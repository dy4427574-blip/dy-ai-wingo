"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 10000);

const ADMIN_KEY = String(
  process.env.ADMIN_KEY || "dy4427574"
).trim();

const WINGOBOT_TOKEN = String(
  process.env.WINGOBOT_TOKEN || ""
).trim();

const WINGOBOT_URL = String(
  process.env.WINGOBOT_URL ||
  "https://api.wingobot.com/v2/30-sec-game-history"
).trim();

const ROUND_SECONDS = 30;
const LIVE_RESULTS_LIMIT = 30;
const WINLOSS_LIMIT = 30;
const BACKTEST_MAX_TESTS = 120;

const ROOT = __dirname;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

const state = {
  ready: false,
  database: false,
  wingobot: false,

  history: [],
  analysis: null,

  settledIssue: null,
  targetIssue: null,

  providerCurrentIssue: null,
  providerCountdown: null,

  historySignature: "",
  lastHistoryUpdate: 0,

  timerAnchorMs: Date.now(),

  lastError: null
};

function now() {
  return Date.now();
}

function json(res, status, data) {
  const body = JSON.stringify(data);

  res.writeHead(status, {
    "Content-Type":
      "application/json; charset=utf-8",

    "Cache-Control":
      "no-store, no-cache, must-revalidate",

    "Access-Control-Allow-Origin":
      "*",

    "Access-Control-Allow-Headers":
      "Content-Type, X-Admin-Key, X-Access-Key, X-Device-ID, Authorization",

    "Access-Control-Allow-Methods":
      "GET, POST, DELETE, OPTIONS"
  });

  res.end(body);
}

function text(
  res,
  status,
  body,
  type = "text/plain; charset=utf-8"
) {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });

  res.end(body);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk;

      if (body.length > 2 * 1024 * 1024) {
        reject(
          new Error("Request body too large")
        );

        req.destroy();
      }
    });

    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(
          new Error("Invalid JSON")
        );
      }
    });

    req.on("error", reject);
  });
}

/* =========================================================
   AUTH
========================================================= */

function requireAdmin(req, res) {
  const key = String(
    req.headers["x-admin-key"] ||
    req.headers.authorization?.replace(
      /^Bearer\s+/i,
      ""
    ) ||
    ""
  ).trim();

  if (!key || key !== ADMIN_KEY) {
    json(res, 401, {
      success: false,
      ok: false,
      message: "Invalid admin key"
    });

    return false;
  }

  return true;
}

function getAccessKey(req) {
  return String(
    req.headers["x-access-key"] ||
    req.headers.authorization?.replace(
      /^Bearer\s+/i,
      ""
    ) ||
    ""
  ).trim();
}

function getDeviceId(req) {
  return String(
    req.headers["x-device-id"] || ""
  ).trim();
}

/* =========================================================
   BASIC HELPERS
========================================================= */

function cleanIssue(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  const s = String(value).trim();

  return s || null;
}

function getNumber(row) {
  const values = [
    row?.number,
    row?.num,
    row?.result,
    row?.openNumber
  ];

  for (const value of values) {
    if (
      value !== null &&
      value !== undefined &&
      value !== ""
    ) {
      const n = Number(value);

      if (
        Number.isInteger(n) &&
        n >= 0 &&
        n <= 9
      ) {
        return n;
      }
    }
  }

  return null;
}

function classifyNumber(number) {
  const n = Number(number);

  if (!Number.isInteger(n)) {
    return null;
  }

  if (n >= 5) {
    return "BIG";
  }

  return "SMALL";
}

function normalizeSide(value, number) {
  const s = String(
    value || ""
  )
    .trim()
    .toUpperCase();

  if (
    s === "BIG" ||
    s === "SMALL"
  ) {
    return s;
  }

  return classifyNumber(number);
}

function compareIssueDesc(a, b) {
  try {
    const x = BigInt(String(a));
    const y = BigInt(String(b));

    if (x === y) return 0;
    return x > y ? -1 : 1;
  } catch {
    return String(b).localeCompare(
      String(a)
    );
  }
}

function incrementIssue(issue) {
  if (!issue) return null;

  try {
    return String(
      BigInt(String(issue)) + 1n
    );
  } catch {
    return null;
  }
}

function makeHistorySignature(history) {
  return history
    .slice(0, 30)
    .map(
      row =>
        `${row.issueNumber}:${row.number}`
    )
    .join("|");
}

/* =========================================================
   WINGOBOT DATA
========================================================= */

function extractRows(data) {
  let rows = [];

  if (Array.isArray(data)) {
    rows = data;
  } else if (
    Array.isArray(data?.history)
  ) {
    rows = data.history;
  } else if (
    Array.isArray(data?.data)
  ) {
    rows = data.data;
  } else if (
    Array.isArray(data?.data?.history)
  ) {
    rows = data.data.history;
  } else if (
    Array.isArray(data?.result?.history)
  ) {
    rows = data.result.history;
  } else if (
    Array.isArray(data?.records)
  ) {
    rows = data.records;
  }

  const normalized = [];

  for (const row of rows) {
    if (
      !row ||
      typeof row !== "object"
    ) {
      continue;
    }

    const issue = cleanIssue(
      row.issueNumber ??
      row.issue_number ??
      row.period ??
      row.issue ??
      row.id
    );

    const number = getNumber(row);

    if (!issue || number === null) {
      continue;
    }

    normalized.push({
      issueNumber: issue,
      number,

      side: normalizeSide(
        row.colour ??
        row.color ??
        row.side ??
        row.bigSmall ??
        row.big_small,
        number
      ),

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
    });
  }

  const unique = new Map();

  for (const row of normalized) {
    if (
      !unique.has(
        row.issueNumber
      )
    ) {
      unique.set(
        row.issueNumber,
        row
      );
    }
  }

  return Array.from(
    unique.values()
  ).sort(compareIssueDesc);
}

function extractCurrentIssue(data) {
  return cleanIssue(
    data?.current?.issueNumber ??
    data?.current?.issue_number ??
    data?.current?.period ??
    data?.currentIssue ??
    data?.current_issue ??
    null
  );
}

function extractCountdown(data) {
  const values = [
    data?.countdown,
    data?.countdownSeconds,
    data?.countdown_seconds,

    data?.current?.countdown,
    data?.current?.countdownSeconds,
    data?.current?.countdown_seconds,

    data?.timer,
    data?.remaining
  ];

  for (const value of values) {
    const n = Number(value);

    if (
      Number.isFinite(n) &&
      n >= 0 &&
      n <= 120
    ) {
      return Math.floor(n);
    }
  }

  return null;
}

async function fetchWingo() {
  if (!WINGOBOT_TOKEN) {
    throw new Error(
      "WINGOBOT_TOKEN is not configured"
    );
  }

  const response = await fetch(
    WINGOBOT_URL,
    {
      method: "GET",

      headers: {
        Authorization:
          `Bearer ${WINGOBOT_TOKEN}`,

        Accept:
          "application/json"
      }
    }
  );

  const body =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `WingoBot HTTP ${response.status}: ${body.slice(
        0,
        300
      )}`
    );
  }

  let data;

  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(
      "WingoBot returned invalid JSON"
    );
  }

  const history =
    extractRows(data);

  if (!history.length) {
    throw new Error(
      "WingoBot returned no valid history"
    );
  }

  return {
    history,

    currentIssue:
      extractCurrentIssue(data),

    providerCountdown:
      extractCountdown(data)
  };
}

/* =========================================================
   TIMER
========================================================= */

function updateTimerAnchor() {
  state.timerAnchorMs = now();
}

function getEstimatedCountdown() {
  if (
    state.providerCountdown !== null &&
    Number.isFinite(
      state.providerCountdown
    )
  ) {
    const elapsed =
      Math.floor(
        (now() -
          state.timerAnchorMs) /
          1000
      );

    const value =
      state.providerCountdown -
      elapsed;

    if (
      value >= 0 &&
      value <= 30
    ) {
      return value;
    }
  }

  const elapsed =
    Math.floor(
      (now() -
        state.timerAnchorMs) /
        1000
    );

  const value =
    ROUND_SECONDS -
    (elapsed % ROUND_SECONDS);

  return value === 0
    ? ROUND_SECONDS
    : value;
}

/* =========================================================
   MODEL DATA
========================================================= */

function getSequence(history) {
  return history
    .map(row => row.side)
    .filter(
      side =>
        side === "BIG" ||
        side === "SMALL"
    );
}

function getNumbers(history) {
  return history
    .map(row => row.number)
    .filter(
      n =>
        Number.isInteger(n) &&
        n >= 0 &&
        n <= 9
    );
}

function rateFor(values) {
  if (!values.length) {
    return 0.5;
  }

  const big =
    values.filter(
      x => x === "BIG"
    ).length;

  return (
    big / values.length
  );
}

function scoreToSide(
  score,
  threshold = 0.12
) {
  if (score > threshold) {
    return "BIG";
  }

  if (score < -threshold) {
    return "SMALL";
  }

  return null;
}

/* =========================================================
   MODEL 1
   MULTI WINDOW RECENCY
========================================================= */

function recencyEvidence(seq) {
  if (seq.length < 5) {
    return null;
  }

  const windows = [
    {
      size: 3,
      weight: 0.90
    },
    {
      size: 5,
      weight: 1.00
    },
    {
      size: 8,
      weight: 0.80
    },
    {
      size: 10,
      weight: 0.55
    }
  ];

  let score = 0;
  let totalWeight = 0;

  for (const window of windows) {
    const slice =
      seq.slice(
        0,
        Math.min(
          window.size,
          seq.length
        )
      );

    if (slice.length < 3) {
      continue;
    }

    const p =
      rateFor(slice);

    score +=
      (p - 0.5) *
      2 *
      window.weight;

    totalWeight +=
      window.weight;
  }

  if (!totalWeight) {
    return null;
  }

  const normalized =
    score / totalWeight;

  const side =
    scoreToSide(
      normalized,
      0.08
    );

  if (!side) {
    return null;
  }

  return {
    name:
      "Multi-Window Recency",

    side,

    strength:
      Math.round(
        50 +
        Math.abs(normalized) *
          35
      ),

    sample:
      Math.min(
        seq.length,
        10
      ),

    edge:
      Math.abs(normalized)
  };
}

/* =========================================================
   MODEL 2
   CONDITIONAL TRANSITION
========================================================= */

function transitionEvidence(seq) {
  if (seq.length < 6) {
    return null;
  }

  const current =
    seq[0];

  let same = 0;
  let flip = 0;
  let samples = 0;

  /*
   * Historical cases where the same current side
   * appeared and what followed it.
   */
  for (
    let i = 1;
    i < seq.length - 1;
    i++
  ) {
    const previous =
      seq[i];

    const next =
      seq[i - 1];

    if (
      previous !== current
    ) {
      continue;
    }

    samples++;

    if (
      next === current
    ) {
      same++;
    } else {
      flip++;
    }
  }

  if (samples < 2) {
    return null;
  }

  const pSame =
    same / samples;

  const pFlip =
    flip / samples;

  const side =
    pSame >= pFlip
      ? current
      : current === "BIG"
        ? "SMALL"
        : "BIG";

  const edge =
    Math.abs(
      pSame - 0.5
    ) * 2;

  return {
    name:
      "Conditional Transition",

    side,

    strength:
      Math.round(
        50 +
        edge * 35
      ),

    sample: samples,

    edge
  };
}

/* =========================================================
   MODEL 3
   SEQUENCE PATTERN
========================================================= */

function patternEvidence(seq) {
  if (seq.length < 7) {
    return null;
  }

  let best = null;

  for (
    const length of [2, 3, 4]
  ) {
    if (
      seq.length <=
      length + 2
    ) {
      continue;
    }

    const pattern =
      seq
        .slice(0, length)
        .join(",");

    let matches = 0;
    let big = 0;
    let small = 0;

    for (
      let i = length;
      i < seq.length;
      i++
    ) {
      const previousPattern =
        seq
          .slice(
            i - length,
            i
          )
          .join(",");

      if (
        previousPattern !==
        pattern
      ) {
        continue;
      }

      matches++;

      if (
        seq[i] === "BIG"
      ) {
        big++;
      } else {
        small++;
      }
    }

    if (matches < 2) {
      continue;
    }

    const side =
      big >= small
        ? "BIG"
        : "SMALL";

    const edge =
      Math.abs(
        big / matches -
          0.5
      ) * 2;

    const candidate = {
      name:
        `Sequence ${length}`,

      side,

      strength:
        Math.round(
          50 +
          edge * 40
        ),

      sample:
        matches,

      edge
    };

    if (
      !best ||
      matches * edge >
        best.sample *
          best.edge
    ) {
      best =
        candidate;
    }
  }

  return best;
}

/* =========================================================
   MODEL 4
   STREAK + TRANSITION
========================================================= */

function streakEvidence(seq) {
  if (seq.length < 4) {
    return null;
  }

  const last =
    seq[0];

  let streak = 1;

  while (
    streak < seq.length &&
    seq[streak] === last
  ) {
    streak++;
  }

  if (streak < 3) {
    return null;
  }

  const transition =
    transitionEvidence(seq);

  if (!transition) {
    return null;
  }

  return {
    name:
      "Streak + Transition",

    side:
      transition.side,

    strength:
      Math.round(
        50 +
        Math.min(
          streak,
          6
        ) *
          3 +
        transition.edge *
          25
      ),

    sample:
      transition.sample,

    edge:
      transition.edge,

    streak
  };
}

/* =========================================================
   MODEL COLLECTION
========================================================= */

function runModels(history) {
  const seq =
    getSequence(history);

  if (seq.length < 5) {
    return [];
  }

  const models = [
    recencyEvidence(seq),
    transitionEvidence(seq),
    patternEvidence(seq),
    streakEvidence(seq)
  ].filter(Boolean);

  /*
   * Recent balance has deliberately low weight.
   * It can never dominate all other models.
   */
  if (seq.length >= 8) {
    const recent =
      seq.slice(
        0,
        Math.min(
          10,
          seq.length
        )
      );

    const p =
      rateFor(recent);

    const edge =
      Math.abs(
        p - 0.5
      ) * 2;

    const side =
      p >= 0.5
        ? "BIG"
        : "SMALL";

    if (edge >= 0.20) {
      models.push({
        name:
          "Recent Balance",

        side,

        strength:
          Math.round(
            50 +
            edge * 20
          ),

        sample:
          recent.length,

        edge,

        lowWeight:
          true
      });
    }
  }

  return models;
}

/* =========================================================
   ENSEMBLE
========================================================= */

function predictSide(history) {
  const models =
    runModels(history);

  if (!models.length) {
    return {
      side: null,
      confidence: 0,
      agreement: 0,
      patternScore: 0,
      models
    };
  }

  let bigScore = 0;
  let smallScore = 0;
  let totalWeight = 0;

  for (const model of models) {
    const sample =
      Math.max(
        Number(
          model.sample || 1
        ),
        1
      );

    const edge =
      Math.max(
        0.02,
        Number(
          model.edge || 0
        )
      );

    /*
     * Sample size helps but cannot dominate.
     */
    const sampleFactor =
      Math.min(
        1.25,
        0.75 +
          Math.log10(
            sample + 1
          ) *
            0.22
      );

    const strengthFactor =
      0.75 +
      Math.min(
        0.65,
        edge
      );

    const lowWeightFactor =
      model.lowWeight
        ? 0.35
        : 1;

    const weight =
      sampleFactor *
      strengthFactor *
      lowWeightFactor;

    if (
      model.side === "BIG"
    ) {
      bigScore += weight;
    }

    if (
      model.side === "SMALL"
    ) {
      smallScore += weight;
    }

    totalWeight += weight;
  }

  const difference =
    bigScore -
    smallScore;

  const normalizedEdge =
    Math.abs(difference) /
    Math.max(
      totalWeight,
      1
    );

  /*
   * With only 10 results, don't force a prediction
   * when the models disagree.
   */
  const minimumEdge =
    history.length < 15
      ? 0.16
      : 0.10;

  const side =
    normalizedEdge >=
    minimumEdge
      ? difference > 0
        ? "BIG"
        : "SMALL"
      : null;

  const agreement =
    Math.round(
      (
        Math.max(
          bigScore,
          smallScore
        ) /
        Math.max(
          totalWeight,
          1
        )
      ) * 100
    );

  const averageStrength =
    models.reduce(
      (sum, model) =>
        sum +
        Number(
          model.strength || 50
        ),
      0
    ) /
    models.length;

  const patternScore =
    Math.round(
      Math.min(
        100,
        averageStrength *
          0.45 +
          normalizedEdge *
            100 *
            0.55
      )
    );

  let confidence =
    Math.round(
      50 +
      normalizedEdge *
        55
    );

  confidence =
    Math.max(
      0,
      Math.min(
        confidence,
        78
      )
    );

  if (!side) {
    confidence = 0;
  }

  return {
    side,
    confidence,
    agreement,
    patternScore,
    models
  };
}

/* =========================================================
   BACKTEST
========================================================= */

function backtest(history) {
  if (history.length < 15) {
    return {
      samples: 0,
      wins: 0,
      losses: 0,
      accuracy: null
    };
  }

  const chronological =
    [...history].reverse();

  const start =
    Math.max(
      6,
      chronological.length -
        BACKTEST_MAX_TESTS
    );

  let tested = 0;
  let wins = 0;

  for (
    let i = start;
    i < chronological.length;
    i++
  ) {
    const training =
      chronological.slice(
        0,
        i
      );

    if (
      training.length < 5
    ) {
      continue;
    }

    const actual =
      chronological[i]?.side;

    if (
      actual !== "BIG" &&
      actual !== "SMALL"
    ) {
      continue;
    }

    const result =
      predictSide(
        training
      );

    if (!result.side) {
      continue;
    }

    tested++;

    if (
      result.side ===
      actual
    ) {
      wins++;
    }
  }

  if (!tested) {
    return {
      samples: 0,
      wins: 0,
      losses: 0,
      accuracy: null
    };
  }

  return {
    samples: tested,
    wins,
    losses:
      tested - wins,

    accuracy:
      Math.round(
        wins /
          tested *
          100
      )
  };
}

/* =========================================================
   NUMBER PREDICTION
========================================================= */

function chooseNumber(
  history,
  side
) {
  if (
    side !== "BIG" &&
    side !== "SMALL"
  ) {
    return null;
  }

  const numbers =
    getNumbers(history);

  if (!numbers.length) {
    return null;
  }

  const allowed =
    side === "BIG"
      ? [5, 6, 7, 8, 9]
      : [0, 1, 2, 3, 4];

  const score =
    new Map(
      allowed.map(
        n => [n, 0]
      )
    );

  numbers
    .slice(
      0,
      Math.min(
        60,
        numbers.length
      )
    )
    .forEach(
      (number, index) => {
        if (
          !score.has(number)
        ) {
          return;
        }

        const weight =
          1 /
          Math.sqrt(
            index + 1
          );

        score.set(
          number,
          score.get(number) +
            weight
        );
      }
    );

  /*
   * Don't blindly repeat the most frequent number.
   * Choose the least represented candidate from the
   * predicted BIG/SMALL class.
   */
  let best =
    allowed[0];

  let bestScore =
    Infinity;

  for (
    const number of allowed
  ) {
    const value =
      score.get(number) ||
      0;

    if (
      value < bestScore
    ) {
      bestScore = value;
      best = number;
    }
  }

  return best;
}

/* =========================================================
   FINAL AI ANALYSIS
========================================================= */

function adaptiveEnsemble(history) {
  const prediction =
    predictSide(history);

  const validation =
    backtest(history);

  let confidence =
    prediction.confidence;

  /*
   * Backtest matters only when enough historical
   * samples are available.
   */
  if (
    validation.samples >= 20 &&
    validation.accuracy !== null
  ) {
    confidence =
      Math.round(
        confidence * 0.60 +
        validation.accuracy *
          0.40
      );
  } else if (
    history.length < 15
  ) {
    confidence =
      Math.min(
        confidence,
        58
      );
  } else {
    confidence =
      Math.min(
        confidence,
        65
      );
  }

  if (!prediction.side) {
    confidence = 0;
  }

  confidence =
    Math.max(
      0,
      Math.min(
        confidence,
        78
      )
    );

  let status;

  if (!prediction.side) {
    status =
      "NO CLEAR EDGE";
  } else if (
    validation.samples < 20
  ) {
    status =
      "EARLY SIGNAL";
  } else if (
    confidence >= 70
  ) {
    status =
      "STRONGER SIGNAL";
  } else if (
    confidence >= 62
  ) {
    status =
      "MODERATE SIGNAL";
  } else {
    status =
      "WEAK SIGNAL";
  }

  return {
    prediction:
      prediction.side ||
      "WAIT",

    predictedNumber:
      chooseNumber(
        history,
        prediction.side
      ),

    confidence,

    agreement:
      prediction.agreement,

    patternScore:
      prediction.patternScore,

    status,

    avgModelAccuracy:
      validation.accuracy,

    backtestSamples:
      validation.samples,

    backtestWins:
      validation.wins,

    backtestLosses:
      validation.losses,

    historyUsed:
      history.length,

    models:
      prediction.models.map(
        model => ({
          name:
            model.name,

          side:
            model.side,

          confidence:
            model.strength,

          sample:
            model.sample,

          edge:
            Number(
              model.edge || 0
            ).toFixed(2),

          streak:
            model.streak || 0
        })
      )
  };
}

/* =========================================================
   DATABASE
========================================================= */

async function ensureDatabase() {
  if (!process.env.DATABASE_URL) {
    state.database = false;
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
    CREATE TABLE IF NOT EXISTS predictions (
      id SERIAL PRIMARY KEY,
      target_issue TEXT,
      prediction TEXT,
      predicted_number INTEGER,
      confidence INTEGER DEFAULT 0,
      pattern_score INTEGER DEFAULT 0,
      agreement INTEGER DEFAULT 0,
      status TEXT,
      created_at BIGINT NOT NULL,
      settled_number INTEGER,
      outcome TEXT
    )
  `);

  const migrations = [
    `ALTER TABLE predictions ADD COLUMN IF NOT EXISTS target_issue TEXT`,
    `ALTER TABLE predictions ADD COLUMN IF NOT EXISTS prediction TEXT`,
    `ALTER TABLE predictions ADD COLUMN IF NOT EXISTS predicted_number INTEGER`,
    `ALTER TABLE predictions ADD COLUMN IF NOT EXISTS confidence INTEGER DEFAULT 0`,
    `ALTER TABLE predictions ADD COLUMN IF NOT EXISTS pattern_score INTEGER DEFAULT 0`,
    `ALTER TABLE predictions ADD COLUMN IF NOT EXISTS agreement INTEGER DEFAULT 0`,
    `ALTER TABLE predictions ADD COLUMN IF NOT EXISTS status TEXT`,
    `ALTER TABLE predictions ADD COLUMN IF NOT EXISTS created_at BIGINT`,
    `ALTER TABLE predictions ADD COLUMN IF NOT EXISTS settled_number INTEGER`,
    `ALTER TABLE predictions ADD COLUMN IF NOT EXISTS outcome TEXT`
  ];

  for (
    const sql of migrations
  ) {
    try {
      await pool.query(sql);
    } catch (e) {
      console.log(
        "Migration:",
        e.message
      );
    }
  }

  state.database = true;
}

/* =========================================================
   ACCESS KEY CHECK
========================================================= */

async function checkAccessKey(
  key,
  deviceId
) {
  if (!state.database) {
    return {
      ok: false,
      message:
        "Database is not configured"
    };
  }

  if (!key || !deviceId) {
    return {
      ok: false,
      message:
        "Access key and device ID are required"
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

  if (!result.rows.length) {
    return {
      ok: false,
      message:
        "Invalid access key"
    };
  }

  const row =
    result.rows[0];

  if (
    row.device_id &&
    row.device_id !==
      deviceId
  ) {
    return {
      ok: false,
      message:
        "This key is already linked to another device"
    };
  }

  if (!row.device_id) {
    await pool.query(
      `
      UPDATE access_keys
      SET device_id = $1,
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
    ok: true
  };
}

async function requireAccess(req) {
  const key =
    getAccessKey(req);

  const deviceId =
    getDeviceId(req);

  if (
    !key ||
    !deviceId ||
    !state.database
  ) {
    return false;
  }

  const result =
    await pool.query(
      `
      SELECT id, device_id
      FROM access_keys
      WHERE access_key = $1
      LIMIT 1
      `,
      [key]
    );

  if (!result.rows.length) {
    return false;
  }

  const row =
    result.rows[0];

  if (
    !row.device_id ||
    row.device_id !==
      deviceId
  ) {
    return false;
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

  return true;
}

/* =========================================================
   SAVE PREDICTION
========================================================= */

async function savePrediction(
  targetIssue,
  analysis
) {
  if (
    !state.database ||
    !targetIssue ||
    !analysis
  ) {
    return;
  }

  if (
    !analysis.prediction ||
    analysis.prediction ===
      "WAIT"
  ) {
    return;
  }

  const existing =
    await pool.query(
      `
      SELECT id
      FROM predictions
      WHERE target_issue = $1
      LIMIT 1
      `,
      [targetIssue]
    );

  if (existing.rows.length) {
    return;
  }

  await pool.query(
    `
    INSERT INTO predictions (
      target_issue,
      prediction,
      predicted_number,
      confidence,
      pattern_score,
      agreement,
      status,
      created_at
    )
    VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8
    )
    `,
    [
      targetIssue,

      analysis.prediction,

      analysis.predictedNumber,

      analysis.confidence,

      analysis.patternScore,

      analysis.agreement,

      analysis.status,

      now()
    ]
  );
}

/* =========================================================
   SETTLE WIN / LOSS
========================================================= */

async function settlePredictions(
  history
) {
  if (
    !state.database ||
    !history.length
  ) {
    return;
  }

  const rows =
    history.slice(
      0,
      WINLOSS_LIMIT
    );

  for (
    const row of rows
  ) {
    if (
      !row.issueNumber ||
      row.number === null
    ) {
      continue;
    }

    const result =
      await pool.query(
        `
        SELECT id, prediction
        FROM predictions
        WHERE target_issue = $1
          AND (
            outcome IS NULL
            OR outcome = ''
          )
        LIMIT 1
        `,
        [row.issueNumber]
      );

    if (!result.rows.length) {
      continue;
    }

    const prediction =
      result.rows[0].prediction;

    const actual =
      classifyNumber(
        row.number
      );

    if (
      !prediction ||
      !actual
    ) {
      continue;
    }

    const outcome =
      prediction === actual
        ? "WIN"
        : "LOSS";

    await pool.query(
      `
      UPDATE predictions
      SET settled_number = $1,
          outcome = $2
      WHERE id = $3
      `,
      [
        row.number,
        outcome,
        result.rows[0].id
      ]
    );
  }
}

/* =========================================================
   WIN LOSS STATS
========================================================= */

async function getWinLossStats() {
  if (!state.database) {
    return {
      win: 0,
      loss: 0,
      rate: 0
    };
  }

  const result =
    await pool.query(`
      SELECT
        COUNT(*) FILTER (
          WHERE outcome = 'WIN'
        ) AS win,

        COUNT(*) FILTER (
          WHERE outcome = 'LOSS'
        ) AS loss

      FROM predictions

      WHERE outcome IN (
        'WIN',
        'LOSS'
      )
    `);

  const row =
    result.rows[0];

  const win =
    Number(row.win || 0);

  const loss =
    Number(row.loss || 0);

  const total =
    win + loss;

  return {
    win,
    loss,

    rate:
      total
        ? Math.round(
            win /
              total *
              100
          )
        : 0
  };
}

/* =========================================================
   COMBINED LIVE RESULTS
========================================================= */

async function getCombinedResults() {
  const rows =
    state.history.slice(
      0,
      LIVE_RESULTS_LIMIT
    );

  const map =
    new Map();

  if (
    state.database &&
    rows.length
  ) {
    const issues =
      rows.map(
        row =>
          row.issueNumber
      );

    const result =
      await pool.query(
        `
        SELECT
          target_issue,
          prediction,
          predicted_number,
          outcome

        FROM predictions

        WHERE target_issue =
          ANY($1::text[])
        `,
        [issues]
      );

    for (
      const row of result.rows
    ) {
      map.set(
        String(
          row.target_issue
        ),
        row
      );
    }
  }

  return rows.map(
    row => {
      const prediction =
        map.get(
          String(
            row.issueNumber
          )
        );

      return {
        issueNumber:
          row.issueNumber,

        number:
          row.number,

        colour:
          row.colour,

        prediction:
          prediction?.prediction ||
          null,

        predictedNumber:
          prediction?.predicted_number ??
          null,

        outcome:
          prediction?.outcome ||
          null
      };
    }
  );
}

/* =========================================================
   UPDATE LIVE STATE
========================================================= */

async function updateLiveState() {
  try {
    const data =
      await fetchWingo();

    const history =
      data.history;

    const signature =
      makeHistorySignature(
        history
      );

    const changed =
      signature !==
      state.historySignature;

    state.history =
      history;

    state.wingobot =
      true;

    state.providerCurrentIssue =
      data.currentIssue;

    state.providerCountdown =
      data.providerCountdown;

    state.lastError =
      null;

    if (changed) {
      state.historySignature =
        signature;

      state.lastHistoryUpdate =
        now();

      updateTimerAnchor();

      const settled =
        history[0] ||
        null;

      state.settledIssue =
        settled?.issueNumber ||
        null;

      /*
       * IMPORTANT:
       * Target is always latest settled + 1.
       */
      state.targetIssue =
        incrementIssue(
          state.settledIssue
        );

      /*
       * Prediction is recalculated ONLY
       * when new settled history arrives.
       */
      state.analysis =
        adaptiveEnsemble(
          history
        );

      await settlePredictions(
        history
      );

      await savePrediction(
        state.targetIssue,
        state.analysis
      );
    } else {
      /*
       * Do NOT generate another prediction
       * here.
       */
      const settled =
        history[0] ||
        null;

      if (settled) {
        state.settledIssue =
          settled.issueNumber;

        state.targetIssue =
          incrementIssue(
            settled.issueNumber
          );
      }
    }

    /*
     * If provider gives countdown,
     * synchronize timer anchor.
     */
    if (
      data.providerCountdown !==
        null &&
      Number.isFinite(
        data.providerCountdown
      )
    ) {
      state.timerAnchorMs =
        now() -
        (
          ROUND_SECONDS -
          data.providerCountdown
        ) *
          1000;
    }

    return true;
  } catch (e) {
    state.wingobot =
      false;

    state.lastError =
      e.message;

    console.log(
      "WingoBot error:",
      e.message
    );

    return false;
  }
}

/* =========================================================
   STATE
========================================================= */

async function buildState() {
  const stats =
    await getWinLossStats();

  const results =
    await getCombinedResults();

  const analysis =
    state.analysis ||
    adaptiveEnsemble(
      state.history
    );

  return {
    success: true,
    ok: true,

    ready:
      state.ready,

    database:
      state.database,

    wingobot:
      state.wingobot,

    settledIssue:
      state.settledIssue,

    targetIssue:
      state.targetIssue,

    nextIssue:
      state.targetIssue,

    providerCurrentIssue:
      state.providerCurrentIssue,

    countdown:
      getEstimatedCountdown(),

    history:
      state.history.slice(
        0,
        LIVE_RESULTS_LIMIT
      ),

    historyCount:
      state.history.length,

    results,

    analysis,

    prediction:
      analysis.prediction,

    predictedNumber:
      analysis.predictedNumber,

    confidence:
      analysis.confidence,

    patternScore:
      analysis.patternScore,

    agreement:
      analysis.agreement,

    backtestSamples:
      analysis.backtestSamples,

    avgModelAccuracy:
      analysis.avgModelAccuracy,

    status:
      analysis.status,

    winLossStats:
      stats,

    lastHistoryUpdate:
      state.lastHistoryUpdate,

    lastError:
      state.lastError
  };
}

/* =========================================================
   USER API
========================================================= */

async function keyCheck(req, res) {
  try {
    const body =
      await parseBody(req);

    const key =
      String(
        body.key ||
        body.access_key ||
        ""
      ).trim();

    const deviceId =
      String(
        body.device_id ||
        body.deviceId ||
        ""
      ).trim();

    const result =
      await checkAccessKey(
        key,
        deviceId
      );

    if (!result.ok) {
      json(res, 401, {
        success: false,
        ok: false,
        message:
          result.message
      });

      return;
    }

    json(res, 200, {
      success: true,
      ok: true,
      message:
        "Access granted"
    });
  } catch (e) {
    json(res, 500, {
      success: false,
      ok: false,
      message:
        e.message
    });
  }
}

async function stateApi(req, res) {
  try {
    const allowed =
      await requireAccess(req);

    if (!allowed) {
      json(res, 401, {
        success: false,
        ok: false,
        message:
          "Unauthorized"
      });

      return;
    }

    json(
      res,
      200,
      await buildState()
    );
  } catch (e) {
    json(res, 500, {
      success: false,
      ok: false,
      message:
        e.message
    });
  }
}

async function historyApi(req, res) {
  try {
    const allowed =
      await requireAccess(req);

    if (!allowed) {
      json(res, 401, {
        success: false,
        ok: false,
        message:
          "Unauthorized"
      });

      return;
    }

    json(res, 200, {
      success: true,
      ok: true,

      history:
        state.history.slice(
          0,
          LIVE_RESULTS_LIMIT
        ),

      count:
        state.history.length,

      settledIssue:
        state.settledIssue,

      targetIssue:
        state.targetIssue
    });
  } catch (e) {
    json(res, 500, {
      success: false,
      ok: false,
      message:
        e.message
    });
  }
}

/* =========================================================
   ADMIN API
========================================================= */

async function adminPing(
  req,
  res
) {
  if (!requireAdmin(req, res)) {
    return;
  }

  json(res, 200, {
    success: true,
    ok: true,
    message:
      "Admin API working"
  });
}

async function adminStatus(
  req,
  res
) {
  if (!requireAdmin(req, res)) {
    return;
  }

  json(res, 200, {
    success: true,
    ok: true,

    ready:
      state.ready,

    database:
      state.database,

    wingobot:
      state.wingobot,

    historyCount:
      state.history.length,

    settledIssue:
      state.settledIssue,

    targetIssue:
      state.targetIssue,

    providerCurrentIssue:
      state.providerCurrentIssue,

    countdown:
      getEstimatedCountdown(),

    lastHistoryUpdate:
      state.lastHistoryUpdate,

    lastError:
      state.lastError
  });
}

async function adminKeysGet(
  req,
  res
) {
  if (!requireAdmin(req, res)) {
    return;
  }

  if (!state.database) {
    json(res, 500, {
      success: false,
      ok: false,
      message:
        "Database not configured"
    });

    return;
  }

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

  json(res, 200, {
    success: true,
    ok: true,
    keys:
      result.rows
  });
}

function generateKey() {
  return (
    "DY-" +
    crypto
      .randomBytes(6)
      .toString("hex")
      .toUpperCase()
  );
}

async function adminKeysCreate(
  req,
  res
) {
  if (!requireAdmin(req, res)) {
    return;
  }

  if (!state.database) {
    json(res, 500, {
      success: false,
      ok: false,
      message:
        "Database not configured"
    });

    return;
  }

  const body =
    await parseBody(req);

  const requested =
    Number(
      body.count ??
      body.quantity ??
      1
    );

  const count =
    Number.isFinite(
      requested
    )
      ? Math.max(
          1,
          Math.min(
            100,
            Math.floor(
              requested
            )
          )
        )
      : 1;

  const keys = [];

  for (
    let i = 0;
    i < count;
    i++
  ) {
    let key =
      generateKey();

    while (true) {
      const check =
        await pool.query(
          `
          SELECT 1
          FROM access_keys
          WHERE access_key = $1
          LIMIT 1
          `,
          [key]
        );

      if (!check.rows.length) {
        break;
      }

      key =
        generateKey();
    }

    await pool.query(
      `
      INSERT INTO access_keys (
        access_key,
        device_id,
        created_at,
        last_seen
      )
      VALUES (
        $1,
        NULL,
        $2,
        0
      )
      `,
      [
        key,
        now()
      ]
    );

    keys.push(key);
  }

  json(res, 200, {
    success: true,
    ok: true,

    key:
      keys[0],

    keys
  });
}

async function adminKeysDelete(
  req,
  res
) {
  if (!requireAdmin(req, res)) {
    return;
  }

  if (!state.database) {
    json(res, 500, {
      success: false,
      ok: false,
      message:
        "Database not configured"
    });

    return;
  }

  const body =
    await parseBody(req);

  const id =
    body.id ??
    body.keyId;

  const key =
    body.key ??
    body.access_key;

  let result;

  if (
    id !== undefined
  ) {
    result =
      await pool.query(
        `
        DELETE FROM access_keys
        WHERE id = $1
        `,
        [Number(id)]
      );
  } else if (key) {
    result =
      await pool.query(
        `
        DELETE FROM access_keys
        WHERE access_key = $1
        `,
        [String(key)]
      );
  } else {
    json(res, 400, {
      success: false,
      ok: false,
      message:
        "Key or id required"
    });

    return;
  }

  json(res, 200, {
    success: true,
    ok: true,
    deleted:
      result.rowCount
  });
}

async function adminResetDevice(
  req,
  res
) {
  if (!requireAdmin(req, res)) {
    return;
  }

  if (!state.database) {
    json(res, 500, {
      success: false,
      ok: false,
      message:
        "Database not configured"
    });

    return;
  }

  const body =
    await parseBody(req);

  const id =
    body.id ??
    body.keyId;

  const key =
    body.key ??
    body.access_key;

  let result;

  if (
    id !== undefined
  ) {
    result =
      await pool.query(
        `
        UPDATE access_keys

        SET
          device_id = NULL,
          last_seen = 0

        WHERE id = $1

        RETURNING
          id,
          access_key
        `,
        [Number(id)]
      );
  } else if (key) {
    result =
      await pool.query(
        `
        UPDATE access_keys

        SET
          device_id = NULL,
          last_seen = 0

        WHERE access_key = $1

        RETURNING
          id,
          access_key
        `,
        [String(key)]
      );
  } else {
    json(res, 400, {
      success: false,
      ok: false,
      message:
        "Key or id required"
    });

    return;
  }

  json(res, 200, {
    success: true,
    ok: true,

    reset:
      result.rowCount,

    row:
      result.rows[0] ||
      null
  });
}

async function adminWingoTest(
  req,
  res
) {
  if (!requireAdmin(req, res)) {
    return;
  }

  try {
    const data =
      await fetchWingo();

    json(res, 200, {
      success: true,
      ok: true,

      current:
        data.currentIssue,

      countdown:
        data.providerCountdown,

      fetched:
        data.history.length,

      history:
        data.history.slice(
          0,
          30
        )
    });
  } catch (e) {
    json(res, 500, {
      success: false,
      ok: false,
      message:
        e.message
    });
  }
}

async function adminModelTest(
  req,
  res
) {
  if (!requireAdmin(req, res)) {
    return;
  }

  try {
    if (
      !state.history.length
    ) {
      await updateLiveState();
    }

    const analysis =
      adaptiveEnsemble(
        state.history
      );

    json(res, 200, {
      success: true,
      ok: true,

      analysis,

      history:
        state.history.slice(
          0,
          30
        ),

      avgModelAccuracy:
        analysis.avgModelAccuracy,

      backtestSamples:
        analysis.backtestSamples,

      patternScore:
        analysis.patternScore,

      agreement:
        analysis.agreement,

      prediction:
        analysis.prediction,

      predictedNumber:
        analysis.predictedNumber,

      confidence:
        analysis.confidence,

      status:
        analysis.status
    });
  } catch (e) {
    json(res, 500, {
      success: false,
      ok: false,
      message:
        e.message
    });
  }
}

/* =========================================================
   STATIC FILES
========================================================= */

const MIME = {
  ".html":
    "text/html; charset=utf-8",

  ".js":
    "application/javascript; charset=utf-8",

  ".css":
    "text/css; charset=utf-8",

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
    "image/webp"
};

function serveAudio(
  req,
  res,
  filePath
) {
  fs.stat(
    filePath,
    (err, stat) => {
      if (err) {
        text(
          res,
          404,
          "Audio not found"
        );

        return;
      }

      const size =
        stat.size;

      const range =
        req.headers.range;

      if (!range) {
        res.writeHead(200, {
          "Content-Type":
            "audio/mpeg",

          "Content-Length":
            size,

          "Accept-Ranges":
            "bytes"
        });

        fs.createReadStream(
          filePath
        ).pipe(res);

        return;
      }

      const match =
        /bytes=(\d*)-(\d*)/
          .exec(range);

      if (!match) {
        res.writeHead(416);
        res.end();
        return;
      }

      let start =
        match[1]
          ? Number(match[1])
          : 0;

      let end =
        match[2]
          ? Number(match[2])
          : size - 1;

      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start < 0 ||
        end >= size ||
        start > end
      ) {
        res.writeHead(416, {
          "Content-Range":
            `bytes */${size}`
        });

        res.end();
        return;
      }

      const chunkSize =
        end - start + 1;

      res.writeHead(206, {
        "Content-Type":
          "audio/mpeg",

        "Content-Length":
          chunkSize,

        "Content-Range":
          `bytes ${start}-${end}/${size}`,

        "Accept-Ranges":
          "bytes"
      });

      fs.createReadStream(
        filePath,
        {
          start,
          end
        }
      ).pipe(res);
    }
  );
}

function serveStatic(
  req,
  res,
  pathname
) {
  let filePath;

  if (
    pathname === "/" ||
    pathname === ""
  ) {
    filePath =
      path.join(
        ROOT,
        "prediction.html"
      );
  } else {
    let clean;

    try {
      clean =
        decodeURIComponent(
          pathname
        ).replace(
          /^\/+/,
          ""
        );
    } catch {
      text(
        res,
        400,
        "Bad request"
      );

      return;
    }

    filePath =
      path.join(
        ROOT,
        clean
      );
  }

  if (
    !filePath.startsWith(
      ROOT
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
    (err, stat) => {
      if (
        err ||
        !stat.isFile()
      ) {
        text(
          res,
          404,
          "Not found"
        );

        return;
      }

      const ext =
        path.extname(
          filePath
        ).toLowerCase();

      const mime =
        MIME[ext] ||
        "application/octet-stream";

      if (
        ext === ".mp3"
      ) {
        serveAudio(
          req,
          res,
          filePath
        );

        return;
      }

      res.writeHead(200, {
        "Content-Type":
          mime,

        "Cache-Control":
          "no-cache"
      });

      fs.createReadStream(
        filePath
      ).pipe(res);
    }
  );
}

/* =========================================================
   ROUTER
========================================================= */

async function router(
  req,
  res
) {
  const url =
    new URL(
      req.url,
      `http://${
        req.headers.host ||
        "localhost"
      }`
    );

  const pathname =
    url.pathname;

  if (
    req.method === "OPTIONS"
  ) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin":
        "*",

      "Access-Control-Allow-Headers":
        "Content-Type, X-Admin-Key, X-Access-Key, X-Device-ID, Authorization",

      "Access-Control-Allow-Methods":
        "GET, POST, DELETE, OPTIONS"
    });

    res.end();

    return;
  }

  /* HEALTH */

  if (
    pathname === "/health"
  ) {
    json(res, 200, {
      success: true,
      ok: true,
      status:
        "healthy",

      ready:
        state.ready,

      database:
        state.database,

      wingobot:
        state.wingobot
    });

    return;
  }

  /* USER */

  if (
    pathname ===
      "/api/key/check" &&
    req.method === "POST"
  ) {
    await keyCheck(
      req,
      res
    );

    return;
  }

  if (
    pathname ===
      "/api/state" &&
    req.method === "GET"
  ) {
    await stateApi(
      req,
      res
    );

    return;
  }

  if (
    pathname ===
      "/api/history" &&
    req.method === "GET"
  ) {
    await historyApi(
      req,
      res
    );

    return;
  }

  /* ADMIN */

  if (
    pathname ===
      "/api/admin/ping" &&
    req.method === "GET"
  ) {
    await adminPing(
      req,
      res
    );

    return;
  }

  if (
    pathname ===
      "/api/admin/status" &&
    req.method === "GET"
  ) {
    await adminStatus(
      req,
      res
    );

    return;
  }

  if (
    pathname ===
      "/api/admin/keys" &&
    req.method === "GET"
  ) {
    await adminKeysGet(
      req,
      res
    );

    return;
  }

  if (
    pathname ===
      "/api/admin/keys" &&
    req.method === "POST"
  ) {
    await adminKeysCreate(
      req,
      res
    );

    return;
  }

  if (
    pathname ===
      "/api/admin/keys" &&
    req.method === "DELETE"
  ) {
    await adminKeysDelete(
      req,
      res
    );

    return;
  }

  if (
    pathname ===
      "/api/admin/reset-device" &&
    req.method === "POST"
  ) {
    await adminResetDevice(
      req,
      res
    );

    return;
  }

  if (
    pathname ===
      "/api/admin/wingo-test" &&
    req.method === "GET"
  ) {
    await adminWingoTest(
      req,
      res
    );

    return;
  }

  if (
    pathname ===
      "/api/admin/model-test" &&
    req.method === "GET"
  ) {
    await adminModelTest(
      req,
      res
    );

    return;
  }

  /* STATIC */

  serveStatic(
    req,
    res,
    pathname
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
        await router(
          req,
          res
        );
      } catch (e) {
        console.error(
          "SERVER ERROR:",
          e
        );

        if (
          !res.headersSent
        ) {
          json(
            res,
            500,
            {
              success: false,
              ok: false,
              message:
                e.message ||
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
   START
========================================================= */

async function start() {
  try {
    await ensureDatabase();

    console.log(
      "Database:",
      state.database
    );
  } catch (e) {
    state.database =
      false;

    console.error(
      "Database setup error:",
      e.message
    );
  }

  state.ready =
    true;

  await updateLiveState();

  /*
   * WingoBot history refresh:
   * every 3 seconds.
   */
  setInterval(
    async () => {
      await updateLiveState();
    },
    3000
  );

  server.listen(
    PORT,
    "0.0.0.0",
    () => {
      console.log(
        `DY AI running on port ${PORT}`
      );
    }
  );
}

/* =========================================================
   PROCESS SAFETY
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

async function shutdown(
  signal
) {
  console.log(
    `${signal} received`
  );

  server.close(
    async () => {
      try {
        await pool.end();
      } catch {}

      process.exit(0);
    }
  );
}

process.on(
  "SIGTERM",
  () => shutdown("SIGTERM")
);

process.on(
  "SIGINT",
  () => shutdown("SIGINT")
);

start();
