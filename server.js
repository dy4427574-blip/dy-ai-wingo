const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 10000);

const ADMIN_KEY =
  process.env.ADMIN_KEY || "dy4427574";

const WINGOBOT_TOKEN =
  process.env.WINGOBOT_TOKEN || "";

const WINGOBOT_URL =
  process.env.WINGOBOT_URL ||
  "https://api.wingobot.com/v2/30-sec-game-history";

const ROUND_SECONDS = 30;
const LIVE_RESULTS_LIMIT = 30;
const WINLOSS_LIMIT = 30;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is missing");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10
});

const state = {
  history: [],
  settledIssue: "",
  targetIssue: "",
  prediction: null,
  historySignature: "",
  historyVersion: 0,
  countdown: 30,
  anchorTime: Date.now(),
  lastFetchAt: 0,
  providerCurrentIssue: "",
  providerFetched: 0,
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

function json(res, status, data) {
  const body = JSON.stringify(data);

  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Admin-Key",
    "Access-Control-Allow-Methods":
      "GET, POST, DELETE, OPTIONS"
  });

  res.end(body);
}

function text(res, status, body, type) {
  res.writeHead(status, {
    "Content-Type":
      type || "text/plain; charset=utf-8"
  });

  res.end(body);
}

function now() {
  return Date.now();
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function issueString(v) {
  return v == null ? "" : String(v).trim();
}

function issueBigInt(v) {
  try {
    return BigInt(issueString(v));
  } catch {
    return 0n;
  }
}

function nextIssue(issue) {
  try {
    return (issueBigInt(issue) + 1n).toString();
  } catch {
    return "";
  }
}

function resultType(number) {
  const n = Number(number);

  if (!Number.isFinite(n)) return "";

  return n >= 5 ? "BIG" : "SMALL";
}

function opposite(type) {
  return type === "BIG" ? "SMALL" : "BIG";
}

function average(arr) {
  if (!arr.length) return 0;

  return arr.reduce(
    (a, b) => a + b,
    0
  ) / arr.length;
}

/* =========================================================
   BODY
========================================================= */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk;

      if (body.length > 1024 * 1024) {
        reject(new Error("Request too large"));
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

  const timeout = setTimeout(() => {
    controller.abort();
  }, 12000);

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

    const raw = await response.text();

    let data;

    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(
        `Wingo API invalid JSON: HTTP ${response.status}`
      );
    }

    if (!response.ok) {
      throw new Error(
        data?.error ||
        data?.message ||
        `Wingo API HTTP ${response.status}`
      );
    }

    if (data?.success === false) {
      throw new Error(
        data.error ||
        data.message ||
        "Wingo API failed"
      );
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

/* =========================================================
   NORMALIZE HISTORY
========================================================= */

function normalizeHistory(data) {
  let rows = [];

  if (Array.isArray(data?.history)) {
    rows = data.history;
  } else if (
    Array.isArray(data?.data?.history)
  ) {
    rows = data.data.history;
  } else if (Array.isArray(data?.data)) {
    rows = data.data;
  }

  const result = [];

  for (const row of rows) {
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

    if (
      issue == null ||
      number == null
    ) {
      continue;
    }

    const n = Number(number);

    if (!Number.isFinite(n)) {
      continue;
    }

    result.push({
      issueNumber: issueString(issue),
      number: n,
      colour:
        row?.colour ??
        row?.color ??
        "",
      premium:
        row?.premium ?? null,
      sum:
        row?.sum ?? null
    });
  }

  const unique = new Map();

  for (const row of result) {
    if (!unique.has(row.issueNumber)) {
      unique.set(
        row.issueNumber,
        row
      );
    }
  }

  const finalRows =
    [...unique.values()];

  finalRows.sort((a, b) => {
    const aa =
      issueBigInt(a.issueNumber);

    const bb =
      issueBigInt(b.issueNumber);

    if (aa > bb) return -1;
    if (aa < bb) return 1;

    return 0;
  });

  return finalRows;
}

/* =========================================================
   COUNTDOWN
========================================================= */

function extractCountdown(data) {
  const values = [
    data?.countdownSeconds,
    data?.countdown,
    data?.current?.countdownSeconds,
    data?.current?.countdown,
    data?.data?.countdownSeconds,
    data?.data?.countdown
  ];

  for (const value of values) {
    const n = Number(value);

    if (
      Number.isFinite(n) &&
      n >= 0 &&
      n <= ROUND_SECONDS
    ) {
      return Math.floor(n);
    }
  }

  return null;
}

/* =========================================================
   SEQUENCES
========================================================= */

function getSequence(history, limit) {
  const rows =
    history.slice(
      0,
      limit || history.length
    );

  return rows
    .map(x => resultType(x.number))
    .filter(Boolean)
    .reverse();
}

function counts(sequence) {
  let big = 0;
  let small = 0;

  for (const x of sequence) {
    if (x === "BIG") big++;
    else if (x === "SMALL") small++;
  }

  return { big, small };
}

/* =========================================================
   MODEL 1 - RECENCY
========================================================= */

function recencyModel(history) {
  const seq =
    getSequence(
      history,
      Math.min(history.length, 40)
    );

  if (seq.length < 5) return null;

  let big = 0;
  let small = 0;

  for (let i = 0; i < seq.length; i++) {
    const weight = i + 1;

    if (seq[i] === "BIG") {
      big += weight;
    } else {
      small += weight;
    }
  }

  const total = big + small;

  if (!total) return null;

  const pBig = big / total;
  const pSmall = small / total;

  return {
    name: "Recency",
    prediction:
      pBig >= pSmall
        ? "BIG"
        : "SMALL",
    confidence:
      clamp(
        50 +
        Math.abs(pBig - pSmall) * 100,
        50,
        72
      )
  };
}

/* =========================================================
   MODEL 2 - SHORT WINDOW
========================================================= */

function shortModel(history) {
  const seq =
    getSequence(
      history,
      Math.min(history.length, 12)
    );

  if (seq.length < 5) return null;

  const c = counts(seq);

  let prediction =
    c.big >= c.small
      ? "BIG"
      : "SMALL";

  const last =
    seq[seq.length - 1];

  let streak = 1;

  for (
    let i = seq.length - 2;
    i >= 0;
    i--
  ) {
    if (seq[i] === last) {
      streak++;
    } else {
      break;
    }
  }

  if (streak >= 4) {
    prediction = last;
  }

  return {
    name: "Short Window",
    prediction,
    confidence:
      clamp(
        50 +
        Math.abs(c.big - c.small) *
          5 +
        Math.min(streak, 5) * 2,
        50,
        78
      )
  };
}

/* =========================================================
   MODEL 3 - TRANSITION
========================================================= */

function transitionModel(history) {
  const seq =
    getSequence(
      history,
      Math.min(history.length, 300)
    );

  if (seq.length < 20) return null;

  const t = {
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
    const previous =
      seq[i - 1];

    const current =
      seq[i];

    t[previous][current]++;
  }

  const last =
    seq[seq.length - 1];

  const row =
    t[last];

  const total =
    row.BIG + row.SMALL;

  if (!total) return null;

  const pBig =
    row.BIG / total;

  const pSmall =
    row.SMALL / total;

  return {
    name: "Transition",
    prediction:
      pBig >= pSmall
        ? "BIG"
        : "SMALL",
    confidence:
      clamp(
        50 +
        Math.abs(pBig - pSmall) * 100,
        50,
        80
      )
  };
}

/* =========================================================
   MODEL 4 - STREAK
========================================================= */

function streakModel(history) {
  const seq =
    getSequence(
      history,
      Math.min(history.length, 80)
    );

  if (seq.length < 5) return null;

  const last =
    seq[seq.length - 1];

  let streak = 1;

  for (
    let i = seq.length - 2;
    i >= 0;
    i--
  ) {
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
    confidence:
      clamp(
        55 + streak * 4,
        55,
        75
      )
  };
}

/* =========================================================
   MODEL 5 - ALTERNATION
========================================================= */

function alternationModel(history) {
  const seq =
    getSequence(
      history,
      Math.min(history.length, 20)
    );

  if (seq.length < 6) return null;

  let alternating = 0;

  for (let i = 1; i < seq.length; i++) {
    if (
      seq[i] !==
      seq[i - 1]
    ) {
      alternating++;
    }
  }

  const ratio =
    alternating /
    (seq.length - 1);

  if (ratio < 0.72) {
    return null;
  }

  return {
    name: "Alternation",
    prediction:
      opposite(
        seq[seq.length - 1]
      ),
    confidence:
      clamp(
        55 + ratio * 20,
        55,
        72
      )
  };
}

/* =========================================================
   MODEL 6 - FULL HISTORY
========================================================= */

function fullHistoryModel(history) {
  const seq =
    getSequence(
      history,
      history.length
    );

  if (seq.length < 30) return null;

  const c = counts(seq);

  const total =
    c.big + c.small;

  const pBig =
    c.big / total;

  const pSmall =
    c.small / total;

  return {
    name: "Full History",
    prediction:
      pBig >= pSmall
        ? "BIG"
        : "SMALL",
    confidence:
      clamp(
        50 +
        Math.abs(pBig - pSmall) * 70,
        50,
        65
      )
  };
}

/* =========================================================
   MODEL 7 - NUMBER STRUCTURE
========================================================= */

function numberModel(history) {
  const rows =
    history.slice(
      0,
      Math.min(
        history.length,
        100
      )
    );

  if (rows.length < 15) {
    return null;
  }

  let big = 0;
  let small = 0;

  for (const row of rows) {
    if (Number(row.number) >= 5) {
      big++;
    } else {
      small++;
    }
  }

  const total =
    big + small;

  const pBig =
    big / total;

  const pSmall =
    small / total;

  return {
    name: "Number Structure",
    prediction:
      pBig >= pSmall
        ? "BIG"
        : "SMALL",
    confidence:
      clamp(
        50 +
        Math.abs(pBig - pSmall) * 60,
        50,
        63
      )
  };
}

/* =========================================================
   MODEL 8 - PATTERN MATCH
========================================================= */

function patternModel(history) {
  const seq =
    getSequence(
      history,
      history.length
    );

  if (seq.length < 30) {
    return null;
  }

  const patternLength =
    Math.min(
      5,
      Math.floor(seq.length / 5)
    );

  const current =
    seq.slice(
      seq.length -
      patternLength
    );

  let big = 0;
  let small = 0;
  let matches = 0;

  /*
    Find older occurrences of the
    same recent sequence.
  */

  for (
    let i = 0;
    i <=
      seq.length -
      patternLength -
      1;
    i++
  ) {

    let same = true;

    for (
      let j = 0;
      j < patternLength;
      j++
    ) {

      if (
        seq[i + j] !==
        current[j]
      ) {
        same = false;
        break;
      }

    }

    if (!same) continue;

    const next =
      seq[i + patternLength];

    if (next === "BIG") {
      big++;
    }

    if (next === "SMALL") {
      small++;
    }

    matches++;
  }

  if (matches < 3) {
    return null;
  }

  const total =
    big + small;

  if (!total) return null;

  const pBig =
    big / total;

  const pSmall =
    small / total;

  return {
    name: "Pattern Match",
    prediction:
      pBig >= pSmall
        ? "BIG"
        : "SMALL",
    confidence:
      clamp(
        50 +
        Math.abs(pBig - pSmall) *
          100 +
        Math.min(matches, 10),
        50,
        78
      )
  };
}

/* =========================================================
   GENERATE MODELS
========================================================= */

function generateModels(history) {
  return [
    recencyModel(history),
    shortModel(history),
    transitionModel(history),
    streakModel(history),
    alternationModel(history),
    fullHistoryModel(history),
    numberModel(history),
    patternModel(history)
  ].filter(Boolean);
}

/* =========================================================
   RAW ENSEMBLE
========================================================= */

function rawEnsemble(history) {
  const models =
    generateModels(history);

  if (!models.length) {
    return {
      prediction: null,
      confidence: 0,
      agreement: 0,
      models
    };
  }

  const weights = {
    "Pattern Match": 1.35,
    "Transition": 1.25,
    "Short Window": 1.20,
    "Recency": 1.05,
    "Streak": 0.90,
    "Alternation": 0.85,
    "Number Structure": 0.55,
    "Full History": 0.65
  };

  let bigScore = 0;
  let smallScore = 0;

  for (const model of models) {

    const weight =
      weights[model.name] ||
      0.75;

    const confidence =
      clamp(
        model.confidence,
        50,
        85
      ) / 100;

    const score =
      weight * confidence;

    if (
      model.prediction ===
      "BIG"
    ) {
      bigScore += score;
    }
    else if (
      model.prediction ===
      "SMALL"
    ) {
      smallScore += score;
    }
  }

  const total =
    bigScore +
    smallScore;

  if (!total) {
    return {
      prediction: null,
      confidence: 0,
      agreement: 0,
      models
    };
  }

  const prediction =
    bigScore >= smallScore
      ? "BIG"
      : "SMALL";

  const dominant =
    Math.max(
      bigScore,
      smallScore
    );

  let confidence =
    50 +
    (
      dominant / total -
      0.5
    ) *
    100;

  const agreeCount =
    models.filter(
      x =>
        x.prediction ===
        prediction
    ).length;

  const agreement =
    agreeCount /
    models.length *
    100;

  return {
    prediction,
    confidence:
      clamp(
        confidence,
        50,
        82
      ),
    agreement,
    models
  };
}

/* =========================================================
   BACKTEST
========================================================= */

function backtest(history) {

  /*
    API se jo bhi history aayi hai
    usi ko training ke liye use karte hain.

    Testing ke liye latest maximum 150
    historical points liye jaate hain,
    taaki server unnecessarily heavy na ho.
  */

  const chronological =
    [...history].reverse();

  if (
    chronological.length < 40
  ) {
    return {
      samples: 0,
      wins: 0,
      losses: 0,
      accuracy: null
    };
  }

  const minimumTrain = 30;

  const available =
    chronological.length -
    minimumTrain;

  const sampleCount =
    Math.min(
      150,
      available
    );

  const start =
    chronological.length -
    sampleCount;

  let wins = 0;
  let losses = 0;
  let samples = 0;

  for (
    let i = start;
    i < chronological.length;
    i++
  ) {

    const train =
      chronological.slice(
        0,
        i
      );

    const actual =
      resultType(
        chronological[i].number
      );

    const signal =
      rawEnsemble(train);

    if (!signal.prediction) {
      continue;
    }

    samples++;

    if (
      signal.prediction ===
      actual
    ) {
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
        ? wins / samples * 100
        : null
  };
}

/* =========================================================
   FINAL AI ENGINE
========================================================= */

function adaptiveEnsemble(history) {

  const raw =
    rawEnsemble(history);

  if (!raw.prediction) {
    return {
      prediction: null,
      confidence: 0,
      agreement: 0,
      patternScore: 0,
      status:
        "INSUFFICIENT DATA",
      backtest: {
        samples: 0,
        wins: 0,
        losses: 0,
        accuracy: null
      },
      models: []
    };
  }

  const bt =
    backtest(history);

  let confidence =
    raw.confidence;

  /*
    Calibration:
    insufficient backtest =
    lower displayed confidence.
  */

  if (bt.samples < 20) {

    confidence =
      Math.min(
        confidence,
        60
      );

  }
  else if (bt.samples < 50) {

    confidence =
      Math.min(
        confidence,
        66
      );

  }
  else if (
    bt.accuracy != null &&
    bt.accuracy < 50
  ) {

    confidence =
      Math.min(
        confidence,
        57
      );

  }
  else if (
    bt.accuracy != null &&
    bt.accuracy < 55
  ) {

    confidence =
      Math.min(
        confidence,
        62
      );

  }
  else if (
    bt.accuracy != null &&
    bt.accuracy >= 60
  ) {

    confidence += 4;

  }

  if (
    raw.agreement < 50
  ) {
    confidence -= 4;
  }

  if (
    raw.agreement >= 75
  ) {
    confidence += 3;
  }

  confidence =
    Math.round(
      clamp(
        confidence,
        50,
        76
      )
    );

  let status =
    "WEAK SIGNAL";

  if (
    bt.samples < 20
  ) {
    status =
      "EARLY SIGNAL";
  }
  else if (
    confidence >= 70 &&
    bt.accuracy != null &&
    bt.accuracy >= 55
  ) {
    status =
      "STRONGER MODEL LEAN";
  }
  else if (
    confidence >= 63
  ) {
    status =
      "MODERATE SIGNAL";
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
    prediction:
      raw.prediction,

    confidence,

    agreement:
      Math.round(
        raw.agreement
      ),

    patternScore,

    status,

    backtest: bt,

    models:
      raw.models.map(
        model => ({
          name:
            model.name,
          prediction:
            model.prediction,
          confidence:
            Math.round(
              model.confidence
            )
        })
      )
  };
}

/* =========================================================
   PREDICTED NUMBER
========================================================= */

function predictedNumber(
  history,
  prediction
) {

  if (!prediction) {
    return null;
  }

  const candidates =
    prediction === "BIG"
      ? [5,6,7,8,9]
      : [0,1,2,3,4];

  const frequency =
    new Map();

  for (
    const row of history.slice(
      0,
      Math.min(
        history.length,
        100
      )
    )
  ) {

    const n =
      Number(row.number);

    frequency.set(
      n,
      (frequency.get(n) || 0) + 1
    );

  }

  candidates.sort(
    (a,b) =>
      (frequency.get(a) || 0) -
      (frequency.get(b) || 0)
  );

  return candidates[0];
}

/* =========================================================
   SAVE PREDICTION
========================================================= */

async function savePrediction(pred) {

  if (
    !pred ||
    !pred.targetIssue ||
    !pred.prediction
  ) {
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
    VALUES
    ($1,$2,$3,$4,'PENDING',$5)

    ON CONFLICT (target_issue)
    DO UPDATE SET
      prediction =
        EXCLUDED.prediction,
      predicted_number =
        EXCLUDED.predicted_number,
      confidence =
        EXCLUDED.confidence
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
   SETTLE
========================================================= */

async function settlePrediction(
  issue,
  actualNumber
) {

  const actual =
    resultType(actualNumber);

  if (!issue || !actual) {
    return;
  }

  await pool.query(
    `
    UPDATE predictions

    SET
      actual_number = $2,
      actual_result = $3,

      status =
        CASE
          WHEN prediction = $3
          THEN 'WIN'
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
   WIN LOSS
========================================================= */

async function getWinLoss() {

  const result =
    await pool.query(
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

      WHERE status IN
        ('WIN','LOSS')

      ORDER BY id DESC

      LIMIT $1
      `,
      [WINLOSS_LIMIT]
    );

  const rows =
    result.rows;

  let wins = 0;
  let losses = 0;

  for (const row of rows) {

    if (row.status === "WIN") {
      wins++;
    }

    if (row.status === "LOSS") {
      losses++;
    }

  }

  const total =
    wins + losses;

  return {
    rows,
    wins,
    losses,
    total,
    rate:
      total
        ? Math.round(
            wins /
            total *
            100
          )
        : 0
  };
}

/* =========================================================
   LIVE UPDATE
========================================================= */

async function updateLiveState() {

  if (state.updating) {
    return;
  }

  state.updating = true;

  try {

    const data =
      await fetchWingo();

    const history =
      normalizeHistory(data);

    if (!history.length) {
      throw new Error(
        "Wingo history is empty"
      );
    }

    const settled =
      history[0];

    const settledIssue =
      settled.issueNumber;

    const providerCurrent =
      issueString(
        data?.current?.issueNumber ??
        data?.current?.periodId ??
        ""
      );

    const fetched =
      Number(
        data?.stats?.fetched ??
        history.length
      );

    const signature =
      history
        .slice(0,20)
        .map(
          x =>
            `${x.issueNumber}:${x.number}`
        )
        .join("|");

    const historyChanged =
      signature !==
      state.historySignature;

    /*
      If a new settled result arrived,
      settle the prediction for that
      exact issue.
    */

    if (
      historyChanged &&
      state.targetIssue
    ) {

      const exact =
        history.find(
          x =>
            x.issueNumber ===
            state.targetIssue
        );

      if (exact) {

        await settlePrediction(
          exact.issueNumber,
          exact.number
        );

      }

    }

    state.history =
      history;

    state.settledIssue =
      settledIssue;

    state.providerCurrentIssue =
      providerCurrent;

    state.providerFetched =
      fetched;

    state.lastFetchAt =
      now();

    state.lastError =
      "";

    /*
      Target issue.
    */

    let target =
      nextIssue(
        settledIssue
      );

    if (providerCurrent) {

      try {

        if (
          issueBigInt(
            providerCurrent
          ) >
          issueBigInt(
            settledIssue
          )
        ) {

          target =
            providerCurrent;

        }

      } catch {}

    }

    /*
      Prediction changes ONLY
      when actual history changes
      or target is missing/changed.
    */

    const recalculate =
      historyChanged ||
      target !== state.targetIssue ||
      !state.prediction;

    if (recalculate) {

      const analysis =
        adaptiveEnsemble(
          history
        );

      const number =
        predictedNumber(
          history,
          analysis.prediction
        );

      state.targetIssue =
        target;

      state.prediction = {
        targetIssue:
          target,

        prediction:
          analysis.prediction,

        predictedNumber:
          number,

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

        generatedAt:
          now()
      };

      if (
        analysis.prediction
      ) {

        await savePrediction({
          targetIssue:
            target,

          prediction:
            analysis.prediction,

          predictedNumber:
            number,

          confidence:
            analysis.confidence
        });

      }

      state.historyVersion++;
    }

    /*
      Provider countdown if available.
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
        (
          ROUND_SECONDS -
          providerCountdown
        ) *
        1000;

    }
    else {

      /*
        Fallback timer is estimated
        from the latest API update.
      */

      if (
        historyChanged ||
        !state.anchorTime
      ) {

        state.anchorTime =
          now();

      }

      const elapsed =
        Math.floor(
          (
            now() -
            state.anchorTime
          ) / 1000
        );

      state.countdown =
        ROUND_SECONDS -
        (
          elapsed %
          ROUND_SECONDS
        );

    }

    state.historySignature =
      signature;

  }
  catch(error) {

    state.lastError =
      error?.message ||
      "Wingo API error";

    console.error(
      "WINGO UPDATE ERROR:",
      state.lastError
    );

  }
  finally {

    state.updating =
      false;

  }
}

/* =========================================================
   STATE
========================================================= */

async function getState() {

  const winLoss =
    await getWinLoss();

  return {
    success: true,

    settledIssue:
      state.settledIssue,

    nextIssue:
      state.targetIssue,

    targetIssue:
      state.targetIssue,

    countdown:
      state.countdown,

    prediction:
      state.prediction,

    /*
      UI only receives latest 30.
      AI above uses the complete
      API history stored in state.
    */

    history:
      state.history.slice(
        0,
        LIVE_RESULTS_LIMIT
      ),

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

    winLoss
  };
}

/* =========================================================
   ACCESS KEY
========================================================= */

async function checkKey(
  key,
  deviceId
) {

  key =
    String(key || "").trim();

  deviceId =
    String(deviceId || "").trim();

  if (!key) {

    return {
      ok:false,
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
      [key]
    );

  if (!result.rows.length) {

    return {
      ok:false,
      error:
        "Invalid access key"
    };

  }

  const row =
    result.rows[0];

  if (
    row.device_id &&
    deviceId &&
    row.device_id !==
      deviceId
  ) {

    return {
      ok:false,
      error:
        "This key is already linked to another device"
    };

  }

  if (!row.device_id) {

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
        deviceId,
        now()
      ]
    );

  }
  else {

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
    ok:true,
    key:row.access_key
  };
}

/* =========================================================
   ADMIN AUTH
========================================================= */

function isAdmin(
  req,
  body
) {

  body =
    body || {};

  const header =
    req.headers[
      "x-admin-key"
    ];

  const auth =
    req.headers.authorization ||
    "";

  const bearer =
    auth.startsWith(
      "Bearer "
    )
      ? auth.slice(7)
      : "";

  const supplied =
    body.adminKey ||
    body.admin_key ||
    header ||
    bearer ||
    "";

  return String(
    supplied
  ) === String(
    ADMIN_KEY
  );
}

/* =========================================================
   ADMIN
========================================================= */

async function listKeys() {

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

  return result.rows;
}

async function createKey(
  body
) {

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

    VALUES
    ($1,$2,0)
    `,
    [
      key,
      now()
    ]
  );

  return key;
}

/* =========================================================
   STATIC FILE SERVER
========================================================= */

function serveStatic(
  req,
  res
) {

  let requestPath;

  try {

    requestPath =
      decodeURIComponent(
        req.url.split("?")[0]
      );

  }
  catch {

    text(
      res,
      400,
      "Bad request"
    );

    return;
  }

  if (
    requestPath === "/"
  ) {

    requestPath =
      "/prediction.html";

  }

  if (
    requestPath.includes("..") ||
    requestPath.includes("\0")
  ) {

    text(
      res,
      403,
      "Forbidden"
    );

    return;
  }

  const filePath =
    path.join(
      __dirname,
      requestPath
    );

  fs.stat(
    filePath,
    (error, stats) => {

      if (
        error ||
        !stats.isFile()
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

      const types = {
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
      };

      const type =
        types[ext] ||
        "application/octet-stream";

      /*
        MP3 range support
      */

      if (
        ext === ".mp3" &&
        req.headers.range
      ) {

        const match =
          req.headers.range.match(
            /bytes=(\d+)-(\d*)/
          );

        if (!match) {

          text(
            res,
            416,
            "Invalid range"
          );

          return;
        }

        const start =
          Number(match[1]);

        const end =
          match[2]
            ? Number(match[2])
            : stats.size - 1;

        if (
          start >= stats.size ||
          end >= stats.size ||
          start > end
        ) {

          res.writeHead(
            416,
            {
              "Content-Range":
                `bytes */${stats.size}`
            }
          );

          res.end();

          return;
        }

        res.writeHead(
          206,
          {
            "Content-Type":
              type,

            "Content-Range":
              `bytes ${start}-${end}/${stats.size}`,

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

          "Content-Length":
            stats.size,

          "Cache-Control":
            ext === ".html"
              ? "no-store"
              : "public, max-age=3600"
        }
      );

      fs.createReadStream(
        filePath
      ).pipe(res);

    }
  );
}

/* =========================================================
   SERVER
========================================================= */

const server =
  http.createServer(
    async (req, res) => {

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
                "Content-Type, Authorization, X-Admin-Key",

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
            `http://${req.headers.host || "localhost"}`
          );

        const pathname =
          url.pathname;

        /* HEALTH */

        if (
          pathname ===
            "/health" &&
          req.method ===
            "GET"
        ) {

          json(
            res,
            200,
            {
              ok:true,
              service:
                "DY AI Wingo 30S",
              uptime:
                process.uptime()
            }
          );

          return;
        }

        /* KEY CHECK */

        if (
          pathname ===
            "/api/key/check" &&
          req.method ===
            "POST"
        ) {

          const body =
            await readBody(req);

          const result =
            await checkKey(
              body.key ||
              body.access_key,
              body.device_id
            );

          json(
            res,
            result.ok
              ? 200
              : 403,
            result
          );

          return;
        }

        /* STATE */

        if (
          pathname ===
            "/api/state" &&
          req.method ===
            "GET"
        ) {

          json(
            res,
            200,
            await getState()
          );

          return;
        }

        /* HISTORY */

        if (
          pathname ===
            "/api/history" &&
          req.method ===
            "GET"
        ) {

          json(
            res,
            200,
            {
              success:true,
              limit:
                WINLOSS_LIMIT,
              ...(await getWinLoss())
            }
          );

          return;
        }

        /* ADMIN KEYS GET */

        if (
          pathname ===
            "/api/admin/keys" &&
          req.method ===
            "GET"
        ) {

          if (!isAdmin(req)) {

            json(
              res,
              403,
              {
                success:false,
                error:"Unauthorized"
              }
            );

            return;
          }

          json(
            res,
            200,
            {
              success:true,
              keys:
                await listKeys()
            }
          );

          return;
        }

        /* ADMIN KEYS CREATE */

        if (
          pathname ===
            "/api/admin/keys" &&
          req.method ===
            "POST"
        ) {

          const body =
            await readBody(req);

          if (
            !isAdmin(
              req,
              body
            )
          ) {

            json(
              res,
              403,
              {
                success:false,
                error:"Unauthorized"
              }
            );

            return;
          }

          const key =
            await createKey(
              body
            );

          json(
            res,
            200,
            {
              success:true,
              key
            }
          );

          return;
        }

        /* ADMIN KEY DELETE */

        if (
          pathname ===
            "/api/admin/keys" &&
          req.method ===
            "DELETE"
        ) {

          const body =
            await readBody(req);

          if (
            !isAdmin(
              req,
              body
            )
          ) {

            json(
              res,
              403,
              {
                success:false,
                error:"Unauthorized"
              }
            );

            return;
          }

          await pool.query(
            `
            DELETE FROM access_keys
            WHERE id = $1
            `,
            [
              Number(body.id)
            ]
          );

          json(
            res,
            200,
            {
              success:true
            }
          );

          return;
        }

        /* RESET DEVICE */

        if (
          pathname ===
            "/api/admin/reset-device" &&
          req.method ===
            "POST"
        ) {

          const body =
            await readBody(req);

          if (
            !isAdmin(
              req,
              body
            )
          ) {

            json(
              res,
              403,
              {
                success:false,
                error:"Unauthorized"
              }
            );

            return;
          }

          await pool.query(
            `
            UPDATE access_keys

            SET
              device_id = NULL,
              last_seen = 0

            WHERE id = $1
            `,
            [
              Number(body.id)
            ]
          );

          json(
            res,
            200,
            {
              success:true
            }
          );

          return;
        }

        /* ADMIN STATUS */

        if (
          pathname ===
            "/api/admin/status" &&
          req.method ===
            "GET"
        ) {

          if (!isAdmin(req)) {

            json(
              res,
              403,
              {
                success:false,
                error:"Unauthorized"
              }
            );

            return;
          }

          json(
            res,
            200,
            {
              success:true,
              uptime:
                process.uptime(),
              historyLength:
                state.history.length,
              settledIssue:
                state.settledIssue,
              targetIssue:
                state.targetIssue,
              historyVersion:
                state.historyVersion,
              providerFetched:
                state.providerFetched,
              lastFetchAt:
                state.lastFetchAt,
              error:
                state.lastError || null
            }
          );

          return;
        }

        /* ADMIN PING */

        if (
          pathname ===
            "/api/admin/ping" &&
          req.method ===
            "GET"
        ) {

          if (!isAdmin(req)) {

            json(
              res,
              403,
              {
                success:false,
                error:"Unauthorized"
              }
            );

            return;
          }

          json(
            res,
            200,
            {
              success:true,
              message:
                "DY AI server online",
              time:
                now()
            }
          );

          return;
        }

        /* ADMIN WINGO TEST */

        if (
          pathname ===
            "/api/admin/wingo-test" &&
          req.method ===
            "GET"
        ) {

          if (!isAdmin(req)) {

            json(
              res,
              403,
              {
                success:false,
                error:"Unauthorized"
              }
            );

            return;
          }

          try {

            const data =
              await fetchWingo();

            const history =
              normalizeHistory(
                data
              );

            json(
              res,
              200,
              {
                success:true,
                current:
                  data?.current ||
                  null,
                fetched:
                  data?.stats?.fetched ??
                  history.length,
                historyLength:
                  history.length,
                latest:
                  history[0] ||
                  null
              }
            );

          }
          catch(error) {

            json(
              res,
              500,
              {
                success:false,
                error:
                  error.message
              }
            );

          }

          return;
        }

        /* ADMIN MODEL TEST */

        if (
          pathname ===
            "/api/admin/model-test" &&
          req.method ===
            "GET"
        ) {

          if (!isAdmin(req)) {

            json(
              res,
              403,
              {
                success:false,
                error:"Unauthorized"
              }
            );

            return;
          }

          const analysis =
            adaptiveEnsemble(
              state.history
            );

          json(
            res,
            200,
            {
              success:true,
              history:
                state.history.length,
              analysis
            }
          );

          return;
        }

        /* STATIC */

        serveStatic(
          req,
          res
        );

      }
      catch(error) {

        console.error(
          "SERVER ERROR:",
          error
        );

        json(
          res,
          500,
          {
            success:false,
            error:
              error.message ||
              "Internal server error"
          }
        );

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
      First API fetch
    */

    await updateLiveState();

    /*
      API polling every second.
      Prediction is NOT recalculated
      every second.
    */

    setInterval(
      () => {

        updateLiveState()
          .catch(error => {

            console.error(
              "UPDATE LOOP:",
              error.message
            );

          });

      },
      1000
    );

    server.listen(
      PORT,
      "0.0.0.0",
      () => {

        console.log(
          `DY AI Wingo server running on port ${PORT}`
        );

      }
    );

  }
  catch(error) {

    console.error(
      "START FAILED:",
      error
    );

    process.exit(1);

  }

}

start();
