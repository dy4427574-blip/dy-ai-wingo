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

const ADMIN_KEY =
  String(process.env.ADMIN_KEY || "").trim();

const WINGOBOT_TOKEN =
  String(process.env.WINGOBOT_TOKEN || "").trim();

const DATABASE_URL =
  String(process.env.DATABASE_URL || "").trim();

const PUBLIC_DIR = __dirname;

const WINGOBOT_API =
  "https://api.wingobot.com/v2/30-sec-game-history";

const REFRESH_MS = 3000;


/* =========================================================
   DATABASE
========================================================= */

let pool = null;

if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    }
  });
}

async function dbQuery(text, params = []) {
  if (!pool) {
    throw new Error("DATABASE_URL missing");
  }

  return pool.query(text, params);
}


async function initDatabase() {

  if (!pool) {
    console.log("DATABASE_URL not configured");
    return;
  }

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS access_keys (
      id SERIAL PRIMARY KEY,
      access_key TEXT UNIQUE NOT NULL,
      device_id TEXT,
      created_at BIGINT NOT NULL,
      last_seen BIGINT DEFAULT 0
    )
  `);

  await dbQuery(`
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

  console.log("Database ready");
}


/* =========================================================
   MEMORY CACHE
========================================================= */

let liveState = {
  ok: false,
  updatedAt: 0,
  currentIssue: null,
  latestSettledIssue: null,
  history: [],
  analysis: null,
  error: null
};


/* =========================================================
   HTTP JSON HELPER
========================================================= */

function requestJSON(url, options = {}) {

  return new Promise((resolve, reject) => {

    const parsed = new URL(url);

    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: options.method || "GET",
      headers: options.headers || {},
      timeout: 10000
    }, res => {

      let body = "";

      res.on("data", chunk => {
        body += chunk;
      });

      res.on("end", () => {

        if (res.statusCode < 200 || res.statusCode >= 300) {

          reject(
            new Error(
              `Provider HTTP ${res.statusCode}`
            )
          );

          return;
        }

        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(
            new Error("Invalid provider JSON")
          );
        }

      });

    });

    req.on("timeout", () => {
      req.destroy(
        new Error("Provider request timeout")
      );
    });

    req.on("error", reject);

    req.end();

  });

}


/* =========================================================
   NORMALIZATION
========================================================= */

function normalizeResult(row) {

  if (!row || typeof row !== "object") {
    return null;
  }

  const issue =
    row.issueNumber ??
    row.issue ??
    row.period ??
    row.periodNumber;

  const numberRaw =
    row.number ??
    row.resultNumber ??
    row.value;

  const number =
    Number.isInteger(Number(numberRaw))
      ? Number(numberRaw)
      : null;

  let result = null;

  if (
    typeof row.bigSmall === "string"
  ) {
    result = row.bigSmall.trim().toUpperCase();
  }

  if (
    typeof row.result === "string" &&
    !result
  ) {
    const s = row.result.trim().toUpperCase();

    if (s === "BIG" || s === "SMALL") {
      result = s;
    }
  }

  if (!result && number !== null) {
    if (number >= 0 && number <= 9) {
      result =
        number >= 5
          ? "BIG"
          : "SMALL";
    }
  }

  if (
    result !== "BIG" &&
    result !== "SMALL"
  ) {
    result = null;
  }

  return {
    issue: issue == null
      ? null
      : String(issue),

    number,

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
}


function normalizeHistory(data) {

  const source =
    Array.isArray(data?.history)
      ? data.history
      : [];

  return source
    .map(normalizeResult)
    .filter(Boolean);
}


/* =========================================================
   ISSUE HELPERS
========================================================= */

function incrementIssue(issue) {

  if (!issue) return null;

  try {
    return (
      BigInt(String(issue)) + 1n
    ).toString();
  } catch {
    return null;
  }
}


function resolveTargetIssue(
  currentIssue,
  history
) {

  const latest =
    history[0]?.issue;

  if (!latest) {
    return currentIssue || null;
  }

  if (!currentIssue) {
    return incrementIssue(latest);
  }

  try {

    const current =
      BigInt(String(currentIssue));

    const settled =
      BigInt(String(latest));

    if (current > settled) {
      return current.toString();
    }

    return (settled + 1n).toString();

  } catch {

    return currentIssue;
  }
}


/* =========================================================
   STATISTICAL ANALYSIS
========================================================= */

function validSides(history) {

  return history
    .map(x => x.result)
    .filter(
      x => x === "BIG" || x === "SMALL"
    );
}


function countStreak(values) {

  if (!values.length) {
    return {
      side: null,
      length: 0
    };
  }

  const side = values[0];

  let length = 1;

  while (
    length < values.length &&
    values[length] === side
  ) {
    length++;
  }

  return {
    side,
    length
  };
}


function windowStats(values, size) {

  const arr =
    values.slice(0, size);

  if (!arr.length) {
    return {
      big: 0,
      small: 0,
      total: 0
    };
  }

  const big =
    arr.filter(x => x === "BIG").length;

  const small =
    arr.filter(x => x === "SMALL").length;

  return {
    big,
    small,
    total: arr.length
  };
}


function transitionStats(values) {

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

  for (
    let i = 0;
    i < values.length - 1;
    i++
  ) {

    const current = values[i];
    const previous = values[i + 1];

    if (
      matrix[previous] &&
      matrix[previous][current] !== undefined
    ) {
      matrix[previous][current]++;
    }
  }

  return matrix;
}


function alternationScore(values) {

  if (values.length < 4) {
    return 0;
  }

  let flips = 0;

  for (
    let i = 0;
    i < values.length - 1;
    i++
  ) {

    if (values[i] !== values[i + 1]) {
      flips++;
    }
  }

  return flips / (values.length - 1);
}


function meanNumber(history, size) {

  const nums =
    history
      .slice(0, size)
      .map(x => x.number)
      .filter(
        n =>
          Number.isInteger(n) &&
          n >= 0 &&
          n <= 9
      );

  if (!nums.length) {
    return null;
  }

  return (
    nums.reduce(
      (a, b) => a + b,
      0
    ) / nums.length
  );
}


/*
  Important:
  This function is intentionally an ANALYSIS score,
  not a guaranteed future-result predictor.
*/

function analyzeHistory(history) {

  const values =
    validSides(history);

  if (values.length < 5) {

    return {
      status: "WAITING",
      message: "Need more settled history",
      windows: {},
      streak: countStreak(values),
      transitions: null,
      alternation: 0,
      mean: meanNumber(history, 10)
    };
  }

  const w5 =
    windowStats(values, 5);

  const w10 =
    windowStats(values, 10);

  const w20 =
    windowStats(values, 20);

  const streak =
    countStreak(values);

  const transitions =
    transitionStats(values);

  const alternation =
    alternationScore(values);

  const mean =
    meanNumber(history, 10);

  let bigScore = 0;
  let smallScore = 0;

  /*
    Recent window gets more weight.
  */

  bigScore +=
    (w5.big / Math.max(w5.total, 1))
    * 5;

  smallScore +=
    (w5.small / Math.max(w5.total, 1))
    * 5;


  bigScore +=
    (w10.big / Math.max(w10.total, 1))
    * 2.5;

  smallScore +=
    (w10.small / Math.max(w10.total, 1))
    * 2.5;


  bigScore +=
    (w20.big / Math.max(w20.total, 1))
    * 1.5;

  smallScore +=
    (w20.small / Math.max(w20.total, 1))
    * 1.5;


  /*
    Mean is secondary only.
  */

  if (mean !== null) {

    if (mean > 4.5) {
      bigScore += 0.7;
    }

    if (mean < 4.5) {
      smallScore += 0.7;
    }
  }


  /*
    Streak is reported but not blindly reversed.
  */

  let streakNote = "NORMAL";

  if (streak.length >= 3) {
    streakNote =
      `${streak.side} streak ${streak.length}`;
  }


  /*
    Transition information.
  */

  const lastSide = values[0];

  if (lastSide === "BIG") {

    if (
      transitions.BIG.SMALL >
      transitions.BIG.BIG
    ) {
      smallScore += 0.8;
    }

    if (
      transitions.BIG.BIG >
      transitions.BIG.SMALL
    ) {
      bigScore += 0.8;
    }

  } else {

    if (
      transitions.SMALL.BIG >
      transitions.SMALL.SMALL
    ) {
      bigScore += 0.8;
    }

    if (
      transitions.SMALL.SMALL >
      transitions.SMALL.BIG
    ) {
      smallScore += 0.8;
    }
  }


  /*
    If sequence is strongly alternating,
    mark it as unstable instead of forcing a side.
  */

  let status = "BALANCED";

  const difference =
    Math.abs(
      bigScore - smallScore
    );

  if (alternation >= 0.75) {
    status = "ALTERNATING / UNSTABLE";
  } else if (difference >= 1.4) {
    status =
      bigScore > smallScore
        ? "BIG BIAS"
        : "SMALL BIAS";
  }


  const total =
    bigScore + smallScore;

  const bigPct =
    total > 0
      ? Math.round(
          bigScore / total * 100
        )
      : 50;

  const smallPct =
    100 - bigPct;


  return {

    status,

    bigPct,

    smallPct,

    windows: {
      w5,
      w10,
      w20
    },

    streak: {
      side: streak.side,
      length: streak.length,
      note: streakNote
    },

    transitions,

    alternation,

    mean,

    difference:

      Number(
        difference.toFixed(2)
      ),

    updatedAt: Date.now()
  };
}


/* =========================================================
   PROVIDER REFRESH
========================================================= */

async function refreshProvider() {

  if (!WINGOBOT_TOKEN) {

    liveState = {
      ...liveState,
      ok: false,
      error: "WINGOBOT_TOKEN missing"
    };

    return;
  }


  try {

    const data =
      await requestJSON(
        WINGOBOT_API,
        {
          headers: {
            "Authorization":
              "Bearer " +
              WINGOBOT_TOKEN,

            "Accept":
              "application/json",

            "User-Agent":
              "DY-AI-Wingo/1.0"
          }
        }
      );


    const history =
      normalizeHistory(data);


    const currentIssue =
      data?.current?.issueNumber
        ? String(
            data.current.issueNumber
          )
        : null;


    const latestSettledIssue =
      history[0]?.issue || null;


    const targetIssue =
      resolveTargetIssue(
        currentIssue,
        history
      );


    const analysis =
      analyzeHistory(history);


    liveState = {

      ok: true,

      updatedAt: Date.now(),

      currentIssue,

      targetIssue,

      latestSettledIssue,

      history: history.slice(0, 30),

      analysis,

      providerStats:
        data?.stats || null,

      error: null
    };


    await settleRecords(history);

  } catch (err) {

    console.error(
      "Provider refresh:",
      err.message
    );

    liveState = {
      ...liveState,
      ok: false,
      error: err.message
    };
  }
}


/* =========================================================
   SETTLEMENT
========================================================= */

async function settleRecords(history) {

  if (!pool || !history.length) {
    return;
  }

  for (const row of history.slice(0, 30)) {

    if (!row.issue || !row.result) {
      continue;
    }

    await dbQuery(`
      UPDATE prediction_records
      SET
        actual_number = $1,
        actual_result = $2,
        settled_at = $3
      WHERE target_issue = $4
        AND settled_at IS NULL
    `, [
      row.number,
      row.result,
      Date.now(),
      row.issue
    ]);
  }
}


/* =========================================================
   ACCESS KEY
========================================================= */

function getHeader(req, name) {

  const key =
    Object.keys(req.headers)
      .find(
        k => k.toLowerCase() === name.toLowerCase()
      );

  return key
    ? req.headers[key]
    : "";
}


async function verifyAccess(req) {

  if (!pool) {
    return {
      ok: true,
      demo: true
    };
  }

  const accessKey =
    String(
      getHeader(req, "x-access-key") || ""
    ).trim();

  const deviceId =
    String(
      getHeader(req, "x-device-id") || ""
    ).trim();


  if (!accessKey || !deviceId) {

    return {
      ok: false,
      status: 401,
      message: "Access key and device ID required"
    };
  }


  const result =
    await dbQuery(`
      SELECT *
      FROM access_keys
      WHERE access_key = $1
      LIMIT 1
    `, [accessKey]);


  if (!result.rows.length) {

    return {
      ok: false,
      status: 403,
      message: "Invalid access key"
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
      status: 403,
      message: "Key already bound to another device"
    };
  }


  if (!row.device_id) {

    await dbQuery(`
      UPDATE access_keys
      SET
        device_id = $1,
        last_seen = $2
      WHERE id = $3
    `, [
      deviceId,
      Date.now(),
      row.id
    ]);

  } else {

    await dbQuery(`
      UPDATE access_keys
      SET last_seen = $1
      WHERE id = $2
    `, [
      Date.now(),
      row.id
    ]);
  }


  return {
    ok: true,
    keyId: row.id
  };
}


/* =========================================================
   ADMIN
========================================================= */

function verifyAdmin(req) {

  if (!ADMIN_KEY) {
    return false;
  }

  const supplied =
    String(
      getHeader(req, "x-admin-key") || ""
    ).trim();

  return (
    supplied &&
    supplied === ADMIN_KEY
  );
}


function randomKey() {

  return (
    "DY-" +
    crypto
      .randomBytes(10)
      .toString("hex")
      .toUpperCase()
  );
}


/* =========================================================
   BODY
========================================================= */

function readBody(req) {

  return new Promise((resolve, reject) => {

    let body = "";

    req.on("data", chunk => {

      body += chunk;

      if (body.length > 1024 * 1024) {
        req.destroy();
        reject(
          new Error("Request too large")
        );
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


/* =========================================================
   JSON RESPONSE
========================================================= */

function sendJSON(
  res,
  status,
  data
) {

  const output =
    JSON.stringify(data);

  res.writeHead(status, {
    "Content-Type":
      "application/json; charset=utf-8",

    "Cache-Control":
      "no-store",

    "Access-Control-Allow-Origin":
      "*",

    "Access-Control-Allow-Headers":
      "Content-Type, X-Access-Key, X-Device-Id, X-Admin-Key",

    "Access-Control-Allow-Methods":
      "GET,POST,DELETE,OPTIONS"
  });

  res.end(output);
}


/* =========================================================
   STATIC FILES
========================================================= */

const MIME = {

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
    "audio/mpeg",

  ".ico":
    "image/x-icon"
};


function safeFilePath(urlPath) {

  let decoded;

  try {
    decoded =
      decodeURIComponent(urlPath);
  } catch {
    return null;
  }

  decoded =
    decoded.split("?")[0];

  if (
    decoded === "/" ||
    decoded === ""
  ) {
    decoded = "/prediction.html";
  }

  const full =
    path.normalize(
      path.join(
        PUBLIC_DIR,
        decoded
      )
    );


  if (
    !full.startsWith(
      path.normalize(PUBLIC_DIR + path.sep)
    )
  ) {
    return null;
  }

  return full;
}


function serveStatic(req, res) {

  const filePath =
    safeFilePath(req.url);

  if (!filePath) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }


  fs.stat(filePath, (err, stat) => {

    if (err || !stat.isFile()) {

      res.writeHead(404, {
        "Content-Type":
          "text/plain; charset=utf-8"
      });

      res.end("Not Found");

      return;
    }


    const ext =
      path.extname(filePath)
        .toLowerCase();

    const type =
      MIME[ext] ||
      "application/octet-stream";


    /*
      MP3 range support
    */

    if (
      ext === ".mp3" &&
      req.headers.range
    ) {

      const range =
        req.headers.range;

      const match =
        /bytes=(\d*)-(\d*)/.exec(
          range
        );

      if (match) {

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

          res.writeHead(416);
          res.end();
          return;
        }


        res.writeHead(206, {

          "Content-Type":
            type,

          "Content-Length":
            end - start + 1,

          "Content-Range":
            `bytes ${start}-${end}/${stat.size}`,

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
    }


    res.writeHead(200, {

      "Content-Type":
        type,

      "Content-Length":
        stat.size,

      "Cache-Control":
        ext === ".html"
          ? "no-cache"
          : "public, max-age=3600",

      "Accept-Ranges":
        ext === ".mp3"
          ? "bytes"
          : undefined

    });


    fs.createReadStream(
      filePath
    ).pipe(res);

  });
}


/* =========================================================
   ROUTER
========================================================= */

const server =
  http.createServer(
    async (req, res) => {

      try {

        if (req.method === "OPTIONS") {

          res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers":
              "Content-Type, X-Access-Key, X-Device-Id, X-Admin-Key",
            "Access-Control-Allow-Methods":
              "GET,POST,DELETE,OPTIONS"
          });

          res.end();

          return;
        }


        const url =
          new URL(
            req.url,
            `http://${req.headers.host}`
          );


        /* HEALTH */

        if (
          url.pathname === "/health"
        ) {

          sendJSON(
            res,
            200,
            {
              ok: true,
              service: "DY AI WinGo",
              time: Date.now()
            }
          );

          return;
        }


        /* STATE */

        if (
          url.pathname === "/api/state"
        ) {

          const access =
            await verifyAccess(req);

          if (!access.ok) {

            sendJSON(
              res,
              access.status,
              {
                ok: false,
                error: access.message
              }
            );

            return;
          }


          sendJSON(
            res,
            200,
            {
              ok: liveState.ok,
              updatedAt:
                liveState.updatedAt,

              currentIssue:
                liveState.currentIssue,

              targetIssue:
                liveState.targetIssue,

              latestSettledIssue:
                liveState.latestSettledIssue,

              history:
                liveState.history,

              analysis:
                liveState.analysis,

              providerStats:
                liveState.providerStats,

              error:
                liveState.error
            }
          );

          return;
        }


        /* KEY CHECK */

        if (
          url.pathname === "/api/key/check" &&
          req.method === "POST"
        ) {

          const body =
            await readBody(req);

          const accessKey =
            String(
              body.accessKey || ""
            ).trim();

          const deviceId =
            String(
              body.deviceId || ""
            ).trim();


          if (!accessKey || !deviceId) {

            sendJSON(
              res,
              400,
              {
                ok: false,
                error:
                  "accessKey and deviceId required"
              }
            );

            return;
          }


          if (!pool) {

            sendJSON(
              res,
              200,
              {
                ok: true,
                demo: true
              }
            );

            return;
          }


          const result =
            await dbQuery(`
              SELECT *
              FROM access_keys
              WHERE access_key = $1
              LIMIT 1
            `, [accessKey]);


          if (!result.rows.length) {

            sendJSON(
              res,
              403,
              {
                ok: false,
                error:
                  "Invalid access key"
              }
            );

            return;
          }


          const row =
            result.rows[0];


          if (
            row.device_id &&
            row.device_id !== deviceId
          ) {

            sendJSON(
              res,
              403,
              {
                ok: false,
                error:
                  "This key is already bound to another device"
              }
            );

            return;
          }


          if (!row.device_id) {

            await dbQuery(`
              UPDATE access_keys
              SET
                device_id = $1,
                last_seen = $2
              WHERE id = $3
            `, [
              deviceId,
              Date.now(),
              row.id
            ]);

          } else {

            await dbQuery(`
              UPDATE access_keys
              SET last_seen = $1
              WHERE id = $2
            `, [
              Date.now(),
              row.id
            ]);

          }


          sendJSON(
            res,
            200,
            {
              ok: true
            }
          );

          return;
        }


        /* HISTORY */

        if (
          url.pathname === "/api/history"
        ) {

          const access =
            await verifyAccess(req);

          if (!access.ok) {

            sendJSON(
              res,
              access.status,
              {
                ok: false,
                error: access.message
              }
            );

            return;
          }


          sendJSON(
            res,
            200,
            {
              ok: true,
              history:
                liveState.history
            }
          );

          return;
        }


        /* ADMIN STATUS */

        if (
          url.pathname === "/api/admin/status"
        ) {

          if (!verifyAdmin(req)) {

            sendJSON(
              res,
              403,
              {
                ok: false,
                error: "Admin denied"
              }
            );

            return;
          }


          sendJSON(
            res,
            200,
            {
              ok: true,
              provider:
                liveState.ok,

              updatedAt:
                liveState.updatedAt,

              currentIssue:
                liveState.currentIssue,

              targetIssue:
                liveState.targetIssue,

              historyCount:
                liveState.history.length,

              error:
                liveState.error
            }
          );

          return;
        }


        /* ADMIN KEYS */

        if (
          url.pathname === "/api/admin/keys"
        ) {

          if (!verifyAdmin(req)) {

            sendJSON(
              res,
              403,
              {
                ok: false,
                error: "Admin denied"
              }
            );

            return;
          }


          if (!pool) {

            sendJSON(
              res,
              500,
              {
                ok: false,
                error:
                  "DATABASE_URL missing"
              }
            );

            return;
          }


          if (
            req.method === "GET"
          ) {

            const result =
              await dbQuery(`
                SELECT
                  id,
                  access_key,
                  device_id,
                  created_at,
                  last_seen
                FROM access_keys
                ORDER BY id DESC
              `);


            sendJSON(
              res,
              200,
              {
                ok: true,
                keys:
                  result.rows
              }
            );

            return;
          }


          if (
            req.method === "POST"
          ) {

            const body =
              await readBody(req);

            const requested =
              String(
                body.accessKey || ""
              ).trim();

            const accessKey =
              requested ||
              randomKey();


            const result =
              await dbQuery(`
                INSERT INTO access_keys
                (
                  access_key,
                  created_at
                )
                VALUES
                ($1,$2)
                RETURNING *
              `, [
                accessKey,
                Date.now()
              ]);


            sendJSON(
              res,
              201,
              {
                ok: true,
                key:
                  result.rows[0]
              }
            );

            return;
          }


          if (
            req.method === "DELETE"
          ) {

            const body =
              await readBody(req);

            const id =
              Number(body.id);


            if (!Number.isInteger(id)) {

              sendJSON(
                res,
                400,
                {
                  ok: false,
                  error:
                    "Valid key id required"
                }
              );

              return;
            }


            await dbQuery(`
              DELETE FROM access_keys
              WHERE id = $1
            `, [id]);


            sendJSON(
              res,
              200,
              {
                ok: true
              }
            );

            return;
          }
        }


        /* ADMIN RESET DEVICE */

        if (
          url.pathname ===
            "/api/admin/reset-device" &&
          req.method === "POST"
        ) {

          if (!verifyAdmin(req)) {

            sendJSON(
              res,
              403,
              {
                ok: false,
                error: "Admin denied"
              }
            );

            return;
          }


          const body =
            await readBody(req);

          const id =
            Number(body.id);


          await dbQuery(`
            UPDATE access_keys
            SET device_id = NULL,
                last_seen = 0
            WHERE id = $1
          `, [id]);


          sendJSON(
            res,
            200,
            {
              ok: true
            }
          );

          return;
        }


        /* ADMIN PING */

        if (
          url.pathname ===
            "/api/admin/ping"
        ) {

          if (!verifyAdmin(req)) {

            sendJSON(
              res,
              403,
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
              pong: Date.now()
            }
          );

          return;
        }


        /* STATIC */

        if (
          req.method === "GET" ||
          req.method === "HEAD"
        ) {

          serveStatic(req, res);
          return;
        }


        sendJSON(
          res,
          404,
          {
            ok: false,
            error: "Route not found"
          }
        );

      } catch (err) {

        console.error(err);

        sendJSON(
          res,
          500,
          {
            ok: false,
            error:
              "Internal server error"
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
  } catch (err) {
    console.error(
      "Database init failed:",
      err.message
    );
  }


  server.listen(
    PORT,
    () => {

      console.log(
        `DY AI server running on port ${PORT}`
      );

    }
  );


  /*
    First refresh
  */

  await refreshProvider();


  /*
    Continue live refresh
  */

  setInterval(
    refreshProvider,
    REFRESH_MS
  );

}


start();
