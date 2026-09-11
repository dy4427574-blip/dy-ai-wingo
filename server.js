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

const THINKING_DURATION_MS = 3000;
const COOLDOWN_ROUNDS = 5;

if (!DATABASE_URL) {
  console.error("DATABASE_URL is missing.");
}

if (!WINGOBOT_TOKEN) {
  console.error("WINGOBOT_TOKEN is missing.");
}

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
  if (!DATABASE_URL) return;

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

  console.log("Database ready.");
}


// ======================================================
// BASIC HELPERS
// ======================================================

function json(res, status, data) {
  const body = JSON.stringify(data);

  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "Content-Type, X-Access-Key, X-Device-Id, X-Admin-Key",
    "Access-Control-Allow-Methods":
      "GET, POST, DELETE, OPTIONS"
  });

  res.end(body);
}

function text(res, status, data, contentType = "text/plain") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });

  res.end(data);
}

function now() {
  return Date.now();
}

function safeString(value) {
  return String(value ?? "").trim();
}

function issueNumberPart(issue) {
  const s = safeString(issue);
  const m = s.match(/\d+/g);

  if (!m || !m.length) {
    return null;
  }

  return Number(m[m.length - 1]);
}

function numberToAB(number) {
  const n = Number(number);

  if (!Number.isInteger(n) || n < 0 || n > 9) {
    return null;
  }

  return n >= 5 ? "B" : "A";
}

function abToType(ab) {
  return ab === "B" ? "BIG" : "SMALL";
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
    throw new Error("WINGOBOT_TOKEN missing");
  }

  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    8000
  );

  try {
    const response = await fetch(
      WINGOBOT_URL,
      {
        method: "GET",
        headers: {
          Authorization:
            `Bearer ${WINGOBOT_TOKEN}`,
          Accept: "application/json"
        },
        signal: controller.signal
      }
    );

    if (!response.ok) {
      throw new Error(
        `Wingo API HTTP ${response.status}`
      );
    }

    const data = await response.json();

    return data;

  } finally {
    clearTimeout(timeout);
  }
}


function normalizeWingo(data) {
  const currentIssue =
    data?.current?.issueNumber ||
    data?.currentIssue ||
    null;

  const rows =
    Array.isArray(data?.history)
      ? data.history
      : Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data?.results)
          ? data.results
          : [];

  const history = rows
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
        result: abToType(
          numberToAB(n)
        ),
        colour:
          row?.colour ??
          row?.color ??
          null,
        premium:
          row?.premium ?? null,
        sum:
          row?.sum ?? null
      };
    })
    .filter(Boolean);

  const unique = [];
  const seen = new Set();

  for (const row of history) {
    if (seen.has(row.issue)) continue;

    seen.add(row.issue);
    unique.push(row);
  }

  unique.sort(
    (a, b) =>
      (issueNumberPart(a.issue) ?? 0) -
      (issueNumberPart(b.issue) ?? 0)
  );

  return {
    currentIssue:
      currentIssue
        ? String(currentIssue)
        : unique.length
          ? unique[unique.length - 1].issue
          : null,

    history: unique
  };
}


// ======================================================
// ANALYSIS HELPERS
// ======================================================

function countAB(seq) {
  let A = 0;
  let B = 0;

  for (const x of seq) {
    if (x === "A") A++;
    else if (x === "B") B++;
  }

  const total = A + B;

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
  const runs = [];

  if (!seq.length) return runs;

  let side = seq[0];
  let length = 1;

  for (let i = 1; i < seq.length; i++) {

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
      longestA: 0,
      longestB: 0,
      common: 0
    };
  }

  const lengths =
    runs.map(r => r.length);

  const sorted =
    [...lengths].sort(
      (a, b) => a - b
    );

  const mid =
    Math.floor(
      sorted.length / 2
    );

  const median =
    sorted.length % 2
      ? sorted[mid]
      : (
          sorted[mid - 1] +
          sorted[mid]
        ) / 2;

  const frequency = {};

  for (const n of lengths) {
    frequency[n] =
      (frequency[n] || 0) + 1;
  }

  let common = lengths[0];

  for (const n of Object.keys(frequency)) {
    if (
      frequency[n] >
      (frequency[common] || 0)
    ) {
      common = Number(n);
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
          .filter(r => r.side === "A")
          .map(r => r.length)
      ),

    longestB:
      Math.max(
        0,
        ...runs
          .filter(r => r.side === "B")
          .map(r => r.length)
      ),

    common
  };
}


function switchingStats(seq) {
  if (seq.length < 2) {
    return {
      switches: 0,
      rate: 0,
      classification: "LOW DATA"
    };
  }

  let switches = 0;

  for (let i = 1; i < seq.length; i++) {
    if (seq[i] !== seq[i - 1]) {
      switches++;
    }
  }

  const rate =
    (switches / (seq.length - 1)) * 100;

  let classification =
    "STREAK DOMINANT";

  if (rate > 60) {
    classification = "HIGH SWITCHING";
  } else if (rate >= 40) {
    classification = "BALANCED";
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

  for (let i = 1; i < seq.length; i++) {
    matrix[
      seq[i - 1] + seq[i]
    ]++;
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

  if (matrix.AA + matrix.AB > 0) {
    next.afterA.A =
      matrix.AA /
      (matrix.AA + matrix.AB);

    next.afterA.B =
      matrix.AB /
      (matrix.AA + matrix.AB);
  }

  if (matrix.BA + matrix.BB > 0) {
    next.afterB.A =
      matrix.BA /
      (matrix.BA + matrix.BB);

    next.afterB.B =
      matrix.BB /
      (matrix.BA + matrix.BB);
  }

  return {
    matrix,
    next
  };
}


function momentumAnalysis(seq) {
  if (seq.length < 10) {
    return {
      classification: "LOW DATA",
      recent: null,
      previous: null
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

  const diff =
    r.BPercent -
    p.BPercent;

  let classification =
    "STABLE";

  if (diff >= 25) {
    classification =
      "BIG MOMENTUM";
  } else if (diff <= -25) {
    classification =
      "SMALL MOMENTUM";
  } else if (diff >= 10) {
    classification =
      "BIG LEAN";
  } else if (diff <= -10) {
    classification =
      "SMALL LEAN";
  }

  return {
    classification,
    recent: r,
    previous: p,
    difference: diff
  };
}


function alternationAnalysis(seq) {
  if (seq.length < 4) {
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
    active: length >= 4,
    length,
    break:
      length >= 4 &&
      seq[seq.length - 1] ===
      seq[seq.length - 2]
  };
}


function repeatingBlocks(seq) {
  const found = [];

  for (let size = 2; size <= 6; size++) {

    if (seq.length < size * 2) {
      continue;
    }

    const last =
      seq.slice(-size)
        .join("");

    const prev =
      seq
        .slice(
          -size * 2,
          -size
        )
        .join("");

    if (last === prev) {
      found.push({
        length: size,
        pattern: last
      });
    }
  }

  return found;
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

  const total =
    numbers.length;

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
      total
        ? numbers.reduce(
            (a, b) => a + b,
            0
          ) / total
        : 0
  };
}


function historicalSequence(seq) {
  if (seq.length < 6) {
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
  let nextA = 0;
  let nextB = 0;

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
        nextA++;
      } else {
        nextB++;
      }
    }
  }

  return {
    matches,
    afterA: nextA,
    afterB: nextB,

    support:
      matches
        ? {
            A:
              nextA / matches,
            B:
              nextB / matches
          }
        : null
  };
}


// ======================================================
// FULL MODEL
// ======================================================

function fullAnalysis(history) {

  const chronological =
    [...history]
      .sort(
        (a, b) =>
          (issueNumberPart(a.issue) ?? 0) -
          (issueNumberPart(b.issue) ?? 0)
      );

  const numbers =
    cleanNumbers(
      chronological.map(
        x => x.number
      )
    );

  const seq =
    numbers.map(
      numberToAB
    );

  const total =
    seq.length;

  if (total < 10) {
    return {
      prediction: null,
      confidence: 0,

      classification:
        "INSUFFICIENT DATA",

      score: {
        BIG: 0,
        SMALL: 0
      },

      stats: countAB(seq),

      current:
        currentStreak(seq),

      switching:
        switchingStats(seq),

      momentum:
        momentumAnalysis(seq),

      transition:
        transitions(seq),

      runs:
        runStats(seq),

      alternation:
        alternationAnalysis(seq),

      repeating:
        repeatingBlocks(seq),

      digits:
        digitAnalysis(numbers),

      historical:
        historicalSequence(seq),

      dataCount: total
    };
  }


  const windows = {};

  for (const size of [
    5,
    10,
    20,
    30,
    50,
    100
  ]) {

    const part =
      seq.slice(-size);

    windows[size] =
      countAB(part);
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

  const runs =
    runStats(seq);

  const switching =
    switchingStats(seq);

  const transition =
    transitions(seq);

  const momentum =
    momentumAnalysis(seq);

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


  // ----------------------------------------------------
  // RECENT WINDOWS
  // ----------------------------------------------------

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


  // ----------------------------------------------------
  // GLOBAL FREQUENCY
  // ----------------------------------------------------

  bigScore +=
    (stats.BPercent - 50) *
    0.10;

  smallScore +=
    (stats.APercent - 50) *
    0.10;


  // ----------------------------------------------------
  // SWITCHING
  // ----------------------------------------------------

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


  // ----------------------------------------------------
  // TRANSITION
  // ----------------------------------------------------

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


  // ----------------------------------------------------
  // MOMENTUM
  // ----------------------------------------------------

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


  // ----------------------------------------------------
  // HISTORICAL PATTERN
  // ----------------------------------------------------

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


  // ----------------------------------------------------
  // ALTERNATION
  // ----------------------------------------------------

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


  // ----------------------------------------------------
  // REPEATING BLOCK
  // ----------------------------------------------------

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

    if (last === "A") {
      bigScore += 2;
    } else {
      smallScore += 2;
    }
  }


  // ----------------------------------------------------
  // LONG STREAK PROTECTION
  // ----------------------------------------------------

  if (
    current.length >= 4
  ) {

    if (
      current.side === "A"
    ) {

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

    } else {

      smallScore +=
        Math.min(
          8,
          current.length * 1.5
        );

      bigScore +=
        Math.min(
          10,
          current.length * 2
        );
    }
  }


  // ----------------------------------------------------
  // EXTREME STREAK
  // ----------------------------------------------------

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


  // ----------------------------------------------------
  // CONTRADICTION / CONFLICT
  // ----------------------------------------------------

  const difference =
    Math.abs(
      bigScore -
      smallScore
    );


  let classification =
    "MIXED / CONFLICTING";


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


  // ----------------------------------------------------
  // PREDICTION
  // ----------------------------------------------------

  let prediction;

  if (
    bigScore >
    smallScore
  ) {
    prediction = "BIG";
  } else {
    prediction = "SMALL";
  }


  // ----------------------------------------------------
  // CONFIDENCE
  // ----------------------------------------------------

  let confidence =
    50 +
    Math.min(
      40,
      difference * 1.55
    );


  // sample penalty
  if (total < 20) {
    confidence -= 8;
  } else if (total < 30) {
    confidence -= 4;
  }


  // conflict penalty
  if (
    difference < 5
  ) {
    confidence -= 12;
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

    momentum,

    transition,

    runs,

    alternation,

    repeating,

    digits,

    historical,

    windows,

    dataCount: total
  };
}


// ======================================================
// DATABASE PREDICTIONS
// ======================================================

async function getLatestPrediction() {

  if (!DATABASE_URL) {
    return null;
  }

  const result =
    await pool.query(`
      SELECT *
      FROM prediction_records
      ORDER BY id DESC
      LIMIT 1
    `);

  return result.rows[0] || null;
}


async function savePrediction({
  targetIssue,
  prediction,
  confidence
}) {

  if (!DATABASE_URL) {
    return null;
  }

  const existing =
    await pool.query(
      `
      SELECT *
      FROM prediction_records
      WHERE target_issue = $1
      LIMIT 1
      `,
      [String(targetIssue)]
    );

  if (existing.rows.length) {
    return existing.rows[0];
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
        "OWN-FULL-ANALYSIS-V4",
        now()
      ]
    );

  return result.rows[0];
}


function completedRoundsAfter(
  history,
  targetIssue
) {

  const target =
    issueNumberPart(
      targetIssue
    );

  if (target === null) {
    return 0;
  }

  return history.filter(
    row => {

      const n =
        issueNumberPart(
          row.issue
        );

      return (
        n !== null &&
        n > target
      );
    }
  ).length;
}


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
        COOLDOWN_ROUNDS
    };
  }


  // Previous prediction still pending
  if (
    !latest.actual_result
  ) {

    return {
      active: true,
      completedRounds: 0,
      waitRounds:
        COOLDOWN_ROUNDS,
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
// SETTLE
// ======================================================

async function settlePredictions(
  history
) {

  if (!DATABASE_URL) {
    return;
  }

  const pending =
    await pool.query(`
      SELECT *
      FROM prediction_records
      WHERE actual_result IS NULL
      ORDER BY id ASC
    `);


  for (
    const prediction
    of pending.rows
  ) {

    const actual =
      history.find(
        row =>
          String(row.issue) ===
          String(
            prediction.target_issue
          )
      );


    if (!actual) {
      continue;
    }


    const actualType =
      actual.result;


    const outcome =
      actualType ===
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
  }
}


// ======================================================
// CREATE NEW PREDICTION
// ======================================================

async function createPredictionIfAllowed(
  currentIssue,
  history
) {

  if (!DATABASE_URL) {
    return null;
  }


  const cooldown =
    await getCooldownStatus(
      history
    );


  if (
    cooldown.active
  ) {
    return null;
  }


  const targetNumber =
    issueNumberPart(
      currentIssue
    );


  if (
    targetNumber === null
  ) {
    return null;
  }


  const targetIssue =
    String(
      targetNumber + 1
    );


  const existing =
    await pool.query(
      `
      SELECT *
      FROM prediction_records
      WHERE target_issue = $1
      LIMIT 1
      `,
      [targetIssue]
    );


  if (
    existing.rows.length
  ) {

    return existing.rows[0];
  }


  const analysis =
    fullAnalysis(
      history
    );


  if (
    !analysis.prediction
  ) {
    return null;
  }


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


  const raw =
    await fetchWingoHistory();


  const normalized =
    normalizeWingo(raw);


  const history =
    normalized.history;


  await settlePredictions(
    history
  );


  const currentIssue =
    normalized.currentIssue;


  let predictionRecord =
    null;


  if (currentIssue) {

    predictionRecord =
      await createPredictionIfAllowed(
        currentIssue,
        history
      );
  }


  const analysis =
    fullAnalysis(
      history
    );


  const cooldown =
    await getCooldownStatus(
      history
    );


  // IMPORTANT:
  // During cooldown we hide NEW prediction.
  // Existing settled prediction can still be shown
  // in lastPrediction.

  let modelPrediction =
    null;

  let targetIssue =
    null;

  let modelConfidence =
    0;


  if (
    predictionRecord &&
    !cooldown.active
  ) {

    modelPrediction =
      predictionRecord.prediction;

    targetIssue =
      predictionRecord.target_issue;

    modelConfidence =
      predictionRecord.confidence;
  }


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
        "OWN-FULL-ANALYSIS-V4",

      prediction:
        modelPrediction,

      confidence:
        modelConfidence,

      targetIssue,

      analysis,

      cooldown,

      lastPrediction:
        latest
    }
  };


  stateCache = {
    timestamp: now(),
    state
  };


  return state;
}


// ======================================================
// ACCESS KEY AUTH
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


  if (!key || !device) {
    return {
      ok: false,
      error:
        "Access key and device ID required."
    };
  }


  if (!DATABASE_URL) {
    return {
      ok: false,
      error:
        "Database unavailable."
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
    key: row.access_key
  };
}


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
// BODY
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

          if (
            body.length >
            100000
          ) {

            body = "";
            req.destroy();
          }
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
        "no-store"
    }
  );

  res.end(data);
}


// ======================================================
// MUSIC RANGE
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

    return fs.createReadStream(
      filePath
    ).pipe(res);
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
    Number(match[1]);

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


  const chunkSize =
    end - start + 1;


  res.writeHead(
    206,
    {
      "Content-Range":
        `bytes ${start}-${end}/${stat.size}`,

      "Accept-Ranges":
        "bytes",

      "Content-Length":
        chunkSize,

      "Content-Type":
        "audio/mpeg"
    }
  );


  fs.createReadStream(
    filePath,
    {
      start,
      end
    }
  ).pipe(res);
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


        // ------------------------------------------------
        // HEALTH
        // ------------------------------------------------

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
                "DY AI WinGo V4",
              time:
                now()
            }
          );
        }


        // ------------------------------------------------
        // USER KEY CHECK
        // ------------------------------------------------

        if (
          url.pathname ===
          "/api/key/check" &&
          req.method === "GET"
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


        // ------------------------------------------------
        // USER STATE
        // ------------------------------------------------

        if (
          url.pathname ===
          "/api/state" &&
          req.method === "GET"
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


        // ------------------------------------------------
        // HISTORY
        // ------------------------------------------------

        if (
          url.pathname ===
          "/api/history" &&
          req.method === "GET"
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
              history:
                state.history,
              currentIssue:
                state.currentIssue
            }
          );
        }


        // =================================================
        // ADMIN
        // =================================================

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


          // ----------------------------------------------
          // PING
          // ----------------------------------------------

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
                admin: true
              }
            );
          }


          // ----------------------------------------------
          // STATUS
          // ----------------------------------------------

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


            let keys = 0;

            if (
              DATABASE_URL
            ) {

              const r =
                await pool.query(
                  `
                  SELECT COUNT(*)::int AS count
                  FROM access_keys
                  `
                );

              keys =
                r.rows[0].count;
            }


            return json(
              res,
              200,
              {
                ...state,
                keys
              }
            );
          }


          // ----------------------------------------------
          // KEYS GET
          // ----------------------------------------------

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


          // ----------------------------------------------
          // CREATE KEY
          // ----------------------------------------------

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
                  .toString("hex")
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

            } catch (error) {

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


          // ----------------------------------------------
          // DELETE KEY
          // ----------------------------------------------

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


          // ----------------------------------------------
          // RESET DEVICE
          // ----------------------------------------------

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


          // ----------------------------------------------
          // WINGO TEST
          // ----------------------------------------------

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
                }
              );

            } catch (error) {

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


          // ----------------------------------------------
          // MODEL TEST
          // ----------------------------------------------

          if (
            url.pathname ===
              "/api/admin/model-test" &&
            req.method ===
              "GET"
          ) {

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
                  state.model
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


        // ------------------------------------------------
        // STATIC
        // ------------------------------------------------

        if (
          url.pathname ===
          "/" ||
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
          "Not Found"
        );

      } catch (error) {

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
          `DY AI WinGo V4 running on port ${PORT}`
        );
      }
    );

  } catch (error) {

    console.error(
      "STARTUP ERROR:",
      error
    );

    process.exit(1);
  }

})();
