"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 10000);
const ADMIN_KEY = String(process.env.ADMIN_KEY || "dy4427574").trim();

const WINGOBOT_URL =
  "https://api.wingobot.com/v2/30-sec-game-history";

const WINGOBOT_TOKEN =
  String(process.env.WINGOBOT_TOKEN || "").trim();

const ROUND_SECONDS = 30;
const LIVE_RESULTS_LIMIT = 30;
const WINLOSS_LIMIT = 30;

const ROOT = __dirname;

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes("localhost")
        ? false
        : { rejectUnauthorized: false }
    })
  : null;

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
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    Pragma: "no-cache",
    Expires: "0",
    "Access-Control-Allow-Origin": "*"
  });

  res.end(body);
}

function sendText(res, status, text, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store"
  });

  res.end(text);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk;

      if (body.length > 2 * 1024 * 1024) {
        reject(new Error("Request body too large"));
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

function requireAdmin(req, res) {
  const key = String(
    req.headers["x-admin-key"] ||
    req.headers["authorization"]?.replace(/^Bearer\s+/i, "") ||
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
    req.headers["authorization"]?.replace(/^Bearer\s+/i, "") ||
    ""
  ).trim();
}

function getDeviceId(req) {
  return String(req.headers["x-device-id"] || "").trim();
}

function normalizeNumber(v) {
  if (v === null || v === undefined || v === "") {
    return null;
  }

  const n = Number(v);

  if (!Number.isFinite(n)) {
    return null;
  }

  return Math.trunc(n);
}

function normalizeIssue(v) {
  if (v === null || v === undefined) {
    return null;
  }

  const s = String(v).trim();

  return s || null;
}

function normalizeColour(v) {
  if (v === null || v === undefined) {
    return null;
  }

  const s = String(v).trim().toUpperCase();

  return s || null;
}

function classifyNumber(n) {
  if (!Number.isFinite(Number(n))) {
    return null;
  }

  return Number(n) >= 5 ? "BIG" : "SMALL";
}

function parseMaybeJson(value) {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/* =========================================================
   WINGOBOT
========================================================= */

function extractHistory(payload) {
  if (!payload) return [];

  let candidates = [];

  if (Array.isArray(payload)) {
    candidates.push(payload);
  }

  if (Array.isArray(payload.history)) {
    candidates.push(payload.history);
  }

  if (Array.isArray(payload.data)) {
    candidates.push(payload.data);
  }

  if (payload.data && Array.isArray(payload.data.history)) {
    candidates.push(payload.data.history);
  }

  if (
    payload.result &&
    Array.isArray(payload.result.history)
  ) {
    candidates.push(payload.result.history);
  }

  if (
    payload.data &&
    payload.data.result &&
    Array.isArray(payload.data.result.history)
  ) {
    candidates.push(payload.data.result.history);
  }

  for (const list of candidates) {
    const normalized = list
      .map(row => {
        if (!row || typeof row !== "object") {
          return null;
        }

        const issue = normalizeIssue(
          row.issueNumber ??
          row.issue_number ??
          row.period ??
          row.issue ??
          row.round
        );

        const number = normalizeNumber(
          row.number ??
          row.num ??
          row.result ??
          row.openNumber
        );

        if (!issue || number === null) {
          return null;
        }

        return {
          issueNumber: issue,
          number,
          colour: normalizeColour(
            row.colour ??
            row.color
          ),
          premium: row.premium ?? null,
          sum: row.sum ?? null
        };
      })
      .filter(Boolean);

    if (normalized.length) {
      return normalized;
    }
  }

  return [];
}

function extractCurrentIssue(payload) {
  const candidates = [
    payload?.current?.issueNumber,
    payload?.current?.issue_number,
    payload?.currentIssueNumber,
    payload?.issueNumber,
    payload?.issue_number,
    payload?.data?.current?.issueNumber,
    payload?.data?.current?.issue_number,
    payload?.result?.current?.issueNumber
  ];

  for (const value of candidates) {
    const issue = normalizeIssue(value);

    if (issue) return issue;
  }

  return null;
}

function extractCountdown(payload) {
  const candidates = [
    payload?.current?.countdown,
    payload?.current?.remainingSeconds,
    payload?.current?.remaining_seconds,
    payload?.countdown,
    payload?.remainingSeconds,
    payload?.remaining_seconds,
    payload?.data?.current?.countdown,
    payload?.data?.current?.remainingSeconds
  ];

  for (const value of candidates) {
    const n = Number(value);

    if (Number.isFinite(n) && n >= 0 && n <= 120) {
      return Math.floor(n);
    }
  }

  return null;
}

async function fetchWingo() {
  if (!WINGOBOT_TOKEN) {
    throw new Error("WINGOBOT_TOKEN is not configured");
  }

  const response = await fetch(WINGOBOT_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${WINGOBOT_TOKEN}`,
      Accept: "application/json"
    }
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `WingoBot HTTP ${response.status}: ${text.slice(0, 300)}`
    );
  }

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("WingoBot returned invalid JSON");
  }

  const history = extractHistory(data);

  if (!history.length) {
    throw new Error("WingoBot returned no valid history");
  }

  const currentIssue = extractCurrentIssue(data);
  const providerCountdown = extractCountdown(data);

  return {
    history,
    currentIssue,
    providerCountdown,
    raw: data
  };
}

/* =========================================================
   ISSUE / PERIOD HELPERS
========================================================= */

function issueToBigInt(issue) {
  try {
    return BigInt(String(issue));
  } catch {
    return null;
  }
}

function incrementIssue(issue) {
  const n = issueToBigInt(issue);

  if (n === null) {
    return null;
  }

  return String(n + 1n);
}

function issueDistance(a, b) {
  const x = issueToBigInt(a);
  const y = issueToBigInt(b);

  if (x === null || y === null) {
    return null;
  }

  const d = y - x;

  try {
    return Number(d);
  } catch {
    return null;
  }
}

function latestSettled(history) {
  if (!Array.isArray(history) || !history.length) {
    return null;
  }

  return history[0];
}

function makeHistorySignature(history) {
  return history
    .slice(0, 30)
    .map(x => `${x.issueNumber}:${x.number}`)
    .join("|");
}

/* =========================================================
   MODEL
========================================================= */

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function mean(values) {
  if (!values.length) return 0;

  return values.reduce((a, b) => a + b, 0) / values.length;
}

function percentage(a, b) {
  if (!b) return 0;

  return Math.round((a / b) * 100);
}

function transitionScore(history) {
  if (history.length < 2) {
    return {
      big: 0,
      small: 0,
      confidence: 0
    };
  }

  let big = 0;
  let small = 0;

  const recent = history.slice(0, Math.min(20, history.length));

  for (let i = 0; i < recent.length - 1; i++) {
    const current = classifyNumber(recent[i].number);
    const previous = classifyNumber(recent[i + 1].number);

    if (!current || !previous) continue;

    if (previous === "BIG" && current === "BIG") big += 1;
    if (previous === "SMALL" && current === "BIG") big += 1;

    if (previous === "SMALL" && current === "SMALL") small += 1;
    if (previous === "BIG" && current === "SMALL") small += 1;
  }

  const total = big + small;

  return {
    big,
    small,
    confidence: total ? Math.abs(big - small) / total : 0
  };
}

function recentBias(history) {
  const recent = history.slice(0, Math.min(10, history.length));

  let big = 0;
  let small = 0;

  for (const row of recent) {
    const type = classifyNumber(row.number);

    if (type === "BIG") big++;
    if (type === "SMALL") small++;
  }

  const total = big + small;

  if (!total) {
    return {
      big: 0,
      small: 0,
      ratio: 0
    };
  }

  return {
    big,
    small,
    ratio: Math.abs(big - small) / total
  };
}

function alternationScore(history) {
  const recent = history
    .slice(0, Math.min(12, history.length))
    .map(x => classifyNumber(x.number))
    .filter(Boolean);

  if (recent.length < 4) return 0;

  let switches = 0;

  for (let i = 0; i < recent.length - 1; i++) {
    if (recent[i] !== recent[i + 1]) {
      switches++;
    }
  }

  return switches / (recent.length - 1);
}

function numberStructureScore(history) {
  const recent = history.slice(0, Math.min(15, history.length));

  if (!recent.length) return 0;

  const evens = recent.filter(x => Number(x.number) % 2 === 0).length;
  const odds = recent.length - evens;

  return Math.abs(evens - odds) / recent.length;
}

function patternScore(history) {
  if (history.length < 5) return 0;

  const recent = history.slice(0, Math.min(20, history.length));

  const bias = recentBias(history);
  const trans = transitionScore(history);
  const alt = alternationScore(history);
  const structure = numberStructureScore(history);

  const score =
    bias.ratio * 35 +
    trans.confidence * 30 +
    Math.abs(alt - 0.5) * 25 +
    structure * 10;

  return Math.round(clamp(score, 0, 100));
}

function choosePrediction(history) {
  if (!Array.isArray(history) || history.length < 5) {
    return {
      prediction: "WAIT",
      predictedNumber: null,
      confidence: 0,
      patternScore: 0,
      agreement: 0,
      status: "INSUFFICIENT DATA",
      backtestSamples: 0,
      avgModelAccuracy: null
    };
  }

  const bias = recentBias(history);
  const trans = transitionScore(history);
  const alt = alternationScore(history);

  const votes = {
    BIG: 0,
    SMALL: 0
  };

  if (bias.big > bias.small) {
    votes.BIG += 1;
  } else if (bias.small > bias.big) {
    votes.SMALL += 1;
  }

  if (trans.big > trans.small) {
    votes.BIG += 1;
  } else if (trans.small > trans.big) {
    votes.SMALL += 1;
  }

  if (alt > 0.55) {
    const latest = classifyNumber(history[0].number);

    if (latest === "BIG") votes.SMALL += 1;
    if (latest === "SMALL") votes.BIG += 1;
  } else {
    const latest = classifyNumber(history[0].number);

    if (latest === "BIG") votes.BIG += 1;
    if (latest === "SMALL") votes.SMALL += 1;
  }

  const prediction =
    votes.BIG > votes.SMALL
      ? "BIG"
      : votes.SMALL > votes.BIG
        ? "SMALL"
        : "WAIT";

  const totalVotes = votes.BIG + votes.SMALL;

  const agreement =
    prediction === "WAIT"
      ? 0
      : Math.round(
          (Math.max(votes.BIG, votes.SMALL) / totalVotes) * 100
        );

  const pScore = patternScore(history);

  let confidence = Math.round(
    40 +
    pScore * 0.35 +
    agreement * 0.25
  );

  confidence = clamp(confidence, 0, 95);

  const backtest = backtestModel(history);

  /*
   * Small samples are intentionally capped.
   * This prevents the UI from showing misleading high confidence
   * when there is not enough historical validation data.
   */
  if (backtest.samples < 20) {
    confidence = Math.min(confidence, 60);
  }

  if (prediction === "WAIT") {
    confidence = 0;
  }

  let status = "EARLY SIGNAL";

  if (history.length < 10) {
    status = "INSUFFICIENT DATA";
  } else if (backtest.samples >= 50 && confidence >= 90) {
    status = "STRONG MODEL LEAN";
  } else if (confidence >= 82) {
    status = "MODERATE SIGNAL";
  } else if (confidence >= 70) {
    status = "LOWER LEAN";
  } else if (confidence > 0) {
    status = "EARLY SIGNAL";
  } else {
    status = "WAITING";
  }

  let predictedNumber = null;

  if (prediction !== "WAIT") {
    const latestNumbers = history
      .slice(0, Math.min(20, history.length))
      .map(x => Number(x.number))
      .filter(n => Number.isFinite(n));

    if (latestNumbers.length) {
      const targetType = prediction;

      const candidates = Array.from(
        { length: 10 },
        (_, i) => i
      ).filter(n => classifyNumber(n) === targetType);

      /*
       * Choose a number from the target class using recent frequency.
       * This is only a model output, not a guarantee.
       */
      let best = candidates[0];
      let bestFrequency = Infinity;

      for (const candidate of candidates) {
        const frequency = latestNumbers.filter(
          n => n === candidate
        ).length;

        if (frequency < bestFrequency) {
          bestFrequency = frequency;
          best = candidate;
        }
      }

      predictedNumber = best;
    }
  }

  return {
    prediction,
    predictedNumber,
    confidence,
    patternScore: pScore,
    agreement,
    status,
    backtestSamples: backtest.samples,
    avgModelAccuracy: backtest.accuracy
  };
}

function modelDirection(history, index) {
  const data = history.slice(index);

  if (data.length < 5) {
    return "WAIT";
  }

  const bias = recentBias(data);
  const trans = transitionScore(data);
  const latest = classifyNumber(data[0]?.number);

  let big = 0;
  let small = 0;

  if (bias.big > bias.small) big++;
  if (bias.small > bias.big) small++;

  if (trans.big > trans.small) big++;
  if (trans.small > trans.big) small++;

  if (latest === "BIG") big++;
  if (latest === "SMALL") small++;

  if (big > small) return "BIG";
  if (small > big) return "SMALL";

  return "WAIT";
}

function backtestModel(history) {
  /*
   * Use older settled rows as validation targets.
   * The newest row is never treated as a future target.
   */
  const maxSamples = Math.min(
    Math.max(history.length - 5, 0),
    200
  );

  let samples = 0;
  let correct = 0;

  for (let i = 1; i <= maxSamples; i++) {
    const actual = classifyNumber(history[i - 1]?.number);

    if (!actual) continue;

    const prediction = modelDirection(history, i);

    if (prediction === "WAIT") continue;

    samples++;

    if (prediction === actual) {
      correct++;
    }
  }

  return {
    samples,
    accuracy: samples
      ? Math.round((correct / samples) * 100)
      : null
  };
}

/* =========================================================
   DATABASE
========================================================= */

async function setupDatabase() {
  if (!pool) {
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

  for (const sql of migrations) {
    try {
      await pool.query(sql);
    } catch (e) {
      console.error("Migration warning:", e.message);
    }
  }

  /*
   * Do not allow blank target rows to interfere with settlement.
   */
  try {
    await pool.query(`
      DELETE FROM predictions
      WHERE target_issue IS NULL OR TRIM(target_issue) = ''
    `);
  } catch (e) {
    console.error("Prediction cleanup warning:", e.message);
  }

  state.database = true;
}

/* =========================================================
   ACCESS KEY
========================================================= */

async function checkAccessKey(key, deviceId) {
  if (!pool) {
    return {
      ok: false,
      message: "Database is not configured"
    };
  }

  if (!key || !deviceId) {
    return {
      ok: false,
      message: "Access key and device ID are required"
    };
  }

  const result = await pool.query(
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
      message: "Invalid access key"
    };
  }

  const row = result.rows[0];

  if (row.device_id && row.device_id !== deviceId) {
    return {
      ok: false,
      message: "This key is already linked to another device"
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
      [deviceId, now(), row.id]
    );
  } else {
    await pool.query(
      `
        UPDATE access_keys
        SET last_seen = $1
        WHERE id = $2
      `,
      [now(), row.id]
    );
  }

  return {
    ok: true,
    row
  };
}

async function authorizeUser(req) {
  const key = getAccessKey(req);
  const deviceId = getDeviceId(req);

  if (!key || !deviceId || !pool) {
    return false;
  }

  const result = await pool.query(
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

  const row = result.rows[0];

  if (!row.device_id || row.device_id !== deviceId) {
    return false;
  }

  await pool.query(
    `
      UPDATE access_keys
      SET last_seen = $1
      WHERE id = $2
    `,
    [now(), row.id]
  );

  return true;
}

/* =========================================================
   PREDICTIONS
========================================================= */

async function savePrediction(targetIssue, model) {
  if (!pool || !targetIssue || !model) {
    return;
  }

  if (
    !model.prediction ||
    model.prediction === "WAIT"
  ) {
    return;
  }

  const existing = await pool.query(
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
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `,
    [
      targetIssue,
      model.prediction,
      model.predictedNumber,
      model.confidence,
      model.patternScore,
      model.agreement,
      model.status,
      now()
    ]
  );
}

async function settlePredictions(history) {
  if (!pool || !Array.isArray(history) || !history.length) {
    return;
  }

  const recent = history.slice(
    0,
    WINLOSS_LIMIT
  );

  for (const row of recent) {
    if (!row.issueNumber || row.number === null) {
      continue;
    }

    const result = await pool.query(
      `
        SELECT id, prediction
        FROM predictions
        WHERE target_issue = $1
          AND (outcome IS NULL OR outcome = '')
        LIMIT 1
      `,
      [row.issueNumber]
    );

    if (!result.rows.length) {
      continue;
    }

    const prediction = result.rows[0].prediction;
    const actual = classifyNumber(row.number);

    if (!prediction || !actual) {
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

async function getWinLossStats() {
  if (!pool) {
    return {
      win: 0,
      loss: 0,
      rate: 0
    };
  }

  const result = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE outcome = 'WIN') AS win,
      COUNT(*) FILTER (WHERE outcome = 'LOSS') AS loss
    FROM predictions
    WHERE outcome IN ('WIN','LOSS')
  `);

  const row = result.rows[0];

  const win = Number(row.win || 0);
  const loss = Number(row.loss || 0);

  return {
    win,
    loss,
    rate: percentage(win, win + loss)
  };
}

async function getCombinedResults(history) {
  const rows = Array.isArray(history)
    ? history.slice(0, LIVE_RESULTS_LIMIT)
    : [];

  let predictionMap = new Map();

  if (pool) {
    const issues = rows
      .map(x => x.issueNumber)
      .filter(Boolean);

    if (issues.length) {
      const result = await pool.query(
        `
          SELECT
            target_issue,
            prediction,
            predicted_number,
            outcome
          FROM predictions
          WHERE target_issue = ANY($1::text[])
        `,
        [issues]
      );

      for (const row of result.rows) {
        predictionMap.set(
          String(row.target_issue),
          row
        );
      }
    }
  }

  return rows.map(row => {
    const prediction = predictionMap.get(
      String(row.issueNumber)
    );

    return {
      issueNumber: row.issueNumber,
      number: row.number,
      colour: row.colour,
      prediction: prediction?.prediction || null,
      predictedNumber:
        prediction?.predicted_number ?? null,
      outcome: prediction?.outcome || null
    };
  });
}

/* =========================================================
   REFRESH DATA
========================================================= */

async function refreshWingo() {
  try {
    const data = await fetchWingo();

    const history = data.history;

    const signature =
      makeHistorySignature(history);

    const changed =
      signature !== state.historySignature;

    state.wingobot = true;
    state.history = history;
    state.providerCurrentIssue =
      data.currentIssue;
    state.providerCountdown =
      data.providerCountdown;
    state.lastError = null;

    if (changed) {
      state.historySignature = signature;
      state.lastHistoryUpdate = now();

      const settled = latestSettled(history);

      state.settledIssue =
        settled?.issueNumber || null;

      /*
       * Prediction target is ALWAYS the next issue
       * after the latest settled result.
       */
      state.targetIssue =
        incrementIssue(
          state.settledIssue
        );

      const model =
        choosePrediction(history);

      state.analysis = model;

      /*
       * Save only when the settled history changed.
       * This prevents a new prediction from being created
       * every second for the same result.
       */
      await savePrediction(
        state.targetIssue,
        model
      );

      await settlePredictions(history);
    } else {
      const settled = latestSettled(history);

      state.settledIssue =
        settled?.issueNumber || state.settledIssue;

      state.targetIssue =
        incrementIssue(
          state.settledIssue
        );
    }

    /*
     * Provider countdown is used if available.
     * Otherwise use a smooth 30-second estimate anchored
     * to the last settled-history update.
     */
    if (
      Number.isFinite(data.providerCountdown)
    ) {
      state.timerAnchorMs =
        now() -
        (ROUND_SECONDS -
          data.providerCountdown) *
          1000;
    } else if (changed) {
      state.timerAnchorMs = now();
    }

    return true;
  } catch (e) {
    state.wingobot = false;
    state.lastError = e.message;

    console.error(
      "WingoBot refresh error:",
      e.message
    );

    return false;
  }
}

/* =========================================================
   COUNTDOWN
========================================================= */

function getCountdown() {
  if (
    Number.isFinite(
      state.providerCountdown
    )
  ) {
    return Math.max(
      0,
      Math.floor(
        state.providerCountdown
      )
    );
  }

  const elapsed =
    Math.floor(
      (now() - state.timerAnchorMs) /
        1000
    );

  const remaining =
    ROUND_SECONDS -
    (elapsed % ROUND_SECONDS);

  return remaining === ROUND_SECONDS
    ? 0
    : remaining;
}

/* =========================================================
   STATE API
========================================================= */

async function buildState() {
  const stats =
    await getWinLossStats();

  const results =
    await getCombinedResults(
      state.history
    );

  const analysis =
    state.analysis ||
    choosePrediction(
      state.history
    );

  return {
    success: true,
    ok: true,

    ready: state.ready,
    database: state.database,
    wingobot: state.wingobot,

    settledIssue:
      state.settledIssue,

    targetIssue:
      state.targetIssue,

    nextIssue:
      state.targetIssue,

    providerCurrentIssue:
      state.providerCurrentIssue,

    countdown:
      getCountdown(),

    history:
      state.history.slice(
        0,
        LIVE_RESULTS_LIMIT
      ),

    historyCount:
      state.history.length,

    results,

    analysis,

    /*
     * Top-level aliases are included for
     * compatibility with older prediction pages.
     */
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
   ADMIN APIs
========================================================= */

async function adminKeysGet(req, res) {
  if (!requireAdmin(req, res)) return;

  if (!pool) {
    json(res, 500, {
      success: false,
      ok: false,
      message: "Database not configured"
    });
    return;
  }

  const result = await pool.query(`
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
    keys: result.rows
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

async function adminKeysCreate(req, res) {
  if (!requireAdmin(req, res)) return;

  if (!pool) {
    json(res, 500, {
      success: false,
      ok: false,
      message: "Database not configured"
    });
    return;
  }

  const body = await parseBody(req);

  const requested =
    Number(
      body.count ??
      body.quantity ??
      1
    );

  const count = clamp(
    Number.isFinite(requested)
      ? Math.floor(requested)
      : 1,
    1,
    100
  );

  const keys = [];

  for (let i = 0; i < count; i++) {
    let key = generateKey();

    let exists = true;

    while (exists) {
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

      exists = check.rows.length > 0;

      if (exists) {
        key = generateKey();
      }
    }

    await pool.query(
      `
        INSERT INTO access_keys (
          access_key,
          device_id,
          created_at,
          last_seen
        )
        VALUES ($1,NULL,$2,0)
      `,
      [key, now()]
    );

    keys.push(key);
  }

  json(res, 200, {
    success: true,
    ok: true,
    key: keys[0],
    keys
  });
}

async function adminKeysDelete(req, res) {
  if (!requireAdmin(req, res)) return;

  if (!pool) {
    json(res, 500, {
      success: false,
      ok: false,
      message: "Database not configured"
    });
    return;
  }

  const body = await parseBody(req);

  const id =
    body.id ??
    body.keyId;

  const key =
    body.key ??
    body.access_key;

  let result;

  if (id !== undefined) {
    result = await pool.query(
      `
        DELETE FROM access_keys
        WHERE id = $1
      `,
      [Number(id)]
    );
  } else if (key) {
    result = await pool.query(
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
      message: "Key or id required"
    });
    return;
  }

  json(res, 200, {
    success: true,
    ok: true,
    deleted: result.rowCount
  });
}

async function adminResetDevice(req, res) {
  if (!requireAdmin(req, res)) return;

  if (!pool) {
    json(res, 500, {
      success: false,
      ok: false,
      message: "Database not configured"
    });
    return;
  }

  const body = await parseBody(req);

  const id =
    body.id ??
    body.keyId;

  const key =
    body.key ??
    body.access_key;

  let result;

  if (id !== undefined) {
    result = await pool.query(
      `
        UPDATE access_keys
        SET device_id = NULL,
            last_seen = 0
        WHERE id = $1
        RETURNING id, access_key
      `,
      [Number(id)]
    );
  } else if (key) {
    result = await pool.query(
      `
        UPDATE access_keys
        SET device_id = NULL,
            last_seen = 0
        WHERE access_key = $1
        RETURNING id, access_key
      `,
      [String(key)]
    );
  } else {
    json(res, 400, {
      success: false,
      ok: false,
      message: "Key or id required"
    });
    return;
  }

  json(res, 200, {
    success: true,
    ok: true,
    reset: result.rowCount,
    row: result.rows[0] || null
  });
}

async function adminStatus(req, res) {
  if (!requireAdmin(req, res)) return;

  json(res, 200, {
    success: true,
    ok: true,
    ready: state.ready,
    database: state.database,
    wingobot: state.wingobot,
    historyCount: state.history.length,
    settledIssue: state.settledIssue,
    targetIssue: state.targetIssue,
    providerCurrentIssue:
      state.providerCurrentIssue,
    countdown: getCountdown(),
    lastHistoryUpdate:
      state.lastHistoryUpdate,
    lastError: state.lastError
  });
}

async function adminPing(req, res) {
  if (!requireAdmin(req, res)) return;

  json(res, 200, {
    success: true,
    ok: true,
    message: "Admin API working"
  });
}

async function adminWingoTest(req, res) {
  if (!requireAdmin(req, res)) return;

  try {
    const data = await fetchWingo();

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
        data.history.slice(0, 30)
    });
  } catch (e) {
    json(res, 500, {
      success: false,
      ok: false,
      message: e.message
    });
  }
}

async function adminModelTest(req, res) {
  if (!requireAdmin(req, res)) return;

  try {
    if (!state.history.length) {
      await refreshWingo();
    }

    const analysis =
      choosePrediction(
        state.history
      );

    const backtest =
      backtestModel(
        state.history
      );

    json(res, 200, {
      success: true,
      ok: true,
      analysis,
      history:
        state.history.slice(0, 30),
      avgModelAccuracy:
        backtest.accuracy,
      backtestSamples:
        backtest.samples,
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
      message: e.message
    });
  }
}

/* =========================================================
   USER APIs
========================================================= */

async function keyCheckApi(req, res) {
  try {
    const body = await parseBody(req);

    const key =
      String(
        body.key ??
        body.access_key ??
        ""
      ).trim();

    const deviceId =
      String(
        body.device_id ??
        body.deviceId ??
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
      message: "Access granted"
    });
  } catch (e) {
    json(res, 500, {
      success: false,
      ok: false,
      message: e.message
    });
  }
}

async function stateApi(req, res) {
  try {
    const authorized =
      await authorizeUser(req);

    if (!authorized) {
      json(res, 401, {
        success: false,
        ok: false,
        message: "Unauthorized"
      });
      return;
    }

    json(
      res,
      200,
      await buildState()
    );
  } catch (e) {
    console.error(e);

    json(res, 500, {
      success: false,
      ok: false,
      message: e.message
    });
  }
}

async function historyApi(req, res) {
  try {
    const authorized =
      await authorizeUser(req);

    if (!authorized) {
      json(res, 401, {
        success: false,
        ok: false,
        message: "Unauthorized"
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
      message: e.message
    });
  }
}

/* =========================================================
   STATIC FILE SERVER
========================================================= */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".webp": "image/webp"
};

function serveStatic(req, res, pathname) {
  let filePath;

  if (pathname === "/" || pathname === "") {
    filePath =
      path.join(
        ROOT,
        "prediction.html"
      );
  } else {
    const clean =
      decodeURIComponent(
        pathname
      ).replace(/^\/+/, "");

    filePath =
      path.join(ROOT, clean);
  }

  if (!filePath.startsWith(ROOT)) {
    sendText(
      res,
      403,
      "Forbidden"
    );
    return;
  }

  fs.stat(
    filePath,
    (err, stat) => {
      if (err || !stat.isFile()) {
        sendText(
          res,
          404,
          "Not found"
        );
        return;
      }

      const ext =
        path.extname(filePath)
          .toLowerCase();

      const mime =
        MIME[ext] ||
        "application/octet-stream";

      if (ext === ".mp3") {
        serveAudio(
          req,
          res,
          filePath,
          mime
        );
        return;
      }

      res.writeHead(200, {
        "Content-Type": mime,
        "Cache-Control":
          "no-cache"
      });

      fs.createReadStream(
        filePath
      ).pipe(res);
    }
  );
}

function serveAudio(
  req,
  res,
  filePath,
  mime
) {
  fs.stat(
    filePath,
    (err, stat) => {
      if (err) {
        sendText(
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
          "Content-Type": mime,
          "Content-Length": size,
          "Accept-Ranges": "bytes"
        });

        fs.createReadStream(
          filePath
        ).pipe(res);

        return;
      }

      const match =
        /bytes=(\d*)-(\d*)/.exec(
          range
        );

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
        "Content-Type": mime,
        "Content-Length": chunkSize,
        "Content-Range":
          `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes"
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

/* =========================================================
   SERVER
========================================================= */

const server =
  http.createServer(
    async (req, res) => {
      try {
        const url =
          new URL(
            req.url,
            `http://${req.headers.host || "localhost"}`
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
              "Content-Type, X-Access-Key, X-Device-ID, X-Admin-Key, Authorization",
            "Access-Control-Allow-Methods":
              "GET,POST,DELETE,OPTIONS"
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
            status: "healthy",
            ready: state.ready,
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
          await keyCheckApi(
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

        serveStatic(
          req,
          res,
          pathname
        );
      } catch (e) {
        console.error(
          "SERVER ERROR:",
          e
        );

        if (!res.headersSent) {
          json(res, 500, {
            success: false,
            ok: false,
            message:
              e.message ||
              "Internal server error"
          });
        } else {
          res.end();
        }
      }
    }
  );

/* =========================================================
   STARTUP
========================================================= */

async function startup() {
  try {
    await setupDatabase();

    state.ready = true;

    console.log(
      "Database ready:",
      state.database
    );
  } catch (e) {
    state.ready = true;
    state.database = false;

    console.error(
      "Database setup error:",
      e.message
    );
  }

  await refreshWingo();

  setInterval(
    refreshWingo,
    3000
  );

  server.listen(
    PORT,
    "0.0.0.0",
    () => {
      console.log(
        `DY AI server running on port ${PORT}`
      );
    }
  );
}

process.on(
  "unhandledRejection",
  err => {
    console.error(
      "Unhandled rejection:",
      err
    );
  }
);

process.on(
  "uncaughtException",
  err => {
    console.error(
      "Uncaught exception:",
      err
    );
  }
);

startup();
