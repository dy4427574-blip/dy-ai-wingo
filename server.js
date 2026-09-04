const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL;
const WINGOBOT_TOKEN = process.env.WINGOBOT_TOKEN || "";
const ADMIN_KEY = process.env.ADMIN_KEY || "";

const GAME_URL =
  "https://www.shreewin38.com/#/register?invitationCode=88523152383";

const MODEL_VERSION = "DY-TRACKER-V7";

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes("localhost")
        ? false
        : { rejectUnauthorized: false },
    })
  : null;

let cache = {
  history: [],
  currentIssue: null,
  lastUpdated: 0,
  fetched: 0,
  error: null,
};

function now() {
  return Date.now();
}

function json(res, status, data) {
  const body = JSON.stringify(data);

  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });

  res.end(body);
}

function text(res, status, body, type = "text/plain") {
  res.writeHead(status, {
    "Content-Type": `${type}; charset=utf-8`,
    "Cache-Control": "no-store",
  });

  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk;

      if (body.length > 1024 * 1024) {
        reject(new Error("Request too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!body) return resolve({});

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });

    req.on("error", reject);
  });
}

function getAdminKey(req) {
  return (
    req.headers["x-admin-key"] ||
    req.headers["authorization"]?.replace(/^Bearer\s+/i, "") ||
    ""
  );
}

function requireAdmin(req, res) {
  if (!ADMIN_KEY || getAdminKey(req) !== ADMIN_KEY) {
    json(res, 401, {
      ok: false,
      error: "Unauthorized",
    });
    return false;
  }

  return true;
}

function normalizeSide(row) {
  const direct = String(
    row.result ||
    row.bigSmall ||
    row.big_small ||
    row.side ||
    row.colour ||
    row.color ||
    ""
  )
    .trim()
    .toUpperCase();

  if (["BIG", "B"].includes(direct)) return "BIG";
  if (["SMALL", "S"].includes(direct)) return "SMALL";

  const n = Number(row.number);

  if (Number.isInteger(n) && n >= 0 && n <= 9) {
    return n >= 5 ? "BIG" : "SMALL";
  }

  return null;
}

function normalizeRow(row) {
  if (!row) return null;

  const issue = String(
    row.issueNumber ||
    row.issue ||
    row.period ||
    row.periodNumber ||
    ""
  ).trim();

  if (!issue) return null;

  const number =
    row.number === undefined ||
    row.number === null ||
    row.number === ""
      ? null
      : Number(row.number);

  const side = normalizeSide(row);

  return {
    issueNumber: issue,
    number: Number.isInteger(number) ? number : null,
    side,
    rawColour: row.colour || row.color || null,
  };
}

function sortHistory(rows) {
  return rows
    .filter(Boolean)
    .sort((a, b) => {
      try {
        return BigInt(b.issueNumber) > BigInt(a.issueNumber)
          ? 1
          : BigInt(b.issueNumber) < BigInt(a.issueNumber)
          ? -1
          : 0;
      } catch {
        return String(b.issueNumber).localeCompare(String(a.issueNumber));
      }
    });
}

function incrementIssue(issue) {
  if (!issue) return null;

  try {
    return (BigInt(issue) + 1n).toString();
  } catch {
    return null;
  }
}

function resolveTargetIssue(history, currentIssue) {
  if (!history.length) {
    return currentIssue || null;
  }

  const latestSettled = history[0].issueNumber;

  if (!currentIssue) {
    return incrementIssue(latestSettled);
  }

  try {
    const current = BigInt(currentIssue);
    const latest = BigInt(latestSettled);

    if (current > latest) {
      return current.toString();
    }

    return (latest + 1n).toString();
  } catch {
    return currentIssue;
  }
}

function fetchWingoBot() {
  return new Promise((resolve, reject) => {
    if (!WINGOBOT_TOKEN) {
      return reject(new Error("WINGOBOT_TOKEN missing"));
    }

    const request = https.request(
      "https://api.wingobot.com/v2/30-sec-game-history",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${WINGOBOT_TOKEN}`,
          Accept: "application/json",
          "User-Agent": "DY-AI-Tracker-V7",
        },
      },
      response => {
        let body = "";

        response.on("data", chunk => {
          body += chunk;
        });

        response.on("end", () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            return reject(
              new Error(
                `WingoBot HTTP ${response.statusCode}: ${body.slice(0, 300)}`
              )
            );
          }

          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error("WingoBot returned invalid JSON"));
          }
        });
      }
    );

    request.setTimeout(15000, () => {
      request.destroy(new Error("WingoBot timeout"));
    });

    request.on("error", reject);
    request.end();
  });
}

function extractHistory(payload) {
  const possible =
    payload?.history ||
    payload?.data?.history ||
    payload?.data ||
    payload?.results ||
    [];

  if (!Array.isArray(possible)) return [];

  return sortHistory(
    possible
      .map(normalizeRow)
      .filter(row => row && row.side)
  );
}

async function updateProviderCache() {
  try {
    const payload = await fetchWingoBot();

    const history = extractHistory(payload);

    const currentIssue = String(
      payload?.current?.issueNumber ||
      payload?.data?.current?.issueNumber ||
      ""
    ).trim() || null;

    cache = {
      history,
      currentIssue,
      lastUpdated:
        Number(payload?.stats?.last_updated) ||
        Number(payload?.data?.stats?.last_updated) ||
        now(),
      fetched:
        Number(payload?.stats?.fetched) ||
        Number(payload?.data?.stats?.fetched) ||
        history.length,
      error: null,
    };

    return cache;
  } catch (err) {
    cache.error = err.message;
    throw err;
  }
}

async function initDb() {
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

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_prediction_target
    ON prediction_records(target_issue)
  `);
}

function makeKey() {
  return (
    "DY-" +
    crypto.randomBytes(12).toString("hex").toUpperCase()
  );
}

async function checkAccessKey(key, deviceId) {
  if (!pool) {
    return {
      ok: false,
      error: "Database unavailable",
    };
  }

  const result = await pool.query(
    `
    SELECT *
    FROM access_keys
    WHERE access_key = $1
    LIMIT 1
    `,
    [key]
  );

  if (!result.rows.length) {
    return {
      ok: false,
      error: "Invalid access key",
    };
  }

  const row = result.rows[0];

  if (row.device_id && row.device_id !== deviceId) {
    return {
      ok: false,
      error: "Key already bound to another device",
    };
  }

  if (!row.device_id && deviceId) {
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

async function adminKeys(res) {
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

  json(res, 200, {
    ok: true,
    keys: result.rows,
  });
}

async function createAccessKey(res) {
  const key = makeKey();

  await pool.query(
    `
    INSERT INTO access_keys
      (access_key, created_at)
    VALUES
      ($1, $2)
    `,
    [key, now()]
  );

  json(res, 200, {
    ok: true,
    access_key: key,
  });
}

async function deleteAccessKey(res, id) {
  await pool.query(
    `DELETE FROM access_keys WHERE id = $1`,
    [id]
  );

  json(res, 200, {
    ok: true,
  });
}

async function resetDevice(res, id) {
  await pool.query(
    `
    UPDATE access_keys
    SET device_id = NULL,
        last_seen = 0
    WHERE id = $1
    `,
    [id]
  );

  json(res, 200, {
    ok: true,
  });
}

function buildLast30() {
  return cache.history.slice(0, 30).map(row => ({
    issueNumber: row.issueNumber,
    side: row.side,
    number: row.number,
  }));
}

function buildState() {
  const history = cache.history;
  const targetIssue = resolveTargetIssue(
    history,
    cache.currentIssue
  );

  return {
    ok: true,
    model: MODEL_VERSION,

    gameUrl: GAME_URL,

    currentIssue: cache.currentIssue,
    targetIssue,

    providerLastUpdated: cache.lastUpdated,
    fetched: cache.fetched,

    history: buildLast30(),

    latest: history[0] || null,

    stats: {
      historyCount: history.length,
      big: history.filter(x => x.side === "BIG").length,
      small: history.filter(x => x.side === "SMALL").length,
    },

    error: cache.error,
  };
}

async function predictionHistory() {
  if (!pool) return [];

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

  const actualMap = new Map(
    cache.history.map(row => [
      row.issueNumber,
      row,
    ])
  );

  return result.rows.map(row => {
    const actual = actualMap.get(row.target_issue);

    let status = "PENDING";

    if (actual?.side) {
      status =
        actual.side === row.prediction
          ? "WIN"
          : "LOSS";
    }

    return {
      id: row.id,
      targetIssue: row.target_issue,
      prediction: row.prediction,
      actual: actual?.side || null,
      actualNumber: actual?.number ?? null,
      status,
      modelVersion: row.model_version,
      createdAt: row.created_at,
    };
  });
}

async function settleRecords() {
  if (!pool || !cache.history.length) return;

  for (const row of cache.history) {
    await pool.query(
      `
      UPDATE prediction_records
      SET
        actual_number = $1,
        actual_result = $2,
        settled_at = COALESCE(settled_at, $3)
      WHERE target_issue = $4
        AND actual_result IS NULL
      `,
      [
        row.number,
        row.side,
        now(),
        row.issueNumber,
      ]
    );
  }
}

async function modelStatus() {
  return {
    model: MODEL_VERSION,
    mode: "RESULT_TRACKING",
    predictionEngine: false,
    bettingSignal: false,
    historyAvailable: cache.history.length,
    lastUpdated: cache.lastUpdated,
  };
}

async function handleApi(req, res, url) {
  if (url.pathname === "/api/state") {
    try {
      if (!cache.history.length || cache.error) {
        await updateProviderCache();
      }

      await settleRecords();

      return json(res, 200, buildState());
    } catch {
      return json(res, 200, buildState());
    }
  }

  if (url.pathname === "/api/history") {
    try {
      if (!cache.history.length) {
        await updateProviderCache();
      }

      await settleRecords();

      return json(res, 200, {
        ok: true,
        history: await predictionHistory(),
      });
    } catch (err) {
      return json(res, 500, {
        ok: false,
        error: err.message,
      });
    }
  }

  if (url.pathname === "/api/key/check" && req.method === "POST") {
    try {
      const body = await readBody(req);

      const key = String(body.key || "").trim();
      const deviceId = String(body.deviceId || "").trim();

      if (!key || !deviceId) {
        return json(res, 400, {
          ok: false,
          error: "Key and device ID required",
        });
      }

      return json(
        res,
        200,
        await checkAccessKey(key, deviceId)
      );
    } catch (err) {
      return json(res, 500, {
        ok: false,
        error: err.message,
      });
    }
  }

  if (url.pathname === "/api/admin/status") {
    if (!requireAdmin(req, res)) return;

    return json(res, 200, {
      ok: true,
      server: true,
      database: !!pool,
      wingobot: !!WINGOBOT_TOKEN,
      gameUrl: GAME_URL,
      ...(await modelStatus()),
    });
  }

  if (url.pathname === "/api/admin/ping") {
    if (!requireAdmin(req, res)) return;

    let database = false;

    if (pool) {
      try {
        await pool.query("SELECT 1");
        database = true;
      } catch {}
    }

    json(res, 200, {
      ok: true,
      server: true,
      database,
      time: now(),
    });

    return;
  }

  if (url.pathname === "/api/admin/wingo-test") {
    if (!requireAdmin(req, res)) return;

    try {
      const payload = await fetchWingoBot();

      json(res, 200, {
        ok: true,
        current: payload?.current || null,
        fetched: payload?.stats?.fetched || null,
        historyCount: extractHistory(payload).length,
      });
    } catch (err) {
      json(res, 500, {
        ok: false,
        error: err.message,
      });
    }

    return;
  }

  if (url.pathname === "/api/admin/model-test") {
    if (!requireAdmin(req, res)) return;

    json(res, 200, {
      ok: true,
      model: MODEL_VERSION,
      mode: "RESULT_TRACKING",
      message:
        "This version tracks actual BIG/SMALL results and exact issue settlement. It does not generate betting signals.",
      historyUsed: cache.history.length,
      last30: buildLast30(),
    });

    return;
  }

  if (url.pathname === "/api/admin/keys" && req.method === "GET") {
    if (!requireAdmin(req, res)) return;

    try {
      await adminKeys(res);
    } catch (err) {
      json(res, 500, {
        ok: false,
        error: err.message,
      });
    }

    return;
  }

  if (url.pathname === "/api/admin/keys" && req.method === "POST") {
    if (!requireAdmin(req, res)) return;

    try {
      await createAccessKey(res);
    } catch (err) {
      json(res, 500, {
        ok: false,
        error: err.message,
      });
    }

    return;
  }

  if (url.pathname === "/api/admin/keys" && req.method === "DELETE") {
    if (!requireAdmin(req, res)) return;

    try {
      const id = Number(url.searchParams.get("id"));

      if (!id) {
        return json(res, 400, {
          ok: false,
          error: "Invalid ID",
        });
      }

      await deleteAccessKey(res, id);
    } catch (err) {
      json(res, 500, {
        ok: false,
        error: err.message,
      });
    }

    return;
  }

  if (
    url.pathname === "/api/admin/reset-device" &&
    req.method === "POST"
  ) {
    if (!requireAdmin(req, res)) return;

    try {
      const body = await readBody(req);
      const id = Number(body.id);

      if (!id) {
        return json(res, 400, {
          ok: false,
          error: "Invalid ID",
        });
      }

      await resetDevice(res, id);
    } catch (err) {
      json(res, 500, {
        ok: false,
        error: err.message,
      });
    }

    return;
  }

  if (url.pathname === "/api/admin/refresh") {
    if (!requireAdmin(req, res)) return;

    try {
      await updateProviderCache();

      json(res, 200, {
        ok: true,
        ...buildState(),
      });
    } catch (err) {
      json(res, 500, {
        ok: false,
        error: err.message,
      });
    }

    return;
  }

  return json(res, 404, {
    ok: false,
    error: "API route not found",
  });
}

function serveFile(res, filename, type) {
  const file = path.join(__dirname, filename);

  if (!fs.existsSync(file)) {
    return text(res, 404, "File not found");
  }

  res.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": "no-cache",
  });

  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(
      req.url,
      `http://${req.headers.host || "localhost"}`
    );

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods":
          "GET,POST,DELETE,OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type,X-Admin-Key,Authorization",
      });

      return res.end();
    }

    if (url.pathname === "/health") {
      return json(res, 200, {
        ok: true,
        model: MODEL_VERSION,
        database: !!pool,
        wingobot: !!WINGOBOT_TOKEN,
        time: now(),
      });
    }

    if (url.pathname.startsWith("/api/")) {
      return await handleApi(req, res, url);
    }

    if (url.pathname === "/" || url.pathname === "/prediction.html") {
      return serveFile(
        res,
        "prediction.html",
        "text/html; charset=utf-8"
      );
    }

    if (url.pathname === "/admin.html") {
      return serveFile(
        res,
        "admin.html",
        "text/html; charset=utf-8"
      );
    }

    if (url.pathname === "/music.mp3") {
      const file = path.join(__dirname, "music.mp3");

      if (!fs.existsSync(file)) {
        return text(res, 404, "Music not found");
      }

      const stat = fs.statSync(file);
      const range = req.headers.range;

      if (!range) {
        res.writeHead(200, {
          "Content-Type": "audio/mpeg",
          "Content-Length": stat.size,
          "Accept-Ranges": "bytes",
        });

        return fs.createReadStream(file).pipe(res);
      }

      const match = /bytes=(\d+)-(\d*)/.exec(range);

      if (!match) {
        res.writeHead(416);
        return res.end();
      }

      const start = Number(match[1]);
      const end = match[2]
        ? Number(match[2])
        : stat.size - 1;

      if (
        start >= stat.size ||
        end >= stat.size ||
        start > end
      ) {
        res.writeHead(416);
        return res.end();
      }

      res.writeHead(206, {
        "Content-Type": "audio/mpeg",
        "Accept-Ranges": "bytes",
        "Content-Range":
          `bytes ${start}-${end}/${stat.size}`,
        "Content-Length": end - start + 1,
      });

      return fs
        .createReadStream(file, { start, end })
        .pipe(res);
    }

    return text(res, 404, "Not found");
  } catch (err) {
    console.error(err);

    json(res, 500, {
      ok: false,
      error: "Internal server error",
    });
  }
});

async function boot() {
  try {
    await initDb();

    try {
      await updateProviderCache();
      console.log(
        `WingoBot loaded: ${cache.history.length} results`
      );
    } catch (err) {
      console.log(
        "Initial WingoBot fetch failed:",
        err.message
      );
    }

    setInterval(async () => {
      try {
        await updateProviderCache();
        await settleRecords();
      } catch (err) {
        cache.error = err.message;
      }
    }, 3000);

    server.listen(PORT, () => {
      console.log(`DY Tracker V7 running on ${PORT}`);
    });
  } catch (err) {
    console.error("BOOT ERROR:", err);
    process.exit(1);
  }
}

boot();
