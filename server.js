"use strict";

/*
===========================================================
 DY AI WINGO 30S
 HISTORY-BASED PREDICTION SERVER
===========================================================

 REQUIRED ENVIRONMENT VARIABLES ON RENDER:

 DATABASE_URL=your_postgres_url

 ADMIN_KEY=your_admin_key

 WINGOBOT_TOKEN=your_wingobot_token

 PORT=10000

===========================================================
*/

const http = require("http");
const url = require("url");
const crypto = require("crypto");
const { Pool } = require("pg");


/* =========================================================
   CONFIG
========================================================= */

const PORT =
  Number(process.env.PORT || 10000);

const DATABASE_URL =
  process.env.DATABASE_URL;

const ADMIN_KEY =
  process.env.ADMIN_KEY || "";

const WINGOBOT_TOKEN =
  process.env.WINGOBOT_TOKEN || "";

const WINGOBOT_URL =
  "https://api.wingobot.com/v2/30-sec-game-history";


/*
  WingoBot polling.

  We don't create a new prediction every second.
  New prediction is created only when target period changes.
*/
const PROVIDER_POLL_MS = 3000;


/*
  The provider endpoint does not expose a guaranteed
  countdown field in the documented response.

  Therefore this is an ESTIMATED timer anchored to the
  moment a new target period is detected.
*/
const ROUND_SECONDS = 30;


/*
  Keep enough source history for calculations.

  IMPORTANT:
  This is NOT sent to the provider as a "limit=1000".
  We simply use however many valid rows the API returns.
*/
const MAX_ANALYSIS_ROWS = 500;


/* =========================================================
   DATABASE
========================================================= */

if (!DATABASE_URL) {
  console.error(
    "ERROR: DATABASE_URL is missing."
  );
}

const pool =
  new Pool({
    connectionString: DATABASE_URL,

    ssl:
      process.env.NODE_ENV === "production"
        ? {
            rejectUnauthorized: false
          }
        : false
  });


/* =========================================================
   SERVER STATE
========================================================= */

let liveState = {
  ready: false,

  providerOnline: false,

  latestSettledIssue: null,

  targetIssue: null,

  currentIssue: null,

  prediction: null,

  number: null,

  confidence: 0,

  status: "WAITING FOR DATA",

  analysis: {
    patternScore: 0,
    modelAgreement: 0,
    backtestSamples: 0,
    avgModelAccuracy: null
  },

  predictionHistory: [],

  wins: 0,

  losses: 0,

  countdown: ROUND_SECONDS,

  countdownAnchor: Date.now(),

  updatedAt: 0,

  error: null
};


let providerHistory = [];

let providerCurrentIssue = null;

let lastTargetIssue = null;

let lastProviderFetch = 0;

let providerBusy = false;


/* =========================================================
   UTILITY
========================================================= */

function now() {
  return Date.now();
}


function safeString(value) {

  if (
    value === null ||
    value === undefined
  ) {
    return "";
  }

  return String(value).trim();
}


function clamp(
  value,
  min,
  max
) {

  return Math.max(
    min,
    Math.min(
      max,
      value
    )
  );
}


function roundNumber(
  value,
  digits = 2
) {

  const multiplier =
    Math.pow(
      10,
      digits
    );

  return (
    Math.round(
      Number(value || 0) *
      multiplier
    ) /
    multiplier
  );
}


function normalizeSide(value) {

  const v =
    safeString(value)
      .toUpperCase();


  if (
    v === "BIG" ||
    v === "B"
  ) {

    return "BIG";
  }


  if (
    v === "SMALL" ||
    v === "S"
  ) {

    return "SMALL";
  }


  return null;
}


function sideFromNumber(number) {

  const n =
    Number(number);


  if (
    !Number.isInteger(n) ||
    n < 0 ||
    n > 9
  ) {

    return null;
  }


  return n >= 5
    ? "BIG"
    : "SMALL";
}


function normalizeNumber(value) {

  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {

    return null;
  }


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


/* =========================================================
   ISSUE NUMBER
========================================================= */

/*
  Wingo issue numbers are strings.

  We only need a safe comparison/increment mechanism.
*/

function issueParts(issue) {

  const str =
    safeString(issue);


  if (!str) {
    return null;
  }


  const match =
    str.match(
      /^(.*?)(\d+)$/
    );


  if (!match) {

    return {
      prefix: str,
      number: null,
      raw: str
    };
  }


  return {
    prefix: match[1],
    number: match[2],
    raw: str
  };
}


function compareIssues(
  a,
  b
) {

  const aa =
    issueParts(a);

  const bb =
    issueParts(b);


  if (!aa || !bb) {
    return 0;
  }


  if (
    aa.number !== null &&
    bb.number !== null &&
    aa.prefix === bb.prefix
  ) {

    try {

      const na =
        BigInt(aa.number);

      const nb =
        BigInt(bb.number);


      if (na > nb) return 1;

      if (na < nb) return -1;

      return 0;

    } catch {

      return safeString(a)
        .localeCompare(
          safeString(b)
        );
    }
  }


  return safeString(a)
    .localeCompare(
      safeString(b)
    );
}


function incrementIssue(
  issue
) {

  const p =
    issueParts(issue);


  if (!p) {
    return null;
  }


  if (p.number === null) {

    return null;
  }


  try {

    const next =
      BigInt(p.number) +
      BigInt(1);


    return (
      p.prefix +
      next
        .toString()
        .padStart(
          p.number.length,
          "0"
        )
    );

  } catch {

    return null;
  }
}


/* =========================================================
   HTTP JSON
========================================================= */

function sendJson(
  res,
  statusCode,
  data
) {

  const body =
    JSON.stringify(
      data
    );


  res.writeHead(
    statusCode,
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
        "Content-Type, Authorization",

      "Access-Control-Allow-Methods":
        "GET,POST,DELETE,OPTIONS"
    }
  );


  res.end(body);
}


function sendText(
  res,
  statusCode,
  text,
  contentType =
    "text/plain; charset=utf-8"
) {

  res.writeHead(
    statusCode,
    {
      "Content-Type":
        contentType,

      "Cache-Control":
        "no-store"
    }
  );


  res.end(text);
}


/* =========================================================
   REQUEST BODY
========================================================= */

function readBody(req) {

  return new Promise(
    (
      resolve,
      reject
    ) => {

      let body = "";


      req.on(
        "data",
        chunk => {

          body +=
            chunk.toString();

          if (
            body.length >
            2 * 1024 * 1024
          ) {

            reject(
              new Error(
                "Request body too large."
              )
            );

            req.destroy();
          }
        }
      );


      req.on(
        "end",
        () => {

          if (!body) {

            resolve({});

            return;
          }


          try {

            resolve(
              JSON.parse(body)
            );

          } catch {

            reject(
              new Error(
                "Invalid JSON."
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


/* =========================================================
   ACCESS KEY
========================================================= */

async function checkAccessKey(
  accessKey,
  deviceId
) {

  if (!accessKey) {

    return {
      success: false,
      error: "INVALID_ACCESS_KEY"
    };
  }


  if (!deviceId) {

    return {
      success: false,
      error: "DEVICE_ID_REQUIRED"
    };
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
      WHERE access_key = $1
      LIMIT 1
      `,
      [accessKey]
    );


  if (
    result.rowCount === 0
  ) {

    return {
      success: false,
      error: "INVALID_ACCESS_KEY"
    };
  }


  const row =
    result.rows[0];


  /*
    First device binds the key.
  */

  if (
    row.device_id &&
    row.device_id !== deviceId
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
      device_id = COALESCE(device_id, $1),
      last_seen = $2
    WHERE id = $3
    `,
    [
      deviceId,
      now(),
      row.id
    ]
  );


  return {
    success: true,
    key: row.access_key
  };
}


/* =========================================================
   ADMIN AUTH
========================================================= */

function isAdmin(req) {

  const headerKey =
    req.headers[
      "x-admin-key"
    ];


  if (
    ADMIN_KEY &&
    headerKey &&
    headerKey === ADMIN_KEY
  ) {

    return true;
  }


  return false;
}


/* =========================================================
   DATABASE INIT
========================================================= */

async function initDatabase() {

  if (!DATABASE_URL) {
    return;
  }


  await pool.query(
    `
    CREATE TABLE IF NOT EXISTS access_keys (

      id SERIAL PRIMARY KEY,

      access_key TEXT UNIQUE NOT NULL,

      device_id TEXT,

      created_at BIGINT NOT NULL,

      last_seen BIGINT DEFAULT 0

    )
    `
  );


  await pool.query(
    `
    CREATE TABLE IF NOT EXISTS prediction_records (

      id SERIAL PRIMARY KEY,

      target_issue TEXT UNIQUE NOT NULL,

      prediction TEXT,

      predicted_number INTEGER,

      confidence NUMERIC DEFAULT 0,

      status TEXT DEFAULT 'SIGNAL READY',

      outcome TEXT DEFAULT 'PENDING',

      actual_number INTEGER,

      actual_side TEXT,

      analysis JSONB DEFAULT '{}'::jsonb,

      created_at BIGINT NOT NULL,

      settled_at BIGINT DEFAULT 0

    )
    `
  );


  /*
    Compatibility migration for older databases.
  */

  await pool.query(
    `
    ALTER TABLE prediction_records
    ADD COLUMN IF NOT EXISTS target_issue TEXT
    `
  );


  await pool.query(
    `
    ALTER TABLE prediction_records
    ADD COLUMN IF NOT EXISTS prediction TEXT
    `
  );


  await pool.query(
    `
    ALTER TABLE prediction_records
    ADD COLUMN IF NOT EXISTS predicted_number INTEGER
    `
  );


  await pool.query(
    `
    ALTER TABLE prediction_records
    ADD COLUMN IF NOT EXISTS confidence NUMERIC DEFAULT 0
    `
  );


  await pool.query(
    `
    ALTER TABLE prediction_records
    ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'SIGNAL READY'
    `
  );


  await pool.query(
    `
    ALTER TABLE prediction_records
    ADD COLUMN IF NOT EXISTS outcome TEXT DEFAULT 'PENDING'
    `
  );


  await pool.query(
    `
    ALTER TABLE prediction_records
    ADD COLUMN IF NOT EXISTS actual_number INTEGER
    `
  );


  await pool.query(
    `
    ALTER TABLE prediction_records
    ADD COLUMN IF NOT EXISTS actual_side TEXT
    `
  );


  await pool.query(
    `
    ALTER TABLE prediction_records
    ADD COLUMN IF NOT EXISTS analysis JSONB DEFAULT '{}'::jsonb
    `
  );


  await pool.query(
    `
    ALTER TABLE prediction_records
    ADD COLUMN IF NOT EXISTS created_at BIGINT DEFAULT 0
    `
  );


  await pool.query(
    `
    ALTER TABLE prediction_records
    ADD COLUMN IF NOT EXISTS settled_at BIGINT DEFAULT 0
    `
  );


  /*
    Remove duplicate target rows if an old database
    contains duplicates and the unique index is missing.
  */

  try {

    await pool.query(
      `
      CREATE UNIQUE INDEX IF NOT EXISTS
      prediction_records_target_issue_unique
      ON prediction_records(target_issue)
      `
    );

  } catch (error) {

    console.error(
      "Prediction unique index warning:",
      error.message
    );
  }


  /*
    Old pending rows can be kept if their period is still
    relevant. We do NOT blindly turn them into losses.
  */
}


/* =========================================================
   WINGOBOT FETCH
========================================================= */

async function fetchWingoHistory() {

  if (!WINGOBOT_TOKEN) {

    throw new Error(
      "WINGOBOT_TOKEN is missing."
    );
  }


  const controller =
    new AbortController();


  const timeout =
    setTimeout(
      () =>
        controller.abort(),
      8000
    );


  try {

    const response =
      await fetch(
        WINGOBOT_URL,
        {
          method: "GET",

          headers: {

            "Authorization":
              "Bearer " +
              WINGOBOT_TOKEN,

            "Accept":
              "application/json"
          },

          signal:
            controller.signal
        }
      );


    if (!response.ok) {

      const text =
        await response.text();


      throw new Error(
        `WingoBot HTTP ${response.status}: ${text.slice(0,200)}`
      );
    }


    return await response.json();

  } finally {

    clearTimeout(timeout);
  }
}


/* =========================================================
   NORMALIZE PROVIDER RESPONSE
========================================================= */

function normalizeProviderResponse(
  data
) {

  const current =
    data &&
    data.current
      ? data.current
      : {};


  const rawHistory =
    Array.isArray(
      data &&
      data.history
    )
      ? data.history
      : [];


  const rows =
    rawHistory
      .map(
        row => {

          const issue =
            safeString(
              row.issueNumber ??
              row.issue_number ??
              row.period
            );


          const number =
            normalizeNumber(
              row.number ??
              row.result ??
              row.winNumber
            );


          let side =
            normalizeSide(
              row.side ??
              row.resultSide ??
              row.bigSmall
            );


          if (
            !side &&
            number !== null
          ) {

            side =
              sideFromNumber(
                number
              );
          }


          return {

            issueNumber:
              issue,

            number,

            side,

            colour:
              safeString(
                row.colour ??
                row.color
              ),

            premium:
              row.premium ??
              null,

            sum:
              row.sum ??
              null
          };
        }
      )
      .filter(
        row =>
          row.issueNumber &&
          row.number !== null &&
          row.side
      );


  /*
    Sort newest first.
  */

  rows.sort(
    (
      a,
      b
    ) =>
      compareIssues(
        b.issueNumber,
        a.issueNumber
      )
  );


  /*
    Remove duplicate periods.
  */

  const seen =
    new Set();

  const unique = [];


  for (
    const row of rows
  ) {

    if (
      seen.has(
        row.issueNumber
      )
    ) {

      continue;
    }


    seen.add(
      row.issueNumber
    );


    unique.push(
      row
    );
  }


  return {

    currentIssue:
      safeString(
        current.issueNumber ??
        current.issue_number ??
        current.period
      ) || null,

    history:
      unique.slice(
        0,
        MAX_ANALYSIS_ROWS
      ),

    stats:
      data.stats || {}
  };
}


/* =========================================================
   TARGET ISSUE RESOLVER
========================================================= */

function resolveTargetIssue(
  currentIssue,
  history
) {

  const latest =
    history &&
    history.length
      ? history[0].issueNumber
      : null;


  if (!latest) {

    return {
      latestSettledIssue: null,
      targetIssue:
        currentIssue || null
    };
  }


  /*
    IMPORTANT:

    The latest settled history row is the reference.

    If provider current is ahead of settled history,
    that current issue is the target.

    Otherwise move one period forward from latest settled.
  */

  if (
    currentIssue &&
    compareIssues(
      currentIssue,
      latest
    ) > 0
  ) {

    return {
      latestSettledIssue:
        latest,

      targetIssue:
        currentIssue
    };
  }


  const next =
    incrementIssue(
      latest
    );


  return {
    latestSettledIssue:
      latest,

    targetIssue:
      next ||
      currentIssue ||
      latest
  };
}


/* =========================================================
   ANALYSIS HELPERS
========================================================= */

function recentRows(
  history,
  count
) {

  return history
    .filter(
      row =>
        row &&
        row.number !== null &&
        row.side
    )
    .slice(
      0,
      count
    );
}


function countSides(
  rows
) {

  let big = 0;

  let small = 0;


  for (
    const row of rows
  ) {

    if (
      row.side === "BIG"
    ) {

      big++;

    } else if (
      row.side === "SMALL"
    ) {

      small++;
    }
  }


  return {
    big,
    small
  };
}


/* =========================================================
   TREND SCORE
========================================================= */

function calculateTrendScore(
  history
) {

  const rows =
    recentRows(
      history,
      12
    );


  if (
    rows.length < 3
  ) {

    return {
      big: 0,
      small: 0,
      strength: 0
    };
  }


  /*
    Newer results receive larger weight.
  */

  let big = 0;

  let small = 0;


  rows.forEach(
    (
      row,
      index
    ) => {

      const weight =
        rows.length -
        index;


      if (
        row.side === "BIG"
      ) {

        big +=
          weight;

      } else {

        small +=
          weight;
      }
    }
  );


  const total =
    big + small;


  const difference =
    Math.abs(
      big - small
    );


  const strength =
    total
      ? (
          difference /
          total
        ) *
        100
      : 0;


  return {
    big,
    small,
    strength
  };
}


/* =========================================================
   STREAK SCORE
========================================================= */

function calculateStreak(
  history
) {

  const rows =
    recentRows(
      history,
      15
    );


  if (!rows.length) {

    return {
      side: null,
      length: 0
    };
  }


  const first =
    rows[0].side;


  let length = 0;


  for (
    const row of rows
  ) {

    if (
      row.side === first
    ) {

      length++;

    } else {

      break;
    }
  }


  return {
    side: first,
    length
  };
}


/* =========================================================
   TRANSITION SCORE
========================================================= */

function calculateTransitions(
  history
) {

  const rows =
    recentRows(
      history,
      30
    );


  if (
    rows.length < 3
  ) {

    return {
      big: 0,
      small: 0,
      total: 0
    };
  }


  let bb = 0;
  let bs = 0;
  let sb = 0;
  let ss = 0;


  for (
    let i = 0;
    i < rows.length - 1;
    i++
  ) {

    const current =
      rows[i].side;

    const previous =
      rows[i + 1].side;


    if (
      previous === "BIG" &&
      current === "BIG"
    ) {

      bb++;

    } else if (
      previous === "BIG" &&
      current === "SMALL"
    ) {

      bs++;

    } else if (
      previous === "SMALL" &&
      current === "BIG"
    ) {

      sb++;

    } else if (
      previous === "SMALL" &&
      current === "SMALL"
    ) {

      ss++;
    }
  }


  const last =
    rows[0].side;


  /*
    Conditional next-side estimate.

    We use historical transitions from the same
    current side, but heavily regularize when sample
    size is small.
  */

  let big = 0;

  let small = 0;


  if (
    last === "BIG"
  ) {

    big =
      bb + 1;

    small =
      bs + 1;

  } else {

    big =
      sb + 1;

    small =
      ss + 1;
  }


  return {
    big,
    small,
    total:
      big + small
  };
}


/* =========================================================
   NUMBER FREQUENCY
========================================================= */

function calculateNumberFrequency(
  history
) {

  const rows =
    recentRows(
      history,
      40
    );


  const counts =
    Array(10).fill(0);


  rows.forEach(
    row => {

      if (
        row.number !== null
      ) {

        counts[
          row.number
        ]++;
      }
    }
  );


  return counts;
}


/* =========================================================
   SIDE FREQUENCY
========================================================= */

function calculateSideFrequency(
  history,
  count = 40
) {

  const rows =
    recentRows(
      history,
      count
    );


  const sides =
    countSides(
      rows
    );


  const total =
    sides.big +
    sides.small;


  return {
    big:
      total
        ? sides.big / total
        : 0.5,

    small:
      total
        ? sides.small / total
        : 0.5
  };
}


/* =========================================================
   MEAN REGRESSION
========================================================= */

function calculateMeanRegression(
  history
) {

  const rows =
    recentRows(
      history,
      15
    );


  if (!rows.length) {

    return {
      big: 0,
      small: 0,
      mean: 4.5
    };
  }


  let weightedSum = 0;

  let weightTotal = 0;


  rows.forEach(
    (
      row,
      index
    ) => {

      const weight =
        rows.length -
        index;


      weightedSum +=
        row.number *
        weight;


      weightTotal +=
        weight;
    }
  );


  const mean =
    weightTotal
      ? weightedSum /
        weightTotal
      : 4.5;


  /*
    If mean is above midpoint, recent numbers lean BIG.
    If below, they lean SMALL.

    This is only one component.
  */

  const deviation =
    mean - 4.5;


  const normalized =
    clamp(
      deviation / 2.5,
      -1,
      1
    );


  let big =
    50 +
    normalized *
    25;


  let small =
    50 -
    normalized *
    25;


  return {
    big,
    small,
    mean
  };
}


/* =========================================================
   SIMILAR HISTORICAL PATTERNS
========================================================= */

/*
  Compare recent BIG/SMALL sequences against older
  sequences of the same length.

  Example:

  Current:
  BIG SMALL SMALL BIG SMALL

  Search older windows with similar sequence.

  If the next historical result after similar windows
  was more often BIG, BIG gets a small positive score.
*/

function calculateHistoricalPattern(
  history
) {

  const rows =
    recentRows(
      history,
      80
    );


  const patternLength =
    Math.min(
      5,
      rows.length
    );


  if (
    patternLength < 3
  ) {

    return {
      big: 0,
      small: 0,
      matches: 0
    };
  }


  const currentPattern =
    rows
      .slice(
        0,
        patternLength
      )
      .map(
        row =>
          row.side
      );


  let bigMatches = 0;

  let smallMatches = 0;

  let matches = 0;


  /*
    Start from index 1 so we don't match the current
    live window against itself.
  */

  for (
    let i = 1;
    i <=
      rows.length -
      patternLength -
      1;
    i++
  ) {

    let same = true;


    for (
      let j = 0;
      j < patternLength;
      j++
    ) {

      if (
        rows[i + j].side !==
        currentPattern[j]
      ) {

        same = false;

        break;
      }
    }


    if (!same) {
      continue;
    }


    /*
      The row immediately after this historical window
      in chronological direction is rows[i + length].
    */

    const next =
      rows[
        i + patternLength
      ];


    if (!next) {
      continue;
    }


    matches++;


    if (
      next.side === "BIG"
    ) {

      bigMatches++;

    } else {

      smallMatches++;
    }
  }


  if (!matches) {

    return {
      big: 0,
      small: 0,
      matches: 0
    };
  }


  return {
    big:
      (
        bigMatches /
        matches
      ) *
      100,

    small:
      (
        smallMatches /
        matches
      ) *
      100,

    matches
  };
}


/* =========================================================
   SIDE MODEL
========================================================= */

function calculateSideModel(
  history
) {

  const trend =
    calculateTrendScore(
      history
    );


  const streak =
    calculateStreak(
      history
    );


  const transitions =
    calculateTransitions(
      history
    );


  const mean =
    calculateMeanRegression(
      history
    );


  const frequency =
    calculateSideFrequency(
      history,
      40
    );


  const historical =
    calculateHistoricalPattern(
      history
    );


  /*
    We use several independent-ish signals.

    IMPORTANT:
    These are heuristic scores, not true probabilities.
  */

  let bigScore = 50;

  let smallScore = 50;


  /*
    1. Recent weighted trend
  */

  if (
    trend.big +
    trend.small >
    0
  ) {

    const total =
      trend.big +
      trend.small;


    const bigPct =
      (
        trend.big /
        total
      ) *
      100;


    const smallPct =
      (
        trend.small /
        total
      ) *
      100;


    bigScore +=
      (
        bigPct -
        50
      ) *
      0.45;


    smallScore +=
      (
        smallPct -
        50
      ) *
      0.45;
  }


  /*
    2. Transition model
  */

  if (
    transitions.total
  ) {

    const bigPct =
      (
        transitions.big /
        transitions.total
      ) *
      100;


    const smallPct =
      (
        transitions.small /
        transitions.total
      ) *
      100;


    bigScore +=
      (
        bigPct -
        50
      ) *
      0.30;


    smallScore +=
      (
        smallPct -
        50
      ) *
      0.30;
  }


  /*
    3. Mean regression
  */

  bigScore +=
    (
      mean.big -
      50
    ) *
    0.30;


  smallScore +=
    (
      mean.small -
      50
    ) *
    0.30;


  /*
    4. Long frequency
  */

  bigScore +=
    (
      frequency.big -
      0.5
    ) *
    20;


  smallScore +=
    (
      frequency.small -
      0.5
    ) *
    20;


  /*
    5. Historical sequence
  */

  if (
    historical.matches >= 2
  ) {

    bigScore +=
      (
        historical.big -
        50
      ) *
      0.20;


    smallScore +=
      (
        historical.small -
        50
      ) *
      0.20;
  }


  /*
    6. Streak regularization.

    We DON'T blindly reverse a streak.
    Long streaks increase uncertainty rather than
    forcing an opposite prediction.
  */

  if (
    streak.length >= 4
  ) {

    const penalty =
      Math.min(
        5,
        streak.length - 3
      );


    if (
      streak.side === "BIG"
    ) {

      bigScore -=
        penalty;

      smallScore +=
        penalty * 0.35;

    } else {

      smallScore -=
        penalty;

      bigScore +=
        penalty * 0.35;
    }
  }


  bigScore =
    clamp(
      bigScore,
      0,
      100
    );


  smallScore =
    clamp(
      smallScore,
      0,
      100
    );


  const total =
    bigScore +
    smallScore;


  const bigPct =
    total
      ? (
          bigScore /
          total
        ) *
        100
      : 50;


  const smallPct =
    total
      ? (
          smallScore /
          total
        ) *
        100
      : 50;


  const prediction =
    bigPct >= smallPct
      ? "BIG"
      : "SMALL";


  const selectedScore =
    prediction === "BIG"
      ? bigPct
      : smallPct;


  const otherScore =
    prediction === "BIG"
      ? smallPct
      : bigPct;


  const margin =
    Math.abs(
      selectedScore -
      otherScore
    );


  /*
    Confidence is deliberately conservative.

    50 = almost balanced
    70 = moderate lean
    80+ = stronger model alignment
  */

  let confidence =
    50 +
    margin *
    0.72;


  /*
    Historical match support can slightly increase
    confidence, but never dominate.
  */

  if (
    historical.matches >= 3
  ) {

    confidence +=
      Math.min(
        4,
        historical.matches *
        0.6
      );
  }


  /*
    Very small sample = lower confidence.
  */

  const sampleSize =
    recentRows(
      history,
      40
    ).length;


  if (
    sampleSize < 8
  ) {

    confidence -= 8;

  } else if (
    sampleSize < 15
  ) {

    confidence -= 4;
  }


  confidence =
    clamp(
      Math.round(
        confidence
      ),
      50,
      89
    );


  /*
    Agreement:

    How many components point toward the same side.
  */

  const components = [];


  components.push(
    trend.big >= trend.small
      ? "BIG"
      : "SMALL"
  );


  components.push(
    transitions.big >= transitions.small
      ? "BIG"
      : "SMALL"
  );


  components.push(
    mean.big >= mean.small
      ? "BIG"
      : "SMALL"
  );


  components.push(
    frequency.big >= frequency.small
      ? "BIG"
      : "SMALL"
  );


  if (
    historical.matches >= 2
  ) {

    components.push(
      historical.big >= historical.small
        ? "BIG"
        : "SMALL"
    );
  }


  const agreeCount =
    components.filter(
      side =>
        side === prediction
    ).length;


  const modelAgreement =
    Math.round(
      (
        agreeCount /
        components.length
      ) *
      100
    );


  /*
    Pattern score is a combined measure of:
    margin + agreement + historical sample.
  */

  const patternScore =
    Math.round(
      clamp(
        (
          margin * 1.3
        ) +
        (
          modelAgreement *
          0.35
        ) +
        Math.min(
          10,
          historical.matches * 1.2
        ),
        0,
        100
      )
    );


  return {

    prediction,

    confidence,

    bigScore:
      roundNumber(
        bigPct
      ),

    smallScore:
      roundNumber(
        smallPct
      ),

    patternScore,

    modelAgreement,

    trend,

    streak,

    transitions,

    mean,

    frequency,

    historical
  };
}


/* =========================================================
   NUMBER MODEL
========================================================= */

function calculateNumberModel(
  history,
  predictedSide
) {

  const rows =
    recentRows(
      history,
      60
    );


  const counts =
    Array(10).fill(0);


  /*
    Recent weighted frequency.
  */

  rows.forEach(
    (
      row,
      index
    ) => {

      if (
        row.number === null
      ) {

        return;
      }


      const weight =
        Math.max(
          1,
          rows.length -
          index
        );


      counts[
        row.number
      ] +=
        weight;
    }
  );


  /*
    Add conditional-side frequency.
  */

  rows.forEach(
    (
      row,
      index
    ) => {

      if (
        row.number === null ||
        row.side !== predictedSide
      ) {

        return;
      }


      const weight =
        Math.max(
          1,
          (
            rows.length -
            index
          ) *
          1.35
        );


      counts[
        row.number
      ] +=
        weight;
  });


  /*
    Digits must match the predicted side.
  */

  const validDigits =
    predictedSide === "BIG"
      ? [5,6,7,8,9]
      : [0,1,2,3,4];


  /*
    Recent transition:

    Look for numbers that historically followed the
    latest number.
  */

  const latest =
    rows.length
      ? rows[0].number
      : null;


  if (
    latest !== null
  ) {

    for (
      let i = 1;
      i < rows.length;
      i++
    ) {

      if (
        rows[i].number === latest
      ) {

        const next =
          rows[i - 1];


        if (
          next &&
          next.number !== null &&
          validDigits.includes(
            next.number
          )
        ) {

          counts[
            next.number
          ] +=
            4;
        }
      }
    }
  }


  /*
    Prevent one digit from winning just because of
    a tiny sample.

    Small smoothing amount.
  */

  validDigits.forEach(
    digit => {

      counts[digit] +=
        1;
    }
  );


  /*
    Select highest-scoring digit.

    Deterministic tie-break:
    choose digit with the stronger long-term frequency,
    then lower digit.
  */

  let best =
    validDigits[0];


  for (
    const digit of validDigits
  ) {

    if (
      counts[digit] >
      counts[best]
    ) {

      best =
        digit;
    }
  }


  const total =
    validDigits.reduce(
      (
        sum,
        digit
      ) =>
        sum +
        counts[digit],
      0
    );


  const bestShare =
    total
      ? (
          counts[best] /
          total
        ) *
        100
      : 20;


  return {

    number:
      best,

    score:
      roundNumber(
        counts[best]
      ),

    share:
      roundNumber(
        bestShare
      ),

    candidates:
      validDigits
        .map(
          digit => ({
            digit,
            score:
              roundNumber(
                counts[digit]
              )
          })
        )
        .sort(
          (
            a,
            b
          ) =>
            b.score -
            a.score
        )
  };
}


/* =========================================================
   WALK-FORWARD BACKTEST
========================================================= */

/*
  This is NOT a claim of future accuracy.

  It simply runs the same deterministic side model over
  older windows and reports what it would have selected.

  We keep it limited to avoid excessive CPU usage.
*/

function calculateBacktest(
  history
) {

  const rows =
    recentRows(
      history,
      180
    );


  /*
    Need enough history for both training and testing.
  */

  if (
    rows.length < 20
  ) {

    return {
      samples: 0,
      accuracy: null
    };
  }


  /*
    Convert newest-first rows to oldest-first.
  */

  const chronological =
    [...rows]
      .reverse();


  let correct = 0;

  let samples = 0;


  /*
    Test recent portion only.

    Each test point uses only data that existed BEFORE
    that result.
  */

  const start =
    Math.max(
      10,
      chronological.length -
      80
    );


  for (
    let i = start;
    i < chronological.length;
    i++
  ) {

    const training =
      chronological
        .slice(
          0,
          i
        )
        .reverse();


    const actual =
      chronological[i];


    if (
      !actual ||
      !actual.side
    ) {

      continue;
    }


    const model =
      calculateSideModelLight(
        training
      );


    if (
      !model
    ) {

      continue;
    }


    samples++;


    if (
      model ===
      actual.side
    ) {

      correct++;
    }
  }


  return {

    samples,

    accuracy:
      samples
        ? Math.round(
            (
              correct /
              samples
            ) *
            100
          )
        : null
  };
}


/*
  Lightweight version used by backtest so it doesn't
  recursively run another backtest.
*/

function calculateSideModelLight(
  history
) {

  const rows =
    recentRows(
      history,
      12
    );


  if (
    rows.length < 5
  ) {

    return null;
  }


  let big = 0;

  let small = 0;


  rows.forEach(
    (
      row,
      index
    ) => {

      const weight =
        rows.length -
        index;


      if (
        row.side === "BIG"
      ) {

        big +=
          weight;

      } else {

        small +=
          weight;
      }
    }
  );


  /*
    Mean.
  */

  let weightedSum = 0;

  let weightTotal = 0;


  rows.forEach(
    (
      row,
      index
    ) => {

      const weight =
        rows.length -
        index;


      weightedSum +=
        row.number *
        weight;


      weightTotal +=
        weight;
    }
  );


  const mean =
    weightTotal
      ? weightedSum /
        weightTotal
      : 4.5;


  if (
    mean > 4.5
  ) {

    big += 2;

  } else if (
    mean < 4.5
  ) {

    small += 2;
  }


  /*
    Long frequency.
  */

  const freq =
    calculateSideFrequency(
      history,
      30
    );


  big +=
    freq.big *
    4;


  small +=
    freq.small *
    4;


  return big >= small
    ? "BIG"
    : "SMALL";
}


/* =========================================================
   FULL PREDICTION
========================================================= */

function createPrediction(
  history
) {

  if (
    !history ||
    history.length < 5
  ) {

    return {

      prediction: null,

      number: null,

      confidence: 0,

      status:
        "WAITING FOR HISTORY",

      analysis: {

        patternScore: 0,

        modelAgreement: 0,

        backtestSamples: 0,

        avgModelAccuracy: null
      }
    };
  }


  const model =
    calculateSideModel(
      history
    );


  const numberModel =
    calculateNumberModel(
      history,
      model.prediction
    );


  const backtest =
    calculateBacktest(
      history
    );


  /*
    Don't pretend weak/noisy data is a strong signal.

    We still return the stronger side so the UI has a
    prediction, but status clearly communicates signal quality.
  */

  let status =
    "SIGNAL READY";


  if (
    model.confidence < 60
  ) {

    status =
      "LOW CONFIDENCE";

  } else if (
    model.confidence < 70
  ) {

    status =
      "MODERATE LEAN";

  } else if (
    model.confidence >= 80
  ) {

    status =
      "STRONGER LEAN";
  }


  return {

    prediction:
      model.prediction,

    number:
      numberModel.number,

    confidence:
      model.confidence,

    status,

    analysis: {

      patternScore:
        model.patternScore,

      modelAgreement:
        model.modelAgreement,

      backtestSamples:
        backtest.samples,

      avgModelAccuracy:
        backtest.accuracy,

      bigScore:
        model.bigScore,

      smallScore:
        model.smallScore,

      recentMean:
        roundNumber(
          model.mean.mean
        ),

      streakSide:
        model.streak.side,

      streakLength:
        model.streak.length,

      historicalMatches:
        model.historical.matches,

      numberScore:
        numberModel.share
    }
  };
}


/* =========================================================
   SAVE PREDICTION
========================================================= */

async function savePrediction(
  targetIssue,
  prediction
) {

  if (
    !targetIssue ||
    !prediction ||
    !prediction.prediction
  ) {

    return null;
  }


  /*
    IMPORTANT:

    target_issue is UNIQUE.

    Therefore the same target period can never receive
    a second prediction.
  */

  const result =
    await pool.query(
      `
      INSERT INTO prediction_records
      (
        target_issue,
        prediction,
        predicted_number,
        confidence,
        status,
        outcome,
        actual_number,
        actual_side,
        analysis,
        created_at,
        settled_at
      )
      VALUES
      (
        $1,
        $2,
        $3,
        $4,
        $5,
        'PENDING',
        NULL,
        NULL,
        $6::jsonb,
        $7,
        0
      )
      ON CONFLICT (target_issue)
      DO NOTHING
      RETURNING *
      `,
      [
        targetIssue,

        prediction.prediction,

        prediction.number,

        prediction.confidence,

        prediction.status,

        JSON.stringify(
          prediction.analysis ||
          {}
        ),

        now()
      ]
    );


  if (
    result.rowCount === 0
  ) {

    const existing =
      await pool.query(
        `
        SELECT *
        FROM prediction_records
        WHERE target_issue = $1
        LIMIT 1
        `,
        [targetIssue]
      );


    return existing.rows[0] ||
      null;
  }


  return result.rows[0];
}


/* =========================================================
   SETTLE PREDICTIONS
========================================================= */

async function settlePredictions(
  history
) {

  if (
    !history ||
    !history.length
  ) {

    return;
  }


  /*
    Build exact period map.
  */

  const actualMap =
    new Map();


  for (
    const row of history
  ) {

    if (
      row.issueNumber &&
      row.number !== null &&
      row.side
    ) {

      actualMap.set(
        row.issueNumber,
        row
      );
    }
  }


  /*
    Only PENDING rows.

    Never compare one period's prediction with
    another period's result.
  */

  const pending =
    await pool.query(
      `
      SELECT *
      FROM prediction_records
      WHERE outcome = 'PENDING'
      ORDER BY id ASC
      LIMIT 200
      `
    );


  for (
    const prediction
    of pending.rows
  ) {

    const actual =
      actualMap.get(
        prediction.target_issue
      );


    /*
      No exact actual result yet.
      Leave PENDING.
    */

    if (!actual) {

      continue;
    }


    const actualSide =
      actual.side;


    const predictedSide =
      normalizeSide(
        prediction.prediction
      );


    if (
      !predictedSide ||
      !actualSide
    ) {

      continue;
    }


    const outcome =
      predictedSide ===
      actualSide
        ? "WIN"
        : "LOSS";


    await pool.query(
      `
      UPDATE prediction_records
      SET
        outcome = $1,
        actual_number = $2,
        actual_side = $3,
        settled_at = $4
      WHERE id = $5
      `,
      [
        outcome,

        actual.number,

        actualSide,

        now(),

        prediction.id
      ]
    );
  }
}


/* =========================================================
   GET PREDICTION HISTORY
========================================================= */

async function getPredictionHistory() {

  const result =
    await pool.query(
      `
      SELECT
        target_issue,
        prediction,
        predicted_number,
        confidence,
        status,
        outcome,
        actual_number,
        actual_side,
        analysis,
        created_at,
        settled_at
      FROM prediction_records
      ORDER BY id DESC
      LIMIT 30
      `
    );


  return result.rows;
}


/* =========================================================
   BUILD LAST 30 DISPLAY
========================================================= */

async function buildDisplayHistory(
  sourceHistory
) {

  const predictions =
    await getPredictionHistory();


  const predictionMap =
    new Map();


  for (
    const p of predictions
  ) {

    predictionMap.set(
      p.target_issue,
      p
    );
  }


  /*
    We want recent actual results first.

    Each row has:
      PERIOD
      NUMBER
      RESULT
      PREDICT
      W/L
  */

  const output = [];


  for (
    const actual
    of sourceHistory.slice(
      0,
      30
    )
  ) {

    const p =
      predictionMap.get(
        actual.issueNumber
      );


    output.push({

      target_issue:
        actual.issueNumber,

      result_number:
        actual.number,

      result_side:
        actual.side,

      prediction:
        p
          ? p.prediction
          : null,

      predicted_number:
        p
          ? p.predicted_number
          : null,

      confidence:
        p
          ? Number(
              p.confidence || 0
            )
          : null,

      status:
        p
          ? p.status
          : null,

      outcome:
        p
          ? p.outcome
          : null,

      created_at:
        p
          ? p.created_at
          : null
    });
  }


  return output;
}


/* =========================================================
   SESSION STATS
========================================================= */

async function getStats() {

  const result =
    await pool.query(
      `
      SELECT
        COUNT(*) FILTER
          (
            WHERE outcome = 'WIN'
          ) AS wins,

        COUNT(*) FILTER
          (
            WHERE outcome = 'LOSS'
          ) AS losses

      FROM prediction_records
      `
    );


  const row =
    result.rows[0] ||
    {};


  const wins =
    Number(
      row.wins || 0
    );


  const losses =
    Number(
      row.losses || 0
    );


  return {
    wins,
    losses
  };
}


/* =========================================================
   TIMER
========================================================= */

function getCountdown() {

  const elapsed =
    Math.floor(
      (
        now() -
        liveState.countdownAnchor
      ) /
      1000
    );


  let remaining =
    ROUND_SECONDS -
    elapsed;


  if (
    remaining < 0
  ) {

    remaining = 0;
  }


  return remaining;
}


/* =========================================================
   UPDATE LIVE STATE
========================================================= */

async function updateLiveState() {

  if (providerBusy) {

    return;
  }


  providerBusy =
    true;


  try {

    const raw =
      await fetchWingoHistory();


    const normalized =
      normalizeProviderResponse(
        raw
      );


    if (
      !normalized.history.length
    ) {

      throw new Error(
        "No valid settled history returned by WingoBot."
      );
    }


    providerHistory =
      normalized.history;


    providerCurrentIssue =
      normalized.currentIssue;


    lastProviderFetch =
      now();


    liveState.providerOnline =
      true;


    liveState.error =
      null;


    /*
      Resolve latest settled and next target.
    */

    const resolved =
      resolveTargetIssue(
        providerCurrentIssue,
        providerHistory
      );


    const latestIssue =
      resolved.latestSettledIssue;


    const targetIssue =
      resolved.targetIssue;


    liveState.latestSettledIssue =
      latestIssue;


    liveState.currentIssue =
      providerCurrentIssue;


    liveState.targetIssue =
      targetIssue;


    /*
      FIRST settle existing exact-period predictions.
    */

    await settlePredictions(
      providerHistory
    );


    /*
      If target changed, create exactly ONE new
      prediction for the new target.
    */

    if (
      targetIssue &&
      targetIssue !==
        lastTargetIssue
    ) {

      lastTargetIssue =
        targetIssue;


      liveState.countdownAnchor =
        now();


      liveState.countdown =
        ROUND_SECONDS;


      const prediction =
        createPrediction(
          providerHistory
        );


      if (
        prediction &&
        prediction.prediction
      ) {

        await savePrediction(
          targetIssue,
          prediction
        );


        liveState.prediction =
          prediction.prediction;


        liveState.number =
          prediction.number;


        liveState.confidence =
          prediction.confidence;


        liveState.status =
          prediction.status;


        liveState.analysis =
          prediction.analysis;
      }
    }


    /*
      Load the prediction for the current target
      from DB.

      This is important after server restart.
    */

    if (targetIssue) {

      const currentPrediction =
        await pool.query(
          `
          SELECT *
          FROM prediction_records
          WHERE target_issue = $1
          LIMIT 1
          `,
          [targetIssue]
        );


      if (
        currentPrediction.rowCount
      ) {

        const p =
          currentPrediction.rows[0];


        liveState.prediction =
          normalizeSide(
            p.prediction
          );


        liveState.number =
          p.predicted_number !== null
            ? Number(
                p.predicted_number
              )
            : null;


        liveState.confidence =
          Number(
            p.confidence || 0
          );


        liveState.status =
          safeString(
            p.status
          ) ||
          "SIGNAL READY";


        liveState.analysis =
          p.analysis || {};
      }
    }


    /*
      If target hasn't changed but current prediction
      disappeared from memory, regenerate only if DB
      has no row.
    */

    if (
      targetIssue &&
      !liveState.prediction
    ) {

      const prediction =
        createPrediction(
          providerHistory
        );


      if (
        prediction.prediction
      ) {

        await savePrediction(
          targetIssue,
          prediction
        );


        liveState.prediction =
          prediction.prediction;


        liveState.number =
          prediction.number;


        liveState.confidence =
          prediction.confidence;


        liveState.status =
          prediction.status;


        liveState.analysis =
          prediction.analysis;
      }
    }


    /*
      Stats.
    */

    const stats =
      await getStats();


    liveState.wins =
      stats.wins;


    liveState.losses =
      stats.losses;


    /*
      LAST 30 display.
    */

    liveState.predictionHistory =
      await buildDisplayHistory(
        providerHistory
      );


    liveState.countdown =
      getCountdown();


    liveState.updatedAt =
      now();


    liveState.ready =
      true;

  } catch (error) {

    console.error(
      "Wingo update error:",
      error.message
    );


    /*
      IMPORTANT:

      Don't erase the last valid state on a temporary
      provider/network failure.
    */

    liveState.providerOnline =
      false;


    liveState.error =
      error.message;


    liveState.updatedAt =
      now();


    liveState.countdown =
      getCountdown();

  } finally {

    providerBusy =
      false;
  }
}


/* =========================================================
   STATE RESPONSE
========================================================= */

async function getPublicState() {

  /*
    Refresh countdown on every frontend request.
  */

  liveState.countdown =
    getCountdown();


  /*
    If timer reached zero, the next provider poll will
    detect the new target.

    We do NOT create a new prediction just because the
    countdown reached zero.
  */


  return {

    success: true,

    ready:
      liveState.ready,

    providerOnline:
      liveState.providerOnline,

    latestSettledIssue:
      liveState.latestSettledIssue,

    currentIssue:
      liveState.currentIssue,

    targetIssue:
      liveState.targetIssue,

    prediction:
      liveState.prediction,

    number:
      liveState.number,

    confidence:
      liveState.confidence,

    status:
      liveState.status,

    countdown:
      liveState.countdown,

    analysis:
      liveState.analysis || {},

    predictionHistory:
      liveState.predictionHistory || [],

    wins:
      liveState.wins,

    losses:
      liveState.losses,

    updatedAt:
      liveState.updatedAt
  };
}


/* =========================================================
   ADMIN: CREATE KEY
========================================================= */

async function createAccessKey() {

  const key =
    "DY-" +
    crypto
      .randomBytes(8)
      .toString(
        "hex"
      )
      .toUpperCase();


  const result =
    await pool.query(
      `
      INSERT INTO access_keys
      (
        access_key,
        device_id,
        created_at,
        last_seen
      )
      VALUES
      (
        $1,
        NULL,
        $2,
        0
      )
      RETURNING *
      `,
      [
        key,
        now()
      ]
    );


  return result.rows[0];
}


/* =========================================================
   ADMIN: LIST KEYS
========================================================= */

async function listAccessKeys() {

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
   ADMIN: DELETE KEY
========================================================= */

async function deleteAccessKey(
  id
) {

  const result =
    await pool.query(
      `
      DELETE FROM access_keys
      WHERE id = $1
      RETURNING id
      `,
      [id]
    );


  return result.rowCount > 0;
}


/* =========================================================
   ADMIN: RESET DEVICE
========================================================= */

async function resetDevice(
  id
) {

  const result =
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


  return result.rows[0] ||
    null;
}


/* =========================================================
   ADMIN: STATUS
========================================================= */

async function adminStatus() {

  const stats =
    await getStats();


  return {

    success: true,

    serverTime:
      now(),

    providerOnline:
      liveState.providerOnline,

    historyCount:
      providerHistory.length,

    latestSettledIssue:
      liveState.latestSettledIssue,

    currentIssue:
      liveState.currentIssue,

    targetIssue:
      liveState.targetIssue,

    prediction:
      liveState.prediction,

    confidence:
      liveState.confidence,

    wins:
      stats.wins,

    losses:
      stats.losses,

    lastProviderFetch,

    error:
      liveState.error
  };
}


/* =========================================================
   ADMIN: WINGO TEST
========================================================= */

async function adminWingoTest() {

  try {

    const raw =
      await fetchWingoHistory();


    const normalized =
      normalizeProviderResponse(
        raw
      );


    const resolved =
      resolveTargetIssue(
        normalized.currentIssue,
        normalized.history
      );


    return {

      success: true,

      currentIssue:
        normalized.currentIssue,

      latestSettledIssue:
        resolved.latestSettledIssue,

      targetIssue:
        resolved.targetIssue,

      historyCount:
        normalized.history.length,

      firstRows:
        normalized.history.slice(
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
   ADMIN: MODEL TEST
========================================================= */

async function adminModelTest() {

  if (
    !providerHistory.length
  ) {

    return {

      success: false,

      error:
        "History not loaded yet."
    };
  }


  const prediction =
    createPrediction(
      providerHistory
    );


  return {

    success: true,

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
   ROUTER
========================================================= */

async function handleRequest(
  req,
  res
) {

  const parsed =
    url.parse(
      req.url,
      true
    );


  const pathname =
    parsed.pathname;


  /*
    OPTIONS
  */

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
          "Content-Type, Authorization, X-Admin-Key",

        "Access-Control-Allow-Methods":
          "GET,POST,DELETE,OPTIONS"
      }
    );


    res.end();

    return;
  }


  /*
    HEALTH
  */

  if (
    pathname ===
      "/health" &&
    req.method ===
      "GET"
  ) {

    sendJson(
      res,
      200,
      {
        status:
          "ok",

        providerOnline:
          liveState.providerOnline,

        database:
          !!DATABASE_URL,

        historyCount:
          providerHistory.length,

        time:
          now()
      }
    );

    return;
  }


  /*
    ACCESS KEY CHECK
  */

  if (
    pathname ===
      "/api/key/check" &&
    req.method ===
      "POST"
  ) {

    try {

      const body =
        await readBody(
          req
        );


      const result =
        await checkAccessKey(
          safeString(
            body.access_key
          ),
          safeString(
            body.device_id
          )
        );


      sendJson(
        res,
        result.success
          ? 200
          : 403,
        result
      );

    } catch (error) {

      console.error(
        error
      );


      sendJson(
        res,
        500,
        {
          success: false,

          error:
            "DATABASE_NOT_READY"
        }
      );
    }


    return;
  }


  /*
    PUBLIC STATE
  */

  if (
    pathname ===
      "/api/state" &&
    req.method ===
      "GET"
  ) {

    sendJson(
      res,
      200,
      await getPublicState()
    );

    return;
  }


  /*
    PUBLIC HISTORY
  */

  if (
    pathname ===
      "/api/history" &&
    req.method ===
      "GET"
  ) {

    sendJson(
      res,
      200,
      {
        success: true,

        history:
          providerHistory.slice(
            0,
            100
          ),

        predictions:
          liveState.predictionHistory
      }
    );

    return;
  }


  /*
    ADMIN AUTH
  */

  if (
    pathname.startsWith(
      "/api/admin/"
    )
  ) {

    if (!isAdmin(req)) {

      sendJson(
        res,
        403,
        {
          success: false,

          error:
            "ADMIN_UNAUTHORIZED"
        }
      );

      return;
    }
  }


  /*
    ADMIN STATUS
  */

  if (
    pathname ===
      "/api/admin/status" &&
    req.method ===
      "GET"
  ) {

    sendJson(
      res,
      200,
      await adminStatus()
    );

    return;
  }


  /*
    ADMIN PING
  */

  if (
    pathname ===
      "/api/admin/ping" &&
    req.method ===
      "GET"
  ) {

    sendJson(
      res,
      200,
      {
        success: true,

        message:
          "ADMIN CONNECTED",

        time:
          now()
      }
    );

    return;
  }


  /*
    ADMIN KEYS GET
  */

  if (
    pathname ===
      "/api/admin/keys" &&
    req.method ===
      "GET"
  ) {

    try {

      const keys =
        await listAccessKeys();


      sendJson(
        res,
        200,
        {
          success: true,
          keys
        }
      );

    } catch (error) {

      sendJson(
        res,
        500,
        {
          success: false,
          error:
            error.message
        }
      );
    }


    return;
  }


  /*
    ADMIN KEYS CREATE
  */

  if (
    pathname ===
      "/api/admin/keys" &&
    req.method ===
      "POST"
  ) {

    try {

      const key =
        await createAccessKey();


      sendJson(
        res,
        200,
        {
          success: true,
          key
        }
      );

    } catch (error) {

      sendJson(
        res,
        500,
        {
          success: false,
          error:
            error.message
        }
      );
    }


    return;
  }


  /*
    ADMIN KEY DELETE
  */

  if (
    pathname ===
      "/api/admin/keys" &&
    req.method ===
      "DELETE"
  ) {

    try {

      const body =
        await readBody(
          req
        );


      const id =
        Number(
          body.id
        );


      if (
        !Number.isInteger(id)
      ) {

        sendJson(
          res,
          400,
          {
            success: false,
            error:
              "INVALID_ID"
          }
        );

        return;
      }


      const deleted =
        await deleteAccessKey(
          id
        );


      sendJson(
        res,
        200,
        {
          success: deleted
        }
      );

    } catch (error) {

      sendJson(
        res,
        500,
        {
          success: false,
          error:
            error.message
        }
      );
    }


    return;
  }


  /*
    ADMIN RESET DEVICE
  */

  if (
    pathname ===
      "/api/admin/reset-device" &&
    req.method ===
      "POST"
  ) {

    try {

      const body =
        await readBody(
          req
        );


      const id =
        Number(
          body.id
        );


      const result =
        await resetDevice(
          id
        );


      sendJson(
        res,
        200,
        {
          success:
            !!result,

          key:
            result
        }
      );

    } catch (error) {

      sendJson(
        res,
        500,
        {
          success: false,
          error:
            error.message
        }
      );
    }


    return;
  }


  /*
    ADMIN WINGO TEST
  */

  if (
    pathname ===
      "/api/admin/wingo-test" &&
    req.method ===
      "GET"
  ) {

    sendJson(
      res,
      200,
      await adminWingoTest()
    );

    return;
  }


  /*
    ADMIN MODEL TEST
  */

  if (
    pathname ===
      "/api/admin/model-test" &&
    req.method ===
      "GET"
  ) {

    sendJson(
      res,
      200,
      await adminModelTest()
    );

    return;
  }


  /*
    STATIC prediction.html
  */

  if (
    pathname ===
      "/" ||
    pathname ===
      "/prediction.html"
  ) {

    res.writeHead(
      200,
      {
        "Content-Type":
          "text/html; charset=utf-8",

        "Cache-Control":
          "no-store"
      }
    );


    require("fs").createReadStream(
      "./prediction.html"
    )
    .pipe(
      res
    );


    return;
  }


  /*
    STATIC admin.html
  */

  if (
    pathname ===
      "/admin.html"
  ) {

    res.writeHead(
      200,
      {
        "Content-Type":
          "text/html; charset=utf-8",

        "Cache-Control":
          "no-store"
      }
    );


    require("fs").createReadStream(
      "./admin.html"
    )
    .pipe(
      res
    );


    return;
  }


  /*
    MUSIC FILE

    Range requests retained so audio works properly.
  */

  if (
    pathname ===
      "/music.mp3"
  ) {

    await serveMusic(
      req,
      res
    );

    return;
  }


  /*
    404
  */

  sendJson(
    res,
    404,
    {
      success: false,
      error:
        "NOT_FOUND"
    }
  );
}


/* =========================================================
   MUSIC
========================================================= */

async function serveMusic(
  req,
  res
) {

  const fs =
    require("fs");

  const path =
    require("path");

  const filePath =
    path.join(
      __dirname,
      "music.mp3"
    );


  if (
    !fs.existsSync(
      filePath
    )
  ) {

    sendText(
      res,
      404,
      "music.mp3 not found"
    );

    return;
  }


  const stat =
    fs.statSync(
      filePath
    );


  const range =
    req.headers.range;


  if (!range) {

    res.writeHead(
      200,
      {
        "Content-Type":
          "audio/mpeg",

        "Content-Length":
          stat.size,

        "Accept-Ranges":
          "bytes",

        "Cache-Control":
          "public, max-age=3600"
      }
    );


    fs.createReadStream(
      filePath
    ).pipe(
      res
    );


    return;
  }


  const match =
    range.match(
      /bytes=(\d*)-(\d*)/
    );


  if (!match) {

    sendText(
      res,
      416,
      "Invalid range"
    );

    return;
  }


  const start =
    match[1]
      ? Number(
          match[1]
        )
      : 0;


  const requestedEnd =
    match[2]
      ? Number(
          match[2]
        )
      : stat.size - 1;


  const end =
    Math.min(
      requestedEnd,
      stat.size - 1
    );


  if (
    start > end ||
    start >= stat.size
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
        `bytes ${start}-${end}/${stat.size}`,

      "Accept-Ranges":
        "bytes",

      "Cache-Control":
        "public, max-age=3600"
    }
  );


  fs.createReadStream(
    filePath,
    {
      start,
      end
    }
  ).pipe(
    res
  );
}


/* =========================================================
   SERVER
========================================================= */

const server =
  http.createServer(
    (
      req,
      res
    ) => {

      handleRequest(
        req,
        res
      )
      .catch(
        error => {

          console.error(
            "Request error:",
            error
          );


          if (
            !res.headersSent
          ) {

            sendJson(
              res,
              500,
              {
                success: false,

                error:
                  "INTERNAL_SERVER_ERROR"
              }
            );

          } else {

            res.end();
          }
        }
      );
    }
  );


/* =========================================================
   STARTUP
========================================================= */

async function start() {

  try {

    await initDatabase();


    server.listen(
      PORT,
      "0.0.0.0",
      () => {

        console.log(
          `DY AI Wingo server running on port ${PORT}`
        );

        console.log(
          `WingoBot provider: ${WINGOBOT_URL}`
        );
      }
    );


    /*
      First provider update immediately.
    */

    await updateLiveState();


    /*
      Continue polling provider every 3 seconds.

      Frontend can poll /api/state every second,
      but it never creates predictions itself.
    */

    setInterval(
      () => {

        updateLiveState()
          .catch(
            error =>
              console.error(
                "Polling error:",
                error.message
              )
          );

      },
      PROVIDER_POLL_MS
    );


  } catch (error) {

    console.error(
      "STARTUP ERROR:",
      error
    );


    process.exit(
      1
    );
  }
}


start();


/* =========================================================
   GRACEFUL SHUTDOWN
========================================================= */

async function shutdown() {

  console.log(
    "Shutting down..."
  );


  try {

    await pool.end();

  } catch {}


  server.close(
    () => {

      process.exit(
        0
      );
    }
  );


  setTimeout(
    () =>
      process.exit(
        1
      ),
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
