"use strict";

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 10000);
const ADMIN_KEY = String(process.env.ADMIN_KEY || "").trim();
const WINGOBOT_TOKEN = String(process.env.WINGOBOT_TOKEN || "").trim();
const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();

const ROOT = __dirname;

if (!DATABASE_URL) {
  console.error("DATABASE_URL missing");
}

if (!WINGOBOT_TOKEN) {
  console.error("WINGOBOT_TOKEN missing");
}

const pool = new Pool({
  connectionString: DATABASE_URL || undefined,
  ssl: DATABASE_URL
    ? { rejectUnauthorized: false }
    : false,
  max: 5,
});

const API_URL =
  "https://api.wingobot.com/v2/30-sec-game-history";

let providerState = {
  currentIssue: null,
  history: [],
  stats: {},
  lastFetch: 0,
  error: null,
};

let refreshBusy = false;


/* =========================================================
   DATABASE
========================================================= */

async function initDB() {
  if (!DATABASE_URL) return;

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

  console.log("Database ready");
}


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
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "Content-Type, X-Access-Key, X-Device-Id, Authorization",
    "Access-Control-Allow-Methods":
      "GET, POST, DELETE, OPTIONS",
  });

  res.end(body);
}

function text(res, status, data, type = "text/plain") {
  res.writeHead(status, {
    "Content-Type": `${type}; charset=utf-8`,
    "Cache-Control": "no-store",
  });

  res.end(data);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk;

      if (body.length > 2 * 1024 * 1024) {
        reject(new Error("Request too large"));
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

function randomKey() {
  return crypto.randomBytes(18).toString("hex");
}

function incrementIssue(issue) {
  const s = String(issue || "");

  if (!s) return null;

  const match = s.match(/^(.*?)(\d+)$/);

  if (!match) return null;

  const prefix = match[1];
  const digits = match[2];

  const next = String(
    BigInt(digits) + 1n
  ).padStart(digits.length, "0");

  return prefix + next;
}


/* =========================================================
   RESULT NORMALIZATION
========================================================= */

function getNumber(row) {
  const n = Number(row?.number);

  if (
    Number.isInteger(n) &&
    n >= 0 &&
    n <= 9
  ) {
    return n;
  }

  return null;
}

function getResult(row) {
  const n = getNumber(row);

  if (n !== null) {
    return n >= 5 ? "BIG" : "SMALL";
  }

  const possible = [
    row?.result,
    row?.bigSmall,
    row?.size,
    row?.prediction,
  ];

  for (const value of possible) {
    const s = String(value || "")
      .trim()
      .toUpperCase();

    if (s === "BIG" || s === "SMALL") {
      return s;
    }
  }

  return null;
}

function normalizeRow(row) {
  return {
    issueNumber: String(
      row?.issueNumber ??
      row?.issue ??
      row?.period ??
      ""
    ),

    number: getNumber(row),

    result: getResult(row),

    colour:
      row?.colour ??
      row?.color ??
      null,

    premium:
      row?.premium ??
      null,

    sum:
      row?.sum ??
      null,
  };
}


/* =========================================================
   WINGOBOT REQUEST
========================================================= */

function fetchWingoBot() {
  return new Promise((resolve, reject) => {
    if (!WINGOBOT_TOKEN) {
      reject(new Error("WINGOBOT_TOKEN missing"));
      return;
    }

    const url = new URL(API_URL);

    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: "GET",

        headers: {
          Authorization:
            "Bearer " + WINGOBOT_TOKEN,

          Accept:
            "application/json",

          "User-Agent":
            "DY-AI-Wingo/2.0",
        },

        timeout: 10000,
      },

      res => {
        let body = "";

        res.on("data", chunk => {
          body += chunk;
        });

        res.on("end", () => {
          if (
            res.statusCode < 200 ||
            res.statusCode >= 300
          ) {
            reject(
              new Error(
                "WingoBot HTTP " +
                res.statusCode
              )
            );

            return;
          }

          try {
            const data = JSON.parse(body);
            resolve(data);
          } catch {
            reject(
              new Error(
                "Invalid WingoBot response"
              )
            );
          }
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(
        new Error("WingoBot request timeout")
      );
    });

    req.on("error", reject);

    req.end();
  });
}


/* =========================================================
   PROVIDER REFRESH
========================================================= */

async function refreshProvider() {
  if (refreshBusy) return;

  refreshBusy = true;

  try {
    const data = await fetchWingoBot();

    const rawHistory = Array.isArray(data?.history)
      ? data.history
      : [];

    const history = rawHistory
      .map(normalizeRow)
      .filter(row => row.issueNumber);

    providerState = {
      currentIssue:
        data?.current?.issueNumber
          ? String(data.current.issueNumber)
          : null,

      history,

      stats:
        data?.stats &&
        typeof data.stats === "object"
          ? data.stats
          : {},

      lastFetch: now(),

      error: null,
    };

    await settlePredictions();

    console.log(
      "WingoBot refresh:",
      history.length,
      "rows",
      "current:",
      providerState.currentIssue
    );
  } catch (err) {
    providerState.error =
      err?.message || "Provider error";

    console.error(
      "Provider refresh error:",
      providerState.error
    );
  } finally {
    refreshBusy = false;
  }
}


/* =========================================================
   TARGET PERIOD
========================================================= */

function getLatestSettledIssue(history) {
  for (const row of history) {
    if (
      row.issueNumber &&
      row.result
    ) {
      return row.issueNumber;
    }
  }

  return null;
}

function resolveTargetIssue() {
  const history =
    providerState.history || [];

  const latestSettled =
    getLatestSettledIssue(history);

  const current =
    providerState.currentIssue;

  /*
    Provider current issue is treated as active.

    If current is ahead of latest settled,
    current becomes target.

    Otherwise target = next issue after
    latest settled.
  */

  if (
    current &&
    latestSettled &&
    String(current) > String(latestSettled)
  ) {
    return String(current);
  }

  if (latestSettled) {
    return incrementIssue(
      latestSettled
    );
  }

  return current || null;
}


/* =========================================================
   ANALYSIS ENGINE
========================================================= */

function validResults(history) {
  return history
    .filter(x =>
      x &&
      (x.result === "BIG" ||
       x.result === "SMALL")
    );
}

function recentWindow(rows, size) {
  return rows.slice(
    0,
    Math.min(size, rows.length)
  );
}

function sideScore(rows, side) {
  if (!rows.length) return 0;

  let score = 0;

  rows.forEach((row, index) => {
    if (row.result !== side) return;

    const weight =
      1 +
      ((rows.length - index) /
        rows.length) * 2;

    score += weight;
  });

  return score;
}

function getStreak(rows) {
  if (!rows.length) {
    return {
      side: null,
      length: 0,
    };
  }

  const side = rows[0].result;

  let length = 1;

  while (
    length < rows.length &&
    length < 12 &&
    rows[length].result === side
  ) {
    length++;
  }

  return {
    side,
    length,
  };
}

function alternatingScore(rows) {
  if (rows.length < 4) {
    return {
      score: 0,
      side: null,
    };
  }

  let matches = 0;

  for (let i = 1; i < rows.length; i++) {
    if (
      rows[i].result !==
      rows[i - 1].result
    ) {
      matches++;
    }
  }

  const ratio =
    matches / (rows.length - 1);

  if (ratio < 0.70) {
    return {
      score: 0,
      side: null,
    };
  }

  return {
    score: ratio,
    side:
      rows[0].result === "BIG"
        ? "SMALL"
        : "BIG",
  };
}

function split22Score(rows) {
  if (rows.length < 6) {
    return {
      score: 0,
      side: null,
    };
  }

  const a = rows[0].result;
  const b = rows[1].result;

  if (a !== b) {
    return {
      score: 0,
      side: null,
    };
  }

  let pairs = 0;

  for (
    let i = 0;
    i + 1 < rows.length;
    i += 2
  ) {
    if (
      rows[i].result ===
        rows[i + 1].result &&
      rows[i].result ===
        (i % 4 === 0 ? a : b)
    ) {
      pairs++;
    }
  }

  if (pairs < 2) {
    return {
      score: 0,
      side: null,
    };
  }

  return {
    score: pairs / Math.ceil(rows.length / 2),
    side:
      a === "BIG"
        ? "SMALL"
        : "BIG",
  };
}

function transitionScore(rows) {
  if (rows.length < 5) {
    return {
      big: 0,
      small: 0,
    };
  }

  let bigAfterSmall = 0;
  let smallAfterBig = 0;

  for (let i = 1; i < rows.length; i++) {
    const previous =
      rows[i - 1].result;

    const current =
      rows[i].result;

    if (
      previous === "SMALL" &&
      current === "BIG"
    ) {
      bigAfterSmall++;
    }

    if (
      previous === "BIG" &&
      current === "SMALL"
    ) {
      smallAfterBig++;
    }
  }

  return {
    big: bigAfterSmall,
    small: smallAfterBig,
  };
}

function analyzeHistory(history) {
  const rows =
    validResults(history);

  if (rows.length < 5) {
    return {
      prediction: "WAIT",
      confidence: 0,
      regime: "INSUFFICIENT DATA",
      streak: getStreak(rows),
      bigPercent: 50,
      smallPercent: 50,
      modelVersion: "DY-AI-2.0",
    };
  }

  const w5 =
    recentWindow(rows, 5);

  const w10 =
    recentWindow(rows, 10);

  const w20 =
    recentWindow(rows, 20);

  const w30 =
    recentWindow(rows, 30);

  let big = 0;
  let small = 0;

  /*
    Recent windows carry greater weight.
  */

  big += sideScore(w5, "BIG") * 4;
  small += sideScore(w5, "SMALL") * 4;

  big += sideScore(w10, "BIG") * 2.5;
  small += sideScore(w10, "SMALL") * 2.5;

  big += sideScore(w20, "BIG") * 1.5;
  small += sideScore(w20, "SMALL") * 1.5;

  big += sideScore(w30, "BIG") * 1;
  small += sideScore(w30, "SMALL") * 1;


  /* Transition analysis */

  const transition =
    transitionScore(w10);

  big += transition.big * 1.25;
  small += transition.small * 1.25;


  /* Alternating pattern */

  const alternating =
    alternatingScore(w10);

  if (alternating.score > 0) {
    if (alternating.side === "BIG") {
      big +=
        alternating.score * 4;
    } else {
      small +=
        alternating.score * 4;
    }
  }


  /* 2-2 pattern */

  const split =
    split22Score(w10);

  if (split.score > 0) {
    if (split.side === "BIG") {
      big += split.score * 2;
    } else {
      small += split.score * 2;
    }
  }


  /* Current streak */

  const streak =
    getStreak(rows);

  /*
    Do not blindly follow a long streak.
    The streak becomes a regime signal,
    not a guaranteed reversal.
  */

  if (streak.length >= 5) {
    if (streak.side === "BIG") {
      big *= 0.78;
    } else {
      small *= 0.78;
    }
  } else if (streak.length >= 3) {
    if (streak.side === "BIG") {
      big *= 0.92;
    } else {
      small *= 0.92;
    }
  }


  const total =
    big + small;

  if (total <= 0) {
    return {
      prediction: "WAIT",
      confidence: 0,
      regime: "NO SIGNAL",
      streak,
      bigPercent: 50,
      smallPercent: 50,
      modelVersion: "DY-AI-2.0",
    };
  }

  const bigPercent =
    Math.round(
      (big / total) * 100
    );

  const smallPercent =
    100 - bigPercent;

  const gap =
    Math.abs(
      bigPercent -
      smallPercent
    );

  let prediction;

  if (gap < 8) {
    prediction = "BALANCED";
  } else if (
    bigPercent > smallPercent
  ) {
    prediction = "BIG";
  } else {
    prediction = "SMALL";
  }

  /*
    Confidence is an analytical strength score,
    not a guarantee of the next outcome.
  */

  let confidence =
    50 + gap * 0.85;

  if (streak.length >= 5) {
    confidence -= 5;
  }

  if (alternating.score >= 0.8) {
    confidence += 3;
  }

  if (split.score >= 0.5) {
    confidence += 2;
  }

  confidence = Math.max(
    50,
    Math.min(
      95,
      Math.round(confidence)
    )
  );


  let regime =
    "MIXED";

  if (streak.length >= 5) {
    regime = "LONG STREAK";
  } else if (
    alternating.score >= 0.75
  ) {
    regime = "ALTERNATING";
  } else if (
    split.score >= 0.5
  ) {
    regime = "2-2 SPLIT";
  } else if (
    gap >= 15
  ) {
    regime = "DIRECTIONAL";
  } else {
    regime = "BALANCED";
  }


  return {
    prediction,
    confidence,
    regime,
    streak,
    bigPercent,
    smallPercent,

    signals: {
      transition,
      alternating:
        Number(
          alternating.score.toFixed(3)
        ),
      split22:
        Number(
          split.score.toFixed(3)
        ),
    },

    modelVersion:
      "DY-AI-2.0"
  };
}


/* =========================================================
   DATABASE PREDICTIONS
========================================================= */

async function getPrediction(issue) {
  if (!DATABASE_URL || !issue) {
    return null;
  }

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
}

async function createPrediction(
  issue,
  analysis
) {
  if (!DATABASE_URL) return null;

  const existing =
    await getPrediction(issue);

  if (existing) {
    return existing;
  }

  if (
    !analysis ||
    !["BIG", "SMALL"].includes(
      analysis.prediction
    )
  ) {
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
          created_at
        )
        VALUES ($1,$2,$3,$4,$5)
        RETURNING *
      `,
      [
        String(issue),
        analysis.prediction,
        analysis.confidence,
        analysis.modelVersion,
        now(),
      ]
    );

  return result.rows[0];
}


/* =========================================================
   SETTLEMENT
========================================================= */

async function settlePredictions() {
  if (!DATABASE_URL) return;

  const history =
    providerState.history || [];

  const settledMap =
    new Map();

  for (const row of history) {
    if (
      row.issueNumber &&
      row.result
    ) {
      settledMap.set(
        String(row.issueNumber),
        row
      );
    }
  }

  const pending =
    await pool.query(
      `
        SELECT *
        FROM prediction_records
        WHERE actual_result IS NULL
        ORDER BY id ASC
        LIMIT 100
      `
    );

  for (const prediction of pending.rows) {
    const actual =
      settledMap.get(
        String(prediction.target_issue)
      );

    /*
      Exact issue match only.
    */

    if (!actual) continue;

    const actualResult =
      actual.result;

    const isWin =
      prediction.prediction ===
      actualResult;

    await pool.query(
      `
        UPDATE prediction_records
        SET
          actual_number = $1,
          actual_result = $2,
          settled_at = $3
        WHERE id = $4
      `,
      [
        actual.number,
        actualResult,
        now(),
        prediction.id,
      ]
    );

    console.log(
      "Settled:",
      prediction.target_issue,
      prediction.prediction,
      actualResult,
      isWin ? "WIN" : "LOSS"
    );
  }
}


/* =========================================================
   ACCESS KEY
========================================================= */

async function checkAccess(
  req
) {
  if (!DATABASE_URL) {
    return {
      ok: true,
      key: null,
    };
  }

  const key =
    String(
      req.headers["x-access-key"] ||
      ""
    ).trim();

  const device =
    String(
      req.headers["x-device-id"] ||
      ""
    ).trim();

  if (!key || !device) {
    return {
      ok: false,
      reason:
        "ACCESS_KEY_OR_DEVICE_MISSING",
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
      [key]
    );

  if (!result.rows.length) {
    return {
      ok: false,
      reason: "INVALID_ACCESS_KEY",
    };
  }

  const row =
    result.rows[0];

  if (
    row.device_id &&
    row.device_id !== device
  ) {
    return {
      ok: false,
      reason:
        "KEY_ALREADY_BOUND_TO_ANOTHER_DEVICE",
    };
  }

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
        device,
        now(),
        row.id,
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
        row.id,
      ]
    );
  }

  return {
    ok: true,
    key: row.access_key,
  };
}


/* =========================================================
   STATIC FILES
========================================================= */

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
    "image/x-icon",
};

function safeStaticPath(
  pathname
) {
  const clean =
    decodeURIComponent(pathname)
      .replace(/^\/+/, "");

  const resolved =
    path.resolve(
      ROOT,
      clean || "prediction.html"
    );

  if (
    !resolved.startsWith(
      path.resolve(ROOT)
    )
  ) {
    return null;
  }

  return resolved;
}

function serveStatic(
  req,
  res,
  pathname
) {
  let filePath =
    safeStaticPath(pathname);

  if (!filePath) {
    text(res, 403, "Forbidden");
    return;
  }

  if (!fs.existsSync(filePath)) {
    if (pathname === "/") {
      filePath =
        path.join(
          ROOT,
          "prediction.html"
        );
    }
  }

  if (
    !fs.existsSync(filePath) ||
    !fs.statSync(filePath).isFile()
  ) {
    text(res, 404, "Not Found");
    return;
  }

  const ext =
    path.extname(filePath)
      .toLowerCase();

  const type =
    MIME[ext] ||
    "application/octet-stream";

  const stat =
    fs.statSync(filePath);

  /*
    MP3 range support.
  */

  if (ext === ".mp3") {
    const range =
      req.headers.range;

    if (!range) {
      res.writeHead(200, {
        "Content-Type": type,
        "Content-Length": stat.size,
        "Accept-Ranges": "bytes",
      });

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
      res.writeHead(416);
      res.end();
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
      start < 0 ||
      end >= stat.size ||
      start > end
    ) {
      res.writeHead(416);
      res.end();
      return;
    }

    res.writeHead(206, {
      "Content-Type": type,
      "Content-Length":
        end - start + 1,
      "Content-Range":
        `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges": "bytes",
    });

    fs.createReadStream(
      filePath,
      {
        start,
        end,
      }
    ).pipe(res);

    return;
  }

  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": stat.size,
    "Cache-Control": "no-cache",
  });

  fs.createReadStream(
    filePath
  ).pipe(res);
}


/* =========================================================
   API HANDLER
========================================================= */

async function handleAPI(
  req,
  res,
  url
) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin":
        "*",

      "Access-Control-Allow-Headers":
        "Content-Type, X-Access-Key, X-Device-Id, Authorization",

      "Access-Control-Allow-Methods":
        "GET, POST, DELETE, OPTIONS",
    });

    res.end();
    return true;
  }


  /* Health */

  if (
    req.method === "GET" &&
    url.pathname === "/health"
  ) {
    json(res, 200, {
      ok: true,
      service: "DY AI Wingo",
      version: "2.0",
      provider:
        providerState.error
          ? "ERROR"
          : "ONLINE",
      history:
        providerState.history.length,
      time: now(),
    });

    return true;
  }


  /* Public key check */

  if (
    req.method === "POST" &&
    url.pathname === "/api/key/check"
  ) {
    try {
      const body =
        await parseBody(req);

      const fakeReq = {
        headers: {
          "x-access-key":
            body.accessKey || "",
          "x-device-id":
            body.deviceId || "",
        },
      };

      const result =
        await checkAccess(
          fakeReq
        );

      json(
        res,
        result.ok ? 200 : 403,
        result
      );
    } catch (err) {
      json(res, 400, {
        ok: false,
        error: err.message,
      });
    }

    return true;
  }


  /* State */

  if (
    req.method === "GET" &&
    url.pathname === "/api/state"
  ) {
    const access =
      await checkAccess(req);

    if (!access.ok) {
      json(res, 403, access);
      return true;
    }

    const history =
      providerState.history || [];

    const target =
      resolveTargetIssue();

    const analysis =
      analyzeHistory(history);

    let prediction =
      await getPrediction(target);

    /*
      One prediction per target issue.
    */

    if (
      !prediction &&
      analysis.prediction !==
        "WAIT" &&
      analysis.prediction !==
        "BALANCED"
    ) {
      prediction =
        await createPrediction(
          target,
          analysis
        );
    }

    json(res, 200, {
      ok: true,

      provider: {
        currentIssue:
          providerState.currentIssue,

        lastFetch:
          providerState.lastFetch,

        error:
          providerState.error,

        stats:
          providerState.stats,
      },

      targetIssue: target,

      analysis,

      prediction,

      history:
        history.slice(0, 30),
    });

    return true;
  }


  /* History */

  if (
    req.method === "GET" &&
    url.pathname === "/api/history"
  ) {
    const access =
      await checkAccess(req);

    if (!access.ok) {
      json(res, 403, access);
      return true;
    }

    const limit =
      Math.min(
        100,
        Math.max(
          1,
          Number(
            url.searchParams.get(
              "limit"
            ) || 30
          )
        )
      );

    if (!DATABASE_URL) {
      json(res, 200, {
        ok: true,
        records: [],
      });

      return true;
    }

    const result =
      await pool.query(
        `
          SELECT *
          FROM prediction_records
          ORDER BY id DESC
          LIMIT $1
        `,
        [limit]
      );

    json(res, 200, {
      ok: true,
      records: result.rows,
    });

    return true;
  }


  /* Admin auth */

  function adminAllowed() {
    const key =
      String(
        req.headers.authorization ||
        ""
      ).replace(
        /^Bearer\s+/i,
        ""
      );

    return (
      ADMIN_KEY &&
      key === ADMIN_KEY
    );
  }


  /* Admin status */

  if (
    req.method === "GET" &&
    url.pathname ===
      "/api/admin/status"
  ) {
    if (!adminAllowed()) {
      json(res, 401, {
        ok: false,
        error: "Unauthorized",
      });

      return true;
    }

    json(res, 200, {
      ok: true,

      provider: {
        currentIssue:
          providerState.currentIssue,

        history:
          providerState.history.length,

        lastFetch:
          providerState.lastFetch,

        error:
          providerState.error,
      },

      database:
        Boolean(DATABASE_URL),

      token:
        Boolean(WINGOBOT_TOKEN),
    });

    return true;
  }


  /* Admin ping */

  if (
    req.method === "GET" &&
    url.pathname ===
      "/api/admin/ping"
  ) {
    if (!adminAllowed()) {
      json(res, 401, {
        ok: false,
      });

      return true;
    }

    json(res, 200, {
      ok: true,
      message:
        "DY AI admin online",
      time: now(),
    });

    return true;
  }


  /* Admin provider test */

  if (
    req.method === "GET" &&
    url.pathname ===
      "/api/admin/wingo-test"
  ) {
    if (!adminAllowed()) {
      json(res, 401, {
        ok: false,
        error: "Unauthorized",
      });

      return true;
    }

    try {
      const data =
        await fetchWingoBot();

      json(res, 200, {
        ok: true,

        current:
          data?.current || null,

        historyCount:
          Array.isArray(
            data?.history
          )
            ? data.history.length
            : 0,

        stats:
          data?.stats || {},
      });
    } catch (err) {
      json(res, 502, {
        ok: false,
        error: err.message,
      });
    }

    return true;
  }


  /* Admin model test */

  if (
    req.method === "GET" &&
    url.pathname ===
      "/api/admin/model-test"
  ) {
    if (!adminAllowed()) {
      json(res, 401, {
        ok: false,
        error: "Unauthorized",
      });

      return true;
    }

    const analysis =
      analyzeHistory(
        providerState.history
      );

    json(res, 200, {
      ok: true,
      analysis,
      sample:
        providerState.history
          .slice(0, 30),
    });

    return true;
  }


  /* Admin create keys */

  if (
    req.method === "POST" &&
    url.pathname ===
      "/api/admin/keys"
  ) {
    if (!adminAllowed()) {
      json(res, 401, {
        ok: false,
        error: "Unauthorized",
      });

      return true;
    }

    const body =
      await parseBody(req);

    const count =
      Math.min(
        100,
        Math.max(
          1,
          Number(
            body.count || 1
          )
        )
      );

    const keys = [];

    for (
      let i = 0;
      i < count;
      i++
    ) {
      const key =
        body.prefix
          ? String(body.prefix) +
            "-" +
            randomKey()
          : randomKey();

      if (DATABASE_URL) {
        await pool.query(
          `
            INSERT INTO access_keys
            (
              access_key,
              created_at
            )
            VALUES ($1,$2)
            ON CONFLICT
            (access_key)
            DO NOTHING
          `,
          [key, now()]
        );
      }

      keys.push(key);
    }

    json(res, 200, {
      ok: true,
      keys,
    });

    return true;
  }


  /* Admin list keys */

  if (
    req.method === "GET" &&
    url.pathname ===
      "/api/admin/keys"
  ) {
    if (!adminAllowed()) {
      json(res, 401, {
        ok: false,
        error: "Unauthorized",
      });

      return true;
    }

    if (!DATABASE_URL) {
      json(res, 200, {
        ok: true,
        keys: [],
      });

      return true;
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

    json(res, 200, {
      ok: true,
      keys: result.rows,
    });

    return true;
  }


  /* Admin delete key */

  if (
    req.method === "DELETE" &&
    url.pathname ===
      "/api/admin/keys"
  ) {
    if (!adminAllowed()) {
      json(res, 401, {
        ok: false,
        error: "Unauthorized",
      });

      return true;
    }

    const body =
      await parseBody(req);

    const key =
      String(
        body.accessKey || ""
      ).trim();

    if (!key) {
      json(res, 400, {
        ok: false,
        error:
          "accessKey required",
      });

      return true;
    }

    if (DATABASE_URL) {
      await pool.query(
        `
          DELETE FROM access_keys
          WHERE access_key = $1
        `,
        [key]
      );
    }

    json(res, 200, {
      ok: true,
    });

    return true;
  }


  /* Admin reset device */

  if (
    req.method === "POST" &&
    url.pathname ===
      "/api/admin/reset-device"
  ) {
    if (!adminAllowed()) {
      json(res, 401, {
        ok: false,
        error: "Unauthorized",
      });

      return true;
    }

    const body =
      await parseBody(req);

    const key =
      String(
        body.accessKey || ""
      ).trim();

    if (!key) {
      json(res, 400, {
        ok: false,
        error:
          "accessKey required",
      });

      return true;
    }

    if (DATABASE_URL) {
      await pool.query(
        `
          UPDATE access_keys
          SET device_id = NULL
          WHERE access_key = $1
        `,
        [key]
      );
    }

    json(res, 200, {
      ok: true,
      message:
        "Device binding reset",
    });

    return true;
  }


  return false;
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

        const handled =
          await handleAPI(
            req,
            res,
            url
          );

        if (handled) return;

        if (
          req.method === "GET" ||
          req.method === "HEAD"
        ) {
          serveStatic(
            req,
            res,
            url.pathname
          );

          return;
        }

        json(res, 405, {
          ok: false,
          error:
            "Method not allowed",
        });
      } catch (err) {
        console.error(
          "Server error:",
          err
        );

        if (!res.headersSent) {
          json(res, 500, {
            ok: false,
            error:
              "Internal server error",
          });
        }
      }
    }
  );


/* =========================================================
   STARTUP
========================================================= */

async function start() {
  try {
    await initDB();
  } catch (err) {
    console.error(
      "Database initialization failed:",
      err.message
    );
  }

  server.listen(
    PORT,
    "0.0.0.0",
    () => {
      console.log(
        `DY AI Wingo running on port ${PORT}`
      );
    }
  );

  /*
    First provider refresh.
  */

  await refreshProvider();

  /*
    Keep provider history reasonably fresh.
  */

  setInterval(
    refreshProvider,
    3000
  );
}

start();


/* =========================================================
   SAFE SHUTDOWN
========================================================= */

process.on(
  "SIGTERM",
  async () => {
    try {
      await pool.end();
    } catch {}

    server.close(() => {
      process.exit(0);
    });
  }
);

process.on(
  "SIGINT",
  async () => {
    try {
      await pool.end();
    } catch {}

    server.close(() => {
      process.exit(0);
    });
  }
);
