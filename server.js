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
const MODEL_VERSION = "OWN-FULL-ANALYSIS-V6";


// ======================================================
// DATABASE
// ======================================================

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


// ======================================================
// BASIC HELPERS
// ======================================================

function now() {
  return Date.now();
}


function safeString(value) {
  return String(value ?? "").trim();
}


function json(res, status, data) {

  const body = JSON.stringify(data);

  res.writeHead(status, {
    "Content-Type":
      "application/json; charset=utf-8",

    "Cache-Control":
      "no-store, no-cache, must-revalidate",

    "Pragma":
      "no-cache",

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


// ======================================================
// ISSUE NUMBER SAFE LOGIC
// ======================================================

function issueDigits(issue) {

  const s = safeString(issue);

  const digits =
    s.replace(/\D/g, "");

  return digits || null;
}


function issueBigInt(issue) {

  const digits =
    issueDigits(issue);

  if (!digits) {
    return null;
  }

  try {
    return BigInt(digits);
  } catch {
    return null;
  }
}


function compareIssues(a, b) {

  const A = issueBigInt(a);
  const B = issueBigInt(b);

  if (A === null || B === null) {
    return 0;
  }

  if (A < B) return -1;
  if (A > B) return 1;

  return 0;
}


/*
 * Handles:
 *
 * 202609111000050282
 * ->
 * 202609111000050283
 *
 * WITHOUT JavaScript Number precision loss.
 */

function nextIssue(issue) {

  const s = safeString(issue);

  if (!s) {
    return null;
  }

  const match =
    s.match(/(\d+)$/);

  if (!match) {
    return null;
  }

  const suffix = match[1];

  const prefix =
    s.slice(
      0,
      s.length - suffix.length
    );

  try {

    let next =
      (BigInt(suffix) + 1n)
        .toString();

    if (
      next.length <
      suffix.length
    ) {
      next =
        next.padStart(
          suffix.length,
          "0"
        );
    }

    return prefix + next;

  } catch {

    return null;
  }
}


/*
 * Handles old records too.
 *
 * Example:
 *
 * 202609111000050276
 * 50276
 *
 * are treated as the same issue.
 */

function sameIssue(a, b) {

  const A =
    issueDigits(a);

  const B =
    issueDigits(b);

  if (!A || !B) {
    return false;
  }

  if (A === B) {
    return true;
  }

  if (
    A.endsWith(B) ||
    B.endsWith(A)
  ) {
    return true;
  }

  return false;
}


function numberToAB(number) {

  const n = Number(number);

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
// WINGOBOT API
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

        const n =
          Number(number);

        if (
          issue === undefined ||
          !Number.isInteger(n) ||
          n < 0 ||
          n > 9
        ) {
          return null;
        }

        return {

          issue:
            String(issue),

          number:
            n,

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

  for (
    const row of history
  ) {

    const key =
      issueDigits(
        row.issue
      ) ||
      row.issue;

    if (
      seen.has(key)
    ) {
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

  return {

    currentIssue:
      currentIssue
        ? String(currentIssue)
        : unique.length
          ? unique[
              unique.length - 1
            ].issue
          : null,

    history:
      unique
  };
}


// ======================================================
// ANALYSIS FUNCTIONS
// ======================================================

function countAB(seq) {

  let A = 0;
  let B = 0;

  for (
    const x of seq
  ) {

    if (x === "A") A++;
    if (x === "B") B++;
  }

  const total =
    A + B;

  return {

    A,
    B,
    total,

    APercent:
      total
        ? (A / total) * 100
        : 0,

    BPercent:
      total
        ? (B / total) * 100
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
    seq[
      seq.length - 1
    ];

  let length = 0;

  for (
    let i = seq.length - 1;
    i >= 0;
    i--
  ) {

    if (
      seq[i] !== side
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


function getRuns(seq) {

  if (!seq.length) {
    return [];
  }

  const runs = [];

  let side =
    seq[0];

  let length = 1;

  for (
    let i = 1;
    i < seq.length;
    i++
  ) {

    if (
      seq[i] === side
    ) {

      length++;

    } else {

      runs.push({
        side,
        length
      });

      side =
        seq[i];

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

  for (
    const n of lengths
  ) {

    frequency[n] =
      (frequency[n] || 0) + 1;
  }

  let common =
    lengths[0];

  for (
    const key of Object.keys(
      frequency
    )
  ) {

    if (
      frequency[key] >
      frequency[common]
    ) {

      common =
        Number(key);
    }
  }

  return {

    average:
      lengths.reduce(
        (a, b) => a + b,
        0
      ) /
      lengths.length,

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

  if (
    seq.length < 2
  ) {

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

  if (
    rate > 60
  ) {

    classification =
      "HIGH SWITCHING";

  } else if (
    rate >= 40
  ) {

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
      matrix.AA /
      afterA;

    next.afterA.B =
      matrix.AB /
      afterA;
  }

  if (afterB) {

    next.afterB.A =
      matrix.BA /
      afterB;

    next.afterB.B =
      matrix.BB /
      afterB;
  }

  return {
    matrix,
    next
  };
}


function momentumAnalysis(seq) {

  if (
    seq.length < 10
  ) {

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

  if (
    difference >= 25
  ) {

    classification =
      "BIG MOMENTUM";

  } else if (
    difference <= -25
  ) {

    classification =
      "SMALL MOMENTUM";

  } else if (
    difference >= 10
  ) {

    classification =
      "BIG LEAN";

  } else if (
    difference <= -10
  ) {

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

  if (
    seq.length < 4
  ) {

    return {
      active: false,
      length: 0,
      break: false
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

    length,

    break:
      length >= 4 &&
      seq[
        seq.length - 1
      ] ===
      seq[
        seq.length - 2
      ]
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

    const last =
      seq
        .slice(-size)
        .join("");

    const previous =
      seq
        .slice(
          -size * 2,
          -size
        )
        .join("");

    if (
      last === previous
    ) {

      result.push({
        length: size,
        pattern: last
      });
    }
  }

  return result;
}


function digitAnalysis(numbers) {

  const frequency =
    Array(10).fill(0);

  for (
    const n of numbers
  ) {

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


function historicalSequence(seq) {

  if (
    seq.length < 6
  ) {

    return {

      matches: 0,

      afterA: 0,

      afterB: 0,

      support: null
    };
  }

  const pattern =
    seq.slice(-5);

  let matches = 0;
  let afterA = 0;
  let afterB = 0;

  for (
    let i = 5;
    i < seq.length - 1;
    i++
  ) {

    const previous =
      seq.slice(
        i - 5,
        i
      );

    if (
      previous.join("") ===
      pattern.join("")
    ) {

      matches++;

      if (
        seq[i] === "A"
      ) {

        afterA++;

      } else {

        afterB++;
      }
    }
  }

  return {

    matches,

    afterA,

    afterB,

    support:
      matches
        ? {
            A:
              afterA /
              matches,

            B:
              afterB /
              matches
          }
        : null
  };
}


// ======================================================
// FULL MODEL
// ======================================================

function fullAnalysis(history) {

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


  /*
   * We need enough history
   * for a meaningful analysis.
   */

  if (
    total < 5
  ) {

    return {

      prediction: null,

      confidence: 0,

      classification:
        "INSUFFICIENT DATA",

      score: {
        BIG: 0,
        SMALL: 0
      },

      dataCount:
        total
    };
  }


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

  const recent5 =
    windows[5];

  const recent10 =
    windows[10];

  const recent20 =
    windows[20];


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

  const historical =
    historicalSequence(seq);


  let bigScore = 50;
  let smallScore = 50;


  // ====================================================
  // 1. RECENT WINDOWS
  // ====================================================

  bigScore +=
    (recent5.BPercent - 50) *
    0.22;

  smallScore +=
    (recent5.APercent - 50) *
    0.22;


  bigScore +=
    (recent10.BPercent - 50) *
    0.13;

  smallScore +=
    (recent10.APercent - 50) *
    0.13;


  bigScore +=
    (recent20.BPercent - 50) *
    0.10;

  smallScore +=
    (recent20.APercent - 50) *
    0.10;


  // ====================================================
  // 2. GLOBAL FREQUENCY
  // ====================================================

  bigScore +=
    (stats.BPercent - 50) *
    0.10;

  smallScore +=
    (stats.APercent - 50) *
    0.10;


  // ====================================================
  // 3. SWITCHING
  // ====================================================

  if (
    switching.classification ===
    "HIGH SWITCHING"
  ) {

    if (
      current.side === "A"
    ) {

      bigScore += 5;

    } else {

      smallScore += 5;
    }

  } else if (
    switching.classification ===
    "STREAK DOMINANT"
  ) {

    if (
      current.side === "A"
    ) {

      smallScore += 4;

    } else {

      bigScore += 4;
    }
  }


  // ====================================================
  // 4. TRANSITION MATRIX
  // ====================================================

  if (
    current.side === "A"
  ) {

    bigScore +=
      transition.next.afterA.B *
      14;

    smallScore +=
      transition.next.afterA.A *
      14;

  } else {

    bigScore +=
      transition.next.afterB.B *
      14;

    smallScore +=
      transition.next.afterB.A *
      14;
  }


  // ====================================================
  // 5. MOMENTUM
  // ====================================================

  if (
    momentum.classification ===
    "BIG MOMENTUM"
  ) {

    bigScore += 7;
  }


  if (
    momentum.classification ===
    "SMALL MOMENTUM"
  ) {

    smallScore += 7;
  }


  if (
    momentum.classification ===
    "BIG LEAN"
  ) {

    bigScore += 3;
  }


  if (
    momentum.classification ===
    "SMALL LEAN"
  ) {

    smallScore += 3;
  }


  // ====================================================
  // 6. HISTORICAL SEQUENCE
  // ====================================================

  if (
    historical.matches >= 2 &&
    historical.support
  ) {

    bigScore +=
      historical.support.B *
      10;

    smallScore +=
      historical.support.A *
      10;
  }


  // ====================================================
  // 7. ALTERNATION
  // ====================================================

  if (
    alternation.active
  ) {

    if (
      current.side === "A"
    ) {

      bigScore += 5;

    } else {

      smallScore += 5;
    }
  }


  // ====================================================
  // 8. REPEATING BLOCK
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

      bigScore += 2;

    } else {

      smallScore += 2;
    }
  }


  // ====================================================
  // 9. STREAK STRUCTURE
  // ====================================================

  if (
    current.length >= 4
  ) {

    if (
      current.side === "A"
    ) {

      /*
       * Reversal WATCH only.
       * Never treat it as guaranteed.
       */

      bigScore +=
        Math.min(
          10,
          current.length * 2
        );

      smallScore +=
        Math.min(
          8,
          current.length * 1.5
        );

    } else {

      bigScore +=
        Math.min(
          8,
          current.length * 1.5
        );

      smallScore +=
        Math.min(
          10,
          current.length * 2
        );
    }
  }


  // ====================================================
  // 10. VERY LONG STREAK
  // ====================================================

  if (
    current.length >= 7
  ) {

    if (
      current.side === "A"
    ) {

      bigScore += 7;

    } else {

      smallScore += 7;
    }
  }


  // ====================================================
  // FINAL
  // ====================================================

  const difference =
    Math.abs(
      bigScore -
      smallScore
    );


  let classification;


  if (
    difference < 5
  ) {

    classification =
      "NO CLEAR SIGNAL";

  } else if (
    difference < 10
  ) {

    classification =
      "WEAK HISTORICAL BIAS";

  } else if (
    difference < 18
  ) {

    classification =
      "MODERATE HISTORICAL BIAS";

  } else {

    classification =
      "STRONG HISTORICAL BIAS";
  }


  let prediction =
    bigScore >= smallScore
      ? "BIG"
      : "SMALL";


  /*
   * Always return a prediction
   * when >=5 valid results exist.
   */

  let confidence =
    50 +
    Math.min(
      40,
      difference * 1.55
    );


  if (
    total < 10
  ) {

    confidence -= 10;

  } else if (
    total < 20
  ) {

    confidence -= 7;

  } else if (
    total < 30
  ) {

    confidence -= 4;
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

    score: {

      BIG:
        Number(
          bigScore.toFixed(2)
        ),

      SMALL:
        Number(
          smallScore.toFixed(2)
        )
    },

    stats,

    current,

    switching,

    transition,

    momentum,

    runs,

    alternation,

    repeating,

    digits,

    historical,

    windows,

    dataCount:
      total
  };
}


// ======================================================
// PREDICTION DATABASE
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


/*
 * Also checks old/short issue
 * formats to avoid duplicate predictions.
 */

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


  const match =
    recent.rows.find(
      row =>
        sameIssue(
          row.target_issue,
          targetIssue
        )
    );


  return match || null;
}


async function savePrediction({
  targetIssue,
  prediction,
  confidence
}) {

  const target =
    String(
      targetIssue
    );


  const existing =
    await findExistingPrediction(
      target
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
        target,
        prediction,
        confidence,
        MODEL_VERSION,
        now()
      ]
    );


  return result.rows[0];
}


// ======================================================
// SETTLE PREDICTIONS
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


    const actualResult =
      actual.result;


    const outcome =
      actualResult ===
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
// COUNT COMPLETED ROUNDS
// ======================================================

function completedRoundsAfter(
  history,
  targetIssue
) {

  /*
   * First use exact/suffix matching.
   * This is important for old records.
   */

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

    /*
     * History is chronological:
     * oldest -> newest
     */

    return Math.max(
      0,
      history.length -
      index -
      1
    );
  }


  /*
   * Fallback for issue formats
   * that cannot be matched.
   */

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


// ======================================================
// COOLDOWN STATUS
// ======================================================

async function getCooldownStatus(
  history
) {

  const latest =
    await getLatestPrediction();


  if (!latest) {

    return {

      active: false,

      completedRounds: 0,

      waitRounds: 0,

      requiredRounds:
        COOLDOWN_ROUNDS,

      lastPrediction:
        null
    };
  }


  /*
   * Pending prediction:
   *
   * It is currently the active
   * prediction and should be shown.
   *
   * It is NOT treated as the
   * 5-round waiting period yet.
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
// CREATE NEW PREDICTION
// ======================================================

async function createPredictionIfAllowed(
  currentIssue,
  history
) {

  if (!currentIssue) {
    return null;
  }


  /*
   * Check latest prediction.
   */

  const latest =
    await getLatestPrediction();


  /*
   * If latest prediction is still
   * pending, return it.
   *
   * This is the MAIN V6 FIX.
   */

  if (
    latest &&
    !latest.actual_result
  ) {

    return latest;
  }


  /*
   * If latest was settled,
   * count the 5 completed rounds.
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
   * Next issue.
   */

  const targetIssue =
    nextIssue(
      currentIssue
    );


  if (!targetIssue) {
    return null;
  }


  /*
   * Prevent duplicate target.
   */

  const existing =
    await findExistingPrediction(
      targetIssue
    );


  if (existing) {
    return existing;
  }


  /*
   * FULL fresh analysis.
   */

  const analysis =
    fullAnalysis(
      history
    );


  if (
    !analysis.prediction
  ) {
    return null;
  }


  console.log(
    "NEW ANALYSIS",
    {
      currentIssue,
      targetIssue,
      prediction:
        analysis.prediction,
      confidence:
        analysis.confidence,
      classification:
        analysis.classification,
      data:
        analysis.dataCount
    }
  );


  /*
   * Save prediction.
   */

  const saved =
    await savePrediction({

      targetIssue,

      prediction:
        analysis.prediction,

      confidence:
        analysis.confidence
    });


  return saved;
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

  /*
   * Small cache to prevent
   * duplicate API calls.
   */

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
   * Settle old prediction FIRST.
   */

  const settled =
    await settlePredictions(
      history
    );


  /*
   * Create/return current prediction.
   */

  let predictionRecord =
    await createPredictionIfAllowed(
      currentIssue,
      history
    );


  /*
   * If a new result was settled,
   * try again after settlement.
   *
   * This ensures the next target
   * can be created immediately after
   * cooldown completes.
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
   * Fresh full analysis.
   */

  const analysis =
    fullAnalysis(
      history
    );


  /*
   * IMPORTANT:
   *
   * Do NOT call getCooldownStatus()
   * and then hide a newly-created
   * pending prediction.
   *
   * Pending prediction must remain
   * visible.
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
  }


  /*
   * If create returned null,
   * check latest DB record.
   */

  if (
    !predictionRecord
  ) {

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


  /*
   * Only after deciding what to show,
   * calculate cooldown.
   */

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


  /*
   * Bind first device.
   */

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
// ADMIN AUTH
// ======================================================

function adminAuthorized(
  req
) {

  return (
    safeString(
      req.headers[
        "x-admin-key"
      ]
    ) ===
    ADMIN_KEY
  );
}


// ======================================================
// REQUEST BODY
// ======================================================

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
// HTTP SERVER
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
                "DY AI WinGo V6",

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
        // USER STATE
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
        // ADMIN ROUTES
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
          // ADMIN PING
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
          // ADMIN STATUS
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

                  model:
                    state.model,

                  currentIssue:
                    state.currentIssue,

                  historyCount:
                    state.historyCount
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
// START SERVER
// ======================================================

(async () => {

  try {

    await initDB();


    server.listen(
      PORT,
      "0.0.0.0",
      () => {

        console.log(
          `DY AI WinGo V6 running on port ${PORT}`
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
