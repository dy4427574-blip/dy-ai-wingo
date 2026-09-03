const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = process.env.PORT || 10000;

const ADMIN_KEY =
  process.env.ADMIN_KEY || "dy4427574";

const WINGOBOT_TOKEN =
  process.env.WINGOBOT_TOKEN || "";

const MODEL_VERSION =
  "DY-AI-BS-V3";

const GAME_URL =
  "https://www.shreewin38.com/#/register?invitationCode=88523152383";

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL,

  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});

let provider = {
  currentIssue: null,
  latestSettledIssue: null,
  history: [],
  fetched: 0,
  lastUpdated: 0,
  lastFetchAt: 0,
  error: null
};

const startedAt = Date.now();


// ============================================================
// HELPERS
// ============================================================

function now() {
  return Date.now();
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);

  res.writeHead(status, {
    "Content-Type":
      "application/json; charset=utf-8",
    "Cache-Control":
      "no-store, no-cache, must-revalidate",
    "Access-Control-Allow-Origin": "*"
  });

  res.end(body);
}

function sendText(
  res,
  status,
  body,
  type = "text/plain; charset=utf-8"
) {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store"
  });

  res.end(body);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk.toString();

      if (body.length > 1024 * 1024) {
        reject(
          new Error("Request body too large")
        );

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
        reject(
          new Error("Invalid JSON")
        );
      }
    });

    req.on("error", reject);
  });
}

function issueNumber(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  const s = String(value).trim();

  return /^\d+$/.test(s)
    ? s
    : null;
}

function issueBigInt(value) {
  try {
    return BigInt(String(value));
  } catch {
    return null;
  }
}

function compareIssue(a, b) {
  const aa = issueBigInt(a);
  const bb = issueBigInt(b);

  if (aa === null || bb === null) {
    return String(a || "")
      .localeCompare(
        String(b || "")
      );
  }

  if (aa > bb) return 1;
  if (aa < bb) return -1;

  return 0;
}

function nextIssue(issue) {
  const n = issueBigInt(issue);

  if (n === null) return null;

  return String(n + 1n);
}

function normalizeSide(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  const s =
    String(value)
      .trim()
      .toUpperCase();

  if (s === "BIG") return "BIG";
  if (s === "SMALL") return "SMALL";

  return null;
}

function normalizeNumber(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const n = Number(value);

  if (!Number.isInteger(n)) {
    return null;
  }

  if (n < 0 || n > 9) {
    return null;
  }

  return n;
}

function numberToSide(number) {
  const n =
    normalizeNumber(number);

  if (n === null) return null;

  return n >= 5
    ? "BIG"
    : "SMALL";
}

function randomKey(length = 10) {
  return crypto
    .randomBytes(length)
    .toString("hex")
    .toUpperCase();
}


// ============================================================
// DATABASE
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
      target_issue TEXT NOT NULL,
      prediction TEXT NOT NULL,
      confidence INTEGER DEFAULT 0,
      model_version TEXT,
      created_at BIGINT NOT NULL,
      actual_number INTEGER,
      actual_result TEXT,
      settled_at BIGINT
    )
  `);

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
    UPDATE prediction_records
    SET model_version = 'LEGACY'
    WHERE model_version IS NULL
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS
    prediction_model_issue_unique
    ON prediction_records(
      model_version,
      target_issue
    )
  `);
}


// ============================================================
// WINGOBOT
// ============================================================

async function fetchWingoBot() {

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
      10000
    );

  try {

    const response =
      await fetch(
        "https://api.wingobot.com/v2/30-sec-game-history",
        {
          method: "GET",

          headers: {
            Authorization:
              `Bearer ${WINGOBOT_TOKEN}`,

            Accept:
              "application/json"
          },

          signal:
            controller.signal
        }
      );

    if (!response.ok) {
      throw new Error(
        `WingoBot HTTP ${response.status}`
      );
    }

    return await response.json();

  } finally {

    clearTimeout(timeout);
  }
}


// ============================================================
// NORMALIZE HISTORY
// ============================================================

function normalizeHistory(raw) {

  const rows =
    Array.isArray(raw?.history)
      ? raw.history
      : Array.isArray(raw?.data)
        ? raw.data
        : Array.isArray(raw)
          ? raw
          : [];

  const map = new Map();

  for (const row of rows) {

    if (!row) continue;

    const issue =
      issueNumber(
        row.issueNumber ??
        row.issue ??
        row.period ??
        row.periodNumber
      );

    if (!issue) continue;

    const number =
      normalizeNumber(
        row.number ??
        row.num ??
        row.openNumber
      );

    const explicitSide =
      normalizeSide(
        row.side ??
        row.bigSmall ??
        row.resultType
      );

    const side =
      explicitSide ||
      numberToSide(number);

    /*
     * No valid side = not settled.
     */
    if (!side) continue;

    /*
     * Keep one record per period.
     */
    if (!map.has(issue)) {

      map.set(issue, {
        issueNumber: issue,
        number,
        side,
        colour:
          row.colour ??
          row.color ??
          null,
        premium:
          row.premium ??
          null,
        sum:
          row.sum ??
          null
      });
    }
  }

  return Array.from(map.values())
    .sort(
      (a, b) =>
        compareIssue(
          b.issueNumber,
          a.issueNumber
        )
    );
}


// ============================================================
// PROVIDER REFRESH
// ============================================================

async function refreshProvider() {

  try {

    const raw =
      await fetchWingoBot();

    const history =
      normalizeHistory(raw);

    const current =
      issueNumber(
        raw?.current?.issueNumber ??
        raw?.current?.issue ??
        raw?.current?.period
      );

    const latest =
      history.length
        ? history[0].issueNumber
        : null;

    provider = {
      currentIssue:
        current,

      latestSettledIssue:
        latest,

      history,

      fetched:
        Number(
          raw?.stats?.fetched ??
          history.length
        ),

      lastUpdated:
        Number(
          raw?.stats?.last_updated ??
          now()
        ),

      lastFetchAt:
        now(),

      error:
        null
    };

    return provider;

  } catch (error) {

    provider = {
      ...provider,
      error:
        error.message,
      lastFetchAt:
        now()
    };

    throw error;
  }
}


// ============================================================
// TARGET
// ============================================================

function getTargetIssue() {

  const latest =
    provider.latestSettledIssue;

  const current =
    provider.currentIssue;

  if (!latest && current) {
    return current;
  }

  if (!latest) {
    return null;
  }

  /*
   * Provider current is ahead:
   * current = target.
   */
  if (
    current &&
    compareIssue(
      current,
      latest
    ) > 0
  ) {
    return current;
  }

  /*
   * Current is same/behind:
   * next period is target.
   */
  return nextIssue(latest);
}


// ============================================================
// MODEL HELPERS
// ============================================================

function getSides(limit = 100) {
  return provider.history
    .slice(0, limit)
    .map(x => x.side)
    .filter(Boolean);
}

function sideScore(sides) {

  if (!sides.length) return 0;

  let big = 0;
  let small = 0;

  for (const side of sides) {

    if (side === "BIG") big++;
    if (side === "SMALL") small++;
  }

  return (
    (big - small) /
    sides.length
  );
}

function weightedScore(
  sides,
  decay = 0.78
) {

  if (!sides.length) return 0;

  let big = 0;
  let small = 0;
  let weight = 1;

  for (const side of sides) {

    if (side === "BIG") {
      big += weight;
    }

    if (side === "SMALL") {
      small += weight;
    }

    weight *= decay;
  }

  const total =
    big + small;

  if (!total) return 0;

  return (
    (big - small) /
    total
  );
}

function getStreak(sides) {

  if (!sides.length) {
    return {
      side: null,
      length: 0
    };
  }

  const side =
    sides[0];

  let length = 0;

  for (const value of sides) {

    if (value !== side) {
      break;
    }

    length++;
  }

  return {
    side,
    length
  };
}


// ============================================================
// SHORT SIGNAL
// ============================================================

function shortSignal(sides) {

  const recent =
    sides.slice(0, 5);

  const score =
    weightedScore(
      recent,
      0.70
    );

  return {
    score,
    strength:
      Math.min(
        1,
        Math.abs(score)
      )
  };
}


// ============================================================
// MEDIUM SIGNAL
// ============================================================

function mediumSignal(sides) {

  const recent =
    sides.slice(0, 15);

  const score =
    sideScore(recent);

  return {
    score,
    strength:
      Math.min(
        1,
        Math.abs(score) * 1.4
      )
  };
}


// ============================================================
// TRANSITION SIGNAL
// ============================================================

function transitionSignal(sides) {

  const counts = {
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
      counts[previous]
    ) {

      counts[previous][next]++;
    }
  }

  const current =
    sides[0];

  if (!current) {
    return {
      score: 0,
      sample: 0
    };
  }

  const total =
    counts[current].BIG +
    counts[current].SMALL;

  if (!total) {
    return {
      score: 0,
      sample: 0
    };
  }

  const big =
    counts[current].BIG /
    total;

  const small =
    counts[current].SMALL /
    total;

  return {
    score:
      big - small,

    sample:
      total
  };
}


// ============================================================
// RUN ANALYSIS
// ============================================================

function runHistory(sides) {

  const runs = [];

  if (!sides.length) {
    return runs;
  }

  let side =
    sides[0];

  let length = 1;

  for (
    let i = 1;
    i < sides.length;
    i++
  ) {

    if (sides[i] === side) {

      length++;

    } else {

      runs.push({
        side,
        length
      });

      side =
        sides[i];

      length = 1;
    }
  }

  runs.push({
    side,
    length
  });

  return runs;
}


// ============================================================
// TREND BREAK
// ============================================================

function breakSignal(sides) {

  if (sides.length < 8) {

    return {
      score: 0,
      strength: 0,
      reason:
        "NOT_ENOUGH_DATA"
    };
  }

  const streak =
    getStreak(sides);

  const recent =
    sides.slice(0, 5);

  const previous =
    sides.slice(5, 15);

  const recentScore =
    sideScore(recent);

  const previousScore =
    sideScore(previous);

  const shift =
    recentScore -
    previousScore;

  let changes = 0;

  for (
    let i = 1;
    i < recent.length;
    i++
  ) {

    if (
      recent[i] !==
      recent[i - 1]
    ) {
      changes++;
    }
  }

  const instability =
    recent.length > 1
      ? changes /
        (recent.length - 1)
      : 0;

  let score = 0;

  /*
   * Streak pressure is deliberately small.
   * A streak alone cannot force reversal.
   */
  if (streak.length >= 4) {

    const pressure =
      Math.min(
        0.20,
        (streak.length - 3) *
        0.05
      );

    if (
      streak.side === "BIG"
    ) {
      score -= pressure;
    } else {
      score += pressure;
    }
  }

  /*
   * Strong regime shift.
   */
  if (
    Math.abs(shift) >= 0.50
  ) {

    score +=
      shift > 0
        ? 0.22
        : -0.22;
  }

  /*
   * Instability itself does not choose
   * a side. It reduces confidence later.
   */
  return {
    score,

    strength:
      Math.min(
        1,
        Math.abs(score) * 3
      ),

    instability,

    reason:
      Math.abs(shift) >= 0.50
        ? "REGIME_SHIFT"
        : instability >= 0.75
          ? "HIGH_INSTABILITY"
          : "NORMAL"
  };
}


// ============================================================
// HISTORICAL PATTERN
// ============================================================

function historicalSignal(sides) {

  const size = 5;

  if (sides.length < 18) {

    return {
      score: 0,
      confidence: 0,
      matches: 0
    };
  }

  const current =
    sides
      .slice(0, size)
      .join(",");

  let big = 0;
  let small = 0;
  let matches = 0;

  for (
    let i = size + 1;
    i < sides.length - 1;
    i++
  ) {

    const pattern =
      sides
        .slice(i, i + size)
        .join(",");

    if (
      pattern !== current
    ) {
      continue;
    }

    const next =
      sides[i - 1];

    if (next === "BIG") {
      big++;
    }

    if (next === "SMALL") {
      small++;
    }

    matches++;
  }

  if (!matches) {

    return {
      score: 0,
      confidence: 0,
      matches: 0
    };
  }

  return {
    score:
      (big - small) /
      matches,

    confidence:
      Math.min(
        1,
        matches / 6
      ),

    matches
  };
}


// ============================================================
// REGIME
// ============================================================

function classifyRegime(
  sides,
  short,
  medium,
  transition,
  breaker,
  streak
) {

  if (
    breaker.reason ===
    "HIGH_INSTABILITY"
  ) {
    return "CONFLICT";
  }

  const shortSide =
    short.score > 0.18
      ? "BIG"
      : short.score < -0.18
        ? "SMALL"
        : null;

  const mediumSide =
    medium.score > 0.12
      ? "BIG"
      : medium.score < -0.12
        ? "SMALL"
        : null;

  const transitionSide =
    transition.score > 0.15
      ? "BIG"
      : transition.score < -0.15
        ? "SMALL"
        : null;

  /*
   * Break evidence against current short direction.
   */
  if (
    breaker.score > 0.12 &&
    shortSide === "SMALL"
  ) {
    return "POSSIBLE_BREAK";
  }

  if (
    breaker.score < -0.12 &&
    shortSide === "BIG"
  ) {
    return "POSSIBLE_BREAK";
  }

  if (
    shortSide &&
    mediumSide &&
    shortSide !== mediumSide
  ) {
    return "CONFLICT";
  }

  if (
    shortSide &&
    transitionSide &&
    shortSide !== transitionSide
  ) {
    return "TREND_WEAKENING";
  }

  if (
    streak.length <= 2 &&
    shortSide
  ) {
    return "NEW_TREND";
  }

  if (
    streak.length >= 3 &&
    shortSide &&
    mediumSide &&
    shortSide === mediumSide
  ) {
    return "TREND_CONTINUING";
  }

  return "NEUTRAL";
}


// ============================================================
// AI V3
// ============================================================

function createPrediction() {

  const sides =
    getSides(100);

  if (sides.length < 5) {

    return {
      prediction: null,
      confidence: 0,
      regime:
        "INSUFFICIENT_DATA",
      reason:
        "WAITING_FOR_HISTORY",
      diagnostics: {}
    };
  }

  const short =
    shortSignal(sides);

  const medium =
    mediumSignal(sides);

  const transition =
    transitionSignal(sides);

  const breaker =
    breakSignal(sides);

  const historical =
    historicalSignal(sides);

  const streak =
    getStreak(sides);

  /*
   * Base score.
   *
   * Recent > medium > transition.
   * Break and historical are supporting signals.
   */
  let score =
    short.score * 0.40 +
    medium.score * 0.22 +
    transition.score *
      Math.min(
        1,
        transition.sample / 10
      ) *
      0.18 +
    breaker.score * 0.14 +
    historical.score *
      historical.confidence *
      0.06;


  /*
   * Anti-blind trend.
   */
  if (
    streak.length >= 4
  ) {

    if (
      streak.side === "BIG"
    ) {
      score -= 0.035;
    } else {
      score += 0.035;
    }

    /*
     * If all major signals still agree,
     * continuation is allowed.
     */
    const continuation =
      streak.side === "BIG"
        ? (
            short.score > 0.20 &&
            medium.score > 0.10 &&
            transition.score > 0.10
          )
        : (
            short.score < -0.20 &&
            medium.score < -0.10 &&
            transition.score < -0.10
          );

    if (continuation) {

      score +=
        streak.side === "BIG"
          ? 0.055
          : -0.055;
    }
  }


  const regime =
    classifyRegime(
      sides,
      short,
      medium,
      transition,
      breaker,
      streak
    );


  /*
   * Conflict control.
   */
  if (
    regime === "CONFLICT"
  ) {
    score *= 0.78;
  }

  if (
    regime === "POSSIBLE_BREAK"
  ) {
    score *= 0.90;
  }

  if (
    regime === "TREND_WEAKENING"
  ) {
    score *= 0.90;
  }


  const prediction =
    score >= 0
      ? "BIG"
      : "SMALL";


  /*
   * Agreement.
   */
  const votes = [];

  if (short.score > 0.15) {
    votes.push("BIG");
  } else if (
    short.score < -0.15
  ) {
    votes.push("SMALL");
  }

  if (medium.score > 0.12) {
    votes.push("BIG");
  } else if (
    medium.score < -0.12
  ) {
    votes.push("SMALL");
  }

  if (
    transition.score > 0.15
  ) {
    votes.push("BIG");
  } else if (
    transition.score < -0.15
  ) {
    votes.push("SMALL");
  }

  if (
    breaker.score > 0.12
  ) {
    votes.push("BIG");
  } else if (
    breaker.score < -0.12
  ) {
    votes.push("SMALL");
  }


  const agreement =
    votes.length
      ? votes.filter(
          x =>
            x === prediction
        ).length /
        votes.length
      : 0;


  /*
   * Confidence.
   */
  let confidence =
    48 +
    Math.abs(score) * 38 +
    agreement * 8;

  if (
    regime === "CONFLICT"
  ) {
    confidence -= 10;
  }

  if (
    regime === "POSSIBLE_BREAK"
  ) {
    confidence -= 5;
  }

  if (
    regime === "TREND_WEAKENING"
  ) {
    confidence -= 4;
  }

  if (
    breaker.instability >= 0.75
  ) {
    confidence -= 6;
  }

  confidence =
    Math.round(
      Math.max(
        45,
        Math.min(
          86,
          confidence
        )
      )
    );


  let reason =
    "BALANCED_SIGNAL";

  if (
    regime ===
    "TREND_CONTINUING"
  ) {
    reason =
      "TREND_CONTINUATION";
  }

  if (
    regime === "NEW_TREND"
  ) {
    reason =
      "NEW_TREND";
  }

  if (
    regime ===
    "TREND_WEAKENING"
  ) {
    reason =
      "TREND_WEAKENING";
  }

  if (
    regime ===
    "POSSIBLE_BREAK"
  ) {
    reason =
      "POSSIBLE_TREND_BREAK";
  }

  if (
    regime === "CONFLICT"
  ) {
    reason =
      "MIXED_SIGNAL";
  }


  return {

    prediction,

    confidence,

    regime,

    reason,

    diagnostics: {

      score:
        Number(
          score.toFixed(4)
        ),

      short:
        Number(
          short.score.toFixed(4)
        ),

      medium:
        Number(
          medium.score.toFixed(4)
        ),

      transition:
        Number(
          transition.score.toFixed(4)
        ),

      break:
        Number(
          breaker.score.toFixed(4)
        ),

      historical:
        Number(
          historical.score.toFixed(4)
        ),

      streakSide:
        streak.side,

      streakLength:
        streak.length,

      transitionSample:
        transition.sample,

      historicalMatches:
        historical.matches,

      agreement:
        Number(
          agreement.toFixed(2)
        ),

      historyUsed:
        sides.length
    }
  };
}


// ============================================================
// PREDICTION RECORD
// ============================================================

async function getPrediction(
  target
) {

  const result =
    await pool.query(
      `
      SELECT *
      FROM prediction_records
      WHERE model_version = $1
        AND target_issue = $2
      LIMIT 1
      `,
      [
        MODEL_VERSION,
        String(target)
      ]
    );

  return (
    result.rows[0] ||
    null
  );
}

async function createRecord(
  target
) {

  const existing =
    await getPrediction(
      target
    );

  if (existing) {
    return existing;
  }

  const model =
    createPrediction();

  if (!model.prediction) {
    return null;
  }

  const result =
    await pool.query(
      `
      INSERT INTO prediction_records
      (
        target_issue,
        prediction,
        confidence,
        model_version,
        created_at,
        actual_number,
        actual_result,
        settled_at
      )
      VALUES
      (
        $1,$2,$3,$4,$5,
        NULL,NULL,NULL
      )
      ON CONFLICT
      (
        model_version,
        target_issue
      )
      DO NOTHING
      RETURNING *
      `,
      [
        String(target),
        model.prediction,
        model.confidence,
        MODEL_VERSION,
        now()
      ]
    );

  return (
    result.rows[0] ||
    await getPrediction(target)
  );
}


// ============================================================
// EXACT SETTLEMENT
// ============================================================

async function settlePredictions() {

  const pending =
    await pool.query(
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

  const actualMap =
    new Map();

  for (
    const row of provider.history
  ) {

    if (
      !row.issueNumber ||
      !row.side
    ) {
      continue;
    }

    actualMap.set(
      String(
        row.issueNumber
      ),
      row
    );
  }

  for (
    const prediction
    of pending.rows
  ) {

    /*
     * EXACT PERIOD ONLY.
     */
    const actual =
      actualMap.get(
        String(
          prediction.target_issue
        )
      );

    if (!actual) {
      continue;
    }

    const result =
      prediction.prediction ===
      actual.side
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
        AND model_version = $5
        AND actual_result IS NULL
      `,
      [
        actual.number,
        result,
        now(),
        prediction.id,
        MODEL_VERSION
      ]
    );
  }
}


// ============================================================
// CURRENT
// ============================================================

async function currentPrediction() {

  const target =
    getTargetIssue();

  if (!target) {

    return {
      targetIssue: null,
      prediction: null,
      confidence: 0,
      status: "WAITING",
      regime: "WAITING",
      reason: "WAITING"
    };
  }

  let record =
    await getPrediction(
      target
    );

  if (!record) {

    record =
      await createRecord(
        target
      );
  }

  if (!record) {

    return {
      targetIssue: target,
      prediction: null,
      confidence: 0,
      status: "WAITING",
      regime:
        "INSUFFICIENT_DATA",
      reason:
        "WAITING_FOR_HISTORY"
    };
  }

  const diagnostics =
    createPrediction();

  return {

    targetIssue:
      String(target),

    prediction:
      record.prediction,

    confidence:
      Number(
        record.confidence || 0
      ),

    status:
      record.actual_result ||
      "PENDING",

    regime:
      diagnostics.regime,

    reason:
      diagnostics.reason,

    diagnostics:
      diagnostics.diagnostics
  };
}


// ============================================================
// LAST 30
// ============================================================

async function last30() {

  const result =
    await pool.query(
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

  const actualMap =
    new Map();

  for (
    const row of provider.history
  ) {

    if (
      row.issueNumber &&
      row.side
    ) {

      actualMap.set(
        String(
          row.issueNumber
        ),
        row
      );
    }
  }

  return result.rows.map(
    row => {

      const actual =
        actualMap.get(
          String(
            row.target_issue
          )
        );

      /*
       * No exact actual =
       * PENDING.
       */
      const wl =
        actual
          ? (
              row.prediction ===
              actual.side
                ? "WIN"
                : "LOSS"
            )
          : "PENDING";

      return {

        period:
          String(
            row.target_issue
          ),

        result:
          actual
            ? actual.side
            : null,

        predict:
          row.prediction,

        confidence:
          Number(
            row.confidence || 0
          ),

        wl,

        createdAt:
          row.created_at,

        settledAt:
          actual
            ? (
                row.settled_at ||
                null
              )
            : null
      };
    }
  );
}


// ============================================================
// STATS
// ============================================================

async function stats() {

  const result =
    await pool.query(
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

  const row =
    result.rows[0];

  const wins =
    Number(row.wins || 0);

  const losses =
    Number(row.losses || 0);

  const pending =
    Number(row.pending || 0);

  const settled =
    wins + losses;

  const accuracy =
    settled
      ? Number(
          (
            wins /
            settled *
            100
          ).toFixed(2)
        )
      : 0;

  return {
    wins,
    losses,
    pending,
    settled,
    accuracy
  };
}


// ============================================================
// ACCESS KEYS
// ============================================================

async function checkKey(
  key,
  deviceId
) {

  if (!key || !deviceId) {

    return {
      ok: false,
      message:
        "Access key and device required"
    };
  }

  const result =
    await pool.query(
      `
      SELECT *
      FROM access_keys
      WHERE access_key = $1
      LIMIT 1
      `,
      [
        String(key).trim()
      ]
    );

  if (!result.rows.length) {

    return {
      ok: false,
      message:
        "Invalid access key"
    };
  }

  const row =
    result.rows[0];

  if (
    row.device_id &&
    row.device_id !== deviceId
  ) {

    return {
      ok: false,
      message:
        "Key already linked to another device"
    };
  }

  await pool.query(
    `
    UPDATE access_keys
    SET
      device_id = COALESCE(
        device_id,
        $1
      ),
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
    message: "Access granted"
  };
}


// ============================================================
// ADMIN
// ============================================================

function adminOK(req) {

  return String(
    req.headers["x-admin-key"] ||
    ""
  ) === String(
    ADMIN_KEY
  );
}

async function keysList() {

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

  return result.rows;
}

async function createAccessKey(
  custom
) {

  const key =
    custom &&
    String(custom).trim()
      ? String(custom).trim()
      : randomKey();

  const result =
    await pool.query(
      `
      INSERT INTO access_keys
      (
        access_key,
        device_id,
        created_at,
        last_seen
      )
      VALUES
      ($1,NULL,$2,0)
      RETURNING *
      `,
      [
        key,
        now()
      ]
    );

  return result.rows[0];
}

async function adminStatus() {

  let dbOnline = false;

  try {

    await pool.query(
      "SELECT 1"
    );

    dbOnline = true;

  } catch {}

  const s =
    await stats();

  return {

    ok: true,

    server: {
      status: "ONLINE",
      uptime:
        now() -
        startedAt
    },

    database: {
      status:
        dbOnline
          ? "ONLINE"
          : "OFFLINE"
    },

    wingobot: {

      status:
        provider.error
          ? "ERROR"
          : provider.history.length
            ? "ONLINE"
            : "WAITING",

      currentIssue:
        provider.currentIssue,

      latestSettledIssue:
        provider.latestSettledIssue,

      fetched:
        provider.fetched,

      lastFetchAt:
        provider.lastFetchAt,

      error:
        provider.error
    },

    model: {

      version:
        MODEL_VERSION,

      type:
        "BIG_SMALL",

      numberPrediction:
        false
    },

    stats: s
  };
}


// ============================================================
// SERVER
// ============================================================

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


        // ----------------------------------------------------
        // OPTIONS
        // ----------------------------------------------------

        if (
          req.method === "OPTIONS"
        ) {

          res.writeHead(
            204,
            {
              "Access-Control-Allow-Origin":
                "*",

              "Access-Control-Allow-Headers":
                "Content-Type, x-admin-key",

              "Access-Control-Allow-Methods":
                "GET, POST, DELETE, OPTIONS"
            }
          );

          res.end();

          return;
        }


        // ----------------------------------------------------
        // HEALTH
        // ----------------------------------------------------

        if (
          pathname === "/health" &&
          req.method === "GET"
        ) {

          sendJSON(
            res,
            200,
            {
              ok: true,
              model:
                MODEL_VERSION,
              uptime:
                now() -
                startedAt
            }
          );

          return;
        }


        // ----------------------------------------------------
        // KEY CHECK
        // ----------------------------------------------------

        if (
          pathname ===
            "/api/key/check" &&
          req.method === "POST"
        ) {

          const body =
            await parseBody(req);

          const result =
            await checkKey(
              body.key,
              body.deviceId
            );

          sendJSON(
            res,
            result.ok
              ? 200
              : 401,
            result
          );

          return;
        }


        // ----------------------------------------------------
        // STATE
        // ----------------------------------------------------

        if (
          pathname === "/api/state" &&
          req.method === "GET"
        ) {

          await settlePredictions();

          const current =
            await currentPrediction();

          const s =
            await stats();

          const history =
            await last30();

          sendJSON(
            res,
            200,
            {

              ok: true,

              model:
                MODEL_VERSION,

              gameUrl:
                GAME_URL,

              provider: {

                currentIssue:
                  provider.currentIssue,

                latestSettledIssue:
                  provider.latestSettledIssue,

                fetched:
                  provider.fetched,

                lastUpdated:
                  provider.lastUpdated,

                lastFetchAt:
                  provider.lastFetchAt,

                error:
                  provider.error
              },

              current,

              stats: s,

              last30:
                history,

              serverTime:
                now()
            }
          );

          return;
        }


        // ----------------------------------------------------
        // PROVIDER HISTORY
        // ----------------------------------------------------

        if (
          pathname ===
            "/api/history" &&
          req.method === "GET"
        ) {

          sendJSON(
            res,
            200,
            {
              ok: true,

              history:
                provider.history
                  .slice(0, 100)
            }
          );

          return;
        }


        // ----------------------------------------------------
        // ADMIN STATUS
        // ----------------------------------------------------

        if (
          pathname ===
            "/api/admin/status" &&
          req.method === "GET"
        ) {

          if (!adminOK(req)) {

            sendJSON(
              res,
              401,
              {
                ok: false,
                message:
                  "Unauthorized"
              }
            );

            return;
          }

          sendJSON(
            res,
            200,
            await adminStatus()
          );

          return;
        }


        // ----------------------------------------------------
        // ADMIN PING
        // ----------------------------------------------------

        if (
          pathname ===
            "/api/admin/ping" &&
          req.method === "GET"
        ) {

          if (!adminOK(req)) {

            sendJSON(
              res,
              401,
              {
                ok: false
              }
            );

            return;
          }

          sendJSON(
            res,
            200,
            {
              ok: true,
              model:
                MODEL_VERSION,
              time:
                now()
            }
          );

          return;
        }


        // ----------------------------------------------------
        // ADMIN WINGOBOT TEST
        // ----------------------------------------------------

        if (
          pathname ===
            "/api/admin/wingo-test" &&
          req.method === "GET"
        ) {

          if (!adminOK(req)) {

            sendJSON(
              res,
              401,
              {
                ok: false
              }
            );

            return;
          }

          try {

            const p =
              await refreshProvider();

            sendJSON(
              res,
              200,
              {
                ok: true,

                currentIssue:
                  p.currentIssue,

                latestSettledIssue:
                  p.latestSettledIssue,

                fetched:
                  p.fetched,

                historyCount:
                  p.history.length
              }
            );

          } catch (error) {

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

          return;
        }


        // ----------------------------------------------------
        // ADMIN MODEL TEST
        // ----------------------------------------------------

        if (
          pathname ===
            "/api/admin/model-test" &&
          req.method === "GET"
        ) {

          if (!adminOK(req)) {

            sendJSON(
              res,
              401,
              {
                ok: false
              }
            );

            return;
          }

          sendJSON(
            res,
            200,
            {
              ok: true,

              modelVersion:
                MODEL_VERSION,

              model:
                createPrediction(),

              historyUsed:
                provider.history.length
            }
          );

          return;
        }


        // ----------------------------------------------------
        // ADMIN KEYS GET
        // ----------------------------------------------------

        if (
          pathname ===
            "/api/admin/keys" &&
          req.method === "GET"
        ) {

          if (!adminOK(req)) {

            sendJSON(
              res,
              401,
              {
                ok: false
              }
            );

            return;
          }

          sendJSON(
            res,
            200,
            {
              ok: true,
              keys:
                await keysList()
            }
          );

          return;
        }


        // ----------------------------------------------------
        // ADMIN KEY CREATE
        // ----------------------------------------------------

        if (
          pathname ===
            "/api/admin/keys" &&
          req.method === "POST"
        ) {

          if (!adminOK(req)) {

            sendJSON(
              res,
              401,
              {
                ok: false
              }
            );

            return;
          }

          const body =
            await parseBody(req);

          try {

            const row =
              await createAccessKey(
                body.key
              );

            sendJSON(
              res,
              200,
              {
                ok: true,
                key: row
              }
            );

          } catch (error) {

            sendJSON(
              res,
              400,
              {
                ok: false,
                message:
                  error.message
              }
            );
          }

          return;
        }


        // ----------------------------------------------------
        // ADMIN KEY DELETE
        // ----------------------------------------------------

        if (
          pathname.startsWith(
            "/api/admin/keys/"
          ) &&
          req.method === "DELETE"
        ) {

          if (!adminOK(req)) {

            sendJSON(
              res,
              401,
              {
                ok: false
              }
            );

            return;
          }

          const id =
            pathname
              .split("/")
              .pop();

          await pool.query(
            `
            DELETE FROM access_keys
            WHERE id = $1
            `,
            [id]
          );

          sendJSON(
            res,
            200,
            {
              ok: true
            }
          );

          return;
        }


        // ----------------------------------------------------
        // RESET DEVICE
        // ----------------------------------------------------

        if (
          pathname ===
            "/api/admin/reset-device" &&
          req.method === "POST"
        ) {

          if (!adminOK(req)) {

            sendJSON(
              res,
              401,
              {
                ok: false
              }
            );

            return;
          }

          const body =
            await parseBody(req);

          await pool.query(
            `
            UPDATE access_keys
            SET
              device_id = NULL,
              last_seen = 0
            WHERE id = $1
            `,
            [body.id]
          );

          sendJSON(
            res,
            200,
            {
              ok: true
            }
          );

          return;
        }


        // ----------------------------------------------------
        // STATIC FILE
        // ----------------------------------------------------

        let file;

        if (
          pathname === "/"
        ) {

          file =
            path.join(
              __dirname,
              "prediction.html"
            );

        } else {

          file =
            path.join(
              __dirname,
              pathname.replace(
                /^\/+/,
                ""
              )
            );
        }

        const root =
          path.resolve(
            __dirname
          );

        const resolved =
          path.resolve(file);

        if (
          !resolved.startsWith(
            root
          )
        ) {

          sendText(
            res,
            403,
            "Forbidden"
          );

          return;
        }


        // ----------------------------------------------------
        // MP3 RANGE
        // ----------------------------------------------------

        if (
          pathname.endsWith(
            ".mp3"
          ) &&
          fs.existsSync(
            resolved
          )
        ) {

          const stat =
            fs.statSync(
              resolved
            );

          const range =
            req.headers.range;

          if (!range) {

            res.writeHead(
              200,
              {
                "Content-Type":
                  "audio/mpeg",

                "Content-Length":
                  stat.size,

                "Accept-Ranges":
                  "bytes"
              }
            );

            fs.createReadStream(
              resolved
            ).pipe(res);

            return;
          }

          const match =
            range.match(
              /bytes=(\d*)-(\d*)/
            );

          if (!match) {

            sendText(
              res,
              416,
              "Invalid range"
            );

            return;
          }

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
              : stat.size - 1;

          if (
            start >= stat.size ||
            end >= stat.size ||
            start > end
          ) {

            res.writeHead(
              416,
              {
                "Content-Range":
                  `bytes */${stat.size}`
              }
            );

            res.end();

            return;
          }

          const length =
            end - start + 1;

          res.writeHead(
            206,
            {
              "Content-Type":
                "audio/mpeg",

              "Content-Length":
                length,

              "Content-Range":
                `bytes ${start}-${end}/${stat.size}`,

              "Accept-Ranges":
                "bytes"
            }
          );

          fs.createReadStream(
            resolved,
            {
              start,
              end
            }
          ).pipe(res);

          return;
        }


        // ----------------------------------------------------
        // NORMAL STATIC
        // ----------------------------------------------------

        if (
          fs.existsSync(
            resolved
          ) &&
          fs.statSync(
            resolved
          ).isFile()
        ) {

          const ext =
            path.extname(
              resolved
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

            ".ico":
              "image/x-icon"
          };

          res.writeHead(
            200,
            {
              "Content-Type":
                types[ext] ||
                "application/octet-stream",

              "Cache-Control":
                "no-cache, no-store, must-revalidate"
            }
          );

          fs.createReadStream(
            resolved
          ).pipe(res);

          return;
        }


        sendText(
          res,
          404,
          "Not Found"
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


// ============================================================
// BACKGROUND POLLING
// ============================================================

async function providerLoop() {

  try {

    await refreshProvider();

    await settlePredictions();

  } catch (error) {

    console.error(
      "WingoBot:",
      error.message
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
      `Database ready: ${MODEL_VERSION}`
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
          `DY AI running on ${PORT}`
        );

        console.log(
          `Model: ${MODEL_VERSION}`
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

})();
