"use strict";

/*
============================================================
DY AI WINGO
ADAPTIVE CHART PATTERN ENGINE V4
============================================================

A = SMALL = 0,1,2,3,4
B = BIG   = 5,6,7,8,9

IMPORTANT:

Prediction is generated ONLY when a usable chart pattern
matches the latest historical sequence.

NO:
- frequency-only prediction
- momentum-only prediction
- random prediction
- forced alternation
- forced BIG
- forced SMALL

If no usable pattern matches:
prediction = null

This is historical pattern analysis only.
It does not guarantee future outcomes.
============================================================
*/


// ============================================================
// MODULES
// ============================================================

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
  "DY-AI-ADAPTIVE-CHART-V4";

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

  pool =
    new Pool({
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
      part /
      total *
      100
    ).toFixed(2)
  );

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
// NUMBER -> BIG / SMALL
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
    : "S";

}


function typeLabel(
  type
) {

  if (type === "B") {

    return "BIG";

  }

  if (type === "S") {

    return "SMALL";

  }

  return "UNKNOWN";

}


// ============================================================
// NUMBER -> A/B
// ============================================================

function numberToAB(
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

  /*
    A = SMALL
    B = BIG
  */

  return n <= 4
    ? "A"
    : "B";

}


function abToPrediction(
  value
) {

  if (value === "A") {

    return "SMALL";

  }

  if (value === "B") {

    return "BIG";

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
      BigInt(
        String(a)
      );

    const bb =
      BigInt(
        String(b)
      );

    if (
      aa > bb
    ) {

      return 1;

    }

    if (
      aa < bb
    ) {

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
                    JSON.parse(
                      body
                    )
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
// REFRESH PROVIDER
// ============================================================

async function refreshProvider() {

  if (
    refreshInProgress
  ) {

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
          ? String(
              currentIssue
            )
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
// PATTERN CLEANER
// ============================================================

function cleanPattern(
  pattern
) {

  return String(
    pattern || ""
  )
    .replace(
      /[^AB]/g,
      ""
    );

}


// ============================================================
// ADD PATTERN HELPER
// ============================================================

function addPattern(
  list,
  name,
  pattern,
  family,
  priority
) {

  pattern =
    cleanPattern(
      pattern
    );

  if (
    pattern.length < 4
  ) {

    return;

  }

  list.push({

    name,

    pattern,

    family,

    priority:
      Number(
        priority || 1
      )

  });

}


// ============================================================
// RUN LENGTH -> PATTERN
// ============================================================

function makeRunPattern(
  start,
  lengths
) {

  let side =
    start;

  let output = "";

  for (
    const length of
      lengths
  ) {

    output +=
      side.repeat(
        length
      );

    side =
      side === "A"
        ? "B"
        : "A";

  }

  return output;

}


// ============================================================
// ADAPTIVE PATTERN LIBRARY
// ============================================================

function buildPatternLibrary() {

  const list = [];

  // ----------------------------------------------------------
  // ALTERNATION
  // ----------------------------------------------------------

  for (
    let length = 4;
    length <= 14;
    length++
  ) {

    addPattern(
      list,
      "SINGLE TREND",
      "AB".repeat(
        Math.ceil(
          length / 2
        )
      ).slice(
        0,
        length
      ),
      "ALTERNATION",
      3
    );

    addPattern(
      list,
      "SINGLE TREND",
      "BA".repeat(
        Math.ceil(
          length / 2
        )
      ).slice(
        0,
        length
      ),
      "ALTERNATION",
      3
    );

  }


  // ----------------------------------------------------------
  // DOUBLE BLOCK
  // ----------------------------------------------------------

  for (
    let repeats = 2;
    repeats <= 6;
    repeats++
  ) {

    addPattern(
      list,
      "DOUBLE TREND",
      "AABB".repeat(
        repeats
      ),
      "DOUBLE",
      5
    );

    addPattern(
      list,
      "DOUBLE TREND",
      "BBAA".repeat(
        repeats
      ),
      "DOUBLE",
      5
    );

  }


  // ----------------------------------------------------------
  // TRIPLE BLOCK
  // ----------------------------------------------------------

  for (
    let repeats = 2;
    repeats <= 4;
    repeats++
  ) {

    addPattern(
      list,
      "TRIPLE TREND",
      "AAABBB".repeat(
        repeats
      ),
      "TRIPLE",
      6
    );

    addPattern(
      list,
      "TRIPLE TREND",
      "BBBAAA".repeat(
        repeats
      ),
      "TRIPLE",
      6
    );

  }


  // ----------------------------------------------------------
  // QUAD BLOCK
  // ----------------------------------------------------------

  for (
    let repeats = 2;
    repeats <= 3;
    repeats++
  ) {

    addPattern(
      list,
      "QUADRA TREND",
      "AAAABBBB".repeat(
        repeats
      ),
      "QUAD",
      7
    );

    addPattern(
      list,
      "QUADRA TREND",
      "BBBBAAAA".repeat(
        repeats
      ),
      "QUAD",
      7
    );

  }


  // ----------------------------------------------------------
  // COMMON CHART STRUCTURES
  // ----------------------------------------------------------

  const common = [

    [
      "THREE IN ONE",
      "AAABAAA"
    ],

    [
      "THREE IN ONE",
      "BBBABBB"
    ],

    [
      "THREE IN ONE",
      "AAABAAAB"
    ],

    [
      "THREE IN ONE",
      "BBBABBBA"
    ],

    [
      "TWO IN ONE",
      "AABAAB"
    ],

    [
      "TWO IN ONE",
      "BBABBA"
    ],

    [
      "TWO IN ONE",
      "AABAABAAB"
    ],

    [
      "TWO IN ONE",
      "BBABBABBA"
    ],

    [
      "THREE IN TWO",
      "AAABB"
    ],

    [
      "THREE IN TWO",
      "BBBAA"
    ],

    [
      "THREE IN TWO",
      "AAABBBAABB"
    ],

    [
      "THREE IN TWO",
      "BBBAAABBAA"
    ],

    [
      "FOUR IN ONE",
      "AAAABAAAA"
    ],

    [
      "FOUR IN ONE",
      "BBBBABBBB"
    ],

    [
      "FOUR IN TWO",
      "AAAABB"
    ],

    [
      "FOUR IN TWO",
      "BBBBAA"
    ],

    [
      "MIRROR",
      "ABBA"
    ],

    [
      "MIRROR",
      "BAAB"
    ],

    [
      "MIRROR",
      "ABBAABBA"
    ],

    [
      "MIRROR",
      "BAABBAAB"
    ],

    [
      "EXTENDED BLOCK",
      "AABBAABB"
    ],

    [
      "EXTENDED BLOCK",
      "BBAABBAA"
    ],

    [
      "EXTENDED BLOCK",
      "AAABBAAABB"
    ],

    [
      "EXTENDED BLOCK",
      "BBBAABBBAA"

    ]

  ];


  for (
    const item of common
  ) {

    addPattern(
      list,
      item[0],
      item[1],
      "CHART",
      5
    );

  }


  // ----------------------------------------------------------
  // RUN LENGTH PATTERNS
  // ----------------------------------------------------------

  const runTemplates = [

    [1, 1],

    [1, 2],

    [2, 1],

    [1, 3],

    [3, 1],

    [2, 2],

    [2, 3],

    [3, 2],

    [1, 2, 1],

    [2, 1, 2],

    [1, 2, 2],

    [2, 2, 1],

    [1, 3, 1],

    [3, 1, 3],

    [1, 2, 3],

    [3, 2, 1],

    [1, 1, 2],

    [2, 1, 1],

    [2, 2, 2],

    [3, 2, 2],

    [2, 3, 2],

    [2, 2, 3]

  ];


  for (
    const lengths of
      runTemplates
  ) {

    addPattern(
      list,
      `RUN ${lengths.join("-")}`,
      makeRunPattern(
        "A",
        lengths
      ),
      "RUN_LENGTH",
      5
    );

    addPattern(
      list,
      `RUN ${lengths.join("-")}`,
      makeRunPattern(
        "B",
        lengths
      ),
      "RUN_LENGTH",
      5
    );

  }


  // ----------------------------------------------------------
  // REPEATED MOTIFS
  // ----------------------------------------------------------

  const motifs = [

    "AB",
    "BA",

    "AA",
    "BB",

    "AAB",
    "ABB",

    "BAA",
    "BBA",

    "ABA",
    "BAB",

    "AABB",
    "BBAA",

    "ABBA",
    "BAAB",

    "AAAB",
    "BBBA",

    "AABA",
    "BBAB",

    "ABAA",
    "BABB"

  ];


  for (
    const motif of
      motifs
  ) {

    for (
      let repeat = 2;
      repeat <= 4;
      repeat++
    ) {

      addPattern(
        list,
        "REPEATED MOTIF",
        motif.repeat(
          repeat
        ),
        "REPEAT",
        4 + repeat
      );

    }

  }


  // ----------------------------------------------------------
  // REMOVE DUPLICATES
  // ----------------------------------------------------------

  const unique =
    new Map();

  for (
    const item of
      list
  ) {

    const key =
      `${item.name}|${item.pattern}`;

    if (
      !unique.has(key)
    ) {

      unique.set(
        key,
        item
      );

    }

  }

  return [
    ...unique.values()
  ];

}


const ADAPTIVE_PATTERNS =
  buildPatternLibrary();


// ============================================================
// CURRENT RUN
// ============================================================

function currentRunInfo(
  sequence
) {

  if (
    !sequence.length
  ) {

    return {

      side: null,

      length: 0

    };

  }

  const side =
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
      sequence[i] !==
      side
    ) {

      break;

    }

    length++;

  }

  return {

    side,

    length

  };

}


// ============================================================
// RUN SIGNATURE
// ============================================================

function getRuns(
  sequence
) {

  const runs = [];

  if (
    !sequence.length
  ) {

    return runs;

  }

  let side =
    sequence[0];

  let length = 1;

  for (
    let i = 1;
    i < sequence.length;
    i++
  ) {

    if (
      sequence[i] ===
      side
    ) {

      length++;

    } else {

      runs.push({

        side,

        length

      });

      side =
        sequence[i];

      length = 1;

    }

  }

  runs.push({

    side,

    length

  });

  return runs;

}


function runSignature(
  sequence
) {

  return getRuns(
    sequence
  )
    .map(
      item =>
        `${item.side}${item.length}`
    )
    .join("-");

}


// ============================================================
// CLEAN NUMBERS
// ============================================================

function cleanPatternNumbers(
  results
) {

  const clean = [];

  for (
    const item of
      Array.isArray(results)
        ? results
        : []
  ) {

    let number;

    if (
      typeof item ===
        "object" &&
      item !== null
    ) {

      number =
        Number(
          item.number ??
          item.actual_number ??
          item.value
        );

    } else {

      number =
        Number(item);

    }

    if (
      Number.isInteger(number) &&
      number >= 0 &&
      number <= 9
    ) {

      clean.push(
        number
      );

    }

  }

  return clean;

}


// ============================================================
// PREFIX/SUFFIX MATCH
// ============================================================
//
// History suffix must match pattern prefix.
//
// Example:
//
// Pattern:
// AABB AABB
//
// History ending:
// AABB
//
// Match:
// 4
//
// Next:
// A
//
// ============================================================

function prefixSuffixMatch(
  sequence,
  pattern
) {

  const max =
    Math.min(
      sequence.length,
      pattern.length - 1
    );

  let best = 0;

  for (
    let length = 1;
    length <= max;
    length++
  ) {

    const historyPart =
      sequence
        .slice(
          -length
        )
        .join("");

    const patternPart =
      pattern
        .slice(
          0,
          length
        );

    if (
      historyPart ===
      patternPart
    ) {

      best =
        length;

    }

  }

  return best;

}


// ============================================================
// DYNAMIC REPEATED BLOCK DETECTION
// ============================================================
//
// Example:
//
// ABABAB
// AABB AABB
// ABBABB
//
// If recent sequence is a repeated block,
// the engine can use the block's next
// continuation.
//
// ============================================================

function findDynamicRepeat(
  sequence
) {

  const candidates = [];

  const maxBlock =
    Math.min(
      6,
      Math.floor(
        sequence.length / 2
      )
    );

  for (
    let size = 2;
    size <= maxBlock;
    size++
  ) {

    const last =
      sequence.slice(
        -size
      );

    const previous =
      sequence.slice(
        -size * 2,
        -size
      );

    if (
      last.length !==
      size ||
      previous.length !==
      size
    ) {

      continue;

    }

    if (
      last.join("") !==
      previous.join("")
    ) {

      continue;

    }

    const block =
      last.join("");

    /*
      Need a third repetition
      or enough evidence to
      continue the block.

      We only predict the first
      element of the repeated block.
    */

    const next =
      block[0];

    candidates.push({

      name:
        "DYNAMIC REPEAT",

      pattern:
        block,

      family:
        "DYNAMIC_REPEAT",

      priority:
        7,

      matched:
        size,

      patternLength:
        size + 1,

      next,

      prediction:
        abToPrediction(
          next
        ),

      score:
        60 +
        size * 10

    });

  }

  return candidates;

}


// ============================================================
// FIND ADAPTIVE MATCHES
// ============================================================

function findAdaptiveMatches(
  sequence
) {

  const matches = [];

  for (
    const rule of
      ADAPTIVE_PATTERNS
  ) {

    const matched =
      prefixSuffixMatch(
        sequence,
        rule.pattern
      );

    /*
      Minimum 4.

      This prevents very common
      1-2 character coincidences.
    */

    if (
      matched < 4
    ) {

      continue;

    }

    /*
      Must have a next character
      available in the pattern.
    */

    if (
      matched >=
      rule.pattern.length
    ) {

      continue;

    }

    const next =
      rule.pattern[
        matched
      ];

    matches.push({

      ...rule,

      matched,

      patternLength:
        rule.pattern.length,

      next,

      prediction:
        abToPrediction(
          next
        )

    });

  }


  /*
    Dynamic repeated blocks
  */

  matches.push(
    ...findDynamicRepeat(
      sequence
    )
  );


  return matches;

}


// ============================================================
// MATCH SCORE
// ============================================================

function matchScore(
  match
) {

  /*
    Match length = most important.
  */

  let score =
    match.matched *
    15;


  /*
    Pattern complexity.
  */

  score +=
    Number(
      match.priority || 1
    ) *
    4;


  /*
    Near completion.
  */

  const remaining =
    Math.max(
      0,
      match.patternLength -
      match.matched
    );


  if (
    remaining === 1
  ) {

    score += 40;

  } else if (
    remaining === 2
  ) {

    score += 22;

  } else if (
    remaining === 3
  ) {

    score += 10;

  }


  /*
    Longer matched pattern
    receives extra weight.
  */

  if (
    match.matched >= 6
  ) {

    score += 10;

  }

  if (
    match.matched >= 8
  ) {

    score += 12;

  }

  if (
    match.matched >= 10
  ) {

    score += 15;

  }


  return score;

}


// ============================================================
// HISTORICAL SAME-PATTERN CHECK
// ============================================================

function historicalPatternCheck(
  sequence,
  pattern,
  expectedNext
) {

  const length =
    pattern.length;

  let matches = 0;

  let correct = 0;

  let wrong = 0;

  if (
    sequence.length <=
    length
  ) {

    return {

      matches: 0,

      correct: 0,

      wrong: 0,

      rate: null

    };

  }


  for (
    let i = length;
    i < sequence.length;
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
      Don't count the current
      unfinished suffix.
    */

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


  return {

    matches,

    correct,

    wrong,

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
// SELECT BEST PATTERN
// ============================================================

function selectBestPattern(
  sequence,
  matches
) {

  if (
    !matches.length
  ) {

    return {

      prediction:
        null,

      status:
        "NO PATTERN",

      confidence:
        0,

      best:
        null,

      top:
        [],

      conflict:
        false

    };

  }


  const scored =
    matches
      .map(
        item => ({

          ...item,

          score:
            matchScore(
              item
            )

        })
      )
      .sort(
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

          return (
            b.patternLength -
            a.patternLength
          );

        }
      );


  const best =
    scored[0];


  /*
    Only patterns reasonably close
    to the strongest pattern are
    considered for conflict.
  */

  const tolerance = 12;

  const top =
    scored.filter(
      item =>
        item.score >=
        best.score -
        tolerance
    );


  const sides =
    [
      ...new Set(
        top.map(
          item =>
            item.next
        )
      )
    ];


  /*
    Opposite strong evidence =
    don't make a prediction.
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

      best:
        null,

      top,

      conflict:
        true

    };

  }


  /*
    Pattern confidence.

    This is pattern-strength,
    not probability guarantee.
  */

  let confidence = 52;


  if (
    best.matched >= 5
  ) {

    confidence += 6;

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
    best.matched >= 10
  ) {

    confidence += 7;

  }


  if (
    best.patternLength -
    best.matched ===
    1
  ) {

    confidence += 8;

  }


  confidence =
    clamp(
      confidence,
      50,
      90
    );


  let level =
    "LOW";


  if (
    confidence >= 80
  ) {

    level =
      "HIGH";

  } else if (
    confidence >= 70
  ) {

    level =
      "MEDIUM";

  } else {

    level =
      "LOW";

  }


  return {

    prediction:
      abToPrediction(
        best.next
      ),

    status:
      "PATTERN MATCH",

    confidence,

    confidenceLevel:
      level,

    best,

    top,

    conflict:
      false

  };

}


// ============================================================
// MAIN PATTERN ANALYSIS
// ============================================================

function analyzePattern(
  results
) {

  const numbers =
    cleanPatternNumbers(
      results
    );


  const sequence =
    numbers.map(
      numberToAB
    )
    .filter(Boolean);


  const sequenceString =
    sequence.join("");


  if (
    sequence.length < 5
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

      nextAB:
        null,

      sequence:
        sequenceString,

      dataSize:
        sequence.length,

      matchedRules:
        [],

      strongestMatches:
        [],

      selectedMatch:
        null,

      historical: {

        matches: 0,

        correct: 0,

        wrong: 0,

        rate: null

      },

      reason:
        "At least 5 valid results are required.",

      patternCount:
        ADAPTIVE_PATTERNS.length,

      analyzedAt:
        now()

    };

  }


  // ----------------------------------------------------------
  // MATCH
  // ----------------------------------------------------------

  const matches =
    findAdaptiveMatches(
      sequence
    );


  // ----------------------------------------------------------
  // SELECT
  // ----------------------------------------------------------

  const selected =
    selectBestPattern(
      sequence,
      matches
    );


  // ----------------------------------------------------------
  // HISTORICAL VALIDATION
  // ----------------------------------------------------------

  let historical = {

    matches: 0,

    correct: 0,

    wrong: 0,

    rate: null

  };


  if (
    selected.best
  ) {

    historical =
      historicalPatternCheck(
        sequence,
        selected.best.pattern,
        selected.best.next
      );

  }


  // ----------------------------------------------------------
  // CURRENT RUN
  // ----------------------------------------------------------

  const currentRun =
    currentRunInfo(
      sequence
    );


  // ----------------------------------------------------------
  // CLASSIFICATION
  // ----------------------------------------------------------

  let classification =
    "NO CLEAR PATTERN";


  if (
    selected.status ===
    "PATTERN MATCH"
  ) {

    classification =
      "PATTERN MATCH";

  }


  if (
    selected.status ===
    "PATTERN CONFLICT"
  ) {

    classification =
      "PATTERN CONFLICT";

  }


  // ----------------------------------------------------------
  // REASON
  // ----------------------------------------------------------

  let reason =
    "No usable chart pattern matched the latest history. Prediction withheld.";


  if (
    selected.status ===
    "PATTERN CONFLICT"
  ) {

    reason =
      "Multiple strong chart patterns gave different next sides. Prediction withheld.";

  }


  if (
    selected.best
  ) {

    reason =
      `PATTERN ${selected.best.name} | ` +
      `${selected.best.pattern} | ` +
      `MATCH ${selected.best.matched}/${selected.best.patternLength} | ` +
      `NEXT ${selected.best.next}`;

    if (
      historical.matches > 0
    ) {

      reason +=
        ` | HISTORY ${historical.correct}/${historical.matches}`;

    }

  }


  // ----------------------------------------------------------
  // RETURN
  // ----------------------------------------------------------

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
      selected.best
        ? selected.best.name
        : "NONE",

    matchedPattern:
      selected.best
        ?.pattern ||
      null,

    matchedSequence:
      selected.best
        ? sequenceString.slice(
            -selected.best.matched
          )
        : null,

    nextAB:
      selected.best
        ?.next ||
      null,

    sequence:
      sequenceString,

    dataSize:
      sequence.length,

    current: {

      type:
        currentRun.side,

      label:
        currentRun.side === "A"
          ? "SMALL"
          : currentRun.side === "B"
          ? "BIG"
          : null,

      streak:
        currentRun.length

    },

    runSignature:
      runSignature(
        sequence
      ),

    patternStatus:
      selected.status,

    conflict:
      selected.conflict,

    matchedRules:
      matches
        .map(
          item => ({

            name:
              item.name,

            family:
              item.family,

            pattern:
              item.pattern,

            matched:
              item.matched,

            patternLength:
              item.patternLength,

            next:
              item.next,

            prediction:
              item.prediction,

            score:
              matchScore(
                item
              )

          })
        )
        .sort(
          (
            a,
            b
          ) =>
            b.score -
            a.score
        ),

    strongestMatches:
      selected.top,

    selectedMatch:
      selected.best,

    historical,

    reason,

    patternCount:
      ADAPTIVE_PATTERNS.length,

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
        number =>
          Number.isInteger(
            number
          ) &&
          number >= 0 &&
          number <= 9
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
        analysis.classification ||
        "NO CLEAR PATTERN",

      pattern:
        analysis.pattern ||
        "NONE",

      matchedPattern:
        analysis.matchedPattern ||
        null,

      matchedSequence:
        analysis.matchedSequence ||
        null,

      nextAB:
        analysis.nextAB ||
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


  /*
    Save ONLY when an actual
    pattern produced a prediction.
  */

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


  /*
    No pattern =
    no prediction record.
  */

  if (
    !targetIssue ||
    !analysis ||
    !analysis.prediction ||
    analysis.patternStatus !==
      "PATTERN MATCH"
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
      providerState.history
        .slice(
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
        )
          .toUpperCase();


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
// ACCESS KEY
// ============================================================

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


// ============================================================
// VALIDATE ACCESS
// ============================================================

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
    row.device_id !==
      device
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

function requireAdmin(
  req
) {

  return (
    ADMIN_KEY &&
    getAdminKey(
      req
    ) === ADMIN_KEY
  );

}


// ============================================================
// PREDICTION HISTORY MAP
// ============================================================

async function getPredictionRecords() {

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
        confidence,
        model_version,
        actual_number,
        actual_result,
        created_at,
        settled_at
      FROM prediction_records
      ORDER BY created_at DESC
      LIMIT 200
      `
    );


  return result.rows;

}


// ============================================================
// MERGED LIVE HISTORY
// ============================================================

async function buildLiveHistory() {

  const provider =
    providerState.history
      .slice(
        0,
        30
      );


  let records = [];

  try {

    records =
      await getPredictionRecords();

  } catch {

    records = [];

  }


  const recordMap =
    new Map();


  for (
    const record of
      records
  ) {

    const issue =
      String(
        record.target_issue
      );


    if (
      !recordMap.has(
        issue
      )
    ) {

      recordMap.set(
        issue,
        record
      );

    }

  }


  return provider.map(
    row => {

      const number =
        Number(
          row.number
        );


      const type =
        numberToType(
          number
        );


      const record =
        recordMap.get(
          String(
            row.issueNumber
          )
        );


      let result =
        "PENDING";


      if (
        record?.actual_result
      ) {

        result =
          String(
            record.actual_result
          )
            .toUpperCase();

      }


      return {

        issue:
          String(
            row.issueNumber
          ),

        issueNumber:
          String(
            row.issueNumber
          ),

        number,

        type,

        label:
          typeLabel(
            type
          ),

        prediction:
          record?.prediction ||
          null,

        confidence:
          record?.confidence ||
          0,

        actualResult:
          result,

        result,

        modelVersion:
          record?.model_version ||
          null,

        createdAt:
          record?.created_at ||
          null,

        settledAt:
          record?.settled_at ||
          null

      };

    }
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
    Generate model when target changes.
  */

  if (
    !modelCache.prediction ||
    modelCache.targetIssue !==
      targetIssue
  ) {

    await generateModel();

  }


  const liveHistory =
    await buildLiveHistory();


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


      /*
        Main model.
      */

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

        nextAB:
          model?.nextAB ||
          null,

        reason:
          model?.reason ||
          "No usable pattern matched.",

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


      /*
        Provider.
      */

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


      /*
        LAST 30
      */

      history:
        liveHistory

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

      patternCount:
        ADAPTIVE_PATTERNS.length,

      thinkingDurationMs:
        THINKING_DURATION_MS,

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
        MODEL_VERSION,

      patternCount:
        ADAPTIVE_PATTERNS.length

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

      reason:
        model.prediction
          ?.reason ||
        "",

      patternCount:
        ADAPTIVE_PATTERNS.length,

      analysis:
        model.prediction
          ?.analysis ||
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
    await readBody(
      req
    );


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
    await readBody(
      req
    );


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
    await readBody(
      req
    );


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

      patternCount:
        ADAPTIVE_PATTERNS.length,

      thinkingDurationMs:
        THINKING_DURATION_MS,

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
        ).pipe(
          res
        );


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
      ).pipe(
        res
      );

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

          health(
            res
          );

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


    /*
      New issue =
      generate new pattern analysis.
    */

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
          "DY AI WINGO STARTED"
        );

        console.log(
          "========================================"
        );

        console.log(
          `PORT: ${PORT}`
        );

        console.log(
          `MODEL: ${MODEL_VERSION}`
        );

        console.log(
          `PATTERNS: ${ADAPTIVE_PATTERNS.length}`
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
            "NO PATTERN"
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
