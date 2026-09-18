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

const DEFAULT_ACCESS_KEY = String(
  process.env.DEFAULT_ACCESS_KEY || "DY-JPMSUULN"
).trim();

const WINGOBOT_URL =
  "https://api.wingobot.com/v2/1-min-game-history";

const WINGOBOT_TOKEN = String(
  process.env.WINGOBOT_TOKEN || ""
)
  .replace(/^Bearer\s+/i, "")
  .replace(/^["']|["']$/g, "")
  .replace(/\r|\n/g, "")
  .trim();

const MODEL_VERSION =
  String(process.env.MODEL || "DY-AI-1MIN-V21").trim();

const POLL_MS = 1000;
const ANALYSIS_MS = 4000;
const SKIP_ROUNDS = 4;
const REQUEST_TIMEOUT = 8000;

let pool = null;

if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
  });
}

const memory = {
  keys: new Map(),
  predictions: [],
  keyId: 1,
  predictionId: 1
};

const live = {
  ok: false,
  currentIssue: null,
  history: [],
  updated: 0,
  error: null,
  fetched: 0,
  lastIssue: null,
  lastIssueChange: 0
};

const analysis = {
  active: false,
  issue: null,
  startedAt: 0,
  endsAt: 0
};

let fetching = false;
let engineBusy = false;

function now() {
  return Date.now();
}

function resultType(n) {
  n = Number(n);
  if (!Number.isInteger(n) || n < 0 || n > 9) return null;
  return n >= 5 ? "BIG" : "SMALL";
}

function issueBigInt(issue) {
  try {
    return BigInt(String(issue));
  } catch {
    return null;
  }
}

function issueDiff(a, b) {
  const x = issueBigInt(a);
  const y = issueBigInt(b);

  if (x === null || y === null) return null;

  return Number(x - y);
}

function cleanNumber(value) {
  if (
    value &&
    typeof value === "object"
  ) {
    value =
      value.number ??
      value.value ??
      value.openNumber ??
      value.open_num ??
      value.winNumber ??
      value.win_number;
  }

  const n = Number(value);

  if (
    !Number.isInteger(n) ||
    n < 0 ||
    n > 9
  ) {
    return null;
  }

  return n;
}

function makeKey() {
  return (
    "DY-" +
    crypto
      .randomBytes(6)
      .toString("hex")
      .toUpperCase()
  );
}

/* =========================
   DATABASE
========================= */

async function initDB() {
  if (!pool) {
    if (!memory.keys.has(DEFAULT_ACCESS_KEY)) {
      memory.keys.set(DEFAULT_ACCESS_KEY, {
        id: memory.keyId++,
        access_key: DEFAULT_ACCESS_KEY,
        device_id: null,
        created_at: now(),
        last_seen: 0
      });
    }
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

  const check = await pool.query(
    `SELECT id
     FROM access_keys
     WHERE access_key=$1
     LIMIT 1`,
    [DEFAULT_ACCESS_KEY]
  );

  if (!check.rows.length) {
    await pool.query(
      `INSERT INTO access_keys
       (access_key,device_id,created_at,last_seen)
       VALUES($1,NULL,$2,0)`,
      [DEFAULT_ACCESS_KEY, now()]
    );
  }
}

/* =========================
   HISTORY PARSER
========================= */

function normalizeHistory(raw) {
  let arr = [];

  const candidates = [
    raw,
    raw?.data,
    raw?.result,
    raw?.data?.data,
    raw?.data?.result,
    raw?.data?.list,
    raw?.data?.records,
    raw?.data?.history,
    raw?.history,
    raw?.results,
    raw?.list,
    raw?.records
  ];

  for (const c of candidates) {
    if (Array.isArray(c)) {
      arr = c;
      break;
    }
  }

  const output = [];

  for (const item of arr) {
    if (
      typeof item === "number" ||
      typeof item === "string"
    ) {
      const n = cleanNumber(item);

      if (n !== null) {
        output.push({
          issue: null,
          number: n,
          result: resultType(n)
        });
      }

      continue;
    }

    if (!item || typeof item !== "object") {
      continue;
    }

    const n = cleanNumber(
      item.number ??
      item.openNumber ??
      item.open_num ??
      item.num ??
      item.value ??
      item.result ??
      item.winNumber ??
      item.win_number
    );

    if (n === null) continue;

    const issue =
      item.issue ??
      item.period ??
      item.periodNumber ??
      item.period_number ??
      item.period_id ??
      item.periodId ??
      item.issueNumber ??
      item.issue_number ??
      item.draw ??
      item.round ??
      item.roundNumber ??
      item.round_number ??
      item.id ??
      null;

    output.push({
      issue:
        issue === null ||
        issue === undefined
          ? null
          : String(issue),
      number: n,
      result: resultType(n)
    });
  }

  const seen = new Set();

  return output.filter(x => {
    const key =
      `${x.issue}|${x.number}`;

    if (seen.has(key)) return false;

    seen.add(key);
    return true;
  });
}

/* =========================
   CURRENT ISSUE
========================= */

function findIssueDeep(obj) {
  if (!obj || typeof obj !== "object") {
    return null;
  }

  const direct =
    obj.currentIssue ??
    obj.current_issue ??
    obj.currentPeriod ??
    obj.current_period ??
    obj.currentPeriodNumber ??
    obj.current_period_number ??
    obj.current?.issue ??
    obj.current?.period ??
    obj.current?.periodNumber;

  if (
    direct !== null &&
    direct !== undefined &&
    String(direct).trim()
  ) {
    return String(direct).trim();
  }

  return null;
}

function deriveCurrentIssue(history) {
  const nums = history
    .map(x => issueBigInt(x.issue))
    .filter(x => x !== null);

  if (!nums.length) {
    return null;
  }

  let latest = nums[0];

  for (const n of nums) {
    if (n > latest) {
      latest = n;
    }
  }

  /*
    History normally contains completed results.
    Current round = latest completed issue + 1.
  */

  return (latest + 1n).toString();
}

async function fetchWingo() {
  if (!WINGOBOT_TOKEN) {
    throw new Error(
      "WINGOBOT_TOKEN_MISSING"
    );
  }

  const controller =
    new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT
  );

  try {
    const response = await fetch(
      WINGOBOT_URL,
      {
        method: "GET",
        headers: {
          Authorization:
            `Bearer ${WINGOBOT_TOKEN}`,
          Accept:
            "application/json"
        },
        signal: controller.signal
      }
    );

    if (!response.ok) {
      throw new Error(
        `WINGOBOT_HTTP_${response.status}`
      );
    }

    const raw =
      await response.json();

    const history =
      normalizeHistory(raw);

    if (!history.length) {
      throw new Error(
        "HISTORY_NOT_FOUND"
      );
    }

    let currentIssue =
      findIssueDeep(raw);

    if (!currentIssue) {
      currentIssue =
        deriveCurrentIssue(
          history
        );
    }

    if (!currentIssue) {
      throw new Error(
        "CURRENT_PERIOD_NOT_FOUND"
      );
    }

    return {
      currentIssue,
      history,
      raw
    };

  } finally {
    clearTimeout(timer);
  }
}

/* =========================
   KEY SYSTEM
========================= */

async function checkKey(
  key,
  deviceId
) {
  key =
    String(key || "").trim();

  deviceId =
    String(deviceId || "").trim();

  if (!key || !deviceId) {
    return {
      ok: false,
      error:
        "KEY_AND_DEVICE_REQUIRED"
    };
  }

  if (!pool) {
    const item =
      memory.keys.get(key);

    if (!item) {
      return {
        ok: false,
        error: "INVALID_KEY"
      };
    }

    if (
      item.device_id &&
      item.device_id !== deviceId
    ) {
      return {
        ok: false,
        error:
          "KEY_ALREADY_USED_ON_ANOTHER_DEVICE"
      };
    }

    item.device_id = deviceId;
    item.last_seen = now();

    return {
      ok: true,
      key,
      deviceId
    };
  }

  const r =
    await pool.query(
      `SELECT *
       FROM access_keys
       WHERE access_key=$1
       LIMIT 1`,
      [key]
    );

  if (!r.rows.length) {
    return {
      ok: false,
      error: "INVALID_KEY"
    };
  }

  const item =
    r.rows[0];

  if (
    item.device_id &&
    item.device_id !== deviceId
  ) {
    return {
      ok: false,
      error:
        "KEY_ALREADY_USED_ON_ANOTHER_DEVICE"
    };
  }

  await pool.query(
    `UPDATE access_keys
     SET device_id=$1,
         last_seen=$2
     WHERE id=$3`,
    [
      deviceId,
      now(),
      item.id
    ]
  );

  return {
    ok: true,
    key,
    deviceId
  };
}

async function verifyAccess(req) {
  const key =
    req.headers["x-access-key"];

  const device =
    req.headers["x-device-id"];

  return checkKey(
    key,
    device
  );
}

/* =========================
   AI MODEL
========================= */

function weightedSignal(
  results,
  count
) {
  const data =
    results.slice(
      0,
      count
    );

  if (!data.length) return 0;

  let score = 0;
  let weight = 0;

  for (
    let i = 0;
    i < data.length;
    i++
  ) {
    const w =
      count - i;

    score +=
      (
        data[i] === "BIG"
          ? 1
          : -1
      ) * w;

    weight += w;
  }

  return weight
    ? score / weight
    : 0;
}

function streakSignal(results) {
  if (!results.length) return 0;

  const first =
    results[0];

  let streak = 0;

  for (const x of results) {
    if (x !== first) break;
    streak++;
  }

  if (streak >= 5) {
    return first === "BIG"
      ? -0.35
      : 0.35;
  }

  if (streak === 4) {
    return first === "BIG"
      ? -0.22
      : 0.22;
  }

  if (streak === 3) {
    return first === "BIG"
      ? -0.12
      : 0.12;
  }

  return 0;
}

function transitionSignal(results) {
  if (results.length < 2) return 0;

  const a = results[0];
  const b = results[1];

  if (
    a === "BIG" &&
    b === "BIG"
  ) {
    return 0.08;
  }

  if (
    a === "SMALL" &&
    b === "SMALL"
  ) {
    return -0.08;
  }

  return a === "BIG"
    ? 0.04
    : -0.04;
}

function patternSignal(results) {
  if (results.length < 8) return 0;

  const pattern =
    results
      .slice(0, 5)
      .join("");

  let big = 0;
  let small = 0;

  for (
    let i = 6;
    i < results.length;
    i++
  ) {
    const old =
      results
        .slice(i, i + 5)
        .join("");

    if (old !== pattern) {
      continue;
    }

    if (
      results[i - 1] === "BIG"
    ) {
      big++;
    } else {
      small++;
    }
  }

  const total =
    big + small;

  if (!total) return 0;

  return (
    (big - small) /
    total
  );
}

function numberSignal(numbers) {
  if (!numbers.length) return 0;

  let score = 0;
  let weight = 0;

  for (
    let i = 0;
    i < numbers.length;
    i++
  ) {
    const n =
      numbers[i];

    const w =
      numbers.length - i;

    if (n >= 7) {
      score +=
        0.10 * w;
    }

    if (n <= 2) {
      score -=
        0.10 * w;
    }

    weight += w;
  }

  if (!weight) return 0;

  return score /
    (weight * 0.10);
}

function entropy(results) {
  if (!results.length) return 0;

  let big = 0;
  let small = 0;

  for (const x of results) {
    if (x === "BIG") big++;
    else small++;
  }

  const total =
    big + small;

  const pb = big / total;
  const ps = small / total;

  let e = 0;

  if (pb > 0) {
    e -= pb * Math.log2(pb);
  }

  if (ps > 0) {
    e -= ps * Math.log2(ps);
  }

  return e;
}

function analyzeAI(history) {
  const data =
    history.filter(
      x =>
        Number.isInteger(
          x.number
        )
    );

  if (data.length < 10) {
    return {
      prediction: null,
      confidence: 0,
      quality: "INSUFFICIENT",
      sampleSize: data.length
    };
  }

  const recent =
    data.slice(
      0,
      50
    );

  const results =
    recent.map(
      x => x.result
    );

  const numbers =
    recent.map(
      x => x.number
    );

  const short =
    weightedSignal(
      results,
      Math.min(
        6,
        results.length
      )
    );

  const medium =
    weightedSignal(
      results,
      Math.min(
        12,
        results.length
      )
    );

  const long =
    weightedSignal(
      results,
      Math.min(
        24,
        results.length
      )
    );

  const streak =
    streakSignal(
      results
    );

  const transition =
    transitionSignal(
      results
    );

  const pattern =
    patternSignal(
      results
    );

  const number =
    numberSignal(
      numbers
    );

  const e =
    entropy(
      results.slice(
        0,
        20
      )
    );

  let switches = 0;

  for (
    let i = 1;
    i <
    Math.min(
      20,
      results.length
    );
    i++
  ) {
    if (
      results[i] !==
      results[i - 1]
    ) {
      switches++;
    }
  }

  const switchRate =
    Math.min(
      1,
      switches / 19
    );

  let score =
      short * 0.30 +
      medium * 0.18 +
      long * 0.10 +
      streak * 0.12 +
      transition * 0.10 +
      pattern * 0.12 +
      number * 0.08;

  if (switchRate > 0.70) {
    score *= 0.85;
  }

  if (e > 0.98) {
    score *= 0.75;
  }

  score =
    Math.max(
      -1,
      Math.min(
        1,
        score
      )
    );

  const prediction =
    score >= 0
      ? "BIG"
      : "SMALL";

  let confidence =
    50 +
    Math.round(
      Math.abs(score) *
      42
    );

  if (e > 0.98) {
    confidence -= 7;
  }

  confidence =
    Math.max(
      51,
      Math.min(
        91,
        confidence
      )
    );

  let quality = "MEDIUM";

  if (confidence >= 75) {
    quality = "HIGH";
  } else if (
    confidence < 62
  ) {
    quality = "LOW";
  }

  return {
    prediction,
    confidence,
    quality,
    score:
      Number(
        score.toFixed(4)
      ),
    entropy:
      Number(
        e.toFixed(4)
      ),
    switchRate:
      Number(
        switchRate.toFixed(4)
      ),
    sampleSize:
      data.length,
    model:
      MODEL_VERSION
  };
}

/* =========================
   PREDICTIONS
========================= */

async function getPrediction(
  issue
) {
  if (!issue) return null;

  if (!pool) {
    return (
      memory.predictions
        .filter(
          x =>
            x.target_issue ===
            String(issue)
        )
        .sort(
          (a,b) =>
            b.created_at -
            a.created_at
        )[0] ||
      null
    );
  }

  const r =
    await pool.query(
      `SELECT *
       FROM prediction_records
       WHERE target_issue=$1
       ORDER BY id DESC
       LIMIT 1`,
      [String(issue)]
    );

  return r.rows[0] || null;
}

async function getLastPrediction() {
  if (!pool) {
    return (
      [...memory.predictions]
        .sort(
          (a,b) =>
            b.created_at -
            a.created_at
        )[0] ||
      null
    );
  }

  const r =
    await pool.query(`
      SELECT *
      FROM prediction_records
      ORDER BY id DESC
      LIMIT 1
    `);

  return r.rows[0] || null;
}

async function savePrediction(
  issue,
  ai
) {
  const existing =
    await getPrediction(
      issue
    );

  if (existing) {
    return existing;
  }

  if (!pool) {
    const row = {
      id:
        memory.predictionId++,
      target_issue:
        String(issue),
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

    memory.predictions.push(
      row
    );

    return row;
  }

  const r =
    await pool.query(
      `INSERT INTO prediction_records
       (
         target_issue,
         prediction,
         confidence,
         model_version,
         created_at
       )
       VALUES($1,$2,$3,$4,$5)
       RETURNING *`,
      [
        String(issue),
        ai.prediction,
        ai.confidence,
        MODEL_VERSION,
        now()
      ]
    );

  return r.rows[0];
}

async function settlePredictions() {
  const map =
    new Map();

  for (
    const x of live.history
  ) {
    if (x.issue) {
      map.set(
        String(x.issue),
        x.number
      );
    }
  }

  if (!map.size) return;

  if (!pool) {
    for (
      const p of memory.predictions
    ) {
      if (
        p.actual_result === null &&
        map.has(
          p.target_issue
        )
      ) {
        const n =
          map.get(
            p.target_issue
          );

        p.actual_number =
          n;

        p.actual_result =
          resultType(n);

        p.settled_at =
          now();
      }
    }

    return;
  }

  const r =
    await pool.query(`
      SELECT id,target_issue
      FROM prediction_records
      WHERE actual_result IS NULL
      ORDER BY id DESC
      LIMIT 100
    `);

  for (
    const p of r.rows
  ) {
    const n =
      map.get(
        String(
          p.target_issue
        )
      );

    if (n === undefined) {
      continue;
    }

    await pool.query(
      `UPDATE prediction_records
       SET actual_number=$1,
           actual_result=$2,
           settled_at=$3
       WHERE id=$4`,
      [
        n,
        resultType(n),
        now(),
        p.id
      ]
    );
  }
}

/* =========================
   4 SKIP RULE
========================= */

async function getCycle(
  currentIssue
) {
  const last =
    await getLastPrediction();

  if (!last) {
    return {
      mode: "PREDICT",
      skipRound: 0,
      skipTotal: 4,
      skipRemaining: 0
    };
  }

  const diff =
    issueDiff(
      currentIssue,
      last.target_issue
    );

  if (
    diff === null
  ) {
    return {
      mode: "PREDICT",
      skipRound: 0,
      skipTotal: 4,
      skipRemaining: 0
    };
  }

  if (diff <= 0) {
    return {
      mode: "PREDICTED",
      skipRound: 0,
      skipTotal: 4,
      skipRemaining: 0
    };
  }

  if (
    diff >= 1 &&
    diff <= SKIP_ROUNDS
  ) {
    return {
      mode: "SKIP",
      skipRound: diff,
      skipTotal: SKIP_ROUNDS,
      skipRemaining:
        SKIP_ROUNDS -
        diff +
        1
    };
  }

  return {
    mode: "PREDICT",
    skipRound: 0,
    skipTotal: SKIP_ROUNDS,
    skipRemaining: 0
  };
}

function resetAnalysis() {
  analysis.active = false;
  analysis.issue = null;
  analysis.startedAt = 0;
  analysis.endsAt = 0;
}

/* =========================
   PREDICTION ENGINE
========================= */

async function engineTick() {
  if (
    engineBusy ||
    !live.ok ||
    !live.currentIssue
  ) {
    return;
  }

  engineBusy = true;

  try {
    const issue =
      String(
        live.currentIssue
      );

    const existing =
      await getPrediction(
        issue
      );

    if (existing) {
      resetAnalysis();
      return;
    }

    const cycle =
      await getCycle(
        issue
      );

    /*
      NO ANALYSIS DURING SKIP
    */

    if (
      cycle.mode ===
      "SKIP"
    ) {
      resetAnalysis();
      return;
    }

    if (
      cycle.mode !==
      "PREDICT"
    ) {
      resetAnalysis();
      return;
    }

    /*
      NEW PREDICTION ROUND:
      START 4 SECOND TIMER
    */

    if (
      !analysis.active ||
      analysis.issue !== issue
    ) {
      analysis.active = true;
      analysis.issue = issue;
      analysis.startedAt = now();
      analysis.endsAt =
        now() +
        ANALYSIS_MS;

      console.log(
        `[AI] Analysis started: ${issue}`
      );

      return;
    }

    /*
      WAIT FOR 4 SECONDS
    */

    if (
      now() <
      analysis.endsAt
    ) {
      return;
    }

    /*
      ANALYZE
    */

    const ai =
      analyzeAI(
        live.history
      );

    if (!ai.prediction) {
      resetAnalysis();
      return;
    }

    /*
      SAVE CURRENT ISSUE PREDICTION
    */

    const saved =
      await savePrediction(
        issue,
        ai
      );

    console.log(
      `[AI] Prediction ${issue}: ${saved.prediction} (${saved.confidence}%)`
    );

    resetAnalysis();

    await settlePredictions();

  } catch (e) {

    console.error(
      "[ENGINE]",
      e.message
    );

  } finally {
    engineBusy = false;
  }
}

/* =========================
   LIVE REFRESH
========================= */

async function refreshLive() {
  if (fetching) return;

  fetching = true;

  try {
    const data =
      await fetchWingo();

    const oldIssue =
      live.currentIssue;

    live.currentIssue =
      String(
        data.currentIssue
      );

    live.history =
      data.history;

    live.ok = true;
    live.error = null;
    live.updated = now();
    live.fetched++;

    if (
      oldIssue &&
      oldIssue !==
        live.currentIssue
    ) {

      live.lastIssue =
        oldIssue;

      live.lastIssueChange =
        now();

      /*
        NEW ROUND:
        RESET ONLY WHEN ISSUE CHANGES
      */

      resetAnalysis();

      console.log(
        `[LIVE] New issue: ${live.currentIssue}`
      );
    }

    await settlePredictions();

  } catch (e) {

    live.ok = false;
    live.error =
      e.message;
    live.updated =
      now();

  } finally {
    fetching = false;
  }
}

/* =========================
   STATE
========================= */

async function getPredictionView() {

  const issue =
    live.currentIssue;

  if (!issue) {
    return {
      result: "WAIT",
      status: "WAITING",
      prediction: null,
      issue: null
    };
  }

  const existing =
    await getPrediction(
      issue
    );

  if (existing) {
    return {
      result:
        existing.prediction,
      status:
        "PREDICTED",
      prediction:
        existing.prediction,
      confidence:
        Number(
          existing.confidence ||
          0
        ),
      issue,
      model:
        existing.model_version,
      analysis: {
        active: false,
        elapsed:
          ANALYSIS_MS,
        remaining: 0,
        complete: true
      }
    };
  }

  const cycle =
    await getCycle(
      issue
    );

  /*
    SKIP = ZERO ANALYSIS
  */

  if (
    cycle.mode ===
    "SKIP"
  ) {

    resetAnalysis();

    return {
      result: "SKIP",
      status: "COOLDOWN",
      prediction: null,
      issue,
      cycle,
      analysis: {
        active: false,
        elapsed: 0,
        remaining: 0,
        complete: false
      }
    };
  }

  /*
    START TIMER IF NEEDED
  */

  if (
    !analysis.active ||
    analysis.issue !==
      String(issue)
  ) {

    analysis.active = true;
    analysis.issue =
      String(issue);
    analysis.startedAt =
      now();
    analysis.endsAt =
      now() +
      ANALYSIS_MS;
  }

  const elapsed =
    Math.max(
      0,
      Math.min(
        ANALYSIS_MS,
        now() -
          analysis.startedAt
      )
    );

  const remaining =
    Math.max(
      0,
      analysis.endsAt -
        now()
    );

  if (
    remaining > 0
  ) {

    return {
      result:
        "ANALYZING",
      status:
        "ANALYZING",
      prediction: null,
      issue,
      cycle,
      analysis: {
        active: true,
        elapsed,
        remaining,
        complete: false
      }
    };
  }

  await engineTick();

  const after =
    await getPrediction(
      issue
    );

  if (after) {
    return {
      result:
        after.prediction,
      status:
        "PREDICTED",
      prediction:
        after.prediction,
      confidence:
        Number(
          after.confidence ||
          0
        ),
      issue,
      cycle,
      model:
        after.model_version,
      analysis: {
        active: false,
        elapsed:
          ANALYSIS_MS,
        remaining: 0,
        complete: true
      }
    };
  }

  return {
    result:
      "ANALYZING",
    status:
      "ANALYZING",
    prediction: null,
    issue,
    cycle,
    analysis: {
      active: true,
      elapsed:
        ANALYSIS_MS,
      remaining: 0,
      complete: false
    }
  };
}

async function buildState() {

  const prediction =
    await getPredictionView();

  const ai =
    live.history.length >= 10
      ? analyzeAI(
          live.history
        )
      : null;

  return {

    ok: true,

    currentPeriod:
      live.currentIssue,

    latestResult:
      live.history[0] ||
      null,

    prediction,

    ai: ai
      ? {
          model:
            ai.model,
          confidence:
            ai.confidence,
          quality:
            ai.quality,
          sampleSize:
            ai.sampleSize,
          score:
            ai.score
        }
      : null,

    cycle:
      await getCycle(
        live.currentIssue
      ),

    recentResults:
      live.history.slice(
        0,
        10
      ),

    source: {
      ok:
        live.ok,
      error:
        live.error,
      updated:
        live.updated,
      fetched:
        live.fetched
    },

    analysisSession: {
      active:
        analysis.active,
      issue:
        analysis.issue,
      startedAt:
        analysis.startedAt,
      endsAt:
        analysis.endsAt,
      duration:
        ANALYSIS_MS
    }
  };
}

/* =========================
   ADMIN
========================= */

async function listKeys() {

  if (!pool) {
    return [
      ...memory.keys.values()
    ];
  }

  const r =
    await pool.query(`
      SELECT *
      FROM access_keys
      ORDER BY id DESC
    `);

  return r.rows;
}

async function createKey(custom) {

  const key =
    String(
      custom || ""
    ).trim() ||
    makeKey();

  if (!pool) {

    if (
      memory.keys.has(key)
    ) {
      throw new Error(
        "KEY_ALREADY_EXISTS"
      );
    }

    const item = {
      id:
        memory.keyId++,
      access_key:
        key,
      device_id:
        null,
      created_at:
        now(),
      last_seen: 0
    };

    memory.keys.set(
      key,
      item
    );

    return item;
  }

  const r =
    await pool.query(
      `INSERT INTO access_keys
       (access_key,device_id,created_at,last_seen)
       VALUES($1,NULL,$2,0)
       RETURNING *`,
      [
        key,
        now()
      ]
    );

  return r.rows[0];
}

async function resetKey(key) {

  key =
    String(key || "")
      .trim();

  if (!pool) {

    const item =
      memory.keys.get(key);

    if (!item) {
      throw new Error(
        "KEY_NOT_FOUND"
      );
    }

    item.device_id = null;
    item.last_seen = 0;

    return item;
  }

  const r =
    await pool.query(
      `UPDATE access_keys
       SET device_id=NULL,
           last_seen=0
       WHERE access_key=$1
       RETURNING *`,
      [key]
    );

  if (!r.rows.length) {
    throw new Error(
      "KEY_NOT_FOUND"
    );
  }

  return r.rows[0];
}

async function deleteKey(key) {

  key =
    String(key || "")
      .trim();

  if (
    key ===
    DEFAULT_ACCESS_KEY
  ) {
    throw new Error(
      "DEFAULT_KEY_CANNOT_BE_DELETED"
    );
  }

  if (!pool) {

    const ok =
      memory.keys.delete(
        key
      );

    if (!ok) {
      throw new Error(
        "KEY_NOT_FOUND"
      );
    }

    return true;
  }

  const r =
    await pool.query(
      `DELETE FROM access_keys
       WHERE access_key=$1`,
      [key]
    );

  if (!r.rowCount) {
    throw new Error(
      "KEY_NOT_FOUND"
    );
  }

  return true;
}

async function listPredictions() {

  if (!pool) {
    return [
      ...memory.predictions
    ]
      .sort(
        (a,b) =>
          b.id - a.id
      )
      .slice(0,200);
  }

  const r =
    await pool.query(`
      SELECT *
      FROM prediction_records
      ORDER BY id DESC
      LIMIT 200
    `);

  return r.rows;
}

async function adminStatus() {

  const keys =
    await listKeys();

  const predictions =
    await listPredictions();

  const settled =
    predictions.filter(
      x =>
        x.actual_result
    );

  const wins =
    settled.filter(
      x =>
        x.prediction ===
        x.actual_result
    ).length;

  return {

    ok: true,

    live: {
      ok:
        live.ok,
      currentIssue:
        live.currentIssue,
      history:
        live.history.length,
      error:
        live.error
    },

    analysis: {
      active:
        analysis.active,
      issue:
        analysis.issue,
      startedAt:
        analysis.startedAt,
      endsAt:
        analysis.endsAt
    },

    stats: {
      keys:
        keys.length,
      predictions:
        predictions.length,
      settled:
        settled.length,
      wins,
      losses:
        settled.length -
        wins,
      accuracy:
        settled.length
          ? Number(
              (
                wins /
                settled.length *
                100
              ).toFixed(2)
            )
          : 0
    }
  };
}

/* =========================
   HTTP HELPERS
========================= */

function sendJson(
  res,
  status,
  data
) {

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
        "Content-Type,X-Access-Key,X-Device-ID,X-Admin-Key,Authorization",
      "Access-Control-Allow-Methods":
        "GET,POST,OPTIONS"
    }
  );

  res.end(body);
}

function sendFile(
  res,
  file
) {

  const safe =
    path.basename(file);

  const full =
    path.join(
      __dirname,
      safe
    );

  if (
    !fs.existsSync(full)
  ) {
    res.writeHead(404);
    return res.end(
      "File not found"
    );
  }

  const ext =
    path.extname(
      full
    ).toLowerCase();

  const types = {
    ".html":
      "text/html; charset=utf-8",
    ".css":
      "text/css; charset=utf-8",
    ".js":
      "application/javascript; charset=utf-8"
  };

  res.writeHead(
    200,
    {
      "Content-Type":
        types[ext] ||
        "application/octet-stream",
      "Cache-Control":
        "no-cache"
    }
  );

  fs.createReadStream(
    full
  ).pipe(res);
}

function readBody(req) {

  return new Promise(
    (resolve,reject) => {

      let body = "";

      req.on(
        "data",
        chunk => {

          body += chunk;

          if (
            body.length >
            2000000
          ) {
            reject(
              new Error(
                "REQUEST_TOO_LARGE"
              )
            );

            req.destroy();
          }
        }
      );

      req.on(
        "end",
        () => {

          if (!body) {
            return resolve({});
          }

          try {
            resolve(
              JSON.parse(body)
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

function adminAuth(req) {

  const key =
    req.headers[
      "x-admin-key"
    ];

  return (
    String(
      key || ""
    ).trim() ===
    ADMIN_KEY
  );
}

/* =========================
   ROUTER
========================= */

async function router(
  req,
  res
) {

  const url =
    new URL(
      req.url,
      `http://${req.headers.host || "localhost"}`
    );

  const p =
    url.pathname;

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
          "Content-Type,X-Access-Key,X-Device-ID,X-Admin-Key,Authorization",
        "Access-Control-Allow-Methods":
          "GET,POST,OPTIONS"
      }
    );

    return res.end();
  }

  /* HEALTH */

  if (
    p === "/health"
  ) {
    return sendJson(
      res,
      200,
      {
        ok: true,
        service:
          "DY AI WINGO",
        live:
          live.ok,
        currentIssue:
          live.currentIssue
      }
    );
  }

  /* KEY CHECK */

  if (
    p ===
      "/api/key/check" &&
    req.method ===
      "POST"
  ) {

    const body =
      await readBody(req);

    const result =
      await checkKey(
        body.key,
        body.deviceId
      );

    return sendJson(
      res,
      result.ok
        ? 200
        : 403,
      result
    );
  }

  /* STATE */

  if (
    p ===
      "/api/state" &&
    req.method ===
      "GET"
  ) {

    const auth =
      await verifyAccess(
        req
      );

    if (!auth.ok) {
      return sendJson(
        res,
        403,
        auth
      );
    }

    return sendJson(
      res,
      200,
      await buildState()
    );
  }

  /* ADMIN */

  if (
    p.startsWith(
      "/api/admin/"
    )
  ) {

    if (
      !adminAuth(req)
    ) {
      return sendJson(
        res,
        401,
        {
          ok:false,
          error:
            "ADMIN_UNAUTHORIZED"
        }
      );
    }

    try {

      if (
        p ===
          "/api/admin/keys" &&
        req.method ===
          "GET"
      ) {
        return sendJson(
          res,
          200,
          {
            ok:true,
            keys:
              await listKeys()
          }
        );
      }

      if (
        p ===
          "/api/admin/keys" &&
        req.method ===
          "POST"
      ) {

        const body =
          await readBody(req);

        return sendJson(
          res,
          200,
          {
            ok:true,
            key:
              await createKey(
                body.key
              )
          }
        );
      }

      if (
        p ===
          "/api/admin/reset-device" &&
        req.method ===
          "POST"
      ) {

        const body =
          await readBody(req);

        return sendJson(
          res,
          200,
          {
            ok:true,
            key:
              await resetKey(
                body.key
              )
          }
        );
      }

      if (
        p ===
          "/api/admin/delete-key" &&
        req.method ===
          "POST"
      ) {

        const body =
          await readBody(req);

        await deleteKey(
          body.key
        );

        return sendJson(
          res,
          200,
          {
            ok:true
          }
        );
      }

      if (
        p ===
          "/api/admin/status"
      ) {
        return sendJson(
          res,
          200,
          await adminStatus()
        );
      }

      if (
        p ===
          "/api/admin/predictions"
      ) {
        return sendJson(
          res,
          200,
          {
            ok:true,
            predictions:
              await listPredictions()
          }
        );
      }

      if (
        p ===
          "/api/admin/live-test"
      ) {

        const data =
          await fetchWingo();

        return sendJson(
          res,
          200,
          {
            ok:true,
            currentIssue:
              data.currentIssue,
            count:
              data.history.length,
            history:
              data.history.slice(
                0,
                20
              ),
            ai:
              analyzeAI(
                data.history
              )
          }
        );
      }

      return sendJson(
        res,
        404,
        {
          ok:false,
          error:
            "ADMIN_ROUTE_NOT_FOUND"
        }
      );

    } catch(e) {

      return sendJson(
        res,
        500,
        {
          ok:false,
          error:e.message
        }
      );
    }
  }

  /* FRONTEND */

  if (
    p === "/" ||
    p === "/prediction.html"
  ) {
    return sendFile(
      res,
      "prediction.html"
    );
  }

  if (
    p === "/admin.html"
  ) {
    return sendFile(
      res,
      "admin.html"
    );
  }

  return sendJson(
    res,
    404,
    {
      ok:false,
      error:"NOT_FOUND"
    }
  );
}

/* =========================
   SERVER
========================= */

const server =
  http.createServer(
    (req,res) => {

      router(
        req,
        res
      ).catch(error => {

        console.error(
          "SERVER ERROR:",
          error
        );

        if (
          !res.headersSent
        ) {
          sendJson(
            res,
            500,
            {
              ok:false,
              error:
                "SERVER_ERROR"
            }
          );
        }

      });

    }
  );

/* =========================
   START
========================= */

async function start() {

  await initDB();

  server.listen(
    PORT,
    "0.0.0.0",
    () => {

      console.log(
        "=============================="
      );

      console.log(
        " DY AI WINGO 1 MIN"
      );

      console.log(
        " PORT:",
        PORT
      );

      console.log(
        " MODEL:",
        MODEL_VERSION
      );

      console.log(
        " POLL:",
        POLL_MS
      );

      console.log(
        " ANALYSIS:",
        ANALYSIS_MS
      );

      console.log(
        " SKIP:",
        SKIP_ROUNDS
      );

      console.log(
        " TOKEN:",
        WINGOBOT_TOKEN
          ? "SET"
          : "MISSING"
      );

      console.log(
        "=============================="
      );
    }
  );

  await refreshLive();

  /*
    API refresh every 1 second
  */

  setInterval(
    async () => {

      await refreshLive();

      await engineTick();

    },
    POLL_MS
  );

  /*
    Prediction timer checked
    every 250ms.
  */

  setInterval(
    async () => {
      await engineTick();
    },
    250
  );
}

start().catch(
  error => {

    console.error(
      "STARTUP ERROR:",
      error
    );

    process.exit(1);

  }
);
