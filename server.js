// ============================================================
// DY AI WINGO 30S - COMPLETE SERVER
// MODEL: DY-AI-BS-V3
// ============================================================

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const { Pool } = require("pg");

// ============================================================
// CONFIG
// ============================================================

const PORT = Number(process.env.PORT || 10000);

const DATABASE_URL = process.env.DATABASE_URL || "";

const ADMIN_KEY = process.env.ADMIN_KEY || "dy4427574";

const WINGOBOT_TOKEN = process.env.WINGOBOT_TOKEN || "";

const WINGOBOT_URL =
  "https://api.wingobot.com/v2/30-sec-game-history";

const GAME_URL =
  "https://www.shreewin38.com/#/register?invitationCode=88523152383";

const MODEL_VERSION = "DY-AI-BS-V3";

const PROVIDER_POLL_MS = 3000;

const STATE_CACHE_MS = 800;

const MAX_HISTORY = 200;

const LAST30 = 30;


// ============================================================
// DATABASE
// ============================================================

let pool = null;

if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });
}


// ============================================================
// GLOBAL PROVIDER STATE
// ============================================================

let provider = {
  ok: false,
  history: [],
  currentIssue: null,
  lastUpdated: null,
  fetched: 0,
  error: null,
  fetchedAt: 0
};

let providerFetching = false;

let lastStateCache = null;

let lastStateCacheAt = 0;


// ============================================================
// BASIC HELPERS
// ============================================================

function now() {
  return Date.now();
}

function json(res, status, data) {
  const body = JSON.stringify(data);

  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS"
  });

  res.end(body);
}

function text(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });

  res.end(body);
}

function safeString(value) {
  if (value === null || value === undefined) return "";
  return String(value);
}

function cleanIssue(value) {
  if (value === null || value === undefined) return null;

  const s = String(value).trim();

  if (!s) return null;

  return s;
}

function incrementIssue(issue) {
  if (!issue) return null;

  const s = String(issue).trim();

  if (!/^\d+$/.test(s)) {
    return null;
  }

  try {
    return (BigInt(s) + 1n).toString();
  } catch {
    return null;
  }
}

function sameIssue(a, b) {
  return String(a || "") === String(b || "");
}

function sideFromNumber(number) {
  const n = Number(number);

  if (!Number.isFinite(n)) {
    return null;
  }

  if (n >= 0 && n <= 4) {
    return "SMALL";
  }

  if (n >= 5 && n <= 9) {
    return "BIG";
  }

  return null;
}

function normalizeSide(value, number = null) {
  const s = safeString(value).trim().toUpperCase();

  if (
    s === "BIG" ||
    s === "B" ||
    s === "BIGGEST"
  ) {
    return "BIG";
  }

  if (
    s === "SMALL" ||
    s === "S" ||
    s === "SMALLEST"
  ) {
    return "SMALL";
  }

  return sideFromNumber(number);
}

function oppositeSide(side) {
  return side === "BIG" ? "SMALL" : "BIG";
}

function average(arr) {
  if (!arr.length) return 0;

  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function randomId() {
  return crypto.randomBytes(18).toString("hex");
}


// ============================================================
// REQUEST BODY
// ============================================================

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk.toString();

      if (body.length > 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });

    req.on("error", reject);
  });
}


// ============================================================
// DATABASE INIT
// ============================================================

async function initDatabase() {
  if (!pool) {
    console.log("DATABASE_URL not configured.");
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
      settled_at BIGINT,
      created_at BIGINT NOT NULL
    )
  `);

  // Existing databases may not have these columns.
  await pool.query(`
    ALTER TABLE prediction_records
    ADD COLUMN IF NOT EXISTS confidence INTEGER DEFAULT 0
  `);

  await pool.query(`
    ALTER TABLE prediction_records
    ADD COLUMN IF NOT EXISTS model_version TEXT
  `);

  await pool.query(`
    ALTER TABLE prediction_records
    ADD COLUMN IF NOT EXISTS actual_number INTEGER
  `);

  await pool.query(`
    ALTER TABLE prediction_records
    ADD COLUMN IF NOT EXISTS actual_result TEXT
  `);

  await pool.query(`
    ALTER TABLE prediction_records
    ADD COLUMN IF NOT EXISTS settled_at BIGINT
  `);

  await pool.query(`
    ALTER TABLE prediction_records
    ADD COLUMN IF NOT EXISTS created_at BIGINT
  `);

  await pool.query(`
    UPDATE prediction_records
    SET model_version = 'LEGACY'
    WHERE model_version IS NULL
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS
    prediction_model_issue_unique
    ON prediction_records(model_version, target_issue)
  `);

  console.log("Database initialized.");
}


// ============================================================
// WINGOBOT FETCH
// ============================================================

async function fetchWingoBot() {
  if (!WINGOBOT_TOKEN) {
    provider.ok = false;
    provider.error = "WINGOBOT_TOKEN is not configured";
    return provider;
  }

  if (providerFetching) {
    return provider;
  }

  providerFetching = true;

  try {
    const response = await fetch(WINGOBOT_URL, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${WINGOBOT_TOKEN}`,
        "Accept": "application/json"
      }
    });

    const rawText = await response.text();

    if (!response.ok) {
      throw new Error(
        `WingoBot HTTP ${response.status}: ${rawText.slice(0, 300)}`
      );
    }

    let data;

    try {
      data = JSON.parse(rawText);
    } catch {
      throw new Error("WingoBot returned invalid JSON");
    }

    const normalized = normalizeWingoResponse(data);

    provider = {
      ok: true,
      history: normalized.history,
      currentIssue: normalized.currentIssue,
      lastUpdated: normalized.lastUpdated,
      fetched: normalized.fetched,
      error: null,
      fetchedAt: now()
    };

    lastStateCache = null;

    return provider;

  } catch (error) {
    provider.ok = false;
    provider.error = error.message || "Provider error";
    provider.fetchedAt = now();

    console.error("WingoBot fetch error:", provider.error);

    return provider;

  } finally {
    providerFetching = false;
  }
}


// ============================================================
// NORMALIZE WINGOBOT RESPONSE
// ============================================================

function normalizeWingoResponse(data) {
  const currentIssue =
    cleanIssue(
      data?.current?.issueNumber ??
      data?.current?.issue ??
      data?.currentIssue
    );

  const rows =
    Array.isArray(data?.history)
      ? data.history
      : Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data)
          ? data
          : [];

  const history = [];

  for (const row of rows) {
    if (!row) continue;

    const issue =
      cleanIssue(
        row.issueNumber ??
        row.issue ??
        row.period ??
        row.periodNumber
      );

    if (!issue) continue;

    const rawNumber =
      row.number ??
      row.num ??
      row.result;

    let number = null;

    if (
      rawNumber !== null &&
      rawNumber !== undefined &&
      String(rawNumber).trim() !== ""
    ) {
      const n = Number(rawNumber);

      if (
        Number.isInteger(n) &&
        n >= 0 &&
        n <= 9
      ) {
        number = n;
      }
    }

    const side =
      normalizeSide(
        row.colour ??
        row.color ??
        row.resultType ??
        row.bigSmall ??
        row.side,
        number
      );

    /*
      A row without a valid number/side is NOT considered settled.
      This prevents pending rows from becoming fake WIN/LOSS.
    */

    if (!side && number === null) {
      continue;
    }

    history.push({
      issueNumber: issue,
      number,
      side,
      colour: row.colour ?? row.color ?? side,
      premium: row.premium ?? null,
      sum: row.sum ?? null,
      raw: row
    });
  }

  // Remove duplicate periods.
  const unique = new Map();

  for (const row of history) {
    if (!unique.has(row.issueNumber)) {
      unique.set(row.issueNumber, row);
    }
  }

  const finalHistory = Array.from(unique.values());

  finalHistory.sort((a, b) => {
    try {
      const aa = BigInt(a.issueNumber);
      const bb = BigInt(b.issueNumber);

      if (aa > bb) return -1;
      if (aa < bb) return 1;

      return 0;
    } catch {
      return String(b.issueNumber)
        .localeCompare(String(a.issueNumber));
    }
  });

  return {
    currentIssue,
    history: finalHistory.slice(0, MAX_HISTORY),
    lastUpdated:
      data?.stats?.last_updated ??
      data?.last_updated ??
      data?.lastUpdated ??
      null,
    fetched:
      Number(
        data?.stats?.fetched ??
        finalHistory.length
      ) || finalHistory.length
  };
}


// ============================================================
// TARGET ISSUE
// ============================================================

function resolveTargetIssue() {
  const history = provider.history || [];

  const latestSettled =
    history.length
      ? history[0].issueNumber
      : null;

  const current =
    cleanIssue(provider.currentIssue);

  /*
    Correct target logic:

    latest settled = history[0]

    If provider current is ahead of latest settled,
    current is the next target.

    Otherwise target = latest settled + 1
  */

  if (latestSettled && current) {
    try {
      const h = BigInt(latestSettled);
      const c = BigInt(current);

      if (c > h) {
        return current;
      }

      return (h + 1n).toString();

    } catch {
      if (current !== latestSettled) {
        return current;
      }

      return incrementIssue(latestSettled);
    }
  }

  if (current) {
    return current;
  }

  if (latestSettled) {
    return incrementIssue(latestSettled);
  }

  return null;
}


// ============================================================
// SIDE EXTRACTION
// ============================================================

function sidesFromHistory(limit = 30) {
  return (provider.history || [])
    .filter(row => row && row.side)
    .slice(0, limit)
    .map(row => row.side);
}


// ============================================================
// SHORT SIGNAL
// ============================================================

function shortSignal(sides) {
  const arr = sides.slice(0, 5);

  if (!arr.length) {
    return 0;
  }

  let score = 0;

  const weights = [
    1.0,
    0.85,
    0.70,
    0.55,
    0.40
  ];

  for (let i = 0; i < arr.length; i++) {
    score +=
      arr[i] === "BIG"
        ? weights[i]
        : -weights[i];
  }

  return clamp(score / 3.5, -1, 1);
}


// ============================================================
// MEDIUM SIGNAL
// ============================================================

function mediumSignal(sides) {
  const arr = sides.slice(0, 15);

  if (!arr.length) {
    return 0;
  }

  let score = 0;

  for (let i = 0; i < arr.length; i++) {
    const weight =
      1 -
      (i / Math.max(1, arr.length)) * 0.55;

    score +=
      (arr[i] === "BIG" ? 1 : -1) *
      weight;
  }

  const max =
    arr.reduce((sum, _, i) => {
      return sum +
        (1 -
          (i / Math.max(1, arr.length)) *
          0.55);
    }, 0);

  return max
    ? clamp(score / max, -1, 1)
    : 0;
}


// ============================================================
// TRANSITION SIGNAL
// ============================================================

function transitionSignal(sides) {
  const arr = sides.slice(0, 20);

  if (arr.length < 3) {
    return 0;
  }

  let bigToSmall = 0;
  let smallToBig = 0;
  let same = 0;

  for (let i = 0; i < arr.length - 1; i++) {
    const current = arr[i];
    const older = arr[i + 1];

    if (
      older === "BIG" &&
      current === "SMALL"
    ) {
      bigToSmall++;
    }

    if (
      older === "SMALL" &&
      current === "BIG"
    ) {
      smallToBig++;
    }

    if (older === current) {
      same++;
    }
  }

  const total =
    bigToSmall +
    smallToBig +
    same;

  if (!total) return 0;

  /*
    More recent transition gets more influence.
  */

  let recent = 0;

  for (
    let i = 0;
    i < Math.min(6, arr.length - 1);
    i++
  ) {
    const current = arr[i];
    const older = arr[i + 1];

    if (
      older === "BIG" &&
      current === "SMALL"
    ) {
      recent -= 0.18;
    }

    if (
      older === "SMALL" &&
      current === "BIG"
    ) {
      recent += 0.18;
    }
  }

  return clamp(
    (smallToBig - bigToSmall) /
      Math.max(1, total) +
      recent,
    -1,
    1
  );
}


// ============================================================
// STREAK / BREAK SIGNAL
// ============================================================

function breakSignal(sides) {
  const arr = sides.slice(0, 12);

  if (arr.length < 3) {
    return 0;
  }

  let streak = 1;

  while (
    streak < arr.length &&
    arr[streak] === arr[0]
  ) {
    streak++;
  }

  let signal = 0;

  /*
    Do not blindly follow long streaks.
    Detect potential trend break.
  */

  if (streak >= 5) {
    signal =
      arr[0] === "BIG"
        ? -0.55
        : 0.55;
  } else if (streak === 4) {
    signal =
      arr[0] === "BIG"
        ? -0.28
        : 0.28;
  } else if (streak === 3) {
    signal =
      arr[0] === "BIG"
        ? -0.08
        : 0.08;
  }

  // Recent instability.
  const recent = arr.slice(0, 6);

  let changes = 0;

  for (let i = 0; i < recent.length - 1; i++) {
    if (recent[i] !== recent[i + 1]) {
      changes++;
    }
  }

  if (changes >= 4) {
    signal *= 0.65;
  }

  return clamp(signal, -1, 1);
}


// ============================================================
// HISTORICAL PATTERN SIGNAL
// ============================================================

function historicalSignal(sides) {
  const arr = sides.slice(0, 12);

  if (arr.length < 4) {
    return 0;
  }

  const pattern =
    arr
      .slice(0, 4)
      .map(x => x === "BIG" ? "B" : "S")
      .join("");

  let big = 0;
  let small = 0;

  for (let i = 4; i < arr.length - 1; i++) {
    const candidate =
      arr
        .slice(i, i + 4)
        .map(x => x === "BIG" ? "B" : "S")
        .join("");

    if (candidate !== pattern) {
      continue;
    }

    const next = arr[i - 1];

    if (next === "BIG") {
      big++;
    }

    if (next === "SMALL") {
      small++;
    }
  }

  const total = big + small;

  if (!total) {
    return 0;
  }

  return clamp(
    (big - small) / total,
    -1,
    1
  );
}


// ============================================================
// REGIME CLASSIFIER
// ============================================================

function classifyRegime(
  sides,
  short,
  medium,
  transition,
  breakSig
) {
  const arr = sides.slice(0, 15);

  if (arr.length < 4) {
    return "NEUTRAL";
  }

  if (Math.abs(short) < 0.12) {
    return "NEUTRAL";
  }

  if (
    Math.abs(breakSig) > 0.40 &&
    Math.sign(breakSig) !== Math.sign(short)
  ) {
    return "POSSIBLE_BREAK";
  }

  if (
    Math.sign(short) !== Math.sign(medium) &&
    Math.abs(short) > 0.20 &&
    Math.abs(medium) > 0.20
  ) {
    return "CONFLICT";
  }

  if (
    Math.abs(short) > 0.40 &&
    Math.abs(medium) < 0.22
  ) {
    return "NEW_TREND";
  }

  if (
    Math.abs(medium) > 0.40 &&
    Math.abs(short) < Math.abs(medium) * 0.55
  ) {
    return "TREND_WEAKENING";
  }

  if (
    Math.sign(short) === Math.sign(medium) &&
    Math.abs(short) > 0.30 &&
    Math.abs(medium) > 0.30
  ) {
    return "TREND_CONTINUING";
  }

  return "NEUTRAL";
}


// ============================================================
// PREDICTION MODEL
// ============================================================

function createPrediction() {
  const sides = sidesFromHistory(40);

  if (sides.length < 3) {
    return {
      prediction: null,
      confidence: 0,
      regime: "WAITING",
      reason: "Not enough settled history",
      diagnostics: {
        short: 0,
        medium: 0,
        transition: 0,
        break: 0,
        historical: 0
      }
    };
  }

  const short = shortSignal(sides);
  const medium = mediumSignal(sides);
  const transition = transitionSignal(sides);
  const breakSig = breakSignal(sides);
  const historical = historicalSignal(sides);

  const regime =
    classifyRegime(
      sides,
      short,
      medium,
      transition,
      breakSig
    );

  /*
    V3 weighting

    short       40%
    medium      22%
    transition  18%
    break       14%
    historical   6%
  */

  let score =
    short * 0.40 +
    medium * 0.22 +
    transition * 0.18 +
    breakSig * 0.14 +
    historical * 0.06;

  /*
    Anti-blind trend protection.
  */

  if (regime === "POSSIBLE_BREAK") {
    score *= 0.72;
    score += breakSig * 0.12;
  }

  if (regime === "CONFLICT") {
    score *= 0.70;
  }

  if (regime === "TREND_WEAKENING") {
    score *= 0.82;
  }

  /*
    Very strong same-side streak:
    reduce blind continuation.
  */

  const first = sides[0];

  let streak = 1;

  while (
    streak < sides.length &&
    sides[streak] === first
  ) {
    streak++;
  }

  if (streak >= 6) {
    score =
      score * 0.58 +
      (first === "BIG" ? -0.18 : 0.18);
  }

  let prediction;

  if (score >= 0) {
    prediction = "BIG";
  } else {
    prediction = "SMALL";
  }

  /*
    Confidence is intentionally capped.
    This is a statistical estimate, not a guarantee.
  */

  let confidence =
    45 +
    Math.abs(score) * 31;

  if (regime === "CONFLICT") {
    confidence -= 7;
  }

  if (regime === "POSSIBLE_BREAK") {
    confidence -= 5;
  }

  if (regime === "NEUTRAL") {
    confidence -= 3;
  }

  if (sides.length < 8) {
    confidence -= 5;
  }

  confidence =
    Math.round(
      clamp(confidence, 45, 86)
    );

  let reason = "";

  if (regime === "POSSIBLE_BREAK") {
    reason =
      "Trend-break pressure detected";
  } else if (regime === "CONFLICT") {
    reason =
      "Short and medium trend are conflicting";
  } else if (regime === "NEW_TREND") {
    reason =
      "Recent side is gaining momentum";
  } else if (regime === "TREND_WEAKENING") {
    reason =
      "Existing trend is weakening";
  } else if (regime === "TREND_CONTINUING") {
    reason =
      "Recent trend remains aligned";
  } else {
    reason =
      "Mixed recent signals";
  }

  return {
    prediction,
    confidence,
    regime,
    reason,
    diagnostics: {
      short: Number(short.toFixed(4)),
      medium: Number(medium.toFixed(4)),
      transition: Number(transition.toFixed(4)),
      break: Number(breakSig.toFixed(4)),
      historical: Number(historical.toFixed(4)),
      score: Number(score.toFixed(4)),
      streak
    }
  };
}


// ============================================================
// SAVE / GET PREDICTION
// ============================================================

async function getPredictionRecord(issue) {
  if (!pool || !issue) {
    return null;
  }

  const result = await pool.query(
    `
      SELECT *
      FROM prediction_records
      WHERE model_version = $1
      AND target_issue = $2
      ORDER BY id DESC
      LIMIT 1
    `,
    [MODEL_VERSION, issue]
  );

  return result.rows[0] || null;
}


async function createStoredPrediction(issue) {
  if (!issue) {
    return null;
  }

  const existing =
    await getPredictionRecord(issue);

  if (existing) {
    return existing;
  }

  const ai = createPrediction();

  if (!ai.prediction) {
    return null;
  }

  if (!pool) {
    return {
      id: null,
      target_issue: issue,
      prediction: ai.prediction,
      confidence: ai.confidence,
      model_version: MODEL_VERSION,
      actual_number: null,
      actual_result: null,
      settled_at: null,
      created_at: now(),
      regime: ai.regime,
      reason: ai.reason,
      diagnostics: ai.diagnostics
    };
  }

  const result = await pool.query(
    `
      INSERT INTO prediction_records
      (
        target_issue,
        prediction,
        confidence,
        model_version,
        actual_number,
        actual_result,
        settled_at,
        created_at
      )
      VALUES ($1, $2, $3, $4, NULL, NULL, NULL, $5)
      ON CONFLICT (model_version, target_issue)
      DO NOTHING
      RETURNING *
    `,
    [
      issue,
      ai.prediction,
      ai.confidence,
      MODEL_VERSION,
      now()
    ]
  );

  if (result.rows[0]) {
    return {
      ...result.rows[0],
      regime: ai.regime,
      reason: ai.reason,
      diagnostics: ai.diagnostics
    };
  }

  return await getPredictionRecord(issue);
}


// ============================================================
// SETTLE PREDICTIONS
// ============================================================

async function settlePredictions() {
  if (!pool) {
    return;
  }

  if (!provider.history?.length) {
    return;
  }

  const result = await pool.query(
    `
      SELECT *
      FROM prediction_records
      WHERE model_version = $1
      AND actual_result IS NULL
      ORDER BY id DESC
      LIMIT 100
    `,
    [MODEL_VERSION]
  );

  if (!result.rows.length) {
    return;
  }

  const actualMap = new Map();

  for (const row of provider.history) {
    if (!row.issueNumber) continue;

    /*
      Only settled rows are allowed.
      No side + no number = pending/invalid.
    */

    if (
      !row.side &&
      row.number === null
    ) {
      continue;
    }

    actualMap.set(
      String(row.issueNumber),
      row
    );
  }

  for (const prediction of result.rows) {
    const actual =
      actualMap.get(
        String(prediction.target_issue)
      );

    if (!actual) {
      // Still pending.
      continue;
    }

    const actualSide =
      actual.side ||
      sideFromNumber(actual.number);

    if (!actualSide) {
      continue;
    }

    const actualResult =
      actualSide === prediction.prediction
        ? "WIN"
        : "LOSS";

    await pool.query(
      `
        UPDATE prediction_records
        SET
          actual_number = $1,
          actual_result = $2,
          settled_at = $3
        WHERE id = $4
        AND actual_result IS NULL
      `,
      [
        actual.number,
        actualResult,
        now(),
        prediction.id
      ]
    );
  }
}


// ============================================================
// CURRENT PREDICTION
// ============================================================

async function currentPrediction() {
  const target = resolveTargetIssue();

  if (!target) {
    return {
      targetIssue: null,
      prediction: null,
      confidence: 0,
      regime: "WAITING",
      reason: "Waiting for provider data",
      modelVersion: MODEL_VERSION,
      diagnostics: null
    };
  }

  let record =
    await createStoredPrediction(target);

  if (!record) {
    return {
      targetIssue: target,
      prediction: null,
      confidence: 0,
      regime: "WAITING",
      reason: "AI is analysing history",
      modelVersion: MODEL_VERSION,
      diagnostics: null
    };
  }

  /*
    Diagnostics are generated from current history,
    but stored prediction itself never changes for the same
    target issue.
  */

  const diagnosticsAI =
    createPrediction();

  return {
    targetIssue: target,
    prediction: record.prediction,
    confidence: Number(record.confidence || 0),
    regime:
      diagnosticsAI.regime ||
      "NEUTRAL",
    reason:
      diagnosticsAI.reason ||
      "AI analysis complete",
    modelVersion:
      record.model_version ||
      MODEL_VERSION,
    diagnostics:
      diagnosticsAI.diagnostics || null,
    createdAt:
      record.created_at || null
  };
}


// ============================================================
// LAST 30
// ============================================================

async function last30() {
  if (!pool) {
    return [];
  }

  const result = await pool.query(
    `
      SELECT
        id,
        target_issue,
        prediction,
        confidence,
        model_version,
        actual_number,
        actual_result,
        settled_at,
        created_at
      FROM prediction_records
      WHERE model_version = $1
      ORDER BY id DESC
      LIMIT 100
    `,
    [MODEL_VERSION]
  );

  const actualMap = new Map();

  for (const row of provider.history || []) {
    if (!row.issueNumber) continue;

    const side =
      row.side ||
      sideFromNumber(row.number);

    if (!side) continue;

    actualMap.set(
      String(row.issueNumber),
      {
        number: row.number,
        side
      }
    );
  }

  return result.rows
    .slice(0, LAST30)
    .map(row => {
      const actual =
        actualMap.get(
          String(row.target_issue)
        );

      let resultText = null;
      let wl = "PENDING";
      let actualNumber = null;

      /*
        IMPORTANT:
        WIN/LOSS only when exact target issue exists
        in actual provider history.
      */

      if (actual) {
        actualNumber = actual.number;
        resultText = actual.side;

        wl =
          actual.side === row.prediction
            ? "WIN"
            : "LOSS";
      }

      return {
        id: row.id,
        issue: row.target_issue,
        period: row.target_issue,

        // Number is intentionally not exposed to UI.
        number: null,

        result: resultText,
        predict: row.prediction,
        prediction: row.prediction,

        wl,

        confidence:
          Number(row.confidence || 0),

        modelVersion:
          row.model_version,

        settled:
          Boolean(actual),

        createdAt:
          row.created_at,

        settledAt:
          row.settled_at
      };
    });
}


// ============================================================
// STATS
// ============================================================

async function stats() {
  if (!pool) {
    return {
      wins: 0,
      losses: 0,
      pending: 0,
      total: 0,
      winRate: 0
    };
  }

  const result = await pool.query(
    `
      SELECT
        COUNT(*) FILTER (
          WHERE actual_result = 'WIN'
        ) AS wins,

        COUNT(*) FILTER (
          WHERE actual_result = 'LOSS'
        ) AS losses,

        COUNT(*) FILTER (
          WHERE actual_result IS NULL
        ) AS pending

      FROM prediction_records
      WHERE model_version = $1
    `,
    [MODEL_VERSION]
  );

  const row = result.rows[0];

  const wins = Number(row.wins || 0);
  const losses = Number(row.losses || 0);
  const pending = Number(row.pending || 0);

  const total = wins + losses;

  const winRate =
    total > 0
      ? Number(((wins / total) * 100).toFixed(1))
      : 0;

  return {
    wins,
    losses,
    pending,
    total,
    winRate
  };
}


// ============================================================
// ACCESS KEY HELPERS
// ============================================================

function requireAdmin(req) {
  const key =
    req.headers["x-admin-key"] ||
    req.headers["authorization"]?.replace(
      /^Bearer\s+/i,
      ""
    );

  return safeString(key) === ADMIN_KEY;
}

function getDeviceId(body) {
  return safeString(
    body?.deviceId ||
    body?.device_id
  ).trim();
}


// ============================================================
// KEY CHECK
// ============================================================

async function checkAccessKey(accessKey, deviceId) {
  if (!pool) {
    return {
      ok: false,
      message: "Database unavailable"
    };
  }

  if (!accessKey) {
    return {
      ok: false,
      message: "Access key required"
    };
  }

  if (!deviceId) {
    return {
      ok: false,
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
      message: "Invalid access key"
    };
  }

  const row = result.rows[0];

  /*
    First device gets bound to key.
  */

  if (!row.device_id) {
    await pool.query(
      `
        UPDATE access_keys
        SET
          device_id = $1,
          last_seen = $2
        WHERE id = $3
      `,
      [
        deviceId,
        now(),
        row.id
      ]
    );

    return {
      ok: true,
      message: "Access granted",
      bound: true
    };
  }

  if (row.device_id !== deviceId) {
    return {
      ok: false,
      message: "This key is already bound to another device"
    };
  }

  await pool.query(
    `
      UPDATE access_keys
      SET last_seen = $1
      WHERE id = $2
    `,
    [now(), row.id]
  );

  return {
    ok: true,
    message: "Access granted",
    bound: true
  };
}


// ============================================================
// ADMIN KEY LIST
// ============================================================

async function adminListKeys() {
  if (!pool) {
    return [];
  }

  const result = await pool.query(
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

  return result.rows;
}


// ============================================================
// CREATE ACCESS KEY
// ============================================================

async function adminCreateKey(customKey = "") {
  if (!pool) {
    throw new Error("Database unavailable");
  }

  let key =
    safeString(customKey).trim();

  if (!key) {
    key =
      "DY-" +
      randomId().toUpperCase();
  }

  const result = await pool.query(
    `
      INSERT INTO access_keys
      (
        access_key,
        device_id,
        created_at,
        last_seen
      )
      VALUES ($1, NULL, $2, 0)
      RETURNING *
    `,
    [key, now()]
  );

  return result.rows[0];
}


// ============================================================
// RESET DEVICE
// ============================================================

async function adminResetDevice(id) {
  if (!pool) {
    throw new Error("Database unavailable");
  }

  const result = await pool.query(
    `
      UPDATE access_keys
      SET
        device_id = NULL,
        last_seen = 0
      WHERE id = $1
      RETURNING *
    `,
    [id]
  );

  return result.rows[0] || null;
}


// ============================================================
// DELETE KEY
// ============================================================

async function adminDeleteKey(id) {
  if (!pool) {
    throw new Error("Database unavailable");
  }

  const result = await pool.query(
    `
      DELETE FROM access_keys
      WHERE id = $1
      RETURNING id
    `,
    [id]
  );

  return Boolean(result.rows.length);
}


// ============================================================
// ADMIN MODEL TEST
// ============================================================

function modelTest() {
  const ai = createPrediction();

  return {
    ok: Boolean(ai.prediction),
    modelVersion: MODEL_VERSION,
    prediction: ai.prediction,
    confidence: ai.confidence,
    regime: ai.regime,
    reason: ai.reason,
    diagnostics: ai.diagnostics,
    historyCount:
      provider.history?.length || 0,
    providerOk: provider.ok
  };
}


// ============================================================
// STATE
// ============================================================

async function buildState() {
  if (
    lastStateCache &&
    now() - lastStateCacheAt < STATE_CACHE_MS
  ) {
    return lastStateCache;
  }

  await settlePredictions();

  const prediction =
    await currentPrediction();

  const result = {
    ok: true,

    gameUrl: GAME_URL,

    model: {
      version: MODEL_VERSION,
      numberPrediction: false,
      type: "BIG/SMALL"
    },

    provider: {
      ok: provider.ok,
      currentIssue:
        provider.currentIssue,
      lastUpdated:
        provider.lastUpdated,
      fetched:
        provider.fetched,
      historyCount:
        provider.history?.length || 0,
      fetchedAt:
        provider.fetchedAt,
      error:
        provider.error
    },

    current: {
      issue:
        prediction.targetIssue,
      targetIssue:
        prediction.targetIssue,

      prediction:
        prediction.prediction,

      confidence:
        prediction.confidence,

      regime:
        prediction.regime,

      reason:
        prediction.reason,

      modelVersion:
        prediction.modelVersion,

      diagnostics:
        prediction.diagnostics
    },

    stats:
      await stats(),

    last30:
      await last30(),

    serverTime:
      now()
  };

  lastStateCache = result;
  lastStateCacheAt = now();

  return result;
}


// ============================================================
// STATIC FILE SERVER
// ============================================================

function serveFile(res, fileName, contentType) {
  const filePath =
    path.join(__dirname, fileName);

  fs.stat(filePath, (statError, stat) => {
    if (statError || !stat.isFile()) {
      text(
        res,
        404,
        "File not found"
      );

      return;
    }

    fs.readFile(
      filePath,
      (err, data) => {
        if (err) {
          text(
            res,
            500,
            "Unable to read file"
          );

          return;
        }

        res.writeHead(200, {
          "Content-Type": contentType,
          "Cache-Control":
            fileName.endsWith(".html")
              ? "no-store"
              : "public, max-age=3600"
        });

        res.end(data);
      }
    );
  });
}


// ============================================================
// MP3 RANGE SERVER
// ============================================================

function serveMusic(res) {
  const filePath =
    path.join(__dirname, "music.mp3");

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      text(
        res,
        404,
        "music.mp3 not found"
      );

      return;
    }

    const size = stat.size;

    const range =
      res.req?.headers?.range;

    if (!range) {
      res.writeHead(200, {
        "Content-Type": "audio/mpeg",
        "Content-Length": size,
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=3600"
      });

      fs.createReadStream(filePath)
        .pipe(res);

      return;
    }

    const match =
      range.match(
        /bytes=(\d*)-(\d*)/
      );

    if (!match) {
      res.writeHead(416, {
        "Content-Range":
          `bytes */${size}`
      });

      res.end();

      return;
    }

    let start =
      match[1]
        ? Number(match[1])
        : 0;

    let end =
      match[2]
        ? Number(match[2])
        : size - 1;

    if (!Number.isFinite(start)) {
      start = 0;
    }

    if (!Number.isFinite(end)) {
      end = size - 1;
    }

    start = Math.max(
      0,
      Math.min(start, size - 1)
    );

    end = Math.max(
      start,
      Math.min(end, size - 1)
    );

    const chunkSize =
      end - start + 1;

    res.writeHead(206, {
      "Content-Type": "audio/mpeg",
      "Content-Length": chunkSize,
      "Content-Range":
        `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=3600"
    });

    fs.createReadStream(
      filePath,
      {
        start,
        end
      }
    ).pipe(res);
  });
}


// ============================================================
// SERVER
// ============================================================

const server =
  http.createServer(
    async (req, res) => {

      // CORS preflight
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers":
            "Content-Type, Authorization, X-Admin-Key",
          "Access-Control-Allow-Methods":
            "GET, POST, DELETE, OPTIONS"
        });

        return res.end();
      }

      const parsed =
        new URL(
          req.url,
          `http://${req.headers.host || "localhost"}`
        );

      const pathname =
        parsed.pathname;

      try {

        // ==================================================
        // HEALTH
        // ==================================================

        if (
          req.method === "GET" &&
          pathname === "/health"
        ) {
          return json(
            res,
            200,
            {
              ok: true,
              service: "DY AI Wingo 30S",
              model: MODEL_VERSION,
              provider: provider.ok,
              time: now()
            }
          );
        }


        // ==================================================
        // ROOT = PREDICTION
        // ==================================================

        if (
          req.method === "GET" &&
          (
            pathname === "/" ||
            pathname === "/index.html"
          )
        ) {
          return serveFile(
            res,
            "prediction.html",
            "text/html; charset=utf-8"
          );
        }


        // ==================================================
        // ADMIN
        // ==================================================

        if (
          req.method === "GET" &&
          pathname === "/admin.html"
        ) {
          return serveFile(
            res,
            "admin.html",
            "text/html; charset=utf-8"
          );
        }


        // ==================================================
        // MUSIC
        // ==================================================

        if (
          req.method === "GET" &&
          pathname === "/music.mp3"
        ) {
          return serveMusic(res);
        }


        // ==================================================
        // ACCESS KEY CHECK
        // ==================================================

        if (
          req.method === "POST" &&
          pathname === "/api/key/check"
        ) {
          const body =
            await readBody(req);

          const accessKey =
            safeString(
              body.accessKey ||
              body.key
            ).trim();

          const deviceId =
            getDeviceId(body);

          const result =
            await checkAccessKey(
              accessKey,
              deviceId
            );

          return json(
            res,
            result.ok ? 200 : 403,
            result
          );
        }


        // ==================================================
        // STATE
        // ==================================================

        if (
          req.method === "GET" &&
          pathname === "/api/state"
        ) {
          const state =
            await buildState();

          return json(
            res,
            200,
            state
          );
        }


        // ==================================================
        // HISTORY
        // ==================================================

        if (
          req.method === "GET" &&
          pathname === "/api/history"
        ) {
          return json(
            res,
            200,
            {
              ok: true,
              history:
                provider.history || [],
              count:
                provider.history?.length || 0,
              currentIssue:
                provider.currentIssue
            }
          );
        }


        // ==================================================
        // ADMIN STATUS
        // ==================================================

        if (
          req.method === "GET" &&
          pathname === "/api/admin/status"
        ) {
          if (!requireAdmin(req)) {
            return json(
              res,
              401,
              {
                ok: false,
                message: "Unauthorized"
              }
            );
          }

          const ai =
            createPrediction();

          const database =
            Boolean(pool);

          return json(
            res,
            200,
            {
              ok: true,

              service:
                "DY AI Wingo 30S",

              modelVersion:
                MODEL_VERSION,

              numberPrediction:
                false,

              predictionType:
                "BIG/SMALL",

              gameUrl:
                GAME_URL,

              database,

              provider: {
                ok:
                  provider.ok,

                currentIssue:
                  provider.currentIssue,

                historyCount:
                  provider.history?.length || 0,

                fetched:
                  provider.fetched,

                lastUpdated:
                  provider.lastUpdated,

                error:
                  provider.error,

                fetchedAt:
                  provider.fetchedAt
              },

              ai: {
                prediction:
                  ai.prediction,

                confidence:
                  ai.confidence,

                regime:
                  ai.regime,

                reason:
                  ai.reason,

                diagnostics:
                  ai.diagnostics
              },

              serverTime:
                now()
            }
          );
        }


        // ==================================================
        // ADMIN PING
        // ==================================================

        if (
          req.method === "GET" &&
          pathname === "/api/admin/ping"
        ) {
          if (!requireAdmin(req)) {
            return json(
              res,
              401,
              {
                ok: false
              }
            );
          }

          return json(
            res,
            200,
            {
              ok: true,
              message: "DY AI server online",
              model: MODEL_VERSION,
              time: now()
            }
          );
        }


        // ==================================================
        // ADMIN WINGOBOT TEST
        // ==================================================

        if (
          req.method === "GET" &&
          pathname === "/api/admin/wingo-test"
        ) {
          if (!requireAdmin(req)) {
            return json(
              res,
              401,
              {
                ok: false,
                message: "Unauthorized"
              }
            );
          }

          await fetchWingoBot();

          return json(
            res,
            200,
            {
              ok: provider.ok,
              currentIssue:
                provider.currentIssue,
              historyCount:
                provider.history?.length || 0,
              fetched:
                provider.fetched,
              lastUpdated:
                provider.lastUpdated,
              error:
                provider.error,
              sample:
                provider.history
                  ?.slice(0, 5)
                  .map(row => ({
                    issueNumber:
                      row.issueNumber,
                    side:
                      row.side
                  }))
            }
          );
        }


        // ==================================================
        // ADMIN MODEL TEST
        // ==================================================

        if (
          req.method === "GET" &&
          pathname === "/api/admin/model-test"
        ) {
          if (!requireAdmin(req)) {
            return json(
              res,
              401,
              {
                ok: false,
                message: "Unauthorized"
              }
            );
          }

          return json(
            res,
            200,
            modelTest()
          );
        }


        // ==================================================
        // ADMIN KEYS GET
        // ==================================================

        if (
          req.method === "GET" &&
          pathname === "/api/admin/keys"
        ) {
          if (!requireAdmin(req)) {
            return json(
              res,
              401,
              {
                ok: false,
                message: "Unauthorized"
              }
            );
          }

          const keys =
            await adminListKeys();

          return json(
            res,
            200,
            {
              ok: true,
              keys
            }
          );
        }


        // ==================================================
        // ADMIN KEY CREATE
        // ==================================================

        if (
          req.method === "POST" &&
          pathname === "/api/admin/keys"
        ) {
          if (!requireAdmin(req)) {
            return json(
              res,
              401,
              {
                ok: false,
                message: "Unauthorized"
              }
            );
          }

          const body =
            await readBody(req);

          const key =
            safeString(
              body.accessKey ||
              body.key
            ).trim();

          const created =
            await adminCreateKey(key);

          return json(
            res,
            200,
            {
              ok: true,
              key: created
            }
          );
        }


        // ==================================================
        // ADMIN RESET DEVICE
        // ==================================================

        if (
          req.method === "POST" &&
          pathname === "/api/admin/reset-device"
        ) {
          if (!requireAdmin(req)) {
            return json(
              res,
              401,
              {
                ok: false,
                message: "Unauthorized"
              }
            );
          }

          const body =
            await readBody(req);

          const id =
            Number(body.id);

          if (!Number.isInteger(id)) {
            return json(
              res,
              400,
              {
                ok: false,
                message: "Invalid key ID"
              }
            );
          }

          const updated =
            await adminResetDevice(id);

          return json(
            res,
            200,
            {
              ok: Boolean(updated),
              key: updated
            }
          );
        }


        // ==================================================
        // ADMIN DELETE KEY
        // ==================================================

        if (
          req.method === "DELETE" &&
          pathname === "/api/admin/keys"
        ) {
          if (!requireAdmin(req)) {
            return json(
              res,
              401,
              {
                ok: false,
                message: "Unauthorized"
              }
            );
          }

          const id =
            Number(
              parsed.searchParams.get("id")
            );

          if (!Number.isInteger(id)) {
            return json(
              res,
              400,
              {
                ok: false,
                message: "Invalid key ID"
              }
            );
          }

          const deleted =
            await adminDeleteKey(id);

          return json(
            res,
            200,
            {
              ok: deleted
            }
          );
        }


        // ==================================================
        // FAVICON
        // ==================================================

        if (
          req.method === "GET" &&
          pathname === "/favicon.ico"
        ) {
          return text(
            res,
            204,
            ""
          );
        }


        // ==================================================
        // 404
        // ==================================================

        return json(
          res,
          404,
          {
            ok: false,
            message: "Not found"
          }
        );

      } catch (error) {

        console.error(
          "Server request error:",
          error
        );

        return json(
          res,
          500,
          {
            ok: false,
            message:
              error.message ||
              "Internal server error"
          }
        );
      }
    }
  );


// ============================================================
// BACKGROUND PROVIDER LOOP
// ============================================================

async function providerLoop() {
  await fetchWingoBot();

  try {
    await settlePredictions();
  } catch (error) {
    console.error(
      "Settlement error:",
      error.message
    );
  }

  setTimeout(
    providerLoop,
    PROVIDER_POLL_MS
  );
}


// ============================================================
// START
// ============================================================

async function start() {
  try {

    await initDatabase();

    server.listen(
      PORT,
      "0.0.0.0",
      () => {
        console.log(
          `DY AI Wingo server running on port ${PORT}`
        );

        console.log(
          `Prediction: /`
        );

        console.log(
          `Admin: /admin.html`
        );

        console.log(
          `Model: ${MODEL_VERSION}`
        );

        console.log(
          `Game: ${GAME_URL}`
        );
      }
    );

    providerLoop();

  } catch (error) {

    console.error(
      "Startup error:",
      error
    );

    process.exit(1);
  }
}

start();


// ============================================================
// PROCESS SAFETY
// ============================================================

process.on(
  "unhandledRejection",
  error => {
    console.error(
      "Unhandled rejection:",
      error
    );
  }
);

process.on(
  "uncaughtException",
  error => {
    console.error(
      "Uncaught exception:",
      error
    );
  }
);
