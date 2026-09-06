"use strict";

/*
============================================================
              DY AI WINGO - SERVER
          OPPOSITE CHART PATTERN ENGINE
============================================================

A = SMALL  (0-4)
B = BIG    (5-9)

IMPORTANT:

Prediction ONLY when a meaningful chart pattern matches.

No:
- Random prediction
- Frequency-only prediction
- Momentum-only prediction
- Forced alternation
- "BIG ke baad SMALL"
- "SMALL ke baad BIG"

25 chart rules are included.

Every rule automatically gets an OPPOSITE version:

A -> B
B -> A

Example:

AABBAABB
      ↓
BBAABBAA

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
  String(process.env.ADMIN_KEY || "").trim();

const WINGOBOT_TOKEN =
  String(process.env.WINGOBOT_TOKEN || "").trim();

const DATABASE_URL =
  String(process.env.DATABASE_URL || "").trim();

const WINGOBOT_API =
  "https://api.wingobot.com/v2/30-sec-game-history";

const MODEL_VERSION =
  "DY-AI-OPPOSITE-CHART-V4";

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
    connectionString: DATABASE_URL,

    ssl:
      DATABASE_URL.includes("localhost")
        ? false
        : {
            rejectUnauthorized: false
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
// BASIC HELPERS
// ============================================================

function now() {
  return Date.now();
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

  return n >= 5 ? "B" : "S";
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


function randomKey() {

  return (
    "DY-" +
    crypto
      .randomBytes(12)
      .toString("hex")
      .toUpperCase()
  );

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
// WINGOBOT API
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
                  response.statusCode < 200 ||
                  response.statusCode >= 300
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


    const n = Number(number);


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

function providerCurrentIssue(payload) {

  return (

    payload?.current?.issueNumber

    ??

    payload?.currentIssue

    ??

    payload?.current?.issue

    ??

    payload?.current?.period

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


  refreshInProgress = true;


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
// ============================================================
//              25 CHART RULES
// ============================================================
// ============================================================

const BASE_RULES = [

  { id: 1, pattern: "ABABABABAB" },

  { id: 2, pattern: "AABBAABB" },

  { id: 3, pattern: "AAABBBAAABBB" },

  { id: 4, pattern: "AAAABBBBAAAABBBB" },

  { id: 5, pattern: "AABAABAAB" },

  { id: 6, pattern: "AAAAAAAABBBBBBBB" },

  { id: 7, pattern: "ABBABBABB" },

  { id: 8, pattern: "AAABAAABAAAB" },

  { id: 9, pattern: "AAABBAAABB" },

  { id: 10, pattern: "AAAABBABBBAAAA" },

  { id: 11, pattern: "ABBBABBBABBB" },

  { id: 12, pattern: "ABABBABBB" },

  { id: 13, pattern: "AABBAAABBBAAAABBBB" },

  { id: 14, pattern: "ABBAAABBBB" },

  { id: 15, pattern: "AAAABBBAAB" },

  { id: 16, pattern: "ABAABBAAABBB" },

  { id: 17, pattern: "AABBBABBBBAA" },

  { id: 18, pattern: "ABBAAAABBBBBBBB" },

  { id: 19, pattern: "ABBBABBB" },

  { id: 20, pattern: "AABBBAABBB" },

  { id: 21, pattern: "ABAABAAAB" },

  { id: 22, pattern: "AABAABBAABBB" },

  { id: 23, pattern: "AAAABAAAAB" },

  { id: 24, pattern: "AAAABBAAAABB" },

  { id: 25, pattern: "AAAABBBAAAABBB" }

];


// ============================================================
// OPPOSITE PATTERN
// ============================================================

function invertPattern(pattern) {

  return String(pattern)
    .split("")
    .map(ch => {

      if (ch === "A") {
        return "B";
      }

      if (ch === "B") {
        return "A";
      }

      return "";

    })
    .join("");

}


// ============================================================
// BUILD ORIGINAL + OPPOSITE
// ============================================================

const RULES = [];


for (
  const base of BASE_RULES
) {

  const original =
    String(base.pattern)
      .replace(/[^AB]/g, "");


  if (!original) {
    continue;
  }


  RULES.push({

    id:
      base.id,

    variant:
      "ORIGINAL",

    pattern:
      original

  });


  const opposite =
    invertPattern(
      original
    );


  if (
    opposite !==
    original
  ) {

    RULES.push({

      id:
        base.id,

      variant:
        "OPPOSITE",

      pattern:
        opposite

    });

  }

}


// ============================================================
// NUMBER -> A/B
// ============================================================

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


  /*
    0-4 = A = SMALL
    5-9 = B = BIG
  */

  return n <= 4
    ? "A"
    : "B";

}


// ============================================================
// HISTORY -> A/B
// ============================================================

function convertHistory(results) {

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


    const ab =
      numberToAB(n);


    if (ab !== null) {

      output.push(ab);

    }

  }


  return output;

}


// ============================================================
// MATCH QUALITY
// ============================================================

function matchQuality(
  matched,
  patternLength
) {

  /*
    1-2 characters:
    NO PREDICTION

    3:
    weak candidate

    4:
    moderate

    5:
    good

    6+:
    strong
  */

  if (
    matched < 3
  ) {

    return {

      valid: false,

      weight: 0,

      level:
        "TOO_SHORT"

    };

  }


  const ratio =
    matched /
    patternLength;


  if (
    matched >= 8 &&
    ratio >= 0.70
  ) {

    return {

      valid: true,

      weight: 10,

      level:
        "VERY_STRONG"

    };

  }


  if (
    matched >= 6 &&
    ratio >= 0.60
  ) {

    return {

      valid: true,

      weight: 8,

      level:
        "STRONG"

    };

  }


  if (
    matched >= 5 &&
    ratio >= 0.55
  ) {

    return {

      valid: true,

      weight: 6,

      level:
        "GOOD"

    };

  }


  if (
    matched >= 4 &&
    ratio >= 0.50
  ) {

    return {

      valid: true,

      weight: 4,

      level:
        "MODERATE"

    };

  }


  if (
    matched >= 3 &&
    ratio >= 0.40
  ) {

    return {

      valid: true,

      weight: 2,

      level:
        "WEAK"

    };

  }


  return {

    valid: false,

    weight: 0,

    level:
      "LOW"

  };

}


// ============================================================
// FIND BEST SUFFIX MATCH
// ============================================================

function findBestMatch(
  history,
  rule
) {

  const historyString =
    history.join("");


  const pattern =
    rule.pattern;


  /*
    Pattern ke START ko
    current history ke END se
    compare karte hain.
  */

  const max =
    Math.min(
      historyString.length,
      pattern.length - 1
    );


  let best = null;


  for (
    let len = max;
    len >= 3;
    len--
  ) {

    const historyPart =
      historyString.slice(
        -len
      );


    const patternPart =
      pattern.slice(
        0,
        len
      );


    if (
      historyPart ===
      patternPart
    ) {

      const next =
        pattern[len];


      if (!next) {
        continue;
      }


      const quality =
        matchQuality(
          len,
          pattern.length
        );


      if (!quality.valid) {
        continue;
      }


      best = {

        rule:
          rule.id,

        variant:
          rule.variant,

        pattern:
          pattern,

        matched:
          len,

        next:
          next,

        weight:
          quality.weight,

        level:
          quality.level

      };


      break;

    }

  }


  return best;

}


// ============================================================
// FIND PATTERN CANDIDATES
// ============================================================

function findPatternCandidates(
  history
) {

  const candidates = [];


  for (
    const rule of
      RULES
  ) {

    const match =
      findBestMatch(
        history,
        rule
      );


    if (match) {

      candidates.push(
        match
      );

    }

  }


  return candidates;

}


// ============================================================
// REMOVE DUPLICATES
// ============================================================

function uniqueCandidates(
  candidates
) {

  const map =
    new Map();


  for (
    const candidate of
      candidates
  ) {

    const key =
      [
        candidate.pattern,
        candidate.next
      ].join("|");


    const old =
      map.get(key);


    if (
      !old ||
      candidate.weight >
        old.weight ||
      (
        candidate.weight ===
          old.weight &&
        candidate.matched >
          old.matched
      )
    ) {

      map.set(
        key,
        candidate
      );

    }

  }


  return Array.from(
    map.values()
  );

}


// ============================================================
// PATTERN SUPPORT
// ============================================================

function calculatePatternSupport(
  candidates
) {

  let A = 0;
  let B = 0;


  const evidence = [];


  for (
    const candidate of
      candidates
  ) {

    const weight =
      candidate.weight;


    if (
      candidate.next ===
      "A"
    ) {

      A += weight;

    }


    if (
      candidate.next ===
      "B"
    ) {

      B += weight;

    }


    evidence.push({

      rule:
        candidate.rule,

      variant:
        candidate.variant,

      pattern:
        candidate.pattern,

      matched:
        candidate.matched,

      patternLength:
        candidate.pattern.length,

      expectedNext:
        candidate.next,

      weight:
        weight,

      level:
        candidate.level

    });

  }


  const total =
    A + B;


  const APercent =
    total
      ? Number(
          (
            A /
            total *
            100
          ).toFixed(2)
        )
      : 0;


  const BPercent =
    total
      ? Number(
          (
            B /
            total *
            100
          ).toFixed(2)
        )
      : 0;


  return {

    A,

    B,

    total,

    APercent,

    BPercent,

    evidence

  };

}


// ============================================================
// CONFLICT CHECK
// ============================================================

function detectConflict(
  support
) {

  if (
    support.A === 0 &&
    support.B === 0
  ) {

    return true;

  }


  if (
    support.A ===
    support.B
  ) {

    return true;

  }


  const total =
    support.A +
    support.B;


  if (!total) {
    return true;
  }


  const difference =
    Math.abs(
      support.A -
      support.B
    );


  /*
    Difference less than 20%
    means evidence is too close.
  */

  if (
    difference /
      total <
    0.20
  ) {

    return true;

  }


  return false;

}


// ============================================================
// DECISION
// ============================================================

function decidePattern(
  history,
  candidates,
  support
) {

  if (
    !candidates.length
  ) {

    return {

      prediction:
        null,

      confidence:
        0,

      classification:
        "NO PATTERN",

      reason:
        "No meaningful chart pattern matched.",

      selected:
        null

    };

  }


  if (
    detectConflict(
      support
    )
  ) {

    return {

      prediction:
        null,

      confidence:
        0,

      classification:
        "PATTERN CONFLICT",

      reason:
        "Matched chart patterns are conflicting.",

      selected:
        null

    };

  }


  let side;


  if (
    support.A >
    support.B
  ) {

    side = "A";

  } else {

    side = "B";

  }


  /*
    Select strongest matching
    candidate from winning side.
  */

  const sideCandidates =
    candidates
      .filter(
        candidate =>
          candidate.next ===
          side
      )
      .sort(
        (a, b) => {

          if (
            b.weight !==
            a.weight
          ) {

            return (
              b.weight -
              a.weight
            );

          }


          return (
            b.matched -
            a.matched
          );

        }
      );


  const selected =
    sideCandidates[0];


  if (!selected) {

    return {

      prediction:
        null,

      confidence:
        0,

      classification:
        "NO PATTERN",

      reason:
        "No consistent next side.",

      selected:
        null

    };

  }


  const total =
    support.A +
    support.B;


  const sideSupport =
    side === "A"
      ? support.A
      : support.B;


  let confidence =
    total
      ? (
          sideSupport /
          total *
          100
        )
      : 0;


  /*
    Match strength bonus.
  */

  if (
    selected.matched >= 8
  ) {

    confidence += 5;

  }
  else if (
    selected.matched >= 6
  ) {

    confidence += 3;

  }


  confidence =
    Math.min(
      95,
      Math.round(
        confidence
      )
    );


  /*
    Weak chart match:
    NO prediction.
  */

  if (
    confidence < 60
  ) {

    return {

      prediction:
        null,

      confidence,

      classification:
        "WEAK PATTERN",

      reason:
        "Pattern matched but evidence is not strong enough.",

      selected

    };

  }


  const prediction =
    selected.next === "A"
      ? "SMALL"
      : "BIG";


  let classification =
    "PATTERN MATCH";


  if (
    selected.matched >= 8 &&
    confidence >= 80
  ) {

    classification =
      "STRONG PATTERN MATCH";

  }
  else if (
    selected.matched >= 6
  ) {

    classification =
      "GOOD PATTERN MATCH";

  }


  return {

    prediction,

    confidence,

    classification,

    reason:
      `RULE ${selected.rule} ` +
      `${selected.variant} | ` +
      `${selected.pattern} | ` +
      `${selected.matched}/${selected.pattern.length} ` +
      `matched | NEXT ${prediction}`,

    selected

  };

}


// ============================================================
// MAIN PATTERN ENGINE
// ============================================================

function humanBigSmallLogic(
  results
) {

  const history =
    convertHistory(
      results
    );


  const sequence =
    history.join("");


  const dataSize =
    history.length;


  /*
    Need enough history.
  */

  if (
    dataSize < 10
  ) {

    return {

      status:
        "INSUFFICIENT DATA",

      prediction:
        null,

      confidence:
        0,

      confidenceLevel:
        "LOW",

      classification:
        "INSUFFICIENT DATA",

      pattern:
        "NONE",

      matchedPattern:
        null,

      matchedSequence:
        null,

      sequence,

      dataSize,

      matchedRules:
        [],

      support: {

        A: 0,

        B: 0,

        APercent: 0,

        BPercent: 0

      },

      reason:
        "At least 10 valid results are preferred.",

      engine:
        "DY-AI-OPPOSITE-CHART-V4",

      rulesCount:
        RULES.length,

      analyzedAt:
        now()

    };

  }


  /*
    Find ORIGINAL + OPPOSITE.
  */

  let candidates =
    findPatternCandidates(
      history
    );


  candidates =
    uniqueCandidates(
      candidates
    );


  /*
    Calculate pattern support.
  */

  const support =
    calculatePatternSupport(
      candidates
    );


  /*
    Decide.
  */

  const decision =
    decidePattern(
      history,
      candidates,
      support
    );


  const selected =
    decision.selected;


  return {

    status:
      "OK",

    prediction:
      decision.prediction,

    confidence:
      decision.confidence,

    confidenceLevel:
      decision.confidence >= 80
        ? "HIGH"
        : decision.confidence >= 70
        ? "MEDIUM"
        : decision.confidence >= 60
        ? "LOW-MEDIUM"
        : "LOW",

    classification:
      decision.classification,

    pattern:
      selected
        ? `RULE ${selected.rule}`
        : "NONE",

    matchedPattern:
      selected
        ? selected.variant
        : null,

    matchedSequence:
      selected
        ? selected.pattern
        : null,

    sequence,

    dataSize,

    current:
      history[dataSize - 1] ||
      null,

    matchedRules:
      candidates,

    support: {

      A:
        support.A,

      B:
        support.B,

      APercent:
        support.APercent,

      BPercent:
        support.BPercent

    },

    reason:
      decision.reason,

    engine:
      "DY-AI-OPPOSITE-CHART-V4",

    rulesCount:
      RULES.length,

    originalRules:
      BASE_RULES.length,

    oppositePatterns:
      true,

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


  /*
    If current issue is ahead
    of latest settled result,
    use current.
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
    Otherwise:
    latest + 1
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
    Provider:
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
          analysis.confidence ||
          0
        ),

      confidenceLevel:
        analysis.confidenceLevel ||
        "LOW",

      classification:
        analysis.classification ||
        "NO PATTERN",

      pattern:
        analysis.pattern ||
        "NONE",

      matchedPattern:
        analysis.matchedPattern ||
        null,

      matchedSequence:
        analysis.matchedSequence ||
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

  /*
    IMPORTANT:
    No pattern = no prediction record.
  */

  if (
    !pool ||
    !targetIssue ||
    !analysis?.prediction
  ) {

    return;

  }


  try {

    /*
      Prevent duplicate.
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
// ACCESS KEY
// ============================================================

function getAccessKey(req) {

  return String(
    req.headers["x-access-key"] ||
    ""
  ).trim();

}


function getDeviceId(req) {

  return String(
    req.headers["x-device-id"] ||
    ""
  ).trim();

}


function getAdminKey(req) {

  return String(
    req.headers["x-admin-key"] ||
    ""
  ).trim();

}


// ============================================================
// VALIDATE ACCESS
// ============================================================

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


  /*
    One key = one browser.
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
    Generate model only when target
    changes or cache is missing.
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

  const providerHistory =
    providerState.history
      .slice(0, 30)
      .map(row => {

        const number =
          Number(row.number);


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

      });


  /*
    Get prediction records so
    UI can show WIN/LOSS.
  */

  let predictionRecords = [];


  if (pool) {

    try {

      const dbResult =
        await pool.query(
          `
          SELECT
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


      predictionRecords =
        dbResult.rows;

    } catch (error) {

      console.error(
        "[DB] history:",
        error.message
      );

    }

  }


  const predictionMap =
    new Map();


  for (
    const record of
      predictionRecords
  ) {

    predictionMap.set(
      String(
        record.target_issue
      ),
      record
    );

  }


  /*
    Merge provider + prediction.
  */

  const history =
    providerHistory.map(
      row => {

        const record =
          predictionMap.get(
            String(
              row.issueNumber
            )
          );


        let prediction =
          null;

        let result =
          "PENDING";


        let confidence =
          null;


        if (record) {

          prediction =
            String(
              record.prediction ||
              ""
            ).toUpperCase();


          confidence =
            Number(
              record.confidence ||
              0
            );


          if (
            record.actual_result
          ) {

            result =
              String(
                record.actual_result
              ).toUpperCase();

          }

        }


        return {

          ...row,

          prediction,

          ai:
            prediction,

          confidence,

          result,

          actualResult:
            result,

          modelVersion:
            record?.model_version ||
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
          "LOW",

        classification:
          model?.classification ||
          "NO PATTERN",

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
// PREDICTION HISTORY API
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

      engine:
        "25 RULE + OPPOSITE PATTERN ENGINE",

      rules:
        BASE_RULES.length,

      totalPatterns:
        RULES.length,

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

      confidenceLevel:
        model.prediction?.confidenceLevel ||
        "LOW",

      classification:
        model.prediction?.classification ||
        "NO PATTERN",

      pattern:
        model.prediction?.pattern ||
        "NONE",

      matchedPattern:
        model.prediction?.matchedPattern ||
        null,

      matchedSequence:
        model.prediction?.matchedSequence ||
        null,

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

      engine:
        "25 RULE + OPPOSITE PATTERN",

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
          `BASE RULES: ${BASE_RULES.length}`
        );


        console.log(
          `TOTAL PATTERNS: ${RULES.length}`
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
          `MATCH: ${
            modelCache.prediction
              ?.matchedPattern ||
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
