"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

/* =========================================================
   DY AI WINGO 1 MINUTE
   COMPLETE SERVER.JS
========================================================= */

/* ---------------- CONFIG ---------------- */

const PORT = Number(process.env.PORT || 10000);

const DATABASE_URL =
  String(process.env.DATABASE_URL || "").trim();

const ADMIN_KEY =
  String(process.env.ADMIN_KEY || "dy4427574").trim();

const WINGOBOT_TOKEN =
  String(process.env.WINGOBOT_TOKEN || "").trim();

/*
  1-MINUTE WINGOBOT API
*/
const WINGOBOT_URL =
  String(
    process.env.WINGOBOT_URL ||
    "https://api.wingobot.com/v2/1-min-game-history"
  ).trim();

/*
  Optional custom live API.
  Leave empty if not required.
*/
const LIVE_API_URL =
  String(process.env.LIVE_API_URL || "").trim();

const LIVE_API_TOKEN =
  String(process.env.LIVE_API_TOKEN || "").trim();

/*
  After a prediction settles:
  5 complete rounds are skipped.
*/
const COOLDOWN_ROUNDS = Math.max(
  0,
  Number(process.env.COOLDOWN || 5)
);

/*
  Server/API polling.
*/
const POLL_MS = Math.max(
  1000,
  Number(process.env.POLL || 1000)
);

const MODEL =
  String(
    process.env.MODEL ||
    "DY-AI-1MIN-V1"
  ).trim();


/* =========================================================
   DATABASE
========================================================= */

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,

      ssl: {
        rejectUnauthorized: false
      },

      max: 5,

      idleTimeoutMillis: 30000,

      connectionTimeoutMillis: 10000
    })
  : null;


/* =========================================================
   DATABASE INIT
========================================================= */

async function initDB() {

  if (!pool) {
    console.log("DATABASE_URL missing");
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

  console.log("DATABASE READY");
}


/* =========================================================
   HELPERS
========================================================= */

function now() {
  return Date.now();
}


function json(res, status, data) {

  const body = JSON.stringify(data);

  res.writeHead(status, {
    "Content-Type":
      "application/json; charset=utf-8",

    "Cache-Control":
      "no-store, no-cache, must-revalidate, proxy-revalidate",

    "Pragma": "no-cache",

    "Expires": "0",

    "Access-Control-Allow-Origin": "*",

    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Admin-Key, X-Access-Key, X-Device-Id",

    "Access-Control-Allow-Methods":
      "GET,POST,OPTIONS"
  });

  res.end(body);
}


/* =========================================================
   ISSUE ID
   IMPORTANT:
   NEVER CONVERT LARGE ISSUE ID TO Number
========================================================= */

function normalizeIssue(value) {

  if (
    value === undefined ||
    value === null
  ) {
    return "";
  }

  return String(value).trim();
}


function compareIssue(a, b) {

  a = normalizeIssue(a);
  b = normalizeIssue(b);

  if (
    /^\d+$/.test(a) &&
    /^\d+$/.test(b)
  ) {

    try {

      const A = BigInt(a);
      const B = BigInt(b);

      if (A < B) return -1;
      if (A > B) return 1;

      return 0;

    } catch (_) {}
  }

  return a.localeCompare(
    b,
    undefined,
    {
      numeric: true
    }
  );
}


function nextIssue(issue) {

  issue = normalizeIssue(issue);

  if (!/^\d+$/.test(issue)) {
    return "";
  }

  try {
    return (BigInt(issue) + 1n).toString();
  } catch (_) {
    return "";
  }
}


function issueDistance(older, newer) {

  older = normalizeIssue(older);
  newer = normalizeIssue(newer);

  if (
    !/^\d+$/.test(older) ||
    !/^\d+$/.test(newer)
  ) {
    return null;
  }

  try {

    const A = BigInt(older);
    const B = BigInt(newer);

    if (B < A) {
      return null;
    }

    const difference = B - A;

    if (
      difference >
      BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      return null;
    }

    return Number(difference);

  } catch (_) {

    return null;
  }
}


/* =========================================================
   RESULT LOGIC
========================================================= */

function validDigit(n) {

  return (
    Number.isInteger(n) &&
    n >= 0 &&
    n <= 9
  );
}


function resultOf(number) {

  if (!validDigit(number)) {
    return null;
  }

  return number <= 4
    ? "SMALL"
    : "BIG";
}


/* =========================================================
   HTTP FETCH
========================================================= */

async function fetchJSON(url, headers = {}) {

  const controller =
    new AbortController();

  const timer =
    setTimeout(() => {
      controller.abort();
    }, 10000);

  try {

    const response =
      await fetch(url, {
        method: "GET",

        headers: {
          Accept:
            "application/json",

          ...headers
        },

        signal:
          controller.signal
      });

    const raw =
      await response.text();

    let data;

    try {

      data =
        JSON.parse(raw);

    } catch (_) {

      throw new Error(
        "INVALID_JSON_RESPONSE"
      );
    }

    if (!response.ok) {

      throw new Error(
        "HTTP_" +
        response.status
      );
    }

    return data;

  } finally {

    clearTimeout(timer);

  }
}


/* =========================================================
   PICK VALUE
========================================================= */

function pick(obj, keys) {

  if (
    !obj ||
    typeof obj !== "object"
  ) {
    return null;
  }

  for (const key of keys) {

    if (
      obj[key] !== undefined &&
      obj[key] !== null
    ) {

      return obj[key];

    }
  }

  return null;
}


/* =========================================================
   NORMALIZE API ROW
========================================================= */

function normalizeRow(row) {

  if (
    !row ||
    typeof row !== "object"
  ) {
    return null;
  }

  const issue =
    normalizeIssue(
      pick(row, [
        "issueNumber",
        "issue",
        "period",
        "periodNumber",
        "drawNumber",
        "draw_id",
        "drawId",
        "id"
      ])
    );

  let rawNumber =
    pick(row, [
      "number",
      "result",
      "digit",
      "openNumber",
      "winningNumber",
      "winning_number"
    ]);

  if (
    typeof rawNumber === "string"
  ) {

    const match =
      rawNumber.match(
        /^\s*(\d)/
      );

    if (match) {
      rawNumber =
        Number(match[1]);
    }
  }

  const number =
    Number(rawNumber);

  if (
    !issue ||
    !validDigit(number)
  ) {
    return null;
  }

  return {

    issue,

    number,

    result:
      resultOf(number),

    colour:
      pick(row, [
        "colour",
        "color"
      ]),

    premium:
      pick(row, [
        "premium"
      ]),

    sum:
      pick(row, [
        "sum"
      ])
  };
}


/* =========================================================
   EXTRACT HISTORY
========================================================= */

function extractRows(data) {

  if (Array.isArray(data)) {
    return data;
  }

  if (Array.isArray(data?.history)) {
    return data.history;
  }

  if (Array.isArray(data?.results)) {
    return data.results;
  }

  if (Array.isArray(data?.records)) {
    return data.records;
  }

  if (Array.isArray(data?.data)) {
    return data.data;
  }

  if (
    Array.isArray(
      data?.data?.history
    )
  ) {
    return data.data.history;
  }

  if (
    Array.isArray(
      data?.data?.results
    )
  ) {
    return data.data.results;
  }

  return [];
}


/* =========================================================
   LIVE CACHE
========================================================= */

let liveCache = {

  rows: [],

  currentIssue: "",

  fetchedAt: 0,

  source: "NONE",

  error: null

};


/* =========================================================
   WINGOBOT 1 MINUTE API
========================================================= */

async function fetchWingoBot() {

  if (!WINGOBOT_TOKEN) {

    throw new Error(
      "WINGOBOT_TOKEN_NOT_CONFIGURED"
    );
  }

  const data =
    await fetchJSON(
      WINGOBOT_URL,
      {
        Authorization:
          "Bearer " +
          WINGOBOT_TOKEN
      }
    );

  if (
    data &&
    data.success === false
  ) {

    throw new Error(
      data.error ||
      "WINGOBOT_API_ERROR"
    );
  }

  const rawRows =
    extractRows(data);

  const rows =
    rawRows
      .map(normalizeRow)
      .filter(Boolean)
      .sort(
        (a, b) =>
          compareIssue(
            a.issue,
            b.issue
          )
      );

  const current =
    normalizeIssue(
      data?.current?.issueNumber ||
      data?.current?.issue ||
      data?.currentIssue ||
      data?.issueNumber ||
      ""
    );

  if (!rows.length) {

    throw new Error(
      "WINGOBOT_NO_VALID_HISTORY"
    );
  }

  return {

    rows,

    currentIssue:
      current ||
      rows[
        rows.length - 1
      ].issue,

    source:
      "WINGOBOT_1MIN"
  };
}


/* =========================================================
   OPTIONAL CUSTOM API
========================================================= */

async function fetchCustomAPI() {

  if (!LIVE_API_URL) {

    throw new Error(
      "CUSTOM_API_DISABLED"
    );
  }

  const headers = {};

  if (LIVE_API_TOKEN) {

    headers.Authorization =
      "Bearer " +
      LIVE_API_TOKEN;
  }

  const data =
    await fetchJSON(
      LIVE_API_URL,
      headers
    );

  const rows =
    extractRows(data)
      .map(normalizeRow)
      .filter(Boolean)
      .sort(
        (a, b) =>
          compareIssue(
            a.issue,
            b.issue
          )
      );

  if (!rows.length) {

    throw new Error(
      "CUSTOM_API_NO_VALID_HISTORY"
    );
  }

  const current =
    normalizeIssue(
      data?.current?.issueNumber ||
      data?.current?.issue ||
      data?.currentIssue ||
      ""
    );

  return {

    rows,

    currentIssue:
      current ||
      rows[
        rows.length - 1
      ].issue,

    source:
      "CUSTOM_API"
  };
}


/* =========================================================
   REFRESH LIVE API
========================================================= */

async function refreshLive() {

  let result = null;
  let lastError = null;

  /*
    Custom API first if configured.
  */

  if (LIVE_API_URL) {

    try {

      result =
        await fetchCustomAPI();

    } catch (error) {

      lastError =
        error.message;

      console.log(
        "CUSTOM API:",
        error.message
      );
    }
  }

  /*
    WingoBot 1-minute API.
  */

  if (!result) {

    try {

      result =
        await fetchWingoBot();

      lastError = null;

    } catch (error) {

      lastError =
        error.message;

      console.log(
        "WINGOBOT 1MIN:",
        error.message
      );
    }
  }

  if (result) {

    liveCache = {

      rows:
        result.rows.slice(-500),

      currentIssue:
        result.currentIssue,

      fetchedAt:
        now(),

      source:
        result.source,

      error:
        null
    };

  } else {

    liveCache.error =
      lastError ||
      "LIVE_DATA_UNAVAILABLE";
  }

  return liveCache;
}


/* =========================================================
   STATISTICS
========================================================= */

function average(values) {

  if (!values.length) {
    return 0;
  }

  return (
    values.reduce(
      (a, b) =>
        a + b,
      0
    ) /
    values.length
  );
}


function median(values) {

  if (!values.length) {
    return 0;
  }

  const arr =
    [...values].sort(
      (a, b) =>
        a - b
    );

  const mid =
    Math.floor(
      arr.length / 2
    );

  if (
    arr.length % 2
  ) {
    return arr[mid];
  }

  return (
    arr[mid - 1] +
    arr[mid]
  ) / 2;
}


function percentage(a, b) {

  if (!b) {
    return 0;
  }

  return (
    a / b
  ) * 100;
}


/* =========================================================
   SWITCH ANALYSIS
========================================================= */

function countSwitches(seq) {

  let count = 0;

  for (
    let i = 1;
    i < seq.length;
    i++
  ) {

    if (
      seq[i] !==
      seq[i - 1]
    ) {

      count++;

    }
  }

  return count;
}


/* =========================================================
   STREAK ANALYSIS
========================================================= */

function streakInfo(seq) {

  if (!seq.length) {

    return {

      current: null,

      currentLength: 0,

      longestBig: 0,

      longestSmall: 0,

      averageBig: 0,

      averageSmall: 0

    };
  }

  const current =
    seq[
      seq.length - 1
    ];

  let currentLength = 1;

  for (
    let i =
      seq.length - 2;
    i >= 0;
    i--
  ) {

    if (
      seq[i] ===
      current
    ) {

      currentLength++;

    } else {

      break;

    }
  }

  const runs = [];

  let side =
    seq[0];

  let length = 1;

  for (
    let i = 1;
    i < seq.length;
    i++
  ) {

    if (
      seq[i] ===
      side
    ) {

      length++;

    } else {

      runs.push({
        side,
        length
      });

      side =
        seq[i];

      length = 1;
    }
  }

  runs.push({
    side,
    length
  });

  const bigRuns =
    runs
      .filter(
        x =>
          x.side ===
          "BIG"
      )
      .map(
        x =>
          x.length
      );

  const smallRuns =
    runs
      .filter(
        x =>
          x.side ===
          "SMALL"
      )
      .map(
        x =>
          x.length
      );

  return {

    current,

    currentLength,

    longestBig:
      bigRuns.length
        ? Math.max(
            ...bigRuns
          )
        : 0,

    longestSmall:
      smallRuns.length
        ? Math.max(
            ...smallRuns
          )
        : 0,

    averageBig:
      Number(
        average(
          bigRuns
        ).toFixed(2)
      ),

    averageSmall:
      Number(
        average(
          smallRuns
        ).toFixed(2)
      )
  };
}


/* =========================================================
   TRANSITION MATRIX
========================================================= */

function transitionMatrix(seq) {

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
    let i = 1;
    i < seq.length;
    i++
  ) {

    const from =
      seq[i - 1];

    const to =
      seq[i];

    if (
      matrix[from] &&
      matrix[from][to] !==
        undefined
    ) {

      matrix[from][to]++;

    }
  }

  return matrix;
}


/* =========================================================
   DIGIT ANALYSIS
========================================================= */

function digitAnalysis(rows) {

  const frequency =
    Array(10).fill(0);

  const gaps =
    Array(10).fill(null);

  const numbers =
    rows.map(
      row =>
        row.number
    );

  for (
    const number of
    numbers
  ) {

    if (
      validDigit(number)
    ) {

      frequency[number]++;

    }
  }

  for (
    let digit = 0;
    digit <= 9;
    digit++
  ) {

    let gap = 0;
    let found = false;

    for (
      let i =
        rows.length - 1;
      i >= 0;
      i--
    ) {

      if (
        rows[i].number ===
        digit
      ) {

        found = true;
        break;
      }

      gap++;
    }

    gaps[digit] =
      found
        ? gap
        : null;
  }

  return {

    frequency,

    gaps,

    average:
      Number(
        average(
          numbers
        ).toFixed(2)
      ),

    median:
      Number(
        median(
          numbers
        ).toFixed(2)
      )
  };
}


/* =========================================================
   PATTERN ANALYSIS
========================================================= */

function patternAnalysis(seq) {

  const recent =
    seq.slice(-12);

  const output = {

    recentPattern:
      recent.join(""),

    alternating:
      false,

    alternatingLength:
      0,

    repeatedBlocks: []

  };

  if (
    recent.length >= 6
  ) {

    let alternating =
      true;

    for (
      let i = 1;
      i < recent.length;
      i++
    ) {

      if (
        recent[i] ===
        recent[i - 1]
      ) {

        alternating =
          false;

        break;
      }
    }

    if (alternating) {

      output.alternating =
        true;

      output.alternatingLength =
        recent.length;
    }
  }

  for (
    let size = 2;
    size <= 6;
    size++
  ) {

    if (
      seq.length <
      size * 2
    ) {
      continue;
    }

    const first =
      seq
        .slice(-size)
        .join("");

    const second =
      seq
        .slice(
          -size * 2,
          -size
        )
        .join("");

    if (
      first ===
      second
    ) {

      output
        .repeatedBlocks
        .push(size);
    }
  }

  return output;
}


/* =========================================================
   FULL AI ANALYSIS
========================================================= */

function analyze(rows) {

  const validRows =
    rows
      .filter(
        row =>
          row &&
          validDigit(
            row.number
          )
      )
      .sort(
        (a, b) =>
          compareIssue(
            a.issue,
            b.issue
          )
      );

  /*
    Maximum analysis history:
    100 results.
  */

  const data =
    validRows.slice(-100);

  const seq =
    data.map(
      row =>
        row.result
    );

  const total =
    seq.length;

  if (
    total < 10
  ) {

    return {

      prediction:
        "SKIP",

      confidence:
        0,

      classification:
        "INSUFFICIENT DATA",

      total,

      big: 0,

      small: 0,

      bigPct: 0,

      smallPct: 0,

      switchRate: 0,

      streak: null

    };
  }

  const big =
    seq.filter(
      x =>
        x === "BIG"
    ).length;

  const small =
    total -
    big;

  const bigPct =
    percentage(
      big,
      total
    );

  const smallPct =
    percentage(
      small,
      total
    );

  const switches =
    countSwitches(seq);

  const switchRate =
    percentage(
      switches,
      Math.max(
        1,
        total - 1
      )
    );

  const streak =
    streakInfo(seq);

  const transitions =
    transitionMatrix(seq);

  const patterns =
    patternAnalysis(seq);

  const digits =
    digitAnalysis(data);


  /* =====================================================
     SCORE ENGINE
  ===================================================== */

  let bigScore = 0;
  let smallScore = 0;


  /* -----------------------------------------------------
     RECENT WINDOWS
  ----------------------------------------------------- */

  const windows = [
    5,
    10,
    20,
    30,
    50
  ];

  const weights = [
    35,
    25,
    20,
    12,
    8
  ];

  let weightedBig = 0;
  let weightedSmall = 0;

  for (
    let i = 0;
    i < windows.length;
    i++
  ) {

    const window =
      seq.slice(
        -windows[i]
      );

    if (!window.length) {
      continue;
    }

    const wb =
      window.filter(
        x =>
          x === "BIG"
      ).length;

    const ws =
      window.length -
      wb;

    weightedBig +=
      (
        wb /
        window.length
      ) *
      weights[i];

    weightedSmall +=
      (
        ws /
        window.length
      ) *
      weights[i];
  }

  bigScore +=
    weightedBig /
    100 *
    2;

  smallScore +=
    weightedSmall /
    100 *
    2;


  /* -----------------------------------------------------
     OVERALL FREQUENCY
  ----------------------------------------------------- */

  if (
    bigPct >
    smallPct
  ) {

    bigScore +=
      0.60;

  } else if (
    smallPct >
    bigPct
  ) {

    smallScore +=
      0.60;
  }


  /* -----------------------------------------------------
     MOMENTUM
  ----------------------------------------------------- */

  const recent10 =
    seq.slice(-10);

  const previous10 =
    seq.slice(
      -20,
      -10
    );

  if (
    recent10.length >= 5 &&
    previous10.length >= 5
  ) {

    const recentBig =
      recent10.filter(
        x =>
          x === "BIG"
      ).length;

    const previousBig =
      previous10.filter(
        x =>
          x === "BIG"
      ).length;

    const momentum =
      recentBig -
      previousBig;

    if (
      momentum > 0
    ) {

      bigScore +=
        Math.min(
          0.8,
          momentum *
          0.16
        );

    } else if (
      momentum < 0
    ) {

      smallScore +=
        Math.min(
          0.8,
          Math.abs(
            momentum
          ) *
          0.16
        );
    }
  }


  /* -----------------------------------------------------
     TRANSITION
  ----------------------------------------------------- */

  const last =
    seq[
      seq.length - 1
    ];

  if (
    transitions[last]
  ) {

    const same =
      transitions[last][last];

    const opposite =
      last === "BIG"
        ? transitions[last].SMALL
        : transitions[last].BIG;

    const transitionTotal =
      same +
      opposite;

    if (
      transitionTotal >= 4
    ) {

      if (
        same >
        opposite
      ) {

        if (
          last === "BIG"
        ) {

          bigScore +=
            0.55;

        } else {

          smallScore +=
            0.55;
        }

      } else if (
        opposite >
        same
      ) {

        if (
          last === "BIG"
        ) {

          smallScore +=
            0.55;

        } else {

          bigScore +=
            0.55;
        }
      }
    }
  }


  /* -----------------------------------------------------
     STREAK
  ----------------------------------------------------- */

  if (
    streak.current ===
    "BIG"
  ) {

    if (
      streak.currentLength >=
      4
    ) {

      /*
        Historical reversal WATCH.
        Not guaranteed reversal.
      */

      smallScore +=
        Math.min(
          0.90,
          streak.currentLength *
          0.14
        );

    } else {

      bigScore +=
        0.15;
    }
  }


  if (
    streak.current ===
    "SMALL"
  ) {

    if (
      streak.currentLength >=
      4
    ) {

      bigScore +=
        Math.min(
          0.90,
          streak.currentLength *
          0.14
        );

    } else {

      smallScore +=
        0.15;
    }
  }


  /* -----------------------------------------------------
     SWITCHING
  ----------------------------------------------------- */

  if (
    switchRate >= 60
  ) {

    if (
      last === "BIG"
    ) {

      smallScore +=
        0.30;

    } else {

      bigScore +=
        0.30;
    }

  } else if (
    switchRate < 40
  ) {

    if (
      last === "BIG"
    ) {

      bigScore +=
        0.25;

    } else {

      smallScore +=
        0.25;
    }
  }


  /* -----------------------------------------------------
     ALTERNATION
  ----------------------------------------------------- */

  if (
    patterns.alternating
  ) {

    if (
      last === "BIG"
    ) {

      smallScore +=
        0.45;

    } else {

      bigScore +=
        0.45;
    }
  }


  /* -----------------------------------------------------
     REPEATED BLOCK
  ----------------------------------------------------- */

  for (
    const size of
    patterns.repeatedBlocks
  ) {

    const block =
      seq.slice(-size);

    if (!block.length) {
      continue;
    }

    const lastBlock =
      block[
        block.length - 1
      ];

    if (
      lastBlock ===
      "BIG"
    ) {

      smallScore +=
        0.10;

    } else {

      bigScore +=
        0.10;
    }
  }


  /* -----------------------------------------------------
     DIGIT LEVEL
  ----------------------------------------------------- */

  const recentNumbers =
    data
      .slice(-10)
      .map(
        x =>
          x.number
      );

  const recentAverage =
    average(
      recentNumbers
    );

  if (
    recentAverage >=
    5.5
  ) {

    bigScore +=
      0.20;

  } else if (
    recentAverage <=
    3.5
  ) {

    smallScore +=
      0.20;
  }


  /* -----------------------------------------------------
     CONTRADICTION
  ----------------------------------------------------- */

  const difference =
    Math.abs(
      bigScore -
      smallScore
    );

  if (
    difference <
    0.25
  ) {

    bigScore *=
      0.90;

    smallScore *=
      0.90;
  }


  /* -----------------------------------------------------
     FINAL PREDICTION
  ----------------------------------------------------- */

  const prediction =
    bigScore >=
    smallScore
      ? "BIG"
      : "SMALL";


  /*
    Confidence = model strength,
    NOT guaranteed win probability.
  */

  let confidence =
    50 +
    Math.abs(
      bigScore -
      smallScore
    ) *
    9;


  /*
    Sample-size penalty.
  */

  if (
    total < 20
  ) {

    confidence =
      Math.min(
        confidence,
        62
      );

  } else if (
    total < 30
  ) {

    confidence =
      Math.min(
        confidence,
        70
      );
  }


  confidence =
    Math.round(
      Math.max(
        50,
        Math.min(
          92,
          confidence
        )
      )
    );


  /* -----------------------------------------------------
     CLASSIFICATION
  ----------------------------------------------------- */

  let classification =
    "MIXED / CONFLICTING";

  if (
    total < 20
  ) {

    classification =
      "LOW DATA";

  } else if (
    difference < 0.30
  ) {

    classification =
      "NO CLEAR SIGNAL";

  } else if (
    difference < 0.60
  ) {

    classification =
      "WEAK HISTORICAL BIAS";

  } else if (
    difference < 1.00
  ) {

    classification =
      "MODERATE HISTORICAL BIAS";

  } else {

    classification =
      "STRONG HISTORICAL BIAS";
  }


  if (
    streak.currentLength >= 5 &&
    difference >= 0.35
  ) {

    classification =
      "REVERSAL WATCH";
  }


  return {

    prediction,

    confidence,

    classification,

    total,

    big,

    small,

    bigPct:
      Number(
        bigPct.toFixed(2)
      ),

    smallPct:
      Number(
        smallPct.toFixed(2)
      ),

    switchRate:
      Number(
        switchRate.toFixed(2)
      ),

    streak,

    recent5:
      seq.slice(-5),

    recent10:
      seq.slice(-10),

    recent20:
      seq.slice(-20),

    weighted: {

      big:
        Number(
          weightedBig.toFixed(2)
        ),

      small:
        Number(
          weightedSmall.toFixed(2)
        )
    },

    scores: {

      big:
        Number(
          bigScore.toFixed(3)
        ),

      small:
        Number(
          smallScore.toFixed(3)
        )
    },

    transitions,

    patterns,

    digits,

    recentAverage:
      Number(
        recentAverage.toFixed(2)
      )
  };
}


/* =========================================================
   PREDICTION DATABASE
========================================================= */

async function getPendingPrediction() {

  if (!pool) {
    return null;
  }

  const result =
    await pool.query(`
      SELECT *
      FROM prediction_records
      WHERE actual_result IS NULL
      ORDER BY id DESC
      LIMIT 1
    `);

  return (
    result.rows[0] ||
    null
  );
}


async function getLatestPrediction() {

  if (!pool) {
    return null;
  }

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


/* =========================================================
   CREATE PREDICTION
========================================================= */

async function createPrediction(
  targetIssue,
  analysis
) {

  if (
    !pool ||
    !targetIssue ||
    !analysis
  ) {
    return null;
  }

  if (
    analysis.prediction !==
      "BIG" &&
    analysis.prediction !==
      "SMALL"
  ) {
    return null;
  }

  const existing =
    await pool.query(
      `
      SELECT *
      FROM prediction_records
      WHERE target_issue = $1
      AND actual_result IS NULL
      LIMIT 1
      `,
      [
        targetIssue
      ]
    );

  if (
    existing.rows.length
  ) {

    return existing.rows[0];
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
      VALUES
      ($1,$2,$3,$4,$5)
      RETURNING *
      `,
      [
        targetIssue,

        analysis.prediction,

        Number(
          analysis.confidence ||
          0
        ),

        MODEL,

        now()
      ]
    );

  return (
    result.rows[0] ||
    null
  );
}


/* =========================================================
   SETTLE
========================================================= */

async function settlePrediction(
  prediction,
  actualRow
) {

  if (
    !pool ||
    !prediction ||
    !actualRow
  ) {
    return prediction;
  }

  if (
    prediction.actual_result
  ) {
    return prediction;
  }

  const status =
    prediction.prediction ===
      actualRow.result
      ? "WIN"
      : "LOSS";

  const result =
    await pool.query(
      `
      UPDATE prediction_records
      SET
        actual_number = $1,
        actual_result = $2,
        settled_at = $3
      WHERE id = $4
      AND actual_result IS NULL
      RETURNING *
      `,
      [
        actualRow.number,

        status,

        now(),

        prediction.id
      ]
    );

  return (
    result.rows[0] ||
    prediction
  );
}


/* =========================================================
   STALE PREDICTION
========================================================= */

async function cleanupStale(
  latestIssue,
  rows
) {

  if (
    !pool ||
    !latestIssue
  ) {
    return;
  }

  const pending =
    await getPendingPrediction();

  if (!pending) {
    return;
  }

  if (
    compareIssue(
      pending.target_issue,
      latestIssue
    ) >= 0
  ) {
    return;
  }

  const actualRow =
    rows.find(
      row =>
        compareIssue(
          row.issue,
          pending.target_issue
        ) === 0
    );

  if (actualRow) {

    await settlePrediction(
      pending,
      actualRow
    );

    return;
  }

  /*
    Target result is no longer available
    in API history.
  */

  await pool.query(
    `
    UPDATE prediction_records
    SET
      actual_result = 'SKIPPED',
      settled_at = $1
    WHERE id = $2
    AND actual_result IS NULL
    `,
    [
      now(),
      pending.id
    ]
  );
}


/* =========================================================
   COOLDOWN
========================================================= */

async function getCooldown(
  latestIssue
) {

  if (
    !pool ||
    !latestIssue
  ) {

    return {

      active: false,

      wait: 0,

      completed: 0
    };
  }

  const last =
    await getLatestPrediction();

  if (!last) {

    return {

      active: false,

      wait: 0,

      completed: 0
    };
  }

  /*
    Current prediction is still pending.
  */

  if (
    !last.actual_result
  ) {

    return {

      active: false,

      wait: 0,

      completed: 0,

      pending: true
    };
  }

  /*
    SKIPPED doesn't start cooldown.
  */

  if (
    last.actual_result !==
      "WIN" &&
    last.actual_result !==
      "LOSS"
  ) {

    return {

      active: false,

      wait: 0,

      completed: 0
    };
  }

  const distance =
    issueDistance(
      last.target_issue,
      latestIssue
    );

  if (
    distance === null
  ) {

    return {

      active: false,

      wait: 0,

      completed: 0
    };
  }

  /*
    Example:

    Prediction = 100

    101 = wait
    102 = wait
    103 = wait
    104 = wait
    105 = wait

    New prediction = 106
  */

  const completed =
    Math.max(
      0,
      distance
    );

  if (
    completed <=
    COOLDOWN_ROUNDS
  ) {

    return {

      active: true,

      wait:
        Math.max(
          0,
          COOLDOWN_ROUNDS -
          completed +
          1
        ),

      completed
    };
  }

  return {

    active: false,

    wait: 0,

    completed
  };
}


/* =========================================================
   BUILD STATE
========================================================= */

async function buildState() {

  await refreshLive();

  const rows =
    liveCache.rows || [];

  const latest =
    rows.length
      ? rows[
          rows.length - 1
        ]
      : null;

  const latestIssue =
    latest
      ? latest.issue
      : "";

  const sourceCurrentIssue =
    normalizeIssue(
      liveCache.currentIssue
    );


  /*
    First clean old pending prediction.
  */

  await cleanupStale(
    latestIssue,
    rows
  );


  /*
    Try to settle current prediction.
  */

  let pending =
    await getPendingPrediction();

  if (pending) {

    const actual =
      rows.find(
        row =>
          compareIssue(
            row.issue,
            pending.target_issue
          ) === 0
      );

    if (actual) {

      pending =
        await settlePrediction(
          pending,
          actual
        );
    }
  }


  /*
    Fresh analysis.
  */

  const analysis =
    analyze(rows);


  /*
    Current cooldown.
  */

  let cooldown =
    await getCooldown(
      latestIssue
    );


  /*
    Reload pending after settlement.
  */

  pending =
    await getPendingPrediction();


  /*
    Never display an old target.
  */

  if (
    pending &&
    latestIssue &&
    compareIssue(
      pending.target_issue,
      latestIssue
    ) <= 0
  ) {

    pending = null;
  }


  /*
    Create a NEW prediction only when:
    - no pending
    - cooldown complete
    - enough data
    - analysis gives BIG/SMALL
  */

  if (
    !pending &&
    !cooldown.active &&
    latestIssue &&
    rows.length >= 10 &&
    (
      analysis.prediction ===
        "BIG" ||
      analysis.prediction ===
        "SMALL"
    )
  ) {

    const target =
      nextIssue(
        latestIssue
      );

    if (target) {

      pending =
        await createPrediction(
          target,
          analysis
        );
    }
  }


  /*
    Recalculate cooldown.
  */

  cooldown =
    await getCooldown(
      latestIssue
    );


  /*
    LAST 30 RESULTS
  */

  const last30 =
    rows
      .slice(-30)
      .reverse()
      .map(
        row => ({

          issue:
            row.issue,

          number:
            row.number,

          result:
            row.result,

          colour:
            row.colour,

          premium:
            row.premium,

          sum:
            row.sum
        })
      );


  /*
    PREDICTION HISTORY
  */

  let history = [];

  if (pool) {

    const result =
      await pool.query(`
        SELECT *
        FROM prediction_records
        ORDER BY id DESC
        LIMIT 100
      `);

    history =
      result.rows;
  }


  return {

    ok: true,

    game:
      "WINGO 1 MINUTE",

    model:
      MODEL,

    serverTime:
      now(),

    poll:
      POLL_MS,

    source:
      liveCache.source,

    fetchedAt:
      liveCache.fetchedAt,

    liveError:
      liveCache.error,

    sourceCurrentIssue,

    currentIssue:
      latestIssue,

    latest,

    nextIssue:
      nextIssue(
        latestIssue
      ),

    dataCount:
      rows.length,

    analysis,

    prediction:
      pending
        ? {

            id:
              pending.id,

            targetIssue:
              pending.target_issue,

            prediction:
              pending.prediction,

            confidence:
              pending.confidence,

            model:
              pending.model_version,

            actualNumber:
              pending.actual_number,

            status:
              pending.actual_result
          }
        : null,

    cooldown,

    last30,

    history
  };
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
            chunk;

          if (
            body.length >
            1024 * 1024
          ) {

            reject(
              new Error(
                "BODY_TOO_LARGE"
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
              JSON.parse(
                body
              )
            );

          } catch (_) {

            reject(
              new Error(
                "INVALID_JSON"
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
   ADMIN AUTH
========================================================= */

function isAdmin(
  req,
  url
) {

  const queryKey =
    String(
      url.searchParams.get(
        "key"
      ) || ""
    ).trim();

  const headerKey =
    String(
      req.headers[
        "x-admin-key"
      ] || ""
    ).trim();

  const authorization =
    String(
      req.headers[
        "authorization"
      ] || ""
    ).trim();

  let bearer = "";

  if (
    authorization
      .toLowerCase()
      .startsWith(
        "bearer "
      )
  ) {

    bearer =
      authorization
        .slice(7)
        .trim();
  }

  return (
    queryKey === ADMIN_KEY ||
    headerKey === ADMIN_KEY ||
    bearer === ADMIN_KEY
  );
}


/* =========================================================
   ACCESS KEY AUTH
========================================================= */

async function checkAccessKey(
  req,
  url
) {

  if (!pool) {

    return {

      status: 500,

      data: {

        ok: false,

        valid: false,

        error:
          "DATABASE_NOT_CONFIGURED"
      }
    };
  }

  let body = {};

  if (
    req.method ===
    "POST"
  ) {

    try {

      body =
        await readBody(req);

    } catch (error) {

      return {

        status: 400,

        data: {

          ok: false,

          valid: false,

          error:
            error.message
        }
      };
    }
  }

  const queryKey =
    String(
      url.searchParams.get(
        "key"
      ) || ""
    ).trim();

  const queryDevice =
    String(
      url.searchParams.get(
        "deviceId"
      ) || ""
    ).trim();

  const headerKey =
    String(
      req.headers[
        "x-access-key"
      ] || ""
    ).trim();

  const headerDevice =
    String(
      req.headers[
        "x-device-id"
      ] || ""
    ).trim();

  const accessKey =
    String(
      body.key ||
      queryKey ||
      headerKey ||
      ""
    ).trim();

  const deviceId =
    String(
      body.deviceId ||
      queryDevice ||
      headerDevice ||
      ""
    ).trim();

  if (!accessKey) {

    return {

      status: 400,

      data: {

        ok: false,

        valid: false,

        error:
          "ACCESS_KEY_REQUIRED"
      }
    };
  }

  if (!deviceId) {

    return {

      status: 400,

      data: {

        ok: false,

        valid: false,

        error:
          "DEVICE_ID_REQUIRED"
      }
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
      [
        accessKey
      ]
    );

  if (
    !result.rows.length
  ) {

    return {

      status: 401,

      data: {

        ok: false,

        valid: false,

        error:
          "INVALID_ACCESS_KEY"
      }
    };
  }

  const row =
    result.rows[0];

  if (
    row.device_id &&
    row.device_id !==
      deviceId
  ) {

    return {

      status: 403,

      data: {

        ok: false,

        valid: false,

        error:
          "KEY_BOUND_TO_OTHER_DEVICE"
      }
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
      deviceId,
      now(),
      row.id
    ]
  );

  return {

    status: 200,

    data: {

      ok: true,

      valid: true,

      message:
        "ACCESS_KEY_VALID"
    }
  };
}


/* =========================================================
   STATIC FILE
========================================================= */

function serveFile(
  res,
  filePath,
  contentType
) {

  if (
    !fs.existsSync(
      filePath
    )
  ) {

    return json(
      res,
      404,
      {

        ok: false,

        error:
          "FILE_NOT_FOUND",

        file:
          path.basename(
            filePath
          )
      }
    );
  }

  const data =
    fs.readFileSync(
      filePath
    );

  res.writeHead(
    200,
    {

      "Content-Type":
        contentType,

      "Cache-Control":
        "no-cache, no-store, must-revalidate",

      "Pragma":
        "no-cache",

      "Expires":
        "0"
    }
  );

  res.end(data);
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

        /* -------------------------------------------------
           OPTIONS
        ------------------------------------------------- */

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
                "Content-Type, Authorization, X-Admin-Key, X-Access-Key, X-Device-Id",

              "Access-Control-Allow-Methods":
                "GET,POST,OPTIONS"
            }
          );

          return res.end();
        }


        const url =
          new URL(
            req.url,
            `http://${req.headers.host}`
          );

        const p =
          url.pathname;


        /* -------------------------------------------------
           HEALTH
        ------------------------------------------------- */

        if (
          p === "/health"
        ) {

          return json(
            res,
            200,
            {

              ok: true,

              game:
                "WINGO 1 MINUTE",

              model:
                MODEL,

              uptime:
                process.uptime(),

              database:
                !!pool,

              wingoBot:
                !!WINGOBOT_TOKEN,

              source:
                liveCache.source,

              currentIssue:
                liveCache.currentIssue,

              resultCount:
                liveCache.rows.length,

              time:
                now()
            }
          );
        }


        /* -------------------------------------------------
           PREDICTION PAGE
        ------------------------------------------------- */

        if (
          p === "/" ||
          p === "/prediction.html"
        ) {

          return serveFile(
            res,

            path.join(
              process.cwd(),
              "prediction.html"
            ),

            "text/html; charset=utf-8"
          );
        }


        /* -------------------------------------------------
           ADMIN PAGE
        ------------------------------------------------- */

        if (
          p === "/admin.html"
        ) {

          return serveFile(
            res,

            path.join(
              process.cwd(),
              "admin.html"
            ),

            "text/html; charset=utf-8"
          );
        }


        /* -------------------------------------------------
           ACCESS KEY CHECK
        ------------------------------------------------- */

        if (
          p === "/api/key/check" &&
          (
            req.method ===
              "GET" ||
            req.method ===
              "POST"
          )
        ) {

          const result =
            await checkAccessKey(
              req,
              url
            );

          return json(
            res,
            result.status,
            result.data
          );
        }


        /* -------------------------------------------------
           STATE
        ------------------------------------------------- */

        if (
          p === "/api/state" &&
          req.method === "GET"
        ) {

          const access =
            await checkAccessKey(
              req,
              url
            );

          if (
            !access.data.valid
          ) {

            return json(
              res,
              access.status,
              access.data
            );
          }

          const state =
            await buildState();

          return json(
            res,
            200,
            state
          );
        }


        /* -------------------------------------------------
           ADMIN PING
        ------------------------------------------------- */

        if (
          p === "/api/admin/ping"
        ) {

          if (
            !isAdmin(
              req,
              url
            )
          ) {

            return json(
              res,
              401,
              {

                ok: false,

                error:
                  "UNAUTHORIZED"
              }
            );
          }

          return json(
            res,
            200,
            {

              ok: true,

              pong: true,

              game:
                "WINGO 1 MINUTE",

              time:
                now()
            }
          );
        }


        /* -------------------------------------------------
           ADMIN STATUS
        ------------------------------------------------- */

        if (
          p === "/api/admin/status"
        ) {

          if (
            !isAdmin(
              req,
              url
            )
          ) {

            return json(
              res,
              401,
              {

                ok: false,

                error:
                  "UNAUTHORIZED"
              }
            );
          }

          return json(
            res,
            200,
            {

              ok: true,

              game:
                "WINGO 1 MINUTE",

              model:
                MODEL,

              serverTime:
                now(),

              uptime:
                process.uptime(),

              database:
                !!pool,

              wingoBotConfigured:
                !!WINGOBOT_TOKEN,

              wingoBotURL:
                WINGOBOT_URL,

              source:
                liveCache.source,

              fetchedAt:
                liveCache.fetchedAt,

              currentIssue:
                liveCache.currentIssue,

              resultCount:
                liveCache.rows.length,

              error:
                liveCache.error,

              cooldown:
                COOLDOWN_ROUNDS
            }
          );
        }


        /* -------------------------------------------------
           LIVE API TEST
        ------------------------------------------------- */

        if (
          p ===
          "/api/admin/live-test"
        ) {

          if (
            !isAdmin(
              req,
              url
            )
          ) {

            return json(
              res,
              401,
              {

                ok: false,

                error:
                  "UNAUTHORIZED"
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

                game:
                  "WINGO 1 MINUTE",

                source:
                  data.source,

                api:
                  WINGOBOT_URL,

                currentIssue:
                  data.currentIssue,

                count:
                  data.rows.length,

                rows:
                  data.rows.slice(-30)
              }
            );

          } catch (error) {

            return json(
              res,
              200,
              {

                ok: false,

                game:
                  "WINGO 1 MINUTE",

                api:
                  WINGOBOT_URL,

                error:
                  error.message
              }
            );
          }
        }


        /* -------------------------------------------------
           MODEL TEST
        ------------------------------------------------- */

        if (
          p ===
          "/api/admin/model-test"
        ) {

          if (
            !isAdmin(
              req,
              url
            )
          ) {

            return json(
              res,
              401,
              {

                ok: false,

                error:
                  "UNAUTHORIZED"
              }
            );
          }

          await refreshLive();

          return json(
            res,
            200,
            {

              ok: true,

              game:
                "WINGO 1 MINUTE",

              model:
                MODEL,

              source:
                liveCache.source,

              currentIssue:
                liveCache.currentIssue,

              dataCount:
                liveCache.rows.length,

              analysis:
                analyze(
                  liveCache.rows
                )
            }
          );
        }


        /* -------------------------------------------------
           ADMIN KEYS GET
        ------------------------------------------------- */

        if (
          p ===
            "/api/admin/keys" &&
          req.method === "GET"
        ) {

          if (
            !isAdmin(
              req,
              url
            )
          ) {

            return json(
              res,
              401,
              {

                ok: false,

                error:
                  "UNAUTHORIZED"
              }
            );
          }

          if (!pool) {

            return json(
              res,
              500,
              {

                ok: false,

                error:
                  "DATABASE_NOT_CONFIGURED"
              }
            );
          }

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

              rows:
                result.rows
            }
          );
        }


        /* -------------------------------------------------
           ADMIN CREATE KEY
        ------------------------------------------------- */

        if (
          p ===
            "/api/admin/keys" &&
          req.method === "POST"
        ) {

          if (
            !isAdmin(
              req,
              url
            )
          ) {

            return json(
              res,
              401,
              {

                ok: false,

                error:
                  "UNAUTHORIZED"
              }
            );
          }

          if (!pool) {

            return json(
              res,
              500,
              {

                ok: false,

                error:
                  "DATABASE_NOT_CONFIGURED"
              }
            );
          }

          const body =
            await readBody(req);

          let key =
            String(
              body.key ||
              ""
            ).trim();

          if (!key) {

            key =
              "DY-" +
              Math.random()
                .toString(36)
                .slice(
                  2,
                  10
                )
                .toUpperCase();
          }

          try {

            const result =
              await pool.query(
                `
                INSERT INTO access_keys
                (
                  access_key,
                  created_at
                )
                VALUES
                ($1,$2)
                RETURNING *
                `,
                [
                  key,
                  now()
                ]
              );

            return json(
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

              return json(
                res,
                409,
                {

                  ok: false,

                  error:
                    "KEY_ALREADY_EXISTS"
                }
              );
            }

            throw error;
          }
        }


        /* -------------------------------------------------
           RESET DEVICE
        ------------------------------------------------- */

        if (
          p ===
            "/api/admin/reset-device" &&
          req.method === "POST"
        ) {

          if (
            !isAdmin(
              req,
              url
            )
          ) {

            return json(
              res,
              401,
              {

                ok: false,

                error:
                  "UNAUTHORIZED"
              }
            );
          }

          if (!pool) {

            return json(
              res,
              500,
              {

                ok: false,

                error:
                  "DATABASE_NOT_CONFIGURED"
              }
            );
          }

          const body =
            await readBody(req);

          const id =
            Number(body.id);

          if (
            !Number.isInteger(id) ||
            id <= 0
          ) {

            return json(
              res,
              400,
              {

                ok: false,

                error:
                  "VALID_ID_REQUIRED"
              }
            );
          }

          const result =
            await pool.query(
              `
              UPDATE access_keys
              SET
                device_id = NULL,
                last_seen = 0
              WHERE id = $1
              RETURNING *
              `,
              [
                id
              ]
            );

          return json(
            res,
            200,
            {

              ok:
                result.rows.length >
                0,

              row:
                result.rows[0] ||
                null
            }
          );
        }


        /* -------------------------------------------------
           ADMIN PREDICTIONS
        ------------------------------------------------- */

        if (
          p ===
            "/api/admin/predictions" &&
          req.method === "GET"
        ) {

          if (
            !isAdmin(
              req,
              url
            )
          ) {

            return json(
              res,
              401,
              {

                ok: false,

                error:
                  "UNAUTHORIZED"
              }
            );
          }

          if (!pool) {

            return json(
              res,
              500,
              {

                ok: false,

                error:
                  "DATABASE_NOT_CONFIGURED"
              }
            );
          }

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

              rows:
                result.rows
            }
          );
        }


        /* -------------------------------------------------
           404
        ------------------------------------------------- */

        return json(
          res,
          404,
          {

            ok: false,

            error:
              "NOT_FOUND",

            path:
              p
          }
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

            error:
              error.message ||
              "SERVER_ERROR"
          }
        );
      }
    }
  );


/* =========================================================
   START
========================================================= */

(async () => {

  try {

    await initDB();

    server.listen(
      PORT,
      "0.0.0.0",
      () => {

        console.log(
          "========================================"
        );

        console.log(
          " DY AI WINGO 1 MINUTE"
        );

        console.log(
          "========================================"
        );

        console.log(
          "PORT:",
          PORT
        );

        console.log(
          "MODEL:",
          MODEL
        );

        console.log(
          "GAME: WINGO 1 MINUTE"
        );

        console.log(
          "API:",
          WINGOBOT_URL
        );

        console.log(
          "TOKEN:",
          WINGOBOT_TOKEN
            ? "CONFIGURED"
            : "MISSING"
        );

        console.log(
          "DATABASE:",
          pool
            ? "CONFIGURED"
            : "MISSING"
        );

        console.log(
          "COOLDOWN:",
          COOLDOWN_ROUNDS
        );

        console.log(
          "POLL:",
          POLL_MS,
          "ms"
        );

        console.log(
          "========================================"
        );
      }
    );

  } catch (error) {

    console.error(
      "START ERROR:",
      error
    );

    process.exit(1);
  }

})();
