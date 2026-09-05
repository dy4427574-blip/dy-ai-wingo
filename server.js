"use strict";

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { Pool } = require("pg");

// ============================================================
// DY AI WINGO
// CHART PATTERN ENGINE
// ============================================================
//
// A = SMALL = 0,1,2,3,4
// B = BIG   = 5,6,7,8,9
//
// IMPORTANT:
//
// Prediction ONLY when a chart pattern is matched.
//
// NO:
// - frequency fallback
// - momentum fallback
// - forced alternation
// - random prediction
// - "last was BIG => SMALL"
// - "last was SMALL => BIG"
//
// Pattern not matched:
// prediction = null
//
// ============================================================


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
  "DY-AI-25-CHART-RULE-V3";

const THINKING_DURATION_MS =
  3000;

const PROVIDER_REFRESH_MS =
  3000;

const REQUEST_TIMEOUT_MS =
  12000;

const MAX_HISTORY =
  500;


// ============================================================
// DATABASE
// ============================================================

let pool = null;

if (DATABASE_URL) {

  pool = new Pool({
    connectionString:
      DATABASE_URL,

    ssl:
      DATABASE_URL.includes("localhost")
        ? false
        : {
            rejectUnauthorized: false
          },

    max: 5,

    idleTimeoutMillis:
      30000,

    connectionTimeoutMillis:
      10000
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
// HELPERS
// ============================================================

function now() {
  return Date.now();
}


function clamp(
  value,
  min,
  max
) {

  return Math.max(
    min,
    Math.min(max, value)
  );
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
      part /
      total *
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


// ============================================================
// NUMBER -> A/B
// ============================================================

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
    : "A";
}


function typeLabel(
  type
) {

  if (type === "B") {
    return "BIG";
  }

  if (type === "A") {
    return "SMALL";
  }

  return "UNKNOWN";
}


function predictionLabel(
  type
) {

  if (type === "B") {
    return "BIG";
  }

  if (type === "A") {
    return "SMALL";
  }

  return null;
}


// ============================================================
// ISSUE HELPERS
// ============================================================

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
// JSON
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
// BODY
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
                "DY-AI-Wingo/ChartPattern/3.0"

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
// NORMALIZE HISTORY
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


  return result
    .slice(
      0,
      MAX_HISTORY
    );
}


// ============================================================
// CURRENT ISSUE
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
// CHART RULE DEFINITIONS
// ============================================================
//
// A = SMALL
// B = BIG
//
// The engine checks the most recent completed sequence.
//
// There is NO fallback prediction.
//
// ============================================================

const CHART_RULES = [

  // ----------------------------------------------------------
  // 1. SINGLE TREND
  // AB AB AB
  // ----------------------------------------------------------

  {
    id: 1,
    name: "SINGLE TREND",
    sequence: "ABABAB",
    next: "A",
    confidence: 72
  },

  {
    id: 1,
    name: "SINGLE TREND",
    sequence: "BABABA",
    next: "B",
    confidence: 72
  },


  // ----------------------------------------------------------
  // 2. DOUBLE TREND
  // AA BB AA
  // ----------------------------------------------------------

  {
    id: 2,
    name: "DOUBLE TREND",
    sequence: "AABBAA",
    next: "B",
    confidence: 75
  },

  {
    id: 2,
    name: "DOUBLE TREND",
    sequence: "BBAABB",
    next: "A",
    confidence: 75
  },


  // ----------------------------------------------------------
  // 3. TRIPLE TREND
  // AAA BBB
  // ----------------------------------------------------------

  {
    id: 3,
    name: "TRIPLE TREND",
    sequence: "AAABBB",
    next: "A",
    confidence: 77
  },

  {
    id: 3,
    name: "TRIPLE TREND",
    sequence: "BBBAAA",
    next: "B",
    confidence: 77
  },


  // ----------------------------------------------------------
  // 4. QUADRA TREND
  // AAAA BBBB
  // ----------------------------------------------------------

  {
    id: 4,
    name: "QUADRA TREND",
    sequence: "AAAABBBB",
    next: "A",
    confidence: 80
  },

  {
    id: 4,
    name: "QUADRA TREND",
    sequence: "BBBBAAAA",
    next: "B",
    confidence: 80
  },


  // ----------------------------------------------------------
  // 5. THREE IN ONE
  // AAB AAB
  // ----------------------------------------------------------

  {
    id: 5,
    name: "THREE IN ONE",
    sequence: "AABAAB",
    next: "A",
    confidence: 78
  },

  {
    id: 5,
    name: "THREE IN ONE",
    sequence: "BBABBA",
    next: "B",
    confidence: 78
  },


  // ----------------------------------------------------------
  // 6. LONG TREND
  // sustained same side
  // ----------------------------------------------------------

  {
    id: 6,
    name: "LONG TREND",
    sequence: "AAAAAAAA",
    next: "A",
    confidence: 68
  },

  {
    id: 6,
    name: "LONG TREND",
    sequence: "BBBBBBBB",
    next: "B",
    confidence: 68
  },


  // ----------------------------------------------------------
  // 7. TWO IN ONE
  // ABB ABB
  // ----------------------------------------------------------

  {
    id: 7,
    name: "TWO IN ONE",
    sequence: "ABBABB",
    next: "A",
    confidence: 80
  },

  {
    id: 7,
    name: "TWO IN ONE",
    sequence: "BAABAA",
    next: "B",
    confidence: 80
  },


  // ----------------------------------------------------------
  // 8. THREE IN ONE
  // AAAB AAAB
  // ----------------------------------------------------------

  {
    id: 8,
    name: "THREE IN ONE",
    sequence: "AAABAAAB",
    next: "A",
    confidence: 82
  },

  {
    id: 8,
    name: "THREE IN ONE",
    sequence: "BBBA BBBA".replace(/ /g, ""),
    next: "B",
    confidence: 82
  },


  // ----------------------------------------------------------
  // 9. THREE-TWO
  // AAABB AAABB
  // ----------------------------------------------------------

  {
    id: 9,
    name: "THREE-TWO TREND",
    sequence: "AAABBAAABB",
    next: "A",
    confidence: 83
  },

  {
    id: 9,
    name: "THREE-TWO TREND",
    sequence: "BBBAABBBAA",
    next: "B",
    confidence: 83
  },


  // ----------------------------------------------------------
  // 10. FOUR IN ONE
  // AAAAB AAAAB
  // ----------------------------------------------------------

  {
    id: 10,
    name: "FOUR IN ONE",
    sequence: "AAAABAAAAB",
    next: "A",
    confidence: 84
  },

  {
    id: 10,
    name: "FOUR IN ONE",
    sequence: "BBBABBBBA",
    next: "B",
    confidence: 84
  },


  // ----------------------------------------------------------
  // 11. ONE IN FOUR
  // ABBBB ABBBB
  // ----------------------------------------------------------

  {
    id: 11,
    name: "ONE IN FOUR",
    sequence: "ABBBBABBBB",
    next: "A",
    confidence: 84
  },

  {
    id: 11,
    name: "ONE IN FOUR",
    sequence: "BAAAABAAAA",
    next: "B",
    confidence: 84
  },


  // ----------------------------------------------------------
  // 12. MIXED TREND
  // ABBA ABBA
  // ----------------------------------------------------------

  {
    id: 12,
    name: "MIXED TREND",
    sequence: "ABBAABBA",
    next: "A",
    confidence: 82
  },

  {
    id: 12,
    name: "MIXED TREND",
    sequence: "BAABBAAB",
    next: "B",
    confidence: 82
  },


  // ----------------------------------------------------------
  // 13. EXPANDING BLOCK
  // AABB AABB
  // ----------------------------------------------------------

  {
    id: 13,
    name: "EXPANDING BLOCK",
    sequence: "AABBAABB",
    next: "A",
    confidence: 83
  },

  {
    id: 13,
    name: "EXPANDING BLOCK",
    sequence: "BBAABBAA",
    next: "B",
    confidence: 83
  },


  // ----------------------------------------------------------
  // 14. REVERSAL BLOCK
  // ABB AAAB BBBB
  // ----------------------------------------------------------

  {
    id: 14,
    name: "REVERSAL BLOCK",
    sequence: "ABBAAABBBB",
    next: "A",
    confidence: 86
  },

  {
    id: 14,
    name: "REVERSAL BLOCK",
    sequence: "BAABBBBAAA",
    next: "B",
    confidence: 86
  },


  // ----------------------------------------------------------
  // 15. FOUR-THREE-TWO
  // AAAA BBB AA
  // ----------------------------------------------------------

  {
    id: 15,
    name: "FOUR-THREE-TWO",
    sequence: "AAAABBBAA",
    next: "B",
    confidence: 85
  },

  {
    id: 15,
    name: "FOUR-THREE-TWO",
    sequence: "BBBBAAABB",
    next: "A",
    confidence: 85
  },


  // ----------------------------------------------------------
  // 16. EXPANDING TREND
  // AB AABB AAABBB
  // ----------------------------------------------------------

  {
    id: 16,
    name: "EXPANDING TREND",
    sequence: "ABAABBAAABBB",
    next: "A",
    confidence: 88
  },

  {
    id: 16,
    name: "EXPANDING TREND",
    sequence: "BABBAABBBBAAA",
    next: "B",
    confidence: 88
  },


  // ----------------------------------------------------------
  // 17. MIXED REVERSAL
  // AA BBB A BBB AA
  // ----------------------------------------------------------

  {
    id: 17,
    name: "MIXED REVERSAL",
    sequence: "AABBBAAABBBAA",
    next: "B",
    confidence: 87
  },

  {
    id: 17,
    name: "MIXED REVERSAL",
    sequence: "BBAAABBBAAABB",
    next: "A",
    confidence: 87
  },


  // ----------------------------------------------------------
  // 18. LONG EXPANSION
  // A BB AAAA BBBB
  // ----------------------------------------------------------

  {
    id: 18,
    name: "LONG EXPANSION",
    sequence: "ABBAAAABBBB",
    next: "A",
    confidence: 89
  },

  {
    id: 18,
    name: "LONG EXPANSION",
    sequence: "BAABBBBBAAA",
    next: "B",
    confidence: 89
  },


  // ----------------------------------------------------------
  // 19. FOUR BLOCK
  // ABBBB ABBBB
  // ----------------------------------------------------------

  {
    id: 19,
    name: "FOUR BLOCK",
    sequence: "ABBBBABBBB",
    next: "A",
    confidence: 84
  },

  {
    id: 19,
    name: "FOUR BLOCK",
    sequence: "BAAAABAAAA",
    next: "B",
    confidence: 84
  },


  // ----------------------------------------------------------
  // 20. FIVE-TWO BLOCK
  // AA BBBBB AA BBBBB
  // ----------------------------------------------------------

  {
    id: 20,
    name: "FIVE-TWO BLOCK",
    sequence: "AABBBBBAABBBBB",
    next: "A",
    confidence: 90
  },

  {
    id: 20,
    name: "FIVE-TWO BLOCK",
    sequence: "BBAAAAABB AAAAA".replace(/ /g, ""),
    next: "B",
    confidence: 90
  },


  // ----------------------------------------------------------
  // 21. PROGRESSIVE ALTERNATION
  // AB AAB AAAB
  // ----------------------------------------------------------

  {
    id: 21,
    name: "PROGRESSIVE ALTERNATION",
    sequence: "ABAABAAAB",
    next: "A",
    confidence: 88
  },

  {
    id: 21,
    name: "PROGRESSIVE ALTERNATION",
    sequence: "BABBA BBBA".replace(/ /g, ""),
    next: "B",
    confidence: 88
  },


  // ----------------------------------------------------------
  // 22. PROGRESSIVE BLOCK
  // AAB AABB AABBB
  // ----------------------------------------------------------

  {
    id: 22,
    name: "PROGRESSIVE BLOCK",
    sequence: "AABAABBAABBB",
    next: "A",
    confidence: 90
  },

  {
    id: 22,
    name: "PROGRESSIVE BLOCK",
    sequence: "BBABB AABBBAAA".replace(/ /g, ""),
    next: "B",
    confidence: 90
  },


  // ----------------------------------------------------------
  // 23. FIVE TREND
  // AAAAA B
  // ----------------------------------------------------------

  {
    id: 23,
    name: "FIVE IN ONE",
    sequence: "AAAAABAAAAAB",
    next: "A",
    confidence: 88
  },

  {
    id: 23,
    name: "FIVE IN ONE",
    sequence: "BBBBABBBBBAB",
    next: "B",
    confidence: 88
  },


  // ----------------------------------------------------------
  // 24. FIVE IN TWO
  // AAAAAB B
  // ----------------------------------------------------------

  {
    id: 24,
    name: "FIVE IN TWO",
    sequence: "AAAAABBAAAAABB",
    next: "A",
    confidence: 91
  },

  {
    id: 24,
    name: "FIVE IN TWO",
    sequence: "BBBBBAABBBBBAA",
    next: "B",
    confidence: 91
  },


  // ----------------------------------------------------------
  // 25. FIVE IN THREE
  // AAAAA BBB
  // ----------------------------------------------------------

  {
    id: 25,
    name: "FIVE IN THREE",
    sequence: "AAAAABBBAAAAABBB",
    next: "A",
    confidence: 92
  },

  {
    id: 25,
    name: "FIVE IN THREE",
    sequence: "BBBBBAAABBBBBAAA",
    next: "B",
    confidence: 92
  }

];


// ============================================================
// REMOVE INVALID RULES
// ============================================================

const VALID_CHART_RULES =
  CHART_RULES.filter(
    rule =>
      typeof rule.sequence === "string" &&
      /^[AB]+$/.test(rule.sequence) &&
      (rule.next === "A" ||
       rule.next === "B")
  );


// ============================================================
// PATTERN MATCH HELPERS
// ============================================================

function suffixMatches(
  sequence,
  pattern
) {

  if (
    !sequence ||
    !pattern
  ) {
    return false;
  }

  return sequence.endsWith(
    pattern
  );
}


function countHistoricalPattern(
  sequence,
  pattern,
  expected
) {

  let matches = 0;
  let correct = 0;


  if (
    !pattern ||
    pattern.length < 1
  ) {

    return {
      matches: 0,
      correct: 0,
      rate: null
    };
  }


  for (
    let i = pattern.length;
    i < sequence.length;
    i++
  ) {

    const previous =
      sequence.slice(
        i - pattern.length,
        i
      );


    if (
      previous === pattern
    ) {

      matches++;


      if (
        i < sequence.length &&
        sequence[i] === expected
      ) {

        correct++;

      }

    }

  }


  return {

    matches,

    correct,

    rate:
      matches > 0
        ? Number(
            (
              correct /
              matches *
              100
            ).toFixed(2)
          )
        : null

  };
}


// ============================================================
// CURRENT STREAK
// ============================================================

function getCurrentRun(
  sequence
) {

  if (!sequence.length) {

    return {
      type: null,
      length: 0
    };
  }


  const latest =
    sequence[
      sequence.length - 1
    ];


  let length = 1;


  for (
    let i =
      sequence.length - 2;
    i >= 0;
    i--
  ) {

    if (
      sequence[i] !== latest
    ) {

      break;
    }

    length++;
  }


  return {

    type: latest,

    length

  };
}


// ============================================================
// EXACT CHART ENGINE
// ============================================================

function humanBigSmallLogic(
  results
) {

  // ----------------------------------------------------------
  // CLEAN NUMBERS
  // ----------------------------------------------------------

  const numbers = [];


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

      numbers.push(n);

    }

  }


  // ----------------------------------------------------------
  // NUMBER -> A/B
  // ----------------------------------------------------------

  const sequence =
    numbers
      .map(
        n =>
          numberToType(n)
      )
      .filter(Boolean)
      .join("");


  const dataSize =
    sequence.length;


  // ----------------------------------------------------------
  // CURRENT
  // ----------------------------------------------------------

  const currentRun =
    getCurrentRun(
      sequence
    );


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

      matchedRule:
        null,

      matchedSequence:
        null,

      matchType:
        null,

      nextType:
        null,

      sequence,

      dataSize,

      current: {

        type:
          currentRun.type,

        label:
          typeLabel(
            currentRun.type
          ),

        streak:
          currentRun.length

      },

      historicalMatches: 0,

      historicalCorrect: 0,

      historicalRate: null,

      agreeingRules: 0,

      reason:
        "Minimum 5 valid results required.",

      engine:
        "DY-AI-25-CHART-RULE",

      rulesCount:
        VALID_CHART_RULES.length,

      mapping: {

        A: "SMALL",

        B: "BIG"

      },

      analyzedAt:
        now()

    };
  }


  // ----------------------------------------------------------
  // MATCH ALL RULES
  // ----------------------------------------------------------

  const matches = [];


  for (
    const rule of
      VALID_CHART_RULES
  ) {

    if (
      suffixMatches(
        sequence,
        rule.sequence
      )
    ) {

      matches.push({
        ...rule
      });

    }

  }


  // ----------------------------------------------------------
  // LONG TREND
  //
  // ONLY if no exact rule already matched.
  // ----------------------------------------------------------

  if (
    !matches.length &&
    currentRun.length >= 8
  ) {

    const longSequence =
      currentRun.type.repeat(
        Math.min(
          currentRun.length,
          16
        )
      );


    matches.push({

      id: 6,

      name:
        "LONG TREND",

      sequence:
        longSequence,

      next:
        currentRun.type,

      confidence:
        currentRun.length >= 12
          ? 78
          : currentRun.length >= 10
          ? 74
          : 68

    });

  }


  // ----------------------------------------------------------
  // NO MATCH
  // ----------------------------------------------------------

  if (
    !matches.length
  ) {

    return {

      status:
        "NO_PATTERN",

      prediction:
        null,

      confidence:
        0,

      confidenceLevel:
        "NONE",

      classification:
        "NO CLEAR PATTERN",

      pattern:
        "NONE",

      matchedPattern:
        null,

      matchedRule:
        null,

      matchedSequence:
        null,

      matchType:
        null,

      nextType:
        null,

      sequence,

      dataSize,

      current: {

        type:
          currentRun.type,

        label:
          typeLabel(
            currentRun.type
          ),

        streak:
          currentRun.length

      },

      historicalMatches: 0,

      historicalCorrect: 0,

      historicalRate: null,

      agreeingRules: 0,

      reason:
        "Current A/B sequence me koi exact chart pattern match nahi hua. Forced prediction disabled.",

      engine:
        "DY-AI-25-CHART-RULE",

      rulesCount:
        VALID_CHART_RULES.length,

      mapping: {

        A: "SMALL",

        B: "BIG"

      },

      analyzedAt:
        now()

    };
  }


  // ----------------------------------------------------------
  // STRONGEST MATCH
  //
  // Longer exact pattern gets priority.
  // ----------------------------------------------------------

  matches.sort(
    (a, b) => {

      if (
        b.sequence.length !==
        a.sequence.length
      ) {

        return (
          b.sequence.length -
          a.sequence.length
        );
      }


      return (
        b.confidence -
        a.confidence
      );

    }
  );


  const selected =
    matches[0];


  // ----------------------------------------------------------
  // AGREEMENT
  // ----------------------------------------------------------

  const agreeingRules =
    matches.filter(
      item =>
        item.next ===
        selected.next
    ).length;


  // ----------------------------------------------------------
  // HISTORICAL MATCHES
  // ----------------------------------------------------------

  const historical =
    countHistoricalPattern(
      sequence,
      selected.sequence,
      selected.next
    );


  // ----------------------------------------------------------
  // CONFIDENCE
  // ----------------------------------------------------------

  let confidence =
    Number(
      selected.confidence || 60
    );


  // Longer exact match = stronger evidence.
  if (
    selected.sequence.length >= 15
  ) {

    confidence += 3;

  } else if (
    selected.sequence.length >= 12
  ) {

    confidence += 2;

  }


  // Multiple rules same direction.
  if (
    agreeingRules >= 3
  ) {

    confidence += 4;

  } else if (
    agreeingRules >= 2
  ) {

    confidence += 2;

  }


  // Historical confirmation.
  if (
    historical.matches >= 2 &&
    historical.rate !== null
  ) {

    if (
      historical.rate >= 70
    ) {

      confidence += 4;

    } else if (
      historical.rate >= 55
    ) {

      confidence += 2;

    } else if (
      historical.rate < 40
    ) {

      confidence -= 5;

    }

  }


  confidence =
    clamp(
      Math.round(confidence),
      50,
      95
    );


  // ----------------------------------------------------------
  // CONFIDENCE LEVEL
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

  }


  // ----------------------------------------------------------
  // FINAL PREDICTION
  // ----------------------------------------------------------

  const prediction =
    predictionLabel(
      selected.next
    );


  // ----------------------------------------------------------
  // REASON
  // ----------------------------------------------------------

  let reason =
    `${selected.name} matched ` +
    `${selected.sequence} -> ` +
    `${selected.next} -> ` +
    `${prediction}`;


  if (
    historical.matches > 0
  ) {

    reason +=
      ` | historical ${historical.correct}/${historical.matches}`;

  }


  // ----------------------------------------------------------
  // FINAL
  // ----------------------------------------------------------

  return {

    status:
      "OK",

    prediction,

    confidence,

    confidenceLevel,

    classification:
      "PATTERN MATCH",

    pattern:
      selected.name,

    matchedPattern:
      selected.name,

    matchedRule:
      selected.id,

    matchedSequence:
      selected.sequence,

    matchType:
      "EXACT",

    nextType:
      selected.next,

    sequence,

    dataSize,

    current: {

      type:
        currentRun.type,

      label:
        typeLabel(
          currentRun.type
        ),

      streak:
        currentRun.length

    },

    historicalMatches:
      historical.matches,

    historicalCorrect:
      historical.correct,

    historicalRate:
      historical.rate,

    agreeingRules,

    matchedCandidates:
      matches.map(
        item => ({
          id: item.id,
          name: item.name,
          sequence: item.sequence,
          next: item.next,
          confidence: item.confidence
        })
      ),

    reason,

    engine:
      "DY-AI-25-CHART-RULE",

    rulesCount:
      VALID_CHART_RULES.length,

    mapping: {

      A: "SMALL",

      B: "BIG"

    },

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


  const latest =
    history[0]?.issueNumber;


  const current =
    providerState.currentIssue;


  // Current provider issue is ahead.
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


  // Otherwise next issue.
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


  // WingoBot:
  // newest -> oldest
  //
  // Engine:
  // oldest -> newest

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
        "NONE",

      classification:
        analysis.classification ||
        "NO CLEAR PATTERN",

      pattern:
        analysis.pattern ||
        "NONE",

      matchedPattern:
        analysis.matchedPattern ||
        null,

      matchedRule:
        analysis.matchedRule ||
        null,

      matchedSequence:
        analysis.matchedSequence ||
        null,

      nextType:
        analysis.nextType ||
        null,

      reason:
        analysis.reason ||
        "",

      modelVersion:
        MODEL_VERSION,

      generatedAt,

      analysis

    },

    generatedAt

  };


  // Save only actual pattern prediction.
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

    // NO PATTERN -> NO DB PREDICTION
    return;
  }


  try {

    const existing =
      await pool.query(
        `
        SELECT
          id
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
      VALUES
      ($1,$2,$3,$4,$5)
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


    console.log(
      `[MODEL] Saved ${targetIssue} -> ${analysis.prediction}`
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
          record.prediction || ""
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


      console.log(
        `[SETTLE] ${row.issueNumber}: ${prediction} / ${actualLabel} = ${actualResult}`
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
// ACCESS KEY
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
// VALIDATE ACCESS
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
      SET
        last_seen = $1
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

function requireAdmin(
  req
) {

  return (
    ADMIN_KEY &&
    getAdminKey(req) ===
      ADMIN_KEY
  );
}


// ============================================================
// HISTORY MERGE
// ============================================================

async function getPredictionMap() {

  const map =
    new Map();


  if (!pool) {
    return map;
  }


  try {

    const result =
      await pool.query(
        `
        SELECT
          target_issue,
          prediction,
          confidence,
          actual_number,
          actual_result,
          created_at,
          settled_at
        FROM prediction_records
        ORDER BY created_at DESC
        LIMIT 200
        `
      );


    for (
      const row of
        result.rows
    ) {

      map.set(
        String(
          row.target_issue
        ),
        row
      );

    }

  } catch (error) {

    console.error(
      "[DB] history map:",
      error.message
    );

  }


  return map;
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


  // Generate when target changes.
  if (
    !modelCache.prediction ||
    modelCache.targetIssue !==
      targetIssue
  ) {

    await generateModel();

  }


  const predictionMap =
    await getPredictionMap();


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


          const issue =
            String(
              row.issueNumber
            );


          const record =
            predictionMap.get(
              issue
            );


          let ai =
            record?.prediction ||
            null;


          let result =
            record?.actual_result ||
            null;


          // If DB result missing but actual number
          // and prediction exist, calculate safely.
          if (
            !result &&
            ai
          ) {

            const actualLabel =
              type === "B"
                ? "BIG"
                : type === "A"
                ? "SMALL"
                : null;


            if (
              actualLabel
            ) {

              result =
                ai ===
                actualLabel
                  ? "WIN"
                  : "LOSS";

            }

          }


          return {

            issue,

            issueNumber:
              issue,

            number,

            type,

            label:
              typeLabel(type),

            prediction:
              ai,

            ai,

            result:

              result ||
              (
                ai
                  ? "PENDING"
                  : "PENDING"
              ),

            confidence:
              record?.confidence ||
              null

          };

        }
      );


  const model =
    modelCache.prediction;


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
          "NONE",

        classification:
          model?.classification ||
          "NO CLEAR PATTERN",

        pattern:
          model?.pattern ||
          "NONE",

        matchedPattern:
          model?.matchedPattern ||
          null,

        matchedRule:
          model?.matchedRule ||
          null,

        matchedSequence:
          model?.matchedSequence ||
          null,

        nextType:
          model?.nextType ||
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


      // Backward compatibility.
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

      confidenceLevel:
        model.prediction?.confidenceLevel ||
        "NONE",

      pattern:
        model.prediction?.pattern ||
        "NONE",

      matchedRule:
        model.prediction?.matchedRule ||
        null,

      matchedSequence:
        model.prediction?.matchedSequence ||
        null,

      classification:
        model.prediction?.classification ||
        "NO CLEAR PATTERN",

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
        VALUES
        ($1,$2,0)
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

      engine:
        "DY-AI-25-CHART-RULE",

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
// STATIC SERVER
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


      // --------------------------------------------------------
      // MP3 RANGE
      // --------------------------------------------------------

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


      // --------------------------------------------------------
      // NORMAL
      // --------------------------------------------------------

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

        // ------------------------------------------------------
        // OPTIONS
        // ------------------------------------------------------

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


        // ------------------------------------------------------
        // HEALTH
        // ------------------------------------------------------

        if (
          pathname ===
          "/health"
        ) {

          health(res);

          return;
        }


        // ------------------------------------------------------
        // KEY CHECK
        // ------------------------------------------------------

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


        // ------------------------------------------------------
        // STATE
        // ------------------------------------------------------

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


        // ------------------------------------------------------
        // HISTORY
        // ------------------------------------------------------

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


        // ------------------------------------------------------
        // ADMIN AUTH
        // ------------------------------------------------------

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


        // ------------------------------------------------------
        // ADMIN STATUS
        // ------------------------------------------------------

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


        // ------------------------------------------------------
        // ADMIN PING
        // ------------------------------------------------------

        if (
          pathname ===
            "/api/admin/ping" &&
          req.method ===
            "GET"
        ) {

          adminPing(res);

          return;
        }


        // ------------------------------------------------------
        // WINGO TEST
        // ------------------------------------------------------

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


        // ------------------------------------------------------
        // MODEL TEST
        // ------------------------------------------------------

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


        // ------------------------------------------------------
        // KEYS GET
        // ------------------------------------------------------

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


        // ------------------------------------------------------
        // KEYS CREATE
        // ------------------------------------------------------

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


        // ------------------------------------------------------
        // KEYS DELETE
        // ------------------------------------------------------

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


        // ------------------------------------------------------
        // RESET DEVICE
        // ------------------------------------------------------

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


        // ------------------------------------------------------
        // STATIC
        // ------------------------------------------------------

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
// START
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
          "========================================"
        );

        console.log(
          `DY AI WINGO running on ${PORT}`
        );

        console.log(
          `MODEL: ${MODEL_VERSION}`
        );

        console.log(
          `ENGINE: DY-AI-25-CHART-RULE`
        );

        console.log(
          `RULES: ${VALID_CHART_RULES.length}`
        );

        console.log(
          `HISTORY: ${providerState.history.length}`
        );

        console.log(
          `LATEST: ${
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
            "NO CLEAR PATTERN"
          }`
        );

        console.log(
          "========================================"
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
