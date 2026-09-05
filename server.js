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

const PORT = Number(process.env.PORT || 10000);

const ADMIN_KEY =
  String(process.env.ADMIN_KEY || "").trim();

const WINGOBOT_TOKEN =
  String(process.env.WINGOBOT_TOKEN || "").trim();

const DATABASE_URL =
  String(process.env.DATABASE_URL || "").trim();

const WINGOBOT_API =
  "https://api.wingobot.com/v2/30-sec-game-history";

const MODEL_VERSION =
  "DY-AI-HUMAN-LOGIC-V2";

const THINKING_DURATION_MS = 3000;

const PROVIDER_REFRESH_MS = 3000;

const REQUEST_TIMEOUT_MS = 12000;

let pool = null;

if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes("localhost")
      ? false
      : { rejectUnauthorized: false }
  });
}

// ============================================================
// DATABASE
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
// STATE
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

function clamp(value, min, max) {
  return Math.max(
    min,
    Math.min(max, value)
  );
}

function average(arr) {
  if (!arr.length) return 0;

  return (
    arr.reduce(
      (a, b) => a + b,
      0
    ) / arr.length
  );
}

function median(arr) {
  if (!arr.length) return 0;

  const a = [...arr].sort(
    (x, y) => x - y
  );

  const mid =
    Math.floor(a.length / 2);

  if (a.length % 2) {
    return a[mid];
  }

  return (
    a[mid - 1] + a[mid]
  ) / 2;
}

function percentage(part, total) {
  if (!total) return 0;

  return Number(
    ((part / total) * 100).toFixed(2)
  );
}

function standardDeviation(arr) {
  if (!arr.length) return 0;

  const avg = average(arr);

  const variance =
    arr.reduce(
      (sum, value) =>
        sum +
        Math.pow(
          value - avg,
          2
        ),
      0
    ) / arr.length;

  return Math.sqrt(variance);
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

function numberToType(n) {
  const value = Number(n);

  if (
    !Number.isInteger(value) ||
    value < 0 ||
    value > 9
  ) {
    return null;
  }

  return value >= 5
    ? "B"
    : "S";
}

function typeLabel(type) {
  if (type === "B") return "BIG";
  if (type === "S") return "SMALL";

  return "UNKNOWN";
}

function incrementIssue(issue) {
  if (
    issue === null ||
    issue === undefined
  ) {
    return null;
  }

  const s = String(issue);

  if (!/^\d+$/.test(s)) {
    return null;
  }

  return (
    BigInt(s) + 1n
  ).toString().padStart(
    s.length,
    "0"
  );
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
// RESPONSE
// ============================================================

function json(res, status, data) {
  const body =
    JSON.stringify(data);

  res.writeHead(status, {
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
  });

  res.end(body);
}

function text(
  res,
  status,
  body,
  type = "text/plain"
) {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store"
  });

  res.end(body);
}

// ============================================================
// BODY
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
                "DY-AI-Wingo/2.0"
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

  for (const item of raw) {
    const issue =
      item?.issueNumber ??
      item?.issue ??
      item?.period;

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

function providerCurrentIssue(
  payload
) {
  return (
    payload?.current
      ?.issueNumber ??
    payload?.currentIssue ??
    payload?.current?.issue ??
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
// HUMAN LOGIC ENGINE
// ============================================================

function humanBigSmallLogic(
  results
) {

  // ----------------------------------------------------------
  // 1. CLEAN DATA
  // ----------------------------------------------------------

  const clean = [];

  for (const value of Array.isArray(results)
    ? results
    : []) {

    const stringValue =
      String(value).trim();

    if (
      /^\d$/.test(
        stringValue
      )
    ) {
      const n =
        Number(stringValue);

      if (
        Number.isInteger(n) &&
        n >= 0 &&
        n <= 9
      ) {
        clean.push(n);
      }
    }
  }

  if (clean.length < 10) {
    return {
      status:
        "INSUFFICIENT DATA",

      message:
        "At least 10 results are required.",

      prediction: null,

      confidence:
        "VERY LOW"
    };
  }

  // ----------------------------------------------------------
  // 2. NUMBER → B/S
  // ----------------------------------------------------------

  const seq =
    clean.map(
      x =>
        x >= 5
          ? "B"
          : "S"
    );

  // ----------------------------------------------------------
  // 3. BASIC COUNTS
  // ----------------------------------------------------------

  const big =
    seq.filter(
      x => x === "B"
    ).length;

  const small =
    seq.length - big;

  const total =
    seq.length;

  const bigPct =
    percentage(
      big,
      total
    );

  const smallPct =
    percentage(
      small,
      total
    );

  // ----------------------------------------------------------
  // 4. CURRENT STREAK
  // ----------------------------------------------------------

  const current =
    seq[seq.length - 1];

  let streak = 1;

  for (
    let i =
      seq.length - 2;
    i >= 0;
    i--
  ) {
    if (
      seq[i] === current
    ) {
      streak++;
    } else {
      break;
    }
  }

  // ----------------------------------------------------------
  // 5. RUNS
  // ----------------------------------------------------------

  const runs = [];

  let runType =
    seq[0];

  let runLength = 1;

  for (
    let i = 1;
    i < seq.length;
    i++
  ) {
    if (
      seq[i] === runType
    ) {
      runLength++;
    } else {
      runs.push({
        type: runType,
        length: runLength
      });

      runType =
        seq[i];

      runLength = 1;
    }
  }

  runs.push({
    type: runType,
    length: runLength
  });

  const bigRuns =
    runs
      .filter(
        x => x.type === "B"
      )
      .map(
        x => x.length
      );

  const smallRuns =
    runs
      .filter(
        x => x.type === "S"
      )
      .map(
        x => x.length
      );

  const longestBig =
    Math.max(
      ...bigRuns,
      0
    );

  const longestSmall =
    Math.max(
      ...smallRuns,
      0
    );

  // ----------------------------------------------------------
  // 6. SWITCHING
  // ----------------------------------------------------------

  let switches = 0;

  for (
    let i = 1;
    i < seq.length;
    i++
  ) {
    if (
      seq[i] !==
      seq[i - 1]
    ) {
      switches++;
    }
  }

  const switchRate =
    percentage(
      switches,
      Math.max(
        1,
        seq.length - 1
      )
    );

  // ----------------------------------------------------------
  // 7. WINDOWS
  // ----------------------------------------------------------

  function windowStats(n) {

    const data =
      seq.slice(
        -Math.min(
          n,
          seq.length
        )
      );

    const b =
      data.filter(
        x => x === "B"
      ).length;

    const s =
      data.length - b;

    return {
      length:
        data.length,

      B: b,

      S: s,

      B_percent:
        percentage(
          b,
          data.length
        ),

      S_percent:
        percentage(
          s,
          data.length
        )
    };
  }

  const w5 =
    windowStats(5);

  const w10 =
    windowStats(10);

  const w20 =
    windowStats(20);

  const w30 =
    windowStats(30);

  const w50 =
    windowStats(50);

  const w100 =
    windowStats(100);

  // ----------------------------------------------------------
  // 8. MOMENTUM
  // ----------------------------------------------------------

  let momentum =
    "NEUTRAL";

  let momentumValue = 0;

  if (
    seq.length >= 20
  ) {
    const previous =
      seq.slice(
        -20,
        -10
      );

    const recent =
      seq.slice(-10);

    const previousBig =
      previous.filter(
        x => x === "B"
      ).length /
      10 *
      100;

    const recentBig =
      recent.filter(
        x => x === "B"
      ).length /
      10 *
      100;

    momentumValue =
      Number(
        (
          recentBig -
          previousBig
        ).toFixed(2)
      );

    if (
      momentumValue >= 20
    ) {
      momentum =
        "BIG MOMENTUM";
    } else if (
      momentumValue <= -20
    ) {
      momentum =
        "SMALL MOMENTUM";
    }
  }

  // ----------------------------------------------------------
  // 9. ALTERNATION
  // ----------------------------------------------------------

  let alternationLength =
    1;

  for (
    let i =
      seq.length - 1;
    i > 0;
    i--
  ) {
    if (
      seq[i] !==
      seq[i - 1]
    ) {
      alternationLength++;
    } else {
      break;
    }
  }

  const alternating =
    alternationLength >= 4;

  // ----------------------------------------------------------
  // 10. REPEATING BLOCK
  // ----------------------------------------------------------

  let repeatingBlock =
    null;

  for (
    let size = 2;
    size <=
      Math.min(
        6,
        Math.floor(
          seq.length / 2
        )
      );
    size++
  ) {

    const a =
      seq.slice(
        -size * 2,
        -size
      );

    const b =
      seq.slice(-size);

    if (
      a.length === size &&
      b.length === size &&
      a.join("") ===
        b.join("")
    ) {
      repeatingBlock =
        b.join("");

      break;
    }
  }

  // ----------------------------------------------------------
  // 11. STREAK REVERSAL
  // ----------------------------------------------------------

  let reversalScore = 0;

  const reversalReasons = [];

  if (
    current === "B" &&
    streak >= 4 &&
    streak >= longestBig
  ) {
    reversalScore += 2;

    reversalReasons.push(
      "LONG_BIG_STREAK"
    );
  }

  if (
    current === "S" &&
    streak >= 4 &&
    streak >= longestSmall
  ) {
    reversalScore += 2;

    reversalReasons.push(
      "LONG_SMALL_STREAK"
    );
  }

  if (
    w10.B_percent >= 70
  ) {
    reversalScore++;

    reversalReasons.push(
      "RECENT_BIG_IMBALANCE"
    );
  }

  if (
    w10.S_percent >= 70
  ) {
    reversalScore++;

    reversalReasons.push(
      "RECENT_SMALL_IMBALANCE"
    );
  }

  // ----------------------------------------------------------
  // 12. PATTERN BREAK
  // ----------------------------------------------------------

  let patternBreak =
    false;

  if (
    seq.length >= 6
  ) {
    const last6 =
      seq.slice(-6);

    if (
      last6[0] !== last6[1] &&
      last6[1] !== last6[2] &&
      last6[2] !== last6[3] &&
      last6[3] !== last6[4] &&
      last6[4] === last6[5]
    ) {
      patternBreak = true;

      reversalScore++;

      reversalReasons.push(
        "ALTERNATION_BREAK"
      );
    }
  }

  // ----------------------------------------------------------
  // 13. FAILED REVERSAL
  // ----------------------------------------------------------

  let failedReversal =
    false;

  let failedReversalCount = 0;

  let successfulBreaks = 0;

  for (
    let i = 2;
    i < seq.length;
    i++
  ) {

    const a =
      seq[i - 2];

    const b =
      seq[i - 1];

    const c =
      seq[i];

    // B B -> S -> B
    // S S -> B -> S

    if (
      a === b &&
      b !== c
    ) {

      if (
        i + 1 <
          seq.length &&
        seq[i + 1] === a
      ) {
        failedReversalCount++;
      }
    }

    // Successful break
    if (
      a === b &&
      c !== b
    ) {
      successfulBreaks++;
    }
  }

  if (
    seq.length >= 3
  ) {
    const a =
      seq[seq.length - 3];

    const b =
      seq[seq.length - 2];

    const c =
      seq[seq.length - 1];

    if (
      a === b &&
      b !== c
    ) {
      // Wait for next result;
      // don't call it failed yet.
      failedReversal =
        false;
    }

    if (
      seq.length >= 4
    ) {
      const d =
        seq[seq.length - 1];

      const c2 =
        seq[seq.length - 2];

      const b2 =
        seq[seq.length - 3];

      const a2 =
        seq[seq.length - 4];

      if (
        a2 === b2 &&
        b2 !== c2 &&
        c2 === d
      ) {
        failedReversal =
          true;
      }
    }
  }

  // ----------------------------------------------------------
  // 14. HUMAN SIGNALS
  // ----------------------------------------------------------

  const signals = [];

  if (
    w5.B >
    w5.S
  ) {
    signals.push("B");
  } else if (
    w5.S >
    w5.B
  ) {
    signals.push("S");
  }

  if (
    w10.B >
    w10.S
  ) {
    signals.push("B");
  } else if (
    w10.S >
    w10.B
  ) {
    signals.push("S");
  }

  if (
    w20.B >
    w20.S
  ) {
    signals.push("B");
  } else if (
    w20.S >
    w20.B
  ) {
    signals.push("S");
  }

  if (
    momentum ===
    "BIG MOMENTUM"
  ) {
    signals.push("B");
  }

  if (
    momentum ===
    "SMALL MOMENTUM"
  ) {
    signals.push("S");
  }

  // ----------------------------------------------------------
  // 15. SIGNAL AGREEMENT
  // ----------------------------------------------------------

  const bSignals =
    signals.filter(
      x => x === "B"
    ).length;

  const sSignals =
    signals.filter(
      x => x === "S"
    ).length;

  let dominant =
    "NO CLEAR DIRECTION";

  if (
    bSignals >
    sSignals
  ) {
    dominant = "B";
  } else if (
    sSignals >
    bSignals
  ) {
    dominant = "S";
  }

  // ----------------------------------------------------------
  // 16. REVERSAL STATUS
  // ----------------------------------------------------------

  let reversalStatus =
    "NO REVERSAL SIGNAL";

  if (
    reversalScore >= 4
  ) {
    reversalStatus =
      "STRONG REVERSAL WATCH";
  } else if (
    reversalScore >= 2
  ) {
    reversalStatus =
      "REVERSAL WATCH";
  } else if (
    reversalScore === 1
  ) {
    reversalStatus =
      "WEAK REVERSAL SIGNAL";
  }

  // ----------------------------------------------------------
  // 17. CONFIDENCE
  // ----------------------------------------------------------

  let confidence =
    "LOW";

  if (
    signals.length === 0
  ) {
    confidence =
      "LOW";
  } else if (
    bSignals ===
    sSignals
  ) {
    confidence =
      "LOW";
  } else if (
    Math.abs(
      bSignals -
      sSignals
    ) === 1
  ) {
    confidence =
      "MEDIUM";
  } else {
    confidence =
      "HIGH";
  }

  if (
    reversalStatus !==
    "NO REVERSAL SIGNAL"
  ) {
    confidence =
      "MEDIUM";
  }

  if (
    failedReversal
  ) {
    confidence =
      "LOW";
  }

  // Sample-size protection

  if (
    clean.length < 20
  ) {
    confidence =
      "LOW";
  }

  // ----------------------------------------------------------
  // 18. FINAL PREDICTION
  // ----------------------------------------------------------

  let prediction =
    null;

  if (
    dominant === "B"
  ) {
    prediction =
      "BIG";
  } else if (
    dominant === "S"
  ) {
    prediction =
      "SMALL";
  }

  if (
    failedReversal
  ) {
    prediction =
      dominant === "B"
        ? "BIG"
        : dominant === "S"
        ? "SMALL"
        : null;
  }

  // No signal
  if (
    dominant ===
    "NO CLEAR DIRECTION"
  ) {
    prediction = null;
  }

  // ----------------------------------------------------------
  // 19. NUMERIC SUPPORT
  // ----------------------------------------------------------

  let bigSupport =
    50;

  let smallSupport =
    50;

  if (
    bSignals +
      sSignals >
    0
  ) {

    const signalTotal =
      bSignals +
      sSignals;

    bigSupport =
      (
        bSignals /
        signalTotal
      ) *
      100;

    smallSupport =
      (
        sSignals /
        signalTotal
      ) *
      100;
  }

  // Small amount of frequency
  // influence

  bigSupport =
    bigSupport * 0.7 +
    bigPct * 0.3;

  smallSupport =
    smallSupport * 0.7 +
    smallPct * 0.3;

  // Normalize

  const supportTotal =
    bigSupport +
    smallSupport;

  bigSupport =
    Number(
      (
        bigSupport /
        supportTotal *
        100
      ).toFixed(2)
    );

  smallSupport =
    Number(
      (
        smallSupport /
        supportTotal *
        100
      ).toFixed(2)
    );

  // ----------------------------------------------------------
  // 20. CLASSIFICATION
  // ----------------------------------------------------------

  let classification =
    "NO CLEAR SIGNAL";

  const supportEdge =
    Math.abs(
      bigSupport -
      smallSupport
    );

  if (
    clean.length < 10
  ) {
    classification =
      "INSUFFICIENT DATA";
  } else if (
    failedReversal
  ) {
    classification =
      "FAILED REVERSAL";
  } else if (
    reversalScore >= 4
  ) {
    classification =
      "REVERSAL WATCH";
  } else if (
    patternBreak
  ) {
    classification =
      "PATTERN BREAK";
  } else if (
    supportEdge < 7
  ) {
    classification =
      "NO CLEAR SIGNAL";
  } else if (
    supportEdge < 15
  ) {
    classification =
      "WEAK HISTORICAL BIAS";
  } else if (
    supportEdge < 25
  ) {
    classification =
      "MODERATE HISTORICAL BIAS";
  } else {
    classification =
      "STRONG HISTORICAL BIAS";
  }

  // ----------------------------------------------------------
  // 21. RETURN
  // ----------------------------------------------------------

  return {

    status: "OK",

    sequence:
      seq.join(""),

    totalResults:
      total,

    current: {
      type:
        current,

      label:
        typeLabel(current),

      streak:
        streak
    },

    overall: {
      BIG: big,
      SMALL: small,

      BIG_percent:
        bigPct,

      SMALL_percent:
        smallPct
    },

    windows: {
      last_5: w5,
      last_10: w10,
      last_20: w20,
      last_30: w30,
      last_50: w50,
      last_100: w100
    },

    streak_analysis: {
      longest_big:
        longestBig,

      longest_small:
        longestSmall,

      big_runs:
        bigRuns,

      small_runs:
        smallRuns,

      average_big_run:
        Number(
          average(
            bigRuns
          ).toFixed(2)
        ),

      average_small_run:
        Number(
          average(
            smallRuns
          ).toFixed(2)
        ),

      median_big_run:
        Number(
          median(
            bigRuns
          ).toFixed(2)
        ),

      median_small_run:
        Number(
          median(
            smallRuns
          ).toFixed(2)
        )
    },

    switching: {
      switches,
      switch_rate:
        switchRate,

      classification:
        switchRate > 60
          ? "HIGH SWITCHING"
          : switchRate >= 40
          ? "BALANCED"
          : "STREAK DOMINANT"
    },

    pattern: {
      alternating,

      alternation_length:
        alternationLength,

      repeating_block:
        repeatingBlock,

      pattern_break:
        patternBreak,

      runs
    },

    momentum: {
      status:
        momentum,

      value:
        momentumValue
    },

    reversal: {
      status:
        reversalStatus,

      score:
        reversalScore,

      reasons:
        reversalReasons
    },

    failed_reversal: {
      active:
        failedReversal,

      count:
        failedReversalCount,

      successful_breaks:
        successfulBreaks
    },

    human_logic: {
      signals,

      big_signals:
        bSignals,

      small_signals:
        sSignals,

      dominant_historical_side:
        dominant,

      confidence,

      support: {
        big:
          bigSupport,

        small:
          smallSupport
      }
    },

    prediction,

    classification,

    warning:
      clean.length < 20
        ? "LOW DATA"
        : clean.length < 50
        ? "MODERATE SAMPLE"
        : "STATISTICAL SAMPLE AVAILABLE",

    modelVersion:
      MODEL_VERSION,

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
    history[0].issueNumber;

  const current =
    providerState.currentIssue;

  if (
    current &&
    compareIssue(
      current,
      latest
    ) > 0
  ) {
    return current;
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
    WingoBot history:
    newest -> oldest

    Human logic:
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

  modelCache = {
    targetIssue,

    prediction: {

      targetIssue,

      prediction:
        analysis.prediction,

      confidence:
        confidenceNumber(
          analysis.confidence
        ),

      confidenceLevel:
        analysis.confidence,

      classification:
        analysis.classification,

      reason:
        buildReason(
          analysis
        ),

      modelVersion:
        MODEL_VERSION,

      generatedAt,

      statisticalSupport:
        analysis
          .human_logic
          ?.support || {
            big: 50,
            small: 50
          },

      agreement: {
        big:
          analysis
            .human_logic
            ?.big_signals || 0,

        small:
          analysis
            .human_logic
            ?.small_signals || 0
      },

      evidenceConflict:
        analysis
          .human_logic
          ?.big_signals ===
        analysis
          .human_logic
          ?.small_signals,

      analysis,

      warning:
        analysis.warning
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
// CONFIDENCE NUMBER
// ============================================================

function confidenceNumber(
  level
) {
  if (
    level === "HIGH"
  ) {
    return 82;
  }

  if (
    level === "MEDIUM"
  ) {
    return 70;
  }

  return 45;
}

// ============================================================
// REASON
// ============================================================

function buildReason(
  analysis
) {

  const parts = [];

  const current =
    analysis.current;

  if (
    current?.label
  ) {
    parts.push(
      `${current.label} streak ${current.streak}`
    );
  }

  if (
    analysis.momentum
      ?.status !==
    "NEUTRAL"
  ) {
    parts.push(
      analysis.momentum.status
    );
  }

  if (
    analysis
      .human_logic
      ?.signals
      ?.length
  ) {
    parts.push(
      `signals ${analysis.human_logic.signals.join("/")}`
    );
  }

  if (
    analysis.pattern
      ?.repeating_block
  ) {
    parts.push(
      `repeat ${analysis.pattern.repeating_block}`
    );
  }

  if (
    analysis.reversal
      ?.score > 0
  ) {
    parts.push(
      `reversal ${analysis.reversal.score}`
    );
  }

  if (
    analysis.pattern
      ?.pattern_break
  ) {
    parts.push(
      "pattern break"
    );
  }

  if (!parts.length) {
    return (
      "Human-style historical pattern analysis."
    );
  }

  return parts.join(
    " • "
  );
}

// ============================================================
// SAVE PREDICTION
// ============================================================

async function savePrediction(
  targetIssue,
  analysis
) {
  if (!pool) return;

  if (
    !targetIssue ||
    !analysis?.prediction
  ) {
    return;
  }

  try {

    /*
      Don't create duplicate records
      for same issue.
    */

    const existing =
      await pool.query(
        `
        SELECT id
        FROM prediction_records
        WHERE target_issue = $1
          AND actual_result IS NULL
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

        analysis.prediction,

        confidenceNumber(
          analysis.confidence
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
// SETTLE
// ============================================================

async function settlePredictions() {
  if (!pool) return;

  for (
    const row of
      providerState.history.slice(
        0,
        100
      )
  ) {

    const number =
      Number(row.number);

    const actual =
      numberToType(
        number
      );

    if (!actual) {
      continue;
    }

    try {

      await pool.query(
        `
        UPDATE prediction_records
        SET
          actual_number = $1,
          actual_result = $2,
          settled_at = $3
        WHERE target_issue = $4
          AND actual_result IS NULL
        `,
        [
          number,
          actual,
          now(),
          String(
            row.issueNumber
          )
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

  if (
    !modelCache.prediction ||
    modelCache.targetIssue !==
      targetIssue
  ) {
    await generateModel();
  }

  const history =
    providerState.history
      .slice(0, 30)
      .map(
        row => {

          const type =
            numberToType(
              Number(
                row.number
              )
            );

          return {
            issue:
              row.issueNumber,

            number:
              Number(
                row.number
              ),

            type,

            label:
              typeLabel(type)
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

      provider: {
        ok:
          providerState.ok,

        currentIssue:
          providerState.currentIssue,

        historyCount:
          providerState.history.length,

        lastUpdated:
          providerState.lastUpdated,

        error:
          providerState.error
      },

      targetIssue,

      thinkingDurationMs:
        THINKING_DURATION_MS,

      prediction:
        modelCache.prediction,

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
      key: auth.key,
      id: auth.id,
      modelVersion:
        MODEL_VERSION
    }
  );
}

// ============================================================
// HISTORY
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

function adminPing(res) {

  json(
    res,
    200,
    {
      ok: true,
      message: "PONG",
      time: now(),
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
          5
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
    }
  );
}

// ============================================================
// ADMIN KEYS
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
        providerState.ok
    }
  );
}

// ============================================================
// STATIC
// ============================================================

function contentType(
  filePath
) {

  const ext =
    path.extname(
      filePath
    ).toLowerCase();

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

        // HEALTH

        if (
          pathname ===
          "/health"
        ) {
          health(res);
          return;
        }

        // KEY CHECK

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

        // STATE

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

        // HISTORY

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

        // ADMIN AUTH

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

        // ADMIN STATUS

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

        // ADMIN PING

        if (
          pathname ===
            "/api/admin/ping" &&
          req.method ===
            "GET"
        ) {

          adminPing(res);

          return;
        }

        // WINGO TEST

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

        // MODEL TEST

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

        // KEYS GET

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

        // KEYS CREATE

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

        // KEYS DELETE

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

        // RESET DEVICE

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

        // STATIC

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
// BACKGROUND
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
          `HISTORY: ${providerState.history.length}`
        );

        console.log(
          `TARGET: ${modelCache.targetIssue}`
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

start();
