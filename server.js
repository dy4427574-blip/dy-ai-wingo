"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const { Pool } = require("pg");

// ============================================================
// DY AI WINGO 30S - V4
// BIG / SMALL ONLY
// ============================================================

const PORT = Number(process.env.PORT || 10000);

const DATABASE_URL =
  process.env.DATABASE_URL || "";

const ADMIN_KEY =
  process.env.ADMIN_KEY || "dy4427574";

const WINGOBOT_TOKEN =
  process.env.WINGOBOT_TOKEN || "";

const WINGOBOT_URL =
  "https://api.wingobot.com/v2/30-sec-game-history";

const GAME_URL =
  "https://www.shreewin38.com/#/register?invitationCode=88523152383";

const MODEL_VERSION =
  "DY-AI-BS-V4";

const PROVIDER_POLL_MS = 3000;

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
// PROVIDER STATE
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


// ============================================================
// HELPERS
// ============================================================

function now() {
  return Date.now();
}

function safeString(v) {
  if (v === null || v === undefined) {
    return "";
  }

  return String(v);
}

function cleanIssue(v) {
  const s = safeString(v).trim();

  return s || null;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function sideFromNumber(number) {
  const n = Number(number);

  if (!Number.isInteger(n)) {
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

function normalizeSide(value, number) {
  const s =
    safeString(value)
      .trim()
      .toUpperCase();

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

function opposite(side) {
  return side === "BIG"
    ? "SMALL"
    : "BIG";
}

function incrementIssue(issue) {
  if (!issue) {
    return null;
  }

  if (!/^\d+$/.test(String(issue))) {
    return null;
  }

  try {
    return (
      BigInt(issue) + 1n
    ).toString();
  } catch {
    return null;
  }
}

function json(res, status, data) {
  const body =
    JSON.stringify(data);

  res.writeHead(status, {
    "Content-Type":
      "application/json; charset=utf-8",
    "Cache-Control":
      "no-store",
    "Access-Control-Allow-Origin":
      "*",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Admin-Key",
    "Access-Control-Allow-Methods":
      "GET, POST, DELETE, OPTIONS"
  });

  res.end(body);
}

function text(
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

function randomKey() {
  return (
    "DY-" +
    crypto
      .randomBytes(12)
      .toString("hex")
      .toUpperCase()
  );
}


// ============================================================
// BODY
// ============================================================

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk.toString();

      if (body.length > 1024 * 1024) {
        reject(
          new Error("Request too large")
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


// ============================================================
// DATABASE INIT
// ============================================================

async function initDatabase() {
  if (!pool) {
    console.log(
      "DATABASE_URL not configured"
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
      settled_at BIGINT,
      created_at BIGINT NOT NULL
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

  console.log(
    "Database initialized"
  );
}


// ============================================================
// WINGOBOT
// ============================================================

async function fetchWingoBot() {
  if (!WINGOBOT_TOKEN) {
    provider.ok = false;
    provider.error =
      "WINGOBOT_TOKEN is not configured";

    return provider;
  }

  if (providerFetching) {
    return provider;
  }

  providerFetching = true;

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
              "application/json"
          }
        }
      );

    const raw =
      await response.text();

    if (!response.ok) {
      throw new Error(
        `WingoBot HTTP ${response.status}`
      );
    }

    let data;

    try {
      data =
        JSON.parse(raw);
    } catch {
      throw new Error(
        "Invalid WingoBot JSON"
      );
    }

    const normalized =
      normalizeResponse(data);

    provider = {
      ok: true,
      history:
        normalized.history,
      currentIssue:
        normalized.currentIssue,
      lastUpdated:
        normalized.lastUpdated,
      fetched:
        normalized.fetched,
      error: null,
      fetchedAt: now()
    };

    return provider;

  } catch (error) {
    provider.ok = false;

    provider.error =
      error.message ||
      "Provider error";

    provider.fetchedAt =
      now();

    console.error(
      "Provider:",
      provider.error
    );

    return provider;

  } finally {
    providerFetching = false;
  }
}


// ============================================================
// NORMALIZE PROVIDER DATA
// ============================================================

function normalizeResponse(data) {
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

  const map = new Map();

  for (const row of rows) {
    if (!row) {
      continue;
    }

    const issue =
      cleanIssue(
        row.issueNumber ??
        row.issue ??
        row.period ??
        row.periodNumber
      );

    if (!issue) {
      continue;
    }

    const rawNumber =
      row.number ??
      row.num ??
      null;

    let number = null;

    if (
      rawNumber !== null &&
      rawNumber !== undefined &&
      String(rawNumber).trim() !== ""
    ) {
      const n =
        Number(rawNumber);

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
      A row without a valid side/number
      is NOT a settled result.
    */

    if (!side) {
      continue;
    }

    map.set(
      issue,
      {
        issueNumber: issue,
        number,
        side,
        colour:
          row.colour ??
          row.color ??
          side,
        premium:
          row.premium ?? null,
        sum:
          row.sum ?? null
      }
    );
  }

  const history =
    Array.from(map.values());

  history.sort((a, b) => {
    try {
      const aa =
        BigInt(a.issueNumber);

      const bb =
        BigInt(b.issueNumber);

      if (aa > bb) return -1;
      if (aa < bb) return 1;

      return 0;
    } catch {
      return String(
        b.issueNumber
      ).localeCompare(
        String(a.issueNumber)
      );
    }
  });

  return {
    currentIssue,
    history:
      history.slice(
        0,
        MAX_HISTORY
      ),
    lastUpdated:
      data?.stats?.last_updated ??
      data?.last_updated ??
      data?.lastUpdated ??
      null,
    fetched:
      Number(
        data?.stats?.fetched ??
        history.length
      ) ||
      history.length
  };
}


// ============================================================
// TARGET RESOLVER
// ============================================================

function resolveTargetIssue() {
  const history =
    provider.history || [];

  const latestSettled =
    history.length
      ? history[0].issueNumber
      : null;

  const current =
    cleanIssue(
      provider.currentIssue
    );

  if (
    latestSettled &&
    current
  ) {
    try {
      const h =
        BigInt(latestSettled);

      const c =
        BigInt(current);

      /*
        Provider current is ahead:
        use it as target.
      */

      if (c > h) {
        return current;
      }

      /*
        Otherwise latest settled + 1.
      */

      return (
        h + 1n
      ).toString();

    } catch {
      if (
        current !==
        latestSettled
      ) {
        return current;
      }

      return incrementIssue(
        latestSettled
      );
    }
  }

  if (current) {
    return current;
  }

  if (latestSettled) {
    return incrementIssue(
      latestSettled
    );
  }

  return null;
}


// ============================================================
// HISTORY SIDES
// ============================================================

function getSides(limit = 100) {
  return (provider.history || [])
    .filter(
      x => x && x.side
    )
    .slice(0, limit)
    .map(
      x => x.side
    );
}


// ============================================================
// SIGNAL 1
// RECENT WEIGHTED MOMENTUM
// ============================================================

function recentMomentum(sides) {
  const arr =
    sides.slice(0, 7);

  if (!arr.length) {
    return 0;
  }

  const weights = [
    1.00,
    0.92,
    0.82,
    0.70,
    0.58,
    0.45,
    0.32
  ];

  let score = 0;
  let total = 0;

  for (
    let i = 0;
    i < arr.length;
    i++
  ) {
    const value =
      arr[i] === "BIG"
        ? 1
        : -1;

    score +=
      value *
      weights[i];

    total +=
      weights[i];
  }

  return total
    ? clamp(
        score / total,
        -1,
        1
      )
    : 0;
}


// ============================================================
// SIGNAL 2
// MEDIUM BALANCE
// ============================================================

function mediumBalance(sides) {
  const arr =
    sides.slice(0, 20);

  if (!arr.length) {
    return 0;
  }

  let big = 0;
  let small = 0;

  for (const side of arr) {
    if (side === "BIG") {
      big++;
    } else {
      small++;
    }
  }

  return clamp(
    (big - small) /
    arr.length,
    -1,
    1
  );
}


// ============================================================
// SIGNAL 3
// VERY RECENT BALANCE
// ============================================================

function microBalance(sides) {
  const arr =
    sides.slice(0, 4);

  if (!arr.length) {
    return 0;
  }

  let big = 0;
  let small = 0;

  for (const side of arr) {
    if (side === "BIG") {
      big++;
    } else {
      small++;
    }
  }

  return clamp(
    (big - small) /
    arr.length,
    -1,
    1
  );
}


// ============================================================
// SIGNAL 4
// TRANSITIONS
// ============================================================

function transitionModel(sides) {
  const arr =
    sides.slice(0, 25);

  if (arr.length < 3) {
    return 0;
  }

  let bb = 0;
  let bs = 0;
  let sb = 0;
  let ss = 0;

  for (
    let i = 0;
    i < arr.length - 1;
    i++
  ) {
    const current =
      arr[i];

    const older =
      arr[i + 1];

    if (
      older === "BIG" &&
      current === "BIG"
    ) {
      bb++;
    }

    if (
      older === "BIG" &&
      current === "SMALL"
    ) {
      bs++;
    }

    if (
      older === "SMALL" &&
      current === "BIG"
    ) {
      sb++;
    }

    if (
      older === "SMALL" &&
      current === "SMALL"
    ) {
      ss++;
    }
  }

  const latest =
    arr[0];

  let predictionScore = 0;

  if (latest === "BIG") {

    const total =
      bb + bs;

    if (total > 0) {
      /*
        P(next BIG) vs P(next SMALL)
      */

      predictionScore =
        (bb - bs) /
        total;
    }

  } else {

    const total =
      sb + ss;

    if (total > 0) {

      predictionScore =
        (sb - ss) /
        total;
    }
  }

  return clamp(
    predictionScore,
    -1,
    1
  );
}


// ============================================================
// SIGNAL 5
// STREAK BREAK
// ============================================================

function streakBreak(sides) {
  const arr =
    sides.slice(0, 20);

  if (!arr.length) {
    return 0;
  }

  const first =
    arr[0];

  let streak = 1;

  while (
    streak < arr.length &&
    arr[streak] === first
  ) {
    streak++;
  }

  if (streak >= 7) {
    return first === "BIG"
      ? -0.90
      : 0.90;
  }

  if (streak === 6) {
    return first === "BIG"
      ? -0.70
      : 0.70;
  }

  if (streak === 5) {
    return first === "BIG"
      ? -0.48
      : 0.48;
  }

  if (streak === 4) {
    return first === "BIG"
      ? -0.25
      : 0.25;
  }

  if (streak === 3) {
    return first === "BIG"
      ? -0.08
      : 0.08;
  }

  return 0;
}


// ============================================================
// SIGNAL 6
// ALTERNATION DETECTOR
// ============================================================

function alternationSignal(sides) {
  const arr =
    sides.slice(0, 10);

  if (arr.length < 5) {
    return 0;
  }

  let changes = 0;

  for (
    let i = 0;
    i < arr.length - 1;
    i++
  ) {
    if (
      arr[i] !==
      arr[i + 1]
    ) {
      changes++;
    }
  }

  const ratio =
    changes /
    (arr.length - 1);

  if (ratio >= 0.80) {

    /*
      Strong alternating sequence:
      next side leans opposite latest.
    */

    return arr[0] === "BIG"
      ? -0.75
      : 0.75;
  }

  if (ratio >= 0.65) {

    return arr[0] === "BIG"
      ? -0.38
      : 0.38;
  }

  return 0;
}


// ============================================================
// SIGNAL 7
// PATTERN MATCHING
// ============================================================

function patternSignal(sides) {
  const arr =
    sides.slice(0, 40);

  if (arr.length < 7) {
    return 0;
  }

  const patternLength = 4;

  const pattern =
    arr
      .slice(0, patternLength)
      .map(
        x =>
          x === "BIG"
            ? "B"
            : "S"
      )
      .join("");

  let big = 0;
  let small = 0;

  for (
    let i = patternLength;
    i < arr.length - 1;
    i++
  ) {

    const candidate =
      arr
        .slice(
          i,
          i + patternLength
        )
        .map(
          x =>
            x === "BIG"
              ? "B"
              : "S"
        )
        .join("");

    if (
      candidate !==
      pattern
    ) {
      continue;
    }

    const next =
      arr[i - 1];

    if (next === "BIG") {
      big++;
    } else if (
      next === "SMALL"
    ) {
      small++;
    }
  }

  const total =
    big + small;

  if (!total) {
    return 0;
  }

  return clamp(
    (big - small) /
    total,
    -1,
    1
  );
}


// ============================================================
// SIGNAL 8
// LOCAL REVERSAL
// ============================================================

function reversalSignal(sides) {
  const arr =
    sides.slice(0, 6);

  if (arr.length < 4) {
    return 0;
  }

  /*
    If last 3 contain same side
    and older context disagrees,
    reversal gets a modest boost.
  */

  const latest =
    arr[0];

  const same =
    arr.filter(
      x => x === latest
    ).length;

  if (same >= 4) {
    return latest === "BIG"
      ? -0.58
      : 0.58;
  }

  if (same === 3) {
    return latest === "BIG"
      ? -0.25
      : 0.25;
  }

  return 0;
}


// ============================================================
// SIGNAL 9
// LONG BALANCE
// ============================================================

function longBalance(sides) {
  const arr =
    sides.slice(0, 60);

  if (!arr.length) {
    return 0;
  }

  let big = 0;
  let small = 0;

  for (const side of arr) {
    if (side === "BIG") {
      big++;
    } else {
      small++;
    }
  }

  return clamp(
    (big - small) /
    arr.length,
    -1,
    1
  );
}


// ============================================================
// REGIME
// ============================================================

function classifyRegime(
  recent,
  medium,
  transition,
  streak,
  alternation,
  reversal
) {

  if (
    Math.abs(alternation) >= 0.60
  ) {
    return "ALTERNATING";
  }

  if (
    Math.abs(streak) >= 0.45
  ) {
    return "STREAK_BREAK";
  }

  if (
    Math.sign(recent) !==
      Math.sign(medium) &&
    Math.abs(recent) > 0.22 &&
    Math.abs(medium) > 0.22
  ) {
    return "CONFLICT";
  }

  if (
    Math.abs(transition) > 0.50
  ) {
    return "TRANSITION";
  }

  if (
    Math.abs(recent) > 0.50 &&
    Math.abs(medium) > 0.30
  ) {
    return "TREND";
  }

  if (
    Math.abs(recent) > 0.25
  ) {
    return "SHORT_SHIFT";
  }

  return "MIXED";
}


// ============================================================
// V4 AI
// ============================================================

function createPrediction() {

  const sides =
    getSides(100);

  /*
    Important:
    Even one settled result is enough
    for a BIG/SMALL prediction.
  */

  if (!sides.length) {

    return {
      prediction: null,
      confidence: 0,
      regime: "WAITING",
      reason:
        "Waiting for first settled result",
      diagnostics: {}
    };

  }

  const recent =
    recentMomentum(sides);

  const medium =
    mediumBalance(sides);

  const micro =
    microBalance(sides);

  const transition =
    transitionModel(sides);

  const streak =
    streakBreak(sides);

  const alternation =
    alternationSignal(sides);

  const pattern =
    patternSignal(sides);

  const reversal =
    reversalSignal(sides);

  const long =
    longBalance(sides);

  /*
    V4 core score.
  */

  let score =
    recent * 0.27 +
    micro * 0.12 +
    medium * 0.12 +
    transition * 0.14 +
    streak * 0.12 +
    alternation * 0.10 +
    pattern * 0.05 +
    reversal * 0.05 +
    long * 0.03;

  /*
    Strong alternating sequence gets
    priority over simple trend.
  */

  if (
    Math.abs(alternation) >= 0.60
  ) {

    score =
      score * 0.70 +
      alternation * 0.30;

  }

  /*
    Long streak should not be blindly followed.
  */

  if (
    Math.abs(streak) >= 0.45
  ) {

    score =
      score * 0.72 +
      streak * 0.28;

  }

  /*
    If recent and transition agree,
    give a small boost.
  */

  if (
    Math.sign(recent) ===
      Math.sign(transition) &&
    Math.abs(recent) > 0.25 &&
    Math.abs(transition) > 0.25
  ) {

    score *= 1.08;

  }

  /*
    If signals strongly conflict,
    reduce confidence but still select
    a side.
  */

  const regime =
    classifyRegime(
      recent,
      medium,
      transition,
      streak,
      alternation,
      reversal
    );

  if (
    regime === "CONFLICT"
  ) {

    score *= 0.82;

  }

  /*
    Compulsory BIG/SMALL.
  */

  const prediction =
    score >= 0
      ? "BIG"
      : "SMALL";

  /*
    Confidence represents signal strength,
    NOT guaranteed probability.
  */

  let confidence =
    48 +
    Math.abs(score) * 32;

  if (
    regime === "CONFLICT"
  ) {
    confidence -= 6;
  }

  if (
    regime === "MIXED"
  ) {
    confidence -= 2;
  }

  if (
    sides.length < 5
  ) {
    confidence -= 4;
  }

  confidence =
    Math.round(
      clamp(
        confidence,
        45,
        88
      )
    );

  let reason;

  switch (regime) {

    case "ALTERNATING":
      reason =
        "Alternating pattern detected";

      break;

    case "STREAK_BREAK":
      reason =
        "Strong streak-break pressure";

      break;

    case "CONFLICT":
      reason =
        "Recent and medium signals conflict";

      break;

    case "TRANSITION":
      reason =
        "Transition pattern is dominant";

      break;

    case "TREND":
      reason =
        "Recent and medium trend aligned";

      break;

    case "SHORT_SHIFT":
      reason =
        "Recent-side momentum shifted";

      break;

    default:
      reason =
        "Multiple mixed signals combined";

      break;
  }

  return {
    prediction,
    confidence,
    regime,
    reason,

    diagnostics: {
      recent:
        Number(
          recent.toFixed(4)
        ),

      micro:
        Number(
          micro.toFixed(4)
        ),

      medium:
        Number(
          medium.toFixed(4)
        ),

      transition:
        Number(
          transition.toFixed(4)
        ),

      streak:
        Number(
          streak.toFixed(4)
        ),

      alternation:
        Number(
          alternation.toFixed(4)
        ),

      pattern:
        Number(
          pattern.toFixed(4)
        ),

      reversal:
        Number(
          reversal.toFixed(4)
        ),

      long:
        Number(
          long.toFixed(4)
        ),

      score:
        Number(
          score.toFixed(4)
        ),

      history:
        sides.length
    }
  };
}


// ============================================================
// GET STORED PREDICTION
// ============================================================

async function getStoredPrediction(issue) {

  if (
    !pool ||
    !issue
  ) {
    return null;
  }

  const result =
    await pool.query(
      `
        SELECT *
        FROM prediction_records
        WHERE model_version = $1
        AND target_issue = $2
        ORDER BY id DESC
        LIMIT 1
      `,
      [
        MODEL_VERSION,
        issue
      ]
    );

  return (
    result.rows[0] ||
    null
  );
}


// ============================================================
// CREATE STORED PREDICTION
// ============================================================

async function ensurePrediction(issue) {

  if (!issue) {
    return null;
  }

  const existing =
    await getStoredPrediction(
      issue
    );

  if (existing) {
    return existing;
  }

  const ai =
    createPrediction();

  /*
    V4 must always choose a side
    when at least one settled result exists.
  */

  if (!ai.prediction) {
    return null;
  }

  if (!pool) {

    return {
      id: null,

      target_issue:
        issue,

      prediction:
        ai.prediction,

      confidence:
        ai.confidence,

      model_version:
        MODEL_VERSION,

      actual_number:
        null,

      actual_result:
        null,

      settled_at:
        null,

      created_at:
        now(),

      regime:
        ai.regime,

      reason:
        ai.reason,

      diagnostics:
        ai.diagnostics
    };

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
          actual_number,
          actual_result,
          settled_at,
          created_at
        )
        VALUES
        ($1,$2,$3,$4,NULL,NULL,NULL,$5)
        ON CONFLICT
        (model_version,target_issue)
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

  if (
    result.rows[0]
  ) {

    return {
      ...result.rows[0],

      regime:
        ai.regime,

      reason:
        ai.reason,

      diagnostics:
        ai.diagnostics
    };

  }

  return getStoredPrediction(
    issue
  );
}


// ============================================================
// SETTLEMENT
// ============================================================

async function settlePredictions() {

  if (
    !pool ||
    !provider.history?.length
  ) {
    return;
  }

  const pending =
    await pool.query(
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

  if (!pending.rows.length) {
    return;
  }

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

    const actual =
      actualMap.get(
        String(
          prediction.target_issue
        )
      );

    /*
      Exact period only.
    */

    if (!actual) {
      continue;
    }

    const actualSide =
      actual.side ||
      sideFromNumber(
        actual.number
      );

    if (!actualSide) {
      continue;
    }

    const result =
      actualSide ===
      prediction.prediction
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
        result,
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

  const target =
    resolveTargetIssue();

  if (!target) {

    return {
      targetIssue: null,
      prediction: null,
      confidence: 0,
      regime: "WAITING",
      reason:
        "Waiting for provider data",
      modelVersion:
        MODEL_VERSION,
      diagnostics: null
    };

  }

  const record =
    await ensurePrediction(
      target
    );

  if (!record) {

    return {
      targetIssue:
        target,

      prediction:
        null,

      confidence:
        0,

      regime:
        "WAITING",

      reason:
        "Waiting for settled history",

      modelVersion:
        MODEL_VERSION,

      diagnostics:
        null
    };

  }

  /*
    Stored prediction stays locked
    for the exact target issue.
  */

  return {
    targetIssue:
      target,

    prediction:
      record.prediction,

    confidence:
      Number(
        record.confidence || 0
      ),

    regime:
      record.regime ||
      "MIXED",

    reason:
      record.reason ||
      "AI analysis complete",

    modelVersion:
      record.model_version ||
      MODEL_VERSION,

    diagnostics:
      record.diagnostics ||
      null,

    createdAt:
      record.created_at ||
      null
  };
}


// ============================================================
// LAST 30
// ============================================================

async function last30() {

  if (!pool) {
    return [];
  }

  const result =
    await pool.query(
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
        LIMIT 30
      `,
      [MODEL_VERSION]
    );

  const actualMap =
    new Map();

  for (
    const row of provider.history || []
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

  return result.rows.map(
    row => {

      const actual =
        actualMap.get(
          String(
            row.target_issue
          )
        );

      let resultText =
        null;

      let wl =
        "PENDING";

      /*
        Do NOT use database actual_result
        blindly for display if provider has
        no exact result.

        Exact current provider period wins.
      */

      if (actual) {

        resultText =
          actual.side;

        wl =
          actual.side ===
          row.prediction
            ? "WIN"
            : "LOSS";

      }

      return {
        id:
          row.id,

        issue:
          row.target_issue,

        period:
          row.target_issue,

        number:
          null,

        result:
          resultText,

        predict:
          row.prediction,

        prediction:
          row.prediction,

        wl,

        confidence:
          Number(
            row.confidence || 0
          ),

        modelVersion:
          row.model_version,

        settled:
          Boolean(actual),

        createdAt:
          row.created_at,

        settledAt:
          row.settled_at
      };

    }
  );
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

  const result =
    await pool.query(
      `
        SELECT
          COUNT(*) FILTER
          (
            WHERE actual_result = 'WIN'
          ) AS wins,

          COUNT(*) FILTER
          (
            WHERE actual_result = 'LOSS'
          ) AS losses,

          COUNT(*) FILTER
          (
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

  const total =
    wins + losses;

  const winRate =
    total
      ? Number(
          (
            wins /
            total *
            100
          ).toFixed(1)
        )
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
// ACCESS KEY
// ============================================================

async function checkAccessKey(
  accessKey,
  deviceId
) {

  if (!pool) {

    return {
      ok: false,
      message:
        "Database unavailable"
    };

  }

  if (!accessKey) {

    return {
      ok: false,
      message:
        "Access key required"
    };

  }

  if (!deviceId) {

    return {
      ok: false,
      message:
        "Device ID required"
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
      [accessKey]
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

  /*
    First device binds.
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
      message:
        "Access granted"
    };

  }

  if (
    row.device_id !==
    deviceId
  ) {

    return {
      ok: false,
      message:
        "This key is already bound to another device"
    };

  }

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

  return {
    ok: true,
    message:
      "Access granted"
  };
}


// ============================================================
// ADMIN AUTH
// ============================================================

function isAdmin(req) {

  const header =
    req.headers["x-admin-key"];

  const authorization =
    req.headers["authorization"];

  const key =
    header ||
    (
      authorization
        ? authorization.replace(
            /^Bearer\s+/i,
            ""
          )
        : ""
    );

  return (
    safeString(key) ===
    ADMIN_KEY
  );
}


// ============================================================
// ADMIN KEYS
// ============================================================

async function listKeys() {

  if (!pool) {
    return [];
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

  return result.rows;
}


async function createKey(custom) {

  if (!pool) {
    throw new Error(
      "Database unavailable"
    );
  }

  const key =
    safeString(custom).trim() ||
    randomKey();

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


async function resetDevice(id) {

  if (!pool) {
    throw new Error(
      "Database unavailable"
    );
  }

  const result =
    await pool.query(
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

  return (
    result.rows[0] ||
    null
  );
}


async function deleteKey(id) {

  if (!pool) {
    throw new Error(
      "Database unavailable"
    );
  }

  const result =
    await pool.query(
      `
        DELETE FROM access_keys
        WHERE id = $1
        RETURNING id
      `,
      [id]
    );

  return Boolean(
    result.rows.length
  );
}


// ============================================================
// STATE
// ============================================================

async function getState() {

  await settlePredictions();

  const current =
    await currentPrediction();

  return {

    ok: true,

    gameUrl:
      GAME_URL,

    model: {

      version:
        MODEL_VERSION,

      type:
        "BIG/SMALL",

      numberPrediction:
        false

    },

    provider: {

      ok:
        provider.ok,

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
        current.targetIssue,

      targetIssue:
        current.targetIssue,

      prediction:
        current.prediction,

      confidence:
        current.confidence,

      regime:
        current.regime,

      reason:
        current.reason,

      modelVersion:
        current.modelVersion,

      diagnostics:
        current.diagnostics

    },

    stats:
      await stats(),

    last30:
      await last30(),

    serverTime:
      now()

  };
}


// ============================================================
// MODEL TEST
// ============================================================

function modelTest() {

  const ai =
    createPrediction();

  return {

    ok:
      Boolean(
        ai.prediction
      ),

    modelVersion:
      MODEL_VERSION,

    prediction:
      ai.prediction,

    confidence:
      ai.confidence,

    regime:
      ai.regime,

    reason:
      ai.reason,

    diagnostics:
      ai.diagnostics,

    historyCount:
      provider.history?.length || 0,

    providerOk:
      provider.ok

  };
}


// ============================================================
// STATIC FILES
// ============================================================

function serveFile(
  res,
  fileName,
  contentType
) {

  const filePath =
    path.join(
      __dirname,
      fileName
    );

  fs.stat(
    filePath,
    (statError, stat) => {

      if (
        statError ||
        !stat.isFile()
      ) {

        text(
          res,
          404,
          "File not found"
        );

        return;

      }

      fs.readFile(
        filePath,
        (error, data) => {

          if (error) {

            text(
              res,
              500,
              "Unable to read file"
            );

            return;

          }

          res.writeHead(
            200,
            {
              "Content-Type":
                contentType,

              "Cache-Control":
                fileName.endsWith(".html")
                  ? "no-store"
                  : "public, max-age=3600"
            }
          );

          res.end(data);

        }
      );

    }
  );
}


// ============================================================
// MUSIC
// ============================================================

function serveMusic(res, req) {

  const filePath =
    path.join(
      __dirname,
      "music.mp3"
    );

  fs.stat(
    filePath,
    (error, stat) => {

      if (
        error ||
        !stat.isFile()
      ) {

        text(
          res,
          404,
          "music.mp3 not found"
        );

        return;

      }

      const size =
        stat.size;

      const range =
        req.headers.range;

      if (!range) {

        res.writeHead(
          200,
          {
            "Content-Type":
              "audio/mpeg",

            "Content-Length":
              size,

            "Accept-Ranges":
              "bytes"
          }
        );

        fs.createReadStream(
          filePath
        ).pipe(res);

        return;

      }

      const match =
        range.match(
          /bytes=(\d*)-(\d*)/
        );

      if (!match) {

        res.writeHead(
          416,
          {
            "Content-Range":
              `bytes */${size}`
          }
        );

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

      start =
        Math.max(
          0,
          Math.min(
            start,
            size - 1
          )
        );

      end =
        Math.max(
          start,
          Math.min(
            end,
            size - 1
          )
        );

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
            `bytes ${start}-${end}/${size}`,

          "Accept-Ranges":
            "bytes"
        }
      );

      fs.createReadStream(
        filePath,
        {
          start,
          end
        }
      ).pipe(res);

    }
  );
}


// ============================================================
// HTTP SERVER
// ============================================================

const server =
  http.createServer(
    async (req, res) => {

      if (
        req.method === "OPTIONS"
      ) {

        res.writeHead(
          204,
          {
            "Access-Control-Allow-Origin":
              "*",

            "Access-Control-Allow-Headers":
              "Content-Type, Authorization, X-Admin-Key",

            "Access-Control-Allow-Methods":
              "GET, POST, DELETE, OPTIONS"
          }
        );

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
        // ROOT -> PREDICTION
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
              model:
                MODEL_VERSION,
              provider:
                provider.ok,
              time:
                now()
            }
          );

        }


        // ==================================================
        // MUSIC
        // ==================================================

        if (
          req.method === "GET" &&
          pathname === "/music.mp3"
        ) {

          return serveMusic(
            res,
            req
          );

        }


        // ==================================================
        // KEY CHECK
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
            safeString(
              body.deviceId ||
              body.device_id
            ).trim();

          const result =
            await checkAccessKey(
              accessKey,
              deviceId
            );

          return json(
            res,
            result.ok
              ? 200
              : 403,
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

          return json(
            res,
            200,
            await getState()
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

          if (!isAdmin(req)) {

            return json(
              res,
              401,
              {
                ok: false,
                message:
                  "Unauthorized"
              }
            );

          }

          const ai =
            createPrediction();

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

              database:
                Boolean(pool),

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

          if (!isAdmin(req)) {

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
              model:
                MODEL_VERSION,
              message:
                "Server online",
              time:
                now()
            }
          );

        }


        // ==================================================
        // WINGOBOT TEST
        // ==================================================

        if (
          req.method === "GET" &&
          pathname === "/api/admin/wingo-test"
        ) {

          if (!isAdmin(req)) {

            return json(
              res,
              401,
              {
                ok: false,
                message:
                  "Unauthorized"
              }
            );

          }

          await fetchWingoBot();

          return json(
            res,
            200,
            {

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

              sample:
                (
                  provider.history || []
                )
                  .slice(0, 10)
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
        // MODEL TEST
        // ==================================================

        if (
          req.method === "GET" &&
          pathname === "/api/admin/model-test"
        ) {

          if (!isAdmin(req)) {

            return json(
              res,
              401,
              {
                ok: false,
                message:
                  "Unauthorized"
              }
            );

          }

          return json(
            res,
            200,
            model
