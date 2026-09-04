"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
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

const GAME_URL =
  "https://www.shreewin38.com/#/register?invitationCode=88523152383";

const WINGOBOT_URL =
  "https://api.wingobot.com/v2/30-sec-game-history";

const ROOT = __dirname;

/* =========================================================
   BASIC VALIDATION
========================================================= */

console.log("======================================");
console.log("DY AI WINGO SERVER");
console.log("Node:", process.version);
console.log("Port:", PORT);
console.log("DATABASE_URL:", DATABASE_URL ? "FOUND" : "MISSING");
console.log("WINGOBOT_TOKEN:", WINGOBOT_TOKEN ? "FOUND" : "MISSING");
console.log("ADMIN_KEY:", ADMIN_KEY ? "FOUND" : "MISSING");
console.log("======================================");

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

  pool.on("error", (err) => {
    console.error("[DB POOL ERROR]", err.message);
  });
} else {
  console.warn(
    "[DB] DATABASE_URL missing. Server will continue in limited mode."
  );
}

/* =========================================================
   MEMORY CACHE
========================================================= */

let liveState = {
  ok: false,
  provider: "WingoBot",
  gameUrl: GAME_URL,
  currentIssue: null,
  latestSettledIssue: null,
  targetIssue: null,
  history: [],
  fetched: 0,
  lastUpdated: 0,
  serverTime: Date.now(),
  error: null
};

let lastProviderFetch = 0;
let lastProviderError = null;

/* =========================================================
   DATABASE INITIALIZATION
========================================================= */

async function initDatabase() {
  if (!pool) {
    console.warn("[DB] Skipping database initialization.");
    return false;
  }

  try {
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
      CREATE INDEX IF NOT EXISTS idx_prediction_target_issue
      ON prediction_records(target_issue)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_prediction_created_at
      ON prediction_records(created_at DESC)
    `);

    console.log("[DB] Tables ready.");
    return true;
  } catch (err) {
    console.error("[DB INIT ERROR]", err.message);
    return false;
  }
}

/* =========================================================
   HELPERS
========================================================= */

function now() {
  return Date.now();
}

function safeJson(res, statusCode, data) {
  const body = JSON.stringify(data);

  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key, X-Access-Key",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Content-Length": Buffer.byteLength(body)
  });

  res.end(body);
}

function sendText(res, statusCode, text, contentType = "text/plain") {
  res.writeHead(statusCode, {
    "Content-Type": `${contentType}; charset=utf-8`,
    "Cache-Control": "no-store"
  });

  res.end(text);
}

function notFound(res) {
  safeJson(res, 404, {
    ok: false,
    error: "Not found"
  });
}

function methodNotAllowed(res) {
  safeJson(res, 405, {
    ok: false,
    error: "Method not allowed"
  });
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk.toString();

      if (body.length > 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!body.trim()) {
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

function getHeader(req, name) {
  const value = req.headers[name.toLowerCase()];
  return typeof value === "string" ? value.trim() : "";
}

function requireAdmin(req, res) {
  if (!ADMIN_KEY) {
    safeJson(res, 503, {
      ok: false,
      error: "ADMIN_KEY is not configured on server"
    });

    return false;
  }

  const provided =
    getHeader(req, "x-admin-key") ||
    getHeader(req, "authorization").replace(/^Bearer\s+/i, "");

  if (!provided || provided !== ADMIN_KEY) {
    safeJson(res, 401, {
      ok: false,
      error: "Invalid admin key"
    });

    return false;
  }

  return true;
}

/* =========================================================
   DEVICE ID
========================================================= */

function validDeviceId(value) {
  if (!value) return false;

  return /^[a-zA-Z0-9._:-]{8,200}$/.test(value);
}

/* =========================================================
   WINGOBOT FETCH
========================================================= */

function httpsGetJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": "DY-AI-Wingo/1.0",
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
            const json = JSON.parse(body);
            resolve(json);
          } catch {
            reject(
              new Error(
                `WingoBot returned invalid JSON: ${body.slice(0, 300)}`
              )
            );
          }
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error("WingoBot request timeout"));
    });

    request.on("error", reject);
  });
}

/* =========================================================
   NORMALIZATION
========================================================= */

function normalizeResult(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const text = String(value).trim().toUpperCase();

  if (text === "BIG") return "BIG";
  if (text === "SMALL") return "SMALL";

  return null;
}

function normalizeHistory(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }

  const output = [];

  for (const row of raw) {
    if (!row) continue;

    const issue =
      row.issueNumber ??
      row.issue ??
      row.period ??
      row.periodNumber;

    if (issue === undefined || issue === null) {
      continue;
    }

    const issueNumber = String(issue).trim();

    if (!issueNumber) continue;

    let number = null;

    if (
      row.number !== undefined &&
      row.number !== null &&
      String(row.number).trim() !== ""
    ) {
      const parsed = Number(row.number);

      if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 9) {
        number = parsed;
      }
    }

    let result = normalizeResult(row.result);

    if (!result) {
      result = normalizeResult(row.bigSmall);
    }

    if (!result) {
      result = normalizeResult(row.size);
    }

    if (!result && number !== null) {
      result = number >= 5 ? "BIG" : "SMALL";
    }

    output.push({
      issueNumber,
      number,
      result,
      colour: row.colour ?? null,
      premium: row.premium ?? null,
      sum: row.sum ?? null
    });
  }

  return output;
}

/* =========================================================
   ISSUE HELPERS
========================================================= */

function incrementIssue(issue) {
  if (!issue) return null;

  const text = String(issue).trim();

  if (!/^\d+$/.test(text)) {
    return null;
  }

  try {
    const n = BigInt(text) + 1n;
    return n.toString().padStart(text.length, "0");
  } catch {
    return null;
  }
}

function resolveTargetIssue(currentIssue, history) {
  const latest = history.length
    ? String(history[0].issueNumber)
    : null;

  if (!latest) {
    return currentIssue ? String(currentIssue) : null;
  }

  if (!currentIssue) {
    return incrementIssue(latest);
  }

  const current = String(currentIssue);

  try {
    const c = BigInt(current);
    const l = BigInt(latest);

    if (c > l) {
      return current;
    }

    return incrementIssue(latest);
  } catch {
    return current !== latest ? current : incrementIssue(latest);
  }
}

/* =========================================================
   PROVIDER REFRESH
========================================================= */

async function refreshProvider() {
  if (!WINGOBOT_TOKEN) {
    liveState = {
      ...liveState,
      ok: false,
      error: "WINGOBOT_TOKEN is not configured",
      serverTime: now()
    };

    return false;
  }

  try {
    const data = await httpsGetJson(WINGOBOT_URL, {
      Authorization: `Bearer ${WINGOBOT_TOKEN}`
    });

    const currentIssue =
      data?.current?.issueNumber ??
      data?.current?.issue ??
      null;

    const history = normalizeHistory(
      data?.history ||
      data?.data ||
      data?.results ||
      []
    );

    const stats = data?.stats || {};

    const fetched = Number(
      stats.fetched ??
      history.length
    ) || history.length;

    const providerUpdated =
      Number(
        stats.last_updated ??
        data?.last_updated ??
        data?.lastUpdated ??
        0
      ) || 0;

    const latestSettledIssue =
      history.length
        ? history[0].issueNumber
        : null;

    const targetIssue = resolveTargetIssue(
      currentIssue,
      history
    );

    liveState = {
      ok: true,
      provider: "WingoBot",
      gameUrl: GAME_URL,
      currentIssue:
        currentIssue !== null
          ? String(currentIssue)
          : null,
      latestSettledIssue,
      targetIssue,
      history: history.slice(0, 100),
      fetched,
      lastUpdated: providerUpdated,
      serverTime: now(),
      error: null
    };

    lastProviderFetch = now();
    lastProviderError = null;

    return true;
  } catch (err) {
    lastProviderError = err.message;

    liveState = {
      ...liveState,
      ok: false,
      serverTime: now(),
      error: err.message
    };

    console.error("[WINGOBOT ERROR]", err.message);

    return false;
  }
}

/* =========================================================
   ACCESS KEY API
========================================================= */

async function checkAccessKey(req, res) {
  if (!pool) {
    safeJson(res, 503, {
      ok: false,
      error: "Database is not configured"
    });

    return;
  }

  try {
    const body = await parseJsonBody(req);

    const accessKey = String(
      body.accessKey || body.key || ""
    ).trim();

    const deviceId = String(
      body.deviceId || ""
    ).trim();

    if (!accessKey) {
      safeJson(res, 400, {
        ok: false,
        error: "Access key required"
      });

      return;
    }

    if (!validDeviceId(deviceId)) {
      safeJson(res, 400, {
        ok: false,
        error: "Valid device ID required"
      });

      return;
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
      safeJson(res, 401, {
        ok: false,
        error: "Invalid access key"
      });

      return;
    }

    const row = result.rows[0];

    if (row.device_id && row.device_id !== deviceId) {
      safeJson(res, 403, {
        ok: false,
        error: "This key is already linked to another device"
      });

      return;
    }

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

    safeJson(res, 200, {
      ok: true,
      access: true,
      key: accessKey
    });
  } catch (err) {
    console.error("[ACCESS CHECK ERROR]", err);

    safeJson(res, 500, {
      ok: false,
      error: err.message
    });
  }
}

/* =========================================================
   ACCESS AUTH FOR STATE
========================================================= */

async function verifyAccessKey(req) {
  if (!pool) return false;

  const key =
    getHeader(req, "x-access-key");

  const deviceId =
    getHeader(req, "x-device-id");

  if (!key || !validDeviceId(deviceId)) {
    return false;
  }

  try {
    const result = await pool.query(
      `
      SELECT id
      FROM access_keys
      WHERE access_key = $1
        AND (device_id = $2 OR device_id IS NULL)
      LIMIT 1
      `,
      [key, deviceId]
    );

    if (!result.rows.length) {
      return false;
    }

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
        result.rows[0].id
      ]
    );

    return true;
  } catch (err) {
    console.error("[ACCESS VERIFY ERROR]", err.message);
    return false;
  }
}

/* =========================================================
   ADMIN - KEYS
========================================================= */

async function adminKeys(req, res) {
  if (!requireAdmin(req, res)) return;

  if (!pool) {
    safeJson(res, 503, {
      ok: false,
      error: "Database is not configured"
    });

    return;
  }

  try {
    if (req.method === "GET") {
      const result = await pool.query(`
        SELECT
          id,
          access_key,
          device_id,
          created_at,
          last_seen
        FROM access_keys
        ORDER BY id DESC
      `);

      safeJson(res, 200, {
        ok: true,
        keys: result.rows
      });

      return;
    }

    if (req.method === "POST") {
      const body = await parseJsonBody(req);

      let accessKey = String(
        body.accessKey ||
        body.key ||
        ""
      ).trim();

      if (!accessKey) {
        accessKey =
          "DY-" +
          crypto.randomBytes(6)
            .toString("hex")
            .toUpperCase();
      }

      if (accessKey.length < 4) {
        safeJson(res, 400, {
          ok: false,
          error: "Key too short"
        });

        return;
      }

      const result = await pool.query(
        `
        INSERT INTO access_keys
          (access_key, created_at)
        VALUES
          ($1, $2)
        RETURNING *
        `,
        [
          accessKey,
          now()
        ]
      );

      safeJson(res, 201, {
        ok: true,
        key: result.rows[0]
      });

      return;
    }

    if (req.method === "DELETE") {
      const body = await parseJsonBody(req);

      const id = Number(body.id);

      if (!Number.isInteger(id)) {
        safeJson(res, 400, {
          ok: false,
          error: "Valid key ID required"
        });

        return;
      }

      await pool.query(
        `
        DELETE FROM access_keys
        WHERE id = $1
        `,
        [id]
      );

      safeJson(res, 200, {
        ok: true
      });

      return;
    }

    methodNotAllowed(res);
  } catch (err) {
    console.error("[ADMIN KEYS ERROR]", err.message);

    safeJson(res, 500, {
      ok: false,
      error: err.message
    });
  }
}

/* =========================================================
   ADMIN RESET DEVICE
========================================================= */

async function resetDevice(req, res) {
  if (!requireAdmin(req, res)) return;

  if (!pool) {
    safeJson(res, 503, {
      ok: false,
      error: "Database is not configured"
    });

    return;
  }

  try {
    const body = await parseJsonBody(req);

    const id = Number(body.id);

    if (!Number.isInteger(id)) {
      safeJson(res, 400, {
        ok: false,
        error: "Valid key ID required"
      });

      return;
    }

    const result = await pool.query(
      `
      UPDATE access_keys
      SET device_id = NULL,
          last_seen = 0
      WHERE id = $1
      RETURNING id, access_key, device_id, last_seen
      `,
      [id]
    );

    if (!result.rows.length) {
      safeJson(res, 404, {
        ok: false,
        error: "Key not found"
      });

      return;
    }

    safeJson(res, 200, {
      ok: true,
      key: result.rows[0]
    });
  } catch (err) {
    console.error("[RESET DEVICE ERROR]", err.message);

    safeJson(res, 500, {
      ok: false,
      error: err.message
    });
  }
}

/* =========================================================
   ADMIN STATUS
========================================================= */

async function adminStatus(req, res) {
  if (!requireAdmin(req, res)) return;

  safeJson(res, 200, {
    ok: true,
    server: {
      node: process.version,
      uptime: process.uptime(),
      port: PORT
    },
    database: {
      configured: !!pool
    },
    wingobot: {
      configured: !!WINGOBOT_TOKEN,
      lastFetch: lastProviderFetch,
      lastError: lastProviderError
    },
    state: {
      currentIssue: liveState.currentIssue,
      latestSettledIssue:
        liveState.latestSettledIssue,
      targetIssue: liveState.targetIssue,
      historyCount:
        liveState.history.length,
      fetched:
        liveState.fetched,
      lastUpdated:
        liveState.lastUpdated
    }
  });
}

/* =========================================================
   ADMIN PING
========================================================= */

async function adminPing(req, res) {
  if (!requireAdmin(req, res)) return;

  safeJson(res, 200, {
    ok: true,
    message: "Server is running",
    time: now()
  });
}

/* =========================================================
   WINGO TEST
========================================================= */

async function adminWingoTest(req, res) {
  if (!requireAdmin(req, res)) return;

  if (!WINGOBOT_TOKEN) {
    safeJson(res, 503, {
      ok: false,
      error: "WINGOBOT_TOKEN is missing"
    });

    return;
  }

  try {
    const data = await httpsGetJson(
      WINGOBOT_URL,
      {
        Authorization:
          `Bearer ${WINGOBOT_TOKEN}`
      }
    );

    const history = normalizeHistory(
      data?.history ||
      data?.data ||
      data?.results ||
      []
    );

    safeJson(res, 200, {
      ok: true,
      current:
        data?.current || null,
      fetched:
        data?.stats?.fetched ??
        history.length,
      last_updated:
        data?.stats?.last_updated ??
        0,
      historyCount:
        history.length,
      sample:
        history.slice(0, 5)
    });
  } catch (err) {
    safeJson(res, 502, {
      ok: false,
      error: err.message
    });
  }
}

/* =========================================================
   MODEL TEST
   ========================================================= */

async function modelTest(req, res) {
  if (!requireAdmin(req, res)) return;

  safeJson(res, 200, {
    ok: true,
    mode: "tracker",
    message:
      "History tracking and exact-period settlement are active.",
    historyCount:
      liveState.history.length,
    latestSettledIssue:
      liveState.latestSettledIssue,
    targetIssue:
      liveState.targetIssue
  });
}

/* =========================================================
   PREDICTION RECORD HELPERS
========================================================= */

async function getPredictionForIssue(issue) {
  if (!pool || !issue) return null;

  try {
    const result = await pool.query(
      `
      SELECT *
      FROM prediction_records
      WHERE target_issue = $1
      ORDER BY id DESC
      LIMIT 1
      `,
      [String(issue)]
    );

    return result.rows[0] || null;
  } catch (err) {
    console.error(
      "[GET PREDICTION ERROR]",
      err.message
    );

    return null;
  }
}

/* =========================================================
   SETTLEMENT
========================================================= */

async function settleRecords() {
  if (!pool || !liveState.history.length) {
    return;
  }

  try {
    for (const row of liveState.history) {
      if (!row.issueNumber || !row.result) {
        continue;
      }

      const result = await pool.query(
        `
        SELECT *
        FROM prediction_records
        WHERE target_issue = $1
          AND actual_result IS NULL
        ORDER BY id DESC
        `,
        [String(row.issueNumber)]
      );

      for (const prediction of result.rows) {
        const predicted =
          normalizeResult(prediction.prediction);

        const actual =
          normalizeResult(row.result);

        if (!predicted || !actual) {
          continue;
        }

        const win =
          predicted === actual;

        await pool.query(
          `
          UPDATE prediction_records
          SET actual_number = $1,
              actual_result = $2,
              settled_at = $3
          WHERE id = $4
          `,
          [
            row.number,
            actual,
            now(),
            prediction.id
          ]
        );

        console.log(
          `[SETTLE] ${prediction.target_issue} ${predicted} -> ${actual} ${win ? "WIN" : "LOSS"}`
        );
      }
    }
  } catch (err) {
    console.error(
      "[SETTLEMENT ERROR]",
      err.message
    );
  }
}

/* =========================================================
   HISTORY API
========================================================= */

async function historyApi(req, res) {
  if (!pool) {
    safeJson(res, 503, {
      ok: false,
      error: "Database is not configured"
    });

    return;
  }

  try {
    const result = await pool.query(`
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
      ORDER BY id DESC
      LIMIT 30
    `);

    const rows = result.rows.map((row) => {
      let status = "PENDING";

      if (
        row.actual_result &&
        row.prediction
      ) {
        status =
          String(row.prediction).toUpperCase() ===
          String(row.actual_result).toUpperCase()
            ? "WIN"
            : "LOSS";
      }

      return {
        ...row,
        status
      };
    });

    safeJson(res, 200, {
      ok: true,
      count: rows.length,
      history: rows
    });
  } catch (err) {
    safeJson(res, 500, {
      ok: false,
      error: err.message
    });
  }
}

/* =========================================================
   STATE API
========================================================= */

async function stateApi(req, res) {
  const authorized =
    await verifyAccessKey(req);

  if (!authorized) {
    safeJson(res, 401, {
      ok: false,
      error: "Access key required"
    });

    return;
  }

  let latestRecord = null;

  if (liveState.targetIssue) {
    latestRecord =
      await getPredictionForIssue(
        liveState.targetIssue
      );
  }

  safeJson(res, 200, {
    ok: true,
    gameUrl: GAME_URL,

    currentIssue:
      liveState.currentIssue,

    latestSettledIssue:
      liveState.latestSettledIssue,

    targetIssue:
      liveState.targetIssue,

    history:
      liveState.history.slice(0, 30),

    fetched:
      liveState.fetched,

    lastUpdated:
      liveState.lastUpdated,

    serverTime:
      now(),

    providerOk:
      liveState.ok,

    providerError:
      liveState.error,

    record:
      latestRecord
        ? {
            targetIssue:
              latestRecord.target_issue,
            prediction:
              latestRecord.prediction,
            confidence:
              latestRecord.confidence,
            modelVersion:
              latestRecord.model_version,
            actualNumber:
              latestRecord.actual_number,
            actualResult:
              latestRecord.actual_result,
            createdAt:
              latestRecord.created_at,
            settledAt:
              latestRecord.settled_at
          }
        : null
  });
}

/* =========================================================
   HEALTH
========================================================= */

async function healthApi(req, res) {
  let databaseOk = false;

  if (pool) {
    try {
      await pool.query("SELECT 1");
      databaseOk = true;
    } catch {
      databaseOk = false;
    }
  }

  const healthy =
    databaseOk &&
    !!WINGOBOT_TOKEN &&
    liveState.ok;

  safeJson(res, healthy ? 200 : 503, {
    ok: healthy,
    server: true,
    database: databaseOk,
    wingobotConfigured:
      !!WINGOBOT_TOKEN,
    providerOk:
      liveState.ok,
    currentIssue:
      liveState.currentIssue,
    targetIssue:
      liveState.targetIssue,
    time:
      now()
  });
}

/* =========================================================
   STATIC FILE SERVER
========================================================= */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg"
};

function safeFilePath(urlPath) {
  let decoded;

  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }

  decoded = decoded.split("?")[0];

  if (decoded === "/" || decoded === "") {
    decoded = "/prediction.html";
  }

  const full = path.resolve(
    ROOT,
    "." + decoded
  );

  if (
    full !== ROOT &&
    !full.startsWith(ROOT + path.sep)
  ) {
    return null;
  }

  return full;
}

function serveStatic(req, res) {
  const filePath =
    safeFilePath(req.url);

  if (!filePath) {
    notFound(res);
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      notFound(res);
      return;
    }

    const ext =
      path.extname(filePath).toLowerCase();

    const contentType =
      MIME[ext] ||
      "application/octet-stream";

    /* MP3 range support */
    if (ext === ".mp3") {
      serveAudio(filePath, req, res);
      return;
    }

    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control":
        ext === ".html"
          ? "no-store"
          : "public, max-age=300"
    });

    fs.createReadStream(filePath)
      .pipe(res);
  });
}

/* =========================================================
   AUDIO RANGE SUPPORT
========================================================= */

function serveAudio(filePath, req, res) {
  fs.stat(filePath, (err, stat) => {
    if (err) {
      notFound(res);
      return;
    }

    const total = stat.size;
    const range = req.headers.range;

    if (!range) {
      res.writeHead(200, {
        "Content-Type": "audio/mpeg",
        "Content-Length": total,
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=300"
      });

      fs.createReadStream(filePath)
        .pipe(res);

      return;
    }

    const match =
      /bytes=(\d*)-(\d*)/.exec(range);

    if (!match) {
      res.writeHead(416, {
        "Content-Range":
          `bytes */${total}`
      });

      res.end();
      return;
    }

    let start =
      match[1] === ""
        ? 0
        : Number(match[1]);

    let end =
      match[2] === ""
        ? total - 1
        : Number(match[2]);

    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end >= total ||
      start > end
    ) {
      res.writeHead(416, {
        "Content-Range":
          `bytes */${total}`
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
        `bytes ${start}-${end}/${total}`,
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=300"
    });

    fs.createReadStream(filePath, {
      start,
      end
    }).pipe(res);
  });
}

/* =========================================================
   ROUTER
========================================================= */

const server = http.createServer(
  async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers":
            "Content-Type, X-Admin-Key, X-Access-Key, X-Device-Id",
          "Access-Control-Allow-Methods":
            "GET, POST, DELETE, OPTIONS"
        });

        res.end();
        return;
      }

      const url = new URL(
        req.url,
        `http://${req.headers.host || "localhost"}`
      );

      const pathname = url.pathname;

      /* Health */
      if (pathname === "/health") {
        await healthApi(req, res);
        return;
      }

      /* Access */
      if (
        pathname === "/api/key/check" &&
        req.method === "POST"
      ) {
        await checkAccessKey(req, res);
        return;
      }

      /* State */
      if (pathname === "/api/state") {
        if (req.method !== "GET") {
          methodNotAllowed(res);
          return;
        }

        await stateApi(req, res);
        return;
      }

      /* History */
      if (pathname === "/api/history") {
        if (req.method !== "GET") {
          methodNotAllowed(res);
          return;
        }

        await historyApi(req, res);
        return;
      }

      /* Admin keys */
      if (pathname === "/api/admin/keys") {
        await adminKeys(req, res);
        return;
      }

      /* Admin reset */
      if (
        pathname === "/api/admin/reset-device" &&
        req.method === "POST"
      ) {
        await resetDevice(req, res);
        return;
      }

      /* Admin status */
      if (pathname === "/api/admin/status") {
        if (req.method !== "GET") {
          methodNotAllowed(res);
          return;
        }

        await adminStatus(req, res);
        return;
      }

      /* Admin ping */
      if (pathname === "/api/admin/ping") {
        if (req.method !== "GET") {
          methodNotAllowed(res);
          return;
        }

        await adminPing(req, res);
        return;
      }

      /* Admin Wingo test */
      if (pathname === "/api/admin/wingo-test") {
        if (req.method !== "GET") {
          methodNotAllowed(res);
          return;
        }

        await adminWingoTest(req, res);
        return;
      }

      /* Admin model test */
      if (pathname === "/api/admin/model-test") {
        if (req.method !== "GET") {
          methodNotAllowed(res);
          return;
        }

        await modelTest(req, res);
        return;
      }

      /* Static */
      serveStatic(req, res);
    } catch (err) {
      console.error(
        "[SERVER REQUEST ERROR]",
        err
      );

      if (!res.headersSent) {
        safeJson(res, 500, {
          ok: false,
          error: "Internal server error"
        });
      } else {
        res.end();
      }
    }
  }
);

/* =========================================================
   STARTUP
========================================================= */

async function start() {
  console.log("[START] Initializing database...");

  await initDatabase();

  console.log("[START] Starting HTTP server...");

  server.listen(PORT, "0.0.0.0", () => {
    console.log(
      `[SERVER] Listening on 0.0.0.0:${PORT}`
    );
  });

  /*
   * Provider failure must NOT kill the Node process.
   */
  try {
    await refreshProvider();
  } catch (err) {
    console.error(
      "[INITIAL REFRESH ERROR]",
      err.message
    );
  }

  /*
   * Refresh every 3 seconds.
   */
  setInterval(async () => {
    try {
      await refreshProvider();
      await settleRecords();
    } catch (err) {
      console.error(
        "[REFRESH LOOP ERROR]",
        err.message
      );
    }
  }, 3000);
}

/* =========================================================
   PROCESS SAFETY
========================================================= */

process.on("uncaughtException", (err) => {
  console.error(
    "[UNCAUGHT EXCEPTION]",
    err
  );

  /*
   * Do not immediately process.exit().
   * Keep Render service alive where possible.
   */
});

process.on("unhandledRejection", (reason) => {
  console.error(
    "[UNHANDLED REJECTION]",
    reason
  );
});

process.on("SIGTERM", async () => {
  console.log("[SIGTERM] Shutting down...");

  try {
    if (pool) {
      await pool.end();
    }
  } catch {}

  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => {
    process.exit(0);
  }, 5000);
});

process.on("SIGINT", async () => {
  console.log("[SIGINT] Shutting down...");

  try {
    if (pool) {
      await pool.end();
    }
  } catch {}

  server.close(() => {
    process.exit(0);
  });
});

/* =========================================================
   RUN
========================================================= */

start().catch((err) => {
  /*
   * Log the actual reason instead of a silent status-1 exit.
   */
  console.error(
    "[FATAL START ERROR]",
    err
  );

  /*
   * HTTP server is intentionally not force-exited here.
   * Render will still expose the logs/health state.
   */
});
