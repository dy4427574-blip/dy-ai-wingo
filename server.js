"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 10000);

const ADMIN_KEY =
  process.env.ADMIN_KEY || "dy4427574";

const WINGOBOT_TOKEN =
  process.env.WINGOBOT_TOKEN || "";

const DATABASE_URL =
  process.env.DATABASE_URL || "";

const PUBLIC_DIR = __dirname;

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: {
        rejectUnauthorized: false
      }
    })
  : null;


/* =========================================================
   LIVE STATE
========================================================= */

let liveState = {
  success: true,
  ready: false,

  currentIssue: "",
  latestSettledIssue: "",
  targetIssue: "",

  prediction: "WAIT",
  number: null,

  confidence: 0,
  status: "WAIT",

  mode: "AI MODE",
  randomized: false,
  randomMixPercent: 0,

  aiPrediction: "WAIT",
  aiNumber: null,

  analysis: {
    status: "WAIT",

    patternScore: 0,
    modelAgreement: 0,

    backtestSamples: 0,
    avgModelAccuracy: null,

    bigProbability: 50,
    smallProbability: 50,

    votes: {
      BIG: 0,
      SMALL: 0,
      total: 0
    },

    volatility: 0,

    evidence: [],

    streak: {
      side: "",
      length: 0
    },

    transition: {
      currentSide: "",
      sample: 0
    },

    mode: "AI MODE",
    randomized: false
  },

  result: null,
  settled: false,

  history: [],
  predictionHistory: [],

  historySignature: "",

  wins: 0,
  losses: 0,
  pending: 0,

  updatedAt: Date.now(),

  error: null
};


/* =========================================================
   DATABASE
========================================================= */

async function initDb() {

  if (!pool) {
    console.log(
      "[DB] DATABASE_URL not configured"
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

  console.log("[DB] Database ready.");
}


/* =========================================================
   HELPERS
========================================================= */

function now() {
  return Date.now();
}


function json(
  res,
  statusCode,
  data
) {

  const body =
    JSON.stringify(data);

  res.writeHead(
    statusCode,
    {
      "Content-Type":
        "application/json; charset=utf-8",

      "Cache-Control":
        "no-store",

      "Access-Control-Allow-Origin":
        "*",

      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, X-Admin-Key",

      "Access-Control-Allow-Methods":
        "GET, POST, DELETE, OPTIONS"
    }
  );

  res.end(body);
}


function text(
  res,
  statusCode,
  body,
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

  res.end(body);
}


function parseBody(req) {

  return new Promise(
    (resolve, reject) => {

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
                "Request too large"
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

            resolve({});
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


function safeInt(
  value,
  fallback = 0
) {

  const n =
    Number(value);

  return Number.isFinite(n)
    ? n
    : fallback;
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


function sigmoid(
  value
) {

  return (
    1 /
    (
      1 +
      Math.exp(-value)
    )
  );
}


function normalizeSide(value) {

  const v =
    String(
      value || ""
    ).toUpperCase();

  if (
    v === "BIG"
  )
    return "BIG";

  if (
    v === "SMALL"
  )
    return "SMALL";

  return "";
}


function sideFromNumber(number) {

  const n =
    Number(number);

  if (
    !Number.isFinite(n)
  )
    return "";

  return n >= 5
    ? "BIG"
    : "SMALL";
}


/* =========================================================
   PERIOD HELPERS
========================================================= */

function incrementIssue(
  issue
) {

  const value =
    String(
      issue || ""
    ).trim();

  if (!value)
    return "";

  if (
    !/^\d+$/.test(value)
  )
    return "";

  try {

    return (
      BigInt(value) +
      1n
    ).toString();

  } catch {

    return "";
  }
}


function compareIssues(
  a,
  b
) {

  const aa =
    String(a || "");

  const bb =
    String(b || "");

  if (
    /^\d+$/.test(aa) &&
    /^\d+$/.test(bb)
  ) {

    const A =
      BigInt(aa);

    const B =
      BigInt(bb);

    if (A > B)
      return 1;

    if (A < B)
      return -1;

    return 0;
  }

  if (aa > bb)
    return 1;

  if (aa < bb)
    return -1;

  return 0;
}


function resolveTargetIssue(
  currentIssue,
  latestSettledIssue
) {

  const current =
    String(
      currentIssue || ""
    ).trim();

  const latest =
    String(
      latestSettledIssue || ""
    ).trim();

  if (!latest) {
    return current;
  }

  if (!current) {
    return incrementIssue(
      latest
    );
  }

  const comparison =
    compareIssues(
      current,
      latest
    );

  if (
    comparison > 0
  ) {

    return current;
  }

  return (
    incrementIssue(
      latest
    ) ||
    current
  );
}


/* =========================================================
   ACCESS KEY
========================================================= */

async function checkAccessKey(
  accessKey,
  deviceId
) {

  if (!pool) {

    return {
      ok: true,
      demoDatabase: true
    };
  }

  if (
    !accessKey ||
    !deviceId
  ) {

    return {
      ok: false,
      error:
        "ACCESS_KEY_AND_DEVICE_REQUIRED"
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
        String(
          accessKey
        ).trim()
      ]
    );

  if (
    result.rows.length === 0
  ) {

    return {
      ok: false,
      error:
        "INVALID_ACCESS_KEY"
    };
  }

  const row =
    result.rows[0];

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
        now(),
        row.id
      ]
    );

    return {
      ok: true,
      bound: true
    };
  }

  if (
    row.device_id !==
    deviceId
  ) {

    return {
      ok: false,
      error:
        "KEY_ALREADY_USED_ON_ANOTHER_DEVICE"
    };
  }

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

  return {
    ok: true,
    bound: true
  };
}


/* =========================================================
   WINGOBOT API
========================================================= */

function fetchWingoBot() {

  return new Promise(
    (resolve, reject) => {

      if (
        !WINGOBOT_TOKEN
      ) {

        reject(
          new Error(
            "WINGOBOT_TOKEN is not configured"
          )
        );

        return;
      }

      const request =
        https.request(
          {
            hostname:
              "api.wingobot.com",

            path:
              "/v2/30-sec-game-history",

            method:
              "GET",

            headers: {

              Authorization:
                `Bearer ${WINGOBOT_TOKEN}`,

              Accept:
                "application/json",

              "User-Agent":
                "DY-AI-Wingo/3.0"
            },

            timeout:
              10000
          },

          response => {

            let body = "";

            response.on(
              "data",
              chunk => {

                body +=
                  chunk.toString();
              }
            );

            response.on(
              "end",
              () => {

                if (
                  response.statusCode <
                    200 ||
                  response.statusCode >=
                    300
                ) {

                  reject(
                    new Error(
                      `WingoBot HTTP ${response.statusCode}: ${body.slice(0,500)}`
                    )
                  );

                  return;
                }

                try {

                  const data =
                    JSON.parse(
                      body
                    );

                  if (
                    !data ||
                    data.success === false
                  ) {

                    reject(
                      new Error(
                        data?.error ||
                        "WingoBot API returned failure"
                      )
                    );

                    return;
                  }

                  resolve(data);

                } catch(error) {

                  reject(
                    new Error(
                      `Invalid WingoBot JSON: ${error.message}`
                    )
                  );
                }
              }
            );
          }
        );

      request.on(
        "timeout",
        () => {

          request.destroy(
            new Error(
              "WingoBot request timeout"
            )
          );
        }
      );

      request.on(
        "error",
        reject
      );

      request.end();
    }
  );
}


/* =========================================================
   NORMALIZE HISTORY
========================================================= */

function normalizeHistory(
  apiData
) {

  const source =
    Array.isArray(
      apiData?.history
    )
      ? apiData.history
      : [];

  return source
    .map(row => {

      const number =
        safeInt(
          row.number,
          NaN
        );

      const issueNumber =
        String(
          row.issueNumber ??
          row.issue ??
          row.period ??
          ""
        ).trim();

      if (
        !issueNumber ||
        !Number.isFinite(number)
      ) {

        return null;
      }

      const side =
        normalizeSide(
          row.side
        ) ||
        normalizeSide(
          row.bigSmall
        ) ||
        sideFromNumber(
          number
        );

      return {

        issueNumber,

        number,

        side,

        colour:
          row.colour ??
          row.color ??
          "",

        premium:
          row.premium ??
          "",

        sum:
          row.sum ??
          "",

        raw:
          row
      };
    })
    .filter(Boolean);
}


function getLatestSettled(
  history
) {

  return (
    history.length
      ? history[0]
      : null
  );
}


function makeHistorySignature(
  history
) {

  return history
    .slice(
      0,
      15
    )
    .map(
      row =>
        `${row.issueNumber}:${row.number}:${row.side}`
    )
    .join("|");
}


/* =========================================================
   RECENCY ENGINE
========================================================= */

function recencySignal(
  history,
  size
) {

  const rows =
    history.slice(
      0,
      size
    );

  if (
    !rows.length
  ) {

    return {
      BIG: 0,
      SMALL: 0,
      sample: 0
    };
  }

  let bigWeight = 0;
  let smallWeight = 0;
  let totalWeight = 0;

  rows.forEach(
    (
      row,
      index
    ) => {

      const weight =
        Math.max(
          0.35,
          1 -
          (
            index /
            Math.max(
              1,
              size * 1.15
            )
          )
        );

      totalWeight +=
        weight;

      if (
        row.side ===
        "BIG"
      ) {

        bigWeight +=
          weight;
      }

      else if (
        row.side ===
        "SMALL"
      ) {

        smallWeight +=
          weight;
      }
    }
  );

  if (
    !totalWeight
  ) {

    return {
      BIG: 0,
      SMALL: 0,
      sample: 0
    };
  }

  return {

    BIG:
      (
        bigWeight /
        totalWeight
      ) -
      0.5,

    SMALL:
      (
        smallWeight /
        totalWeight
      ) -
      0.5,

    sample:
      rows.length
  };
}


/* =========================================================
   TRANSITION ENGINE
========================================================= */

function transitionEvidence(
  history
) {

  const transitions = {

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
    let i = 0;
    i <
      history.length - 1;
    i++
  ) {

    const current =
      history[i]?.side;

    const previous =
      history[i + 1]?.side;

    if (
      !current ||
      !previous
    )
      continue;

    transitions[
      previous
    ][
      current
    ]++;
  }

  const currentSide =
    history[0]?.side;

  if (!currentSide) {

    return {

      BIG: 0,
      SMALL: 0,

      sample: 0,

      currentSide: ""
    };
  }

  const row =
    transitions[
      currentSide
    ];

  const total =
    row.BIG +
    row.SMALL;

  if (
    total === 0
  ) {

    return {

      BIG: 0,
      SMALL: 0,

      sample: 0,

      currentSide
    };
  }

  /*
    Laplace smoothing.
  */

  const bigProbability =
    (
      row.BIG + 1
    ) /
    (
      total + 2
    );

  const smallProbability =
    (
      row.SMALL + 1
    ) /
    (
      total + 2
    );

  return {

    BIG:
      bigProbability -
      0.5,

    SMALL:
      smallProbability -
      0.5,

    sample:
      total,

    currentSide
  };
}


/* =========================================================
   PATTERN ENGINE
========================================================= */

function sequenceEvidence(
  history,
  length
) {

  const result = {

    BIG: 0,
    SMALL: 0,

    samples: 0,

    pattern: ""
  };

  if (
    history.length <
    length + 4
  ) {

    return result;
  }

  const currentPattern =
    history
      .slice(
        0,
        length
      )
      .map(
        row =>
          row.side
      )
      .join(",");

  result.pattern =
    currentPattern;

  let big = 0;
  let small = 0;

  /*
    Search only older patterns.

    history is newest first.

    Example:

      [current pattern]
      [older pattern]
      [older result]

    The result after the older
    pattern is at i + length.
  */

  for (
    let i = 1;
    i + length <
      history.length;
    i++
  ) {

    const pattern =
      history
        .slice(
          i,
          i + length
        )
        .map(
          row =>
            row.side
        )
        .join(",");

    if (
      pattern !==
      currentPattern
    )
      continue;

    const next =
      history[
        i + length
      ];

    if (
      next?.side ===
      "BIG"
    ) {

      big++;
    }

    else if (
      next?.side ===
      "SMALL"
    ) {

      small++;
    }
  }

  const total =
    big + small;

  if (
    total === 0
  ) {

    return result;
  }

  const bigProbability =
    (
      big + 1
    ) /
    (
      total + 2
    );

  const smallProbability =
    (
      small + 1
    ) /
    (
      total + 2
    );

  result.BIG =
    bigProbability -
    0.5;

  result.SMALL =
    smallProbability -
    0.5;

  result.samples =
    total;

  return result;
}


/* =========================================================
   STREAK
========================================================= */

function getStreak(
  history
) {

  const side =
    history[0]?.side;

  if (!side) {

    return {
      side: "",
      length: 0
    };
  }

  let length = 0;

  for (
    const row of history
  ) {

    if (
      row.side !==
      side
    )
      break;

    length++;
  }

  return {
    side,
    length
  };
}


function streakEvidence(
  history
) {

  const streak =
    getStreak(
      history
    );

  if (
    !streak.side
  ) {

    return {

      BIG: 0,
      SMALL: 0,

      length: 0
    };
  }

  const transition =
    transitionEvidence(
      history
    );

  let BIG = 0;
  let SMALL = 0;

  /*
    A streak does NOT automatically
    mean reversal.

    First give a small continuation
    signal.
  */

  if (
    streak.length >= 2
  ) {

    const continuation =
      clamp(
        streak.length *
        0.025,
        0,
        0.12
      );

    if (
      streak.side ===
      "BIG"
    ) {

      BIG +=
        continuation;

    } else {

      SMALL +=
        continuation;
    }
  }

  /*
    Historical transition gets
    stronger when sample is useful.
  */

  if (
    transition.sample >= 5
  ) {

    BIG +=
      transition.BIG *
      0.30;

    SMALL +=
      transition.SMALL *
      0.30;
  }

  return {

    BIG,
    SMALL,

    length:
      streak.length
  };
}


/* =========================================================
   VOLATILITY
========================================================= */

function volatilitySignal(
  history
) {

  const rows =
    history.slice(
      0,
      12
    );

  if (
    rows.length < 3
  ) {

    return {

      alternation: 0,
      changes: 0
    };
  }

  let changes = 0;

  for (
    let i = 0;
    i <
      rows.length - 1;
    i++
  ) {

    if (
      rows[i].side &&
      rows[i + 1].side &&
      rows[i].side !==
        rows[i + 1].side
    ) {

      changes++;
    }
  }

  return {

    alternation:
      changes /
      Math.max(
        1,
        rows.length - 1
      ),

    changes
  };
}


/* =========================================================
   NUMBER ANALYSIS
========================================================= */

function numberAnalysis(
  history
) {

  const counts = {};

  for (
    let n = 0;
    n <= 9;
    n++
  ) {

    counts[n] = 0;
  }

  history
    .slice(
      0,
      30
    )
    .forEach(
      (
        row,
        index
      ) => {

        const n =
          Number(
            row.number
          );

        if (
          !Number.isInteger(n) ||
          n < 0 ||
          n > 9
        )
          return;

        const weight =
          Math.max(
            0.35,
            1 -
            (
              index /
              45
            )
          );

        counts[n] +=
          weight;
      }
    );

  let big = 0;
  let small = 0;

  [5,6,7,8,9]
    .forEach(
      n => {
        big +=
          counts[n];
      }
    );

  [0,1,2,3,4]
    .forEach(
      n => {
        small +=
          counts[n];
      }
    );

  const total =
    big + small;

  if (
    !total
  ) {

    return {

      BIG: 0,
      SMALL: 0,

      counts
    };
  }

  return {

    BIG:
      (
        big /
        total
      ) -
      0.5,

    SMALL:
      (
        small /
        total
      ) -
      0.5,

    counts
  };
}


/* =========================================================
   EXPERT ENSEMBLE
========================================================= */

function runModels(
  history
) {

  let BIG = 0;
  let SMALL = 0;

  const evidence = [];


  /*
    MICRO 3
  */

  const micro3 =
    recencySignal(
      history,
      3
    );

  BIG +=
    micro3.BIG *
    0.24;

  SMALL +=
    micro3.SMALL *
    0.24;

  evidence.push({

    name:
      "MICRO 3",

    BIG:
      micro3.BIG,

    SMALL:
      micro3.SMALL,

    sample:
      micro3.sample
  });


  /*
    SHORT 5
  */

  const short5 =
    recencySignal(
      history,
      5
    );

  BIG +=
    short5.BIG *
    0.20;

  SMALL +=
    short5.SMALL *
    0.20;

  evidence.push({

    name:
      "SHORT 5",

    BIG:
      short5.BIG,

    SMALL:
      short5.SMALL,

    sample:
      short5.sample
  });


  /*
    MEDIUM 8
  */

  const medium8 =
    recencySignal(
      history,
      8
    );

  BIG +=
    medium8.BIG *
    0.12;

  SMALL +=
    medium8.SMALL *
    0.12;

  evidence.push({

    name:
      "MEDIUM 8",

    BIG:
      medium8.BIG,

    SMALL:
      medium8.SMALL,

    sample:
      medium8.sample
  });


  /*
    BALANCE 12
  */

  const balance12 =
    recencySignal(
      history,
      12
    );

  BIG +=
    balance12.BIG *
    0.08;

  SMALL +=
    balance12.SMALL *
    0.08;

  evidence.push({

    name:
      "BALANCE 12",

    BIG:
      balance12.BIG,

    SMALL:
      balance12.SMALL,

    sample:
      balance12.sample
  });


  /*
    TRANSITION
  */

  const transition =
    transitionEvidence(
      history
    );

  BIG +=
    transition.BIG *
    0.17;

  SMALL +=
    transition.SMALL *
    0.17;

  evidence.push({

    name:
      "TRANSITION",

    BIG:
      transition.BIG,

    SMALL:
      transition.SMALL,

    sample:
      transition.sample
  });


  /*
    PATTERN 2
  */

  const pattern2 =
    sequenceEvidence(
      history,
      2
    );

  BIG +=
    pattern2.BIG *
    0.06;

  SMALL +=
    pattern2.SMALL *
    0.06;

  evidence.push({

    name:
      "PATTERN 2",

    BIG:
      pattern2.BIG,

    SMALL:
      pattern2.SMALL,

    sample:
      pattern2.samples
  });


  /*
    PATTERN 3
  */

  const pattern3 =
    sequenceEvidence(
      history,
      3
    );

  BIG +=
    pattern3.BIG *
    0.08;

  SMALL +=
    pattern3.SMALL *
    0.08;

  evidence.push({

    name:
      "PATTERN 3",

    BIG:
      pattern3.BIG,

    SMALL:
      pattern3.SMALL,

    sample:
      pattern3.samples
  });


  /*
    PATTERN 4
  */

  const pattern4 =
    sequenceEvidence(
      history,
      4
    );

  BIG +=
    pattern4.BIG *
    0.05;

  SMALL +=
    pattern4.SMALL *
    0.05;

  evidence.push({

    name:
      "PATTERN 4",

    BIG:
      pattern4.BIG,

    SMALL:
      pattern4.SMALL,

    sample:
      pattern4.samples
  });


  /*
    STREAK
  */

  const streak =
    streakEvidence(
      history
    );

  BIG +=
    streak.BIG *
    0.07;

  SMALL +=
    streak.SMALL *
    0.07;

  evidence.push({

    name:
      "STREAK",

    BIG:
      streak.BIG,

    SMALL:
      streak.SMALL,

    sample:
      streak.length
  });


  /*
    NUMBER DISTRIBUTION
  */

  const numbers =
    numberAnalysis(
      history
    );

  BIG +=
    numbers.BIG *
    0.03;

  SMALL +=
    numbers.SMALL *
    0.03;

  evidence.push({

    name:
      "NUMBER DISTRIBUTION",

    BIG:
      numbers.BIG,

    SMALL:
      numbers.SMALL
  });


  /*
    VOLATILITY
  */

  const volatility =
    volatilitySignal(
      history
    );

  evidence.push({

    name:
      "VOLATILITY",

    BIG: 0,

    SMALL: 0,

    alternation:
      volatility.alternation
  });


  /*
    FINAL DIRECTION
  */

  const difference =
    BIG -
    SMALL;

  const edge =
    Math.abs(
      difference
    );


  const bigProbability =
    sigmoid(
      difference *
      5.5
    );

  const smallProbability =
    1 -
    bigProbability;


  /*
    Voting models.
  */

  const directional =
    evidence.filter(
      item =>
        item.name !==
        "VOLATILITY" &&
        Math.abs(
          item.BIG -
          item.SMALL
        ) >=
        0.025
    );


  const bigVotes =
    directional.filter(
      item =>
        item.BIG >
        item.SMALL
    ).length;


  const smallVotes =
    directional.filter(
      item =>
        item.SMALL >
        item.BIG
    ).length;


  const totalVotes =
    directional.length;


  let side =
    bigProbability >=
    smallProbability
      ? "BIG"
      : "SMALL";


  const agreement =
    totalVotes
      ? (
          Math.max(
            bigVotes,
            smallVotes
          ) /
          totalVotes
        )
      : 0;


  /*
    More history means
    stricter decision.
  */

  const minimumEdge =
    history.length < 15
      ? 0.115
      : history.length < 25
        ? 0.095
        : 0.075;


  /*
    Don't force a weak prediction.
  */

  if (
    edge <
    minimumEdge ||
    agreement <
    0.50
  ) {

    side =
      "WAIT";
  }


  const modelAgreement =
    Math.round(
      agreement *
      100
    );


  const patternScore =
    Math.round(
      clamp(
        (
          edge *
          65
        ) +
        (
          agreement *
          35
        ),
        0,
        100
      )
    );


  return {

    side,

    BIG,
    SMALL,

    edge,

    bigProbability:
      Math.round(
        bigProbability *
        100
      ),

    smallProbability:
      Math.round(
        smallProbability *
        100
      ),

    modelAgreement,

    patternScore,

    evidence,

    volatility:
      volatility.alternation,

    votes: {

      BIG:
        bigVotes,

      SMALL:
        smallVotes,

      total:
        totalVotes
    },

    streak,

    transition
  };
}


/* =========================================================
   WALK-FORWARD BACKTEST
========================================================= */

function predictFromPast(
  history
) {

  if (
    history.length < 8
  ) {

    return "WAIT";
  }

  return runModels(
    history
  ).side;
}


function backtest(
  history
) {

  if (
    history.length < 18
  ) {

    return {

      samples: 0,

      accuracy: null,

      wins: 0,

      losses: 0
    };
  }

  const maxSamples =
    Math.min(
      history.length - 9,
      100
    );

  let samples = 0;
  let correct = 0;

  for (
    let i = 0;
    i < maxSamples;
    i++
  ) {

    const targetIndex =
      history.length -
      1 -
      i;

    if (
      targetIndex <= 7
    )
      break;

    const target =
      history[
        targetIndex
      ];

    /*
      Only older data.
    */

    const training =
      history.slice(
        targetIndex + 1
      );

    if (
      training.length < 8
    )
      continue;

    const prediction =
      predictFromPast(
        training
      );

    if (
      prediction !==
        "BIG" &&
      prediction !==
        "SMALL"
    ) {

      continue;
    }

    samples++;

    if (
      prediction ===
      target.side
    ) {

      correct++;
    }
  }

  return {

    samples,

    accuracy:
      samples > 0
        ? Math.round(
            (
              correct /
              samples
            ) *
            100
          )
        : null,

    wins:
      correct,

    losses:
      samples -
      correct
  };
}


/* =========================================================
   CONFIDENCE
========================================================= */

function adaptiveConfidence(
  model,
  bt,
  historyLength
) {

  if (
    model.side !==
      "BIG" &&
    model.side !==
      "SMALL"
  ) {

    return 0;
  }

  let confidence =
    50 +
    (
      model.edge *
      155
    );


  if (
    model.modelAgreement >=
    70
  ) {

    confidence += 5;
  }


  if (
    model.modelAgreement >=
    85
  ) {

    confidence += 4;
  }


  if (
    bt.samples >= 15 &&
    bt.accuracy != null
  ) {

    confidence =
      (
        confidence *
        0.72
      ) +
      (
        bt.accuracy *
        0.28
      );
  }


  /*
    Confidence caps.
    We don't display fake
    90–99% certainty.
  */

  if (
    historyLength < 15
  ) {

    confidence =
      Math.min(
        confidence,
        64
      );

  } else if (
    historyLength < 25
  ) {

    confidence =
      Math.min(
        confidence,
        72
      );

  } else {

    confidence =
      Math.min(
        confidence,
        82
      );
  }


  return clamp(
    Math.round(
      confidence
    ),
    0,
    82
  );
}


/* =========================================================
   SMART NUMBER
========================================================= */

function chooseNumber(
  history,
  side
) {

  if (
    side !== "BIG" &&
    side !== "SMALL"
  ) {

    return null;
  }


  const allowed =
    side === "BIG"
      ? [5,6,7,8,9]
      : [0,1,2,3,4];


  const counts = {};
  const lastSeen = {};


  allowed.forEach(
    n => {

      counts[n] = 0;

      lastSeen[n] =
        Infinity;
    }
  );


  history
    .slice(
      0,
      40
    )
    .forEach(
      (
        row,
        index
      ) => {

        const n =
          Number(
            row.number
          );

        if (
          !allowed.includes(n)
        )
          return;

        const weight =
          Math.max(
            0.35,
            1 -
            (
              index /
              50
            )
          );

        counts[n] +=
          weight;

        if (
          lastSeen[n] ===
          Infinity
        ) {

          lastSeen[n] =
            index;
        }
      }
    );


  const scored =
    allowed.map(
      n => {

        const frequencyPenalty =
          counts[n] *
          0.55;

        const missingBonus =
          Math.min(
            5,
            lastSeen[n] ===
              Infinity
              ? 5
              : lastSeen[n] *
                0.14
          );

        return {

          number:
            n,

          score:
            missingBonus -
            frequencyPenalty
        };
      }
    );


  const maxScore =
    Math.max(
      ...scored.map(
        x =>
          x.score
      )
    );


  const candidates =
    scored
      .filter(
        x =>
          x.score >=
          maxScore -
          1.25
      )
      .map(
        x =>
          x.number
      );


  /*
    Deterministic.

    Same target/history =
    same number.
  */

  const seed =
    String(
      history[0]?.issueNumber ||
      "0"
    );

  let hash = 0;

  for (
    let i = 0;
    i < seed.length;
    i++
  ) {

    hash =
      (
        (
          hash *
          31
        ) +
        seed.charCodeAt(i)
      ) |
      0;
  }

  return candidates[
    Math.abs(hash) %
    candidates.length
  ];
}


/* =========================================================
   EXPERT PREDICTION
========================================================= */

function createPrediction(
  history
) {

  if (
    history.length < 10
  ) {

    return {

      prediction:
        "WAIT",

      number:
        null,

      confidence:
        0,

      status:
        "INSUFFICIENT DATA",

      mode:
        "AI MODE",

      randomized:
        false,

      aiPrediction:
        "WAIT",

      aiNumber:
        null,

      analysis: {

        status:
          "INSUFFICIENT DATA",

        patternScore:
          0,

        modelAgreement:
          0,

        backtestSamples:
          0,

        avgModelAccuracy:
          null,

        bigProbability:
          50,

        smallProbability:
          50,

        votes: {
          BIG: 0,
          SMALL: 0,
          total: 0
        },

        volatility:
          0,

        evidence: [],

        streak: {
          side: "",
          length: 0
        },

        transition: {
          currentSide: "",
          sample: 0
        },

        mode:
          "AI MODE",

        randomized:
          false
      }
    };
  }


  const model =
    runModels(
      history
    );


  const bt =
    backtest(
      history
    );


  if (
    model.side !==
      "BIG" &&
    model.side !==
      "SMALL"
  ) {

    return {

      prediction:
        "WAIT",

      number:
        null,

      confidence:
        0,

      status:
        "NO CLEAR EDGE",

      mode:
        "AI MODE",

      randomized:
        false,

      aiPrediction:
        "WAIT",

      aiNumber:
        null,

      analysis: {

        status:
          "NO CLEAR EDGE",

        patternScore:
          model.patternScore,

        modelAgreement:
          model.modelAgreement,

        backtestSamples:
          bt.samples,

        avgModelAccuracy:
          bt.accuracy,

        bigProbability:
          model.bigProbability,

        smallProbability:
          model.smallProbability,

        votes:
          model.votes,

        volatility:
          model.volatility,

        evidence:
          model.evidence,

        streak:
          model.streak,

        transition: {

          currentSide:
            model.transition
              .currentSide,

          sample:
            model.transition
              .sample
        },

        mode:
          "AI MODE",

        randomized:
          false
      }
    };
  }


  const confidence =
    adaptiveConfidence(
      model,
      bt,
      history.length
    );


  const number =
    chooseNumber(
      history,
      model.side
    );


  let status =
    "WEAK SIGNAL";


  if (
    confidence >= 75 &&
    model.modelAgreement >=
      70
  ) {

    status =
      "STRONGER SIGNAL";

  } else if (
    confidence >= 65 &&
    model.modelAgreement >=
      55
  ) {

    status =
      "MODERATE SIGNAL";

  } else if (
    confidence >= 55
  ) {

    status =
      "EARLY SIGNAL";
  }


  return {

    prediction:
      model.side,

    number,

    confidence,

    status,

    mode:
      "AI MODE",

    randomized:
      false,

    aiPrediction:
      model.side,

    aiNumber:
      number,

    analysis: {

      status,

      patternScore:
        model.patternScore,

      modelAgreement:
        model.modelAgreement,

      backtestSamples:
        bt.samples,

      avgModelAccuracy:
        bt.accuracy,

      bigProbability:
        model.bigProbability,

      smallProbability:
        model.smallProbability,

      votes:
        model.votes,

      volatility:
        model.volatility,

      evidence:
        model.evidence,

      streak:
        model.streak,

      transition: {

        currentSide:
          model.transition
            .currentSide,

        sample:
          model.transition
            .sample
      },

      mode:
        "AI MODE",

      randomized:
        false
    }
  };
}


/* =========================================================
   DB PREDICTION RECORDS
========================================================= */

async function getPredictionRecord(
  issue
) {

  if (!pool)
    return null;

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


async function savePredictionRecord(
  issue,
  prediction
) {

  if (!pool)
    return null;

  const result =
    await pool.query(
      `
      INSERT INTO prediction_records
      (
        target_issue,
        prediction,
        predicted_number,
        ai_prediction,
        ai_number,
        mode,
        randomized,
        confidence,
        status,
        created_at
      )
      VALUES
      (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
      )
      ON CONFLICT (target_issue)
      DO NOTHING
      RETURNING *
      `,
      [

        String(issue),

        prediction.prediction,

        prediction.number,

        prediction.aiPrediction,

        prediction.aiNumber,

        "AI MODE",

        false,

        prediction.confidence,

        prediction.status,

        now()
      ]
    );

  return (
    result.rows[0] ||
    null
  );
}


/* =========================================================
   SETTLE PREDICTIONS
========================================================= */

async function settlePredictions(
  history
) {

  if (!pool)
    return;

  const pending =
    await pool.query(
      `
      SELECT *
      FROM prediction_records
      WHERE outcome = 'PENDING'
      ORDER BY id ASC
      LIMIT 500
      `
    );


  for (
    const prediction
      of pending.rows
  ) {

    const actual =
      history.find(
        row =>
          String(
            row.issueNumber
          ) ===
          String(
            prediction.target_issue
          )
      );


    if (!actual)
      continue;


    const actualSide =
      actual.side ||
      sideFromNumber(
        actual.number
      );


    const outcome =
      prediction.prediction ===
      actualSide
        ? "WIN"
        : "LOSS";


    await pool.query(
      `
      UPDATE prediction_records
      SET
        result_number = $1,
        result_side = $2,
        outcome = $3,
        settled_at = $4
      WHERE id = $5
      `,
      [

        actual.number,

        actualSide,

        outcome,

        now(),

        prediction.id
      ]
    );


    console.log(
      `[SETTLED] ${prediction.target_issue} => ${outcome} | prediction=${prediction.prediction} | result=${actual.number} ${actualSide}`
    );
  }
}


/* =========================================================
   PREDICTION HISTORY
========================================================= */

async function getPredictionHistory() {

  if (!pool) {

    return [];
  }


  const result =
    await pool.query(
      `
      SELECT
        id,
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
        result_number,
        result_side,
        outcome,
        settled_at
      FROM prediction_records
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

  if (!pool) {

    return {

      wins: 0,
      losses: 0,
      pending: 0
    };
  }


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
          ) AS losses,

        COUNT(*) FILTER
          (
            WHERE outcome = 'PENDING'
          ) AS pending

      FROM prediction_records
      `
    );


  const row =
    result.rows[0];


  return {

    wins:
      Number(
        row.wins || 0
      ),

    losses:
      Number(
        row.losses || 0
      ),

    pending:
      Number(
        row.pending || 0
      )
  };
}


/* =========================================================
   UPDATE LIVE STATE
========================================================= */

async function updateLiveState() {

  try {

    const data =
      await fetchWingoBot();


    const history =
      normalizeHistory(
        data
      );


    const latest =
      getLatestSettled(
        history
      );


    if (!latest) {

      liveState = {

        ...liveState,

        ready:
          false,

        history:
          [],

        error:
          "No settled history received",

        updatedAt:
          now()
      };

      return;
    }


    const apiCurrent =
      String(
        data?.current?.issueNumber ||
        ""
      ).trim();


    const latestSettledIssue =
      String(
        latest.issueNumber
      );


    const targetIssue =
      resolveTargetIssue(
        apiCurrent,
        latestSettledIssue
      );


    /*
      Detect target BEFORE replacing
      liveState.
    */

    const targetChanged =
      String(
        liveState.targetIssue ||
        ""
      ) !==
      String(
        targetIssue
      );


    /*
      Settle exact matching periods.
    */

    await settlePredictions(
      history
    );


    /*
      Existing target?
    */

    let record =
      await getPredictionRecord(
        targetIssue
      );


    /*
      Only generate when this exact
      target does not exist.
    */

    let freshPrediction =
      null;


    if (!record) {

      freshPrediction =
        createPrediction(
          history
        );


      record =
        await savePredictionRecord(
          targetIssue,
          freshPrediction
        );


      /*
        If INSERT lost a race,
        load the existing record.
      */

      if (!record) {

        record =
          await getPredictionRecord(
            targetIssue
          );
      }


      /*
        No DB fallback.
      */

      if (!record) {

        record = {

          target_issue:
            targetIssue,

          prediction:
            freshPrediction.prediction,

          predicted_number:
            freshPrediction.number,

          ai_prediction:
            freshPrediction.aiPrediction,

          ai_number:
            freshPrediction.aiNumber,

          mode:
            "AI MODE",

          randomized:
            false,

          confidence:
            freshPrediction.confidence,

          status:
            freshPrediction.status,

          created_at:
            now(),

          result_number:
            null,

          result_side:
            null,

          outcome:
            "PENDING",

          analysis:
            freshPrediction.analysis
        };
      }


      console.log(
        `[PREDICTION CREATED] ${targetIssue} => ${record.prediction} | number=${record.predicted_number} | confidence=${record.confidence}`
      );
    }


    const stats =
      await getStats();


    let analysis =
      liveState.analysis;


    /*
      Fresh target gets fresh
      analysis.

      Same target keeps the
      previous analysis.
    */

    if (
      targetChanged &&
      freshPrediction
    ) {

      analysis =
        freshPrediction.analysis;

    } else if (
      targetChanged &&
      record.analysis
    ) {

      analysis =
        record.analysis;
    }


    liveState = {

      success:
        true,

      ready:
        true,

      currentIssue:
        apiCurrent,

      latestSettledIssue:
        latestSettledIssue,

      targetIssue:
        targetIssue,

      prediction:
        record.prediction ||
        "WAIT",

      number:
        record.predicted_number ??
        null,

      confidence:
        Number(
          record.confidence ||
          0
        ),

      status:
        record.status ||
        "WAIT",

      mode:
        "AI MODE",

      randomized:
        false,

      randomMixPercent:
        0,

      aiPrediction:
        record.ai_prediction ||
        record.prediction ||
        "WAIT",

      aiNumber:
        record.ai_number ??
        record.predicted_number ??
        null,

      analysis: {

        ...analysis,

        mode:
          "AI MODE",

        randomized:
          false
      },

      result:
        record.result_number !=
        null
          ? {

              issueNumber:
                record.target_issue,

              number:
                record.result_number,

              side:
                record.result_side,

              outcome:
                record.outcome
            }
          : null,

      settled:
        record.outcome !==
        "PENDING",

      history:
        history.slice(
          0,
          30
        ),

      predictionHistory:
        await getPredictionHistory(),

      historySignature:
        makeHistorySignature(
          history
        ),

      wins:
        stats.wins,

      losses:
        stats.losses,

      pending:
        stats.pending,

      updatedAt:
        now(),

      error:
        null
    };

  } catch(error) {

    console.error(
      "[WINGOBOT]",
      error.message
    );


    liveState = {

      ...liveState,

      error:
        error.message,

      updatedAt:
        now()
    };
  }
}


/* =========================================================
   ESTIMATED TIMER
========================================================= */

let timerAnchor = null;
let lastTimerIssue = "";


function buildState() {

  const issue =
    liveState.targetIssue ||
    liveState.currentIssue;


  if (
    issue &&
    issue !==
      lastTimerIssue
  ) {

    timerAnchor = {

      issue,

      at:
        now()
    };

    lastTimerIssue =
      issue;
  }


  const elapsed =
    timerAnchor
      ? Math.floor(
          (
            now() -
            timerAnchor.at
          ) /
          1000
        )
      : 0;


  let countdown =
    30 -
    (
      elapsed % 30
    );


  if (
    countdown <= 0
  ) {

    countdown =
      30;
  }


  return {

    ...liveState,

    countdown,

    serverTime:
      now(),

    gameTimerMode:
      "ESTIMATED"
  };
}


/* =========================================================
   ADMIN AUTH
========================================================= */

function isAdmin(
  req,
  url
) {

  const headerKey =
    req.headers[
      "x-admin-key"
    ] ||
    req.headers[
      "authorization"
    ]?.replace(
      /^Bearer\s+/i,
      ""
    );


  const queryKey =
    url.searchParams.get(
      "key"
    );


  return (

    String(
      headerKey || ""
    ) ===
    String(
      ADMIN_KEY
    )

    ||

    String(
      queryKey || ""
    ) ===
    String(
      ADMIN_KEY
    )
  );
}


/* =========================================================
   ADMIN KEYS
========================================================= */

async function adminKeys(
  req,
  res
) {

  const url =
    new URL(
      req.url,
      "http://localhost"
    );


  if (
    !isAdmin(
      req,
      url
    )
  ) {

    json(
      res,
      401,
      {
        success:
          false,

        error:
          "UNAUTHORIZED"
      }
    );

    return;
  }


  if (!pool) {

    json(
      res,
      200,
      {

        success:
          true,

        keys:
          [],

        warning:
          "DATABASE_URL not configured"
      }
    );

    return;
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


  json(
    res,
    200,
    {

      success:
        true,

      ok:
        true,

      keys:
        result.rows
    }
  );
}


/* =========================================================
   CREATE KEY
========================================================= */

async function createKey(
  req,
  res
) {

  const url =
    new URL(
      req.url,
      "http://localhost"
    );


  if (
    !isAdmin(
      req,
      url
    )
  ) {

    json(
      res,
      401,
      {
        success:
          false,

        error:
          "UNAUTHORIZED"
      }
    );

    return;
  }


  if (!pool) {

    json(
      res,
      500,
      {
        success:
          false,

        error:
          "DATABASE_URL_NOT_CONFIGURED"
      }
    );

    return;
  }


  const body =
    await parseBody(
      req
    );


  let accessKey =
    String(
      body.access_key ||
      body.key ||
      ""
    ).trim();


  if (!accessKey) {

    accessKey =
      "DY-" +
      crypto
        .randomBytes(6)
        .toString("hex")
        .toUpperCase();
  }


  try {

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
        ($1,NULL,$2,0)
        RETURNING *
        `,
        [
          accessKey,
          now()
        ]
      );


    json(
      res,
      200,
      {

        success:
          true,

        ok:
          true,

        key:
          result.rows[0]
            .access_key,

        keys:
          result.rows
      }
    );

  } catch(error) {

    if (
      error.code ===
      "23505"
    ) {

      json(
        res,
        409,
        {

          success:
            false,

          error:
            "KEY_ALREADY_EXISTS"
        }
      );

      return;
    }


    throw error;
  }
}


/* =========================================================
   DELETE KEY
========================================================= */

async function deleteKey(
  req,
  res
) {

  const url =
    new URL(
      req.url,
      "http://localhost"
    );


  if (
    !isAdmin(
      req,
      url
    )
  ) {

    json(
      res,
      401,
      {
        success:
          false,

        error:
          "UNAUTHORIZED"
      }
    );

    return;
  }


  if (!pool) {

    json(
      res,
      500,
      {
        success:
          false,

        error:
          "DATABASE_URL_NOT_CONFIGURED"
      }
    );

    return;
  }


  const body =
    await parseBody(
      req
    );


  const id =
    safeInt(
      body.id ||
      body.key_id,
      0
    );


  const accessKey =
    String(
      body.access_key ||
      body.key ||
      ""
    ).trim();


  let result;


  if (id) {

    result =
      await pool.query(
        `
        DELETE FROM access_keys
        WHERE id = $1
        RETURNING *
        `,
        [id]
      );

  } else if (
    accessKey
  ) {

    result =
      await pool.query(
        `
        DELETE FROM access_keys
        WHERE access_key = $1
        RETURNING *
        `,
        [accessKey]
      );

  } else {

    json(
      res,
      400,
      {

        success:
          false,

        error:
          "KEY_OR_ID_REQUIRED"
      }
    );

    return;
  }


  json(
    res,
    200,
    {

      success:
        true,

      ok:
        true,

      deleted:
        result.rows[0] ||
        null
    }
  );
}


/* =========================================================
   RESET DEVICE
========================================================= */

async function resetDevice(
  req,
  res
) {

  const url =
    new URL(
      req.url,
      "http://localhost"
    );


  if (
    !isAdmin(
      req,
      url
    )
  ) {

    json(
      res,
      401,
      {
        success:
          false,

        error:
          "UNAUTHORIZED"
      }
    );

    return;
  }


  if (!pool) {

    json(
      res,
      500,
      {

        success:
          false,

        error:
          "DATABASE_URL_NOT_CONFIGURED"
      }
    );

    return;
  }


  const body =
    await parseBody(
      req
    );


  const id =
    safeInt(
      body.id ||
      body.key_id,
      0
    );


  const accessKey =
    String(
      body.access_key ||
      body.key ||
      ""
    ).trim();


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
        RETURNING *
        `,
        [id]
      );

  } else if (
    accessKey
  ) {

    result =
      await pool.query(
        `
        UPDATE access_keys
        SET
          device_id = NULL,
          last_seen = 0
        WHERE access_key = $1
        RETURNING *
        `,
        [accessKey]
      );

  } else {

    json(
      res,
      400,
      {

        success:
          false,

        error:
          "KEY_OR_ID_REQUIRED"
      }
    );

    return;
  }


  json(
    res,
    200,
    {

      success:
        true,

      ok:
        true,

      key:
        result.rows[0] ||
        null
    }
  );
}


/* =========================================================
   ADMIN STATUS
========================================================= */

async function adminStatus(
  req,
  res
) {

  const url =
    new URL(
      req.url,
      "http://localhost"
    );


  if (
    !isAdmin(
      req,
      url
    )
  ) {

    json(
      res,
      401,
      {
        success:
          false,

        error:
          "UNAUTHORIZED"
      }
    );

    return;
  }


  json(
    res,
    200,
    {

      success:
        true,

      ok:
        true,

      ready:
        liveState.ready,

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

      mode:
        "AI MODE",

      randomized:
        false,

      aiPrediction:
        liveState.aiPrediction,

      aiNumber:
        liveState.aiNumber,

      randomMixPercent:
        0,

      analysis:
        liveState.analysis,

      historyCount:
        liveState.history.length,

      predictionCount:
        liveState
          .predictionHistory
          .length,

      wins:
        liveState.wins,

      losses:
        liveState.losses,

      pending:
        liveState.pending,

      updatedAt:
        liveState.updatedAt,

      error:
        liveState.error
    }
  );
}


/* =========================================================
   ADMIN WINGOBOT TEST
========================================================= */

async function adminWingoTest(
  req,
  res
) {

  const url =
    new URL(
      req.url,
      "http://localhost"
    );


  if (
    !isAdmin(
      req,
      url
    )
  ) {

    json(
      res,
      401,
      {
        success:
          false,

        error:
          "UNAUTHORIZED"
      }
    );

    return;
  }


  try {

    const data =
      await fetchWingoBot();


    const history =
      normalizeHistory(
        data
      );


    const latest =
      getLatestSettled(
        history
      );


    const currentIssue =
      String(
        data?.current?.issueNumber ||
        ""
      );


    const targetIssue =
      resolveTargetIssue(
        currentIssue,
        latest?.issueNumber
      );


    json(
      res,
      200,
      {

        success:
          true,

        ok:
          true,

        current:
          data.current ||
          null,

        resolvedTarget:
          targetIssue,

        latestSettled:
          latest ||
          null,

        stats:
          data.stats ||
          null,

        history:
          history.slice(
            0,
            30
          )
      }
    );

  } catch(error) {

    json(
      res,
      500,
      {

        success:
          false,

        error:
          error.message
      }
    );
  }
}


/* =========================================================
   ADMIN MODEL TEST
========================================================= */

async function adminModelTest(
  req,
  res
) {

  const url =
    new URL(
      req.url,
      "http://localhost"
    );


  if (
    !isAdmin(
      req,
      url
    )
  ) {

    json(
      res,
      401,
      {

        success:
          false,

        error:
          "UNAUTHORIZED"
      }
    );

    return;
  }


  try {

    const data =
      await fetchWingoBot();


    const history =
      normalizeHistory(
        data
      );


    const latest =
      getLatestSettled(
        history
      );


    const currentIssue =
      String(
        data?.current?.issueNumber ||
        ""
      );


    const targetIssue =
      resolveTargetIssue(
        currentIssue,
        latest?.issueNumber
      );


    const prediction =
      createPrediction(
        history
      );


    json(
      res,
      200,
      {

        success:
          true,

        ok:
          true,

        currentIssue,

        latestSettledIssue:
          latest?.issueNumber ||
          "",

        targetIssue,

        prediction:
          prediction.prediction,

        number:
          prediction.number,

        confidence:
          prediction.confidence,

        mode:
          "AI MODE",

        randomized:
          false,

        aiPrediction:
          prediction.aiPrediction,

        aiNumber:
          prediction.aiNumber,

        analysis:
          prediction.analysis,

        history:
          history.slice(
            0,
            30
          ),

        avgModelAccuracy:
          prediction.analysis
            .avgModelAccuracy,

        backtestSamples:
          prediction.analysis
            .backtestSamples,

        randomMixPercent:
          0
      }
    );

  } catch(error) {

    json(
      res,
      500,
      {

        success:
          false,

        error:
          error.message
      }
    );
  }
}


/* =========================================================
   ROUTER
========================================================= */

async function router(
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
          "GET, POST, DELETE, OPTIONS"
      }
    );

    res.end();

    return;
  }


  /* HEALTH */

  if (
    req.method ===
      "GET" &&
    url.pathname ===
      "/health"
  ) {

    json(
      res,
      200,
      {

        ok:
          true,

        service:
          "DY AI Wingo",

        time:
          now()
      }
    );

    return;
  }


  /* ACCESS KEY */

  if (
    req.method ===
      "POST" &&
    url.pathname ===
      "/api/key/check"
  ) {

    const body =
      await parseBody(
        req
      );


    const result =
      await checkAccessKey(
        body.access_key ||
          body.key,

        body.device_id
      );


    json(
      res,
      result.ok
        ? 200
        : 403,
      {

        success:
          result.ok,

        ...result
      }
    );

    return;
  }


  /* STATE */

  if (
    req.method ===
      "GET" &&
    url.pathname ===
      "/api/state"
  ) {

    json(
      res,
      200,
      buildState()
    );

    return;
  }


  /* HISTORY */

  if (
    req.method ===
      "GET" &&
    url.pathname ===
      "/api/history"
  ) {

    json(
      res,
      200,
      {

        success:
          true,

        history:
          liveState.history,

        predictions:
          liveState
            .predictionHistory,

        wins:
          liveState.wins,

        losses:
          liveState.losses,

        pending:
          liveState.pending
      }
    );

    return;
  }


  /* ADMIN KEYS */

  if (
    req.method ===
      "GET" &&
    url.pathname ===
      "/api/admin/keys"
  ) {

    await adminKeys(
      req,
      res
    );

    return;
  }


  /* CREATE KEY */

  if (
    req.method ===
      "POST" &&
    url.pathname ===
      "/api/admin/keys"
  ) {

    await createKey(
      req,
      res
    );

    return;
  }


  /* DELETE KEY */

  if (
    req.method ===
      "DELETE" &&
    url.pathname ===
      "/api/admin/keys"
  ) {

    await deleteKey(
      req,
      res
    );

    return;
  }


  /* RESET DEVICE */

  if (
    req.method ===
      "POST" &&
    url.pathname ===
      "/api/admin/reset-device"
  ) {

    await resetDevice(
      req,
      res
    );

    return;
  }


  /* ADMIN STATUS */

  if (
    req.method ===
      "GET" &&
    url.pathname ===
      "/api/admin/status"
  ) {

    await adminStatus(
      req,
      res
    );

    return;
  }


  /* ADMIN PING */

  if (
    req.method ===
      "GET" &&
    url.pathname ===
      "/api/admin/ping"
  ) {

    if (
      !isAdmin(
        req,
        url
      )
    ) {

      json(
        res,
        401,
        {

          success:
            false,

          error:
            "UNAUTHORIZED"
        }
      );

      return;
    }


    json(
      res,
      200,
      {

        success:
          true,

        ok:
          true,

        time:
          now()
      }
    );

    return;
  }


  /* WINGOBOT TEST */

  if (
    req.method ===
      "GET" &&
    url.pathname ===
      "/api/admin/wingo-test"
  ) {

    await adminWingoTest(
      req,
      res
    );

    return;
  }


  /* MODEL TEST */

  if (
    req.method ===
      "GET" &&
    url.pathname ===
      "/api/admin/model-test"
  ) {

    await adminModelTest(
      req,
      res
    );

    return;
  }


  /* PREDICTION */

  if (
    req.method ===
      "GET" &&
    (
      url.pathname ===
        "/" ||
      url.pathname ===
        "/prediction.html"
    )
  ) {

    serveFile(
      res,

      path.join(
        PUBLIC_DIR,
        "prediction.html"
      ),

      "text/html; charset=utf-8"
    );

    return;
  }


  /* ADMIN */

  if (
    req.method ===
      "GET" &&
    url.pathname ===
      "/admin.html"
  ) {

    serveFile(
      res,

      path.join(
        PUBLIC_DIR,
        "admin.html"
      ),

      "text/html; charset=utf-8"
    );

    return;
  }


  /* MUSIC */

  if (
    req.method ===
      "GET" &&
    url.pathname ===
      "/music.mp3"
  ) {

    serveAudio(
      req,
      res,

      path.join(
        PUBLIC_DIR,
        "music.mp3"
      )
    );

    return;
  }


  text(
    res,
    404,
    "Not Found"
  );
}


/* =========================================================
   STATIC FILE
========================================================= */

function serveFile(
  res,
  filePath,
  contentType
) {

  fs.readFile(
    filePath,
    (
      error,
      data
    ) => {

      if (error) {

        text(
          res,
          404,
          "File not found"
        );

        return;
      }


      res.writeHead(
        200,
        {

          "Content-Type":
            contentType,

          "Cache-Control":
            "no-cache"
        }
      );


      res.end(data);
    }
  );
}


/* =========================================================
   AUDIO
========================================================= */

function serveAudio(
  req,
  res,
  filePath
) {

  fs.stat(
    filePath,
    (
      error,
      stats
    ) => {

      if (error) {

        text(
          res,
          404,
          "music.mp3 not found"
        );

        return;
      }


      const range =
        req.headers.range;


      if (!range) {

        res.writeHead(
          200,
          {

            "Content-Type":
              "audio/mpeg",

            "Content-Length":
              stats.size,

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
        range.match(
          /bytes=(\d*)-(\d*)/
        );


      if (!match) {

        res.writeHead(
          416
        );

        res.end();

        return;
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
          : stats.size - 1;


      if (
        start >= stats.size ||
        end >= stats.size ||
        start > end
      ) {

        res.writeHead(
          416
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

          "Content-Range":
            `bytes ${start}-${end}/${stats.size}`,

          "Accept-Ranges":
            "bytes",

          "Content-Length":
            chunkSize,

          "Content-Type":
            "audio/mpeg"
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
   START
========================================================= */

const server =
  http.createServer(
    (
      req,
      res
    ) => {

      router(
        req,
        res
      ).catch(
        error => {

          console.error(
            "[SERVER]",
            error
          );


          if (
            !res.headersSent
          ) {

            json(
              res,
              500,
              {

                success:
                  false,

                error:
                  "SERVER_ERROR",

                message:
                  error.message
              }
            );

          } else {

            res.end();
          }
        }
      );
    }
  );


async function start() {

  try {

    await initDb();

  } catch(error) {

    console.error(
      "[DB INIT]",
      error.message
    );
  }


  await updateLiveState();


  /*
    API polling:
    every 3 seconds.
  */

  setInterval(
    updateLiveState,
    3000
  );


  server.listen(
    PORT,
    "0.0.0.0",
    () => {

      console.log(
        `DY AI Wingo running on port ${PORT}`
      );

      console.log(
        "Expert AI: ENABLED"
      );

      console.log(
        "Random Mix: DISABLED"
      );
    }
  );
}


start();
