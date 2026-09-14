const http = require("http");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 10000);

const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_KEY = process.env.ADMIN_KEY || "dy4427574";
const WINGOBOT_TOKEN = process.env.WINGOBOT_TOKEN;

const WINGOBOT_URL =
  "https://api.wingobot.com/v2/30-sec-game-history";

const MODEL_VERSION = "DY-AI-ADAPTIVE-V9";
const COOLDOWN_ROUNDS = 5;


/* ======================================================
   DATABASE
====================================================== */

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL
    ? { rejectUnauthorized: false }
    : undefined,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});


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


/* ======================================================
   HELPERS
====================================================== */

function now() {
  return Date.now();
}


function safeString(value) {
  return String(value ?? "").trim();
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


/* ======================================================
   SAFE ISSUE NUMBER
====================================================== */

function issueDigits(issue) {
  const value = safeString(issue);
  const digits = value.replace(/\D/g, "");
  return digits || null;
}


function issueBigInt(issue) {
  const digits = issueDigits(issue);

  if (!digits) return null;

  try {
    return BigInt(digits);
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

  if (A.length >= 6 && B.length >= 6) {
    if (A.slice(-6) === B.slice(-6)) {
      return true;
    }
  }

  return A.endsWith(B) || B.endsWith(A);
}


function nextIssue(issue) {
  const value = safeString(issue);

  const match = value.match(/(\d+)$/);

  if (!match) return null;

  const suffix = match[1];

  const prefix = value.slice(
    0,
    value.length - suffix.length
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


/* ======================================================
   BIG / SMALL
====================================================== */

function numberToSide(number) {
  const n = Number(number);

  if (
    !Number.isInteger(n) ||
    n < 0 ||
    n > 9
  ) {
    return null;
  }

  return n >= 5 ? "BIG" : "SMALL";
}


function sideCode(side) {
  return side === "BIG" ? "B" : "S";
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


/* ======================================================
   WINGOBOT
====================================================== */

async function fetchWingoHistory() {
  if (!WINGOBOT_TOKEN) {
    throw new Error(
      "WINGOBOT_TOKEN missing"
    );
  }

  const controller =
    new AbortController();

  const timer = setTimeout(
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
    clearTimeout(timer);
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

  const history = [];

  for (const row of rows) {
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
      continue;
    }

    history.push({
      issue: String(issue),
      number: n,
      result: numberToSide(n),
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
    });
  }


  const unique = [];
  const seen = new Set();

  for (const row of history) {
    const key =
      issueDigits(row.issue) ||
      row.issue;

    if (seen.has(key)) {
      continue;
    }

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


  let liveIssue =
    currentIssue
      ? String(currentIssue)
      : null;


  if (!liveIssue && unique.length) {
    liveIssue =
      unique[
        unique.length - 1
      ].issue;
  }


  return {
    currentIssue: liveIssue,
    history: unique
  };
}


/* ======================================================
   COUNT
====================================================== */

function countSides(seq) {
  let BIG = 0;
  let SMALL = 0;

  for (const x of seq) {
    if (x === "B") BIG++;
    if (x === "S") SMALL++;
  }

  const total = BIG + SMALL;

  return {
    BIG,
    SMALL,
    total,
    BIGPercent:
      total
        ? BIG / total * 100
        : 50,
    SMALLPercent:
      total
        ? SMALL / total * 100
        : 50
  };
}


/* ======================================================
   STREAK
====================================================== */

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
  const runs = getRuns(seq);

  if (!runs.length) {
    return {
      average: 0,
      median: 0,
      longestBIG: 0,
      longestSMALL: 0,
      common: 0
    };
  }

  const lengths =
    runs.map(x => x.length);

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

  let common = lengths[0];

  for (
    const key of Object.keys(
      frequency
    )
  ) {
    if (
      frequency[key] >
      frequency[common]
    ) {
      common = Number(key);
    }
  }

  return {
    average:
      lengths.reduce(
        (a, b) => a + b,
        0
      ) / lengths.length,

    median,

    longestBIG:
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

    longestSMALL:
      Math.max(
        0,
        ...runs
          .filter(
            x => x.side === "S"
          )
          .map(
            x => x.length
          )
      ),

    common
  };
}


/* ======================================================
   SWITCHING
====================================================== */

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


/* ======================================================
   TRANSITIONS
====================================================== */

function transitionStats(seq) {
  const matrix = {
    BB: 0,
    BS: 0,
    SB: 0,
    SS: 0
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

  const afterBIG =
    matrix.BB +
    matrix.BS;

  const afterSMALL =
    matrix.SB +
    matrix.SS;

  return {
    matrix,

    afterBIG: {
      BIG:
        afterBIG
          ? matrix.BB /
            afterBIG
          : 0.5,

      SMALL:
        afterBIG
          ? matrix.BS /
            afterBIG
          : 0.5
    },

    afterSMALL: {
      BIG:
        afterSMALL
          ? matrix.SB /
            afterSMALL
          : 0.5,

      SMALL:
        afterSMALL
          ? matrix.SS /
            afterSMALL
          : 0.5
    }
  };
}


/* ======================================================
   MOMENTUM
====================================================== */

function momentumStats(seq) {
  if (seq.length < 10) {
    return {
      classification:
        "LOW DATA",
      difference: 0
    };
  }

  const recent =
    countSides(
      seq.slice(-5)
    );

  const previous =
    countSides(
      seq.slice(-10, -5)
    );

  const difference =
    recent.BIGPercent -
    previous.BIGPercent;

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
    difference,
    recent,
    previous
  };
}


/* ======================================================
   ALTERNATION
====================================================== */

function alternationStats(seq) {
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


/* ======================================================
   REPEATING BLOCK
====================================================== */

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


/* ======================================================
   DIGIT ANALYSIS
====================================================== */

function digitStats(numbers) {
  const frequency =
    Array(10).fill(0);

  const lastGap =
    Array(10).fill(null);

  for (
    const n of numbers
  ) {
    if (
      Number.isInteger(n)
    ) {
      frequency[n]++;
    }
  }

  for (
    let i = numbers.length - 1;
    i >= 0;
    i--
  ) {
    const n =
      numbers[i];

    if (
      lastGap[n] === null
    ) {
      lastGap[n] =
        numbers.length -
        1 -
        i;
    }
  }

  return {
    frequency,
    lastGap,

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


/* ======================================================
   PATTERN FOLLOW
====================================================== */

function patternFollow(
  seq,
  size
) {
  if (
    seq.length <
    size + 2
  ) {
    return {
      matches: 0,
      BIG: 0,
      SMALL: 0
    };
  }

  const pattern =
    seq.slice(-size);

  let matches = 0;
  let BIG = 0;
  let SMALL = 0;

  for (
    let i = size;
    i < seq.length;
    i++
  ) {
    const previous =
      seq.slice(
        i - size,
        i
      );

    if (
      previous.join("") ===
      pattern.join("")
    ) {
      matches++;

      if (
        seq[i] === "B"
      ) {
        BIG++;
      } else {
        SMALL++;
      }
    }
  }

  return {
    matches,
    BIG,
    SMALL
  };
}


/* ======================================================
   WALK FORWARD
====================================================== */

function walkPrediction(
  seq,
  index
) {
  if (index < 8) {
    return null;
  }

  const before =
    seq.slice(
      0,
      index
    );

  const w5 =
    countSides(
      before.slice(-5)
    );

  const w10 =
    countSides(
      before.slice(-10)
    );

  let BIG = 0;
  let SMALL = 0;

  BIG +=
    (
      w5.BIGPercent -
      50
    ) * 0.8;

  SMALL +=
    (
      w5.SMALLPercent -
      50
    ) * 0.8;

  BIG +=
    (
      w10.BIGPercent -
      50
    ) * 0.35;

  SMALL +=
    (
      w10.SMALLPercent -
      50
    ) * 0.35;

  const last =
    before[
      before.length - 1
    ];

  const transition =
    transitionStats(
      before
    );

  if (last === "B") {

    BIG +=
      transition.afterBIG.BIG *
      10;

    SMALL +=
      transition.afterBIG.SMALL *
      10;

  } else {

    BIG +=
      transition.afterSMALL.BIG *
      10;

    SMALL +=
      transition.afterSMALL.SMALL *
      10;
  }

  return BIG >= SMALL
    ? "B"
    : "S";
}


function backtest(seq) {
  const data = {
    BIG: {
      attempts: 0,
      wins: 0
    },

    SMALL: {
      attempts: 0,
      wins: 0
    }
  };

  if (
    seq.length < 12
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

  let total = 0;
  let wins = 0;

  for (
    let i = 8;
    i < seq.length;
    i++
  ) {

    const prediction =
      walkPrediction(
        seq,
        i
      );

    if (!prediction) {
      continue;
    }

    const actual =
      seq[i];

    const side =
      prediction === "B"
        ? "BIG"
        : "SMALL";

    data[side].attempts++;

    total++;

    if (
      prediction === actual
    ) {
      data[side].wins++;
      wins++;
    }
  }

  return {
    BIG: {
      attempts:
        data.BIG.attempts,

      wins:
        data.BIG.wins,

      accuracy:
        data.BIG.attempts
          ? data.BIG.wins /
            data.BIG.attempts
          : 0.5
    },

    SMALL: {
      attempts:
        data.SMALL.attempts,

      wins:
        data.SMALL.wins,

      accuracy:
        data.SMALL.attempts
          ? data.SMALL.wins /
            data.SMALL.attempts
          : 0.5
    },

    overall:
      total
        ? wins / total
        : 0.5
  };
}


/* ======================================================
   RECENT MODEL PERFORMANCE
====================================================== */

async function recentPerformance() {
  const result =
    await pool.query(`
      SELECT
        prediction,
        actual_result

      FROM prediction_records

      WHERE actual_result IN
        ('WIN','LOSS')

      ORDER BY id DESC

      LIMIT 20
    `);

  const data = {
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

    data[side].attempts++;

    if (
      row.actual_result ===
      "WIN"
    ) {
      data[side].wins++;
    }
  }

  return {
    BIG: {
      attempts:
        data.BIG.attempts,

      wins:
        data.BIG.wins,

      accuracy:
        data.BIG.attempts
          ? data.BIG.wins /
            data.BIG.attempts
          : 0.5
    },

    SMALL: {
      attempts:
        data.SMALL.attempts,

      wins:
        data.SMALL.wins,

      accuracy:
        data.SMALL.attempts
          ? data.SMALL.wins /
            data.SMALL.attempts
          : 0.5
    }
  };
}


/* ======================================================
   FULL ADAPTIVE MODEL
====================================================== */

async function fullAnalysis(
  history
) {

  const ordered =
    history
      .slice()
      .sort(
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
      n =>
        sideCode(
          numberToSide(n)
        )
    );

  const total =
    seq.length;


  /*
   * Minimum data.
   */

  if (
    total < 5
  ) {
    return {
      prediction: null,
      confidence: 0,
      classification:
        "INSUFFICIENT DATA",
      dataCount: total
    };
  }


  /* -----------------------------------------------
     WINDOWS
  ----------------------------------------------- */

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
      countSides(
        seq.slice(-size)
      );
  }


  const global =
    countSides(seq);

  const current =
    currentStreak(seq);

  const runs =
    runStats(seq);

  const switching =
    switchingStats(seq);

  const transitions =
    transitionStats(seq);

  const momentum =
    momentumStats(seq);

  const alternation =
    alternationStats(seq);

  const repeating =
    repeatingBlocks(seq);

  const digits =
    digitStats(numbers);

  const P3 =
    patternFollow(
      seq,
      3
    );

  const P4 =
    patternFollow(
      seq,
      4
    );

  const P5 =
    patternFollow(
      seq,
      5
    );

  const historical =
    backtest(seq);


  let live;

  try {

    live =
      await recentPerformance();

  } catch {

    live = {
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


  /* -----------------------------------------------
     SCORE
  ----------------------------------------------- */

  let BIG = 0;
  let SMALL = 0;


  /*
   * Recent 5
   */

  BIG +=
    (
      windows[5].BIGPercent -
      50
    ) * 0.30;

  SMALL +=
    (
      windows[5].SMALLPercent -
      50
    ) * 0.30;


  /*
   * Recent 10
   */

  BIG +=
    (
      windows[10].BIGPercent -
      50
    ) * 0.20;

  SMALL +=
    (
      windows[10].SMALLPercent -
      50
    ) * 0.20;


  /*
   * Recent 20
   */

  BIG +=
    (
      windows[20].BIGPercent -
      50
    ) * 0.12;

  SMALL +=
    (
      windows[20].SMALLPercent -
      50
    ) * 0.12;


  /*
   * Global
   */

  BIG +=
    (
      global.BIGPercent -
      50
    ) * 0.08;

  SMALL +=
    (
      global.SMALLPercent -
      50
    ) * 0.08;


  /*
   * Transition
   */

  if (
    current.side === "B"
  ) {

    BIG +=
      transitions.afterBIG.BIG *
      14;

    SMALL +=
      transitions.afterBIG.SMALL *
      14;

  } else {

    BIG +=
      transitions.afterSMALL.BIG *
      14;

    SMALL +=
      transitions.afterSMALL.SMALL *
      14;
  }


  /*
   * Momentum
   */

  if (
    momentum.classification ===
    "BIG MOMENTUM"
  ) {
    BIG += 6;
  }

  if (
    momentum.classification ===
    "SMALL MOMENTUM"
  ) {
    SMALL += 6;
  }

  if (
    momentum.classification ===
    "BIG LEAN"
  ) {
    BIG += 3;
  }

  if (
    momentum.classification ===
    "SMALL LEAN"
  ) {
    SMALL += 3;
  }


  /*
   * Pattern 3
   */

  if (
    P3.matches >= 2
  ) {

    BIG +=
      (
        P3.BIG /
        P3.matches
      ) * 10;

    SMALL +=
      (
        P3.SMALL /
        P3.matches
      ) * 10;
  }


  /*
   * Pattern 4
   */

  if (
    P4.matches >= 2
  ) {

    BIG +=
      (
        P4.BIG /
        P4.matches
      ) * 8;

    SMALL +=
      (
        P4.SMALL /
        P4.matches
      ) * 8;
  }


  /*
   * Pattern 5
   */

  if (
    P5.matches >= 2
  ) {

    BIG +=
      (
        P5.BIG /
        P5.matches
      ) * 7;

    SMALL +=
      (
        P5.SMALL /
        P5.matches
      ) * 7;
  }


  /*
   * Streak
   *
   * Streak is evidence only,
   * not guaranteed reversal.
   */

  if (
    current.length >= 3
  ) {

    const boost =
      Math.min(
        7,
        current.length *
        1.15
      );

    if (
      current.side === "B"
    ) {

      BIG += boost;

    } else {

      SMALL += boost;
    }
  }


  /*
   * Switching
   */

  if (
    switching.classification ===
    "HIGH SWITCHING"
  ) {

    if (
      current.side === "B"
    ) {

      SMALL += 4;

    } else {

      BIG += 4;
    }

  } else if (
    switching.classification ===
    "STREAK DOMINANT"
  ) {

    if (
      current.side === "B"
    ) {

      BIG += 3;

    } else {

      SMALL += 3;
    }
  }


  /*
   * Alternation
   */

  if (
    alternation.active
  ) {

    if (
      current.side === "B"
    ) {

      SMALL += 3;

    } else {

      BIG += 3;
    }
  }


  /*
   * Repeating block
   */

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
      last === "B"
    ) {

      BIG += 2;

    } else {

      SMALL += 2;
    }
  }


  /*
   * Historical backtest
   */

  BIG +=
    (
      historical.BIG.accuracy -
      0.5
    ) * 22;

  SMALL +=
    (
      historical.SMALL.accuracy -
      0.5
    ) * 22;


  /*
   * Live performance
   */

  if (
    live.BIG.attempts >= 3
  ) {

    BIG +=
      (
        live.BIG.accuracy -
        0.5
      ) * 18;
  }

  if (
    live.SMALL.attempts >= 3
  ) {

    SMALL +=
      (
        live.SMALL.accuracy -
        0.5
      ) * 18;
  }


  /* -----------------------------------------------
     ANTI-STUCK
  ----------------------------------------------- */

  let sameCount = 0;
  let previousSide = null;


  try {

    const result =
      await pool.query(`
        SELECT prediction

        FROM prediction_records

        WHERE actual_result IN
          ('WIN','LOSS')

        ORDER BY id DESC

        LIMIT 6
      `);


    for (
      const row of result.rows
    ) {

      const side =
        row.prediction === "BIG"
          ? "BIG"
          : "SMALL";


      if (
        previousSide === null
      ) {

        previousSide =
          side;

        sameCount = 1;

      } else if (
        side === previousSide
      ) {

        sameCount++;

      } else {

        break;
      }
    }

  } catch {
    sameCount = 0;
  }


  /*
   * Do NOT force alternation.
   *
   * Only penalize if the model
   * has been stuck on one side.
   */

  if (
    sameCount >= 3
  ) {

    const penalty =
      8 +
      (
        sameCount - 3
      ) * 2;


    if (
      previousSide === "BIG"
    ) {

      BIG -= penalty;

    } else if (
      previousSide === "SMALL"
    ) {

      SMALL -= penalty;
    }
  }


  /* -----------------------------------------------
     CONFLICT
  ----------------------------------------------- */

  const recentGap =
    Math.abs(
      windows[5].BIGPercent -
      windows[5].SMALLPercent
    );

  const globalGap =
    Math.abs(
      global.BIGPercent -
      global.SMALLPercent
    );

  let conflictPenalty = 0;


  if (
    recentGap < 10 &&
    globalGap < 10
  ) {
    conflictPenalty = 5;
  }


  BIG -= conflictPenalty;
  SMALL -= conflictPenalty;


  /* -----------------------------------------------
     SAMPLE SIZE
  ----------------------------------------------- */

  let samplePenalty = 0;

  if (total < 10) {
    samplePenalty = 7;
  } else if (total < 20) {
    samplePenalty = 4;
  }

  BIG -= samplePenalty;
  SMALL -= samplePenalty;


  /* -----------------------------------------------
     NORMALIZE
  ----------------------------------------------- */

  const rawBIG =
    Math.max(
      0,
      50 + BIG
    );

  const rawSMALL =
    Math.max(
      0,
      50 + SMALL
    );

  const scoreTotal =
    rawBIG +
    rawSMALL;

  const bigPercent =
    scoreTotal
      ? rawBIG /
        scoreTotal *
        100
      : 50;

  const smallPercent =
    scoreTotal
      ? rawSMALL /
        scoreTotal *
        100
      : 50;


  /* -----------------------------------------------
     FINAL DECISION
  ----------------------------------------------- */

  let prediction;

  if (
    bigPercent >
    smallPercent
  ) {

    prediction =
      "BIG";

  } else if (
    smallPercent >
    bigPercent
  ) {

    prediction =
      "SMALL";

  } else {

    prediction =
      historical.BIG.accuracy >=
      historical.SMALL.accuracy
        ? "BIG"
        : "SMALL";
  }


  /* -----------------------------------------------
     CLASSIFICATION
  ----------------------------------------------- */

  const difference =
    Math.abs(
      bigPercent -
      smallPercent
    );

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
    sameCount >= 3
  ) {

    classification +=
      " + ANTI-STUCK";
  }


  /* -----------------------------------------------
     CONFIDENCE
  ----------------------------------------------- */

  let confidence =
    50 +
    difference * 1.55;


  const selectedHistorical =
    prediction === "BIG"
      ? historical.BIG
      : historical.SMALL;


  if (
    selectedHistorical.accuracy >=
    0.60
  ) {

    confidence += 4;

  } else if (
    selectedHistorical.accuracy <
    0.45
  ) {

    confidence -= 5;
  }


  const selectedLive =
    prediction === "BIG"
      ? live.BIG
      : live.SMALL;


  if (
    selectedLive.attempts >= 3
  ) {

    if (
      selectedLive.accuracy >=
      0.60
    ) {

      confidence += 3;

    } else if (
      selectedLive.accuracy <
      0.40
    ) {

      confidence -= 5;
    }
  }


  if (total < 10) {
    confidence -= 10;
  } else if (total < 20) {
    confidence -= 6;
  } else if (total < 30) {
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


  return {

    prediction,

    confidence,

    classification,

    dataCount:
      total,

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
          rawBIG.toFixed(2)
        ),

      SMALL:
        Number(
          rawSMALL.toFixed(2)
        )
    },

    windows,

    global,

    current,

    runs,

    switching,

    transitions,

    momentum,

    alternation,

    repeating,

    digits,

    patterns: {

      P3,

      P4,

      P5
    },

    historical,

    live,

    sameCount,

    conflictPenalty,

    samplePenalty
  };
}


/* ======================================================
   PREDICTION RECORDS
====================================================== */

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


async function findExistingPrediction(
  targetIssue
) {

  const exact =
    await pool.query(
      `
      SELECT *
      FROM prediction_records

      WHERE target_issue = $1

      LIMIT 1
      `,
      [
        String(targetIssue)
      ]
    );


  if (
    exact.rows.length
  ) {
    return exact.rows[0];
  }


  const recent =
    await pool.query(`
      SELECT *
      FROM prediction_records

      ORDER BY id DESC

      LIMIT 100
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


async function savePrediction(
  targetIssue,
  prediction,
  confidence
) {

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


/* ======================================================
   SETTLEMENT
====================================================== */

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


/* ======================================================
   STALE PREDICTIONS
====================================================== */

async function cleanupStale(
  currentIssue,
  history
) {

  const current =
    issueBigInt(
      currentIssue
    );


  if (
    current === null
  ) {
    return;
  }


  const result =
    await pool.query(`
      SELECT *
      FROM prediction_records

      WHERE actual_result IS NULL

      ORDER BY id ASC
    `);


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


    if (actual) {
      continue;
    }


    const target =
      issueBigInt(
        prediction.target_issue
      );


    if (
      target === null
    ) {
      continue;
    }


    if (
      target < current
    ) {

      await pool.query(
        `
        UPDATE prediction_records

        SET
          actual_result = 'SKIPPED',
          settled_at = $1

        WHERE id = $2
        `,
        [
          now(),
          prediction.id
        ]
      );
    }
  }
}


/* ======================================================
   COOLDOWN
====================================================== */

function completedAfter(
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

    const issue =
      issueBigInt(
        row.issue
      );


    if (
      issue !== null &&
      issue > target
    ) {

      count++;
    }
  }


  return count;
}


async function getCooldown(
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
      lastPrediction: null
    };
  }


  /*
   * Current prediction.
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
      lastPrediction: latest
    };
  }


  /*
   * SKIPPED doesn't block.
   */

  if (
    latest.actual_result ===
    "SKIPPED"
  ) {

    return {
      active: false,
      pending: false,
      completedRounds:
        COOLDOWN_ROUNDS,
      waitRounds: 0,
      requiredRounds:
        COOLDOWN_ROUNDS,
      lastPrediction: latest
    };
  }


  const completed =
    completedAfter(
      history,
      latest.target_issue
    );


  const wait =
    Math.max(
      0,
      COOLDOWN_ROUNDS -
      completed
    );


  return {
    active:
      wait > 0,

    pending: false,

    completedRounds:
      Math.min(
        COOLDOWN_ROUNDS,
        completed
      ),

    waitRounds:
      wait,

    requiredRounds:
      COOLDOWN_ROUNDS,

    lastPrediction:
      latest
  };
}


/* ======================================================
   CREATE PREDICTION
====================================================== */

async function createPrediction(
  currentIssue,
  history
) {

  if (!currentIssue) {
    return null;
  }


  await settlePredictions(
    history
  );


  const latest =
    await getLatestPrediction();


  /*
   * Pending current prediction.
   */

  if (
    latest &&
    !latest.actual_result
  ) {

    const current =
      issueBigInt(
        currentIssue
      );

    const target =
      issueBigInt(
        latest.target_issue
      );


    if (
      current !== null &&
      target !== null &&
      target >= current
    ) {

      return latest;
    }


    /*
     * Old/broken pending record.
     */

    await pool.query(
      `
      UPDATE prediction_records

      SET
        actual_result = 'SKIPPED',
        settled_at = $1

      WHERE id = $2
      `,
      [
        now(),
        latest.id
      ]
    );
  }


  const cooldown =
    await getCooldown(
      history
    );


  if (
    cooldown.active
  ) {
    return null;
  }


  /*
   * Exact next issue.
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

    if (
      !existing.actual_result
    ) {
      return existing;
    }

    return null;
  }


  /*
   * FULL ANALYSIS.
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
    "=========================================="
  );

  console.log(
    "DY AI NEW PREDICTION"
  );

  console.log(
    "MODEL:",
    MODEL_VERSION
  );

  console.log(
    "CURRENT ISSUE:",
    currentIssue
  );

  console.log(
    "TARGET ISSUE:",
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
    "CLASSIFICATION:",
    analysis.classification
  );

  console.log(
    "DATA:",
    analysis.dataCount
  );

  console.log(
    "=========================================="
  );


  return savePrediction(
    targetIssue,
    analysis.prediction,
    analysis.confidence
  );
}


/* ======================================================
   LIVE STATE
====================================================== */

let stateCache = {
  timestamp: 0,
  state: null
};


async function getLiveState(
  force = false
) {

  if (
    !force &&
    stateCache.state &&
    now() -
      stateCache.timestamp <
      700
  ) {

    return stateCache.state;
  }


  /*
   * LIVE API.
   */

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
   * SETTLE OLD.
   */

  await settlePredictions(
    history
  );


  /*
   * CLEAN BROKEN.
   */

  await cleanupStale(
    currentIssue,
    history
  );


  /*
   * GET/CREATE PREDICTION.
   */

  let predictionRecord =
    await createPrediction(
      currentIssue,
      history
    );


  /*
   * Retry.
   */

  if (
    !predictionRecord
  ) {

    predictionRecord =
      await createPrediction(
        currentIssue,
        history
      );
  }


  /*
   * Full analysis.
   */

  const analysis =
    await fullAnalysis(
      history
    );


  let prediction = null;
  let targetIssue = null;
  let confidence = 0;


  /*
   * Main prediction.
   */

  if (
    predictionRecord &&
    !predictionRecord.actual_result
  ) {

    const current =
      issueBigInt(
        currentIssue
      );

    const target =
      issueBigInt(
        predictionRecord.target_issue
      );


    if (
      current !== null &&
      target !== null &&
      target >= current
    ) {

      prediction =
        predictionRecord.prediction;

      targetIssue =
        predictionRecord.target_issue;

      confidence =
        Number(
          predictionRecord.confidence ||
          0
        );
    }
  }


  /*
   * Extra fallback.
   */

  if (
    !prediction
  ) {

    const latest =
      await getLatestPrediction();


    if (
      latest &&
      !latest.actual_result
    ) {

      const current =
        issueBigInt(
          currentIssue
        );

      const target =
        issueBigInt(
          latest.target_issue
        );


      if (
        current !== null &&
        target !== null &&
        target >= current
      ) {

        prediction =
          latest.prediction;

        targetIssue =
          latest.target_issue;

        confidence =
          Number(
            latest.confidence ||
            0
          );
      }
    }
  }


  /*
   * Final creation fallback.
   */

  if (
    !prediction
  ) {

    const cooldown =
      await getCooldown(
        history
      );


    if (
      !cooldown.active &&
      !cooldown.pending &&
      analysis.prediction &&
      currentIssue
    ) {

      const candidate =
        nextIssue(
          currentIssue
        );


      if (candidate) {

        try {

          const saved =
            await savePrediction(
              candidate,
              analysis.prediction,
              analysis.confidence
            );


          if (
            saved &&
            !saved.actual_result
          ) {

            prediction =
              saved.prediction;

            targetIssue =
              saved.target_issue;

            confidence =
              Number(
                saved.confidence ||
                0
              );
          }

        } catch(error) {

          console.error(
            "Fallback save error:",
            error.message
          );


          /*
           * Frontend fallback only.
           */

          prediction =
            analysis.prediction;

          targetIssue =
            candidate;

          confidence =
            analysis.confidence;
        }
      }
    }
  }


  const cooldown =
    await getCooldown(
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

      targetIssue,

      confidence,

      analysis,

      cooldown,

      lastPrediction:
        latest
    }
  };


  stateCache = {
    timestamp:
      now(),

    state
  };


  return state;
}


/* ======================================================
   USER AUTH
====================================================== */

async function authorizeUser(
  req
) {

  const accessKey =
    safeString(
      req.headers[
        "x-access-key"
      ]
    );

  const deviceId =
    safeString(
      req.headers[
        "x-device-id"
      ]
    );


  if (
    !accessKey ||
    !deviceId
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
      [
        accessKey
      ]
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
    row.device_id !== deviceId
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
        deviceId,
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


/* ======================================================
   ADMIN
====================================================== */

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


/* ======================================================
   BODY
====================================================== */

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


/* ======================================================
   STATIC FILE
====================================================== */

function serveFile(
  res,
  filename,
  contentType
) {

  const file =
    path.join(
      __dirname,
      filename
    );


  if (
    !fs.existsSync(file)
  ) {

    return text(
      res,
      404,
      "File not found"
    );
  }


  const data =
    fs.readFileSync(file);


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


/* ======================================================
   MUSIC
====================================================== */

function serveMusic(
  req,
  res
) {

  const file =
    path.join(
      __dirname,
      "music.mp3"
    );


  if (
    !fs.existsSync(file)
  ) {

    return text(
      res,
      404,
      "Music not found"
    );
  }


  const stat =
    fs.statSync(file);


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
      .createReadStream(file)
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


  const length =
    end - start + 1;


  res.writeHead(
    206,
    {
      "Content-Type":
        "audio/mpeg",

      "Content-Length":
        length,

      "Content-Range":
        `bytes ${start}-${end}/${stat.size}`,

      "Accept-Ranges":
        "bytes"
    }
  );


  fs
    .createReadStream(
      file,
      {
        start,
        end
      }
    )
    .pipe(res);
}


/* ======================================================
   SERVER
====================================================== */

const server =
  http.createServer(
    async (
      req,
      res
    ) => {

      try {

        /* -----------------------------------------------
           OPTIONS
        ----------------------------------------------- */

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


        /* -----------------------------------------------
           HEALTH
        ----------------------------------------------- */

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
                "DY AI WinGo",

              model:
                MODEL_VERSION,

              time:
                now()
            }
          );
        }


        /* -----------------------------------------------
           KEY CHECK
        ----------------------------------------------- */

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


        /* -----------------------------------------------
           STATE
        ----------------------------------------------- */

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


        /* -----------------------------------------------
           HISTORY
        ----------------------------------------------- */

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


        /* -----------------------------------------------
           ADMIN
        ----------------------------------------------- */

        if (
          url.pathname.startsWith(
            "/api/admin/"
          )
        ) {

          if (
            !adminAuthorized(req)
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


          /* =============================================
             PING
          ============================================= */

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
                  MODEL_VERSION,
                time:
                  now()
              }
            );
          }


          /* =============================================
             STATUS
          ============================================= */

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
                  COUNT(*)::int AS total,

                  COUNT(
                    device_id
                  )::int AS bound

                FROM access_keys
              `);


            const predictions =
              await pool.query(`
                SELECT
                  COUNT(*)::int AS total,

                  COUNT(*) FILTER (
                    WHERE actual_result = 'WIN'
                  )::int AS wins,

                  COUNT(*) FILTER (
                    WHERE actual_result = 'LOSS'
                  )::int AS losses,

                  COUNT(*) FILTER (
                    WHERE actual_result IS NULL
                  )::int AS pending

                FROM prediction_records
              `);


            return json(
              res,
              200,
              {
                ok: true,

                model:
                  MODEL_VERSION,

                currentIssue:
                  state.currentIssue,

                historyCount:
                  state.historyCount,

                prediction:
                  state.model.prediction,

                targetIssue:
                  state.model.targetIssue,

                confidence:
                  state.model.confidence,

                keys:
                  keys.rows[0],

                predictions:
                  predictions.rows[0]
              }
            );
          }


          /* =============================================
             KEYS GET
          ============================================= */

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


          /* =============================================
             CREATE KEY
          ============================================= */

          if (
            url.pathname ===
              "/api/admin/keys" &&
            req.method ===
              "POST"
          ) {

            const body =
              await readBody(req);


            let key =
              safeString(
                body.key
              );


            if (!key) {

              key =
                "DY-" +
                Math.random()
                  .toString(36)
                  .slice(2, 10)
                  .toUpperCase() +
                "-" +
                Math.random()
                  .toString(36)
                  .slice(2, 8)
                  .toUpperCase();
            }


            const existing =
              await pool.query(
                `
                SELECT id

                FROM access_keys

                WHERE access_key = $1
                `,
                [key]
              );


            if (
              existing.rows.length
            ) {

              return json(
                res,
                409,
                {
                  ok: false,
                  error:
                    "Key already exists."
                }
              );
            }


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
          }


          /* =============================================
             DELETE KEY
          ============================================= */

          if (
            url.pathname ===
              "/api/admin/keys" &&
            req.method ===
              "DELETE"
          ) {

            const id =
              Number(
                url.searchParams.get(
                  "id"
                )
              );


            if (
              !Number.isInteger(id)
            ) {

              return json(
                res,
                400,
                {
                  ok: false,
                  error:
                    "Invalid key id."
                }
              );
            }


            await pool.query(
              `
              DELETE FROM access_keys

              WHERE id = $1
              `,
              [id]
            );


            return json(
              res,
              200,
              {
                ok: true
              }
            );
          }


          /* =============================================
             RESET DEVICE
          ============================================= */

          if (
            url.pathname ===
              "/api/admin/reset-device" &&
            req.method ===
              "POST"
          ) {

            const body =
              await readBody(req);


            const id =
              Number(
                body.id
              );


            if (
              !Number.isInteger(id)
            ) {

              return json(
                res,
                400,
                {
                  ok: false,
                  error:
                    "Invalid key id."
                }
              );
            }


            await pool.query(
              `
              UPDATE access_keys

              SET
                device_id = NULL,
                last_seen = 0

              WHERE id = $1
              `,
              [id]
            );


            return json(
              res,
              200,
              {
                ok: true
              }
            );
          }


          /* =============================================
             WINGO TEST
          ============================================= */

          if (
            url.pathname ===
              "/api/admin/wingo-test" &&
            req.method ===
              "GET"
          ) {

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

                historyCount:
                  normalized.history.length,

                history:
                  normalized.history
                    .slice(-30)
                    .reverse()
              }
            );
          }


          /* =============================================
             MODEL TEST
          ============================================= */

          if (
            url.pathname ===
              "/api/admin/model-test" &&
            req.method ===
              "GET"
          ) {

            const raw =
              await fetchWingoHistory();


            const normalized =
              normalizeWingo(
                raw
              );


            const analysis =
              await fullAnalysis(
                normalized.history
              );


            return json(
              res,
              200,
              {
                ok: true,

                model:
                  MODEL_VERSION,

                currentIssue:
                  normalized.currentIssue,

                analysis
              }
            );
          }


          /* =============================================
             PREDICTION HISTORY
          ============================================= */

          if (
            url.pathname ===
              "/api/admin/predictions" &&
            req.method ===
              "GET"
          ) {

            const result =
              await pool.query(`
                SELECT *
                FROM prediction_records

                ORDER BY id DESC

                LIMIT 100
              `);


            return json(
              res,
              200,
              {
                ok: true,

                predictions:
                  result.rows
              }
            );
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


        /* -----------------------------------------------
           STATIC
        ----------------------------------------------- */

        if (
          url.pathname ===
          "/"
        ) {

          return serveFile(
            res,
            "prediction.html",
            "text/html; charset=utf-8"
          );
        }


        if (
          url.pathname ===
          "/prediction.html"
        ) {

          return serveFile(
            res,
            "prediction.html",
            "text/html; charset=utf-8"
          );
        }


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
          "Not found"
        );

      } catch(error) {

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
              error.message ||
              "Internal server error."
          }
        );
      }
    }
  );


/* ======================================================
   START
====================================================== */

async function start() {

  try {

    await initDB();


    server.listen(
      PORT,
      "0.0.0.0",
      () => {

        console.log(
          "=========================================="
        );

        console.log(
          "DY AI WINGO SERVER STARTED"
        );

        console.log(
          "PORT:",
          PORT
        );

        console.log(
          "MODEL:",
          MODEL_VERSION
        );

        console.log(
          "COOLDOWN:",
          COOLDOWN_ROUNDS,
          "ROUNDS"
        );

        console.log(
          "=========================================="
        );
      }
    );

  } catch(error) {

    console.error(
      "STARTUP ERROR:",
      error
    );

    process.exit(1);
  }
}


start();


/* ======================================================
   PROCESS SAFETY
====================================================== */

process.on(
  "unhandledRejection",
  error => {
    console.error(
      "UNHANDLED REJECTION:",
      error
    );
  }
);


process.on(
  "uncaughtException",
  error => {
    console.error(
      "UNCAUGHT EXCEPTION:",
      error
    );
  }
);
