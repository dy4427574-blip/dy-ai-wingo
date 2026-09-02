const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 10000);

const ADMIN_KEY =
  process.env.ADMIN_KEY || "change-this-admin-key";

const WINGOBOT_TOKEN =
  process.env.WINGOBOT_TOKEN || "";

const WINGOBOT_URL =
  "https://api.wingobot.com/v2/30-sec-game-history";

const ROUND_SECONDS = 30;

/* =====================================================
   DATABASE
===================================================== */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});

const cache = {
  history: [],
  currentIssue: null,
  settledIssue: null,
  targetIssue: null,

  historyVersion: 0,
  historySignature: "",

  analysis: null,

  lastUpdated: 0,
  providerCountdown: null,

  anchorTime: 0,

  error: null
};

/* =====================================================
   DATABASE INIT
===================================================== */

async function initDatabase() {

  if (!process.env.DATABASE_URL) {
    console.log("DATABASE_URL not configured");
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS access_keys (
      id SERIAL PRIMARY KEY,
      access_key TEXT UNIQUE NOT NULL,
      device_id TEXT,
      created_at BIGINT NOT NULL,
      last_seen BIGINT DEFAULT 0
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS predictions (
      id SERIAL PRIMARY KEY,
      target_issue TEXT UNIQUE NOT NULL,
      prediction TEXT NOT NULL,
      confidence INTEGER DEFAULT 0,
      pattern_score INTEGER DEFAULT 0,
      created_at BIGINT NOT NULL,
      actual TEXT,
      result TEXT,
      settled_at BIGINT DEFAULT 0
    )
  `);

  console.log("Database ready");
}

/* =====================================================
   RESPONSE
===================================================== */

function sendJSON(res, status, data) {

  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });

  res.end(JSON.stringify(data));
}

function readBody(req) {

  return new Promise(resolve => {

    let data = "";

    req.on("data", chunk => {
      data += chunk;
    });

    req.on("end", () => {

      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }

    });

  });
}

/* =====================================================
   BIG / SMALL
===================================================== */

function classify(number) {

  const n = Number(number);

  if (!Number.isFinite(n)) {
    return null;
  }

  return n >= 5 ? "BIG" : "SMALL";
}

/* =====================================================
   ISSUE HELPERS
===================================================== */

function cleanIssue(value) {

  return String(value || "").trim();

}

function compareIssues(a, b) {

  try {

    const A = BigInt(a);
    const B = BigInt(b);

    if (A > B) return 1;
    if (A < B) return -1;

    return 0;

  } catch {

    return String(a).localeCompare(String(b));

  }

}

function nextIssue(value) {

  const s = cleanIssue(value);

  const match = s.match(/^(.*?)(\d+)$/);

  if (!match) {
    return null;
  }

  const prefix = match[1];
  const digits = match[2];

  try {

    const next = BigInt(digits) + 1n;

    return (
      prefix +
      next.toString().padStart(
        digits.length,
        "0"
      )
    );

  } catch {

    return null;

  }

}

/* =====================================================
   PROVIDER HISTORY
===================================================== */

function normalizeHistory(data) {

  const rows =
    Array.isArray(data?.history)
      ? data.history
      : Array.isArray(data?.data?.history)
        ? data.data.history
        : Array.isArray(data?.data)
          ? data.data
          : [];

  return rows
    .map(row => ({

      issueNumber:
        cleanIssue(
          row.issueNumber ??
          row.issue ??
          row.period
        ),

      number:
        Number(row.number),

      colour:
        row.colour ??
        row.color ??
        "",

      premium:
        row.premium ??
        "",

      sum:
        row.sum ??
        ""

    }))
    .filter(row =>
      row.issueNumber &&
      Number.isFinite(row.number)
    );
}

/* =====================================================
   PROVIDER COUNTDOWN
===================================================== */

function extractCountdown(data) {

  const values = [

    data?.countdown,
    data?.remainingSeconds,
    data?.seconds,
    data?.timeLeft,

    data?.current?.countdown,
    data?.current?.remainingSeconds,
    data?.current?.seconds,
    data?.current?.timeLeft

  ];

  for (const value of values) {

    const n = Number(value);

    if (
      Number.isFinite(n) &&
      n >= 0 &&
      n <= 120
    ) {

      return Math.floor(n);

    }

  }

  return null;
}

/* =====================================================
   WINGOBOT API
===================================================== */

async function fetchWingoData() {

  if (!WINGOBOT_TOKEN) {

    throw new Error(
      "WINGOBOT_TOKEN is not configured"
    );

  }

  const response =
    await fetch(
      WINGOBOT_URL,
      {
        headers: {
          Authorization:
            `Bearer ${WINGOBOT_TOKEN}`,

          Accept:
            "application/json"
        }
      }
    );

  if (!response.ok) {

    throw new Error(
      `WingoBot HTTP ${response.status}`
    );

  }

  return response.json();
}

/* =====================================================
   BASIC UTILITIES
===================================================== */

function opposite(side) {

  return side === "BIG"
    ? "SMALL"
    : "BIG";

}

function clamp(value, min, max) {

  return Math.max(
    min,
    Math.min(max, value)
  );

}

/* =====================================================
   SIGNAL OBJECT
===================================================== */

function makeSignal(
  type,
  side,
  strength,
  matches = 1
) {

  if (
    side !== "BIG" &&
    side !== "SMALL"
  ) {
    return null;
  }

  return {

    type,
    side,

    strength:
      Number(
        strength
      ) || 0,

    matches:
      Number(
        matches
      ) || 1

  };

}

/* =====================================================
   EXACT SEQUENCE PATTERN
===================================================== */

function exactSequenceSignal(
  sequence,
  length
) {

  if (
    sequence.length <
    length + 2
  ) {
    return null;
  }

  const current =
    sequence
      .slice(0, length)
      .join("");

  let big = 0;
  let small = 0;
  let matches = 0;

  for (
    let i = length;
    i < sequence.length;
    i++
  ) {

    const previous =
      sequence
        .slice(i, i + length)
        .join("");

    if (
      previous !== current
    ) {
      continue;
    }

    /*
      The element immediately
      before the matching block
      is the historical next side.
    */

    const following =
      sequence[i - 1];

    if (
      following === "BIG"
    ) {
      big++;
    }

    if (
      following === "SMALL"
    ) {
      small++;
    }

    matches++;

  }

  if (!matches) {
    return null;
  }

  if (big === small) {
    return null;
  }

  const side =
    big > small
      ? "BIG"
      : "SMALL";

  const agreement =
    Math.max(big, small) /
    (big + small);

  return makeSignal(
    `EXACT-${length}`,
    side,
    agreement,
    matches
  );
}

/* =====================================================
   REVERSAL / TRANSITION
===================================================== */

function transitionSignal(sequence) {

  if (
    sequence.length < 10
  ) {
    return null;
  }

  let sameAfterBig = 0;
  let oppositeAfterBig = 0;

  let sameAfterSmall = 0;
  let oppositeAfterSmall = 0;

  /*
    Older sequence is used only
    for structural analysis.
  */

  for (
    let i = 1;
    i < sequence.length;
    i++
  ) {

    const previous =
      sequence[i];

    const following =
      sequence[i - 1];

    if (
      previous === "BIG"
    ) {

      if (
        following === "BIG"
      ) {
        sameAfterBig++;
      } else {
        oppositeAfterBig++;
      }

    }

    if (
      previous === "SMALL"
    ) {

      if (
        following === "SMALL"
      ) {
        sameAfterSmall++;
      } else {
        oppositeAfterSmall++;
      }

    }

  }

  const current =
    sequence[0];

  let same;
  let opposite;

  if (
    current === "BIG"
  ) {

    same = sameAfterBig;
    opposite = oppositeAfterBig;

  } else {

    same = sameAfterSmall;
    opposite = oppositeAfterSmall;

  }

  const total =
    same +
    opposite;

  if (
    total < 3
  ) {
    return null;
  }

  const side =
    same >= opposite
      ? current
      : opposite(current);

  const strength =
    Math.abs(
      same - opposite
    ) / total;

  if (
    strength < 0.12
  ) {
    return null;
  }

  return makeSignal(
    "TRANSITION",
    side,
    strength,
    total
  );
}

/* =====================================================
   RUN STRUCTURE
===================================================== */

function runStructureSignal(sequence) {

  if (
    sequence.length < 10
  ) {
    return null;
  }

  let currentRun = 1;

  while (
    currentRun <
      sequence.length &&
    sequence[currentRun] ===
      sequence[0]
  ) {

    currentRun++;

  }

  /*
    Very long runs are treated cautiously.
  */

  if (
    currentRun > 5
  ) {
    return makeSignal(
      "RUN-REVERSAL",
      opposite(sequence[0]),
      0.30,
      currentRun
    );
  }

  let big = 0;
  let small = 0;
  let matches = 0;

  for (
    let i = 0;
    i < sequence.length - currentRun;
    i++
  ) {

    let run = 1;

    while (
      i + run <
        sequence.length &&
      sequence[i + run] ===
        sequence[i]
    ) {

      run++;

    }

    if (
      run === currentRun
    ) {

      const next =
        sequence[i - 1];

      if (
        next === "BIG"
      ) {
        big++;
      }

      if (
        next === "SMALL"
      ) {
        small++;
      }

      matches++;

    }

  }

  if (
    matches < 2
  ) {
    return null;
  }

  if (
    big === small
  ) {
    return null;
  }

  const side =
    big > small
      ? "BIG"
      : "SMALL";

  const strength =
    Math.max(big, small) /
    (big + small);

  return makeSignal(
    "RUN-STRUCTURE",
    side,
    strength,
    matches
  );
}

/* =====================================================
   ALTERNATION STRUCTURE
===================================================== */

function alternationSignal(sequence) {

  if (
    sequence.length < 8
  ) {
    return null;
  }

  let alternating = 0;

  for (
    let i = 0;
    i < 7;
    i++
  ) {

    if (
      sequence[i] !==
      sequence[i + 1]
    ) {

      alternating++;

    }

  }

  if (
    alternating < 6
  ) {
    return null;
  }

  return makeSignal(
    "ALTERNATION",
    opposite(sequence[0]),
    0.28,
    alternating
  );
}

/* =====================================================
   BLOCK / MICRO PATTERN
===================================================== */

function blockPatternSignal(sequence) {

  if (
    sequence.length < 12
  ) {
    return null;
  }

  const recent =
    sequence.slice(0, 6);

  let bestSide = null;
  let bestScore = 0;

  for (
    let length = 2;
    length <= 4;
    length++
  ) {

    const pattern =
      recent
        .slice(0, length)
        .join("");

    let big = 0;
    let small = 0;

    for (
      let i = length;
      i < sequence.length - length;
      i++
    ) {

      const block =
        sequence
          .slice(i, i + length)
          .join("");

      if (
        block !== pattern
      ) {
        continue;
      }

      const next =
        sequence[i - 1];

      if (
        next === "BIG"
      ) {
        big++;
      }

      if (
        next === "SMALL"
      ) {
        small++;
      }

    }

    const total =
      big + small;

    if (
      total < 2 ||
      big === small
    ) {
      continue;
    }

    const side =
      big > small
        ? "BIG"
        : "SMALL";

    const score =
      Math.abs(big - small) /
      total;

    if (
      score > bestScore
    ) {

      bestScore = score;
      bestSide = side;

    }

  }

  if (
    !bestSide ||
    bestScore < 0.15
  ) {
    return null;
  }

  return makeSignal(
    "BLOCK-PATTERN",
    bestSide,
    bestScore,
    2
  );
}

/* =====================================================
   WALK FORWARD VALIDATION
===================================================== */

function historicalValidation(
  history
) {

  const sequence =
    history
      .map(row =>
        classify(row.number)
      )
      .filter(Boolean);

  if (
    sequence.length < 18
  ) {

    return {

      samples: 0,
      wins: 0,
      losses: 0,
      accuracy: 0

    };

  }

  let wins = 0;
  let losses = 0;

  /*
    Out-of-sample style validation:
    prediction uses only the older
    portion of the sequence.
  */

  for (
    let end = 10;
    end < sequence.length;
    end++
  ) {

    const train =
      sequence.slice(
        end
      );

    const actual =
      sequence[end - 1];

    const signals =
      collectSignals(train);

    const estimate =
      combineSignals(signals);

    if (
      !estimate ||
      !estimate.prediction
    ) {
      continue;
    }

    if (
      estimate.prediction ===
      actual
    ) {

      wins++;

    } else {

      losses++;

    }

  }

  const total =
    wins + losses;

  return {

    samples: total,

    wins,

    losses,

    accuracy:
      total
        ? Math.round(
            wins * 100 /
            total
          )
        : 0

  };
}

/* =====================================================
   COLLECT SIGNALS
===================================================== */

function collectSignals(
  sequence
) {

  const signals = [];

  /*
    Exact patterns
  */

  for (
    const length of
    [2, 3, 4, 5, 6]
  ) {

    const signal =
      exactSequenceSignal(
        sequence,
        length
      );

    if (
      signal
    ) {

      signals.push(
        signal
      );

    }

  }

  /*
    Structural signals
  */

  const transition =
    transitionSignal(
      sequence
    );

  if (
    transition
  ) {

    signals.push(
      transition
    );

  }

  const run =
    runStructureSignal(
      sequence
    );

  if (
    run
  ) {

    signals.push(
      run
    );

  }

  const alternate =
    alternationSignal(
      sequence
    );

  if (
    alternate
  ) {

    signals.push(
      alternate
    );

  }

  const block =
    blockPatternSignal(
      sequence
    );

  if (
    block
  ) {

    signals.push(
      block
    );

  }

  return signals;
}

/* =====================================================
   COMBINE SIGNALS
===================================================== */

function combineSignals(
  signals
) {

  if (
    !signals.length
  ) {

    return {

      prediction: null,
      confidence: 0,
      agreement: 0,
      evidence: 0,
      patternScore: 0

    };

  }

  let big = 0;
  let small = 0;

  for (
    const signal of signals
  ) {

    /*
      Structural strength only.
      No raw BIG/SMALL frequency.
    */

    const weight =
      clamp(
        Number(
          signal.strength
        ),
        0,
        1
      );

    if (
      signal.side === "BIG"
    ) {

      big += weight;

    }

    if (
      signal.side === "SMALL"
    ) {

      small += weight;

    }

  }

  const total =
    big + small;

  if (
    total <= 0
  ) {

    return {

      prediction: null,
      confidence: 0,
      agreement: 0,
      evidence: signals.length,
      patternScore: 0

    };

  }

  const prediction =
    big >= small
      ? "BIG"
      : "SMALL";

  const winningSideWeight =
    Math.max(
      big,
      small
    );

  const margin =
    Math.abs(
      big - small
    ) / total;

  const sideCount =
    signals.filter(
      x =>
        x.side ===
        prediction
    ).length;

  const agreement =
    sideCount /
    signals.length;

  /*
    Conservative confidence.
    It is NOT a probability guarantee.
  */

  let confidence =
    50 +
    margin * 20 +
    Math.max(
      0,
      agreement - 0.5
    ) * 18;

  confidence =
    Math.round(
      clamp(
        confidence,
        50,
        72
      )
    );

  /*
    Contradictory signals:
    reduce confidence.
  */

  if (
    agreement < 0.60
  ) {

    confidence =
      Math.min(
        confidence,
        55
      );

  }

  if (
    margin < 0.10
  ) {

    confidence =
      Math.min(
        confidence,
        54
      );

  }

  const patternScore =
    Math.round(
      clamp(
        50 +
        margin * 35 +
        Math.max(
          0,
          agreement - 0.5
        ) * 30,
        50,
        90
      )
    );

  return {

    prediction,

    confidence,

    agreement:
      Math.round(
        agreement * 100
      ),

    evidence:
      signals.length,

    patternScore,

    weightedBig:
      Number(
        big.toFixed(2)
      ),

    weightedSmall:
      Number(
        small.toFixed(2)
      )

  };
}

/* =====================================================
   MAIN ANALYSIS
===================================================== */

function analyze(history) {

  const sequence =
    history
      .slice(0, 60)
      .map(row =>
        classify(row.number)
      )
      .filter(Boolean);

  if (
    sequence.length < 10
  ) {

    return {

      prediction:
        sequence.length
          ? opposite(sequence[0])
          : null,

      confidence: 50,

      patternScore: 50,

      status:
        "LOW SIGNAL",

      agreement: 0,

      evidence: 0,

      validation: {
        samples: 0,
        wins: 0,
        losses: 0,
        accuracy: 0
      },

      models: []

    };

  }

  const signals =
    collectSignals(
      sequence
    );

  const combined =
    combineSignals(
      signals
    );

  const validation =
    historicalValidation(
      history.slice(
        0,
        60
      )
    );

  /*
    Model details for UI/debugging.
  */

  const models =
    signals.map(
      signal => ({

        type:
          signal.type,

        side:
          signal.side,

        strength:
          Number(
            signal.strength
              .toFixed(2)
          ),

        matches:
          signal.matches

      })
    );

  let status =
    "LOW SIGNAL";

  if (
    combined.evidence >= 2 &&
    combined.agreement >= 60 &&
    combined.patternScore >= 60
  ) {

    status =
      "NORMAL SIGNAL";

  }

  /*
    If out-of-sample validation
    is weak, explicitly warn.
    It does NOT force a side.
  */

  if (
    validation.samples >= 8 &&
    validation.accuracy < 50
  ) {

    status =
      "LOW SIGNAL";

    combined.confidence =
      Math.min(
        combined.confidence,
        55
      );

  }

  return {

    prediction:
      combined.prediction,

    confidence:
      combined.confidence,

    patternScore:
      combined.patternScore,

    status,

    agreement:
      combined.agreement,

    evidence:
      combined.evidence,

    validation,

    models,

    sequence:
      sequence.slice(
        0,
        12
      ),

    note:
      "Statistical estimate only; no outcome is guaranteed."

  };

}

/* =====================================================
   SAVE PREDICTION
===================================================== */

async function savePrediction(
  targetIssue,
  analysis
) {

  if (
    !process.env.DATABASE_URL ||
    !targetIssue ||
    !analysis ||
    !analysis.prediction
  ) {

    return;

  }

  await pool.query(
    `
    INSERT INTO predictions
    (
      target_issue,
      prediction,
      confidence,
      pattern_score,
      created_at
    )
    VALUES
    (
      $1,
      $2,
      $3,
      $4,
      $5
    )
    ON CONFLICT
    (
      target_issue
    )
    DO NOTHING
    `,
    [
      targetIssue,
      analysis.prediction,
      analysis.confidence,
      analysis.patternScore,
      Date.now()
    ]
  );

}

/* =====================================================
   SETTLE PREDICTION
===================================================== */

async function settlePrediction(row) {

  if (
    !process.env.DATABASE_URL ||
    !row
  ) {

    return;

  }

  const actual =
    classify(
      row.number
    );

  if (!actual) {
    return;
  }

  await pool.query(
    `
    UPDATE predictions

    SET
      actual = $1,

      result =
        CASE
          WHEN prediction = $1
          THEN 'WIN'
          ELSE 'LOSS'
        END,

      settled_at = $2

    WHERE
      target_issue = $3

      AND result IS NULL
    `,
    [
      actual,
      Date.now(),
      row.issueNumber
    ]
  );

}

/* =====================================================
   WIN / LOSS
===================================================== */

async function getWinLoss() {

  if (
    !process.env.DATABASE_URL
  ) {

    return {

      rows: [],

      stats: {
        total: 0,
        win: 0,
        loss: 0,
        rate: 0,
        streak: "-"
      }

    };

  }

  const result =
    await pool.query(
      `
      SELECT
        target_issue,
        prediction,
        confidence,
        pattern_score,
        created_at,
        actual,
        result,
        settled_at

      FROM predictions

      WHERE result IS NOT NULL

      ORDER BY id DESC

      LIMIT 100
      `
    );

  const rows =
    result.rows;

  const win =
    rows.filter(
      x =>
        x.result === "WIN"
    ).length;

  const loss =
    rows.filter(
      x =>
        x.result === "LOSS"
    ).length;

  let streak = "-";

  if (
    rows.length
  ) {

    const first =
      rows[0].result;

    let count = 0;

    for (
      const row of rows
    ) {

      if (
        row.result !==
        first
      ) {

        break;

      }

      count++;

    }

    streak =
      `${first} ${count}`;

  }

  return {

    rows,

    stats: {

      total:
        win + loss,

      win,

      loss,

      rate:
        win + loss
          ? Math.round(
              win * 1000 /
              (win + loss)
            ) / 10
          : 0,

      streak

    }

  };

}

/* =====================================================
   CACHE UPDATE
===================================================== */

async function updateCache() {

  try {

    const data =
      await fetchWingoData();

    const history =
      normalizeHistory(
        data
      );

    if (
      !history.length
    ) {

      throw new Error(
        "No history received"
      );

    }

    /*
      Provider history is expected
      newest first.
    */

    const settledIssue =
      history[0].issueNumber;

    const providerCurrent =
      cleanIssue(
        data?.current
          ?.issueNumber
      );

    let targetIssue =
      null;

    if (
      providerCurrent &&
      compareIssues(
        providerCurrent,
        settledIssue
      ) > 0
    ) {

      targetIssue =
        providerCurrent;

    } else {

      targetIssue =
        nextIssue(
          settledIssue
        );

    }

    /*
      Signature changes only when
      a settled number changes.
    */

    const signature =
      history
        .slice(0, 8)
        .map(row =>
          `${row.issueNumber}:${row.number}`
        )
        .join("|");

    const changed =
      signature !==
      cache.historySignature;

    cache.history =
      history;

    cache.currentIssue =
      providerCurrent ||
      settledIssue;

    cache.settledIssue =
      settledIssue;

    cache.targetIssue =
      targetIssue;

    cache.providerCountdown =
      extractCountdown(
        data
      );

    cache.lastUpdated =
      Date.now();

    cache.error =
      null;

    /*
      IMPORTANT:
      Prediction is NOT regenerated
      every second.
    */

    if (
      changed
    ) {

      cache.historySignature =
        signature;

      cache.historyVersion++;

      /*
        First settle previous target.
      */

      await settlePrediction(
        history[0]
      );

      /*
        New statistical analysis.
      */

      cache.analysis =
        analyze(
          history
        );

      /*
        Start a fresh 30-sec estimate
        only after a new settled result.
      */

      cache.anchorTime =
        Date.now();

      /*
        Save prediction for next issue.
      */

      await savePrediction(
        targetIssue,
        cache.analysis
      );

      console.log(
        "New settled result:",
        settledIssue,
        "Target:",
        targetIssue,
        "Prediction:",
        cache.analysis?.prediction,
        "Confidence:",
        cache.analysis?.confidence
      );

    }

  } catch (error) {

    cache.error =
      error.message;

    console.error(
      "Provider error:",
      error.message
    );

  }

}

/* =====================================================
   TIMER
===================================================== */

function getTiming() {

  if (
    Number.isFinite(
      cache.providerCountdown
    )
  ) {

    return {

      seconds:
        Math.min(
          30,
          cache.providerCountdown
        ),

      exact: true

    };

  }

  if (
    !cache.anchorTime
  ) {

    return {

      seconds: 30,

      exact: false

    };

  }

  const elapsed =
    Math.floor(
      (
        Date.now() -
        cache.anchorTime
      ) / 1000
    );

  let seconds =
    ROUND_SECONDS -
    (
      elapsed %
      ROUND_SECONDS
    );

  if (
    seconds === 0
  ) {

    seconds =
      ROUND_SECONDS;

  }

  return {

    seconds,

    exact: false

  };

}

/* =====================================================
   ADMIN AUTH
===================================================== */

function checkAdmin(req) {

  const admin =
    req.headers[
      "x-admin-key"
    ];

  return admin ===
    ADMIN_KEY;

}

/* =====================================================
   API HANDLER
===================================================== */

async function handleAPI(
  req,
  res,
  url
) {

  /* HEALTH */

  if (
    url.pathname ===
    "/health"
  ) {

    return sendJSON(
      res,
      200,
      {
        ok: true,
        time: Date.now()
      }
    );

  }

  /* STATE */

  if (
    url.pathname ===
      "/api/state" &&
    req.method ===
      "GET"
  ) {

    return sendJSON(
      res,
      200,
      {

        ok: true,

        history:
          cache.history.slice(
            0,
            30
          ),

        currentIssue:
          cache.currentIssue,

        settledIssue:
          cache.settledIssue,

        targetIssue:
          cache.targetIssue,

        historyVersion:
          cache.historyVersion,

        lastUpdated:
          cache.lastUpdated,

        timing:
          getTiming(),

        analysis:
          cache.analysis,

        error:
          cache.error

      }
    );

  }

  /* WIN LOSS */

  if (
    url.pathname ===
      "/api/history" &&
    req.method ===
      "GET"
  ) {

    return sendJSON(
      res,
      200,
      await getWinLoss()
    );

  }

  /* ACCESS KEY */

  if (
    url.pathname ===
      "/api/key/check" &&
    req.method ===
      "POST"
  ) {

    const data =
      await readBody(
        req
      );

    const key =
      String(
        data.key || ""
      ).trim();

    const device =
      String(
        req.headers[
          "x-device-id"
        ] ||
        data.device_id ||
        ""
      ).trim();

    if (
      !process.env.DATABASE_URL
    ) {

      return sendJSON(
        res,
        503,
        {
          ok: false,
          message:
            "Database not configured"
        }
      );

    }

    if (!key) {

      return sendJSON(
        res,
        400,
        {
          ok: false,
          message:
            "Access key required"
        }
      );

    }

    const result =
      await pool.query(
        `
        SELECT *
        FROM access_keys
        WHERE access_key = $1
        `,
        [key]
      );

    if (
      !result.rowCount
    ) {

      return sendJSON(
        res,
        401,
        {
          ok: false,
          message:
            "Invalid access key"
        }
      );

    }

    const row =
      result.rows[0];

    /*
      If a key is already bound,
      only the same device can use it.
    */

    if (
      row.device_id &&
      row.device_id !== device
    ) {

      return sendJSON(
        res,
        403,
        {
          ok: false,
          message:
            "Key already bound to another device"
        }
      );

    }

    await pool.query(
      `
      UPDATE access_keys

      SET
        device_id = $1,
        last_seen = $2

      WHERE id = $3
      `,
      [
        device,
        Date.now(),
        row.id
      ]
    );

    return sendJSON(
      res,
      200,
      {
        ok: true,
        message:
          "Access granted"
      }
    );

  }

  /* =================================================
     ADMIN
  ================================================= */

  if (
    url.pathname.startsWith(
      "/api/admin/"
    )
  ) {

    if (
      !checkAdmin(req)
    ) {

      return sendJSON(
        res,
        401,
        {
          ok: false,
          message:
            "Unauthorized"
        }
      );

    }

    /* ADMIN PING */

    if (
      url.pathname ===
        "/api/admin/ping" &&
      req.method ===
        "GET"
    ) {

      return sendJSON(
        res,
        200,
        {
          ok: true,
          time: Date.now()
        }
      );

    }

    /* STATUS */

    if (
      url.pathname ===
        "/api/admin/status"
    ) {

      return sendJSON(
        res,
        200,
        {

          ok: true,

          database:
            !!process.env.DATABASE_URL,

          wingobot:
            !!WINGOBOT_TOKEN,

          currentIssue:
            cache.currentIssue,

          settledIssue:
            cache.settledIssue,

          targetIssue:
            cache.targetIssue,

          lastUpdated:
            cache.lastUpdated,

          error:
            cache.error

        }
      );

    }

    /* WINGOBOT TEST */

    if (
      url.pathname ===
        "/api/admin/wingo-test"
    ) {

      try {

        const data =
          await fetchWingoData();

        return sendJSON(
          res,
          200,
          {

            ok: true,

            current:
              data.current ||
              null,

            countdown:
              extractCountdown(
                data
              ),

            history:
              normalizeHistory(
                data
              ).slice(
                0,
                10
              )

          }
        );

      } catch (error) {

        return sendJSON(
          res,
          500,
          {
            ok: false,
            message:
              error.message
          }
        );

      }

    }

    /* LIST KEYS */

    if (
      url.pathname ===
        "/api/admin/keys" &&
      req.method ===
        "GET"
    ) {

      if (
        !process.env.DATABASE_URL
      ) {

        return sendJSON(
          res,
          503,
          {
            ok: false,
            message:
              "Database not configured"
          }
        );

      }

      const result =
        await pool.query(
          `
          SELECT
            id,
            access_key,
            device_id,
            created_at,
            last_seen

          FROM access_keys

          ORDER BY id DESC
          `
        );

      return sendJSON(
        res,
        200,
        {
          ok: true,
          keys:
            result.rows
        }
      );

    }

    /* CREATE KEYS */

    if (
      url.pathname ===
        "/api/admin/keys" &&
      req.method ===
        "POST"
    ) {

      if (
        !process.env.DATABASE_URL
      ) {

        return sendJSON(
          res,
          503,
          {
            ok: false,
            message:
              "Database not configured"
          }
        );

      }

      const data =
        await readBody(
          req
        );

      const count =
        Math.max(
          1,
          Math.min(
            100,
            Number(
              data.count || 1
            )
          )
        );

      const keys = [];

      for (
        let i = 0;
        i < count;
        i++
      ) {

        let created =
          false;

        while (
          !created
        ) {

          const key =
            "DY-" +
            crypto
              .randomBytes(
                5
              )
              .toString(
                "hex"
              )
              .toUpperCase();

          const result =
            await pool.query(
              `
              INSERT INTO access_keys
              (
                access_key,
                created_at
              )

              VALUES
              (
                $1,
                $2
              )

              ON CONFLICT
              DO NOTHING

              RETURNING access_key
              `,
              [
                key,
                Date.now()
              ]
            );

          if (
            result.rowCount
          ) {

            keys.push(
              key
            );

            created =
              true;

          }

        }

      }

      return sendJSON(
        res,
        200,
        {
          ok: true,
          keys
        }
      );

    }

    /* DELETE KEY */

    if (
      url.pathname ===
        "/api/admin/keys" &&
      req.method ===
        "DELETE"
    ) {

      const data =
        await readBody(
          req
        );

      await pool.query(
        `
        DELETE FROM access_keys
        WHERE id = $1
        `,
        [data.id]
      );

      return sendJSON(
        res,
        200,
        {
          ok: true
        }
      );

    }

    /* RESET DEVICE */

    if (
      url.pathname ===
        "/api/admin/reset-device" &&
      req.method ===
        "POST"
    ) {

      const data =
        await readBody(
          req
        );

      await pool.query(
        `
        UPDATE access_keys

        SET device_id = NULL

        WHERE id = $1
        `,
        [data.id]
      );

      return sendJSON(
        res,
        200,
        {
          ok: true
        }
      );

    }

  }

  return null;
}

/* =====================================================
   STATIC FILE SERVER
===================================================== */

function serveStatic(
  req,
  res,
  url
) {

  let filename =
    url.pathname === "/"
      ? "/prediction.html"
      : url.pathname;

  if (
    filename.includes("..")
  ) {

    return sendJSON(
      res,
      400,
      {
        ok: false
      }
    );

  }

  const filePath =
    path.join(
      __dirname,
      filename
    );

  if (
    !fs.existsSync(
      filePath
    )
  ) {

    return sendJSON(
      res,
      404,
      {
        ok: false,
        message:
          "File not found"
      }
    );

  }

  const ext =
    path
      .extname(
        filePath
      )
      .toLowerCase();

  const types = {

    ".html":
      "text/html; charset=utf-8",

    ".css":
      "text/css; charset=utf-8",

    ".js":
      "application/javascript; charset=utf-8",

    ".json":
      "application/json"

  };

  /* =================================================
     MP3 RANGE SUPPORT
  ================================================= */

  if (
    ext === ".mp3"
  ) {

    const stat =
      fs.statSync(
        filePath
      );

    const range =
      req.headers.range;

    if (
      range
    ) {

      const match =
        range.match(
          /bytes=(\d+)-(\d*)/
        );

      if (
        match
      ) {

        const start =
          Number(
            match[1]
          );

        let end =
          match[2]
            ? Number(
                match[2]
              )
            : stat.size - 1;

        end =
          Math.min(
            end,
            stat.size - 1
          );

        if (
          start <
          stat.size &&
          start <= end
        ) {

          res.writeHead(
            206,
            {

              "Content-Type":
                "audio/mpeg",

              "Accept-Ranges":
                "bytes",

              "Content-Range":
                `bytes ${start}-${end}/${stat.size}`,

              "Content-Length":
                end - start + 1

            }
          );

          return fs
            .createReadStream(
              filePath,
              {
                start,
                end
              }
            )
            .pipe(res);

        }

      }

    }

    res.writeHead(
      200,
      {

        "Content-Type":
          "audio/mpeg",

        "Accept-Ranges":
          "bytes",

        "Content-Length":
          stat.size

      }
    );

    return fs
      .createReadStream(
        filePath
      )
      .pipe(res);

  }

  res.writeHead(
    200,
    {

      "Content-Type":
        types[ext] ||
        "application/octet-stream",

      "Cache-Control":
        "no-store"

    }
  );

  fs
    .createReadStream(
      filePath
    )
    .pipe(res);

}

/* =====================================================
   SERVER
===================================================== */

const server =
  http.createServer(
    async (
      req,
      res
    ) => {

      try {

        const url =
          new URL(
            req.url,
            `http://${req.headers.host || "localhost"}`
          );

        const handled =
          await handleAPI(
            req,
            res,
            url
          );

        if (
          handled !== null
        ) {

          return;

        }

        serveStatic(
          req,
          res,
          url
        );

      } catch (error) {

        console.error(
          "Server error:",
          error
        );

        sendJSON(
          res,
          500,
          {
            ok: false,
            message:
              error.message
          }
        );

      }

    }
  );

/* =====================================================
   START
===================================================== */

(async () => {

  try {

    await initDatabase();

    await updateCache();

    /*
      Provider polling every second.
    */

    setInterval(
      updateCache,
      1000
    );

    server.listen(
      PORT,
      () => {

        console.log(
          `DY AI server running on ${PORT}`
        );

      }
    );

  } catch (error) {

    console.error(
      "Startup error:",
      error
    );

    process.exit(1);

  }

})();
