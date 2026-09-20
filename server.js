"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 3000);

const ADMIN_KEY = String(
  process.env.ADMIN_KEY || "dy4427574"
).trim();

const WINGOBOT_TOKEN = String(
  process.env.WINGOBOT_TOKEN || ""
).trim();

const DATABASE_URL = String(
  process.env.DATABASE_URL || ""
).trim();

const WINGO_API =
  "https://api.wingobot.com/v2/1-min-game-history";

const MODEL_VERSION =
  "DY-AI-ADAPTIVE-V6";

const API_REFRESH_MS = 1000;
const ENGINE_TICK_MS = 250;
const ANALYSIS_MS = 4000;
const SKIP_ROUNDS = 4;

const MIN_HISTORY = 6;
const MIN_TRAINING_SAMPLES = 4;

let pool = null;
let dbReady = false;

if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    }
  });
}

/* =========================================================
   MEMORY FALLBACK
========================================================= */

const memory = {
  keys: [],
  predictions: []
};

/* =========================================================
   LIVE
========================================================= */

const live = {
  online: false,
  history: [],
  currentIssue: null,
  latestIssue: null,
  latestNumber: null,
  latestResult: null,
  fetchedAt: 0,
  error: null
};

/* =========================================================
   ANALYSIS
========================================================= */

const analysis = {
  active: false,
  issue: null,
  startedAt: 0
};

/* =========================================================
   BASIC HELPERS
========================================================= */

function now() {
  return Date.now();
}

function text(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function resultFromNumber(n) {
  if (!Number.isInteger(n)) return null;
  return n >= 5 ? "BIG" : "SMALL";
}

function parseDigit(v) {
  if (typeof v === "number" && Number.isFinite(v)) {
    const n = Math.trunc(v);
    if (n >= 0 && n <= 9) return n;
  }

  if (v === null || v === undefined) return null;

  const s = String(v).trim();

  if (/^[0-9]$/.test(s)) {
    return Number(s);
  }

  const m = s.match(/(?:^|\D)([0-9])(?:\D|$)/);

  if (!m) return null;

  return Number(m[1]);
}

function parseIssue(v) {
  if (v === null || v === undefined) return null;

  const s = String(v).replace(/\D/g, "");

  if (s.length < 3) return null;

  return s;
}

function nextIssue(issue) {
  issue = parseIssue(issue);

  if (!issue) return null;

  try {
    return (
      BigInt(issue) + 1n
    ).toString().padStart(issue.length, "0");
  } catch {
    return null;
  }
}

function issueDiff(a, b) {
  a = parseIssue(a);
  b = parseIssue(b);

  if (!a || !b) return null;

  try {
    return Number(BigInt(a) - BigInt(b));
  } catch {
    return null;
  }
}

/* =========================================================
   OBJECT WALKER
========================================================= */

function collectObjects(value, output = [], depth = 0) {
  if (
    value === null ||
    value === undefined ||
    depth > 8
  ) {
    return output;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectObjects(item, output, depth + 1);
    }
    return output;
  }

  if (typeof value !== "object") {
    return output;
  }

  output.push(value);

  for (const key of Object.keys(value)) {
    collectObjects(
      value[key],
      output,
      depth + 1
    );
  }

  return output;
}

function firstValue(obj, keys) {
  for (const key of keys) {
    if (
      obj &&
      obj[key] !== null &&
      obj[key] !== undefined &&
      text(obj[key])
    ) {
      return obj[key];
    }
  }

  return null;
}

const ISSUE_KEYS = [
  "issue",
  "issueNumber",
  "issue_number",
  "period",
  "periodId",
  "period_id",
  "draw",
  "drawNumber",
  "draw_number",
  "round",
  "roundId",
  "round_id"
];

const NUMBER_KEYS = [
  "number",
  "result",
  "digit",
  "num",
  "value",
  "openNumber",
  "open_number",
  "openNum",
  "open_num",
  "winningNumber",
  "winning_number",
  "winNumber",
  "win_number"
];

const CURRENT_KEYS = [
  "currentIssue",
  "current_issue",
  "currentPeriod",
  "current_period",
  "currentPeriodId",
  "current_period_id",
  "currentIssueNumber",
  "current_issue_number"
];

/* =========================================================
   NORMALIZE WINGOBOT HISTORY
========================================================= */

function normalizeHistory(payload) {
  const objects = collectObjects(payload);
  const rows = [];
  const seen = new Set();

  for (const obj of objects) {
    const issue = parseIssue(
      firstValue(obj, ISSUE_KEYS)
    );

    const number = parseDigit(
      firstValue(obj, NUMBER_KEYS)
    );

    if (!issue || number === null) continue;

    const id = issue + ":" + number;

    if (seen.has(id)) continue;

    seen.add(id);

    rows.push({
      issue,
      number,
      result: resultFromNumber(number)
    });
  }

  rows.sort((a, b) => {
    try {
      const aa = BigInt(a.issue);
      const bb = BigInt(b.issue);

      if (aa < bb) return -1;
      if (aa > bb) return 1;

      return 0;
    } catch {
      return 0;
    }
  });

  return rows;
}

function findCurrentIssue(payload) {
  const objects = collectObjects(payload);

  for (const obj of objects) {
    const issue = parseIssue(
      firstValue(obj, CURRENT_KEYS)
    );

    if (issue) return issue;
  }

  return null;
}

/* =========================================================
   WINGOBOT API
========================================================= */

async function fetchWingo() {
  if (!WINGOBOT_TOKEN) {
    throw new Error(
      "WINGOBOT_TOKEN missing"
    );
  }

  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    8000
  );

  try {
    const response = await fetch(
      WINGO_API,
      {
        method: "GET",

        headers: {
          Authorization:
            "Bearer " + WINGOBOT_TOKEN,

          Accept:
            "application/json",

          "User-Agent":
            "DY-AI-WINGO-V6"
        },

        signal: controller.signal
      }
    );

    if (!response.ok) {
      throw new Error(
        "WingoBot HTTP " +
        response.status
      );
    }

    const payload =
      await response.json();

    const history =
      normalizeHistory(payload);

    if (!history.length) {
      throw new Error(
        "No valid result history from API"
      );
    }

    const latest =
      history[history.length - 1];

    let current =
      findCurrentIssue(payload);

    /*
      If API does not give current issue,
      current active issue is assumed to
      be latest settled issue + 1.
    */

    if (!current) {
      current =
        nextIssue(latest.issue);
    }

    if (!current) {
      throw new Error(
        "Current issue unavailable"
      );
    }

    return {
      history,
      currentIssue: current,
      latestIssue: latest.issue,
      latestNumber: latest.number,
      latestResult: latest.result
    };
  } finally {
    clearTimeout(timeout);
  }
}

/* =========================================================
   DATABASE
========================================================= */

async function initDB() {
  if (!pool) {
    console.log(
      "DATABASE_URL not configured - MEMORY MODE"
    );
    return;
  }

  try {
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

    dbReady = true;

    console.log("POSTGRESQL READY");
  } catch (err) {
    console.error(
      "DATABASE ERROR:",
      err.message
    );

    dbReady = false;
  }
}

/* =========================================================
   ACCESS KEYS
========================================================= */

async function getKey(accessKey) {
  accessKey = text(accessKey);

  if (!accessKey) return null;

  if (dbReady) {
    const result = await pool.query(
      `
      SELECT *
      FROM access_keys
      WHERE access_key=$1
      LIMIT 1
      `,
      [accessKey]
    );

    return result.rows[0] || null;
  }

  return (
    memory.keys.find(
      x => x.access_key === accessKey
    ) || null
  );
}

async function checkAccess(
  accessKey,
  deviceId
) {
  accessKey = text(accessKey);
  deviceId = text(deviceId);

  if (!accessKey || !deviceId) {
    return {
      ok: false,
      message:
        "KEY AND DEVICE REQUIRED"
    };
  }

  const row =
    await getKey(accessKey);

  if (!row) {
    return {
      ok: false,
      message:
        "INVALID ACCESS KEY"
    };
  }

  if (
    row.device_id &&
    row.device_id !== deviceId
  ) {
    return {
      ok: false,
      message:
        "KEY ALREADY BOUND TO ANOTHER DEVICE"
    };
  }

  if (dbReady) {
    await pool.query(
      `
      UPDATE access_keys
      SET
        device_id=COALESCE(device_id,$1),
        last_seen=$2
      WHERE access_key=$3
      `,
      [
        deviceId,
        now(),
        accessKey
      ]
    );
  } else {
    row.device_id =
      row.device_id || deviceId;

    row.last_seen = now();
  }

  return {
    ok: true,
    message: "ACCESS GRANTED"
  };
}

async function createKey(requested) {
  let accessKey = text(requested);

  if (!accessKey) {
    accessKey =
      "DY-" +
      crypto
        .randomBytes(8)
        .toString("hex")
        .toUpperCase();
  }

  if (dbReady) {
    const result =
      await pool.query(
        `
        INSERT INTO access_keys
        (
          access_key,
          device_id,
          created_at,
          last_seen
        )
        VALUES
        ($1,NULL,$2,0)
        RETURNING *
        `,
        [
          accessKey,
          now()
        ]
      );

    return result.rows[0];
  }

  if (
    memory.keys.some(
      x => x.access_key === accessKey
    )
  ) {
    throw new Error(
      "KEY ALREADY EXISTS"
    );
  }

  const row = {
    id: memory.keys.length + 1,
    access_key: accessKey,
    device_id: null,
    created_at: now(),
    last_seen: 0
  };

  memory.keys.push(row);

  return row;
}

async function listKeys() {
  if (dbReady) {
    const result =
      await pool.query(`
        SELECT *
        FROM access_keys
        ORDER BY id DESC
      `);

    return result.rows;
  }

  return memory.keys
    .slice()
    .reverse();
}

async function resetDevice(accessKey) {
  accessKey = text(accessKey);

  if (dbReady) {
    const result =
      await pool.query(
        `
        UPDATE access_keys
        SET
          device_id=NULL,
          last_seen=0
        WHERE access_key=$1
        RETURNING *
        `,
        [accessKey]
      );

    return result.rows[0] || null;
  }

  const row =
    memory.keys.find(
      x => x.access_key === accessKey
    );

  if (!row) return null;

  row.device_id = null;
  row.last_seen = 0;

  return row;
}

async function deleteKey(accessKey) {
  accessKey = text(accessKey);

  if (dbReady) {
    const result =
      await pool.query(
        `
        DELETE FROM access_keys
        WHERE access_key=$1
        RETURNING *
        `,
        [accessKey]
      );

    return result.rows[0] || null;
  }

  const index =
    memory.keys.findIndex(
      x => x.access_key === accessKey
    );

  if (index < 0) return null;

  return memory.keys.splice(
    index,
    1
  )[0];
}

/* =========================================================
   FEATURE ENGINE
========================================================= */

function buildFeatures(history) {
  const numbers =
    history
      .map(x => x.number)
      .filter(Number.isInteger);

  const bits =
    numbers.map(
      n => n >= 5 ? 1 : 0
    );

  const recent =
    bits.slice(-20);

  const bigCount =
    recent.filter(
      x => x === 1
    ).length;

  const bigRatio =
    recent.length
      ? bigCount / recent.length
      : 0.5;

  let streak = 0;
  let streakValue = null;

  if (bits.length) {
    streakValue =
      bits[bits.length - 1];

    for (
      let i = bits.length - 1;
      i >= 0;
      i--
    ) {
      if (
        bits[i] !== streakValue
      ) {
        break;
      }

      streak++;
    }
  }

  let switches = 0;

  for (
    let i = 1;
    i < bits.length;
    i++
  ) {
    if (
      bits[i] !== bits[i - 1]
    ) {
      switches++;
    }
  }

  const switchRate =
    bits.length > 1
      ? switches /
        (bits.length - 1)
      : 0.5;

  const last10 =
    numbers.slice(-10);

  const previous10 =
    numbers.slice(-20, -10);

  const avgLast =
    last10.length
      ? last10.reduce(
          (a,b) => a+b,
          0
        ) / last10.length
      : 4.5;

  const avgPrevious =
    previous10.length
      ? previous10.reduce(
          (a,b) => a+b,
          0
        ) / previous10.length
      : 4.5;

  const highRatio =
    numbers.length
      ? numbers.filter(
          n => n >= 7
        ).length /
        numbers.length
      : 0.5;

  const lowRatio =
    numbers.length
      ? numbers.filter(
          n => n <= 2
        ).length /
        numbers.length
      : 0.5;

  const vector = [
    bigRatio,
    1 - bigRatio,
    switchRate,
    Math.min(streak,10) / 10,
    streakValue === 1 ? 1 : 0,
    avgLast / 9,
    (avgLast - avgPrevious) / 9,
    highRatio,
    lowRatio
  ];

  const last12 =
    bits.slice(-12);

  while (last12.length < 12) {
    last12.unshift(0.5);
  }

  for (const bit of last12) {
    vector.push(bit);
  }

  const last8 =
    numbers.slice(-8);

  while (last8.length < 8) {
    last8.unshift(4.5);
  }

  for (const n of last8) {
    vector.push(n / 9);
  }

  return {
    numbers,
    bits,
    vector,
    bigRatio,
    switchRate,
    streak,
    streakValue
  };
}

/* =========================================================
   LOGISTIC MODEL
========================================================= */

function sigmoid(x) {
  if (x < -50) return 0;
  if (x > 50) return 1;

  return 1 /
    (1 + Math.exp(-x));
}

function dot(a,b) {
  let total = 0;

  for (
    let i = 0;
    i < Math.min(a.length,b.length);
    i++
  ) {
    total +=
      a[i] * b[i];
  }

  return total;
}

function createTrainingSet(history) {
  const samples = [];

  for (
    let i = 1;
    i < history.length;
    i++
  ) {
    const previous =
      history.slice(0,i);

    if (
      previous.length < 5
    ) {
      continue;
    }

    const n =
      history[i].number;

    if (!Number.isInteger(n)) {
      continue;
    }

    const f =
      buildFeatures(previous);

    samples.push({
      x: f.vector,
      y: n >= 5 ? 1 : 0
    });
  }

  return samples;
}

function trainModel(samples) {
  if (
    samples.length <
    MIN_TRAINING_SAMPLES
  ) {
    return null;
  }

  const weights =
    new Array(
      samples[0].x.length
    ).fill(0);

  let bias = 0;

  const learningRate = 0.04;
  const epochs = 180;

  for (
    let epoch = 0;
    epoch < epochs;
    epoch++
  ) {
    const gradient =
      new Array(
        weights.length
      ).fill(0);

    let biasGradient = 0;

    for (const sample of samples) {
      const p =
        sigmoid(
          dot(weights,sample.x) +
          bias
        );

      const error =
        p - sample.y;

      for (
        let j = 0;
        j < weights.length;
        j++
      ) {
        gradient[j] +=
          error *
          sample.x[j];
      }

      biasGradient += error;
    }

    for (
      let j = 0;
      j < weights.length;
      j++
    ) {
      weights[j] -=
        learningRate *
        gradient[j] /
        samples.length;
    }

    bias -=
      learningRate *
      biasGradient /
      samples.length;
  }

  return {
    weights,
    bias
  };
}

/* =========================================================
   VALIDATION
========================================================= */

function validation(history) {
  const samples =
    createTrainingSet(history);

  if (
    samples.length <
    MIN_TRAINING_SAMPLES
  ) {
    return {
      accuracy: 0.5,
      baseline: 0.5,
      edge: 0,
      tested: 0,
      samples: samples.length
    };
  }

  let start =
    Math.floor(
      samples.length * 0.45
    );

  start =
    Math.max(
      MIN_TRAINING_SAMPLES,
      start
    );

  if (
    start >= samples.length
  ) {
    start =
      Math.max(
        1,
        samples.length - 2
      );
  }

  let correct = 0;
  let tested = 0;

  for (
    let i = start;
    i < samples.length;
    i++
  ) {
    const model =
      trainModel(
        samples.slice(0,i)
      );

    if (!model) continue;

    const p =
      sigmoid(
        dot(
          model.weights,
          samples[i].x
        ) +
        model.bias
      );

    const predicted =
      p >= 0.5 ? 1 : 0;

    if (
      predicted ===
      samples[i].y
    ) {
      correct++;
    }

    tested++;
  }

  const accuracy =
    tested
      ? correct / tested
      : 0.5;

  const big =
    samples.filter(
      x => x.y === 1
    ).length;

  const small =
    samples.length - big;

  const baseline =
    samples.length
      ? Math.max(
          big,
          small
        ) / samples.length
      : 0.5;

  return {
    accuracy,
    baseline,
    edge:
      accuracy - baseline,
    tested,
    samples:
      samples.length
  };
}

/* =========================================================
   MARKOV
========================================================= */

function markov(bits) {
  if (bits.length < 4) {
    return {
      probability: 0.5,
      support: 0
    };
  }

  const counts = [
    [1,1],
    [1,1]
  ];

  const recent =
    bits.slice(-80);

  for (
    let i = 1;
    i < recent.length;
    i++
  ) {
    counts[
      recent[i - 1]
    ][
      recent[i]
    ]++;
  }

  const last =
    recent[recent.length - 1];

  const total =
    counts[last][0] +
    counts[last][1];

  return {
    probability:
      counts[last][1] / total,

    support:
      total - 2
  };
}

/* =========================================================
   PATTERN
========================================================= */

function pattern(bits, length) {
  if (
    bits.length <
    length + 1
  ) {
    return {
      probability: 0.5,
      matches: 0
    };
  }

  const target =
    bits.slice(-length);

  let big = 1;
  let small = 1;
  let matches = 0;

  for (
    let i = length;
    i < bits.length;
    i++
  ) {
    let matched = true;

    for (
      let j = 0;
      j < length;
      j++
    ) {
      if (
        bits[i-length+j] !==
        target[j]
      ) {
        matched = false;
        break;
      }
    }

    if (!matched) continue;

    matches++;

    if (bits[i] === 1) {
      big++;
    } else {
      small++;
    }
  }

  return {
    probability:
      big / (big + small),

    matches
  };
}

/* =========================================================
   STREAK
========================================================= */

function streakModel(f) {
  if (
    !f.streak ||
    f.streakValue === null
  ) {
    return {
      probability: 0.5,
      support: 0
    };
  }

  let same = 1;
  let opposite = 1;
  let support = 0;

  for (
    let i = 1;
    i < f.bits.length - 1;
    i++
  ) {
    let run = 1;

    for (
      let j = i - 1;
      j >= 0;
      j--
    ) {
      if (
        f.bits[j] !==
        f.bits[i]
      ) {
        break;
      }

      run++;
    }

    if (
      run !== f.streak
    ) {
      continue;
    }

    support++;

    if (
      f.bits[i+1] ===
      f.bits[i]
    ) {
      same++;
    } else {
      opposite++;
    }
  }

  if (!support) {
    return {
      probability: 0.5,
      support: 0
    };
  }

  const oppositeRate =
    opposite /
    (same + opposite);

  let p;

  if (
    f.streakValue === 1
  ) {
    p = 1 - oppositeRate;
  } else {
    p = oppositeRate;
  }

  return {
    probability:
      clamp(p,0.05,0.95),

    support
  };
}

/* =========================================================
   RANDOMNESS
========================================================= */

function randomness(bits) {
  if (bits.length < 4) {
    return 1;
  }

  const recent =
    bits.slice(-40);

  const ones =
    recent.filter(
      x => x === 1
    ).length /
    recent.length;

  let entropy = 0;

  if (
    ones > 0 &&
    ones < 1
  ) {
    entropy =
      -(
        ones *
        Math.log2(ones) +

        (1 - ones) *
        Math.log2(1 - ones)
      );
  }

  let switches = 0;

  for (
    let i = 1;
    i < recent.length;
    i++
  ) {
    if (
      recent[i] !==
      recent[i-1]
    ) {
      switches++;
    }
  }

  const rate =
    switches /
    Math.max(
      1,
      recent.length - 1
    );

  const switchRandomness =
    1 -
    Math.abs(rate - 0.5) * 2;

  return clamp(
    (entropy + switchRandomness) / 2,
    0,
    1
  );
}

/* =========================================================
   AI ANALYSIS
========================================================= */

function analyzeAI(history) {
  const f =
    buildFeatures(history);

  const samples =
    createTrainingSet(history);

  /*
    IMPORTANT:
    We only wait when history is genuinely
    too small. With 10 results this will
    already produce BIG/SMALL.
  */

  if (
    f.numbers.length <
    MIN_HISTORY
  ) {
    return {
      prediction: "WAIT",
      confidence: 0,
      quality: "LOW",
      evidence: "INSUFFICIENT",
      samples: samples.length
    };
  }

  const model =
    trainModel(samples);

  const valid =
    validation(history);

  /*
    ML fallback.
    Even if training model cannot be
    created, use available signals.
  */

  let ml = 0.5;

  if (model) {
    ml =
      sigmoid(
        dot(
          model.weights,
          f.vector
        ) +
        model.bias
      );
  }

  const mk =
    markov(f.bits);

  const p3 =
    pattern(f.bits,3);

  const p5 =
    pattern(f.bits,5);

  const st =
    streakModel(f);

  const random =
    randomness(f.bits);

  /*
    If model is weak, we still produce
    a signal instead of WAIT.
  */

  const weights = {
    ml: model ? 1.00 : 0.25,
    markov: 0.85,
    pattern3: 0.80,
    pattern5: 0.60,
    streak: 0.60
  };

  if (valid.edge > 0) {
    weights.ml +=
      Math.min(
        0.8,
        valid.edge * 5
      );
  }

  if (mk.support >= 4) {
    weights.markov *= 1.15;
  }

  if (p3.matches >= 2) {
    weights.pattern3 *= 1.15;
  }

  if (p5.matches >= 2) {
    weights.pattern5 *= 1.20;
  }

  if (st.support >= 2) {
    weights.streak *= 1.10;
  }

  if (random > 0.94) {
    weights.pattern3 *= 0.60;
    weights.pattern5 *= 0.50;
    weights.streak *= 0.80;
  }

  const models = [
    {
      name: "ML",
      p: ml,
      w: weights.ml
    },
    {
      name: "MARKOV",
      p: mk.probability,
      w: weights.markov
    },
    {
      name: "PATTERN3",
      p: p3.probability,
      w: weights.pattern3
    },
    {
      name: "PATTERN5",
      p: p5.probability,
      w: weights.pattern5
    },
    {
      name: "STREAK",
      p: st.probability,
      w: weights.streak
    }
  ];

  let weighted = 0;
  let totalWeight = 0;

  for (const item of models) {
    weighted +=
      item.p * item.w;

    totalWeight +=
      item.w;
  }

  let probability =
    totalWeight
      ? weighted / totalWeight
      : 0.5;

  /*
    Final safety:
    never return NaN.
  */

  if (!Number.isFinite(probability)) {
    probability = 0.5;
  }

  probability =
    clamp(
      probability,
      0.05,
      0.95
    );

  const prediction =
    probability >= 0.5
      ? "BIG"
      : "SMALL";

  const targetBit =
    prediction === "BIG"
      ? 1
      : 0;

  const agreementCount =
    models.filter(
      item =>
        (
          item.p >= 0.5
            ? 1
            : 0
        ) === targetBit
    ).length;

  const agreement =
    agreementCount /
    models.length;

  let confidence =
    51 +
    Math.abs(
      probability - 0.5
    ) * 100;

  confidence +=
    valid.edge * 20;

  if (random > 0.95) {
    confidence -= 5;
  }

  confidence =
    Math.round(
      clamp(
        confidence,
        51,
        91
      )
    );

  let quality = "LOW";

  if (
    confidence >= 65 &&
    agreement >= 0.60
  ) {
    quality = "MEDIUM";
  }

  if (
    confidence >= 76 &&
    agreement >= 0.80 &&
    random < 0.95
  ) {
    quality = "HIGH";
  }

  const evidence =
    agreement >= 0.60 &&
    samples.length >= 4
      ? "SUPPORTED"
      : "WEAK";

  return {
    prediction,
    confidence,
    quality,
    evidence,

    probability,

    mlProbability: ml,

    markovProbability:
      mk.probability,

    patternProbability:
      p3.probability,

    longPatternProbability:
      p5.probability,

    streakProbability:
      st.probability,

    agreement,

    randomness: random,

    validationAccuracy:
      valid.accuracy,

    validationBaseline:
      valid.baseline,

    validationEdge:
      valid.edge,

    validationTested:
      valid.tested,

    samples:
      samples.length,

    markovSupport:
      mk.support,

    patternMatches:
      p3.matches,

    longPatternMatches:
      p5.matches,

    streakSupport:
      st.support
  };
}

/* =========================================================
   PREDICTION DB
========================================================= */

async function getLastPrediction() {
  if (dbReady) {
    const result =
      await pool.query(`
        SELECT *
        FROM prediction_records
        ORDER BY id DESC
        LIMIT 1
      `);

    return result.rows[0] || null;
  }

  return (
    memory.predictions.at(-1) ||
    null
  );
}

async function predictionForIssue(issue) {
  if (!issue) return null;

  if (dbReady) {
    const result =
      await pool.query(
        `
        SELECT *
        FROM prediction_records
        WHERE target_issue=$1
        ORDER BY id DESC
        LIMIT 1
        `,
        [issue]
      );

    return result.rows[0] || null;
  }

  return (
    memory.predictions
      .slice()
      .reverse()
      .find(
        x =>
          x.target_issue === issue
      ) || null
  );
}

async function savePrediction(
  issue,
  ai
) {
  if (dbReady) {
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
          issue,
          ai.prediction,
          ai.confidence,
          MODEL_VERSION,
          now()
        ]
      );

    return result.rows[0];
  }

  const row = {
    id:
      memory.predictions.length + 1,

    target_issue:
      issue,

    prediction:
      ai.prediction,

    confidence:
      ai.confidence,

    model_version:
      MODEL_VERSION,

    actual_number:
      null,

    actual_result:
      null,

    created_at:
      now(),

    settled_at:
      null
  };

  memory.predictions.push(row);

  return row;
}

/* =========================================================
   SETTLEMENT
========================================================= */

async function settlePredictions() {
  const map =
    new Map(
      live.history.map(
        x => [
          x.issue,
          x.number
        ]
      )
    );

  if (dbReady) {
    const result =
      await pool.query(`
        SELECT *
        FROM prediction_records
        WHERE actual_number IS NULL
        ORDER BY id ASC
        LIMIT 200
      `);

    for (const row of result.rows) {
      const number =
        map.get(
          row.target_issue
        );

      if (
        number === undefined
      ) {
        continue;
      }

      await pool.query(
        `
        UPDATE prediction_records
        SET
          actual_number=$1,
          actual_result=$2,
          settled_at=$3
        WHERE id=$4
        `,
        [
          number,
          resultFromNumber(number),
          now(),
          row.id
        ]
      );
    }

    return;
  }

  for (
    const row of memory.predictions
  ) {
    if (
      row.actual_number !== null
    ) {
      continue;
    }

    const number =
      map.get(
        row.target_issue
      );

    if (
      number === undefined
    ) {
      continue;
    }

    row.actual_number =
      number;

    row.actual_result =
      resultFromNumber(number);

    row.settled_at =
      now();
  }
}

/* =========================================================
   4 ROUND SKIP CYCLE
========================================================= */

async function getCycle(issue) {
  const last =
    await getLastPrediction();

  if (!last) {
    return {
      mode: "PREDICT",
      skipRound: 0,
      skipTotal: SKIP_ROUNDS,
      skipRemaining: 0
    };
  }

  const diff =
    issueDiff(
      issue,
      last.target_issue
    );

  if (diff === null) {
    return {
      mode: "PREDICT",
      skipRound: 0,
      skipTotal: SKIP_ROUNDS,
      skipRemaining: 0
    };
  }

  if (diff <= 0) {
    return {
      mode: "PREDICTED",
      skipRound: 0,
      skipTotal: SKIP_ROUNDS,
      skipRemaining: 0
    };
  }

  /*
    After prediction:
    +1 +2 +3 +4 = SKIP
    +5 = NEXT PREDICTION
  */

  if (
    diff >= 1 &&
    diff <= SKIP_ROUNDS
  ) {
    return {
      mode: "SKIP",
      skipRound: diff,
      skipTotal: SKIP_ROUNDS,
      skipRemaining:
        SKIP_ROUNDS - diff + 1
    };
  }

  return {
    mode: "PREDICT",
    skipRound: 0,
    skipTotal: SKIP_ROUNDS,
    skipRemaining: 0
  };
}

/* =========================================================
   ANALYSIS RESET
========================================================= */

function resetAnalysis() {
  analysis.active = false;
  analysis.issue = null;
  analysis.startedAt = 0;
}

function startAnalysis(issue) {
  analysis.active = true;
  analysis.issue = String(issue);
  analysis.startedAt = now();

  console.log(
    "[AI] ANALYSIS START:",
    issue
  );
}

/* =========================================================
   ENGINE
========================================================= */

async function engineTick() {
  try {
    if (!live.currentIssue) {
      resetAnalysis();
      return;
    }

    const existing =
      await predictionForIssue(
        live.currentIssue
      );

    if (existing) {
      resetAnalysis();
      return;
    }

    const cycle =
      await getCycle(
        live.currentIssue
      );

    /*
      IMPORTANT:
      NO ANALYSIS DURING SKIP.
    */

    if (
      cycle.mode !== "PREDICT"
    ) {
      resetAnalysis();
      return;
    }

    /*
      New allowed round.
      Start immediately.
    */

    if (
      !analysis.active ||
      analysis.issue !==
        live.currentIssue
    ) {
      resetAnalysis();

      startAnalysis(
        live.currentIssue
      );

      return;
    }

    const elapsed =
      now() -
      analysis.startedAt;

    /*
      Wait exactly 4 seconds.
    */

    if (
      elapsed < ANALYSIS_MS
    ) {
      return;
    }

    /*
      Round changed during analysis.
    */

    if (
      live.currentIssue !==
      analysis.issue
    ) {
      resetAnalysis();
      return;
    }

    const target =
      analysis.issue;

    const duplicate =
      await predictionForIssue(
        target
      );

    if (duplicate) {
      resetAnalysis();
      return;
    }

    const ai =
      analyzeAI(
        live.history
      );

    /*
      Only genuinely insufficient
      history should WAIT.
    */

    if (
      ai.prediction === "WAIT"
    ) {
      console.log(
        "[AI] HISTORY TOO SMALL:",
        live.history.length
      );

      /*
        Do NOT create an endless
        ANALYZING -> WAIT -> ANALYZING
        loop.
      */

      resetAnalysis();
      return;
    }

    await savePrediction(
      target,
      ai
    );

    console.log(
      "[AI] PREDICTION:",
      target,
      ai.prediction,
      ai.confidence + "%"
    );

    resetAnalysis();

    await settlePredictions();

  } catch (err) {
    console.error(
      "ENGINE ERROR:",
      err.message
    );
  }
}

/* =========================================================
   LIVE REFRESH
========================================================= */

async function refreshLive() {
  try {
    const previousIssue =
      live.currentIssue;

    const data =
      await fetchWingo();

    live.online = true;
    live.history = data.history;
    live.currentIssue =
      data.currentIssue;
    live.latestIssue =
      data.latestIssue;
    live.latestNumber =
      data.latestNumber;
    live.latestResult =
      data.latestResult;
    live.fetchedAt = now();
    live.error = null;

    /*
      New issue detected.
      Restart timer from zero.
    */

    if (
      previousIssue &&
      previousIssue !==
        live.currentIssue
    ) {
      console.log(
        "[LIVE] NEW ROUND:",
        live.currentIssue
      );

      resetAnalysis();
    }

    await settlePredictions();

  } catch (err) {
    live.online = false;
    live.error = err.message;

    console.error(
      "[LIVE ERROR]",
      err.message
    );
  }
}

/* =========================================================
   STATE
========================================================= */

async function buildState() {
  let prediction = null;

  let cycle = {
    mode: "WAIT",
    skipRound: 0,
    skipTotal: SKIP_ROUNDS,
    skipRemaining: 0
  };

  if (live.currentIssue) {
    prediction =
      await predictionForIssue(
        live.currentIssue
      );

    if (prediction) {
      cycle = {
        mode: "PREDICTED",
        skipRound: 0,
        skipTotal: SKIP_ROUNDS,
        skipRemaining: 0
      };
    } else {
      cycle =
        await getCycle(
          live.currentIssue
        );
    }
  }

  let analysisSession = {
    active: false,
    issue: null,
    elapsed: 0,
    remaining: ANALYSIS_MS,
    total: ANALYSIS_MS,
    progress: 0
  };

  if (analysis.active) {
    const elapsed =
      Math.max(
        0,
        now() -
        analysis.startedAt
      );

    analysisSession = {
      active: true,
      issue: analysis.issue,
      elapsed:
        Math.min(
          elapsed,
          ANALYSIS_MS
        ),
      remaining:
        Math.max(
          0,
          ANALYSIS_MS - elapsed
        ),
      total: ANALYSIS_MS,
      progress:
        clamp(
          elapsed / ANALYSIS_MS,
          0,
          1
        )
    };
  }

  return {
    ok: true,

    online:
      live.online,

    source:
      "WingoBot",

    modelVersion:
      MODEL_VERSION,

    currentPeriod:
      live.currentIssue,

    nextPeriod:
      nextIssue(
        live.currentIssue
      ),

    latestIssue:
      live.latestIssue,

    latestNumber:
      Number.isInteger(
        live.latestNumber
      )
        ? live.latestNumber
        : null,

    latestResult:
      live.latestResult,

    lastFetchAt:
      live.fetchedAt,

    lastError:
      live.error,

    prediction:
      prediction
        ? {
            issue:
              prediction.target_issue,

            result:
              prediction.prediction,

            confidence:
              Number(
                prediction.confidence
              ) || 0,

            modelVersion:
              prediction.model_version
          }
        : null,

    cycle,

    analysisSession,

    recentResults:
      live.history
        .slice()
        .reverse()
        .slice(0,10)
  };
}

/* =========================================================
   ADMIN STATS
========================================================= */

async function getStats() {
  let rows = [];

  if (dbReady) {
    const result =
      await pool.query(`
        SELECT *
        FROM prediction_records
        ORDER BY id DESC
        LIMIT 200
      `);

    rows = result.rows;
  } else {
    rows =
      memory.predictions
        .slice()
        .reverse()
        .slice(0,200);
  }

  let settled = 0;
  let wins = 0;
  let losses = 0;

  for (const row of rows) {
    if (!row.actual_result) continue;

    settled++;

    if (
      row.prediction ===
      row.actual_result
    ) {
      wins++;
    } else {
      losses++;
    }
  }

  return {
    total: rows.length,
    settled,
    wins,
    losses,
    accuracy:
      settled
        ? wins / settled
        : 0,
    rows
  };
}

async function adminStatus() {
  const keys =
    await listKeys();

  const predictions =
    await getStats();

  return {
    ok: true,

    server: {
      node: process.version,
      model: MODEL_VERSION,
      database:
        dbReady
          ? "POSTGRESQL"
          : "MEMORY",
      analysisSeconds: 4,
      skipRounds: SKIP_ROUNDS,
      refreshSeconds: 1
    },

    live: {
      online:
        live.online,

      currentIssue:
        live.currentIssue,

      nextIssue:
        nextIssue(
          live.currentIssue
        ),

      latestIssue:
        live.latestIssue,

      latestNumber:
        Number.isInteger(
          live.latestNumber
        )
          ? live.latestNumber
          : null,

      latestResult:
        live.latestResult,

      historySize:
        live.history.length,

      lastError:
        live.error
    },

    analysis: {
      active:
        analysis.active,

      issue:
        analysis.issue,

      elapsed:
        analysis.active
          ? now() -
            analysis.startedAt
          : 0
    },

    keys: {
      total:
        keys.length,

      online:
        keys.filter(
          x =>
            x.last_seen &&
            now() -
              Number(x.last_seen) <
              120000
        ).length,

      rows:
        keys
    },

    predictions
  };
}

/* =========================================================
   HTTP HELPERS
========================================================= */

function sendJSON(res, status, data) {
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
        "Content-Type,X-Admin-Key,X-Access-Key,X-Device-ID",

      "Access-Control-Allow-Methods":
        "GET,POST,OPTIONS"
    }
  );

  res.end(body);
}

function sendFile(res, filename) {
  const file =
    path.join(
      __dirname,
      filename
    );

  if (!fs.existsSync(file)) {
    sendJSON(
      res,
      404,
      {
        ok: false,
        message:
          filename +
          " NOT FOUND"
      }
    );

    return;
  }

  res.writeHead(
    200,
    {
      "Content-Type":
        "text/html; charset=utf-8",

      "Cache-Control":
        "no-cache"
    }
  );

  fs.createReadStream(file)
    .pipe(res);
}

function readBody(req) {
  return new Promise(
    (resolve,reject) => {
      let data = "";

      req.on(
        "data",
        chunk => {
          data += chunk;

          if (
            data.length >
            1000000
          ) {
            reject(
              new Error(
                "REQUEST TOO LARGE"
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

function isAdmin(req, body) {
  const header =
    text(
      req.headers[
        "x-admin-key"
      ]
    );

  const bodyKey =
    text(
      body &&
      body.adminKey
    );

  return (
    header === ADMIN_KEY ||
    bodyKey === ADMIN_KEY
  );
}

/* =========================================================
   ROUTER
========================================================= */

async function router(req,res) {
  const url =
    new URL(
      req.url,
      "http://localhost"
    );

  const route =
    url.pathname;

  if (
    req.method === "OPTIONS"
  ) {
    sendJSON(
      res,
      204,
      {}
    );
    return;
  }

  if (
    req.method === "GET" &&
    route === "/"
  ) {
    sendFile(
      res,
      "prediction.html"
    );
    return;
  }

  if (
    req.method === "GET" &&
    route ===
      "/prediction.html"
  ) {
    sendFile(
      res,
      "prediction.html"
    );
    return;
  }

  if (
    req.method === "GET" &&
    route === "/admin.html"
  ) {
    sendFile(
      res,
      "admin.html"
    );
    return;
  }

  if (
    req.method === "GET" &&
    route === "/health"
  ) {
    sendJSON(
      res,
      200,
      {
        ok: true,
        model:
          MODEL_VERSION,
        online:
          live.online,
        currentIssue:
          live.currentIssue,
        latestNumber:
          live.latestNumber,
        latestResult:
          live.latestResult,
        error:
          live.error
      }
    );
    return;
  }

  /* KEY CHECK */

  if (
    req.method === "POST" &&
    route ===
      "/api/key/check"
  ) {
    const body =
      await readBody(req);

    try {
      const result =
        await checkAccess(
          body.accessKey,
          body.deviceId
        );

      sendJSON(
        res,
        200,
        result
      );
    } catch (err) {
      sendJSON(
        res,
        500,
        {
          ok: false,
          message:
            err.message
        }
      );
    }

    return;
  }

  /* STATE */

  if (
    req.method === "GET" &&
    route === "/api/state"
  ) {
    sendJSON(
      res,
      200,
      await buildState()
    );
    return;
  }

  /* ADMIN */

  if (
    route.startsWith(
      "/api/admin/"
    )
  ) {
    let body = {};

    if (
      req.method === "POST"
    ) {
      body =
        await readBody(req);
    }

    if (
      !isAdmin(
        req,
        body
      )
    ) {
      sendJSON(
        res,
        403,
        {
          ok: false,
          message:
            "ADMIN AUTH FAILED"
        }
      );

      return;
    }

    /* PING */

    if (
      req.method === "GET" &&
      route ===
        "/api/admin/ping"
    ) {
      sendJSON(
        res,
        200,
        {
          ok: true,
          pong: true,
          time: now()
        }
      );

      return;
    }

    /* STATUS */

    if (
      req.method === "GET" &&
      route ===
        "/api/admin/status"
    ) {
      sendJSON(
        res,
        200,
        await adminStatus()
      );

      return;
    }

    /* KEYS */

    if (
      req.method === "GET" &&
      route ===
        "/api/admin/keys"
    ) {
      sendJSON(
        res,
        200,
        {
          ok: true,
          keys:
            await listKeys()
        }
      );

      return;
    }

    /* CREATE KEY */

    if (
      req.method === "POST" &&
      route ===
        "/api/admin/keys"
    ) {
      try {
        const key =
          await createKey(
            body.accessKey
          );

        sendJSON(
          res,
          200,
          {
            ok: true,
            key
          }
        );
      } catch (err) {
        sendJSON(
          res,
          400,
          {
            ok: false,
            message:
              err.message
          }
        );
      }

      return;
    }

    /* RESET DEVICE */

    if (
      req.method === "POST" &&
      route ===
        "/api/admin/reset-device"
    ) {
      const result =
        await resetDevice(
          body.accessKey
        );

      if (!result) {
        sendJSON(
          res,
          404,
          {
            ok: false,
            message:
              "KEY NOT FOUND"
          }
        );

        return;
      }

      sendJSON(
        res,
        200,
        {
          ok: true,
          key: result
        }
      );

      return;
    }

    /* DELETE KEY */

    if (
      req.method === "POST" &&
      route ===
        "/api/admin/delete-key"
    ) {
      const result =
        await deleteKey(
          body.accessKey
        );

      if (!result) {
        sendJSON(
          res,
          404,
          {
            ok: false,
            message:
              "KEY NOT FOUND"
          }
        );

        return;
      }

      sendJSON(
        res,
        200,
        {
          ok: true,
          deleted: result
        }
      );

      return;
    }

    /* LIVE TEST */

    if (
      req.method === "GET" &&
      route ===
        "/api/admin/live-test"
    ) {
      try {
        const data =
          await fetchWingo();

        const ai =
          analyzeAI(
            data.history
          );

        sendJSON(
          res,
          200,
          {
            ok: true,

            currentIssue:
              data.currentIssue,

            nextIssue:
              nextIssue(
                data.currentIssue
              ),

            latestIssue:
              data.latestIssue,

            latestNumber:
              data.latestNumber,

            latestResult:
              data.latestResult,

            historySize:
              data.history.length,

            ai
          }
        );
      } catch (err) {
        sendJSON(
          res,
          500,
          {
            ok: false,
            message:
              err.message
          }
        );
      }

      return;
    }

    /* MODEL TEST */

    if (
      req.method === "GET" &&
      route ===
        "/api/admin/model-test"
    ) {
      if (!live.history.length) {
        sendJSON(
          res,
          200,
          {
            ok: false,
            message:
              "NO LIVE HISTORY"
          }
        );

        return;
      }

      sendJSON(
        res,
        200,
        {
          ok: true,
          model:
            MODEL_VERSION,

          currentIssue:
            live.currentIssue,

          result:
            analyzeAI(
              live.history
            )
        }
      );

      return;
    }

    /* PREDICTIONS */

    if (
      req.method === "GET" &&
      route ===
        "/api/admin/predictions"
    ) {
      sendJSON(
        res,
        200,
        await getStats()
      );

      return;
    }

    sendJSON(
      res,
      404,
      {
        ok: false,
        message:
          "ADMIN ROUTE NOT FOUND"
      }
    );

    return;
  }

  sendJSON(
    res,
    404,
    {
      ok: false,
      message:
        "ROUTE NOT FOUND"
    }
  );
}

/* =========================================================
   SERVER
========================================================= */

const server =
  http.createServer(
    (req,res) => {
      router(req,res)
        .catch(err => {
          console.error(
            "SERVER ERROR:",
            err
          );

          if (
            !res.headersSent
          ) {
            sendJSON(
              res,
              500,
              {
                ok: false,
                message:
                  "INTERNAL SERVER ERROR"
              }
            );
          }
        });
    }
  );

/* =========================================================
   START
========================================================= */

async function start() {
  await initDB();

  server.listen(
    PORT,
    "0.0.0.0",
    () => {
      console.log(
        "================================"
      );

      console.log(
        "DY AI WINGO V6 STARTED"
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
        "API REFRESH: 1 SECOND"
      );

      console.log(
        "ANALYSIS: 4 SECONDS"
      );

      console.log(
        "SKIP ROUNDS:",
        SKIP_ROUNDS
      );

      console.log(
        "================================"
      );
    }
  );

  /*
    First live fetch.
  */

  await refreshLive();

  /*
    API every 1 second.
  */

  setInterval(
    refreshLive,
    API_REFRESH_MS
  );

  /*
    Engine every 250ms.
  */

  setInterval(
    engineTick,
    ENGINE_TICK_MS
  );

  await engineTick();
}

start().catch(err => {
  console.error(
    "FATAL ERROR:",
    err
  );

  process.exit(1);
});

process.on(
  "SIGTERM",
  async () => {
    try {
      if (pool) {
        await pool.end();
      }
    } catch {}

    server.close(
      () => process.exit(0)
    );

    setTimeout(
      () => process.exit(0),
      3000
    );
  }
);
