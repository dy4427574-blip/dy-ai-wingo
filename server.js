const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 10000);

const ADMIN_KEY = String(
  process.env.ADMIN_KEY || "dy4427574"
).trim();

const WINGOBOT_TOKEN = String(
  process.env.WINGOBOT_TOKEN || ""
).trim();

const WINGOBOT_URL = String(
  process.env.WINGOBOT_URL ||
    "https://api.wingobot.com/v2/30-sec-game-history"
).trim();

const ROUND_SECONDS = 30;

const LIVE_RESULTS_LIMIT = 30;
const WINLOSS_LIMIT = 30;

const POLL_MS = 1000;


/* =====================================================
   DATABASE
===================================================== */

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes("localhost")
        ? false
        : { rejectUnauthorized: false },
      max: 5
    })
  : null;


/* =====================================================
   GLOBAL STATE
===================================================== */

const state = {
  history: [],
  analysis: null,
  prediction: null,

  targetIssue: null,
  settledIssue: null,
  nextIssue: null,

  providerCurrent: null,

  lastSignature: "",
  lastProviderUpdate: 0,

  lastError: "",
  updatedAt: 0,

  ready: false
};


/* =====================================================
   RESPONSE HELPERS
===================================================== */

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);

  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    Pragma: "no-cache",
    "Content-Length": Buffer.byteLength(body)
  });

  res.end(body);
}


function sendText(
  res,
  status,
  body,
  contentType = "text/plain; charset=utf-8"
) {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body)
  });

  res.end(body);
}


/* =====================================================
   BODY PARSER
===================================================== */

function parseJSONBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";

    req.on("data", chunk => {
      raw += chunk;

      if (raw.length > 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });

    req.on("error", reject);
  });
}


/* =====================================================
   ADMIN AUTH
===================================================== */

function getAdminKey(req) {
  const headerKey =
    req.headers["x-admin-key"];

  const authorization =
    req.headers["authorization"];

  if (headerKey) {
    return String(headerKey).trim();
  }

  if (authorization) {
    return String(authorization)
      .replace(/^Bearer\s+/i, "")
      .trim();
  }

  return "";
}


function isAdmin(req) {
  const key = getAdminKey(req);

  return Boolean(
    key &&
    ADMIN_KEY &&
    key === ADMIN_KEY
  );
}


function requireAdmin(req, res) {
  if (!isAdmin(req)) {
    sendJSON(res, 403, {
      success: false,
      ok: false,
      error: "Invalid admin key"
    });

    return false;
  }

  return true;
}


/* =====================================================
   GENERAL HELPERS
===================================================== */

function firstDefined(...values) {
  for (const value of values) {
    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {
      return value;
    }
  }

  return null;
}


function normalizeNumber(value) {
  const n = Number(value);

  if (
    Number.isFinite(n) &&
    n >= 0 &&
    n <= 9
  ) {
    return Math.trunc(n);
  }

  return null;
}


function issueKey(value) {
  return String(value ?? "").trim();
}


function compareIssues(a, b) {
  const A = issueKey(a);
  const B = issueKey(b);

  if (
    /^\d+$/.test(A) &&
    /^\d+$/.test(B)
  ) {
    if (A.length !== B.length) {
      return A.length - B.length;
    }

    return A.localeCompare(B);
  }

  return A.localeCompare(B, undefined, {
    numeric: true
  });
}


function nextIssue(issue) {
  const value = issueKey(issue);

  if (
    !value ||
    !/^\d+$/.test(value)
  ) {
    return null;
  }

  try {
    return String(BigInt(value) + 1n);
  } catch {
    return null;
  }
}


function sideOf(number) {
  const n = normalizeNumber(number);

  if (n === null) {
    return null;
  }

  return n >= 5 ? "BIG" : "SMALL";
}


function clamp(value, min, max) {
  return Math.max(
    min,
    Math.min(
      max,
      Number(value) || 0
    )
  );
}


function percentage(value) {
  return Math.round(
    clamp(value, 0, 100)
  );
}


/* =====================================================
   HISTORY NORMALIZER
===================================================== */

function normalizeHistory(payload) {
  const candidates = [
    payload?.history,
    payload?.data?.history,
    payload?.data?.data,
    payload?.data,
    payload?.results
  ];

  let rows =
    candidates.find(
      item => Array.isArray(item)
    ) || [];

  const output = [];

  for (const row of rows) {
    if (
      !row ||
      typeof row !== "object"
    ) {
      continue;
    }

    const issue = firstDefined(
      row.issueNumber,
      row.issue_number,
      row.period,
      row.issue,
      row.round,
      row.id
    );

    const number = normalizeNumber(
      firstDefined(
        row.number,
        row.num,
        row.result,
        row.openNumber,
        row.open_number
      )
    );

    if (
      !issue ||
      number === null
    ) {
      continue;
    }

    output.push({
      issueNumber: issueKey(issue),
      number,

      colour: firstDefined(
        row.colour,
        row.color,
        row.colourName,
        null
      ),

      premium: firstDefined(
        row.premium,
        null
      ),

      sum: firstDefined(
        row.sum,
        null
      )
    });
  }

  const unique = new Map();

  for (const row of output) {
    unique.set(
      row.issueNumber,
      row
    );
  }

  return [...unique.values()].sort(
    (a, b) =>
      compareIssues(
        b.issueNumber,
        a.issueNumber
      )
  );
}


/* =====================================================
   PROVIDER CURRENT
===================================================== */

function getProviderCurrent(payload) {
  const current =
    payload?.current ||
    payload?.data?.current ||
    payload?.data?.currentGame ||
    null;

  if (!current) {
    return null;
  }

  return {
    ...current,

    issueNumber: issueKey(
      firstDefined(
        current.issueNumber,
        current.issue_number,
        current.period,
        current.issue
      )
    ),

    countdown: firstDefined(
      current.countdown,
      current.remaining,
      current.remainingSeconds,
      current.secondsLeft,
      null
    )
  };
}


/* =====================================================
   WINGOBOT FETCH
===================================================== */

async function fetchWingo() {
  if (!WINGOBOT_TOKEN) {
    throw new Error(
      "WINGOBOT_TOKEN is not configured"
    );
  }

  const controller =
    new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    12000
  );

  try {
    const response = await fetch(
      WINGOBOT_URL,
      {
        method: "GET",

        headers: {
          Authorization:
            `Bearer ${WINGOBOT_TOKEN}`,

          Accept:
            "application/json"
        },

        signal: controller.signal
      }
    );

    const raw =
      await response.text();

    let data;

    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(
        `WingoBot returned non-JSON (${response.status})`
      );
    }

    if (!response.ok) {
      throw new Error(
        data?.message ||
        data?.error ||
        `WingoBot HTTP ${response.status}`
      );
    }

    const history =
      normalizeHistory(data);

    if (!history.length) {
      throw new Error(
        "WingoBot returned no settled history"
      );
    }

    return {
      raw: data,
      history,

      current:
        getProviderCurrent(data),

      fetched: Number(
        data?.stats?.fetched ||
        data?.data?.stats?.fetched ||
        history.length
      )
    };
  } finally {
    clearTimeout(timeout);
  }
}


/* =====================================================
   MODEL HELPERS
===================================================== */

function sideSeries(history) {
  return history
    .map(row => sideOf(row.number))
    .filter(Boolean);
}


function numberSeries(history) {
  return history
    .map(row => row.number)
    .filter(Number.isFinite);
}


function countSides(values) {
  const result = {
    BIG: 0,
    SMALL: 0
  };

  for (const value of values) {
    if (
      value === "BIG" ||
      value === "SMALL"
    ) {
      result[value]++;
    }
  }

  return result;
}


/* =====================================================
   MICRO TREND MODEL
===================================================== */

function microTrendModel(history) {
  const sample =
    history.slice(
      0,
      Math.min(5, history.length)
    );

  if (sample.length < 3) {
    return null;
  }

  const sides =
    sideSeries(sample);

  const counts =
    countSides(sides);

  const prediction =
    counts.BIG >= counts.SMALL
      ? "BIG"
      : "SMALL";

  const confidence =
    percentage(
      Math.abs(
        counts.BIG -
        counts.SMALL
      ) /
      sample.length *
      100
    );

  return {
    name: "Micro Trend",
    side: prediction,
    confidence,
    strength: confidence,

    detail:
      `Last ${sample.length}: BIG ${counts.BIG}, SMALL ${counts.SMALL}`
  };
}


/* =====================================================
   FREQUENCY MODEL
===================================================== */

function frequencyModel(
  history,
  windowSize
) {
  const sample =
    history.slice(
      0,
      Math.min(
        windowSize,
        history.length
      )
    );

  if (sample.length < 8) {
    return null;
  }

  const counts =
    countSides(
      sideSeries(sample)
    );

  const total =
    counts.BIG +
    counts.SMALL;

  if (!total) {
    return null;
  }

  const bigRatio =
    counts.BIG / total;

  const prediction =
    bigRatio >= 0.5
      ? "BIG"
      : "SMALL";

  const confidence =
    percentage(
      Math.abs(
        bigRatio - 0.5
      ) * 200
    );

  return {
    name:
      `Frequency ${sample.length}`,

    side:
      prediction,

    confidence,

    strength:
      confidence,

    detail:
      `BIG ${counts.BIG}/${total}, SMALL ${counts.SMALL}/${total}`
  };
}


/* =====================================================
   TRANSITION MODEL
===================================================== */

function transitionModel(history) {
  if (history.length < 8) {
    return null;
  }

  const sides =
    sideSeries(history);

  const transitions = {
    BIG: {
      BIG: 0,
      SMALL: 0
    },

    SMALL: {
      BIG: 0,
      SMALL: 0
    }
  };

  for (
    let i = 1;
    i < sides.length;
    i++
  ) {
    const previous =
      sides[i];

    const next =
      sides[i - 1];

    if (
      transitions[previous] &&
      transitions[previous][next] !== undefined
    ) {
      transitions[previous][next]++;
    }
  }

  const latest =
    sides[0];

  const row =
    transitions[latest];

  const total =
    row.BIG +
    row.SMALL;

  if (!total) {
    return null;
  }

  const bigRatio =
    row.BIG / total;

  const prediction =
    bigRatio >= 0.5
      ? "BIG"
      : "SMALL";

  const confidence =
    percentage(
      Math.abs(
        bigRatio - 0.5
      ) * 200
    );

  return {
    name: "Transition Model",

    side:
      prediction,

    confidence,

    strength:
      confidence,

    detail:
      `${latest} → BIG ${(bigRatio * 100).toFixed(0)}% / SMALL ${((1 - bigRatio) * 100).toFixed(0)}%`
  };
}


/* =====================================================
   RUN LENGTH MODEL
===================================================== */

function runLengthModel(history) {
  const sides =
    sideSeries(history);

  if (sides.length < 6) {
    return null;
  }

  const latest =
    sides[0];

  let run = 0;

  for (const side of sides) {
    if (side === latest) {
      run++;
    } else {
      break;
    }
  }

  let prediction;
  let confidence;

  if (run >= 3) {
    prediction =
      latest === "BIG"
        ? "SMALL"
        : "BIG";

    confidence =
      Math.min(
        45,
        18 + run * 5
      );
  } else {
    prediction = latest;
    confidence = 20;
  }

  return {
    name: "Run-Length Model",

    side:
      prediction,

    confidence,

    strength:
      confidence,

    detail:
      `${latest} streak = ${run}`
  };
}


/* =====================================================
   ALTERNATION MODEL
===================================================== */

function alternationModel(history) {
  const sides =
    sideSeries(history)
      .slice(0, 12);

  if (sides.length < 6) {
    return null;
  }

  let alternating = 0;

  for (
    let i = 1;
    i < sides.length;
    i++
  ) {
    if (
      sides[i] !==
      sides[i - 1]
    ) {
      alternating++;
    }
  }

  const score =
    alternating /
    (sides.length - 1);

  if (score < 0.58) {
    return null;
  }

  const prediction =
    sides[0] === "BIG"
      ? "SMALL"
      : "BIG";

  const confidence =
    percentage(
      (score - 0.5) * 100
    );

  return {
    name: "Alternation Model",

    side:
      prediction,

    confidence,

    strength:
      confidence,

    detail:
      `Alternation ${(score * 100).toFixed(0)}%`
  };
}


/* =====================================================
   HISTORICAL PATTERN MATCH
===================================================== */

function patternMatchModel(history) {
  if (history.length < 25) {
    return null;
  }

  const sides =
    sideSeries(history);

  const length = 4;

  const current =
    sides
      .slice(0, length)
      .join("");

  if (
    current.length !==
    length
  ) {
    return null;
  }

  let matches = 0;
  let bigAfter = 0;
  let smallAfter = 0;

  for (
    let i = length;
    i < sides.length;
    i++
  ) {
    const pattern =
      sides
        .slice(
          i,
          i + length
        )
        .join("");

    if (pattern !== current) {
      continue;
    }

    const after =
      sides[i - 1];

    matches++;

    if (after === "BIG") {
      bigAfter++;
    }

    if (after === "SMALL") {
      smallAfter++;
    }
  }

  if (matches < 3) {
    return null;
  }

  const prediction =
    bigAfter >= smallAfter
      ? "BIG"
      : "SMALL";

  const confidence =
    percentage(
      Math.abs(
        bigAfter -
        smallAfter
      ) /
      matches *
      100
    );

  return {
    name:
      "Historical Pattern Match",

    side:
      prediction,

    confidence,

    strength:
      confidence,

    detail:
      `Pattern ${current}, matches ${matches}`,

    matches
  };
}


/* =====================================================
   NUMBER MODEL
===================================================== */

function numberModel(history) {
  const sample =
    history.slice(
      0,
      Math.min(
        100,
        history.length
      )
    );

  if (sample.length < 10) {
    return null;
  }

  const numberCounts =
    Array(10).fill(0);

  for (const row of sample) {
    numberCounts[
      row.number
    ]++;
  }

  let best = 0;

  for (
    let n = 1;
    n <= 9;
    n++
  ) {
    if (
      numberCounts[n] >
      numberCounts[best]
    ) {
      best = n;
    }
  }

  return {
    number: best,

    side:
      sideOf(best),

    confidence:
      percentage(
        numberCounts[best] /
        sample.length *
        100
      ),

    counts:
      numberCounts
  };
}


/* =====================================================
   BUILD MODELS
===================================================== */

function buildModels(history) {
  return [
    microTrendModel(history),

    frequencyModel(
      history,
      20
    ),

    frequencyModel(
      history,
      50
    ),

    frequencyModel(
      history,
      200
    ),

    frequencyModel(
      history,
      history.length
    ),

    transitionModel(history),

    runLengthModel(history),

    alternationModel(history),

    patternMatchModel(history)
  ].filter(Boolean);
}


/* =====================================================
   ENSEMBLE
===================================================== */

function ensemble(history) {
  const models =
    buildModels(history);

  if (!models.length) {
    return {
      prediction: null,
      confidence: 0,
      agreement: 0,
      patternScore: 0,
      models: [],
      number: null,
      status: "INSUFFICIENT DATA"
    };
  }

  const weights = {
    "Micro Trend": 1.00,

    "Frequency 20": 1.00,

    "Frequency 50": 1.20,

    "Frequency 200": 1.10,

    [`Frequency ${history.length}`]: 1.00,

    "Transition Model": 1.40,

    "Run-Length Model": 0.70,

    "Alternation Model": 0.70,

    "Historical Pattern Match": 1.50
  };

  let bigScore = 0;
  let smallScore = 0;
  let totalWeight = 0;

  for (const model of models) {
    const weight =
      weights[model.name] || 1;

    const strength =
      Math.max(
        0.15,
        (model.confidence || 0) / 100
      );

    const value =
      weight * strength;

    if (model.side === "BIG") {
      bigScore += value;
    } else {
      smallScore += value;
    }

    totalWeight += value;
  }

  const prediction =
    bigScore >= smallScore
      ? "BIG"
      : "SMALL";

  const margin =
    totalWeight
      ? Math.abs(
          bigScore -
          smallScore
        ) / totalWeight
      : 0;

  const agreement =
    totalWeight
      ? Math.max(
          bigScore,
          smallScore
        ) / totalWeight
      : 0;

  const numberPick =
    numberModel(history);

  let predictedNumber =
    numberPick?.number ??
    null;

  /*
    Make sure number belongs to
    selected BIG/SMALL side.
  */

  if (
    predictedNumber !== null &&
    sideOf(predictedNumber) !==
      prediction
  ) {
    const counts =
      numberPick.counts;

    let best = null;

    for (
      let n = 0;
      n <= 9;
      n++
    ) {
      if (
        sideOf(n) ===
        prediction &&
        (
          best === null ||
          counts[n] >
          counts[best]
        )
      ) {
        best = n;
      }
    }

    predictedNumber =
      best;
  }

  const historical =
    patternMatchModel(history);

  const patternScore =
    percentage(
      margin * 65 +
      Math.min(
        25,
        models.length * 3
      ) +
      Math.min(
        10,
        (historical?.matches || 0) * 2
      )
    );

  const rawConfidence =
    50 +
    margin * 45;

  let status =
    "EARLY SIGNAL";

  if (history.length < 30) {
    status =
      "INSUFFICIENT DATA";
  } else if (
    rawConfidence >= 70
  ) {
    status =
      "STATISTICAL LEAN";
  }

  return {
    prediction,

    predictedNumber,

    confidence:
      percentage(rawConfidence),

    agreement:
      percentage(
        agreement * 100
      ),

    patternScore,

    status,

    models
  };
}


/* =====================================================
   WALK-FORWARD BACKTEST
===================================================== */

function backtest(history) {
  const chronological =
    [...history].sort(
      (a, b) =>
        compareIssues(
          a.issueNumber,
          b.issueNumber
        )
    );

  const total =
    chronological.length;

  const minimumTraining = 25;

  if (
    total <=
    minimumTraining
  ) {
    return {
      samples: 0,
      wins: 0,
      losses: 0,
      accuracy: null
    };
  }

  /*
    Maximum 150 tests so that a very large
    API history does not overload Render.

    Every test still trains on ALL earlier
    history available at that point.
  */

  const maxSamples =
    Math.min(
      150,
      total -
        minimumTraining
    );

  const start =
    total -
    maxSamples;

  let wins = 0;
  let losses = 0;

  for (
    let i = start;
    i < total;
    i++
  ) {
    if (
      i <
      minimumTraining
    ) {
      continue;
    }

    const training =
      chronological
        .slice(0, i)
        .reverse();

    const actual =
      sideOf(
        chronological[i].number
      );

    const model =
      ensemble(training);

    if (!model.prediction) {
      continue;
    }

    if (
      model.prediction ===
      actual
    ) {
      wins++;
    } else {
      losses++;
    }
  }

  const samples =
    wins + losses;

  return {
    samples,
    wins,
    losses,

    accuracy:
      samples
        ? percentage(
            wins /
            samples *
            100
          )
        : null
  };
}


/* =====================================================
   FINAL ANALYSIS
===================================================== */

function analyzeHistory(history) {
  const clean =
    Array.isArray(history)
      ? history
      : [];

  const model =
    ensemble(clean);

  const test =
    backtest(clean);

  let confidence =
    model.confidence;

  /*
    Confidence calibration.
  */

  if (
    test.samples >= 20 &&
    test.accuracy !== null
  ) {
    const calibration =
      50 +
      Math.abs(
        test.accuracy - 50
      ) * 0.65;

    confidence =
      percentage(
        confidence * 0.45 +
        calibration * 0.55
      );
  }

  else if (
    test.samples > 0 &&
    test.accuracy !== null
  ) {
    const calibration =
      50 +
      Math.abs(
        test.accuracy - 50
      ) * 0.35;

    confidence =
      percentage(
        confidence * 0.65 +
        calibration * 0.35
      );
  }

  else {
    /*
      No backtest =
      don't show fake high confidence.
    */

    confidence =
      Math.min(
        confidence,
        clean.length >= 30
          ? 62
          : 55
      );
  }

  let status =
    model.status;

  if (test.samples === 0) {
    status =
      "EARLY SIGNAL";
  }

  if (
    test.samples >= 20 &&
    test.accuracy !== null
  ) {
    if (
      test.accuracy >= 60 &&
      confidence >= 62
    ) {
      status =
        "VALIDATED LEAN";
    }

    else if (
      test.accuracy < 50
    ) {
      status =
        "WEAK / UNVALIDATED";
    }

    else {
      status =
        "STATISTICAL LEAN";
    }
  }

  return {
    prediction:
      model.prediction,

    predictedNumber:
      model.predictedNumber,

    confidence,

    agreement:
      model.agreement,

    patternScore:
      model.patternScore,

    status,

    models:
      model.models.map(
        item => ({
          name:
            item.name,

          side:
            item.side,

          prediction:
            item.side,

          confidence:
            item.confidence,

          strength:
            item.strength,

          detail:
            item.detail,

          matches:
            item.matches || 0
        })
      ),

    backtest: test,

    historyUsed:
      clean.length,

    generatedAt:
      Date.now()
  };
}


/* =====================================================
   DATABASE INIT + MIGRATION
===================================================== */

async function initDB() {
  if (!pool) {
    console.log(
      "DATABASE_URL not configured"
    );

    return;
  }

  /*
    ACCESS KEYS
  */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS access_keys (
      id SERIAL PRIMARY KEY,
      access_key TEXT UNIQUE NOT NULL,
      device_id TEXT,
      created_at BIGINT NOT NULL,
      last_seen BIGINT DEFAULT 0
    )
  `);


  /*
    PREDICTIONS

    Important:
    We intentionally create issue_number
    as TEXT because Wingo issue numbers can
    be very large.
  */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS predictions (
      id SERIAL PRIMARY KEY,
      issue_number TEXT,
      prediction TEXT,
      predicted_number INTEGER,
      confidence NUMERIC DEFAULT 0,
      pattern_score INTEGER DEFAULT 0,
      agreement INTEGER DEFAULT 0,
      status TEXT,
      created_at BIGINT DEFAULT 0,
      settled_number INTEGER,
      result TEXT,
      settled_at BIGINT,
      backtest_samples INTEGER DEFAULT 0,
      backtest_accuracy NUMERIC,
      model_details JSONB
    )
  `);


  /*
    Check existing predictions columns.
  */

  const before =
    await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
      AND table_name = 'predictions'
    `);

  const existing =
    new Set(
      before.rows.map(
        row =>
          row.column_name
      )
    );


  /*
    Add missing columns.
  */

  const columns = [
    ["issue_number", "TEXT"],
    ["prediction", "TEXT"],
    ["predicted_number", "INTEGER"],
    ["confidence", "NUMERIC DEFAULT 0"],
    ["pattern_score", "INTEGER DEFAULT 0"],
    ["agreement", "INTEGER DEFAULT 0"],
    ["status", "TEXT"],
    ["created_at", "BIGINT DEFAULT 0"],
    ["settled_number", "INTEGER"],
    ["result", "TEXT"],
    ["settled_at", "BIGINT"],
    ["backtest_samples", "INTEGER DEFAULT 0"],
    ["backtest_accuracy", "NUMERIC"],
    ["model_details", "JSONB"]
  ];


  for (
    const [column, type]
    of columns
  ) {
    if (!existing.has(column)) {
      console.log(
        `Adding missing column: ${column}`
      );

      await pool.query(
        `ALTER TABLE predictions
         ADD COLUMN IF NOT EXISTS
         ${column} ${type}`
      );
    }
  }


  /*
    Re-check columns after migration.
  */

  const after =
    await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
      AND table_name = 'predictions'
    `);

  const cols =
    new Set(
      after.rows.map(
        row =>
          row.column_name
      )
    );


  /*
    Migrate old schemas if present.
  */

  if (cols.has("period")) {
    await pool.query(`
      UPDATE predictions
      SET issue_number = period::TEXT
      WHERE
        (issue_number IS NULL
         OR issue_number = '')
        AND period IS NOT NULL
    `);

    console.log(
      "Migrated period -> issue_number"
    );
  }


  if (cols.has("issue")) {
    await pool.query(`
      UPDATE predictions
      SET issue_number = issue::TEXT
      WHERE
        (issue_number IS NULL
         OR issue_number = '')
        AND issue IS NOT NULL
    `);

    console.log(
      "Migrated issue -> issue_number"
    );
  }


  if (cols.has("issueNumber")) {
    await pool.query(`
      UPDATE predictions
      SET issue_number = "issueNumber"::TEXT
      WHERE
        (issue_number IS NULL
         OR issue_number = '')
        AND "issueNumber" IS NOT NULL
    `);

    console.log(
      "Migrated issueNumber -> issue_number"
    );
  }


  /*
    Remove unusable old rows.
  */

  await pool.query(`
    DELETE FROM predictions
    WHERE
      issue_number IS NULL
      OR TRIM(issue_number) = ''
  `);


  /*
    Unique index.

    First remove duplicate issue numbers
    if old data contains duplicates.
  */

  await pool.query(`
    DELETE FROM predictions a
    USING predictions b
    WHERE
      a.id < b.id
      AND a.issue_number = b.issue_number
  `);


  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS
    predictions_issue_number_unique
    ON predictions(issue_number)
  `);


  /*
    Defaults for old records.
  */

  await pool.query(`
    UPDATE predictions
    SET confidence = 0
    WHERE confidence IS NULL
  `);

  await pool.query(`
    UPDATE predictions
    SET pattern_score = 0
    WHERE pattern_score IS NULL
  `);

  await pool.query(`
    UPDATE predictions
    SET agreement = 0
    WHERE agreement IS NULL
  `);

  await pool.query(`
    UPDATE predictions
    SET backtest_samples = 0
    WHERE backtest_samples IS NULL
  `);

  await pool.query(`
    UPDATE predictions
    SET created_at = 0
    WHERE created_at IS NULL
  `);


  console.log(
    "DATABASE MIGRATION COMPLETE"
  );


  /*
    Print final schema to Render logs.
  */

  const finalColumns =
    await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
      AND table_name = 'predictions'
      ORDER BY ordinal_position
    `);

  console.log(
    "PREDICTIONS COLUMNS:",
    finalColumns.rows
      .map(
        row =>
          row.column_name
      )
      .join(", ")
  );
}


/* =====================================================
   ACCESS KEY CREATOR
===================================================== */

async function createAccessKey() {
  if (!pool) {
    throw new Error(
      "Database is not configured"
    );
  }

  for (
    let i = 0;
    i < 10;
    i++
  ) {
    const key =
      crypto
        .randomBytes(9)
        .toString("hex")
        .toUpperCase();

    try {
      const result =
        await pool.query(
          `INSERT INTO access_keys
           (access_key, created_at)
           VALUES ($1, $2)
           RETURNING *`,
          [
            key,
            Date.now()
          ]
        );

      return result.rows[0];

    } catch (error) {
      if (error.code === "23505") {
        continue;
      }

      throw error;
    }
  }

  throw new Error(
    "Unable to generate unique access key"
  );
}


/* =====================================================
   ACCESS KEY CHECK
===================================================== */

async function checkAccessKey(
  key,
  deviceId
) {
  if (!pool) {
    return {
      ok: false,
      error:
        "Database is not configured"
    };
  }

  const cleanKey =
    String(key || "").trim();

  const result =
    await pool.query(
      `SELECT *
       FROM access_keys
       WHERE access_key = $1
       LIMIT 1`,
      [cleanKey]
    );

  const row =
    result.rows[0];

  if (!row) {
    return {
      ok: false,
      error:
        "Invalid access key"
    };
  }

  const cleanDevice =
    String(
      deviceId || ""
    ).trim();


  if (
    row.device_id &&
    cleanDevice &&
    row.device_id !==
      cleanDevice
  ) {
    return {
      ok: false,
      error:
        "Key already bound to another device"
    };
  }


  const now =
    Date.now();


  if (
    !row.device_id &&
    cleanDevice
  ) {
    await pool.query(
      `UPDATE access_keys
       SET device_id = $1,
           last_seen = $2
       WHERE id = $3`,
      [
        cleanDevice,
        now,
        row.id
      ]
    );
  }

  else {
    await pool.query(
      `UPDATE access_keys
       SET last_seen = $1
       WHERE id = $2`,
      [
        now,
        row.id
      ]
    );
  }


  return {
    ok: true,
    key:
      row.access_key
  };
}


/* =====================================================
   SAVE PREDICTION
===================================================== */

async function savePrediction(
  issue,
  analysis
) {
  if (
    !pool ||
    !issue ||
    !analysis?.prediction
  ) {
    return;
  }

  await pool.query(
    `
    INSERT INTO predictions (
      issue_number,
      prediction,
      predicted_number,
      confidence,
      pattern_score,
      agreement,
      status,
      created_at,
      backtest_samples,
      backtest_accuracy,
      model_details
    )
    VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
    )

    ON CONFLICT(issue_number)

    DO UPDATE SET
      prediction =
        EXCLUDED.prediction,

      predicted_number =
        EXCLUDED.predicted_number,

      confidence =
        EXCLUDED.confidence,

      pattern_score =
        EXCLUDED.pattern_score,

      agreement =
        EXCLUDED.agreement,

      status =
        EXCLUDED.status,

      backtest_samples =
        EXCLUDED.backtest_samples,

      backtest_accuracy =
        EXCLUDED.backtest_accuracy,

      model_details =
        EXCLUDED.model_details
    `,
    [
      issue,

      analysis.prediction,

      analysis.predictedNumber,

      analysis.confidence,

      analysis.patternScore,

      analysis.agreement,

      analysis.status,

      Date.now(),

      analysis.backtest?.samples || 0,

      analysis.backtest?.accuracy ?? null,

      JSON.stringify(
        analysis.models || []
      )
    ]
  );
}


/* =====================================================
   SETTLE PREDICTION
===================================================== */

async function settlePrediction(
  issue,
  actualNumber
) {
  if (
    !pool ||
    !issue ||
    actualNumber === null
  ) {
    return;
  }

  const result =
    await pool.query(
      `SELECT *
       FROM predictions
       WHERE issue_number = $1
       LIMIT 1`,
      [issue]
    );

  const row =
    result.rows[0];

  if (
    !row ||
    row.result
  ) {
    return;
  }

  const actualSide =
    sideOf(actualNumber);

  const predictionSide =
    String(
      row.prediction || ""
    ).toUpperCase();

  if (
    !actualSide ||
    !predictionSide
  ) {
    return;
  }

  const outcome =
    predictionSide === actualSide
      ? "WIN"
      : "LOSS";

  await pool.query(
    `UPDATE predictions
     SET
       settled_number = $1,
       result = $2,
       settled_at = $3
     WHERE issue_number = $4`,
    [
      actualNumber,
      outcome,
      Date.now(),
      issue
    ]
  );
}


/* =====================================================
   PERFORMANCE
===================================================== */

async function getPerformance() {
  if (!pool) {
    return {
      win: 0,
      loss: 0,
      wins: 0,
      losses: 0,
      rate: 0,
      total: 0,
      rows: []
    };
  }

  const result =
    await pool.query(
      `
      SELECT
        issue_number,
        prediction,
        predicted_number,
        confidence,
        pattern_score,
        agreement,
        status,
        created_at,
        settled_number,
        result,
        settled_at,
        backtest_samples,
        backtest_accuracy

      FROM predictions

      WHERE result IS NOT NULL

      ORDER BY
        settled_at DESC NULLS LAST,
        id DESC

      LIMIT $1
      `,
      [WINLOSS_LIMIT]
    );

  const rows =
    result.rows.map(row => ({
      issueNumber:
        row.issue_number,

      prediction:
        row.prediction,

      predictedNumber:
        row.predicted_number === null
          ? null
          : Number(
              row.predicted_number
            ),

      confidence:
        Number(
          row.confidence || 0
        ),

      patternScore:
        Number(
          row.pattern_score || 0
        ),

      agreement:
        Number(
          row.agreement || 0
        ),

      status:
        row.status,

      createdAt:
        Number(
          row.created_at || 0
        ),

      settledNumber:
        row.settled_number === null
          ? null
          : Number(
              row.settled_number
            ),

      result:
        row.result,

      settledAt:
        Number(
          row.settled_at || 0
        ),

      backtestSamples:
        Number(
          row.backtest_samples || 0
        ),

      backtestAccuracy:
        row.backtest_accuracy === null
          ? null
          : Number(
              row.backtest_accuracy
            )
    }));

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

  const total =
    win + loss;

  return {
    win,
    loss,

    wins: win,
    losses: loss,

    rate:
      total
        ? Math.round(
            win /
            total *
            100
          )
        : 0,

    total,

    rows
  };
}


/* =====================================================
   LIVE PROVIDER UPDATE
===================================================== */

async function updateLiveState() {
  try {
    const provider =
      await fetchWingo();

    const history =
      provider.history;

    const settled =
      history[0];

    if (!settled) {
      throw new Error(
        "No settled result"
      );
    }

    /*
      Signature changes only when
      settled results actually change.
    */

    const signature =
      history
        .slice(0, 5)
        .map(
          row =>
            `${row.issueNumber}:${row.number}`
        )
        .join("|");

    const changed =
      signature !==
      state.lastSignature;

    state.history =
      history;

    state.providerCurrent =
      provider.current;

    state.lastProviderUpdate =
      Date.now();

    state.lastError = "";

    state.ready = true;

    state.updatedAt =
      Date.now();


    const providerIssue =
      provider.current?.issueNumber ||
      null;

    const estimatedNext =
      nextIssue(
        settled.issueNumber
      );

    let target =
      estimatedNext;


    /*
      If provider explicitly exposes a
      current issue ahead of settled issue,
      use it.
    */

    if (
      providerIssue &&
      compareIssues(
        providerIssue,
        settled.issueNumber
      ) > 0
    ) {
      target =
        providerIssue;
    }


    state.settledIssue =
      settled.issueNumber;

    state.nextIssue =
      estimatedNext;

    state.targetIssue =
      target;


    /*
      IMPORTANT:
      Prediction is not recalculated every
      second.

      It changes when:
      - new settled result arrives
      - target changes
      - app starts without prediction
    */

    if (
      changed ||
      !state.analysis ||
      !state.prediction ||
      state.prediction.issueNumber !==
        target
    ) {

      /*
        Settle the prediction for the
        result that just arrived.
      */

      if (
        state.lastSignature &&
        settled.issueNumber
      ) {
        try {
          await settlePrediction(
            settled.issueNumber,
            settled.number
          );
        } catch (error) {
          console.error(
            "SETTLE ERROR:",
            error.message
          );
        }
      }


      /*
        Analyze complete history returned
        by the provider.
      */

      const analysis =
        analyzeHistory(
          history
        );

      state.analysis =
        analysis;


      state.prediction = {
        issueNumber:
          target,

        prediction:
          analysis.prediction,

        predictedNumber:
          analysis.predictedNumber,

        confidence:
          analysis.confidence,

        patternScore:
          analysis.patternScore,

        agreement:
          analysis.agreement,

        status:
          analysis.status,

        backtest:
          analysis.backtest,

        models:
          analysis.models,

        historyUsed:
          analysis.historyUsed,

        generatedAt:
          analysis.generatedAt
      };


      if (
        target &&
        analysis.prediction
      ) {
        try {
          await savePrediction(
            target,
            analysis
          );
        } catch (error) {
          console.error(
            "SAVE PREDICTION ERROR:",
            error.message
          );
        }
      }


      state.lastSignature =
        signature;
    }
  }

  catch (error) {
    state.lastError =
      error.message ||
      String(error);

    state.updatedAt =
      Date.now();

    console.error(
      "WINGO UPDATE ERROR:",
      state.lastError
    );
  }
}


/* =====================================================
   API: KEY CHECK
===================================================== */

async function apiKeyCheck(
  req,
  res
) {
  try {
    const body =
      await parseJSONBody(req);

    const key =
      firstDefined(
        body.key,
        body.access_key,
        req.headers["x-access-key"]
      );

    const deviceId =
      firstDefined(
        body.device_id,
        body.deviceId,
        req.headers["x-device-id"]
      );

    const result =
      await checkAccessKey(
        key,
        deviceId
      );

    if (!result.ok) {
      return sendJSON(
        res,
        401,
        {
          success: false,
          ok: false,
          valid: false,
          error:
            result.error
        }
      );
    }

    return sendJSON(
      res,
      200,
      {
        success: true,
        ok: true,
        valid: true,
        message:
          "Access granted"
      }
    );
  }

  catch (error) {
    return sendJSON(
      res,
      500,
      {
        success: false,
        ok: false,
        error:
          error.message
      }
    );
  }
}


/* =====================================================
   API: STATE
===================================================== */

async function apiState(
  req,
  res
) {
  const performance =
    await getPerformance()
      .catch(
        () => ({
          win: 0,
          loss: 0,
          rate: 0,
          rows: []
        })
      );

  return sendJSON(
    res,
    200,
    {
      success: true,
      ok: true,

      ready:
        state.ready,

      targetIssue:
        state.targetIssue,

      settledIssue:
        state.settledIssue,

      nextIssue:
        state.nextIssue,

      providerCurrent:
        state.providerCurrent,

      countdown:
        state.providerCurrent?.countdown ??
        null,

      prediction:
        state.prediction,

      analysis:
        state.analysis,

      /*
        Only latest 30 are sent to UI.
        Analysis uses full history.
      */

      history:
        state.history.slice(
          0,
          LIVE_RESULTS_LIMIT
        ),

      historyCount:
        state.history.length,

      performance,

      updatedAt:
        state.updatedAt,

      lastProviderUpdate:
        state.lastProviderUpdate,

      error:
        state.lastError ||
        null
    }
  );
}


/* =====================================================
   API: HISTORY
===================================================== */

async function apiHistory(
  req,
  res
) {
  const performance =
    await getPerformance();

  return sendJSON(
    res,
    200,
    {
      success: true,
      ok: true,

      stats: {
        win:
          performance.win,

        loss:
          performance.loss,

        wins:
          performance.win,

        losses:
          performance.loss,

        rate:
          performance.rate,

        total:
          performance.total
      },

      wins:
        performance.win,

      losses:
        performance.loss,

      rate:
        performance.rate,

      predictions:
        performance.rows,

      rows:
        performance.rows
    }
  );
}


/* =====================================================
   ADMIN: PING
===================================================== */

async function adminPing(
  req,
  res
) {
  if (
    !requireAdmin(
      req,
      res
    )
  ) {
    return;
  }

  return sendJSON(
    res,
    200,
    {
      success: true,
      ok: true,

      message:
        "DY AI admin server online",

      time:
        Date.now()
    }
  );
}


/* =====================================================
   ADMIN: STATUS
===================================================== */

async function adminStatus(
  req,
  res
) {
  if (
    !requireAdmin(
      req,
      res
    )
  ) {
    return;
  }

  let database = false;

  if (pool) {
    try {
      await pool.query(
        "SELECT 1"
      );

      database = true;
    } catch {}
  }

  return sendJSON(
    res,
    200,
    {
      success: true,
      ok: true,

      database,

      wingobot:
        Boolean(
          WINGOBOT_TOKEN
        ),

      providerFetched:
        state.history.length,

      historyLength:
        state.history.length,

      targetIssue:
        state.targetIssue,

      settledIssue:
        state.settledIssue,

      updatedAt:
        state.updatedAt,

      error:
        state.lastError ||
        null
    }
  );
}


/* =====================================================
   ADMIN: KEYS
===================================================== */

async function adminKeys(
  req,
  res
) {
  if (
    !requireAdmin(
      req,
      res
    )
  ) {
    return;
  }

  if (!pool) {
    return sendJSON(
      res,
      500,
      {
        success: false,
        ok: false,
        error:
          "Database is not configured"
      }
    );
  }

  try {

    /*
      GET
    */

    if (
      req.method ===
      "GET"
    ) {
      const result =
        await pool.query(`
          SELECT
            id,
            access_key,
            device_id,
            created_at,
            last_seen

          FROM access_keys

          ORDER BY id DESC
        `);

      return sendJSON(
        res,
        200,
        {
          success: true,
          ok: true,
          keys:
            result.rows
        }
      );
    }


    /*
      POST
    */

    if (
      req.method ===
      "POST"
    ) {
      const body =
        await parseJSONBody(req);

      let count =
        Number(
          body.count || 1
        );

      count =
        Math.max(
          1,
          Math.min(
            100,
            count
          )
        );

      const keys = [];

      for (
        let i = 0;
        i < count;
        i++
      ) {
        const row =
          await createAccessKey();

        keys.push(
          row.access_key
        );
      }

      return sendJSON(
        res,
        200,
        {
          success: true,
          ok: true,

          key:
            keys[0],

          keys
        }
      );
    }


    /*
      DELETE
    */

    if (
      req.method ===
      "DELETE"
    ) {
      const body =
        await parseJSONBody(req);

      const id =
        Number(body.id);

      if (
        !Number.isInteger(id)
      ) {
        return sendJSON(
          res,
          400,
          {
            success: false,
            ok: false,
            error:
              "Invalid key id"
          }
        );
      }

      const result =
        await pool.query(
          `DELETE FROM access_keys
           WHERE id = $1
           RETURNING id`,
          [id]
        );

      const deleted =
        Boolean(
          result.rows[0]
        );

      return sendJSON(
        res,
        200,
        {
          success:
            deleted,

          ok:
            deleted,

          deleted
        }
      );
    }


    return sendJSON(
      res,
      405,
      {
        success: false,
        ok: false,
        error:
          "Method not allowed"
      }
    );

  }

  catch (error) {
    console.error(
      "ADMIN KEYS ERROR:",
      error
    );

    return sendJSON(
      res,
      500,
      {
        success: false,
        ok: false,
        error:
          error.message
      }
    );
  }
}


/* =====================================================
   ADMIN: RESET DEVICE
===================================================== */

async function adminResetDevice(
  req,
  res
) {
  if (
    !requireAdmin(
      req,
      res
    )
  ) {
    return;
  }

  try {
    const body =
      await parseJSONBody(req);

    const id =
      Number(body.id);

    if (
      !Number.isInteger(id)
    ) {
      return sendJSON(
        res,
        400,
        {
          success: false,
          ok: false,
          error:
            "Invalid key id"
        }
      );
    }

    const result =
      await pool.query(
        `UPDATE access_keys
         SET
           device_id = NULL,
           last_seen = 0
         WHERE id = $1
         RETURNING *`,
        [id]
      );

    const row =
      result.rows[0];

    if (!row) {
      return sendJSON(
        res,
        404,
        {
          success: false,
          ok: false,
          error:
            "Key not found"
        }
      );
    }

    return sendJSON(
      res,
      200,
      {
        success: true,
        ok: true,
        key: row
      }
    );
  }

  catch (error) {
    return sendJSON(
      res,
      500,
      {
        success: false,
        ok: false,
        error:
          error.message
      }
    );
  }
}


/* =====================================================
   ADMIN: WINGOBOT TEST
===================================================== */

async function adminWingoTest(
  req,
  res
) {
  if (
    !requireAdmin(
      req,
      res
    )
  ) {
    return;
  }

  try {
    const provider =
      await fetchWingo();

    return sendJSON(
      res,
      200,
      {
        success: true,
        ok: true,

        fetched:
          provider.fetched,

        historyLength:
          provider.history.length,

        current:
          provider.current,

        latest:
          provider.history[0] ||
          null
      }
    );
  }

  catch (error) {
    return sendJSON(
      res,
      502,
      {
        success: false,
        ok: false,
        error:
          error.message
      }
    );
  }
}


/* =====================================================
   ADMIN: MODEL TEST
===================================================== */

async function adminModelTest(
  req,
  res
) {
  if (
    !requireAdmin(
      req,
      res
    )
  ) {
    return;
  }

  try {
    const provider =
      await fetchWingo();

    const analysis =
      analyzeHistory(
        provider.history
      );

    return sendJSON(
      res,
      200,
      {
        success: true,
        ok: true,

        history:
          provider.history.length,

        fetched:
          provider.fetched,

        prediction:
          analysis.prediction,

        predictedNumber:
          analysis.predictedNumber,

        confidence:
          analysis.confidence,

        patternScore:
          analysis.patternScore,

        agreement:
          analysis.agreement,

        status:
          analysis.status,

        avgModelAccuracy:
          analysis.backtest.accuracy,

        backtestSamples:
          analysis.backtest.samples,

        backtestWins:
          analysis.backtest.wins,

        backtestLosses:
          analysis.backtest.losses,

        backtest:
          analysis.backtest,

        models:
          analysis.models,

        analysis
      }
    );
  }

  catch (error) {
    return sendJSON(
      res,
      502,
      {
        success: false,
        ok: false,
        error:
          error.message
      }
    );
  }
}


/* =====================================================
   STATIC FILE SERVER
===================================================== */

const MIME = {
  ".html":
    "text/html; charset=utf-8",

  ".js":
    "application/javascript; charset=utf-8",

  ".css":
    "text/css; charset=utf-8",

  ".json":
    "application/json; charset=utf-8",

  ".mp3":
    "audio/mpeg",

  ".png":
    "image/png",

  ".jpg":
    "image/jpeg",

  ".jpeg":
    "image/jpeg",

  ".svg":
    "image/svg+xml",

  ".ico":
    "image/x-icon"
};


function serveStatic(
  req,
  res,
  pathname
) {
  let relative =
    pathname === "/"
      ? "prediction.html"
      : pathname.replace(
          /^\/+/,
          ""
        );

  if (
    relative.includes("..")
  ) {
    return sendText(
      res,
      400,
      "Bad request"
    );
  }

  const file =
    path.join(
      __dirname,
      relative
    );

  fs.stat(
    file,
    (error, stat) => {

      if (
        error ||
        !stat.isFile()
      ) {
        return sendText(
          res,
          404,
          "Not found"
        );
      }

      const extension =
        path.extname(
          file
        ).toLowerCase();

      const type =
        MIME[extension] ||
        "application/octet-stream";


      /*
        MP3 range support
      */

      if (
        extension ===
        ".mp3"
      ) {
        const size =
          stat.size;

        const range =
          req.headers.range;

        if (range) {
          const match =
            /bytes=(\d*)-(\d*)/
              .exec(range);

          if (match) {

            const start =
              match[1]
                ? Number(
                    match[1]
                  )
                : 0;

            const end =
              match[2]
                ? Number(
                    match[2]
                  )
                : size - 1;

            if (
              start >= size ||
              end < start
            ) {
              res.writeHead(
                416,
                {
                  "Content-Range":
                    `bytes */${size}`
                }
              );

              return res.end();
            }

            const finalEnd =
              Math.min(
                end,
                size - 1
              );

            res.writeHead(
              206,
              {
                "Content-Type":
                  type,

                "Content-Range":
                  `bytes ${start}-${finalEnd}/${size}`,

                "Accept-Ranges":
                  "bytes",

                "Content-Length":
                  finalEnd -
                  start +
                  1,

                "Cache-Control":
                  "public,max-age=3600"
              }
            );

            return fs
              .createReadStream(
                file,
                {
                  start,
                  end: finalEnd
                }
              )
              .pipe(res);
          }
        }

        res.writeHead(
          200,
          {
            "Content-Type":
              type,

            "Accept-Ranges":
              "bytes",

            "Content-Length":
              size,

            "Cache-Control":
              "public,max-age=3600"
          }
        );

        return fs
          .createReadStream(file)
          .pipe(res);
      }


      /*
        Normal files
      */

      res.writeHead(
        200,
        {
          "Content-Type":
            type,

          "Cache-Control":
            extension === ".html"
              ? "no-store"
              : "public,max-age=3600",

          "Content-Length":
            stat.size
        }
      );

      fs
        .createReadStream(file)
        .pipe(res);
    }
  );
}


/* =====================================================
   HTTP SERVER
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

        const pathname =
          url.pathname;


        /* =============================================
           HEALTH
        ============================================= */

        if (
          pathname ===
          "/health"
        ) {
          return sendJSON(
            res,
            200,
            {
              success: true,
              ok: true,

              status:
                "healthy",

              time:
                Date.now()
            }
          );
        }


        /* =============================================
           PUBLIC KEY API
        ============================================= */

        if (
          pathname ===
            "/api/key/check" &&
          req.method ===
            "POST"
        ) {
          return apiKeyCheck(
            req,
            res
          );
        }


        /* =============================================
           PUBLIC STATE
        ============================================= */

        if (
          pathname ===
            "/api/state" &&
          req.method ===
            "GET"
        ) {
          return apiState(
            req,
            res
          );
        }


        /* =============================================
           PUBLIC HISTORY
        ============================================= */

        if (
          pathname ===
            "/api/history" &&
          req.method ===
            "GET"
        ) {
          return apiHistory(
            req,
            res
          );
        }


        /* =============================================
           ADMIN PING
        ============================================= */

        if (
          pathname ===
            "/api/admin/ping" &&
          req.method ===
            "GET"
        ) {
          return adminPing(
            req,
            res
          );
        }


        /* =============================================
           ADMIN STATUS
        ============================================= */

        if (
          pathname ===
            "/api/admin/status" &&
          req.method ===
            "GET"
        ) {
          return adminStatus(
            req,
            res
          );
        }


        /* =============================================
           ADMIN KEYS
        ============================================= */

        if (
          pathname ===
            "/api/admin/keys" &&
          [
            "GET",
            "POST",
            "DELETE"
          ].includes(
            req.method
          )
        ) {
          return adminKeys(
            req,
            res
          );
        }


        /* =============================================
           RESET DEVICE
        ============================================= */

        if (
          pathname ===
            "/api/admin/reset-device" &&
          req.method ===
            "POST"
        ) {
          return adminResetDevice(
            req,
            res
          );
        }


        /* =============================================
           WINGOBOT TEST
        ============================================= */

        if (
          pathname ===
            "/api/admin/wingo-test" &&
          req.method ===
            "GET"
        ) {
          return adminWingoTest(
            req,
            res
          );
        }


        /* =============================================
           MODEL TEST
        ============================================= */

        if (
          pathname ===
            "/api/admin/model-test" &&
          req.method ===
            "GET"
        ) {
          return adminModelTest(
            req,
            res
          );
        }


        /* =============================================
           STATIC
        ============================================= */

        return serveStatic(
          req,
          res,
          pathname
        );

      }

      catch (error) {

        console.error(
          "SERVER ERROR:",
          error
        );

        return sendJSON(
          res,
          500,
          {
            success: false,
            ok: false,
            error:
              "Internal server error"
          }
        );
      }
    }
  );


/* =====================================================
   BOOT
===================================================== */

async function boot() {

  try {

    await initDB();

    console.log(
      `DY AI server starting on port ${PORT}`
    );

    console.log(
      `ADMIN_KEY configured: ${
        ADMIN_KEY
          ? "YES"
          : "NO"
      }`
    );

    console.log(
      `WINGOBOT_TOKEN configured: ${
        WINGOBOT_TOKEN
          ? "YES"
          : "NO"
      }`
    );

    console.log(
      `DATABASE configured: ${
        pool
          ? "YES"
          : "NO"
      }`
    );


    server.listen(
      PORT,
      "0.0.0.0",
      () => {
        console.log(
          `DY AI LIVE on port ${PORT}`
        );
      }
    );


    /*
      Initial provider update.
    */

    await updateLiveState();


    /*
      Continuous provider polling.
    */

    setInterval(
      updateLiveState,
      POLL_MS
    );

  }

  catch (error) {

    console.error(
      "BOOT ERROR:",
      error
    );

    process.exit(1);
  }
}


boot();
