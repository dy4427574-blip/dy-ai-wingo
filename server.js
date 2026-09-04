"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

/* =========================================================
   DY AI WINGO 30S — V4 SERVER
   ========================================================= */

const PORT = Number(process.env.PORT || 10000);

const ADMIN_KEY =
  process.env.ADMIN_KEY || "dy4427574";

const WINGOBOT_TOKEN =
  process.env.WINGOBOT_TOKEN || "";

const WINGOBOT_URL =
  "https://api.wingobot.com/v2/30-sec-game-history";

const GAME_URL =
  "https://www.shreewin38.com/#/register?invitationCode=88523152383";

const MODEL_VERSION =
  "DY-AI-BS-V4";

const ROOT =
  __dirname;


/* =========================================================
   DATABASE
   ========================================================= */

let pool = null;

if (process.env.DATABASE_URL) {

  pool = new Pool({
    connectionString:
      process.env.DATABASE_URL,

    ssl:
      process.env.DATABASE_URL.includes("localhost")
        ? false
        : { rejectUnauthorized: false },

    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });

}


/* =========================================================
   MEMORY CACHE
   ========================================================= */

let providerCache = {
  history: [],
  currentIssue: "",
  lastUpdated: 0,
  fetched: 0,
  fetchedAt: 0,
  error: null
};

let lastProviderFetch = 0;

let stateCache = {
  updatedAt: 0,
  data: null
};


/* =========================================================
   UTILS
   ========================================================= */

function now() {
  return Date.now();
}


function json(res, status, data) {

  const body =
    JSON.stringify(data);

  res.writeHead(status, {
    "Content-Type":
      "application/json; charset=utf-8",

    "Cache-Control":
      "no-store",

    "Access-Control-Allow-Origin":
      "*",

    "Access-Control-Allow-Headers":
      "Content-Type, x-access-key, x-device-id, x-admin-key",

    "Access-Control-Allow-Methods":
      "GET,POST,DELETE,OPTIONS"
  });

  res.end(body);
}


function text(res, status, body, type = "text/plain") {

  res.writeHead(status, {
    "Content-Type":
      type,

    "Cache-Control":
      "no-store"
  });

  res.end(body);
}


function parseBody(req) {

  return new Promise((resolve) => {

    let raw = "";

    req.on("data", chunk => {

      raw += chunk.toString();

      if (raw.length > 1024 * 1024) {
        req.destroy();
      }

    });

    req.on("end", () => {

      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }

    });

    req.on("error", () => {
      resolve({});
    });

  });

}


function getHeader(req, name) {

  const value =
    req.headers[name.toLowerCase()];

  if (Array.isArray(value)) {
    return value[0];
  }

  return value || "";
}


function safeEqual(a, b) {

  if (
    typeof a !== "string" ||
    typeof b !== "string"
  ) {
    return false;
  }

  const aa =
    Buffer.from(a);

  const bb =
    Buffer.from(b);

  if (aa.length !== bb.length) {
    return false;
  }

  try {

    return crypto.timingSafeEqual(
      aa,
      bb
    );

  } catch {
    return false;
  }

}


function adminAuthorized(req) {

  const key =
    getHeader(
      req,
      "x-admin-key"
    );

  return safeEqual(
    key,
    ADMIN_KEY
  );

}


function accessKeyFromRequest(req, body = {}) {

  return (
    getHeader(req, "x-access-key") ||
    body.access_key ||
    body.key ||
    ""
  ).trim();

}


function deviceFromRequest(req, body = {}) {

  return (
    getHeader(req, "x-device-id") ||
    body.device_id ||
    ""
  ).trim();

}


function incrementIssue(issue) {

  if (!issue) {
    return "";
  }

  const s =
    String(issue).trim();

  if (!/^\d+$/.test(s)) {
    return "";
  }

  /*
    BigInt is used so long issue numbers
    are not damaged by JavaScript Number.
  */

  try {

    return (
      BigInt(s) + 1n
    ).toString();

  } catch {

    return "";

  }

}


/* =========================================================
   DATABASE INIT
   ========================================================= */

async function initDatabase() {

  if (!pool) {
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


  const columns = [
    [
      "confidence",
      "INTEGER DEFAULT 0"
    ],
    [
      "model_version",
      "TEXT"
    ],
    [
      "actual_number",
      "INTEGER"
    ],
    [
      "actual_result",
      "TEXT"
    ],
    [
      "settled_at",
      "BIGINT"
    ]
  ];


  for (const [name, type] of columns) {

    try {

      await pool.query(
        `ALTER TABLE prediction_records
         ADD COLUMN IF NOT EXISTS ${name} ${type}`
      );

    } catch {}

  }


  await pool.query(`
    UPDATE prediction_records
    SET model_version = 'LEGACY'
    WHERE model_version IS NULL
  `);


  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS
    prediction_records_model_issue_idx
    ON prediction_records(model_version, target_issue)
  `);

}


/* =========================================================
   WINGOBOT FETCH
   ========================================================= */

async function fetchWingoHistory(force = false) {

  if (
    !force &&
    providerCache.history.length > 0 &&
    now() - lastProviderFetch < 2500
  ) {

    return providerCache;

  }


  if (!WINGOBOT_TOKEN) {

    providerCache.error =
      "WINGOBOT_TOKEN is missing";

    return providerCache;

  }


  lastProviderFetch =
    now();


  try {

    const response =
      await fetch(
        WINGOBOT_URL,
        {
          method: "GET",

          headers: {
            "Authorization":
              `Bearer ${WINGOBOT_TOKEN}`,

            "Accept":
              "application/json"
          },

          signal:
            AbortSignal.timeout(12000)
        }
      );


    if (!response.ok) {

      throw new Error(
        `WingoBot HTTP ${response.status}`
      );

    }


    const data =
      await response.json();


    const rows =
      Array.isArray(data.history)
        ? data.history
        : [];


    const history =
      rows
        .map(normalizeHistoryRow)
        .filter(Boolean)
        .sort(
          (a, b) =>
            compareIssue(
              b.issueNumber,
              a.issueNumber
            )
        );


    const currentIssue =
      data.current &&
      data.current.issueNumber
        ? String(
            data.current.issueNumber
          )
        : "";


    const stats =
      data.stats || {};


    const lastUpdated =
      Number(
        stats.last_updated ||
        data.last_updated ||
        data.lastUpdated ||
        now()
      );


    providerCache = {

      history,

      currentIssue,

      lastUpdated,

      fetched:
        Number(
          stats.fetched ||
          history.length
        ),

      fetchedAt:
        now(),

      error:
        null

    };


    return providerCache;

  } catch (error) {

    providerCache.error =
      error.message ||
      "Provider fetch failed";

    return providerCache;

  }

}


/* =========================================================
   HISTORY NORMALIZER
   ========================================================= */

function normalizeHistoryRow(row) {

  if (!row) {
    return null;
  }


  const issue =
    row.issueNumber ??
    row.issue_number ??
    row.period ??
    row.issue;


  if (
    issue === undefined ||
    issue === null
  ) {
    return null;
  }


  const issueNumber =
    String(issue).trim();


  if (!issueNumber) {
    return null;
  }


  let number = null;

  if (
    row.number !== undefined &&
    row.number !== null &&
    row.number !== ""
  ) {

    const n =
      Number(row.number);

    if (
      Number.isInteger(n) &&
      n >= 0 &&
      n <= 9
    ) {
      number = n;
    }

  }


  let result =
    normalizeSide(
      row.result ||
      row.bigSmall ||
      row.big_small ||
      row.size ||
      row.colour ||
      row.color
    );


  /*
    If provider gives only number,
    derive BIG/SMALL:
    0-4 SMALL
    5-9 BIG
  */

  if (
    !result &&
    number !== null
  ) {

    result =
      number >= 5
        ? "BIG"
        : "SMALL";

  }


  return {

    issueNumber,

    number,

    result,

    colour:
      row.colour ||
      row.color ||
      "",

    premium:
      row.premium ??
      null,

    sum:
      row.sum ??
      null

  };

}


function normalizeSide(value) {

  if (
    value === undefined ||
    value === null
  ) {
    return "";
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


  return "";

}


function compareIssue(a, b) {

  const aa =
    String(a);

  const bb =
    String(b);


  if (
    /^\d+$/.test(aa) &&
    /^\d+$/.test(bb)
  ) {

    const A =
      BigInt(aa);

    const B =
      BigInt(bb);

    if (A > B) return 1;
    if (A < B) return -1;

    return 0;

  }


  return aa.localeCompare(bb);

}


/* =========================================================
   TARGET RESOLVER
   ========================================================= */

function resolveTarget(history, currentIssue) {

  if (!Array.isArray(history) ||
      history.length === 0) {

    if (currentIssue) {
      return String(currentIssue);
    }

    return "";

  }


  const latestSettled =
    history.find(
      row =>
        row &&
        row.result
    );


  const latestIssue =
    latestSettled
      ? String(
          latestSettled.issueNumber
        )
      : String(
          history[0].issueNumber
        );


  const current =
    currentIssue
      ? String(currentIssue)
      : "";


  /*
    If provider's current issue is ahead
    of latest settled, current is target.
  */

  if (
    current &&
    compareIssue(
      current,
      latestIssue
    ) > 0
  ) {

    return current;

  }


  /*
    Otherwise next issue after latest
    settled is target.
  */

  return incrementIssue(
    latestIssue
  );

}


/* =========================================================
   V4 MODEL HELPERS
   ========================================================= */

function sideArray(history) {

  return history
    .map(row => row.result)
    .filter(
      x =>
        x === "BIG" ||
        x === "SMALL"
    );

}


function balanceScore(arr, count) {

  const values =
    arr.slice(0, count);


  if (!values.length) {
    return 0;
  }


  let big = 0;
  let small = 0;


  values.forEach(
    side => {

      if (side === "BIG") {
        big++;
      } else {
        small++;
      }

    }
  );


  return (
    (big - small) /
    values.length
  );

}


function weightedMomentum(arr, count) {

  const values =
    arr.slice(0, count);


  if (!values.length) {
    return 0;
  }


  let total = 0;
  let weightTotal = 0;


  for (
    let i = 0;
    i < values.length;
    i++
  ) {

    const weight =
      values.length - i;

    const value =
      values[i] === "BIG"
        ? 1
        : -1;


    total +=
      value * weight;

    weightTotal +=
      weight;

  }


  return (
    total /
    weightTotal
  );

}


function transitionScore(arr, count) {

  const values =
    arr.slice(0, count + 1);


  if (values.length < 2) {
    return 0;
  }


  let follow = 0;
  let reverse = 0;


  for (
    let i = 0;
    i < values.length - 1;
    i++
  ) {

    if (
      values[i] ===
      values[i + 1]
    ) {

      follow++;

    } else {

      reverse++;

    }

  }


  const total =
    follow + reverse;


  if (!total) {
    return 0;
  }


  /*
    Positive = continuation pressure
    Negative = reversal pressure
  */

  return (
    (follow - reverse) /
    total
  );

}


function streakInfo(arr) {

  if (!arr.length) {

    return {
      side: "",
      length: 0
    };

  }


  const side =
    arr[0];

  let length = 0;


  for (
    const value of arr
  ) {

    if (value !== side) {
      break;
    }

    length++;

  }


  return {
    side,
    length
  };

}


function alternationScore(arr, count) {

  const values =
    arr.slice(0, count);


  if (values.length < 2) {
    return 0;
  }


  let alternating = 0;


  for (
    let i = 0;
    i < values.length - 1;
    i++
  ) {

    if (
      values[i] !==
      values[i + 1]
    ) {
      alternating++;
    }

  }


  return (
    alternating /
    (values.length - 1)
  );

}


function patternScore(arr) {

  if (arr.length < 5) {
    return 0;
  }


  const key =
    arr
      .slice(0, 4)
      .map(
        x =>
          x === "BIG"
            ? "B"
            : "S"
      )
      .join("");


  let matches = 0;
  let nextBig = 0;
  let nextSmall = 0;


  for (
    let i = 4;
    i < arr.length;
    i++
  ) {

    const previous =
      arr
        .slice(i - 4, i)
        .map(
          x =>
            x === "BIG"
              ? "B"
              : "S"
        )
        .join("");


    if (
      previous !== key
    ) {
      continue;
    }


    matches++;


    if (
      arr[i] === "BIG"
    ) {

      nextBig++;

    } else {

      nextSmall++;

    }

  }


  if (!matches) {
    return 0;
  }


  return (
    (nextBig - nextSmall) /
    matches
  );

}


function classifyRegime(
  arr,
  features
) {

  if (arr.length < 3) {
    return "MIXED";
  }


  if (
    features.alternation >= 0.72
  ) {
    return "ALTERNATING";
  }


  if (
    features.streakLength >= 4
  ) {
    return "STREAK_BREAK";
  }


  if (
    Math.abs(
      features.recent -
      features.medium
    ) > 0.45
  ) {
    return "CONFLICT";
  }


  if (
    Math.abs(
      features.transition
    ) < 0.10
  ) {
    return "TRANSITION";
  }


  if (
    Math.abs(features.medium) >= 0.35 &&
    Math.abs(features.recent) >= 0.30
  ) {
    return "TREND";
  }


  if (
    Math.abs(features.recent) >= 0.45
  ) {
    return "SHORT_SHIFT";
  }


  return "MIXED";

}


/* =========================================================
   V4 PREDICTION
   ========================================================= */

function calculatePrediction(history) {

  const arr =
    sideArray(history);


  if (!arr.length) {

    return {

      prediction: "BIG",

      confidence: 45,

      regime: "MIXED",

      reason:
        "Waiting for settled BIG/SMALL history."

    };

  }


  const recent =
    weightedMomentum(
      arr,
      7
    );


  const medium =
    balanceScore(
      arr,
      20
    );


  const micro =
    balanceScore(
      arr,
      4
    );


  const transition =
    transitionScore(
      arr,
      25
    );


  const alternation =
    alternationScore(
      arr,
      10
    );


  const pattern =
    patternScore(
      arr
    );


  const streak =
    streakInfo(
      arr
    );


  const streakLength =
    streak.length;


  /*
    Reversal signal:
    Long streak gets a controlled
    counter-pressure, not blind reversal.
  */

  let streakBreak = 0;


  if (
    streakLength >= 3
  ) {

    streakBreak =
      streak.side === "BIG"
        ? -Math.min(
            1,
            (streakLength - 2) /
            4
          )
        : Math.min(
            1,
            (streakLength - 2) /
            4
          );

  }


  let reversalSignal = 0;


  if (
    arr.length >= 2 &&
    arr[0] !== arr[1]
  ) {

    reversalSignal =
      arr[0] === "BIG"
        ? -0.15
        : 0.15;

  }


  const longBalance =
    balanceScore(
      arr,
      60
    );


  const features = {

    recent,

    medium,

    micro,

    transition,

    alternation,

    pattern,

    streakBreak,

    reversalSignal,

    long: longBalance,

    streakLength

  };


  const regime =
    classifyRegime(
      arr,
      features
    );


  /*
    Base weighted score.
    Positive = BIG
    Negative = SMALL
  */

  let score = 0;


  score +=
    recent * 0.27;

  score +=
    micro * 0.12;

  score +=
    medium * 0.12;

  score +=
    transition * 0.14;

  score +=
    streakBreak * 0.12;

  score +=
    (
      alternation > 0.5
        ? -recent
        : recent
    ) * 0.10;

  score +=
    pattern * 0.05;

  score +=
    reversalSignal * 0.05;

  score +=
    longBalance * 0.03;


  /*
    Alternating regime:
    Do not simply follow the last result.
  */

  if (
    regime === "ALTERNATING"
  ) {

    const opposite =
      arr[0] === "BIG"
        ? -1
        : 1;

    score +=
      opposite * 0.12;

  }


  /*
    Long streak:
    increase reversal pressure
    but keep it controlled.
  */

  if (
    regime === "STREAK_BREAK"
  ) {

    score +=
      streakBreak * 0.10;

  }


  /*
    If short and medium disagree,
    reduce confidence rather than
    blindly forcing the short trend.
  */

  if (
    regime === "CONFLICT"
  ) {

    score *= 0.68;

  }


  /*
    Agreement boost.
  */

  const signs = [

    Math.sign(recent),

    Math.sign(micro),

    Math.sign(medium),

    Math.sign(transition)

  ].filter(
    x => x !== 0
  );


  let agreement = 0;


  if (signs.length) {

    const positive =
      signs.filter(
        x => x > 0
      ).length;

    const negative =
      signs.filter(
        x => x < 0
      ).length;

    agreement =
      Math.max(
        positive,
        negative
      ) / signs.length;

  }


  if (
    agreement >= 0.75
  ) {

    score *= 1.08;

  }


  /*
    Keep score bounded.
  */

  score =
    Math.max(
      -1,
      Math.min(
        1,
        score
      )
    );


  const prediction =
    score >= 0
      ? "BIG"
      : "SMALL";


  /*
    Confidence is a model-strength
    score, NOT a win probability.
  */

  let confidence =
    45 +
    Math.round(
      Math.abs(score) * 30
    );


  confidence +=
    Math.round(
      Math.max(
        0,
        agreement - 0.5
      ) * 15
    );


  if (
    regime === "CONFLICT"
  ) {

    confidence -= 8;

  }


  if (
    regime === "MIXED"
  ) {

    confidence -= 2;

  }


  confidence =
    Math.max(
      45,
      Math.min(
        88,
        confidence
      )
    );


  let reason = "";


  if (
    regime === "ALTERNATING"
  ) {

    reason =
      "Recent sequence shows alternating pressure; V4 is avoiding blind trend-following.";

  } else if (
    regime === "STREAK_BREAK"
  ) {

    reason =
      "Extended streak detected; V4 is applying controlled trend-break pressure.";

  } else if (
    regime === "CONFLICT"
  ) {

    reason =
      "Short and medium signals conflict; V4 is reducing signal strength.";

  } else if (
    regime === "TREND"
  ) {

    reason =
      "Recent and medium windows show aligned directional pressure.";

  } else if (
    regime === "TRANSITION"
  ) {

    reason =
      "Transition behaviour detected; recent and reversal signals are being balanced.";

  } else {

    reason =
      "V4 is combining recent momentum, transitions, streak behaviour and historical patterns.";

  }


  return {

    prediction,

    confidence,

    regime,

    reason,

    score,

    model_version:
      MODEL_VERSION

  };

}


/* =========================================================
   CREATE / GET PREDICTION
   ========================================================= */

async function getOrCreatePrediction(
  targetIssue,
  history
) {

  if (!targetIssue) {
    return null;
  }


  const existing =
    await findPrediction(
      targetIssue
    );


  if (existing) {

    return existing;

  }


  const model =
    calculatePrediction(
      history
    );


  if (pool) {

    try {

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
          ON CONFLICT
          (model_version,target_issue)
          DO NOTHING
          RETURNING *
          `,
          [
            targetIssue,
            model.prediction,
            model.confidence,
            MODEL_VERSION,
            now()
          ]
        );


      if (
        result.rows.length
      ) {

        return result.rows[0];

      }


      const again =
        await findPrediction(
          targetIssue
        );


      if (again) {
        return again;
      }

    } catch (error) {

      console.error(
        "Prediction insert error:",
        error.message
      );

    }

  }


  return {

    target_issue:
      targetIssue,

    prediction:
      model.prediction,

    confidence:
      model.confidence,

    model_version:
      MODEL_VERSION,

    created_at:
      now(),

    actual_result:
      null,

    settled_at:
      null

  };

}


async function findPrediction(
  targetIssue
) {

  if (!pool) {
    return null;
  }


  try {

    const result =
      await pool.query(
        `
        SELECT *
        FROM prediction_records
        WHERE target_issue = $1
          AND model_version = $2
        ORDER BY id DESC
        LIMIT 1
        `,
        [
          targetIssue,
          MODEL_VERSION
        ]
      );


    return (
      result.rows[0] ||
      null
    );

  } catch {

    return null;

  }

}


/* =========================================================
   SETTLEMENT
   ========================================================= */

async function settlePredictions(
  history
) {

  if (!pool ||
      !Array.isArray(history) ||
      !history.length) {

    return;

  }


  const map =
    new Map();


  for (
    const row of history
  ) {

    if (
      row &&
      row.issueNumber &&
      (
        row.result === "BIG" ||
        row.result === "SMALL"
      )
    ) {

      map.set(
        String(row.issueNumber),
        row
      );

    }

  }


  if (!map.size) {
    return;
  }


  try {

    const pending =
      await pool.query(
        `
        SELECT *
        FROM prediction_records
        WHERE model_version = $1
          AND actual_result IS NULL
        ORDER BY id DESC
        LIMIT 200
        `,
        [MODEL_VERSION]
      );


    for (
      const prediction
      of pending.rows
    ) {

      const issue =
        String(
          prediction.target_issue
        );


      const actual =
        map.get(issue);


      /*
        Exact issue match ONLY.
      */

      if (!actual) {
        continue;
      }


      const actualResult =
        actual.result;


      if (
        actualResult !== "BIG" &&
        actualResult !== "SMALL"
      ) {
        continue;
      }


      await pool.query(
        `
        UPDATE prediction_records
        SET
          actual_number = $1,
          actual_result = $2,
          settled_at = $3
        WHERE id = $4
          AND actual_result IS NULL
        `,
        [
          actual.number,
          actualResult,
          now(),
          prediction.id
        ]
      );

    }

  } catch (error) {

    console.error(
      "Settlement error:",
      error.message
    );

  }

}


/* =========================================================
   LAST 30 PREDICTIONS
   ========================================================= */

async function last30Predictions(
  history
) {

  if (!pool) {
    return [];
  }


  try {

    const result =
      await pool.query(
        `
        SELECT *
        FROM prediction_records
        WHERE model_version = $1
        ORDER BY id DESC
        LIMIT 30
        `,
        [MODEL_VERSION]
      );


    const actualMap =
      new Map();


    for (
      const row of history
    ) {

      if (
        row &&
        row.issueNumber &&
        (
          row.result === "BIG" ||
          row.result === "SMALL"
        )
      ) {

        actualMap.set(
          String(row.issueNumber),
          row
        );

      }

    }


    return result.rows.map(
      row => {

        const issue =
          String(
            row.target_issue
          );


        const actual =
          actualMap.get(
            issue
          );


        let status =
          "PENDING";


        let actualResult =
          null;


        if (actual) {

          actualResult =
            actual.result;


          if (
            actualResult ===
              "BIG" ||
            actualResult ===
              "SMALL"
          ) {

            status =
              row.prediction ===
              actualResult
                ? "WIN"
                : "LOSS";

          }

        } else if (
          row.actual_result ===
            "BIG" ||
          row.actual_result ===
            "SMALL"
        ) {

          /*
            Stored settlement is only
            used if provider history
            currently does not contain
            the row.
          */

          actualResult =
            row.actual_result;


          status =
            row.prediction ===
            actualResult
              ? "WIN"
              : "LOSS";

        }


        return {

          id:
            row.id,

          target_issue:
            issue,

          prediction:
            row.prediction,

          confidence:
            row.confidence,

          model_version:
            row.model_version,

          actual_number:
            actual
              ? actual.number
              : row.actual_number,

          actual_result:
            actualResult,

          status,

          created_at:
            row.created_at,

          settled_at:
            row.settled_at

        };

      }
    );

  } catch (error) {

    console.error(
      "Last30 error:",
      error.message
    );

    return [];

  }

}


/* =========================================================
   STATS
   ========================================================= */

async function predictionStats() {

  if (!pool) {

    return {
      wins: 0,
      losses: 0,
      pending: 0,
      total: 0,
      winRate: 0
    };

  }


  try {

    const result =
      await pool.query(
        `
        SELECT
          COUNT(*) FILTER
            (WHERE actual_result IS NOT NULL)
            AS settled,

          COUNT(*) FILTER
            (WHERE actual_result =
              prediction)
            AS wins,

          COUNT(*) FILTER
            (WHERE actual_result IS NOT NULL
              AND actual_result <>
              prediction)
            AS losses,

          COUNT(*) FILTER
            (WHERE actual_result IS NULL)
            AS pending

        FROM prediction_records
        WHERE model_version = $1
        `,
        [MODEL_VERSION]
      );


    const row =
      result.rows[0] || {};


    const wins =
      Number(row.wins || 0);

    const losses =
      Number(row.losses || 0);

    const pending =
      Number(row.pending || 0);

    const total =
      wins + losses;


    const winRate =
      total > 0
        ? Math.round(
            wins /
            total *
            100
          )
        : 0;


    return {

      wins,

      losses,

      pending,

      total,

      winRate

    };

  } catch {

    return {

      wins: 0,

      losses: 0,

      pending: 0,

      total: 0,

      winRate: 0

    };

  }

}


/* =========================================================
   STATE
   ========================================================= */

async function buildState() {

  const provider =
    await fetchWingoHistory();


  const history =
    provider.history || [];


  await settlePredictions(
    history
  );


  const target =
    resolveTarget(
      history,
      provider.currentIssue
    );


  const predictionRecord =
    await getOrCreatePrediction(
      target,
      history
    );


  const model =
    calculatePrediction(
      history
    );


  const predictions =
    await last30Predictions(
      history
    );


  const stats =
    await predictionStats();


  const prediction =
    predictionRecord
      ? {

          target_issue:
            predictionRecord.target_issue,

          prediction:
            predictionRecord.prediction,

          confidence:
            Number(
              predictionRecord.confidence ||
              model.confidence
            ),

          regime:
            model.regime,

          reason:
            model.reason,

          model_version:
            predictionRecord.model_version ||
            MODEL_VERSION,

          actual_result:
            predictionRecord.actual_result ||
            null

        }
      : {

          target_issue:
            target,

          prediction:
            model.prediction,

          confidence:
            model.confidence,

          regime:
            model.regime,

          reason:
            model.reason,

          model_version:
            MODEL_VERSION,

          actual_result:
            null

        };


  return {

    ok: true,

    model_version:
      MODEL_VERSION,

    game_url:
      GAME_URL,

    currentIssue:
      provider.currentIssue,

    current_issue:
      provider.currentIssue,

    targetIssue:
      target,

    target_issue:
      target,

    providerLastUpdated:
      provider.lastUpdated || 0,

    provider_last_updated:
      provider.lastUpdated || 0,

    history,

    prediction,

    predictions,

    stats,

    wins:
      stats.wins,

    losses:
      stats.losses,

    winRate:
      stats.winRate,

    provider: {

      fetched:
        provider.fetched,

      last_updated:
        provider.lastUpdated,

      fetched_at:
        provider.fetchedAt,

      error:
        provider.error

    }

  };

}


/* =========================================================
   ACCESS KEY CHECK
   ========================================================= */

async function checkAccess(
  req,
  body = {}
) {

  if (!pool) {

    return {

      ok: false,

      error:
        "Database is not configured."

    };

  }


  const key =
    accessKeyFromRequest(
      req,
      body
    );


  const device =
    deviceFromRequest(
      req,
      body
    );


  if (!key) {

    return {

      ok: false,

      error:
        "Access key required."

    };

  }


  if (!device) {

    return {

      ok: false,

      error:
        "Device ID required."

    };

  }


  try {

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
      result.rows.length === 0
    ) {

      return {

        ok: false,

        error:
          "Invalid access key."

      };

    }


    const row =
      result.rows[0];


    /*
      One key = one browser device.
    */

    if (
      row.device_id &&
      row.device_id !== device
    ) {

      return {

        ok: false,

        error:
          "This key is already bound to another device."

      };

    }


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
        row.id
      ]
    );


    return {

      ok: true,

      valid: true,

      success: true,

      key: row.access_key,

      device_bound:
        Boolean(row.device_id),

      last_seen:
        now()

    };

  } catch (error) {

    return {

      ok: false,

      error:
        error.message

    };

  }

}


/* =========================================================
   ADMIN STATUS
   ========================================================= */

async function adminStatus() {

  let database =
    "NOT CONFIGURED";


  if (pool) {

    try {

      await pool.query(
        "SELECT 1"
      );

      database =
        "CONNECTED";

    } catch {

      database =
        "ERROR";

    }

  }


  const provider =
    await fetchWingoHistory();


  return {

    ok: true,

    status: "ok",

    server:
      "ONLINE",

    database,

    db:
      database,

    wingobot:
      provider.error
        ? "ERROR"
        : "CONNECTED",

    wingo:
      provider.error
        ? "ERROR"
        : "CONNECTED",

    model:
      MODEL_VERSION,

    model_version:
      MODEL_VERSION,

    number_model:
      "DISABLED",

    output:
      "BIG / SMALL",

    settlement:
      "EXACT ISSUE",

    game_url:
      GAME_URL,

    provider_error:
      provider.error

  };

}


/* =========================================================
   ADMIN KEYS
   ========================================================= */

async function listKeys() {

  if (!pool) {
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


function generateAccessKey() {

  const random =
    crypto
      .randomBytes(8)
      .toString("hex")
      .toUpperCase();


  return `DY-${random}`;

}


/* =========================================================
   STATIC FILES
   ========================================================= */

function contentType(file) {

  const ext =
    path.extname(file)
      .toLowerCase();


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
      "image/x-icon"

  };


  return (
    types[ext] ||
    "application/octet-stream"
  );

}


function serveFile(
  req,
  res,
  file
) {

  const full =
    path.join(
      ROOT,
      file
    );


  if (!fs.existsSync(full)) {

    text(
      res,
      404,
      "File not found"
    );

    return;

  }


  const stat =
    fs.statSync(full);


  const type =
    contentType(full);


  /*
    MP3 range support
  */

  if (
    type === "audio/mpeg"
  ) {

    const range =
      req.headers.range;


    if (!range) {

      res.writeHead(
        200,
        {
          "Content-Type":
            type,

          "Content-Length":
            stat.size,

          "Accept-Ranges":
            "bytes"
        }
      );


      fs.createReadStream(
        full
      ).pipe(res);


      return;

    }


    const match =
      /bytes=(\d*)-(\d*)/
        .exec(range);


    if (!match) {

      res.writeHead(
        416
      );

      res.end();

      return;

    }


    let start =
      match[1]
        ? Number(match[1])
        : 0;


    let end =
      match[2]
        ? Number(match[2])
        : stat.size - 1;


    if (
      start < 0 ||
      end >= stat.size ||
      start > end
    ) {

      res.writeHead(
        416,
        {
          "Content-Range":
            `bytes */${stat.size}`
        }
      );

      res.end();

      return;

    }


    const chunkSize =
      end - start + 1;


    res.writeHead(
      206,
      {

        "Content-Type":
          type,

        "Content-Length":
          chunkSize,

        "Content-Range":
          `bytes ${start}-${end}/${stat.size}`,

        "Accept-Ranges":
          "bytes"

      }
    );


    fs.createReadStream(
      full,
      {
        start,
        end
      }
    ).pipe(res);


    return;

  }


  res.writeHead(
    200,
    {
      "Content-Type":
        type,

      "Content-Length":
        stat.size,

      "Cache-Control":
        "no-cache"
    }
  );


  fs.createReadStream(
    full
  ).pipe(res);

}


/* =========================================================
   HTTP SERVER
   ========================================================= */

const server =
  http.createServer(
    async (req, res) => {

      try {

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
                "Content-Type, x-access-key, x-device-id, x-admin-key",

              "Access-Control-Allow-Methods":
                "GET,POST,DELETE,OPTIONS"
            }
          );

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


        /* =================================================
           HEALTH
           ================================================= */

        if (
          pathname ===
          "/health"
        ) {

          json(
            res,
            200,
            {
              ok: true,
              status: "healthy",
              model:
                MODEL_VERSION,
              time:
                now()
            }
          );

          return;

        }


        /* =================================================
           ROOT
           ================================================= */

        if (
          pathname ===
            "/" ||
          pathname ===
            "/prediction"
        ) {

          serveFile(
            req,
            res,
            "prediction.html"
          );

          return;

        }


        /* =================================================
           ADMIN HTML
           ================================================= */

        if (
          pathname ===
          "/admin.html"
        ) {

          serveFile(
            req,
            res,
            "admin.html"
          );

          return;

        }


        /* =================================================
           ACCESS KEY CHECK
           ================================================= */

        if (
          pathname ===
          "/api/key/check" &&
          req.method === "POST"
        ) {

          const body =
            await parseBody(req);


          const result =
            await checkAccess(
              req,
              body
            );


          json(
            res,
            result.ok
              ? 200
              : 403,
            result
          );

          return;

        }


        /* =================================================
           STATE
           ================================================= */

        if (
          pathname ===
          "/api/state" &&
          req.method === "GET"
        ) {

          const key =
            accessKeyFromRequest(
              req
            );

          const device =
            deviceFromRequest(
              req
            );


          if (!pool) {

            json(
              res,
              503,
              {
                ok: false,
                error:
                  "Database is not configured."
              }
            );

            return;

          }


          if (!key || !device) {

            json(
              res,
              401,
              {
                ok: false,
                error:
                  "Access key and device ID required."
              }
            );

            return;

          }


          const access =
            await checkAccess(
              req
            );


          if (!access.ok) {

            json(
              res,
              403,
              access
            );

            return;

          }


          const state =
            await buildState();


          json(
            res,
            200,
            state
          );

          return;

        }


        /* =================================================
           HISTORY
           ================================================= */

        if (
          pathname ===
          "/api/history" &&
          req.method === "GET"
        ) {

          const key =
            accessKeyFromRequest(
              req
            );

          const device =
            deviceFromRequest(
              req
            );


          if (!key || !device) {

            json(
              res,
              401,
              {
                ok: false,
                error:
                  "Access key and device ID required."
              }
            );

            return;

          }


          const access =
            await checkAccess(
              req
            );


          if (!access.ok) {

            json(
              res,
              403,
              access
            );

            return;

          }


          const provider =
            await fetchWingoHistory();


          await settlePredictions(
            provider.history
          );


          const predictions =
            await last30Predictions(
              provider.history
            );


          const stats =
            await predictionStats();


          json(
            res,
            200,
            {

              ok: true,

              predictions,

              history:
                predictions,

              stats,

              model_version:
                MODEL_VERSION

            }
          );

          return;

        }


        /* =================================================
           ADMIN AUTH
           ================================================= */

        if (
          pathname.startsWith(
            "/api/admin/"
          )
        ) {

          if (
            !adminAuthorized(req)
          ) {

            json(
              res,
              401,
              {
                ok: false,
                error:
                  "Unauthorized admin request."
              }
            );

            return;

          }

        }


        /* =================================================
           ADMIN STATUS
           ================================================= */

        if (
          pathname ===
          "/api/admin/status" &&
          req.method === "GET"
        ) {

          const result =
            await adminStatus();


          json(
            res,
            200,
            result
          );

          return;

        }


        /* =================================================
           ADMIN PING
           ================================================= */

        if (
          pathname ===
          "/api/admin/ping" &&
          req.method === "GET"
        ) {

          json(
            res,
            200,
            {
              ok: true,
              message:
                "PONG",
              model:
                MODEL_VERSION,
              time:
                now()
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
          req.method === "GET"
        ) {

          const provider =
            await fetchWingoHistory(
              true
            );


          json(
            res,
            provider.error
              ? 502
              : 200,
            {

              ok:
                !provider.error,

              currentIssue:
                provider.currentIssue,

              historyCount:
                provider.history.length,

              fetched:
                provider.fetched,

              lastUpdated:
                provider.lastUpdated,

              error:
                provider.error

            }
          );

          return;

        }


        /* =================================================
           ADMIN MODEL TEST
           ================================================= */

        if (
          pathname ===
          "/api/admin/model-test" &&
          req.method === "GET"
        ) {

          const provider =
            await fetchWingoHistory(
              true
            );


          const model =
            calculatePrediction(
              provider.history
            );


          json(
            res,
            200,
            {

              ok: true,

              model_version:
                MODEL_VERSION,

              prediction:
                model.prediction,

              confidence:
                model.confidence,

              regime:
                model.regime,

              reason:
                model.reason,

              history_used:
                provider.history.length,

              number_model:
                "DISABLED"

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
          req.method === "GET"
        ) {

          const keys =
            await listKeys();


          json(
            res,
            200,
            {
              ok: true,
              keys
            }
          );

          return;

        }


        /* =================================================
           ADMIN KEYS CREATE
           ================================================= */

        if (
          pathname ===
          "/api/admin/keys" &&
          req.method === "POST"
        ) {

          if (!pool) {

            json(
              res,
              503,
              {
                ok: false,
                error:
                  "Database is not configured."
              }
            );

            return;

          }


          const body =
            await parseBody(req);


          let key =
            String(
              body.access_key ||
              body.key ||
              ""
            ).trim();


          if (!key) {
            key =
              generateAccessKey();
          }


          if (
            key.length < 4 ||
            key.length > 200
          ) {

            json(
              res,
              400,
              {
                ok: false,
                error:
                  "Invalid access key length."
              }
            );

            return;

          }


          try {

            const result =
              await pool.query(
                `
                INSERT INTO access_keys
                (
                  access_key,
                  created_at,
                  last_seen
                )
                VALUES ($1,$2,0)
                RETURNING *
                `,
                [
                  key,
                  now()
                ]
              );


            json(
              res,
              200,
              {
                ok: true,
                key:
                  result.rows[0]
              }
            );

          } catch (error) {

            if (
              error.code ===
              "23505"
            ) {

              json(
                res,
                409,
                {
                  ok: false,
                  error:
                    "This access key already exists."
                }
              );

            } else {

              json(
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

          return;

        }


        /* =================================================
           ADMIN KEYS DELETE
           ================================================= */

        if (
          pathname ===
          "/api/admin/keys" &&
          req.method === "DELETE"
        ) {

          if (!pool) {

            json(
              res,
              503,
              {
                ok: false,
                error:
                  "Database is not configured."
              }
            );

            return;

          }


          const body =
            await parseBody(req);


          const id =
            body.id ||
            url.searchParams.get(
              "id"
            );


          const key =
            body.access_key ||
            body.key ||
            url.searchParams.get(
              "access_key"
            );


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

          } else if (key) {

            result =
              await pool.query(
                `
                DELETE FROM access_keys
                WHERE access_key = $1
                RETURNING id, access_key
                `,
                [key]
              );

          } else {

            json(
              res,
              400,
              {
                ok: false,
                error:
                  "Key or ID required."
              }
            );

            return;

          }


          if (
            result.rows.length === 0
          ) {

            json(
              res,
              404,
              {
                ok: false,
                error:
                  "Key not found."
              }
            );

            return;

          }


          json(
            res,
            200,
            {
              ok: true,
              deleted:
                result.rows[0]
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
          req.method === "POST"
        ) {

          if (!pool) {

            json(
              res,
              503,
              {
                ok: false,
                error:
                  "Database is not configured."
              }
            );

            return;

          }


          const body =
            await parseBody(req);


          const key =
            String(
              body.access_key ||
              body.key ||
              ""
            ).trim();


          if (!key) {

            json(
              res,
              400,
              {
                ok: false,
                error:
                  "Access key required."
              }
            );

            return;

          }


          const result =
            await pool.query(
              `
              UPDATE access_keys
              SET device_id = NULL
              WHERE access_key = $1
              RETURNING id, access_key
              `,
              [key]
            );


          if (
            result.rows.length === 0
          ) {

            json(
              res,
              404,
              {
                ok: false,
                error:
                  "Access key not found."
              }
            );

            return;

          }


          json(
            res,
            200,
            {
              ok: true,
              reset:
                result.rows[0]
            }
          );

          return;

        }


        /* =================================================
           STATIC MUSIC
           ================================================= */

        if (
          pathname ===
          "/music.mp3"
        ) {

          serveFile(
            req,
            res,
            "music.mp3"
          );

          return;

        }


        /* =================================================
           OTHER STATIC FILES
           ================================================= */

        const allowed =
          [
            "favicon.ico",
            "robots.txt"
          ];


        const filename =
          path.basename(
            pathname
          );


        if (
          allowed.includes(
            filename
          )
        ) {

          serveFile(
            req,
            res,
            filename
          );

          return;

        }


        /* =================================================
           404
           ================================================= */

        json(
          res,
          404,
          {
            ok: false,
            error:
              "Not found"
          }
        );

      } catch (error) {

        console.error(
          "SERVER ERROR:",
          error
        );


        if (!res.headersSent) {

          json(
            res,
            500,
            {
              ok: false,
              error:
                "Internal server error",
              message:
                error.message
            }
          );

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

  try {

    await initDatabase();

    console.log(
      "Database initialization complete."
    );

  } catch (error) {

    console.error(
      "Database initialization failed:",
      error.message
    );

  }


  server.listen(
    PORT,
    "0.0.0.0",
    () => {

      console.log(
        `DY AI Wingo V4 server running on port ${PORT}`
      );

      console.log(
        `Model: ${MODEL_VERSION}`
      );

      console.log(
        `Game: ${GAME_URL}`
      );

    }
  );

}


start();


/* =========================================================
   BACKGROUND PROVIDER REFRESH
   ========================================================= */

setInterval(
  async () => {

    try {

      const provider =
        await fetchWingoHistory(
          true
        );


      if (
        provider.history.length
      ) {

        await settlePredictions(
          provider.history
        );

      }

    } catch (error) {

      console.error(
        "Background refresh:",
        error.message
      );

    }

  },
  3000
);


/* =========================================================
   SAFE SHUTDOWN
   ========================================================= */

async function shutdown() {

  console.log(
    "Shutting down..."
  );


  try {

    if (pool) {
      await pool.end();
    }

  } catch {}


  server.close(
    () => {
      process.exit(0);
    }
  );


  setTimeout(
    () => process.exit(0),
    5000
  );

}


process.on(
  "SIGTERM",
  shutdown
);

process.on(
  "SIGINT",
  shutdown
);
