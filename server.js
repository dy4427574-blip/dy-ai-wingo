const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = process.env.PORT || 10000;
const ADMIN_KEY = process.env.ADMIN_KEY || "dy4427574";
const WINGOBOT_TOKEN = process.env.WINGOBOT_TOKEN || "";

const MODEL_VERSION = "DY-AI-BS-V3";

const GAME_URL =
  "https://www.shreewin38.com/#/register?invitationCode=88523152383";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false,
});

let providerCache = {
  currentIssue: null,
  latestSettledIssue: null,
  history: [],
  fetched: 0,
  lastUpdated: 0,
  lastFetchAt: 0,
  error: null,
};

let lastPredictionTarget = null;
let lastPrediction = null;
let lastPredictionAt = 0;

let serverStartedAt = Date.now();


// ============================================================
// BASIC HELPERS
// ============================================================

function now() {
  return Date.now();
}

function safeJson(res, status, data) {
  const body = JSON.stringify(data);

  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });

  res.end(body);
}

function text(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });

  res.end(body);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk.toString();

      if (body.length > 2 * 1024 * 1024) {
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

function randomKey(length = 16) {
  return crypto
    .randomBytes(length)
    .toString("hex")
    .toUpperCase();
}

function incrementIssue(issue) {
  if (!issue) return null;

  const s = String(issue).trim();

  if (!/^\d+$/.test(s)) {
    return null;
  }

  try {
    const n = BigInt(s) + 1n;
    return n.toString();
  } catch {
    return null;
  }
}

function issueToBigInt(issue) {
  try {
    return BigInt(String(issue));
  } catch {
    return null;
  }
}

function compareIssue(a, b) {
  const aa = issueToBigInt(a);
  const bb = issueToBigInt(b);

  if (aa === null || bb === null) {
    return String(a || "").localeCompare(String(b || ""));
  }

  if (aa > bb) return 1;
  if (aa < bb) return -1;
  return 0;
}


// ============================================================
// SIDE HELPERS
// ============================================================

function normalizeSide(value) {
  if (value === null || value === undefined) return null;

  const s = String(value).trim().toUpperCase();

  if (s === "BIG") return "BIG";
  if (s === "SMALL") return "SMALL";

  return null;
}

function sideFromNumber(number) {
  if (number === null || number === undefined) return null;

  const n = Number(number);

  if (!Number.isFinite(n)) return null;
  if (n < 0 || n > 9) return null;

  return n >= 5 ? "BIG" : "SMALL";
}

function normalizeNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const n = Number(value);

  if (!Number.isInteger(n)) return null;
  if (n < 0 || n > 9) return null;

  return n;
}


// ============================================================
// WINGOBOT
// ============================================================

async function fetchWingoBot() {
  if (!WINGOBOT_TOKEN) {
    throw new Error("WINGOBOT_TOKEN is not configured");
  }

  const url = "https://api.wingobot.com/v2/30-sec-game-history";

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, 10000);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${WINGOBOT_TOKEN}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`WingoBot HTTP ${response.status}`);
    }

    const data = await response.json();

    return data;
  } finally {
    clearTimeout(timeout);
  }
}


// ============================================================
// HISTORY NORMALIZATION
// ============================================================

function normalizeHistory(raw) {
  const rows = Array.isArray(raw?.history)
    ? raw.history
    : Array.isArray(raw?.data)
      ? raw.data
      : Array.isArray(raw)
        ? raw
        : [];

  const result = [];

  for (const row of rows) {
    if (!row) continue;

    const issue =
      row.issueNumber ??
      row.issue ??
      row.period ??
      row.periodNumber ??
      null;

    if (issue === null || issue === undefined) continue;

    const issueNumber = String(issue);

    const number = normalizeNumber(
      row.number ??
      row.num ??
      row.result ??
      row.openNumber
    );

    const explicitSide = normalizeSide(
      row.side ??
      row.bigSmall ??
      row.resultType
    );

    const side = explicitSide || sideFromNumber(number);

    /*
     * IMPORTANT:
     * A result without a valid number/side is NOT treated as settled.
     */
    if (!side) {
      continue;
    }

    result.push({
      issueNumber,
      number,
      side,
      colour: row.colour ?? row.color ?? null,
      premium: row.premium ?? null,
      sum: row.sum ?? null,
    });
  }

  /*
   * Remove duplicate periods.
   */
  const unique = new Map();

  for (const row of result) {
    if (!unique.has(row.issueNumber)) {
      unique.set(row.issueNumber, row);
    }
  }

  return Array.from(unique.values())
    .sort((a, b) => compareIssue(b.issueNumber, a.issueNumber));
}


// ============================================================
// PROVIDER STATE
// ============================================================

async function refreshProvider() {
  try {
    const raw = await fetchWingoBot();

    const history = normalizeHistory(raw);

    const currentIssue =
      raw?.current?.issueNumber ??
      raw?.current?.issue ??
      raw?.current?.period ??
      null;

    const latestSettledIssue =
      history.length > 0
        ? history[0].issueNumber
        : null;

    providerCache = {
      currentIssue: currentIssue ? String(currentIssue) : null,
      latestSettledIssue,
      history,
      fetched:
        raw?.stats?.fetched ??
        history.length,
      lastUpdated:
        raw?.stats?.last_updated ??
        now(),
      lastFetchAt: now(),
      error: null,
    };

    return providerCache;
  } catch (err) {
    providerCache = {
      ...providerCache,
      error: err.message,
      lastFetchAt: now(),
    };

    throw err;
  }
}


// ============================================================
// TARGET RESOLVER
// ============================================================

function resolveTargetIssue() {
  const latest = providerCache.latestSettledIssue;
  const current = providerCache.currentIssue;

  if (!latest && current) {
    return current;
  }

  if (!latest) {
    return null;
  }

  /*
   * If provider current is ahead of latest settled result,
   * current is the target.
   *
   * Example:
   * settled = 51803
   * current  = 51804
   * target   = 51804
   */
  if (current && compareIssue(current, latest) > 0) {
    return current;
  }

  /*
   * If current is same as latest settled, next period is target.
   */
  return incrementIssue(latest);
}


// ============================================================
// MODEL DATA
// ============================================================

function sidesFromHistory(history, limit = 100) {
  return history
    .slice(0, limit)
    .map(x => x.side)
    .filter(Boolean);
}

function countSides(arr) {
  let big = 0;
  let small = 0;

  for (const side of arr) {
    if (side === "BIG") big++;
    if (side === "SMALL") small++;
  }

  return { big, small };
}

function sideScore(arr) {
  if (!arr.length) return 0;

  const { big, small } = countSides(arr);

  return (big - small) / arr.length;
}

function weightedRecentScore(sides, decay = 0.82) {
  let big = 0;
  let small = 0;
  let weight = 1;

  for (const side of sides) {
    if (side === "BIG") big += weight;
    if (side === "SMALL") small += weight;

    weight *= decay;
  }

  const total = big + small;

  if (!total) return 0;

  return (big - small) / total;
}


// ============================================================
// STREAK
// ============================================================

function getStreak(sides) {
  if (!sides.length) {
    return {
      side: null,
      length: 0,
    };
  }

  const side = sides[0];

  let length = 0;

  for (const x of sides) {
    if (x !== side) break;
    length++;
  }

  return {
    side,
    length,
  };
}


// ============================================================
// SHORT TREND
// ============================================================

function getShortTrend(sides) {
  const a = sides.slice(0, 5);

  if (!a.length) {
    return {
      score: 0,
      strength: 0,
      label: "NEUTRAL",
    };
  }

  const score = weightedRecentScore(a, 0.72);

  const strength = Math.min(1, Math.abs(score));

  let label = "NEUTRAL";

  if (score >= 0.25) label = "BIG";
  if (score <= -0.25) label = "SMALL";

  return {
    score,
    strength,
    label,
  };
}


// ============================================================
// MEDIUM TREND
// ============================================================

function getMediumTrend(sides) {
  const a = sides.slice(0, 15);

  if (!a.length) {
    return {
      score: 0,
      strength: 0,
      label: "NEUTRAL",
    };
  }

  const score = sideScore(a);

  const strength = Math.min(1, Math.abs(score) * 1.4);

  let label = "NEUTRAL";

  if (score >= 0.15) label = "BIG";
  if (score <= -0.15) label = "SMALL";

  return {
    score,
    strength,
    label,
  };
}


// ============================================================
// TRANSITION MODEL
// ============================================================

function getTransitionModel(sides) {
  const counts = {
    BIG: {
      BIG: 0,
      SMALL: 0,
    },
    SMALL: {
      BIG: 0,
      SMALL: 0,
    },
  };

  for (let i = 1; i < sides.length; i++) {
    const previous = sides[i];
    const next = sides[i - 1];

    if (!counts[previous] || !counts[previous][next]) continue;

    counts[previous][next]++;
  }

  const last = sides[0];

  if (!last) {
    return {
      score: 0,
      confidence: 0,
      sample: 0,
    };
  }

  const total =
    counts[last].BIG +
    counts[last].SMALL;

  if (!total) {
    return {
      score: 0,
      confidence: 0,
      sample: 0,
    };
  }

  const bigP = counts[last].BIG / total;
  const smallP = counts[last].SMALL / total;

  return {
    score: bigP - smallP,
    confidence: Math.min(1, total / 12),
    sample: total,
  };
}


// ============================================================
// RUN HISTORY
// ============================================================

function getRunHistory(sides) {
  const runs = [];

  if (!sides.length) return runs;

  let current = sides[0];
  let length = 1;

  for (let i = 1; i < sides.length; i++) {
    if (sides[i] === current) {
      length++;
    } else {
      runs.push({
        side: current,
        length,
      });

      current = sides[i];
      length = 1;
    }
  }

  runs.push({
    side: current,
    length,
  });

  return runs;
}


// ============================================================
// BREAK DETECTOR
// ============================================================

function getBreakModel(sides) {
  if (sides.length < 4) {
    return {
      score: 0,
      strength: 0,
      reason: "NOT_ENOUGH_DATA",
    };
  }

  const streak = getStreak(sides);

  const recent = sides.slice(0, 6);
  const older = sides.slice(6, 16);

  const recentScore = sideScore(recent);
  const olderScore = sideScore(older);

  /*
   * Opposite movement compared with the older regime.
   */
  const regimeShift = recentScore - olderScore;

  /*
   * Alternation / instability.
   */
  let changes = 0;

  for (let i = 1; i < recent.length; i++) {
    if (recent[i] !== recent[i - 1]) {
      changes++;
    }
  }

  const instability =
    recent.length > 1
      ? changes / (recent.length - 1)
      : 0;

  let score = 0;

  /*
   * Long streak creates pressure,
   * but NEVER automatically means reversal.
   */
  if (streak.length >= 4) {
    const pressure = Math.min(0.28, (streak.length - 3) * 0.07);

    if (streak.side === "BIG") {
      score -= pressure;
    } else {
      score += pressure;
    }
  }

  /*
   * Strong regime shift.
   */
  if (Math.abs(regimeShift) >= 0.55) {
    score += regimeShift > 0 ? 0.22 : -0.22;
  }

  /*
   * Very high instability reduces confidence
   * instead of forcing a side.
   */
  const strength =
    Math.min(
      1,
      Math.abs(score) * 2 +
      instability * 0.12
    );

  let reason = "NEUTRAL";

  if (score > 0.12) reason = "BREAK_TO_BIG";
  if (score < -0.12) reason = "BREAK_TO_SMALL";

  if (instability >= 0.8) {
    reason = "HIGH_INSTABILITY";
  }

  return {
    score,
    strength,
    reason,
  };
}


// ============================================================
// HISTORICAL PATTERN
// ============================================================

function historicalPattern(sides) {
  const window = 5;

  if (sides.length < 15) {
    return {
      score: 0,
      confidence: 0,
      matches: 0,
    };
  }

  const current = sides
    .slice(0, window)
    .join(",");

  let bigAfter = 0;
  let smallAfter = 0;
  let matches = 0;

  /*
   * Search older sequences.
   */
  for (
    let i = window + 1;
    i < sides.length - 1;
    i++
  ) {
    const pattern = sides
      .slice(i, i + window)
      .join(",");

    if (pattern !== current) continue;

    const next = sides[i - 1];

    if (next === "BIG") bigAfter++;
    if (next === "SMALL") smallAfter++;

    matches++;
  }

  if (!matches) {
    return {
      score: 0,
      confidence: 0,
      matches: 0,
    };
  }

  const score =
    (bigAfter - smallAfter) /
    matches;

  return {
    score,
    confidence: Math.min(1, matches / 8),
    matches,
  };
}


// ============================================================
// REGIME CLASSIFIER
// ============================================================

function getRegime(sides) {
  const short = getShortTrend(sides);
  const medium = getMediumTrend(sides);
  const streak = getStreak(sides);
  const breakModel = getBreakModel(sides);

  const shortSide = short.label;
  const mediumSide = medium.label;

  if (breakModel.reason === "HIGH_INSTABILITY") {
    return "CONFLICT";
  }

  if (
    breakModel.reason === "BREAK_TO_BIG" &&
    shortSide === "SMALL"
  ) {
    return "POSSIBLE_BREAK";
  }

  if (
    breakModel.reason === "BREAK_TO_SMALL" &&
    shortSide === "BIG"
  ) {
    return "POSSIBLE_BREAK";
  }

  if (
    shortSide !== "NEUTRAL" &&
    mediumSide !== "NEUTRAL" &&
    shortSide !== mediumSide
  ) {
    return "CONFLICT";
  }

  if (
    streak.length <= 2 &&
    shortSide !== "NEUTRAL"
  ) {
    return "NEW_TREND";
  }

  if (
    streak.length >= 3 &&
    shortSide === mediumSide
  ) {
    return "TREND_CONTINUING";
  }

  if (
    streak.length >= 3 &&
    shortSide !== mediumSide
  ) {
    return "TREND_WEAKENING";
  }

  return "NEUTRAL";
}


// ============================================================
// PREDICTION ENGINE V3
// ============================================================

function createPrediction(history) {
  const sides = sidesFromHistory(history, 100);

  if (sides.length < 5) {
    return {
      prediction: "BIG",
      confidence: 45,
      regime: "INSUFFICIENT_DATA",
      reason: "Not enough settled history",
      scores: {},
    };
  }

  const short = getShortTrend(sides);
  const medium = getMediumTrend(sides);
  const transition = getTransitionModel(sides);
  const breakModel = getBreakModel(sides);
  const historical = historicalPattern(sides);
  const streak = getStreak(sides);
  const regime = getRegime(sides);

  /*
   * ==========================================================
   * CORE SCORE
   * ==========================================================
   *
   * Important:
   * Short + medium are NOT simply added with full strength.
   * Otherwise the same trend gets counted multiple times.
   */

  let score = 0;

  // Recent behaviour
  score += short.score * 0.38;

  // Medium confirmation
  score += medium.score * 0.22;

  // Transition evidence
  score += transition.score *
    0.18 *
    transition.confidence;

  // Break/reversal evidence
  score += breakModel.score * 0.16;

  // Historical pattern only as supporting evidence
  score += historical.score *
    0.06 *
    historical.confidence;


  // ==========================================================
  // ANTI-BLIND-TREND LOGIC
  // ==========================================================

  /*
   * Long streak alone must not dominate.
   */
  if (streak.length >= 4) {
    if (streak.side === "BIG") {
      score -= 0.04;
    } else {
      score += 0.04;
    }
  }

  /*
   * But we also DON'T automatically reverse after a streak.
   *
   * If short + medium + transition all agree with the streak,
   * continuation remains valid.
   */
  if (
    streak.length >= 4 &&
    short.label === streak.side &&
    medium.label === streak.side &&
    (
      transition.score > 0.10 &&
      streak.side === "BIG"
      ||
      transition.score < -0.10 &&
      streak.side === "SMALL"
    )
  ) {
    if (streak.side === "BIG") {
      score += 0.06;
    } else {
      score -= 0.06;
    }
  }


  // ==========================================================
  // CONFLICT CONTROL
  // ==========================================================

  let conflictPenalty = 0;

  if (regime === "CONFLICT") {
    conflictPenalty = 0.18;
  }

  if (regime === "POSSIBLE_BREAK") {
    conflictPenalty = 0.08;
  }

  /*
   * If evidence is mixed, pull score toward neutral.
   */
  if (conflictPenalty > 0) {
    score *= 1 - conflictPenalty;
  }


  // ==========================================================
  // FINAL SIDE
  // ==========================================================

  let prediction;

  if (score >= 0) {
    prediction = "BIG";
  } else {
    prediction = "SMALL";
  }


  // ==========================================================
  // CONFIDENCE
  // ==========================================================

  let confidence =
    50 +
    Math.abs(score) * 40;

  /*
   * Agreement bonus.
   */
  let agreement = 0;

  const votes = [
    short.label,
    medium.label,
    transition.score > 0.10
      ? "BIG"
      : transition.score < -0.10
        ? "SMALL"
        : null,
    breakModel.score > 0.10
      ? "BIG"
      : breakModel.score < -0.10
        ? "SMALL"
        : null,
    historical.score > 0.20
      ? "BIG"
      : historical.score < -0.20
        ? "SMALL"
        : null,
  ].filter(Boolean);

  for (const vote of votes) {
    if (vote === prediction) {
      agreement++;
    }
  }

  if (votes.length > 0) {
    confidence +=
      (agreement / votes.length) * 8;
  }

  /*
   * Conflict lowers confidence.
   */
  if (regime === "CONFLICT") {
    confidence -= 10;
  }

  if (regime === "POSSIBLE_BREAK") {
    confidence -= 4;
  }

  if (regime === "TREND_WEAKENING") {
    confidence -= 3;
  }

  /*
   * Keep confidence realistic.
   */
  confidence = Math.round(
    Math.max(
      45,
      Math.min(86, confidence)
    )
  );


  let reason = "BALANCED_SIGNAL";

  if (regime === "TREND_CONTINUING") {
    reason = "TREND_CONTINUATION";
  }

  if (regime === "NEW_TREND") {
    reason = "NEW_TREND";
  }

  if (regime === "TREND_WEAKENING") {
    reason = "TREND_WEAKENING";
  }

  if (regime === "POSSIBLE_BREAK") {
    reason = "POSSIBLE_TREND_BREAK";
  }

  if (regime === "CONFLICT") {
    reason = "MIXED_SIGNAL";
  }

  return {
    prediction,
    confidence,
    regime,
    reason,

    scores: {
      final: Number(score.toFixed(4)),
      short: Number(short.score.toFixed(4)),
      medium: Number(medium.score.toFixed(4)),
      transition: Number(transition.score.toFixed(4)),
      break: Number(breakModel.score.toFixed(4)),
      historical: Number(historical.score.toFixed(4)),
    },

    diagnostics: {
      streakSide: streak.side,
      streakLength: streak.length,
      transitionSample: transition.sample,
      historicalMatches: historical.matches,
      agreement,
      voteCount: votes.length,
    },
  };
}


// ============================================================
// DATABASE INIT
// ============================================================

async function initDB() {
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
      model_version TEXT,
      target_issue TEXT NOT NULL,
      prediction TEXT NOT NULL,
      confidence INTEGER DEFAULT 0,
      created_at BIGINT NOT NULL,
      actual_number INTEGER,
      actual_result TEXT,
      settled_at BIGINT
    )
  `);

  /*
   * Existing installations may have old schemas.
   */
  await pool.query(`
    ALTER TABLE prediction_records
    ADD COLUMN IF NOT EXISTS model_version TEXT
  `);

  await pool.query(`
    ALTER TABLE prediction_records
    ADD COLUMN IF NOT EXISTS confidence INTEGER DEFAULT 0
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

  /*
   * Old records are kept but separated.
   */
  await pool.query(`
    UPDATE prediction_records
    SET model_version = 'LEGACY'
    WHERE model_version IS NULL
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS
    prediction_records_model_target_idx
    ON prediction_records(model_version, target_issue)
  `);
}


// ============================================================
// ACCESS KEY
// ============================================================

async function checkAccessKey(key, deviceId) {
  if (!key || !deviceId) {
    return {
      ok: false,
      message: "Access key and device required",
    };
  }

  const result = await pool.query(
    `
    SELECT *
    FROM access_keys
    WHERE access_key = $1
    LIMIT 1
    `,
    [String(key).trim()]
  );

  if (!result.rows.length) {
    return {
      ok: false,
      message: "Invalid access key",
    };
  }

  const row = result.rows[0];

  if (row.device_id && row.device_id !== deviceId) {
    return {
      ok: false,
      message: "This key is already linked to another device",
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
      [deviceId, now(), row.id]
    );
  } else {
    await pool.query(
      `
      UPDATE access_keys
      SET last_seen = $1
      WHERE id = $2
      `,
      [now(), row.id]
    );
  }

  return {
    ok: true,
    key: row.access_key,
  };
}


// ============================================================
// PREDICTION STORAGE
// ============================================================

async function getRecord(targetIssue) {
  const result = await pool.query(
    `
    SELECT *
    FROM prediction_records
    WHERE model_version = $1
      AND target_issue = $2
    LIMIT 1
    `,
    [MODEL_VERSION, String(targetIssue)]
  );

  return result.rows[0] || null;
}

async function savePrediction(targetIssue, prediction) {
  if (!targetIssue || !prediction) return null;

  const existing = await getRecord(targetIssue);

  if (existing) {
    return existing;
  }

  const result = await pool.query(
    `
    INSERT INTO prediction_records
    (
      model_version,
      target_issue,
      prediction,
      confidence,
      created_at,
      actual_number,
      actual_result,
      settled_at
    )
    VALUES
    ($1, $2, $3, $4, $5, NULL, NULL, NULL)
    ON CONFLICT (model_version, target_issue)
    DO NOTHING
    RETURNING *
    `,
    [
      MODEL_VERSION,
      String(targetIssue),
      prediction.prediction,
      prediction.confidence,
      now(),
    ]
  );

  return result.rows[0] || await getRecord(targetIssue);
}


// ============================================================
// EXACT PERIOD SETTLEMENT
// ============================================================

async function settlePredictions(history) {
  if (!Array.isArray(history) || !history.length) {
    return;
  }

  const settledMap = new Map();

  for (const row of history) {
    if (!row.issueNumber) continue;
    if (!row.side) continue;

    settledMap.set(String(row.issueNumber), row);
  }

  const pending = await pool.query(
    `
    SELECT *
    FROM prediction_records
    WHERE model_version = $1
      AND actual_result IS NULL
    ORDER BY id ASC
    LIMIT 100
    `,
    [MODEL_VERSION]
  );

  for (const prediction of pending.rows) {
    const actual =
      settledMap.get(String(prediction.target_issue));

    /*
     * CRITICAL:
     * No exact period = no settlement.
     */
    if (!actual) {
      continue;
    }

    const actualSide = actual.side;

    if (!actualSide) {
      continue;
    }

    const result =
      prediction.prediction === actualSide
        ? "WIN"
        : "LOSS";

    await pool.query(
      `
      UPDATE prediction_records
      SET actual_number = $1,
          actual_result = $2,
          settled_at = $3
      WHERE id = $4
        AND model_version = $5
        AND actual_result IS NULL
      `,
      [
        actual.number,
        result,
        now(),
        prediction.id,
        MODEL_VERSION,
      ]
    );
  }
}


// ============================================================
// GET CURRENT PREDICTION
// ============================================================

async function getCurrentPrediction() {
  const targetIssue = resolveTargetIssue();

  if (!targetIssue) {
    return {
      targetIssue: null,
      prediction: null,
      confidence: 0,
      status: "WAITING",
      regime: "WAITING",
    };
  }

  /*
   * Prediction is created only once for each target.
   */
  let record = await getRecord(targetIssue);

  if (!record) {
    const model = createPrediction(
      providerCache.history
    );

    record = await savePrediction(
      targetIssue,
      model
    );

    lastPredictionTarget = targetIssue;
    lastPrediction = model;
    lastPredictionAt = now();
  } else {
    /*
     * Diagnostics are recalculated for UI,
     * but the stored prediction itself does NOT change.
     */
    const model = createPrediction(
      providerCache.history
    );

    lastPredictionTarget = targetIssue;
    lastPrediction = {
      ...model,
      prediction: record.prediction,
      confidence: record.confidence,
    };
  }

  const status =
    record.actual_result
      ? record.actual_result
      : "PENDING";

  return {
    targetIssue,
    prediction: record.prediction,
    confidence: record.confidence,
    status,
    regime: lastPrediction?.regime || "NEUTRAL",
    reason: lastPrediction?.reason || "",
    diagnostics: lastPrediction?.diagnostics || {},
  };
}


// ============================================================
// STATS
// ============================================================

async function getStats() {
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

  const row = result.rows[0] || {};

  const wins = Number(row.wins || 0);
  const losses = Number(row.losses || 0);
  const pending = Number(row.pending || 0);

  const settled = wins + losses;

  const accuracy =
    settled > 0
      ? Number(((wins / settled) * 100).toFixed(2))
      : 0;

  return {
    wins,
    losses,
    pending,
    settled,
    accuracy,
  };
}


// ============================================================
// LAST 30
// ============================================================

async function getLast30() {
  const result = await pool.query(
    `
    SELECT
      id,
      target_issue,
      prediction,
      confidence,
      created_at,
      actual_number,
      actual_result,
      settled_at
    FROM prediction_records
    WHERE model_version = $1
    ORDER BY id DESC
    LIMIT 30
    `,
    [MODEL_VERSION]
  );

  /*
   * IMPORTANT:
   * Actual result shown only if this exact prediction
   * period has a matching settled provider result.
   */
  const actualMap = new Map();

  for (const row of providerCache.history) {
    if (!row.issueNumber || !row.side) continue;

    actualMap.set(
      String(row.issueNumber),
      row
    );
  }

  return result.rows.map(row => {
    const actual =
      actualMap.get(String(row.target_issue));

    /*
     * If provider has no exact period:
     * result must remain PENDING.
     */
    const actualResult =
      actual
        ? (
            row.prediction === actual.side
              ? "WIN"
              : "LOSS"
          )
        : null;

    return {
      period: row.target_issue,
      predict: row.prediction,
      confidence: row.confidence,
      result: actual?.side || null,
      actualNumber: actual?.number ?? null,
      wl: actualResult || "PENDING",
      createdAt: row.created_at,
      settledAt: row.settled_at,
    };
  });
}


// ============================================================
// ADMIN
// ============================================================

function isAdmin(req) {
  const key = req.headers["x-admin-key"];

  return Boolean(
    key &&
    String(key) === String(ADMIN_KEY)
  );
}

function requireAdmin(req, res) {
  if (!isAdmin(req)) {
    safeJson(res, 401, {
      ok: false,
      message: "Unauthorized",
    });

    return false;
  }

  return true;
}


// ============================================================
// ADMIN STATUS
// ============================================================

async function adminStatus() {
  const stats = await getStats();

  let dbOk = false;

  try {
    await pool.query("SELECT 1");
    dbOk = true;
  } catch {
    dbOk = false;
  }

  return {
    ok: true,

    server: {
      status: "ONLINE",
      uptime: now() - serverStartedAt,
    },

    database: {
      status: dbOk ? "ONLINE" : "OFFLINE",
    },

    wingobot: {
      status:
        providerCache.error
          ? "ERROR"
          : providerCache.history.length
            ? "ONLINE"
            : "WAITING",

      currentIssue:
        providerCache.currentIssue,

      latestSettledIssue:
        providerCache.latestSettledIssue,

      fetched:
        providerCache.fetched,

      lastFetchAt:
        providerCache.lastFetchAt,

      error:
        providerCache.error,
    },

    model: {
      version: MODEL_VERSION,
      type: "BIG_SMALL",
      numberPrediction: false,
    },

    stats,
  };
}


// ============================================================
// ADMIN KEYS
// ============================================================

async function listKeys() {
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

async function createKey(customKey) {
  let key =
    customKey &&
    String(customKey).trim()
      ? String(customKey).trim()
      : randomKey(10);

  const result = await pool.query(
    `
    INSERT INTO access_keys
    (
      access_key,
      device_id,
      created_at,
      last_seen
    )
    VALUES
    ($1, NULL, $2, 0)
    RETURNING *
    `,
    [key, now()]
  );

  return result.rows[0];
}


// ============================================================
// HTTP SERVER
// ============================================================

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(
      req.url,
      `http://${req.headers.host || "localhost"}`
    );

    const pathname = url.pathname;

    // --------------------------------------------------------
    // CORS / OPTIONS
    // --------------------------------------------------------

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers":
          "Content-Type, x-admin-key",
        "Access-Control-Allow-Methods":
          "GET, POST, DELETE, OPTIONS",
      });

      res.end();
      return;
    }


    // --------------------------------------------------------
    // HEALTH
    // --------------------------------------------------------

    if (
      pathname === "/health" &&
      req.method === "GET"
    ) {
      safeJson(res, 200, {
        ok: true,
        model: MODEL_VERSION,
        uptime: now() - serverStartedAt,
      });

      return;
    }


    // --------------------------------------------------------
    // ACCESS KEY CHECK
    // --------------------------------------------------------

    if (
      pathname === "/api/key/check" &&
      req.method === "POST"
    ) {
      const body = await parseBody(req);

      const result = await checkAccessKey(
        body.key,
        body.deviceId
      );

      safeJson(res, result.ok ? 200 : 401, result);

      return;
    }


    // --------------------------------------------------------
    // STATE
    // --------------------------------------------------------

    if (
      pathname === "/api/state" &&
      req.method === "GET"
    ) {
      /*
       * Settlement first.
       */
      await settlePredictions(
        providerCache.history
      );

      const current =
        await getCurrentPrediction();

      const stats =
        await getStats();

      safeJson(res, 200, {
        ok: true,

        model: MODEL_VERSION,

        gameUrl: GAME_URL,

        provider: {
          currentIssue:
            providerCache.currentIssue,

          latestSettledIssue:
            providerCache.latestSettledIssue,

          fetched:
            providerCache.fetched,

          lastUpdated:
            providerCache.lastUpdated,

          lastFetchAt:
            providerCache.lastFetchAt,

          error:
            providerCache.error,
        },

        current,

        stats,

        serverTime: now(),
      });

      return;
    }


    // --------------------------------------------------------
    // HISTORY
    // --------------------------------------------------------

    if (
      pathname === "/api/history" &&
      req.method === "GET"
    ) {
      safeJson(res, 200, {
        ok: true,
        history: providerCache.history.slice(0, 100),
      });

      return;
    }


    // --------------------------------------------------------
    // ADMIN STATUS
    // --------------------------------------------------------

    if (
      pathname === "/api/admin/status" &&
      req.method === "GET"
    ) {
      if (!requireAdmin(req, res)) return;

      safeJson(
        res,
        200,
        await adminStatus()
      );

      return;
    }


    // --------------------------------------------------------
    // ADMIN PING
    // --------------------------------------------------------

    if (
      pathname === "/api/admin/ping" &&
      req.method === "GET"
    ) {
      if (!requireAdmin(req, res)) return;

      safeJson(res, 200, {
        ok: true,
        message: "DY AI server online",
        model: MODEL_VERSION,
        time: now(),
      });

      return;
    }


    // --------------------------------------------------------
    // ADMIN WINGOBOT TEST
    // --------------------------------------------------------

    if (
      pathname === "/api/admin/wingo-test" &&
      req.method === "GET"
    ) {
      if (!requireAdmin(req, res)) return;

      try {
        const data =
          await refreshProvider();

        safeJson(res, 200, {
          ok: true,
          currentIssue:
            data.currentIssue,

          latestSettledIssue:
            data.latestSettledIssue,

          fetched:
            data.fetched,

          historyCount:
            data.history.length,

          lastFetchAt:
            data.lastFetchAt,
        });
      } catch (err) {
        safeJson(res, 500, {
          ok: false,
          message: err.message,
        });
      }

      return;
    }


    // --------------------------------------------------------
    // ADMIN MODEL TEST
    // --------------------------------------------------------

    if (
      pathname === "/api/admin/model-test" &&
      req.method === "GET"
    ) {
      if (!requireAdmin(req, res)) return;

      const model =
        createPrediction(
          providerCache.history
        );

      safeJson(res, 200, {
        ok: true,
        modelVersion: MODEL_VERSION,
        prediction: model,
        historyUsed:
          providerCache.history.length,
      });

      return;
    }


    // --------------------------------------------------------
    // ADMIN KEYS GET
    // --------------------------------------------------------

    if (
      pathname === "/api/admin/keys" &&
      req.method === "GET"
    ) {
      if (!requireAdmin(req, res)) return;

      safeJson(res, 200, {
        ok: true,
        keys: await listKeys(),
      });

      return;
    }


    // --------------------------------------------------------
    // ADMIN KEY CREATE
    // --------------------------------------------------------

    if (
      pathname === "/api/admin/keys" &&
      req.method === "POST"
    ) {
      if (!requireAdmin(req, res)) return;

      const body = await parseBody(req);

      try {
        const row =
          await createKey(body.key);

        safeJson(res, 200, {
          ok: true,
          key: row,
        });
      } catch (err) {
        safeJson(res, 400, {
          ok: false,
          message: err.message,
        });
      }

      return;
    }


    // --------------------------------------------------------
    // ADMIN KEY DELETE
    // --------------------------------------------------------

    if (
      pathname.startsWith("/api/admin/keys/") &&
      req.method === "DELETE"
    ) {
      if (!requireAdmin(req, res)) return;

      const id =
        pathname.split("/").pop();

      await pool.query(
        `
        DELETE FROM access_keys
        WHERE id = $1
        `,
        [id]
      );

      safeJson(res, 200, {
        ok: true,
      });

      return;
    }


    // --------------------------------------------------------
    // RESET DEVICE
    // --------------------------------------------------------

    if (
      pathname === "/api/admin/reset-device" &&
      req.method === "POST"
    ) {
      if (!requireAdmin(req, res)) return;

      const body = await parseBody(req);

      if (!body.id) {
        safeJson(res, 400, {
          ok: false,
          message: "Key id required",
        });

        return;
      }

      await pool.query(
        `
        UPDATE access_keys
        SET device_id = NULL,
            last_seen = 0
        WHERE id = $1
        `,
        [body.id]
      );

      safeJson(res, 200, {
        ok: true,
      });

      return;
    }


    // --------------------------------------------------------
    // STATIC FILES
    // --------------------------------------------------------

    let filePath = null;

    if (pathname === "/") {
      filePath =
        path.join(
          __dirname,
          "prediction.html"
        );
    } else {
      filePath =
        path.join(
          __dirname,
          pathname.replace(/^\/+/, "")
        );
    }

    /*
     * Prevent path traversal.
     */
    const root =
      path.resolve(__dirname);

    const resolved =
      path.resolve(filePath);

    if (
      !resolved.startsWith(root)
    ) {
      text(res, 403, "Forbidden");
      return;
    }


    // --------------------------------------------------------
    // MP3 RANGE SUPPORT
    // --------------------------------------------------------

    if (
      pathname.endsWith(".mp3") &&
      fs.existsSync(resolved)
    ) {
      const stat =
        fs.statSync(resolved);

      const range =
        req.headers.range;

      if (!range) {
        res.writeHead(200, {
          "Content-Type": "audio/mpeg",
          "Content-Length": stat.size,
          "Accept-Ranges": "bytes",
        });

        fs.createReadStream(resolved)
          .pipe(res);

        return;
      }

      const match =
        range.match(
          /bytes=(\d*)-(\d*)/
        );

      if (!match) {
        text(res, 416, "Invalid range");
        return;
      }

      const start =
        match[1]
          ? Number(match[1])
          : 0;

      const end =
        match[2]
          ? Number(match[2])
          : stat.size - 1;

      if (
        start >= stat.size ||
        end >= stat.size ||
        start > end
      ) {
        res.writeHead(416, {
          "Content-Range":
            `bytes */${stat.size}`,
        });

        res.end();
        return;
      }

      const chunkSize =
        end - start + 1;

      res.writeHead(206, {
        "Content-Type": "audio/mpeg",
        "Content-Length": chunkSize,
        "Content-Range":
          `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
      });

      fs.createReadStream(
        resolved,
        { start, end }
      ).pipe(res);

      return;
    }


    // --------------------------------------------------------
    // NORMAL STATIC FILE
    // --------------------------------------------------------

    if (
      fs.existsSync(resolved) &&
      fs.statSync(resolved).isFile()
    ) {
      const ext =
        path.extname(resolved)
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
        ".png":
          "image/png",
        ".jpg":
          "image/jpeg",
        ".jpeg":
          "image/jpeg",
        ".svg":
          "image/svg+xml",
        ".ico":
          "image/x-icon",
      };

      res.writeHead(200, {
        "Content-Type":
          types[ext] ||
          "application/octet-stream",
        "Cache-Control":
          "no-cache, no-store, must-revalidate",
      });

      fs.createReadStream(resolved)
        .pipe(res);

      return;
    }

    text(res, 404, "Not Found");

  } catch (err) {
    console.error("SERVER ERROR:", err);

    safeJson(res, 500, {
      ok: false,
      message: err.message,
    });
  }
});


// ============================================================
// BACKGROUND PROVIDER POLLING
// ============================================================

async function providerLoop() {
  try {
    await refreshProvider();

    /*
     * Settle old predictions immediately after fresh history.
     */
    await settlePredictions(
      providerCache.history
    );

  } catch (err) {
    console.error(
      "WingoBot update:",
      err.message
    );
  }
}


// ============================================================
// START
// ============================================================

(async () => {
  try {
    await initDB();

    console.log(
      `Database ready - ${MODEL_VERSION}`
    );

    await providerLoop();

    setInterval(
      providerLoop,
      3000
    );

    server.listen(
      PORT,
      "0.0.0.0",
      () => {
        console.log(
          `DY AI server running on port ${PORT}`
        );

        console.log(
          `Model: ${MODEL_VERSION}`
        );

        console.log(
          `Game: ${GAME_URL}`
        );
      }
    );

  } catch (err) {
    console.error(
      "STARTUP ERROR:",
      err
    );

    process.exit(1);
  }
})();
