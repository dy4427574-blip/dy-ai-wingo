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

/* =====================================================
   CACHE
===================================================== */

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
      next.toString().padStart(digits.length, "0")
    );
  } catch {
    return null;
  }
}

/* =====================================================
   PROVIDER NORMALIZER
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
      issueNumber: cleanIssue(
        row.issueNumber ??
        row.issue ??
        row.period
      ),

      number: Number(row.number),

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

  const response = await fetch(
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
   WEIGHTED VOTE
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
   RECENCY WEIGHT
===================================================== */

function recencyWeight(index) {
  return 1 / (1 + index * 0.055);
}

/* =====================================================
   EXACT SEQUENCE
===================================================== */

function exactPattern(sequence, length) {
  if (sequence.length < length + 2) {
    return null;
  }

  const current =
    sequence.slice(0, length).join("");

  const signals = [];

  for (
    let i = length + 1;
    i < sequence.length;
    i++
  ) {
    const old =
      sequence
        .slice(i, i + length)
        .join("");

    if (old !== current) {
      continue;
    }

    signals.push({
      side: sequence[i - 1],

      weight:
        1.8 *
        recencyWeight(i),

      type: "exact"
    });
  }

  if (!signals.length) {
    return null;
  }

  const vote =
    weightedVote(signals);

  return {
    side:
      vote.big >= vote.small
        ? "BIG"
        : "SMALL",

    matches: signals.length,

    weight:
      Math.min(
        3,
        vote.big + vote.small
      ),

    type: "exact"
  };
}

/* =====================================================
   SIMILAR SEQUENCE
===================================================== */

function similarPattern(sequence, length) {
  if (sequence.length < length + 2) {
    return null;
  }

  const current =
    sequence.slice(0, length);

  const maxDistance =
    length <= 4 ? 1 : 2;

  const signals = [];

  for (
    let i = length + 1;
    i < sequence.length;
    i++
  ) {
    const old =
      sequence.slice(i, i + length);

    let distance = 0;

    for (
      let j = 0;
      j < length;
      j++
    ) {
      if (
        current[j] !== old[j]
      ) {
        distance++;
      }
    }

    if (distance > maxDistance) {
      continue;
    }

    const similarity =
      1 - distance / length;

    signals.push({
      side: sequence[i - 1],

      weight:
        0.75 *
        similarity *
        recencyWeight(i),

      type: "similar"
    });
  }

  if (!signals.length) {
    return null;
  }

  const vote =
    weightedVote(signals);

  return {
    side:
      vote.big >= vote.small
        ? "BIG"
        : "SMALL",

    matches: signals.length,

    weight:
      Math.min(
        2,
        vote.big + vote.small
      ),

    type: "similar"
  };
}

/* =====================================================
   TRANSITION MODEL
===================================================== */

function transitionSignal(sequence) {
  if (sequence.length < 10) {
    return null;
  }

  const current = sequence[0];

  const signals = [];

  for (
    let i = 1;
    i < sequence.length - 1;
    i++
  ) {
    if (sequence[i] !== current) {
      continue;
    }

    signals.push({
      side: sequence[i - 1],

      weight:
        1.15 *
        recencyWeight(i),

      type: "transition"
    });
  }

  if (!signals.length) {
    return null;
  }

  const vote =
    weightedVote(signals);

  return {
    side:
      vote.big >= vote.small
        ? "BIG"
        : "SMALL",

    matches: signals.length,

    weight:
      Math.min(
        2.2,
        vote.big + vote.small
      ),

    type: "transition"
  };
}

/* =====================================================
   RUN MODEL
===================================================== */

function runSignal(sequence) {
  if (sequence.length < 10) {
    return null;
  }

  let currentRun = 1;

  while (
    currentRun < sequence.length &&
    sequence[currentRun] === sequence[0]
  ) {
    currentRun++;
  }

  const signals = [];

  for (
    let i = currentRun + 1;
    i < sequence.length;
    i++
  ) {
    let run = 1;

    while (
      i + run < sequence.length &&
      sequence[i + run] === sequence[i]
    ) {
      run++;
    }

    if (run !== currentRun) {
      continue;
    }

    signals.push({
      side: sequence[i - 1],

      weight:
        0.9 *
        recencyWeight(i),

      type: "run"
    });
  }

  if (!signals.length) {
    return null;
  }

  const vote =
    weightedVote(signals);

  return {
    side:
      vote.big >= vote.small
        ? "BIG"
        : "SMALL",

    matches: signals.length,

    weight:
      Math.min(
        1.8,
        vote.big + vote.small
      ),

    type: "run"
  };
}

/* =====================================================
   ALTERNATION MODEL
===================================================== */

function alternationSignal(sequence) {
  if (sequence.length < 8) {
    return null;
  }

  let alternating = true;

  for (let i = 0; i < 7; i++) {
    if (
      sequence[i] ===
      sequence[i + 1]
    ) {
      alternating = false;
      break;
    }
  }

  if (!alternating) {
    return null;
  }

  return {
    side:
      sequence[0] === "BIG"
        ? "SMALL"
        : "BIG",

    matches: 1,

    weight: 0.8,

    type: "alternation"
  };
}

/* =====================================================
   RECENT CONTEXT MODEL
   NOT SIMPLE FREQUENCY COUNT
===================================================== */

function contextSignal(sequence) {
  if (sequence.length < 6) {
    return null;
  }

  const windows = [
    sequence.slice(0, 3),
    sequence.slice(0, 5),
    sequence.slice(0, 7)
  ];

  const signals = [];

  for (
    const window of windows
  ) {
    if (window.length < 3) {
      continue;
    }

    const last =
      window[window.length - 1];

    const previous =
      window[window.length - 2];

    /*
      Detect immediate direction
      rather than raw BIG/SMALL count.
    */

    if (last !== previous) {
      signals.push({
        side: previous,
        weight: 0.35,
        type: "context"
      });
    }
  }

  if (!signals.length) {
    return null;
  }

  const vote =
    weightedVote(signals);

  return {
    side:
      vote.big >= vote.small
        ? "BIG"
        : "SMALL",

    matches: signals.length,

    weight:
      Math.min(
        1,
        vote.big + vote.small
      ),

    type: "context"
  };
}

/* =====================================================
   BACKTEST
===================================================== */

function calculateBacktest(history) {
  if (history.length < 20) {
    return {
      samples: 0,
      wins: 0,
      losses: 0,
      accuracy: 0
    };
  }

  const maxSamples =
    Math.min(
      35,
      history.length - 10
    );

  let wins = 0;
  let losses = 0;

  /*
    history is newest -> oldest.
    For each old point, only use data
    that was already available at that point.
  */

  for (
    let offset = 1;
    offset <= maxSamples;
    offset++
  ) {
    const targetIndex = offset;

    const training =
      history.slice(
        targetIndex,
        targetIndex + 60
      );

    if (training.length < 8) {
      continue;
    }

    const target =
      classify(
        history[targetIndex - 1]?.number
      );

    if (!target) {
      continue;
    }

    const result =
      analyzeCore(training, false);

    if (!result) {
      continue;
    }

    if (
      result.prediction === target
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
            wins * 1000 / total
          ) / 10
        : 0
  };
}

/* =====================================================
   CORE ANALYSIS
===================================================== */

function analyzeCore(history, includeBacktest = true) {
  const sequence =
    history
      .slice(0, 60)
      .map(row =>
        classify(row.number)
      )
      .filter(Boolean);

  if (sequence.length < 8) {
    return {
      prediction:
        sequence[0] === "BIG"
          ? "SMALL"
          : "BIG",

      confidence: 50,
      patternScore: 50,

      status: "LOW SIGNAL",

      agreement: 0,
      evidence: 0,

      matches: {
        exact: 0,
        similar: 0,
        transition: 0,
        runs: 0,
        alternation: 0,
        context: 0
      },

      backtest: {
        samples: 0,
        wins: 0,
        losses: 0,
        accuracy: 0
      }
    };
  }

  const signals = [];

  /* ---------------------------------------------
     EXACT PATTERNS
  --------------------------------------------- */

  for (
    const length of [2, 3, 4, 5, 6, 8]
  ) {
    const exact =
      exactPattern(
        sequence,
        length
      );

    if (exact) {
      /*
        Longer exact patterns are more specific.
      */

      if (length >= 5) {
        exact.weight *= 1.35;
      } else if (length >= 3) {
        exact.weight *= 1.1;
      }

      signals.push(exact);
    }

    const similar =
      similarPattern(
        sequence,
        length
      );

    if (similar) {
      signals.push(similar);
    }
  }

  /* ---------------------------------------------
     TRANSITION
  --------------------------------------------- */

  const transition =
    transitionSignal(sequence);

  if (transition) {
    signals.push(transition);
  }

  /* ---------------------------------------------
     RUN
  --------------------------------------------- */

  const run =
    runSignal(sequence);

  if (run) {
    signals.push(run);
  }

  /* ---------------------------------------------
     ALTERNATION
  --------------------------------------------- */

  const alternating =
    alternationSignal(sequence);

  if (alternating) {
    signals.push(alternating);
  }

  /* ---------------------------------------------
     CONTEXT
  --------------------------------------------- */

  const context =
    contextSignal(sequence);

  if (context) {
    signals.push(context);
  }

  if (!signals.length) {
    return {
      prediction:
        sequence[0] === "BIG"
          ? "SMALL"
          : "BIG",

      confidence: 50,
      patternScore: 50,

      status: "LOW SIGNAL",

      agreement: 0,
      evidence: 0,

      matches: {
        exact: 0,
        similar: 0,
        transition: 0,
        runs: 0,
        alternation: 0,
        context: 0
      },

      backtest: {
        samples: 0,
        wins: 0,
        losses: 0,
        accuracy: 0
      }
    };
  }

  /* ---------------------------------------------
     WEIGHTED DECISION
  --------------------------------------------- */

  const vote =
    weightedVote(signals);

  const total =
    vote.big + vote.small;

  let prediction =
    vote.big >= vote.small
      ? "BIG"
      : "SMALL";

  const margin =
    total
      ? Math.abs(
          vote.big - vote.small
        ) / total
      : 0;

  const sides =
    signals.map(
      signal =>
        signal.side
    );

  const bigSignals =
    sides.filter(
      side =>
        side === "BIG"
    ).length;

  const smallSignals =
    sides.filter(
      side =>
        side === "SMALL"
    ).length;

  const agreement =
    sides.length
      ? Math.max(
          bigSignals,
          smallSignals
        ) / sides.length
      : 0;

  /* ---------------------------------------------
     DIVERSITY
     Different models agreeing is stronger
     than same model repeating.
  --------------------------------------------- */

  const modelTypes =
    new Set(
      signals.map(
        signal =>
          signal.type
      )
    );

  const diversity =
    Math.min(
      1,
      modelTypes.size / 5
    );

  /* ---------------------------------------------
     BACKTEST
  --------------------------------------------- */

  const backtest =
    includeBacktest
      ? calculateBacktest(history)
      : {
          samples: 0,
          wins: 0,
          losses: 0,
          accuracy: 0
        };

  /*
    Backtest is a calibration signal,
    not a guarantee.
  */

  let confidence =
    50 +
    margin * 18 +
    Math.max(
      0,
      agreement - 0.5
    ) * 12 +
    diversity * 7;

  if (
    backtest.samples >= 10
  ) {
    if (
      backtest.accuracy >= 60
    ) {
      confidence += 3;
    }

    if (
      backtest.accuracy < 45
    ) {
      confidence -= 4;
    }
  }

  confidence =
    Math.round(
      Math.max(
        50,
        Math.min(
          72,
          confidence
        )
      )
    );

  /*
    Avoid showing a high score when
    signals disagree heavily.
  */

  if (
    agreement < 0.55 ||
    margin < 0.07
  ) {
    confidence =
      Math.min(
        confidence,
        55
      );
  }

  /* ---------------------------------------------
     PATTERN SCORE
  --------------------------------------------- */

  let patternScore =
    50 +
    margin * 28 +
    Math.max(
      0,
      agreement - 0.5
    ) * 24 +
    diversity * 8;

  if (
    backtest.samples >= 10
  ) {
    patternScore +=
      (
        backtest.accuracy - 50
      ) * 0.15;
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

  /* ---------------------------------------------
     STATUS
  --------------------------------------------- */

  let status =
    "LOW SIGNAL";

  if (
    agreement >= 0.65 &&
    margin >= 0.12 &&
    modelTypes.size >= 2
  ) {
    status =
      "NORMAL SIGNAL";
  }

  if (
    agreement >= 0.75 &&
    margin >= 0.18 &&
    modelTypes.size >= 3 &&
    backtest.samples >= 10 &&
    backtest.accuracy >= 50
  ) {
    status =
      "STRONG PATTERN";
  }

  /* ---------------------------------------------
     MATCH COUNTS
  --------------------------------------------- */

  const matches = {
    exact: 0,
    similar: 0,
    transition: 0,
    runs: 0,
    alternation: 0,
    context: 0
  };

  for (
    const signal of signals
  ) {
    if (
      signal.type === "exact"
    ) {
      matches.exact +=
        signal.matches || 0;
    }

    if (
      signal.type === "similar"
    ) {
      matches.similar +=
        signal.matches || 0;
    }

    if (
      signal.type === "transition"
    ) {
      matches.transition +=
        signal.matches || 0;
    }

    if (
      signal.type === "run"
    ) {
      matches.runs +=
        signal.matches || 0;
    }

    if (
      signal.type === "alternation"
    ) {
      matches.alternation +=
        signal.matches || 0;
    }

    if (
      signal.type === "context"
    ) {
      matches.context +=
        signal.matches || 0;
    }
  }

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
      signals.length,

    matches,

    backtest,

    sequence:
      sequence.slice(0, 12)
  };
}

/* =====================================================
   PUBLIC ANALYSIS
===================================================== */

function analyze(history) {
  return analyzeCore(
    history,
    true
  );
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
      row =>
        row.result === "WIN"
    ).length;

  const loss =
    rows.filter(
      row =>
        row.result === "LOSS"
    ).length;

  let streak = "-";

  if (rows.length) {
    const first =
      rows[0].result;

    let count = 0;

    for (
      const row of rows
    ) {
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
      normalizeHistory(data);

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
      extractCountdown(data);

    cache.lastUpdated =
      Date.now();

    cache.error =
      null;

    /*
      IMPORTANT:
      Prediction is regenerated only
      when a new settled result appears.
    */

    if (changed) {
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
        Then calculate fresh analysis.
      */

      cache.analysis =
        analyze(history);

      /*
        Start timer from new settled
        result.
      */

      cache.anchorTime =
        Date.now();

      /*
        Save prediction for target issue.
      */

      await savePrediction(
        targetIssue,
        cache.analysis
      );

      console.log(
        "NEW RESULT:",
        settledIssue,
        "TARGET:",
        targetIssue,
        "PRED:",
        cache.analysis.prediction
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
   ADMIN PING
===================================================== */

function adminPing() {
  return {
    ok: true,
    serverTime: Date.now(),
    providerConnected:
      !!WINGOBOT_TOKEN,
    databaseConnected:
      !!process.env.DATABASE_URL,
    historyCount:
      cache.history.length,
    targetIssue:
      cache.targetIssue,
    settledIssue:
      cache.settledIssue
  };
}

/* =====================================================
   API HANDLER
===================================================== */

async function handleAPI(
  req,
  res,
  url
) {
  /* ---------------------------------------------
     HEALTH
  --------------------------------------------- */

  if (
    url.pathname === "/health"
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

  /* ---------------------------------------------
     STATE
  --------------------------------------------- */

  if (
    url.pathname === "/api/state" &&
    req.method === "GET"
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

  /* ---------------------------------------------
     WIN LOSS
  --------------------------------------------- */

  if (
    url.pathname === "/api/history" &&
    req.method === "GET"
  ) {
    return sendJSON(
      res,
      200,
      await getWinLoss()
    );
  }

  /* ---------------------------------------------
     ACCESS KEY
  --------------------------------------------- */

  if (
    url.pathname === "/api/key/check" &&
    req.method === "POST"
  ) {
    const data =
      await readBody(req);

    const key =
      String(
        data.key || ""
      ).trim();

    const device =
      String(
        req.headers["x-device-id"] ||
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

    if (!result.rowCount) {
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

  /* ---------------------------------------------
     ADMIN
  --------------------------------------------- */

  if (
    url.pathname.startsWith(
      "/api/admin/"
    )
  ) {
    const admin =
      req.headers["x-admin-key"];

    if (
      admin !== ADMIN_KEY
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
        adminPing()
      );
    }

    /* ADMIN STATUS */

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

          history:
            cache.history.length,

          targetIssue:
            cache.targetIssue,

          settledIssue:
            cache.settledIssue
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

    /* BACKTEST */

    if (
      url.pathname ===
      "/api/admin/backtest"
    ) {
      return sendJSON(
        res,
        200,
        {
          ok: true,

          backtest:
            cache.analysis?.backtest ||
            calculateBacktest(
              cache.history
            )
        }
      );
    }

    /* LIST KEYS */

    if (
      url.pathname ===
        "/api/admin/keys" &&
      req.method === "GET"
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
      req.method === "POST"
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

      const requested =
        Number(
          data.count || 1
        );

      const count =
        Math.max(
          1,
          Math.min(
            100,
            Number.isFinite(
              requested
            )
              ? Math.floor(
                  requested
                )
              : 1
          )
        );

      const keys = [];

      for (
        let i = 0;
        i < count;
        i++
      ) {
        let created = false;

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
      req.method === "DELETE"
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
      req.method === "POST"
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
      "application/json"
  };

  /* ---------------------------------------------
     MP3 RANGE SUPPORT
  --------------------------------------------- */

  if (
    ext === ".mp3"
  ) {
    const stat =
      fs.statSync(filePath);

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

        end =
          Math.min(
            end,
            stat.size - 1
          );

        if (
          start >= 0 &&
          start < stat.size &&
          end >= start
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
      .createReadStream(filePath)
      .pipe(res);
  }

  res.writeHead(
    200,
    {
      "Content-Type":
        types[ext] ||
        "application/octet-stream"
    }
  );

  fs
    .createReadStream(filePath)
    .pipe(res);
}

/* =====================================================
   SERVER
===================================================== */

const server =
  http.createServer(
    async (req, res) => {
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
        console.error(error);

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

    /*
      Provider unavailable होने पर server
      बंद नहीं होगा.
    */

    try {
      await updateCache();
    } catch (error) {
      console.error(
        "Initial provider update:",
        error.message
      );
    }

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
      "STARTUP ERROR:",
      error
    );

    /*
      Render पर useful error देने के लिए
      process exit केवल database/server
      initialization failure पर होगा.
    */

    process.exit(1);
  }
})();
