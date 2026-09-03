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

const PORT =
  Number(process.env.PORT || 10000);

const DATABASE_URL =
  process.env.DATABASE_URL || "";

const WINGOBOT_TOKEN =
  process.env.WINGOBOT_TOKEN || "";

const ADMIN_KEY =
  process.env.ADMIN_KEY ||
  "dy4427574";

const WINGOBOT_HISTORY_URL =
  "https://api.wingobot.com/v2/30-sec-game-history";

const PUBLIC_DIR =
  __dirname;

const PREDICTION_FILE =
  path.join(
    PUBLIC_DIR,
    "prediction.html"
  );

const ADMIN_FILE =
  path.join(
    PUBLIC_DIR,
    "admin.html"
  );

const MUSIC_FILE =
  path.join(
    PUBLIC_DIR,
    "music.mp3"
  );


/* =========================================================
   DATABASE
========================================================= */

if (!DATABASE_URL) {
  console.warn(
    "[WARNING] DATABASE_URL is not configured."
  );
}

const pool =
  new Pool({
    connectionString:
      DATABASE_URL || undefined,

    ssl:
      process.env.NODE_ENV === "production"
        ? {
            rejectUnauthorized: false
          }
        : undefined,

    max: 10,

    idleTimeoutMillis:
      30000,

    connectionTimeoutMillis:
      10000
  });

let dbReady = false;


/* =========================================================
   LIVE STATE
========================================================= */

let liveState = {

  currentIssue: "",

  latestSettledIssue: "",

  targetIssue: "",

  countdown: 30,

  prediction: "WAIT",

  number: null,

  confidence: 0,

  status: "WAIT",

  analysis: {

    patternScore: 0,

    modelAgreement: 0,

    backtestSamples: 0,

    avgModelAccuracy: null
  },

  history: [],

  predictionHistory: [],

  wins: 0,

  losses: 0,

  skipped: 0,

  lastUpdated: 0,

  providerUpdated: null,

  aiPrediction: "WAIT",

  aiNumber: null,

  error: null
};

let updateInProgress = false;


/* =========================================================
   DATABASE INIT
========================================================= */

async function initDatabase() {

  if (!DATABASE_URL) {
    return;
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

        target_issue TEXT UNIQUE NOT NULL,

        prediction TEXT NOT NULL,

        predicted_number INTEGER,

        ai_prediction TEXT,

        ai_number INTEGER,

        mode TEXT DEFAULT 'AI MODE',

        randomized BOOLEAN DEFAULT FALSE,

        confidence INTEGER DEFAULT 0,

        status TEXT DEFAULT 'WAIT',

        created_at BIGINT NOT NULL,

        result_number INTEGER,

        result_side TEXT,

        outcome TEXT DEFAULT 'PENDING',

        settled_at BIGINT DEFAULT 0
      )
    `);


    /*
      Test ke liye purane pending records hata do.
      Settled WIN/LOSS records ko touch nahi karte.
    */

    await pool.query(`
      DELETE FROM prediction_records
      WHERE outcome = 'PENDING'
    `);


    dbReady = true;

    console.log(
      "[DATABASE] Ready"
    );

  } catch (error) {

    console.error(
      "[DATABASE INIT ERROR]",
      error.message
    );

    dbReady = false;
  }
}


/* =========================================================
   BASIC HELPERS
========================================================= */

function now() {
  return Date.now();
}


function jsonResponse(
  res,
  status,
  data
) {

  const body =
    JSON.stringify(data);

  res.writeHead(
    status,
    {

      "Content-Type":
        "application/json; charset=utf-8",

      "Cache-Control":
        "no-store, no-cache, must-revalidate",

      "Pragma":
        "no-cache",

      "Access-Control-Allow-Origin":
        "*",

      "Access-Control-Allow-Headers":
        "Content-Type, X-Admin-Key, X-Access-Key",

      "Access-Control-Allow-Methods":
        "GET, POST, DELETE, OPTIONS"
    }
  );

  res.end(body);
}


function textResponse(
  res,
  status,
  text,
  type = "text/plain"
) {

  res.writeHead(
    status,
    {

      "Content-Type":
        type,

      "Cache-Control":
        "no-store"
    }
  );

  res.end(text);
}


function safeJsonParse(
  text
) {

  try {

    return JSON.parse(text);

  } catch {

    return {};
  }
}


function readBody(req) {

  return new Promise(
    resolve => {

      let body = "";

      req.on(
        "data",
        chunk => {

          body +=
            chunk.toString();

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

          resolve(
            safeJsonParse(body)
          );
        }
      );


      req.on(
        "error",
        () => {

          resolve({});
        }
      );
    }
  );
}


/* =========================================================
   NUMBER / SIDE HELPERS
========================================================= */

function cleanNumber(
  value
) {

  const n =
    Number(value);

  if (
    !Number.isInteger(n) ||
    n < 0 ||
    n > 9
  ) {

    return null;
  }

  return n;
}


function sideFromNumber(
  number
) {

  const n =
    cleanNumber(number);

  if (n === null) {
    return null;
  }

  return n >= 5
    ? "BIG"
    : "SMALL";
}


function normalizeSide(
  value
) {

  if (!value) {
    return null;
  }

  const s =
    String(value)
      .trim()
      .toUpperCase();

  if (
    s === "BIG" ||
    s === "B"
  ) {

    return "BIG";
  }

  if (
    s === "SMALL" ||
    s === "S"
  ) {

    return "SMALL";
  }

  return null;
}


/* =========================================================
   ISSUE HELPERS
========================================================= */

function normalizeIssue(
  value
) {

  if (
    value === null ||
    value === undefined
  ) {

    return "";
  }

  return String(value).trim();
}


function incrementIssue(
  issue
) {

  const s =
    normalizeIssue(issue);

  if (!s) {
    return "";
  }

  if (/^\d+$/.test(s)) {

    try {

      const next =
        (
          BigInt(s) + 1n
        ).toString();

      if (
        next.length <
        s.length
      ) {

        return next.padStart(
          s.length,
          "0"
        );
      }

      return next;

    } catch {

      return "";
    }
  }

  return "";
}


/* =========================================================
   TARGET RESOLUTION
========================================================= */

function resolveTargetIssue(
  currentIssue,
  latestSettledIssue
) {

  const current =
    normalizeIssue(
      currentIssue
    );

  const latest =
    normalizeIssue(
      latestSettledIssue
    );


  if (!latest) {
    return current;
  }


  if (!current) {
    return incrementIssue(
      latest
    );
  }


  if (
    /^\d+$/.test(current) &&
    /^\d+$/.test(latest)
  ) {

    try {

      const c =
        BigInt(current);

      const l =
        BigInt(latest);

      if (c > l) {
        return current;
      }

      return incrementIssue(
        latest
      );

    } catch {

      return incrementIssue(
        latest
      );
    }
  }


  if (
    current === latest
  ) {

    return incrementIssue(
      latest
    );
  }


  return current;
}


/* =========================================================
   WINGOBOT API
========================================================= */

async function fetchWingoHistory() {

  if (!WINGOBOT_TOKEN) {

    throw new Error(
      "WINGOBOT_TOKEN is missing"
    );
  }


  const response =
    await fetch(
      WINGOBOT_HISTORY_URL,
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


  const text =
    await response.text();


  if (!response.ok) {

    throw new Error(
      `WingoBot HTTP ${response.status}: ${text.slice(0,300)}`
    );
  }


  return safeJsonParse(
    text
  );
}


/* =========================================================
   HISTORY NORMALIZATION
========================================================= */

function normalizeHistory(
  apiData
) {

  const raw =
    Array.isArray(
      apiData?.history
    )
      ? apiData.history
      : [];


  const result = [];


  for (
    const row of raw
  ) {

    const issue =
      normalizeIssue(
        row?.issueNumber
      );

    const number =
      cleanNumber(
        row?.number
      );


    if (
      !issue ||
      number === null
    ) {

      continue;
    }


    const calculatedSide =
      sideFromNumber(
        number
      );


    const apiSide =
      normalizeSide(
        row?.colour
      );


    result.push({

      issueNumber:
        issue,

      number:
        number,

      side:
        calculatedSide,

      colour:
        apiSide ||
        calculatedSide,

      premium:
        row?.premium ?? null,

      sum:
        row?.sum ?? null
    });
  }


  result.sort(
    (a, b) => {

      if (
        /^\d+$/.test(
          a.issueNumber
        ) &&
        /^\d+$/.test(
          b.issueNumber
        )
      ) {

        try {

          const aa =
            BigInt(
              a.issueNumber
            );

          const bb =
            BigInt(
              b.issueNumber
            );


          if (aa > bb) {
            return -1;
          }

          if (aa < bb) {
            return 1;
          }

        } catch {}
      }


      return 0;
    }
  );


  return result;
}


/* =========================================================
   RANDOM PREDICTION
========================================================= */

function createPrediction(
  history,
  targetIssue
) {

  /*
    Side random:
      50% BIG
      50% SMALL
  */

  const prediction =
    Math.random() < 0.5
      ? "BIG"
      : "SMALL";


  /*
    Number random,
    lekin selected side ke andar.
  */

  const numbers =
    prediction === "BIG"
      ? [5, 6, 7, 8, 9]
      : [0, 1, 2, 3, 4];


  const number =
    numbers[
      Math.floor(
        Math.random() *
        numbers.length
      )
    ];


  return {

    targetIssue,

    prediction,

    number,

    /*
      Random output ke liye
      confidence neutral rakha gaya hai.
    */

    confidence: 50,

    status:
      "RANDOM SIGNAL",

    analysis: {

      patternScore: 0,

      modelAgreement: 0,

      backtestSamples: 0,

      avgModelAccuracy: null
    },

    aiPrediction:
      prediction,

    aiNumber:
      number
  };
}


/* =========================================================
   PREDICTION DATABASE
========================================================= */

async function getPredictionRecord(
  issue
) {

  if (!dbReady) {
    return null;
  }


  const result =
    await pool.query(
      `
      SELECT *
      FROM prediction_records
      WHERE target_issue = $1
      LIMIT 1
      `,
      [
        String(issue)
      ]
    );


  return (
    result.rows[0] ||
    null
  );
}


/* =========================================================
   SAVE PREDICTION
========================================================= */

async function savePrediction(
  prediction
) {

  if (!dbReady) {
    return null;
  }


  const validSide =
    normalizeSide(
      prediction.prediction
    );


  if (!validSide) {
    return null;
  }


  const validNumber =
    cleanNumber(
      prediction.number
    );


  if (validNumber === null) {
    return null;
  }


  const result =
    await pool.query(
      `
      INSERT INTO prediction_records (
        target_issue,
        prediction,
        predicted_number,
        ai_prediction,
        ai_number,
        mode,
        randomized,
        confidence,
        status,
        created_at,
        outcome
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        'TEST',
        TRUE,
        $6,
        $7,
        $8,
        'PENDING'
      )
      ON CONFLICT (target_issue)
      DO NOTHING
      RETURNING *
      `,
      [

        prediction.targetIssue,

        validSide,

        validNumber,

        validSide,

        validNumber,

        prediction.confidence,

        prediction.status,

        now()
      ]
    );


  return (
    result.rows[0] ||
    await getPredictionRecord(
      prediction.targetIssue
    )
  );
}


/* =========================================================
   SETTLE PREDICTIONS
========================================================= */

async function settlePredictions(
  history
) {

  if (
    !dbReady ||
    !Array.isArray(history) ||
    !history.length
  ) {

    return;
  }


  for (
    const actual of history
  ) {

    const issue =
      normalizeIssue(
        actual.issueNumber
      );


    const number =
      cleanNumber(
        actual.number
      );


    const actualSide =
      sideFromNumber(
        number
      );


    if (
      !issue ||
      number === null ||
      !actualSide
    ) {

      continue;
    }


    /*
      EXACT ISSUE MATCH

      Prediction 51327
      Result 51327

      Tabhi W/L.
    */

    const result =
      await pool.query(
        `
        SELECT *
        FROM prediction_records
        WHERE target_issue = $1
        LIMIT 1
        `,
        [issue]
      );


    if (
      !result.rows.length
    ) {

      continue;
    }


    const record =
      result.rows[0];


    if (
      record.outcome === "WIN" ||
      record.outcome === "LOSS"
    ) {

      continue;
    }


    const prediction =
      normalizeSide(
        record.prediction
      );


    if (!prediction) {

      await pool.query(
        `
        DELETE FROM prediction_records
        WHERE
          target_issue = $1
          AND outcome = 'PENDING'
        `,
        [issue]
      );

      continue;
    }


    const outcome =
      prediction === actualSide
        ? "WIN"
        : "LOSS";


    await pool.query(
      `
      UPDATE prediction_records
      SET

        result_number = $2,

        result_side = $3,

        outcome = $4,

        settled_at = $5

      WHERE
        target_issue = $1

        AND outcome = 'PENDING'
      `,
      [

        issue,

        number,

        actualSide,

        outcome,

        now()
      ]
    );
  }
}


/* =========================================================
   GET PREDICTION HISTORY
========================================================= */

async function getPredictionHistory() {

  if (!dbReady) {
    return [];
  }


  const result =
    await pool.query(
      `
      SELECT

        target_issue,

        prediction,

        predicted_number,

        ai_prediction,

        ai_number,

        confidence,

        status,

        created_at,

        result_number,

        result_side,

        outcome,

        settled_at

      FROM prediction_records

      WHERE
        prediction IN ('BIG','SMALL')

      ORDER BY id DESC

      LIMIT 30
      `
    );


  return result.rows;
}


/* =========================================================
   STATS
========================================================= */

async function getStats() {

  if (!dbReady) {

    return {

      wins: 0,

      losses: 0,

      skipped: 0
    };
  }


  const result =
    await pool.query(
      `
      SELECT

        COUNT(*) FILTER (
          WHERE outcome = 'WIN'
        ) AS wins,

        COUNT(*) FILTER (
          WHERE outcome = 'LOSS'
        ) AS losses,

        COUNT(*) FILTER (
          WHERE outcome = 'SKIPPED'
        ) AS skipped

      FROM prediction_records
      `
    );


  const row =
    result.rows[0] || {};


  return {

    wins:
      Number(
        row.wins || 0
      ),

    losses:
      Number(
        row.losses || 0
      ),

    skipped:
      Number(
        row.skipped || 0
      )
  };
}


/* =========================================================
   TIMESTAMP
========================================================= */

function normalizeTimestamp(
  value
) {

  const n =
    Number(value);


  if (
    !Number.isFinite(n) ||
    n <= 0
  ) {

    return 0;
  }


  if (
    n < 100000000000
  ) {

    return n * 1000;
  }


  return n;
}


/* =========================================================
   COUNTDOWN
========================================================= */

function calculateCountdown(
  currentIssue,
  latestUpdated
) {

  const updated =
    normalizeTimestamp(
      latestUpdated
    );


  if (!updated) {

    const seconds =
      Math.floor(
        Date.now() / 1000
      );


    const remainder =
      seconds % 30;


    return (
      remainder === 0
        ? 30
        : 30 - remainder
    );
  }


  const elapsed =
    Math.floor(
      (
        Date.now() -
        updated
      ) / 1000
    );


  const remainder =
    elapsed % 30;


  const remaining =
    remainder === 0
      ? 30
      : 30 - remainder;


  return Math.max(
    1,
    Math.min(
      30,
      remaining
    )
  );
}


/* =========================================================
   UPDATE LIVE STATE
========================================================= */

async function updateLiveState() {

  if (
    updateInProgress
  ) {

    return liveState;
  }


  updateInProgress =
    true;


  try {

    const apiData =
      await fetchWingoHistory();


    const history =
      normalizeHistory(
        apiData
      );


    const currentIssue =
      normalizeIssue(
        apiData?.current?.issueNumber
      );


    const latestSettledIssue =
      history[0]?.issueNumber ||
      "";


    const targetIssue =
      resolveTargetIssue(
        currentIssue,
        latestSettledIssue
      );


    /*
      Pehle old predictions settle.
    */

    await settlePredictions(
      history
    );


    /*
      Current target ka existing prediction check.
    */

    let record =
      await getPredictionRecord(
        targetIssue
      );


    /*
      Agar target ke liye prediction nahi hai,
      fresh random prediction create karo.
    */

    if (
      !record &&
      targetIssue
    ) {

      const prediction =
        createPrediction(
          history,
          targetIssue
        );


      record =
        await savePrediction(
          prediction
        );


      if (record) {

        console.log(
          `[PREDICTION CREATED] ${targetIssue} => ${prediction.prediction} ${prediction.number}`
        );
      }
    }


    const stats =
      await getStats();


    const predictionHistory =
      await getPredictionHistory();


    let prediction =
      "WAIT";


    let number =
      null;


    let confidence =
      0;


    let status =
      "WAIT";


    let analysis = {

      patternScore: 0,

      modelAgreement: 0,

      backtestSamples: 0,

      avgModelAccuracy: null
    };


    if (record) {

      prediction =
        normalizeSide(
          record.prediction
        ) ||
        "WAIT";


      number =
        cleanNumber(
          record.predicted_number
        );


      confidence =
        Number(
          record.confidence || 0
        );


      status =
        record.status ||
        "WAIT";


      analysis = {

        patternScore: 0,

        modelAgreement: 0,

        backtestSamples: 0,

        avgModelAccuracy: null
      };
    }


    liveState = {

      currentIssue,

      latestSettledIssue,

      targetIssue,

      countdown:
        calculateCountdown(
          currentIssue,
          apiData?.stats?.last_updated
        ),

      prediction,

      number,

      confidence,

      status,

      analysis,

      history:
        history.slice(
          0,
          30
        ),

      predictionHistory,

      wins:
        stats.wins,

      losses:
        stats.losses,

      skipped:
        stats.skipped,

      lastUpdated:
        now(),

      providerUpdated:
        apiData?.stats?.last_updated ||
        null,

      aiPrediction:
        prediction,

      aiNumber:
        number,

      error:
        null
    };


    return liveState;

  } catch (error) {

    console.error(
      "[LIVE UPDATE ERROR]",
      error.message
    );


    liveState = {

      ...liveState,

      error:
        error.message,

      lastUpdated:
        now()
    };


    return liveState;

  } finally {

    updateInProgress =
      false;
  }
}


/* =========================================================
   ADMIN AUTH
========================================================= */

function isAdmin(
  req,
  body = {}
) {

  const headerKey =
    req.headers[
      "x-admin-key"
    ];


  const bodyKey =
    body.admin_key ||
    body.adminKey;


  return (
    headerKey === ADMIN_KEY ||
    bodyKey === ADMIN_KEY
  );
}


/* =========================================================
   ACCESS KEY
========================================================= */

function getAccessKeyFromRequest(
  req
) {

  return (
    req.headers[
      "x-access-key"
    ] ||
    ""
  ).trim();
}


/* =========================================================
   KEY CHECK
========================================================= */

async function checkAccessKey(
  accessKey,
  deviceId
) {

  if (!dbReady) {

    return {

      success: false,

      error:
        "DATABASE_NOT_READY"
    };
  }


  const key =
    String(
      accessKey || ""
    ).trim();


  const device =
    String(
      deviceId || ""
    ).trim();


  if (
    !key ||
    !device
  ) {

    return {

      success: false,

      error:
        "INVALID_REQUEST"
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


  if (
    !result.rows.length
  ) {

    return {

      success: false,

      error:
        "INVALID_ACCESS_KEY"
    };
  }


  const row =
    result.rows[0];


  if (
    row.device_id &&
    row.device_id !== device
  ) {

    return {

      success: false,

      error:
        "KEY_ALREADY_USED_ON_ANOTHER_DEVICE"
    };
  }


  await pool.query(
    `
    UPDATE access_keys
    SET

      device_id = $2,

      last_seen = $3

    WHERE access_key = $1
    `,
    [

      key,

      device,

      now()
    ]
  );


  return {

    success: true,

    error: null
  };
}


/* =========================================================
   ADMIN KEY LIST
========================================================= */

async function listKeys() {

  if (!dbReady) {
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


/* =========================================================
   CREATE ACCESS KEY
========================================================= */

async function createAccessKey(
  requestedKey
) {

  if (!dbReady) {

    throw new Error(
      "DATABASE_NOT_READY"
    );
  }


  let key =
    String(
      requestedKey || ""
    ).trim();


  if (!key) {

    key =
      "DY-" +
      crypto
        .randomBytes(6)
        .toString("hex")
        .toUpperCase();
  }


  const result =
    await pool.query(
      `
      INSERT INTO access_keys (
        access_key,
        created_at
      )
      VALUES (
        $1,
        $2
      )
      RETURNING

        id,

        access_key,

        device_id,

        created_at,

        last_seen
      `,
      [

        key,

        now()
      ]
    );


  return result.rows[0];
}


/* =========================================================
   ADMIN MODEL TEST
========================================================= */

async function adminModelTest() {

  const history =
    Array.isArray(
      liveState.history
    )
      ? liveState.history
      : [];


  const prediction =
    createPrediction(
      history,
      liveState.targetIssue
    );


  return {

    success: true,

    liveTarget:
      liveState.targetIssue,

    latestSettled:
      liveState.latestSettledIssue,

    prediction:
      prediction.prediction,

    number:
      prediction.number,

    confidence:
      prediction.confidence,

    status:
      prediction.status,

    analysis:
      prediction.analysis
  };
}


/* =========================================================
   ADMIN WINGO TEST
========================================================= */

async function adminWingoTest() {

  try {

    const apiData =
      await fetchWingoHistory();


    const history =
      normalizeHistory(
        apiData
      );


    return {

      success: true,

      current:
        apiData?.current ||
        null,

      stats:
        apiData?.stats ||
        null,

      historyCount:
        history.length,

      latest:
        history[0] ||
        null,

      first10:
        history.slice(
          0,
          10
        )
    };

  } catch (error) {

    return {

      success: false,

      error:
        error.message
    };
  }
}


/* =========================================================
   STATIC FILE
========================================================= */

function serveStatic(
  req,
  res,
  pathname
) {

  let filePath;


  if (
    pathname === "/" ||
    pathname === "/prediction.html"
  ) {

    filePath =
      PREDICTION_FILE;

  } else if (
    pathname === "/admin.html"
  ) {

    filePath =
      ADMIN_FILE;

  } else if (
    pathname === "/music.mp3"
  ) {

    filePath =
      MUSIC_FILE;

  } else {

    textResponse(
      res,
      404,
      "Not Found"
    );

    return;
  }


  if (
    !fs.existsSync(
      filePath
    )
  ) {

    textResponse(
      res,
      404,
      "File not found"
    );

    return;
  }


  const ext =
    path.extname(
      filePath
    ).toLowerCase();


  const types = {

    ".html":
      "text/html; charset=utf-8",

    ".js":
      "application/javascript; charset=utf-8",

    ".css":
      "text/css; charset=utf-8",

    ".json":
      "application/json; charset=utf-8",

    ".mp3":
      "audio/mpeg"
  };


  const contentType =
    types[ext] ||
    "application/octet-stream";


  if (
    ext === ".mp3"
  ) {

    serveAudio(
      req,
      res,
      filePath
    );

    return;
  }


  fs.readFile(
    filePath,
    (error, data) => {

      if (error) {

        textResponse(
          res,
          500,
          "Read error"
        );

        return;
      }


      res.writeHead(
        200,
        {

          "Content-Type":
            contentType,

          "Cache-Control":
            "no-store"
        }
      );


      res.end(data);
    }
  );
}


/* =========================================================
   AUDIO RANGE
========================================================= */

function serveAudio(
  req,
  res,
  filePath
) {

  fs.stat(
    filePath,
    (error, stats) => {

      if (error) {

        textResponse(
          res,
          404,
          "Audio not found"
        );

        return;
      }


      const size =
        stats.size;


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
        /bytes=(\d+)-(\d*)/
          .exec(range);


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


      const start =
        Number(
          match[1]
        );


      let end =
        match[2]
          ? Number(
              match[2]
            )
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

        res.end();

        return;
      }


      const chunkSize =
        end -
        start +
        1;


      res.writeHead(
        206,
        {

          "Content-Type":
            "audio/mpeg",

          "Content-Length":
            chunkSize,

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


/* =========================================================
   SERVER
========================================================= */

const server =
  http.createServer(
    async (
      req,
      res
    ) => {

      try {

        /* =================================================
           OPTIONS
        ================================================= */

        if (
          req.method ===
          "OPTIONS"
        ) {

          res.writeHead(
            204,
            {

              "Access-Control-Allow-Origin":
                "*",

              "Access-Control-Allow-Headers":
                "Content-Type, X-Admin-Key, X-Access-Key",

              "Access-Control-Allow-Methods":
                "GET, POST, DELETE, OPTIONS"
            }
          );

          res.end();

          return;
        }


        const parsed =
          new URL(
            req.url,
            `http://${req.headers.host || "localhost"}`
          );


        const pathname =
          parsed.pathname;


        /* =================================================
           HEALTH
        ================================================= */

        if (
          pathname === "/health"
        ) {

          jsonResponse(
            res,
            200,
            {

              ok: true,

              database:
                dbReady,

              wingoBot:
                Boolean(
                  WINGOBOT_TOKEN
                ),

              time:
                new Date().toISOString()
            }
          );

          return;
        }


        /* =================================================
           ACCESS KEY CHECK
        ================================================= */

        if (
          pathname ===
            "/api/key/check" &&
          req.method ===
            "POST"
        ) {

          const body =
            await readBody(
              req
            );


          const result =
            await checkAccessKey(
              body.access_key ||
              body.accessKey,

              body.device_id ||
              body.deviceId
            );


          jsonResponse(
            res,

            result.success
              ? 200
              : 403,

            result
          );

          return;
        }


        /* =================================================
           LIVE STATE
        ================================================= */

        if (
          pathname ===
            "/api/state" &&
          req.method ===
            "GET"
        ) {

          await updateLiveState();


          jsonResponse(
            res,
            200,
            liveState
          );

          return;
        }


        /* =================================================
           PREDICTION HISTORY
        ================================================= */

        if (
          pathname ===
            "/api/history" &&
          req.method ===
            "GET"
        ) {

          await updateLiveState();


          const history =
            await getPredictionHistory();


          jsonResponse(
            res,
            200,
            {

              success: true,

              history
            }
          );

          return;
        }


        /* =================================================
           ADMIN STATUS
        ================================================= */

        if (
          pathname ===
            "/api/admin/status" &&
          req.method ===
            "GET"
        ) {

          if (
            !isAdmin(req)
          ) {

            jsonResponse(
              res,
              403,
              {

                success: false,

                error:
                  "UNAUTHORIZED"
              }
            );

            return;
          }


          await updateLiveState();


          jsonResponse(
            res,
            200,
            {

              success: true,

              database:
                dbReady,

              wingoBot:
                Boolean(
                  WINGOBOT_TOKEN
                ),

              currentIssue:
                liveState.currentIssue,

              latestSettledIssue:
                liveState.latestSettledIssue,

              targetIssue:
                liveState.targetIssue,

              prediction:
                liveState.prediction,

              number:
                liveState.number,

              confidence:
                liveState.confidence,

              status:
                liveState.status
            }
          );

          return;
        }


        /* =================================================
           ADMIN PING
        ================================================= */

        if (
          pathname ===
            "/api/admin/ping" &&
          req.method ===
            "POST"
        ) {

          const body =
            await readBody(
              req
            );


          if (
            !isAdmin(
              req,
              body
            )
          ) {

            jsonResponse(
              res,
              403,
              {

                success: false,

                error:
                  "UNAUTHORIZED"
              }
            );

            return;
          }


          jsonResponse(
            res,
            200,
            {

              success: true,

              message:
                "Admin connection OK",

              time:
                new Date().toISOString()
            }
          );

          return;
        }


        /* =================================================
           ADMIN KEYS GET
        ================================================= */

        if (
          pathname ===
            "/api/admin/keys" &&
          req.method ===
            "GET"
        ) {

          if (
            !isAdmin(req)
          ) {

            jsonResponse(
              res,
              403,
              {

                success: false,

                error:
                  "UNAUTHORIZED"
              }
            );

            return;
          }


          const keys =
            await listKeys();


          jsonResponse(
            res,
            200,
            {

              success: true,

              keys
            }
          );

          return;
        }


        /* =================================================
           ADMIN KEY CREATE
        ================================================= */

        if (
          pathname ===
            "/api/admin/keys" &&
          req.method ===
            "POST"
        ) {

          const body =
            await readBody(
              req
            );


          if (
            !isAdmin(
              req,
              body
            )
          ) {

            jsonResponse(
              res,
              403,
              {

                success: false,

                error:
                  "UNAUTHORIZED"
              }
            );

            return;
          }


          try {

            const key =
              await createAccessKey(
                body.access_key ||
                body.accessKey ||
                body.key
              );


            jsonResponse(
              res,
              200,
              {

                success: true,

                key
              }
            );

          } catch (error) {

            jsonResponse(
              res,
              400,
              {

                success: false,

                error:
                  error.code ===
                  "23505"
                    ? "KEY_ALREADY_EXISTS"
                    : error.message
              }
            );
          }

          return;
        }


        /* =================================================
           ADMIN KEY DELETE
        ================================================= */

        if (
          pathname ===
            "/api/admin/keys" &&
          req.method ===
            "DELETE"
        ) {

          const body =
            await readBody(
              req
            );


          if (
            !isAdmin(
              req,
              body
            )
          ) {

            jsonResponse(
              res,
              403,
              {

                success: false,

                error:
                  "UNAUTHORIZED"
              }
            );

            return;
          }


          const id =
            body.id;


          const accessKey =
            body.access_key ||
            body.accessKey ||
            body.key;


          let result;


          if (id) {

            result =
              await pool.query(
                `
                DELETE FROM access_keys
                WHERE id = $1
                RETURNING id, access_key
                `,
                [id]
              );

          } else {

            result =
              await pool.query(
                `
                DELETE FROM access_keys
                WHERE access_key = $1
                RETURNING id, access_key
                `,
                [accessKey]
              );
          }


          jsonResponse(
            res,
            200,
            {

              success: true,

              deleted:
                result.rows[0] ||
                null
            }
          );

          return;
        }


        /* =================================================
           RESET DEVICE
        ================================================= */

        if (
          pathname ===
            "/api/admin/reset-device" &&
          req.method ===
            "POST"
        ) {

          const body =
            await readBody(
              req
            );


          if (
            !isAdmin(
              req,
              body
            )
          ) {

            jsonResponse(
              res,
              403,
              {

                success: false,

                error:
                  "UNAUTHORIZED"
              }
            );

            return;
          }


          const id =
            body.id;


          const accessKey =
            body.access_key ||
            body.accessKey ||
            body.key;


          let result;


          if (id) {

            result =
              await pool.query(
                `
                UPDATE access_keys

                SET
                  device_id = NULL,
                  last_seen = 0

                WHERE id = $1

                RETURNING id, access_key
                `,
                [id]
              );

          } else {

            result =
              await pool.query(
                `
                UPDATE access_keys

                SET
                  device_id = NULL,
                  last_seen = 0

                WHERE access_key = $1

                RETURNING id, access_key
                `,
                [accessKey]
              );
          }


          jsonResponse(
            res,
            200,
            {

              success: true,

              reset:
                result.rows[0] ||
                null
            }
          );

          return;
        }


        /* =================================================
           ADMIN WINGO TEST
        ================================================= */

        if (
          pathname ===
            "/api/admin/wingo-test" &&
          req.method ===
            "POST"
        ) {

          const body =
            await readBody(
              req
            );


          if (
            !isAdmin(
              req,
              body
            )
          ) {

            jsonResponse(
              res,
              403,
              {

                success: false,

                error:
                  "UNAUTHORIZED"
              }
            );

            return;
          }


          const result =
            await adminWingoTest();


          jsonResponse(
            res,

            result.success
              ? 200
              : 502,

            result
          );

          return;
        }


        /* =================================================
           ADMIN MODEL TEST
        ================================================= */

        if (
          pathname ===
            "/api/admin/model-test" &&
          req.method ===
            "POST"
        ) {

          const body =
            await readBody(
              req
            );


          if (
            !isAdmin(
              req,
              body
            )
          ) {

            jsonResponse(
              res,
              403,
              {

                success: false,

                error:
                  "UNAUTHORIZED"
              }
            );

            return;
          }


          await updateLiveState();


          const result =
            await adminModelTest();


          jsonResponse(
            res,
            200,
            result
          );

          return;
        }


        /* =================================================
           STATIC
        ================================================= */

        serveStatic(
          req,
          res,
          pathname
        );

      } catch (error) {

        console.error(
          "[SERVER ERROR]",
          error
        );


        jsonResponse(
          res,
          500,
          {

            success: false,

            error:
              "INTERNAL_SERVER_ERROR"
          }
        );
      }
    }
  );


/* =========================================================
   START
========================================================= */

async function start() {

  await initDatabase();


  /*
    Initial live update.
  */

  try {

    await updateLiveState();

  } catch (error) {

    console.error(
      "[INITIAL WINGO ERROR]",
      error.message
    );
  }


  /*
    WingoBot se har 3 second
    latest history fetch hogi.
  */

  setInterval(
    async () => {

      try {

        await updateLiveState();

      } catch (error) {

        console.error(
          "[POLL ERROR]",
          error.message
        );
      }

    },
    3000
  );


  server.listen(
    PORT,
    "0.0.0.0",
    () => {

      console.log(
        `DY AI Wingo server running on port ${PORT}`
      );

      console.log(
        `Database: ${
          dbReady
            ? "READY"
            : "NOT READY"
        }`
      );

      console.log(
        `WingoBot: ${
          WINGOBOT_TOKEN
            ? "TOKEN SET"
            : "TOKEN MISSING"
        }`
      );
    }
  );
}


start();


/* =========================================================
   GRACEFUL SHUTDOWN
========================================================= */

process.on(
  "SIGTERM",
  async () => {

    console.log(
      "SIGTERM received."
    );


    server.close(
      async () => {

        try {
          await pool.end();
        } catch {}


        process.exit(0);
      }
    );
  }
);


process.on(
  "SIGINT",
  async () => {

    console.log(
      "SIGINT received."
    );


    server.close(
      async () => {

        try {
          await pool.end();
        } catch {}


        process.exit(0);
      }
    );
  }
);
