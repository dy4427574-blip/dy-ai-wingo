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
  String(process.env.ADMIN_KEY || "").trim();

const WINGOBOT_TOKEN =
  String(process.env.WINGOBOT_TOKEN || "").trim();

const DATABASE_URL =
  String(process.env.DATABASE_URL || "").trim();

const WINGOBOT_API =
  "https://api.wingobot.com/v2/30-sec-game-history";

const MODEL_VERSION =
  "DY-AI-25-CHART-RULE-V2";

const THINKING_DURATION_MS =
  3000;

const PROVIDER_REFRESH_MS =
  3000;

const REQUEST_TIMEOUT_MS =
  12000;

let pool = null;


// ============================================================
// DATABASE
// ============================================================

if (DATABASE_URL) {

  pool = new Pool({
    connectionString: DATABASE_URL,

    ssl:
      DATABASE_URL.includes("localhost")
        ? false
        : {
            rejectUnauthorized: false
          }
  });

}


async function initDatabase() {

  if (!pool) {
    console.log("[DB] DATABASE_URL missing");
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

  console.log("[DB] Ready");
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

let refreshInProgress = false;


// ============================================================
// HELPERS
// ============================================================

function now() {
  return Date.now();
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


function numberToType(number) {

  const n = Number(number);

  if (
    !Number.isInteger(n) ||
    n < 0 ||
    n > 9
  ) {
    return null;
  }

  return n >= 5 ? "B" : "A";
}


function typeLabel(type) {

  if (type === "B") {
    return "BIG";
  }

  if (type === "A") {
    return "SMALL";
  }

  return "UNKNOWN";
}


function predictionFromType(type) {

  return type === "B"
    ? "BIG"
    : type === "A"
    ? "SMALL"
    : null;
}


function incrementIssue(issue) {

  if (
    issue === null ||
    issue === undefined
  ) {
    return null;
  }

  const value = String(issue);

  if (!/^\d+$/.test(value)) {
    return null;
  }

  try {

    return (
      BigInt(value) + 1n
    )
      .toString()
      .padStart(value.length, "0");

  } catch {

    return null;

  }
}


function compareIssue(a, b) {

  try {

    const aa = BigInt(String(a));
    const bb = BigInt(String(b));

    if (aa > bb) return 1;
    if (aa < bb) return -1;

    return 0;

  } catch {

    return 0;

  }
}


// ============================================================
// JSON RESPONSE
// ============================================================

function json(res, status, data) {

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
    (resolve, reject) => {

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
// WINGOBOT
// ============================================================

function fetchWingoBot() {

  return new Promise(
    (resolve, reject) => {

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
                "DY-AI-Wingo/4.0"

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

function normalizeHistory(payload) {

  const raw =
    Array.isArray(payload?.history)
      ? payload.history
      : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.results)
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

        number: n,

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
// CURRENT ISSUE
// ============================================================

function providerCurrentIssue(payload) {

  return (
    payload?.current?.issueNumber ??
    payload?.currentIssue ??
    payload?.current?.issue ??
    payload?.current?.period ??
    null
  );

}


// ============================================================
// PROVIDER REFRESH
// ============================================================

async function refreshProvider() {

  if (refreshInProgress) {
    return providerState;
  }

  refreshInProgress = true;

  try {

    const payload =
      await fetchWingoBot();

    const history =
      normalizeHistory(payload);

    const currentIssue =
      providerCurrentIssue(payload);

    providerState = {

      ok: true,

      currentIssue:
        currentIssue !== null
          ? String(currentIssue)
          : history[0]?.issueNumber ||
            null,

      history,

      fetched:
        Number(
          payload?.stats?.fetched
        ) ||
        history.length,

      lastUpdated:
        Number(
          payload?.stats?.last_updated
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

    refreshInProgress = false;

  }

}


// ============================================================
// 25 CHART RULES
// ============================================================
//
// A = SMALL
// B = BIG
//
// These are chart structures.
// Direction is derived from the next part
// of the repeating structure.
// ============================================================

const CHART_RULES = [

  {
    id: 1,
    name: "SINGLE TREND",
    type: "ALTERNATING",
    sequence: "ABABABABAB",
    next: "A",
    confidence: 72
  },

  {
    id: 2,
    name: "DOUBLE TREND",
    type: "DOUBLE",
    sequence: "AABBAABB",
    next: "A",
    confidence: 74
  },

  {
    id: 3,
    name: "TRIPLE TREND",
    type: "TRIPLE",
    sequence: "AAABBBAAABBB",
    next: "A",
    confidence: 76
  },

  {
    id: 4,
    name: "QUADRA TREND",
    type: "QUADRA",
    sequence: "AAAABBBBAAAABBBB",
    next: "A",
    confidence: 78
  },

  {
    id: 5,
    name: "THREE IN ONE",
    type: "3-1",
    sequence: "AABAABAAB",
    next: "A",
    confidence: 78
  },

  {
    id: 6,
    name: "LONG TREND",
    type: "LONG",
    sequence: "AAAAAAAAABBBBBBBBB",
    next: "A",
    confidence: 79
  },

  {
    id: 7,
    name: "TWO IN ONE",
    type: "2-1",
    sequence: "ABBABBABB",
    next: "A",
    confidence: 78
  },

  {
    id: 8,
    name: "THREE IN TWO",
    type: "3-2",
    sequence: "AAABAAABAAAB",
    next: "A",
    confidence: 80
  },

  {
    id: 9,
    name: "FOUR IN ONE",
    type: "4-1",
    sequence: "AAABBAAABB",
    next: "A",
    confidence: 80
  },

  {
    id: 10,
    name: "CENTER BREAK",
    type: "4-2-1",
    sequence: "AAAABBABBAAAA",
    next: "B",
    confidence: 82
  },

  {
    id: 11,
    name: "ONE IN THREE",
    type: "1-3",
    sequence: "ABBBABBBABBB",
    next: "A",
    confidence: 81
  },

  {
    id: 12,
    name: "EXPANDING TREND",
    type: "1-2-3",
    sequence: "ABAABBABBB",
    next: "A",
    confidence: 82
  },

  {
    id: 13,
    name: "EXPANDING BLOCK",
    type: "2-3-4",
    sequence: "AABBAAABBBAAAABBBB",
    next: "A",
    confidence: 84
  },

  {
    id: 14,
    name: "EXPANDING BLOCK",
    type: "1-2-3-4",
    sequence: "ABBAAABBBB",
    next: "A",
    confidence: 82
  },

  {
    id: 15,
    name: "SHRINKING BLOCK",
    type: "4-3-2-1",
    sequence: "AAAABBBAAB",
    next: "A",
    confidence: 82
  },

  {
    id: 16,
    name: "EXPANDING BLOCK",
    type: "1-2-3",
    sequence: "ABAABBAAABBB",
    next: "A",
    confidence: 84
  },

  {
    id: 17,
    name: "CENTER REVERSAL",
    type: "2-3-1-3-2",
    sequence: "AABBBABBBAA",
    next: "B",
    confidence: 84
  },

  {
    id: 18,
    name: "LONG EXPANSION",
    type: "1-2-4-8",
    sequence: "ABBAAAABBBBBBBB",
    next: "A",
    confidence: 85
  },

  {
    id: 19,
    name: "FOUR IN ONE",
    type: "1-4-3",
    sequence: "ABBBBABBB",
    next: "A",
    confidence: 83
  },

  {
    id: 20,
    name: "THREE IN TWO",
    type: "3-2",
    sequence: "AABBBAABBB",
    next: "A",
    confidence: 84
  },

  {
    id: 21,
    name: "EXPANDING ALTERNATION",
    type: "1-2-3",
    sequence: "ABAABAAAB",
    next: "A",
    confidence: 84
  },

  {
    id: 22,
    name: "PROGRESSIVE BLOCK",
    type: "2-2-3",
    sequence: "AABAABBAABBB",
    next: "A",
    confidence: 85
  },

  {
    id: 23,
    name: "FIVE IN ONE",
    type: "5-1",
    sequence: "AAAAABAAAAAB",
    next: "A",
    confidence: 86
  },

  {
    id: 24,
    name: "FIVE IN TWO",
    type: "5-2",
    sequence: "AAAAABBAAAAABB",
    next: "A",
    confidence: 87
  },

  {
    id: 25,
    name: "FIVE IN THREE",
    type: "5-3",
    sequence: "AAAAABBBAAAAABBB",
    next: "A",
    confidence: 88
  }

];


// ============================================================
// PATTERN MATCH HELPERS
// ============================================================

function suffixMatchLength(
  source,
  pattern
) {

  const max =
    Math.min(
      source.length,
      pattern.length
    );

  for (
    let length = max;
    length >= 3;
    length--
  ) {

    if (
      source.slice(-length) ===
      pattern.slice(-length)
    ) {

      return length;

    }

  }

  return 0;
}


function getCurrentRun(sequence) {

  if (!sequence.length) {
    return {
      type: null,
      length: 0
    };
  }

  const latest =
    sequence[sequence.length - 1];

  let length = 1;

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

    length++;

  }

  return {
    type: latest,
    length
  };

}


// ============================================================
// LONG TREND
// ============================================================

function getLongTrend(sequence) {

  const run =
    getCurrentRun(sequence);

  if (
    run.length < 8
  ) {

    return null;

  }

  return {

    id: 0,

    name: "LONG TREND",

    type: "LONG TREND",

    sequence:
      sequence.slice(
        -run.length
      ),

    next:
      run.type,

    confidence:
      run.length >= 12
        ? 78
        : run.length >= 10
        ? 75
        : 70

  };

}


// ============================================================
// HISTORICAL PATTERN VALIDATION
// ============================================================

function historicalValidation(
  sequence,
  rule
) {

  if (!rule) {

    return {
      matches: 0,
      correct: 0,
      rate: null
    };

  }

  const pattern =
    rule.sequence;

  const expected =
    rule.next;

  const length =
    pattern.length;

  let matches = 0;
  let correct = 0;

  for (
    let i = length;
    i < sequence.length - 1;
    i++
  ) {

    const previous =
      sequence.slice(
        i - length,
        i
      );

    if (
      previous === pattern
    ) {

      matches++;

      if (
        sequence[i] ===
        expected
      ) {

        correct++;

      }

    }

  }

  return {

    matches,

    correct,

    rate:
      matches
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
// PURE CHART ENGINE
// ============================================================

function humanBigSmallLogic(
  results
) {

  // ----------------------------------------------------------
  // CLEAN
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

      n = Number(value);

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
  // A/B
  // ----------------------------------------------------------

  const sequenceArray =
    numbers.map(
      n =>
        n >= 5
          ? "B"
          : "A"
    );

  const sequence =
    sequenceArray.join("");

  const dataSize =
    sequence.length;


  // ----------------------------------------------------------
  // MIN DATA
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

      matchType:
        "NONE",

      sequence,

      dataSize,

      current:
        null,

      historicalMatches:
        0,

      historicalCorrect:
        0,

      historicalRate:
        null,

      reason:
        "At least 5 results required.",

      engine:
        "DY-AI-25-RULE-CHART"

    };

  }


  // ----------------------------------------------------------
  // EXACT MATCH
  // ----------------------------------------------------------

  const exactMatches = [];

  for (
    const rule of CHART_RULES
  ) {

    if (
      sequence.endsWith(
        rule.sequence
      )
    ) {

      exactMatches.push(rule);

    }

  }


  exactMatches.sort(
    (a, b) =>
      b.sequence.length -
      a.sequence.length
  );


  // ----------------------------------------------------------
  // PARTIAL MATCH
  // ----------------------------------------------------------

  let bestPartial = null;
  let bestPartialLength = 0;

  for (
    const rule of CHART_RULES
  ) {

    const length =
      suffixMatchLength(
        sequence,
        rule.sequence
      );

    if (
      length >= 3 &&
      length >
        bestPartialLength
    ) {

      bestPartial =
        rule;

      bestPartialLength =
        length;

    }

  }


  // ----------------------------------------------------------
  // SELECT
  // ----------------------------------------------------------

  let selectedRule = null;
  let matchType = "NONE";
  let matchedLength = 0;

  if (
    exactMatches.length
  ) {

    selectedRule =
      exactMatches[0];

    matchType =
      "EXACT";

    matchedLength =
      selectedRule.sequence.length;

  } else if (
    bestPartial
  ) {

    selectedRule =
      bestPartial;

    matchType =
      "PARTIAL";

    matchedLength =
      bestPartialLength;

  }


  // ----------------------------------------------------------
  // CURRENT RUN
  // ----------------------------------------------------------

  const current =
    getCurrentRun(
      sequence
    );


  // ----------------------------------------------------------
  // LONG TREND
  // ----------------------------------------------------------

  const longTrend =
    getLongTrend(
      sequence
    );


  // ----------------------------------------------------------
  // HISTORICAL
  // ----------------------------------------------------------

  const history =
    historicalValidation(
      sequence,
      selectedRule
    );


  // ----------------------------------------------------------
  // FINAL
  // ----------------------------------------------------------

  let prediction = null;

  let confidence = 0;

  let patternName =
    "NONE";

  let matchedSequence =
    null;

  let classification =
    "NO CLEAR SIGNAL";

  let reason =
    "No chart pattern matched.";


  // ----------------------------------------------------------
  // EXACT
  // ----------------------------------------------------------

  if (
    selectedRule &&
    matchType === "EXACT"
  ) {

    prediction =
      predictionFromType(
        selectedRule.next
      );

    confidence =
      selectedRule.confidence;

    patternName =
      selectedRule.name;

    matchedSequence =
      selectedRule.sequence;

    classification =
      "EXACT PATTERN MATCH";

    reason =
      `${selectedRule.name} | ` +
      `${selectedRule.sequence} -> ` +
      `${selectedRule.next}`;

  }


  // ----------------------------------------------------------
  // PARTIAL
  // ----------------------------------------------------------

  else if (
    selectedRule &&
    matchType === "PARTIAL"
  ) {

    prediction =
      predictionFromType(
        selectedRule.next
      );

    const ratio =
      matchedLength /
      selectedRule.sequence.length;

    confidence =
      Math.round(
        50 +
        ratio * 32
      );

    confidence =
      Math.max(
        52,
        Math.min(
          82,
          confidence
        )
      );

    patternName =
      selectedRule.name;

    matchedSequence =
      sequence.slice(
        -matchedLength
      );

    classification =
      "PARTIAL PATTERN MATCH";

    reason =
      `${selectedRule.name} | ` +
      `${matchedLength}/` +
      `${selectedRule.sequence.length} matched`;

  }


  // ----------------------------------------------------------
  // LONG TREND
  // ----------------------------------------------------------

  else if (
    longTrend
  ) {

    prediction =
      predictionFromType(
        longTrend.next
      );

    confidence =
      longTrend.confidence;

    patternName =
      "LONG TREND";

    matchedSequence =
      longTrend.sequence;

    classification =
      "LONG TREND";

    reason =
      `LONG TREND ${longTrend.next} ` +
      `x${current.length}`;

  }


  // ----------------------------------------------------------
  // FALLBACK CHART STRUCTURE
  // ----------------------------------------------------------
  //
  // IMPORTANT:
  // Prediction blank nahi rahegi jab enough data ho.
  //
  // Is fallback me latest chart ke run structure
  // ko identify kiya jata hai.
  //
  // Ye frequency/momentum prediction nahi hai.
  // ----------------------------------------------------------

  if (
    !prediction &&
    dataSize >= 5
  ) {

    const recent =
      sequence.slice(-8);

    const last =
      recent[recent.length - 1];

    const before =
      recent.slice(
        0,
        -1
      );

    let transitions = 0;

    for (
      let i = 1;
      i < before.length;
      i++
    ) {

      if (
        before[i] !==
        before[i - 1]
      ) {

        transitions++;

      }

    }


    // Alternating chart
    if (
      before.length >= 4 &&
      transitions >=
        before.length - 2
    ) {

      prediction =
        last === "B"
          ? "SMALL"
          : "BIG";

      confidence = 58;

      patternName =
        "SINGLE TREND";

      matchedSequence =
        recent;

      classification =
        "CHART FALLBACK";

      reason =
        "Recent alternating chart structure.";

    }


    // Repeated pairs
    else if (
      before.length >= 4
    ) {

      const lastFour =
        before.slice(-4);

      if (
        lastFour[0] ===
          lastFour[1] &&
        lastFour[2] ===
          lastFour[3]
      ) {

        prediction =
          last === "B"
            ? "BIG"
            : "SMALL";

        confidence = 56;

        patternName =
          "DOUBLE TREND";

        matchedSequence =
          lastFour.join("") +
          last;

        classification =
          "CHART FALLBACK";

        reason =
          "Recent double-block chart structure.";

      }

    }


    // Repeated triple
    if (
      !prediction &&
      current.length >= 3
    ) {

      prediction =
        current.type === "B"
          ? "SMALL"
          : "BIG";

      confidence = 54;

      patternName =
        "TRIPLE TREND";

      matchedSequence =
        sequence.slice(
          -current.length
        );

      classification =
        "CHART FALLBACK";

      reason =
        "Recent triple-run chart structure.";

    }


    // Final chart-only fallback
    if (
      !prediction
    ) {

      prediction =
        last === "B"
          ? "SMALL"
          : "BIG";

      confidence = 51;

      patternName =
        "CHART CONTINUATION";

      matchedSequence =
        recent;

      classification =
        "CHART FALLBACK";

      reason =
        "No named rule matched; latest chart structure used.";

    }

  }


  // ----------------------------------------------------------
  // HISTORICAL CONFIRMATION
  // ----------------------------------------------------------

  if (
    selectedRule &&
    history.matches >= 2 &&
    history.rate !== null
  ) {

    if (
      history.rate >= 70
    ) {

      confidence =
        Math.min(
          95,
          confidence + 4
        );

    } else if (
      history.rate >= 55
    ) {

      confidence =
        Math.min(
          93,
          confidence + 1
        );

    } else if (
      history.rate < 40
    ) {

      confidence =
        Math.max(
          45,
          confidence - 7
        );

    }

  }


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

  } else {

    confidenceLevel =
      "LOW";

  }


  // ----------------------------------------------------------
  // SUPPORT
  // ----------------------------------------------------------

  let bigSupport = 50;
  let smallSupport = 50;


  if (
    prediction === "BIG"
  ) {

    bigSupport =
      confidence;

    smallSupport =
      100 - confidence;

  } else if (
    prediction === "SMALL"
  ) {

    smallSupport =
      confidence;

    bigSupport =
      100 - confidence;

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

    matchType,

    matchedLength,

    sequence,

    dataSize,

    current: {

      type:
        current.type,

      label:
        typeLabel(
          current.type
        ),

      streak:
        current.length

    },

    historicalMatches:
      history.matches,

    historicalCorrect:
      history.correct,

    historicalRate:
      history.rate,

    support: {

      BIG:
        Number(
          bigSupport.toFixed(2)
        ),

      SMALL:
        Number(
          smallSupport.toFixed(2)
        )

    },

    reason,

    engine:
      "DY-AI-25-RULE-CHART",

    mapping: {

      A:
        "SMALL",

      B:
        "BIG"

    },

    rulesCount:
      CHART_RULES.length,

    supportedRules:
      CHART_RULES.map(
        rule => ({

          id:
            rule.id,

          name:
            rule.name,

          type:
            rule.type,

          sequence:
            rule.sequence,

          next:
            rule.next,

          prediction:
            predictionFromType(
              rule.next
            )

        })
      ),

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

  if (!history.length) {
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


// ============================================================
// GENERATE MODEL
// ============================================================

async function generateModel() {

  const history =
    providerState.history;

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
        analysis.classification ||
        "NO CLEAR SIGNAL",

      pattern:
        analysis.pattern ||
        "NONE",

      matchedPattern:
        analysis.matchedPattern ||
        null,

      matchedSequence:
        analysis.matchedSequence ||
        null,

      matchType:
        analysis.matchType ||
        "NONE",

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

    const existing =
      await pool.query(
        `
        SELECT id
        FROM prediction_records
        WHERE target_issue = $1
        LIMIT 1
        `,
        [
          String(targetIssue)
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

        String(targetIssue),

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
      "[DB] save:",
      error.message
    );

  }

}


// ============================================================
// SETTLE
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
      numberToType(number);

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
        predictionFromType(
          actualType
        );


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


async function validateAccess(req) {

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
    await validateAccess(req);


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


  if (
    !modelCache.prediction ||
    modelCache.targetIssue !==
      targetIssue
  ) {

    await generateModel();

  }


  const prediction =
    modelCache.prediction;


  const records =
    await getPredictionRecords();


  const history =
    providerState.history
      .slice(0, 30)
      .map(
        row => {

          const number =
            Number(row.number);

          const type =
            numberToType(number);

          const issue =
            String(
              row.issueNumber
            );


          const record =
            records.find(
              item =>
                String(
                  item.target_issue
                ) === issue
            );


          let result =
            "PENDING";


          if (
            record?.actual_result
          ) {

            result =
              record.actual_result;

          } else if (
            record?.prediction
          ) {

            result =
              "PENDING";

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
              record?.prediction ||
              null,

            confidence:
              record?.confidence ||
              0,

            result

          };

        }
      );


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
          prediction?.targetIssue ||
          targetIssue,

        prediction:
          prediction?.prediction ||
          null,

        confidence:
          prediction?.confidence ||
          0,

        confidenceLevel:
          prediction?.confidenceLevel ||
          "LOW",

        classification:
          prediction?.classification ||
          "NO CLEAR SIGNAL",

        pattern:
          prediction?.pattern ||
          "NONE",

        matchedPattern:
          prediction?.matchedPattern ||
          null,

        matchedSequence:
          prediction?.matchedSequence ||
          null,

        matchType:
          prediction?.matchType ||
          "NONE",

        reason:
          prediction?.reason ||
          "",

        modelVersion:
          MODEL_VERSION,

        generatedAt:
          prediction?.generatedAt ||
          now(),

        analysis:
          prediction?.analysis ||
          null

      },


      prediction:
        prediction?.prediction ||
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
// PREDICTION RECORDS
// ============================================================

async function getPredictionRecords() {

  if (!pool) {
    return [];
  }

  try {

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
        LIMIT 150
        `
      );

    return result.rows;

  } catch {

    return [];

  }

}


// ============================================================
// KEY CHECK
// ============================================================

async function keyCheck(
  req,
  res
) {

  const auth =
    await validateAccess(req);


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
// HISTORY API
// ============================================================

async function predictionHistory(
  res
) {

  const records =
    await getPredictionRecords();


  json(
    res,
    200,
    {

      ok: true,

      records

    }
  );

}


// ============================================================
// ADMIN STATUS
// ============================================================

async function adminStatus(res) {

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

function adminPing(res) {

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

async function adminWingoTest(res) {

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

async function adminModelTest(res) {

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
// ADMIN KEY LIST
// ============================================================

async function adminKeysList(res) {

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
// ADMIN KEY CREATE
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
// ADMIN KEY DELETE
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
    url.searchParams.get("id") ||
    body?.id;


  const key =
    url.searchParams.get("key") ||
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

function health(res) {

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
        providerState.history.length,

      prediction:
        modelCache.prediction?.prediction ||
        null

    }
  );

}


// ============================================================
// STATIC
// ============================================================

function contentType(filePath) {

  const ext =
    path
      .extname(filePath)
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
    !filePath.startsWith(root)
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
        // OPTIONS
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
        // KEY CHECK
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
        // HISTORY
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
        // WINGO TEST
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
        // KEY LIST
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
        // KEY CREATE
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
        // KEY DELETE
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
          `DY AI WINGO running on ${PORT}`
        );

        console.log(
          `MODEL: ${MODEL_VERSION}`
        );

        console.log(
          `RULES: ${CHART_RULES.length}`
        );

        console.log(
          `HISTORY: ${
            providerState.history.length
          }`
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
