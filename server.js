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
    return String(a).localeCompare(String(b));
  }
}

function nextIssue(value) {
  const s = cleanIssue(value);
  const match = s.match(/^(.*?)(\d+)$/);

  if (!match) return null;

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
   PROVIDER
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
        Accept: "application/json"
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
   UTILITIES
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

  return { big, small };
}

function sideFromVote(big, small) {
  if (big === small) return null;
  return big > small ? "BIG" : "SMALL";
}

/* =====================================================
   RECENT WINDOW SIGNAL
===================================================== */

function recentSignal(sequence, size, weight) {
  if (sequence.length < size) {
    return null;
  }

  const data =
    sequence.slice(0, size);

  let big = 0;
  let small = 0;

  data.forEach((side, index) => {
    const w =
      weight *
      (1 - index / (size * 1.8));

    if (side === "BIG") big += w;
    if (side === "SMALL") small += w;
  });

  const side =
    sideFromVote(big, small);

  if (!side) return null;

  return {
    side,
    weight: Math.abs(big - small),
    matches: size,
    type: `recent${size}`
  };
}

/* =====================================================
   TRANSITION MATRIX
===================================================== */

function transitionMatrix(sequence) {
  if (sequence.length < 12) {
    return null;
  }

  let BB = 0;
  let BS = 0;
  let SB = 0;
  let SS = 0;

  for (
    let i = 0;
    i < sequence.length - 1;
    i++
  ) {
    const a = sequence[i];
    const b = sequence[i + 1];

    if (a === "BIG" && b === "BIG") BB++;
    if (a === "BIG" && b === "SMALL") BS++;
    if (a === "SMALL" && b === "BIG") SB++;
    if (a === "SMALL" && b === "SMALL") SS++;
  }

  const current = sequence[0];

  let stay;
  let change;

  if (current === "BIG") {
    stay = BB;
    change = BS;
  } else {
    stay = SS;
    change = SB;
  }

  const total = stay + change;

  if (!total) return null;

  /*
    Only use this as a weak statistical signal.
  */

  if (stay === change) {
    return null;
  }

  return {
    side:
      stay > change
        ? current
        : current === "BIG"
          ? "SMALL"
          : "BIG",

    weight:
      Math.min(
        1.8,
        Math.abs(stay - change) /
        Math.max(1, total)
      ),

    matches: total,

    type: "transition"
  };
}

/* =====================================================
   STREAK / REVERSAL
===================================================== */

function streakSignal(sequence) {
  if (sequence.length < 6) {
    return null;
  }

  const current =
    sequence[0];

  let streak = 0;

  for (
    const side of sequence
  ) {
    if (side !== current) break;
    streak++;
  }

  if (streak < 2) {
    return null;
  }

  /*
    A streak is NOT treated as guaranteed
    reversal. It only gets a small weight.
  */

  let side;

  if (streak >= 4) {
    side =
      current === "BIG"
        ? "SMALL"
        : "BIG";
  } else {
    side = current;
  }

  return {
    side,

    weight:
      streak >= 5
        ? 0.9
        : streak >= 4
          ? 0.65
          : 0.25,

    matches: streak,

    type: "streak"
  };
}

/* =====================================================
   ALTERNATION
===================================================== */

function alternationSignal(sequence) {
  if (sequence.length < 7) {
    return null;
  }

  let alternating = true;

  for (let i = 0; i < 6; i++) {
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

    weight: 0.45,

    matches: 6,

    type: "alternation"
  };
}

/* =====================================================
   EXACT PATTERN
===================================================== */

function exactPattern(sequence, length) {
  if (
    sequence.length <
    length + 3
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
        .slice(i, i + length)
        .join("");

    if (old !== current) {
      continue;
    }

    const side =
      sequence[i - 1];

    signals.push({
      side,

      weight:
        1 /
        (1 + i * 0.08)
    });
  }

  if (!signals.length) {
    return null;
  }

  const vote =
    weightedVote(signals);

  const side =
    sideFromVote(
      vote.big,
      vote.small
    );

  if (!side) return null;

  return {
    side,

    matches:
      signals.length,

    weight:
      Math.min(
        2,
        vote.big + vote.small
      ),

    type: "exact"
  };
}

/* =====================================================
   SIMILAR PATTERN
===================================================== */

function similarPattern(sequence, length) {
  if (
    sequence.length <
    length + 3
  ) {
    return null;
  }

  const current =
    sequence.slice(
      0,
      length
    );

  const maxDistance =
    length <= 4 ? 1 : 2;

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
        current[j] !== old[j]
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
        0.35 /
        (1 + i * 0.08)
    });
  }

  if (!signals.length) {
    return null;
  }

  const vote =
    weightedVote(signals);

  const side =
    sideFromVote(
      vote.big,
      vote.small
    );

  if (!side) return null;

  return {
    side,

    matches:
      signals.length,

    weight:
      Math.min(
        1.4,
        vote.big + vote.small
      ),

    type: "similar"
  };
}

/* =====================================================
   RUN PATTERN
===================================================== */

function runSignal(sequence) {
  if (sequence.length < 10) {
    return null;
  }

  const current =
    sequence[0];

  let currentRun = 0;

  while (
    currentRun <
      sequence.length &&
    sequence[currentRun] ===
      current
  ) {
    currentRun++;
  }

  if (currentRun < 2) {
    return null;
  }

  const signals = [];

  for (
    let i = currentRun + 1;
    i < sequence.length - 1;
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
      signals.push({
        side:
          sequence[i - 1],

        weight:
          0.45 /
          (1 + i * 0.07)
      });
    }
  }

  if (!signals.length) {
    return null;
  }

  const vote =
    weightedVote(signals);

  const side =
    sideFromVote(
      vote.big,
      vote.small
    );

  if (!side) return null;

  return {
    side,

    matches:
      signals.length,

    weight:
      Math.min(
        1,
        vote.big + vote.small
      ),

    type: "run"
  };
}

/* =====================================================
   SIGNAL CALIBRATION
===================================================== */

function signalCalibration(
  tests,
  signalType
) {
  const rows =
    tests.filter(
      x =>
        x.signalTypes &&
        x.signalTypes.includes(
          signalType
        )
    );

  if (rows.length < 5) {
    return 1;
  }

  const wins =
    rows.filter(
      x =>
        x.result === "WIN"
    ).length;

  const accuracy =
    wins / rows.length;

  /*
    Baseline weight = 1.
    Poor historical performance
    reduces influence.
  */

  if (accuracy < 0.40) {
    return 0.55;
  }

  if (accuracy < 0.45) {
    return 0.70;
  }

  if (accuracy < 0.50) {
    return 0.85;
  }

  if (accuracy < 0.55) {
    return 1.00;
  }

  if (accuracy < 0.60) {
    return 1.08;
  }

  return 1.15;
}

/* =====================================================
   BASIC PREDICTION
===================================================== */

function rawAnalysis(
  history,
  calibration = null
) {
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
        runs: 0
      },

      signalTypes: []
    };
  }

  const signals = [];

  const recent5 =
    recentSignal(
      sequence,
      5,
      0.55
    );

  if (recent5) {
    signals.push(recent5);
  }

  const recent10 =
    recentSignal(
      sequence,
      10,
      0.35
    );

  if (recent10) {
    signals.push(recent10);
  }

  const recent20 =
    recentSignal(
      sequence,
      20,
      0.20
    );

  if (recent20) {
    signals.push(recent20);
  }

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
      exact.weight *=
        length >= 4
          ? 1.15
          : 0.85;

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

  const transition =
    transitionMatrix(
      sequence
    );

  if (transition) {
    signals.push(transition);
  }

  const streak =
    streakSignal(
      sequence
    );

  if (streak) {
    signals.push(streak);
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

  /*
    Apply historical signal calibration
    only when enough backtest data exists.
  */

  for (const signal of signals) {
    if (calibration) {
      const factor =
        calibration(
          signal.type
        );

      signal.weight *= factor;
    }
  }

  const vote =
    weightedVote(signals);

  const total =
    vote.big +
    vote.small;

  let prediction =
    sideFromVote(
      vote.big,
      vote.small
    );

  if (!prediction) {
    prediction =
      sequence[0] === "BIG"
        ? "SMALL"
        : "BIG";
  }

  const margin =
    total
      ? Math.abs(
          vote.big -
          vote.small
        ) / total
      : 0;

  const sides =
    signals.map(
      x => x.side
    );

  const agreement =
    sides.length
      ? Math.max(
          sides.filter(
            x =>
              x === "BIG"
          ).length,

          sides.filter(
            x =>
              x === "SMALL"
          ).length
        ) /
        sides.length
      : 0;

  /*
    Conservative confidence.
  */

  let confidence =
    Math.round(
      50 +
      margin * 13 +
      Math.max(
        0,
        agreement - 0.5
      ) * 12
    );

  confidence =
    Math.max(
      50,
      Math.min(
        68,
        confidence
      )
    );

  if (
    agreement < 0.58 ||
    margin < 0.07
  ) {
    confidence =
      Math.min(
        confidence,
        54
      );
  }

  const exactMatches =
    signals
      .filter(
        x =>
          x.type === "exact"
      )
      .reduce(
        (sum, x) =>
          sum + x.matches,
        0
      );

  const similarMatches =
    signals
      .filter(
        x =>
          x.type === "similar"
      )
      .reduce(
        (sum, x) =>
          sum + x.matches,
        0
      );

  const transitionMatches =
    signals
      .filter(
        x =>
          x.type === "transition"
      )
      .reduce(
        (sum, x) =>
          sum + x.matches,
        0
      );

  const runMatches =
    signals
      .filter(
        x =>
          x.type === "run"
      )
      .reduce(
        (sum, x) =>
          sum + x.matches,
        0
      );

  const patternScore =
    Math.max(
      50,
      Math.min(
        90,
        Math.round(
          50 +
          margin * 28 +
          Math.max(
            0,
            agreement - 0.5
          ) * 22
        )
      )
    );

  return {
    prediction,

    confidence,

    patternScore,

    status:
      agreement >= 0.64 &&
      margin >= 0.10
        ? "NORMAL SIGNAL"
        : "LOW SIGNAL",

    agreement:
      Math.round(
        agreement * 100
      ),

    evidence:
      signals.length,

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

    signalTypes:
      signals.map(
        x => x.type
      ),

    sequence:
      sequence.slice(0, 12)
  };
}

/* =====================================================
   ROLLING BACKTEST
===================================================== */

function calculateBacktest(history) {
  const rows =
    history
      .slice()
      .sort(
        (a, b) =>
          compareIssues(
            a.issueNumber,
            b.issueNumber
          )
      );

  if (rows.length < 15) {
    return {
      sample: 0,
      wins: 0,
      losses: 0,
      accuracy: 0,
      last20: 0,
      last50: 0,
      recent: []
    };
  }

  const tests = [];

  /*
    First pass:
    calculate predictions using
    only information available
    before each target.
  */

  for (
    let i = 8;
    i < rows.length;
    i++
  ) {
    const past =
      rows.slice(
        0,
        i
      );

    const target =
      rows[i];

    const analysis =
      rawAnalysis(
        past
      );

    const actual =
      classify(
        target.number
      );

    if (
      !analysis ||
      !analysis.prediction ||
      !actual
    ) {
      continue;
    }

    tests.push({
      issue:
        target.issueNumber,

      prediction:
        analysis.prediction,

      actual,

      result:
        analysis.prediction === actual
          ? "WIN"
          : "LOSS",

      signalTypes:
        analysis.signalTypes || []
    });
  }

  const wins =
    tests.filter(
      x =>
        x.result === "WIN"
    ).length;

  const losses =
    tests.filter(
      x =>
        x.result === "LOSS"
    ).length;

  const accuracy =
    tests.length
      ? Math.round(
          wins *
          1000 /
          tests.length
        ) / 10
      : 0;

  const last20 =
    tests.slice(-20);

  const last50 =
    tests.slice(-50);

  const last20Wins =
    last20.filter(
      x =>
        x.result === "WIN"
    ).length;

  const last50Wins =
    last50.filter(
      x =>
        x.result === "WIN"
    ).length;

  /*
    Per-signal calibration.
  */

  const signalAccuracy = {};

  const types = [
    "recent5",
    "recent10",
    "recent20",
    "exact",
    "similar",
    "transition",
    "streak",
    "run",
    "alternation"
  ];

  for (const type of types) {
    const relevant =
      tests.filter(
        x =>
          x.signalTypes.includes(
            type
          )
      );

    const signalWins =
      relevant.filter(
        x =>
          x.result === "WIN"
      ).length;

    signalAccuracy[type] =
      relevant.length
        ? {
            sample:
              relevant.length,

            wins:
              signalWins,

            accuracy:
              Math.round(
                signalWins *
                1000 /
                relevant.length
              ) / 10
          }
        : {
            sample: 0,
            wins: 0,
            accuracy: 0
          };
  }

  return {
    sample:
      tests.length,

    wins,

    losses,

    accuracy,

    last20:
      last20.length
        ? Math.round(
            last20Wins *
            1000 /
            last20.length
          ) / 10
        : 0,

    last50:
      last50.length
        ? Math.round(
            last50Wins *
            1000 /
            last50.length
          ) / 10
        : 0,

    signalAccuracy,

    recent:
      tests.slice(-10)
  };
}

/* =====================================================
   FINAL ANALYSIS
===================================================== */

function analyze(history) {
  const backtest =
    calculateBacktest(
      history
    );

  let calibration =
    null;

  if (
    backtest.sample >= 15
  ) {
    calibration =
      type =>
        signalCalibration(
          backtest.recent.length >= 5
            ? [
                ...backtest.recent
              ]
            : [],
          type
        );

    /*
      Use complete reconstructed
      backtest if available.
    */

    const allRows =
      history
        .slice()
        .sort(
          (a, b) =>
            compareIssues(
              a.issueNumber,
              b.issueNumber
            )
        );

    const tests = [];

    for (
      let i = 8;
      i < allRows.length;
      i++
    ) {
      const past =
        allRows.slice(
          0,
          i
        );

      const target =
        allRows[i];

      const a =
        rawAnalysis(
          past
        );

      const actual =
        classify(
          target.number
        );

      if (
        a &&
        a.prediction &&
        actual
      ) {
        tests.push({
          prediction:
            a.prediction,

          actual,

          result:
            a.prediction === actual
              ? "WIN"
              : "LOSS",

          signalTypes:
            a.signalTypes || []
        });
      }
    }

    calibration =
      type =>
        signalCalibration(
          tests,
          type
        );
  }

  const result =
    rawAnalysis(
      history,
      calibration
    );

  result.backtest = {
    sample:
      backtest.sample,

    accuracy:
      backtest.accuracy,

    last20:
      backtest.last20,

    last50:
      backtest.last50,

    signalAccuracy:
      backtest.signalAccuracy
  };

  return result;
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
    ON CONFLICT(target_issue)
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

  if (!actual) return;

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
  if (!process.env.DATABASE_URL) {
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
              win *
              1000 /
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
      extractCountdown(data);

    cache.lastUpdated =
      Date.now();

    cache.error = null;

    if (changed) {
      cache.historySignature =
        signature;

      cache.historyVersion++;

      cache.analysis =
        analyze(history);

      cache.anchorTime =
        Date.now();

      /*
        Settle previous prediction
        first, then create new one.
      */

      await settlePrediction(
        history[0]
      );

      await savePrediction(
        targetIssue,
        cache.analysis
      );

      console.log(
        "NEW RESULT",
        settledIssue,
        "| NEXT",
        targetIssue,
        "| PRED",
        cache.analysis.prediction,
        "| CONF",
        cache.analysis.confidence,
        "| BACKTEST",
        cache.analysis.backtest?.accuracy
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
   ADMIN
===================================================== */

function isAdmin(req) {
  return (
    req.headers["x-admin-key"] ===
    ADMIN_KEY
  );
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
    url.pathname === "/health"
  ) {
    return sendJSON(
      res,
      200,
      {
        ok: true,
        time: Date.now(),
        database:
          !!process.env.DATABASE_URL,
        wingobot:
          !!WINGOBOT_TOKEN
      }
    );
  }

  /* STATE */

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

  /* WIN LOSS */

  if (
    url.pathname ===
      "/api/history" &&
    req.method === "GET"
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

  /* ===================================================
     ADMIN
  =================================================== */

  if (
    url.pathname.startsWith(
      "/api/admin/"
    )
  ) {
    if (!isAdmin(req)) {
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

    /* PING */

    if (
      url.pathname ===
      "/api/admin/ping"
    ) {
      return sendJSON(
        res,
        200,
        {
          ok: true,
          message:
            "Admin API working",
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
          ok: true,
          message:
            "Device reset"
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
      "application/json; charset=utf-8",

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

  /* MP3 */

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
        "application/octet-stream"
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
          "SERVER ERROR:",
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

    try {
      await updateCache();
    } catch (error) {
      console.error(
        "Initial provider error:",
        error.message
      );
    }

    setInterval(
      updateCache,
      1000
    );

    server.listen(
      PORT,
      "0.0.0.0",
      () => {
        console.log(
          `DY AI server running on ${PORT}`
        );
      }
    );
  } catch (error) {
    console.error(
      "START ERROR:",
      error
    );

    process.exit(1);
  }
})();
