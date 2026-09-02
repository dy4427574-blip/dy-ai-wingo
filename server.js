const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 10000);
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_KEY = process.env.ADMIN_KEY || "dy4427574";
const WINGOBOT_TOKEN = process.env.WINGOBOT_TOKEN || "";

const ROUND_SECONDS = 30;
const API_REFRESH_MS = 1000;
const API_URL = "https://api.wingobot.com/v2/30-sec-game-history";

if (!DATABASE_URL) {
  console.error("DATABASE_URL is missing");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const cache = {
  data: null,
  history: [],
  analysis: null,

  apiIssue: null,
  apiNumber: null,

  settledIssue: null,
  targetIssue: null,

  historySignature: "",
  historyVersion: 0,

  lastSuccessAt: 0,
  lastHistoryChangeAt: 0,

  anchorIssue: null,
  anchorTime: 0,

  fetching: false,
  error: null
};

/* =========================
   BASIC HELPERS
========================= */

function json(res, code, obj) {
  const body = JSON.stringify(obj);

  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });

  res.end(body);
}

function sendFile(res, filename, contentType) {
  const filePath = path.join(__dirname, filename);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8"
      });

      return res.end("File not found");
    }

    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store"
    });

    res.end(data);
  });
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function bigSmall(number) {
  return Number(number) >= 5 ? "BIG" : "SMALL";
}

/* =========================
   ISSUE NUMBER
========================= */

function nextIssue(issue, step = 1) {
  if (!issue) return null;

  const value = String(issue);

  const match = value.match(/^(.*?)(\d+)$/);

  if (!match) return null;

  const prefix = match[1];
  const digits = match[2];
  const width = digits.length;

  const next = (
    BigInt(digits) + BigInt(step)
  ).toString().padStart(width, "0");

  return prefix + next;
}

/* =========================
   HISTORY CLEANING
========================= */

function cleanHistory(rows) {
  if (!Array.isArray(rows)) return [];

  return rows
    .filter(row =>
      row &&
      row.issueNumber != null &&
      row.number != null
    )
    .map(row => ({
      issueNumber: String(row.issueNumber),
      number: Number(row.number),
      colour: row.colour ?? null,
      premium: row.premium ?? null,
      sum: row.sum ?? null
    }))
    .filter(row =>
      Number.isFinite(row.number) &&
      row.number >= 0 &&
      row.number <= 9
    )
    .sort((a, b) =>
      String(b.issueNumber).localeCompare(
        String(a.issueNumber)
      )
    );
}

/* =========================
   TREND FUNCTIONS
========================= */

function transitionScore(arr) {
  if (arr.length < 2) return 0;

  let same = 0;
  let flip = 0;

  for (let i = 0; i < arr.length - 1; i++) {
    if (arr[i] === arr[i + 1]) {
      same++;
    } else {
      flip++;
    }
  }

  return (
    (flip - same) /
    Math.max(1, arr.length - 1)
  );
}

function longestStreak(arr) {
  if (!arr.length) return 0;

  let best = 1;
  let current = 1;

  for (let i = 1; i < arr.length; i++) {
    if (arr[i] === arr[i - 1]) {
      current++;
    } else {
      current = 1;
    }

    best = Math.max(best, current);
  }

  return best;
}

/* =========================
   AI STATISTICAL ENGINE
========================= */

function analyze(history, targetPeriod) {
  if (history.length < 8) {
    return {
      ready: false,
      targetPeriod,
      prediction: null,
      number: null,
      confidence: 0,
      patternScore: 0,
      sampleSize: history.length,
      reason: "Not enough settled results"
    };
  }

  /*
     IMPORTANT:

     History is newest -> oldest.

     This engine is an ensemble of:
     - micro trend
     - short trend
     - medium trend
     - long trend
     - streak
     - transition behaviour
     - number frequency
     - number recency
     - gap
     - BIG/SMALL compatibility

     It is NOT a guaranteed predictor.
  */

  const numbers = history.map(x => x.number);

  const sides = numbers.map(bigSmall);

  function windowStats(size) {
    const arr = sides.slice(
      0,
      Math.min(size, sides.length)
    );

    const big = arr.filter(
      x => x === "BIG"
    ).length;

    return {
      size: arr.length,
      bigRate: arr.length
        ? big / arr.length
        : 0.5,
      smallRate: arr.length
        ? 1 - big / arr.length
        : 0.5
    };
  }

  const w5 = windowStats(5);
  const w10 = windowStats(10);
  const w20 = windowStats(20);
  const w30 = windowStats(30);

  /*
     Weighted ensemble
  */

  let bigScore =
    w5.bigRate * 0.38 +
    w10.bigRate * 0.27 +
    w20.bigRate * 0.20 +
    w30.bigRate * 0.15;

  let smallScore =
    w5.smallRate * 0.38 +
    w10.smallRate * 0.27 +
    w20.smallRate * 0.20 +
    w30.smallRate * 0.15;

  /*
     Micro trend
  */

  const recentSides = sides.slice(0, 6);

  const transition = transitionScore(
    recentSides
  );

  if (transition > 0.25) {
    /*
       Stronger flipping behaviour
    */

    if (sides[0] === "BIG") {
      smallScore += 0.045;
    } else {
      bigScore += 0.045;
    }
  }

  if (transition < -0.25) {
    /*
       Stronger continuation behaviour
    */

    if (sides[0] === "BIG") {
      bigScore += 0.035;
    } else {
      smallScore += 0.035;
    }
  }

  /*
     Streak signal
  */

  const streak = longestStreak(
    recentSides
  );

  if (streak >= 3) {
    if (sides[0] === "BIG") {
      bigScore += 0.025;
    } else {
      smallScore += 0.025;
    }
  }

  const prediction =
    bigScore >= smallScore
      ? "BIG"
      : "SMALL";

  const sideGap =
    Math.abs(bigScore - smallScore);

  const sideConfidence = clamp(
    Math.round(
      50 + sideGap * 100
    ),
    51,
    74
  );

  /* =========================
     NUMBER MODEL
  ========================= */

  const candidates = [];

  for (let n = 0; n <= 9; n++) {
    const last5 = numbers.slice(0, 5);
    const last10 = numbers.slice(0, 10);
    const last30 = numbers.slice(0, 30);

    const freq5 =
      last5.filter(x => x === n).length;

    const freq10 =
      last10.filter(x => x === n).length;

    const freq30 =
      last30.filter(x => x === n).length;

    let lastSeen =
      numbers.indexOf(n);

    if (lastSeen < 0) {
      lastSeen = 31;
    }

    /*
       Number gap
    */

    const gapBonus = clamp(
      lastSeen / 12,
      0,
      2.8
    );

    /*
       Frequency
    */

    const frequency =
      freq5 * 0.8 +
      freq10 * 0.45 +
      freq30 * 0.18;

    /*
       BIG / SMALL compatibility
    */

    let sideBonus = 0;

    if (
      prediction === "BIG"
    ) {
      sideBonus =
        n >= 5
          ? 2.0
          : -0.8;
    } else {
      sideBonus =
        n < 5
          ? 2.0
          : -0.8;
    }

    /*
       Recent side compatibility
    */

    const predictionRate =
      recentSides.filter(
        x => x === prediction
      ).length /
      Math.max(
        1,
        recentSides.length
      );

    const microBonus =
      predictionRate *
      (n % 2 === 0
        ? 0.35
        : 0.25);

    /*
       Don't automatically repeat last numbers,
       but don't force artificial variation either.
    */

    const repeatPenalty =
      numbers
        .slice(0, 2)
        .includes(n)
        ? 0.75
        : 0;

    /*
       Mild diversity bonus
    */

    const diversityBonus =
      numbers
        .slice(0, 3)
        .includes(n)
        ? 0
        : 0.55;

    /*
       Final number score
    */

    const score =
      5 +
      gapBonus +
      frequency * 0.28 +
      sideBonus +
      microBonus +
      diversityBonus -
      repeatPenalty;

    candidates.push({
      number: n,
      score
    });
  }

  candidates.sort(
    (a, b) => b.score - a.score
  );

  const selected =
    candidates[0].number;

  const numberGap =
    candidates[0].score -
    candidates[1].score;

  const numberConfidence =
    clamp(
      Math.round(
        50 + numberGap * 7
      ),
      51,
      72
    );

  /*
     Final confidence uses the weaker
     of side and number confidence.
  */

  const confidence =
    Math.min(
      sideConfidence,
      numberConfidence
    );

  /*
     Pattern score
  */

  const patternScore = clamp(
    Math.round(
      50 +
      Math.abs(
        w5.bigRate - 0.5
      ) * 55 +
      Math.abs(
        w20.bigRate - 0.5
      ) * 25 +
      Math.abs(
        transition
      ) * 12
    ),
    50,
    85
  );

  return {
    ready: true,

    targetPeriod,

    prediction,

    number: selected,

    confidence,

    patternScore,

    sampleSize: history.length,

    streak,

    transition:
      Number(
        transition.toFixed(3)
      ),

    windows: {
      w5: Number(
        (w5.bigRate * 100)
          .toFixed(1)
      ),

      w10: Number(
        (w10.bigRate * 100)
          .toFixed(1)
      ),

      w20: Number(
        (w20.bigRate * 100)
          .toFixed(1)
      ),

      w30: Number(
        (w30.bigRate * 100)
          .toFixed(1)
      )
    },

    topNumbers:
      candidates
        .slice(0, 3)
        .map(x => x.number),

    generatedFrom:
      history[0]?.issueNumber ||
      null
  };
}

/* =========================
   WINGOBOT API
========================= */

async function fetchWingoBot() {
  if (!WINGOBOT_TOKEN) {
    throw new Error(
      "WINGOBOT_TOKEN is missing"
    );
  }

  const response = await fetch(
    API_URL,
    {
      headers: {
        Authorization:
          `Bearer ${WINGOBOT_TOKEN}`,

        Accept:
          "application/json"
      }
    }
  );

  if (!response.ok) {
    throw new Error(
      `WingoBot HTTP ${response.status}`
    );
  }

  return await response.json();
}

/* =========================
   UPDATE CACHE
========================= */

async function updateCache(data) {
  const history =
    cleanHistory(
      data.history ||
      data.data ||
      data.results ||
      []
    );

  if (!history.length) {
    throw new Error(
      "WingoBot returned no history"
    );
  }

  const settledIssue =
    history[0].issueNumber;

  /*
     Signature makes sure prediction
     changes only when actual settled
     history changes.
  */

  const signature =
    history
      .slice(0, 5)
      .map(x =>
        `${x.issueNumber}:${x.number}`
      )
      .join("|");

  const historyChanged =
    signature !==
    cache.historySignature;

  cache.data = data;
  cache.history = history;

  cache.apiIssue =
    data?.current?.issueNumber != null
      ? String(
          data.current.issueNumber
        )
      : null;

  cache.apiNumber =
    data?.current?.number ??
    null;

  cache.settledIssue =
    settledIssue;

  /*
     Prediction target = NEXT issue
     after the latest settled result.
  */

  cache.targetIssue =
    nextIssue(
      settledIssue,
      1
    );

  cache.lastSuccessAt =
    Date.now();

  cache.error = null;

  /*
     VERY IMPORTANT FIX:

     Do NOT regenerate prediction
     every second.

     Generate only when new
     settled result appears.
  */

  if (historyChanged) {
    cache.historySignature =
      signature;

    cache.historyVersion++;

    cache.lastHistoryChangeAt =
      Date.now();

    cache.anchorIssue =
      settledIssue;

    cache.anchorTime =
      Date.now();

    cache.analysis =
      analyze(
        cache.history,
        cache.targetIssue
      );
  }
}

/* =========================
   REFRESH
========================= */

async function refreshWingo() {
  if (cache.fetching) {
    return;
  }

  cache.fetching = true;

  try {
    const data =
      await fetchWingoBot();

    await updateCache(data);

  } catch (error) {
    cache.error =
      error.message ||
      "API error";
  } finally {
    cache.fetching = false;
  }
}

/* =========================
   TIMER
========================= */

function getTiming() {
  if (!cache.anchorTime) {
    return {
      countdown: null,
      estimated: true,
      status:
        "WAITING FOR SYNC"
    };
  }

  const elapsed =
    Math.floor(
      (
        Date.now() -
        cache.anchorTime
      ) / 1000
    );

  const countdown =
    Math.max(
      1,
      ROUND_SECONDS -
      (
        elapsed %
        ROUND_SECONDS
      )
    );

  return {
    countdown,

    estimated: true,

    status:
      "SYNCED / ESTIMATED",

    anchoredTo:
      cache.anchorIssue,

    anchorAge:
      elapsed
  };
}

/* =========================
   STATE
========================= */

function makeState() {
  const timing =
    getTiming();

  const analysis =
    cache.analysis;

  return {
    ok: true,

    serverTime:
      Date.now(),

    /*
       settledPeriod = latest actual result
    */

    settledPeriod:
      cache.settledIssue,

    /*
       targetPeriod = next period
       prediction is for
    */

    targetPeriod:
      cache.targetIssue,

    period:
      cache.targetIssue,

    countdown:
      timing.countdown,

    timing,

    prediction:
      analysis?.ready
        ? analysis.prediction
        : null,

    number:
      analysis?.ready
        ? analysis.number
        : null,

    confidence:
      analysis?.ready
        ? analysis.confidence
        : 0,

    patternScore:
      analysis?.ready
        ? analysis.patternScore
        : 0,

    sampleSize:
      analysis?.sampleSize ||
      cache.history.length,

    analysisReady:
      !!analysis?.ready,

    predictionGeneratedFrom:
      analysis?.generatedFrom ||
      null,

    historyVersion:
      cache.historyVersion,

    latestResult:
      cache.history[0] ||
      null,

    statistics:
      analysis?.windows ||
      null,

    topNumbers:
      analysis?.topNumbers ||
      [],

    error:
      cache.error,

    note:
      "AI-style statistical ensemble. Random future outcomes are not guaranteed."
  };
}

/* =========================
   DATABASE
========================= */

async function ensureDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS access_keys (
      id SERIAL PRIMARY KEY,
      access_key TEXT UNIQUE NOT NULL,
      device_id TEXT,
      created_at BIGINT NOT NULL,
      last_seen BIGINT DEFAULT 0
    )
  `);
}

/* =========================
   ACCESS KEY
========================= */

async function checkKey(
  accessKey,
  deviceId
) {
  if (
    !accessKey ||
    !deviceId
  ) {
    return {
      ok: false,
      message:
        "Missing key/device"
    };
  }

  const result =
    await pool.query(
      `
      SELECT *
      FROM access_keys
      WHERE access_key=$1
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
        "Key already bound to another device"
    };
  }

  if (!row.device_id) {
    await pool.query(
      `
      UPDATE access_keys
      SET device_id=$1,
          last_seen=$2
      WHERE id=$3
      `,
      [
        deviceId,
        Date.now(),
        row.id
      ]
    );
  } else {
    await pool.query(
      `
      UPDATE access_keys
      SET last_seen=$1
      WHERE id=$2
      `,
      [
        Date.now(),
        row.id
      ]
    );
  }

  return {
    ok: true
  };
}

/* =========================
   ADMIN AUTH
========================= */

function adminOk(req, url) {
  const key =
    req.headers["x-admin-key"] ||
    url.searchParams.get("key") ||
    "";

  return key === ADMIN_KEY;
}

/* =========================
   JSON BODY
========================= */

function readJsonBody(req) {
  return new Promise(
    (resolve, reject) => {
      let body = "";

      req.on(
        "data",
        chunk => {
          body += chunk;

          if (
            body.length >
            1024 * 1024
          ) {
            req.destroy();
          }
        }
      );

      req.on(
        "end",
        () => {
          try {
            resolve(
              body
                ? JSON.parse(body)
                : {}
            );
          } catch {
            reject(
              new Error(
                "Invalid JSON"
              )
            );
          }
        }
      );

      req.on(
        "error",
        reject
      );
    }
  );
}

/* =========================
   ADMIN KEYS
========================= */

async function handleAdminKeys(
  req,
  res,
  url
) {
  if (
    !adminOk(req, url)
  ) {
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

  if (
    req.method === "GET"
  ) {
    const result =
      await pool.query(`
        SELECT
          id,
          access_key,
          device_id,
          created_at,
          last_seen
        FROM access_keys
        ORDER BY id DESC
      `);

    return json(
      res,
      200,
      {
        ok: true,
        keys:
          result.rows
      }
    );
  }

  if (
    req.method === "POST"
  ) {
    const body =
      await readJsonBody(req);

    const key =
      String(
        body.access_key ||
        body.key ||
        crypto
          .randomBytes(6)
          .toString("hex")
      );

    await pool.query(
      `
      INSERT INTO access_keys
      (
        access_key,
        created_at,
        last_seen
      )
      VALUES
      ($1,$2,0)
      `,
      [
        key,
        Date.now()
      ]
    );

    return json(
      res,
      200,
      {
        ok: true,
        access_key: key
      }
    );
  }

  if (
    req.method === "DELETE"
  ) {
    const body =
      await readJsonBody(req);

    const key =
      String(
        body.access_key ||
        body.key ||
        ""
      );

    await pool.query(
      `
      DELETE FROM access_keys
      WHERE access_key=$1
      `,
      [key]
    );

    return json(
      res,
      200,
      {
        ok: true
      }
    );
  }

  return json(
    res,
    405,
    {
      ok: false
    }
  );
}

/* =========================
   MP3 RANGE SUPPORT
========================= */

function serveMp3(
  req,
  res
) {
  const filePath =
    path.join(
      __dirname,
      "music.mp3"
    );

  if (
    !fs.existsSync(filePath)
  ) {
    res.writeHead(404);
    return res.end();
  }

  const stat =
    fs.statSync(filePath);

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
          "bytes",

        "Cache-Control":
          "no-store"
      }
    );

    return fs
      .createReadStream(filePath)
      .pipe(res);
  }

  const match =
    range.match(
      /bytes=(\d*)-(\d*)/
    );

  if (!match) {
    res.writeHead(416);
    return res.end();
  }

  const start =
    match[1]
      ? Number(match[1])
      : 0;

  const end =
    match[2]
      ? Number(match[2])
      : size - 1;

  if (
    start >= size ||
    end >= size ||
    start > end
  ) {
    res.writeHead(
      416,
      {
        "Content-Range":
          `bytes */${size}`
      }
    );

    return res.end();
  }

  res.writeHead(
    206,
    {
      "Content-Type":
        "audio/mpeg",

      "Content-Range":
        `bytes ${start}-${end}/${size}`,

      "Content-Length":
        end - start + 1,

      "Accept-Ranges":
        "bytes",

      "Cache-Control":
        "no-store"
    }
  );

  fs
    .createReadStream(
      filePath,
      {
        start,
        end
      }
    )
    .pipe(res);
}

/* =========================
   ROUTER
========================= */

async function route(
  req,
  res
) {
  const url =
    new URL(
      req.url,
      `http://${
        req.headers.host ||
        "localhost"
      }`
    );

  /* CORS */

  if (
    req.method === "OPTIONS"
  ) {
    res.writeHead(
      204,
      {
        "Access-Control-Allow-Origin":
          "*",

        "Access-Control-Allow-Headers":
          "Content-Type,X-Admin-Key,X-Device-ID",

        "Access-Control-Allow-Methods":
          "GET,POST,DELETE,OPTIONS"
      }
    );

    return res.end();
  }

  /* HEALTH */

  if (
    url.pathname === "/health"
  ) {
    return json(
      res,
      200,
      {
        ok: true,
        time: Date.now(),
        wingo:
          !!cache.lastSuccessAt
      }
    );
  }

  /* STATE */

  if (
    url.pathname === "/api/state"
  ) {
    return json(
      res,
      200,
      makeState()
    );
  }

  /* HISTORY */

  if (
    url.pathname === "/api/history"
  ) {
    return json(
      res,
      200,
      {
        ok: true,
        settledPeriod:
          cache.settledIssue,
        history:
          cache.history
      }
    );
  }

  /* KEY */

  if (
    url.pathname ===
      "/api/key/check" &&
    req.method === "POST"
  ) {
    try {
      const body =
        await readJsonBody(req);

      const result =
        await checkKey(
          String(
            body.key || ""
          ),
          String(
            body.device_id ||
            req.headers[
              "x-device-id"
            ] ||
            ""
          )
        );

      return json(
        res,
        result.ok
          ? 200
          : 403,
        result
      );
    } catch (error) {
      return json(
        res,
        400,
        {
          ok: false,
          message:
            error.message
        }
      );
    }
  }

  /* ADMIN KEYS */

  if (
    url.pathname ===
    "/api/admin/keys"
  ) {
    return handleAdminKeys(
      req,
      res,
      url
    );
  }

  /* RESET DEVICE */

  if (
    url.pathname ===
      "/api/admin/reset-device" &&
    req.method === "POST"
  ) {
    if (
      !adminOk(req, url)
    ) {
      return json(
        res,
        401,
        {
          ok: false
        }
      );
    }

    const body =
      await readJsonBody(req);

    await pool.query(
      `
      UPDATE access_keys
      SET device_id=NULL
      WHERE access_key=$1
      `,
      [
        String(
          body.key || ""
        )
      ]
    );

    return json(
      res,
      200,
      {
        ok: true
      }
    );
  }

  /* ADMIN STATUS */

  if (
    url.pathname ===
    "/api/admin/status"
  ) {
    if (
      !adminOk(req, url)
    ) {
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
        db: true,
        wingoLastSuccess:
          cache.lastSuccessAt,
        settledPeriod:
          cache.settledIssue,
        targetPeriod:
          cache.targetIssue,
        historyCount:
          cache.history.length,
        historyVersion:
          cache.historyVersion,
        error:
          cache.error
      }
    );
  }

  /* ADMIN PING */

  if (
    url.pathname ===
    "/api/admin/ping"
  ) {
    if (
      !adminOk(req, url)
    ) {
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
        pong: Date.now()
      }
    );
  }

  /* WINGOBOT TEST */

  if (
    url.pathname ===
    "/api/admin/wingo-test"
  ) {
    if (
      !adminOk(req, url)
    ) {
      return json(
        res,
        401,
        {
          ok: false
        }
      );
    }

    try {
      const data =
        await fetchWingoBot();

      return json(
        res,
        200,
        {
          ok: true,
          current:
            data.current ||
            null,

          historyCount:
            Array.isArray(
              data.history
            )
              ? data.history.length
              : 0
        }
      );
    } catch (error) {
      return json(
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

  /* STATIC */

  if (
    url.pathname === "/" ||
    url.pathname ===
      "/prediction.html"
  ) {
    return sendFile(
      res,
      "prediction.html",
      "text/html; charset=utf-8"
    );
  }

  if (
    url.pathname ===
    "/admin.html"
  ) {
    return sendFile(
      res,
      "admin.html",
      "text/html; charset=utf-8"
    );
  }

  if (
    url.pathname ===
    "/music.mp3"
  ) {
    return serveMp3(
      req,
      res
    );
  }

  return json(
    res,
    404,
    {
      ok: false,
      message:
        "Not found"
    }
  );
}

/* =========================
   START SERVER
========================= */

(async () => {
  try {
    await ensureDb();

    await refreshWingo();

    /*
       API refresh every second.
       Prediction itself does NOT
       regenerate every second.
    */

    setInterval(
      refreshWingo,
      API_REFRESH_MS
    );

    const server =
      http.createServer(
        (req, res) => {
          route(
            req,
            res
          ).catch(error => {
            console.error(
              error
            );

            json(
              res,
              500,
              {
                ok: false,
                message:
                  "Server error"
              }
            );
          });
        }
      );

    server.listen(
      PORT,
      () => {
        console.log(
          `DY AI server running on ${PORT}`
        );
      }
    );
  } catch (error) {
    console.error(
      "Startup error:",
      error
    );

    process.exit(1);
  }
})();
