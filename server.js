"use strict";

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { Pool } = require("pg");

// ============================================================
// CONFIG
// ============================================================

const PORT =
  Number(process.env.PORT || 10000);

const ADMIN_KEY =
  String(
    process.env.ADMIN_KEY || ""
  ).trim();

const WINGOBOT_TOKEN =
  String(
    process.env.WINGOBOT_TOKEN || ""
  ).trim();

const DATABASE_URL =
  String(
    process.env.DATABASE_URL || ""
  ).trim();

const WINGOBOT_API =
  "https://api.wingobot.com/v2/30-sec-game-history";

const MODEL_VERSION =
  "DY-AI-CHART-PATTERN-V1";

const THINKING_DURATION_MS =
  3000;

const PROVIDER_REFRESH_MS =
  3000;

const REQUEST_TIMEOUT_MS =
  12000;

let pool = null;


// ============================================================
// DATABASE CONNECTION
// ============================================================

if (DATABASE_URL) {

  pool = new Pool({
    connectionString:
      DATABASE_URL,

    ssl:
      DATABASE_URL.includes(
        "localhost"
      )
        ? false
        : {
            rejectUnauthorized:
              false
          }
  });

}


// ============================================================
// DATABASE INITIALIZATION
// ============================================================

async function initDatabase() {

  if (!pool) {

    console.log(
      "[DB] DATABASE_URL missing"
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
    );
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
    );
  `);


  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_prediction_issue
    ON prediction_records(target_issue);
  `);


  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_prediction_created
    ON prediction_records(created_at DESC);
  `);


  console.log(
    "[DB] Ready"
  );
}


// ============================================================
// GLOBAL STATE
// ============================================================

let providerState = {

  ok: false,

  currentIssue: null,

  history: [],

  fetched: 0,

  lastUpdated: 0,

  error: null

};


let modelCache = {

  targetIssue: null,

  prediction: null,

  generatedAt: 0

};


let refreshInProgress =
  false;


// ============================================================
// BASIC HELPERS
// ============================================================

function now() {
  return Date.now();
}


function percentage(
  part,
  total
) {

  if (!total) {
    return 0;
  }

  return Number(
    (
      (part / total) *
      100
    ).toFixed(2)
  );
}


function randomKey() {

  return (
    "DY-" +
    crypto
      .randomBytes(12)
      .toString("hex")
      .toUpperCase()
  );
}


function numberToType(
  number
) {

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
    ? "B"
    : "S";
}


function typeLabel(type) {

  if (type === "B") {
    return "BIG";
  }

  if (type === "S") {
    return "SMALL";
  }

  return "UNKNOWN";
}


function incrementIssue(
  issue
) {

  if (
    issue === null ||
    issue === undefined
  ) {
    return null;
  }


  const value =
    String(issue);


  if (
    !/^\d+$/.test(value)
  ) {
    return null;
  }


  try {

    return (
      BigInt(value) + 1n
    )
      .toString()
      .padStart(
        value.length,
        "0"
      );

  } catch {

    return null;
  }
}


function compareIssue(
  a,
  b
) {

  try {

    const aa =
      BigInt(String(a));

    const bb =
      BigInt(String(b));


    if (aa > bb) {
      return 1;
    }

    if (aa < bb) {
      return -1;
    }

    return 0;

  } catch {

    return 0;
  }
}


// ============================================================
// JSON RESPONSE
// ============================================================

function json(
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
        "no-store",

      "Access-Control-Allow-Origin":
        "*",

      "Access-Control-Allow-Headers":
        "Content-Type, X-Access-Key, X-Device-Id, X-Admin-Key",

      "Access-Control-Allow-Methods":
        "GET, POST, DELETE, OPTIONS"
    }
  );


  res.end(body);
}


function text(
  res,
  status,
  body,
  contentType =
    "text/plain; charset=utf-8"
) {

  res.writeHead(
    status,
    {
      "Content-Type":
        contentType,

      "Cache-Control":
        "no-store"
    }
  );


  res.end(body);
}


// ============================================================
// REQUEST BODY
// ============================================================

function readBody(req) {

  return new Promise(
    (
      resolve,
      reject
    ) => {

      let data = "";


      req.on(
        "data",
        chunk => {

          data += chunk;


          if (
            data.length >
            1024 * 1024
          ) {

            reject(
              new Error(
                "Body too large"
              )
            );


            req.destroy();
          }
        }
      );


      req.on(
        "end",
        () => {

          if (!data) {

            resolve({});

            return;
          }


          try {

            resolve(
              JSON.parse(data)
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


// ============================================================
// WINGOBOT API
// ============================================================

function fetchWingoBot() {

  return new Promise(
    (
      resolve,
      reject
    ) => {

      if (!WINGOBOT_TOKEN) {

        reject(
          new Error(
            "WINGOBOT_TOKEN missing"
          )
        );

        return;
      }


      const request =
        https.request(
          WINGOBOT_API,
          {
            method: "GET",

            timeout:
              REQUEST_TIMEOUT_MS,

            headers: {

              Authorization:
                `Bearer ${WINGOBOT_TOKEN}`,

              Accept:
                "application/json",

              "User-Agent":
                "DY-AI-Wingo/3.0"
            }
          },


          response => {

            let body = "";


            response.on(
              "data",
              chunk => {
                body += chunk;
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
                      `WingoBot HTTP ${response.statusCode}`
                    )
                  );

                  return;
                }


                try {

                  resolve(
                    JSON.parse(body)
                  );

                } catch {

                  reject(
                    new Error(
                      "Invalid WingoBot JSON"
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
              "WingoBot timeout"
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


// ============================================================
// NORMALIZE WINGOBOT HISTORY
// ============================================================

function normalizeHistory(
  payload
) {

  const raw =
    Array.isArray(
      payload?.history
    )
      ? payload.history

      : Array.isArray(
          payload?.data
        )
      ? payload.data

      : Array.isArray(
          payload?.results
        )
      ? payload.results

      : [];


  const result = [];


  for (
    const item of raw
  ) {

    const issue =
      item?.issueNumber ??
      item?.issue ??
      item?.period ??
      item?.periodNumber;


    const number =
      item?.number ??
      item?.result ??
      item?.openNumber ??
      item?.digit;


    const n =
      Number(number);


    if (
      issue !== undefined &&
      Number.isInteger(n) &&
      n >= 0 &&
      n <= 9
    ) {

      result.push({

        issueNumber:
          String(issue),

        number:
          n,

        colour:
          item?.colour ??
          item?.color ??
          null,

        premium:
          item?.premium ??
          null,

        sum:
          item?.sum ??
          null

      });

    }

  }


  return result;
}


// ============================================================
// PROVIDER CURRENT ISSUE
// ============================================================

function providerCurrentIssue(
  payload
) {

  return (

    payload?.current
      ?.issueNumber

    ??

    payload?.currentIssue

    ??

    payload?.current
      ?.issue

    ??

    payload?.current
      ?.period

    ??

    null

  );
}


// ============================================================
// REFRESH PROVIDER
// ============================================================

async function refreshProvider() {

  if (refreshInProgress) {
    return providerState;
  }


  refreshInProgress =
    true;


  try {

    const payload =
      await fetchWingoBot();


    const history =
      normalizeHistory(
        payload
      );


    const currentIssue =
      providerCurrentIssue(
        payload
      );


    providerState = {

      ok: true,

      currentIssue:
        currentIssue !== null
          ? String(currentIssue)
          : history[0]
              ?.issueNumber ||
            null,

      history,

      fetched:
        Number(
          payload?.stats
            ?.fetched
        ) ||
        history.length,

      lastUpdated:
        Number(
          payload?.stats
            ?.last_updated
        ) ||
        now(),

      error: null

    };


    return providerState;

  } catch (error) {

    providerState = {

      ...providerState,

      ok: false,

      error:
        error.message ||
        "Provider error"

    };


    return providerState;

  } finally {

    refreshInProgress =
      false;

  }

}


// ============================================================
// CHART PATTERN ENGINE
// ============================================================
//
// ONLY THESE PATTERNS DECIDE THE PREDICTION:
//
// 1. SINGLE TREND
// 2. DOUBLE TREND
// 3. TRIPLE TREND
// 4. QUADRA TREND
// 5. THREE IN ONE
// 6. TWO IN ONE
// 7. THREE IN TWO
// 8. FOUR IN ONE
// 9. FOUR IN TWO
// 10. LONG TREND
//
// Number:
// 0-4 = SMALL
// 5-9 = BIG
//
// Latest result = last item
//
// No forced alternation.
// No random prediction.
// No frequency-based prediction.
// No momentum-based prediction.
// ============================================================

function humanBigSmallLogic(
  results
) {

  // ----------------------------------------------------------
  // CLEAN NUMBERS
  // ----------------------------------------------------------

  const clean = [];


  for (
    const value of
      Array.isArray(results)
        ? results
        : []
  ) {

    let n;


    if (
      typeof value ===
      "object" &&
      value !== null
    ) {

      n =
        Number(
          value.number ??
          value.actual_number ??
          value.value
        );

    } else {

      n =
        Number(value);

    }


    if (
      Number.isInteger(n) &&
      n >= 0 &&
      n <= 9
    ) {

      clean.push(n);

    }

  }


  const sequence =
    clean.map(
      n =>
        numberToType(n)
    );


  const sequenceString =
    sequence.join("");


  const dataSize =
    sequence.length;


  // ----------------------------------------------------------
  // MINIMUM DATA
  // ----------------------------------------------------------

  if (
    dataSize < 5
  ) {

    return {

      status:
        "INSUFFICIENT DATA",

      prediction:
        null,

      confidence:
        0,

      confidenceLevel:
        "VERY LOW",

      classification:
        "INSUFFICIENT DATA",

      pattern:
        "NONE",

      matchedPattern:
        null,

      matchedSequence:
        null,

      sequence:
        sequenceString,

      dataSize,

      historicalMatches:
        0,

      historicalCorrect:
        0,

      historicalRate:
        null,

      reason:
        "At least 5 valid results are required."

    };

  }


  // ----------------------------------------------------------
  // CHART PATTERNS
  // ----------------------------------------------------------

  const patterns = [

    // ========================================================
    // 1. SINGLE TREND
    // ========================================================

    {
      name:
        "SINGLE TREND",

      sequence:
        "BSBSB",

      next:
        "S",

      confidence:
        72
    },

    {
      name:
        "SINGLE TREND",

      sequence:
        "SBSBS",

      next:
        "B",

      confidence:
        72
    },


    // ========================================================
    // 2. DOUBLE TREND
    // ========================================================

    {
      name:
        "DOUBLE TREND",

      sequence:
        "SSBBSS",

      next:
        "B",

      confidence:
        75
    },

    {
      name:
        "DOUBLE TREND",

      sequence:
        "BBSSBB",

      next:
        "S",

      confidence:
        75
    },


    // ========================================================
    // 3. TRIPLE TREND
    // ========================================================

    {
      name:
        "TRIPLE TREND",

      sequence:
        "BBBSSS",

      next:
        "B",

      confidence:
        77
    },

    {
      name:
        "TRIPLE TREND",

      sequence:
        "SSSBBB",

      next:
        "S",

      confidence:
        77
    },


    // ========================================================
    // 4. QUADRA TREND
    // ========================================================

    {
      name:
        "QUADRA TREND",

      sequence:
        "SSSSBBBB",

      next:
        "S",

      confidence:
        80
    },

    {
      name:
        "QUADRA TREND",

      sequence:
        "BBBBSSSS",

      next:
        "B",

      confidence:
        80
    },


    // ========================================================
    // 5. THREE IN ONE
    // ========================================================

    {
      name:
        "THREE IN ONE",

      sequence:
        "BBBSBBB",

      next:
        "S",

      confidence:
        82
    },

    {
      name:
        "THREE IN ONE",

      sequence:
        "SSSBSSS",

      next:
        "B",

      confidence:
        82
    },


    // ========================================================
    // 6. TWO IN ONE
    // ========================================================

    {
      name:
        "TWO IN ONE",

      sequence:
        "SSBSSBSS",

      next:
        "B",

      confidence:
        83
    },

    {
      name:
        "TWO IN ONE",

      sequence:
        "BBSBBSBB",

      next:
        "S",

      confidence:
        83
    },


    // ========================================================
    // 7. THREE IN TWO
    // ========================================================

    {
      name:
        "THREE IN TWO",

      sequence:
        "BBBSSBBB",

      next:
        "S",

      confidence:
        84
    },

    {
      name:
        "THREE IN TWO",

      sequence:
        "SSSBBSSS",

      next:
        "B",

      confidence:
        84
    },


    // ========================================================
    // 8. FOUR IN ONE
    // ========================================================

    {
      name:
        "FOUR IN ONE",

      sequence:
        "SSSSBSSSS",

      next:
        "B",

      confidence:
        86
    },

    {
      name:
        "FOUR IN ONE",

      sequence:
        "BBBBSBBBB",

      next:
        "S",

      confidence:
        86
    },


    // ========================================================
    // 9. FOUR IN TWO
    // ========================================================

    {
      name:
        "FOUR IN TWO",

      sequence:
        "BBBBSSBBBB",

      next:
        "S",

      confidence:
        88
    },

    {
      name:
        "FOUR IN TWO",

      sequence:
        "SSSSBBSSSS",

      next:
        "B",

      confidence:
        88
    }

  ];


  // ----------------------------------------------------------
  // LONGEST PATTERN FIRST
  // ----------------------------------------------------------

  patterns.sort(
    (
      a,
      b
    ) =>
      b.sequence.length -
      a.sequence.length
  );


  // ----------------------------------------------------------
  // EXACT SUFFIX MATCH
  // ----------------------------------------------------------

  let matched =
    null;


  for (
    const pattern of patterns
  ) {

    if (
      sequenceString.endsWith(
        pattern.sequence
      )
    ) {

      matched =
        pattern;

      break;

    }

  }


  // ----------------------------------------------------------
  // LONG TREND
  // ----------------------------------------------------------

  const latest =
    sequence[
      sequence.length - 1
    ];


  let currentRun =
    1;


  for (
    let i =
      sequence.length - 2;

    i >= 0;

    i--
  ) {

    if (
      sequence[i] !==
      latest
    ) {
      break;
    }

    currentRun++;

  }


  let longTrend =
    null;


  if (
    currentRun >= 8
  ) {

    /*
      Image shows LONG TREND as a
      sustained one-side trend.

      Therefore LONG TREND follows
      the existing trend instead of
      forcing an opposite prediction.
    */

    longTrend = {

      name:
        "LONG TREND",

      current:
        latest,

      runLength:
        currentRun,

      next:
        latest,

      confidence:
        currentRun >= 12
          ? 78
          : currentRun >= 10
          ? 74
          : 68

    };

  }


  // ----------------------------------------------------------
  // FINAL PATTERN
  // ----------------------------------------------------------

  let prediction =
    null;

  let confidence =
    0;

  let patternName =
    "NONE";

  let matchedSequence =
    null;

  let classification =
    "NO CLEAR SIGNAL";

  let reason =
    "No chart pattern matched.";


  // ----------------------------------------------------------
  // EXACT PATTERN HAS PRIORITY
  // ----------------------------------------------------------

  if (matched) {

    prediction =
      matched.next === "B"
        ? "BIG"
        : "SMALL";


    confidence =
      matched.confidence;


    patternName =
      matched.name;


    matchedSequence =
      matched.sequence;


    classification =
      "PATTERN MATCH";


    reason =
      `${matched.name} ` +
      `${matched.sequence} -> ` +
      `${matched.next}`;

  }


  // ----------------------------------------------------------
  // LONG TREND FALLBACK
  // ----------------------------------------------------------

  else if (
    longTrend
  ) {

    prediction =
      longTrend.next === "B"
        ? "BIG"
        : "SMALL";


    confidence =
      longTrend.confidence;


    patternName =
      "LONG TREND";


    matchedSequence =
      sequence
        .slice(
          -currentRun
        )
        .join("");


    classification =
      "LONG TREND";


    reason =
      `LONG TREND ${latest}` +
      ` x${currentRun}`;

  }


  // ----------------------------------------------------------
  // HISTORICAL MATCH CHECK
  // ----------------------------------------------------------
  //
  // This remains inside the same chart-pattern system.
  //
  // It asks:
  //
  // "When exactly this chart sequence appeared before,
  // what happened next?"
  //
  // It DOES NOT introduce frequency/momentum logic.
  // ----------------------------------------------------------

  let historicalMatches =
    0;

  let historicalCorrect =
    0;


  if (matched) {

    const patternString =
      matched.sequence;

    const expected =
      matched.next;

    const length =
      patternString.length;


    for (
      let i = length;
      i <
        sequence.length - 1;
      i++
    ) {

      const previous =
        sequence
          .slice(
            i - length,
            i
          )
          .join("");


      if (
        previous ===
        patternString
      ) {

        historicalMatches++;


        if (
          sequence[i] ===
          expected
        ) {

          historicalCorrect++;

        }

      }

    }

  }


  let historicalRate =
    null;


  if (
    historicalMatches > 0
  ) {

    historicalRate =
      Number(
        (
          (
            historicalCorrect /
            historicalMatches
          ) * 100
        ).toFixed(2)
      );

  }


  // ----------------------------------------------------------
  // HISTORICAL PATTERN CONFIRMATION
  // ----------------------------------------------------------
  //
  // Side NEVER changes here.
  //
  // Only confidence is adjusted.
  // ----------------------------------------------------------

  if (
    matched &&
    historicalMatches >= 2 &&
    historicalRate !== null
  ) {

    if (
      historicalRate >= 70
    ) {

      confidence =
        Math.min(
          95,
          confidence + 4
        );

    } else if (
      historicalRate < 40
    ) {

      confidence =
        Math.max(
          50,
          confidence - 8
        );

    }

  }


  // ----------------------------------------------------------
  // PATTERN STRENGTH
  // ----------------------------------------------------------

  let confidenceLevel =
    "LOW";


  if (
    confidence >= 85
  ) {

    confidenceLevel =
      "HIGH";

  } else if (
    confidence >= 75
  ) {

    confidenceLevel =
      "MEDIUM";

  } else if (
    confidence >= 60
  ) {

    confidenceLevel =
      "LOW-MEDIUM";

  } else {

    confidenceLevel =
      "LOW";

  }


  // ----------------------------------------------------------
  // RETURN
  // ----------------------------------------------------------

  return {

    status:
      "OK",

    prediction,

    confidence,

    confidenceLevel,

    classification,

    pattern:
      patternName,

    matchedPattern:
      patternName,

    matchedSequence,

    sequence:
      sequenceString,

    dataSize,

    current: {

      type:
        latest,

      label:
        typeLabel(latest),

      streak:
        currentRun

    },

    historicalMatches,

    historicalCorrect,

    historicalRate,

    reason,

    supportedPatterns: [

      "SINGLE TREND",

      "DOUBLE TREND",

      "TRIPLE TREND",

      "QUADRA TREND",

      "THREE IN ONE",

      "TWO IN ONE",

      "THREE IN TWO",

      "FOUR IN ONE",

      "FOUR IN TWO",

      "LONG TREND"

    ],

    analyzedAt:
      now()

  };

}


// ============================================================
// TARGET ISSUE
// ============================================================

function resolveTargetIssue() {

  const history =
    providerState.history;


  if (
    !history.length
  ) {
    return null;
  }


  /*
    WingoBot normally returns
    newest -> oldest.

    history[0] = latest settled.
  */

  const latest =
    history[0]?.issueNumber;


  const current =
    providerState.currentIssue;


  /*
    If provider current issue is
    genuinely ahead of latest settled,
    use it.
  */

  if (
    current &&
    latest &&
    compareIssue(
      current,
      latest
    ) > 0
  ) {

    return String(current);

  }


  /*
    Otherwise target =
    latest settled + 1.
  */

  return incrementIssue(
    latest
  );
}


// ============================================================
// GENERATE MODEL
// ============================================================

async function generateModel() {

  const history =
    providerState.history;


  /*
    WingoBot:
    newest -> oldest

    Engine:
    oldest -> newest
  */

  const numbers =
    history
      .map(
        row =>
          Number(row.number)
      )
      .filter(
        n =>
          Number.isInteger(n) &&
          n >= 0 &&
          n <= 9
      )
      .reverse();


  const analysis =
    humanBigSmallLogic(
      numbers
    );


  const targetIssue =
    resolveTargetIssue();


  const generatedAt =
    now();


  const prediction =
    analysis.prediction ||
    null;


  modelCache = {

    targetIssue,

    prediction: {

      targetIssue,

      prediction,

      confidence:
        Number(
          analysis.confidence || 0
        ),

      confidenceLevel:
        analysis.confidenceLevel ||
        "LOW",

      classification:
        analysis.classification,

      pattern:
        analysis.pattern,

      matchedPattern:
        analysis.matchedPattern,

      matchedSequence:
        analysis.matchedSequence,

      reason:
        analysis.reason,

      modelVersion:
        MODEL_VERSION,

      generatedAt,

      analysis

    },

    generatedAt

  };


  await savePrediction(
    targetIssue,
    analysis
  );


  return modelCache;
}


// ============================================================
// SAVE PREDICTION
// ============================================================

async function savePrediction(
  targetIssue,
  analysis
) {

  if (!pool) {
    return;
  }


  if (
    !targetIssue ||
    !analysis?.prediction
  ) {
    return;
  }


  try {

    /*
      Don't duplicate prediction
      for the same target issue.
    */

    const existing =
      await pool.query(
        `
        SELECT id
        FROM prediction_records
        WHERE target_issue = $1
        LIMIT 1
        `,
        [
          String(
            targetIssue
          )
        ]
      );


    if (
      existing.rows.length
    ) {

      return;

    }


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
      `,
      [

        String(
          targetIssue
        ),

        String(
          analysis.prediction
        ),

        Number(
          analysis.confidence || 0
        ),

        MODEL_VERSION,

        now()

      ]
    );


  } catch (error) {

    console.error(
      "[DB] save prediction:",
      error.message
    );

  }

}


// ============================================================
// SETTLE PREDICTIONS
// ============================================================

async function settlePredictions() {

  if (!pool) {
    return;
  }


  for (
    const row of
      providerState.history.slice(
        0,
        100
      )
  ) {

    const number =
      Number(row.number);


    const actualType =
      numberToType(
        number
      );


    if (!actualType) {
      continue;
    }


    try {

      /*
        IMPORTANT FIX:

        Prediction = BIG / SMALL

        Actual = BIG / SMALL

        Save actual_result as
        WIN / LOSS
        instead of B / S.
      */

      const result =
        await pool.query(
          `
          SELECT
            id,
            prediction,
            actual_result
          FROM prediction_records
          WHERE target_issue = $1
          LIMIT 1
          `,
          [
            String(
              row.issueNumber
            )
          ]
        );


      if (
        !result.rows.length
      ) {
        continue;
      }


      const record =
        result.rows[0];


      if (
        record.actual_result
      ) {
        continue;
      }


      const prediction =
        String(
          record.prediction ||
          ""
        ).toUpperCase();


      const actualLabel =
        actualType === "B"
          ? "BIG"
          : "SMALL";


      const actualResult =
        prediction ===
        actualLabel
          ? "WIN"
          : "LOSS";


      await pool.query(
        `
        UPDATE prediction_records
        SET
          actual_number = $1,
          actual_result = $2,
          settled_at = $3
        WHERE id = $4
        `,
        [

          number,

          actualResult,

          now(),

          record.id

        ]
      );


    } catch (error) {

      console.error(
        "[DB] settle:",
        error.message
      );

    }

  }

}


// ============================================================
// ACCESS AUTH
// ============================================================

function getAccessKey(req) {

  return String(
    req.headers[
      "x-access-key"
    ] || ""
  ).trim();

}


function getDeviceId(req) {

  return String(
    req.headers[
      "x-device-id"
    ] || ""
  ).trim();

}


function getAdminKey(req) {

  return String(
    req.headers[
      "x-admin-key"
    ] || ""
  ).trim();

}


// ============================================================
// VALIDATE ACCESS KEY
// ============================================================

async function validateAccess(
  req
) {

  const key =
    getAccessKey(req);


  const device =
    getDeviceId(req);


  if (
    !key ||
    !device
  ) {

    return {

      ok: false,

      error:
        "ACCESS_KEY_OR_DEVICE_MISSING"

    };

  }


  if (!pool) {

    return {

      ok: false,

      error:
        "DATABASE_DISABLED"

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

      ok: false,

      error:
        "INVALID_ACCESS_KEY"

    };

  }


  const row =
    result.rows[0];


  /*
    One access key =
    one browser device.
  */

  if (
    row.device_id &&
    row.device_id !== device
  ) {

    return {

      ok: false,

      error:
        "KEY_ALREADY_BOUND"

    };

  }


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

        device,

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

    key:
      row.access_key,

    id:
      row.id

  };

}


// ============================================================
// ADMIN AUTH
// ============================================================

function requireAdmin(req) {

  return (
    ADMIN_KEY &&
    getAdminKey(req) ===
      ADMIN_KEY
  );

}


// ============================================================
// STATE API
// ============================================================

async function stateApi(
  req,
  res
) {

  const auth =
    await validateAccess(
      req
    );


  if (!auth.ok) {

    json(
      res,
      401,
      auth
    );

    return;
  }


  await refreshProvider();


  await settlePredictions();


  const targetIssue =
    resolveTargetIssue();


  /*
    Generate only when target changes.
  */

  if (
    !modelCache.prediction ||
    modelCache.targetIssue !==
      targetIssue
  ) {

    await generateModel();

  }


  /*
    Provider history.
  */

  const history =
    providerState.history
      .slice(
        0,
        30
      )
      .map(
        row => {

          const number =
            Number(
              row.number
            );


          const type =
            numberToType(
              number
            );


          return {

            issue:
              row.issueNumber,

            issueNumber:
              row.issueNumber,

            number,

            type,

            label:
              typeLabel(type)

          };

        }
      );


  const model =
    modelCache.prediction;


  /*
    Return multiple compatible aliases
    so current prediction.html and
    admin.html both work.
  */

  json(
    res,
    200,
    {

      ok: true,

      serverTime:
        now(),

      targetIssue,

      thinkingDurationMs:
        THINKING_DURATION_MS,


      current: {

        issueNumber:
          providerState.currentIssue,

        issue:
          providerState.currentIssue

      },


      model: {

        targetIssue:
          model?.targetIssue ||
          targetIssue,

        prediction:
          model?.prediction ||
          null,

        confidence:
          model?.confidence ||
          0,

        confidenceLevel:
          model?.confidenceLevel ||
          "LOW",

        classification:
          model?.classification ||
          "NO CLEAR SIGNAL",

        pattern:
          model?.pattern ||
          "NONE",

        matchedPattern:
          model?.matchedPattern ||
          null,

        matchedSequence:
          model?.matchedSequence ||
          null,

        reason:
          model?.reason ||
          "",

        modelVersion:
          MODEL_VERSION,

        generatedAt:
          model?.generatedAt ||
          now(),

        analysis:
          model?.analysis ||
          null

      },


      /*
        Backward-compatible direct fields.
      */

      prediction:
        model?.prediction ||
        null,


      provider: {

        ok:
          providerState.ok,

        currentIssue:
          providerState.currentIssue,

        historyCount:
          providerState.history.length,

        fetched:
          providerState.fetched,

        lastUpdated:
          providerState.lastUpdated,

        error:
          providerState.error

      },


      history

    }
  );

}


// ============================================================
// KEY CHECK
// ============================================================

async function keyCheck(
  req,
  res
) {

  const auth =
    await validateAccess(
      req
    );


  if (!auth.ok) {

    json(
      res,
      401,
      auth
    );

    return;
  }


  json(
    res,
    200,
    {

      ok: true,

      valid: true,

      key:
        auth.key,

      id:
        auth.id,

      modelVersion:
        MODEL_VERSION

    }
  );

}


// ============================================================
// PREDICTION HISTORY
// ============================================================

async function predictionHistory(
  res
) {

  if (!pool) {

    json(
      res,
      200,
      {

        ok: true,

        records: []

      }
    );

    return;
  }


  const result =
    await pool.query(
      `
      SELECT
        id,
        target_issue,
        prediction,
        confidence,
        model_version,
        actual_number,
        actual_result,
        created_at,
        settled_at
      FROM prediction_records
      ORDER BY created_at DESC
      LIMIT 100
      `
    );


  json(
    res,
    200,
    {

      ok: true,

      records:
        result.rows

    }
  );

}


// ============================================================
// ADMIN STATUS
// ============================================================

async function adminStatus(
  res
) {

  json(
    res,
    200,
    {

      ok: true,

      serverTime:
        now(),

      modelVersion:
        MODEL_VERSION,

      provider: {

        ok:
          providerState.ok,

        currentIssue:
          providerState.currentIssue,

        historyCount:
          providerState.history.length,

        fetched:
          providerState.fetched,

        lastUpdated:
          providerState.lastUpdated,

        error:
          providerState.error

      },


      model:
        modelCache

    }
  );

}


// ============================================================
// ADMIN PING
// ============================================================

function adminPing(
  res
) {

  json(
    res,
    200,
    {

      ok: true,

      message:
        "PONG",

      time:
        now(),

      modelVersion:
        MODEL_VERSION

    }
  );

}


// ============================================================
// ADMIN WINGO TEST
// ============================================================

async function adminWingoTest(
  res
) {

  const state =
    await refreshProvider();


  json(
    res,
    200,
    {

      ok:
        state.ok,

      currentIssue:
        state.currentIssue,

      historyCount:
        state.history.length,

      fetched:
        state.fetched,

      lastUpdated:
        state.lastUpdated,

      error:
        state.error,

      sample:
        state.history.slice(
          0,
          10
        )

    }
  );

}


// ============================================================
// ADMIN MODEL TEST
// ============================================================

async function adminModelTest(
  res
) {

  await refreshProvider();


  await settlePredictions();


  const model =
    await generateModel();


  json(
    res,
    200,
    {

      ok: true,

      targetIssue:
        model.targetIssue,

      prediction:
        model.prediction?.prediction ||
        null,

      confidence:
        model.prediction?.confidence ||
        0,

      pattern:
        model.prediction?.pattern ||
        "NONE",

      classification:
        model.prediction?.classification ||
        "NO CLEAR SIGNAL",

      reason:
        model.prediction?.reason ||
        "",

      analysis:
        model.prediction?.analysis ||
        null

    }
  );

}


// ============================================================
// ADMIN KEYS LIST
// ============================================================

async function adminKeysList(
  res
) {

  if (!pool) {

    json(
      res,
      500,
      {

        ok: false,

        error:
          "DATABASE_DISABLED"

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

      ok: true,

      keys:
        result.rows

    }
  );

}


// ============================================================
// ADMIN CREATE KEY
// ============================================================

async function adminKeysCreate(
  req,
  res
) {

  if (!pool) {

    json(
      res,
      500,
      {

        ok: false,

        error:
          "DATABASE_DISABLED"

      }
    );

    return;
  }


  const body =
    await readBody(req);


  const custom =
    String(
      body?.key ||
      body?.access_key ||
      ""
    ).trim();


  const key =
    custom ||
    randomKey();


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
            .access_key,

        access_key:
          result.rows[0]
            .access_key,

        row:
          result.rows[0]

      }
    );


  } catch (error) {

    json(
      res,
      400,
      {

        ok: false,

        error:
          error.code ===
          "23505"

            ? "KEY_ALREADY_EXISTS"

            : error.message

      }
    );

  }

}


// ============================================================
// ADMIN DELETE KEY
// ============================================================

async function adminKeysDelete(
  req,
  res,
  url
) {

  if (!pool) {

    json(
      res,
      500,
      {

        ok: false,

        error:
          "DATABASE_DISABLED"

      }
    );

    return;
  }


  const body =
    await readBody(req);


  const id =
    url.searchParams.get(
      "id"
    ) ||
    body?.id;


  const key =
    url.searchParams.get(
      "key"
    ) ||
    body?.key;


  if (
    !id &&
    !key
  ) {

    json(
      res,
      400,
      {

        ok: false,

        error:
          "ID_OR_KEY_REQUIRED"

      }
    );

    return;
  }


  let result;


  if (id) {

    result =
      await pool.query(
        `
        DELETE FROM access_keys
        WHERE id = $1
        RETURNING id, access_key
        `,
        [
          Number(id)
        ]
      );

  } else {

    result =
      await pool.query(
        `
        DELETE FROM access_keys
        WHERE access_key = $1
        RETURNING id, access_key
        `,
        [
          String(key)
        ]
      );

  }


  json(
    res,
    200,
    {

      ok: true,

      deleted:
        result.rows[0] ||
        null

    }
  );

}


// ============================================================
// ADMIN RESET DEVICE
// ============================================================

async function adminResetDevice(
  req,
  res
) {

  if (!pool) {

    json(
      res,
      500,
      {

        ok: false,

        error:
          "DATABASE_DISABLED"

      }
    );

    return;
  }


  const body =
    await readBody(req);


  const id =
    body?.id;


  const key =
    body?.key ||
    body?.access_key;


  if (
    !id &&
    !key
  ) {

    json(
      res,
      400,
      {

        ok: false,

        error:
          "ID_OR_KEY_REQUIRED"

      }
    );

    return;
  }


  let result;


  if (id) {

    result =
      await pool.query(
        `
        UPDATE access_keys
        SET device_id = NULL
        WHERE id = $1
        RETURNING id, access_key, device_id
        `,
        [
          Number(id)
        ]
      );

  } else {

    result =
      await pool.query(
        `
        UPDATE access_keys
        SET device_id = NULL
        WHERE access_key = $1
        RETURNING id, access_key, device_id
        `,
        [
          String(key)
        ]
      );

  }


  json(
    res,
    200,
    {

      ok: true,

      row:
        result.rows[0] ||
        null

    }
  );

}


// ============================================================
// HEALTH
// ============================================================

function health(
  res
) {

  json(
    res,
    200,
    {

      ok: true,

      service:
        "DY AI WINGO",

      modelVersion:
        MODEL_VERSION,

      time:
        now(),

      providerOk:
        providerState.ok,

      historyCount:
        providerState.history.length

    }
  );

}


// ============================================================
// STATIC CONTENT TYPE
// ============================================================

function contentType(
  filePath
) {

  const ext =
    path
      .extname(
        filePath
      )
      .toLowerCase();


  const types = {

    ".html":
      "text/html; charset=utf-8",

    ".css":
      "text/css; charset=utf-8",

    ".js":
      "application/javascript; charset=utf-8",

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


// ============================================================
// STATIC FILE SERVER
// ============================================================

function serveStatic(
  req,
  res,
  pathname
) {

  let requested =
    pathname === "/"
      ? "/prediction.html"
      : pathname;


  try {

    requested =
      decodeURIComponent(
        requested
      );

  } catch {

    text(
      res,
      400,
      "Bad Request"
    );

    return;
  }


  const root =
    path.resolve(
      __dirname
    );


  const filePath =
    path.resolve(
      root,
      "." + requested
    );


  if (
    !filePath.startsWith(
      root
    )
  ) {

    text(
      res,
      403,
      "Forbidden"
    );

    return;
  }


  fs.stat(
    filePath,
    (
      error,
      stats
    ) => {

      if (
        error ||
        !stats.isFile()
      ) {

        text(
          res,
          404,
          "Not Found"
        );

        return;
      }


      const type =
        contentType(
          filePath
        );


      // ------------------------------------------------------
      // MP3 RANGE SUPPORT
      // ------------------------------------------------------

      if (
        type === "audio/mpeg" &&
        req.headers.range
      ) {

        const match =
          req.headers.range.match(
            /bytes=(\d*)-(\d*)/
          );


        if (!match) {

          text(
            res,
            416,
            "Invalid range"
          );

          return;
        }


        const size =
          stats.size;


        let start =
          match[1]
            ? Number(match[1])
            : 0;


        let end =
          match[2]
            ? Number(match[2])
            : size - 1;


        if (
          start >= size
        ) {
          start = 0;
        }


        if (
          end >= size
        ) {
          end =
            size - 1;
        }


        res.writeHead(
          206,
          {

            "Content-Type":
              type,

            "Content-Range":
              `bytes ${start}-${end}/${size}`,

            "Accept-Ranges":
              "bytes",

            "Content-Length":
              end - start + 1

          }
        );


        fs.createReadStream(
          filePath,
          {
            start,
            end
          }
        ).pipe(res);


        return;
      }


      // ------------------------------------------------------
      // NORMAL FILE
      // ------------------------------------------------------

      res.writeHead(
        200,
        {

          "Content-Type":
            type,

          "Cache-Control":
            "no-cache"

        }
      );


      fs.createReadStream(
        filePath
      ).pipe(res);

    }
  );
}


// ============================================================
// ROUTER
// ============================================================

const server =
  http.createServer(
    async (
      req,
      res
    ) => {

      try {

        // ----------------------------------------------------
        // CORS PREFLIGHT
        // ----------------------------------------------------

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
                "GET, POST, DELETE, OPTIONS"

            }
          );


          res.end();

          return;
        }


        const url =
          new URL(
            req.url,
            `http://${req.headers.host}`
          );


        const pathname =
          url.pathname;


        // ----------------------------------------------------
        // HEALTH
        // ----------------------------------------------------

        if (
          pathname ===
          "/health"
        ) {

          health(res);

          return;
        }


        // ----------------------------------------------------
        // ACCESS KEY CHECK
        // ----------------------------------------------------

        if (
          pathname ===
            "/api/key/check" &&
          req.method ===
            "GET"
        ) {

          await keyCheck(
            req,
            res
          );

          return;
        }


        // ----------------------------------------------------
        // STATE
        // ----------------------------------------------------

        if (
          pathname ===
            "/api/state" &&
          req.method ===
            "GET"
        ) {

          await stateApi(
            req,
            res
          );

          return;
        }


        // ----------------------------------------------------
        // PREDICTION HISTORY
        // ----------------------------------------------------

        if (
          pathname ===
            "/api/history" &&
          req.method ===
            "GET"
        ) {

          const auth =
            await validateAccess(
              req
            );


          if (!auth.ok) {

            json(
              res,
              401,
              auth
            );

            return;
          }


          await predictionHistory(
            res
          );

          return;
        }


        // ----------------------------------------------------
        // ADMIN AUTH
        // ----------------------------------------------------

        if (
          pathname.startsWith(
            "/api/admin/"
          )
        ) {

          if (
            !requireAdmin(req)
          ) {

            json(
              res,
              401,
              {

                ok: false,

                error:
                  "ADMIN_UNAUTHORIZED"

              }
            );

            return;
          }

        }


        // ----------------------------------------------------
        // ADMIN STATUS
        // ----------------------------------------------------

        if (
          pathname ===
            "/api/admin/status" &&
          req.method ===
            "GET"
        ) {

          await adminStatus(
            res
          );

          return;
        }


        // ----------------------------------------------------
        // ADMIN PING
        // ----------------------------------------------------

        if (
          pathname ===
            "/api/admin/ping" &&
          req.method ===
            "GET"
        ) {

          adminPing(res);

          return;
        }


        // ----------------------------------------------------
        // WINGOBOT TEST
        // ----------------------------------------------------

        if (
          pathname ===
            "/api/admin/wingo-test" &&
          req.method ===
            "GET"
        ) {

          await adminWingoTest(
            res
          );

          return;
        }


        // ----------------------------------------------------
        // MODEL TEST
        // ----------------------------------------------------

        if (
          pathname ===
            "/api/admin/model-test" &&
          req.method ===
            "GET"
        ) {

          await adminModelTest(
            res
          );

          return;
        }


        // ----------------------------------------------------
        // ADMIN KEYS GET
        // ----------------------------------------------------

        if (
          pathname ===
            "/api/admin/keys" &&
          req.method ===
            "GET"
        ) {

          await adminKeysList(
            res
          );

          return;
        }


        // ----------------------------------------------------
        // ADMIN KEY CREATE
        // ----------------------------------------------------

        if (
          pathname ===
            "/api/admin/keys" &&
          req.method ===
            "POST"
        ) {

          await adminKeysCreate(
            req,
            res
          );

          return;
        }


        // ----------------------------------------------------
        // ADMIN KEY DELETE
        // ----------------------------------------------------

        if (
          pathname ===
            "/api/admin/keys" &&
          req.method ===
            "DELETE"
        ) {

          await adminKeysDelete(
            req,
            res,
            url
          );

          return;
        }


        // ----------------------------------------------------
        // RESET DEVICE
        // ----------------------------------------------------

        if (
          pathname ===
            "/api/admin/reset-device" &&
          req.method ===
            "POST"
        ) {

          await adminResetDevice(
            req,
            res
          );

          return;
        }


        // ----------------------------------------------------
        // STATIC
        // ----------------------------------------------------

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


        if (
          !res.headersSent
        ) {

          json(
            res,
            500,
            {

              ok: false,

              error:
                error.message ||
                "Internal server error"

            }
          );

        } else {

          res.end();

        }

      }

    }
  );


// ============================================================
// BACKGROUND REFRESH
// ============================================================

async function backgroundRefresh() {

  try {

    await refreshProvider();


    await settlePredictions();


    const target =
      resolveTargetIssue();


    if (
      target &&
      (
        !modelCache.prediction ||
        modelCache.targetIssue !==
          target
      )
    ) {

      await generateModel();

    }

  } catch (error) {

    console.error(
      "[BACKGROUND]",
      error.message
    );

  }

}


// ============================================================
// START SERVER
// ============================================================

async function start() {

  try {

    await initDatabase();


    await refreshProvider();


    await settlePredictions();


    await generateModel();


    server.listen(
      PORT,
      "0.0.0.0",
      () => {

        console.log(
          `DY AI WINGO running on ${PORT}`
        );


        console.log(
          `MODEL: ${MODEL_VERSION}`
        );


        console.log(
          `HISTORY: ${providerState.history.length}`
        );


        console.log(
          `LATEST ISSUE: ${
            providerState.history[0]
              ?.issueNumber ||
            "NONE"
          }`
        );


        console.log(
          `TARGET: ${
            modelCache.targetIssue ||
            "NONE"
          }`
        );


        console.log(
          `PATTERN: ${
            modelCache.prediction
              ?.pattern ||
            "NONE"
          }`
        );


        console.log(
          `PREDICTION: ${
            modelCache.prediction
              ?.prediction ||
            "NO CLEAR SIGNAL"
          }`
        );

      }
    );


    setInterval(
      backgroundRefresh,
      PROVIDER_REFRESH_MS
    );


  } catch (error) {

    console.error(
      "[STARTUP ERROR]",
      error
    );


    process.exit(1);
  }

}


// ============================================================
// ERROR HANDLERS
// ============================================================

process.on(
  "unhandledRejection",
  error => {

    console.error(
      "[UNHANDLED]",
      error
    );

  }
);


process.on(
  "uncaughtException",
  error => {

    console.error(
      "[UNCAUGHT]",
      error
    );

  }
);


// ============================================================
// BOOT
// ============================================================

start();
