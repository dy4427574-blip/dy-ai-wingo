"use strict";

/*
===========================================================
DY AI WINGO
TASHAN-WIN STYLE 25 RULE PATTERN ENGINE
===========================================================

A = SMALL
B = BIG

0,1,2,3,4 = A = SMALL
5,6,7,8,9 = B = BIG

IMPORTANT:
- Prediction ONLY from 25 chart rules.
- No frequency prediction.
- No momentum prediction.
- No forced alternation.
- No random prediction.
- No "BIG ke baad SMALL" type blind logic.
- Pattern match nahi hua = NO CLEAR PATTERN.
- Partial suffix matching is used exactly according
  to the supplied 25-rule engine.
- Historical evidence is NOT a guarantee.
===========================================================
*/

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { Pool } = require("pg");


// ===========================================================
// CONFIG
// ===========================================================

const PORT =
  Number(process.env.PORT || 10000);

const ADMIN_KEY =
  String(process.env.ADMIN_KEY || "").trim();

const WINGOBOT_TOKEN =
  String(process.env.WINGOBOT_TOKEN || "").trim();

const DATABASE_URL =
  String(process.env.DATABASE_URL || "").trim();

const WINGOBOT_API =
  "https://api.wingobot.com/v2/30-sec-game-history";

const MODEL_VERSION =
  "DY-AI-25-RULE-PATTERN-V4";

const ENGINE_NAME =
  "TASHAN-WIN-STYLE-25-RULE";

const THINKING_DURATION_MS =
  3000;

const PROVIDER_REFRESH_MS =
  3000;

const REQUEST_TIMEOUT_MS =
  12000;

const MAX_HISTORY =
  500;


let pool = null;


// ===========================================================
// DATABASE CONNECTION
// ===========================================================

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


// ===========================================================
// DATABASE INIT
// ===========================================================

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


// ===========================================================
// GLOBAL STATE
// ===========================================================

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


// ===========================================================
// BASIC HELPERS
// ===========================================================

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


function randomKey() {

  return (
    "DY-" +
    crypto
      .randomBytes(12)
      .toString("hex")
      .toUpperCase()
  );
}


// ===========================================================
// NUMBER -> A/B
// ===========================================================

function numberToAB(number) {

  const n =
    Number(number);


  if (
    !Number.isInteger(n) ||
    n < 0 ||
    n > 9
  ) {

    return null;
  }


  return n <= 4
    ? "A"
    : "B";
}


function typeLabel(
  type
) {

  if (type === "A") {
    return "SMALL";
  }

  if (type === "B") {
    return "BIG";
  }

  return "UNKNOWN";
}


function predictionLabel(
  type
) {

  if (type === "A") {
    return "SMALL";
  }

  if (type === "B") {
    return "BIG";
  }

  return null;
}


// ===========================================================
// ISSUE HELPERS
// ===========================================================

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


// ===========================================================
// JSON RESPONSE
// ===========================================================

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


// ===========================================================
// REQUEST BODY
// ===========================================================

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


// ===========================================================
// WINGOBOT API
// ===========================================================

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

            method:
              "GET",

            timeout:
              REQUEST_TIMEOUT_MS,

            headers: {

              Authorization:
                `Bearer ${WINGOBOT_TOKEN}`,

              Accept:
                "application/json",

              "User-Agent":
                "DY-AI-Wingo/25Rule/4.0"

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


// ===========================================================
// NORMALIZE HISTORY
// ===========================================================

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


  return result.slice(
    0,
    MAX_HISTORY
  );
}


// ===========================================================
// CURRENT ISSUE
// ===========================================================

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


// ===========================================================
// PROVIDER REFRESH
// ===========================================================

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


// ===========================================================
// 25 BASIC RULES
// ===========================================================
//
// EXACTLY BASED ON USER PROVIDED RULE LIST.
//
// A = SMALL
// B = BIG
//
// ===========================================================

const RULES = [

  // LEFT SIDE

  {
    id: 1,
    pattern: "ABABABABAB"
  },

  {
    id: 2,
    pattern: "AABBAABB"
  },

  {
    id: 3,
    pattern: "AAABBBAAABBB"
  },

  {
    id: 4,
    pattern: "AAAABBBBAAAABBBB"
  },

  {
    id: 5,
    pattern: "AABAABAAB"
  },

  {
    id: 6,
    pattern:
      "AAAAAAAA BBBBBBBB"
        .replace(/\s/g, "")
  },

  {
    id: 7,
    pattern: "ABBABBABB"
  },

  {
    id: 8,
    pattern: "AAABAAABAAAB"
  },

  {
    id: 9,
    pattern: "AAABBAAABB"
  },

  {
    id: 10,
    pattern:
      "AAAAB B A BB AAAA"
        .replace(/\s/g, "")
  },

  {
    id: 11,
    pattern: "ABBBABBBABBB"
  },

  {
    id: 12,
    pattern: "ABABBABBB"
  },

  {
    id: 13,
    pattern:
      "AABBAAABBBAAAABBBB"
  },


  // RIGHT SIDE

  {
    id: 14,
    pattern: "ABBAAABBBB"
  },

  {
    id: 15,
    pattern: "AAAABBBAAB"
  },

  {
    id: 16,
    pattern: "ABAABBAAABBB"
  },

  {
    id: 17,
    pattern:
      "AABBBABBB AA"
        .replace(/\s/g, "")
  },

  {
    id: 18,
    pattern:
      "ABBAAAABBBBBBBB"
  },

  {
    id: 19,
    pattern: "ABBBABBB"
  },

  {
    id: 20,
    pattern: "AABBBAABBB"
  },

  {
    id: 21,
    pattern: "ABAABAAAB"
  },

  {
    id: 22,
    pattern: "AABAABBAABBB"
  },

  {
    id: 23,
    pattern:
      "AAAABA AA AAB"
        .replace(/\s/g, "")
  },

  {
    id: 24,
    pattern: "AAAABBAAAABB"
  },

  {
    id: 25,
    pattern: "AAAABBBAAAABBB"
  }

];


// ===========================================================
// CLEAN RULES
// ===========================================================

for (
  const rule of RULES
) {

  rule.pattern =
    rule.pattern
      .replace(
        /[^AB]/g,
        ""
      );

}


// ===========================================================
// RULE WEIGHTS
// ===========================================================
//
// Same calculation as supplied logic.
//
// ===========================================================

function calculateWeight(
  match
) {

  const length =
    match.matched;


  if (length >= 10) {
    return 10;
  }

  if (length >= 8) {
    return 8;
  }

  if (length >= 6) {
    return 6;
  }

  if (length >= 5) {
    return 5;
  }

  if (length >= 4) {
    return 4;
  }

  if (length >= 3) {
    return 3;
  }

  return 1;
}


// ===========================================================
// CONVERT HISTORY
// ===========================================================

function convertHistory(
  results
) {

  const output = [];


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


    const type =
      numberToAB(n);


    if (type) {

      output.push(type);

    }

  }


  return output;
}


// ===========================================================
// SUFFIX PARTIAL MATCH
// ===========================================================
//
// IMPORTANT:
//
// User ke original logic mein:
//
// history ke LAST characters
// rule ke FIRST characters se compare hote hain.
//
// Example:
//
// Rule:
// ABABABABAB
//
// History ending:
// ...ABAB
//
// matched = 4
//
// Agar rule ka complete pattern match ho gaya,
// to next available nahi hoga.
// Isliye us rule se prediction nahi banegi.
//
// ===========================================================

function suffixMatch(
  history,
  pattern
) {

  const maxLength =
    Math.min(
      history.length,
      pattern.length
    );


  let bestMatch = 0;


  for (
    let len = 1;
    len <= maxLength;
    len++
  ) {

    const historyPart =
      history
        .slice(
          history.length - len
        )
        .join("");


    const patternPart =
      pattern.slice(
        0,
        len
      );


    if (
      historyPart ===
      patternPart
    ) {

      bestMatch = len;

    }

  }


  return bestMatch;
}


// ===========================================================
// FIND ALL MATCHING RULES
// ===========================================================

function findRules(
  history
) {

  const matches = [];


  for (
    const rule of RULES
  ) {

    const matchLength =
      suffixMatch(
        history,
        rule.pattern
      );


    if (
      matchLength >= 2
    ) {

      let next = null;


      if (
        matchLength <
        rule.pattern.length
      ) {

        next =
          rule.pattern[
            matchLength
          ];

      }


      matches.push({

        rule:
          rule.id,

        pattern:
          rule.pattern,

        matched:
          matchLength,

        next

      });

    }

  }


  return matches;
}


// ===========================================================
// SUPPORT CALCULATION
// ===========================================================

function calculateSupport(
  matches
) {

  let A = 0;
  let B = 0;


  const evidence = [];


  for (
    const match of
      matches
  ) {

    if (!match.next) {
      continue;
    }


    const weight =
      calculateWeight(
        match
      );


    if (
      match.next === "A"
    ) {

      A += weight;

    }


    if (
      match.next === "B"
    ) {

      B += weight;

    }


    evidence.push({

      rule:
        match.rule,

      pattern:
        match.pattern,

      matched:
        match.matched,

      expectedNext:
        match.next,

      weight

    });

  }


  const total =
    A + B;


  let APct = 0;
  let BPct = 0;


  if (total > 0) {

    APct =
      Number(
        (
          A /
          total *
          100
        ).toFixed(2)
      );


    BPct =
      Number(
        (
          B /
          total *
          100
        ).toFixed(2)
      );

  }


  return {

    A,

    B,

    APct,

    BPct,

    total,

    evidence

  };
}


// ===========================================================
// REVERSAL ANALYSIS
// ===========================================================
//
// Reversal here means:
//
// Current A + stronger B support
// OR
// Current B + stronger A support
//
// It is only a WATCH flag.
// It is NOT guaranteed.
//
// ===========================================================

function reversalAnalysis(
  history,
  support
) {

  const current =
    history[
      history.length - 1
    ] || null;


  let reversal =
    false;


  let reason =
    "";


  if (
    current === "A" &&
    support.B > support.A
  ) {

    reversal = true;


    reason =
      "Current A side ke baad B-side pattern support stronger.";

  }


  if (
    current === "B" &&
    support.A > support.B
  ) {

    reversal = true;


    reason =
      "Current B side ke baad A-side pattern support stronger.";

  }


  return {

    current,

    currentLabel:
      typeLabel(current),

    reversalWatch:
      reversal,

    reason

  };
}


// ===========================================================
// DECISION
// ===========================================================

function decide(
  history,
  support
) {

  if (
    support.A === 0 &&
    support.B === 0
  ) {

    return {

      signal:
        "NO MATCH",

      prediction:
        null,

      confidence:
        "LOW",

      difference:
        0

    };

  }


  const difference =
    Math.abs(
      support.A -
      support.B
    );


  const total =
    support.A +
    support.B;


  const percentage =
    total === 0
      ? 0
      : difference /
        total *
        100;


  let confidence =
    "LOW";


  if (
    percentage >= 60
  ) {

    confidence =
      "HIGH";

  } else if (
    percentage >= 30
  ) {

    confidence =
      "MEDIUM";

  }


  let signal =
    "CONFLICT";


  if (
    support.A >
    support.B
  ) {

    signal =
      "A";

  } else if (
    support.B >
    support.A
  ) {

    signal =
      "B";

  }


  return {

    signal,

    prediction:
      signal === "A"
        ? "SMALL"
        : signal === "B"
        ? "BIG"
        : null,

    confidence,

    difference:
      Number(
        percentage.toFixed(2)
      )

  };
}


// ===========================================================
// MAIN 25 RULE ENGINE
// ===========================================================

function analyze(
  results
) {

  const history =
    convertHistory(
      results
    );


  // ---------------------------------------------------------
  // DATA CHECK
  // ---------------------------------------------------------

  if (
    history.length < 3
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

      engine:
        ENGINE_NAME,

      rulesCount:
        RULES.length,

      rawResults:
        Array.isArray(results)
          ? results
          : [],

      ABHistory:
        history.join(""),

      dataSize:
        history.length,

      matchedRules: [],

      support: {

        A: 0,

        B: 0,

        APercent: 0,

        BPercent: 0

      },

      reversal: {

        current:
          history[
            history.length - 1
          ] || null,

        reversalWatch:
          false,

        reason:
          ""

      },

      decision: {

        signal:
          "NO MATCH",

        prediction:
          null,

        confidence:
          "LOW",

        difference:
          0

      },

      message:
        "At least 3 valid results required."

    };
  }


  // ---------------------------------------------------------
  // FIND PATTERNS
  // ---------------------------------------------------------

  const matches =
    findRules(
      history
    );


  // ---------------------------------------------------------
  // SUPPORT
  // ---------------------------------------------------------

  const support =
    calculateSupport(
      matches
    );


  // ---------------------------------------------------------
  // REVERSAL
  // ---------------------------------------------------------

  const reversal =
    reversalAnalysis(
      history,
      support
    );


  // ---------------------------------------------------------
  // DECISION
  // ---------------------------------------------------------

  const decision =
    decide(
      history,
      support
    );


  // ---------------------------------------------------------
  // BEST MATCH
  // ---------------------------------------------------------

  let bestMatch =
    null;


  if (
    matches.length
  ) {

    const usable =
      matches
        .filter(
          item =>
            Boolean(
              item.next
            )
        );


    usable.sort(
      (a, b) => {

        if (
          b.matched !==
          a.matched
        ) {

          return (
            b.matched -
            a.matched
          );

        }


        return (
          calculateWeight(b) -
          calculateWeight(a)
        );

      }
    );


    bestMatch =
      usable[0] ||
      null;

  }


  // ---------------------------------------------------------
  // FINAL PREDICTION
  // ---------------------------------------------------------
  //
  // IMPORTANT:
  //
  // Decision signal must have
  // actual pattern evidence.
  //
  // If support is tied:
  // no prediction.
  //
  // If no usable match:
  // no prediction.
  //
  // ---------------------------------------------------------

  let prediction =
    null;


  if (
    bestMatch &&
    (
      support.A !==
      support.B
    )
  ) {

    prediction =
      decision.prediction;

  }


  // ---------------------------------------------------------
  // CONFIDENCE
  // ---------------------------------------------------------

  let confidence =
    0;


  if (
    prediction
  ) {

    confidence =
      clamp(
        Math.round(
          bestMatch.matched /
          bestMatch.pattern.length *
          100
        ),
        50,
        95
      );


    // Support dominance bonus.
    if (
      decision.difference >= 60
    ) {

      confidence += 8;

    } else if (
      decision.difference >= 30
    ) {

      confidence += 4;

    }


    confidence =
      clamp(
        confidence,
        50,
        95
      );

  }


  let confidenceLevel =
    "NONE";


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

  } else if (
    confidence > 0
  ) {

    confidenceLevel =
      "LOW";

  }


  // ---------------------------------------------------------
  // CLASSIFICATION
  // ---------------------------------------------------------

  let classification =
    "NO CLEAR PATTERN";


  if (
    !bestMatch
  ) {

    classification =
      "NO CLEAR PATTERN";

  } else if (
    support.A ===
    support.B
  ) {

    classification =
      "MIXED / CONFLICTING";

  } else if (
    reversal.reversalWatch
  ) {

    classification =
      "REVERSAL WATCH";

  } else {

    classification =
      "PATTERN MATCH";

  }


  // ---------------------------------------------------------
  // BEST PATTERN
  // ---------------------------------------------------------

  const patternName =
    bestMatch
      ? `RULE ${bestMatch.rule}`
      : "NONE";


  const matchedSequence =
    bestMatch
      ? bestMatch.pattern
          .slice(
            0,
            bestMatch.matched
          )
      : null;


  // ---------------------------------------------------------
  // REASON
  // ---------------------------------------------------------

  let reason =
    "";


  if (
    bestMatch &&
    prediction
  ) {

    reason =
      `Rule ${bestMatch.rule} ` +
      `matched ${matchedSequence} ` +
      `(${bestMatch.matched}/${bestMatch.pattern.length})` +
      ` -> ${prediction}.`;

  } else if (
    matches.length
  ) {

    reason =
      "Rules matched, but no clear next-side support.";

  } else {

    reason =
      "Current sequence me 25 rules ka usable pattern match nahi hua.";

  }


  // ---------------------------------------------------------
  // RESULT
  // ---------------------------------------------------------

  return {

    status:
      prediction
        ? "OK"
        : "NO_PATTERN",

    prediction,

    confidence,

    confidenceLevel,

    classification,

    pattern:
      patternName,

    matchedPattern:
      bestMatch
        ? bestMatch.pattern
        : null,

    matchedSequence,

    matchedRule:
      bestMatch
        ? bestMatch.rule
        : null,

    matchLength:
      bestMatch
        ? bestMatch.matched
        : 0,

    patternLength:
      bestMatch
        ? bestMatch.pattern.length
        : 0,

    nextType:
      bestMatch
        ? bestMatch.next
        : null,

    rawResults:
      Array.isArray(results)
        ? results
        : [],

    ABHistory:
      history.join(""),

    current:
      history[
        history.length - 1
      ],

    currentLabel:
      typeLabel(
        history[
          history.length - 1
        ]
      ),

    dataSize:
      history.length,

    matchedRules:
      matches,

    support: {

      A:
        support.A,

      B:
        support.B,

      APercent:
        support.APct,

      BPercent:
        support.BPct,

      total:
        support.total,

      evidence:
        support.evidence

    },

    reversal,

    decision,

    bestMatch:
      bestMatch
        ? {

            rule:
              bestMatch.rule,

            pattern:
              bestMatch.pattern,

            matched:
              bestMatch.matched,

            next:
              bestMatch.next,

            weight:
              calculateWeight(
                bestMatch
              )

          }
        : null,

    message:
      "Pattern match is historical evidence only, not a guaranteed next result.",

    engine:
      ENGINE_NAME,

    modelVersion:
      MODEL_VERSION,

    rulesCount:
      RULES.length,

    mapping: {

      A:
        "SMALL",

      B:
        "BIG"

    },

    analyzedAt:
      now()

  };
}


// ===========================================================
// TARGET ISSUE
// ===========================================================

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


  return incrementIssue(
    latest
  );
}


// ===========================================================
// GENERATE MODEL
// ===========================================================

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
          Number(
            row.number
          )
      )
      .filter(
        n =>
          Number.isInteger(n) &&
          n >= 0 &&
          n <= 9
      )
      .reverse();


  const analysis =
    analyze(
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

      matchLength:
        analysis.matchLength ||
        0,

      patternLength:
        analysis.patternLength ||
        0,

      nextType:
        analysis.nextType ||
        null,

      reason:
        analysis.reason ||
        "",

      modelVersion:
        MODEL_VERSION,

      engine:
        ENGINE_NAME,

      generatedAt,

      analysis

    },

    generatedAt

  };


  /*
  IMPORTANT:

  If no pattern matched,
  nothing is saved as a prediction.
  */

  await savePrediction(
    targetIssue,
    analysis
  );


  return modelCache;
}


// ===========================================================
// SAVE PREDICTION
// ===========================================================

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
      `[MODEL] ${targetIssue} -> ${analysis.prediction} | ${analysis.pattern}`
    );

  } catch (error) {

    console.error(
      "[DB] save prediction:",
      error.message
    );

  }
}


// ===========================================================
// SETTLE PREDICTIONS
// ===========================================================

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
      Number(
        row.number
      );


    const actualType =
      numberToAB(
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
          record.prediction ||
          ""
        ).toUpperCase();


      const actualLabel =
        actualType === "A"
          ? "SMALL"
          : "BIG";


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
        `[SETTLE] ${row.issueNumber} | ${prediction} | ${actualLabel} | ${actualResult}`
      );

    } catch (error) {

      console.error(
        "[DB] settle:",
        error.message
      );

    }

  }
}


// ===========================================================
// ACCESS KEY HELPERS
// ===========================================================

function getAccessKey(
  req
) {

  return String(
    req.headers[
      "x-access-key"
    ] || ""
  ).trim();
}


function getDeviceId(
  req
) {

  return String(
    req.headers[
      "x-device-id"
    ] || ""
  ).trim();
}


function getAdminKey(
  req
) {

  return String(
    req.headers[
      "x-admin-key"
    ] || ""
  ).trim();
}


// ===========================================================
// VALIDATE ACCESS
// ===========================================================

async function validateAccess(
  req
) {

  const key =
    getAccessKey(
      req
    );


  const device =
    getDeviceId(
      req
    );


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
      [
        key
      ]
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


// ===========================================================
// ADMIN AUTH
// ===========================================================

function requireAdmin(
  req
) {

  return (
    ADMIN_KEY &&
    getAdminKey(req) ===
      ADMIN_KEY
  );
}


// ===========================================================
// PREDICTION MAP
// ===========================================================

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
      "[DB] prediction map:",
      error.message
    );

  }


  return map;
}


// ===========================================================
// STATE API
// ===========================================================

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
  Only regenerate when target issue changes.
  */

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

          const issue =
            String(
              row.issueNumber
            );


          const number =
            Number(
              row.number
            );


          const type =
            numberToAB(
              number
            );


          const record =
            predictionMap.get(
              issue
            );


          let result =
            record?.actual_result ||
            null;


          const ai =
            record?.prediction ||
            null;


          if (
            !result &&
            ai
          ) {

            const actualLabel =
              type === "A"
                ? "SMALL"
                : type === "B"
                ? "BIG"
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
              typeLabel(
                type
              ),

            prediction:
              ai,

            ai,

            result:
              result ||
              "PENDING",

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


      engine:
        ENGINE_NAME,

      modelVersion:
        MODEL_VERSION,


      mapping: {

        A:
          "SMALL",

        B:
          "BIG"

      },


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

        matchLength:
          model?.matchLength ||
          0,

        patternLength:
          model?.patternLength ||
          0,

        nextType:
          model?.nextType ||
          null,

        reason:
          model?.reason ||
          "",

        modelVersion:
          MODEL_VERSION,

        engine:
          ENGINE_NAME,

        generatedAt:
          model?.generatedAt ||
          now(),

        analysis:
          model?.analysis ||
          null

      },


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


// ===========================================================
// KEY CHECK
// ===========================================================

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
        MODEL_VERSION,

      engine:
        ENGINE_NAME

    }
  );
}


// ===========================================================
// PREDICTION HISTORY
// ===========================================================

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


// ===========================================================
// ADMIN STATUS
// ===========================================================

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

      engine:
        ENGINE_NAME,

      rulesCount:
        RULES.length,

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


// ===========================================================
// ADMIN PING
// ===========================================================

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
        MODEL_VERSION,

      engine:
        ENGINE_NAME

    }
  );
}


// ===========================================================
// ADMIN WINGO TEST
// ===========================================================

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


// ===========================================================
// ADMIN MODEL TEST
// ===========================================================

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

      engine:
        ENGINE_NAME,

      modelVersion:
        MODEL_VERSION,

      rulesCount:
        RULES.length,

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

      matchLength:
        model.prediction?.matchLength ||
        0,

      patternLength:
        model.prediction?.patternLength ||
        0,

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


// ===========================================================
// ADMIN KEYS LIST
// ===========================================================

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


// ===========================================================
// ADMIN CREATE KEY
// ===========================================================

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


// ===========================================================
// ADMIN DELETE KEY
// ===========================================================

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


// ===========================================================
// ADMIN RESET DEVICE
// ===========================================================

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


// ===========================================================
// HEALTH
// ===========================================================

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
        ENGINE_NAME,

      rulesCount:
        RULES.length,

      time:
        now(),

      providerOk:
        providerState.ok,

      historyCount:
        providerState.history.length

    }
  );
}


// ===========================================================
// CONTENT TYPE
// ===========================================================

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


// ===========================================================
// STATIC SERVER
// ===========================================================

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
    filePath !== root &&
    !filePath.startsWith(
      root + path.sep
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


      // -------------------------------------------------------
      // MP3 RANGE
      // -------------------------------------------------------

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


      // -------------------------------------------------------
      // NORMAL FILE
      // -------------------------------------------------------

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


// ===========================================================
// ROUTER
// ===========================================================

const server =
  http.createServer(
    async (
      req,
      res
    ) => {

      try {

        // -----------------------------------------------------
        // CORS
        // -----------------------------------------------------

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


        // -----------------------------------------------------
        // HEALTH
        // -----------------------------------------------------

        if (
          pathname ===
          "/health"
        ) {

          health(res);

          return;
        }


        // -----------------------------------------------------
        // KEY CHECK
        // -----------------------------------------------------

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


        // -----------------------------------------------------
        // STATE
        // -----------------------------------------------------

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


        // -----------------------------------------------------
        // HISTORY
        // -----------------------------------------------------

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


        // -----------------------------------------------------
        // ADMIN AUTH
        // -----------------------------------------------------

        if (
          pathname.startsWith(
            "/api/admin/"
          )
        ) {

          if (
            !requireAdmin(
              req
            )
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


        // -----------------------------------------------------
        // ADMIN STATUS
        // -----------------------------------------------------

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


        // -----------------------------------------------------
        // ADMIN PING
        // -----------------------------------------------------

        if (
          pathname ===
            "/api/admin/ping" &&
          req.method ===
            "GET"
        ) {

          adminPing(
            res
          );

          return;
        }


        // -----------------------------------------------------
        // WINGO TEST
        // -----------------------------------------------------

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


        // -----------------------------------------------------
        // MODEL TEST
        // -----------------------------------------------------

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


        // -----------------------------------------------------
        // ADMIN KEYS GET
        // -----------------------------------------------------

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


        // -----------------------------------------------------
        // ADMIN KEYS CREATE
        // -----------------------------------------------------

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


        // -----------------------------------------------------
        // ADMIN KEYS DELETE
        // -----------------------------------------------------

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


        // -----------------------------------------------------
        // RESET DEVICE
        // -----------------------------------------------------

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


        // -----------------------------------------------------
        // STATIC
        // -----------------------------------------------------

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


// ===========================================================
// BACKGROUND REFRESH
// ===========================================================

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


// ===========================================================
// START SERVER
// ===========================================================

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
          "=============================================="
        );

        console.log(
          `DY AI WINGO running on ${PORT}`
        );

        console.log(
          `MODEL: ${MODEL_VERSION}`
        );

        console.log(
          `ENGINE: ${ENGINE_NAME}`
        );

        console.log(
          `RULES: ${RULES.length}`
        );

        console.log(
          "A = SMALL | B = BIG"
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
          `MATCH: ${
            modelCache.prediction
              ?.matchedSequence ||
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
          "=============================================="
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


// ===========================================================
// ERROR HANDLERS
// ===========================================================

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


// ===========================================================
// BOOT
// ===========================================================

start();
