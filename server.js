const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

/* =========================================================
   CONFIG
========================================================= */

const PORT = process.env.PORT || 10000;

const DATABASE_URL =
  process.env.DATABASE_URL || "";

const ADMIN_KEY =
  process.env.ADMIN_KEY || "";

const WINGOBOT_TOKEN =
  process.env.WINGOBOT_TOKEN || "";

const WINGOBOT_URL =
  process.env.WINGOBOT_URL ||
  "https://api.wingobot.com/v2/30-sec-game-history";

const HISTORY_SIZE = 30;

/*
  One prediction ke baad kitne completed rounds
  wait karne hain.
*/
const COOLDOWN_ROUNDS = 5;

/*
  API polling cache.
*/
const API_CACHE_MS = 800;


/* =========================================================
   DATABASE
========================================================= */

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL
    ? { rejectUnauthorized: false }
    : undefined
});


/* =========================================================
   BASIC
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
      "no-store, no-cache, must-revalidate",

    "Pragma":
      "no-cache",

    "Expires":
      "0",

    "Access-Control-Allow-Origin":
      "*"
  });

  res.end(body);
}


function text(
  res,
  status,
  body,
  type = "text/plain"
) {

  res.writeHead(status, {
    "Content-Type":
      type,

    "Cache-Control":
      "no-store"
  });

  res.end(body);
}


function header(req, name) {
  return (
    req.headers[
      name.toLowerCase()
    ] || ""
  );
}


/* =========================================================
   ISSUE ID HELPERS
   NEVER CONVERT LARGE ISSUE TO NUMBER
========================================================= */

function normalizeIssue(value) {

  if (
    value === null ||
    value === undefined
  ) {
    return "";
  }

  return String(value)
    .trim()
    .replace(/\D/g, "");
}


function issueBigInt(value) {

  const s =
    normalizeIssue(value);

  if (!s) return null;

  try {
    return BigInt(s);
  } catch {
    return null;
  }
}


function compareIssues(a, b) {

  const A =
    normalizeIssue(a);

  const B =
    normalizeIssue(b);

  if (!A && !B) return 0;
  if (!A) return -1;
  if (!B) return 1;

  if (A.length !== B.length) {
    return A.length - B.length;
  }

  if (A === B) return 0;

  return A > B ? 1 : -1;
}


function sameIssue(a, b) {
  return (
    compareIssues(a, b) === 0
  );
}


function nextIssue(issue) {

  const n =
    issueBigInt(issue);

  if (n === null) {
    return "";
  }

  return (
    n + 1n
  ).toString();
}


/* =========================================================
   NUMBER / SIDE
========================================================= */

function validNumber(value) {

  const n =
    Number(value);

  return (
    Number.isInteger(n) &&
    n >= 0 &&
    n <= 9
  );
}


function sideFromNumber(value) {

  const n =
    Number(value);

  if (!validNumber(n)) {
    return "";
  }

  return n <= 4
    ? "SMALL"
    : "BIG";
}


/* =========================================================
   SAFE TEXT
========================================================= */

function safeText(value) {

  if (
    value === null ||
    value === undefined
  ) {
    return "";
  }

  if (
    typeof value === "string"
  ) {
    return value;
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }

  if (Array.isArray(value)) {

    return value
      .map(safeText)
      .filter(Boolean)
      .join(" • ");
  }

  if (
    typeof value === "object"
  ) {

    const keys = [
      "classification",
      "label",
      "name",
      "message",
      "reason",
      "summary",
      "status"
    ];

    for (const key of keys) {

      if (
        value[key] !== undefined &&
        value[key] !== null
      ) {

        const result =
          safeText(value[key]);

        if (result) {
          return result;
        }
      }
    }

    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }

  return String(value);
}


/* =========================================================
   DATABASE INIT
========================================================= */

async function initDB() {

  if (!DATABASE_URL) {

    console.warn(
      "DATABASE_URL missing"
    );

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


  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    idx_prediction_target
    ON prediction_records(target_issue)
  `);


  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    idx_prediction_created
    ON prediction_records(created_at)
  `);


  console.log(
    "Database initialized"
  );
}


/* =========================================================
   USER AUTH
========================================================= */

async function authenticateUser(req) {

  const accessKey =
    header(
      req,
      "X-Access-Key"
    );

  const deviceId =
    header(
      req,
      "X-Device-Id"
    );


  if (!accessKey) {

    return {
      ok: false,
      status: 401,
      message:
        "Access key required"
    };
  }


  if (!deviceId) {

    return {
      ok: false,
      status: 400,
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
      status: 401,
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
      status: 403,
      message:
        "Key already bound to another device"
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
    row
  };
}


/* =========================================================
   ADMIN AUTH
========================================================= */

function authenticateAdmin(req) {

  const key =
    header(
      req,
      "X-Admin-Key"
    );

  if (!ADMIN_KEY) {
    return false;
  }

  return key === ADMIN_KEY;
}


/* =========================================================
   WINGOBOT API
========================================================= */

let apiCache = null;
let apiCacheTime = 0;

async function fetchWingoAPI() {

  if (!WINGOBOT_TOKEN) {

    throw new Error(
      "WINGOBOT_TOKEN is not configured"
    );
  }


  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () => controller.abort(),
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
              `Bearer ${WINGOBOT_TOKEN}`,

            "Accept":
              "application/json",

            "Cache-Control":
              "no-cache"
          },

          cache:
            "no-store",

          signal:
            controller.signal
        }
      );


    if (!response.ok) {

      throw new Error(
        `Wingo API HTTP ${response.status}`
      );
    }


    return await response.json();

  } finally {

    clearTimeout(timer);
  }
}


/* =========================================================
   NORMALIZE API
========================================================= */

function normalizeWingo(payload) {

  const current =
    payload?.current || {};


  let currentIssue =
    normalizeIssue(
      current.issueNumber ||
      current.issue ||
      payload?.currentIssue ||
      payload?.issueNumber
    );


  let sourceRows = [];


  if (
    Array.isArray(
      payload?.history
    )
  ) {

    sourceRows =
      payload.history;

  } else if (
    Array.isArray(
      payload?.data
    )
  ) {

    sourceRows =
      payload.data;

  } else if (
    Array.isArray(
      payload?.results
    )
  ) {

    sourceRows =
      payload.results;
  }


  const rows = [];


  for (
    const row of sourceRows
  ) {

    const issue =
      normalizeIssue(
        row?.issueNumber ||
        row?.issue ||
        row?.period ||
        row?.targetIssue
      );


    const numberValue =
      row?.number ??
      row?.resultNumber ??
      row?.openNumber ??
      row?.result;


    if (!issue) {
      continue;
    }


    if (
      !validNumber(
        numberValue
      )
    ) {
      continue;
    }


    rows.push({

      issueNumber:
        issue,

      number:
        Number(numberValue),

      result:
        sideFromNumber(
          numberValue
        ),

      colour:
        row?.colour ??
        row?.color ??
        "",

      premium:
        row?.premium ??
        "",

      sum:
        row?.sum ??
        ""
    });
  }


  rows.sort(
    (a, b) =>
      compareIssues(
        a.issueNumber,
        b.issueNumber
      )
  );


  /*
    If API current issue missing,
    newest returned history is baseline.
  */

  if (
    !currentIssue &&
    rows.length
  ) {

    currentIssue =
      rows[
        rows.length - 1
      ].issueNumber;
  }


  /*
    If history is newer than current field,
    use newest settled issue.
  */

  if (
    currentIssue &&
    rows.length &&
    compareIssues(
      rows[
        rows.length - 1
      ].issueNumber,
      currentIssue
    ) > 0
  ) {

    currentIssue =
      rows[
        rows.length - 1
      ].issueNumber;
  }


  return {

    currentIssue,

    history:
      rows,

    fetchedAt:
      now(),

    sourceLastUpdated:
      payload?.stats?.last_updated ??
      payload?.last_updated ??
      null
  };
}


/* =========================================================
   GET LIVE API DATA
========================================================= */

async function getWingo() {

  if (
    apiCache &&
    now() - apiCacheTime <
      API_CACHE_MS
  ) {

    return apiCache;
  }


  const raw =
    await fetchWingoAPI();


  const normalized =
    normalizeWingo(raw);


  apiCache =
    normalized;

  apiCacheTime =
    now();


  return normalized;
}


/* =========================================================
   ANALYSIS FUNCTIONS
========================================================= */

function sideArray(rows) {

  return rows
    .map(
      r => r.result
    )
    .filter(
      x =>
        x === "BIG" ||
        x === "SMALL"
    );
}


function recentRows(
  rows,
  size
) {

  return rows
    .slice()
    .sort(
      (a, b) =>
        compareIssues(
          a.issueNumber,
          b.issueNumber
        )
    )
    .slice(-size);
}


function countSides(rows) {

  let big = 0;
  let small = 0;


  for (
    const row of rows
  ) {

    if (
      row.result === "BIG"
    ) {
      big++;
    }

    if (
      row.result === "SMALL"
    ) {
      small++;
    }
  }


  const total =
    big + small;


  return {

    big,
    small,
    total,

    bigPct:
      total
        ? big / total * 100
        : 0,

    smallPct:
      total
        ? small / total * 100
        : 0
  };
}


function currentStreak(rows) {

  const sides =
    sideArray(rows);


  if (!sides.length) {

    return {
      side: "",
      length: 0
    };
  }


  const last =
    sides[
      sides.length - 1
    ];


  let length = 1;


  for (
    let i =
      sides.length - 2;
    i >= 0;
    i--
  ) {

    if (
      sides[i] !== last
    ) {
      break;
    }

    length++;
  }


  return {
    side: last,
    length
  };
}


function switchRate(rows) {

  const sides =
    sideArray(rows);


  if (
    sides.length < 2
  ) {
    return 0;
  }


  let switches = 0;


  for (
    let i = 1;
    i < sides.length;
    i++
  ) {

    if (
      sides[i] !==
      sides[i - 1]
    ) {

      switches++;
    }
  }


  return (
    switches /
    (sides.length - 1)
  ) * 100;
}


function runStats(rows) {

  const sides =
    sideArray(rows);


  if (!sides.length) {

    return {
      average: 0,
      longest: 0,
      current: 0,
      currentSide: ""
    };
  }


  const runs = [];


  let side =
    sides[0];

  let length = 1;


  for (
    let i = 1;
    i < sides.length;
    i++
  ) {

    if (
      sides[i] === side
    ) {

      length++;

    } else {

      runs.push({
        side,
        length
      });

      side =
        sides[i];

      length = 1;
    }
  }


  runs.push({
    side,
    length
  });


  const lengths =
    runs.map(
      r => r.length
    );


  const average =
    lengths.reduce(
      (a, b) => a + b,
      0
    ) /
    lengths.length;


  return {

    average,

    longest:
      Math.max(
        ...lengths
      ),

    current:
      length,

    currentSide:
      side
  };
}


function transitionMatrix(rows) {

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


  const sides =
    sideArray(rows);


  for (
    let i = 1;
    i < sides.length;
    i++
  ) {

    matrix[
      sides[i - 1]
    ][
      sides[i]
    ]++;
  }


  return matrix;
}


function momentum(rows) {

  const recent =
    countSides(
      recentRows(
        rows,
        10
      )
    );


  const previousRows =
    rows
      .slice(
        0,
        Math.max(
          0,
          rows.length - 10
        )
      );


  const previous =
    countSides(
      recentRows(
        previousRows,
        10
      )
    );


  return {

    recentBig:
      recent.bigPct,

    recentSmall:
      recent.smallPct,

    previousBig:
      previous.bigPct,

    previousSmall:
      previous.smallPct
  };
}


function alternation(rows) {

  const sides =
    sideArray(rows);


  if (
    sides.length < 3
  ) {

    return {
      active: false,
      length: 0
    };
  }


  let length = 1;


  for (
    let i =
      sides.length - 1;
    i > 0;
    i--
  ) {

    if (
      sides[i] ===
      sides[i - 1]
    ) {
      break;
    }

    length++;
  }


  return {
    active:
      length >= 3,

    length
  };
}


function repeatingBlock(rows) {

  const sides =
    sideArray(rows);


  if (
    sides.length < 6
  ) {

    return {
      found: false,
      length: 0,
      block: ""
    };
  }


  for (
    let size = 2;
    size <= 6;
    size++
  ) {

    if (
      sides.length <
      size * 2
    ) {
      continue;
    }


    const first =
      sides.slice(
        -size * 2,
        -size
      );


    const second =
      sides.slice(
        -size
      );


    if (
      first.join("") ===
      second.join("")
    ) {

      return {

        found: true,

        length:
          size,

        block:
          second.join("-")
      };
    }
  }


  return {
    found: false,
    length: 0,
    block: ""
  };
}


function digitStats(rows) {

  const frequency =
    Array(10).fill(0);


  for (
    const row of rows
  ) {

    if (
      validNumber(
        row.number
      )
    ) {

      frequency[
        row.number
      ]++;
    }
  }


  let mostCommonDigit = 0;


  for (
    let i = 1;
    i < 10;
    i++
  ) {

    if (
      frequency[i] >
      frequency[
        mostCommonDigit
      ]
    ) {

      mostCommonDigit = i;
    }
  }


  return {
    frequency,
    mostCommonDigit
  };
}


/* =========================================================
   PREDICTION PRESSURE
========================================================= */

let pressureCache = {
  side: "",
  count: 0
};


async function refreshPredictionPressure() {

  if (!DATABASE_URL) {
    return;
  }


  const result =
    await pool.query(`
      SELECT prediction
      FROM prediction_records
      WHERE prediction IN ('BIG','SMALL')
      ORDER BY id DESC
      LIMIT 6
    `);


  const rows =
    result.rows;


  if (!rows.length) {

    pressureCache = {
      side: "",
      count: 0
    };

    return;
  }


  const side =
    rows[0].prediction;


  let count = 0;


  for (
    const row of rows
  ) {

    if (
      row.prediction === side
    ) {

      count++;

    } else {

      break;
    }
  }


  pressureCache = {
    side,
    count
  };
}


/* =========================================================
   FULL MODEL
========================================================= */

function fullAnalysis(
  history
) {

  const valid =
    history.filter(
      row =>
        validNumber(
          row.number
        ) &&
        (
          row.result ===
            "BIG" ||
          row.result ===
            "SMALL"
        )
    );


  const sample =
    valid.length;


  /*
    Minimum data.
  */

  if (
    sample < 10
  ) {

    return {

      prediction:
        null,

      confidence:
        0,

      classification:
        "INSUFFICIENT DATA",

      sample,

      scores: {
        BIG: 0,
        SMALL: 0
      },

      details: {}
    };
  }


  const windows = {

    5:
      countSides(
        recentRows(
          valid,
          5
        )
      ),

    10:
      countSides(
        recentRows(
          valid,
          10
        )
      ),

    20:
      countSides(
        recentRows(
          valid,
          20
        )
      ),

    30:
      countSides(
        recentRows(
          valid,
          30
        )
      ),

    50:
      countSides(
        recentRows(
          valid,
          50
        )
      ),

    100:
      countSides(
        recentRows(
          valid,
          100
        )
      )
  };


  let bigScore = 0;
  let smallScore = 0;


  /* ---------------------------------------------------------
     RECENT WINDOWS
  --------------------------------------------------------- */

  const weights = [
    [5, 0.30],
    [10, 0.25],
    [20, 0.20],
    [30, 0.15],
    [50, 0.10]
  ];


  for (
    const [size, weight]
    of weights
  ) {

    const w =
      windows[size];


    if (
      !w.total
    ) {
      continue;
    }


    bigScore +=
      (
        w.bigPct /
        100
      ) *
      weight;


    smallScore +=
      (
        w.smallPct /
        100
      ) *
      weight;
  }


  /* ---------------------------------------------------------
     OVERALL FREQUENCY
  --------------------------------------------------------- */

  const overall =
    countSides(valid);


  bigScore +=
    (
      overall.bigPct /
      100
    ) *
    0.15;


  smallScore +=
    (
      overall.smallPct /
      100
    ) *
    0.15;


  /* ---------------------------------------------------------
     STREAK
  --------------------------------------------------------- */

  const streak =
    currentStreak(valid);


  const runs =
    runStats(valid);


  if (
    streak.side ===
    "BIG"
  ) {

    bigScore += 0.04;

  } else if (
    streak.side ===
    "SMALL"
  ) {

    smallScore += 0.04;
  }


  /*
    Unusual streak:
    opposite gets only a small watch signal.
    No guaranteed reversal.
  */

  if (
    streak.length >=
    Math.max(
      4,
      Math.ceil(
        runs.average * 2
      )
    )
  ) {

    if (
      streak.side ===
      "BIG"
    ) {

      smallScore += 0.035;
    }


    if (
      streak.side ===
      "SMALL"
    ) {

      bigScore += 0.035;
    }
  }


  /* ---------------------------------------------------------
     SWITCHING
  --------------------------------------------------------- */

  const switches =
    switchRate(valid);


  if (
    switches >= 60
  ) {

    if (
      streak.side ===
      "BIG"
    ) {

      smallScore += 0.045;
    }


    if (
      streak.side ===
      "SMALL"
    ) {

      bigScore += 0.045;
    }

  } else if (
    switches < 40
  ) {

    if (
      streak.side ===
      "BIG"
    ) {

      bigScore += 0.035;
    }


    if (
      streak.side ===
      "SMALL"
    ) {

      smallScore += 0.035;
    }
  }


  /* ---------------------------------------------------------
     TRANSITION MATRIX
  --------------------------------------------------------- */

  const matrix =
    transitionMatrix(
      recentRows(
        valid,
        20
      )
    );


  if (
    streak.side ===
    "BIG"
  ) {

    const stay =
      matrix.BIG.BIG;

    const change =
      matrix.BIG.SMALL;


    if (
      change > stay
    ) {

      smallScore += 0.07;

    } else if (
      stay > change
    ) {

      bigScore += 0.05;
    }
  }


  if (
    streak.side ===
    "SMALL"
  ) {

    const stay =
      matrix.SMALL.SMALL;

    const change =
      matrix.SMALL.BIG;


    if (
      change > stay
    ) {

      bigScore += 0.07;

    } else if (
      stay > change
    ) {

      smallScore += 0.05;
    }
  }


  /* ---------------------------------------------------------
     MOMENTUM
  --------------------------------------------------------- */

  const mom =
    momentum(valid);


  const recentBias =
    mom.recentBig -
    mom.recentSmall;


  const previousBias =
    mom.previousBig -
    mom.previousSmall;


  const shift =
    recentBias -
    previousBias;


  if (
    shift > 10
  ) {

    bigScore += 0.055;
  }


  if (
    shift < -10
  ) {

    smallScore += 0.055;
  }


  /* ---------------------------------------------------------
     ALTERNATION
  --------------------------------------------------------- */

  const alt =
    alternation(valid);


  if (
    alt.active &&
    alt.length >= 4
  ) {

    if (
      streak.side ===
      "BIG"
    ) {

      smallScore += 0.025;
    }


    if (
      streak.side ===
      "SMALL"
    ) {

      bigScore += 0.025;
    }
  }


  /* ---------------------------------------------------------
     REPEATING BLOCK
  --------------------------------------------------------- */

  const block =
    repeatingBlock(valid);


  if (
    block.found &&
    block.block
  ) {

    const last =
      block.block
        .split("-")
        .pop();


    if (
      last ===
      "BIG"
    ) {

      bigScore += 0.025;
    }


    if (
      last ===
      "SMALL"
    ) {

      smallScore += 0.025;
    }
  }


  /* ---------------------------------------------------------
     DIGIT
  --------------------------------------------------------- */

  const digits =
    digitStats(valid);


  if (
    digits.mostCommonDigit >= 5
  ) {

    bigScore += 0.015;

  } else {

    smallScore += 0.015;
  }


  /* ---------------------------------------------------------
     ANTI STUCK
  --------------------------------------------------------- */

  const pressure =
    pressureCache;


  if (
    pressure.side ===
      "BIG" &&
    pressure.count >= 3
  ) {

    bigScore *= 0.86;
    smallScore *= 1.04;
  }


  if (
    pressure.side ===
      "SMALL" &&
    pressure.count >= 3
  ) {

    smallScore *= 0.86;
    bigScore *= 1.04;
  }


  /* ---------------------------------------------------------
     NORMALIZE
  --------------------------------------------------------- */

  let total =
    bigScore +
    smallScore;


  if (
    total <= 0
  ) {

    return {

      prediction:
        null,

      confidence:
        0,

      classification:
        "NO CLEAR SIGNAL",

      sample,

      scores: {
        BIG: 0,
        SMALL: 0
      },

      details: {}
    };
  }


  bigScore /=
    total;


  smallScore /=
    total;


  const difference =
    Math.abs(
      bigScore -
      smallScore
    );


  /*
    VERY CLOSE SCORES
    -> Don't force prediction.
  */

  if (
    difference < 0.035
  ) {

    return {

      prediction:
        null,

      confidence:
        0,

      classification:
        "NO CLEAR SIGNAL",

      sample,

      scores: {

        BIG:
          Number(
            (
              bigScore * 100
            ).toFixed(2)
          ),

        SMALL:
          Number(
            (
              smallScore * 100
            ).toFixed(2)
          )
      },

      details: {

        windows,

        streak,

        runStats:
          runs,

        switchRate:
          Number(
            switches.toFixed(2)
          ),

        transition:
          matrix,

        momentum:
          mom,

        alternation:
          alt,

        repeatingBlock:
          block,

        digits
      }
    };
  }


  const prediction =
    bigScore >=
    smallScore
      ? "BIG"
      : "SMALL";


  /*
    Confidence.
    Never pretend 50% is a strong signal.
  */

  let confidence =
    Math.round(
      50 +
      difference * 45
    );


  if (
    sample < 20
  ) {

    confidence -= 12;

  } else if (
    sample < 30
  ) {

    confidence -= 7;

  } else if (
    sample < 50
  ) {

    confidence -= 3;
  }


  confidence =
    Math.max(
      50,
      Math.min(
        92,
        confidence
      )
    );


  /*
    If confidence remains 50-54,
    treat as unclear.
  */

  if (
    confidence < 55
  ) {

    return {

      prediction:
        null,

      confidence,

      classification:
        "NO CLEAR SIGNAL",

      sample,

      scores: {

        BIG:
          Number(
            (
              bigScore * 100
            ).toFixed(2)
          ),

        SMALL:
          Number(
            (
              smallScore * 100
            ).toFixed(2)
          )
      },

      details: {

        windows,

        streak,

        runStats:
          runs,

        switchRate:
          Number(
            switches.toFixed(2)
          ),

        transition:
          matrix,

        momentum:
          mom,

        alternation:
          alt,

        repeatingBlock:
          block,

        digits
      }
    };
  }


  let classification =
    "WEAK HISTORICAL BIAS";


  if (
    difference >= 0.25
  ) {

    classification =
      "STRONG HISTORICAL BIAS";

  } else if (
    difference >= 0.12
  ) {

    classification =
      "MODERATE HISTORICAL BIAS";
  }


  if (
    alt.active &&
    alt.length >= 5
  ) {

    classification =
      "REVERSAL WATCH";
  }


  return {

    prediction,

    confidence,

    classification,

    sample,

    scores: {

      BIG:
        Number(
          (
            bigScore * 100
          ).toFixed(2)
        ),

      SMALL:
        Number(
          (
            smallScore * 100
          ).toFixed(2)
        )
    },

    details: {

      windows,

      streak,

      runStats:
        runs,

      switchRate:
        Number(
          switches.toFixed(2)
        ),

      transition:
        matrix,

      momentum:
        mom,

      alternation:
        alt,

      repeatingBlock:
        block,

      digits
    }
  };
}


/* =========================================================
   PREDICTION RECORDS
========================================================= */

async function getLatestPrediction() {

  const result =
    await pool.query(`
      SELECT *
      FROM prediction_records
      ORDER BY id DESC
      LIMIT 1
    `);


  return (
    result.rows[0] ||
    null
  );
}


async function getPendingPredictions() {

  const result =
    await pool.query(`
      SELECT *
      FROM prediction_records
      WHERE actual_result IS NULL
      ORDER BY id ASC
    `);


  return result.rows;
}


/* =========================================================
   SETTLE PREDICTIONS
========================================================= */

async function settlePredictions(
  history
) {

  const pending =
    await getPendingPredictions();


  if (
    !pending.length
  ) {
    return;
  }


  for (
    const prediction
    of pending
  ) {

    const target =
      normalizeIssue(
        prediction.target_issue
      );


    const matched =
      history.find(
        row =>
          sameIssue(
            row.issueNumber,
            target
          )
      );


    /*
      Target result available.
    */

    if (matched) {

      const actual =
        sideFromNumber(
          matched.number
        );


      const predicted =
        String(
          prediction.prediction
        ).toUpperCase();


      const outcome =
        actual === predicted
          ? "WIN"
          : "LOSS";


      await pool.query(
        `
        UPDATE prediction_records
        SET actual_number = $1,
            actual_result = $2,
            settled_at = $3
        WHERE id = $4
        `,
        [
          matched.number,
          outcome,
          now(),
          prediction.id
        ]
      );


      continue;
    }


    /*
      Target is already behind latest
      API result but target row isn't
      available.

      Do NOT mark LOSS.
      Mark SKIPPED.
    */

    const latestIssue =
      history.length
        ? history[
            history.length - 1
          ].issueNumber
        : "";


    if (
      latestIssue &&
      compareIssues(
        latestIssue,
        target
      ) > 0
    ) {

      await pool.query(
        `
        UPDATE prediction_records
        SET actual_result = 'SKIPPED',
            settled_at = $1
        WHERE id = $2
        `,
        [
          now(),
          prediction.id
        ]
      );
    }
  }
}


/* =========================================================
   COOLDOWN
========================================================= */

async function getCooldownState(
  currentIssue
) {

  const latest =
    await getLatestPrediction();


  if (!latest) {

    return {
      active: false,
      remaining: 0,
      completed: 0
    };
  }


  /*
    Pending prediction isn't cooldown.
  */

  if (
    latest.actual_result === null
  ) {

    return {
      active: false,
      pending: true,
      remaining: 0,
      completed: 0,
      targetIssue:
        String(
          latest.target_issue
        )
    };
  }


  /*
    SKIPPED doesn't start cooldown.
  */

  if (
    latest.actual_result !==
      "WIN" &&
    latest.actual_result !==
      "LOSS"
  ) {

    return {
      active: false,
      remaining: 0,
      completed: 0
    };
  }


  const target =
    issueBigInt(
      latest.target_issue
    );


  const current =
    issueBigInt(
      currentIssue
    );


  if (
    target === null ||
    current === null
  ) {

    return {
      active: false,
      remaining: 0,
      completed: 0
    };
  }


  /*
    target 100
    current 101 -> 0
    current 102 -> 1
    ...
    current 106 -> 5
  */

  const completed =
    current > target
      ? Number(
          current - target
        )
      : 0;


  const remaining =
    Math.max(
      0,
      COOLDOWN_ROUNDS -
      completed
    );


  return {

    active:
      remaining > 0,

    pending: false,

    remaining,

    completed:
      Math.min(
        COOLDOWN_ROUNDS,
        completed
      ),

    targetIssue:
      String(
        latest.target_issue
      )
  };
}


/* =========================================================
   CREATE PREDICTION
========================================================= */

async function createPrediction(
  currentIssue,
  history
) {

  /*
    First settle old predictions.
  */

  await settlePredictions(
    history
  );


  await refreshPredictionPressure();


  let latest =
    await getLatestPrediction();


  /*
    ---------------------------------------------------------
    STALE PENDING FIX
    ---------------------------------------------------------
  */

  if (
    latest &&
    latest.actual_result === null
  ) {

    const current =
      issueBigInt(
        currentIssue
      );


    const target =
      issueBigInt(
        latest.target_issue
      );


    if (
      current !== null &&
      target !== null &&
      target <= current
    ) {

      /*
        Old prediction can no longer
        be displayed.
      */

      await pool.query(
        `
        UPDATE prediction_records
        SET actual_result = 'SKIPPED',
            settled_at = $1
        WHERE id = $2
        `,
        [
          now(),
          latest.id
        ]
      );


      latest = null;
    }
  }


  /*
    Existing valid pending prediction.
  */

  if (
    latest &&
    latest.actual_result === null
  ) {

    return {

      record:
        latest,

      analysis:
        null,

      created:
        false
    };
  }


  /*
    Check cooldown.
  */

  const cooldown =
    await getCooldownState(
      currentIssue
    );


  if (
    cooldown.active
  ) {

    return {

      record:
        null,

      analysis:
        null,

      cooldown,

      created:
        false
    };
  }


  /*
    Create target.
  */

  const targetIssue =
    nextIssue(
      currentIssue
    );


  if (!targetIssue) {

    return {

      record:
        null,

      analysis:
        null,

      created:
        false,

      error:
        "Invalid current issue"
    };
  }


  /*
    FULL ANALYSIS FIRST
  */

  const analysis =
    fullAnalysis(
      history
    );


  /*
    No clear signal:
    don't save fake prediction.
  */

  if (
    !analysis.prediction
  ) {

    return {

      record:
        null,

      analysis,

      created:
        false
    };
  }


  /*
    Save prediction.
  */

  const insert =
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
      VALUES
      ($1,$2,$3,$4,$5)
      RETURNING *
      `,
      [
        targetIssue,

        analysis.prediction,

        analysis.confidence,

        "DY-AI-SYNC-V11",

        now()
      ]
    );


  return {

    record:
      insert.rows[0],

    analysis,

    created:
      true
  };
}


/* =========================================================
   LIVE STATE
========================================================= */

async function getLiveState() {

  const wingo =
    await getWingo();


  const history =
    wingo.history
      .slice()
      .sort(
        (a, b) =>
          compareIssues(
            b.issueNumber,
            a.issueNumber
          )
      )
      .slice(
        0,
        HISTORY_SIZE
      );


  /*
    IMPORTANT:
    API current issue is our only trusted
    current issue in this server.
  */

  const currentIssue =
    normalizeIssue(
      wingo.currentIssue
    );


  if (!currentIssue) {

    return {

      ok: true,

      synced:
        false,

      syncStatus:
        "NO CURRENT ISSUE",

      currentIssue:
        "",

      history,

      model:
        null,

      predictions:
        []
    };
  }


  /*
    Create / retrieve prediction.
  */

  const result =
    await createPrediction(
      currentIssue,
      history
    );


  const cooldown =
    result.cooldown ||
    await getCooldownState(
      currentIssue
    );


  let model =
    null;


  if (
    result.record &&
    result.record.actual_result ===
      null
  ) {

    model = {

      prediction:
        String(
          result.record.prediction
        ).toUpperCase(),

      confidence:
        Number(
          result.record.confidence ||
          0
        ),

      targetIssue:
        String(
          result.record.target_issue
        ),

      classification:
        safeText(
          result.analysis?.classification ||
          "FULL AI ANALYSIS"
        ),

      modelVersion:
        String(
          result.record.model_version ||
          ""
        )
    };
  }


  /*
    Final stale safety check.
  */

  if (
    model &&
    model.targetIssue
  ) {

    const c =
      issueBigInt(
        currentIssue
      );


    const t =
      issueBigInt(
        model.targetIssue
      );


    if (
      c !== null &&
      t !== null &&
      t <= c
    ) {

      model = null;
    }
  }


  /*
    Prediction records for history table.
  */

  const predictionRows =
    await pool.query(`
      SELECT
        target_issue,
        prediction,
        confidence,
        actual_number,
        actual_result,
        created_at,
        settled_at
      FROM prediction_records
      ORDER BY id DESC
      LIMIT 100
    `);


  const predictions =
    predictionRows.rows.map(
      row => ({

        target_issue:
          String(
            row.target_issue
          ),

        prediction:
          String(
            row.prediction ||
            ""
          ).toUpperCase(),

        confidence:
          Number(
            row.confidence ||
            0
          ),

        actual_number:
          row.actual_number,

        actual_result:
          row.actual_result,

        created_at:
          row.created_at,

        settled_at:
          row.settled_at
      })
    );


  /*
    Detect API freshness from returned
    history.

    This does NOT pretend that another
    website's browser period is available.
  */

  const newestHistoryIssue =
    history.length
      ? history[0].issueNumber
      : "";


  return {

    ok: true,

    synced:
      Boolean(
        currentIssue
      ),

    syncStatus:
      currentIssue
        ? "LIVE API SYNCED"
        : "SYNCING",

    currentIssue:
      String(
        currentIssue
      ),

    apiCurrentIssue:
      String(
        currentIssue
      ),

    latestHistoryIssue:
      String(
        newestHistoryIssue
      ),

    fetchedAt:
      wingo.fetchedAt,

    sourceLastUpdated:
      wingo.sourceLastUpdated,

    history,

    predictions,

    model,

    cooldown:
      cooldown || {
        active: false,
        remaining: 0,
        completed: 0
      }
  };
}


/* =========================================================
   ADMIN KEY CREATE
========================================================= */

async function createAccessKey() {

  const key =
    crypto
      .randomBytes(12)
      .toString("hex");


  await pool.query(
    `
    INSERT INTO access_keys
    (
      access_key,
      created_at
    )
    VALUES ($1,$2)
    `,
    [
      key,
      now()
    ]
  );


  return key;
}


/* =========================================================
   HTTP SERVER
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


        /* -----------------------------------------------------
           OPTIONS
        ----------------------------------------------------- */

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
                "Content-Type, X-Access-Key, X-Device-Id, X-Admin-Key",

              "Access-Control-Allow-Methods":
                "GET,POST,DELETE,OPTIONS"
            }
          );

          return res.end();
        }


        /* -----------------------------------------------------
           HEALTH
        ----------------------------------------------------- */

        if (
          pathname ===
          "/health"
        ) {

          return json(
            res,
            200,
            {
              ok: true,
              service:
                "DY AI WinGo",
              time:
                now()
            }
          );
        }


        /* -----------------------------------------------------
           USER KEY CHECK
        ----------------------------------------------------- */

        if (
          pathname ===
            "/api/key/check" &&
          req.method ===
            "GET"
        ) {

          const auth =
            await authenticateUser(
              req
            );


          if (!auth.ok) {

            return json(
              res,
              auth.status,
              auth
            );
          }


          return json(
            res,
            200,
            {
              ok: true,
              message:
                "Access granted"
            }
          );
        }


        /* -----------------------------------------------------
           USER STATE
        ----------------------------------------------------- */

        if (
          pathname ===
            "/api/state" &&
          req.method ===
            "GET"
        ) {

          const auth =
            await authenticateUser(
              req
            );


          if (!auth.ok) {

            return json(
              res,
              auth.status,
              auth
            );
          }


          const state =
            await getLiveState();


          return json(
            res,
            200,
            state
          );
        }


        /* -----------------------------------------------------
           USER HISTORY
        ----------------------------------------------------- */

        if (
          pathname ===
            "/api/history" &&
          req.method ===
            "GET"
        ) {

          const auth =
            await authenticateUser(
              req
            );


          if (!auth.ok) {

            return json(
              res,
              auth.status,
              auth
            );
          }


          const wingo =
            await getWingo();


          return json(
            res,
            200,
            {

              ok: true,

              currentIssue:
                wingo.currentIssue,

              history:
                wingo.history
                  .slice()
                  .sort(
                    (a, b) =>
                      compareIssues(
                        b.issueNumber,
                        a.issueNumber
                      )
                  )
                  .slice(
                    0,
                    HISTORY_SIZE
                  )
            }
          );
        }


        /* =====================================================
           ADMIN
        ===================================================== */

        if (
          pathname.startsWith(
            "/api/admin/"
          )
        ) {

          if (
            !authenticateAdmin(
              req
            )
          ) {

            return json(
              res,
              403,
              {
                ok: false,
                message:
                  "Admin access denied"
              }
            );
          }


          /* ---------------------------------------------------
             ADMIN KEYS GET
          --------------------------------------------------- */

          if (
            pathname ===
              "/api/admin/keys" &&
            req.method ===
              "GET"
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


          /* ---------------------------------------------------
             ADMIN CREATE KEY
          --------------------------------------------------- */

          if (
            pathname ===
              "/api/admin/keys" &&
            req.method ===
              "POST"
          ) {

            const key =
              await createAccessKey();


            return json(
              res,
              200,
              {
                ok: true,
                access_key:
                  key
              }
            );
          }


          /* ---------------------------------------------------
             ADMIN DELETE KEY
          --------------------------------------------------- */

          if (
            pathname ===
              "/api/admin/keys" &&
            req.method ===
              "DELETE"
          ) {

            const id =
              url.searchParams.get(
                "id"
              );


            if (!id) {

              return json(
                res,
                400,
                {
                  ok: false,
                  message:
                    "Key ID required"
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


            return json(
              res,
              200,
              {
                ok: true
              }
            );
          }


          /* ---------------------------------------------------
             RESET DEVICE
          --------------------------------------------------- */

          if (
            pathname ===
              "/api/admin/reset-device" &&
            req.method ===
              "POST"
          ) {

            const id =
              url.searchParams.get(
                "id"
              );


            if (!id) {

              return json(
                res,
                400,
                {
                  ok: false,
                  message:
                    "Key ID required"
                }
              );
            }


            await pool.query(
              `
              UPDATE access_keys
              SET device_id = NULL,
                  last_seen = 0
              WHERE id = $1
              `,
              [id]
            );


            return json(
              res,
              200,
              {
                ok: true,
                message:
                  "Device reset"
              }
            );
          }


          /* ---------------------------------------------------
             ADMIN STATUS
          --------------------------------------------------- */

          if (
            pathname ===
              "/api/admin/status" &&
            req.method ===
              "GET"
          ) {

            const keys =
              await pool.query(
                `
                SELECT
                  COUNT(*)::int AS total,

                  COUNT(
                    CASE
                      WHEN last_seen > $1
                      THEN 1
                    END
                  )::int AS online
                FROM access_keys
                `,
                [
                  now() -
                  120000
                ]
              );


            const latest =
              await getLatestPrediction();


            return json(
              res,
              200,
              {

                ok: true,

                keys:
                  keys.rows[0],

                latestPrediction:
                  latest
                    ? {

                        targetIssue:
                          String(
                            latest.target_issue
                          ),

                        prediction:
                          latest.prediction,

                        confidence:
                          Number(
                            latest.confidence ||
                            0
                          ),

                        actualResult:
                          latest.actual_result
                      }
                    : null
              }
            );
          }


          /* ---------------------------------------------------
             ADMIN PING
          --------------------------------------------------- */

          if (
            pathname ===
              "/api/admin/ping" &&
            req.method ===
              "GET"
          ) {

            return json(
              res,
              200,
              {
                ok: true,
                time:
                  now()
              }
            );
          }


          /* ---------------------------------------------------
             ADMIN WINGO TEST
          --------------------------------------------------- */

          if (
            pathname ===
              "/api/admin/wingo-test" &&
            req.method ===
              "GET"
          ) {

            try {

              const data =
                await getWingo();


              return json(
                res,
                200,
                {

                  ok: true,

                  currentIssue:
                    data.currentIssue,

                  historyCount:
                    data.history.length,

                  latestHistory:
                    data.history
                      .slice(-5),

                  fetchedAt:
                    data.fetchedAt,

                  sourceLastUpdated:
                    data.sourceLastUpdated
                }
              );

            } catch (error) {

              return json(
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


          /* ---------------------------------------------------
             ADMIN MODEL TEST
          --------------------------------------------------- */

          if (
            pathname ===
              "/api/admin/model-test" &&
            req.method ===
              "GET"
          ) {

            try {

              const data =
                await getWingo();


              await refreshPredictionPressure();


              const analysis =
                fullAnalysis(
                  data.history
                );


              return json(
                res,
                200,
                {

                  ok: true,

                  currentIssue:
                    data.currentIssue,

                  analysis,

                  predictionPressure:
                    pressureCache
                }
              );

            } catch (error) {

              return json(
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


          /* ---------------------------------------------------
             ADMIN PREDICTIONS
          --------------------------------------------------- */

          if (
            pathname ===
              "/api/admin/predictions" &&
            req.method ===
              "GET"
          ) {

            const result =
              await pool.query(`
                SELECT *
                FROM prediction_records
                ORDER BY id DESC
                LIMIT 200
              `);


            return json(
              res,
              200,
              {
                ok: true,
                predictions:
                  result.rows
              }
            );
          }


          return json(
            res,
            404,
            {
              ok: false,
              message:
                "Admin endpoint not found"
            }
          );
        }


        /* =====================================================
           STATIC FILES
        ===================================================== */

        let filePath;


        if (
          pathname === "/" ||
          pathname === ""
        ) {

          filePath =
            path.join(
              __dirname,
              "prediction.html"
            );

        } else {

          const cleanPath =
            pathname
              .replace(
                /^\/+/,
                ""
              )
              .replace(
                /\.\./g,
                ""
              );


          filePath =
            path.join(
              __dirname,
              cleanPath
            );
        }


        if (
          !filePath.startsWith(
            __dirname
          )
        ) {

          return text(
            res,
            403,
            "Forbidden"
          );
        }


        if (
          fs.existsSync(
            filePath
          ) &&
          fs.statSync(
            filePath
          ).isFile()
        ) {

          const ext =
            path.extname(
              filePath
            ).toLowerCase();


          const contentTypes = {

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
              "audio/mpeg"
          };


          const contentType =
            contentTypes[ext] ||
            "application/octet-stream";


          /* ---------------------------------------------------
             MP3 RANGE
          --------------------------------------------------- */

          if (
            ext === ".mp3"
          ) {

            const stat =
              fs.statSync(
                filePath
              );


            const total =
              stat.size;


            const range =
              req.headers.range;


            if (range) {

              const match =
                range.match(
                  /bytes=(\d*)-(\d*)/
                );


              if (match) {

                let start =
                  match[1]
                    ? parseInt(
                        match[1],
                        10
                      )
                    : 0;


                let end =
                  match[2]
                    ? parseInt(
                        match[2],
                        10
                      )
                    : total - 1;


                if (
                  end >= total
                ) {

                  end =
                    total - 1;
                }


                if (
                  start >= total ||
                  start > end
                ) {

                  return text(
                    res,
                    416,
                    "Range Not Satisfiable"
                  );
                }


                const length =
                  end -
                  start +
                  1;


                res.writeHead(
                  206,
                  {

                    "Content-Range":
                      `bytes ${start}-${end}/${total}`,

                    "Accept-Ranges":
                      "bytes",

                    "Content-Length":
                      length,

                    "Content-Type":
                      contentType,

                    "Cache-Control":
                      "public, max-age=3600"
                  }
                );


                return fs
                  .createReadStream(
                    filePath,
                    {
                      start,
                      end
                    }
                  )
                  .pipe(res);
              }
            }


            res.writeHead(
              200,
              {

                "Content-Length":
                  total,

                "Content-Type":
                  contentType,

                "Accept-Ranges":
                  "bytes",

                "Cache-Control":
                  "public, max-age=3600"
              }
            );


            return fs
              .createReadStream(
                filePath
              )
              .pipe(res);
          }


          /* ---------------------------------------------------
             NORMAL STATIC FILE
          --------------------------------------------------- */

          const file =
            fs.readFileSync(
              filePath
            );


          res.writeHead(
            200,
            {

              "Content-Type":
                contentType,

              "Cache-Control":
                "no-cache"
            }
          );


          return res.end(file);
        }


        return text(
          res,
          404,
          "Not Found"
        );

      } catch (error) {

        console.error(
          "SERVER ERROR:",
          error
        );


        return json(
          res,
          500,
          {

            ok: false,

            message:
              "Internal server error",

            error:
              error.message
          }
        );
      }
    }
  );


/* =========================================================
   START SERVER
========================================================= */

async function start() {

  try {

    await initDB();


    server.listen(
      PORT,
      () => {

        console.log(
          `DY AI WinGo running on ${PORT}`
        );

        console.log(
          `Wingo API: ${WINGOBOT_URL}`
        );
      }
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
