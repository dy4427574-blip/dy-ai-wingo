const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

/* =========================================================
   DY AI WINGO 30S - PRO SERVER
   ========================================================= */

const PORT = Number(process.env.PORT || 10000);

const ADMIN_KEY = process.env.ADMIN_KEY || "dy4427574";

const WINGOBOT_TOKEN = process.env.WINGOBOT_TOKEN || "";
const WINGOBOT_URL =
  process.env.WINGOBOT_URL ||
  "https://api.wingobot.com/v2/30-sec-game-history";

const ROUND_SECONDS = 30;

const LIVE_RESULTS_LIMIT = 30;
const WINLOSS_LIMIT = 30;

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("DATABASE_URL missing");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

/* =========================================================
   GLOBAL STATE
   ========================================================= */

const state = {
  history: [],
  lastSettledIssue: "",
  lastHistorySignature: "",
  targetIssue: "",
  prediction: null,
  countdown: 30,
  anchorTime: Date.now(),
  anchorIssue: "",
  historyVersion: 0,
  providerCurrentIssue: "",
  providerFetched: 0,
  lastFetchAt: 0,
  lastError: "",
  updating: false
};

/* =========================================================
   DATABASE
   ========================================================= */

async function initDb() {
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
      target_issue TEXT UNIQUE NOT NULL,
      prediction TEXT NOT NULL,
      predicted_number INTEGER,
      confidence NUMERIC DEFAULT 0,
      status TEXT DEFAULT 'PENDING',
      actual_number INTEGER,
      actual_result TEXT,
      created_at BIGINT NOT NULL,
      settled_at BIGINT DEFAULT 0
    )
  `);
}

/* =========================================================
   HELPERS
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
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS"
  });

  res.end(body);
}

function text(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });

  res.end(body);
}

function issueToString(v) {
  if (v === undefined || v === null) return "";
  return String(v).trim();
}

function issueNumber(issue) {
  const n = BigInt(issueToString(issue) || "0");
  return n;
}

function nextIssue(issue) {
  try {
    return (issueNumber(issue) + 1n).toString();
  } catch {
    return "";
  }
}

function resultType(number) {
  const n = Number(number);

  if (!Number.isFinite(n)) return "";

  return n >= 5 ? "BIG" : "SMALL";
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function average(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function safeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function randomId(prefix = "") {
  return prefix + crypto.randomBytes(12).toString("hex");
}

/* =========================================================
   HTTP BODY
   ========================================================= */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";

    req.on("data", chunk => {
      data += chunk;

      if (data.length > 1024 * 1024) {
        reject(new Error("Request too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!data) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });

    req.on("error", reject);
  });
}

/* =========================================================
   WINGOBOT API
   ========================================================= */

async function fetchWingo() {
  if (!WINGOBOT_TOKEN) {
    throw new Error("WINGOBOT_TOKEN missing");
  }

  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, 12000);

  try {
    const response = await fetch(WINGOBOT_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${WINGOBOT_TOKEN}`,
        Accept: "application/json"
      },
      signal: controller.signal
    });

    const textData = await response.text();

    let data;

    try {
      data = JSON.parse(textData);
    } catch {
      throw new Error(
        `Wingo API returned invalid JSON (${response.status})`
      );
    }

    if (!response.ok) {
      throw new Error(
        data?.error ||
        data?.message ||
        `Wingo API HTTP ${response.status}`
      );
    }

    if (data && data.success === false) {
      throw new Error(data.error || "Wingo API failed");
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}

/* =========================================================
   HISTORY NORMALIZATION
   ========================================================= */

function normalizeHistory(data) {
  let rows = [];

  if (Array.isArray(data?.history)) {
    rows = data.history;
  } else if (Array.isArray(data?.data?.history)) {
    rows = data.data.history;
  } else if (Array.isArray(data?.data)) {
    rows = data.data;
  }

  const normalized = rows
    .map(row => {
      const issue =
        row?.issueNumber ??
        row?.issue ??
        row?.period ??
        row?.periodId ??
        row?.id;

      const number =
        row?.number ??
        row?.drawNumber ??
        row?.result;

      if (issue === undefined || number === undefined) {
        return null;
      }

      const n = Number(number);

      if (!Number.isFinite(n)) {
        return null;
      }

      return {
        issueNumber: issueToString(issue),
        number: n,
        colour:
          row?.colour ??
          row?.color ??
          "",
        premium:
          row?.premium ??
          null,
        sum:
          row?.sum ??
          null
      };
    })
    .filter(Boolean);

  const unique = new Map();

  for (const row of normalized) {
    if (!unique.has(row.issueNumber)) {
      unique.set(row.issueNumber, row);
    }
  }

  const result = [...unique.values()];

  result.sort((a, b) => {
    try {
      const aa = issueNumber(a.issueNumber);
      const bb = issueNumber(b.issueNumber);

      if (aa > bb) return -1;
      if (aa < bb) return 1;
      return 0;
    } catch {
      return 0;
    }
  });

  return result;
}

/* =========================================================
   COUNTDOWN EXTRACTION
   ========================================================= */

function extractCountdown(data) {
  const candidates = [
    data?.countdownSeconds,
    data?.countdown,
    data?.current?.countdownSeconds,
    data?.current?.countdown,
    data?.data?.countdownSeconds,
    data?.data?.countdown
  ];

  for (const value of candidates) {
    const n = Number(value);

    if (Number.isFinite(n) && n >= 0 && n <= ROUND_SECONDS) {
      return Math.floor(n);
    }
  }

  return null;
}

/* =========================================================
   BASIC FEATURES
   ========================================================= */

function getTypes(history) {
  return history
    .map(x => resultType(x.number))
    .filter(Boolean);
}

function getNumbers(history) {
  return history
    .map(x => Number(x.number))
    .filter(Number.isFinite);
}

function getSequence(history, length = history.length) {
  const source = history.slice(0, Math.max(0, length));

  return source
    .map(x => resultType(x.number))
    .filter(Boolean)
    .reverse();
}

function bigSmallCounts(sequence) {
  let big = 0;
  let small = 0;

  for (const x of sequence) {
    if (x === "BIG") big++;
    else if (x === "SMALL") small++;
  }

  return { big, small };
}

function opposite(type) {
  return type === "BIG" ? "SMALL" : "BIG";
}

/* =========================================================
   MODEL 1 - RECENCY
   ========================================================= */

function recencyModel(history) {
  const seq = getSequence(history, Math.min(history.length, 40));

  if (seq.length < 4) return null;

  const weights = {
    BIG: 0,
    SMALL: 0
  };

  for (let i = 0; i < seq.length; i++) {
    const weight = i + 1;
    weights[seq[i]] += weight;
  }

  const total = weights.BIG + weights.SMALL;

  if (!total) return null;

  const bigPct = weights.BIG / total;
  const smallPct = weights.SMALL / total;

  const prediction =
    bigPct >= smallPct ? "BIG" : "SMALL";

  const edge =
    Math.abs(bigPct - smallPct);

  return {
    name: "Recency",
    prediction,
    confidence: clamp(50 + edge * 100, 50, 72),
    reason: `Recent ${seq.length} rounds weighted by recency`
  };
}

/* =========================================================
   MODEL 2 - SHORT WINDOW
   ========================================================= */

function shortWindowModel(history) {
  const seq = getSequence(history, Math.min(history.length, 12));

  if (seq.length < 5) return null;

  const counts = bigSmallCounts(seq);

  const pBig = counts.big / seq.length;
  const pSmall = counts.small / seq.length;

  let prediction =
    pBig >= pSmall ? "BIG" : "SMALL";

  const last = seq[seq.length - 1];

  let streak = 1;

  for (let i = seq.length - 2; i >= 0; i--) {
    if (seq[i] === last) streak++;
    else break;
  }

  if (streak >= 4) {
    prediction = last;
  }

  const edge =
    Math.abs(pBig - pSmall);

  return {
    name: "Short Window",
    prediction,
    confidence: clamp(
      50 + edge * 80 + Math.min(streak, 5) * 2,
      50,
      78
    ),
    reason:
      `12-round balance + streak ${streak}`
  };
}

/* =========================================================
   MODEL 3 - TRANSITION
   ========================================================= */

function transitionModel(history) {
  const seq = getSequence(history, Math.min(history.length, 300));

  if (seq.length < 20) return null;

  const transition = {
    BIG: {
      BIG: 0,
      SMALL: 0
    },
    SMALL: {
      BIG: 0,
      SMALL: 0
    }
  };

  for (let i = 1; i < seq.length; i++) {
    const previous = seq[i - 1];
    const current = seq[i];

    transition[previous][current]++;
  }

  const last = seq[seq.length - 1];

  const row = transition[last];

  const total = row.BIG + row.SMALL;

  if (!total) return null;

  const pBig = row.BIG / total;
  const pSmall = row.SMALL / total;

  const prediction =
    pBig >= pSmall ? "BIG" : "SMALL";

  return {
    name: "Transition",
    prediction,
    confidence: clamp(
      50 + Math.abs(pBig - pSmall) * 100,
      50,
      80
    ),
    reason:
      `Historical transition after ${last}`
  };
}

/* =========================================================
   MODEL 4 - STREAK
   ========================================================= */

function streakModel(history) {
  const seq = getSequence(history, Math.min(history.length, 80));

  if (seq.length < 5) return null;

  const last = seq[seq.length - 1];

  let streak = 1;

  for (let i = seq.length - 2; i >= 0; i--) {
    if (seq[i] === last) {
      streak++;
    } else {
      break;
    }
  }

  if (streak < 3) {
    return null;
  }

  return {
    name: "Streak",
    prediction: last,
    confidence: clamp(
      55 + streak * 4,
      55,
      75
    ),
    reason:
      `${last} streak detected: ${streak}`
  };
}

/* =========================================================
   MODEL 5 - ALTERNATION
   ========================================================= */

function alternationModel(history) {
  const seq = getSequence(history, Math.min(history.length, 16));

  if (seq.length < 6) return null;

  let alternating = 0;
  let total = 0;

  for (let i = 1; i < seq.length; i++) {
    total++;

    if (seq[i] !== seq[i - 1]) {
      alternating++;
    }
  }

  const ratio = alternating / total;

  if (ratio < 0.72) {
    return null;
  }

  const prediction =
    opposite(seq[seq.length - 1]);

  return {
    name: "Alternation",
    prediction,
    confidence: clamp(
      55 + ratio * 20,
      55,
      72
    ),
    reason:
      `Alternation ratio ${(ratio * 100).toFixed(1)}%`
  };
}

/* =========================================================
   MODEL 6 - LONG HISTORY
   ========================================================= */

function longHistoryModel(history) {
  const seq = getSequence(history, history.length);

  if (seq.length < 30) return null;

  const counts = bigSmallCounts(seq);

  const total = counts.big + counts.small;

  const pBig = counts.big / total;
  const pSmall = counts.small / total;

  const prediction =
    pBig >= pSmall ? "BIG" : "SMALL";

  return {
    name: "Full History",
    prediction,
    confidence: clamp(
      50 + Math.abs(pBig - pSmall) * 70,
      50,
      65
    ),
    reason:
      `Full available history: ${seq.length} rounds`
  };
}

/* =========================================================
   MODEL 7 - NUMBER STRUCTURE
   ========================================================= */

function numberStructureModel(history) {
  const numbers = getNumbers(
    history.slice(0, Math.min(history.length, 100))
  );

  if (numbers.length < 15) return null;

  let big = 0;
  let small = 0;

  for (const n of numbers) {
    if (n >= 5) big++;
    else small++;
  }

  const total = big + small;

  const pBig = big / total;
  const pSmall = small / total;

  const prediction =
    pBig >= pSmall ? "BIG" : "SMALL";

  return {
    name: "Number Structure",
    prediction,
    confidence: clamp(
      50 + Math.abs(pBig - pSmall) * 60,
      50,
      63
    ),
    reason:
      "Digit distribution analysis"
  };
}

/* =========================================================
   MODEL 8 - HISTORICAL PATTERN MATCHING
   ========================================================= */

function patternMatchingModel(history) {
  const seq = getSequence(history, history.length);

  if (seq.length < 30) return null;

  const patternLength = Math.min(5, Math.floor(seq.length / 4));

  const currentPattern =
    seq.slice(seq.length - patternLength);

  if (currentPattern.length < 3) {
    return null;
  }

  let bigFollowing = 0;
  let smallFollowing = 0;
  let matches = 0;

  for (
    let i = 0;
    i <= seq.length - patternLength - 1;
    i++
  ) {
    const candidate =
      seq.slice(i, i + patternLength);

    let same = true;

    for (let j = 0; j < patternLength; j++) {
      if (candidate[j] !== currentPattern[j]) {
        same = false;
        break;
      }
    }

    if (!same) continue;

    const next = seq[i + patternLength];

    if (next === "BIG") bigFollowing++;
    if (next === "SMALL") smallFollowing++;

    matches++;
  }

  if (matches < 3) {
    return null;
  }

  const total =
    bigFollowing + smallFollowing;

  if (!total) return null;

  const pBig = bigFollowing / total;
  const pSmall = smallFollowing / total;

  const prediction =
    pBig >= pSmall ? "BIG" : "SMALL";

  return {
    name: "Pattern Match",
    prediction,
    confidence: clamp(
      50 +
        Math.abs(pBig - pSmall) * 100 +
        Math.min(matches, 10),
      50,
      78
    ),
    reason:
      `${matches} historical matches for ${patternLength}-round pattern`
  };
}

/* =========================================================
   MODEL GENERATOR
   ========================================================= */

function generateModels(history) {
  const models = [
    recencyModel(history),
    shortWindowModel(history),
    transitionModel(history),
    streakModel(history),
    alternationModel(history),
    longHistoryModel(history),
    numberStructureModel(history),
    patternMatchingModel(history)
  ].filter(Boolean);

  if (!models.length && history.length >= 2) {
    const seq = getSequence(history, history.length);

    if (seq.length >= 2) {
      models.push({
        name: "Adaptive Fallback",
        prediction: seq[seq.length - 1],
        confidence: 50,
        reason: "Insufficient historical structure"
      });
    }
  }

  return models;
}

/* =========================================================
   FAST PREDICTION ENGINE
   ========================================================= */

function rawEnsemble(history) {
  const models = generateModels(history);

  if (!models.length) {
    return {
      prediction: null,
      confidence: 0,
      agreement: 0,
      models: [],
      reason: "Insufficient data"
    };
  }

  const weights = {
    "Pattern Match": 1.35,
    "Transition": 1.25,
    "Short Window": 1.2,
    "Recency": 1.05,
    "Streak": 0.9,
    "Alternation": 0.85,
    "Number Structure": 0.55,
    "Full History": 0.65,
    "Adaptive Fallback": 0.2
  };

  let bigScore = 0;
  let smallScore = 0;

  for (const model of models) {
    const weight =
      weights[model.name] || 0.75;

    const confidenceFactor =
      clamp(model.confidence, 50, 85) / 100;

    const score =
      weight * confidenceFactor;

    if (model.prediction === "BIG") {
      bigScore += score;
    } else if (model.prediction === "SMALL") {
      smallScore += score;
    }
  }

  const total = bigScore + smallScore;

  if (!total) {
    return {
      prediction: null,
      confidence: 0,
      agreement: 0,
      models,
      reason: "No directional signal"
    };
  }

  const prediction =
    bigScore >= smallScore ? "BIG" : "SMALL";

  const dominant =
    Math.max(bigScore, smallScore);

  const confidence =
    clamp(
      50 + ((dominant / total) - 0.5) * 100,
      50,
      82
    );

  const sameCount =
    models.filter(
      x => x.prediction === prediction
    ).length;

  const agreement =
    models.length
      ? (sameCount / models.length) * 100
      : 0;

  return {
    prediction,
    confidence,
    agreement,
    models,
    reason:
      `${sameCount}/${models.length} models agree`
  };
}

/* =========================================================
   WALK-FORWARD BACKTEST
   ========================================================= */

function backtest(history) {
  const chronological = [...history].reverse();

  if (chronological.length < 40) {
    return {
      samples: 0,
      wins: 0,
      losses: 0,
      accuracy: null
    };
  }

  /*
    Use a practical sample window so a 1000+ result history
    does not make every API refresh unnecessarily expensive.
    Each tested point still uses ALL earlier available data.
  */

  const minimumTrain = 30;

  const available =
    chronological.length - minimumTrain;

  const sampleCount =
    Math.min(150, available);

  if (sampleCount <= 0) {
    return {
      samples: 0,
      wins: 0,
      losses: 0,
      accuracy: null
    };
  }

  const start =
    chronological.length - sampleCount;

  let wins = 0;
  let losses = 0;
  let samples = 0;

  for (let i = start; i < chronological.length; i++) {
    const train =
      chronological.slice(0, i);

    const actual =
      resultType(chronological[i].number);

    const signal =
      rawEnsemble(train);

    if (!signal.prediction) {
      continue;
    }

    samples++;

    if (signal.prediction === actual) {
      wins++;
    } else {
      losses++;
    }
  }

  return {
    samples,
    wins,
    losses,
    accuracy:
      samples
        ? (wins / samples) * 100
        : null
  };
}

/* =========================================================
   ADAPTIVE ENSEMBLE + CALIBRATION
   ========================================================= */

function adaptiveEnsemble(history) {
  const raw = rawEnsemble(history);

  if (!raw.prediction) {
    return {
      prediction: null,
      confidence: 0,
      agreement: 0,
      patternScore: 0,
      backtest: {
        samples: 0,
        wins: 0,
        losses: 0,
        accuracy: null
      },
      status: "INSUFFICIENT DATA",
      models: []
    };
  }

  /*
    Backtest is intentionally done on historical data only.
    It is NOT used to guarantee the next result.
  */

  const bt = backtest(history);

  let confidence = raw.confidence;

  /*
    Strong calibration rule:
    if we do not have enough out-of-sample samples,
    do not display artificially high confidence.
  */

  if (bt.samples < 20) {
    confidence = Math.min(confidence, 60);
  } else if (bt.samples < 50) {
    confidence = Math.min(confidence, 66);
  } else if (
    bt.accuracy !== null &&
    bt.accuracy < 50
  ) {
    confidence = Math.min(confidence, 57);
  } else if (
    bt.accuracy !== null &&
    bt.accuracy < 55
  ) {
    confidence = Math.min(confidence, 62);
  } else if (
    bt.accuracy !== null &&
    bt.accuracy >= 60
  ) {
    confidence += 4;
  }

  /*
    Agreement matters, but cannot create certainty.
  */

  if (raw.agreement < 50) {
    confidence -= 4;
  }

  if (raw.agreement >= 75) {
    confidence += 3;
  }

  confidence =
    clamp(
      Math.round(confidence),
      50,
      76
    );

  let status = "WEAK SIGNAL";

  if (bt.samples < 20) {
    status = "EARLY SIGNAL";
  } else if (
    confidence >= 70 &&
    bt.accuracy !== null &&
    bt.accuracy >= 55
  ) {
    status = "STRONGER MODEL LEAN";
  } else if (confidence >= 63) {
    status = "MODERATE SIGNAL";
  }

  const patternScore =
    Math.round(
      clamp(
        raw.agreement * 0.55 +
        confidence * 0.45,
        0,
        100
      )
    );

  return {
    prediction: raw.prediction,
    confidence,
    agreement: Math.round(raw.agreement),
    patternScore,
    backtest: bt,
    status,
    models: raw.models.map(m => ({
      name: m.name,
      prediction: m.prediction,
      confidence: Math.round(m.confidence),
      reason: m.reason
    }))
  };
}

/* =========================================================
   PREDICTED NUMBER
   ========================================================= */

function predictedNumber(history, prediction) {
  if (!prediction) return null;

  const numbers = getNumbers(
    history.slice(0, 80)
  );

  if (!numbers.length) {
    return prediction === "BIG" ? 7 : 3;
  }

  /*
    Number is only a representative digit of the
    BIG/SMALL statistical signal.
  */

  const candidates =
    prediction === "BIG"
      ? [5, 6, 7, 8, 9]
      : [0, 1, 2, 3, 4];

  const frequency = new Map();

  for (const n of numbers) {
    frequency.set(
      n,
      (frequency.get(n) || 0) + 1
    );
  }

  candidates.sort((a, b) => {
    return (
      (frequency.get(a) || 0) -
      (frequency.get(b) || 0)
    );
  });

  return candidates[0];
}

/* =========================================================
   PREDICTION DATABASE
   ========================================================= */

async function savePrediction(pred) {
  if (!pred?.targetIssue || !pred?.prediction) {
    return;
  }

  await pool.query(
    `
    INSERT INTO predictions
    (
      target_issue,
      prediction,
      predicted_number,
      confidence,
      status,
      created_at
    )
    VALUES ($1,$2,$3,$4,'PENDING',$5)
    ON CONFLICT (target_issue)
    DO UPDATE SET
      prediction = EXCLUDED.prediction,
      predicted_number = EXCLUDED.predicted_number,
      confidence = EXCLUDED.confidence
    `,
    [
      pred.targetIssue,
      pred.prediction,
      pred.predictedNumber,
      pred.confidence,
      now()
    ]
  );
}

/* =========================================================
   SETTLE PREDICTION
   ========================================================= */

async function settlePrediction(issue, actualNumber) {
  if (!issue) return;

  const actual = resultType(actualNumber);

  if (!actual) return;

  await pool.query(
    `
    UPDATE predictions
    SET
      actual_number = $2,
      actual_result = $3,
      status =
        CASE
          WHEN prediction = $3 THEN 'WIN'
          ELSE 'LOSS'
        END,
      settled_at = $4
    WHERE target_issue = $1
      AND status = 'PENDING'
    `,
    [
      issue,
      actualNumber,
      actual,
      now()
    ]
  );
}

/* =========================================================
   WIN / LOSS HISTORY
   ========================================================= */

async function getWinLoss(limit = WINLOSS_LIMIT) {
  const result = await pool.query(
    `
    SELECT
      target_issue,
      prediction,
      predicted_number,
      confidence,
      status,
      actual_number,
      actual_result,
      created_at,
      settled_at
    FROM predictions
    WHERE status IN ('WIN','LOSS')
    ORDER BY id DESC
    LIMIT $1
    `,
    [limit]
  );

  const rows = result.rows;

  let wins = 0;
  let losses = 0;

  for (const row of rows) {
    if (row.status === "WIN") wins++;
    if (row.status === "LOSS") losses++;
  }

  const total = wins + losses;

  return {
    rows,
    wins,
    losses,
    total,
    rate:
      total
        ? Math.round((wins / total) * 100)
        : 0
  };
}

/* =========================================================
   LIVE UPDATE
   ========================================================= */

async function updateLiveState() {
  if (state.updating) return;

  state.updating = true;

  try {
    const data = await fetchWingo();

    const history =
      normalizeHistory(data);

    if (!history.length) {
      throw new Error("Wingo history empty");
    }

    const providerCurrent =
      issueToString(
        data?.current?.issueNumber ??
        data?.current?.periodId ??
        ""
      );

    const providerFetched =
      Number(
        data?.stats?.fetched ??
        history.length
      );

    const settled =
      history[0];

    const settledIssue =
      settled.issueNumber;

    const signature =
      history
        .slice(0, 20)
        .map(
          x => `${x.issueNumber}:${x.number}`
        )
        .join("|");

    const oldSettled =
      state.lastSettledIssue;

    const historyChanged =
      signature !== state.lastHistorySignature;

    /*
      First settle the prediction belonging to
      the newly arrived settled issue.
    */

    if (
      historyChanged &&
      oldSettled &&
      settledIssue !== oldSettled
    ) {
      const oldRow =
        history.find(
          x => x.issueNumber ===
            state.targetIssue
        );

      /*
        Prefer exact target issue.
        If not available, settle the previous target
        only when the API actually contains that issue.
      */

      const previousTarget =
        state.targetIssue;

      if (previousTarget) {
        const matching =
          history.find(
            x =>
              x.issueNumber ===
              previousTarget
          );

        if (matching) {
          await settlePrediction(
            matching.issueNumber,
            matching.number
          );
        }
      }
    }

    state.history = history;
    state.providerCurrentIssue =
      providerCurrent;

    state.providerFetched =
      providerFetched;

    state.lastFetchAt =
      now();

    state.lastError = "";

    /*
      Prediction period:
      provider current issue if it is ahead of
      latest settled result; otherwise next issue.
    */

    let target = nextIssue(
      settledIssue
    );

    if (providerCurrent) {
      try {
        if (
          issueNumber(providerCurrent) >
          issueNumber(settledIssue)
        ) {
          target = providerCurrent;
        }
      } catch {}
    }

    /*
      Recalculate ONLY when history changes
      or target changed.
    */

    const shouldRecalculate =
      historyChanged ||
      target !== state.targetIssue ||
      !state.prediction;

    if (shouldRecalculate) {
      const analysis =
        adaptiveEnsemble(history);

      const pNumber =
        predictedNumber(
          history,
          analysis.prediction
        );

      state.targetIssue =
        target;

      state.prediction = {
        targetIssue: target,
        prediction:
          analysis.prediction,
        predictedNumber: pNumber,
        confidence:
          analysis.confidence,
        agreement:
          analysis.agreement,
        patternScore:
          analysis.patternScore,
        status:
          analysis.status,
        backtest:
          analysis.backtest,
        models:
          analysis.models,
        generatedAt: now()
      };

      if (analysis.prediction) {
        await savePrediction({
          targetIssue: target,
          prediction:
            analysis.prediction,
          predictedNumber: pNumber,
          confidence:
            analysis.confidence
        });
      }

      state.historyVersion++;
    }

    /*
      Timer:
      use provider countdown if API exposes it.
      Otherwise synchronize from observed round anchor.
    */

    const providerCountdown =
      extractCountdown(data);

    if (
      providerCountdown !== null
    ) {
      state.countdown =
        providerCountdown;

      state.anchorTime =
        now() -
        (ROUND_SECONDS -
          providerCountdown) *
          1000;

      state.anchorIssue =
        providerCurrent ||
        target;
    } else {
      /*
        Anchor to target round.
        This is an estimated timer when the provider
        doesn't expose an exact countdown field.
      */

      if (
        historyChanged ||
        state.anchorIssue !== target
      ) {
        state.anchorIssue = target;
        state.anchorTime = now();
      }

      const elapsed =
        Math.floor(
          (now() -
            state.anchorTime) /
            1000
        );

      state.countdown =
        clamp(
          ROUND_SECONDS -
            (elapsed %
              ROUND_SECONDS),
          0,
          ROUND_SECONDS
        );
    }

    state.lastSettledIssue =
      settledIssue;

    state.lastHistorySignature =
      signature;

  } catch (error) {
    state.lastError =
      error?.message ||
      "Unknown Wingo API error";

    console.error(
      "updateLiveState:",
      state.lastError
    );
  } finally {
    state.updating = false;
  }
}

/* =========================================================
   STATE RESPONSE
   ========================================================= */

async function getStateResponse() {
  const wl =
    await getWinLoss(WINLOSS_LIMIT);

  const latestHistory =
    state.history.slice(
      0,
      LIVE_RESULTS_LIMIT
    );

  return {
    success: true,

    settledIssue:
      state.lastSettledIssue,

    nextIssue:
      state.targetIssue,

    targetIssue:
      state.targetIssue,

    countdown:
      state.countdown,

    prediction:
      state.prediction,

    history:
      latestHistory,

    historyCount:
      state.history.length,

    providerFetched:
      state.providerFetched,

    historyVersion:
      state.historyVersion,

    lastFetchAt:
      state.lastFetchAt,

    error:
      state.lastError || null,

    winLoss: wl
  };
}

/* =========================================================
   ACCESS KEY
   ========================================================= */

async function checkAccessKey(key, deviceId) {
  if (!key) {
    return {
      ok: false,
      error: "Access key required"
    };
  }

  const result = await pool.query(
    `
    SELECT *
    FROM access_keys
    WHERE access_key = $1
    LIMIT 1
    `,
    [String(key).trim()]
  );

  if (!result.rows.length) {
    return {
      ok: false,
      error: "Invalid access key"
    };
  }

  const row = result.rows[0];

  const cleanDevice =
    String(deviceId || "").trim();

  if (
    row.device_id &&
    cleanDevice &&
    row.device_id !== cleanDevice
  ) {
    return {
      ok: false,
      error: "This key is already linked to another device"
    };
  }

  if (!row.device_id && cleanDevice) {
    await pool.query(
      `
      UPDATE access_keys
      SET
        device_id = $2,
        last_seen = $3
      WHERE id = $1
      `,
      [
        row.id,
        cleanDevice,
        now()
      ]
    );
  } else {
    await pool.query(
      `
      UPDATE access_keys
      SET last_seen = $2
      WHERE id = $1
      `,
      [
        row.id,
        now()
      ]
    );
  }

  return {
    ok: true,
    key: row.access_key
  };
}

/* =========================================================
   ADMIN AUTH
   ========================================================= */

function isAdmin(req, body = {}) {
  const header =
    req.headers["x-admin-key"];

  const auth =
    req.headers.authorization || "";

  const bearer =
    auth.startsWith("Bearer ")
      ? auth.slice(7)
      : "";

  const supplied =
    body.adminKey ||
    body.admin_key ||
    header ||
    bearer ||
    "";

  return String(supplied) ===
    String(ADMIN_KEY);
}

/* =========================================================
   ADMIN KEYS
   ========================================================= */

async function adminListKeys() {
  const result = await pool.query(
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

  return result.rows;
}

async function adminCreateKey(body) {
  let key =
    String(
      body.access_key ||
      body.key ||
      ""
    ).trim();

  if (!key) {
    key =
      "DY-" +
      crypto
        .randomBytes(8)
        .toString("hex")
        .toUpperCase();
  }

  await pool.query(
    `
    INSERT INTO access_keys
    (
      access_key,
      created_at,
      last_seen
    )
    VALUES ($1,$2,0)
    `,
    [
      key,
      now()
    ]
  );

  return key;
}

async function adminDeleteKey(id) {
  await pool.query(
    `
    DELETE FROM access_keys
    WHERE id = $1
    `,
    [Number(id)]
  );
}

async function adminResetDevice(id) {
  await pool.query(
    `
    UPDATE access_keys
    SET
      device_id = NULL,
      last_seen = 0
    WHERE id = $1
    `,
    [Number(id)]
  );
}

/* =========================================================
   ADMIN MODEL TEST
   ========================================================= */

function modelTest() {
  const history =
    state.history;

  const analysis =
    adaptiveEnsemble(history);

  return {
    success: true,
    historyAvailable:
      history.length,
    analysis
  };
}

/* =========================================================
   ADMIN WINGO TEST
   ========================================================= */

async function wingoTest() {
  const data =
    await fetchWingo();

  const history =
    normalizeHistory(data);

  return {
    success: true,
    current:
      data?.current || null,
    fetched:
      data?.stats?.fetched ??
      history.length,
    historyLength:
      history.length,
    first:
      history[0] || null
  };
}

/* =========================================================
   ADMIN STATUS
   ========================================================= */

function adminStatus() {
  return {
    success: true,
    uptime:
      process.uptime(),
    memory:
      process.memoryUsage(),
    state: {
      historyLength:
        state.history.length,
      settledIssue:
        state.lastSettledIssue,
      targetIssue:
        state.targetIssue,
      countdown:
        state.countdown,
      historyVersion:
        state.historyVersion,
      providerFetched:
        state.providerFetched,
      lastFetchAt:
        state.lastFetchAt,
      lastError:
        state.lastError
    }
  };
}

/* =========================================================
   STATIC FILE SERVER
   ========================================================= */

function safePath(urlPath) {
  let decoded;

  try {
    decoded =
      decodeURIComponent(urlPath);
  } catch {
    return null;
  }

  decoded =
    decoded.split("?")[0];

  if (
    decoded.includes("..") ||
    decoded.includes("\0")
  ) {
    return null;
  }

  if (decoded === "/") {
    decoded =
      "/prediction.html";
  }

  return decoded;
}

function serveStatic(req, res) {
  const safe =
    safePath(req.url);

  if (!safe) {
    text(res, 400, "Bad request");
    return;
  }

  const filePath =
    path.join(
      __dirname,
      safe
    );

  if (!filePath.startsWith(__dirname)) {
    text(res, 403, "Forbidden");
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      text(res, 404, "Not found");
      return;
    }

    const ext =
      path.extname(filePath)
        .toLowerCase();

    const mime = {
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
        "audio/mpeg"
    }[ext] || "application/octet-stream";

    /*
      MP3 range support
    */

    if (
      ext === ".mp3" &&
      req.headers.range
    ) {
      const range =
        req.headers.range;

      const match =
        range.match(
          /bytes=(\d+)-(\d*)/
        );

      if (!match) {
        text(res, 416, "Invalid range");
        return;
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
        res.writeHead(416, {
          "Content-Range":
            `bytes */${stat.size}`
        });

        res.end();
        return;
      }

      res.writeHead(206, {
        "Content-Type": mime,
        "Content-Range":
          `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
        "Content-Length":
          end - start + 1,
        "Cache-Control":
          "public, max-age=3600"
      });

      fs.createReadStream(
        filePath,
        {
          start,
          end
        }
      ).pipe(res);

      return;
    }

    res.writeHead(200, {
      "Content-Type": mime,
      "Content-Length": stat.size,
      "Cache-Control":
        ext === ".html"
          ? "no-store"
          : "public, max-age=3600"
    });

    fs.createReadStream(filePath)
      .pipe(res);
  });
}

/* =========================================================
   HTTP SERVER
   ========================================================= */

const server =
  http.createServer(
    async (req, res) => {
      try {
        if (req.method === "OPTIONS") {
          res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers":
              "Content-Type, Authorization, X-Admin-Key",
            "Access-Control-Allow-Methods":
              "GET, POST, DELETE, OPTIONS"
          });

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

        /* -----------------------------------------
           HEALTH
           ----------------------------------------- */

        if (
          pathname === "/health" &&
          req.method === "GET"
        ) {
          json(res, 200, {
            ok: true,
            service: "DY AI Wingo 30S",
            uptime: process.uptime()
          });

          return;
        }

        /* -----------------------------------------
           KEY CHECK
           ----------------------------------------- */

        if (
          pathname === "/api/key/check" &&
          req.method === "POST"
        ) {
          const body =
            await readBody(req);

          const result =
            await checkAccessKey(
              body.key ||
                body.access_key,
              body.device_id
            );

          json(res, result.ok ? 200 : 403, result);
          return;
        }

        /* -----------------------------------------
           LIVE STATE
           ----------------------------------------- */

        if (
          pathname === "/api/state" &&
          req.method === "GET"
        ) {
          json(
            res,
            200,
            await getStateResponse()
          );

          return;
        }

        /* -----------------------------------------
           HISTORY / WIN LOSS
           ----------------------------------------- */

        if (
          pathname === "/api/history" &&
          req.method === "GET"
        ) {
          const data =
            await getWinLoss(
              WINLOSS_LIMIT
            );

          json(res, 200, {
            success: true,
            limit:
              WINLOSS_LIMIT,
            ...data
          });

          return;
        }

        /* -----------------------------------------
           ADMIN KEYS GET
           ----------------------------------------- */

        if (
          pathname === "/api/admin/keys" &&
          req.method === "GET"
        ) {
          if (!isAdmin(req)) {
            json(res, 403, {
              success: false,
              error: "Unauthorized"
            });

            return;
          }

          json(res, 200, {
            success: true,
            keys:
              await adminListKeys()
          });

          return;
        }

        /* -----------------------------------------
           ADMIN KEYS POST
           ----------------------------------------- */

        if (
          pathname === "/api/admin/keys" &&
          req.method === "POST"
        ) {
          const body =
            await readBody(req);

          if (!isAdmin(req, body)) {
            json(res, 403, {
              success: false,
              error: "Unauthorized"
            });

            return;
          }

          const key =
            await adminCreateKey(body);

          json(res, 200, {
            success: true,
            key
          });

          return;
        }

        /* -----------------------------------------
           ADMIN KEYS DELETE
           ----------------------------------------- */

        if (
          pathname === "/api/admin/keys" &&
          req.method === "DELETE"
        ) {
          const body =
            await readBody(req);

          if (!isAdmin(req, body)) {
            json(res, 403, {
              success: false,
              error: "Unauthorized"
            });

            return;
          }

          await adminDeleteKey(
            body.id
          );

          json(res, 200, {
            success: true
          });

          return;
        }

        /* -----------------------------------------
           RESET DEVICE
           ----------------------------------------- */

        if (
          pathname ===
            "/api/admin/reset-device" &&
          req.method === "POST"
        ) {
          const body =
            await readBody(req);

          if (!isAdmin(req, body)) {
            json(res, 403, {
              success: false,
              error: "Unauthorized"
            });

            return;
          }

          await adminResetDevice(
            body.id
          );

          json(res, 200, {
            success: true
          });

          return;
        }

        /* -----------------------------------------
           ADMIN STATUS
           ----------------------------------------- */

        if (
          pathname ===
            "/api/admin/status" &&
          req.method === "GET"
        ) {
          if (!isAdmin(req)) {
            json(res, 403, {
              success: false,
              error: "Unauthorized"
            });

            return;
          }

          json(
            res,
            200,
            adminStatus()
          );

          return;
        }

        /* -----------------------------------------
           ADMIN PING
           ----------------------------------------- */

        if (
          pathname ===
            "/api/admin/ping" &&
          req.method === "GET"
        ) {
          if (!isAdmin(req)) {
            json(res, 403, {
              success: false,
              error: "Unauthorized"
            });

            return;
          }

          json(res, 200, {
            success: true,
            message: "DY AI server online",
            time: now()
          });

          return;
        }

        /* -----------------------------------------
           ADMIN WINGO TEST
           ----------------------------------------- */

        if (
          pathname ===
            "/api/admin/wingo-test" &&
          req.method === "GET"
        ) {
          if (!isAdmin(req)) {
            json(res, 403, {
              success: false,
              error: "Unauthorized"
            });

            return;
          }

          try {
            json(
              res,
              200,
              await wingoTest()
            );
          } catch (error) {
            json(res, 500, {
              success: false,
              error:
                error?.message ||
                "Wingo test failed"
            });
          }

          return;
        }

        /* -----------------------------------------
           ADMIN MODEL TEST
           ----------------------------------------- */

        if (
          pathname ===
            "/api/admin/model-test" &&
          req.method === "GET"
        ) {
          if (!isAdmin(req)) {
            json(res, 403, {
              success: false,
              error: "Unauthorized"
            });

            return;
          }

          json(
            res,
            200,
            modelTest()
          );

          return;
        }

        /* -----------------------------------------
           STATIC
           ----------------------------------------- */

        serveStatic(req, res);

      } catch (error) {
        console.error(
          "SERVER ERROR:",
          error
        );

        json(res, 500, {
          success: false,
          error:
            error?.message ||
            "Internal server error"
        });
      }
    }
  );

/* =========================================================
   START
   ========================================================= */

async function start() {
  try {
    await initDb();

    console.log(
      "Database initialized"
    );

    /*
      Initial API load
    */

    await updateLiveState();

    /*
      Poll provider every 1 second.
      Prediction itself is recalculated only
      when settled history changes.
    */

    setInterval(
      () => {
        updateLiveState()
          .catch(err =>
            console.error(
              "Update loop:",
              err?.message
            )
          );
      },
      1000
    );

    /*
      Local countdown smoothing every second.
    */

    setInterval(() => {
      if (
        state.anchorTime &&
        !extractCountdown
      ) {
        return;
      }

      const elapsed =
        Math.floor(
          (now() -
            state.anchorTime) /
            1000
        );

      if (
        state.providerCurrentIssue === ""
      ) {
        state.countdown =
          clamp(
            ROUND_SECONDS -
              (elapsed %
                ROUND_SECONDS),
            0,
            ROUND_SECONDS
          );
      }
    }, 1000);

    server.listen(
      PORT,
      "0.0.0.0",
      () => {
        console.log(
          `DY AI Wingo server running on port ${PORT}`
        );
      }
    );

  } catch (error) {
    console.error(
      "START FAILED:",
      error
    );

    process.exit(1);
  }
}

start();
