"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

/* =========================================================
   CONFIG
========================================================= */

const PORT = Number(process.env.PORT || 10000);

const ADMIN_KEY = String(
  process.env.ADMIN_KEY || ""
).trim();

const WINGOBOT_TOKEN = String(
  process.env.WINGOBOT_TOKEN || ""
).trim();

const DATABASE_URL = String(
  process.env.DATABASE_URL || ""
).trim();

const HOST = "0.0.0.0";

const WINGOBOT_API =
  "https://api.wingobot.com/v2/30-sec-game-history";

const PUBLIC_DIR = path.resolve(__dirname);

const MODEL_VERSION = "DY-AI-STAT-V4";

const THINKING_DURATION_MS = 4000;


/* =========================================================
   DATABASE
========================================================= */

let pool = null;

if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });
}


async function initDatabase() {

  if (!pool) {
    console.log("DATABASE_URL not configured");
    return;
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
    ON prediction_records(created_at DESC)
  `);

  console.log("Database ready");
}


/* =========================================================
   MEMORY STATE
========================================================= */

let providerState = {
  ok: false,
  currentIssue: null,
  history: [],
  fetched: 0,
  lastUpdated: 0,
  error: null,
  fetchedAt: 0
};


let modelCache = {
  targetIssue: null,
  prediction: null,
  confidence: 0,
  confidenceLevel: "LOW",
  reason: "",
  modelVersion: MODEL_VERSION,
  generatedAt: 0,
  thinkingDurationMs: THINKING_DURATION_MS,
  analysis: null
};


/* =========================================================
   GENERAL HELPERS
========================================================= */

function now() {
  return Date.now();
}


function json(res, status, data) {

  const body = JSON.stringify(data);

  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "Content-Type, X-Access-Key, X-Device-Id, X-Admin-Key, Authorization",
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

  const contentType =
    type.includes("charset")
      ? type
      : `${type}; charset=utf-8`;

  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });

  res.end(body);
}


function safeNumber(value) {

  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : null;
}


function issueString(value) {

  if (
    value === undefined ||
    value === null
  ) {
    return null;
  }

  return String(value).trim() || null;
}


function incrementIssue(issue) {

  const s = issueString(issue);

  if (!s) {
    return null;
  }

  if (/^\d+$/.test(s)) {

    try {
      return (BigInt(s) + 1n).toString();
    } catch {
      return null;
    }
  }

  return null;
}


function compareNumericIssues(a, b) {

  const x = issueString(a);
  const y = issueString(b);

  if (!x || !y) {
    return 0;
  }

  if (
    /^\d+$/.test(x) &&
    /^\d+$/.test(y)
  ) {

    try {

      const bx = BigInt(x);
      const by = BigInt(y);

      if (bx > by) return 1;
      if (bx < by) return -1;

      return 0;

    } catch {
      return x.localeCompare(y);
    }
  }

  return x.localeCompare(y);
}


function clamp(value, min, max) {

  return Math.max(
    min,
    Math.min(max, value)
  );
}


function round2(value) {

  return Number(
    Number(value || 0).toFixed(2)
  );
}


function percentage(count, total) {

  if (!total) {
    return 0;
  }

  return round2(
    (count / total) * 100
  );
}


function sideFromNumber(number) {

  const n = safeNumber(number);

  if (
    n === null ||
    !Number.isInteger(n) ||
    n < 0 ||
    n > 9
  ) {
    return null;
  }

  return n >= 5
    ? "BIG"
    : "SMALL";
}


/* =========================================================
   RESULT NORMALIZATION
========================================================= */

function normalizeResult(row) {

  if (!row) {
    return null;
  }

  const number =
    safeNumber(
      row.number ??
      row.resultNumber ??
      row.digit
    );

  const numberSide =
    sideFromNumber(number);

  if (numberSide) {
    return numberSide;
  }

  const raw =
    String(
      row.result ??
      row.bigSmall ??
      row.size ??
      ""
    )
      .trim()
      .toUpperCase();

  if (raw === "BIG") {
    return "BIG";
  }

  if (raw === "SMALL") {
    return "SMALL";
  }

  return null;
}


function normalizeHistory(input) {

  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map(row => {

      const issue =
        issueString(
          row.issueNumber ??
          row.issue ??
          row.period ??
          row.periodNumber
        );

      const number =
        safeNumber(
          row.number ??
          row.resultNumber ??
          row.digit
        );

      const result =
        normalizeResult(row);

      return {

        issueNumber: issue,

        number:
          number !== null &&
          Number.isInteger(number) &&
          number >= 0 &&
          number <= 9
            ? number
            : null,

        result,

        colour:
          row.colour ??
          row.color ??
          null,

        premium:
          row.premium ??
          null,

        sum:
          row.sum ??
          null
      };

    })
    .filter(row => row.issueNumber);
}


/* =========================================================
   WINGOBOT HTTP
========================================================= */

function fetchJson(url, headers = {}) {

  return new Promise(
    (resolve, reject) => {

      const request =
        https.get(
          url,
          {
            headers: {
              Accept: "application/json",
              "User-Agent": "DY-AI-Wingo/4.0",
              ...headers
            },
            timeout: 15000
          },
          response => {

            let body = "";

            response.setEncoding("utf8");

            response.on(
              "data",
              chunk => {
                body += chunk;
              }
            );

            response.on(
              "end",
              () => {

                const status =
                  response.statusCode || 0;

                if (
                  status < 200 ||
                  status >= 300
                ) {

                  reject(
                    new Error(
                      `WingoBot HTTP ${status}: ${body.slice(0, 300)}`
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
                      "WingoBot returned invalid JSON"
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
              "WingoBot request timeout"
            )
          );
        }
      );

      request.on(
        "error",
        reject
      );
    }
  );
}


/* =========================================================
   PROVIDER REFRESH
========================================================= */

async function refreshProvider() {

  if (!WINGOBOT_TOKEN) {

    providerState.ok = false;

    providerState.error =
      "WINGOBOT_TOKEN environment variable missing";

    return;
  }

  try {

    const data =
      await fetchJson(
        WINGOBOT_API,
        {
          Authorization:
            `Bearer ${WINGOBOT_TOKEN}`
        }
      );

    const history =
      normalizeHistory(
        data.history
      );

    const currentIssue =
      issueString(
        data?.current?.issueNumber ??
        data?.current?.issue ??
        null
      );

    let lastUpdated =
      safeNumber(
        data?.stats?.last_updated ??
        data?.last_updated
      ) || 0;

    if (
      lastUpdated > 0 &&
      lastUpdated < 100000000000
    ) {
      lastUpdated *= 1000;
    }

    providerState = {

      ok: true,

      currentIssue,

      history,

      fetched:
        safeNumber(
          data?.stats?.fetched
        ) || history.length,

      lastUpdated,

      error: null,

      fetchedAt: now()
    };

    await settlePredictions(history);

    const target =
      resolveTargetIssue();

    if (
      target &&
      modelCache.targetIssue !== target
    ) {
      generatePrediction();
    }

  } catch (error) {

    providerState.ok = false;

    providerState.error =
      error?.message ||
      "Provider error";

    console.error(
      "Provider refresh error:",
      providerState.error
    );
  }
}


/* =========================================================
   TARGET ISSUE
========================================================= */

function resolveTargetIssue() {

  const history =
    providerState.history || [];

  const latestSettled =
    history.length
      ? history[0]?.issueNumber
      : null;

  const current =
    providerState.currentIssue;

  if (
    current &&
    latestSettled
  ) {

    if (
      compareNumericIssues(
        current,
        latestSettled
      ) > 0
    ) {
      return current;
    }

    return incrementIssue(
      latestSettled
    );
  }

  if (current) {
    return current;
  }

  if (latestSettled) {
    return incrementIssue(
      latestSettled
    );
  }

  return null;
}


/* =========================================================
   SEQUENCE HELPERS
========================================================= */

function getValidRows(rows, limit = 1000) {

  return (rows || [])
    .filter(row =>
      row &&
      issueString(row.issueNumber)
    )
    .filter(row =>
      normalizeResult(row)
    )
    .slice(0, limit);
}


function getResults(rows, limit = 1000) {

  return getValidRows(rows, limit)
    .map(normalizeResult);
}


function getNumbers(rows, limit = 1000) {

  return getValidRows(rows, limit)
    .map(row =>
      safeNumber(row.number)
    )
    .filter(
      n =>
        n !== null &&
        Number.isInteger(n) &&
        n >= 0 &&
        n <= 9
    );
}


/* =========================================================
   FREQUENCY
========================================================= */

function frequencyAnalysis(sequence) {

  const total =
    sequence.length;

  const bigCount =
    sequence.filter(
      x => x === "BIG"
    ).length;

  const smallCount =
    sequence.filter(
      x => x === "SMALL"
    ).length;

  return {

    total,

    bigCount,

    smallCount,

    bigPercent:
      percentage(
        bigCount,
        total
      ),

    smallPercent:
      percentage(
        smallCount,
        total
      )
  };
}


function calculateWindow(
  sequence,
  size
) {

  const data =
    sequence.slice(0, size);

  const frequency =
    frequencyAnalysis(data);

  const switching =
    switchingAnalysis(data);

  const streak =
    currentStreak(data);

  return {

    size,

    available:
      data.length,

    bigCount:
      frequency.bigCount,

    smallCount:
      frequency.smallCount,

    bigPercent:
      frequency.bigPercent,

    smallPercent:
      frequency.smallPercent,

    currentStreak:
      streak,

    switches:
      switching.switches,

    transitions:
      switching.transitions,

    switchRate:
      switching.switchRate,

    dominant:
      frequency.bigCount >
      frequency.smallCount
        ? "BIG"
        : frequency.smallCount >
          frequency.bigCount
          ? "SMALL"
          : "BALANCED"
  };
}


/* =========================================================
   STREAK
========================================================= */

function currentStreak(sequence) {

  if (!sequence.length) {

    return {
      side: null,
      length: 0
    };
  }

  const side =
    sequence[0];

  let length = 1;

  for (
    let i = 1;
    i < sequence.length;
    i++
  ) {

    if (
      sequence[i] !== side
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


function runLengths(sequence) {

  const runs = [];

  if (!sequence.length) {
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
      sequence[i] === side
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


function countRunLengths(
  runs,
  side
) {

  const counts = {};

  for (
    const run of runs
  ) {

    if (
      run.side !== side
    ) {
      continue;
    }

    counts[run.length] =
      (counts[run.length] || 0) + 1;
  }

  return counts;
}


function modeRunLength(
  runs,
  side
) {

  const counts =
    countRunLengths(
      runs,
      side
    );

  const entries =
    Object.entries(counts);

  if (!entries.length) {
    return null;
  }

  entries.sort(
    (a, b) => {

      const countDiff =
        Number(b[1]) -
        Number(a[1]);

      if (countDiff !== 0) {
        return countDiff;
      }

      return (
        Number(a[0]) -
        Number(b[0])
      );
    }
  );

  return Number(
    entries[0][0]
  );
}


function longestRun(
  runs,
  side
) {

  const values =
    runs
      .filter(
        r => r.side === side
      )
      .map(
        r => r.length
      );

  return values.length
    ? Math.max(...values)
    : 0;
}


function runAnalysis(sequence) {

  const runs =
    runLengths(sequence);

  const current =
    currentStreak(sequence);

  return {

    runs,

    currentStreak:
      current,

    mostCommonBigStreak:
      modeRunLength(
        runs,
        "BIG"
      ),

    mostCommonSmallStreak:
      modeRunLength(
        runs,
        "SMALL"
      ),

    longestBigStreak:
      longestRun(
        runs,
        "BIG"
      ),

    longestSmallStreak:
      longestRun(
        runs,
        "SMALL"
      ),

    bigRunCount:
      runs.filter(
        r => r.side === "BIG"
      ).length,

    smallRunCount:
      runs.filter(
        r => r.side === "SMALL"
      ).length,

    distribution: {

      big:
        countRunLengths(
          runs,
          "BIG"
        ),

      small:
        countRunLengths(
          runs,
          "SMALL"
        )
    }
  };
}


/* =========================================================
   SWITCH RATE
========================================================= */

function switchingAnalysis(sequence) {

  let switches = 0;

  const transitions =
    Math.max(
      0,
      sequence.length - 1
    );

  for (
    let i = 0;
    i < sequence.length - 1;
    i++
  ) {

    if (
      sequence[i] !==
      sequence[i + 1]
    ) {
      switches++;
    }
  }

  const switchRate =
    percentage(
      switches,
      transitions
    );

  let classification =
    "BALANCED";

  if (
    switchRate >= 65
  ) {
    classification =
      "HIGH SWITCHING";
  } else if (
    switchRate <= 35
  ) {
    classification =
      "LOW SWITCHING";
  }

  return {

    switches,

    transitions,

    switchRate,

    classification
  };
}


/* =========================================================
   TRANSITION MATRIX
========================================================= */

function transitionAnalysis(sequence) {

  let BB = 0;
  let BS = 0;
  let SB = 0;
  let SS = 0;

  /*
    sequence:
    newest -> oldest

    previous chronological state:
    sequence[i + 1]

    next chronological state:
    sequence[i]
  */

  for (
    let i = 0;
    i < sequence.length - 1;
    i++
  ) {

    const previous =
      sequence[i + 1];

    const next =
      sequence[i];

    if (
      previous === "BIG" &&
      next === "BIG"
    ) {
      BB++;
    }

    if (
      previous === "BIG" &&
      next === "SMALL"
    ) {
      BS++;
    }

    if (
      previous === "SMALL" &&
      next === "BIG"
    ) {
      SB++;
    }

    if (
      previous === "SMALL" &&
      next === "SMALL"
    ) {
      SS++;
    }
  }

  const afterBig =
    BB + BS;

  const afterSmall =
    SB + SS;

  return {

    counts: {
      BB,
      BS,
      SB,
      SS
    },

    probabilities: {

      "B→B":
        percentage(
          BB,
          afterBig
        ),

      "B→S":
        percentage(
          BS,
          afterBig
        ),

      "S→B":
        percentage(
          SB,
          afterSmall
        ),

      "S→S":
        percentage(
          SS,
          afterSmall
        )
    },

    previousStateTotals: {

      BIG:
        afterBig,

      SMALL:
        afterSmall
    },

    sampleSize:
      Math.max(
        0,
        sequence.length - 1
      )
  };
}


/* =========================================================
   RECENT MOMENTUM
========================================================= */

function momentumAnalysis(sequence) {

  const windows = [
    5,
    10,
    20
  ];

  const scores = [];

  for (
    const size of windows
  ) {

    if (
      sequence.length < size
    ) {
      continue;
    }

    const data =
      sequence.slice(
        0,
        size
      );

    const frequency =
      frequencyAnalysis(data);

    const edge =
      frequency.bigPercent -
      frequency.smallPercent;

    scores.push({

      window: size,

      bigPercent:
        frequency.bigPercent,

      smallPercent:
        frequency.smallPercent,

      edge
    });
  }

  if (!scores.length) {

    return {

      big: 50,
      small: 50,
      strength: 0,
      direction: "NEUTRAL",
      windows: []
    };
  }

  /*
    Most recent window gets highest weight.
  */

  const weights = [
    0.55,
    0.30,
    0.15
  ];

  let weightedEdge = 0;

  scores.forEach(
    (item, index) => {

      weightedEdge +=
        item.edge *
        (weights[index] || 0.10);
    }
  );

  weightedEdge =
    clamp(
      weightedEdge,
      -30,
      30
    );

  const big =
    50 +
    weightedEdge;

  const small =
    50 -
    weightedEdge;

  return {

    big:
      round2(big),

    small:
      round2(small),

    strength:
      round2(
        Math.abs(weightedEdge)
      ),

    direction:
      weightedEdge > 3
        ? "BIG"
        : weightedEdge < -3
          ? "SMALL"
          : "NEUTRAL",

    windows:
      scores
  };
}


/* =========================================================
   DIGIT FREQUENCY
========================================================= */

function digitFrequencyAnalysis(rows) {

  const valid =
    getValidRows(
      rows,
      1000
    );

  const counts =
    Array(10).fill(0);

  for (
    const row of valid
  ) {

    const n =
      safeNumber(
        row.number
      );

    if (
      n !== null &&
      Number.isInteger(n) &&
      n >= 0 &&
      n <= 9
    ) {

      counts[n]++;
    }
  }

  const total =
    counts.reduce(
      (a, b) => a + b,
      0
    );

  const bigDigits =
    counts
      .slice(5, 10)
      .reduce(
        (a, b) => a + b,
        0
      );

  const smallDigits =
    counts
      .slice(0, 5)
      .reduce(
        (a, b) => a + b,
        0
      );

  let rarestDigit = null;
  let rarestCount = Infinity;

  let hottestDigit = null;
  let hottestCount = -1;

  counts.forEach(
    (count, digit) => {

      if (
        count < rarestCount
      ) {

        rarestCount = count;
        rarestDigit = digit;
      }

      if (
        count > hottestCount
      ) {

        hottestCount = count;
        hottestDigit = digit;
      }
    }
  );

  const bigPercent =
    percentage(
      bigDigits,
      total
    );

  const smallPercent =
    percentage(
      smallDigits,
      total
    );

  return {

    total,

    counts,

    percentages:
      counts.map(
        count =>
          percentage(
            count,
            total
          )
      ),

    bigCount:
      bigDigits,

    smallCount:
      smallDigits,

    bigPercent,

    smallPercent,

    hottestDigit,

    hottestCount,

    rarestDigit,

    rarestCount,

    direction:
      bigPercent >
      smallPercent + 6
        ? "BIG"
        : smallPercent >
          bigPercent + 6
          ? "SMALL"
          : "NEUTRAL"
  };
}


/* =========================================================
   GAP ANALYSIS
========================================================= */

function gapAnalysis(sequence) {

  let bigGap = null;
  let smallGap = null;

  let bigSeen = false;
  let smallSeen = false;

  for (
    let i = 0;
    i < sequence.length;
    i++
  ) {

    if (
      !bigSeen &&
      sequence[i] === "BIG"
    ) {

      bigGap = i;
      bigSeen = true;
    }

    if (
      !smallSeen &&
      sequence[i] === "SMALL"
    ) {

      smallGap = i;
      smallSeen = true;
    }

    if (
      bigSeen &&
      smallSeen
    ) {
      break;
    }
  }

  /*
    Gap is descriptive only.
    It is NOT treated as "overdue = guaranteed".
  */

  let direction = "NEUTRAL";

  if (
    bigGap !== null &&
    smallGap !== null
  ) {

    const difference =
      bigGap -
      smallGap;

    if (
      difference >= 3
    ) {
      direction = "BIG";
    } else if (
      difference <= -3
    ) {
      direction = "SMALL";
    }
  }

  return {

    bigGap,

    smallGap,

    direction,

    difference:
      bigGap !== null &&
      smallGap !== null
        ? bigGap - smallGap
        : null
  };
}


/* =========================================================
   REPETITION DETECTION
========================================================= */

function exactRepetitionAnalysis(
  sequence
) {

  const sizes =
    [2, 3, 4, 5];

  const detected = [];

  for (
    const size of sizes
  ) {

    if (
      sequence.length <
      size * 2
    ) {
      continue;
    }

    const current =
      sequence.slice(
        0,
        size
      );

    for (
      let start = size;
      start + size <=
        sequence.length;
      start++
    ) {

      const block =
        sequence.slice(
          start,
          start + size
        );

      let same = 0;

      for (
        let i = 0;
        i < size;
        i++
      ) {

        if (
          current[i] ===
          block[i]
        ) {
          same++;
        }
      }

      const similarity =
        percentage(
          same,
          size
        );

      if (
        similarity >= 75
      ) {

        detected.push({

          blockSize: size,

          start,

          similarity,

          current:
            current.join("-"),

          previous:
            block.join("-")
        });
      }
    }
  }

  detected.sort(
    (a, b) =>
      b.similarity -
      a.similarity
  );

  const best =
    detected[0] || null;

  return {

    detected:
      Boolean(best),

    best,

    matches:
      detected.slice(0, 15)
  };
}


/* =========================================================
   PATTERN MATCHING
========================================================= */

function alternatingPattern(sequence) {

  if (
    sequence.length < 4
  ) {

    return {
      detected: false,
      length: sequence.length
    };
  }

  let length = 1;

  for (
    let i = 1;
    i < sequence.length;
    i++
  ) {

    if (
      sequence[i] ===
      sequence[i - 1]
    ) {
      break;
    }

    length++;
  }

  return {

    detected:
      length >= 4,

    length,

    sequence:
      sequence
        .slice(0, length)
        .join("-")
  };
}


function repeatedBlockPattern(
  sequence,
  blockSize
) {

  if (
    sequence.length <
    blockSize * 2
  ) {

    return {
      detected: false,
      blockSize,
      repetitions: 0
    };
  }

  const recent =
    sequence.slice(
      0,
      blockSize * 3
    );

  const firstBlock =
    recent.slice(
      0,
      blockSize
    );

  let repetitions = 1;

  for (
    let start = blockSize;
    start + blockSize <=
      recent.length;
    start += blockSize
  ) {

    const block =
      recent.slice(
        start,
        start + blockSize
      );

    if (
      block.join("") ===
      firstBlock.join("")
    ) {

      repetitions++;

    } else {

      break;
    }
  }

  return {

    detected:
      repetitions >= 2,

    blockSize,

    repetitions,

    block:
      firstBlock.join("-")
  };
}


function patternStrength(
  value,
  total
) {

  if (
    !total ||
    !value
  ) {
    return "LOW";
  }

  const ratio =
    value / total;

  if (
    ratio >= 0.70
  ) {
    return "HIGH";
  }

  if (
    ratio >= 0.45
  ) {
    return "MEDIUM";
  }

  return "LOW";
}


function patternAnalysis(sequence) {

  const alternating =
    alternatingPattern(sequence);

  const pattern22 =
    repeatedBlockPattern(
      sequence,
      2
    );

  const pattern33 =
    repeatedBlockPattern(
      sequence,
      3
    );

  const repeating =
    exactRepetitionAnalysis(
      sequence
    );

  const current =
    currentStreak(sequence);

  const detected = [];

  if (
    alternating.detected
  ) {

    detected.push({

      name: "ALTERNATING",

      strength:
        patternStrength(
          alternating.length,
          sequence.length
        ),

      detail:
        `Alternating length ${alternating.length}`
    });
  }

  if (
    pattern22.detected
  ) {

    detected.push({

      name: "2-2 PATTERN",

      strength: "MEDIUM",

      detail:
        `Repeated ${pattern22.block}`
    });
  }

  if (
    pattern33.detected
  ) {

    detected.push({

      name: "3-3 PATTERN",

      strength: "MEDIUM",

      detail:
        `Repeated ${pattern33.block}`
    });
  }

  if (
    repeating.detected &&
    repeating.best
  ) {

    detected.push({

      name:
        "REPEATING BLOCK",

      strength:
        repeating.best.similarity >= 90
          ? "HIGH"
          : "MEDIUM",

      detail:
        `${repeating.best.similarity}% similarity`
    });
  }

  if (
    current.length >= 3
  ) {

    detected.push({

      name:
        "SAME STREAK",

      strength:
        current.length >= 5
          ? "HIGH"
          : "MEDIUM",

      detail:
        `${current.side} ${current.length} rounds`
    });
  }

  const frequency =
    frequencyAnalysis(sequence);

  const frequencyEdge =
    Math.abs(
      frequency.bigPercent -
      frequency.smallPercent
    );

  if (
    frequencyEdge >= 10
  ) {

    detected.push({

      name:
        "MAJORITY BIAS",

      strength:
        frequencyEdge >= 20
          ? "HIGH"
          : "MEDIUM",

      detail:
        frequency.bigPercent >
        frequency.smallPercent
          ? "BIG dominant"
          : "SMALL dominant"
    });
  }

  if (!detected.length) {

    detected.push({

      name:
        "NO STRONG PATTERN",

      strength:
        "LOW",

      detail:
        "No strong repeated structure"
    });
  }

  const rank = {
    HIGH: 3,
    MEDIUM: 2,
    LOW: 1
  };

  detected.sort(
    (a, b) =>
      (rank[b.strength] || 0) -
      (rank[a.strength] || 0)
  );

  return {

    primary:
      detected[0],

    detected,

    alternating,

    pattern22,

    pattern33,

    repeating
  };
}


/* =========================================================
   HISTORICAL NEXT-STATE PATTERN MATCH
========================================================= */

function nextStatePatternAnalysis(
  sequence
) {

  /*
    Current recent pattern is compared with older
    windows of the same size.

    Example:
    current = B,S,B

    Search older B,S,B sequences.
    Check what came chronologically after those
    sequences in available history.

    This is a weak empirical component.
  */

  const patternSizes =
    [2, 3, 4];

  const results = [];

  for (
    const size of patternSizes
  ) {

    if (
      sequence.length <
      size + 2
    ) {
      continue;
    }

    const current =
      sequence.slice(
        0,
        size
      );

    let bigNext = 0;
    let smallNext = 0;
    let matches = 0;

    /*
      sequence is newest -> oldest.
      At index start, pattern is:
      sequence[start ... start+size-1]

      The next chronological result after that
      older pattern is at start-1.
    */

    for (
      let start = size + 1;
      start < sequence.length;
      start++
    ) {

      const candidate =
        sequence.slice(
          start,
          start + size
        );

      if (
        candidate.length !== size
      ) {
        continue;
      }

      let same = true;

      for (
        let i = 0;
        i < size;
        i++
      ) {

        if (
          candidate[i] !==
          current[i]
        ) {

          same = false;
          break;
        }
      }

      if (!same) {
        continue;
      }

      const next =
        sequence[start - 1];

      if (
        next === "BIG"
      ) {
        bigNext++;
      }

      if (
        next === "SMALL"
      ) {
        smallNext++;
      }

      if (next) {
        matches++;
      }
    }

    const total =
      bigNext +
      smallNext;

    if (
      total > 0
    ) {

      results.push({

        size,

        pattern:
          current.join("-"),

        matches,

        bigNext,

        smallNext,

        bigPercent:
          percentage(
            bigNext,
            total
          ),

        smallPercent:
          percentage(
            smallNext,
            total
          )
      });
    }
  }

  if (!results.length) {

    return {

      big: 50,

      small: 50,

      matches: 0,

      direction:
        "NEUTRAL",

      details: []
    };
  }

  /*
    Prefer larger pattern only when it has enough matches.
  */

  const usable =
    results
      .filter(
        r => r.matches >= 2
      );

  if (!usable.length) {

    return {

      big: 50,

      small: 50,

      matches:
        results.reduce(
          (sum, r) =>
            sum + r.matches,
          0
        ),

      direction:
        "NEUTRAL",

      details:
        results
    };
  }

  let weightedBig = 0;
  let weightedTotal = 0;

  for (
    const item of usable
  ) {

    const weight =
      item.size *
      Math.min(
        item.matches,
        5
      );

    weightedBig +=
      item.bigPercent *
      weight;

    weightedTotal +=
      100 *
      weight;
  }

  const big =
    weightedTotal
      ? weightedBig /
        weightedTotal *
        100
      : 50;

  const small =
    100 - big;

  return {

    big:
      round2(big),

    small:
      round2(small),

    matches:
      usable.reduce(
        (sum, r) =>
          sum + r.matches,
        0
      ),

    direction:
      big >
      small + 5
        ? "BIG"
        : small >
          big + 5
          ? "SMALL"
          : "NEUTRAL",

    details:
      results
  };
}


/* =========================================================
   STREAK CONTINUATION / REVERSAL
========================================================= */

function historicalStreakSupport(
  sequence
) {

  const current =
    currentStreak(sequence);

  if (
    !current.side ||
    current.length < 1
  ) {

    return {

      big: 50,

      small: 50,

      evidence:
        "No streak data",

      sample: 0
    };
  }

  const runs =
    runLengths(sequence);

  /*
    Historical runs of same side.

    We estimate whether runs of similar length
    tended to continue or terminate.

    Since every run eventually terminates in a
    two-sided sequence, this is deliberately
    weak and cannot create certainty.
  */

  let comparable = 0;
  let continuation = 0;

  for (
    let i = 0;
    i < runs.length;
    i++
  ) {

    const run =
      runs[i];

    if (
      run.side !==
      current.side
    ) {
      continue;
    }

    if (
      Math.abs(
        run.length -
        current.length
      ) > 1
    ) {
      continue;
    }

    /*
      The next chronological observation after
      an older completed run is opposite side.
      Therefore completed historical runs mostly
      provide reversal evidence.

      We cap this component heavily.
    */

    comparable++;

    if (
      run.length >=
      current.length
    ) {
      continuation++;
    }
  }

  if (
    comparable < 3
  ) {

    return {

      big: 50,

      small: 50,

      evidence:
        "Insufficient streak sample",

      sample:
        comparable
    };
  }

  const reversalBias =
    clamp(
      50 +
      Math.min(
        10,
        comparable * 0.5
      ),
      50,
      60
    );

  if (
    current.side ===
    "BIG"
  ) {

    return {

      big:
        100 -
        reversalBias,

      small:
        reversalBias,

      evidence:
        `${comparable} comparable BIG runs`,

      sample:
        comparable
    };
  }

  return {

    big:
      reversalBias,

    small:
      100 -
      reversalBias,

    evidence:
      `${comparable} comparable SMALL runs`,

    sample:
      comparable
  };
}


/* =========================================================
   FREQUENCY COMPONENT
========================================================= */

function frequencyComponent(
  sequence
) {

  const w5 =
    frequencyAnalysis(
      sequence.slice(0, 5)
    );

  const w10 =
    frequencyAnalysis(
      sequence.slice(0, 10)
    );

  const w20 =
    frequencyAnalysis(
      sequence.slice(0, 20)
    );

  const w50 =
    frequencyAnalysis(
      sequence.slice(0, 50)
    );

  /*
    Recency weighted.

    Last 5:
    40%

    Last 10:
    30%

    Last 20:
    20%

    Last 50:
    10%
  */

  const big =
    w5.bigPercent * 0.40 +
    w10.bigPercent * 0.30 +
    w20.bigPercent * 0.20 +
    w50.bigPercent * 0.10;

  return {

    big:
      round2(big),

    small:
      round2(
        100 - big
      ),

    evidence:
      "Recency-weighted frequency"
  };
}


/* =========================================================
   SWITCH COMPONENT
========================================================= */

function switchingComponent(
  sequence
) {

  const recent =
    sequence.slice(
      0,
      Math.min(
        20,
        sequence.length
      )
    );

  const switching =
    switchingAnalysis(
      recent
    );

  const current =
    currentStreak(
      sequence
    );

  if (
    !current.side
  ) {

    return {

      big: 50,

      small: 50,

      evidence:
        "No current side"
    };
  }

  /*
    High switching:
    mild opposite-side pressure.

    Low switching:
    mild continuation pressure.

    Balanced:
    neutral.

    Maximum influence remains small.
  */

  if (
    switching.classification ===
    "HIGH SWITCHING"
  ) {

    return {

      big:
        current.side === "BIG"
          ? 47
          : 53,

      small:
        current.side === "BIG"
          ? 53
          : 47,

      evidence:
        `High switch rate ${switching.switchRate}%`
    };
  }

  if (
    switching.classification ===
    "LOW SWITCHING"
  ) {

    return {

      big:
        current.side === "BIG"
          ? 53
          : 47,

      small:
        current.side === "BIG"
          ? 47
          : 53,

      evidence:
        `Low switch rate ${switching.switchRate}%`
    };
  }

  return {

    big: 50,

    small: 50,

    evidence:
      `Balanced switch rate ${switching.switchRate}%`
  };
}


/* =========================================================
   RUN COMPONENT
========================================================= */

function runComponent(
  sequence
) {

  const runs =
    runLengths(sequence);

  const current =
    currentStreak(sequence);

  if (
    !current.side
  ) {

    return {

      big: 50,

      small: 50,

      evidence:
        "No run data"
    };
  }

  const common =
    modeRunLength(
      runs,
      current.side
    );

  if (!common) {

    return {

      big: 50,

      small: 50,

      evidence:
        "Insufficient run history"
    };
  }

  /*
    Do not overreact to streak length.

    Very long compared with common:
    mild reversal.

    Normal:
    mild continuation.
  */

  if (
    current.length >=
    common + 2
  ) {

    return {

      big:
        current.side === "BIG"
          ? 44
          : 56,

      small:
        current.side === "BIG"
          ? 56
          : 44,

      evidence:
        `Current run ${current.length}; common ${common}`
    };
  }

  if (
    current.length ===
    common + 1
  ) {

    return {

      big:
        current.side === "BIG"
          ? 48
          : 52,

      small:
        current.side === "BIG"
          ? 52
          : 48,

      evidence:
        `Current run ${current.length}; common ${common}`
    };
  }

  if (
    current.length <=
    Math.max(
      1,
      common - 1
    )
  ) {

    return {

      big:
        current.side === "BIG"
          ? 52
          : 48,

      small:
        current.side === "BIG"
          ? 48
          : 52,

      evidence:
        `Current run ${current.length}; common ${common}`
    };
  }

  return {

    big: 50,

    small: 50,

    evidence:
      `Current run ${current.length}; common ${common}`
  };
}


/* =========================================================
   TRANSITION COMPONENT
========================================================= */

function transitionComponent(
  sequence
) {

  const transition =
    transitionAnalysis(sequence);

  const current =
    currentStreak(sequence);

  if (
    !current.side
  ) {

    return {

      big: 50,

      small: 50,

      evidence:
        "No current state"
    };
  }

  const minimumSample = 4;

  if (
    current.side ===
    "BIG"
  ) {

    const total =
      transition
        .previousStateTotals
        .BIG;

    if (
      total <
      minimumSample
    ) {

      return {

        big: 50,

        small: 50,

        evidence:
          "Insufficient BIG transition sample"
      };
    }

    return {

      big:
        transition
          .probabilities["B→B"],

      small:
        transition
          .probabilities["B→S"],

      evidence:
        `After BIG: B→B ${transition.probabilities["B→B"]}% / B→S ${transition.probabilities["B→S"]}%`
    };
  }

  const total =
    transition
      .previousStateTotals
      .SMALL;

  if (
    total <
    minimumSample
  ) {

    return {

      big: 50,

      small: 50,

      evidence:
        "Insufficient SMALL transition sample"
    };
  }

  return {

    big:
      transition
        .probabilities["S→B"],

    small:
      transition
        .probabilities["S→S"],

    evidence:
      `After SMALL: S→B ${transition.probabilities["S→B"]}% / S→S ${transition.probabilities["S→S"]}%`
  };
}


/* =========================================================
   DIGIT COMPONENT
========================================================= */

function digitComponent(rows) {

  const analysis =
    digitFrequencyAnalysis(
      rows
    );

  if (
    analysis.total < 10
  ) {

    return {

      big: 50,

      small: 50,

      evidence:
        "Insufficient digit history"
    };
  }

  /*
    Digit frequency is kept moderate.
  */

  const edge =
    clamp(
      analysis.bigPercent -
      analysis.smallPercent,
      -15,
      15
    );

  return {

    big:
      round2(
        50 + edge
      ),

    small:
      round2(
        50 - edge
      ),

    evidence:
      `Digit distribution B ${analysis.bigPercent}% / S ${analysis.smallPercent}%`
  };
}


/* =========================================================
   GAP COMPONENT
========================================================= */

function gapComponent(
  sequence
) {

  const gap =
    gapAnalysis(sequence);

  if (
    gap.direction ===
    "BIG"
  ) {

    return {

      big: 53,

      small: 47,

      evidence:
        `BIG gap ${gap.bigGap}, SMALL gap ${gap.smallGap}`
    };
  }

  if (
    gap.direction ===
    "SMALL"
  ) {

    return {

      big: 47,

      small: 53,

      evidence:
        `BIG gap ${gap.bigGap}, SMALL gap ${gap.smallGap}`
    };
  }

  return {

    big: 50,

    small: 50,

    evidence:
      "No meaningful gap imbalance"
  };
}


/* =========================================================
   REPETITION COMPONENT
========================================================= */

function repetitionComponent(
  sequence
) {

  const repetition =
    exactRepetitionAnalysis(
      sequence
    );

  /*
    Repetition alone does not tell the future side.
    We therefore only use it as a confidence/context
    signal rather than forcing BIG/SMALL.
  */

  return {

    big: 50,

    small: 50,

    evidence:
      repetition.detected &&
      repetition.best
        ? `${repetition.best.similarity}% historical block similarity`
        : "No strong repetition"
  };
}


/* =========================================================
   PATTERN MATCH COMPONENT
========================================================= */

function patternMatchComponent(
  sequence
) {

  const match =
    nextStatePatternAnalysis(
      sequence
    );

  if (
    match.matches < 2
  ) {

    return {

      big: 50,

      small: 50,

      evidence:
        "Insufficient historical pattern matches"
    };
  }

  return {

    big:
      match.big,

    small:
      match.small,

    evidence:
      `${match.matches} historical pattern matches`
  };
}


/* =========================================================
   NORMALIZE COMPONENT
========================================================= */

function normalizeComponent(
  component
) {

  const big =
    clamp(
      safeNumber(
        component?.big
      ) ?? 50,
      0,
      100
    );

  const small =
    clamp(
      safeNumber(
        component?.small
      ) ?? 50,
      0,
      100
    );

  const total =
    big + small;

  if (!total) {

    return {

      big: 50,

      small: 50
    };
  }

  return {

    big:
      round2(
        big /
        total *
        100
      ),

    small:
      round2(
        small /
        total *
        100
      )
  };
}


/* =========================================================
   SIGNAL STRENGTH
========================================================= */

function signalDirection(
  component
) {

  const big =
    safeNumber(
      component?.big
    ) ?? 50;

  const small =
    safeNumber(
      component?.small
    ) ?? 50;

  const edge =
    big - small;

  if (
    Math.abs(edge) < 4
  ) {
    return "NEUTRAL";
  }

  return edge > 0
    ? "BIG"
    : "SMALL";
}


/* =========================================================
   AGREEMENT
========================================================= */

function agreementAnalysis(
  components,
  finalSide
) {

  let directional = 0;
  let agreeing = 0;
  let conflicting = 0;

  const signals = [];

  for (
    const [name, component]
    of Object.entries(components)
  ) {

    const direction =
      signalDirection(
        component
      );

    const edge =
      Math.abs(
        component.big -
        component.small
      );

    signals.push({

      name,

      direction,

      edge:
        round2(edge),

      weight:
        component.weight
    });

    if (
      direction ===
      "NEUTRAL"
    ) {
      continue;
    }

    directional++;

    if (
      direction ===
      finalSide
    ) {
      agreeing++;
    } else {
      conflicting++;
    }
  }

  const agreement =
    directional
      ? agreeing /
        directional
      : 0;

  return {

    directional,

    agreeing,

    conflicting,

    agreement:
      round2(
        agreement * 100
      ),

    agreementRatio:
      agreement,

    signals
  };
}


/* =========================================================
   CONFIDENCE ENGINE
========================================================= */

function calculateConfidence(
  supportBig,
  supportSmall,
  total,
  agreementData,
  components,
  analysis
) {

  const edge =
    Math.abs(
      supportBig -
      supportSmall
    );

  /*
    Base score from edge.
    A 50/50 split gives 0.
  */

  let score =
    40 +
    edge * 2.2;

  /*
    Agreement bonus/penalty.
  */

  if (
    agreementData.directional >= 3
  ) {

    if (
      agreementData.agreementRatio >=
      0.75
    ) {

      score += 12;

    } else if (
      agreementData.agreementRatio >=
      0.60
    ) {

      score += 6;

    } else if (
      agreementData.agreementRatio <
      0.50
    ) {

      score -= 12;
    }
  }

  /*
    Strong conflict penalty.
  */

  if (
    agreementData.conflicting >= 3
  ) {

    score -= 10;
  }

  /*
    More data = slightly better reliability.
  */

  if (
    total >= 50
  ) {

    score += 4;

  } else if (
    total >= 30
  ) {

    score += 2;

  } else if (
    total < 15
  ) {

    score -= 8;
  }

  /*
    Pattern match requires enough evidence.
  */

  const patternMatch =
    components.patternMatch;

  if (
    patternMatch &&
    patternMatch.matches < 2
  ) {
    score -= 2;
  }

  /*
    Conflict check:
    transition vs momentum/frequency disagreement.
  */

  const directionalSignals =
    agreementData.signals
      .filter(
        s =>
          s.direction !==
          "NEUTRAL"
      );

  const uniqueDirections =
    new Set(
      directionalSignals.map(
        s => s.direction
      )
    );

  if (
    uniqueDirections.size >= 2
  ) {

    score -= 5;
  }

  score =
    clamp(
      Math.round(score),
      1,
      95
    );

  let level =
    "LOW";

  if (
    score >= 80 &&
    agreementData.agreementRatio >=
      0.67
  ) {

    level =
      "HIGH";

  } else if (
    score >= 60 &&
    agreementData.agreementRatio >=
      0.50
  ) {

    level =
      "MEDIUM";
  }

  /*
    Very small edge can never be HIGH.
  */

  if (
    edge < 7
  ) {

    level =
      "LOW";
  }

  /*
    Strong conflict can never be HIGH.
  */

  if (
    agreementData.conflicting >= 3 &&
    agreementData.agreementRatio < 0.60
  ) {

    level =
      "LOW";
  }

  let reason =
    "Low Confidence";

  if (
    level === "HIGH"
  ) {

    reason =
      "Strong multi-signal agreement";

  } else if (
    level === "MEDIUM"
  ) {

    reason =
      "Moderate multi-signal agreement";
  }

  if (
    agreementData.conflicting >= 3
  ) {

    reason =
      "Mixed Evidence";
  }

  if (
    edge < 7
  ) {

    reason =
      "Low Confidence";
  }

  return {

    score,

    level,

    reason,

    edge:
      round2(edge),

    agreement:
      agreementData.agreement,

    sampleSize:
      total
  };
}


/* =========================================================
   COMPLETE ANALYSIS
========================================================= */

function completeAnalysis(rows) {

  const validRows =
    getValidRows(
      rows,
      1000
    );

  const sequence =
    validRows.map(
      normalizeResult
    );

  const total =
    sequence.length;

  if (
    total < 5
  ) {

    return {

      status:
        "INSUFFICIENT_DATA",

      totalResults:
        total,

      sequence,

      overall:
        frequencyAnalysis(
          sequence
        ),

      windows: {},

      currentStreak:
        currentStreak(
          sequence
        ),

      switchRate: 0,

      switching: {},

      transitions: {},

      runs: {},

      momentum: {},

      digitFrequency:
        digitFrequencyAnalysis(
          validRows
        ),

      gap:
        gapAnalysis(
          sequence
        ),

      patterns: {},

      statisticalSupport: {

        big: 50,

        small: 50
      },

      confidence: {

        score: 0,

        level: "LOW",

        reason:
          "Insufficient Data"
      },

      agreement: 0,

      evidenceConflict:
        false,

      components: {},

      warning:
        "Historical patterns do not guarantee the next result."
    };
  }

  /* -------------------------------------------------------
     WINDOWS
  ------------------------------------------------------- */

  const windows = {

    last5:
      calculateWindow(
        sequence,
        5
      ),

    last10:
      calculateWindow(
        sequence,
        10
      ),

    last20:
      calculateWindow(
        sequence,
        20
      ),

    last30:
      calculateWindow(
        sequence,
        30
      ),

    last50:
      calculateWindow(
        sequence,
        50
      )
  };

  /* -------------------------------------------------------
     CORE ANALYSIS
  ------------------------------------------------------- */

  const overall =
    frequencyAnalysis(
      sequence
    );

  const runs =
    runAnalysis(
      sequence
    );

  const switching =
    switchingAnalysis(
      sequence
    );

  const transitions =
    transitionAnalysis(
      sequence
    );

  const momentum =
    momentumAnalysis(
      sequence
    );

  const digitFrequency =
    digitFrequencyAnalysis(
      validRows
    );

  const gap =
    gapAnalysis(
      sequence
    );

  const patterns =
    patternAnalysis(
      sequence
    );

  const patternMatches =
    nextStatePatternAnalysis(
      sequence
    );

  /* -------------------------------------------------------
     COMPONENTS
  ------------------------------------------------------- */

  const frequency =
    normalizeComponent(
      frequencyComponent(
        sequence
      )
    );

  const streak =
    normalizeComponent(
      historicalStreakSupport(
        sequence
      )
    );

  const switchingComp =
    normalizeComponent(
      switchingComponent(
        sequence
      )
    );

  const runComp =
    normalizeComponent(
      runComponent(
        sequence
      )
    );

  const transitionComp =
    normalizeComponent(
      transitionComponent(
        sequence
      )
    );

  const momentumComp =
    normalizeComponent(
      momentum
    );

  const digitComp =
    normalizeComponent(
      digitComponent(
        validRows
      )
    );

  const gapComp =
    normalizeComponent(
      gapComponent(
        sequence
      )
    );

  const patternMatchComp =
    normalizeComponent(
      patternMatchComponent(
        sequence
      )
    );

  const repetitionComp =
    normalizeComponent(
      repetitionComponent(
        sequence
      )
    );

  /*
    IMPORTANT WEIGHTS

    Frequency       15%
    Momentum        15%
    Transition      18%
    Pattern Match   15%
    Streak           8%
    Switching        8%
    Runs             7%
    Digit            6%
    Gap              4%
    Repetition       4%

    Total           100%
  */

  const components = {

    frequency: {

      weight: 15,

      big:
        frequency.big,

      small:
        frequency.small,

      evidence:
        frequencyComponent(
          sequence
        ).evidence
    },

    momentum: {

      weight: 15,

      big:
        momentumComp.big,

      small:
        momentumComp.small,

      evidence:
        `Momentum ${momentum.direction}`
    },

    transition: {

      weight: 18,

      big:
        transitionComp.big,

      small:
        transitionComp.small,

      evidence:
        transitionComponent(
          sequence
        ).evidence
    },

    patternMatch: {

      weight: 15,

      big:
        patternMatchComp.big,

      small:
        patternMatchComp.small,

      matches:
        patternMatches.matches,

      evidence:
        patternMatchComponent(
          sequence
        ).evidence
    },

    streak: {

      weight: 8,

      big:
        streak.big,

      small:
        streak.small,

      evidence:
        historicalStreakSupport(
          sequence
        ).evidence
    },

    switching: {

      weight: 8,

      big:
        switchingComp.big,

      small:
        switchingComp.small,

      evidence:
        switchingComponent(
          sequence
        ).evidence
    },

    runs: {

      weight: 7,

      big:
        runComp.big,

      small:
        runComp.small,

      evidence:
        runComponent(
          sequence
        ).evidence
    },

    digitFrequency: {

      weight: 6,

      big:
        digitComp.big,

      small:
        digitComp.small,

      evidence:
        digitComponent(
          validRows
        ).evidence
    },

    gap: {

      weight: 4,

      big:
        gapComp.big,

      small:
        gapComp.small,

      evidence:
        gapComponent(
          sequence
        ).evidence
    },

    repetition: {

      weight: 4,

      big:
        repetitionComp.big,

      small:
        repetitionComp.small,

      evidence:
        repetitionComponent(
          sequence
        ).evidence
    }
  };

  /* -------------------------------------------------------
     WEIGHTED SUPPORT
  ------------------------------------------------------- */

  let supportBig = 0;
  let supportSmall = 0;
  let totalWeight = 0;

  for (
    const component
    of Object.values(
      components
    )
  ) {

    const weight =
      Number(
        component.weight
      ) || 0;

    supportBig +=
      component.big *
      weight;

    supportSmall +=
      component.small *
      weight;

    totalWeight +=
      weight;
  }

  if (
    totalWeight > 0
  ) {

    supportBig /=
      totalWeight;

    supportSmall /=
      totalWeight;
  }

  const supportTotal =
    supportBig +
    supportSmall;

  if (
    supportTotal > 0
  ) {

    supportBig =
      supportBig /
      supportTotal *
      100;

    supportSmall =
      supportSmall /
      supportTotal *
      100;

  } else {

    supportBig = 50;
    supportSmall = 50;
  }

  supportBig =
    round2(
      supportBig
    );

  supportSmall =
    round2(
      supportSmall
    );

  /* -------------------------------------------------------
     FINAL SIDE
  ------------------------------------------------------- */

  const finalSide =
    supportBig >=
    supportSmall
      ? "BIG"
      : "SMALL";

  /* -------------------------------------------------------
     AGREEMENT
  ------------------------------------------------------- */

  const agreement =
    agreementAnalysis(
      components,
      finalSide
    );

  /*
    Conflict means at least 3 directional
    signals and less than 60% agree.
  */

  const evidenceConflict =
    agreement.directional >= 3 &&
    agreement.agreementRatio < 0.60;

  /* -------------------------------------------------------
     CONFIDENCE
  ------------------------------------------------------- */

  const confidence =
    calculateConfidence(
      supportBig,
      supportSmall,
      total,
      agreement,
      components,
      {
        momentum,
        patternMatches,
        switching,
        transitions
      }
    );

  if (
    evidenceConflict
  ) {

    confidence.level =
      "LOW";

    confidence.reason =
      "Mixed Evidence";

    confidence.score =
      Math.min(
        confidence.score,
        59
      );
  }

  if (
    Math.abs(
      supportBig -
      supportSmall
    ) < 7
  ) {

    confidence.level =
      "LOW";

    confidence.reason =
      "Low Confidence";

    confidence.score =
      Math.min(
        confidence.score,
        55
      );
  }

  return {

    status:
      "COMPLETE",

    totalResults:
      total,

    sequence,

    overall,

    windows,

    currentStreak:
      runs.currentStreak,

    longestBigStreak:
      runs.longestBigStreak,

    longestSmallStreak:
      runs.longestSmallStreak,

    switchRate:
      switching.switchRate,

    switching,

    transitions,

    runs,

    momentum,

    digitFrequency,

    gap,

    patterns,

    patternMatches,

    statisticalSupport: {

      big:
        supportBig,

      small:
        supportSmall
    },

    statisticalLean:
      finalSide,

    components,

    agreement:
      agreement.agreement,

    agreementDetails:
      agreement,

    evidenceConflict,

    confidence,

    warning:
      "Historical patterns do not guarantee the next result.",

    safetyLabel:
      "STATISTICAL PATTERN SCORE"
  };
}


/* =========================================================
   MODEL
========================================================= */

function calculateModel(rows) {

  const analysis =
    completeAnalysis(
      rows
    );

  if (
    analysis.status !==
    "COMPLETE"
  ) {

    return {

      prediction: null,

      confidence: 0,

      confidenceLevel: "LOW",

      reason:
        "Insufficient Data",

      modelVersion:
        MODEL_VERSION,

      analysis,

      thinkingDurationMs:
        THINKING_DURATION_MS,

      warning:
        "Historical patterns do not guarantee the next result."
    };
  }

  const big =
    analysis
      .statisticalSupport
      .big;

  const small =
    analysis
      .statisticalSupport
      .small;

  const prediction =
    big >= small
      ? "BIG"
      : "SMALL";

  let reason =
    analysis.confidence.reason;

  if (
    analysis.evidenceConflict
  ) {

    reason =
      "Mixed Evidence";

  } else {

    const primaryPattern =
      analysis.patterns
        ?.primary
        ?.name;

    if (
      primaryPattern &&
      primaryPattern !==
        "NO STRONG PATTERN"
    ) {

      reason =
        `${primaryPattern} · ${analysis.confidence.level}`;

    } else {

      reason =
        `Multi-factor statistical analysis · ${analysis.confidence.level}`;
    }
  }

  return {

    prediction,

    confidence:
      clamp(
        analysis.confidence.score,
        1,
        95
      ),

    confidenceLevel:
      analysis.confidence.level,

    reason,

    modelVersion:
      MODEL_VERSION,

    analysis,

    thinkingDurationMs:
      THINKING_DURATION_MS,

    warning:
      "Historical patterns do not guarantee the next result."
  };
}


/* =========================================================
   GENERATE PREDICTION
========================================================= */

function generatePrediction() {

  const target =
    resolveTargetIssue();

  if (!target) {
    return null;
  }

  if (
    modelCache.targetIssue ===
      target &&
    modelCache.analysis
  ) {

    return modelCache;
  }

  const model =
    calculateModel(
      providerState.history
    );

  modelCache = {

    targetIssue:
      target,

    prediction:
      model.prediction,

    confidence:
      model.confidence,

    confidenceLevel:
      model.confidenceLevel,

    reason:
      model.reason,

    modelVersion:
      model.modelVersion,

    generatedAt:
      now(),

    thinkingDurationMs:
      THINKING_DURATION_MS,

    analysis:
      model.analysis
  };

  if (
    model.prediction
  ) {

    savePrediction(
      modelCache
    ).catch(
      error => {

        console.error(
          "Prediction save error:",
          error.message
        );
      }
    );
  }

  return modelCache;
}


/* =========================================================
   SAVE PREDICTION
========================================================= */

async function savePrediction(
  prediction
) {

  if (!pool) {
    return;
  }

  if (
    !prediction?.targetIssue ||
    !prediction?.prediction
  ) {
    return;
  }

  const existing =
    await pool.query(
      `
      SELECT id
      FROM prediction_records
      WHERE target_issue = $1
      ORDER BY id DESC
      LIMIT 1
      `,
      [
        prediction.targetIssue
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

      prediction.targetIssue,

      prediction.prediction,

      prediction.confidence,

      prediction.modelVersion,

      now()
    ]
  );
}


/* =========================================================
   SETTLEMENT
========================================================= */

async function settlePredictions(
  history
) {

  if (!pool) {
    return;
  }

  if (
    !Array.isArray(history)
  ) {
    return;
  }

  for (
    const row of history
  ) {

    const issue =
      row?.issueNumber;

    const actual =
      normalizeResult(row);

    if (
      !issue ||
      !actual
    ) {
      continue;
    }

    const actualNumber =
      safeNumber(
        row.number
      );

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

        actualNumber,

        actual,

        now(),

        issue

      ]
    );
  }
}


/* =========================================================
   ACCESS KEY
========================================================= */

async function validateAccessKey(
  accessKey,
  deviceId
) {

  if (!pool) {

    return {

      ok: true,

      mode:
        "database-not-configured"
    };
  }

  if (!accessKey) {

    return {

      ok: false,

      error:
        "Access key required"
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
        "Invalid access key"
    };
  }

  const row =
    result.rows[0];

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
        deviceId || null,
        now(),
        row.id
      ]
    );

    return {

      ok: true,

      bound: true
    };
  }

  if (!deviceId) {

    return {

      ok: false,

      error:
        "Device ID required"
    };
  }

  if (
    String(row.device_id) !==
    String(deviceId)
  ) {

    return {

      ok: false,

      error:
        "This key is already linked to another device"
    };
  }

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

  return {
    ok: true
  };
}


/* =========================================================
   ADMIN AUTH
========================================================= */

function adminAuthorized(req) {

  if (!ADMIN_KEY) {
    return false;
  }

  const supplied =
    String(
      req.headers[
        "x-admin-key"
      ] || ""
    ).trim();

  return (
    supplied &&
    supplied === ADMIN_KEY
  );
}


/* =========================================================
   BODY PARSER
========================================================= */

function readBody(req) {

  return new Promise(
    (resolve, reject) => {

      let body = "";

      req.on(
        "data",
        chunk => {

          body += chunk;

          if (
            body.length >
            1024 * 1024
          ) {

            req.destroy();

            reject(
              new Error(
                "Request body too large"
              )
            );
          }
        }
      );

      req.on(
        "end",
        () => {

          if (!body) {

            resolve({});

            return;
          }

          try {

            resolve(
              JSON.parse(body)
            );

          } catch {

            reject(
              new Error(
                "Invalid JSON body"
              )
            );
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


/* =========================================================
   ADMIN ACCESS KEYS
========================================================= */

async function adminKeys(
  req,
  res,
  url
) {

  if (!adminAuthorized(req)) {

    json(res, 401, {

      ok: false,

      error:
        "Unauthorized"

    });

    return;
  }

  if (!pool) {

    json(res, 500, {

      ok: false,

      error:
        "DATABASE_URL not configured"

    });

    return;
  }

  if (
    req.method ===
    "GET"
  ) {

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

    json(res, 200, {

      ok: true,

      keys:
        result.rows

    });

    return;
  }

  if (
    req.method ===
    "POST"
  ) {

    const body =
      await readBody(req);

    let key =
      String(
        body.key ||
        body.access_key ||
        ""
      ).trim();

    if (!key) {

      key =
        "DY-" +
        Math.random()
          .toString(36)
          .slice(2, 12)
          .toUpperCase();
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
          VALUES ($1,$2)
          RETURNING *
          `,
          [
            key,
            now()
          ]
        );

      json(res, 200, {

        ok: true,

        access_key:
          result.rows[0]
            .access_key,

        key:
          result.rows[0]

      });

    } catch (error) {

      if (
        error.code ===
        "23505"
      ) {

        json(res, 409, {

          ok: false,

          error:
            "Key already exists"

        });

        return;
      }

      throw error;
    }

    return;
  }

  if (
    req.method ===
    "DELETE"
  ) {

    let id =
      url.searchParams.get(
        "id"
      );

    let key =
      url.searchParams.get(
        "key"
      );

    if (
      !id &&
      !key
    ) {

      try {

        const body =
          await readBody(req);

        id =
          body.id
            ? String(
                body.id
              )
            : null;

        key =
          body.key ||
          body.access_key ||
          null;

      } catch {
        // ignore
      }
    }

    if (
      !id &&
      !key
    ) {

      json(res, 400, {

        ok: false,

        error:
          "id or key required"

      });

      return;
    }

    if (id) {

      await pool.query(
        `
        DELETE FROM access_keys
        WHERE id = $1
        `,
        [
          id
        ]
      );

    } else {

      await pool.query(
        `
        DELETE FROM access_keys
        WHERE access_key = $1
        `,
        [
          key
        ]
      );
    }

    json(res, 200, {

      ok: true

    });

    return;
  }

  json(res, 405, {

    ok: false,

    error:
      "Method not allowed"

  });
}


/* =========================================================
   RESET DEVICE
========================================================= */

async function resetDevice(
  req,
  res
) {

  if (!adminAuthorized(req)) {

    json(res, 401, {

      ok: false,

      error:
        "Unauthorized"

    });

    return;
  }

  if (!pool) {

    json(res, 500, {

      ok: false,

      error:
        "DATABASE_URL not configured"

    });

    return;
  }

  const body =
    await readBody(req);

  const id =
    body.id;

  const key =
    String(
      body.key ||
      body.access_key ||
      ""
    ).trim();

  if (
    !id &&
    !key
  ) {

    json(res, 400, {

      ok: false,

      error:
        "id or key required"

    });

    return;
  }

  if (id) {

    await pool.query(
      `
      UPDATE access_keys
      SET
        device_id = NULL,
        last_seen = 0
      WHERE id = $1
      `,
      [
        id
      ]
    );

  } else {

    await pool.query(
      `
      UPDATE access_keys
      SET
        device_id = NULL,
        last_seen = 0
      WHERE access_key = $1
      `,
      [
        key
      ]
    );
  }

  json(res, 200, {

    ok: true,

    message:
      "Device binding reset"

  });
}


/* =========================================================
   ADMIN STATUS
========================================================= */

async function adminStatus(
  req,
  res
) {

  if (!adminAuthorized(req)) {

    json(res, 401, {

      ok: false,

      error:
        "Unauthorized"

    });

    return;
  }

  let db = false;

  if (pool) {

    try {

      await pool.query(
        "SELECT 1"
      );

      db = true;

    } catch {
      db = false;
    }
  }

  json(res, 200, {

    ok: true,

    server: true,

    environment:
      process.env.NODE_ENV ||
      "production",

    database:
      db,

    wingobot:
      Boolean(
        WINGOBOT_TOKEN
      ),

    provider:
      providerState.ok,

    currentIssue:
      providerState.currentIssue,

    historyCount:
      providerState.history.length,

    last_updated:
      providerState.lastUpdated,

    targetIssue:
      resolveTargetIssue(),

    thinkingDurationMs:
      THINKING_DURATION_MS,

    model:
      modelCache
  });
}


/* =========================================================
   KEY CHECK
========================================================= */

async function keyCheck(
  req,
  res
) {

  const accessKey =
    String(
      req.headers[
        "x-access-key"
      ] || ""
    ).trim();

  const deviceId =
    String(
      req.headers[
        "x-device-id"
      ] || ""
    ).trim();

  try {

    const result =
      await validateAccessKey(
        accessKey,
        deviceId
      );

    json(
      res,
      200,
      result
    );

  } catch (error) {

    json(res, 500, {

      ok: false,

      error:
        error.message

    });
  }
}


/* =========================================================
   MAIN STATE API
========================================================= */

async function stateApi(
  req,
  res
) {

  const accessKey =
    String(
      req.headers[
        "x-access-key"
      ] || ""
    ).trim();

  const deviceId =
    String(
      req.headers[
        "x-device-id"
      ] || ""
    ).trim();

  try {

    const auth =
      await validateAccessKey(
        accessKey,
        deviceId
      );

    if (!auth.ok) {

      json(
        res,
        403,
        auth
      );

      return;
    }

    const target =
      resolveTargetIssue();

    const prediction =
      target
        ? (
            modelCache.targetIssue ===
            target
              ? modelCache
              : generatePrediction()
          )
        : null;

    json(res, 200, {

      ok: true,

      provider: {

        connected:
          providerState.ok,

        currentIssue:
          providerState.currentIssue,

        fetched:
          providerState.fetched,

        lastUpdated:
          providerState.lastUpdated,

        fetchedAt:
          providerState.fetchedAt,

        error:
          providerState.error

      },

      targetIssue:
        target,

      thinkingDurationMs:
        THINKING_DURATION_MS,

      prediction:
        prediction
          ? {

              targetIssue:
                prediction.targetIssue,

              prediction:
                prediction.prediction,

              confidence:
                prediction.confidence,

              confidenceLevel:
                prediction.confidenceLevel,

              reason:
                prediction.reason,

              modelVersion:
                prediction.modelVersion,

              generatedAt:
                prediction.generatedAt,

              thinkingDurationMs:
                prediction.thinkingDurationMs,

              statisticalSupport:
                prediction.analysis
                  ?.statisticalSupport ||
                null,

              agreement:
                prediction.analysis
                  ?.agreement ??
                0,

              evidenceConflict:
                prediction.analysis
                  ?.evidenceConflict ??
                false,

              analysis:
                prediction.analysis ||
                null,

              warning:
                "Historical patterns do not guarantee the next result."

            }
          : null,

      history:
        providerState.history
          .slice(0, 30)
          .map(
            row => ({

              issueNumber:
                row.issueNumber,

              number:
                row.number,

              result:
                row.result,

              colour:
                row.colour,

              premium:
                row.premium,

              sum:
                row.sum

            })
          )

    });

  } catch (error) {

    json(res, 500, {

      ok: false,

      error:
        error.message

    });
  }
}


/* =========================================================
   HISTORY API
========================================================= */

async function historyApi(
  req,
  res
) {

  if (!pool) {

    json(res, 200, {

      ok: true,

      history: []

    });

    return;
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
        LIMIT 30
        `
      );

    json(res, 200, {

      ok: true,

      history:
        result.rows

    });

  } catch (error) {

    json(res, 500, {

      ok: false,

      error:
        error.message

    });
  }
}


/* =========================================================
   ADMIN PING
========================================================= */

async function adminPing(
  req,
  res
) {

  if (!adminAuthorized(req)) {

    json(res, 401, {

      ok: false,

      error:
        "Unauthorized"

    });

    return;
  }

  json(res, 200, {

    ok: true,

    message:
      "PONG",

    time:
      now()

  });
}


/* =========================================================
   ADMIN WINGO TEST
========================================================= */

async function adminWingoTest(
  req,
  res
) {

  if (!adminAuthorized(req)) {

    json(res, 401, {

      ok: false,

      error:
        "Unauthorized"

    });

    return;
  }

  try {

    await refreshProvider();

    json(res, 200, {

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

    });

  } catch (error) {

    json(res, 500, {

      ok: false,

      error:
        error.message

    });
  }
}


/* =========================================================
   ADMIN MODEL TEST
========================================================= */

async function adminModelTest(
  req,
  res
) {

  if (!adminAuthorized(req)) {

    json(res, 401, {

      ok: false,

      error:
        "Unauthorized"

    });

    return;
  }

  const result =
    calculateModel(
      providerState.history
    );

  json(res, 200, {

    ok: true,

    targetIssue:
      resolveTargetIssue(),

    thinkingDurationMs:
      THINKING_DURATION_MS,

    model:
      result

  });
}


/* =========================================================
   STATIC MIME
========================================================= */

function contentType(file) {

  const ext =
    path.extname(file)
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

    ".png":
      "image/png",

    ".jpg":
      "image/jpeg",

    ".jpeg":
      "image/jpeg",

    ".svg":
      "image/svg+xml",

    ".ico":
      "image/x-icon",

    ".mp3":
      "audio/mpeg",

    ".wav":
      "audio/wav",

    ".webp":
      "image/webp",

    ".txt":
      "text/plain; charset=utf-8"

  };

  return (
    types[ext] ||
    "application/octet-stream"
  );
}


/* =========================================================
   STATIC FILE SERVER
========================================================= */

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

  const filePath =
    path.resolve(
      PUBLIC_DIR,
      "." + requested
    );

  if (
    filePath !==
      PUBLIC_DIR &&
    !filePath.startsWith(
      PUBLIC_DIR +
      path.sep
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
      stat
    ) => {

      if (
        error ||
        !stat.isFile()
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

      /* -----------------------------------------------------
         MP3 RANGE
      ----------------------------------------------------- */

      if (
        type ===
        "audio/mpeg"
      ) {

        const range =
          req.headers.range;

        if (range) {

          const match =
            /^bytes=(\d*)-(\d*)$/
              .exec(
                range
              );

          if (!match) {

            res.writeHead(
              416,
              {
                "Content-Range":
                  `bytes */${stat.size}`
              }
            );

            res.end();

            return;
          }

          const fileSize =
            stat.size;

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
              : fileSize - 1;

          if (
            !Number.isFinite(start) ||
            !Number.isFinite(end) ||
            start < 0 ||
            start >= fileSize ||
            end < start
          ) {

            res.writeHead(
              416,
              {
                "Content-Range":
                  `bytes */${fileSize}`
              }
            );

            res.end();

            return;
          }

          end =
            Math.min(
              end,
              fileSize - 1
            );

          const chunkSize =
            end -
            start +
            1;

          res.writeHead(
            206,
            {

              "Content-Type":
                "audio/mpeg",

              "Content-Length":
                String(
                  chunkSize
                ),

              "Content-Range":
                `bytes ${start}-${end}/${fileSize}`,

              "Accept-Ranges":
                "bytes",

              "Cache-Control":
                "public, max-age=3600"

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
              "audio/mpeg",

            "Content-Length":
              String(
                stat.size
              ),

            "Accept-Ranges":
              "bytes",

            "Cache-Control":
              "public, max-age=3600"

          }
        );

        fs.createReadStream(
          filePath
        ).pipe(res);

        return;
      }

      /* -----------------------------------------------------
         NORMAL FILE
      ----------------------------------------------------- */

      const headers = {

        "Content-Type":
          type,

        "Content-Length":
          String(
            stat.size
          ),

        "Cache-Control":
          type.startsWith(
            "text/html"
          )
            ? "no-store"
            : "public, max-age=3600"

      };

      res.writeHead(
        200,
        headers
      );

      fs.createReadStream(
        filePath
      ).pipe(res);
    }
  );
}


/* =========================================================
   HTTP SERVER
========================================================= */

const server =
  http.createServer(
    async (
      req,
      res
    ) => {

      try {

        /* ---------------------------------------------------
           OPTIONS
        --------------------------------------------------- */

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
                "Content-Type, X-Access-Key, X-Device-Id, X-Admin-Key, Authorization",

              "Access-Control-Allow-Methods":
                "GET, POST, DELETE, OPTIONS",

              "Access-Control-Max-Age":
                "86400"

            }
          );

          res.end();

          return;
        }

        const url =
          new URL(
            req.url,
            `http://${req.headers.host || "localhost"}`
          );

        const pathname =
          url.pathname;

        /* ---------------------------------------------------
           HEALTH
        --------------------------------------------------- */

        if (
          pathname ===
          "/health"
        ) {

          json(
            res,
            200,
            {

              ok: true,

              service:
                "DY AI Wingo",

              version:
                MODEL_VERSION,

              uptime:
                process.uptime(),

              provider:
                providerState.ok,

              history:
                providerState.history.length,

              time:
                now()

            }
          );

          return;
        }

        /* ---------------------------------------------------
           KEY CHECK
        --------------------------------------------------- */

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

        /* ---------------------------------------------------
           STATE
        --------------------------------------------------- */

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

        /* ---------------------------------------------------
           HISTORY
        --------------------------------------------------- */

        if (
          pathname ===
            "/api/history" &&
          req.method ===
            "GET"
        ) {

          await historyApi(
            req,
            res
          );

          return;
        }

        /* ---------------------------------------------------
           ADMIN KEYS
        --------------------------------------------------- */

        if (
          pathname ===
          "/api/admin/keys"
        ) {

          await adminKeys(
            req,
            res,
            url
          );

          return;
        }

        /* ---------------------------------------------------
           RESET DEVICE
        --------------------------------------------------- */

        if (
          pathname ===
            "/api/admin/reset-device" &&
          req.method ===
            "POST"
        ) {

          await resetDevice(
            req,
            res
          );

          return;
        }

        /* ---------------------------------------------------
           ADMIN STATUS
        --------------------------------------------------- */

        if (
          pathname ===
            "/api/admin/status" &&
          req.method ===
            "GET"
        ) {

          await adminStatus(
            req,
            res
          );

          return;
        }

        /* ---------------------------------------------------
           ADMIN PING
        --------------------------------------------------- */

        if (
          pathname ===
            "/api/admin/ping" &&
          req.method ===
            "GET"
        ) {

          await adminPing(
            req,
            res
          );

          return;
        }

        /* ---------------------------------------------------
           ADMIN WINGO TEST
        --------------------------------------------------- */

        if (
          pathname ===
            "/api/admin/wingo-test" &&
          req.method ===
            "GET"
        ) {

          await adminWingoTest(
            req,
            res
          );

          return;
        }

        /* ---------------------------------------------------
           ADMIN MODEL TEST
        --------------------------------------------------- */

        if (
          pathname ===
            "/api/admin/model-test" &&
          req.method ===
            "GET"
        ) {

          await adminModelTest(
            req,
            res
          );

          return;
        }

        /* ---------------------------------------------------
           STATIC
        --------------------------------------------------- */

        serveStatic(
          req,
          res,
          pathname
        );

      } catch (error) {

        console.error(
          "Server request error:",
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
                "Internal server error"

            }
          );

        } else {

          res.end();
        }
      }
    }
  );


/* =========================================================
   STARTUP
========================================================= */

async function start() {

  try {

    await initDatabase();

    server.listen(
      PORT,
      HOST,
      () => {

        console.log(
          `DY AI server running on port ${PORT}`
        );

        console.log(
          `Model: ${MODEL_VERSION}`
        );

        console.log(
          `Thinking duration: ${THINKING_DURATION_MS}ms`
        );

        console.log(
          `WingoBot token: ${
            WINGOBOT_TOKEN
              ? "configured"
              : "missing"
          }`
        );

        console.log(
          `Database: ${
            pool
              ? "configured"
              : "missing"
          }`
        );
      }
    );

    /*
      Initial provider fetch.
    */

    await refreshProvider();

    /*
      Refresh every 3 seconds.
    */

    setInterval(
      () => {

        refreshProvider()
          .catch(
            error => {

              console.error(
                "Refresh loop:",
                error.message
              );

            }
          );

      },
      3000
    );

  } catch (error) {

    console.error(
      "Startup error:",
      error
    );

    if (
      !server.listening
    ) {

      server.listen(
        PORT,
        HOST,
        () => {

          console.log(
            `DY AI server running on port ${PORT}`
          );

        }
      );
    }
  }
}


/* =========================================================
   PROCESS ERROR HANDLERS
========================================================= */

process.on(
  "unhandledRejection",
  error => {

    console.error(
      "Unhandled rejection:",
      error
    );

  }
);


process.on(
  "uncaughtException",
  error => {

    console.error(
      "Uncaught exception:",
      error
    );

  }
);


/* =========================================================
   START
========================================================= */

start();
