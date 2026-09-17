"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const { Pool } = require("pg");

/* =========================================================
   CONFIG
========================================================= */

const PORT = Number(process.env.PORT || 10000);

const ADMIN_KEY =
  String(process.env.ADMIN_KEY || "dy4427574").trim();

const DEFAULT_ACCESS_KEY =
  String(process.env.DEFAULT_ACCESS_KEY || "DY-JPMSUULN").trim();

const WINGOBOT_URL =
  "https://api.wingobot.com/v2/1-min-game-history";

const MODEL_VERSION =
  String(process.env.MODEL || "DY-AI-1MIN-V4").trim();

const POLL_MS =
  Math.max(1000, Number(process.env.POLL || 5000));

const COOLDOWN =
  Math.max(0, Number(process.env.COOLDOWN || 5));

/*
  IMPORTANT:
  Token must be stored in Render Environment Variables.

  The cleanup below also removes accidental:
  - spaces
  - quotes
  - "Bearer "
*/
function cleanToken(value) {
  let token = String(value || "").trim();

  token = token
    .replace(/^Bearer\s+/i, "")
    .trim();

  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    token = token.slice(1, -1).trim();
  }

  token = token.replace(/\r/g, "").replace(/\n/g, "").trim();

  return token;
}

const WINGOBOT_TOKEN = cleanToken(
  process.env.WINGOBOT_TOKEN
);

/* =========================================================
   DATABASE
========================================================= */

let pool = null;
let databaseEnabled = false;

if (process.env.DATABASE_URL) {
  try {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: {
        rejectUnauthorized: false
      }
    });

    databaseEnabled = true;
  } catch (err) {
    console.error("[DB INIT ERROR]", err.message);
  }
}

/* =========================================================
   MEMORY FALLBACK
========================================================= */

const memory = {
  keys: new Map(),
  predictions: []
};

function now() {
  return Date.now();
}

function randomKey() {
  return (
    "DY-" +
    crypto
      .randomBytes(6)
      .toString("hex")
      .toUpperCase()
  );
}

/* =========================================================
   DATABASE INIT
========================================================= */

async function initDatabase() {
  if (!pool) return;

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

  const result = await pool.query(
    `SELECT id FROM access_keys WHERE access_key = $1 LIMIT 1`,
    [DEFAULT_ACCESS_KEY]
  );

  if (result.rowCount === 0) {
    await pool.query(
      `
      INSERT INTO access_keys
      (access_key, device_id, created_at, last_seen)
      VALUES ($1, NULL, $2, 0)
      `,
      [DEFAULT_ACCESS_KEY, now()]
    );
  }
}

/* =========================================================
   KEY HELPERS
========================================================= */

async function getKey(accessKey) {
  if (!accessKey) return null;

  if (pool) {
    const r = await pool.query(
      `
      SELECT *
      FROM access_keys
      WHERE access_key = $1
      LIMIT 1
      `,
      [accessKey]
    );

    return r.rows[0] || null;
  }

  return memory.keys.get(accessKey) || null;
}

async function createKey(accessKey) {
  const key = accessKey || randomKey();

  if (pool) {
    const r = await pool.query(
      `
      INSERT INTO access_keys
      (access_key, device_id, created_at, last_seen)
      VALUES ($1, NULL, $2, 0)
      ON CONFLICT (access_key)
      DO NOTHING
      RETURNING *
      `,
      [key, now()]
    );

    if (r.rowCount > 0) return r.rows[0];

    return await getKey(key);
  }

  if (!memory.keys.has(key)) {
    memory.keys.set(key, {
      id: memory.keys.size + 1,
      access_key: key,
      device_id: null,
      created_at: now(),
      last_seen: 0
    });
  }

  return memory.keys.get(key);
}

async function touchKey(accessKey, deviceId) {
  const key = await getKey(accessKey);

  if (!key) {
    return {
      ok: false,
      error: "Invalid access key"
    };
  }

  if (key.device_id && key.device_id !== deviceId) {
    return {
      ok: false,
      error: "This key is already linked to another device"
    };
  }

  if (pool) {
    if (!key.device_id) {
      await pool.query(
        `
        UPDATE access_keys
        SET device_id = $1,
            last_seen = $2
        WHERE access_key = $3
        `,
        [deviceId, now(), accessKey]
      );
    } else {
      await pool.query(
        `
        UPDATE access_keys
        SET last_seen = $1
        WHERE access_key = $2
        `,
        [now(), accessKey]
      );
    }
  } else {
    key.device_id = key.device_id || deviceId;
    key.last_seen = now();
  }

  return {
    ok: true,
    key
  };
}

/* =========================================================
   PREDICTION DATABASE
========================================================= */

async function savePrediction(record) {
  if (pool) {
    const r = await pool.query(
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
        record.target_issue,
        record.prediction,
        record.confidence,
        record.model_version,
        record.created_at
      ]
    );

    return r.rows[0];
  }

  memory.predictions.unshift({
    id: memory.predictions.length + 1,
    ...record
  });

  memory.predictions =
    memory.predictions.slice(0, 500);

  return memory.predictions[0];
}

async function getPredictionForIssue(issue) {
  if (pool) {
    const r = await pool.query(
      `
      SELECT *
      FROM prediction_records
      WHERE target_issue = $1
      ORDER BY id DESC
      LIMIT 1
      `,
      [issue]
    );

    return r.rows[0] || null;
  }

  return (
    memory.predictions.find(
      x => String(x.target_issue) === String(issue)
    ) || null
  );
}

async function settlePrediction(issue, number) {
  const result =
    number >= 5 ? "BIG" : "SMALL";

  if (pool) {
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
        number,
        result,
        now(),
        issue
      ]
    );

    return;
  }

  for (const p of memory.predictions) {
    if (
      String(p.target_issue) === String(issue) &&
      p.actual_result == null
    ) {
      p.actual_number = number;
      p.actual_result = result;
      p.settled_at = now();
    }
  }
}

/* =========================================================
   WINGOBOT LIVE DATA
========================================================= */

const live = {
  ok: false,
  currentIssue: null,
  history: [],
  fetched: null,
  updated: null,
  error: null,
  lastFetch: 0
};

function resultType(number) {
  const n = Number(number);

  if (!Number.isFinite(n)) {
    return null;
  }

  return n >= 5 ? "BIG" : "SMALL";
}

function normalizeHistory(rows) {
  if (!Array.isArray(rows)) return [];

  return rows
    .map(row => {
      const number = Number(row.number);

      if (!Number.isFinite(number)) {
        return null;
      }

      return {
        issueNumber: String(
          row.issueNumber ?? ""
        ),

        number,

        result: resultType(number),

        colour: row.colour ?? null,

        premium: row.premium ?? null,

        sum: row.sum ?? null
      };
    })
    .filter(Boolean);
}

async function fetchWingo() {
  if (!WINGOBOT_TOKEN) {
    throw new Error(
      "WINGOBOT_TOKEN environment variable is missing"
    );
  }

  const headers = {
    "Authorization": `Bearer ${WINGOBOT_TOKEN}`,
    "Accept": "application/json"
  };

  const controller =
    new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    15000
  );

  try {
    const response = await fetch(
      WINGOBOT_URL,
      {
        method: "GET",
        headers,
        signal: controller.signal
      }
    );

    const text = await response.text();

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(
        `WingoBot returned non-JSON response. HTTP ${response.status}`
      );
    }

    if (!response.ok) {
      throw new Error(
        `WingoBot HTTP ${response.status}: ${
          data.error ||
          data.message ||
          text.slice(0, 200)
        }`
      );
    }

    if (data.success !== true) {
      throw new Error(
        data.error ||
        data.message ||
        "WingoBot returned success=false"
      );
    }

    const currentIssue =
      data.current &&
      data.current.issueNumber != null
        ? String(data.current.issueNumber)
        : null;

    const history =
      normalizeHistory(data.history);

    if (!currentIssue) {
      throw new Error(
        "WingoBot response has no current.issueNumber"
      );
    }

    if (history.length === 0) {
      throw new Error(
        "WingoBot response has no usable history rows"
      );
    }

    return {
      currentIssue,
      history,
      fetched:
        data.stats?.fetched ?? history.length,
      updated:
        data.stats?.last_updated ?? null,
      raw: data
    };
  } finally {
    clearTimeout(timer);
  }
}

async function refreshLive() {
  try {
    const data = await fetchWingo();

    live.ok = true;
    live.currentIssue = data.currentIssue;
    live.history = data.history;
    live.fetched = data.fetched;
    live.updated = data.updated;
    live.error = null;
    live.lastFetch = now();

    console.log(
      `[WINGOBOT 1MIN] Issue: ${live.currentIssue} | Rows: ${live.history.length}`
    );

    await settleLatestPrediction();

  } catch (err) {
    live.ok = false;
    live.error = err.message;

    console.error(
      "[WINGOBOT ERROR]",
      err.message
    );
  }
}

/* =========================================================
   ISSUE HELPERS
========================================================= */

function nextIssue(issue) {
  const value = String(issue || "");

  if (/^\d+$/.test(value)) {
    try {
      return (
        BigInt(value) + 1n
      ).toString();
    } catch {
      return null;
    }
  }

  return null;
}

/* =========================================================
   ANALYSIS
========================================================= */

function calculateAnalysis(history) {
  const rows = Array.isArray(history)
    ? history.slice(0, 50)
    : [];

  if (rows.length === 0) {
    return {
      big: 0,
      small: 0,
      bigPercent: 0,
      smallPercent: 0,
      switchRate: 0,
      streak: null,
      streakCount: 0,
      recent: [],
      prediction: "SKIP",
      confidence: 0,
      reason: "Waiting for live data"
    };
  }

  const big =
    rows.filter(
      x => x.result === "BIG"
    ).length;

  const small =
    rows.filter(
      x => x.result === "SMALL"
    ).length;

  const total = rows.length;

  const bigPercent =
    Math.round(
      (big / total) * 1000
    ) / 10;

  const smallPercent =
    Math.round(
      (small / total) * 1000
    ) / 10;

  let switches = 0;

  for (let i = 0; i < rows.length - 1; i++) {
    if (
      rows[i].result !==
      rows[i + 1].result
    ) {
      switches++;
    }
  }

  const switchRate =
    rows.length > 1
      ? Math.round(
          (switches / (rows.length - 1)) *
            1000
        ) / 10
      : 0;

  const latest =
    rows[0]?.result || null;

  let streakCount = 0;

  for (const row of rows) {
    if (row.result === latest) {
      streakCount++;
    } else {
      break;
    }
  }

  /*
    Recent weighted analysis.
    This is statistical analysis only;
    it cannot guarantee the next result.
  */

  const sample =
    rows.slice(0, Math.min(12, rows.length));

  let bigScore = 0;
  let smallScore = 0;

  sample.forEach((row, index) => {
    const weight =
      sample.length - index;

    if (row.result === "BIG") {
      bigScore += weight;
    } else if (row.result === "SMALL") {
      smallScore += weight;
    }
  });

  /*
    Longer-term component.
  */

  if (bigPercent > 50) {
    bigScore += 2;
  }

  if (smallPercent > 50) {
    smallScore += 2;
  }

  /*
    Avoid blindly predicting the opposite
    merely because of a streak.
  */

  if (streakCount >= 4) {
    if (latest === "BIG") {
      smallScore += 1;
    } else {
      bigScore += 1;
    }
  }

  const difference =
    Math.abs(
      bigScore - smallScore
    );

  let prediction = "SKIP";

  if (sample.length >= 5) {
    if (bigScore > smallScore) {
      prediction = "BIG";
    } else if (smallScore > bigScore) {
      prediction = "SMALL";
    }
  }

  let confidence = 0;

  if (prediction !== "SKIP") {
    const totalScore =
      bigScore + smallScore;

    confidence =
      totalScore > 0
        ? Math.round(
            (difference / totalScore) *
              100
          )
        : 0;

    confidence = Math.max(
      50,
      Math.min(85, confidence + 50)
    );
  }

  const recent =
    rows
      .slice(0, 10)
      .map(x => x.result);

  return {
    big,
    small,
    bigPercent,
    smallPercent,
    switchRate,
    streak: latest,
    streakCount,
    recent,
    prediction,
    confidence,
    reason:
      prediction === "SKIP"
        ? "Insufficient statistical edge"
        : "Recent + historical distribution analysis"
  };
}

/* =========================================================
   AUTO PREDICTION
========================================================= */

async function generatePrediction() {
  if (
    !live.ok ||
    !live.currentIssue ||
    live.history.length < 5
  ) {
    return null;
  }

  const target =
    nextIssue(live.currentIssue);

  if (!target) {
    return null;
  }

  const existing =
    await getPredictionForIssue(target);

  if (existing) {
    return existing;
  }

  const analysis =
    calculateAnalysis(live.history);

  if (analysis.prediction === "SKIP") {
    return null;
  }

  const record = {
    target_issue: target,
    prediction: analysis.prediction,
    confidence: analysis.confidence,
    model_version: MODEL_VERSION,
    created_at: now()
  };

  const saved =
    await savePrediction(record);

  console.log(
    `[PREDICTION] ${target} -> ${analysis.prediction} (${analysis.confidence}%)`
  );

  return saved;
}

async function settleLatestPrediction() {
  if (!live.history.length) {
    return;
  }

  for (const row of live.history.slice(0, 10)) {
    if (!row.issueNumber) continue;

    await settlePrediction(
      row.issueNumber,
      row.number
    );
  }
}

/* =========================================================
   API JSON HELPERS
========================================================= */

function sendJson(res, status, data) {
  const body =
    JSON.stringify(data, null, 2);

  res.writeHead(status, {
    "Content-Type":
      "application/json; charset=utf-8",
    "Cache-Control":
      "no-store",
    "Access-Control-Allow-Origin":
      "*"
  });

  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    "Content-Type":
      "text/plain; charset=utf-8"
  });

  res.end(text);
}

/* =========================================================
   ADMIN AUTH
========================================================= */

function adminAuthorized(url) {
  const key =
    url.searchParams.get("key") || "";

  return key === ADMIN_KEY;
}

/* =========================================================
   STATE
========================================================= */

async function buildState(accessKey, deviceId) {
  const access =
    await touchKey(
      accessKey,
      deviceId
    );

  if (!access.ok) {
    return {
      ok: false,
      error: access.error
    };
  }

  const analysis =
    calculateAnalysis(
      live.history
    );

  const prediction =
    await generatePrediction();

  return {
    ok: true,

    game: "WINGO 1 MINUTE",

    live: live.ok,

    liveError: live.error,

    currentPeriod:
      live.currentIssue,

    nextPeriod:
      nextIssue(live.currentIssue),

    latestResult:
      live.history[0]
        ? {
            issueNumber:
              live.history[0].issueNumber,
            number:
              live.history[0].number,
            result:
              live.history[0].result
          }
        : null,

    prediction:
      prediction
        ? {
            targetPeriod:
              prediction.target_issue,

            result:
              prediction.prediction,

            confidence:
              Number(
                prediction.confidence || 0
              ),

            model:
              prediction.model_version,

            createdAt:
              prediction.created_at,

            actualNumber:
              prediction.actual_number,

            actualResult:
              prediction.actual_result,

            status:
              prediction.actual_result
                ? (
                    prediction.prediction ===
                    prediction.actual_result
                      ? "WIN"
                      : "LOSS"
                  )
                : "PENDING"
          }
        : null,

    analysis,

    recentResults:
      live.history
        .slice(0, 30)
        .map(x => ({
          issueNumber:
            x.issueNumber,
          number:
            x.number,
          result:
            x.result,
          colour:
            x.colour,
          premium:
            x.premium,
          sum:
            x.sum
        })),

    source: {
      provider: "WingoBot",
      endpoint: WINGOBOT_URL,
      fetched: live.fetched,
      updated: live.updated,
      lastFetch: live.lastFetch
    },

    model: MODEL_VERSION,

    serverTime: now()
  };
}

/* =========================================================
   ADMIN DATA
========================================================= */

async function listKeys() {
  if (pool) {
    const r = await pool.query(
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

    return r.rows;
  }

  return Array.from(
    memory.keys.values()
  ).sort(
    (a, b) => b.id - a.id
  );
}

async function resetDevice(accessKey) {
  if (pool) {
    await pool.query(
      `
      UPDATE access_keys
      SET device_id = NULL,
          last_seen = 0
      WHERE access_key = $1
      `,
      [accessKey]
    );

    return;
  }

  const key =
    memory.keys.get(accessKey);

  if (key) {
    key.device_id = null;
    key.last_seen = 0;
  }
}

async function deleteKey(accessKey) {
  if (pool) {
    await pool.query(
      `
      DELETE FROM access_keys
      WHERE access_key = $1
      `,
      [accessKey]
    );

    return;
  }

  memory.keys.delete(accessKey);
}

async function getPredictions() {
  if (pool) {
    const r = await pool.query(
      `
      SELECT *
      FROM prediction_records
      ORDER BY id DESC
      LIMIT 200
      `
    );

    return r.rows;
  }

  return memory.predictions.slice(
    0,
    200
  );
}

/* =========================================================
   STATIC FILE SERVER
========================================================= */

function serveFile(res, fileName) {
  const filePath =
    path.join(
      __dirname,
      fileName
    );

  if (!fs.existsSync(filePath)) {
    sendText(
      res,
      404,
      "File not found"
    );
    return;
  }

  const ext =
    path.extname(filePath)
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
    ".mp3":
      "audio/mpeg"
  };

  res.writeHead(200, {
    "Content-Type":
      types[ext] ||
      "application/octet-stream",
    "Cache-Control":
      "no-cache"
  });

  fs.createReadStream(
    filePath
  ).pipe(res);
}

/* =========================================================
   SERVER
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

        /* -------------------------
           HOME
        ------------------------- */

        if (
          url.pathname === "/" ||
          url.pathname === "/prediction.html"
        ) {
          return serveFile(
            res,
            "prediction.html"
          );
        }

        if (
          url.pathname === "/admin.html"
        ) {
          return serveFile(
            res,
            "admin.html"
          );
        }

        /* -------------------------
           HEALTH
        ------------------------- */

        if (
          url.pathname === "/health"
        ) {
          return sendJson(
            res,
            200,
            {
              ok: true,

              game:
                "WINGO 1 MINUTE",

              model:
                MODEL_VERSION,

              database:
                databaseEnabled,

              databaseMode:
                databaseEnabled
                  ? "POSTGRESQL"
                  : "MEMORY",

              wingoBot:
                live.ok,

              source:
                WINGOBOT_URL,

              currentIssue:
                live.currentIssue,

              resultCount:
                live.history.length,

              liveError:
                live.error,

              tokenConfigured:
                Boolean(
                  WINGOBOT_TOKEN
                ),

              time:
                new Date().toISOString()
            }
          );
        }

        /* -------------------------
           ACCESS KEY CHECK
        ------------------------- */

        if (
          url.pathname ===
            "/api/key/check" &&
          req.method === "GET"
        ) {
          const key =
            url.searchParams.get(
              "key"
            );

          const device =
            url.searchParams.get(
              "device"
            );

          const result =
            await touchKey(
              key,
              device
            );

          return sendJson(
            res,
            result.ok ? 200 : 403,
            result
          );
        }

        /* -------------------------
           LIVE STATE
        ------------------------- */

        if (
          url.pathname ===
            "/api/state" &&
          req.method === "GET"
        ) {
          const key =
            url.searchParams.get(
              "key"
            ) || DEFAULT_ACCESS_KEY;

          const device =
            url.searchParams.get(
              "device"
            ) || "unknown-device";

          const state =
            await buildState(
              key,
              device
            );

          return sendJson(
            res,
            state.ok ? 200 : 403,
            state
          );
        }

        /* -------------------------
           ADMIN STATUS
        ------------------------- */

        if (
          url.pathname ===
            "/api/admin/status" &&
          req.method === "GET"
        ) {
          if (!adminAuthorized(url)) {
            return sendJson(
              res,
              401,
              {
                ok: false,
                error:
                  "Unauthorized"
              }
            );
          }

          return sendJson(
            res,
            200,
            {
              ok: true,
              game:
                "WINGO 1 MINUTE",
              model:
                MODEL_VERSION,
              live,
              database:
                databaseEnabled,
              databaseMode:
                databaseEnabled
                  ? "POSTGRESQL"
                  : "MEMORY",
              tokenConfigured:
                Boolean(
                  WINGOBOT_TOKEN
                )
            }
          );
        }

        /* -------------------------
           ADMIN LIVE TEST
        ------------------------- */

        if (
          url.pathname ===
            "/api/admin/live-test" &&
          req.method === "GET"
        ) {
          if (!adminAuthorized(url)) {
            return sendJson(
              res,
              401,
              {
                ok: false,
                error:
                  "Unauthorized"
              }
            );
          }

          let direct = null;
          let directError = null;

          try {
            direct =
              await fetchWingo();
          } catch (err) {
            directError =
              err.message;
          }

          return sendJson(
            res,
            200,
            {
              ok: true,

              endpoint:
                WINGOBOT_URL,

              tokenConfigured:
                Boolean(
                  WINGOBOT_TOKEN
                ),

              liveCache:
                {
                  ok: live.ok,
                  error: live.error,
                  currentIssue:
                    live.currentIssue,
                  resultCount:
                    live.history.length
                },

              directTest:
                direct
                  ? {
                      success: true,
                      currentIssue:
                        direct.currentIssue,
                      count:
                        direct.history.length,
                      fetched:
                        direct.fetched,
                      updated:
                        direct.updated,
                      history:
                        direct.history
                    }
                  : {
                      success: false,
                      error:
                        directError
                    }
            }
          );
        }

        /* -------------------------
           ADMIN MODEL TEST
        ------------------------- */

        if (
          url.pathname ===
            "/api/admin/model-test" &&
          req.method === "GET"
        ) {
          if (!adminAuthorized(url)) {
            return sendJson(
              res,
              401,
              {
                ok: false,
                error:
                  "Unauthorized"
              }
            );
          }

          return sendJson(
            res,
            200,
            {
              ok: true,
              model:
                MODEL_VERSION,
              analysis:
                calculateAnalysis(
                  live.history
                )
            }
          );
        }

        /* -------------------------
           ADMIN KEYS GET
        ------------------------- */

        if (
          url.pathname ===
            "/api/admin/keys" &&
          req.method === "GET"
        ) {
          if (!adminAuthorized(url)) {
            return sendJson(
              res,
              401,
              {
                ok: false,
                error:
                  "Unauthorized"
              }
            );
          }

          return sendJson(
            res,
            200,
            {
              ok: true,
              keys:
                await listKeys()
            }
          );
        }

        /* -------------------------
           ADMIN KEY CREATE
        ------------------------- */

        if (
          url.pathname ===
            "/api/admin/keys" &&
          req.method === "POST"
        ) {
          if (!adminAuthorized(url)) {
            return sendJson(
              res,
              401,
              {
                ok: false,
                error:
                  "Unauthorized"
              }
            );
          }

          let body = "";

          req.on(
            "data",
            chunk => {
              body += chunk;
            }
          );

          req.on(
            "end",
            async () => {
              try {
                const data =
                  body
                    ? JSON.parse(body)
                    : {};

                const custom =
                  String(
                    data.key || ""
                  ).trim();

                const created =
                  await createKey(
                    custom || null
                  );

                return sendJson(
                  res,
                  200,
                  {
                    ok: true,
                    key: created
                  }
                );
              } catch (err) {
                return sendJson(
                  res,
                  400,
                  {
                    ok: false,
                    error:
                      err.message
                  }
                );
              }
            }
          );

          return;
        }

        /* -------------------------
           ADMIN RESET DEVICE
        ------------------------- */

        if (
          url.pathname ===
            "/api/admin/reset-device" &&
          req.method === "POST"
        ) {
          if (!adminAuthorized(url)) {
            return sendJson(
              res,
              401,
              {
                ok: false,
                error:
                  "Unauthorized"
              }
            );
          }

          let body = "";

          req.on(
            "data",
            chunk => {
              body += chunk;
            }
          );

          req.on(
            "end",
            async () => {
              try {
                const data =
                  body
                    ? JSON.parse(body)
                    : {};

                await resetDevice(
                  String(
                    data.key || ""
                  ).trim()
                );

                return sendJson(
                  res,
                  200,
                  {
                    ok: true
                  }
                );
              } catch (err) {
                return sendJson(
                  res,
                  400,
                  {
                    ok: false,
                    error:
                      err.message
                  }
                );
              }
            }
          );

          return;
        }

        /* -------------------------
           ADMIN DELETE KEY
        ------------------------- */

        if (
          url.pathname ===
            "/api/admin/delete-key" &&
          req.method === "POST"
        ) {
          if (!adminAuthorized(url)) {
            return sendJson(
              res,
              401,
              {
                ok: false,
                error:
                  "Unauthorized"
              }
            );
          }

          let body = "";

          req.on(
            "data",
            chunk => {
              body += chunk;
            }
          );

          req.on(
            "end",
            async () => {
              try {
                const data =
                  body
                    ? JSON.parse(body)
                    : {};

                await deleteKey(
                  String(
                    data.key || ""
                  ).trim()
                );

                return sendJson(
                  res,
                  200,
                  {
                    ok: true
                  }
                );
              } catch (err) {
                return sendJson(
                  res,
                  400,
                  {
                    ok: false,
                    error:
                      err.message
                  }
                );
              }
            }
          );

          return;
        }

        /* -------------------------
           ADMIN PREDICTIONS
        ------------------------- */

        if (
          url.pathname ===
            "/api/admin/predictions" &&
          req.method === "GET"
        ) {
          if (!adminAuthorized(url)) {
            return sendJson(
              res,
              401,
              {
                ok: false,
                error:
                  "Unauthorized"
              }
            );
          }

          return sendJson(
            res,
            200,
            {
              ok: true,
              predictions:
                await getPredictions()
            }
          );
        }

        /* -------------------------
           404
        ------------------------- */

        return sendJson(
          res,
          404,
          {
            ok: false,
            error:
              "Not found"
          }
        );

      } catch (err) {
        console.error(
          "[SERVER ERROR]",
          err
        );

        return sendJson(
          res,
          500,
          {
            ok: false,
            error:
              err.message
          }
        );
      }
    }
  );

/* =========================================================
   STARTUP
========================================================= */

async function start() {
  try {
    await initDatabase();

    if (pool) {
      console.log(
        "[DATABASE] PostgreSQL enabled"
      );
    } else {
      console.log(
        "[DATABASE] Memory mode"
      );
    }

    await createKey(
      DEFAULT_ACCESS_KEY
    );

    await refreshLive();

    setInterval(
      refreshLive,
      POLL_MS
    );

    server.listen(
      PORT,
      "0.0.0.0",
      () => {
        console.log(
          "========================================"
        );

        console.log(
          " DY AI WINGO 1 MINUTE"
        );

        console.log(
          ` PORT: ${PORT}`
        );

        console.log(
          ` MODEL: ${MODEL_VERSION}`
        );

        console.log(
          ` WINGOBOT TOKEN: ${
            WINGOBOT_TOKEN
              ? "CONFIGURED"
              : "MISSING"
          }`
        );

        console.log(
          ` DATABASE: ${
            databaseEnabled
              ? "POSTGRESQL"
              : "MEMORY"
          }`
        );

        console.log(
          "========================================"
        );
      }
    );

  } catch (err) {
    console.error(
      "[STARTUP ERROR]",
      err
    );

    process.exit(1);
  }
}

start();
