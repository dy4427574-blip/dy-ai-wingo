const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = process.env.PORT || 10000;

const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_KEY = process.env.ADMIN_KEY || "";

const WINGOBOT_TOKEN =
  process.env.WINGOBOT_TOKEN || "";

const WINGOBOT_URL =
  process.env.WINGOBOT_URL ||
  "https://api.wingobot.com/v2/30-sec-game-history";

const PUBLIC_DIR = __dirname;

const COOLDOWN_ROUNDS = 5;
const HISTORY_SIZE = 30;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL
    ? { rejectUnauthorized: false }
    : undefined
});


/* =========================================================
   BASIC HELPERS
========================================================= */

function now() {
  return Date.now();
}

function json(res, status, data) {
  const body = JSON.stringify(data);

  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
    "Access-Control-Allow-Origin": "*"
  });

  res.end(body);
}

function text(res, status, body, contentType = "text/plain") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });

  res.end(body);
}

function getHeader(req, name) {
  return req.headers[name.toLowerCase()] || "";
}

function cleanString(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value).trim();
}


/* =========================================================
   ISSUE ID
   NEVER USE JS NUMBER FOR LARGE ISSUE IDs
========================================================= */

function normalizeIssue(value) {
  const s = cleanString(value);

  if (!s) return "";

  return s.replace(/\D/g, "");
}

function issueBigInt(value) {
  const s = normalizeIssue(value);

  if (!s) return null;

  try {
    return BigInt(s);
  } catch {
    return null;
  }
}

function compareIssues(a, b) {
  const A = normalizeIssue(a);
  const B = normalizeIssue(b);

  if (!A && !B) return 0;
  if (!A) return -1;
  if (!B) return 1;

  if (A.length !== B.length) {
    return A.length - B.length;
  }

  if (A === B) return 0;

  return A > B ? 1 : -1;
}

function sameIssue(a, b) {
  return compareIssues(a, b) === 0;
}

function nextIssue(issue) {
  const n = issueBigInt(issue);

  if (n === null) return "";

  return (n + 1n).toString();
}


/* =========================================================
   NUMBER / BIG SMALL
========================================================= */

function validNumber(value) {
  const n = Number(value);

  return (
    Number.isInteger(n) &&
    n >= 0 &&
    n <= 9
  );
}

function sideFromNumber(value) {
  const n = Number(value);

  if (!validNumber(n)) {
    return "";
  }

  return n <= 4 ? "SMALL" : "BIG";
}


/* =========================================================
   OBJECT -> SAFE TEXT
   FIXES [OBJECT OBJECT]
========================================================= */

function safeText(value) {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" ||
      typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value
      .map(safeText)
      .filter(Boolean)
      .join(" • ");
  }

  if (typeof value === "object") {

    const preferred = [
      "classification",
      "label",
      "name",
      "message",
      "reason",
      "summary",
      "status"
    ];

    for (const key of preferred) {
      if (
        value[key] !== undefined &&
        value[key] !== null
      ) {
        const s = safeText(value[key]);

        if (s) return s;
      }
    }

    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }

  return String(value);
}


/* =========================================================
   DATABASE
========================================================= */

async function initDB() {

  if (!DATABASE_URL) {
    console.warn(
      "DATABASE_URL is not configured."
    );
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
    CREATE TABLE IF NOT EXISTS prediction_records (
      id SERIAL PRIMARY KEY,
      target_issue TEXT NOT NULL,
      prediction TEXT NOT NULL,
      confidence INTEGER DEFAULT 0,
      model_version TEXT,
      actual_number INTEGER,
      actual_result TEXT,
      created_at BIGINT NOT NULL,
      settled_at BIGINT
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    idx_prediction_target
    ON prediction_records(target_issue)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    idx_prediction_created
    ON prediction_records(created_at)
  `);

  console.log("Database ready");
}


/* =========================================================
   ACCESS KEY
========================================================= */

async function authenticateUser(req) {

  const accessKey =
    getHeader(req, "X-Access-Key");

  const deviceId =
    getHeader(req, "X-Device-Id");

  if (!accessKey) {
    return {
      ok: false,
      status: 401,
      message: "Access key required"
    };
  }

  if (!deviceId) {
    return {
      ok: false,
      status: 400,
      message: "Device ID required"
    };
  }

  const result = await pool.query(
    `
    SELECT *
    FROM access_keys
    WHERE access_key = $1
    LIMIT 1
    `,
    [accessKey]
  );

  if (!result.rows.length) {
    return {
      ok: false,
      status: 401,
      message: "Invalid access key"
    };
  }

  const row = result.rows[0];

  if (
    row.device_id &&
    row.device_id !== deviceId
  ) {
    return {
      ok: false,
      status: 403,
      message: "Key already bound to another device"
    };
  }

  if (!row.device_id) {
    await pool.query(
      `
      UPDATE access_keys
      SET device_id = $1,
          last_seen = $2
      WHERE id = $3
      `,
      [
        deviceId,
        now(),
        row.id
      ]
    );
  } else {
    await pool.query(
      `
      UPDATE access_keys
      SET last_seen = $1
      WHERE id = $2
      `,
      [
        now(),
        row.id
      ]
    );
  }

  return {
    ok: true,
    row
  };
}


/* =========================================================
   ADMIN AUTH
========================================================= */

function authenticateAdmin(req) {

  const key =
    getHeader(req, "X-Admin-Key");

  if (!ADMIN_KEY) {
    return false;
  }

  return key === ADMIN_KEY;
}


/* =========================================================
   WINGOBOT FETCH
========================================================= */

async function fetchWingoRaw() {

  if (!WINGOBOT_TOKEN) {
    throw new Error(
      "WINGOBOT_TOKEN is not configured"
    );
  }

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      8000
    );

  try {

    const response =
      await fetch(
        WINGOBOT_URL,
        {
          method: "GET",
          headers: {
            "Authorization":
              `Bearer ${WINGOBOT_TOKEN}`,
            "Accept":
              "application/json",
            "Cache-Control":
              "no-cache"
          },
          cache: "no-store",
          signal: controller.signal
        }
      );

    if (!response.ok) {
      throw new Error(
        `Wingo API HTTP ${response.status}`
      );
    }

    return await response.json();

  } finally {

    clearTimeout(timeout);

  }
}


/* =========================================================
   NORMALIZE WINGO DATA
========================================================= */

function normalizeWingo(payload) {

  const current =
    payload?.current || {};

  let currentIssue =
    normalizeIssue(
      current.issueNumber ||
      current.issue ||
      payload?.currentIssue ||
      payload?.issueNumber
    );

  let sourceRows = [];

  if (Array.isArray(payload?.history)) {
    sourceRows = payload.history;
  }

  if (
    !sourceRows.length &&
    Array.isArray(payload?.data)
  ) {
    sourceRows = payload.data;
  }

  if (
    !sourceRows.length &&
    Array.isArray(payload?.results)
  ) {
    sourceRows = payload.results;
  }

  const rows = [];

  for (const row of sourceRows) {

    const issue =
      normalizeIssue(
        row?.issueNumber ||
        row?.issue ||
        row?.period ||
        row?.targetIssue
      );

    const numberValue =
      row?.number ??
      row?.result ??
      row?.resultNumber ??
      row?.openNumber;

    if (!issue) continue;

    if (!validNumber(numberValue)) {
      continue;
    }

    rows.push({
      issueNumber: issue,
      number: Number(numberValue),
      result: sideFromNumber(numberValue),
      colour:
        row?.colour ??
        row?.color ??
        "",
      premium:
        row?.premium ?? "",
      sum:
        row?.sum ?? ""
    });
  }

  rows.sort((a, b) =>
    compareIssues(
      a.issueNumber,
      b.issueNumber
    )
  );

  /*
    If current issue isn't supplied,
    use newest history issue.
  */

  if (!currentIssue && rows.length) {
    currentIssue =
      rows[rows.length - 1].issueNumber;
  }

  /*
    If API current issue is older than the
    newest returned result, use newest settled
    result as the live baseline.
  */

  if (
    currentIssue &&
    rows.length &&
    compareIssues(
      rows[rows.length - 1].issueNumber,
      currentIssue
    ) > 0
  ) {
    currentIssue =
      rows[rows.length - 1].issueNumber;
  }

  return {
    currentIssue,
    history: rows,
    fetchedAt: now(),
    sourceLastUpdated:
      payload?.stats?.last_updated ??
      payload?.last_updated ??
      null
  };
}


/* =========================================================
   GET WINGO DATA
========================================================= */

let lastWingoCache = null;
let lastWingoFetch = 0;

async function getWingo() {

  /*
    Very short cache prevents multiple users
    from hammering API simultaneously.
  */

  if (
    lastWingoCache &&
    now() - lastWingoFetch < 900
  ) {
    return lastWingoCache;
  }

  const raw =
    await fetchWingoRaw();

  const data =
    normalizeWingo(raw);

  lastWingoCache = data;
  lastWingoFetch = now();

  return data;
}


/* =========================================================
   ANALYSIS HELPERS
========================================================= */

function recentRows(history, count) {

  return history
    .slice()
    .sort((a, b) =>
      compareIssues(
        a.issueNumber,
        b.issueNumber
      )
    )
    .slice(-count);
}


function sideArray(rows) {

  return rows
    .map(r => r.result)
    .filter(
      x => x === "BIG" || x === "SMALL"
    );
}


function countSides(rows) {

  let big = 0;
  let small = 0;

  for (const row of rows) {

    if (row.result === "BIG") big++;

    if (row.result === "SMALL") small++;

  }

  const total = big + small;

  return {
    big,
    small,
    total,
    bigPct:
      total ? (big / total) * 100 : 0,
    smallPct:
      total ? (small / total) * 100 : 0
  };
}


function currentStreak(rows) {

  const sides =
    sideArray(rows);

  if (!sides.length) {
    return {
      side: "",
      length: 0
    };
  }

  const last =
    sides[sides.length - 1];

  let length = 1;

  for (
    let i = sides.length - 2;
    i >= 0;
    i--
  ) {

    if (sides[i] !== last) break;

    length++;

  }

  return {
    side: last,
    length
  };
}


function switchRate(rows) {

  const sides =
    sideArray(rows);

  if (sides.length < 2) {
    return 0;
  }

  let switches = 0;

  for (
    let i = 1;
    i < sides.length;
    i++
  ) {

    if (
      sides[i] !==
      sides[i - 1]
    ) {
      switches++;
    }

  }

  return (
    switches /
    (sides.length - 1)
  ) * 100;
}


function runStats(rows) {

  const sides =
    sideArray(rows);

  if (!sides.length) {
    return {
      average: 0,
      longest: 0,
      current: 0,
      currentSide: ""
    };
  }

  const runs = [];

  let side = sides[0];
  let len = 1;

  for (
    let i = 1;
    i < sides.length;
    i++
  ) {

    if (sides[i] === side) {

      len++;

    } else {

      runs.push({
        side,
        length: len
      });

      side = sides[i];
      len = 1;
    }

  }

  runs.push({
    side,
    length: len
  });

  const lengths =
    runs.map(r => r.length);

  const average =
    lengths.reduce(
      (a,b) => a+b,
      0
    ) / lengths.length;

  return {
    average,
    longest:
      Math.max(...lengths),
    current: len,
    currentSide: side
  };
}


function transitionMatrix(rows) {

  const matrix = {
    BIG: {
      BIG: 0,
      SMALL: 0
    },
    SMALL: {
      BIG: 0,
      SMALL: 0
    }
  };

  const sides =
    sideArray(rows);

  for (
    let i = 1;
    i < sides.length;
    i++
  ) {

    matrix[
      sides[i - 1]
    ][
      sides[i]
    ]++;

  }

  return matrix;
}


function momentum(rows) {

  const recent =
    countSides(
      recentRows(rows, 10)
    );

  const previous =
    countSides(
      recentRows(
        rows.slice(0, -10),
        10
      )
    );

  return {
    recentBig: recent.bigPct,
    recentSmall: recent.smallPct,
    previousBig: previous.bigPct,
    previousSmall: previous.smallPct
  };
}


function digitStats(rows) {

  const freq =
    Array(10).fill(0);

  for (const row of rows) {

    if (
      validNumber(row.number)
    ) {
      freq[row.number]++;
    }

  }

  let maxDigit = 0;

  for (
    let i = 1;
    i < freq.length;
    i++
  ) {

    if (freq[i] > freq[maxDigit]) {
      maxDigit = i;
    }

  }

  return {
    frequency: freq,
    mostCommonDigit: maxDigit
  };
}


/* =========================================================
   PATTERN ANALYSIS
========================================================= */

function alternation(rows) {

  const sides =
    sideArray(rows);

  if (sides.length < 3) {
    return {
      active: false,
      length: 0,
      broken: false
    };
  }

  let length = 1;

  for (
    let i = sides.length - 1;
    i > 0;
    i--
  ) {

    if (
      sides[i] ===
      sides[i - 1]
    ) {
      break;
    }

    length++;

  }

  return {
    active: length >= 3,
    length,
    broken: false
  };
}


function repeatingBlock(rows) {

  const sides =
    sideArray(rows);

  if (sides.length < 6) {
    return {
      length: 0,
      found: false
    };
  }

  for (
    let size = 2;
    size <= 6;
    size++
  ) {

    if (
      sides.length <
      size * 2
    ) {
      continue;
    }

    const a =
      sides.slice(
        -size * 2,
        -size
      );

    const b =
      sides.slice(-size);

    if (
      a.join("") ===
      b.join("")
    ) {

      return {
        length: size,
        found: true,
        block:
          b.join("-")
      };

    }

  }

  return {
    length: 0,
    found: false
  };
}


/* =========================================================
   FULL ADAPTIVE ANALYSIS
========================================================= */

function fullAnalysis(history) {

  const valid =
    history.filter(
      r =>
        validNumber(r.number) &&
        (
          r.result === "BIG" ||
          r.result === "SMALL"
        )
    );

  const sample =
    valid.length;

  if (sample < 10) {

    return {
      prediction: null,
      confidence: 0,
      classification:
        "INSUFFICIENT DATA",
      sample,
      scores: {
        BIG: 0,
        SMALL: 0
      },
      details: {}
    };
  }


  const windows = {
    5: countSides(
      recentRows(valid, 5)
    ),
    10: countSides(
      recentRows(valid, 10)
    ),
    20: countSides(
      recentRows(valid, 20)
    ),
    30: countSides(
      recentRows(valid, 30)
    ),
    50: countSides(
      recentRows(valid, 50)
    ),
    100: countSides(
      recentRows(valid, 100)
    )
  };


  /*
    Base historical support.
    This is descriptive statistical analysis,
    not a guarantee of future outcome.
  */

  let bigScore = 0;
  let smallScore = 0;


  /* Recent windows */

  const windowWeights = [
    [5, 0.30],
    [10, 0.25],
    [20, 0.20],
    [30, 0.15],
    [50, 0.10]
  ];

  for (
    const [size, weight]
    of windowWeights
  ) {

    const w =
      windows[size];

    if (!w.total) continue;

    bigScore +=
      (w.bigPct / 100) *
      weight;

    smallScore +=
      (w.smallPct / 100) *
      weight;
  }


  /* Overall frequency */

  const overall =
    countSides(valid);

  bigScore +=
    (overall.bigPct / 100) *
    0.15;

  smallScore +=
    (overall.smallPct / 100) *
    0.15;


  /* Streak structure */

  const streak =
    currentStreak(valid);

  const runs =
    runStats(valid);

  if (streak.side === "BIG") {

    bigScore += 0.05;

  } else if (
    streak.side === "SMALL"
  ) {

    smallScore += 0.05;

  }


  /*
    Do NOT automatically reverse a streak.
    Long streak only adds a small structural signal.
  */

  if (
    streak.length >
    Math.max(3, runs.average * 2)
  ) {

    if (streak.side === "BIG") {
      smallScore += 0.03;
    }

    if (streak.side === "SMALL") {
      bigScore += 0.03;
    }

  }


  /* Switching */

  const switches =
    switchRate(valid);

  if (switches >= 60) {

    /*
      High switching regime:
      modestly reward opposite of current.
    */

    if (streak.side === "BIG") {
      smallScore += 0.05;
    }

    if (streak.side === "SMALL") {
      bigScore += 0.05;
    }

  } else if (
    switches < 40
  ) {

    /*
      Streak-dominant regime:
      don't force reversal.
    */

    if (streak.side === "BIG") {
      bigScore += 0.04;
    }

    if (streak.side === "SMALL") {
      smallScore += 0.04;
    }

  }


  /* Transition matrix */

  const recent20 =
    recentRows(valid, 20);

  const matrix =
    transitionMatrix(recent20);

  const lastSide =
    streak.side;

  if (
    lastSide === "BIG"
  ) {

    const stay =
      matrix.BIG.BIG;

    const change =
      matrix.BIG.SMALL;

    const total =
      stay + change;

    if (total) {

      if (change > stay) {
        smallScore += 0.08;
      } else {
        bigScore += 0.06;
      }

    }

  }


  if (
    lastSide === "SMALL"
  ) {

    const stay =
      matrix.SMALL.SMALL;

    const change =
      matrix.SMALL.BIG;

    const total =
      stay + change;

    if (total) {

      if (change > stay) {
        bigScore += 0.08;
      } else {
        smallScore += 0.06;
      }

    }

  }


  /* Momentum */

  const mom =
    momentum(valid);

  const recentBias =
    mom.recentBig -
    mom.recentSmall;

  const previousBias =
    mom.previousBig -
    mom.previousSmall;

  const shift =
    recentBias -
    previousBias;

  if (shift > 10) {
    bigScore += 0.06;
  }

  if (shift < -10) {
    smallScore += 0.06;
  }


  /* Alternation */

  const alt =
    alternation(valid);

  if (
    alt.active &&
    alt.length >= 4
  ) {

    if (streak.side === "BIG") {
      smallScore += 0.03;
    }

    if (streak.side === "SMALL") {
      bigScore += 0.03;
    }

  }


  /* Repeating block */

  const block =
    repeatingBlock(valid);

  if (
    block.found &&
    block.block
  ) {

    const last =
      block.block
        .split("-")
        .pop();

    if (last === "BIG") {
      bigScore += 0.03;
    }

    if (last === "SMALL") {
      smallScore += 0.03;
    }

  }


  /* Digit analysis */

  const digits =
    digitStats(valid);

  if (
    digits.mostCommonDigit >= 5
  ) {
    bigScore += 0.02;
  } else {
    smallScore += 0.02;
  }


  /*
    Normalize scores
  */

  const totalScore =
    bigScore + smallScore;

  if (totalScore > 0) {

    bigScore /=
      totalScore;

    smallScore /=
      totalScore;

  }


  /*
    Anti-stuck logic.

    This does NOT alternate BIG/SMALL blindly.
    It only reduces confidence when the model
    has repeatedly selected one side.
  */

  const recentPredictions =
    awaitableRecentPredictionSides();

  /*
    Function returns sync-safe cached value.
    Actual DB performance is applied below
    through getPredictionPressure().
  */

  const pressure =
    recentPredictions;


  if (
    pressure.side === "BIG" &&
    pressure.count >= 3
  ) {

    bigScore *= 0.86;
    smallScore *= 1.04;

  }

  if (
    pressure.side === "SMALL" &&
    pressure.count >= 3
  ) {

    smallScore *= 0.86;
    bigScore *= 1.04;

  }


  const finalTotal =
    bigScore + smallScore;

  if (finalTotal > 0) {

    bigScore /=
      finalTotal;

    smallScore /=
      finalTotal;

  }


  const prediction =
    bigScore >= smallScore
      ? "BIG"
      : "SMALL";

  const difference =
    Math.abs(
      bigScore - smallScore
    );

  let confidence =
    Math.round(
      50 + difference * 45
    );


  /*
    Sample penalty
  */

  if (sample < 20) {
    confidence -= 12;
  } else if (
    sample < 30
  ) {
    confidence -= 7;
  } else if (
    sample < 50
  ) {
    confidence -= 3;
  }

  confidence =
    Math.max(
      50,
      Math.min(92, confidence)
    );


  let classification =
    "WEAK HISTORICAL BIAS";

  if (difference < 0.05) {
    classification =
      "MIXED / CONFLICTING";
  } else if (
    difference >= 0.25
  ) {
    classification =
      "STRONG HISTORICAL BIAS";
  } else if (
    difference >= 0.12
  ) {
    classification =
      "MODERATE HISTORICAL BIAS";
  }


  if (
    alt.active &&
    alt.length >= 5
  ) {
    classification =
      "REVERSAL WATCH";
  }


  return {
    prediction,
    confidence,
    classification,
    sample,

    scores: {
      BIG:
        Number(
          (bigScore * 100)
            .toFixed(2)
        ),

      SMALL:
        Number(
          (smallScore * 100)
            .toFixed(2)
        )
    },

    details: {
      windows,
      streak,
      runStats: runs,
      switchRate:
        Number(
          switches.toFixed(2)
        ),
      transition: matrix,
      momentum: mom,
      alternation: alt,
      repeatingBlock: block,
      digits
    }
  };
}


/* =========================================================
   RECENT PREDICTION PRESSURE
   SYNC SAFE CACHE
========================================================= */

let predictionPressure = {
  side: "",
  count: 0
};

function awaitableRecentPredictionSides() {
  return predictionPressure;
}

async function refreshPredictionPressure() {

  if (!DATABASE_URL) return;

  const result =
    await pool.query(`
      SELECT prediction
      FROM prediction_records
      WHERE prediction IN ('BIG','SMALL')
      ORDER BY id DESC
      LIMIT 5
    `);

  const rows =
    result.rows;

  if (!rows.length) {

    predictionPressure = {
      side: "",
      count: 0
    };

    return;
  }

  const first =
    rows[0].prediction;

  let count = 0;

  for (const row of rows) {

    if (
      row.prediction === first
    ) {
      count++;
    } else {
      break;
    }

  }

  predictionPressure = {
    side: first,
    count
  };
}


/* =========================================================
   PREDICTION DB
========================================================= */

async function getLatestPrediction() {

  const result =
    await pool.query(`
      SELECT *
      FROM prediction_records
      ORDER BY id DESC
      LIMIT 1
    `);

  return result.rows[0] || null;
}


async function getPendingPredictions() {

  const result =
    await pool.query(`
      SELECT *
      FROM prediction_records
      WHERE actual_result IS NULL
      ORDER BY id ASC
    `);

  return result.rows;
}


/* =========================================================
   SETTLE OLD PREDICTIONS
========================================================= */

async function settlePredictions(history) {

  const pending =
    await getPendingPredictions();

  if (!pending.length) return;

  for (const prediction of pending) {

    const target =
      normalizeIssue(
        prediction.target_issue
      );

    const result =
      history.find(
        row =>
          sameIssue(
            row.issueNumber,
            target
          )
      );

    if (result) {

      const actual =
        sideFromNumber(
          result.number
        );

      const predicted =
        String(
          prediction.prediction
        ).toUpperCase();

      const outcome =
        actual === predicted
          ? "WIN"
          : "LOSS";

      await pool.query(
        `
        UPDATE prediction_records
        SET actual_number = $1,
            actual_result = $2,
            settled_at = $3
        WHERE id = $4
        `,
        [
          result.number,
          outcome,
          now(),
          prediction.id
        ]
      );

      continue;
    }


    /*
      If current API issue has moved beyond
      target and target is no longer present,
      don't incorrectly mark it LOSS.

      It is SKIPPED because the result wasn't
      available in the returned dataset.
    */

    const latest =
      history.length
        ? history[
            history.length - 1
          ].issueNumber
        : "";

    if (
      latest &&
      compareIssues(
        latest,
        target
      ) > 0
    ) {

      await pool.query(
        `
        UPDATE prediction_records
        SET actual_result = 'SKIPPED',
            settled_at = $1
        WHERE id = $2
        `,
        [
          now(),
          prediction.id
        ]
      );

    }

  }

}


/* =========================================================
   COOLDOWN
========================================================= */

async function getCooldownState(
  currentIssue
) {

  const latest =
    await getLatestPrediction();

  if (!latest) {

    return {
      active: false,
      remaining: 0
    };
  }


  /*
    Pending prediction is NOT cooldown.
  */

  if (
    latest.actual_result === null
  ) {

    return {
      active: true,
      pending: true,
      remaining: 0,
      targetIssue:
        latest.target_issue
    };
  }


  /*
    Only WIN / LOSS count as settled
    prediction rounds for cooldown.

    SKIPPED does not start a cooldown.
  */

  if (
    latest.actual_result !== "WIN" &&
    latest.actual_result !== "LOSS"
  ) {

    return {
      active: false,
      remaining: 0
    };
  }


  const target =
    issueBigInt(
      latest.target_issue
    );

  const current =
    issueBigInt(
      currentIssue
    );

  if (
    target === null ||
    current === null
  ) {

    return {
      active: false,
      remaining: 0
    };
  }


  /*
    Number of completed issue steps after
    the prediction target.

    Example:
    target 100
    current 101 => 0 completed wait rounds
    current 102 => 1
    ...
    current 106 => 5
  */

  const completed =
    current > target
      ? Number(current - target)
      : 0;

  const remaining =
    Math.max(
      0,
      COOLDOWN_ROUNDS -
      completed
    );

  return {
    active: remaining > 0,
    pending: false,
    remaining,
    completed:
      Math.min(
        COOLDOWN_ROUNDS,
        completed
      ),
    targetIssue:
      latest.target_issue
  };
}


/* =========================================================
   CREATE NEW PREDICTION
========================================================= */

async function createPrediction(
  currentIssue,
  history
) {

  await settlePredictions(history);

  await refreshPredictionPressure();

  /*
    Check latest AFTER settlement.
  */

  let latest =
    await getLatestPrediction();


  /*
    Remove stale pending prediction.

    If current issue is already beyond target,
    it must never remain visible.
  */

  if (
    latest &&
    latest.actual_result === null
  ) {

    const current =
      issueBigInt(
        currentIssue
      );

    const target =
      issueBigInt(
        latest.target_issue
      );

    if (
      current !== null &&
      target !== null &&
      current > target
    ) {

      await pool.query(
        `
        UPDATE prediction_records
        SET actual_result = 'SKIPPED',
            settled_at = $1
        WHERE id = $2
        `,
        [
          now(),
          latest.id
        ]
      );

      latest = null;
    }

  }


  /*
    If there is a valid pending prediction,
    return it. Do not create another one.
  */

  if (
    latest &&
    latest.actual_result === null
  ) {

    return {
      record: latest,
      analysis: null,
      created: false
    };
  }


  /*
    Cooldown only after settled prediction.
  */

  const cooldown =
    await getCooldownState(
      currentIssue
    );

  if (cooldown.active) {

    return {
      record: null,
      analysis: null,
      cooldown,
      created: false
    };
  }


  /*
    Current issue must exist.
  */

  const targetIssue =
    nextIssue(currentIssue);

  if (!targetIssue) {

    return {
      record: null,
      analysis: null,
      error:
        "Unable to create next issue"
    };
  }


  /*
    Full analysis BEFORE saving prediction.
  */

  const analysis =
    fullAnalysis(history);


  if (
    !analysis.prediction
  ) {

    return {
      record: null,
      analysis,
      created: false
    };
  }


  const insert =
    await pool.query(
      `
      INSERT INTO prediction_records
      (
        target_issue,
        prediction,
        confidence,
        model_version,
        created_at
      )
      VALUES ($1,$2,$3,$4,$5)
      RETURNING *
      `,
      [
        targetIssue,
        analysis.prediction,
        analysis.confidence,
        "DY-AI-V10-SYNC",
        now()
      ]
    );

  return {
    record: insert.rows[0],
    analysis,
    created: true
  };
}


/* =========================================================
   BUILD LIVE STATE
========================================================= */

async function getLiveState() {

  const wingo =
    await getWingo();

  const history =
    wingo.history
      .slice()
      .sort((a,b) =>
        compareIssues(
          b.issueNumber,
          a.issueNumber
        )
      )
      .slice(
        0,
        HISTORY_SIZE
      );


  const currentIssue =
    wingo.currentIssue ||
    (
      history.length
        ? history[0].issueNumber
        : ""
    );


  /*
    IMPORTANT:

    Never call createPrediction with
    a stale empty current issue.
  */

  if (!currentIssue) {

    return {
      ok: true,
      synced: false,
      syncStatus:
        "NO CURRENT ISSUE",
      currentIssue: "",
      history,
      model: null
    };
  }


  const creation =
    await createPrediction(
      currentIssue,
      history
    );


  let record =
    creation.record;

  /*
    If cooldown active, don't expose
    old prediction as a fresh one.
  */

  const cooldown =
    creation.cooldown ||
    await getCooldownState(
      currentIssue
    );


  let model = null;


  if (
    record &&
    record.actual_result === null
  ) {

    model = {

      prediction:
        record.prediction,

      confidence:
        Number(
          record.confidence || 0
        ),

      targetIssue:
        String(
          record.target_issue
        ),

      classification:
        "FULL AI ANALYSIS",

      modelVersion:
        record.model_version

    };

  } else if (
    !cooldown.active
  ) {

    /*
      Creation may have failed because
      insufficient data.
    */

    if (
      creation.analysis &&
      creation.analysis.prediction
    ) {

      /*
        Record should normally exist here.
      */

      const fresh =
        await getLatestPrediction();

      if (
        fresh &&
        fresh.actual_result === null
      ) {

        model = {
          prediction:
            fresh.prediction,

          confidence:
            Number(
              fresh.confidence || 0
            ),

          targetIssue:
            String(
              fresh.target_issue
            ),

          classification:
            safeText(
              creation.analysis.classification
            ),

          modelVersion:
            fresh.model_version
        };

      }

    }

  }


  /*
    Final stale-target safety check.
  */

  if (
    model &&
    model.targetIssue
  ) {

    const c =
      issueBigInt(
        currentIssue
      );

    const t =
      issueBigInt(
        model.targetIssue
      );

    if (
      c !== null &&
      t !== null &&
      t <= c
    ) {

      model = null;
    }

  }


  /*
    Latest prediction records for W/L table.
  */

  const predictionRows =
    await pool.query(`
      SELECT
        target_issue,
        prediction,
        confidence,
        actual_number,
        actual_result,
        created_at,
        settled_at
      FROM prediction_records
      ORDER BY id DESC
      LIMIT 100
    `);


  /*
    Sync information.

    This is important for your screenshot:
    if API is stuck at 51547, server clearly
    reports API issue instead of pretending
    that 51604 is available.
  */

  const latestHistoryIssue =
    history.length
      ? history[0].issueNumber
      : "";

  return {

    ok: true,

    synced:
      Boolean(
        currentIssue
      ),

    syncStatus:
      currentIssue
        ? "LIVE API SYNCED"
        : "SYNCING",

    currentIssue:
      String(currentIssue),

    apiCurrentIssue:
      String(currentIssue),

    latestHistoryIssue:
      String(latestHistoryIssue),

    fetchedAt:
      wingo.fetchedAt,

    sourceLastUpdated:
      wingo.sourceLastUpdated,

    history,

    predictions:
      predictionRows.rows.map(row => ({
        target_issue:
          String(
            row.target_issue
          ),

        prediction:
          row.prediction,

        confidence:
          Number(
            row.confidence || 0
          ),

        actual_number:
          row.actual_number,

        actual_result:
          row.actual_result,

        created_at:
          row.created_at,

        settled_at:
          row.settled_at
      })),

    model,

    cooldown:
      cooldown || {
        active: false,
        remaining: 0
      }

  };
}


/* =========================================================
   ADMIN: CREATE KEY
========================================================= */

async function createAccessKey() {

  const key =
    crypto
      .randomBytes(12)
      .toString("hex");

  await pool.query(
    `
    INSERT INTO access_keys
    (
      access_key,
      created_at
    )
    VALUES ($1,$2)
    `,
    [
      key,
      now()
    ]
  );

  return key;
}


/* =========================================================
   HTTP SERVER
========================================================= */

const server =
  http.createServer(
    async (req, res) => {

      try {

        const url =
          new URL(
            req.url,
            `http://${req.headers.host}`
          );

        const pathname =
          url.pathname;


        /* -------------------------
           CORS PREFLIGHT
        ------------------------- */

        if (
          req.method === "OPTIONS"
        ) {

          res.writeHead(204, {
            "Access-Control-Allow-Origin":"*",
            "Access-Control-Allow-Headers":
              "Content-Type, X-Access-Key, X-Device-Id, X-Admin-Key",
            "Access-Control-Allow-Methods":
              "GET,POST,DELETE,OPTIONS"
          });

          return res.end();
        }


        /* -------------------------
           HEALTH
        ------------------------- */

        if (
          pathname === "/health"
        ) {

          return json(
            res,
            200,
            {
              ok: true,
              service:
                "DY AI WinGo",
              time: now()
            }
          );
        }


        /* -------------------------
           KEY CHECK
        ------------------------- */

        if (
          pathname === "/api/key/check" &&
          req.method === "GET"
        ) {

          const auth =
            await authenticateUser(
              req
            );

          if (!auth.ok) {

            return json(
              res,
              auth.status,
              auth
            );
          }

          return json(
            res,
            200,
            {
              ok: true,
              message:
                "Access granted"
            }
          );
        }


        /* -------------------------
           STATE
        ------------------------- */

        if (
          pathname === "/api/state" &&
          req.method === "GET"
        ) {

          const auth =
            await authenticateUser(
              req
            );

          if (!auth.ok) {

            return json(
              res,
              auth.status,
              auth
            );
          }

          const state =
            await getLiveState();

          return json(
            res,
            200,
            state
          );
        }


        /* -------------------------
           HISTORY
        ------------------------- */

        if (
          pathname === "/api/history" &&
          req.method === "GET"
        ) {

          const auth =
            await authenticateUser(
              req
            );

          if (!auth.ok) {

            return json(
              res,
              auth.status,
              auth
            );
          }

          const wingo =
            await getWingo();

          return json(
            res,
            200,
            {
              ok: true,
              currentIssue:
                wingo.currentIssue,
              history:
                wingo.history
                  .slice()
                  .sort(
                    (a,b) =>
                      compareIssues(
                        b.issueNumber,
                        a.issueNumber
                      )
                  )
                  .slice(
                    0,
                    HISTORY_SIZE
                  )
            }
          );
        }


        /* =====================================================
           ADMIN
        ===================================================== */

        if (
          pathname.startsWith(
            "/api/admin/"
          )
        ) {

          if (
            !authenticateAdmin(req)
          ) {

            return json(
              res,
              403,
              {
                ok:false,
                message:
                  "Admin access denied"
              }
            );
          }


          /* -------------------------
             ADMIN KEYS GET
          ------------------------- */

          if (
            pathname === "/api/admin/keys" &&
            req.method === "GET"
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

            return json(
              res,
              200,
              {
                ok:true,
                keys:
                  result.rows
              }
            );
          }


          /* -------------------------
             ADMIN KEY CREATE
          ------------------------- */

          if (
            pathname === "/api/admin/keys" &&
            req.method === "POST"
          ) {

            const key =
              await createAccessKey();

            return json(
              res,
              200,
              {
                ok:true,
                access_key:key
              }
            );
          }


          /* -------------------------
             ADMIN KEY DELETE
          ------------------------- */

          if (
            pathname === "/api/admin/keys" &&
            req.method === "DELETE"
          ) {

            const id =
              url.searchParams.get(
                "id"
              );

            if (!id) {

              return json(
                res,
                400,
                {
                  ok:false,
                  message:
                    "Key ID required"
                }
              );
            }

            await pool.query(
              `
              DELETE FROM access_keys
              WHERE id = $1
              `,
              [id]
            );

            return json(
              res,
              200,
              {
                ok:true
              }
            );
          }


          /* -------------------------
             RESET DEVICE
          ------------------------- */

          if (
            pathname ===
            "/api/admin/reset-device" &&
            req.method === "POST"
          ) {

            const id =
              url.searchParams.get(
                "id"
              );

            if (!id) {

              return json(
                res,
                400,
                {
                  ok:false,
                  message:
                    "Key ID required"
                }
              );
            }

            await pool.query(
              `
              UPDATE access_keys
              SET device_id = NULL,
                  last_seen = 0
              WHERE id = $1
              `,
              [id]
            );

            return json(
              res,
              200,
              {
                ok:true,
                message:
                  "Device reset"
              }
            );
          }


          /* -------------------------
             ADMIN STATUS
          ------------------------- */

          if (
            pathname ===
            "/api/admin/status" &&
            req.method === "GET"
          ) {

            const keys =
              await pool.query(`
                SELECT
                  COUNT(*)::int AS total,
                  COUNT(
                    CASE
                      WHEN last_seen >
                        $1
                      THEN 1
                    END
                  )::int AS online
                FROM access_keys
              `, [
                now() - 120000
              ]);

            const latest =
              await getLatestPrediction();

            return json(
              res,
              200,
              {
                ok:true,

                keys:
                  keys.rows[0],

                latestPrediction:
                  latest
                    ? {
                        targetIssue:
                          String(
                            latest.target_issue
                          ),
                        prediction:
                          latest.prediction,
                        confidence:
                          Number(
                            latest.confidence || 0
                          ),
                        actualResult:
                          latest.actual_result
                      }
                    : null
              }
            );
          }


          /* -------------------------
             ADMIN PING
          ------------------------- */

          if (
            pathname ===
            "/api/admin/ping" &&
            req.method === "GET"
          ) {

            return json(
              res,
              200,
              {
                ok:true,
                time:now()
              }
            );
          }


          /* -------------------------
             ADMIN WINGO TEST
          ------------------------- */

          if (
            pathname ===
            "/api/admin/wingo-test" &&
            req.method === "GET"
          ) {

            try {

              const data =
                await getWingo();

              return json(
                res,
                200,
                {
                  ok:true,
                  currentIssue:
                    data.currentIssue,
                  historyCount:
                    data.history.length,
                  latestHistory:
                    data.history
                      .slice(-3),
                  fetchedAt:
                    data.fetchedAt,
                  sourceLastUpdated:
                    data.sourceLastUpdated
                }
              );

            } catch (error) {

              return json(
                res,
                500,
                {
                  ok:false,
                  error:
                    error.message
                }
              );

            }
          }


          /* -------------------------
             ADMIN MODEL TEST
          ------------------------- */

          if (
            pathname ===
            "/api/admin/model-test" &&
            req.method === "GET"
          ) {

            try {

              const data =
                await getWingo();

              const analysis =
                fullAnalysis(
                  data.history
                );

              return json(
                res,
                200,
                {
                  ok:true,
                  currentIssue:
                    data.currentIssue,
                  analysis
                }
              );

            } catch (error) {

              return json(
                res,
                500,
                {
                  ok:false,
                  error:
                    error.message
                }
              );

            }
          }


          /* -------------------------
             ADMIN PREDICTIONS
          ------------------------- */

          if (
            pathname ===
            "/api/admin/predictions" &&
            req.method === "GET"
          ) {

            const result =
              await pool.query(`
                SELECT *
                FROM prediction_records
                ORDER BY id DESC
                LIMIT 200
              `);

            return json(
              res,
              200,
              {
                ok:true,
                predictions:
                  result.rows
              }
            );
          }


          return json(
            res,
            404,
            {
              ok:false,
              message:
                "Admin endpoint not found"
            }
          );
        }


        /* =====================================================
           STATIC FILES
        ===================================================== */

        let filePath;

        if (
          pathname === "/" ||
          pathname === ""
        ) {

          filePath =
            path.join(
              PUBLIC_DIR,
              "prediction.html"
            );

        } else {

          const safePath =
            path
              .normalize(pathname)
              .replace(/^(\.\.[\/\\])+/, "");

          filePath =
            path.join(
              PUBLIC_DIR,
              safePath
            );
        }


        if (
          !filePath.startsWith(
            PUBLIC_DIR
          )
        ) {

          return text(
            res,
            403,
            "Forbidden"
          );
        }


        if (
          fs.existsSync(filePath) &&
          fs.statSync(filePath).isFile()
        ) {

          const ext =
            path.extname(
              filePath
            ).toLowerCase();

          const types = {
            ".html":
              "text/html; charset=utf-8",
            ".css":
              "text/css; charset=utf-8",
            ".js":
              "application/javascript; charset=utf-8",
            ".json":
              "application/json; charset=utf-8",
            ".png":
              "image/png",
            ".jpg":
              "image/jpeg",
            ".jpeg":
              "image/jpeg",
            ".svg":
              "image/svg+xml",
            ".mp3":
              "audio/mpeg"
          };

          const contentType =
            types[ext] ||
            "application/octet-stream";


          /* MP3 range support */

          if (
            ext === ".mp3"
          ) {

            const stat =
              fs.statSync(
                filePath
              );

            const total =
              stat.size;

            const range =
              req.headers.range;

            if (range) {

              const match =
                range.match(
                  /bytes=(\d*)-(\d*)/
                );

              if (match) {

                let start =
                  match[1]
                    ? parseInt(
                        match[1],
                        10
                      )
                    : 0;

                let end =
                  match[2]
                    ? parseInt(
                        match[2],
                        10
                      )
                    : total - 1;

                if (
                  start >= total ||
                  end >= total
                ) {

                  end =
                    total - 1;
                }

                const chunkSize =
                  end - start + 1;

                res.writeHead(
                  206,
                  {
                    "Content-Range":
                      `bytes ${start}-${end}/${total}`,
                    "Accept-Ranges":
                      "bytes",
                    "Content-Length":
                      chunkSize,
                    "Content-Type":
                      contentType,
                    "Cache-Control":
                      "public, max-age=3600"
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
                "Content-Length":
                  total,
                "Content-Type":
                  contentType,
                "Accept-Ranges":
                  "bytes",
                "Cache-Control":
                  "public, max-age=3600"
              }
            );

            return fs
              .createReadStream(
                filePath
              )
              .pipe(res);
          }


          const data =
            fs.readFileSync(
              filePath
            );

          res.writeHead(
            200,
            {
              "Content-Type":
                contentType,
              "Cache-Control":
                "no-cache"
            }
          );

          return res.end(data);
        }


        return text(
          res,
          404,
          "Not Found"
        );

      } catch (error) {

        console.error(
          "SERVER ERROR:",
          error
        );

        return json(
          res,
          500,
          {
            ok:false,
            message:
              "Internal server error",
            error:
              error.message
          }
        );

      }

    }
  );


/* =========================================================
   START
========================================================= */

async function start() {

  try {

    await initDB();

    server.listen(
      PORT,
      () => {

        console.log(
          `DY AI WinGo running on port ${PORT}`
        );

        console.log(
          `Wingo API: ${WINGOBOT_URL}`
        );

      }
    );

  } catch (error) {

    console.error(
      "STARTUP ERROR:",
      error
    );

    process.exit(1);

  }

}

start();
