"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

/* =========================================================
   CONFIG
========================================================= */

const PORT = Number(process.env.PORT || 10000);

const DATABASE_URL =
  process.env.DATABASE_URL || "";

const ADMIN_KEY =
  process.env.ADMIN_KEY || "dy4427574";

const LIVE_API_URL =
  process.env.LIVE_API_URL || "";

const LIVE_API_TOKEN =
  process.env.LIVE_API_TOKEN || "";

const WINGOBOT_URL =
  process.env.WINGOBOT_URL ||
  "https://api.wingobot.com/v2/30-sec-game-history";

const WINGOBOT_TOKEN =
  process.env.WINGOBOT_TOKEN || "";

const POLL =
  Math.max(1000, Number(process.env.POLL || 1000));

const COOLDOWN =
  Math.max(0, Number(process.env.COOLDOWN || 5));

const MODEL =
  process.env.MODEL ||
  "DY-AI-LIVE-V4";

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: {
        rejectUnauthorized: false
      }
    })
  : null;

/* =========================================================
   DATABASE
========================================================= */

async function initDB() {
  if (!pool) {
    console.log(
      "DATABASE_URL not configured."
    );
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
    CREATE INDEX IF NOT EXISTS
    idx_prediction_target
    ON prediction_records(target_issue)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    idx_prediction_created
    ON prediction_records(created_at)
  `);

  console.log(
    "PostgreSQL database ready."
  );
}

/* =========================================================
   HELPERS
========================================================= */

function json(res, status, data) {
  const body =
    JSON.stringify(data);

  res.writeHead(status, {
    "Content-Type":
      "application/json; charset=utf-8",

    "Cache-Control":
      "no-store, no-cache, must-revalidate",

    "Access-Control-Allow-Origin":
      "*",

    "Access-Control-Allow-Headers":
      "Content-Type, Authorization",

    "Access-Control-Allow-Methods":
      "GET,POST,OPTIONS"
  });

  res.end(body);
}

function text(res, status, body) {
  res.writeHead(status, {
    "Content-Type":
      "text/plain; charset=utf-8",

    "Cache-Control":
      "no-store"
  });

  res.end(body);
}

function now() {
  return Date.now();
}

function isDigitNumber(n) {
  return (
    Number.isInteger(n) &&
    n >= 0 &&
    n <= 9
  );
}

function resultOf(n) {
  if (!isDigitNumber(n)) {
    return null;
  }

  return n <= 4
    ? "SMALL"
    : "BIG";
}

/* =========================================================
   LARGE ISSUE ID SAFE HANDLING
========================================================= */

function normalizeIssue(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return "";
  }

  return String(value).trim();
}

function compareIssue(a, b) {
  a = normalizeIssue(a);
  b = normalizeIssue(b);

  if (
    /^\d+$/.test(a) &&
    /^\d+$/.test(b)
  ) {
    try {
      const A = BigInt(a);
      const B = BigInt(b);

      if (A < B) return -1;
      if (A > B) return 1;
      return 0;
    } catch (_) {}
  }

  return a.localeCompare(
    b,
    undefined,
    {
      numeric: true
    }
  );
}

function nextIssue(issue) {
  issue = normalizeIssue(issue);

  if (!/^\d+$/.test(issue)) {
    return "";
  }

  try {
    return (
      BigInt(issue) + 1n
    ).toString();
  } catch (_) {
    return "";
  }
}

/* =========================================================
   GENERIC FETCH
========================================================= */

async function fetchJSON(
  url,
  headers = {}
) {
  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () => controller.abort(),
      8000
    );

  try {
    const response =
      await fetch(url, {
        method: "GET",
        headers,
        signal:
          controller.signal
      });

    const text =
      await response.text();

    let data;

    try {
      data =
        JSON.parse(text);
    } catch (_) {
      throw new Error(
        "INVALID_JSON"
      );
    }

    if (!response.ok) {
      throw new Error(
        "HTTP_" +
        response.status
      );
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}

/* =========================================================
   NORMALIZER
========================================================= */

function pick(obj, keys) {
  for (const key of keys) {
    if (
      obj &&
      obj[key] !== undefined &&
      obj[key] !== null
    ) {
      return obj[key];
    }
  }

  return null;
}

function normalizeRow(row) {
  if (!row || typeof row !== "object") {
    return null;
  }

  const issue = normalizeIssue(
    pick(row, [
      "issueNumber",
      "issue",
      "period",
      "periodNumber",
      "drawNumber",
      "draw_id",
      "id"
    ])
  );

  let rawNumber =
    pick(row, [
      "number",
      "result",
      "digit",
      "openNumber",
      "winningNumber"
    ]);

  if (
    typeof rawNumber === "string"
  ) {
    const match =
      rawNumber.match(/\d/);

    if (match) {
      rawNumber =
        Number(match[0]);
    }
  }

  const number =
    Number(rawNumber);

  if (
    !issue ||
    !isDigitNumber(number)
  ) {
    return null;
  }

  return {
    issue,
    number,
    result:
      resultOf(number),

    colour:
      pick(row, [
        "colour",
        "color"
      ]),

    premium:
      pick(row, [
        "premium"
      ]),

    sum:
      pick(row, [
        "sum"
      ])
  };
}

/* =========================================================
   LIVE CACHE
========================================================= */

let liveCache = {
  rows: [],
  currentIssue: "",
  fetchedAt: 0,
  source: "NONE",
  error: null
};

/* =========================================================
   CUSTOM LIVE API
========================================================= */

async function fetchCustomLive() {
  if (!LIVE_API_URL) {
    throw new Error(
      "LIVE_API_URL_NOT_CONFIGURED"
    );
  }

  const headers = {};

  if (LIVE_API_TOKEN) {
    headers.Authorization =
      "Bearer " +
      LIVE_API_TOKEN;
  }

  const data =
    await fetchJSON(
      LIVE_API_URL,
      headers
    );

  const rawRows =
    Array.isArray(data)
      ? data
      : (
          data.history ||
          data.results ||
          data.data ||
          data.records ||
          []
        );

  const rows =
    rawRows
      .map(normalizeRow)
      .filter(Boolean)
      .sort(
        (a, b) =>
          compareIssue(
            a.issue,
            b.issue
          )
      );

  const current =
    normalizeIssue(
      data?.current?.issueNumber ||
      data?.currentIssue ||
      data?.issueNumber ||
      ""
    );

  if (!rows.length) {
    throw new Error(
      "CUSTOM_API_NO_RESULTS"
    );
  }

  return {
    rows,
    currentIssue:
      current ||
      rows[rows.length - 1].issue,
    source:
      "CUSTOM_API"
  };
}

/* =========================================================
   WINGOBOT
========================================================= */

async function fetchWingoBot() {
  if (!WINGOBOT_TOKEN) {
    throw new Error(
      "WINGOBOT_TOKEN_NOT_CONFIGURED"
    );
  }

  const data =
    await fetchJSON(
      WINGOBOT_URL,
      {
        Authorization:
          "Bearer " +
          WINGOBOT_TOKEN
      }
    );

  const rawRows =
    Array.isArray(data?.history)
      ? data.history
      : Array.isArray(data?.data)
      ? data.data
      : Array.isArray(data)
      ? data
      : [];

  const rows =
    rawRows
      .map(normalizeRow)
      .filter(Boolean)
      .sort(
        (a, b) =>
          compareIssue(
            a.issue,
            b.issue
          )
      );

  const current =
    normalizeIssue(
      data?.current?.issueNumber ||
      data?.currentIssue ||
      ""
    );

  if (!rows.length) {
    throw new Error(
      "WINGOBOT_NO_RESULTS"
    );
  }

  return {
    rows,
    currentIssue:
      current ||
      rows[rows.length - 1].issue,
    source:
      "WINGOBOT"
  };
}

/* =========================================================
   LIVE REFRESH
========================================================= */

async function refreshLive() {
  let data = null;
  let error = null;

  if (LIVE_API_URL) {
    try {
      data =
        await fetchCustomLive();
    } catch (e) {
      error =
        e.message;
    }
  }

  if (!data) {
    try {
      data =
        await fetchWingoBot();
      error = null;
    } catch (e) {
      error =
        error ||
        e.message;
    }
  }

  if (data) {
    liveCache = {
      rows:
        data.rows.slice(-500),
      currentIssue:
        data.currentIssue,
      fetchedAt:
        now(),
      source:
        data.source,
      error: null
    };
  } else {
    liveCache.error =
      error ||
      "LIVE_DATA_UNAVAILABLE";
  }

  return liveCache;
}

/* =========================================================
   ANALYSIS ENGINE
========================================================= */

function pct(a, b) {
  if (!b) return 0;

  return (
    (a / b) * 100
  );
}

function average(arr) {
  if (!arr.length) return 0;

  return (
    arr.reduce(
      (a, b) => a + b,
      0
    ) / arr.length
  );
}

function median(arr) {
  if (!arr.length) return 0;

  const x =
    [...arr].sort(
      (a, b) => a - b
    );

  const m =
    Math.floor(
      x.length / 2
    );

  return x.length % 2
    ? x[m]
    : (x[m - 1] + x[m]) / 2;
}

function switches(seq) {
  let count = 0;

  for (
    let i = 1;
    i < seq.length;
    i++
  ) {
    if (
      seq[i] !==
      seq[i - 1]
    ) {
      count++;
    }
  }

  return count;
}

function streakInfo(seq) {
  if (!seq.length) {
    return {
      current: null,
      currentLength: 0,
      longestBig: 0,
      longestSmall: 0
    };
  }

  let current =
    seq[seq.length - 1];

  let currentLength = 1;

  for (
    let i = seq.length - 2;
    i >= 0;
    i--
  ) {
    if (seq[i] === current) {
      currentLength++;
    } else {
      break;
    }
  }

  let big = 0;
  let small = 0;

  let run = 0;
  let last = null;

  for (const x of seq) {
    if (x === last) {
      run++;
    } else {
      run = 1;
      last = x;
    }

    if (x === "BIG") {
      big =
        Math.max(big, run);
    } else {
      small =
        Math.max(
          small,
          run
        );
    }
  }

  return {
    current,
    currentLength,
    longestBig: big,
    longestSmall: small
  };
}

function runLengths(seq) {
  if (!seq.length) return [];

  const runs = [];

  let last =
    seq[0];

  let length = 1;

  for (
    let i = 1;
    i < seq.length;
    i++
  ) {
    if (seq[i] === last) {
      length++;
    } else {
      runs.push({
        side: last,
        length
      });

      last =
        seq[i];

      length = 1;
    }
  }

  runs.push({
    side: last,
    length
  });

  return runs;
}

function transition(seq) {
  const matrix = {
    BIG: {
      BIG: 0,
      SMALL: 0
    },
    SMALL: {
      BIG: 0,
      SMALL: 0
    }
  };

  for (
    let i = 1;
    i < seq.length;
    i++
  ) {
    matrix[
      seq[i - 1]
    ][seq[i]]++;
  }

  return matrix;
}

function analyzeSequence(seq) {
  const total =
    seq.length;

  const big =
    seq.filter(
      x => x === "BIG"
    ).length;

  const small =
    total - big;

  const sw =
    switches(seq);

  const switchRate =
    total > 1
      ? pct(
          sw,
          total - 1
        )
      : 0;

  const streak =
    streakInfo(seq);

  const runs =
    runLengths(seq);

  const trans =
    transition(seq);

  let bigScore = 0;
  let smallScore = 0;

  /*
    Frequency
  */

  if (big > small) {
    bigScore +=
      (big / total) * 2;
  }

  if (small > big) {
    smallScore +=
      (small / total) * 2;
  }

  /*
    Recent momentum
  */

  const recent =
    seq.slice(-5);

  const old =
    seq.slice(-10, -5);

  if (
    recent.length &&
    old.length
  ) {
    const rb =
      recent.filter(
        x => x === "BIG"
      ).length;

    const ob =
      old.filter(
        x => x === "BIG"
      ).length;

    if (rb > ob) {
      bigScore += 1;
    }

    if (rb < ob) {
      smallScore += 1;
    }
  }

  /*
    Transition
  */

  const last =
    seq[seq.length - 1];

  if (last) {
    const row =
      trans[last];

    if (row) {
      if (
        row.BIG >
        row.SMALL
      ) {
        bigScore +=
          1.25;
      }

      if (
        row.SMALL >
        row.BIG
      ) {
        smallScore +=
          1.25;
      }
    }
  }

  /*
    Streak pressure
  */

  if (
    streak.current ===
      "BIG" &&
    streak.currentLength >= 4
  ) {
    smallScore +=
      Math.min(
        1.5,
        streak.currentLength *
          0.2
      );
  }

  if (
    streak.current ===
      "SMALL" &&
    streak.currentLength >= 4
  ) {
    bigScore +=
      Math.min(
        1.5,
        streak.currentLength *
          0.2
      );
  }

  /*
    Switching behavior
  */

  if (switchRate >= 60) {
    if (
      last === "BIG"
    ) {
      smallScore +=
        0.35;
    } else {
      bigScore +=
        0.35;
    }
  }

  if (switchRate < 40) {
    if (
      last === "BIG"
    ) {
      bigScore +=
        0.3;
    } else {
      smallScore +=
        0.3;
    }
  }

  /*
    Alternation
  */

  let alt = true;

  const altCheck =
    seq.slice(-8);

  for (
    let i = 1;
    i < altCheck.length;
    i++
  ) {
    if (
      altCheck[i] ===
      altCheck[i - 1]
    ) {
      alt = false;
      break;
    }
  }

  if (
    alt &&
    altCheck.length >= 6
  ) {
    if (
      last === "BIG"
    ) {
      smallScore +=
        0.8;
    } else {
      bigScore +=
        0.8;
    }
  }

  /*
    Pattern blocks
  */

  for (
    let size = 2;
    size <= 6;
    size++
  ) {
    if (
      seq.length <
      size * 2
    ) {
      continue;
    }

    const a =
      seq.slice(
        -size
      ).join("");

    const b =
      seq.slice(
        -size * 2,
        -size
      ).join("");

    if (a === b) {
      const next =
        a[a.length - 1];

      if (next === "BIG") {
        smallScore +=
          0.25;
      } else {
        bigScore +=
          0.25;
      }
    }
  }

  /*
    Recency weighting
  */

  const weights = [
    35,
    25,
    20,
    12,
    8
  ];

  let weightedBig = 0;
  let weightedSmall = 0;

  const windows = [
    5,
    10,
    20,
    30,
    50
  ];

  for (
    let i = 0;
    i < windows.length;
    i++
  ) {
    const w =
      seq.slice(
        -windows[i]
      );

    if (!w.length) continue;

    const wb =
      w.filter(
        x => x === "BIG"
      ).length;

    const ws =
      w.length - wb;

    weightedBig +=
      (wb / w.length) *
      weights[i];

    weightedSmall +=
      (ws / w.length) *
      weights[i];
  }

  bigScore +=
    weightedBig / 100;

  smallScore +=
    weightedSmall / 100;

  const totalScore =
    bigScore +
    smallScore;

  let prediction =
    "SKIP";

  if (totalScore > 0) {
    prediction =
      bigScore >=
      smallScore
        ? "BIG"
        : "SMALL";
  }

  const difference =
    Math.abs(
      bigScore -
      smallScore
    );

  let confidence =
    50 +
    difference * 9;

  confidence =
    Math.round(
      Math.max(
        50,
        Math.min(
          92,
          confidence
        )
      )
    );

  if (seq.length < 10) {
    confidence =
      Math.min(
        confidence,
        55
      );
  }

  if (seq.length < 20) {
    confidence =
      Math.min(
        confidence,
        62
      );
  }

  let classification =
    "MIXED / CONFLICTING";

  if (seq.length < 10) {
    classification =
      "INSUFFICIENT DATA";
  } else if (
    difference < 0.35
  ) {
    classification =
      "NO CLEAR SIGNAL";
  } else if (
    difference < 0.7
  ) {
    classification =
      "WEAK HISTORICAL BIAS";
  } else if (
    difference < 1.1
  ) {
    classification =
      "MODERATE HISTORICAL BIAS";
  } else {
    classification =
      "STRONG HISTORICAL BIAS";
  }

  return {
    prediction,
    confidence,
    classification,

    bigScore:
      Number(
        bigScore.toFixed(3)
      ),

    smallScore:
      Number(
        smallScore.toFixed(3)
      ),

    total,

    big,
    small,

    bigPct:
      Number(
        pct(big, total).toFixed(2)
      ),

    smallPct:
      Number(
        pct(small, total).toFixed(2)
      ),

    switchRate:
      Number(
        switchRate.toFixed(2)
      ),

    streak,

    runs: runs.slice(-10),

    transition: trans,

    recent:
      recent,

    weighted: {
      big:
        Number(
          weightedBig.toFixed(2)
        ),
      small:
        Number(
          weightedSmall.toFixed(2)
        )
    }
  };
}

/* =========================================================
   CURRENT ANALYSIS
========================================================= */

function getAnalysis(rows) {
  const valid =
    rows
      .filter(Boolean)
      .sort(
        (a, b) =>
          compareIssue(
            a.issue,
            b.issue
          )
      );

  const last100 =
    valid.slice(-100);

  const seq =
    last100.map(
      x => x.result
    );

  return analyzeSequence(seq);
}

/* =========================================================
   DATABASE PREDICTIONS
========================================================= */

async function getLatestPrediction() {
  if (!pool) return null;

  const r =
    await pool.query(`
      SELECT *
      FROM prediction_records
      ORDER BY id DESC
      LIMIT 1
    `);

  return r.rows[0] || null;
}

async function getPendingPrediction() {
  if (!pool) return null;

  const r =
    await pool.query(`
      SELECT *
      FROM prediction_records
      WHERE actual_result IS NULL
      ORDER BY id DESC
      LIMIT 1
    `);

  return r.rows[0] || null;
}

async function createPrediction(
  targetIssue,
  analysis
) {
  if (!pool) {
    return null;
  }

  const existing =
    await pool.query(
      `
      SELECT *
      FROM prediction_records
      WHERE target_issue = $1
      AND actual_result IS NULL
      LIMIT 1
      `,
      [targetIssue]
    );

  if (existing.rows[0]) {
    return existing.rows[0];
  }

  const r =
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
        targetIssue,
        analysis.prediction,
        analysis.confidence,
        MODEL,
        now()
      ]
    );

  return r.rows[0];
}

/* =========================================================
   SETTLEMENT
========================================================= */

async function settlePrediction(
  prediction,
  row
) {
  if (!pool || !prediction || !row) {
    return null;
  }

  if (
    prediction.actual_result
  ) {
    return prediction;
  }

  const actual =
    row.result;

  const actualNumber =
    row.number;

  const predicted =
    prediction.prediction;

  const status =
    predicted === actual
      ? "WIN"
      : "LOSS";

  const r =
    await pool.query(
      `
      UPDATE prediction_records
      SET
        actual_number = $1,
        actual_result = $2,
        settled_at = $3
      WHERE id = $4
      RETURNING *
      `,
      [
        actualNumber,
        status,
        now(),
        prediction.id
      ]
    );

  return r.rows[0];
}

/* =========================================================
   COOLDOWN
========================================================= */

async function getCooldown() {
  if (!pool) {
    return {
      active: false,
      wait: 0
    };
  }

  const last =
    await getLatestPrediction();

  if (!last) {
    return {
      active: false,
      wait: 0
    };
  }

  /*
    Pending prediction is shown normally.
  */

  if (
    !last.actual_result
  ) {
    return {
      active: false,
      wait: 0,
      pending: true
    };
  }

  /*
    Find how many later completed
    rounds exist after target issue.
  */

  const r =
    await pool.query(
      `
      SELECT COUNT(*)::int AS count
      FROM prediction_records p
      WHERE p.id > $1
      AND p.actual_result IS NOT NULL
      `,
      [last.id]
    );

  const completed =
    Number(
      r.rows[0]?.count || 0
    );

  if (
    completed >= COOLDOWN
  ) {
    return {
      active: false,
      wait: 0,
      completed
    };
  }

  return {
    active: true,
    wait:
      COOLDOWN -
      completed,

    completed
  };
}

/* =========================================================
   STALE PREDICTION CLEANUP
========================================================= */

async function cleanupStalePending(
  currentIssue
) {
  if (!pool || !currentIssue) {
    return;
  }

  const pending =
    await getPendingPrediction();

  if (!pending) {
    return;
  }

  if (
    compareIssue(
      pending.target_issue,
      currentIssue
    ) < 0
  ) {
    await pool.query(
      `
      UPDATE prediction_records
      SET
        actual_result = 'SKIPPED',
        settled_at = $1
      WHERE id = $2
      `,
      [
        now(),
        pending.id
      ]
    );
  }
}

/* =========================================================
   STATE
========================================================= */

async function buildState() {
  await refreshLive();

  const rows =
    liveCache.rows || [];

  const currentIssue =
    normalizeIssue(
      liveCache.currentIssue
    );

  await cleanupStalePending(
    currentIssue
  );

  const latest =
    rows.length
      ? rows[rows.length - 1]
      : null;

  const analysis =
    getAnalysis(rows);

  const pending =
    await getPendingPrediction();

  /*
    If pending target exists and is
    still in future/current, show it.
  */

  let activePrediction =
    pending;

  if (
    activePrediction &&
    compareIssue(
      activePrediction.target_issue,
      currentIssue
    ) < 0
  ) {
    activePrediction = null;
  }

  const cooldown =
    await getCooldown();

  /*
    Only create a new prediction
    when there is no pending prediction
    and cooldown has finished.
  */

  if (
    !activePrediction &&
    !cooldown.active &&
    currentIssue &&
    analysis.prediction !== "SKIP" &&
    rows.length >= 10
  ) {
    const target =
      nextIssue(
        currentIssue
      );

    if (target) {
      activePrediction =
        await createPrediction(
          target,
          analysis
        );
    }
  }

  /*
    Settle prediction if its target
    appears in live history.
  */

  if (activePrediction) {
    const targetRow =
      rows.find(
        x =>
          compareIssue(
            x.issue,
            activePrediction.target_issue
          ) === 0
      );

    if (
      targetRow &&
      !activePrediction.actual_result
    ) {
      activePrediction =
        await settlePrediction(
          activePrediction,
          targetRow
        );

      /*
        Recalculate cooldown
      */

      if (
        activePrediction?.actual_result
      ) {
        return buildState();
      }
    }
  }

  /*
    Last 30 actual results
  */

  const last30 =
    rows.slice(-30).reverse();

  /*
    Recent prediction history
  */

  let predictionHistory = [];

  if (pool) {
    const r =
      await pool.query(`
        SELECT *
        FROM prediction_records
        ORDER BY id DESC
        LIMIT 100
      `);

    predictionHistory =
      r.rows;
  }

  return {
    ok: true,

    model:
      MODEL,

    serverTime:
      now(),

    poll:
      POLL,

    source:
      liveCache.source,

    fetchedAt:
      liveCache.fetchedAt,

    liveError:
      liveCache.error,

    currentIssue,

    latest,

    nextIssue:
      nextIssue(currentIssue),

    analysis,

    prediction:
      activePrediction
        ? {
            id:
              activePrediction.id,

            targetIssue:
              activePrediction.target_issue,

            prediction:
              activePrediction.prediction,

            confidence:
              activePrediction.confidence,

            model:
              activePrediction.model_version,

            actualNumber:
              activePrediction.actual_number,

            status:
              activePrediction.actual_result
          }
        : null,

    cooldown,

    last30,

    history:
      predictionHistory
  };
}

/* =========================================================
   ADMIN AUTH
========================================================= */

function isAdmin(req, url) {
  const key =
    url.searchParams.get(
      "key"
    );

  const header =
    req.headers[
      "x-admin-key"
    ];

  return (
    key === ADMIN_KEY ||
    header === ADMIN_KEY
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
            reject(
              new Error(
                "BODY_TOO_LARGE"
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
            resolve({});
            return;
          }

          try {
            resolve(
              JSON.parse(body)
            );
          } catch (_) {
            reject(
              new Error(
                "INVALID_JSON"
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
   HTTP SERVER
========================================================= */

const server =
  http.createServer(
    async (req, res) => {
      try {
        if (
          req.method === "OPTIONS"
        ) {
          res.writeHead(204);
          return res.end();
        }

        const url =
          new URL(
            req.url,
            `http://${req.headers.host}`
          );

        const p =
          url.pathname;

        /* ---------------------------------------------
           HEALTH
        --------------------------------------------- */

        if (
          p === "/health"
        ) {
          return json(
            res,
            200,
            {
              ok: true,
              service:
                "DY AI WinGo",
              uptime:
                process.uptime(),
              database:
                !!pool,
              time:
                now()
            }
          );
        }

        /* ---------------------------------------------
           PREDICTION PAGE
        --------------------------------------------- */

        if (
          p === "/" ||
          p === "/prediction.html"
        ) {
          return serveFile(
            res,
            path.join(
              process.cwd(),
              "prediction.html"
            ),
            "text/html; charset=utf-8"
          );
        }

        /* ---------------------------------------------
           ADMIN PAGE
        --------------------------------------------- */

        if (
          p === "/admin.html"
        ) {
          return serveFile(
            res,
            path.join(
              process.cwd(),
              "admin.html"
            ),
            "text/html; charset=utf-8"
          );
        }

        /* ---------------------------------------------
           MUSIC
        --------------------------------------------- */

        if (
          p === "/music.mp3"
        ) {
          return serveRangeFile(
            req,
            res,
            path.join(
              process.cwd(),
              "music.mp3"
            ),
            "audio/mpeg"
          );
        }

        /* ---------------------------------------------
           KEY CHECK
        --------------------------------------------- */

        if (
          p === "/api/key/check" &&
          req.method === "POST"
        ) {
          if (!pool) {
            return json(
              res,
              500,
              {
                ok: false,
                error:
                  "DATABASE_NOT_CONFIGURED"
              }
            );
          }

          const body =
            await readBody(req);

          const accessKey =
            String(
              body.key || ""
            ).trim();

          const deviceId =
            String(
              body.deviceId || ""
            ).trim();

          if (
            !accessKey ||
            !deviceId
          ) {
            return json(
              res,
              400,
              {
                ok: false,
                error:
                  "KEY_AND_DEVICE_REQUIRED"
              }
            );
          }

          const r =
            await pool.query(
              `
              SELECT *
              FROM access_keys
              WHERE access_key = $1
              LIMIT 1
              `,
              [accessKey]
            );

          if (!r.rows.length) {
            return json(
              res,
              401,
              {
                ok: false,
                valid: false,
                error:
                  "INVALID_KEY"
              }
            );
          }

          const row =
            r.rows[0];

          if (
            row.device_id &&
            row.device_id !== deviceId
          ) {
            return json(
              res,
              403,
              {
                ok: false,
                valid: false,
                error:
                  "KEY_BOUND_TO_OTHER_DEVICE"
              }
            );
          }

          await pool.query(
            `
            UPDATE access_keys
            SET
              device_id = $1,
              last_seen = $2
            WHERE id = $3
            `,
            [
              deviceId,
              now(),
              row.id
            ]
          );

          return json(
            res,
            200,
            {
              ok: true,
              valid: true,
              key:
                row.access_key
            }
          );
        }

        /* ---------------------------------------------
           STATE
        --------------------------------------------- */

        if (
          p === "/api/state" &&
          req.method === "GET"
        ) {
          return json(
            res,
            200,
            await buildState()
          );
        }

        /* ---------------------------------------------
           HISTORY
        --------------------------------------------- */

        if (
          p === "/api/history" &&
          req.method === "GET"
        ) {
          if (!pool) {
            return json(
              res,
              500,
              {
                ok: false,
                error:
                  "DATABASE_NOT_CONFIGURED"
              }
            );
          }

          const r =
            await pool.query(`
              SELECT *
              FROM prediction_records
              ORDER BY id DESC
              LIMIT 100
            `);

          return json(
            res,
            200,
            {
              ok: true,
              rows:
                r.rows
            }
          );
        }

        /* ---------------------------------------------
           ADMIN STATUS
        --------------------------------------------- */

        if (
          p === "/api/admin/status"
        ) {
          if (
            !isAdmin(req, url)
          ) {
            return json(
              res,
              401,
              {
                ok: false,
                error:
                  "UNAUTHORIZED"
              }
            );
          }

          return json(
            res,
            200,
            {
              ok: true,

              serverTime:
                now(),

              uptime:
                process.uptime(),

              database:
                !!pool,

              liveConfigured:
                !!LIVE_API_URL,

              wingoBotConfigured:
                !!WINGOBOT_TOKEN,

              source:
                liveCache.source,

              fetchedAt:
                liveCache.fetchedAt,

              currentIssue:
                liveCache.currentIssue,

              error:
                liveCache.error,

              model:
                MODEL
            }
          );
        }

        /* ---------------------------------------------
           ADMIN PING
        --------------------------------------------- */

        if (
          p === "/api/admin/ping"
        ) {
          if (
            !isAdmin(req, url)
          ) {
            return json(
              res,
              401,
              {
                ok: false
              }
            );
          }

          return json(
            res,
            200,
            {
              ok: true,
              pong: true,
              time:
                now()
            }
          );
        }

        /* ---------------------------------------------
           ADMIN LIVE TEST
        --------------------------------------------- */

        if (
          p === "/api/admin/live-test"
        ) {
          if (
            !isAdmin(req, url)
          ) {
            return json(
              res,
              401,
              {
                ok: false,
                error:
                  "UNAUTHORIZED"
              }
            );
          }

          const data =
            await refreshLive();

          return json(
            res,
            200,
            {
              ok:
                !!data.rows.length,

              source:
                data.source,

              currentIssue:
                data.currentIssue,

              fetchedAt:
                data.fetchedAt,

              rows:
                data.rows.slice(-30),

              error:
                data.error
            }
          );
        }

        /* ---------------------------------------------
           ADMIN MODEL TEST
        --------------------------------------------- */

        if (
          p === "/api/admin/model-test"
        ) {
          if (
            !isAdmin(req, url)
          ) {
            return json(
              res,
              401,
              {
                ok: false
              }
            );
          }

          await refreshLive();

          const analysis =
            getAnalysis(
              liveCache.rows
            );

          return json(
            res,
            200,
            {
              ok: true,
              model:
                MODEL,
              analysis
            }
          );
        }

        /* ---------------------------------------------
           ADMIN WINGO TEST
        --------------------------------------------- */

        if (
          p === "/api/admin/wingo-test"
        ) {
          if (
            !isAdmin(req, url)
          ) {
            return json(
              res,
              401,
              {
                ok: false
              }
            );
          }

          try {
            const data =
              await fetchWingoBot();

            return json(
              res,
              200,
              {
                ok: true,
                source:
                  data.source,
                currentIssue:
                  data.currentIssue,
                count:
                  data.rows.length,
                rows:
                  data.rows.slice(-30)
              }
            );
          } catch (e) {
            return json(
              res,
              200,
              {
                ok: false,
                error:
                  e.message
              }
            );
          }
        }

        /* ---------------------------------------------
           ADMIN PREDICTIONS
        --------------------------------------------- */

        if (
          p === "/api/admin/predictions"
        ) {
          if (
            !isAdmin(req, url)
          ) {
            return json(
              res,
              401,
              {
                ok: false
              }
            );
          }

          if (!pool) {
            return json(
              res,
              500,
              {
                ok: false,
                error:
                  "DATABASE_NOT_CONFIGURED"
              }
            );
          }

          const r =
            await pool.query(`
              SELECT *
              FROM prediction_records
              ORDER BY id DESC
              LIMIT 200
            `);

          return json(
            res,
            200,
            {
              ok: true,
              rows:
                r.rows
            }
          );
        }

        /* ---------------------------------------------
           ADMIN KEYS GET
        --------------------------------------------- */

        if (
          p === "/api/admin/keys" &&
          req.method === "GET"
        ) {
          if (
            !isAdmin(req, url)
          ) {
            return json(
              res,
              401,
              {
                ok: false
              }
            );
          }

          if (!pool) {
            return json(
              res,
              500,
              {
                ok: false,
                error:
                  "DATABASE_NOT_CONFIGURED"
              }
            );
          }

          const r =
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
              rows:
                r.rows
            }
          );
        }

        /* ---------------------------------------------
           ADMIN CREATE KEY
        --------------------------------------------- */

        if (
          p === "/api/admin/keys" &&
          req.method === "POST"
        ) {
          if (
            !isAdmin(req, url)
          ) {
            return json(
              res,
              401,
              {
                ok: false
              }
            );
          }

          if (!pool) {
            return json(
              res,
              500,
              {
                ok: false,
                error:
                  "DATABASE_NOT_CONFIGURED"
              }
            );
          }

          const body =
            await readBody(req);

          let accessKey =
            String(
              body.key || ""
            ).trim();

          if (!accessKey) {
            accessKey =
              "DY-" +
              Math.random()
                .toString(36)
                .slice(2, 10)
                .toUpperCase();
          }

          const r =
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
                accessKey,
                now()
              ]
            );

          return json(
            res,
            200,
            {
              ok: true,
              key:
                r.rows[0]
            }
          );
        }

        /* ---------------------------------------------
           ADMIN RESET DEVICE
        --------------------------------------------- */

        if (
          p === "/api/admin/reset-device" &&
          req.method === "POST"
        ) {
          if (
            !isAdmin(req, url)
          ) {
            return json(
              res,
              401,
              {
                ok: false
              }
            );
          }

          if (!pool) {
            return json(
              res,
              500,
              {
                ok: false,
                error:
                  "DATABASE_NOT_CONFIGURED"
              }
            );
          }

          const body =
            await readBody(req);

          const id =
            Number(body.id);

          if (!id) {
            return json(
              res,
              400,
              {
                ok: false,
                error:
                  "ID_REQUIRED"
              }
            );
          }

          const r =
            await pool.query(
              `
              UPDATE access_keys
              SET
                device_id = NULL
              WHERE id = $1
              RETURNING *
              `,
              [id]
            );

          return json(
            res,
            200,
            {
              ok:
                !!r.rows.length,
              row:
                r.rows[0] || null
            }
          );
        }

        /* ---------------------------------------------
           404
        --------------------------------------------- */

        return json(
          res,
          404,
          {
            ok: false,
            error:
              "NOT_FOUND"
          }
        );

      } catch (error) {
        console.error(
          error
        );

        return json(
          res,
          500,
          {
            ok: false,
            error:
              error.message ||
              "SERVER_ERROR"
          }
        );
      }
    }
  );

/* =========================================================
   STATIC FILE HELPERS
========================================================= */

function serveFile(
  res,
  filePath,
  contentType
) {
  if (
    !fs.existsSync(filePath)
  ) {
    return json(
      res,
      404,
      {
        ok: false,
        error:
          "FILE_NOT_FOUND",
        file:
          path.basename(
            filePath
          )
      }
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
        "no-cache, no-store, must-revalidate"
    }
  );

  res.end(data);
}

function serveRangeFile(
  req,
  res,
  filePath,
  contentType
) {
  if (
    !fs.existsSync(filePath)
  ) {
    return json(
      res,
      404,
      {
        ok: false,
        error:
          "FILE_NOT_FOUND"
      }
    );
  }

  const stat =
    fs.statSync(filePath);

  const total =
    stat.size;

  const range =
    req.headers.range;

  if (!range) {
    res.writeHead(
      200,
      {
        "Content-Type":
          contentType,

        "Content-Length":
          total,

        "Accept-Ranges":
          "bytes"
      }
    );

    return fs
      .createReadStream(
        filePath
      )
      .pipe(res);
  }

  const match =
    range.match(
      /bytes=(\d*)-(\d*)/
    );

  if (!match) {
    res.writeHead(416);
    return res.end();
  }

  const start =
    match[1]
      ? Number(match[1])
      : 0;

  const end =
    match[2]
      ? Number(match[2])
      : total - 1;

  if (
    start >= total ||
    end >= total ||
    start > end
  ) {
    res.writeHead(416);
    return res.end();
  }

  const chunkSize =
    end - start + 1;

  res.writeHead(
    206,
    {
      "Content-Range":
        `bytes ${start}-${end}/${total}`,

      "Accept-Ranges":
        "bytes",

      "Content-Length":
        chunkSize,

      "Content-Type":
        contentType
    }
  );

  fs
    .createReadStream(
      filePath,
      {
        start,
        end
      }
    )
    .pipe(res);
}

/* =========================================================
   START
========================================================= */

(async () => {
  try {
    await initDB();

    server.listen(
      PORT,
      "0.0.0.0",
      () => {
        console.log(
          "================================="
        );

        console.log(
          " DY AI WinGo Server"
        );

        console.log(
          " Port:",
          PORT
        );

        console.log(
          " Model:",
          MODEL
        );

        console.log(
          " Cooldown:",
          COOLDOWN
        );

        console.log(
          " Live API:",
          LIVE_API_URL
            ? "CONFIGURED"
            : "NOT CONFIGURED"
        );

        console.log(
          " WingoBot:",
          WINGOBOT_TOKEN
            ? "CONFIGURED"
            : "NOT CONFIGURED"
        );

        console.log(
          "================================="
        );
      }
    );
  } catch (error) {
    console.error(
      "START ERROR:",
      error
    );

    process.exit(1);
  }
})();
