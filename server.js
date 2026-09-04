"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

/* =========================================================
   CONFIG
========================================================= */

const PORT = Number(process.env.PORT || 10000);

const ADMIN_KEY = String(process.env.ADMIN_KEY || "").trim();

const WINGOBOT_TOKEN = String(
  process.env.WINGOBOT_TOKEN || ""
).trim();

const DATABASE_URL = String(
  process.env.DATABASE_URL || ""
).trim();

const HOST = "0.0.0.0";

const WINGOBOT_API =
  "https://api.wingobot.com/v2/30-sec-game-history";

const PUBLIC_DIR = __dirname;


/* =========================================================
   DATABASE
========================================================= */

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

async function initDatabase() {
  if (!pool) {
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
    CREATE INDEX IF NOT EXISTS idx_prediction_target
    ON prediction_records(target_issue)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_prediction_created
    ON prediction_records(created_at DESC)
  `);

  console.log("Database ready");
}


/* =========================================================
   MEMORY STATE
========================================================= */

let providerState = {
  ok: false,
  currentIssue: null,
  history: [],
  fetched: 0,
  lastUpdated: 0,
  error: null,
  fetchedAt: 0
};

let modelCache = {
  targetIssue: null,
  prediction: null,
  confidence: 0,
  reason: "",
  modelVersion: "DY-AI-V2",
  generatedAt: 0
};


/* =========================================================
   HELPERS
========================================================= */

function now() {
  return Date.now();
}

function json(res, status, data) {
  const body = JSON.stringify(data);

  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "Content-Type, X-Access-Key, X-Device-Id, Authorization",
    "Access-Control-Allow-Methods":
      "GET, POST, DELETE, OPTIONS"
  });

  res.end(body);
}

function text(res, status, body, type = "text/plain") {
  res.writeHead(status, {
    "Content-Type": `${type}; charset=utf-8`,
    "Cache-Control": "no-store"
  });

  res.end(body);
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function issueString(value) {
  if (value === undefined || value === null) return null;
  return String(value).trim() || null;
}

function incrementIssue(issue) {
  const s = issueString(issue);

  if (!s) return null;

  if (/^\d+$/.test(s)) {
    try {
      return (BigInt(s) + 1n).toString();
    } catch {
      return null;
    }
  }

  return null;
}


/* =========================================================
   RESULT NORMALIZATION
========================================================= */

function normalizeResult(row) {
  if (!row) return null;

  const number = safeNumber(
    row.number ??
    row.resultNumber ??
    row.digit
  );

  if (
    number !== null &&
    Number.isInteger(number) &&
    number >= 0 &&
    number <= 9
  ) {
    return number >= 5 ? "BIG" : "SMALL";
  }

  const raw = String(
    row.result ??
    row.bigSmall ??
    row.size ??
    ""
  )
    .trim()
    .toUpperCase();

  if (raw === "BIG") return "BIG";
  if (raw === "SMALL") return "SMALL";

  return null;
}

function normalizeHistory(input) {
  if (!Array.isArray(input)) return [];

  return input
    .map((row) => {
      const issue = issueString(
        row.issueNumber ??
        row.issue ??
        row.period ??
        row.periodNumber
      );

      const number = safeNumber(
        row.number ??
        row.resultNumber ??
        row.digit
      );

      const result = normalizeResult(row);

      return {
        issueNumber: issue,
        number:
          number !== null &&
          Number.isInteger(number) &&
          number >= 0 &&
          number <= 9
            ? number
            : null,
        result,
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
      };
    })
    .filter((x) => x.issueNumber);
}


/* =========================================================
   WINGOBOT FETCH
========================================================= */

function fetchJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": "DY-AI-Wingo/2.0",
          ...headers
        },
        timeout: 15000
      },
      (response) => {
        let body = "";

        response.setEncoding("utf8");

        response.on("data", (chunk) => {
          body += chunk;
        });

        response.on("end", () => {
          const status = response.statusCode || 0;

          if (status < 200 || status >= 300) {
            reject(
              new Error(
                `WingoBot HTTP ${status}: ${body.slice(0, 300)}`
              )
            );
            return;
          }

          try {
            resolve(JSON.parse(body));
          } catch {
            reject(
              new Error("WingoBot returned invalid JSON")
            );
          }
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(
        new Error("WingoBot request timeout")
      );
    });

    request.on("error", reject);
  });
}

async function refreshProvider() {
  if (!WINGOBOT_TOKEN) {
    providerState.ok = false;
    providerState.error =
      "WINGOBOT_TOKEN environment variable missing";
    return;
  }

  try {
    const data = await fetchJson(
      WINGOBOT_API,
      {
        Authorization:
          `Bearer ${WINGOBOT_TOKEN}`
      }
    );

    const history = normalizeHistory(data.history);

    const currentIssue = issueString(
      data?.current?.issueNumber ??
      data?.current?.issue ??
      null
    );

    let lastUpdated =
      safeNumber(
        data?.stats?.last_updated ??
        data?.last_updated
      ) || 0;

    /*
      Provider timestamps kabhi seconds aur kabhi milliseconds
      format me aa sakte hain.
    */
    if (
      lastUpdated > 0 &&
      lastUpdated < 100000000000
    ) {
      lastUpdated *= 1000;
    }

    providerState = {
      ok: true,
      currentIssue,
      history,
      fetched:
        safeNumber(data?.stats?.fetched) ||
        history.length,
      lastUpdated,
      error: null,
      fetchedAt: now()
    };

    await settlePredictions(history);

    /*
      Target change hone par model dobara calculate hoga.
    */
    const target = resolveTargetIssue();

    if (
      target &&
      modelCache.targetIssue !== target
    ) {
      generatePrediction();
    }
  } catch (error) {
    providerState.ok = false;
    providerState.error =
      error?.message || "Provider error";

    console.error(
      "Provider refresh error:",
      providerState.error
    );
  }
}


/* =========================================================
   TARGET ISSUE
========================================================= */

function resolveTargetIssue() {
  const history = providerState.history || [];

  const latestSettled =
    history.length > 0
      ? history[0]?.issueNumber
      : null;

  const current =
    providerState.currentIssue;

  if (current && latestSettled) {
    /*
      Agar provider ka current issue latest settled se
      aage hai, wahi active target hai.
    */
    if (compareNumericIssues(current, latestSettled) > 0) {
      return current;
    }

    /*
      Agar current already latest settled ya old hai,
      next issue target hoga.
    */
    return incrementIssue(latestSettled);
  }

  if (current) {
    return current;
  }

  if (latestSettled) {
    return incrementIssue(latestSettled);
  }

  return null;
}

function compareNumericIssues(a, b) {
  const x = issueString(a);
  const y = issueString(b);

  if (!x || !y) return 0;

  if (/^\d+$/.test(x) && /^\d+$/.test(y)) {
    try {
      const bx = BigInt(x);
      const by = BigInt(y);

      if (bx > by) return 1;
      if (bx < by) return -1;
      return 0;
    } catch {
      return x.localeCompare(y);
    }
  }

  return x.localeCompare(y);
}


/* =========================================================
   ANALYSIS ENGINE
========================================================= */

function getResults(rows, limit = 30) {
  return rows
    .map(normalizeResult)
    .filter(Boolean)
    .slice(0, limit);
}

function getStreak(rows) {
  const r = getResults(rows, 30);

  if (!r.length) {
    return {
      side: null,
      length: 0
    };
  }

  const side = r[0];
  let length = 1;

  for (
    let i = 1;
    i < r.length;
    i++
  ) {
    if (r[i] !== side) break;
    length++;
  }

  return {
    side,
    length
  };
}

function ratioSignal(rows, windowSize) {
  const r = getResults(rows, windowSize);

  if (!r.length) {
    return {
      big: 0.5,
      small: 0.5,
      n: 0
    };
  }

  const big =
    r.filter((x) => x === "BIG").length /
    r.length;

  return {
    big,
    small: 1 - big,
    n: r.length
  };
}

function transitionSignal(rows) {
  const r = getResults(rows, 50);

  if (r.length < 3) {
    return {
      big: 0.5,
      small: 0.5
    };
  }

  let BB = 0;
  let BS = 0;
  let SB = 0;
  let SS = 0;

  for (let i = 0; i < r.length - 1; i++) {
    const a = r[i];
    const b = r[i + 1];

    if (a === "BIG" && b === "BIG") BB++;
    if (a === "BIG" && b === "SMALL") BS++;
    if (a === "SMALL" && b === "BIG") SB++;
    if (a === "SMALL" && b === "SMALL") SS++;
  }

  const last = r[0];

  if (last === "BIG") {
    const total = BB + BS;

    if (!total) {
      return {
        big: 0.5,
        small: 0.5
      };
    }

    return {
      big: BB / total,
      small: BS / total
    };
  }

  const total = SB + SS;

  if (!total) {
    return {
      big: 0.5,
      small: 0.5
    };
  }

  return {
    big: SB / total,
    small: SS / total
  };
}

function alternationSignal(rows) {
  const r = getResults(rows, 12);

  if (r.length < 4) {
    return {
      strength: 0,
      next: null
    };
  }

  let flips = 0;

  for (let i = 0; i < r.length - 1; i++) {
    if (r[i] !== r[i + 1]) {
      flips++;
    }
  }

  const rate =
    flips / (r.length - 1);

  if (rate >= 0.70) {
    return {
      strength: rate,
      next:
        r[0] === "BIG"
          ? "SMALL"
          : "BIG"
    };
  }

  return {
    strength: 0,
    next: null
  };
}

function trendSignal(rows) {
  const r = getResults(rows, 12);

  if (r.length < 5) {
    return {
      side: null,
      strength: 0
    };
  }

  let score = 0;

  /*
    Recent rounds ko zyada weight.
  */
  for (let i = 0; i < r.length; i++) {
    const weight =
      Math.max(1, r.length - i);

    score +=
      r[i] === "BIG"
        ? weight
        : -weight;
  }

  const max =
    r.reduce(
      (sum, _, i) =>
        sum + Math.max(1, r.length - i),
      0
    );

  const normalized =
    max ? score / max : 0;

  if (Math.abs(normalized) < 0.08) {
    return {
      side: null,
      strength: 0
    };
  }

  return {
    side:
      normalized > 0
        ? "BIG"
        : "SMALL",
    strength:
      Math.min(
        1,
        Math.abs(normalized)
      )
  };
}

function meanNumberSignal(rows) {
  const nums = rows
    .slice(0, 12)
    .map((x) => safeNumber(x.number))
    .filter(
      (n) =>
        Number.isInteger(n) &&
        n >= 0 &&
        n <= 9
    );

  if (!nums.length) {
    return {
      big: 0.5,
      small: 0.5,
      mean: null
    };
  }

  const mean =
    nums.reduce(
      (a, b) => a + b,
      0
    ) / nums.length;

  if (mean > 4.5) {
    return {
      big: 0.58,
      small: 0.42,
      mean
    };
  }

  if (mean < 4.5) {
    return {
      big: 0.42,
      small: 0.58,
      mean
    };
  }

  return {
    big: 0.5,
    small: 0.5,
    mean
  };
}


/* =========================================================
   MODEL
========================================================= */

function calculateModel(rows) {
  const r = getResults(rows, 50);

  if (r.length < 5) {
    return {
      prediction: null,
      confidence: 0,
      reason: "Need more settled history",
      modelVersion: "DY-AI-V2"
    };
  }

  const w5 = ratioSignal(rows, 5);
  const w10 = ratioSignal(rows, 10);
  const w20 = ratioSignal(rows, 20);
  const w30 = ratioSignal(rows, 30);

  const transition =
    transitionSignal(rows);

  const alternation =
    alternationSignal(rows);

  const trend =
    trendSignal(rows);

  const mean =
    meanNumberSignal(rows);

  const streak =
    getStreak(rows);

  /*
    Ensemble weights.
  */
  let big =
    w5.big * 0.25 +
    w10.big * 0.20 +
    w20.big * 0.15 +
    w30.big * 0.10 +
    transition.big * 0.15 +
    mean.big * 0.10 +
    0.05;

  let small =
    w5.small * 0.25 +
    w10.small * 0.20 +
    w20.small * 0.15 +
    w30.small * 0.10 +
    transition.small * 0.15 +
    mean.small * 0.10 +
    0.05;

  /*
    Trend confirmation.
  */
  if (trend.side === "BIG") {
    big += 0.07 * trend.strength;
  }

  if (trend.side === "SMALL") {
    small += 0.07 * trend.strength;
  }

  /*
    Alternating pattern ko limited weight.
  */
  if (
    alternation.next === "BIG"
  ) {
    big +=
      0.05 *
      Math.min(
        1,
        alternation.strength
      );
  }

  if (
    alternation.next === "SMALL"
  ) {
    small +=
      0.05 *
      Math.min(
        1,
        alternation.strength
      );
  }

  /*
    Long streak ko blindly reverse nahi karna.
    Sirf confidence ko dampen karna.
  */
  if (streak.length >= 4) {
    if (streak.side === "BIG") {
      big *= 0.92;
    }

    if (streak.side === "SMALL") {
      small *= 0.92;
    }
  }

  /*
    Normalize.
  */
  const total =
    big + small || 1;

  big /= total;
  small /= total;

  const prediction =
    big >= small
      ? "BIG"
      : "SMALL";

  const edge =
    Math.abs(big - small);

  let confidence =
    Math.round(
      50 + edge * 100
    );

  confidence =
    Math.max(
      50,
      Math.min(
        89,
        confidence
      )
    );

  const reasonParts = [];

  if (trend.side) {
    reasonParts.push(
      `trend ${trend.side}`
    );
  }

  if (streak.length >= 3) {
    reasonParts.push(
      `${streak.side} streak ${streak.length}`
    );
  }

  if (alternation.next) {
    reasonParts.push(
      "alternation checked"
    );
  }

  if (mean.mean !== null) {
    reasonParts.push(
      `mean ${mean.mean.toFixed(2)}`
    );
  }

  if (!reasonParts.length) {
    reasonParts.push(
      "multi-window sequence analysis"
    );
  }

  return {
    prediction,
    confidence,
    reason:
      reasonParts.join(" · "),
    modelVersion: "DY-AI-V2"
  };
}


/* =========================================================
   GENERATE / SAVE PREDICTION
========================================================= */

function generatePrediction() {
  const target =
    resolveTargetIssue();

  if (!target) return null;

  if (
    modelCache.targetIssue === target &&
    modelCache.prediction
  ) {
    return modelCache;
  }

  const model =
    calculateModel(
      providerState.history
    );

  if (!model.prediction) {
    modelCache = {
      targetIssue: target,
      prediction: null,
      confidence: 0,
      reason: model.reason,
      modelVersion: model.modelVersion,
      generatedAt: now()
    };

    return modelCache;
  }

  modelCache = {
    targetIssue: target,
    prediction: model.prediction,
    confidence: model.confidence,
    reason: model.reason,
    modelVersion: model.modelVersion,
    generatedAt: now()
  };

  savePrediction(
    modelCache
  ).catch((error) => {
    console.error(
      "Prediction save error:",
      error.message
    );
  });

  return modelCache;
}

async function savePrediction(prediction) {
  if (!pool) return;

  if (
    !prediction?.targetIssue ||
    !prediction?.prediction
  ) {
    return;
  }

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
    `,
    [
      prediction.targetIssue,
      prediction.prediction,
      prediction.confidence,
      prediction.modelVersion,
      now()
    ]
  );
}


/* =========================================================
   SETTLEMENT
========================================================= */

async function settlePredictions(history) {
  if (!pool) return;

  if (!Array.isArray(history)) return;

  for (const row of history) {
    const issue =
      row?.issueNumber;

    const actual =
      normalizeResult(row);

    if (!issue || !actual) {
      /*
        Pending / invalid rows ko WIN/LOSS nahi banayenge.
      */
      continue;
    }

    const actualNumber =
      safeNumber(row.number);

    await pool.query(
      `
      UPDATE prediction_records
      SET
        actual_number = $1,
        actual_result = $2,
        settled_at = $3
      WHERE target_issue = $4
        AND actual_result IS NULL
      `,
      [
        actualNumber,
        actual,
        now(),
        issue
      ]
    );
  }
}


/* =========================================================
   ACCESS KEY
========================================================= */

async function validateAccessKey(
  accessKey,
  deviceId
) {
  if (!pool) {
    return {
      ok: true,
      mode: "database-not-configured"
    };
  }

  if (!accessKey) {
    return {
      ok: false,
      error: "Access key required"
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
      error: "Invalid access key"
    };
  }

  const row =
    result.rows[0];

  /*
    First device automatically bind.
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
        deviceId || null,
        now(),
        row.id
      ]
    );

    return {
      ok: true,
      bound: true
    };
  }

  /*
    Existing key + no device ID supplied.
  */
  if (!deviceId) {
    return {
      ok: false,
      error: "Device ID required"
    };
  }

  /*
    One key = one browser/device.
  */
  if (
    String(row.device_id) !==
    String(deviceId)
  ) {
    return {
      ok: false,
      error:
        "This key is already linked to another device"
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
    ok: true
  };
}


/* =========================================================
   ADMIN AUTH
========================================================= */

function adminAuthorized(req) {
  if (!ADMIN_KEY) {
    return false;
  }

  const supplied =
    String(
      req.headers["x-admin-key"] ||
      ""
    ).trim();

  return (
    supplied &&
    supplied === ADMIN_KEY
  );
}


/* =========================================================
   BODY PARSER
========================================================= */

function readBody(req) {
  return new Promise(
    (resolve, reject) => {
      let body = "";

      req.on("data", (chunk) => {
        body += chunk;

        if (body.length > 1024 * 1024) {
          req.destroy();

          reject(
            new Error(
              "Request body too large"
            )
          );
        }
      });

      req.on("end", () => {
        if (!body) {
          resolve({});
          return;
        }

        try {
          resolve(
            JSON.parse(body)
          );
        } catch {
          reject(
            new Error(
              "Invalid JSON body"
            )
          );
        }
      });

      req.on("error", reject);
    }
  );
}


/* =========================================================
   ADMIN API
========================================================= */

async function adminKeys(req, res, url) {
  if (!adminAuthorized(req)) {
    json(res, 401, {
      ok: false,
      error: "Unauthorized"
    });
    return;
  }

  if (!pool) {
    json(res, 500, {
      ok: false,
      error:
        "DATABASE_URL not configured"
    });
    return;
  }

  if (
    req.method === "GET"
  ) {
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

    json(res, 200, {
      ok: true,
      keys: result.rows
    });

    return;
  }

  if (
    req.method === "POST"
  ) {
    const body =
      await readBody(req);

    let key =
      String(
        body.key ||
        body.access_key ||
        ""
      ).trim();

    if (!key) {
      key =
        "DY-" +
        Math.random()
          .toString(36)
          .slice(2, 12)
          .toUpperCase();
    }

    try {
      const result =
        await pool.query(
          `
          INSERT INTO access_keys
          (
            access_key,
            created_at
          )
          VALUES ($1,$2)
          RETURNING *
          `,
          [key, now()]
        );

      json(res, 200, {
        ok: true,
        key: result.rows[0]
      });
    } catch (error) {
      if (
        error.code === "23505"
      ) {
        json(res, 409, {
          ok: false,
          error: "Key already exists"
        });
        return;
      }

      throw error;
    }

    return;
  }

  if (
    req.method === "DELETE"
  ) {
    const id =
      url.searchParams.get("id");

    const key =
      url.searchParams.get("key");

    if (!id && !key) {
      json(res, 400, {
        ok: false,
        error:
          "id or key required"
      });
      return;
    }

    if (id) {
      await pool.query(
        `
        DELETE FROM access_keys
        WHERE id = $1
        `,
        [id]
      );
    } else {
      await pool.query(
        `
        DELETE FROM access_keys
        WHERE access_key = $1
        `,
        [key]
      );
    }

    json(res, 200, {
      ok: true
    });

    return;
  }

  json(res, 405, {
    ok: false,
    error: "Method not allowed"
  });
}


/* =========================================================
   RESET DEVICE
========================================================= */

async function resetDevice(req, res) {
  if (!adminAuthorized(req)) {
    json(res, 401, {
      ok: false,
      error: "Unauthorized"
    });
    return;
  }

  if (!pool) {
    json(res, 500, {
      ok: false,
      error:
        "DATABASE_URL not configured"
    });
    return;
  }

  const body =
    await readBody(req);

  const id =
    body.id;

  const key =
    String(
      body.key ||
      body.access_key ||
      ""
    ).trim();

  if (!id && !key) {
    json(res, 400, {
      ok: false,
      error:
        "id or key required"
    });
    return;
  }

  if (id) {
    await pool.query(
      `
      UPDATE access_keys
      SET
        device_id = NULL,
        last_seen = 0
      WHERE id = $1
      `,
      [id]
    );
  } else {
    await pool.query(
      `
      UPDATE access_keys
      SET
        device_id = NULL,
        last_seen = 0
      WHERE access_key = $1
      `,
      [key]
    );
  }

  json(res, 200, {
    ok: true,
    message:
      "Device binding reset"
  });
}


/* =========================================================
   ADMIN STATUS
========================================================= */

async function adminStatus(req, res) {
  if (!adminAuthorized(req)) {
    json(res, 401, {
      ok: false,
      error: "Unauthorized"
    });
    return;
  }

  let db = false;

  if (pool) {
    try {
      await pool.query(
        "SELECT 1"
      );
      db = true;
    } catch {
      db = false;
    }
  }

  json(res, 200, {
    ok: true,
    server: true,
    database: db,
    wingobot:
      Boolean(WINGOBOT_TOKEN),
    provider:
      providerState.ok,
    currentIssue:
      providerState.currentIssue,
    historyCount:
      providerState.history.length,
    targetIssue:
      resolveTargetIssue(),
    model:
      modelCache
  });
}


/* =========================================================
   ACCESS CHECK API
========================================================= */

async function keyCheck(req, res) {
  const accessKey =
    String(
      req.headers["x-access-key"] ||
      ""
    ).trim();

  const deviceId =
    String(
      req.headers["x-device-id"] ||
      ""
    ).trim();

  try {
    const result =
      await validateAccessKey(
        accessKey,
        deviceId
      );

    json(res, 200, result);
  } catch (error) {
    json(res, 500, {
      ok: false,
      error:
        error.message
    });
  }
}


/* =========================================================
   MAIN STATE API
========================================================= */

async function stateApi(req, res) {
  const accessKey =
    String(
      req.headers["x-access-key"] ||
      ""
    ).trim();

  const deviceId =
    String(
      req.headers["x-device-id"] ||
      ""
    ).trim();

  try {
    const auth =
      await validateAccessKey(
        accessKey,
        deviceId
      );

    if (!auth.ok) {
      json(res, 403, auth);
      return;
    }

    const target =
      resolveTargetIssue();

    const prediction =
      target
        ? (
            modelCache.targetIssue === target
              ? modelCache
              : generatePrediction()
          )
        : null;

    json(res, 200, {
      ok: true,

      provider: {
        connected:
          providerState.ok,

        currentIssue:
          providerState.currentIssue,

        fetched:
          providerState.fetched,

        lastUpdated:
          providerState.lastUpdated,

        fetchedAt:
          providerState.fetchedAt,

        error:
          providerState.error
      },

      targetIssue:
        target,

      prediction:
        prediction
          ? {
              targetIssue:
                prediction.targetIssue,

              prediction:
                prediction.prediction,

              confidence:
                prediction.confidence,

              reason:
                prediction.reason,

              modelVersion:
                prediction.modelVersion,

              generatedAt:
                prediction.generatedAt
            }
          : null,

      history:
        providerState.history
          .slice(0, 30)
          .map((row) => ({
            issueNumber:
              row.issueNumber,

            number:
              row.number,

            result:
              row.result,

            colour:
              row.colour,

            premium:
              row.premium,

            sum:
              row.sum
          }))
    });
  } catch (error) {
    json(res, 500, {
      ok: false,
      error:
        error.message
    });
  }
}


/* =========================================================
   HISTORY API
========================================================= */

async function historyApi(req, res) {
  if (!pool) {
    json(res, 200, {
      ok: true,
      history: []
    });
    return;
  }

  try {
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
          created_at,
          settled_at
        FROM prediction_records
        ORDER BY created_at DESC
        LIMIT 30
        `
      );

    json(res, 200, {
      ok: true,
      history:
        result.rows
    });
  } catch (error) {
    json(res, 500, {
      ok: false,
      error:
        error.message
    });
  }
}


/* =========================================================
   ADMIN PING
========================================================= */

async function adminPing(req, res) {
  if (!adminAuthorized(req)) {
    json(res, 401, {
      ok: false,
      error: "Unauthorized"
    });
    return;
  }

  json(res, 200, {
    ok: true,
    message: "PONG",
    time: now()
  });
}


/* =========================================================
   ADMIN WINGO TEST
========================================================= */

async function adminWingoTest(req, res) {
  if (!adminAuthorized(req)) {
    json(res, 401, {
      ok: false,
      error: "Unauthorized"
    });
    return;
  }

  try {
    await refreshProvider();

    json(res, 200, {
      ok: providerState.ok,
      currentIssue:
        providerState.currentIssue,
      historyCount:
        providerState.history.length,
      error:
        providerState.error
    });
  } catch (error) {
    json(res, 500, {
      ok: false,
      error:
        error.message
    });
  }
}


/* =========================================================
   ADMIN MODEL TEST
========================================================= */

async function adminModelTest(req, res) {
  if (!adminAuthorized(req)) {
    json(res, 401, {
      ok: false,
      error: "Unauthorized"
    });
    return;
  }

  const result =
    calculateModel(
      providerState.history
    );

  json(res, 200, {
    ok: true,
    targetIssue:
      resolveTargetIssue(),
    model:
      result
  });
}


/* =========================================================
   STATIC FILE SERVER
========================================================= */

function contentType(file) {
  const ext =
    path.extname(file)
      .toLowerCase();

  const types = {
    ".html":
      "text/html",
    ".css":
      "text/css",
    ".js":
      "application/javascript",
    ".json":
      "application/json",
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
    ".mp3":
      "audio/mpeg",
    ".wav":
      "audio/wav",
    ".webp":
      "image/webp"
  };

  return (
    types[ext] ||
    "application/octet-stream"
  );
}

function serveStatic(req, res, pathname) {
  let requested =
    pathname === "/"
      ? "/prediction.html"
      : pathname;

  /*
    Basic path traversal protection.
  */
  requested =
    decodeURIComponent(requested);

  const filePath =
    path.normalize(
      path.join(
        PUBLIC_DIR,
        requested
      )
    );

  if (
    !filePath.startsWith(
      PUBLIC_DIR
    )
  ) {
    text(
      res,
      403,
      "Forbidden"
    );
    return;
  }

  fs.stat(
    filePath,
    (error, stat) => {
      if (error || !stat.isFile()) {
        text(
          res,
          404,
          "Not Found"
        );
        return;
      }

      const type =
        contentType(filePath);

      /*
        MP3 range support.
      */
      if (
        type === "audio/mpeg" &&
        req.headers.range
      ) {
        const range =
          req.headers.range;

        const match =
          /bytes=(\d*)-(\d*)/.exec(
            range
          );

        if (!match) {
          text(
            res,
            416,
            "Invalid range"
          );
          return;
        }

        const fileSize =
          stat.size;

        let start =
          match[1]
            ? Number(match[1])
            : 0;

        let end =
          match[2]
            ? Number(match[2])
            : fileSize - 1;

        if (
          start < 0 ||
          start >= fileSize ||
          end < start
        ) {
          res.writeHead(416, {
            "Content-Range":
              `bytes */${fileSize}`
          });

          res.end();
          return;
        }

        end =
          Math.min(
            end,
            fileSize - 1
          );

        const chunkSize =
          end - start + 1;

        res.writeHead(206, {
          "Content-Type":
            type,
          "Content-Length":
            chunkSize,
          "Content-Range":
            `bytes ${start}-${end}/${fileSize}`,
          "Accept-Ranges":
            "bytes",
          "Cache-Control":
            "public, max-age=3600"
        });

        fs.createReadStream(
          filePath,
          {
            start,
            end
          }
        ).pipe(res);

        return;
      }

      res.writeHead(200, {
        "Content-Type":
          `${type}; charset=utf-8`,
        "Cache-Control":
          type === "text/html"
            ? "no-store"
            : "public, max-age=3600",
        "Accept-Ranges":
          type === "audio/mpeg"
            ? "bytes"
            : undefined
      });

      fs.createReadStream(
        filePath
      ).pipe(res);
    }
  );
}


/* =========================================================
   HTTP SERVER
========================================================= */

const server =
  http.createServer(
    async (req, res) => {
      try {
        if (
          req.method === "OPTIONS"
        ) {
          res.writeHead(204, {
            "Access-Control-Allow-Origin":
              "*",
            "Access-Control-Allow-Headers":
              "Content-Type, X-Access-Key, X-Device-Id, X-Admin-Key, Authorization",
            "Access-Control-Allow-Methods":
              "GET, POST, DELETE, OPTIONS"
          });

          res.end();
          return;
        }

        const url =
          new URL(
            req.url,
            `http://${req.headers.host || "localhost"}`
          );

        const pathname =
          url.pathname;

        /*
          HEALTH
        */
        if (
          pathname === "/health"
        ) {
          json(res, 200, {
            ok: true,
            service:
              "DY AI Wingo",
            uptime:
              process.uptime(),
            time:
              now()
          });

          return;
        }

        /*
          KEY CHECK
        */
        if (
          pathname ===
          "/api/key/check" &&
          req.method === "GET"
        ) {
          await keyCheck(
            req,
            res
          );
          return;
        }

        /*
          STATE
        */
        if (
          pathname ===
          "/api/state" &&
          req.method === "GET"
        ) {
          await stateApi(
            req,
            res
          );
          return;
        }

        /*
          HISTORY
        */
        if (
          pathname ===
          "/api/history" &&
          req.method === "GET"
        ) {
          await historyApi(
            req,
            res
          );
          return;
        }

        /*
          ADMIN KEYS
        */
        if (
          pathname ===
          "/api/admin/keys"
        ) {
          await adminKeys(
            req,
            res,
            url
          );
          return;
        }

        /*
          ADMIN RESET DEVICE
        */
        if (
          pathname ===
          "/api/admin/reset-device" &&
          req.method === "POST"
        ) {
          await resetDevice(
            req,
            res
          );
          return;
        }

        /*
          ADMIN STATUS
        */
        if (
          pathname ===
          "/api/admin/status" &&
          req.method === "GET"
        ) {
          await adminStatus(
            req,
            res
          );
          return;
        }

        /*
          ADMIN PING
        */
        if (
          pathname ===
          "/api/admin/ping" &&
          req.method === "GET"
        ) {
          await adminPing(
            req,
            res
          );
          return;
        }

        /*
          ADMIN WINGO TEST
        */
        if (
          pathname ===
          "/api/admin/wingo-test" &&
          req.method === "GET"
        ) {
          await adminWingoTest(
            req,
            res
          );
          return;
        }

        /*
          ADMIN MODEL TEST
        */
        if (
          pathname ===
          "/api/admin/model-test" &&
          req.method === "GET"
        ) {
          await adminModelTest(
            req,
            res
          );
          return;
        }

        /*
          STATIC
        */
        serveStatic(
          req,
          res,
          pathname
        );
      } catch (error) {
        console.error(
          "Server request error:",
          error
        );

        json(res, 500, {
          ok: false,
          error:
            "Internal server error"
        });
      }
    }
  );


/* =========================================================
   STARTUP
========================================================= */

async function start() {
  try {
    await initDatabase();

    server.listen(
      PORT,
      HOST,
      () => {
        console.log(
          `DY AI server running on port ${PORT}`
        );

        console.log(
          `WingoBot token: ${
            WINGOBOT_TOKEN
              ? "configured"
              : "missing"
          }`
        );

        console.log(
          `Database: ${
            pool
              ? "configured"
              : "missing"
          }`
        );
      }
    );

    /*
      Initial provider fetch.
    */
    await refreshProvider();

    /*
      Refresh every 3 seconds.
    */
    setInterval(
      () => {
        refreshProvider().catch(
          (error) => {
            console.error(
              "Refresh loop:",
              error.message
            );
          }
        );
      },
      3000
    );
  } catch (error) {
    console.error(
      "Startup error:",
      error
    );

    /*
      Server ko unnecessary crash se bachane ke liye
      process ko turant exit nahi karte.
    */
    if (!server.listening) {
      server.listen(
        PORT,
        HOST,
        () => {
          console.log(
            `DY AI server running on port ${PORT}`
          );
        }
      );
    }
  }
}

process.on(
  "unhandledRejection",
  (error) => {
    console.error(
      "Unhandled rejection:",
      error
    );
  }
);

process.on(
  "uncaughtException",
  (error) => {
    console.error(
      "Uncaught exception:",
      error
    );
  }
);

start();
