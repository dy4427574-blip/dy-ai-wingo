const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 10000);

const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_KEY = process.env.ADMIN_KEY || "dy4427574";
const WINGOBOT_TOKEN = process.env.WINGOBOT_TOKEN;

const WINGOBOT_URL =
  "https://api.wingobot.com/v2/30-sec-game-history";

const COOLDOWN_ROUNDS = 5;
const MODEL_VERSION = "OWN-ADAPTIVE-ANALYSIS-V7";

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL
    ? { rejectUnauthorized: false }
    : undefined,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});


// ======================================================
// DATABASE
// ======================================================

async function initDB() {
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL is missing");
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
      target_issue TEXT NOT NULL,
      prediction TEXT NOT NULL,
      confidence INTEGER DEFAULT 0,
      model_version TEXT,
      actual_number INTEGER,
      actual_result TEXT,
      created_at BIGINT NOT NULL,
      settled_at BIGINT
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_prediction_target
    ON prediction_records(target_issue)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_prediction_created
    ON prediction_records(created_at)
  `);

  console.log("DATABASE READY");
}


// ======================================================
// BASIC
// ======================================================

function now() {
  return Date.now();
}

function safeString(v) {
  return String(v ?? "").trim();
}

function json(res, status, data) {
  const body = JSON.stringify(data);

  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Pragma": "no-cache",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "Content-Type, X-Access-Key, X-Device-Id, X-Admin-Key",
    "Access-Control-Allow-Methods":
      "GET, POST, DELETE, OPTIONS"
  });

  res.end(body);
}

function text(res, status, body, type = "text/plain") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store"
  });

  res.end(body);
}


// ======================================================
// SAFE ISSUE NUMBER
// ======================================================

function issueDigits(issue) {
  const s = safeString(issue);
  const d = s.replace(/\D/g, "");
  return d || null;
}

function issueBigInt(issue) {
  const d = issueDigits(issue);

  if (!d) return null;

  try {
    return BigInt(d);
  } catch {
    return null;
  }
}

function compareIssues(a, b) {
  const A = issueBigInt(a);
  const B = issueBigInt(b);

  if (A === null || B === null) return 0;

  if (A < B) return -1;
  if (A > B) return 1;

  return 0;
}

function sameIssue(a, b) {
  const A = issueDigits(a);
  const B = issueDigits(b);

  if (!A || !B) return false;

  if (A === B) return true;

  return A.endsWith(B) || B.endsWith(A);
}

function nextIssue(issue) {
  const s = safeString(issue);

  if (!s) return null;

  const match = s.match(/(\d+)$/);

  if (!match) return null;

  const suffix = match[1];

  const prefix = s.slice(
    0,
    s.length - suffix.length
  );

  try {
    let next =
      (BigInt(suffix) + 1n).toString();

    if (next.length < suffix.length) {
      next = next.padStart(
        suffix.length,
        "0"
      );
    }

    return prefix + next;
  } catch {
    return null;
  }
}


// ======================================================
// NUMBER / BIG SMALL
// ======================================================

function numberToAB(number) {
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

function abToType(ab) {
  return ab === "B"
    ? "BIG"
    : "SMALL";
}

function cleanNumbers(numbers) {
  return (numbers || [])
    .map(Number)
    .filter(
      n =>
        Number.isInteger(n) &&
        n >= 0 &&
        n <= 9
    );
}


// ======================================================
// WINGOBOT
// ======================================================

async function fetchWingoHistory() {
  if (!WINGOBOT_TOKEN) {
    throw new Error(
      "WINGOBOT_TOKEN missing"
    );
  }

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      8000
    );

  try {
    const response =
      await fetch(
        WINGOBOT_URL,
        {
          method: "GET",
          headers: {
            Authorization:
              `Bearer ${WINGOBOT_TOKEN}`,
            Accept:
              "application/json"
          },
          signal:
            controller.signal
        }
      );

    if (!response.ok) {
      throw new Error(
        `Wingo API HTTP ${response.status}`
      );
    }

    return await response.json();

  } finally {
    clearTimeout(timeout);
  }
}


function normalizeWingo(data) {
  const currentIssue =
    data?.current?.issueNumber ??
    data?.currentIssue ??
    null;

  const rows =
    Array.isArray(data?.history)
      ? data.history
      : Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data?.results)
          ? data.results
          : [];

  const history =
    rows
      .map(row => {
        const issue =
          row?.issueNumber ??
          row?.issue ??
          row?.period ??
          row?.id;

        const number =
          row?.number ??
          row?.num ??
          row?.result;

        const n = Number(number);

        if (
          issue === undefined ||
          !Number.isInteger(n) ||
          n < 0 ||
          n > 9
        ) {
          return null;
        }

        return {
          issue: String(issue),
          number: n,
          result:
            abToType(
              numberToAB(n)
            ),
          colour:
            row?.colour ??
            row?.color ??
            null,
          premium:
            row?.premium ??
            null,
          sum:
            row?.sum ??
            null
        };
      })
      .filter(Boolean);

  const unique = [];
  const seen = new Set();

  for (const row of history) {
    const key =
      issueDigits(row.issue) ||
      row.issue;

    if (seen.has(key)) continue;

    seen.add(key);
    unique.push(row);
  }

  unique.sort(
    (a, b) =>
      compareIssues(
        a.issue,
        b.issue
      )
  );

  return {
    currentIssue:
      currentIssue
        ? String(currentIssue)
        : unique.length
          ? unique[
              unique.length - 1
            ].issue
          : null,

    history: unique
  };
}


// ======================================================
// BASIC ANALYSIS
// ======================================================

function countAB(seq) {
  let A = 0;
  let B = 0;

  for (const x of seq) {
    if (x === "A") A++;
    if (x === "B") B++;
  }

  const total = A + B;

  return {
    A,
    B,
    total,
    APercent:
      total
        ? A / total * 100
        : 0,
    BPercent:
      total
        ? B / total * 100
        : 0
  };
}


function currentStreak(seq) {
  if (!seq.length) {
    return {
      side: null,
      length: 0
    };
  }

  const side =
    seq[seq.length - 1];

  let length = 0;

  for (
    let i = seq.length - 1;
    i >= 0;
    i--
  ) {
    if (seq[i] !== side) break;
    length++;
  }

  return {
    side,
    length
  };
}


function getRuns(seq) {
  if (!seq.length) return [];

  const runs = [];

  let side = seq[0];
  let length = 1;

  for (
    let i = 1;
    i < seq.length;
    i++
  ) {
    if (seq[i] === side) {
      length++;
    } else {
      runs.push({
        side,
        length
      });

      side = seq[i];
      length = 1;
    }
  }

  runs.push({
    side,
    length
  });

  return runs;
}


function runStats(seq) {
  const runs =
    getRuns(seq);

  if (!runs.length) {
    return {
      average: 0,
      median: 0,
      longestA: 0,
      longestB: 0,
      common: 0
    };
  }

  const lengths =
    runs.map(
      x => x.length
    );

  const sorted =
    [...lengths].sort(
      (a, b) => a - b
    );

  const middle =
    Math.floor(
      sorted.length / 2
    );

  const median =
    sorted.length % 2
      ? sorted[middle]
      : (
          sorted[middle - 1] +
          sorted[middle]
        ) / 2;

  const frequency = {};

  for (const n of lengths) {
    frequency[n] =
      (frequency[n] || 0) + 1;
  }

  let common =
    lengths[0];

  for (
    const k of Object.keys(
      frequency
    )
  ) {
    if (
      frequency[k] >
      frequency[common]
    ) {
      common =
        Number(k);
    }
  }

  return {
    average:
      lengths.reduce(
        (a, b) => a + b,
        0
      ) / lengths.length,

    median,

    longestA:
      Math.max(
        0,
        ...runs
          .filter(
            x => x.side === "A"
          )
          .map(
            x => x.length
          )
      ),

    longestB:
      Math.max(
        0,
        ...runs
          .filter(
            x => x.side === "B"
          )
          .map(
            x => x.length
          )
      ),

    common
  };
}


function switchingStats(seq) {
  if (seq.length < 2) {
    return {
      switches: 0,
      rate: 0,
      classification:
        "LOW DATA"
    };
  }

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

  const rate =
    switches /
    (seq.length - 1) *
    100;

  let classification =
    "STREAK DOMINANT";

  if (rate > 60) {
    classification =
      "HIGH SWITCHING";
  } else if (rate >= 40) {
    classification =
      "BALANCED";
  }

  return {
    switches,
    rate,
    classification
  };
}


function transitions(seq) {
  const matrix = {
    AA: 0,
    AB: 0,
    BA: 0,
    BB: 0
  };

  for (
    let i = 1;
    i < seq.length;
    i++
  ) {
    const key =
      seq[i - 1] +
      seq[i];

    if (
      matrix[key] !== undefined
    ) {
      matrix[key]++;
    }
  }

  const next = {
    afterA: {
      A: 0,
      B: 0
    },
    afterB: {
      A: 0,
      B: 0
    }
  };

  const afterA =
    matrix.AA +
    matrix.AB;

  const afterB =
    matrix.BA +
    matrix.BB;

  if (afterA) {
    next.afterA.A =
      matrix.AA / afterA;

    next.afterA.B =
      matrix.AB / afterA;
  }

  if (afterB) {
    next.afterB.A =
      matrix.BA / afterB;

    next.afterB.B =
      matrix.BB / afterB;
  }

  return {
    matrix,
    next
  };
}


function momentumAnalysis(seq) {
  if (seq.length < 10) {
    return {
      classification:
        "LOW DATA",
      recent: null,
      previous: null,
      difference: 0
    };
  }

  const recent =
    seq.slice(-5);

  const previous =
    seq.slice(-10, -5);

  const r =
    countAB(recent);

  const p =
    countAB(previous);

  const difference =
    r.BPercent -
    p.BPercent;

  let classification =
    "STABLE";

  if (difference >= 25) {
    classification =
      "BIG MOMENTUM";
  } else if (difference <= -25) {
    classification =
      "SMALL MOMENTUM";
  } else if (difference >= 10) {
    classification =
      "BIG LEAN";
  } else if (difference <= -10) {
    classification =
      "SMALL LEAN";
  }

  return {
    classification,
    recent: r,
    previous: p,
    difference
  };
}


function alternationAnalysis(seq) {
  if (seq.length < 4) {
    return {
      active: false,
      length: 0
    };
  }

  let length = 1;

  for (
    let i = seq.length - 1;
    i > 0;
    i--
  ) {
    if (
      seq[i] ===
      seq[i - 1]
    ) {
      break;
    }

    length++;
  }

  return {
    active:
      length >= 4,
    length
  };
}


function repeatingBlocks(seq) {
  const result = [];

  for (
    let size = 2;
    size <= 6;
    size++
  ) {
    if (
      seq.length <
      size * 2
    ) {
      continue;
    }

    const a =
      seq
        .slice(-size)
        .join("");

    const b =
      seq
        .slice(
          -size * 2,
          -size
        )
        .join("");

    if (a === b) {
      result.push({
        length: size,
        pattern: a
      });
    }
  }

  return result;
}


function digitAnalysis(numbers) {
  const frequency =
    Array(10).fill(0);

  for (const n of numbers) {
    if (
      Number.isInteger(n) &&
      n >= 0 &&
      n <= 9
    ) {
      frequency[n]++;
    }
  }

  const gaps =
    Array(10).fill(null);

  for (
    let i = numbers.length - 1;
    i >= 0;
    i--
  ) {
    const n =
      numbers[i];

    if (
      gaps[n] === null
    ) {
      gaps[n] =
        numbers.length -
        1 -
        i;
    }
  }

  return {
    frequency,
    gaps,

    average:
      numbers.length
        ? numbers.reduce(
            (a, b) => a + b,
            0
          ) /
          numbers.length
        : 0
  };
}


// ======================================================
// PATTERN MATCHING
// ======================================================

function patternSupport(seq, length) {
  if (
    seq.length <
    length + 1
  ) {
    return {
      matches: 0,
      A: 0,
      B: 0
    };
  }

  const pattern =
    seq.slice(-length);

  let matches = 0;
  let A = 0;
  let B = 0;

  for (
    let i = length;
    i < seq.length;
    i++
  ) {
    const previous =
      seq.slice(
        i - length,
        i
      );

    if (
      previous.join("") ===
      pattern.join("")
    ) {
      matches++;

      if (seq[i] === "A") {
        A++;
      } else {
        B++;
      }
    }
  }

  return {
    matches,
    A,
    B
  };
}


// ======================================================
// ADAPTIVE WALK-FORWARD BACKTEST
// ======================================================

function simpleStrategyPrediction(
  seq,
  index
) {
  if (
    index < 10
  ) {
    return null;
  }

  const before =
    seq.slice(
      0,
      index
    );

  const recent =
    before.slice(-5);

  const ten =
    before.slice(-10);

  const r =
    countAB(recent);

  const t =
    countAB(ten);

  let big = 0;
  let small = 0;

  big +=
    (r.BPercent - 50) *
    0.8;

  small +=
    (r.APercent - 50) *
    0.8;

  big +=
    (t.BPercent - 50) *
    0.35;

  small +=
    (t.APercent - 50) *
    0.35;

  const last =
    before[
      before.length - 1
    ];

  const trans =
    transitions(before);

  if (last === "A") {
    big +=
      trans.next.afterA.B *
      10;

    small +=
      trans.next.afterA.A *
      10;
  } else {
    big +=
      trans.next.afterB.B *
      10;

    small +=
      trans.next.afterB.A *
      10;
  }

  return big >= small
    ? "B"
    : "A";
}


function adaptiveBacktest(seq) {
  if (
    seq.length < 15
  ) {
    return {
      BIG: {
        attempts: 0,
        wins: 0,
        accuracy: 0.5
      },

      SMALL: {
        attempts: 0,
        wins: 0,
        accuracy: 0.5
      },

      overall: 0.5
    };
  }

  const side = {
    A: {
      attempts: 0,
      wins: 0
    },

    B: {
      attempts: 0,
      wins: 0
    }
  };

  let totalAttempts = 0;
  let totalWins = 0;

  /*
   * Walk-forward:
   * prediction is made only from
   * data available before the target.
   */

  for (
    let i = 10;
    i < seq.length;
    i++
  ) {
    const prediction =
      simpleStrategyPrediction(
        seq,
        i
      );

    if (!prediction) {
      continue;
    }

    const actual =
      seq[i];

    side[prediction].attempts++;
    totalAttempts++;

    if (
      prediction === actual
    ) {
      side[prediction].wins++;
      totalWins++;
    }
  }

  const accuracy =
    x =>
      x.attempts
        ? x.wins / x.attempts
        : 0.5;

  return {
    BIG: {
      attempts:
        side.B.attempts,

      wins:
        side.B.wins,

      accuracy:
        accuracy(side.B)
    },

    SMALL: {
      attempts:
        side.A.attempts,

      wins:
        side.A.wins,

      accuracy:
        accuracy(side.A)
    },

    overall:
      totalAttempts
        ? totalWins /
          totalAttempts
        : 0.5
  };
}


// ======================================================
// RECENT PREDICTION PERFORMANCE
// ======================================================

async function recentModelPerformance() {
  const result =
    await pool.query(`
      SELECT prediction, actual_result
      FROM prediction_records
      WHERE actual_result IN ('WIN','LOSS')
      ORDER BY id DESC
      LIMIT 20
    `);

  const resultData = {
    BIG: {
      attempts: 0,
      wins: 0
    },

    SMALL: {
      attempts: 0,
      wins: 0
    }
  };

  for (
    const row of result.rows
  ) {
    const side =
      row.prediction === "BIG"
        ? "BIG"
        : "SMALL";

    resultData[side].attempts++;

    if (
      row.actual_result ===
      "WIN"
    ) {
      resultData[side].wins++;
    }
  }

  for (
    const side of [
      "BIG",
      "SMALL"
    ]
  ) {
    const x =
      resultData[side];

    x.accuracy =
      x.attempts
        ? x.wins /
          x.attempts
        : 0.5;
  }

  return resultData;
}


// ======================================================
// FULL ADAPTIVE MODEL
// ======================================================

async function fullAnalysis(history) {

  const ordered =
    [...history].sort(
      (a, b) =>
        compareIssues(
          a.issue,
          b.issue
        )
    );

  const numbers =
    cleanNumbers(
      ordered.map(
        x => x.number
      )
    );

  const seq =
    numbers.map(
      numberToAB
    );

  const total =
    seq.length;


  if (total < 5) {
    return {
      prediction: null,
      confidence: 0,
      classification:
        "INSUFFICIENT DATA",
      score: {
        BIG: 0,
        SMALL: 0
      },
      dataCount: total
    };
  }


  // ----------------------------------------------------
  // WINDOWS
  // ----------------------------------------------------

  const windows = {};

  for (
    const size of [
      5,
      10,
      20,
      30,
      50,
      100
    ]
  ) {
    windows[size] =
      countAB(
        seq.slice(-size)
      );
  }


  const stats =
    countAB(seq);

  const current =
    currentStreak(seq);

  const switching =
    switchingStats(seq);

  const transition =
    transitions(seq);

  const momentum =
    momentumAnalysis(seq);

  const runs =
    runStats(seq);

  const alternation =
    alternationAnalysis(seq);

  const repeating =
    repeatingBlocks(seq);

  const digits =
    digitAnalysis(numbers);


  // ----------------------------------------------------
  // MULTI LENGTH PATTERNS
  // ----------------------------------------------------

  const pattern3 =
    patternSupport(seq, 3);

  const pattern4 =
    patternSupport(seq, 4);

  const pattern5 =
    patternSupport(seq, 5);


  // ----------------------------------------------------
  // HISTORICAL BACKTEST
  // ----------------------------------------------------

  const backtest =
    adaptiveBacktest(seq);


  // ----------------------------------------------------
  // DATABASE RECENT PERFORMANCE
  // ----------------------------------------------------

  let recentPerformance;

  try {
    recentPerformance =
      await recentModelPerformance();
  } catch {
    recentPerformance = {
      BIG: {
        attempts: 0,
        wins: 0,
        accuracy: 0.5
      },

      SMALL: {
        attempts: 0,
        wins: 0,
        accuracy: 0.5
      }
    };
  }


  // ----------------------------------------------------
  // SCORE
  // ----------------------------------------------------

  let big = 0;
  let small = 0;


  // ====================================================
  // A. RECENT WINDOW
  // ====================================================

  big +=
    (windows[5].BPercent - 50) *
    0.28;

  small +=
    (windows[5].APercent - 50) *
    0.28;


  big +=
    (windows[10].BPercent - 50) *
    0.18;

  small +=
    (windows[10].APercent - 50) *
    0.18;


  big +=
    (windows[20].BPercent - 50) *
    0.12;

  small +=
    (windows[20].APercent - 50) *
    0.12;


  // ====================================================
  // B. GLOBAL FREQUENCY
  // ====================================================

  big +=
    (stats.BPercent - 50) *
    0.08;

  small +=
    (stats.APercent - 50) *
    0.08;


  // ====================================================
  // C. TRANSITION
  // ====================================================

  if (
    current.side === "A"
  ) {

    big +=
      transition.next.afterA.B *
      16;

    small +=
      transition.next.afterA.A *
      16;

  } else {

    big +=
      transition.next.afterB.B *
      16;

    small +=
      transition.next.afterB.A *
      16;
  }


  // ====================================================
  // D. MOMENTUM
  // ====================================================

  if (
    momentum.classification ===
    "BIG MOMENTUM"
  ) {
    big += 6;
  }

  if (
    momentum.classification ===
    "SMALL MOMENTUM"
  ) {
    small += 6;
  }

  if (
    momentum.classification ===
    "BIG LEAN"
  ) {
    big += 3;
  }

  if (
    momentum.classification ===
    "SMALL LEAN"
  ) {
    small += 3;
  }


  // ====================================================
  // E. PATTERN 3
  // ====================================================

  if (
    pattern3.matches >= 2
  ) {

    big +=
      (
        pattern3.B /
        pattern3.matches
      ) * 12;

    small +=
      (
        pattern3.A /
        pattern3.matches
      ) * 12;
  }


  // ====================================================
  // F. PATTERN 4
  // ====================================================

  if (
    pattern4.matches >= 2
  ) {

    big +=
      (
        pattern4.B /
        pattern4.matches
      ) * 10;

    small +=
      (
        pattern4.A /
        pattern4.matches
      ) * 10;
  }


  // ====================================================
  // G. PATTERN 5
  // ====================================================

  if (
    pattern5.matches >= 2
  ) {

    big +=
      (
        pattern5.B /
        pattern5.matches
      ) * 9;

    small +=
      (
        pattern5.A /
        pattern5.matches
      ) * 9;
  }


  // ====================================================
  // H. STREAK
  // ====================================================

  if (
    current.length >= 3
  ) {

    if (
      current.side === "B"
    ) {

      /*
       * Continuation evidence
       */

      big +=
        Math.min(
          7,
          current.length * 1.2
        );

      /*
       * Reversal watch
       */

      small +=
        Math.min(
          5,
          current.length * 0.9
        );

    } else {

      small +=
        Math.min(
          7,
          current.length * 1.2
        );

      big +=
        Math.min(
          5,
          current.length * 0.9
        );
    }
  }


  // ====================================================
  // I. SWITCHING
  // ====================================================

  if (
    switching.classification ===
    "HIGH SWITCHING"
  ) {

    if (
      current.side === "A"
    ) {
      big += 4;
    } else {
      small += 4;
    }

  } else if (
    switching.classification ===
    "STREAK DOMINANT"
  ) {

    if (
      current.side === "A"
    ) {
      small += 3;
    } else {
      big += 3;
    }
  }


  // ====================================================
  // J. ALTERNATION
  // ====================================================

  if (
    alternation.active
  ) {

    /*
     * Alternation is only evidence,
     * not a forced reversal.
     */

    if (
      current.side === "A"
    ) {
      big += 3;
    } else {
      small += 3;
    }
  }


  // ====================================================
  // K. REPEATING BLOCK
  // ====================================================

  if (
    repeating.length
  ) {

    const block =
      repeating[
        repeating.length - 1
      ];

    const last =
      block.pattern[
        block.pattern.length - 1
      ];

    if (
      last === "A"
    ) {
      small += 2;
    } else {
      big += 2;
    }
  }


  // ====================================================
  // L. WALK-FORWARD BACKTEST
  // ====================================================

  /*
   * Important:
   * A side that performs badly in
   * historical simulation gets less
   * weight.
   */

  const bigBT =
    backtest.BIG.accuracy;

  const smallBT =
    backtest.SMALL.accuracy;


  big +=
    (bigBT - 0.5) *
    24;

  small +=
    (smallBT - 0.5) *
    24;


  // ====================================================
  // M. RECENT LIVE MODEL PERFORMANCE
  // ====================================================

  const bigRecent =
    recentPerformance.BIG.accuracy;

  const smallRecent =
    recentPerformance.SMALL.accuracy;


  /*
   * If one side has been losing,
   * reduce its weight.
   */

  if (
    recentPerformance.BIG.attempts >= 3
  ) {

    big +=
      (bigRecent - 0.5) *
      18;
  }


  if (
    recentPerformance.SMALL.attempts >= 3
  ) {

    small +=
      (smallRecent - 0.5) *
      18;
  }


  // ====================================================
  // N. ANTI-STUCK PENALTY
  // ====================================================

  /*
   * Do not allow the model to remain
   * on one side indefinitely.
   *
   * This is NOT forced alternation.
   *
   * It only activates when recent
   * prediction history shows repeated
   * same-side predictions.
   */

  let consecutiveSame =
    0;

  let lastSide = null;

  try {

    const recent =
      await pool.query(`
        SELECT prediction
        FROM prediction_records
        WHERE actual_result IS NOT NULL
        ORDER BY id DESC
        LIMIT 6
      `);

    for (
      const row of recent.rows
    ) {

      const side =
        row.prediction === "BIG"
          ? "BIG"
          : "SMALL";

      if (
        lastSide === null
      ) {

        lastSide = side;
        consecutiveSame = 1;

      } else if (
        side === lastSide
      ) {

        consecutiveSame++;

      } else {

        break;
      }
    }

  } catch {
    consecutiveSame = 0;
  }


  if (
    consecutiveSame >= 3
  ) {

    if (
      lastSide === "BIG"
    ) {

      big -=
        7 +
        (
          consecutiveSame - 3
        ) * 2;

    } else {

      small -=
        7 +
        (
          consecutiveSame - 3
        ) * 2;
    }
  }


  // ====================================================
  // O. CONFLICT PENALTY
  // ====================================================

  const recentDifference =
    Math.abs(
      windows[5].BPercent -
      windows[5].APercent
    );

  const globalDifference =
    Math.abs(
      stats.BPercent -
      stats.APercent
    );


  /*
   * If recent and global picture
   * strongly disagree, reduce confidence.
   */

  let conflictPenalty = 0;

  if (
    recentDifference < 10 &&
    globalDifference < 10
  ) {

    conflictPenalty = 5;
  }


  big -= conflictPenalty;
  small -= conflictPenalty;


  // ====================================================
  // P. SAMPLE SIZE
  // ====================================================

  let samplePenalty = 0;

  if (total < 10) {
    samplePenalty = 7;
  } else if (total < 20) {
    samplePenalty = 4;
  }


  big -= samplePenalty;
  small -= samplePenalty;


  // ====================================================
  // FINAL SCORE NORMALIZATION
  // ====================================================

  const rawBig =
    Math.max(
      0,
      50 + big
    );

  const rawSmall =
    Math.max(
      0,
      50 + small
    );


  const totalScore =
    rawBig +
    rawSmall;


  const bigPercent =
    totalScore
      ? rawBig /
        totalScore *
        100
      : 50;

  const smallPercent =
    totalScore
      ? rawSmall /
        totalScore *
        100
      : 50;


  // ====================================================
  // DECISION
  // ====================================================

  let prediction;

  if (
    Math.abs(
      bigPercent -
      smallPercent
    ) < 2
  ) {

    /*
     * Extremely close.
     *
     * Use stronger historical
     * walk-forward side.
     */

    if (
      bigBT >
      smallBT
    ) {

      prediction =
        "BIG";

    } else if (
      smallBT >
      bigBT
    ) {

      prediction =
        "SMALL";

    } else {

      prediction =
        bigPercent >=
        smallPercent
          ? "BIG"
          : "SMALL";
    }

  } else {

    prediction =
      bigPercent >
      smallPercent
        ? "BIG"
        : "SMALL";
  }


  const difference =
    Math.abs(
      bigPercent -
      smallPercent
    );


  // ====================================================
  // CLASSIFICATION
  // ====================================================

  let classification;

  if (
    difference < 3
  ) {

    classification =
      "MIXED / CONFLICTING";

  } else if (
    difference < 8
  ) {

    classification =
      "WEAK HISTORICAL BIAS";

  } else if (
    difference < 15
  ) {

    classification =
      "MODERATE HISTORICAL BIAS";

  } else {

    classification =
      "STRONG HISTORICAL BIAS";
  }


  if (
    current.length >= 6
  ) {

    classification +=
      " + REVERSAL WATCH";
  }


  if (
    consecutiveSame >= 3
  ) {

    classification +=
      " + ANTI-STUCK";
  }


  // ====================================================
  // CONFIDENCE
  // ====================================================

  let confidence =
    50 +
    difference *
    1.7;


  /*
   * Backtest agreement.
   */

  const selectedBT =
    prediction === "BIG"
      ? bigBT
      : smallBT;


  if (
    selectedBT >= 0.60
  ) {

    confidence += 4;

  } else if (
    selectedBT < 0.45
  ) {

    confidence -= 5;
  }


  /*
   * Recent live accuracy.
   */

  const selectedRecent =
    prediction === "BIG"
      ? bigRecent
      : smallRecent;


  const selectedAttempts =
    prediction === "BIG"
      ? recentPerformance.BIG.attempts
      : recentPerformance.SMALL.attempts;


  if (
    selectedAttempts >= 3
  ) {

    if (
      selectedRecent >= 0.60
    ) {

      confidence += 3;

    } else if (
      selectedRecent < 0.40
    ) {

      confidence -= 5;
    }
  }


  if (
    total < 10
  ) {

    confidence -= 10;

  } else if (
    total < 20
  ) {

    confidence -= 6;

  } else if (
    total < 30
  ) {

    confidence -= 3;
  }


  if (
    difference < 5
  ) {

    confidence -= 8;
  }


  confidence =
    Math.max(
      50,
      Math.min(
        92,
        Math.round(
          confidence
        )
      )
    );


  // ====================================================
  // RETURN
  // ====================================================

  return {

    prediction,

    confidence,

    classification,

    score: {

      BIG:
        Number(
          bigPercent.toFixed(2)
        ),

      SMALL:
        Number(
          smallPercent.toFixed(2)
        )
    },

    rawScore: {

      BIG:
        Number(
          rawBig.toFixed(2)
        ),

      SMALL:
        Number(
          rawSmall.toFixed(2)
        )
    },

    dataCount:
      total,

    windows,

    stats,

    current,

    switching,

    transition,

    momentum,

    runs,

    alternation,

    repeating,

    digits,

    patterns: {

      pattern3,

      pattern4,

      pattern5
    },

    backtest,

    recentPerformance,

    consecutiveSame,

    conflictPenalty,

    samplePenalty
  };
}


// ======================================================
// PREDICTION DB
// ======================================================

async function getLatestPrediction() {

  const result =
    await pool.query(`
      SELECT *
      FROM prediction_records
      ORDER BY id DESC
      LIMIT 1
    `);

  return (
    result.rows[0] ||
    null
  );
}


async function getPredictionByTarget(
  targetIssue
) {

  const result =
    await pool.query(
      `
      SELECT *
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

  return (
    result.rows[0] ||
    null
  );
}


async function findExistingPrediction(
  targetIssue
) {

  const exact =
    await getPredictionByTarget(
      targetIssue
    );

  if (exact) {
    return exact;
  }


  const recent =
    await pool.query(`
      SELECT *
      FROM prediction_records
      ORDER BY id DESC
      LIMIT 50
    `);


  return (
    recent.rows.find(
      row =>
        sameIssue(
          row.target_issue,
          targetIssue
        )
    ) ||
    null
  );
}


async function savePrediction({
  targetIssue,
  prediction,
  confidence
}) {

  const existing =
    await findExistingPrediction(
      targetIssue
    );

  if (existing) {
    return existing;
  }


  const result =
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

      RETURNING *
      `,
      [
        String(targetIssue),
        prediction,
        confidence,
        MODEL_VERSION,
        now()
      ]
    );

  return result.rows[0];
}


// ======================================================
// SETTLE
// ======================================================

async function settlePredictions(
  history
) {

  const result =
    await pool.query(`
      SELECT *
      FROM prediction_records
      WHERE actual_result IS NULL
      ORDER BY id ASC
    `);

  let settled = 0;

  for (
    const prediction
    of result.rows
  ) {

    const actual =
      history.find(
        row =>
          sameIssue(
            row.issue,
            prediction.target_issue
          )
      );

    if (!actual) {
      continue;
    }


    const outcome =
      actual.result ===
      prediction.prediction
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
        actual.number,
        outcome,
        now(),
        prediction.id
      ]
    );


    settled++;
  }

  return settled;
}


// ======================================================
// COOLDOWN
// ======================================================

function completedRoundsAfter(
  history,
  targetIssue
) {

  const index =
    history.findIndex(
      row =>
        sameIssue(
          row.issue,
          targetIssue
        )
    );


  if (
    index !== -1
  ) {

    return Math.max(
      0,
      history.length -
      index -
      1
    );
  }


  const target =
    issueBigInt(
      targetIssue
    );

  if (
    target === null
  ) {
    return 0;
  }


  let count = 0;

  for (
    const row of history
  ) {

    const n =
      issueBigInt(
        row.issue
      );

    if (
      n !== null &&
      n > target
    ) {
      count++;
    }
  }

  return count;
}


async function getCooldownStatus(
  history
) {

  const latest =
    await getLatestPrediction();


  if (!latest) {

    return {
      active: false,
      pending: false,
      completedRounds: 0,
      waitRounds: 0,
      requiredRounds:
        COOLDOWN_ROUNDS,
      lastPrediction:
        null
    };
  }


  /*
   * Current prediction is pending.
   * It MUST remain visible.
   */

  if (
    !latest.actual_result
  ) {

    return {
      active: false,
      pending: true,
      completedRounds: 0,
      waitRounds: 0,
      requiredRounds:
        COOLDOWN_ROUNDS,
      lastPrediction:
        latest
    };
  }


  const completed =
    completedRoundsAfter(
      history,
      latest.target_issue
    );


  const remaining =
    Math.max(
      0,
      COOLDOWN_ROUNDS -
      completed
    );


  return {

    active:
      remaining > 0,

    pending: false,

    completedRounds:
      Math.min(
        COOLDOWN_ROUNDS,
        completed
      ),

    waitRounds:
      remaining,

    requiredRounds:
      COOLDOWN_ROUNDS,

    lastPrediction:
      latest
  };
}


// ======================================================
// CREATE PREDICTION
// ======================================================

async function createPredictionIfAllowed(
  currentIssue,
  history
) {

  if (!currentIssue) {
    return null;
  }


  const latest =
    await getLatestPrediction();


  /*
   * If current prediction is still
   * pending, return SAME prediction.
   */

  if (
    latest &&
    !latest.actual_result
  ) {

    return latest;
  }


  /*
   * If previous prediction settled,
   * wait for 5 completed rounds.
   */

  if (
    latest &&
    latest.actual_result
  ) {

    const completed =
      completedRoundsAfter(
        history,
        latest.target_issue
      );


    if (
      completed <
      COOLDOWN_ROUNDS
    ) {

      return null;
    }
  }


  /*
   * Generate exact next issue.
   */

  const targetIssue =
    nextIssue(
      currentIssue
    );


  if (!targetIssue) {
    return null;
  }


  /*
   * Duplicate protection.
   */

  const existing =
    await findExistingPrediction(
      targetIssue
    );


  if (existing) {
    return existing;
  }


  /*
   * FULL ADAPTIVE ANALYSIS.
   */

  const analysis =
    await fullAnalysis(
      history
    );


  if (
    !analysis.prediction
  ) {
    return null;
  }


  console.log(
    "================================"
  );

  console.log(
    "NEW V7 PREDICTION"
  );

  console.log(
    "CURRENT:",
    currentIssue
  );

  console.log(
    "TARGET:",
    targetIssue
  );

  console.log(
    "PREDICTION:",
    analysis.prediction
  );

  console.log(
    "CONFIDENCE:",
    analysis.confidence
  );

  console.log(
    "SCORE:",
    analysis.score
  );

  console.log(
    "CLASS:",
    analysis.classification
  );

  console.log(
    "DATA:",
    analysis.dataCount
  );

  console.log(
    "================================"
  );


  return savePrediction({
    targetIssue,
    prediction:
      analysis.prediction,
    confidence:
      analysis.confidence
  });
}


// ======================================================
// LIVE STATE
// ======================================================

let stateCache = {
  time: 0,
  state: null
};


async function getLiveState(
  force = false
) {

  if (
    !force &&
    stateCache.state &&
    now() -
      stateCache.time <
      700
  ) {

    return stateCache.state;
  }


  const raw =
    await fetchWingoHistory();


  const normalized =
    normalizeWingo(
      raw
    );


  const history =
    normalized.history;


  const currentIssue =
    normalized.currentIssue;


  /*
   * SETTLE FIRST.
   */

  const settled =
    await settlePredictions(
      history
    );


  /*
   * CREATE / GET CURRENT PREDICTION.
   */

  let predictionRecord =
    await createPredictionIfAllowed(
      currentIssue,
      history
    );


  /*
   * Retry after settlement.
   */

  if (
    settled > 0 &&
    !predictionRecord
  ) {

    predictionRecord =
      await createPredictionIfAllowed(
        currentIssue,
        history
      );
  }


  /*
   * Full analysis for API/admin.
   */

  const analysis =
    await fullAnalysis(
      history
    );


  /*
   * IMPORTANT:
   * Never hide pending prediction.
   */

  let prediction = null;
  let targetIssue = null;
  let confidence = 0;


  if (
    predictionRecord
  ) {

    prediction =
      predictionRecord.prediction;

    targetIssue =
      predictionRecord.target_issue;

    confidence =
      predictionRecord.confidence;

  } else {

    const latest =
      await getLatestPrediction();


    if (
      latest &&
      !latest.actual_result
    ) {

      prediction =
        latest.prediction;

      targetIssue =
        latest.target_issue;

      confidence =
        latest.confidence;
    }
  }


  const cooldown =
    await getCooldownStatus(
      history
    );


  const latest =
    await getLatestPrediction();


  const state = {

    ok: true,

    timestamp:
      now(),

    currentIssue,

    historyCount:
      history.length,

    history:
      history
        .slice(-30)
        .reverse(),

    model: {

      version:
        MODEL_VERSION,

      prediction,

      confidence,

      targetIssue,

      analysis,

      cooldown,

      lastPrediction:
        latest
    }
  };


  stateCache = {
    time: now(),
    state
  };


  return state;
}


// ======================================================
// USER AUTH
// ======================================================

async function authorizeUser(
  req
) {

  const key =
    safeString(
      req.headers[
        "x-access-key"
      ]
    );

  const device =
    safeString(
      req.headers[
        "x-device-id"
      ]
    );


  if (
    !key ||
    !device
  ) {

    return {
      ok: false,
      error:
        "Access key or device missing."
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
        "Invalid access key."
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
        "This key is already bound to another device."
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
    ok: true
  };
}


// ======================================================
// ADMIN
// ======================================================

function adminAuthorized(req) {
  return (
    safeString(
      req.headers[
        "x-admin-key"
      ]
    ) ===
    ADMIN_KEY
  );
}


function readBody(req) {

  return new Promise(
    resolve => {

      let body = "";

      req.on(
        "data",
        chunk => {
          body +=
            chunk.toString();
        }
      );

      req.on(
        "end",
        () => {
          try {
            resolve(
              body
                ? JSON.parse(body)
                : {}
            );
          } catch {
            resolve({});
          }
        }
      );
    }
  );
}


// ======================================================
// STATIC FILES
// ======================================================

function serveFile(
  res,
  filename,
  contentType
) {

  const filePath =
    path.join(
      __dirname,
      filename
    );


  if (
    !fs.existsSync(
      filePath
    )
  ) {

    return text(
      res,
      404,
      "File not found"
    );
  }


  const data =
    fs.readFileSync(
      filePath
    );


  res.writeHead(
    200,
    {
      "Content-Type":
        contentType,

      "Cache-Control":
        "no-store, no-cache, must-revalidate"
    }
  );


  res.end(data);
}


// ======================================================
// MUSIC
// ======================================================

function serveMusic(
  req,
  res
) {

  const filePath =
    path.join(
      __dirname,
      "music.mp3"
    );


  if (
    !fs.existsSync(
      filePath
    )
  ) {

    return text(
      res,
      404,
      "Music not found"
    );
  }


  const stat =
    fs.statSync(
      filePath
    );


  const range =
    req.headers.range;


  if (!range) {

    res.writeHead(
      200,
      {
        "Content-Type":
          "audio/mpeg",

        "Content-Length":
          stat.size,

        "Accept-Ranges":
          "bytes"
      }
    );


    return fs
      .createReadStream(
        filePath
      )
      .pipe(res);
  }


  const match =
    range.match(
      /bytes=(\d+)-(\d*)/
    );


  if (!match) {

    return text(
      res,
      416,
      "Invalid range"
    );
  }


  const start =
    Number(
      match[1]
    );


  const end =
    match[2]
      ? Number(match[2])
      : stat.size - 1;


  if (
    start >= stat.size ||
    end >= stat.size ||
    start > end
  ) {

    return text(
      res,
      416,
      "Range not satisfiable"
    );
  }


  const size =
    end - start + 1;


  res.writeHead(
    206,
    {
      "Content-Range":
        `bytes ${start}-${end}/${stat.size}`,

      "Accept-Ranges":
        "bytes",

      "Content-Length":
        size,

      "Content-Type":
        "audio/mpeg"
    }
  );


  fs
    .createReadStream(
      filePath,
      {
        start,
        end
      }
    )
    .pipe(res);
}


// ======================================================
// SERVER
// ======================================================

const server =
  http.createServer(
    async (
      req,
      res
    ) => {

      try {

        // ================================================
        // OPTIONS
        // ================================================

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

          return res.end();
        }


        const url =
          new URL(
            req.url,
            `http://${req.headers.host}`
          );


        // ================================================
        // HEALTH
        // ================================================

        if (
          url.pathname ===
          "/health"
        ) {

          return json(
            res,
            200,
            {
              ok: true,
              service:
                "DY AI WinGo V7",
              model:
                MODEL_VERSION,
              time:
                now()
            }
          );
        }


        // ================================================
        // KEY CHECK
        // ================================================

        if (
          url.pathname ===
            "/api/key/check" &&
          req.method ===
            "GET"
        ) {

          const auth =
            await authorizeUser(
              req
            );


          return json(
            res,
            auth.ok
              ? 200
              : 401,
            auth
          );
        }


        // ================================================
        // STATE
        // ================================================

        if (
          url.pathname ===
            "/api/state" &&
          req.method ===
            "GET"
        ) {

          const auth =
            await authorizeUser(
              req
            );


          if (!auth.ok) {

            return json(
              res,
              401,
              auth
            );
          }


          const state =
            await getLiveState(
              false
            );


          return json(
            res,
            200,
            state
          );
        }


        // ================================================
        // HISTORY
        // ================================================

        if (
          url.pathname ===
            "/api/history" &&
          req.method ===
            "GET"
        ) {

          const state =
            await getLiveState(
              false
            );


          return json(
            res,
            200,
            {
              ok: true,

              currentIssue:
                state.currentIssue,

              history:
                state.history
            }
          );
        }


        // ================================================
        // ADMIN
        // ================================================

        if (
          url.pathname.startsWith(
            "/api/admin/"
          )
        ) {

          if (
            !adminAuthorized(
              req
            )
          ) {

            return json(
              res,
              401,
              {
                ok: false,
                error:
                  "Unauthorized"
              }
            );
          }


          // ==============================================
          // PING
          // ==============================================

          if (
            url.pathname ===
              "/api/admin/ping" &&
            req.method ===
              "GET"
          ) {

            return json(
              res,
              200,
              {
                ok: true,
                admin: true,
                model:
                  MODEL_VERSION
              }
            );
          }


          // ==============================================
          // STATUS
          // ==============================================

          if (
            url.pathname ===
              "/api/admin/status" &&
            req.method ===
              "GET"
          ) {

            const state =
              await getLiveState(
                true
              );


            const keys =
              await pool.query(`
                SELECT
                  COUNT(*)::int AS count
                FROM access_keys
              `);


            return json(
              res,
              200,
              {
                ...state,

                keys:
                  keys.rows[0].count
              }
            );
          }


          // ==============================================
          // GET KEYS
          // ==============================================

          if (
            url.pathname ===
              "/api/admin/keys" &&
            req.method ===
              "GET"
          ) {

            const result =
              await pool.query(`
                SELECT
                  id,
                  access_key,
                  device_id,
                  created_at,
                  last_seen
                FROM access_keys
                ORDER BY id DESC
              `);


            return json(
              res,
              200,
              {
                ok: true,
                keys:
                  result.rows
              }
            );
          }


          // ==============================================
          // CREATE KEY
          // ==============================================

          if (
            url.pathname ===
              "/api/admin/keys" &&
            req.method ===
              "POST"
          ) {

            const body =
              await readBody(
                req
              );


            let key =
              safeString(
                body.key
              );


            if (!key) {

              key =
                "DY-" +
                crypto
                  .randomBytes(8)
                  .toString(
                    "hex"
                  )
                  .toUpperCase();
            }


            if (
              key.length < 4
            ) {

              return json(
                res,
                400,
                {
                  ok: false,
                  error:
                    "Key too short."
                }
              );
            }


            try {

              const result =
                await pool.query(
                  `
                  INSERT INTO access_keys
                  (
                    access_key,
                    created_at
                  )

                  VALUES
                  ($1,$2)

                  RETURNING *
                  `,
                  [
                    key,
                    now()
                  ]
                );


              return json(
                res,
                200,
                {
                  ok: true,
                  key:
                    result.rows[0]
                }
              );

            } catch {

              return json(
                res,
                400,
                {
                  ok: false,
                  error:
                    "Key already exists."
                }
              );
            }
          }


          // ==============================================
          // DELETE KEY
          // ==============================================

          if (
            url.pathname ===
              "/api/admin/keys" &&
            req.method ===
              "DELETE"
          ) {

            const body =
              await readBody(
                req
              );


            const key =
              safeString(
                body.key
              );


            if (!key) {

              return json(
                res,
                400,
                {
                  ok: false,
                  error:
                    "Key required."
                }
              );
            }


            await pool.query(
              `
              DELETE FROM access_keys
              WHERE access_key = $1
              `,
              [key]
            );


            return json(
              res,
              200,
              {
                ok: true
              }
            );
          }


          // ==============================================
          // RESET DEVICE
          // ==============================================

          if (
            url.pathname ===
              "/api/admin/reset-device" &&
            req.method ===
              "POST"
          ) {

            const body =
              await readBody(
                req
              );


            const key =
              safeString(
                body.key
              );


            await pool.query(
              `
              UPDATE access_keys

              SET
                device_id = NULL,
                last_seen = 0

              WHERE access_key = $1
              `,
              [key]
            );


            return json(
              res,
              200,
              {
                ok: true
              }
            );
          }


          // ==============================================
          // WINGO TEST
          // ==============================================

          if (
            url.pathname ===
              "/api/admin/wingo-test" &&
            req.method ===
              "GET"
          ) {

            try {

              const raw =
                await fetchWingoHistory();


              const normalized =
                normalizeWingo(
                  raw
                );


              return json(
                res,
                200,
                {
                  ok: true,

                  currentIssue:
                    normalized.currentIssue,

                  count:
                    normalized.history.length,

                  sample:
                    normalized.history
                      .slice(-5)
                      .reverse()
                }
              );

            } catch (
              error
            ) {

              return json(
                res,
                500,
                {
                  ok: false,
                  error:
                    error.message
                }
              );
            }
          }


          // ==============================================
          // MODEL TEST
          // ==============================================

          if (
            url.pathname ===
              "/api/admin/model-test" &&
            req.method ===
              "GET"
          ) {

            try {

              const state =
                await getLiveState(
                  true
                );


              return json(
                res,
                200,
                {
                  ok: true,

                  currentIssue:
                    state.currentIssue,

                  historyCount:
                    state.historyCount,

                  model:
                    state.model
                }
              );

            } catch (
              error
            ) {

              return json(
                res,
                500,
                {
                  ok: false,
                  error:
                    error.message
                }
              );
            }
          }


          return json(
            res,
            404,
            {
              ok: false,
              error:
                "Admin endpoint not found."
            }
          );
        }


        // ================================================
        // PREDICTION PAGE
        // ================================================

        if (
          url.pathname === "/" ||
          url.pathname ===
            "/prediction.html"
        ) {

          return serveFile(
            res,
            "prediction.html",
            "text/html; charset=utf-8"
          );
        }


        // ================================================
        // ADMIN PAGE
        // ================================================

        if (
          url.pathname ===
          "/admin.html"
        ) {

          return serveFile(
            res,
            "admin.html",
            "text/html; charset=utf-8"
          );
        }


        // ================================================
        // MUSIC
        // ================================================

        if (
          url.pathname ===
          "/music.mp3"
        ) {

          return serveMusic(
            req,
            res
          );
        }


        return text(
          res,
          404,
          "Not Found"
        );

      } catch (
        error
      ) {

        console.error(
          "SERVER ERROR:",
          error
        );


        return json(
          res,
          500,
          {
            ok: false,

            error:
              "Internal server error",

            message:
              error.message
          }
        );
      }
    }
  );


// ======================================================
// START
// ======================================================

(async () => {

  try {

    await initDB();


    server.listen(
      PORT,
      "0.0.0.0",
      () => {

        console.log(
          `DY AI WinGo V7 running on port ${PORT}`
        );

      }
    );

  } catch (
    error
  ) {

    console.error(
      "STARTUP ERROR:",
      error
    );

    process.exit(1);
  }

})();
