// ============================================================
// DY AI WINGO — ADVANCED PATTERN + REVERSAL ENGINE
// server.js
// ============================================================

"use strict";

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { URL } = require("url");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

// ============================================================
// CONFIG
// ============================================================

const PORT = Number(process.env.PORT || 10000);

const ADMIN_KEY = String(process.env.ADMIN_KEY || "").trim();
const WINGOBOT_TOKEN = String(process.env.WINGOBOT_TOKEN || "").trim();
const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();

const WINGOBOT_API =
  "https://api.wingobot.com/v2/30-sec-game-history";

const MODEL_VERSION = "DY-AI-ADVANCED-REVERSAL-V1";

const THINKING_DURATION_MS = 4000;
const PROVIDER_REFRESH_MS = 3000;
const REQUEST_TIMEOUT_MS = 12000;

const PUBLIC_DIR = __dirname;

// ============================================================
// DATABASE
// ============================================================

let pool = null;

if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes("localhost")
      ? false
      : { rejectUnauthorized: false }
  });
}

async function initDatabase() {
  if (!pool) {
    console.log("[DB] DATABASE_URL missing. Database disabled.");
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS access_keys (
      id SERIAL PRIMARY KEY,
      access_key TEXT UNIQUE NOT NULL,
      device_id TEXT,
      created_at BIGINT NOT NULL,
      last_seen BIGINT DEFAULT 0
    );
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
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_prediction_issue
    ON prediction_records(target_issue);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_prediction_created
    ON prediction_records(created_at DESC);
  `);

  console.log("[DB] Database ready.");
}

// ============================================================
// PROVIDER STATE
// ============================================================

let providerState = {
  ok: false,
  currentIssue: null,
  history: [],
  fetched: 0,
  lastUpdated: 0,
  error: null
};

let modelCache = {
  targetIssue: null,
  prediction: null,
  generatedAt: 0
};

let refreshInProgress = false;

// ============================================================
// BASIC HELPERS
// ============================================================

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
      "Content-Type, X-Access-Key, X-Device-Id, X-Admin-Key",
    "Access-Control-Allow-Methods":
      "GET, POST, DELETE, OPTIONS"
  });

  res.end(body);
}

function text(res, status, body, contentType = "text/plain") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });

  res.end(body);
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function average(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function median(arr) {
  if (!arr.length) return 0;

  const a = [...arr].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);

  return a.length % 2
    ? a[mid]
    : (a[mid - 1] + a[mid]) / 2;
}

function percentage(part, total) {
  if (!total) return 0;
  return Number(((part / total) * 100).toFixed(2));
}

function randomKey() {
  return (
    "DY-" +
    crypto.randomBytes(12).toString("hex").toUpperCase()
  );
}

function incrementIssue(issue) {
  if (issue === null || issue === undefined) return null;

  const s = String(issue).trim();

  if (!/^\d+$/.test(s)) {
    return null;
  }

  const n = BigInt(s) + 1n;

  return n.toString().padStart(s.length, "0");
}

function compareIssue(a, b) {
  try {
    const aa = BigInt(String(a));
    const bb = BigInt(String(b));

    if (aa > bb) return 1;
    if (aa < bb) return -1;
    return 0;
  } catch {
    return 0;
  }
}

// ============================================================
// HTML ESCAPE
// ============================================================

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ============================================================
// REQUEST BODY
// ============================================================

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";

    req.on("data", chunk => {
      data += chunk;

      if (data.length > 1024 * 1024) {
        reject(new Error("Body too large"));
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
        resolve({});
      }
    });

    req.on("error", reject);
  });
}

// ============================================================
// WINGOBOT FETCH
// ============================================================

function fetchWingoBot() {
  return new Promise((resolve, reject) => {
    if (!WINGOBOT_TOKEN) {
      reject(new Error("WINGOBOT_TOKEN missing"));
      return;
    }

    const request = https.request(
      WINGOBOT_API,
      {
        method: "GET",
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          Authorization: `Bearer ${WINGOBOT_TOKEN}`,
          Accept: "application/json",
          "User-Agent": "DY-AI-Wingo/1.0"
        }
      },
      response => {
        let body = "";

        response.on("data", chunk => {
          body += chunk;
        });

        response.on("end", () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(
              new Error(
                `WingoBot HTTP ${response.statusCode}: ${body.slice(
                  0,
                  300
                )}`
              )
            );
            return;
          }

          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error("Invalid WingoBot JSON"));
          }
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error("WingoBot timeout"));
    });

    request.on("error", reject);

    request.end();
  });
}

// ============================================================
// NORMALIZE PROVIDER HISTORY
// ============================================================

function normalizeHistory(payload) {
  const rawHistory =
    Array.isArray(payload?.history)
      ? payload.history
      : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.results)
      ? payload.results
      : [];

  const rows = [];

  for (const item of rawHistory) {
    const issue =
      item?.issueNumber ??
      item?.issue ??
      item?.period ??
      item?.issue;

    const number =
      item?.number ??
      item?.result ??
      item?.openNumber ??
      item?.digit;

    const n = Number(number);

    if (
      issue !== undefined &&
      Number.isInteger(n) &&
      n >= 0 &&
      n <= 9
    ) {
      rows.push({
        issueNumber: String(issue),
        number: n,
        colour: item?.colour ?? item?.color ?? null,
        premium: item?.premium ?? null,
        sum: item?.sum ?? null
      });
    }
  }

  return rows;
}

function getProviderCurrentIssue(payload) {
  return (
    payload?.current?.issueNumber ??
    payload?.currentIssue ??
    payload?.current?.issue ??
    null
  );
}

// ============================================================
// PROVIDER REFRESH
// ============================================================

async function refreshProvider() {
  if (refreshInProgress) {
    return providerState;
  }

  refreshInProgress = true;

  try {
    const payload = await fetchWingoBot();

    const history = normalizeHistory(payload);

    const currentIssue = getProviderCurrentIssue(payload);

    providerState = {
      ok: true,
      currentIssue:
        currentIssue !== null
          ? String(currentIssue)
          : history[0]?.issueNumber || null,
      history,
      fetched:
        safeNumber(payload?.stats?.fetched) ??
        history.length,
      lastUpdated:
        safeNumber(payload?.stats?.last_updated) ??
        now(),
      error: null
    };

    return providerState;
  } catch (error) {
    providerState = {
      ...providerState,
      ok: false,
      error: error.message || "Provider error"
    };

    return providerState;
  } finally {
    refreshInProgress = false;
  }
}

// ============================================================
// B/S CONVERSION
// ============================================================

function numberToType(n) {
  const value = Number(n);

  if (!Number.isInteger(value) || value < 0 || value > 9) {
    return null;
  }

  return value <= 4 ? "S" : "B";
}

function typeToLabel(type) {
  if (type === "B") return "BIG";
  if (type === "S") return "SMALL";
  return "UNKNOWN";
}

function numbersToTypes(numbers) {
  return numbers
    .map(numberToType)
    .filter(Boolean);
}

// ============================================================
// VALIDATION
// ============================================================

function validateNumbers(input) {
  if (!Array.isArray(input)) return [];

  return input
    .map(Number)
    .filter(n =>
      Number.isInteger(n) &&
      n >= 0 &&
      n <= 9
    );
}

// ============================================================
// WINDOWS
// ============================================================

function getWindow(sequence, size) {
  return sequence.slice(-size);
}

function windowStats(sequence, size) {
  const data = getWindow(sequence, size);
  const total = data.length;

  let big = 0;
  let small = 0;
  let switches = 0;

  for (const x of data) {
    if (x === "B") big++;
    if (x === "S") small++;
  }

  for (let i = 1; i < data.length; i++) {
    if (data[i] !== data[i - 1]) {
      switches++;
    }
  }

  const bigPct = percentage(big, total);
  const smallPct = percentage(small, total);

  const difference = Math.abs(bigPct - smallPct);

  let bias = "BALANCED";

  if (difference >= 35) {
    bias = "STRONG HISTORICAL BIAS";
  } else if (difference >= 20) {
    bias = "MODERATE BIAS";
  } else if (difference >= 10) {
    bias = "WEAK BIAS";
  }

  const streak = currentStreak(data);

  return {
    total,
    bigCount: big,
    smallCount: small,
    bigPercent: bigPct,
    smallPercent: smallPct,
    difference,
    bias,
    switchCount: switches,
    switchPercent:
      total > 1
        ? percentage(switches, total - 1)
        : 0,
    currentType: streak.type,
    currentStreak: streak.length,
    longestBigStreak: longestStreak(data, "B"),
    longestSmallStreak: longestStreak(data, "S")
  };
}

// ============================================================
// STREAK ANALYSIS
// ============================================================

function currentStreak(sequence) {
  if (!sequence.length) {
    return {
      type: null,
      length: 0
    };
  }

  const last = sequence[sequence.length - 1];

  let count = 1;

  for (let i = sequence.length - 2; i >= 0; i--) {
    if (sequence[i] !== last) break;
    count++;
  }

  return {
    type: last,
    length: count
  };
}

function streakLengths(sequence, type) {
  const result = [];

  let count = 0;

  for (const x of sequence) {
    if (x === type) {
      count++;
    } else if (count > 0) {
      result.push(count);
      count = 0;
    }
  }

  if (count > 0) {
    result.push(count);
  }

  return result;
}

function longestStreak(sequence, type) {
  const lengths = streakLengths(sequence, type);
  return lengths.length
    ? Math.max(...lengths)
    : 0;
}

function streakAnalysis(sequence) {
  const bigRuns = streakLengths(sequence, "B");
  const smallRuns = streakLengths(sequence, "S");

  const current = currentStreak(sequence);

  let anomaly = false;

  if (current.type === "B") {
    const historical = bigRuns.slice(0, -1);

    if (
      historical.length >= 3 &&
      current.length >
        average(historical) +
          Math.max(1, standardDeviation(historical))
    ) {
      anomaly = true;
    }
  }

  if (current.type === "S") {
    const historical = smallRuns.slice(0, -1);

    if (
      historical.length >= 3 &&
      current.length >
        average(historical) +
          Math.max(1, standardDeviation(historical))
    ) {
      anomaly = true;
    }
  }

  return {
    current,
    big: {
      count: bigRuns.length,
      average: Number(average(bigRuns).toFixed(2)),
      median: Number(median(bigRuns).toFixed(2)),
      longest: bigRuns.length ? Math.max(...bigRuns) : 0,
      lengths: bigRuns
    },
    small: {
      count: smallRuns.length,
      average: Number(average(smallRuns).toFixed(2)),
      median: Number(median(smallRuns).toFixed(2)),
      longest: smallRuns.length ? Math.max(...smallRuns) : 0,
      lengths: smallRuns
    },
    anomaly
  };
}

function standardDeviation(arr) {
  if (!arr.length) return 0;

  const avg = average(arr);

  const variance =
    arr.reduce(
      (sum, value) =>
        sum + Math.pow(value - avg, 2),
      0
    ) / arr.length;

  return Math.sqrt(variance);
}

// ============================================================
// SWITCHING
// ============================================================

function switchingAnalysis(sequence) {
  let switches = 0;
  let transitions = 0;

  for (let i = 1; i < sequence.length; i++) {
    transitions++;

    if (sequence[i] !== sequence[i - 1]) {
      switches++;
    }
  }

  const rate = percentage(switches, transitions);

  let classification = "STREAK DOMINANT";

  if (rate > 60) {
    classification = "HIGH SWITCHING";
  } else if (rate >= 40) {
    classification = "BALANCED";
  }

  return {
    switches,
    transitions,
    switchRate: rate,
    classification
  };
}

// ============================================================
// ALTERNATION
// ============================================================

function alternationAnalysis(sequence) {
  if (sequence.length < 2) {
    return {
      length: 0,
      active: false,
      breakDetected: false
    };
  }

  let length = 1;

  for (
    let i = sequence.length - 1;
    i > 0;
    i--
  ) {
    if (
      sequence[i] !==
      sequence[i - 1]
    ) {
      length++;
    } else {
      break;
    }
  }

  const active = length >= 4;

  let breakDetected = false;

  if (!active && sequence.length >= 5) {
    const recent = sequence.slice(-6);

    let alternating = true;

    for (let i = 1; i < recent.length; i++) {
      if (recent[i] === recent[i - 1]) {
        alternating = false;
        break;
      }
    }

    if (
      alternating &&
      sequence.length >= 7 &&
      sequence[sequence.length - 1] ===
        sequence[sequence.length - 2]
    ) {
      breakDetected = true;
    }
  }

  return {
    length,
    active,
    breakDetected
  };
}

// ============================================================
// RUN-LENGTH ANALYSIS
// ============================================================

function buildRuns(sequence) {
  const runs = [];

  if (!sequence.length) return runs;

  let current = sequence[0];
  let count = 1;

  for (let i = 1; i < sequence.length; i++) {
    if (sequence[i] === current) {
      count++;
    } else {
      runs.push({
        type: current,
        length: count
      });

      current = sequence[i];
      count = 1;
    }
  }

  runs.push({
    type: current,
    length: count
  });

  return runs;
}

function runPatternAnalysis(sequence) {
  const runs = buildRuns(sequence);

  const lengths = runs.map(x => x.length);

  const counts = {};

  for (const len of lengths) {
    counts[len] = (counts[len] || 0) + 1;
  }

  const mostCommonRunLength = lengths.length
    ? Number(
        Object.entries(counts)
          .sort((a, b) => b[1] - a[1])[0][0]
      )
    : 0;

  const lastLengths = lengths.slice(-6);

  const patterns = [];

  const knownPatterns = [
    "1-1",
    "2-2",
    "3-3",
    "1-2",
    "2-1",
    "1-2-3",
    "3-2-1"
  ];

  for (const pattern of knownPatterns) {
    const target = pattern
      .split("-")
      .map(Number);

    for (
      let i = 0;
      i <= lengths.length - target.length;
      i++
    ) {
      const part = lengths.slice(
        i,
        i + target.length
      );

      if (
        part.every(
          (v, idx) => v === target[idx]
        )
      ) {
        patterns.push(pattern);
        break;
      }
    }
  }

  return {
    runs,
    runLengths: lengths,
    averageRunLength:
      Number(average(lengths).toFixed(2)),
    medianRunLength:
      Number(median(lengths).toFixed(2)),
    longestRun:
      lengths.length
        ? Math.max(...lengths)
        : 0,
    mostCommonRunLength,
    recentRunLengths: lastLengths,
    detectedPatterns: [
      ...new Set(patterns)
    ]
  };
}

// ============================================================
// REPEATING BLOCK DETECTOR
// ============================================================

function repeatingBlocks(sequence) {
  const results = [];

  const maxBlock = Math.min(
    6,
    Math.floor(sequence.length / 2)
  );

  for (
    let size = 2;
    size <= maxBlock;
    size++
  ) {
    const lastBlock =
      sequence.slice(-size);

    const previousBlock =
      sequence.slice(
        -size * 2,
        -size
      );

    if (
      lastBlock.length === size &&
      previousBlock.length === size &&
      lastBlock.join("") ===
        previousBlock.join("")
    ) {
      results.push({
        length: size,
        block: lastBlock.join(""),
        type: "REPEATING STRUCTURE"
      });
    }
  }

  return results;
}

// ============================================================
// FREQUENCY
// ============================================================

function frequencyAnalysis(sequence) {
  const total = sequence.length;

  const big = sequence.filter(
    x => x === "B"
  ).length;

  const small = total - big;

  const bigPct = percentage(big, total);
  const smallPct = percentage(small, total);

  const diff = Math.abs(bigPct - smallPct);

  let classification = "BALANCED";

  if (diff > 35) {
    classification = "STRONG HISTORICAL BIAS";
  } else if (diff >= 20) {
    classification = "MODERATE BIAS";
  } else if (diff >= 10) {
    classification = "WEAK BIAS";
  }

  return {
    big,
    small,
    total,
    bigPercent: bigPct,
    smallPercent: smallPct,
    difference: diff,
    classification
  };
}

// ============================================================
// MOMENTUM
// ============================================================

function momentumAnalysis(sequence) {
  if (sequence.length < 20) {
    return {
      available: false,
      bigMomentum: 0,
      smallMomentum: 0,
      classification: "INSUFFICIENT DATA"
    };
  }

  const latest = sequence.slice(-10);
  const previous = sequence.slice(-20, -10);

  const latestF = frequencyAnalysis(latest);
  const previousF = frequencyAnalysis(previous);

  const bigMomentum =
    latestF.bigPercent -
    previousF.bigPercent;

  const smallMomentum =
    latestF.smallPercent -
    previousF.smallPercent;

  const magnitude =
    Math.max(
      Math.abs(bigMomentum),
      Math.abs(smallMomentum)
    );

  let classification =
    "NO SIGNIFICANT SHIFT";

  if (magnitude > 35) {
    classification = "STRONG SHIFT";
  } else if (magnitude >= 20) {
    classification = "MODERATE SHIFT";
  } else if (magnitude >= 10) {
    classification = "WEAK SHIFT";
  }

  return {
    available: true,
    latest10: latestF,
    previous10: previousF,
    bigMomentum:
      Number(bigMomentum.toFixed(2)),
    smallMomentum:
      Number(smallMomentum.toFixed(2)),
    classification
  };
}

// ============================================================
// TRANSITION MATRIX
// ============================================================

function transitionMatrix(sequence) {
  let BB = 0;
  let BS = 0;
  let SB = 0;
  let SS = 0;

  for (let i = 1; i < sequence.length; i++) {
    const prev = sequence[i - 1];
    const curr = sequence[i];

    if (prev === "B" && curr === "B") BB++;
    if (prev === "B" && curr === "S") BS++;
    if (prev === "S" && curr === "B") SB++;
    if (prev === "S" && curr === "S") SS++;
  }

  const fromB = BB + BS;
  const fromS = SB + SS;

  return {
    counts: {
      BB,
      BS,
      SB,
      SS
    },
    probabilities: {
      P_B_given_B: percentage(BB, fromB),
      P_S_given_B: percentage(BS, fromB),
      P_B_given_S: percentage(SB, fromS),
      P_S_given_S: percentage(SS, fromS)
    }
  };
}

function transitionAnalysis(sequence) {
  const all = transitionMatrix(sequence);
  const recent20 = transitionMatrix(
    sequence.slice(-20)
  );

  const diffs = {
    P_B_given_B:
      Math.abs(
        all.probabilities.P_B_given_B -
        recent20.probabilities.P_B_given_B
      ),

    P_S_given_B:
      Math.abs(
        all.probabilities.P_S_given_B -
        recent20.probabilities.P_S_given_B
      ),

    P_B_given_S:
      Math.abs(
        all.probabilities.P_B_given_S -
        recent20.probabilities.P_B_given_S
      ),

    P_S_given_S:
      Math.abs(
        all.probabilities.P_S_given_S -
        recent20.probabilities.P_S_given_S
      )
  };

  const maxDifference =
    Math.max(...Object.values(diffs));

  return {
    allHistory: all,
    recent20,
    differences: diffs,
    regimeShift:
      maxDifference >= 15,
    maxDifference:
      Number(maxDifference.toFixed(2))
  };
}

// ============================================================
// DIGIT ANALYSIS
// ============================================================

function digitAnalysis(numbers) {
  const frequency = Array(10).fill(0);

  for (const n of numbers) {
    if (
      Number.isInteger(n) &&
      n >= 0 &&
      n <= 9
    ) {
      frequency[n]++;
    }
  }

  const total = numbers.length;

  const sorted = frequency
    .map((count, digit) => ({
      digit,
      count,
      percent: percentage(count, total)
    }))
    .sort((a, b) => b.count - a.count);

  const mostFrequent =
    sorted.length
      ? sorted[0]
      : null;

  const nonZero = sorted.filter(
    x => x.count > 0
  );

  const leastFrequent =
    nonZero.length
      ? nonZero[nonZero.length - 1]
      : null;

  const recent = numbers.slice(-5);

  const repeatedDigit =
    recent.length >= 2 &&
    recent[recent.length - 1] ===
      recent[recent.length - 2];

  const highCluster =
    recent.length >= 3 &&
    recent.slice(-3).every(n => n >= 6);

  const lowCluster =
    recent.length >= 3 &&
    recent.slice(-3).every(n => n <= 3);

  const avg =
    Number(average(numbers).toFixed(2));

  return {
    frequency,
    mostFrequentDigit: mostFrequent,
    leastFrequentDigit: leastFrequent,
    recentDigits: recent,
    repeatedDigit,
    highDigitCluster: highCluster,
    lowDigitCluster: lowCluster,
    averageDigit: avg,
    medianDigit: Number(
      median(numbers).toFixed(2)
    ),
    range:
      numbers.length
        ? {
            min: Math.min(...numbers),
            max: Math.max(...numbers)
          }
        : null
  };
}

// ============================================================
// GAP ANALYSIS
// ============================================================

function positionsOf(sequence, type) {
  const positions = [];

  for (let i = 0; i < sequence.length; i++) {
    if (sequence[i] === type) {
      positions.push(i);
    }
  }

  return positions;
}

function historicalGaps(sequence, type) {
  const positions = positionsOf(
    sequence,
    type
  );

  const gaps = [];

  for (let i = 1; i < positions.length; i++) {
    gaps.push(
      positions[i] -
        positions[i - 1] -
        1
    );
  }

  return gaps;
}

function gapAnalysis(sequence) {
  const result = {};

  for (const type of ["B", "S"]) {
    const positions = positionsOf(
      sequence,
      type
    );

    const gaps =
      historicalGaps(sequence, type);

    const lastPosition =
      positions.length
        ? positions[positions.length - 1]
        : -1;

    const currentGap =
      lastPosition === -1
        ? sequence.length
        : sequence.length -
          1 -
          lastPosition;

    const avgGap =
      average(gaps);

    const maxGap =
      gaps.length
        ? Math.max(...gaps)
        : 0;

    result[type] = {
      lastPosition,
      currentGap,
      averageHistoricalGap:
        Number(avgGap.toFixed(2)),
      maximumHistoricalGap: maxGap,
      gapAnomaly:
        gaps.length >= 3 &&
        currentGap >
          avgGap +
            Math.max(
              1,
              standardDeviation(gaps)
            )
    };
  }

  return result;
}

// ============================================================
// PATTERN BREAK
// ============================================================

function patternBreakAnalysis(sequence) {
  if (sequence.length < 6) {
    return {
      detected: false,
      type: null,
      description: null
    };
  }

  const recent6 =
    sequence.slice(-6);

  const last =
    sequence[sequence.length - 1];

  const beforeLast =
    sequence[sequence.length - 2];

  let detected = false;
  let description = null;

  // Streak break
  if (
    sequence.length >= 5 &&
    sequence
      .slice(-5, -1)
      .every(x => x === beforeLast) &&
    last !== beforeLast
  ) {
    detected = true;
    description = "STREAK PATTERN BREAK";
  }

  // Alternation break
  let alternating = true;

  for (let i = 1; i < recent6.length - 1; i++) {
    if (
      recent6[i] ===
      recent6[i - 1]
    ) {
      alternating = false;
      break;
    }
  }

  if (
    alternating &&
    last === beforeLast
  ) {
    detected = true;
    description =
      "ALTERNATION BREAK";
  }

  return {
    detected,
    type:
      detected
        ? "PATTERN BREAK"
        : null,
    description
  };
}

// ============================================================
// HISTORICAL REVERSAL SIMILARITY
// ============================================================

function historicalReversalSimilarity(sequence) {
  if (sequence.length < 12) {
    return {
      score: 0,
      matches: 0,
      successfulBreaks: 0
    };
  }

  const current =
    currentStreak(sequence);

  if (!current.type) {
    return {
      score: 0,
      matches: 0,
      successfulBreaks: 0
    };
  }

  const opposite =
    current.type === "B"
      ? "S"
      : "B";

  let matches = 0;
  let successfulBreaks = 0;

  const targetLength =
    current.length;

  for (
    let i = 1;
    i < sequence.length - 1;
    i++
  ) {
    if (
      sequence[i] === current.type &&
      sequence[i - 1] !== current.type
    ) {
      let len = 1;

      for (
        let j = i + 1;
        j < sequence.length;
        j++
      ) {
        if (
          sequence[j] ===
          current.type
        ) {
          len++;
        } else {
          break;
        }
      }

      if (
        Math.abs(
          len - targetLength
        ) <= 1
      ) {
        matches++;

        const breakIndex =
          i + len;

        if (
          breakIndex <
            sequence.length &&
          sequence[breakIndex] ===
            opposite
        ) {
          successfulBreaks++;
        }
      }
    }
  }

  let score = 0;

  if (matches >= 1) score = 1;
  if (matches >= 3) score = 2;
  if (
    matches >= 5 &&
    successfulBreaks >= 2
  ) {
    score = 3;
  }

  return {
    score,
    matches,
    successfulBreaks,
    currentType: current.type,
    currentLength: targetLength
  };
}

// ============================================================
// FAILED REVERSAL
// ============================================================

function failedReversalAnalysis(sequence) {
  if (sequence.length < 5) {
    return {
      count: 0,
      successfulPatternBreaks: 0,
      recentFailed: false
    };
  }

  let failed = 0;
  let successful = 0;

  // Look for:
  // BBBB -> S -> B
  // SSSS -> B -> S

  for (
    let i = 2;
    i < sequence.length;
    i++
  ) {
    const breakResult =
      sequence[i - 1];

    const before =
      sequence[i - 2];

    const after =
      sequence[i];

    if (
      breakResult !== before &&
      after === before
    ) {
      failed++;
    }

    if (
      breakResult !== before &&
      after === breakResult
    ) {
      successful++;
    }
  }

  const recentFailed =
    sequence.length >= 3 &&
    sequence[sequence.length - 2] !==
      sequence[sequence.length - 3] &&
    sequence[sequence.length - 1] ===
      sequence[sequence.length - 3];

  return {
    count: failed,
    successfulPatternBreaks: successful,
    recentFailed
  };
}

// ============================================================
// MULTI WINDOW AGREEMENT
// ============================================================

function multiWindowAgreement(sequence) {
  const sizes = [5, 10, 20, 30, 50];

  const votes = [];

  for (const size of sizes) {
    const data = getWindow(
      sequence,
      size
    );

    if (!data.length) continue;

    const f = frequencyAnalysis(data);

    if (f.bigPercent > f.smallPercent) {
      votes.push({
        size,
        type: "B"
      });
    } else if (
      f.smallPercent > f.bigPercent
    ) {
      votes.push({
        size,
        type: "S"
      });
    } else {
      votes.push({
        size,
        type: "BALANCED"
      });
    }
  }

  const bigVotes =
    votes.filter(
      x => x.type === "B"
    ).length;

  const smallVotes =
    votes.filter(
      x => x.type === "S"
    ).length;

  const usable =
    bigVotes + smallVotes;

  let status = "MIXED EVIDENCE";

  if (
    usable >= 3 &&
    Math.max(
      bigVotes,
      smallVotes
    ) >= 4
  ) {
    status = "HIGH RECENT CONSISTENCY";
  } else if (
    usable >= 3 &&
    Math.max(
      bigVotes,
      smallVotes
    ) >= 3
  ) {
    status = "MODERATE CONSISTENCY";
  }

  return {
    windows: votes,
    bigVotes,
    smallVotes,
    status
  };
}

// ============================================================
// RECENCY WEIGHTED SUPPORT
// ============================================================

function recencyWeightedSupport(sequence) {
  const configs = [
    [5, 0.35],
    [10, 0.25],
    [20, 0.20],
    [30, 0.12],
    [50, 0.08]
  ];

  let big = 0;
  let small = 0;
  let weightTotal = 0;

  for (const [size, weight] of configs) {
    const data =
      getWindow(sequence, size);

    if (!data.length) continue;

    const f =
      frequencyAnalysis(data);

    big +=
      f.bigPercent * weight;

    small +=
      f.smallPercent * weight;

    weightTotal += weight;
  }

  if (!weightTotal) {
    return {
      big: 50,
      small: 50
    };
  }

  return {
    big:
      Number(
        (big / weightTotal).toFixed(2)
      ),
    small:
      Number(
        (small / weightTotal).toFixed(2)
      )
  };
}

// ============================================================
// REVERSAL ENGINE
// ============================================================

function reversalEngine({
  sequence,
  streak,
  momentum,
  transitions,
  patternBreak,
  agreement,
  similarity,
  gaps
}) {
  const evidence = [];

  let R1 = 0;
  let R2 = 0;
  let R3 = 0;
  let R4 = 0;
  let R5 = 0;
  let R6 = 0;

  // ----------------------------------------------------------
  // R1 STREAK ANOMALY
  // ----------------------------------------------------------

  if (streak.anomaly) {
    R1 = 3;

    evidence.push({
      component: "R1",
      name: "STREAK ANOMALY",
      score: R1
    });
  } else if (
    streak.current.length >= 4
  ) {
    R1 = 1;

    evidence.push({
      component: "R1",
      name: "LONG CURRENT STREAK",
      score: R1
    });
  }

  // ----------------------------------------------------------
  // R2 MOMENTUM SHIFT
  // ----------------------------------------------------------

  if (momentum.available) {
    const magnitude =
      Math.max(
        Math.abs(momentum.bigMomentum),
        Math.abs(momentum.smallMomentum)
      );

    if (magnitude > 35) {
      R2 = 3;
    } else if (magnitude >= 20) {
      R2 = 2;
    } else if (magnitude >= 10) {
      R2 = 1;
    }

    if (R2) {
      evidence.push({
        component: "R2",
        name: "MOMENTUM SHIFT",
        score: R2
      });
    }
  }

  // ----------------------------------------------------------
  // R3 TRANSITION SHIFT
  // ----------------------------------------------------------

  if (transitions.regimeShift) {
    if (transitions.maxDifference >= 30) {
      R3 = 3;
    } else if (
      transitions.maxDifference >= 20
    ) {
      R3 = 2;
    } else {
      R3 = 1;
    }

    evidence.push({
      component: "R3",
      name: "TRANSITION REGIME SHIFT",
      score: R3
    });
  }

  // ----------------------------------------------------------
  // R4 PATTERN BREAK
  // ----------------------------------------------------------

  if (patternBreak.detected) {
    R4 = 2;

    if (
      patternBreak.description ===
      "STREAK PATTERN BREAK"
    ) {
      R4 = 3;
    }

    evidence.push({
      component: "R4",
      name: patternBreak.description,
      score: R4
    });
  }

  // ----------------------------------------------------------
  // R5 MULTI WINDOW
  // ----------------------------------------------------------

  if (
    agreement.status ===
    "HIGH RECENT CONSISTENCY"
  ) {
    R5 = 3;
  } else if (
    agreement.status ===
    "MODERATE CONSISTENCY"
  ) {
    R5 = 2;
  } else if (
    agreement.status ===
    "MIXED EVIDENCE"
  ) {
    R5 = 0;
  }

  if (R5) {
    evidence.push({
      component: "R5",
      name: "MULTI-WINDOW AGREEMENT",
      score: R5
    });
  }

  // ----------------------------------------------------------
  // R6 HISTORICAL SIMILARITY
  // ----------------------------------------------------------

  R6 = similarity.score;

  if (R6) {
    evidence.push({
      component: "R6",
      name: "HISTORICAL REVERSAL SIMILARITY",
      score: R6
    });
  }

  const total =
    R1 +
    R2 +
    R3 +
    R4 +
    R5 +
    R6;

  let status =
    "NO REVERSAL EVIDENCE";

  if (total >= 13) {
    status =
      "STRONG HISTORICAL REVERSAL SETUP";
  } else if (total >= 9) {
    status =
      "MODERATE REVERSAL WATCH";
  } else if (total >= 5) {
    status =
      "WEAK REVERSAL WATCH";
  }

  // Gap anomalies add supporting information
  const currentType =
    streak.current.type;

  const opposite =
    currentType === "B"
      ? "S"
      : "B";

  const gapInfo =
    gaps[opposite];

  if (
    gapInfo &&
    gapInfo.gapAnomaly
  ) {
    evidence.push({
      component: "GAP",
      name:
        `${opposite} GAP ANOMALY`,
      score: 1
    });
  }

  return {
    status,
    score: total,
    components: {
      R1,
      R2,
      R3,
      R4,
      R5,
      R6
    },
    evidence
  };
}

// ============================================================
// CONTRADICTION ENGINE
// ============================================================

function contradictionAnalysis({
  frequency,
  momentum,
  transitions,
  streak,
  agreement,
  reversal
}) {
  const votes = [];

  // Frequency
  if (
    frequency.bigPercent -
      frequency.smallPercent >=
    10
  ) {
    votes.push("B");
  } else if (
    frequency.smallPercent -
      frequency.bigPercent >=
    10
  ) {
    votes.push("S");
  }

  // Momentum
  if (
    momentum.available
  ) {
    if (
      momentum.bigMomentum >= 10
    ) {
      votes.push("B");
    }

    if (
      momentum.smallMomentum >= 10
    ) {
      votes.push("S");
    }
  }

  // Transition
  const last =
    streak.current.type;

  if (last === "B") {
    if (
      transitions.recent20
        .probabilities
        .P_B_given_B >
      transitions.recent20
        .probabilities
        .P_S_given_B
    ) {
      votes.push("B");
    } else {
      votes.push("S");
    }
  }

  if (last === "S") {
    if (
      transitions.recent20
        .probabilities
        .P_B_given_S >
      transitions.recent20
        .probabilities
        .P_S_given_S
    ) {
      votes.push("B");
    } else {
      votes.push("S");
    }
  }

  if (
    agreement.bigVotes >
    agreement.smallVotes
  ) {
    votes.push("B");
  } else if (
    agreement.smallVotes >
    agreement.bigVotes
  ) {
    votes.push("S");
  }

  const big =
    votes.filter(x => x === "B")
      .length;

  const small =
    votes.filter(x => x === "S")
      .length;

  const total = votes.length;

  const difference =
    total
      ? Math.abs(big - small)
      : 0;

  let level = "LOW";

  if (
    total >= 4 &&
    difference <= 1
  ) {
    level = "HIGH";
  } else if (
    total >= 3 &&
    difference <= 1
  ) {
    level = "MODERATE";
  }

  return {
    votes,
    big,
    small,
    total,
    level,
    penalty:
      level === "HIGH"
        ? 15
        : level === "MODERATE"
        ? 8
        : 0
  };
}

// ============================================================
// FINAL SUPPORT ENGINE
// ============================================================

function finalSupport({
  sequence,
  frequency,
  streak,
  switching,
  transitions,
  momentum,
  agreement,
  reversal,
  digit,
  gaps,
  contradiction
}) {
  // ----------------------------------------------------------
  // RECENT WINDOWS 20%
  // ----------------------------------------------------------

  const recent =
    recencyWeightedSupport(
      sequence
    );

  let big = recent.big * 0.20;
  let small = recent.small * 0.20;

  // ----------------------------------------------------------
  // FREQUENCY 15%
  // ----------------------------------------------------------

  big +=
    frequency.bigPercent *
    0.15;

  small +=
    frequency.smallPercent *
    0.15;

  // ----------------------------------------------------------
  // STREAK STRUCTURE 10%
  // ----------------------------------------------------------

  const current =
    streak.current;

  if (current.type === "B") {
    if (
      streak.anomaly
    ) {
      // anomaly gives some reversal support
      small += 70 * 0.10;
      big += 30 * 0.10;
    } else {
      big += 60 * 0.10;
      small += 40 * 0.10;
    }
  }

  if (current.type === "S") {
    if (
      streak.anomaly
    ) {
      big += 70 * 0.10;
      small += 30 * 0.10;
    } else {
      small += 60 * 0.10;
      big += 40 * 0.10;
    }
  }

  // ----------------------------------------------------------
  // SWITCHING 10%
  // ----------------------------------------------------------

  if (
    switching.switchRate >
    60
  ) {
    if (current.type === "B") {
      small += 65 * 0.10;
      big += 35 * 0.10;
    } else {
      big += 65 * 0.10;
      small += 35 * 0.10;
    }
  } else if (
    switching.switchRate < 40
  ) {
    if (current.type === "B") {
      big += 60 * 0.10;
      small += 40 * 0.10;
    } else {
      small += 60 * 0.10;
      big += 40 * 0.10;
    }
  } else {
    big += 50 * 0.10;
    small += 50 * 0.10;
  }

  // ----------------------------------------------------------
  // TRANSITION 15%
  // ----------------------------------------------------------

  const last =
    current.type;

  if (last === "B") {
    const pB =
      transitions.recent20
        .probabilities
        .P_B_given_B;

    const pS =
      transitions.recent20
        .probabilities
        .P_S_given_B;

    big += pB * 0.15;
    small += pS * 0.15;
  } else if (last === "S") {
    const pB =
      transitions.recent20
        .probabilities
        .P_B_given_S;

    const pS =
      transitions.recent20
        .probabilities
        .P_S_given_S;

    big += pB * 0.15;
    small += pS * 0.15;
  } else {
    big += 50 * 0.15;
    small += 50 * 0.15;
  }

  // ----------------------------------------------------------
  // MOMENTUM 10%
  // ----------------------------------------------------------

  if (momentum.available) {
    const bm =
      clamp(
        50 +
          momentum.bigMomentum,
        0,
        100
      );

    const sm =
      clamp(
        50 +
          momentum.smallMomentum,
        0,
        100
      );

    big += bm * 0.10;
    small += sm * 0.10;
  } else {
    big += 50 * 0.10;
    small += 50 * 0.10;
  }

  // ----------------------------------------------------------
  // PATTERN 10%
  // ----------------------------------------------------------

  if (
    agreement.bigVotes >
    agreement.smallVotes
  ) {
    big += 65 * 0.10;
    small += 35 * 0.10;
  } else if (
    agreement.smallVotes >
    agreement.bigVotes
  ) {
    small += 65 * 0.10;
    big += 35 * 0.10;
  } else {
    big += 50 * 0.10;
    small += 50 * 0.10;
  }

  // ----------------------------------------------------------
  // DIGIT/GAP 5%
  // ----------------------------------------------------------

  const recentDigits =
    digit.recentDigits;

  if (recentDigits.length) {
    const digitBig =
      recentDigits.filter(
        n => n >= 5
      ).length;

    const digitSmall =
      recentDigits.length -
      digitBig;

    big +=
      percentage(
        digitBig,
        recentDigits.length
      ) * 0.05;

    small +=
      percentage(
        digitSmall,
        recentDigits.length
      ) * 0.05;
  } else {
    big += 50 * 0.05;
    small += 50 * 0.05;
  }

  // ----------------------------------------------------------
  // REVERSAL 5%
  // ----------------------------------------------------------

  if (
    reversal.score >= 9 &&
    current.type === "B"
  ) {
    small += 70 * 0.05;
    big += 30 * 0.05;
  } else if (
    reversal.score >= 9 &&
    current.type === "S"
  ) {
    big += 70 * 0.05;
    small += 30 * 0.05;
  } else {
    big += 50 * 0.05;
    small += 50 * 0.05;
  }

  // ----------------------------------------------------------
  // CONTRADICTION PENALTY
  // ----------------------------------------------------------

  const penalty =
    contradiction.penalty;

  if (big > small) {
    big -= penalty;
  } else if (small > big) {
    small -= penalty;
  }

  big = clamp(big, 0, 100);
  small = clamp(small, 0, 100);

  const total = big + small;

  let bigNormalized = 50;
  let smallNormalized = 50;

  if (total > 0) {
    bigNormalized =
      (big / total) * 100;

    smallNormalized =
      (small / total) * 100;
  }

  return {
    big:
      Number(bigNormalized.toFixed(2)),
    small:
      Number(
        smallNormalized.toFixed(2)
      ),
    rawBig:
      Number(big.toFixed(2)),
    rawSmall:
      Number(small.toFixed(2))
  };
}

// ============================================================
// CONFIDENCE ENGINE
// ============================================================

function confidenceEngine({
  totalResults,
  support,
  contradiction,
  reversal,
  switching
}) {
  const edge =
    Math.abs(
      support.big -
      support.small
    );

  let confidence =
    50 + edge * 0.8;

  // Sample-size penalty
  if (totalResults < 10) {
    confidence -= 30;
  } else if (
    totalResults < 20
  ) {
    confidence -= 20;
  } else if (
    totalResults < 50
  ) {
    confidence -= 10;
  }

  confidence -=
    contradiction.penalty;

  if (
    reversal.score >= 13
  ) {
    confidence -= 5;
  }

  confidence = clamp(
    Math.round(confidence),
    1,
    95
  );

  let level = "LOW";

  if (
    totalResults >= 50 &&
    confidence >= 82
  ) {
    level = "HIGH";
  } else if (
    totalResults >= 20 &&
    confidence >= 70
  ) {
    level = "MODERATE";
  }

  if (
    totalResults < 10
  ) {
    level = "VERY LOW";
  }

  if (
    edge < 7
  ) {
    level = "LOW";
  }

  return {
    value: confidence,
    level,
    edge:
      Number(edge.toFixed(2))
  };
}

// ============================================================
// FINAL CLASSIFICATION
// ============================================================

function finalClassification({
  totalResults,
  support,
  confidence,
  reversal,
  patternBreak,
  failedReversal,
  contradiction,
  agreement
}) {
  if (totalResults < 10) {
    return "INSUFFICIENT DATA";
  }

  if (
    contradiction.level === "HIGH"
  ) {
    return "MIXED / CONFLICTING";
  }

  if (
    failedReversal.recentFailed
  ) {
    return "FAILED REVERSAL";
  }

  if (
    reversal.score >= 13
  ) {
    return "REVERSAL WATCH";
  }

  if (
    patternBreak.detected
  ) {
    return "PATTERN BREAK";
  }

  const edge =
    Math.abs(
      support.big -
      support.small
    );

  if (edge < 7) {
    return "NO CLEAR SIGNAL";
  }

  if (edge < 15) {
    return "WEAK HISTORICAL BIAS";
  }

  if (edge < 25) {
    return "MODERATE HISTORICAL BIAS";
  }

  return "STRONG HISTORICAL BIAS";
}

// ============================================================
// COMPLETE ADVANCED ANALYSIS
// ============================================================

function analyzeNumbers(numbers) {
  const validNumbers =
    validateNumbers(numbers);

  const sequence =
    numbersToTypes(
      validNumbers
    );

  const totalResults =
    sequence.length;

  if (!totalResults) {
    return {
      totalResults: 0,
      confidence: "VERY LOW",
      warning: "NO VALID DATA"
    };
  }

  const frequency =
    frequencyAnalysis(
      sequence
    );

  const streak =
    streakAnalysis(
      sequence
    );

  const switching =
    switchingAnalysis(
      sequence
    );

  const alternation =
    alternationAnalysis(
      sequence
    );

  const runs =
    runPatternAnalysis(
      sequence
    );

  const patterns =
    repeatingBlocks(
      sequence
    );

  const momentum =
    momentumAnalysis(
      sequence
    );

  const transitions =
    transitionAnalysis(
      sequence
    );

  const digit =
    digitAnalysis(
      validNumbers
    );

  const gaps =
    gapAnalysis(
      sequence
    );

  const patternBreak =
    patternBreakAnalysis(
      sequence
    );

  const agreement =
    multiWindowAgreement(
      sequence
    );

  const similarity =
    historicalReversalSimilarity(
      sequence
    );

  const failedReversal =
    failedReversalAnalysis(
      sequence
    );

  const reversal =
    reversalEngine({
      sequence,
      streak,
      momentum,
      transitions,
      patternBreak,
      agreement,
      similarity,
      gaps
    });

  const contradiction =
    contradictionAnalysis({
      frequency,
      momentum,
      transitions,
      streak,
      agreement,
      reversal
    });

  const support =
    finalSupport({
      sequence,
      frequency,
      streak,
      switching,
      transitions,
      momentum,
      agreement,
      reversal,
      digit,
      gaps,
      contradiction
    });

  const confidence =
    confidenceEngine({
      totalResults,
      support,
      contradiction,
      reversal,
      switching
    });

  const classification =
    finalClassification({
      totalResults,
      support,
      confidence,
      reversal,
      patternBreak,
      failedReversal,
      contradiction,
      agreement
    });

  let prediction = null;

  if (support.big > support.small) {
    prediction = "BIG";
  } else if (
    support.small > support.big
  ) {
    prediction = "SMALL";
  }

  // No strong signal
  if (
    Math.abs(
      support.big -
      support.small
    ) < 7
  ) {
    prediction = null;
  }

  // Under 10 data should never create
  // strong prediction
  if (totalResults < 10) {
    prediction = null;
  }

  return {
    totalResults,

    current: {
      type: streak.current.type,
      label:
        typeToLabel(
          streak.current.type
        ),
      streak:
        streak.current.length
    },

    windows: {
      "5":
        windowStats(sequence, 5),
      "10":
        windowStats(sequence, 10),
      "20":
        windowStats(sequence, 20),
      "30":
        windowStats(sequence, 30),
      "50":
        windowStats(sequence, 50),
      "100":
        windowStats(sequence, 100)
    },

    frequency,

    switching,

    alternation,

    runs,

    patterns,

    transitions,

    momentum,

    digitAnalysis: digit,

    gapAnalysis: gaps,

    patternBreak,

    reversal,

    failedReversal,

    multiWindowAgreement:
      agreement,

    conflict: contradiction,

    historicalSupport: {
      big:
        support.big,
      small:
        support.small
    },

    prediction,

    confidence:
      confidence.level,

    confidenceValue:
      confidence.value,

    confidenceEdge:
      confidence.edge,

    classification,

    warning:
      totalResults < 20
        ? "LOW DATA"
        : totalResults < 50
        ? "MODERATE SAMPLE"
        : "STATISTICAL SAMPLE AVAILABLE",

    modelVersion:
      MODEL_VERSION,

    analyzedAt:
      now()
  };
}

// ============================================================
// TARGET ISSUE
// ============================================================

function resolveTargetIssue() {
  const history =
    providerState.history;

  if (!history.length) {
    return null;
  }

  const latestSettled =
    history[0].issueNumber;

  const current =
    providerState.currentIssue;

  if (
    current &&
    compareIssue(
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

// ============================================================
// PREDICTION RECORD SAVE
// ============================================================

async function savePrediction(
  targetIssue,
  analysis
) {
  if (!pool) return;

  if (!targetIssue) return;

  if (!analysis?.prediction) {
    return;
  }

  try {
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
        String(targetIssue),
        analysis.prediction,
        analysis.confidenceValue || 0,
        MODEL_VERSION,
        now()
      ]
    );
  } catch (error) {
    console.error(
      "[DB] prediction save:",
      error.message
    );
  }
}

// ============================================================
// SETTLE PREDICTIONS
// ============================================================

async function settlePredictions() {
  if (!pool) return;

  const history =
    providerState.history;

  if (!history.length) return;

  for (const row of history.slice(0, 100)) {
    try {
      const actualNumber =
        Number(row.number);

      const actualResult =
        numberToType(
          actualNumber
        );

      if (!actualResult) continue;

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
          actualResult,
          now(),
          String(
            row.issueNumber
          )
        ]
      );
    } catch (error) {
      console.error(
        "[DB] settlement:",
        error.message
      );
    }
  }
}

// ============================================================
// GENERATE MODEL
// ============================================================

async function generateModel() {
  const history =
    providerState.history;

  const numbers =
    history
      .map(row =>
        Number(row.number)
      )
      .filter(n =>
        Number.isInteger(n) &&
        n >= 0 &&
        n <= 9
      )
      .reverse();

  /*
    WingoBot history normally comes newest-first.
    The engine receives chronological order:
    oldest -> newest
  */

  const analysis =
    analyzeNumbers(numbers);

  const targetIssue =
    resolveTargetIssue();

  const generatedAt =
    now();

  modelCache = {
    targetIssue,
    prediction: {
      targetIssue,
      prediction:
        analysis.prediction,
      confidence:
        analysis.confidenceValue,
      confidenceLevel:
        analysis.confidence,
      classification:
        analysis.classification,
      reason:
        buildPredictionReason(
          analysis
        ),
      modelVersion:
        MODEL_VERSION,
      generatedAt,
      statisticalSupport:
        analysis.historicalSupport,
      agreement:
        analysis.multiWindowAgreement,
      evidenceConflict:
        analysis.conflict,
      analysis,
      warning:
        analysis.warning
    },
    generatedAt
  };

  await savePrediction(
    targetIssue,
    analysis
  );

  return modelCache;
}

// ============================================================
// REASON GENERATOR
// ============================================================

function buildPredictionReason(
  analysis
) {
  const parts = [];

  if (
    analysis.current?.streak >= 3
  ) {
    parts.push(
      `${analysis.current.label} streak ${analysis.current.streak}`
    );
  }

  if (
    analysis.momentum?.classification &&
    analysis.momentum.classification !==
      "NO SIGNIFICANT SHIFT"
  ) {
    parts.push(
      analysis.momentum.classification
    );
  }

  if (
    analysis.transitions?.regimeShift
  ) {
    parts.push(
      "transition regime shift"
    );
  }

  if (
    analysis.reversal?.score >= 5
  ) {
    parts.push(
      `reversal evidence ${analysis.reversal.score}/18`
    );
  }

  if (
    analysis.patternBreak?.detected
  ) {
    parts.push(
      "pattern break detected"
    );
  }

  if (
    analysis.multiWindowAgreement?.status
  ) {
    parts.push(
      analysis.multiWindowAgreement.status
    );
  }

  if (!parts.length) {
    return "Multiple historical signals analyzed.";
  }

  return parts.join(" • ");
}

// ============================================================
// ACCESS KEY AUTH
// ============================================================

function getAccessKey(req) {
  return String(
    req.headers["x-access-key"] || ""
  ).trim();
}

function getDeviceId(req) {
  return String(
    req.headers["x-device-id"] || ""
  ).trim();
}

function getAdminKey(req) {
  return String(
    req.headers["x-admin-key"] || ""
  ).trim();
}

async function validateAccess(req) {
  const key =
    getAccessKey(req);

  const device =
    getDeviceId(req);

  if (!key || !device) {
    return {
      ok: false,
      error: "ACCESS_KEY_OR_DEVICE_MISSING"
    };
  }

  if (!pool) {
    return {
      ok: false,
      error: "DATABASE_DISABLED"
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
      error: "INVALID_ACCESS_KEY"
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
      error: "KEY_ALREADY_BOUND"
    };
  }

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
    key: row.access_key,
    id: row.id
  };
}

function requireAdmin(req) {
  if (!ADMIN_KEY) {
    return false;
  }

  return (
    getAdminKey(req) ===
    ADMIN_KEY
  );
}

// ============================================================
// ADMIN APIs
// ============================================================

async function adminKeysList(res) {
  if (!pool) {
    json(res, 500, {
      ok: false,
      error: "DATABASE_DISABLED"
    });
    return;
  }

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
    keys: result.rows
  });
}

async function adminKeysCreate(
  req,
  res
) {
  if (!pool) {
    json(res, 500, {
      ok: false,
      error: "DATABASE_DISABLED"
    });
    return;
  }

  const body =
    await readBody(req);

  const requestedKey =
    String(
      body?.key ||
      body?.access_key ||
      ""
    ).trim();

  const key =
    requestedKey ||
    randomKey();

  try {
    const result =
      await pool.query(
        `
        INSERT INTO access_keys
        (
          access_key,
          created_at,
          last_seen
        )
        VALUES ($1,$2,0)
        RETURNING *
        `,
        [
          key,
          now()
        ]
      );

    json(res, 200, {
      ok: true,
      key: result.rows[0].access_key,
      access_key:
        result.rows[0].access_key,
      row: result.rows[0]
    });
  } catch (error) {
    json(res, 400, {
      ok: false,
      error:
        error.code === "23505"
          ? "KEY_ALREADY_EXISTS"
          : error.message
    });
  }
}

async function adminKeysDelete(
  req,
  res,
  url
) {
  if (!pool) {
    json(res, 500, {
      ok: false,
      error: "DATABASE_DISABLED"
    });
    return;
  }

  const body =
    req.method === "DELETE"
      ? await readBody(req)
      : {};

  const id =
    url.searchParams.get("id") ||
    body?.id;

  const key =
    url.searchParams.get("key") ||
    body?.key;

  if (!id && !key) {
    json(res, 400, {
      ok: false,
      error: "ID_OR_KEY_REQUIRED"
    });
    return;
  }

  let result;

  if (id) {
    result =
      await pool.query(
        `
        DELETE FROM access_keys
        WHERE id = $1
        RETURNING id, access_key
        `,
        [Number(id)]
      );
  } else {
    result =
      await pool.query(
        `
        DELETE FROM access_keys
        WHERE access_key = $1
        RETURNING id, access_key
        `,
        [String(key)]
      );
  }

  json(res, 200, {
    ok: true,
    deleted:
      result.rows[0] || null
  });
}

async function adminResetDevice(
  req,
  res
) {
  if (!pool) {
    json(res, 500, {
      ok: false,
      error: "DATABASE_DISABLED"
    });
    return;
  }

  const body =
    await readBody(req);

  const id =
    body?.id;

  const key =
    body?.key ||
    body?.access_key;

  if (!id && !key) {
    json(res, 400, {
      ok: false,
      error: "ID_OR_KEY_REQUIRED"
    });
    return;
  }

  let result;

  if (id) {
    result =
      await pool.query(
        `
        UPDATE access_keys
        SET device_id = NULL
        WHERE id = $1
        RETURNING id, access_key, device_id
        `,
        [Number(id)]
      );
  } else {
    result =
      await pool.query(
        `
        UPDATE access_keys
        SET device_id = NULL
        WHERE access_key = $1
        RETURNING id, access_key, device_id
        `,
        [String(key)]
      );
  }

  json(res, 200, {
    ok: true,
    row:
      result.rows[0] || null
  });
}

// ============================================================
// ADMIN STATUS
// ============================================================

async function adminStatus(res) {
  json(res, 200, {
    ok: true,
    serverTime: now(),
    modelVersion: MODEL_VERSION,
    provider: {
      ok: providerState.ok,
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
    },
    model: modelCache
  });
}

// ============================================================
// ADMIN PING
// ============================================================

function adminPing(res) {
  json(res, 200, {
    ok: true,
    message: "PONG",
    time: now(),
    modelVersion:
      MODEL_VERSION
  });
}

// ============================================================
// ADMIN WINGOBOT TEST
// ============================================================

async function adminWingoTest(res) {
  const state =
    await refreshProvider();

  json(res, 200, {
    ok: state.ok,
    currentIssue:
      state.currentIssue,
    historyCount:
      state.history.length,
    fetched:
      state.fetched,
    lastUpdated:
      state.lastUpdated,
    error:
      state.error,
    sample:
      state.history.slice(0, 5)
  });
}

// ============================================================
// ADMIN MODEL TEST
// ============================================================

async function adminModelTest(res) {
  await refreshProvider();

  await settlePredictions();

  const model =
    await generateModel();

  json(res, 200, {
    ok: true,
    targetIssue:
      model.targetIssue,
    prediction:
      model.prediction
  });
}

// ============================================================
// HISTORY API
// ============================================================

async function predictionHistory(res) {
  if (!pool) {
    json(res, 200, {
      ok: true,
      records: []
    });
    return;
  }

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
      LIMIT 100
      `
    );

  json(res, 200, {
    ok: true,
    records: result.rows
  });
}

// ============================================================
// STATE API
// ============================================================

async function stateApi(
  req,
  res
) {
  const auth =
    await validateAccess(req);

  if (!auth.ok) {
    json(res, 401, auth);
    return;
  }

  await refreshProvider();

  await settlePredictions();

  const targetIssue =
    resolveTargetIssue();

  // Rebuild model if target changed
  // or cache is stale
  if (
    !modelCache.prediction ||
    modelCache.targetIssue !==
      targetIssue ||
    now() -
      modelCache.generatedAt >
      10000
  ) {
    await generateModel();
  }

  const providerHistory =
    providerState.history
      .slice(0, 30)
      .map(row => ({
        issue:
          row.issueNumber,
        number:
          Number(row.number),
        type:
          numberToType(
            Number(row.number)
          ),
        label:
          typeToLabel(
            numberToType(
              Number(row.number)
            )
          )
      }));

  json(res, 200, {
    ok: true,

    serverTime: now(),

    provider: {
      ok: providerState.ok,
      currentIssue:
        providerState.currentIssue,
      historyCount:
        providerState.history.length,
      lastUpdated:
        providerState.lastUpdated,
      error:
        providerState.error
    },

    targetIssue,

    thinkingDurationMs:
      THINKING_DURATION_MS,

    prediction:
      modelCache.prediction,

    history:
      providerHistory
  });
}

// ============================================================
// KEY CHECK API
// ============================================================

async function keyCheck(
  req,
  res
) {
  const auth =
    await validateAccess(req);

  if (!auth.ok) {
    json(res, 401, auth);
    return;
  }

  json(res, 200, {
    ok: true,
    valid: true,
    key: auth.key,
    id: auth.id,
    modelVersion:
      MODEL_VERSION
  });
}

// ============================================================
// HEALTH
// ============================================================

function health(res) {
  json(res, 200, {
    ok: true,
    service: "DY AI WINGO",
    modelVersion:
      MODEL_VERSION,
    time: now(),
    providerOk:
      providerState.ok
  });
}

// ============================================================
// STATIC FILE SERVER
// ============================================================

function contentType(filePath) {
  const ext =
    path.extname(filePath)
      .toLowerCase();

  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".mp3": "audio/mpeg",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon"
  };

  return (
    types[ext] ||
    "application/octet-stream"
  );
}

function serveStatic(
  req,
  res,
  pathname
) {
  let requested =
    pathname === "/"
      ? "/prediction.html"
      : pathname;

  requested =
    decodeURIComponent(
      requested
    );

  const filePath =
    path.resolve(
      PUBLIC_DIR,
      "." + requested
    );

  if (
    !filePath.startsWith(
      path.resolve(PUBLIC_DIR)
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
    (error, stats) => {
      if (error || !stats.isFile()) {
        text(
          res,
          404,
          "Not Found"
        );
        return;
      }

      const type =
        contentType(filePath);

      // MP3 range support
      if (
        type === "audio/mpeg" &&
        req.headers.range
      ) {
        const range =
          req.headers.range;

        const match =
          range.match(
            /bytes=(\d*)-(\d*)/
          );

        if (!match) {
          text(
            res,
            416,
            "Invalid range"
          );
          return;
        }

        const size =
          stats.size;

        let start =
          match[1]
            ? Number(match[1])
            : 0;

        let end =
          match[2]
            ? Number(match[2])
            : size - 1;

        if (
          start >= size ||
          end >= size
        ) {
          end = size - 1;
        }

        if (start > end) {
          text(
            res,
            416,
            "Invalid range"
          );
          return;
        }

        res.writeHead(206, {
          "Content-Type": type,
          "Content-Range":
            `bytes ${start}-${end}/${size}`,
          "Accept-Ranges": "bytes",
          "Content-Length":
            end - start + 1
        });

        fs.createReadStream(
          filePath,
          { start, end }
        ).pipe(res);

        return;
      }

      res.writeHead(200, {
        "Content-Type": type,
        "Cache-Control":
          "no-cache"
      });

      fs.createReadStream(
        filePath
      ).pipe(res);
    }
  );
}

// ============================================================
// ROUTER
// ============================================================

const server =
  http.createServer(
    async (req, res) => {
      try {
        if (
          req.method === "OPTIONS"
        ) {
          res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers":
              "Content-Type, X-Access-Key, X-Device-Id, X-Admin-Key",
            "Access-Control-Allow-Methods":
              "GET, POST, DELETE, OPTIONS"
          });

          res.end();
          return;
        }

        const url =
          new URL(
            req.url,
            `http://${req.headers.host}`
          );

        const pathname =
          url.pathname;

        // ------------------------------
        // HEALTH
        // ------------------------------

        if (
          pathname === "/health"
        ) {
          health(res);
          return;
        }

        // ------------------------------
        // ACCESS KEY CHECK
        // ------------------------------

        if (
          pathname ===
            "/api/key/check" &&
          req.method === "GET"
        ) {
          await keyCheck(
            req,
            res
          );
          return;
        }

        // ------------------------------
        // STATE
        // ------------------------------

        if (
          pathname === "/api/state" &&
          req.method === "GET"
        ) {
          await stateApi(
            req,
            res
          );
          return;
        }

        // ------------------------------
        // HISTORY
        // ------------------------------

        if (
          pathname ===
            "/api/history" &&
          req.method === "GET"
        ) {
          const auth =
            await validateAccess(
              req
            );

          if (!auth.ok) {
            json(res, 401, auth);
            return;
          }

          await predictionHistory(
            res
          );

          return;
        }

        // ------------------------------
        // ADMIN AUTH
        // ------------------------------

        if (
          pathname.startsWith(
            "/api/admin/"
          )
        ) {
          if (!requireAdmin(req)) {
            json(res, 401, {
              ok: false,
              error: "ADMIN_UNAUTHORIZED"
            });
            return;
          }
        }

        // ------------------------------
        // ADMIN STATUS
        // ------------------------------

        if (
          pathname ===
            "/api/admin/status" &&
          req.method === "GET"
        ) {
          await adminStatus(res);
          return;
        }

        // ------------------------------
        // ADMIN PING
        // ------------------------------

        if (
          pathname ===
            "/api/admin/ping" &&
          req.method === "GET"
        ) {
          adminPing(res);
          return;
        }

        // ------------------------------
        // ADMIN WINGO TEST
        // ------------------------------

        if (
          pathname ===
            "/api/admin/wingo-test" &&
          req.method === "GET"
        ) {
          await adminWingoTest(
            res
          );
          return;
        }

        // ------------------------------
        // ADMIN MODEL TEST
        // ------------------------------

        if (
          pathname ===
            "/api/admin/model-test" &&
          req.method === "GET"
        ) {
          await adminModelTest(
            res
          );
          return;
        }

        // ------------------------------
        // ADMIN KEYS GET
        // ------------------------------

        if (
          pathname ===
            "/api/admin/keys" &&
          req.method === "GET"
        ) {
          await adminKeysList(
            res
          );
          return;
        }

        // ------------------------------
        // ADMIN KEYS CREATE
        // ------------------------------

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

        // ------------------------------
        // ADMIN KEYS DELETE
        // ------------------------------

        if (
          pathname ===
            "/api/admin/keys" &&
          req.method === "DELETE"
        ) {
          await adminKeysDelete(
            req,
            res,
            url
          );
          return;
        }

        // ------------------------------
        // RESET DEVICE
        // ------------------------------

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

        // ------------------------------
        // STATIC
        // ------------------------------

        serveStatic(
          req,
          res,
          pathname
        );
      } catch (error) {
        console.error(
          "[SERVER ERROR]",
          error
        );

        if (!res.headersSent) {
          json(res, 500, {
            ok: false,
            error:
              error.message ||
              "Internal server error"
          });
        } else {
          res.end();
        }
      }
    }
  );

// ============================================================
// BACKGROUND MODEL REFRESH
// ============================================================

async function backgroundRefresh() {
  try {
    await refreshProvider();

    await settlePredictions();

    const target =
      resolveTargetIssue();

    if (
      target &&
      (
        !modelCache.prediction ||
        modelCache.targetIssue !==
          target
      )
    ) {
      await generateModel();
    }
  } catch (error) {
    console.error(
      "[BACKGROUND]",
      error.message
    );
  }
}

// ============================================================
// START
// ============================================================

async function start() {
  try {
    await initDatabase();

    await refreshProvider();

    await settlePredictions();

    await generateModel();

    server.listen(
      PORT,
      "0.0.0.0",
      () => {
        console.log(
          `DY AI WINGO running on port ${PORT}`
        );

        console.log(
          `MODEL: ${MODEL_VERSION}`
        );

        console.log(
          `Provider history: ${providerState.history.length}`
        );

        console.log(
          `Target issue: ${modelCache.targetIssue}`
        );

        console.log(
          `Prediction: ${
            modelCache.prediction?.prediction ||
            "NO CLEAR SIGNAL"
          }`
        );
      }
    );

    setInterval(
      backgroundRefresh,
      PROVIDER_REFRESH_MS
    );
  } catch (error) {
    console.error(
      "[STARTUP ERROR]",
      error
    );

    process.exit(1);
  }
}

// ============================================================
// PROCESS HANDLERS
// ============================================================

process.on(
  "unhandledRejection",
  error => {
    console.error(
      "[UNHANDLED REJECTION]",
      error
    );
  }
);

process.on(
  "uncaughtException",
  error => {
    console.error(
      "[UNCAUGHT EXCEPTION]",
      error
    );
  }
);

start();
