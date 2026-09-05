"use strict";

/*
============================================================
DY AI WINGO
TASHAN-WIN STYLE 25 RULE PATTERN ENGINE
============================================================

A = SMALL  (0-4)
B = BIG    (5-9)

IMPORTANT:
Prediction tabhi milegi jab 25 chart rules me se
usable pattern match ho.

NO:
- frequency prediction
- momentum prediction
- forced alternation
- random prediction
- "same side continue" prediction
- pattern ke bina prediction

YES:
- 25 chart pattern matching
- strongest/latest pattern priority
- historical pattern validation
- conflicting pattern protection
- WIN / LOSS settlement
============================================================
*/


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
  "DY-AI-25-CHART-RULE-V3";

const THINKING_DURATION_MS =
  3000;

const PROVIDER_REFRESH_MS =
  3000;

const REQUEST_TIMEOUT_MS =
  12000;


// ============================================================
// DATABASE
// ============================================================

let pool = null;

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
// DATABASE INIT
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


function randomKey() {

  return (
    "DY-" +
    crypto
      .randomBytes(12)
      .toString("hex")
      .toUpperCase()
  );
}


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


function numberToType(number) {

  const ab =
    numberToAB(number);

  if (!ab) {
    return null;
  }

  return ab === "A"
    ? "S"
    : "B";
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


function abToPrediction(ab) {

  if (ab === "A") {
    return "SMALL";
  }

  if (ab === "B") {
    return "BIG";
  }

  return null;
}


function predictionToAB(prediction) {

  const value =
    String(
      prediction || ""
    ).toUpperCase();

  if (value === "SMALL") {
    return "A";
  }

  if (value === "BIG") {
    return "B";
  }

  return null;
}


function incrementIssue(issue) {

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


function compareIssue(a, b) {

  try {

    const aa =
      BigInt(
        String(a)
      );

    const bb =
      BigInt(
        String(b)
      );


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
                "DY-AI-Wingo/5.0"

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


  return result;
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
// PROVIDER REFRESH
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

      error:
        null

    };


    return providerState;

  } catch (error) {

    providerState = {

      ...providerState,

      ok:
        false,

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
// 25 CHART RULES
// ============================================================
//
// A = SMALL
// B = BIG
//
// IMPORTANT:
// Pattern strings below are the chart rules supplied.
// Prediction is NOT generated from simple frequency.
//
// ============================================================

const RULES = [

  // ----------------------------------------------------------
  // LEFT
  // ----------------------------------------------------------

  {
    id: 1,
    pattern:
      "ABABABABAB"
  },

  {
    id: 2,
    pattern:
      "AABBAABB"
  },

  {
    id: 3,
    pattern:
      "AAABBBAAABBB"
  },

  {
    id: 4,
    pattern:
      "AAAABBBBAAAABBBB"
  },

  {
    id: 5,
    pattern:
      "AABAABAAB"
  },

  {
    id: 6,
    pattern:
      "AAAAAAAABBBBBBBB"
  },

  {
    id: 7,
    pattern:
      "ABBABBABB"
  },

  {
    id: 8,
    pattern:
      "AAABAAABAAAB"
  },

  {
    id: 9,
    pattern:
      "AAABBAAABB"
  },

  {
    id: 10,
    pattern:
      "AAAABBABB" +
      "AAAA"
  },

  {
    id: 11,
    pattern:
      "ABBBABBBABBB"
  },

  {
    id: 12,
    pattern:
      "ABABBABBB"
  },

  {
    id: 13,
    pattern:
      "AABBAAABBBAAAABBBB"
  },


  // ----------------------------------------------------------
  // RIGHT
  // ----------------------------------------------------------

  {
    id: 14,
    pattern:
      "ABBAAABBBB"
  },

  {
    id: 15,
    pattern:
      "AAAABBBAAB"
  },

  {
    id: 16,
    pattern:
      "ABAABBAAABBB"
  },

  {
    id: 17,
    pattern:
      "AABBBABBBAA"
  },

  {
    id: 18,
    pattern:
      "ABBAAAABBBBBBBB"
  },

  {
    id: 19,
    pattern:
      "ABBBABBB"
  },

  {
    id: 20,
    pattern:
      "AABBBAABBB"
  },

  {
    id: 21,
    pattern:
      "ABAABAAAB"
  },

  {
    id: 22,
    pattern:
      "AABAABBAABBB"
  },

  {
    id: 23,
    pattern:
      "AAAABAAAAB"
  },

  {
    id: 24,
    pattern:
      "AAAABBAAAABB"
  },

  {
    id: 25,
    pattern:
      "AAAABBBAAAABBB"
  }

];


// ============================================================
// CLEAN RULES
// ============================================================

for (
  const rule of RULES
) {

  rule.pattern =
    String(
      rule.pattern || ""
    )
      .toUpperCase()
      .replace(
        /[^AB]/g,
        ""
      );

}


// ============================================================
// PATTERN MATCH
// ============================================================
//
// Current history:
//
// XXXXXAABB
//
// Rule:
//
// AABBAABB
//
// History suffix = AABB
// Rule prefix   = AABB
//
// Match length = 4
//
// Next rule character:
// AABBAABB
//     ^
//     next = A
//
// Prediction = SMALL
//
// ============================================================

function suffixMatch(
  history,
  pattern
) {

  const maxLength =
    Math.min(
      history.length,
      pattern.length
    );


  let bestMatch =
    0;


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
      pattern
        .slice(
          0,
          len
        );


    if (
      historyPart ===
      patternPart
    ) {

      bestMatch =
        len;

    }

  }


  return bestMatch;
}


// ============================================================
// FIND ALL MATCHES
// ============================================================

function findRuleMatches(
  history
) {

  const matches = [];


  for (
    const rule of RULES
  ) {

    const matched =
      suffixMatch(
        history,
        rule.pattern
      );


    if (
      matched < 3
    ) {

      /*
        1-2 characters are too common.
        They are not considered a usable
        chart pattern.
      */

      continue;
    }


    const completed =
      matched >=
      rule.pattern.length;


    let next =
      null;


    if (!completed) {

      next =
        rule.pattern[
          matched
        ];

    }


    matches.push({

      rule:
        rule.id,

      pattern:
        rule.pattern,

      matched,

      patternLength:
        rule.pattern.length,

      completed,

      next,

      prediction:
        abToPrediction(
          next
        )

    });

  }


  return matches;
}


// ============================================================
// MATCH SCORE
// ============================================================

function matchScore(
  match
) {

  let score =
    match.matched * 10;


  /*
    Longer pattern = stronger.

    Exact/near-exact patterns get
    additional weight.
  */

  if (
    match.matched >=
    match.patternLength - 1
  ) {

    score += 25;

  }


  if (
    match.matched >= 8
  ) {

    score += 20;

  }


  if (
    match.matched >= 10
  ) {

    score += 20;

  }


  /*
    Completed pattern cannot predict
    next directly, so its score is
    not used as prediction evidence.
  */

  if (
    match.completed
  ) {

    score -= 1000;

  }


  return score;
}


// ============================================================
// SELECT STRONGEST PREDICTION
// ============================================================
//
// VERY IMPORTANT:
//
// Prediction comes ONLY from strongest
// usable chart pattern.
//
// Other weak patterns cannot override it.
//
// If two equally strong patterns predict
// opposite sides -> NO PREDICTION.
//
// ============================================================

function selectPatternPrediction(
  matches
) {

  const usable =
    matches.filter(
      match =>
        match.next === "A" ||
        match.next === "B"
    );


  if (!usable.length) {

    return {

      prediction:
        null,

      status:
        "NO USABLE PATTERN",

      confidence:
        0,

      bestMatch:
        null,

      strongestMatches:
        [],

      conflict:
        false

    };

  }


  const scored =
    usable.map(
      match => ({

        ...match,

        score:
          matchScore(
            match
          )

      })
    );


  scored.sort(
    (
      a,
      b
    ) => {

      if (
        b.score !==
        a.score
      ) {

        return (
          b.score -
          a.score
        );

      }


      if (
        b.matched !==
        a.matched
      ) {

        return (
          b.matched -
          a.matched
        );

      }


      /*
        Lower rule ID first only as
        deterministic tie breaker.
      */

      return (
        a.rule -
        b.rule
      );

    }
  );


  const best =
    scored[0];


  /*
    Find patterns with same
    top strength.
  */

  const topScore =
    best.score;


  const topMatches =
    scored.filter(
      item =>
        item.score ===
        topScore
    );


  const sides =
    [
      ...new Set(
        topMatches.map(
          item =>
            item.next
        )
      )
    ];


  /*
    Conflict protection.

    If strongest patterns disagree,
    do NOT guess.
  */

  if (
    sides.length > 1
  ) {

    return {

      prediction:
        null,

      status:
        "PATTERN CONFLICT",

      confidence:
        0,

      bestMatch:
        null,

      strongestMatches:
        topMatches,

      conflict:
        true

    };

  }


  /*
    Confidence is only a model-strength
    indicator, not probability of winning.
  */

  let confidence =
    55;


  if (
    best.matched >= 4
  ) {

    confidence += 5;

  }


  if (
    best.matched >= 6
  ) {

    confidence += 7;

  }


  if (
    best.matched >= 8
  ) {

    confidence += 8;

  }


  if (
    best.matched >=
    best.patternLength - 1
  ) {

    confidence += 8;

  }


  confidence =
    Math.min(
      90,
      confidence
    );


  let confidenceLevel =
    "LOW";


  if (
    confidence >= 80
  ) {

    confidenceLevel =
      "HIGH";

  } else if (
    confidence >= 70
  ) {

    confidenceLevel =
      "MEDIUM";

  }


  return {

    prediction:
      abToPrediction(
        best.next
      ),

    status:
      "PATTERN MATCH",

    confidence,

    confidenceLevel,

    bestMatch:
      best,

    strongestMatches:
      topMatches,

    conflict:
      false

  };

}


// ============================================================
// HISTORICAL VALIDATION
// ============================================================
//
// Same exact pattern appeared earlier?
//
// If yes, check what came next.
//
// This does NOT reverse the prediction.
// It only changes evidence information.
//
// ============================================================

function historicalValidation(
  sequence,
  pattern,
  expectedNext
) {

  if (
    !pattern ||
    !expectedNext
  ) {

    return {

      matches:
        0,

      correct:
        0,

      wrong:
        0,

      rate:
        null

    };

  }


  const length =
    pattern.length;


  let matches = 0;
  let correct = 0;
  let wrong = 0;


  for (
    let i = length;
    i <
      sequence.length;
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
      previous !==
      pattern
    ) {

      continue;
    }


    /*
      If i is last current result,
      there is no next result to verify.
    */

    if (
      i >=
      sequence.length
    ) {

      continue;
    }


    matches++;


    if (
      sequence[i] ===
      expectedNext
    ) {

      correct++;

    } else {

      wrong++;

    }

  }


  const rate =
    matches > 0
      ? Number(
          (
            correct /
            matches *
            100
          ).toFixed(2)
        )
      : null;


  return {

    matches,

    correct,

    wrong,

    rate

  };

}


// ============================================================
// MAIN PATTERN ENGINE
// ============================================================

function analyzePattern(
  results
) {

  /*
    Clean numbers.
  */

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


  /*
    Chronological:
    oldest -> newest
  */

  const sequence =
    clean.map(
      numberToAB
    );


  const sequenceString =
    sequence.join("");


  const dataSize =
    sequence.length;


  if (
    dataSize < 3
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

      current:
        null,

      matchedRules:
        [],

      reason:
        "Not enough valid results."

    };

  }


  /*
    Find chart matches.
  */

  const matches =
    findRuleMatches(
      sequence
    );


  /*
    Select strongest usable pattern.
  */

  const selected =
    selectPatternPrediction(
      matches
    );


  let historical =
    {

      matches:
        0,

      correct:
        0,

      wrong:
        0,

      rate:
        null

    };


  if (
    selected.bestMatch
  ) {

    historical =
      historicalValidation(
        sequence,
        selected.bestMatch.pattern,
        selected.bestMatch.next
      );

  }


  /*
    Current streak is informational only.
    It does NOT create a prediction.
  */

  const current =
    sequence[
      sequence.length - 1
    ];


  let streak = 1;


  for (
    let i =
      sequence.length - 2;
    i >= 0;
    i--
  ) {

    if (
      sequence[i] ===
      current
    ) {

      streak++;

    } else {

      break;

    }

  }


  /*
    Classification.
  */

  let classification =
    "NO CLEAR PATTERN";


  if (
    selected.status ===
    "PATTERN CONFLICT"
  ) {

    classification =
      "PATTERN CONFLICT";

  } else if (
    selected.status ===
    "PATTERN MATCH"
  ) {

    classification =
      "PATTERN MATCH";

  }


  /*
    Reason.
  */

  let reason =
    "No usable chart pattern matched.";

  if (
    selected.status ===
    "PATTERN CONFLICT"
  ) {

    reason =
      "Strong chart patterns matched but their next sides conflict. Prediction withheld.";

  } else if (
    selected.bestMatch
  ) {

    reason =
      `RULE ${selected.bestMatch.rule}: ` +
      `${selected.bestMatch.pattern} ` +
      `matched ${selected.bestMatch.matched}/${selected.bestMatch.patternLength} ` +
      `-> ${selected.bestMatch.next}`;

  }


  /*
    Historical note.
  */

  if (
    selected.bestMatch &&
    historical.matches > 0
  ) {

    reason +=
      ` • Historical ${historical.correct}/${historical.matches}`;

  }


  return {

    status:
      "OK",

    prediction:
      selected.prediction,

    confidence:
      selected.confidence,

    confidenceLevel:
      selected.confidenceLevel ||
      "LOW",

    classification,

    pattern:
      selected.bestMatch
        ? `RULE ${selected.bestMatch.rule}`
        : "NONE",

    matchedPattern:
      selected.bestMatch
        ?.pattern ||
      null,

    matchedSequence:
      selected.bestMatch
        ? sequenceString.slice(
            -selected.bestMatch.matched
          )
        : null,

    sequence:
      sequenceString,

    dataSize,

    current: {

      type:
        current,

      label:
        current === "A"
          ? "SMALL"
          : "BIG",

      streak

    },

    matchedRules:
      matches,

    strongestMatches:
      selected.strongestMatches,

    selectedMatch:
      selected.bestMatch,

    patternStatus:
      selected.status,

    conflict:
      selected.conflict,

    historical,

    reason,

    supportedPatterns:
      RULES.map(
        rule =>
          `RULE ${rule.id}`
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


  if (
    !history.length
  ) {

    return null;
  }


  const latest =
    history[0]
      ?.issueNumber;


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

    return String(
      current
    );

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


  /*
    Provider:
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
    analyzePattern(
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
          analysis.confidence ||
          0
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

      patternStatus:
        analysis.patternStatus,

      conflict:
        analysis.conflict,

      reason:
        analysis.reason,

      historical:
        analysis.historical,

      selectedMatch:
        analysis.selectedMatch,

      strongestMatches:
        analysis.strongestMatches,

      modelVersion:
        MODEL_VERSION,

      generatedAt,

      analysis

    },

    generatedAt

  };


  /*
    IMPORTANT:

    No pattern = no database prediction.
  */

  if (
    prediction
  ) {

    await savePrediction(
      targetIssue,
      analysis
    );

  }


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
      Existing prediction for same issue?
    */

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
          analysis.confidence ||
          0
        ),

        MODEL_VERSION,

        now()

      ]
    );


    console.log(
      `[PREDICTION SAVED] ${targetIssue} -> ${analysis.prediction}`
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
      Number(
        row.number
      );


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


      console.log(
        `[SETTLED] ${row.issueNumber} ${prediction} -> ${actualLabel} = ${actualResult}`
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


  if (
    !row.device_id
  ) {

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
    New target issue =
    generate new analysis.

    IMPORTANT:
    Model can legitimately have
    prediction = null when no pattern.
  */

  if (
    !modelCache.prediction ||
    modelCache.targetIssue !==
      targetIssue
  ) {

    await generateModel();

  }


  /*
    Live history.
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
          "NO CLEAR PATTERN",

        pattern:
          model?.pattern ||
          "NONE",

        matchedPattern:
          model?.matchedPattern ||
          null,

        matchedSequence:
          model?.matchedSequence ||
          null,

        patternStatus:
          model?.patternStatus ||
          "NO USABLE PATTERN",

        conflict:
          model?.conflict ||
          false,

        reason:
          model?.reason ||
          "Waiting for a usable chart pattern.",

        historical:
          model?.historical ||
          null,

        selectedMatch:
          model?.selectedMatch ||
          null,

        strongestMatches:
          model?.strongestMatches ||
          [],

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
        Direct compatibility field.
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
        model.prediction
          ?.prediction ||
        null,

      confidence:
        model.prediction
          ?.confidence ||
        0,

      confidenceLevel:
        model.prediction
          ?.confidenceLevel ||
        "LOW",

      pattern:
        model.prediction
          ?.pattern ||
        "NONE",

      matchedPattern:
        model.prediction
          ?.matchedPattern ||
        null,

      matchedSequence:
        model.prediction
          ?.matchedSequence ||
        null,

      classification:
        model.prediction
          ?.classification ||
        "NO CLEAR PATTERN",

      patternStatus:
        model.prediction
          ?.patternStatus ||
        "NO USABLE PATTERN",

      conflict:
        model.prediction
          ?.conflict ||
        false,

      reason:
        model.prediction
          ?.reason ||
        "",

      historical:
        model.prediction
          ?.historical ||
        null,

      analysis:
        model.prediction
          ?.analysis ||
        null

    }
  );

}


// ============================================================
// ADMIN KEY LIST
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
// RESET DEVICE
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
        providerState.history.length,

      patternEngine:
        "25 RULE CHART MATCH"

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
      // MP3 RANGE
      // ------------------------------------------------------

      if (
        type ===
          "audio/mpeg" &&
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
            ? Number(
                match[1]
              )
            : 0;


        let end =
          match[2]
            ? Number(
                match[2]
              )
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

          adminPing(
            res
          );

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
        // KEYS GET
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
        // KEYS CREATE
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
        // KEYS DELETE
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
          "========================================"
        );

        console.log(
          `DY AI WINGO running on ${PORT}`
        );

        console.log(
          `MODEL: ${MODEL_VERSION}`
        );

        console.log(
          "ENGINE: 25 RULE CHART PATTERN"
        );

        console.log(
          "A = SMALL (0-4)"
        );

        console.log(
          "B = BIG (5-9)"
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
