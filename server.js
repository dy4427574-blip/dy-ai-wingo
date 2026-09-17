"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

/* =========================================================
   CONFIG
========================================================= */

const PORT = Number(process.env.PORT || 10000);

const ADMIN_KEY = String(
  process.env.ADMIN_KEY || "dy4427574"
).trim();

const DEFAULT_ACCESS_KEY = String(
  process.env.DEFAULT_ACCESS_KEY || "DY-JPMSUULN"
).trim();

const WINGOBOT_TOKEN = String(
  process.env.WINGOBOT_TOKEN || ""
).trim();

const WINGOBOT_URL =
  "https://api.wingobot.com/v2/1-min-game-history";

const MODEL = String(
  process.env.MODEL || "DY-AI-1MIN-V1"
).trim();

const COOLDOWN_ROUNDS = Math.max(
  0,
  Number(process.env.COOLDOWN || 5)
);

const POLL_MS = Math.max(
  1000,
  Number(process.env.POLL || 1000)
);


/* =========================================================
   DATABASE
========================================================= */

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString:
        process.env.DATABASE_URL,

      ssl: {
        rejectUnauthorized: false
      },

      max: 5,

      idleTimeoutMillis: 30000,

      connectionTimeoutMillis: 10000
    })
  : null;


/* =========================================================
   MEMORY FALLBACK
========================================================= */

const memoryKeys = new Map();

memoryKeys.set(DEFAULT_ACCESS_KEY, {
  id: "memory-default",
  access_key: DEFAULT_ACCESS_KEY,
  device_id: null,
  created_at: Date.now(),
  last_seen: 0
});


const memoryPredictions = [];


/* =========================================================
   LIVE CACHE
========================================================= */

let liveCache = {
  rows: [],
  currentIssue: "",
  fetchedAt: 0,
  source: "NONE",
  error: null,
  fetched: 0,
  updated: null
};


/* =========================================================
   DATABASE INIT
========================================================= */

async function initDB() {

  if (!pool) {

    console.log(
      "DATABASE_URL not configured"
    );

    console.log(
      "Running in MEMORY MODE"
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


  /*
    Create default access key automatically.
  */

  await pool.query(`
    INSERT INTO access_keys
    (
      access_key,
      created_at
    )
    VALUES
    ($1,$2)
    ON CONFLICT(access_key)
    DO NOTHING
  `, [
    DEFAULT_ACCESS_KEY,
    Date.now()
  ]);


  console.log(
    "DATABASE READY"
  );

}


/* =========================================================
   BASIC HELPERS
========================================================= */

function now() {
  return Date.now();
}


function json(res, status, data) {

  const body =
    JSON.stringify(data);


  res.writeHead(
    status,
    {
      "Content-Type":
        "application/json; charset=utf-8",

      "Cache-Control":
        "no-store, no-cache, must-revalidate, proxy-revalidate",

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

    const A = BigInt(older);
    const B = BigInt(newer);


    if (B < A) {
      return null;
    }


    const diff =
      B - A;


    if (
      diff >
      BigInt(
        Number.MAX_SAFE_INTEGER
      )
    ) {
      return null;
    }


    return Number(diff);

  } catch (_) {

    return null;

  }

}


function validDigit(number) {

  return (
    Number.isInteger(number) &&
    number >= 0 &&
    number <= 9
  );

}


function resultOf(number) {

  if (
    !validDigit(number)
  ) {
    return null;
  }


  return number <= 4
    ? "SMALL"
    : "BIG";

}


/* =========================================================
   HTTP JSON FETCH
========================================================= */

async function fetchJSON(
  url,
  headers = {}
) {

  const controller =
    new AbortController();


  const timeout =
    setTimeout(
      () => controller.abort(),
      10000
    );


  try {

    const response =
      await fetch(
        url,
        {
          method: "GET",

          headers: {
            "Accept":
              "application/json",

            ...headers
          },

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
        "WINGOBOT_INVALID_JSON"
      );

    }


    if (!response.ok) {

      throw new Error(
        "WINGOBOT_HTTP_" +
        response.status
      );

    }


    return data;

  } finally {

    clearTimeout(timeout);

  }

}


/* =========================================================
   EXACT WINGOBOT 1-MINUTE API
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


  /*
    Your API explicitly returns
    success:true / false.
  */

  if (
    !data ||
    data.success !== true
  ) {

    throw new Error(
      data?.error ||
      "WINGOBOT_API_ERROR"
    );

  }


  /*
    Exact structure:

    data.current.issueNumber

    data.history[
      {
        issueNumber,
        number,
        colour,
        premium,
        sum
      }
    ]
  */

  const currentIssue =
    normalizeIssue(
      data.current?.issueNumber
    );


  if (!currentIssue) {

    throw new Error(
      "CURRENT_ISSUE_NOT_FOUND"
    );

  }


  if (
    !Array.isArray(
      data.history
    )
  ) {

    throw new Error(
      "HISTORY_NOT_FOUND"
    );

  }


  const rows =
    data.history
      .map((row) => {

        if (
          !row ||
          typeof row !==
            "object"
        ) {
          return null;
        }


        const issue =
          normalizeIssue(
            row.issueNumber
          );


        const number =
          Number(
            row.number
          );


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
            row.colour ??
            "",

          premium:
            row.premium ??
            "",

          sum:
            row.sum ??
            ""

        };

      })
      .filter(Boolean)
      .sort(
        (a,b) =>
          compareIssue(
            a.issue,
            b.issue
          )
      );


  if (!rows.length) {

    throw new Error(
      "WINGOBOT_HISTORY_EMPTY"
    );

  }


  return {

    rows,

    currentIssue,

    source:
      "WINGOBOT_1MIN",

    fetched:
      data.stats?.fetched ??
      rows.length,

    updated:
      data.stats?.last_updated ??
      null

  };

}


/* =========================================================
   REFRESH LIVE DATA
========================================================= */

async function refreshLive() {

  try {

    const result =
      await fetchWingoBot();


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
        null,

      fetched:
        result.fetched,

      updated:
        result.updated

    };


    console.log(
      "[WINGOBOT 1MIN]",
      "Issue:",
      result.currentIssue,
      "Rows:",
      result.rows.length
    );


  } catch (error) {

    liveCache.error =
      error.message;


    console.error(
      "[WINGOBOT ERROR]",
      error.message
    );

  }


  return liveCache;

}


/* =========================================================
   ANALYSIS HELPERS
========================================================= */

function average(values) {

  if (!values.length) {
    return 0;
  }


  return (
    values.reduce(
      (sum, value) =>
        sum + value,
      0
    ) /
    values.length
  );

}


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


function streakInfo(seq) {

  if (!seq.length) {

    return {

      current: null,

      currentLength: 0,

      longestBig: 0,

      longestSmall: 0

    };

  }


  const current =
    seq[seq.length - 1];


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


  let longestBig = 0;
  let longestSmall = 0;


  let side = seq[0];

  let length = 1;


  for (
    let i = 1;
    i < seq.length;
    i++
  ) {

    if (
      seq[i] === side
    ) {

      length++;

    } else {

      if (
        side === "BIG"
      ) {

        longestBig =
          Math.max(
            longestBig,
            length
          );

      } else {

        longestSmall =
          Math.max(
            longestSmall,
            length
          );

      }


      side =
        seq[i];

      length = 1;

    }

  }


  if (
    side === "BIG"
  ) {

    longestBig =
      Math.max(
        longestBig,
        length
      );

  } else {

    longestSmall =
      Math.max(
        longestSmall,
        length
      );

  }


  return {

    current,

    currentLength,

    longestBig,

    longestSmall

  };

}


/* =========================================================
   ANALYSIS
========================================================= */

function analyze(rows) {

  const data =
    rows
      .filter(
        row =>
          row &&
          validDigit(
            row.number
          )
      )
      .sort(
        (a,b) =>
          compareIssue(
            a.issue,
            b.issue
          )
      )
      .slice(-100);


  const seq =
    data.map(
      row => row.result
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

      streak: null,

      recent10: seq

    };

  }


  const big =
    seq.filter(
      x => x === "BIG"
    ).length;


  const small =
    total - big;


  const bigPct =
    big /
    total *
    100;


  const smallPct =
    small /
    total *
    100;


  const switches =
    countSwitches(seq);


  const switchRate =
    switches /
    Math.max(
      1,
      total - 1
    ) *
    100;


  const streak =
    streakInfo(seq);


  /*
    Weighted historical windows.
  */

  const windows =
    [5,10,20,30,50];

  const weights =
    [35,25,20,12,8];


  let bigScore = 0;

  let smallScore = 0;


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
        x => x === "BIG"
      ).length;


    const ws =
      window.length - wb;


    bigScore +=
      (
        wb /
        window.length
      ) *
      weights[i];


    smallScore +=
      (
        ws /
        window.length
      ) *
      weights[i];

  }


  bigScore /=
    100;

  smallScore /=
    100;


  /*
    Overall bias.
  */

  if (
    bigPct >
    smallPct
  ) {

    bigScore +=
      0.20;

  }


  if (
    smallPct >
    bigPct
  ) {

    smallScore +=
      0.20;

  }


  /*
    Recent momentum.
  */

  const recent =
    seq.slice(-10);

  const previous =
    seq.slice(-20,-10);


  if (
    recent.length >= 5 &&
    previous.length >= 5
  ) {

    const recentBig =
      recent.filter(
        x => x === "BIG"
      ).length;


    const previousBig =
      previous.filter(
        x => x === "BIG"
      ).length;


    const momentum =
      recentBig -
      previousBig;


    if (
      momentum > 0
    ) {

      bigScore +=
        Math.min(
          0.50,
          momentum * 0.08
        );

    }


    if (
      momentum < 0
    ) {

      smallScore +=
        Math.min(
          0.50,
          Math.abs(
            momentum
          ) * 0.08
        );

    }

  }


  /*
    Streak signal.
  */

  if (
    streak.current ===
    "BIG"
  ) {

    if (
      streak.currentLength >= 4
    ) {

      smallScore +=
        Math.min(
          0.45,
          streak.currentLength *
          0.07
        );

    }

  }


  if (
    streak.current ===
    "SMALL"
  ) {

    if (
      streak.currentLength >= 4
    ) {

      bigScore +=
        Math.min(
          0.45,
          streak.currentLength *
          0.07
        );

    }

  }


  /*
    Switching signal.
  */

  const last =
    seq[seq.length - 1];


  if (
    switchRate >= 60
  ) {

    if (
      last === "BIG"
    ) {

      smallScore +=
        0.15;

    } else {

      bigScore +=
        0.15;

    }

  } else if (
    switchRate < 40
  ) {

    if (
      last === "BIG"
    ) {

      bigScore +=
        0.15;

    } else {

      smallScore +=
        0.15;

    }

  }


  const difference =
    Math.abs(
      bigScore -
      smallScore
    );


  const prediction =
    bigScore >=
    smallScore
      ? "BIG"
      : "SMALL";


  /*
    Confidence is signal strength,
    not a guaranteed probability.
  */

  let confidence =
    50 +
    difference *
    18;


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
          90,
          confidence
        )
      )
    );


  let classification =
    "MIXED";


  if (
    difference < 0.10
  ) {

    classification =
      "NO CLEAR SIGNAL";

  } else if (
    difference < 0.25
  ) {

    classification =
      "WEAK SIGNAL";

  } else if (
    difference < 0.50
  ) {

    classification =
      "MODERATE SIGNAL";

  } else {

    classification =
      "STRONG HISTORICAL SIGNAL";

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

    scores: {

      big:
        Number(
          bigScore.toFixed(3)
        ),

      small:
        Number(
          smallScore.toFixed(3)
        )

    }

  };

}


/* =========================================================
   PREDICTION DATABASE
========================================================= */

async function getPendingPrediction() {

  if (!pool) {

    return (
      memoryPredictions
        .filter(
          row =>
            !row.actual_result
        )
        .sort(
          (a,b) =>
            Number(b.id) -
            Number(a.id)
        )[0] ||
      null
    );

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

    return (
      memoryPredictions
        .slice()
        .sort(
          (a,b) =>
            Number(b.id) -
            Number(a.id)
        )[0] ||
      null
    );

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


async function createPrediction(
  targetIssue,
  analysis
) {

  if (
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


  const pending =
    await getPendingPrediction();


  if (
    pending &&
    String(
      pending.target_issue
    ) ===
      String(targetIssue)
  ) {

    return pending;

  }


  /*
    MEMORY MODE
  */

  if (!pool) {

    const record = {

      id:
        Date.now(),

      target_issue:
        targetIssue,

      prediction:
        analysis.prediction,

      confidence:
        Number(
          analysis.confidence ||
          0
        ),

      model_version:
        MODEL,

      actual_number:
        null,

      actual_result:
        null,

      created_at:
        now(),

      settled_at:
        null

    };


    memoryPredictions.push(
      record
    );


    return record;

  }


  /*
    DATABASE MODE
  */

  const result =
    await pool.query(`
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
    `,[
      targetIssue,

      analysis.prediction,

      Number(
        analysis.confidence ||
        0
      ),

      MODEL,

      now()
    ]);


  return (
    result.rows[0] ||
    null
  );

}


/* =========================================================
   SETTLE PREDICTION
========================================================= */

async function settlePrediction(
  prediction,
  actual
) {

  if (
    !prediction ||
    !actual
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
    actual.result
      ? "WIN"
      : "LOSS";


  /*
    MEMORY
  */

  if (!pool) {

    prediction.actual_number =
      actual.number;

    prediction.actual_result =
      status;

    prediction.settled_at =
      now();

    return prediction;

  }


  /*
    DATABASE
  */

  const result =
    await pool.query(`
      UPDATE prediction_records
      SET
        actual_number=$1,
        actual_result=$2,
        settled_at=$3
      WHERE id=$4
      AND actual_result IS NULL
      RETURNING *
    `,[
      actual.number,
      status,
      now(),
      prediction.id
    ]);


  return (
    result.rows[0] ||
    prediction
  );

}


/* =========================================================
   COOLDOWN
========================================================= */

async function getCooldown(
  latestIssue
) {

  const last =
    await getLatestPrediction();


  if (!last) {

    return {

      active:false,

      wait:0,

      completed:0

    };

  }


  if (
    !last.actual_result
  ) {

    return {

      active:false,

      wait:0,

      completed:0

    };

  }


  if (
    last.actual_result !==
      "WIN" &&
    last.actual_result !==
      "LOSS"
  ) {

    return {

      active:false,

      wait:0,

      completed:0

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

      active:false,

      wait:0,

      completed:0

    };

  }


  if (
    distance <=
    COOLDOWN_ROUNDS
  ) {

    return {

      active:true,

      wait:
        COOLDOWN_ROUNDS -
        distance +
        1,

      completed:
        distance

    };

  }


  return {

    active:false,

    wait:0,

    completed:
      distance

  };

}


/* =========================================================
   BUILD STATE
========================================================= */

async function buildState() {

  await refreshLive();


  const rows =
    liveCache.rows ||
    [];


  const latest =
    rows.length
      ? rows[
          rows.length - 1
        ]
      : null;


  const currentIssue =
    latest?.issue ||
    liveCache.currentIssue ||
    "";


  /*
    Get pending prediction.
  */

  let pending =
    await getPendingPrediction();


  /*
    If target result is now
    present in live history,
    settle it.
  */

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
    Analyze latest data.
  */

  const analysis =
    analyze(rows);


  let cooldown =
    await getCooldown(
      currentIssue
    );


  pending =
    await getPendingPrediction();


  /*
    Do not expose an old pending
    prediction as current.
  */

  if (
    pending &&
    currentIssue &&
    compareIssue(
      pending.target_issue,
      currentIssue
    ) <= 0
  ) {

    pending = null;

  }


  /*
    Create prediction for next
    issue when there is enough data.
  */

  if (
    !pending &&
    !cooldown.active &&
    currentIssue &&
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
        currentIssue
      );


    if (target) {

      pending =
        await createPrediction(
          target,
          analysis
        );

    }

  }


  cooldown =
    await getCooldown(
      currentIssue
    );


  /*
    History.
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

  } else {

    history =
      memoryPredictions
        .slice()
        .sort(
          (a,b) =>
            Number(b.id) -
            Number(a.id)
        )
        .slice(0,100);

  }


  /*
    Last 30 results.
  */

  const last30 =
    rows
      .slice(-30)
      .reverse()
      .map(row => ({

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

      }));


  return {

    ok:true,

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

    apiStats: {

      fetched:
        liveCache.fetched,

      updated:
        liveCache.updated

    },

    currentIssue,

    nextIssue:
      nextIssue(
        currentIssue
      ),

    latest,

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
              pending.actual_result ||
              "PENDING"

          }
        : null,

    cooldown,

    last30,

    history

  };

}


/* =========================================================
   READ BODY
========================================================= */

function readBody(req) {

  return new Promise(
    (resolve,reject) => {

      let body = "";


      req.on(
        "data",
        chunk => {

          body += chunk;


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


/* =========================================================
   ADMIN AUTH
========================================================= */

function isAdmin(req,url) {

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
      .startsWith("bearer ")
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
   ACCESS KEY CHECK
========================================================= */

async function checkAccessKey(
  req,
  url
) {

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

        status:400,

        data: {

          ok:false,

          valid:false,

          error:
            error.message

        }

      };

    }

  }


  const accessKey =
    String(
      body.key ||
      url.searchParams.get(
        "key"
      ) ||
      req.headers[
        "x-access-key"
      ] ||
      ""
    ).trim();


  const deviceId =
    String(
      body.deviceId ||
      url.searchParams.get(
        "deviceId"
      ) ||
      req.headers[
        "x-device-id"
      ] ||
      ""
    ).trim();


  if (!accessKey) {

    return {

      status:400,

      data: {

        ok:false,

        valid:false,

        error:
          "ACCESS_KEY_REQUIRED"

      }

    };

  }


  if (!deviceId) {

    return {

      status:400,

      data: {

        ok:false,

        valid:false,

        error:
          "DEVICE_ID_REQUIRED"

      }

    };

  }


  /*
    DATABASE MODE
  */

  if (pool) {

    const result =
      await pool.query(`
        SELECT *
        FROM access_keys
        WHERE access_key=$1
        LIMIT 1
      `,[
        accessKey
      ]);


    if (
      !result.rows.length
    ) {

      return {

        status:401,

        data: {

          ok:false,

          valid:false,

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

        status:403,

        data: {

          ok:false,

          valid:false,

          error:
            "KEY_BOUND_TO_OTHER_DEVICE"

        }

      };

    }


    await pool.query(`
      UPDATE access_keys
      SET
        device_id=$1,
        last_seen=$2
      WHERE id=$3
    `,[
      deviceId,
      now(),
      row.id
    ]);


    return {

      status:200,

      data: {

        ok:true,

        valid:true,

        message:
          "ACCESS_KEY_VALID"

      }

    };

  }


  /*
    MEMORY MODE
  */

  const row =
    memoryKeys.get(
      accessKey
    );


  if (!row) {

    return {

      status:401,

      data: {

        ok:false,

        valid:false,

        error:
          "INVALID_ACCESS_KEY"

      }

    };

  }


  if (
    row.device_id &&
    row.device_id !==
      deviceId
  ) {

    return {

      status:403,

      data: {

        ok:false,

        valid:false,

        error:
          "KEY_BOUND_TO_OTHER_DEVICE"

      }

    };

  }


  row.device_id =
    deviceId;


  row.last_seen =
    now();


  return {

    status:200,

    data: {

      ok:true,

      valid:true,

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
  filename,
  contentType
) {

  if (
    !fs.existsSync(filename)
  ) {

    return json(
      res,
      404,
      {

        ok:false,

        error:
          "FILE_NOT_FOUND",

        file:
          path.basename(
            filename
          )

      }
    );

  }


  const data =
    fs.readFileSync(
      filename
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
    async (req,res) => {

      try {

        /*
          CORS preflight
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

              ok:true,

              game:
                "WINGO 1 MINUTE",

              model:
                MODEL,

              database:
                !!pool,

              databaseMode:
                pool
                  ? "POSTGRESQL"
                  : "MEMORY",

              wingoBot:
                !!WINGOBOT_TOKEN,

              source:
                liveCache.source,

              currentIssue:
                liveCache.currentIssue,

              resultCount:
                liveCache.rows.length,

              liveError:
                liveCache.error,

              time:
                now()

            }
          );

        }


        /* =================================================
           HOME / PREDICTION
        ================================================= */

        if (
          p === "/" ||
          p ===
            "/prediction.html"
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
          p ===
            "/admin.html"
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
           ACCESS KEY CHECK
        ================================================= */

        if (
          p ===
            "/api/key/check" &&
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


        /* =================================================
           STATE
        ================================================= */

        if (
          p ===
            "/api/state" &&
          req.method ===
            "GET"
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

                ok:false,

                error:
                  "UNAUTHORIZED"

              }
            );

          }


          return json(
            res,
            200,
            {

              ok:true,

              pong:true,

              game:
                "WINGO 1 MINUTE",

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

                ok:false,

                error:
                  "UNAUTHORIZED"

              }
            );

          }


          return json(
            res,
            200,
            {

              ok:true,

              game:
                "WINGO 1 MINUTE",

              model:
                MODEL,

              database:
                !!pool,

              databaseMode:
                pool
                  ? "POSTGRESQL"
                  : "MEMORY",

              wingoBotConfigured:
                !!WINGOBOT_TOKEN,

              api:
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

              apiStats: {

                fetched:
                  liveCache.fetched,

                updated:
                  liveCache.updated

              }

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

                ok:false,

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

                ok:true,

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

                fetched:
                  data.fetched,

                updated:
                  data.updated,

                rows:
                  data.rows.slice(-30)

              }
            );


          } catch(error) {

            return json(
              res,
              200,
              {

                ok:false,

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


        /* =================================================
           ADMIN MODEL TEST
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

                ok:false,

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

              ok:true,

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


        /* =================================================
           GET ACCESS KEYS
        ================================================= */

        if (
          p ===
            "/api/admin/keys" &&
          req.method ===
            "GET"
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

                ok:false,

                error:
                  "UNAUTHORIZED"

              }
            );

          }


          if (!pool) {

            return json(
              res,
              200,
              {

                ok:true,

                mode:
                  "memory",

                rows:
                  Array.from(
                    memoryKeys.values()
                  )

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

              ok:true,

              rows:
                result.rows

            }
          );

        }


        /* =================================================
           CREATE ACCESS KEY
        ================================================= */

        if (
          p ===
            "/api/admin/keys" &&
          req.method ===
            "POST"
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

                ok:false,

                error:
                  "UNAUTHORIZED"

              }
            );

          }


          const body =
            await readBody(req);


          let key =
            String(
              body.key || ""
            ).trim();


          if (!key) {

            key =
              "DY-" +
              crypto
                .randomBytes(5)
                .toString("hex")
                .toUpperCase();

          }


          /*
            MEMORY MODE
          */

          if (!pool) {

            if (
              memoryKeys.has(key)
            ) {

              return json(
                res,
                409,
                {

                  ok:false,

                  error:
                    "KEY_ALREADY_EXISTS"

                }
              );

            }


            const row = {

              id:
                "memory-" +
                Date.now(),

              access_key:
                key,

              device_id:
                null,

              created_at:
                now(),

              last_seen:
                0

            };


            memoryKeys.set(
              key,
              row
            );


            return json(
              res,
              200,
              {

                ok:true,

                key:row

              }
            );

          }


          /*
            POSTGRESQL MODE
          */

          try {

            const result =
              await pool.query(`
                INSERT INTO access_keys
                (
                  access_key,
                  created_at
                )
                VALUES
                ($1,$2)
                RETURNING *
              `,[
                key,
                now()
              ]);


            return json(
              res,
              200,
              {

                ok:true,

                key:
                  result.rows[0]

              }
            );


          } catch(error) {

            if (
              error.code ===
              "23505"
            ) {

              return json(
                res,
                409,
                {

                  ok:false,

                  error:
                    "KEY_ALREADY_EXISTS"

                }
              );

            }


            throw error;

          }

        }


        /* =================================================
           RESET DEVICE
        ================================================= */

        if (
          p ===
            "/api/admin/reset-device" &&
          req.method ===
            "POST"
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

                ok:false,

                error:
                  "UNAUTHORIZED"

              }
            );

          }


          const body =
            await readBody(req);


          /*
            MEMORY MODE
          */

          if (!pool) {

            const key =
              String(
                body.key || ""
              ).trim();


            const row =
              memoryKeys.get(
                key
              );


            if (!row) {

              return json(
                res,
                404,
                {

                  ok:false,

                  error:
                    "KEY_NOT_FOUND"

                }
              );

            }


            row.device_id =
              null;


            row.last_seen =
              0;


            return json(
              res,
              200,
              {

                ok:true,

                row

              }
            );

          }


          /*
            POSTGRESQL MODE
          */

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

                ok:false,

                error:
                  "VALID_ID_REQUIRED"

              }
            );

          }


          const result =
            await pool.query(`
              UPDATE access_keys
              SET
                device_id=NULL,
                last_seen=0
              WHERE id=$1
              RETURNING *
            `,[
              id
            ]);


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
           PREDICTION RECORDS
        ================================================= */

        if (
          p ===
            "/api/admin/predictions" &&
          req.method ===
            "GET"
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

                ok:false,

                error:
                  "UNAUTHORIZED"

              }
            );

          }


          if (!pool) {

            return json(
              res,
              200,
              {

                ok:true,

                mode:
                  "memory",

                rows:
                  memoryPredictions
                    .slice()
                    .sort(
                      (a,b) =>
                        Number(b.id) -
                        Number(a.id)
                    )
                    .slice(0,200)

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

              ok:true,

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

            ok:false,

            error:
              "NOT_FOUND",

            path:
              p

          }
        );


      } catch(error) {

        console.error(
          "SERVER ERROR:",
          error
        );


        return json(
          res,
          500,
          {

            ok:false,

            error:
              error.message ||
              "SERVER_ERROR"

          }
        );

      }

    }
  );


/* =========================================================
   START SERVER
========================================================= */

(async () => {

  try {

    await initDB();


    server.listen(
      PORT,
      "0.0.0.0",
      () => {

        console.log(
          "=========================================="
        );

        console.log(
          " DY AI WINGO 1 MINUTE"
        );

        console.log(
          "=========================================="
        );

        console.log(
          "PORT:",
          PORT
        );

        console.log(
          "GAME:",
          "WINGO 1 MINUTE"
        );

        console.log(
          "MODEL:",
          MODEL
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
            ? "POSTGRESQL"
            : "MEMORY MODE"
        );

        console.log(
          "DEFAULT KEY:",
          DEFAULT_ACCESS_KEY
        );

        console.log(
          "ADMIN:",
          ADMIN_KEY
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
          "=========================================="
        );

      }
    );


  } catch(error) {

    console.error(
      "START ERROR:",
      error
    );

    process.exit(1);

  }

})();
