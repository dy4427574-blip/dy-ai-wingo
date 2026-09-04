const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = process.env.PORT || 10000;

const ADMIN_KEY =
  process.env.ADMIN_KEY || "dy4427574";

const WINGOBOT_TOKEN =
  process.env.WINGOBOT_TOKEN || "";

const GAME_URL =
  "https://www.shreewin38.com/#/register?invitationCode=88523152383";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});

const ROOT = __dirname;

let state = {
  history: [],
  currentIssue: "",
  targetIssue: "",
  providerLastUpdated: 0,
  fetched: 0,
  error: "",
  lastRefresh: 0
};


/* =====================================================
   DATABASE
===================================================== */

async function initDatabase() {

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
}


/* =====================================================
   HELPERS
===================================================== */

function sendJSON(res, status, data) {

  const body = JSON.stringify(data);

  res.writeHead(status, {
    "Content-Type":
      "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });

  res.end(body);
}


function getNow() {
  return Date.now();
}


function incrementIssue(issue) {

  const value = String(issue || "");

  if (!/^\d+$/.test(value)) {
    return "";
  }

  const result =
    BigInt(value) + 1n;

  return result
    .toString()
    .padStart(value.length, "0");
}


function resultFromNumber(number) {

  const n = Number(number);

  if (
    !Number.isInteger(n) ||
    n < 0 ||
    n > 9
  ) {
    return "";
  }

  return n >= 5
    ? "BIG"
    : "SMALL";
}


function normalizeResult(value) {

  const x =
    String(value ?? "")
      .trim()
      .toUpperCase();

  if (x === "BIG") return "BIG";
  if (x === "SMALL") return "SMALL";

  return "";
}


function readBody(req) {

  return new Promise((resolve, reject) => {

    let body = "";

    req.on("data", chunk => {

      body += chunk;

      if (body.length > 1024 * 1024) {

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
        resolve({});
      }

    });

    req.on("error", reject);

  });
}


/* =====================================================
   WINGOBOT
===================================================== */

async function fetchGameData() {

  if (!WINGOBOT_TOKEN) {

    throw new Error(
      "WINGOBOT_TOKEN is not configured"
    );
  }

  const response =
    await fetch(
      "https://api.wingobot.com/v2/30-sec-game-history",
      {
        method: "GET",
        headers: {
          Authorization:
            `Bearer ${WINGOBOT_TOKEN}`,
          Accept: "application/json"
        }
      }
    );

  if (!response.ok) {

    throw new Error(
      `WingoBot API HTTP ${response.status}`
    );
  }

  const data =
    await response.json();

  const history =
    Array.isArray(data.history)
      ? data.history
      : [];

  return {
    currentIssue:
      data.current?.issueNumber
        ? String(data.current.issueNumber)
        : "",

    history,

    fetched:
      Number(
        data.stats?.fetched ||
        history.length ||
        0
      ),

    lastUpdated:
      Number(
        data.stats?.last_updated ||
        0
      )
  };
}


/* =====================================================
   NORMALIZE HISTORY
===================================================== */

function normalizeHistory(history) {

  return history
    .map(item => {

      const issue =
        item.issueNumber ??
        item.issue ??
        item.period ??
        "";

      const number =
        item.number ??
        null;

      let result =
        normalizeResult(item.result);

      if (!result) {

        result =
          normalizeResult(item.colour);
      }

      if (
        !result &&
        number !== null
      ) {

        result =
          resultFromNumber(number);
      }

      return {
        issue: String(issue),
        number:
          Number.isInteger(Number(number))
            ? Number(number)
            : null,
        result
      };

    })
    .filter(item =>
      item.issue &&
      item.result
    );
}


/* =====================================================
   MODEL SIGNALS
===================================================== */

function recentSignal(rows, limit = 12) {

  const data =
    rows.slice(0, limit);

  if (!data.length) {
    return 0;
  }

  let score = 0;
  let max = 0;

  for (
    let i = 0;
    i < data.length;
    i++
  ) {

    const weight =
      data.length - i;

    max += weight;

    if (data[i].result === "BIG") {
      score += weight;
    } else {
      score -= weight;
    }
  }

  return max
    ? score / max
    : 0;
}


function windowSignal(rows, limit) {

  const data =
    rows.slice(0, limit);

  if (!data.length) {
    return 0;
  }

  let big = 0;
  let small = 0;

  for (const item of data) {

    if (item.result === "BIG") {
      big++;
    }

    if (item.result === "SMALL") {
      small++;
    }
  }

  const total =
    big + small;

  if (!total) {
    return 0;
  }

  return (big - small) / total;
}


function transitionSignal(rows) {

  if (rows.length < 2) {
    return 0;
  }

  let BB = 0;
  let BS = 0;
  let SB = 0;
  let SS = 0;

  for (
    let i = 0;
    i < rows.length - 1;
    i++
  ) {

    const current =
      rows[i].result;

    const previous =
      rows[i + 1].result;

    if (
      previous === "BIG" &&
      current === "BIG"
    ) {
      BB++;
    }

    if (
      previous === "BIG" &&
      current === "SMALL"
    ) {
      BS++;
    }

    if (
      previous === "SMALL" &&
      current === "BIG"
    ) {
      SB++;
    }

    if (
      previous === "SMALL" &&
      current === "SMALL"
    ) {
      SS++;
    }
  }

  let score = 0;

  const bigTotal =
    BB + BS;

  const smallTotal =
    SB + SS;

  if (bigTotal) {

    score +=
      (BB - BS) /
      bigTotal;
  }

  if (smallTotal) {

    score +=
      (SB - SS) /
      smallTotal;
  }

  return Math.max(
    -1,
    Math.min(1, score / 2)
  );
}


function getStreak(rows) {

  if (!rows.length) {

    return {
      result: "",
      length: 0
    };
  }

  const result =
    rows[0].result;

  let length = 0;

  for (const row of rows) {

    if (row.result !== result) {
      break;
    }

    length++;
  }

  return {
    result,
    length
  };
}


function streakSignal(rows) {

  const streak =
    getStreak(rows);

  if (!streak.length) {
    return 0;
  }

  const strength =
    Math.min(
      streak.length,
      6
    ) / 6;

  return streak.result === "BIG"
    ? strength
    : -strength;
}


function alternationSignal(rows) {

  if (rows.length < 4) {
    return 0;
  }

  let changes = 0;
  let total = 0;

  for (
    let i = 0;
    i < rows.length - 1;
    i++
  ) {

    if (
      rows[i].result !==
      rows[i + 1].result
    ) {
      changes++;
    }

    total++;
  }

  if (!total) {
    return 0;
  }

  const ratio =
    changes / total;

  if (ratio >= 0.70) {

    return rows[0].result === "BIG"
      ? -0.45
      : 0.45;
  }

  return 0;
}


function consistencySignal(rows) {

  const data =
    rows.slice(0, 15);

  if (data.length < 5) {
    return 0;
  }

  let big = 0;

  for (const row of data) {

    if (row.result === "BIG") {
      big++;
    }
  }

  const ratio =
    big / data.length;

  if (ratio >= 0.70) {
    return 0.45;
  }

  if (ratio <= 0.30) {
    return -0.45;
  }

  return 0;
}


function changePointSignal(rows) {

  if (rows.length < 10) {
    return 0;
  }

  const recent =
    rows.slice(0, 5);

  const older =
    rows.slice(5, 10);

  const recentScore =
    windowSignal(recent, 5);

  const olderScore =
    windowSignal(older, 5);

  return Math.max(
    -0.6,
    Math.min(
      0.6,
      recentScore - olderScore
    )
  );
}


/* =====================================================
   AI MODEL
===================================================== */

function calculatePrediction(rows) {

  if (rows.length < 5) {

    return {
      prediction: "BIG",
      confidence: 50,
      reason: "Collecting history",
      regime: "WARMUP"
    };
  }

  const recent =
    recentSignal(rows, 12);

  const five =
    windowSignal(rows, 5);

  const fifteen =
    windowSignal(rows, 15);

  const forty =
    windowSignal(rows, 40);

  const transition =
    transitionSignal(rows);

  const streakScore =
    streakSignal(rows);

  const alternation =
    alternationSignal(rows);

  const consistency =
    consistencySignal(rows);

  const changePoint =
    changePointSignal(rows);

  let score =
      recent * 0.28
    + five * 0.18
    + fifteen * 0.13
    + forty * 0.08
    + transition * 0.12
    + streakScore * 0.07
    + alternation * 0.05
    + consistency * 0.05
    + changePoint * 0.04;


  const streak =
    getStreak(rows);


  /*
    Long streak ko blindly follow
    karne se bachne ke liye damping.
  */

  if (streak.length >= 4) {

    if (
      streak.result === "BIG" &&
      score > 0
    ) {
      score *= 0.72;
    }

    if (
      streak.result === "SMALL
