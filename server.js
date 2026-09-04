const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = process.env.PORT || 10000;
const ADMIN_KEY = process.env.ADMIN_KEY || "dy4427574";
const WINGOBOT_TOKEN = process.env.WINGOBOT_TOKEN || "";

const GAME_URL =
  "https://www.shreewin38.com/#/register?invitationCode=88523152383";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});

const PUBLIC_DIR = __dirname;

let cache = {
  history: [],
  currentIssue: "",
  targetIssue: "",
  providerLastUpdated: 0,
  fetched: 0,
  error: null,
  lastRefresh: 0
};

const predictionCache = new Map();


/* =========================================================
   DATABASE
========================================================= */

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
      actual_number INTEGER,
      actual_result TEXT,
      created_at BIGINT NOT NULL,
      settled_at BIGINT
    )
  `);
}


/* =========================================================
   HELPERS
========================================================= */

function now() {
  return Date.now();
}

function json(res, code, data) {
  const body = JSON.stringify(data);

  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });

  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        req.destroy();
        reject(new Error("Body too large"));
      }
    });

    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });

    req.on("error", reject);
  });
}

function incrementIssue(issue) {
  const s = String(issue || "");

  if (!/^\d+$/.test(s)) return "";

  const width = s.length;
  const n = BigInt(s) + 1n;

  return n.toString().padStart(width, "0");
}

function normalizeResult(value) {
  const x = String(value ?? "").trim().toUpperCase();

  if (x === "BIG") return "BIG";
  if (x === "SMALL") return "SMALL";

  return "";
}

function numberToResult(number) {
  const n = Number(number);

  if (!Number.isInteger(n) || n < 0 || n > 9) {
    return "";
  }

  return n >= 5 ? "BIG" : "SMALL";
}


/* =========================================================
   WINGOBOT API
========================================================= */

async function fetchWingoHistory() {
  if (!WINGOBOT_TOKEN) {
    throw new Error("WINGOBOT_TOKEN is missing");
  }

  const url =
    "https://api.wingobot.com/v2/30-sec-game-history";

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${WINGOBOT_TOKEN}`,
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(
      `WingoBot HTTP ${response.status}`
    );
  }

  const data = await response.json();

  const history = Array.isArray(data.history)
    ? data.history
    : [];

  return {
    currentIssue:
      data.current?.issueNumber
        ? String(data.current.issueNumber)
        : "",

    history,

    fetched:
      Number(data.stats?.fetched || history.length),

    lastUpdated:
      Number(data.stats?.last_updated || 0)
  };
}


/* =========================================================
   DATA NORMALIZATION
========================================================= */

function normalizeRows(history) {
  return history
    .map(row => {
      const issue =
        row.issueNumber ??
        row.issue ??
        row.period ??
        "";

      const number =
        row.number ??
        row.result ??
        null;

      let result =
        normalizeResult(row.result);

      if (!result) {
        result =
          normalizeResult(row.colour);
      }

      if (!result && number !== null) {
        result = numberToResult(number);
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
    .filter(x => x.issue && x.result);
}


/* =========================================================
   SIGNALS
========================================================= */

function recentSignal(rows, count = 12) {
  const r = rows.slice(0, count);

  if (!r.length) return 0;

  let score = 0;

  r.forEach((x, i) => {
    const weight = r.length - i;

    score +=
      x.result === "BIG"
        ? weight
        : -weight;
  });

  const max =
    r.reduce(
      (sum, _, i) => sum + (r.length - i),
      0
    );

  return max ? score / max : 0;
}


function windowSignal(rows, count) {
  const r = rows.slice(0, count);

  if (!r.length) return 0;

  let big = 0;
  let small = 0;

  for (const x of r) {
    if (x.result === "BIG") big++;
    else if (x.result === "SMALL") small++;
  }

  const total = big + small;

  if (!total) return 0;

  return (big - small) / total;
}


function transitionSignal(rows) {
  if (rows.length < 2) return 0;

  let bigAfterBig = 0;
  let smallAfterBig = 0;
  let bigAfterSmall = 0;
  let smallAfterSmall = 0;

  for (let i = 0; i < rows.length - 1; i++) {
    const current = rows[i].result;
    const previous = rows[i + 1].result;

    if (previous === "BIG") {
      if (current === "BIG") bigAfterBig++;
      else if (current === "SMALL") smallAfterBig++;
    }

    if (previous === "SMALL") {
      if (current === "BIG") bigAfterSmall++;
      else if (current === "SMALL") smallAfterSmall++;
    }
  }

  const bigTotal =
    bigAfterBig + smallAfterBig;

  const smallTotal =
    bigAfterSmall + smallAfterSmall;

  let score = 0;

  if (bigTotal) {
    score +=
      (bigAfterBig - smallAfterBig) /
      bigTotal;
  }

  if (smallTotal) {
    score +=
      (bigAfterSmall - smallAfterSmall) /
      smallTotal;
  }

  return Math.max(-1, Math.min(1, score / 2));
}


function streakInfo(rows) {
  if (!rows.length) {
    return {
      result: "",
      length: 0
    };
  }

  const result = rows[0].result;

  let length = 0;

  for (const x of rows) {
    if (x.result === result) length++;
    else break;
  }

  return {
    result,
    length
  };
}


function streakSignal(rows) {
  const info = streakInfo(rows);

  if (!info.length) return 0;

  const strength =
    Math.min(info.length, 6) / 6;

  return info.result === "BIG"
    ? strength
    : -strength;
}


function alternationSignal(rows) {
  if (rows.length < 4) return 0;

  let alternating = 0;
  let total = 0;

  for (let i = 0; i < rows.length - 1; i++) {
    if (
      rows[i].result !==
      rows[i + 1].result
    ) {
      alternating++;
    }

    total++;
  }

  if (!total) return 0;

  const ratio = alternating / total;

  if (ratio >= 0.7) {
    return rows[0].result === "BIG"
      ? -0.45
      : 0.45;
  }

  return 0;
}


function sequenceSignal(rows) {
  if (rows.length < 6) return 0;

  const a = rows
    .slice(0, 6)
    .map(x => x.result)
    .join("");

  const patterns = [
    "BIGSMALLBIG",
    "SMALLBIGSMALL",
    "BIGBIGSMALL",
    "SMALLSMALLBIG"
  ];

  if (
    patterns.some(p => a.includes(p))
  ) {
    return rows[0].result === "BIG"
      ? 0.18
      : -0.18;
  }

  return 0;
}


function consistencySignal(rows) {
  const r = rows.slice(0, 15);

  if (r.length < 5) return 0;

  let big = 0;

  for (const x of r) {
    if (x.result === "BIG") big++;
  }

  const ratio = big / r.length;

  if (ratio >= 0.7) return 0.45;
  if (ratio <= 0.3) return -0.45;

  return 0;
}


function changePointSignal(rows) {
  if (rows.length < 10) return 0;

  const recent = rows.slice(0, 5);
  const older = rows.slice(5, 10);

  const recentScore =
    windowSignal(recent, 5);

  const oldScore =
    windowSignal(older, 5);

  const diff =
    recentScore - oldScore;

  return Math.max(
    -0.6,
    Math.min(0.6, diff)
  );
}


/* =========================================================
   PREDICTION ENGINE
========================================================= */

function calculatePrediction(rows) {

  if (rows.length < 5) {
    return {
      prediction: "BIG",
      confidence: 50,
      reason: "Collecting enough history",
      regime: "WARMUP"
    };
  }

  const recent =
    recentSignal(rows, 12);

  const w5 =
    windowSignal(rows, 5);

  const w15 =
    windowSignal(rows, 15);

  const w40 =
    windowSignal(rows, 40);

  const transition =
    transitionSignal(rows);

  const streakScore =
    streakSignal(rows);

  const alternation =
    alternationSignal(rows);

  const sequence =
    sequenceSignal(rows);

  const consistency =
    consistencySignal(rows);

  const changePoint =
    changePointSignal(rows);

  /*
    Recency gets the highest influence.
  */

  let score =
      recent * 0.27
    + w5 * 0.18
    + w15 * 0.13
    + w40 * 0.08
    + transition * 0.12
    + streakScore * 0.07
    + alternation * 0.05
    + sequence * 0.03
    + consistency * 0.04
    + changePoint * 0.03;


  /*
    Prevent blindly following a long streak.
    A long streak should reduce confidence,
    not force the same result forever.
  */

  const streak =
    streakInfo(rows);

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


  /*
    Conflicting signals = lower confidence.
  */

  const signals = [
    recent,
    w5,
    w15,
    transition,
    changePoint
  ];

  const positive =
    signals.filter(x => x > 0.15).length;

  const negative =
    signals.filter(x => x < -0.15).length;

  const conflict =
    positive > 0 &&
    negative > 0;

  if (conflict) {
    score *= 0.82;
  }


  score =
    Math.max(-1, Math.min(1, score));


  const prediction =
    score >= 0
      ? "BIG"
      : "SMALL";


  let confidence =
    50 + Math.round(
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


  let regime = "BALANCED";

  if (Math.abs(score) >= 0.6) {
    regime = "STRONG TREND";
  } else if (Math.abs(score) >= 0.3) {
    regime = "TREND";
  } else if (alternation !== 0) {
    regime = "REVERSAL";
  }


  const reasonParts = [];

  if (Math.abs(recent) >= 0.25) {
    reasonParts.push("recent trend");
  }

  if (Math.abs(transition) >= 0.2) {
    reasonParts.push("transition pattern");
  }

  if (Math.abs(changePoint) >= 0.25) {
    reasonParts.push("trend change");
  }

  if (alternation !== 0) {
    reasonParts.push("alternation");
  }

  if (!reasonParts.length) {
    reasonParts.push("multi-window analysis");
  }


  return {
    prediction,
    confidence,
    reason:
      reasonParts.join(" • "),
    regime
  };
}


/* =========================================================
   TARGET ISSUE
========================================================= */

function resolveTargetIssue(
  currentIssue,
  normalizedRows
) {

  const latestSettled =
    normalizedRows.length
      ? normalizedRows[0].issue
      : "";

  const current =
    String(currentIssue || "");

  if (!latestSettled) {
    return current;
  }

  /*
    If provider current issue is ahead
    of latest settled result, use provider
    current issue as target.
  */

  if (
    current &&
    current > latestSettled
  ) {
    return current;
  }

  /*
    Otherwise next issue after latest
    settled result.
  */

  return incrementIssue(latestSettled);
}


/* =========================================================
   PREDICTION DB
========================================================= */

async function getStoredPrediction(issue) {

  const result = await pool.query(
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


async function createPrediction(issue, model) {

  const existing =
    await getStoredPrediction(issue);

  if (existing) {
    return existing;
  }

  const createdAt = now();

  const result = await pool.query(
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
      createdAt
    ]
  );

  return result.rows[0];
}


/* =========================================================
   SETTLEMENT
========================================================= */

async function settlePredictions(rows) {

  if (!rows.length) return;

  const latestRows = rows.slice(0, 100);

  for (const row of latestRows) {

    if (!row.issue || !row.result) {
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

    const actualResult =
      row.result;

    const actualNumber =
      Number.isInteger(row.number)
        ? row.number
        : null;

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
        actualNumber,
        actualResult,
        now(),
        record.id
      ]
    );
  }
}


/* =========================================================
   REFRESH
========================================================= */

async function refreshData() {

  try {

    const data =
      await fetchWingoHistory();

    const rows =
      normalizeRows(data.history);

    const target =
      resolveTargetIssue(
        data.currentIssue,
        rows
      );

    cache = {
      history: rows,
      currentIssue: data.currentIssue,
      targetIssue: target,
      providerLastUpdated:
        data.lastUpdated,
      fetched: data.fetched,
      error: null,
      lastRefresh: now()
    };

    await settlePredictions(rows);

    /*
      Only create a prediction for the
      currently resolved target.
    */

    if (target) {

      let stored =
        await getStoredPrediction(target);

      if (!stored) {

        const model =
          calculatePrediction(rows);

        stored =
          await createPrediction(
            target,
            model
          );
      }

      predictionCache.set(
        target,
        stored
      );
    }

    return cache;

  } catch (err) {

    console.error(
      "Refresh error:",
      err.message
    );

    cache.error =
      err.message;

    return cache;
  }
}


/* =========================================================
   ACCESS KEY
========================================================= */

async function checkAccessKey(
  accessKey,
  deviceId
) {

  if (!accessKey) {
    return {
      ok: false,
      message: "Access key required"
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
      message: "Key already linked to another device"
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
      [
        deviceId,
        now(),
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
        now(),
        row.id
      ]
    );
  }

  return {
    ok: true,
    message: "Access granted"
  };
}


/* =========================================================
   ADMIN AUTH
========================================================= */

function validAdmin(url) {
  return url.searchParams.get("key") === ADMIN_KEY;
}


/* =========================================================
   STATIC FILES
========================================================= */

function serveFile(
  res,
  filename,
  contentType
) {

  const file =
    path.join(
      PUBLIC_DIR,
      filename
    );

  if (!fs.existsSync(file)) {

    res.writeHead(404);
    res.end("Not found");

    return;
  }

  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });

  fs.createReadStream(file)
    .pipe(res);
}


/* =========================================================
   MUSIC RANGE SUPPORT
========================================================= */

function serveMusic(req, res) {

  const file =
    path.join(
      PUBLIC_DIR,
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
      "Content-Type": "audio/mpeg",
      "Content-Length": stat.size,
      "Accept-Ranges": "bytes"
    });

    fs.createReadStream(file)
      .pipe(res);

    return;
  }

  const parts =
    range.replace(/bytes=/, "")
      .split("-");

  const start =
    parseInt(parts[0], 10);

  const end =
    parts[1]
      ? parseInt(parts[1], 10)
      : stat.size - 1;

  if (
    Number.isNaN(start) ||
    start >= stat.size
  ) {

    res.writeHead(416);
    res.end();

    return;
  }

  const chunk =
    end - start + 1;

  res.writeHead(206, {
    "Content-Range":
      `bytes ${start}-${end}/${stat.size}`,
    "Accept-Ranges": "bytes",
    "Content-Length": chunk,
    "Content-Type": "audio/mpeg"
  });

  fs.createReadStream(file, {
    start,
    end
  }).pipe(res);
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

        const pathname =
          url.pathname;


        /* HEALTH */

        if (pathname === "/health") {

          return json(res, 200, {
            ok: true,
            uptime: process.uptime(),
            time: now()
          });

        }


        /* STATE */

        if (
          pathname === "/api/state" &&
          req.method === "GET"
        ) {

          if (
            now() - cache.lastRefresh >
            2500
          ) {
            await refreshData();
          }

          const stored =
            cache.targetIssue
              ? await getStoredPrediction(
                  cache.targetIssue
                )
              : null;

          return json(res, 200, {
            ok: true,
            model: "DY-AI-V8",
            gameUrl: GAME_URL,
            currentIssue:
              cache.currentIssue,
            targetIssue:
              cache.targetIssue,
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
              cache.providerLastUpdated,
            fetched:
              cache.fetched,
            history:
              cache.history.slice(0, 30),
            error:
              cache.error
          });

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

          return json(res, 200, {
            ok: true,
            history: result.rows
          });

        }


        /* KEY CHECK */

        if (
          pathname === "/api/key/check" &&
          req.method === "POST"
        ) {

          const body =
            await readBody(req);

          const result =
            await checkAccessKey(
              String(body.accessKey || ""),
              String(body.deviceId || "")
            );

          return json(res, 200, result);

        }


        /* ADMIN STATUS */

        if (
          pathname === "/api/admin/status" &&
          req.method === "GET"
        ) {

          if (!validAdmin(url)) {
            return json(res, 401, {
              ok: false
            });
          }

          return json(res, 200, {
            ok: true,
            model: "DY-AI-V8",
            currentIssue:
              cache.currentIssue,
            targetIssue:
              cache.targetIssue,
            fetched:
              cache.fetched,
            lastRefresh:
              cache.lastRefresh,
            error:
              cache.error
          });

        }


        /* ADMIN PING */

        if (
          pathname === "/api/admin/ping" &&
          req.method === "GET"
        ) {

          if (!validAdmin(url)) {
            return json(res, 401, {
              ok: false
            });
          }

          return json(res, 200, {
            ok: true,
            pong: true,
            time: now()
          });

        }


        /* WINGO TEST */

        if (
          pathname === "/api/admin/wingo-test" &&
          req.method === "GET"
        ) {

          if (!validAdmin(url)) {
            return json(res, 401, {
              ok: false
            });
          }

          try {

            const data =
              await fetchWingoHistory();

            return json(res, 200, {
              ok: true,
              current:
                data.currentIssue,
              fetched:
                data.fetched,
              history:
                data.history.slice(0, 10),
              lastUpdated:
                data.lastUpdated
            });

          } catch (err) {

            return json(res, 500, {
              ok: false,
              error: err.message
            });

          }

        }


        /* MODEL TEST */

        if (
          pathname === "/api/admin/model-test" &&
          req.method === "GET"
        ) {

          if (!validAdmin(url)) {
            return json(res, 401, {
              ok: false
            });
          }

          const rows =
            normalizeRows(
              cache.history
            );

          const model =
            calculatePrediction(rows);

          return json(res, 200, {
            ok: true,
            model,
            rows: rows.length
          });

        }


        /* ADMIN KEYS GET */

        if (
          pathname === "/api/admin/keys" &&
          req.method === "GET"
        ) {

          if (!validAdmin(url)) {
            return json(res, 401, {
              ok: false
            });
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

          return json(res, 200, {
            ok: true,
            keys: result.rows
          });

        }


        /* ADMIN KEY CREATE */

        if (
          pathname === "/api/admin/keys" &&
          req.method === "POST"
        ) {

          if (!validAdmin(url)) {
            return json(res, 401, {
              ok: false
            });
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
                now()
              ]
            );

          if (!result.rows.length) {

            return json(res, 409, {
              ok: false,
              message: "Key already exists"
            });

          }

          return json(res, 200, {
            ok: true,
            key: result.rows[0]
          });

        }


        /* ADMIN KEY DELETE */

        if (
          pathname === "/api/admin/keys" &&
          req.method === "DELETE"
        ) {

          if (!validAdmin(url)) {
            return json(res, 401, {
              ok: false
            });
          }

          const body =
            await readBody(req);

          const id =
            Number(body.id);

          if (!Number.isInteger(id)) {

            return json(res, 400, {
              ok: false,
              message: "Invalid ID"
            });

          }

          await pool.query(
            `
            DELETE FROM access_keys
            WHERE id = $1
            `,
            [id]
          );

          return json(res, 200, {
            ok: true
          });

        }


        /* RESET DEVICE */

        if (
          pathname === "/api/admin/reset-device" &&
          req.method === "POST"
        ) {

          if (!validAdmin(url)) {
            return json(res, 401, {
              ok: false
            });
          }

          const body =
            await readBody(req);

          const id =
            Number(body.id);

          await pool.query(
            `
            UPDATE access_keys
            SET device_id = NULL,
                last_seen = 0
            WHERE id = $1
            `,
            [id]
          );

          return json(res, 200, {
            ok: true
          });

        }


        /* MUSIC */

        if (pathname === "/music.mp3") {
          return serveMusic(req, res);
        }


        /* PAGES */

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


        if (pathname === "/admin.html") {
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

      } catch (err) {

        console.error(err);

        json(res, 500, {
          ok: false,
          error: err.message
        });

      }

    }
  );


/* =========================================================
   START
========================================================= */

async function start() {

  try {

    await initDB();

    await refreshData();

    server.listen(
      PORT,
      "0.0.0.0",
      () => {
        console.log(
          `DY AI server running on ${PORT}`
        );
      }
    );

    setInterval(
      refreshData,
      3000
    );

  } catch (err) {

    console.error(
      "Startup failed:",
      err
    );

    process.exit(1);

  }
}

start();
