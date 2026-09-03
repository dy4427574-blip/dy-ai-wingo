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

const RANDOM_MIX_PERCENT = Math.max(
  0,
  Math.min(
    100,
    Number(
      process.env.RANDOM_MIX_PERCENT || 25
    )
  )
);

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

  randomMixPercent:
    RANDOM_MIX_PERCENT,

  aiPrediction: "WAIT",

  aiNumber: null,

  analysis: {
    status: "WAIT",

    patternScore: 0,

    modelAgreement: 0,

    backtestSamples: 0,

    avgModelAccuracy: null,

    evidence: [],

    randomized: false,

    mode: "AI MODE"
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


function normalizeSide(value) {

  const v =
    String(
      value || ""
    ).toUpperCase();

  if (v === "BIG")
    return "BIG";

  if (v === "SMALL")
    return "SMALL";

  return "";
}


function sideFromNumber(number) {

  const n =
    Number(number);

  if (!Number.isFinite(n))
    return "";

  return n >= 5
    ? "BIG"
    : "SMALL";
}


function randomInt(
  min,
  max
) {

  return Math.floor(
    Math.random() *
      (max - min + 1)
  ) + min;
}


/* =========================================================
   PERIOD HELPERS
========================================================= */

/*
  Example:

  20260903100051103
             ↓
  20260903100051104

  We increment the numeric issue safely with BigInt.
*/

function incrementIssue(
  issue
) {

  const value =
    String(issue || "").trim();

  if (!value)
    return "";

  if (!/^\d+$/.test(value))
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


/*
  Compare numeric issue IDs.

  Returns:
    1  a > b
    0  equal
   -1  a < b

  If non-numeric, fallback to string comparison.
*/

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

    if (A > B) return 1;

    if (A < B) return -1;

    return 0;
  }

  if (aa > bb) return 1;

  if (aa < bb) return -1;

  return 0;
}


/*
  This is the important target resolver.

  Example 1:

  API current = 51104
  latest settled = 51103

  target = 51104

  Example 2:

  API current = 51103
  latest settled = 51103

  target = 51104

  Therefore latest settled result is NEVER
  used as the next prediction target.
*/

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
    return incrementIssue(latest);
  }

  const comparison =
    compareIssues(
      current,
      latest
    );

  if (comparison > 0) {

    /*
      Current is already ahead.
    */

    return current;
  }

  /*
    Current is same/behind latest settled.
    Next issue is required.
  */

  return (
    incrementIssue(latest) ||
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
   WINGOBOT
========================================================= */

function fetchWingoBot() {

  return new Promise(
    (resolve, reject) => {

      if (!WINGOBOT_TOKEN) {

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
                "DY-AI-Wingo/2.0"
            },

            timeout: 10000
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
    .slice(0, 10)
    .map(
      row =>
        `${row.issueNumber}:${row.number}:${row.side}`
    )
    .join("|");
}


/* =========================================================
   MODELS
========================================================= */

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
    )
      big++;

    if (
      row.side === "SMALL"
    )
      small++;
  }

  return {
    big,
    small,

    total:
      big + small
  };
}


function recentSide(
  rows,
  windowSize
) {

  return countSides(
    rows.slice(
      0,
      windowSize
    )
  );
}


function sideScoreFromCounts(
  counts
) {

  if (
    !counts.total
  ) {

    return {
      BIG: 0,
      SMALL: 0
    };
  }

  return {

    BIG:
      (
        counts.big -
        counts.small
      ) /
      counts.total,

    SMALL:
      (
        counts.small -
        counts.big
      ) /
      counts.total
  };
}


/* =========================================================
   TRANSITION
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
      history[i];

    const previous =
      history[i + 1];

    if (
      !current.side ||
      !previous.side
    )
      continue;

    transitions[
      previous.side
    ][
      current.side
    ]++;
  }

  const current =
    history[0]?.side;

  if (!current) {

    return {
      BIG: 0,
      SMALL: 0,
      sample: 0
    };
  }

  const data =
    transitions[current];

  const total =
    data.BIG +
    data.SMALL;

  if (!total) {

    return {
      BIG: 0,
      SMALL: 0,
      sample: 0
    };
  }

  return {

    BIG:
      (
        data.BIG -
        data.SMALL
      ) /
      total,

    SMALL:
      (
        data.SMALL -
        data.BIG
      ) /
      total,

    sample:
      total
  };
}


/* =========================================================
   PATTERN
========================================================= */

function patternEvidence(
  history
) {

  const result = {

    BIG: 0,

    SMALL: 0,

    samples: 0
  };

  if (
    history.length < 6
  )
    return result;

  for (
    const length of
      [2, 3, 4]
  ) {

    if (
      history.length <=
      length + 1
    )
      continue;

    const currentPattern =
      history
        .slice(
          0,
          length
        )
        .map(
          x => x.side
        )
        .join("");

    let big = 0;

    let small = 0;

    for (
      let i = length;
      i <
        history.length;
      i++
    ) {

      const pattern =
        history
          .slice(
            i - length,
            i
          )
          .map(
            x => x.side
          )
          .join("");

      if (
        pattern !==
        currentPattern
      )
        continue;

      const next =
        history[i - 1];

      if (
        next?.side === "BIG"
      )
        big++;

      if (
        next?.side === "SMALL"
      )
        small++;
    }

    const total =
      big + small;

    if (total > 0) {

      result.BIG +=
        (
          big - small
        ) /
        total;

      result.SMALL +=
        (
          small - big
        ) /
        total;

      result.samples +=
        total;
    }
  }

  if (
    result.samples
  ) {

    result.BIG /= 3;

    result.SMALL /= 3;
  }

  return result;
}


/* =========================================================
   STREAK
========================================================= */

function getStreak(
  history
) {

  if (
    !history.length ||
    !history[0].side
  ) {

    return {
      side: "",
      length: 0
    };
  }

  const side =
    history[0].side;

  let length = 0;

  for (
    const row of history
  ) {

    if (
      row.side !== side
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
    getStreak(history);

  if (
    !streak.side ||
    streak.length < 2
  ) {

    return {
      BIG: 0,
      SMALL: 0,
      length:
        streak.length
    };
  }

  const transition =
    transitionEvidence(
      history
    );

  const followWeight =
    Math.min(
      0.22,
      streak.length *
        0.035
    );

  const result = {

    BIG: 0,

    SMALL: 0,

    length:
      streak.length
  };

  result[
    streak.side
  ] += followWeight;

  if (
    transition.sample >= 3
  ) {

    result.BIG +=
      transition.BIG *
      0.18;

    result.SMALL +=
      transition.SMALL *
      0.18;
  }

  return result;
}


/* =========================================================
   ENSEMBLE
========================================================= */

function runModels(
  history
) {

  const evidence = [];

  let BIG = 0;

  let SMALL = 0;


  const r3 =
    sideScoreFromCounts(
      recentSide(
        history,
        3
      )
    );

  BIG +=
    r3.BIG *
    0.18;

  SMALL +=
    r3.SMALL *
    0.18;

  evidence.push({
    name: "RECENCY 3",
    BIG: r3.BIG,
    SMALL: r3.SMALL
  });


  const r5 =
    sideScoreFromCounts(
      recentSide(
        history,
        5
      )
    );

  BIG +=
    r5.BIG *
    0.17;

  SMALL +=
    r5.SMALL *
    0.17;

  evidence.push({
    name: "RECENCY 5",
    BIG: r5.BIG,
    SMALL: r5.SMALL
  });


  const r8 =
    sideScoreFromCounts(
      recentSide(
        history,
        8
      )
    );

  BIG +=
    r8.BIG *
    0.13;

  SMALL +=
    r8.SMALL *
    0.13;

  evidence.push({
    name: "RECENCY 8",
    BIG: r8.BIG,
    SMALL: r8.SMALL
  });


  const r10 =
    sideScoreFromCounts(
      recentSide(
        history,
        10
      )
    );

  BIG +=
    r10.BIG *
    0.10;

  SMALL +=
    r10.SMALL *
    0.10;

  evidence.push({
    name: "BALANCE 10",
    BIG: r10.BIG,
    SMALL: r10.SMALL
  });


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
    name: "TRANSITION",
    BIG: transition.BIG,
    SMALL: transition.SMALL
  });


  const pattern =
    patternEvidence(
      history
    );

  BIG +=
    pattern.BIG *
    0.15;

  SMALL +=
    pattern.SMALL *
    0.15;

  evidence.push({
    name: "PATTERN",
    BIG: pattern.BIG,
    SMALL: pattern.SMALL
  });


  const streak =
    streakEvidence(
      history
    );

  BIG +=
    streak.BIG *
    0.10;

  SMALL +=
    streak.SMALL *
    0.10;

  evidence.push({
    name: "STREAK",
    BIG: streak.BIG,
    SMALL: streak.SMALL
  });


  const totalAbs =
    Math.abs(BIG) +
    Math.abs(SMALL);

  let side =
    "WAIT";


  if (
    BIG > SMALL
  )
    side = "BIG";


  if (
    SMALL > BIG
  )
    side = "SMALL";


  const rawEdge =
    Math.abs(
      BIG - SMALL
    ) /
    Math.max(
      0.01,
      totalAbs
    );


  const minimumEdge =
    history.length < 15
      ? 0.16
      : 0.10;


  if (
    rawEdge <
    minimumEdge
  ) {

    side =
      "WAIT";
  }


  const agreement =
    evidence.filter(
      item => {

        const d =
          item.BIG -
          item.SMALL;

        if (
          side === "BIG"
        )
          return d > 0.05;

        if (
          side === "SMALL"
        )
          return d < -0.05;

        return false;
      }
    ).length;


  const modelAgreement =
    evidence.length
      ? Math.round(
          (
            agreement /
            evidence.length
          ) *
          100
        )
      : 0;


  return {

    side,

    BIG,

    SMALL,

    edge:
      rawEdge,

    modelAgreement,

    evidence
  };
}


/* =========================================================
   BACKTEST
========================================================= */

function predictFromPast(
  history
) {

  return runModels(
    history
  ).side;
}


function backtest(
  history
) {

  if (
    history.length < 15
  ) {

    return {
      samples: 0,
      accuracy: null
    };
  }

  const maxSamples =
    Math.min(
      history.length - 10,
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
      targetIndex <= 8
    )
      break;

    const target =
      history[
        targetIndex
      ];

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
      prediction !== "BIG" &&
      prediction !== "SMALL"
    )
      continue;

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
        : null
  };
}


/* =========================================================
   NUMBER
========================================================= */

function chooseNumber(
  history,
  side
) {

  if (
    side !== "BIG" &&
    side !== "SMALL"
  )
    return null;


  const allowed =
    side === "BIG"
      ? [5, 6, 7, 8, 9]
      : [0, 1, 2, 3, 4];


  const counts = {};

  for (
    const n of allowed
  ) {

    counts[n] = 0;
  }


  history
    .slice(0, 30)
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
            1,
            8 -
              Math.floor(
                index / 4
              )
          );

        counts[n] +=
          weight;
      }
    );


  let minCount =
    Infinity;

  for (
    const n of allowed
  ) {

    minCount =
      Math.min(
        minCount,
        counts[n]
      );
  }


  const candidates =
    allowed.filter(
      n =>
        counts[n] <=
        minCount + 2
    );


  return candidates[
    randomInt(
      0,
      candidates.length - 1
    )
  ];
}


/* =========================================================
   CONFIDENCE
========================================================= */

function adaptiveConfidence(
  model,
  bt,
  historyLength
) {

  let confidence =
    50 +
    model.edge *
      42;


  if (
    model.modelAgreement >= 70
  ) {

    confidence += 5;
  }


  if (
    model.modelAgreement >= 85
  ) {

    confidence += 4;
  }


  if (
    bt.samples >= 20 &&
    bt.accuracy != null
  ) {

    confidence =
      confidence *
        0.70 +
      bt.accuracy *
        0.30;
  }


  if (
    historyLength < 15
  ) {

    confidence =
      Math.min(
        confidence,
        58
      );

  } else {

    confidence =
      Math.min(
        confidence,
        78
      );
  }


  confidence =
    Math.max(
      0,
      Math.round(
        confidence
      )
    );


  return confidence;
}


/* =========================================================
   RANDOM MIX
========================================================= */

function applyRandomMix(
  base,
  history
) {

  if (
    RANDOM_MIX_PERCENT <= 0 ||
    history.length < 10 ||
    (
      base.prediction !== "BIG" &&
      base.prediction !== "SMALL"
    )
  ) {

    return {

      prediction:
        base.prediction,

      number:
        base.number,

      randomized:
        false,

      mode:
        "AI MODE",

      aiPrediction:
        base.prediction,

      aiNumber:
        base.number,

      confidence:
        base.confidence,

      status:
        base.status
    };
  }


  const roll =
    Math.random() *
    100;


  if (
    roll >=
    RANDOM_MIX_PERCENT
  ) {

    return {

      prediction:
        base.prediction,

      number:
        base.number,

      randomized:
        false,

      mode:
        "AI MODE",

      aiPrediction:
        base.prediction,

      aiNumber:
        base.number,

      confidence:
        base.confidence,

      status:
        base.status
    };
  }


  const opposite =
    base.prediction === "BIG"
      ? "SMALL"
      : "BIG";


  const randomNumber =
    chooseNumber(
      history,
      opposite
    );


  return {

    prediction:
      opposite,

    number:
      randomNumber,

    randomized:
      true,

    mode:
      "RANDOM MIX",

    aiPrediction:
      base.prediction,

    aiNumber:
      base.number,

    confidence:
      Math.min(
        55,
        base.confidence
      ),

    status:
      "RANDOM MIX"
  };
}


/* =========================================================
   CREATE PREDICTION
========================================================= */

function createPrediction(
  history
) {

  if (
    history.length < 8
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

        evidence:
          [],

        randomized:
          false,

        mode:
          "AI MODE"
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


  const prediction =
    model.side;


  if (
    prediction !== "BIG" &&
    prediction !== "SMALL"
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
          Math.round(
            model.edge *
            100
          ),

        modelAgreement:
          model.modelAgreement,

        backtestSamples:
          bt.samples,

        avgModelAccuracy:
          bt.accuracy,

        evidence:
          model.evidence,

        randomized:
          false,

        mode:
          "AI MODE"
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
      prediction
    );


  let status =
    "EARLY SIGNAL";


  if (
    model.edge >= 0.30 &&
    model.modelAgreement >= 70
  ) {

    status =
      "STRONGER SIGNAL";

  } else if (
    model.edge >= 0.20 &&
    model.modelAgreement >= 55
  ) {

    status =
      "MODERATE SIGNAL";

  } else if (
    model.edge < 0.15
  ) {

    status =
      "WEAK SIGNAL";
  }


  const mixed =
    applyRandomMix(
      {
        prediction,
        number,
        confidence,
        status
      },
      history
    );


  return {

    prediction:
      mixed.prediction,

    number:
      mixed.number,

    confidence:
      mixed.confidence,

    status:
      mixed.status,

    mode:
      mixed.mode,

    randomized:
      mixed.randomized,

    aiPrediction:
      mixed.aiPrediction,

    aiNumber:
      mixed.aiNumber,

    analysis: {

      status:
        mixed.status,

      patternScore:
        Math.round(
          model.edge *
          100
        ),

      modelAgreement:
        model.modelAgreement,

      backtestSamples:
        bt.samples,

      avgModelAccuracy:
        bt.accuracy,

      evidence:
        model.evidence,

      randomized:
        mixed.randomized,

      mode:
        mixed.mode
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

        prediction.mode,

        Boolean(
          prediction.randomized
        ),

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


  /*
    Load all pending predictions.
  */

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


    let outcome =
      "LOSS";


    if (
      prediction.prediction ===
      actualSide
    ) {

      outcome =
        "WIN";
    }


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
   GET PREDICTION HISTORY
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
          (WHERE outcome = 'WIN') AS wins,

        COUNT(*) FILTER
          (WHERE outcome = 'LOSS') AS losses,

        COUNT(*) FILTER
          (WHERE outcome = 'PENDING') AS pending

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


    /*
      API current issue.
    */

    const apiCurrent =
      String(
        data?.current?.issueNumber ||
        ""
      ).trim();


    const latestSettledIssue =
      String(
        latest.issueNumber
      );


    /*
      CRITICAL FIX:
      Resolve the actual NEXT TARGET.
    */

    const targetIssue =
      resolveTargetIssue(
        apiCurrent,
        latestSettledIssue
      );


    /*
      First settle any previous predictions
      whose exact target now exists in history.
    */

    await settlePredictions(
      history
    );


    /*
      Check if target prediction already exists.
    */

    let record =
      await getPredictionRecord(
        targetIssue
      );


    /*
      Only create prediction once
      for this exact target.
    */

    if (!record) {

      const prediction =
        createPrediction(
          history
        );


      record =
        await savePredictionRecord(
          targetIssue,
          prediction
        );


      /*
        If DB is unavailable, keep in memory.
      */

      if (!record) {

        record = {

          target_issue:
            targetIssue,

          prediction:
            prediction.prediction,

          predicted_number:
            prediction.number,

          ai_prediction:
            prediction.aiPrediction,

          ai_number:
            prediction.aiNumber,

          mode:
            prediction.mode,

          randomized:
            prediction.randomized,

          confidence:
            prediction.confidence,

          status:
            prediction.status,

          created_at:
            now(),

          result_number:
            null,

          result_side:
            null,

          outcome:
            "PENDING"
        };
      }


      console.log(
        `[PREDICTION CREATED] ${targetIssue} => ${record.prediction} | number=${record.predicted_number} | mode=${record.mode}`
      );
    }


    /*
      If target already has a record,
      NEVER regenerate it.
    */


    const predictionChanged =
      String(
        liveState.targetIssue
      ) !==
      String(
        targetIssue
      );


    const signature =
      makeHistorySignature(
        history
      );


    const stats =
      await getStats();


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
        record.mode ||
        "AI MODE",

      randomized:
        Boolean(
          record.randomized
        ),

      randomMixPercent:
        RANDOM_MIX_PERCENT,

      aiPrediction:
        record.ai_prediction ||
        record.prediction ||
        "WAIT",

      aiNumber:
        record.ai_number ??
        record.predicted_number ??
        null,

      analysis:
        liveState.targetIssue ===
          targetIssue &&
        liveState.analysis
          ? liveState.analysis
          : {
              status:
                record.status ||
                "WAIT",

              patternScore:
                liveState.analysis
                  ?.patternScore ||
                0,

              modelAgreement:
                liveState.analysis
                  ?.modelAgreement ||
                0,

              backtestSamples:
                liveState.analysis
                  ?.backtestSamples ||
                0,

              avgModelAccuracy:
                liveState.analysis
                  ?.avgModelAccuracy ??
                null,

              evidence:
                liveState.analysis
                  ?.evidence ||
                [],

              randomized:
                Boolean(
                  record.randomized
                ),

              mode:
                record.mode ||
                "AI MODE"
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
        signature,

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


    /*
      If this is a brand-new target,
      create fresh analysis metadata.
    */

    if (
      predictionChanged
    ) {

      const model =
        createPrediction(
          history
        );


      liveState.analysis = {
        ...model.analysis,

        /*
          Use saved prediction's actual
          random state.
        */

        randomized:
          Boolean(
            record.randomized
          ),

        mode:
          record.mode ||
          "AI MODE"
      };
    }


    /*
      Important:
      If target did not change,
      prediction stays exactly the same.
    */

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
   STATE
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


  /*
    UI timer only.
    Exact provider countdown isn't
    exposed in documented history response.
  */

  let countdown =
    30 -
    (
      elapsed % 30
    );


  if (
    countdown <= 0
  )
    countdown = 30;


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
      ) ||
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
        liveState.mode,

      randomized:
        liveState.randomized,

      aiPrediction:
        liveState.aiPrediction,

      aiNumber:
        liveState.aiNumber,

      randomMixPercent:
        RANDOM_MIX_PERCENT,

      analysis:
        liveState.analysis,

      historyCount:
        liveState.history.length,

      predictionCount:
        liveState.predictionHistory
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
          prediction.mode,

        randomized:
          prediction.randomized,

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
          RANDOM_MIX_PERCENT
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


  /* KEY */

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


  /* WINGO TEST */

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
   STATIC
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
    WingoBot polling every 3 seconds.
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
        `Random Mix: ${RANDOM_MIX_PERCENT}%`
      );
    }
  );
}


start();
