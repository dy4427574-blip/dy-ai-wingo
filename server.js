"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

/* =====================================================
   CONFIG
===================================================== */

const PORT =
  Number(process.env.PORT || 10000);

const DATABASE_URL =
  String(process.env.DATABASE_URL || "").trim();

const ADMIN_KEY =
  String(
    process.env.ADMIN_KEY ||
    "dy4427574"
  ).trim();

const LIVE_API_URL =
  String(
    process.env.LIVE_API_URL || ""
  ).trim();

const LIVE_API_TOKEN =
  String(
    process.env.LIVE_API_TOKEN || ""
  ).trim();

const WINGOBOT_URL =
  String(
    process.env.WINGOBOT_URL ||
    "https://api.wingobot.com/v2/30-sec-game-history"
  ).trim();

const WINGOBOT_TOKEN =
  String(
    process.env.WINGOBOT_TOKEN || ""
  ).trim();

const COOLDOWN_ROUNDS =
  Math.max(
    0,
    Number(
      process.env.COOLDOWN || 5
    )
  );

const POLL =
  Math.max(
    1000,
    Number(
      process.env.POLL || 1000
    )
  );

const MODEL =
  String(
    process.env.MODEL ||
    "DY-AI-LIVE-V4"
  ).trim();


/* =====================================================
   DATABASE
===================================================== */

const pool =
  DATABASE_URL
    ? new Pool({
        connectionString:
          DATABASE_URL,

        ssl: {
          rejectUnauthorized:
            false
        },

        max: 5,

        idleTimeoutMillis:
          30000,

        connectionTimeoutMillis:
          10000
      })
    : null;


/* =====================================================
   DATABASE INIT
===================================================== */

async function initDB() {

  if (!pool) {
    console.log(
      "DATABASE_URL not configured"
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


/* =====================================================
   RESPONSE
===================================================== */

function json(res, status, data) {

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

      "Expires":
        "0",

      "Access-Control-Allow-Origin":
        "*",

      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, X-Admin-Key, X-Access-Key, X-Device-Id",

      "Access-Control-Allow-Methods":
        "GET,POST,OPTIONS"
    }
  );

  res.end(body);
}


/* =====================================================
   HELPERS
===================================================== */

function now() {
  return Date.now();
}


function normalizeIssue(value) {

  if (
    value === undefined ||
    value === null
  ) {
    return "";
  }

  return String(value).trim();
}


function validDigit(n) {

  return (
    Number.isInteger(n) &&
    n >= 0 &&
    n <= 9
  );
}


function resultOf(n) {

  if (!validDigit(n)) {
    return null;
  }

  return n <= 4
    ? "SMALL"
    : "BIG";
}


/* =====================================================
   SAFE ISSUE ID
===================================================== */

function compareIssue(a, b) {

  a =
    normalizeIssue(a);

  b =
    normalizeIssue(b);

  if (
    /^\d+$/.test(a) &&
    /^\d+$/.test(b)
  ) {

    try {

      const A =
        BigInt(a);

      const B =
        BigInt(b);

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

  issue =
    normalizeIssue(issue);

  if (
    !/^\d+$/.test(issue)
  ) {
    return "";
  }

  try {

    return (
      BigInt(issue) + 1n
    ).toString();

  } catch (_) {

    return "";
  }
}


function issueDistance(
  older,
  newer
) {

  older =
    normalizeIssue(older);

  newer =
    normalizeIssue(newer);

  if (
    !/^\d+$/.test(older) ||
    !/^\d+$/.test(newer)
  ) {
    return null;
  }

  try {

    const A =
      BigInt(older);

    const B =
      BigInt(newer);

    if (B < A) {
      return null;
    }

    const d =
      B - A;

    return Number(d);

  } catch (_) {

    return null;
  }
}


/* =====================================================
   FETCH
===================================================== */

async function fetchJSON(
  url,
  headers = {}
) {

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
        url,
        {
          method: "GET",
          headers,
          signal:
            controller.signal
        }
      );

    const raw =
      await response.text();

    let data;

    try {

      data =
        JSON.parse(raw);

    } catch (_) {

      throw new Error(
        "INVALID_JSON"
      );
    }

    if (
      !response.ok
    ) {

      throw new Error(
        "HTTP_" +
        response.status
      );
    }

    return data;

  } finally {

    clearTimeout(timeout);

  }
}


/* =====================================================
   PICK
===================================================== */

function pick(
  obj,
  keys
) {

  if (
    !obj ||
    typeof obj !== "object"
  ) {
    return null;
  }

  for (
    const key of keys
  ) {

    if (
      obj[key] !== undefined &&
      obj[key] !== null
    ) {

      return obj[key];

    }
  }

  return null;
}


/* =====================================================
   NORMALIZE ROW
===================================================== */

function normalizeRow(row) {

  if (
    !row ||
    typeof row !== "object"
  ) {
    return null;
  }

  const issue =
    normalizeIssue(
      pick(
        row,
        [
          "issueNumber",
          "issue",
          "period",
          "periodNumber",
          "drawNumber",
          "draw_id",
          "drawId",
          "id"
        ]
      )
    );

  let raw =
    pick(
      row,
      [
        "number",
        "result",
        "digit",
        "openNumber",
        "winningNumber",
        "winning_number"
      ]
    );

  if (
    typeof raw ===
    "string"
  ) {

    const m =
      raw.match(/\d/);

    if (m) {
      raw =
        Number(m[0]);
    }
  }

  const number =
    Number(raw);

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
      pick(
        row,
        [
          "colour",
          "color"
        ]
      ),

    premium:
      pick(
        row,
        ["premium"]
      ),

    sum:
      pick(
        row,
        ["sum"]
      )
  };
}


/* =====================================================
   EXTRACT API ROWS
===================================================== */

function extractRows(data) {

  if (
    Array.isArray(data)
  ) {
    return data;
  }

  if (
    Array.isArray(
      data?.history
    )
  ) {
    return data.history;
  }

  if (
    Array.isArray(
      data?.results
    )
  ) {
    return data.results;
  }

  if (
    Array.isArray(
      data?.records
    )
  ) {
    return data.records;
  }

  if (
    Array.isArray(
      data?.data
    )
  ) {
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


/* =====================================================
   LIVE CACHE
===================================================== */

let liveCache = {

  rows: [],

  currentIssue: "",

  fetchedAt: 0,

  source: "NONE",

  error: null

};


/* =====================================================
   CUSTOM LIVE API
===================================================== */

async function fetchCustomLive() {

  if (!LIVE_API_URL) {

    throw new Error(
      "LIVE_API_URL_NOT_CONFIGURED"
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
      "CUSTOM_API_NO_RESULTS"
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
      "CUSTOM_API"

  };
}


/* =====================================================
   WINGOBOT
===================================================== */

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
      ""
    );

  if (!rows.length) {

    throw new Error(
      "WINGOBOT_NO_RESULTS"
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
      "WINGOBOT"

  };
}


/* =====================================================
   REFRESH LIVE
===================================================== */

async function refreshLive() {

  let data = null;
  let error = null;

  /*
     Actual API first
  */

  if (
    LIVE_API_URL
  ) {

    try {

      data =
        await fetchCustomLive();

      error = null;

    } catch (e) {

      error =
        e.message;

      console.log(
        "LIVE API ERROR:",
        e.message
      );

    }
  }


  /*
     WingoBot fallback
  */

  if (!data) {

    try {

      data =
        await fetchWingoBot();

      error = null;

    } catch (e) {

      error =
        error ||
        e.message;

      console.log(
        "WINGOBOT ERROR:",
        e.message
      );

    }
  }


  if (data) {

    liveCache = {

      rows:
        data.rows.slice(
          -500
        ),

      currentIssue:
        data.currentIssue,

      fetchedAt:
        now(),

      source:
        data.source,

      error:
        null

    };

  } else {

    liveCache.error =
      error ||
      "LIVE_DATA_UNAVAILABLE";

  }

  return liveCache;
}


/* =====================================================
   ANALYSIS
===================================================== */

function percentage(
  a,
  b
) {

  if (!b) {
    return 0;
  }

  return (
    a / b
  ) * 100;
}


function average(arr) {

  if (!arr.length) {
    return 0;
  }

  return (
    arr.reduce(
      (a, b) =>
        a + b,
      0
    ) /
    arr.length
  );
}


function median(arr) {

  if (!arr.length) {
    return 0;
  }

  const x =
    [...arr].sort(
      (a, b) =>
        a - b
    );

  const mid =
    Math.floor(
      x.length / 2
    );

  return (
    x.length % 2
      ? x[mid]
      : (
          x[mid - 1] +
          x[mid]
        ) / 2
  );
}


function countSwitches(
  seq
) {

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


function streakInfo(
  seq
) {

  if (!seq.length) {

    return {

      current: null,

      currentLength: 0,

      longestBig: 0,

      longestSmall: 0

    };
  }


  const current =
    seq[
      seq.length - 1
    ];


  let currentLength =
    1;


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


  let longestBig = 0;
  let longestSmall = 0;

  let run = 0;
  let previous = null;


  for (
    const value of seq
  ) {

    if (
      value ===
      previous
    ) {

      run++;

    } else {

      run = 1;

      previous =
        value;

    }


    if (
      value ===
      "BIG"
    ) {

      longestBig =
        Math.max(
          longestBig,
          run
        );

    } else {

      longestSmall =
        Math.max(
          longestSmall,
          run
        );

    }
  }


  return {

    current,

    currentLength,

    longestBig,

    longestSmall

  };
}


function runLengths(
  seq
) {

  if (!seq.length) {
    return [];
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


  return runs;
}


function transitionMatrix(
  seq
) {

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


function digitAnalysis(
  rows
) {

  const frequency =
    Array(10).fill(0);

  const gaps =
    Array(10).fill(null);


  for (
    const row of rows
  ) {

    if (
      validDigit(
        row.number
      )
    ) {

      frequency[
        row.number
      ]++;

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


  const numbers =
    rows.map(
      row =>
        row.number
    );


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


function patternAnalysis(
  seq
) {

  const recent =
    seq.slice(-12);


  const result = {

    recentPattern:
      recent.join(""),

    alternation:
      false,

    alternationLength:
      0,

    repeatedBlocks: []

  };


  let alternating =
    recent.length >= 6;


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

    result.alternation =
      true;

    result.alternationLength =
      recent.length;

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


    const a =
      seq
        .slice(-size)
        .join("");


    const b =
      seq
        .slice(
          -size * 2,
          -size
        )
        .join("");


    if (
      a === b
    ) {

      result
        .repeatedBlocks
        .push(size);

    }
  }


  return result;
}


/* =====================================================
   FULL MODEL
===================================================== */

function analyze(
  rows
) {

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


  const last100 =
    validRows.slice(-100);


  const seq =
    last100.map(
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

      small: 0

    };
  }


  const big =
    seq.filter(
      x =>
        x === "BIG"
    ).length;


  const small =
    total - big;


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


  const switchCount =
    countSwitches(
      seq
    );


  const switchRate =
    total > 1
      ? percentage(
          switchCount,
          total - 1
        )
      : 0;


  const streak =
    streakInfo(
      seq
    );


  const transitions =
    transitionMatrix(
      seq
    );


  const runs =
    runLengths(
      seq
    );


  const recent5 =
    seq.slice(-5);


  const previous5 =
    seq.slice(
      -10,
      -5
    );


  let bigScore = 0;
  let smallScore = 0;


  /*
     Frequency
  */

  if (
    big > small
  ) {

    bigScore += 1.5;

  } else if (
    small > big
  ) {

    smallScore += 1.5;

  }


  /*
     Weighted windows
  */

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

    const w =
      seq.slice(
        -windows[i]
      );


    if (!w.length) {
      continue;
    }


    const wb =
      w.filter(
        x =>
          x === "BIG"
      ).length;


    const ws =
      w.length - wb;


    weightedBig +=
      (
        wb /
        w.length
      ) *
      weights[i];


    weightedSmall +=
      (
        ws /
        w.length
      ) *
      weights[i];

  }


  bigScore +=
    weightedBig / 100;

  smallScore +=
    weightedSmall / 100;


  /*
     Momentum
  */

  if (
    recent5.length &&
    previous5.length
  ) {

    const rb =
      recent5.filter(
        x =>
          x === "BIG"
      ).length;


    const pb =
      previous5.filter(
        x =>
          x === "BIG"
      ).length;


    if (
      rb > pb
    ) {

      bigScore +=
        0.8;

    } else if (
      rb < pb
    ) {

      smallScore +=
        0.8;

    }
  }


  /*
     Transition
  */

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


    if (
      same >
      opposite
    ) {

      if (
        last === "BIG"
      ) {

        bigScore +=
          0.7;

      } else {

        smallScore +=
          0.7;

      }

    } else if (
      opposite >
      same
    ) {

      if (
        last === "BIG"
      ) {

        smallScore +=
          0.7;

      } else {

        bigScore +=
          0.7;

      }
    }
  }


  /*
     Long streak = reversal watch
     NOT guaranteed reversal.
  */

  if (
    streak.current ===
      "BIG" &&
    streak.currentLength >= 4
  ) {

    smallScore +=
      Math.min(
        1.3,
        streak.currentLength *
        0.18
      );

  }


  if (
    streak.current ===
      "SMALL" &&
    streak.currentLength >= 4
  ) {

    bigScore +=
      Math.min(
        1.3,
        streak.currentLength *
        0.18
      );

  }


  /*
     Switching
  */

  if (
    switchRate >= 60
  ) {

    if (
      last === "BIG"
    ) {

      smallScore +=
        0.35;

    } else {

      bigScore +=
        0.35;

    }

  } else if (
    switchRate < 40
  ) {

    if (
      last === "BIG"
    ) {

      bigScore +=
        0.30;

    } else {

      smallScore +=
        0.30;

    }

  }


  /*
     Alternation
  */

  const recent8 =
    seq.slice(-8);


  let alternating =
    recent8.length >= 6;


  for (
    let i = 1;
    i < recent8.length;
    i++
  ) {

    if (
      recent8[i] ===
      recent8[i - 1]
    ) {

      alternating =
        false;

      break;

    }
  }


  if (
    alternating
  ) {

    if (
      last === "BIG"
    ) {

      smallScore +=
        0.65;

    } else {

      bigScore +=
        0.65;

    }
  }


  /*
     Repeating blocks
  */

  const patterns =
    patternAnalysis(
      seq
    );


  for (
    const size of
    patterns.repeatedBlocks
  ) {

    const block =
      seq.slice(-size);


    const final =
      block[
        block.length - 1
      ];


    if (
      final === "BIG"
    ) {

      smallScore +=
        0.18;

    } else {

      bigScore +=
        0.18;

    }
  }


  /*
     Difference
  */

  const difference =
    Math.abs(
      bigScore -
      smallScore
    );


  /*
     If model is too conflicted,
     don't force high confidence.
  */

  if (
    difference < 0.30
  ) {

    bigScore *=
      0.85;

    smallScore *=
      0.85;

  }


  let prediction =
    bigScore >=
    smallScore
      ? "BIG"
      : "SMALL";


  let confidence =
    50 +
    Math.abs(
      bigScore -
      smallScore
    ) *
    10;


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


  if (
    total < 20
  ) {

    confidence =
      Math.min(
        confidence,
        62
      );

  }


  let classification =
    "MIXED / CONFLICTING";


  if (
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


  /*
     Recent balanced market
  */

  const recent20 =
    seq.slice(-20);


  const recent20Big =
    recent20.filter(
      x =>
        x === "BIG"
    ).length;


  const recent20Small =
    recent20.length -
    recent20Big;


  if (
    recent20.length >= 10 &&
    Math.abs(
      recent20Big -
      recent20Small
    ) <= 1 &&
    difference < 0.55
  ) {

    classification =
      "MIXED / CONFLICTING";

    confidence =
      Math.min(
        confidence,
        58
      );

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

    recent5,

    recent10:
      seq.slice(-10),

    recent20,

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

    digits:
      digitAnalysis(
        last100
      ),

    runs:
      runs.slice(-20)

  };
}


/* =====================================================
   GET PENDING
===================================================== */

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


/* =====================================================
   GET LAST PREDICTION
===================================================== */

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


/* =====================================================
   CREATE PREDICTION
===================================================== */

async function createPrediction(
  targetIssue,
  analysis
) {

  if (
    !pool ||
    !targetIssue ||
    !analysis ||
    analysis.prediction ===
      "SKIP"
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


/* =====================================================
   SETTLE
===================================================== */

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


/* =====================================================
   CLEAN STALE PREDICTION
===================================================== */

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
    ) < 0
  ) {

    const row =
      rows.find(
        item =>
          compareIssue(
            item.issue,
            pending.target_issue
          ) === 0
      );


    if (row) {

      await settlePrediction(
        pending,
        row
      );

    } else {

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

  }

}


/* =====================================================
   COOLDOWN
===================================================== */

async function getCooldown(
  latestCompletedIssue
) {

  if (
    !pool ||
    !latestCompletedIssue
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
     Pending prediction is visible.
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
     Only WIN/LOSS starts cooldown.
     SKIPPED does not.
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
      latestCompletedIssue
    );


  const completed =
    distance === null
      ? 0
      : Math.max(
          0,
          distance
        );


  /*
     Example:
     target 100 settled
     current 100 => 0
     current 101 => 1
     ...
     current 105 => 5

     New target becomes 106.
  */

  if (
    completed >=
    COOLDOWN_ROUNDS
  ) {

    return {

      active: false,

      wait: 0,

      completed

    };

  }


  return {

    active: true,

    wait:
      Math.max(
        0,
        COOLDOWN_ROUNDS -
        completed
      ),

    completed

  };
}


/* =====================================================
   BUILD STATE
===================================================== */

async function buildState() {

  await refreshLive();


  const rows =
    liveCache.rows || [];


  /*
     IMPORTANT:
     Last row is treated as latest
     completed result.
  */

  const latestCompleted =
    rows.length
      ? rows[
          rows.length - 1
        ]
      : null;


  const latestCompletedIssue =
    latestCompleted
      ? latestCompleted.issue
      : "";


  /*
     Source may also expose its
     own current/upcoming issue.
  */

  const sourceCurrentIssue =
    normalizeIssue(
      liveCache.currentIssue
    );


  /*
     Cleanup old prediction.
  */

  await cleanupStale(
    latestCompletedIssue,
    rows
  );


  /*
     Try settlement.
  */

  let pending =
    await getPendingPrediction();


  if (
    pending
  ) {

    const targetRow =
      rows.find(
        row =>
          compareIssue(
            row.issue,
            pending.target_issue
          ) === 0
      );


    if (
      targetRow
    ) {

      pending =
        await settlePrediction(
          pending,
          targetRow
        );

    }

  }


  /*
     Full analysis.
  */

  const analysis =
    analyze(rows);


  /*
     Cooldown based on
     latest completed issue.
  */

  let cooldown =
    await getCooldown(
      latestCompletedIssue
    );


  /*
     Re-read pending after settlement.
  */

  pending =
    await getPendingPrediction();


  /*
     If target has become old,
     do not display it.
  */

  if (
    pending &&
    latestCompletedIssue &&
    compareIssue(
      pending.target_issue,
      latestCompletedIssue
    ) < 0
  ) {

    pending = null;

  }


  /*
     New prediction:
     next issue after latest
     completed result.
  */

  if (
    !pending &&
    !cooldown.active &&
    latestCompletedIssue &&
    rows.length >= 10 &&
    analysis.prediction !==
      "SKIP"
  ) {

    const targetIssue =
      nextIssue(
        latestCompletedIssue
      );


    if (
      targetIssue
    ) {

      pending =
        await createPrediction(
          targetIssue,
          analysis
        );

    }

  }


  /*
     Recalculate cooldown.
  */

  cooldown =
    await getCooldown(
      latestCompletedIssue
    );


  /*
     Last 30.
  */

  const last30 =
    rows
      .slice(-30)
      .reverse();


  /*
     Prediction history.
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

    model:
      MODEL,

    serverTime:
      now(),

    poll:
      POLL,

    source:
      liveCache.source,

    fetchedAt:
      liveCache.fetchedAt,

    liveError:
      liveCache.error,

    sourceCurrentIssue,

    currentIssue:
      latestCompletedIssue,

    latest:

      latestCompleted,

    nextIssue:
      nextIssue(
        latestCompletedIssue
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


/* =====================================================
   BODY
===================================================== */

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
              JSON.parse(body)
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


/* =====================================================
   ADMIN AUTH
===================================================== */

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
    queryKey ===
      ADMIN_KEY ||

    headerKey ===
      ADMIN_KEY ||

    bearer ===
      ADMIN_KEY
  );
}


/* =====================================================
   ACCESS KEY
===================================================== */

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
        await readBody(
          req
        );

    } catch (e) {

      return {

        status: 400,

        data: {

          ok: false,

          valid: false,

          error:
            e.message

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
        "ACCESS_KEY_VALID",

      key:
        row.access_key,

      deviceId

    }

  };
}


/* =====================================================
   STATIC FILE
===================================================== */

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


/* =====================================================
   MP3
===================================================== */

function serveAudio(
  req,
  res,
  filePath
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
          "MUSIC_NOT_FOUND"

      }
    );

  }


  const stat =
    fs.statSync(
      filePath
    );


  const total =
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
          total,

        "Accept-Ranges":
          "bytes"

      }
    );


    return fs
      .createReadStream(
        filePath
      )
      .pipe(res);

  }


  const match =
    range.match(
      /bytes=(\d*)-(\d*)/
    );


  if (!match) {

    res.writeHead(
      416
    );

    return res.end();

  }


  const start =
    match[1]
      ? Number(
          match[1]
        )
      : 0;


  const end =
    match[2]
      ? Number(
          match[2]
        )
      : total - 1;


  if (
    start >= total ||
    end >= total ||
    start > end
  ) {

    res.writeHead(
      416
    );

    return res.end();

  }


  const length =
    end - start + 1;


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
        "audio/mpeg"

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


/* =====================================================
   SERVER
===================================================== */

const server =
  http.createServer(
    async (
      req,
      res
    ) => {

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


        /* =================================================
           HEALTH
        ================================================= */

        if (
          p === "/health"
        ) {

          return json(
            res,
            200,
            {

              ok: true,

              service:
                "DY AI WinGo",

              uptime:
                process.uptime(),

              database:
                !!pool,

              liveAPI:
                !!LIVE_API_URL,

              wingoBot:
                !!WINGOBOT_TOKEN,

              source:
                liveCache.source,

              currentIssue:
                liveCache.currentIssue,

              time:
                now()

            }
          );

        }


        /* =================================================
           PREDICTION PAGE
        ================================================= */

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


        /* =================================================
           ADMIN PAGE
        ================================================= */

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


        /* =================================================
           MUSIC
        ================================================= */

        if (
          p === "/music.mp3"
        ) {

          return serveAudio(
            req,
            res,
            path.join(
              process.cwd(),
              "music.mp3"
            )
          );

        }


        /* =================================================
           ACCESS KEY
        ================================================= */

        if (
          p === "/api/key/check" &&
          (
            req.method === "GET" ||
            req.method === "POST"
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


        /* =================================================
           STATE
        ================================================= */

        if (
          p === "/api/state" &&
          req.method === "GET"
        ) {

          return json(
            res,
            200,
            await buildState()
          );

        }


        /* =================================================
           HISTORY
        ================================================= */

        if (
          p === "/api/history" &&
          req.method === "GET"
        ) {

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
              LIMIT 100
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


        /* =================================================
           ADMIN PING
        ================================================= */

        if (
          p ===
          "/api/admin/ping"
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

              time:
                now()

            }
          );

        }


        /* =================================================
           ADMIN STATUS
        ================================================= */

        if (
          p ===
          "/api/admin/status"
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

              serverTime:
                now(),

              uptime:
                process.uptime(),

              database:
                !!pool,

              liveConfigured:
                !!LIVE_API_URL,

              wingoBotConfigured:
                !!WINGOBOT_TOKEN,

              source:
                liveCache.source,

              fetchedAt:
                liveCache.fetchedAt,

              currentIssue:
                liveCache.currentIssue,

              error:
                liveCache.error,

              model:
                MODEL,

              cooldown:
                COOLDOWN_ROUNDS

            }
          );

        }


        /* =================================================
           ADMIN LIVE TEST
        ================================================= */

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


          const data =
            await refreshLive();


          return json(
            res,
            200,
            {

              ok:
                data.rows.length >
                0,

              source:
                data.source,

              currentIssue:
                data.currentIssue,

              fetchedAt:
                data.fetchedAt,

              count:
                data.rows.length,

              rows:
                data.rows.slice(
                  -30
                ),

              error:
                data.error

            }
          );

        }


        /* =================================================
           WINGOBOT TEST
        ================================================= */

        if (
          p ===
          "/api/admin/wingo-test"
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

                source:
                  data.source,

                currentIssue:
                  data.currentIssue,

                count:
                  data.rows.length,

                rows:
                  data.rows.slice(
                    -30
                  )

              }
            );

          } catch (e) {

            return json(
              res,
              200,
              {

                ok: false,

                error:
                  e.message

              }
            );

          }

        }


        /* =================================================
           MODEL TEST
        ================================================= */

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
                ok: false
              }
            );

          }


          await refreshLive();


          return json(
            res,
            200,
            {

              ok: true,

              model:
                MODEL,

              source:
                liveCache.source,

              currentIssue:
                liveCache.currentIssue,

              analysis:
                analyze(
                  liveCache.rows
                )

            }
          );

        }


        /* =================================================
           ADMIN KEYS GET
        ================================================= */

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
                ok: false
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


        /* =================================================
           ADMIN CREATE KEY
        ================================================= */

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
                ok: false
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
            await readBody(
              req
            );


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

          } catch (e) {

            if (
              e.code ===
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

            throw e;

          }

        }


        /* =================================================
           RESET DEVICE
        ================================================= */

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
                ok: false
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
            await readBody(
              req
            );


          const id =
            Number(
              body.id
            );


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
              [id]
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


        /* =================================================
           ADMIN PREDICTIONS
        ================================================= */

        if (
          p ===
          "/api/admin/predictions"
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
                ok: false
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


        /* =================================================
           404
        ================================================= */

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


/* =====================================================
   START
===================================================== */

(async () => {

  try {

    await initDB();


    server.listen(
      PORT,
      "0.0.0.0",
      () => {

        console.log(
          "================================"
        );

        console.log(
          " DY AI WinGo"
        );

        console.log(
          " PORT:",
          PORT
        );

        console.log(
          " MODEL:",
          MODEL
        );

        console.log(
          " COOLDOWN:",
          COOLDOWN_ROUNDS
        );

        console.log(
          " DATABASE:",
          pool
            ? "YES"
            : "NO"
        );

        console.log(
          " LIVE API:",
          LIVE_API_URL
            ? "YES"
            : "NO"
        );

        console.log(
          " WINGOBOT:",
          WINGOBOT_TOKEN
            ? "YES"
            : "NO"
        );

        console.log(
          " ADMIN:",
          ADMIN_KEY
            ? "YES"
            : "NO"
        );

        console.log(
          "================================"
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
