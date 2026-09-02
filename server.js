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
   DATABASE
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
    "Content-Type":
      "application/json; charset=utf-8",

    "Cache-Control":
      "no-store",

    "Access-Control-Allow-Origin":
      "*"
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
        resolve(
          data
            ? JSON.parse(data)
            : {}
        );
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

  return n >= 5
    ? "BIG"
    : "SMALL";
}


/* =====================================================
   ISSUE
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

    return String(a)
      .localeCompare(String(b));

  }

}


function nextIssue(value) {

  const s = cleanIssue(value);

  const match =
    s.match(/^(.*?)(\d+)$/);

  if (!match) {
    return null;
  }

  try {

    const prefix = match[1];
    const digits = match[2];

    const next =
      BigInt(digits) + 1n;

    return (
      prefix +
      next.toString()
        .padStart(
          digits.length,
          "0"
        )
    );

  } catch {

    return null;

  }

}


/* =====================================================
   NORMALIZE HISTORY
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
   COUNTDOWN
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
   WINGOBOT
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
   VOTE
===================================================== */

function weightedVote(signals) {

  let big = 0;
  let small = 0;

  for (const signal of signals) {

    const weight =
      Number(signal.weight) || 0;

    if (signal.side === "BIG") {
      big += weight;
    }

    if (signal.side === "SMALL") {
      small += weight;
    }

  }

  return {
    big,
    small
  };
}


/* =====================================================
   SIGNAL FACTORY
===================================================== */

function makeSignal(
  side,
  weight,
  type,
  matches = 1
) {

  if (
    side !== "BIG" &&
    side !== "SMALL"
  ) {
    return null;
  }

  return {
    side,
    weight,
    type,
    matches
  };

}


/* =====================================================
   RECENT BALANCE
===================================================== */

function recentBalance(sequence, size) {

  const data =
    sequence.slice(
      0,
      size
    );

  if (!data.length) {
    return {
      big: 0,
      small: 0
    };
  }

  const big =
    data.filter(
      x => x === "BIG"
    ).length;

  const small =
    data.length - big;

  return {
    big,
    small
  };
}


/*
  This does NOT simply predict the opposite
  of the majority.

  It only detects an extreme recent imbalance.
*/

function balanceSignal(sequence) {

  if (sequence.length < 10) {
    return null;
  }

  const recent =
    recentBalance(
      sequence,
      10
    );

  const total =
    recent.big +
    recent.small;

  const bigRatio =
    recent.big / total;

  const smallRatio =
    recent.small / total;

  /*
    Only act when imbalance is strong.
  */

  if (bigRatio >= 0.8) {

    return makeSignal(
      "SMALL",
      0.30,
      "balance"
    );

  }

  if (smallRatio >= 0.8) {

    return makeSignal(
      "BIG",
      0.30,
      "balance"
    );

  }

  return null;
}


/* =====================================================
   EXACT PATTERN
===================================================== */

function exactPattern(
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

  const signals = [];

  for (
    let i = length + 1;
    i < sequence.length;
    i++
  ) {

    const old =
      sequence
        .slice(
          i,
          i + length
        )
        .join("");

    if (old !== current) {
      continue;
    }

    const side =
      sequence[i - 1];

    if (
      side !== "BIG" &&
      side !== "SMALL"
    ) {
      continue;
    }

    signals.push({

      side,

      weight:
        1 /
        (
          1 +
          i * 0.06
        )

    });

  }

  if (!signals.length) {
    return null;
  }

  const vote =
    weightedVote(
      signals
    );

  const total =
    vote.big +
    vote.small;

  return {

    side:
      vote.big >= vote.small
        ? "BIG"
        : "SMALL",

    matches:
      signals.length,

    weight:
      Math.min(
        2,
        total
      ),

    type:
      "exact"

  };

}


/* =====================================================
   SIMILAR PATTERN
===================================================== */

function similarPattern(
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
    sequence.slice(
      0,
      length
    );

  const maxDistance =
    length <= 4
      ? 1
      : 2;

  const signals = [];

  for (
    let i = length + 1;
    i < sequence.length;
    i++
  ) {

    const old =
      sequence.slice(
        i,
        i + length
      );

    let distance = 0;

    for (
      let j = 0;
      j < length;
      j++
    ) {

      if (
        current[j] !==
        old[j]
      ) {

        distance++;

      }

    }

    if (
      distance >
      maxDistance
    ) {
      continue;
    }

    const similarity =
      1 -
      distance / length;

    signals.push({

      side:
        sequence[i - 1],

      weight:
        similarity *
        0.40 /
        (
          1 +
          i * 0.07
        )

    });

  }

  if (!signals.length) {
    return null;
  }

  const vote =
    weightedVote(
      signals
    );

  return {

    side:
      vote.big >= vote.small
        ? "BIG"
        : "SMALL",

    matches:
      signals.length,

    weight:
      Math.min(
        1.5,
        vote.big +
        vote.small
      ),

    type:
      "similar"

  };

}


/* =====================================================
   TRANSITION
===================================================== */

function transitionSignal(
  sequence
) {

  if (
    sequence.length < 10
  ) {
    return null;
  }

  const current =
    sequence[0];

  const signals = [];

  for (
    let i = 1;
    i < sequence.length - 1;
    i++
  ) {

    if (
      sequence[i] !==
      current
    ) {
      continue;
    }

    const next =
      sequence[i - 1];

    if (
      next !== "BIG" &&
      next !== "SMALL"
    ) {
      continue;
    }

    signals.push({

      side: next,

      weight:
        0.55 /
        (
          1 +
          i * 0.07
        )

    });

  }

  if (!signals.length) {
    return null;
  }

  const vote =
    weightedVote(
      signals
    );

  return {

    side:
      vote.big >= vote.small
        ? "BIG"
        : "SMALL",

    matches:
      signals.length,

    weight:
      Math.min(
        1.2,
        vote.big +
        vote.small
      ),

    type:
      "transition"

  };

}


/* =====================================================
   RUN ANALYSIS
===================================================== */

function runSignal(sequence) {

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

  if (currentRun > 5) {
    return null;
  }

  const signals = [];

  for (
    let i = currentRun + 1;
    i < sequence.length;
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

      const side =
        sequence[i - 1];

      if (
        side === "BIG" ||
        side === "SMALL"
      ) {

        signals.push({

          side,

          weight:
            0.60 /
            (
              1 +
              i * 0.08
            )

        });

      }

    }

  }

  if (!signals.length) {
    return null;
  }

  const vote =
    weightedVote(
      signals
    );

  return {

    side:
      vote.big >= vote.small
        ? "BIG"
        : "SMALL",

    matches:
      signals.length,

    weight:
      Math.min(
        1,
        vote.big +
        vote.small
      ),

    type:
      "run"

  };

}


/* =====================================================
   ALTERNATION
===================================================== */

function alternationSignal(
  sequence
) {

  if (
    sequence.length < 8
  ) {
    return null;
  }

  let changes = 0;

  for (
    let i = 0;
    i < 7;
    i++
  ) {

    if (
      sequence[i] !==
      sequence[i + 1]
    ) {

      changes++;

    }

  }

  /*
    Only signal when the recent sequence
    is strongly alternating.
  */

  if (changes < 6) {
    return null;
  }

  const side =
    sequence[0] === "BIG"
      ? "SMALL"
      : "BIG";

  return makeSignal(
    side,
    0.25,
    "alternation"
  );

}


/* =====================================================
   RECENT MOMENTUM
===================================================== */

function momentumSignal(
  sequence
) {

  if (
    sequence.length < 12
  ) {
    return null;
  }

  const recent =
    sequence.slice(
      0,
      6
    );

  const previous =
    sequence.slice(
      6,
      12
    );

  const recentBig =
    recent.filter(
      x => x === "BIG"
    ).length;

  const previousBig =
    previous.filter(
      x => x === "BIG"
    ).length;

  const recentRate =
    recentBig / 6;

  const previousRate =
    previousBig / 6;

  const difference =
    recentRate -
    previousRate;

  /*
    Small momentum signal only.
  */

  if (
    Math.abs(difference) <
    0.34
  ) {
    return null;
  }

  return makeSignal(
    difference > 0
      ? "BIG"
      : "SMALL",
    0.25,
    "momentum"
  );

}


/* =====================================================
   MAIN ANALYSIS
===================================================== */

function analyze(history) {

  const sequence =
    history
      .slice(
        0,
        80
      )
      .map(
        row =>
          classify(row.number)
      )
      .filter(Boolean);


  if (
    sequence.length < 8
  ) {

    return {

      prediction:
        sequence[0] === "BIG"
          ? "SMALL"
          : "BIG",

      confidence: 50,

      patternScore: 50,

      status:
        "LOW SIGNAL",

      agreement: 0,

      evidence: 0,

      matches: {
        exact: 0,
        similar: 0,
        transition: 0,
        runs: 0
      }

    };

  }


  const signals = [];


  /*
    Exact patterns
  */

  for (
    const length of
    [2, 3, 4, 5, 6, 8]
  ) {

    const exact =
      exactPattern(
        sequence,
        length
      );

    if (exact) {

      /*
        Longer exact patterns receive
        slightly more importance.
      */

      exact.weight *=
        length >= 5
          ? 1.20
          : length >= 4
            ? 1.05
            : 0.80;

      signals.push(
        exact
      );

    }


    const similar =
      similarPattern(
        sequence,
        length
      );

    if (similar) {

      signals.push(
        similar
      );

    }

  }


  const transition =
    transitionSignal(
      sequence
    );

  if (transition) {
    signals.push(transition);
  }


  const run =
    runSignal(
      sequence
    );

  if (run) {
    signals.push(run);
  }


  const alternating =
    alternationSignal(
      sequence
    );

  if (alternating) {
    signals.push(alternating);
  }


  const momentum =
    momentumSignal(
      sequence
    );

  if (momentum) {
    signals.push(momentum);
  }


  const balance =
    balanceSignal(
      sequence
    );

  if (balance) {
    signals.push(balance);
  }


  /*
    Remove extremely weak signals.
  */

  const usable =
    signals.filter(
      signal =>
        Number(signal.weight) >= 0.15
    );


  const vote =
    weightedVote(
      usable
    );


  const total =
    vote.big +
    vote.small;


  if (
    total <= 0
  ) {

    return {

      prediction:
        sequence[0] === "BIG"
          ? "SMALL"
          : "BIG",

      confidence: 50,

      patternScore: 50,

      status:
        "LOW SIGNAL",

      agreement: 0,

      evidence: 0,

      matches: {
        exact: 0,
        similar: 0,
        transition: 0,
        runs: 0
      }

    };

  }


  const prediction =
    vote.big >= vote.small
      ? "BIG"
      : "SMALL";


  const margin =
    Math.abs(
      vote.big -
      vote.small
    ) / total;


  const sides =
    usable.map(
      x => x.side
    );


  const sameSide =
    sides.filter(
      x =>
        x === prediction
    ).length;


  const agreement =
    sides.length
      ? sameSide /
        sides.length
      : 0;


  /*
    Recent balance check.
  */

  const recent =
    recentBalance(
      sequence,
      10
    );


  const recentTotal =
    recent.big +
    recent.small;


  const recentImbalance =
    recentTotal
      ? Math.abs(
          recent.big -
          recent.small
        ) /
        recentTotal
      : 0;


  /*
    Confidence is deliberately conservative.
  */

  let confidence =
    50 +
    margin * 17 +
    Math.max(
      0,
      agreement - 0.5
    ) * 15;


  /*
    Too little evidence means low confidence.
  */

  if (
    usable.length < 2
  ) {

    confidence =
      Math.min(
        confidence,
        54
      );

  }


  /*
    Conflicting signals reduce confidence.
  */

  if (
    agreement < 0.60
  ) {

    confidence =
      Math.min(
        confidence,
        56
      );

  }


  /*
    Extreme imbalance also prevents
    overconfidence.
  */

  if (
    recentImbalance >= 0.60
  ) {

    confidence =
      Math.min(
        confidence,
        58
      );

  }


  confidence =
    Math.round(
      Math.max(
        50,
        Math.min(
          75,
          confidence
        )
      )
    );


  /*
    Pattern score
  */

  let patternScore =
    50 +
    margin * 30 +
    Math.max(
      0,
      agreement - 0.5
    ) * 30;


  if (
    usable.length >= 4
  ) {
    patternScore += 5;
  }


  patternScore =
    Math.round(
      Math.max(
        50,
        Math.min(
          90,
          patternScore
        )
      )
    );


  let status =
    "LOW SIGNAL";


  if (
    confidence >= 62 &&
    agreement >= 0.65 &&
    margin >= 0.12 &&
    usable.length >= 3
  ) {

    status =
      "NORMAL SIGNAL";

  }


  const exactMatches =
    usable
      .filter(
        x =>
          x.type === "exact"
      )
      .reduce(
        (sum, x) =>
          sum +
          x.matches,
        0
      );


  const similarMatches =
    usable
      .filter(
        x =>
          x.type === "similar"
      )
      .reduce(
        (sum, x) =>
          sum +
          x.matches,
        0
      );


  const transitionMatches =
    usable
      .filter(
        x =>
          x.type === "transition"
      )
      .reduce(
        (sum, x) =>
          sum +
          x.matches,
        0
      );


  const runMatches =
    usable
      .filter(
        x =>
          x.type === "run"
      )
      .reduce(
        (sum, x) =>
          sum +
          x.matches,
        0
      );


  return {

    prediction,

    confidence,

    patternScore,

    status,

    agreement:
      Math.round(
        agreement * 100
      ),

    evidence:
      usable.length,

    matches: {

      exact:
        exactMatches,

      similar:
        similarMatches,

      transition:
        transitionMatches,

      runs:
        runMatches

    },

    sequence:
      sequence.slice(
        0,
        12
      )

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
    !analysis
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
   SETTLE
===================================================== */

async function settlePrediction(row) {

  if (
    !process.env.DATABASE_URL ||
    !row
  ) {
    return;
  }

  const actual =
    classify(row.number);

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
   WIN LOSS
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


  if (rows.length) {

    const first =
      rows[0].result;

    let count = 0;

    for (const row of rows) {

      if (
        row.result !== first
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
              (
                win * 1000
              ) /
              (
                win + loss
              )
            ) / 10
          : 0,

      streak

    }

  };

}


/* =====================================================
   CACHE
===================================================== */

async function updateCache() {

  try {

    const data =
      await fetchWingoData();


    const history =
      normalizeHistory(
        data
      );


    if (!history.length) {

      throw new Error(
        "No history received"
      );

    }


    const settledIssue =
      history[0].issueNumber;


    const providerCurrent =
      cleanIssue(
        data?.current?.issueNumber
      );


    const targetIssue =
      providerCurrent &&
      compareIssues(
        providerCurrent,
        settledIssue
      ) > 0

        ? providerCurrent

        : nextIssue(
            settledIssue
          );


    const signature =
      history
        .slice(0, 8)
        .map(
          row =>
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
      Prediction changes only when
      a NEW settled result arrives.
    */

    if (changed) {

      cache.historySignature =
        signature;


      cache.historyVersion++;


      cache.analysis =
        analyze(
          history
        );


      cache.anchorTime =
        Date.now();


      /*
        First settle the latest
        completed period.
      */

      try {

        await settlePrediction(
          history[0]
        );

      } catch (error) {

        console.error(
          "Settlement error:",
          error.message
        );

      }


      /*
        Then create prediction
        for next target.
      */

      try {

        await savePrediction(
          targetIssue,
          cache.analysis
        );

      } catch (error) {

        console.error(
          "Prediction save error:",
          error.message
        );

      }

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


  if (!cache.anchorTime) {

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


  if (seconds === 0) {
    seconds = ROUND_SECONDS;
  }


  return {

    seconds,

    exact: false

  };

}


/* =====================================================
   API
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
      await readBody(req);


    const key =
      String(
        data.key ||
        data.access_key ||
        ""
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


  /* ===================================================
     ADMIN
  =================================================== */

  if (
    url.pathname.startsWith(
      "/api/admin/"
    )
  ) {

    const admin =
      req.headers[
        "x-admin-key"
      ];


    if (
      admin !==
      ADMIN_KEY
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
      "/api/admin/ping"
    ) {

      return sendJSON(
        res,
        200,
        {
          ok: true,
          server: "online",
          database:
            !!process.env.DATABASE_URL,
          wingobot:
            !!WINGOBOT_TOKEN,
          time:
            Date.now()
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

            history:
              normalizeHistory(
                data
              ).slice(
                0,
                5
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
        await readBody(req);


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


        while (!created) {

          const key =
            "DY-" +
            crypto
              .randomBytes(5)
              .toString("hex")
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

            keys.push(key);
            created = true;

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
        await readBody(req);


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
        await readBody(req);


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
   STATIC FILE
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
    !fs.existsSync(filePath)
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
      .extname(filePath)
      .toLowerCase();


  const types = {

    ".html":
      "text/html; charset=utf-8",

    ".css":
      "text/css; charset=utf-8",

    ".js":
      "application/javascript; charset=utf-8",

    ".json":
      "application/json",

    ".svg":
      "image/svg+xml",

    ".png":
      "image/png",

    ".jpg":
      "image/jpeg",

    ".jpeg":
      "image/jpeg",

    ".webp":
      "image/webp"

  };


  /* ===================================================
     MP3 RANGE
  =================================================== */

  if (
    ext === ".mp3"
  ) {

    const stat =
      fs.statSync(
        filePath
      );


    const range =
      req.headers.range;


    if (range) {

      const match =
        range.match(
          /bytes=(\d+)-(\d*)/
        );


      if (match) {

        const start =
          Number(match[1]);


        let end =
          match[2]
            ? Number(match[2])
            : stat.size - 1;


        if (
          start >= stat.size
        ) {

          return sendJSON(
            res,
            416,
            {
              ok: false,
              message:
                "Range not satisfiable"
            }
          );

        }


        end =
          Math.min(
            end,
            stat.size - 1
          );


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
              end -
              start +
              1

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


        if (!res.headersSent) {

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
      Provider refresh:
      every second.
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
