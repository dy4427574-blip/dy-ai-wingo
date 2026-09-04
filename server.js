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

const GAME_URL =
  "https://www.shreewin38.com/#/register?invitationCode=88523152383";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});

const ROOT = __dirname;

let state = {
  history: [],
  currentIssue: "",
  targetIssue: "",
  providerLastUpdated: 0,
  fetched: 0,
  error: "",
  lastRefresh: 0
};


/* =====================================================
   DATABASE
===================================================== */

async function initDatabase() {

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
}


/* =====================================================
   HELPERS
===================================================== */

function sendJSON(res, status, data) {

  const body = JSON.stringify(data);

  res.writeHead(status, {
    "Content-Type":
      "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });

  res.end(body);
}


function getNow() {
  return Date.now();
}


function incrementIssue(issue) {

  const value = String(issue || "");

  if (!/^\d+$/.test(value)) {
    return "";
  }

  const result =
    BigInt(value) + 1n;

  return result
    .toString()
    .padStart(value.length, "0");
}


function resultFromNumber(number) {

  const n = Number(number);

  if (
    !Number.isInteger(n) ||
    n < 0 ||
    n > 9
  ) {
    return "";
  }

  return n >= 5
    ? "BIG"
    : "SMALL";
}


function normalizeResult(value) {

  const x =
    String(value ?? "")
      .trim()
      .toUpperCase();

  if (x === "BIG") return "BIG";
  if (x === "SMALL") return "SMALL";

  return "";
}


function readBody(req) {

  return new Promise((resolve, reject) => {

    let body = "";

    req.on("data", chunk => {

      body += chunk;

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
        resolve({});
      }

    });

    req.on("error", reject);

  });
}


/* =====================================================
   WINGOBOT API
===================================================== */

async function fetchGameData() {

  if (!WINGOBOT_TOKEN) {

    throw new Error(
      "WINGOBOT_TOKEN is not configured"
    );
  }

  const response =
    await fetch(
      "https://api.wingobot.com/v2/30-sec-game-history",
      {
        method: "GET",
        headers: {
          Authorization:
            `Bearer ${WINGOBOT_TOKEN}`,
          Accept: "application/json"
        }
      }
    );

  if (!response.ok) {

    throw new Error(
      `WingoBot API HTTP ${response.status}`
    );
  }

  const data =
    await response.json();

  const history =
    Array.isArray(data.history)
      ? data.history
      : [];

  return {
    currentIssue:
      data.current?.issueNumber
        ? String(data.current.issueNumber)
        : "",

    history,

    fetched:
      Number(
        data.stats?.fetched ||
        history.length ||
        0
      ),

    lastUpdated:
      Number(
        data.stats?.last_updated ||
        0
      )
  };
}


/* =====================================================
   NORMALIZE HISTORY
===================================================== */

function normalizeHistory(history) {

  return history
    .map(item => {

      const issue =
        item.issueNumber ??
        item.issue ??
        item.period ??
        "";

      const number =
        item.number ??
        null;

      let result =
        normalizeResult(item.result);

      if (!result) {
        result =
          normalizeResult(item.colour);
      }

      if (
        !result &&
        number !== null
      ) {
        result =
          resultFromNumber(number);
      }

      return {
        issue: String(issue),
        number:
          Number.isInteger(Number(number))
            ? Number(number)
            : null,
        result
      };

    })
    .filter(item =>
      item.issue &&
      item.result
    );
}


/* =====================================================
   SIGNALS
===================================================== */

function recentSignal(rows, limit = 12) {

  const data =
    rows.slice(0, limit);

  if (!data.length) return 0;

  let score = 0;
  let max = 0;

  for (
    let i = 0;
    i < data.length;
    i++
  ) {

    const weight =
      data.length - i;

    max += weight;

    if (data[i].result === "BIG") {
      score += weight;
    } else {
      score -= weight;
    }
  }

  return max
    ? score / max
    : 0;
}


function windowSignal(rows, limit) {

  const data =
    rows.slice(0, limit);

  if (!data.length) return 0;

  let big = 0;
  let small = 0;

  for (const item of data) {

    if (item.result === "BIG") big++;
    if (item.result === "SMALL") small++;
  }

  const total =
    big + small;

  if (!total) return 0;

  return (big - small) / total;
}


function transitionSignal(rows) {

  if (rows.length < 2) return 0;

  let BB = 0;
  let BS = 0;
  let SB = 0;
  let SS = 0;

  for (
    let i = 0;
    i < rows.length - 1;
    i++
  ) {

    const current =
      rows[i].result;

    const previous =
      rows[i + 1].result;

    if (
      previous === "BIG" &&
      current === "BIG"
    ) BB++;

    if (
      previous === "BIG" &&
      current === "SMALL"
    ) BS++;

    if (
      previous === "SMALL" &&
      current === "BIG"
    ) SB++;

    if (
      previous === "SMALL" &&
      current === "SMALL"
    ) SS++;
  }

  let score = 0;

  const bigTotal = BB + BS;
  const smallTotal = SB + SS;

  if (bigTotal) {
    score +=
      (BB - BS) / bigTotal;
  }

  if (smallTotal) {
    score +=
      (SB - SS) / smallTotal;
  }

  return Math.max(
    -1,
    Math.min(1, score / 2)
  );
}


function getStreak(rows) {

  if (!rows.length) {
    return {
      result: "",
      length: 0
    };
  }

  const result =
    rows[0].result;

  let length = 0;

  for (const row of rows) {

    if (row.result !== result) {
      break;
    }

    length++;
  }

  return {
    result,
    length
  };
}


function streakSignal(rows) {

  const info =
    getStreak(rows);

  if (!info.length) return 0;

  const strength =
    Math.min(info.length, 6) / 6;

  return info.result === "BIG"
    ? strength
    : -strength;
}


function alternationSignal(rows) {

  if (rows.length < 4) return 0;

  let changes = 0;
  let total = 0;

  for (
    let i = 0;
    i < rows.length - 1;
    i++
  ) {

    if (
      rows[i].result !==
      rows[i + 1].result
    ) {
      changes++;
    }

    total++;
  }

  if (!total) return 0;

  const ratio =
    changes / total;

  if (ratio >= 0.70) {

    return rows[0].result === "BIG"
      ? -0.45
      : 0.45;
  }

  return 0;
}


function consistencySignal(rows) {

  const data =
    rows.slice(0, 15);

  if (data.length < 5) return 0;

  let big = 0;

  for (const row of data) {

    if (row.result === "BIG") {
      big++;
    }
  }

  const ratio =
    big / data.length;

  if (ratio >= 0.70) return 0.45;

  if (ratio <= 0.30) return -0.45;

  return 0;
}


function changePointSignal(rows) {

  if (rows.length < 10) return 0;

  const recent =
    rows.slice(0, 5);

  const older =
    rows.slice(5, 10);

  const recentScore =
    windowSignal(recent, 5);

  const olderScore =
    windowSignal(older, 5);

  return Math.max(
    -0.6,
    Math.min(
      0.6,
      recentScore - olderScore
    )
  );
}


/* =====================================================
   MODEL
===================================================== */

function calculatePrediction(rows) {

  if (rows.length < 5) {

    return {
      prediction: "BIG",
      confidence: 50,
      reason: "Collecting history",
      regime: "WARMUP"
    };
  }

  const recent =
    recentSignal(rows, 12);

  const five =
    windowSignal(rows, 5);

  const fifteen =
    windowSignal(rows, 15);

  const forty =
    windowSignal(rows, 40);

  const transition =
    transitionSignal(rows);

  const streakScore =
    streakSignal(rows);

  const alternation =
    alternationSignal(rows);

  const consistency =
    consistencySignal(rows);

  const changePoint =
    changePointSignal(rows);


  let score =
      recent * 0.28
    + five * 0.18
    + fifteen * 0.13
    + forty * 0.08
    + transition * 0.12
    + streakScore * 0.07
    + alternation * 0.05
    + consistency * 0.05
    + changePoint * 0.04;


  const streak =
    getStreak(rows);


  if (streak.length >= 4) {

    if (
      streak.result === "BIG" &&
      score > 0
    ) {
      score *= 0.72;
    }

    if (
      streak.result === "SMALL" &&
      score < 0
    ) {
      score *= 0.72;
    }
  }


  const signals = [
    recent,
    five,
    fifteen,
    transition,
    changePoint
  ];

  const positive =
    signals.filter(
      x => x > 0.15
    ).length;

  const negative =
    signals.filter(
      x => x < -0.15
    ).length;

  const conflict =
    positive > 0 &&
    negative > 0;

  if (conflict) {
    score *= 0.82;
  }


  score =
    Math.max(
      -1,
      Math.min(1, score)
    );


  const prediction =
    score >= 0
      ? "BIG"
      : "SMALL";


  let confidence =
    50 +
    Math.round(
      Math.abs(score) * 42
    );


  if (conflict) {
    confidence -= 5;
  }

  if (streak.length >= 5) {
    confidence -= 4;
  }


  confidence =
    Math.max(
      50,
      Math.min(92, confidence)
    );


  let regime =
    "BALANCED";

  if (Math.abs(score) >= 0.60) {
    regime = "STRONG TREND";
  }
  else if (Math.abs(score) >= 0.30) {
    regime = "TREND";
  }
  else if (alternation !== 0) {
    regime = "REVERSAL";
  }


  const reasons = [];

  if (Math.abs(recent) >= 0.25) {
    reasons.push("recent trend");
  }

  if (Math.abs(transition) >= 0.20) {
    reasons.push("transitions");
  }

  if (Math.abs(changePoint) >= 0.25) {
    reasons.push("trend change");
  }

  if (alternation !== 0) {
    reasons.push("alternation");
  }

  if (!reasons.length) {
    reasons.push("multi-window analysis");
  }


  return {
    prediction,
    confidence,
    reason: reasons.join(" • "),
    regime
  };
}


/* =====================================================
   TARGET ISSUE
===================================================== */

function resolveTarget(
  currentIssue,
  rows
) {

  const latest =
    rows.length
      ? rows[0].issue
      : "";

  const current =
    String(currentIssue || "");


  if (!latest) {
    return current;
  }


  if (
    current &&
    current > latest
  ) {
    return current;
  }


  return incrementIssue(latest);
}


/* =====================================================
   DATABASE PREDICTION
===================================================== */

async function getPrediction(issue) {

  const result =
    await pool.query(
      `
      SELECT *
      FROM prediction_records
      WHERE target_issue = $1
      ORDER BY id DESC
      LIMIT 1
      `,
      [issue]
    );

  return result.rows[0] || null;
}


async function savePrediction(
  issue,
  model
) {

  const existing =
    await getPrediction(issue);

  if (existing) {
    return existing;
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
        issue,
        model.prediction,
        model.confidence,
        "DY-AI-V8",
        getNow()
      ]
    );

  return result.rows[0];
}


/* =====================================================
   SETTLEMENT
===================================================== */

async function settlePredictions(rows) {

  for (
    const row of rows.slice(0, 100)
  ) {

    if (
      !row.issue ||
      !row.result
    ) {
      continue;
    }


    const result =
      await pool.query(
        `
        SELECT *
        FROM prediction_records
        WHERE target_issue = $1
          AND settled_at IS NULL
        ORDER BY id DESC
        LIMIT 1
        `,
        [row.issue]
      );


    if (!result.rows.length) {
      continue;
    }


    const record =
      result.rows[0];


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
        row.number,
        row.result,
        getNow(),
        record.id
      ]
    );
  }
}


/* =====================================================
   REFRESH DATA
===================================================== */

async function refresh() {

  try {

    const data =
      await fetchGameData();

    const rows =
      normalizeHistory(
        data.history
      );

    const target =
      resolveTarget(
        data.currentIssue,
        rows
      );


    state = {
      history: rows,
      currentIssue:
        data.currentIssue,
      targetIssue:
        target,
      providerLastUpdated:
        data.lastUpdated,
      fetched:
        data.fetched,
      error: "",
      lastRefresh:
        getNow()
    };


    await settlePredictions(rows);


    if (target) {

      const existing =
        await getPrediction(target);

      if (!existing) {

        const model =
          calculatePrediction(rows);

        await savePrediction(
          target,
          model
        );
      }
    }


  } catch (error) {

    console.error(
      "REFRESH ERROR:",
      error.message
    );

    state.error =
      error.message;
  }
}


/* =====================================================
   ADMIN
===================================================== */

function isAdmin(url) {

  return (
    url.searchParams.get("key") ===
    ADMIN_KEY
  );
}


/* =====================================================
   ACCESS KEY
===================================================== */

async function checkAccessKey(
  accessKey,
  deviceId
) {

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
        getNow(),
        row.id
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
        getNow(),
        row.id
      ]
    );
  }


  return {
    ok: true,
    message:
      "Access granted"
  };
}


/* =====================================================
   STATIC FILE
===================================================== */

function serveFile(
  res,
  filename,
  contentType
) {

  const file =
    path.join(
      ROOT,
      filename
    );


  if (!fs.existsSync(file)) {

    res.writeHead(404);
    res.end("File not found");

    return;
  }


  res.writeHead(200, {
    "Content-Type":
      contentType,
    "Cache-Control":
      "no-store"
  });


  fs.createReadStream(file)
    .pipe(res);
}


/* =====================================================
   MUSIC
===================================================== */

function serveMusic(req, res) {

  const file =
    path.join(
      ROOT,
      "music.mp3"
    );


  if (!fs.existsSync(file)) {

    res.writeHead(404);
    res.end("Music not found");

    return;
  }


  const stat =
    fs.statSync(file);

  const range =
    req.headers.range;


  if (!range) {

    res.writeHead(200, {
      "Content-Type":
        "audio/mpeg",
      "Content-Length":
        stat.size,
      "Accept-Ranges":
        "bytes"
    });


    fs.createReadStream(file)
      .pipe(res);

    return;
  }


  const parts =
    range
      .replace("bytes=", "")
      .split("-");


  const start =
    parseInt(parts[0], 10);

  const requestedEnd =
    parts[1]
      ? parseInt(parts[1], 10)
      : stat.size - 1;


  if (
    Number.isNaN(start) ||
    start < 0 ||
    start >= stat.size
  ) {

    res.writeHead(416);
    res.end();

    return;
  }


  const end =
    Math.min(
      requestedEnd,
      stat.size - 1
    );


  const length =
    end - start + 1;


  res.writeHead(206, {
    "Content-Range":
      `bytes ${start}-${end}/${stat.size}`,
    "Accept-Ranges":
      "bytes",
    "Content-Length":
      length,
    "Content-Type":
      "audio/mpeg"
  });


  fs.createReadStream(
    file,
    {
      start,
      end
    }
  ).pipe(res);
}


/* =====================================================
   HTTP SERVER
===================================================== */

const server =
  http.createServer(
    async (req, res) => {

      try {

        const url =
          new URL(
            req.url,
            `http://${req.headers.host}`
          );

        const pathname =
          url.pathname;


        /* HEALTH */

        if (
          pathname === "/health"
        ) {

          return sendJSON(
            res,
            200,
            {
              ok: true,
              time: getNow(),
              uptime:
                process.uptime()
            }
          );
        }


        /* STATE */

        if (
          pathname === "/api/state" &&
          req.method === "GET"
        ) {

          if (
            getNow() -
            state.lastRefresh >
            2500
          ) {

            await refresh();
          }


          const stored =
            state.targetIssue
              ? await getPrediction(
                  state.targetIssue
                )
              : null;


          return sendJSON(
            res,
            200,
            {
              ok: true,
              model:
                "DY-AI-V8",

              gameUrl:
                GAME_URL,

              currentIssue:
                state.currentIssue,

              targetIssue:
                state.targetIssue,

              prediction:
                stored?.prediction || "",

              confidence:
                stored?.confidence || 0,

              reason:
                stored
                  ? "Live multi-signal analysis"
                  : "",

              regime:
                stored
                  ? "LIVE"
                  : "WAITING",

              providerLastUpdated:
                state.providerLastUpdated,

              fetched:
                state.fetched,

              history:
                state.history.slice(
                  0,
                  30
                ),

              error:
                state.error
            }
          );
        }


        /* HISTORY */

        if (
          pathname === "/api/history" &&
          req.method === "GET"
        ) {

          const result =
            await pool.query(
              `
              SELECT *
              FROM prediction_records
              ORDER BY id DESC
              LIMIT 30
              `
            );


          return sendJSON(
            res,
            200,
            {
              ok: true,
              history:
                result.rows
            }
          );
        }


        /* ACCESS KEY */

        if (
          pathname === "/api/key/check" &&
          req.method === "POST"
        ) {

          const body =
            await readBody(req);


          const result =
            await checkAccessKey(
              String(
                body.accessKey || ""
              ),
              String(
                body.deviceId || ""
              )
            );


          return sendJSON(
            res,
            200,
            result
          );
        }


        /* ADMIN STATUS */

        if (
          pathname === "/api/admin/status" &&
          req.method === "GET"
        ) {

          if (!isAdmin(url)) {

            return sendJSON(
              res,
              401,
              {
                ok: false,
                message:
                  "Unauthorized"
              }
            );
          }


          return sendJSON(
            res,
            200,
            {
              ok: true,
              model:
                "DY-AI-V8",
              currentIssue:
                state.currentIssue,
              targetIssue:
                state.targetIssue,
              fetched:
                state.fetched,
              lastRefresh:
                state.lastRefresh,
              error:
                state.error
            }
          );
        }


        /* ADMIN PING */

        if (
          pathname === "/api/admin/ping" &&
          req.method === "GET"
        ) {

          if (!isAdmin(url)) {

            return sendJSON(
              res,
              401,
              { ok: false }
            );
          }


          return sendJSON(
            res,
            200,
            {
              ok: true,
              pong: true,
              time: getNow()
            }
          );
        }


        /* WINGO TEST */

        if (
          pathname === "/api/admin/wingo-test" &&
          req.method === "GET"
        ) {

          if (!isAdmin(url)) {

            return sendJSON(
              res,
              401,
              { ok: false }
            );
          }


          try {

            const data =
              await fetchGameData();


            return sendJSON(
              res,
              200,
              {
                ok: true,
                current:
                  data.currentIssue,
                fetched:
                  data.fetched,
                lastUpdated:
                  data.lastUpdated,
                history:
                  data.history.slice(
                    0,
                    10
                  )
              }
            );

          } catch (error) {

            return sendJSON(
              res,
              500,
              {
                ok: false,
                error:
                  error.message
              }
            );
          }
        }


        /* MODEL TEST */

        if (
          pathname === "/api/admin/model-test" &&
          req.method === "GET"
        ) {

          if (!isAdmin(url)) {

            return sendJSON(
              res,
              401,
              { ok: false }
            );
          }


          const model =
            calculatePrediction(
              state.history
            );


          return sendJSON(
            res,
            200,
            {
              ok: true,
              rows:
                state.history.length,
              model
            }
          );
        }


        /* GET ACCESS KEYS */

        if (
          pathname === "/api/admin/keys" &&
          req.method === "GET"
        ) {

          if (!isAdmin(url)) {

            return sendJSON(
              res,
              401,
              { ok: false }
            );
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


          return sendJSON(
            res,
            200,
            {
              ok: true,
              keys:
                result.rows
            }
          );
        }


        /* CREATE ACCESS KEY */

        if (
          pathname === "/api/admin/keys" &&
          req.method === "POST"
        ) {

          if (!isAdmin(url)) {

            return sendJSON(
              res,
              401,
              { ok: false }
            );
          }


          const body =
            await readBody(req);


          let accessKey =
            String(
              body.accessKey || ""
            ).trim();


          if (!accessKey) {

            accessKey =
              "DY-" +
              crypto
                .randomBytes(8)
                .toString("hex")
                .toUpperCase();
          }


          const result =
            await pool.query(
              `
              INSERT INTO access_keys
              (
                access_key,
                created_at
              )
              VALUES ($1,$2)
              ON CONFLICT(access_key)
              DO NOTHING
              RETURNING *
              `,
              [
                accessKey,
                getNow()
              ]
            );


          if (!result.rows.length) {

            return sendJSON(
              res,
              409,
              {
                ok: false,
                message:
                  "Key already exists"
              }
            );
          }


          return sendJSON(
            res,
            200,
            {
              ok: true,
              key:
                result.rows[0]
            }
          );
        }


        /* DELETE ACCESS KEY */

        if (
          pathname === "/api/admin/keys" &&
          req.method === "DELETE"
        ) {

          if (!isAdmin(url)) {

            return sendJSON(
              res,
              401,
              { ok: false }
            );
          }


          const body =
            await readBody(req);

          const id =
            Number(body.id);


          if (
            !Number.isInteger(id)
          ) {

            return sendJSON(
              res,
              400,
              {
                ok: false,
                message:
                  "Invalid ID"
              }
            );
          }


          await pool.query(
            `
            DELETE FROM access_keys
            WHERE id = $1
            `,
            [id]
          );


          return sendJSON(
            res,
            200,
            { ok: true }
          );
        }


        /* RESET DEVICE */

        if (
          pathname === "/api/admin/reset-device" &&
          req.method === "POST"
        ) {

          if (!isAdmin(url)) {

            return sendJSON(
              res,
              401,
              { ok: false }
            );
          }


          const body =
            await readBody(req);

          const id =
            Number(body.id);


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


          return sendJSON(
            res,
            200,
            { ok: true }
          );
        }


        /* MUSIC */

        if (
          pathname === "/music.mp3"
        ) {

          return serveMusic(
            req,
            res
          );
        }


        /* PREDICTION PAGE */

        if (
          pathname === "/" ||
          pathname === "/prediction.html"
        ) {

          return serveFile(
            res,
            "prediction.html",
            "text/html; charset=utf-8"
          );
        }


        /* ADMIN PAGE */

        if (
          pathname === "/admin.html"
        ) {

          return serveFile(
            res,
            "admin.html",
            "text/html; charset=utf-8"
          );
        }


        /* 404 */

        res.writeHead(404, {
          "Content-Type":
            "text/plain; charset=utf-8"
        });

        res.end("Not found");


      } catch (error) {

        console.error(
          "SERVER ERROR:",
          error
        );


        return sendJSON(
          res,
          500,
          {
            ok: false,
            error:
              error.message
          }
        );
      }

    }
  );


/* =====================================================
   START SERVER
===================================================== */

async function start() {

  try {

    await initDatabase();

    await refresh();


    server.listen(
      PORT,
      "0.0.0.0",
      () => {

        console.log(
          `DY AI server running on port ${PORT}`
        );

      }
    );


    setInterval(
      refresh,
      3000
    );


  } catch (error) {

    console.error(
      "STARTUP ERROR:",
      error
    );

    process.exit(1);
  }
}


start();
