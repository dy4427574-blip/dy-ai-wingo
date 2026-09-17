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

const MODEL_VERSION = String(
  process.env.MODEL || "DY-AI-1MIN-V12"
).trim();

const LIVE_POLL = 1000;
const FETCH_TIMEOUT = 8000;

const SKIP_COUNT = 4;
const ANALYSIS_SECONDS = 4;


/* =====================================================
   DATABASE
===================================================== */

let pool = null;

if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
  });
}


/* =====================================================
   MEMORY FALLBACK
===================================================== */

const memory = {
  keys: new Map(),
  predictions: []
};


/* =====================================================
   LIVE DATA
===================================================== */

const live = {
  ok: false,
  currentIssue: null,
  history: [],
  fetched: 0,
  updated: null,
  error: null,
  lastFetch: 0
};


/* =====================================================
   FETCH LOCK
===================================================== */

let fetchRunning = false;


/* =====================================================
   ANALYSIS SESSION
===================================================== */

const analysisSession = {
  issue: null,
  targetIssue: null,
  startedAt: 0,
  endsAt: 0,
  active: false
};


/* =====================================================
   HELPERS
===================================================== */

function now() {
  return Date.now();
}


function resultType(number) {
  const n = Number(number);

  if (!Number.isFinite(n)) {
    return null;
  }

  return n >= 5 ? "BIG" : "SMALL";
}


function nextIssue(issue) {
  try {
    return (
      BigInt(String(issue)) + 1n
    ).toString();
  } catch {
    return null;
  }
}


function issueDiff(current, target) {
  try {
    return Number(
      BigInt(String(current)) -
      BigInt(String(target))
    );
  } catch {
    return null;
  }
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


/* =====================================================
   DATABASE INIT
===================================================== */

async function initDatabase() {
  if (!pool) {
    console.log("[DATABASE] MEMORY MODE");
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
    CREATE INDEX IF NOT EXISTS idx_prediction_real
    ON prediction_records(prediction)
  `);

  await pool.query(
    `
    INSERT INTO access_keys
    (
      access_key,
      device_id,
      created_at,
      last_seen
    )
    VALUES ($1,NULL,$2,0)
    ON CONFLICT(access_key)
    DO NOTHING
    `,
    [
      DEFAULT_ACCESS_KEY,
      now()
    ]
  );

  console.log("[DATABASE] POSTGRESQL READY");
}


/* =====================================================
   DEFAULT KEY
===================================================== */

async function ensureDefaultKey() {
  if (pool) {
    await pool.query(
      `
      INSERT INTO access_keys
      (
        access_key,
        device_id,
        created_at,
        last_seen
      )
      VALUES ($1,NULL,$2,0)
      ON CONFLICT(access_key)
      DO NOTHING
      `,
      [
        DEFAULT_ACCESS_KEY,
        now()
      ]
    );

    return;
  }

  if (!memory.keys.has(DEFAULT_ACCESS_KEY)) {
    memory.keys.set(
      DEFAULT_ACCESS_KEY,
      {
        id: 1,
        access_key: DEFAULT_ACCESS_KEY,
        device_id: null,
        created_at: now(),
        last_seen: 0
      }
    );
  }
}


/* =====================================================
   GET KEY
===================================================== */

async function getKey(key) {
  if (!key) {
    return null;
  }

  if (pool) {
    const r = await pool.query(
      `
      SELECT *
      FROM access_keys
      WHERE access_key=$1
      LIMIT 1
      `,
      [key]
    );

    return r.rows[0] || null;
  }

  return memory.keys.get(key) || null;
}


/* =====================================================
   BIND DEVICE
===================================================== */

async function bindDevice(key, device) {
  await ensureDefaultKey();

  const item = await getKey(key);

  if (!item) {
    return {
      ok: false,
      error: "Invalid access key"
    };
  }

  if (
    item.device_id &&
    item.device_id !== device
  ) {
    return {
      ok: false,
      error:
        "This key is already linked to another device"
    };
  }

  if (pool) {
    await pool.query(
      `
      UPDATE access_keys
      SET
        device_id=COALESCE(device_id,$1),
        last_seen=$2
      WHERE access_key=$3
      `,
      [
        device,
        now(),
        key
      ]
    );
  } else {
    item.device_id =
      item.device_id || device;

    item.last_seen = now();
  }

  return {
    ok: true
  };
}


/* =====================================================
   CREATE KEY
===================================================== */

async function createKey(customKey) {
  const key =
    String(customKey || "").trim() ||
    makeKey();

  if (pool) {
    const r = await pool.query(
      `
      INSERT INTO access_keys
      (
        access_key,
        device_id,
        created_at,
        last_seen
      )
      VALUES ($1,NULL,$2,0)
      ON CONFLICT(access_key)
      DO NOTHING
      RETURNING *
      `,
      [
        key,
        now()
      ]
    );

    if (r.rows[0]) {
      return r.rows[0];
    }

    return getKey(key);
  }

  if (!memory.keys.has(key)) {
    memory.keys.set(
      key,
      {
        id:
          memory.keys.size + 1,

        access_key:
          key,

        device_id:
          null,

        created_at:
          now(),

        last_seen:
          0
      }
    );
  }

  return memory.keys.get(key);
}


/* =====================================================
   LIST KEYS
===================================================== */

async function listKeys() {
  if (pool) {
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

    return r.rows;
  }

  return Array.from(
    memory.keys.values()
  );
}


/* =====================================================
   RESET DEVICE
===================================================== */

async function resetDevice(key) {
  if (pool) {
    await pool.query(
      `
      UPDATE access_keys
      SET
        device_id=NULL,
        last_seen=0
      WHERE access_key=$1
      `,
      [key]
    );

    return;
  }

  const item =
    memory.keys.get(key);

  if (item) {
    item.device_id = null;
    item.last_seen = 0;
  }
}


/* =====================================================
   DELETE KEY
===================================================== */

async function deleteKey(key) {
  if (key === DEFAULT_ACCESS_KEY) {
    throw new Error(
      "Default access key cannot be deleted"
    );
  }

  if (pool) {
    await pool.query(
      `
      DELETE FROM access_keys
      WHERE access_key=$1
      `,
      [key]
    );

    return;
  }

  memory.keys.delete(key);
}


/* =====================================================
   NORMALIZE HISTORY
===================================================== */

function normalizeHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .map(row => {
      const number =
        Number(row.number);

      if (
        !Number.isFinite(number)
      ) {
        return null;
      }

      return {
        issueNumber:
          String(
            row.issueNumber ?? ""
          ),

        number,

        result:
          resultType(number),

        colour:
          row.colour ?? null,

        premium:
          row.premium ?? null,

        sum:
          row.sum ?? null
      };
    })
    .filter(Boolean);
}


/* =====================================================
   FETCH WINGOBOT
===================================================== */

async function fetchWingo() {
  if (!WINGOBOT_TOKEN) {
    throw new Error(
      "WINGOBOT_TOKEN is missing"
    );
  }

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      FETCH_TIMEOUT
    );

  try {
    const response =
      await fetch(
        WINGOBOT_URL,
        {
          method: "GET",

          headers: {
            Authorization:
              `Bearer ${WINGOBOT_TOKEN}`,

            Accept:
              "application/json",

            "Cache-Control":
              "no-cache"
          },

          cache: "no-store",

          signal:
            controller.signal
        }
      );

    const body =
      await response.text();

    let data;

    try {
      data =
        JSON.parse(body);
    } catch {
      throw new Error(
        `Invalid JSON HTTP ${response.status}`
      );
    }

    if (!response.ok) {
      throw new Error(
        `WingoBot HTTP ${response.status}: ` +
        (
          data.error ||
          data.message ||
          "Request failed"
        )
      );
    }

    if (
      data.success !== true
    ) {
      throw new Error(
        data.error ||
        data.message ||
        "WingoBot success=false"
      );
    }

    const currentIssue =
      data.current &&
      data.current.issueNumber != null
        ? String(
            data.current.issueNumber
          )
        : null;

    const history =
      normalizeHistory(
        data.history
      );

    if (!currentIssue) {
      throw new Error(
        "current.issueNumber missing"
      );
    }

    if (!history.length) {
      throw new Error(
        "WingoBot returned no history"
      );
    }

    return {
      currentIssue,

      history,

      fetched:
        data.stats?.fetched ??
        history.length,

      updated:
        data.stats?.last_updated ??
        null
    };

  } finally {
    clearTimeout(timeout);
  }
}


/* =====================================================
   ANALYSIS RESET
===================================================== */

function resetAnalysis() {
  analysisSession.issue = null;
  analysisSession.targetIssue = null;
  analysisSession.startedAt = 0;
  analysisSession.endsAt = 0;
  analysisSession.active = false;
}


/* =====================================================
   ANALYSIS START
===================================================== */

function startAnalysis(
  currentIssue,
  targetIssue
) {
  /*
    Do not restart analysis every second.
  */

  if (
    analysisSession.active &&
    analysisSession.issue ===
      String(currentIssue)
  ) {
    return;
  }

  analysisSession.issue =
    String(currentIssue);

  analysisSession.targetIssue =
    String(targetIssue);

  analysisSession.startedAt =
    now();

  analysisSession.endsAt =
    analysisSession.startedAt +
    ANALYSIS_SECONDS * 1000;

  analysisSession.active = true;

  console.log(
    "[ANALYSIS START]",
    "Current:",
    currentIssue,
    "Target:",
    targetIssue
  );
}


/* =====================================================
   LIVE REFRESH
===================================================== */

async function refreshLive() {
  /*
    Prevent overlapping API calls.
  */

  if (fetchRunning) {
    return;
  }

  fetchRunning = true;

  try {
    const data =
      await fetchWingo();

    const oldIssue =
      live.currentIssue;

    live.ok = true;

    live.currentIssue =
      data.currentIssue;

    live.history =
      data.history;

    live.fetched =
      data.fetched;

    live.updated =
      data.updated;

    live.error = null;

    live.lastFetch =
      now();

    await settlePredictions();

    /*
      New issue detected.
      Reset old analysis.
    */

    if (
      oldIssue &&
      String(oldIssue) !==
        String(data.currentIssue)
    ) {
      resetAnalysis();

      console.log(
        "[NEW ISSUE]",
        data.currentIssue
      );
    }

  } catch (error) {
    live.error =
      error.message;

    console.error(
      "[WINGOBOT ERROR]",
      error.message
    );

    /*
      Keep last valid live data.
    */

    if (!live.currentIssue) {
      live.ok = false;
    }

  } finally {
    fetchRunning = false;
  }
}


/* =====================================================
   AI / PATTERN ENGINE
===================================================== */

function analyze(history) {
  const rows =
    Array.isArray(history)
      ? history
          .filter(
            x =>
              x.result === "BIG" ||
              x.result === "SMALL"
          )
          .slice(0, 50)
      : [];

  /*
    Minimum data fallback.
  */

  if (rows.length < 10) {
    const big =
      rows.filter(
        x => x.result === "BIG"
      ).length;

    const small =
      rows.filter(
        x => x.result === "SMALL"
      ).length;

    return {
      prediction:
        big >= small
          ? "BIG"
          : "SMALL",

      confidence: 50,

      quality: "LOW_DATA",

      score: 0,

      agreement: 0,

      matches: 0,

      streak: 0,

      switchRate: 0,

      counts: {
        big,
        small
      },

      signals: {}
    };
  }

  const seq =
    rows.map(
      x => x.result
    );

  let big = 0;
  let small = 0;

  for (const x of seq) {
    if (x === "BIG") {
      big++;
    } else {
      small++;
    }
  }


  /* =================================================
     RECENCY
  ================================================= */

  let recentBig = 0;
  let recentSmall = 0;

  const recent =
    seq.slice(0, 10);

  for (
    let i = 0;
    i < recent.length;
    i++
  ) {
    const weight =
      recent.length - i;

    if (
      recent[i] === "BIG"
    ) {
      recentBig += weight;
    } else {
      recentSmall += weight;
    }
  }

  const recentTotal =
    recentBig +
    recentSmall;

  const recentScore =
    recentTotal
      ? (
          recentBig -
          recentSmall
        ) /
        recentTotal
      : 0;


  /* =================================================
     TRANSITIONS
  ================================================= */

  let BB = 0;
  let BS = 0;
  let SB = 0;
  let SS = 0;

  for (
    let i = 0;
    i < seq.length - 1;
    i++
  ) {
    const current =
      seq[i];

    const previous =
      seq[i + 1];

    if (
      previous === "BIG" &&
      current === "BIG"
    ) {
      BB++;
    } else if (
      previous === "BIG" &&
      current === "SMALL"
    ) {
      BS++;
    } else if (
      previous === "SMALL" &&
      current === "BIG"
    ) {
      SB++;
    } else if (
      previous === "SMALL" &&
      current === "SMALL"
    ) {
      SS++;
    }
  }

  let transitionScore = 0;

  if (
    seq[0] === "BIG"
  ) {
    const total =
      BB + BS;

    if (total > 0) {
      transitionScore =
        (BB - BS) / total;
    }
  } else {
    const total =
      SB + SS;

    if (total > 0) {
      transitionScore =
        (SB - SS) / total;
    }
  }


  /* =================================================
     STREAK
  ================================================= */

  const latest =
    seq[0];

  let streak = 1;

  for (
    let i = 1;
    i < seq.length;
    i++
  ) {
    if (
      seq[i] === latest
    ) {
      streak++;
    } else {
      break;
    }
  }

  let streakScore = 0;

  if (
    streak >= 4
  ) {
    streakScore =
      latest === "BIG"
        ? -0.25
        : 0.25;
  }


  /* =================================================
     SWITCH RATE
  ================================================= */

  let switches = 0;

  for (
    let i = 0;
    i < seq.length - 1;
    i++
  ) {
    if (
      seq[i] !==
      seq[i + 1]
    ) {
      switches++;
    }
  }

  const switchRate =
    switches /
    Math.max(
      1,
      seq.length - 1
    );

  let switchScore = 0;

  if (
    switchRate >= 0.70
  ) {
    switchScore =
      latest === "BIG"
        ? -0.12
        : 0.12;
  }


  /* =================================================
     HISTORICAL PATTERN
  ================================================= */

  const pattern =
    seq
      .slice(0, 4)
      .join("-");

  let matchBig = 0;
  let matchSmall = 0;
  let matches = 0;

  for (
    let i = 4;
    i < seq.length;
    i++
  ) {
    const oldPattern =
      seq
        .slice(
          i,
          i + 4
        )
        .join("-");

    if (
      oldPattern === pattern
    ) {
      const following =
        seq[i - 1];

      if (
        following === "BIG"
      ) {
        matchBig++;
      } else if (
        following === "SMALL"
      ) {
        matchSmall++;
      }

      matches++;
    }
  }

  let patternScore = 0;

  if (
    matches > 0
  ) {
    patternScore =
      (
        matchBig -
        matchSmall
      ) /
      matches;
  }


  /* =================================================
     SHORT / MEDIUM / LONG
  ================================================= */

  function ratio(arr) {
    if (!arr.length) {
      return 0.5;
    }

    return (
      arr.filter(
        x => x === "BIG"
      ).length /
      arr.length
    );
  }

  const short =
    ratio(
      seq.slice(0, 5)
    );

  const medium =
    ratio(
      seq.slice(0, 15)
    );

  const long =
    ratio(seq);

  const directionScore =
    (
      short - 0.5
    ) * 0.50 +

    (
      medium - 0.5
    ) * 0.30 +

    (
      long - 0.5
    ) * 0.20;


  /* =================================================
     ENSEMBLE
  ================================================= */

  const score =

    recentScore * 0.24 +

    transitionScore * 0.25 +

    patternScore * 0.25 +

    directionScore * 0.14 +

    streakScore * 0.07 +

    switchScore * 0.05;


  const signals = [
    recentScore,
    transitionScore,
    patternScore,
    directionScore
  ];

  let positive = 0;
  let negative = 0;

  for (
    const s of signals
  ) {
    if (s > 0.05) {
      positive++;
    }

    if (s < -0.05) {
      negative++;
    }
  }

  const agreement =
    Math.max(
      positive,
      negative
    ) /
    signals.length;


  /*
    Always return BIG or SMALL.

    This prevents an endless MODEL_SKIP
    analysis loop.
  */

  let prediction;

  if (score > 0) {
    prediction = "BIG";
  } else if (score < 0) {
    prediction = "SMALL";
  } else {
    prediction =
      big >= small
        ? "BIG"
        : "SMALL";
  }


  let confidence =
    Math.round(
      50 +
      Math.abs(score) * 70 +
      agreement * 10 +
      Math.min(
        7,
        matches * 1.5
      )
    );

  confidence =
    Math.max(
      50,
      Math.min(
        85,
        confidence
      )
    );


  let quality =
    "WEAK";

  if (
    agreement >= 0.75 &&
    matches >= 3
  ) {
    quality = "STRONG";
  } else if (
    agreement >= 0.50
  ) {
    quality = "MODERATE";
  }


  return {
    prediction,

    confidence,

    quality,

    score:
      Number(
        score.toFixed(4)
      ),

    agreement:
      Number(
        agreement.toFixed(2)
      ),

    matches,

    streak,

    switchRate:
      Number(
        switchRate.toFixed(3)
      ),

    counts: {
      big,
      small
    },

    transitions: {
      BB,
      BS,
      SB,
      SS
    },

    signals: {
      recent:
        Number(
          recentScore.toFixed(3)
        ),

      transition:
        Number(
          transitionScore.toFixed(3)
        ),

      pattern:
        Number(
          patternScore.toFixed(3)
        ),

      direction:
        Number(
          directionScore.toFixed(3)
        )
    }
  };
}


/* =====================================================
   GET PREDICTION BY ISSUE
===================================================== */

async function getPredictionForIssue(issue) {
  if (!issue) {
    return null;
  }

  if (pool) {
    const r =
      await pool.query(
        `
        SELECT *
        FROM prediction_records
        WHERE target_issue=$1
        ORDER BY id DESC
        LIMIT 1
        `,
        [String(issue)]
      );

    return r.rows[0] || null;
  }

  return (
    memory.predictions.find(
      p =>
        String(
          p.target_issue
        ) ===
        String(issue)
    ) || null
  );
}


/* =====================================================
   LAST REAL PREDICTION
===================================================== */

async function getLastRealPrediction() {
  if (pool) {
    const r =
      await pool.query(`
        SELECT *
        FROM prediction_records
        WHERE prediction IN ('BIG','SMALL')
        ORDER BY id DESC
        LIMIT 1
      `);

    return r.rows[0] || null;
  }

  return (
    memory.predictions
      .filter(
        p =>
          p.prediction === "BIG" ||
          p.prediction === "SMALL"
      )
      .sort(
        (a, b) =>
          Number(b.id || 0) -
          Number(a.id || 0)
      )[0] || null
  );
}


/* =====================================================
   SAVE PREDICTION
===================================================== */

async function savePrediction(
  targetIssue,
  prediction,
  confidence
) {
  const existing =
    await getPredictionForIssue(
      targetIssue
    );

  if (existing) {
    return existing;
  }

  if (pool) {
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
        VALUES ($1,$2,$3,$4,$5)
        RETURNING *
        `,
        [
          String(targetIssue),
          prediction,
          confidence,
          MODEL_VERSION,
          now()
        ]
      );

    return r.rows[0];
  }

  const item = {
    id:
      memory.predictions.length + 1,

    target_issue:
      String(targetIssue),

    prediction,

    confidence,

    model_version:
      MODEL_VERSION,

    actual_number: null,

    actual_result: null,

    created_at:
      now(),

    settled_at: null
  };

  memory.predictions.unshift(item);

  return item;
}


/* =====================================================
   SETTLE PREDICTIONS
===================================================== */

async function settlePredictions() {
  if (!live.history.length) {
    return;
  }

  for (
    const row of
    live.history.slice(0, 50)
  ) {
    if (
      !row.issueNumber ||
      !row.result
    ) {
      continue;
    }

    if (pool) {
      await pool.query(
        `
        UPDATE prediction_records
        SET
          actual_number=$1,
          actual_result=$2,
          settled_at=$3
        WHERE target_issue=$4
          AND prediction IN ('BIG','SMALL')
          AND actual_result IS NULL
        `,
        [
          row.number,
          row.result,
          now(),
          String(
            row.issueNumber
          )
        ]
      );
    } else {
      for (
        const p of
        memory.predictions
      ) {
        if (
          String(
            p.target_issue
          ) ===
          String(
            row.issueNumber
          ) &&

          (
            p.prediction === "BIG" ||
            p.prediction === "SMALL"
          ) &&

          !p.actual_result
        ) {
          p.actual_number =
            row.number;

          p.actual_result =
            row.result;

          p.settled_at =
            now();
        }
      }
    }
  }
}


/* =====================================================
   4-SKIP CYCLE
===================================================== */

async function getCycleState(
  currentIssue
) {
  const lastReal =
    await getLastRealPrediction();

  /*
    First prediction.
  */

  if (!lastReal) {
    return {
      mode: "PREDICTION",
      skipRound: 0,
      remaining: 0,
      lastPrediction: null
    };
  }

  const difference =
    issueDiff(
      currentIssue,
      lastReal.target_issue
    );

  if (
    difference === null
  ) {
    return {
      mode: "PREDICTION",
      skipRound: 0,
      remaining: 0,
      lastPrediction:
        lastReal
    };
  }


  /*
    Prediction target = 100

    Current 100 = prediction already exists
    Current 101 = skip 1
    Current 102 = skip 2
    Current 103 = skip 3
    Current 104 = skip 4
    Current 105 = new prediction cycle
  */

  if (
    difference >= 1 &&
    difference <= SKIP_COUNT
  ) {
    return {
      mode: "SKIP",

      skipRound:
        difference,

      remaining:
        SKIP_COUNT -
        difference,

      lastPrediction:
        lastReal
    };
  }

  return {
    mode: "PREDICTION",

    skipRound: 0,

    remaining: 0,

    lastPrediction:
      lastReal
  };
}


/* =====================================================
   GET CURRENT PREDICTION STATE
===================================================== */

async function getPredictionState() {

  if (
    !live.ok ||
    !live.currentIssue
  ) {
    return {
      result: "WAIT",

      confidence: 0,

      status: "OFFLINE",

      targetPeriod: null,

      analysisSeconds: 0,

      analysisRemaining: 0
    };
  }


  const currentIssue =
    String(
      live.currentIssue
    );


  /*
    Prediction is for the next issue.
  */

  const targetIssue =
    nextIssue(
      currentIssue
    );


  if (!targetIssue) {
    return {
      result: "WAIT",

      confidence: 0,

      status: "OFFLINE",

      targetPeriod: null
    };
  }


  /*
  ======================================================
  EXISTING PREDICTION
  ======================================================
  */

  const existing =
    await getPredictionForIssue(
      targetIssue
    );


  if (existing) {

    let status =
      "PENDING";

    if (
      existing.actual_result
    ) {
      status =
        existing.prediction ===
        existing.actual_result
          ? "WIN"
          : "LOSS";
    }

    return {
      result:
        existing.prediction,

      confidence:
        Number(
          existing.confidence || 0
        ),

      status,

      targetPeriod:
        String(
          existing.target_issue
        ),

      actualNumber:
        existing.actual_number,

      actualResult:
        existing.actual_result,

      analysisSeconds:
        ANALYSIS_SECONDS,

      analysisRemaining: 0,

      analysisProgress: 100,

      analysis: null
    };
  }


  /*
  ======================================================
  CHECK 4 SKIPS
  ======================================================
  */

  const cycle =
    await getCycleState(
      currentIssue
    );


  if (
    cycle.mode === "SKIP"
  ) {

    /*
      No analysis during SKIP.
    */

    resetAnalysis();

    return {

      result: "SKIP",

      confidence: 0,

      status: "COOLDOWN",

      targetPeriod:
        targetIssue,

      skipRound:
        cycle.skipRound,

      skipTotal:
        SKIP_COUNT,

      skipRemaining:
        cycle.remaining,

      analysisSeconds: 0,

      analysisRemaining: 0,

      analysisProgress: 0,

      analysis: null,

      lastPrediction:
        cycle.lastPrediction
          ? {

              target:
                cycle.lastPrediction
                  .target_issue,

              prediction:
                cycle.lastPrediction
                  .prediction

            }
          : null
    };
  }


  /*
  ======================================================
  ALLOWED ROUND
  ======================================================

  Analysis starts immediately when the
  allowed round starts.

  No 56-second waiting.
  No end-of-minute waiting.
  ======================================================
  */

  startAnalysis(
    currentIssue,
    targetIssue
  );


  const elapsedMs =
    Math.max(
      0,
      now() -
      analysisSession.startedAt
    );


  const remainingMs =
    Math.max(
      0,
      analysisSession.endsAt -
      now()
    );


  const elapsedSeconds =
    Math.min(
      ANALYSIS_SECONDS,
      Math.floor(
        elapsedMs / 1000
      )
    );


  const remainingSeconds =
    Math.max(
      0,
      Math.ceil(
        remainingMs / 1000
      )
    );


  /*
  ======================================================
  STILL ANALYSING
  ======================================================
  */

  if (
    remainingMs > 0
  ) {

    return {

      result: "WAIT",

      confidence: 0,

      status: "ANALYZING",

      targetPeriod:
        targetIssue,

      analysisSeconds:
        elapsedSeconds,

      analysisRemaining:
        remainingSeconds,

      analysisTotal:
        ANALYSIS_SECONDS,

      analysisProgress:
        Math.min(
          100,
          Math.floor(
            (
              elapsedMs /
              (
                ANALYSIS_SECONDS *
                1000
              )
            ) * 100
          )
        ),

      analysis: null
    };
  }


  /*
  ======================================================
  4 SECONDS COMPLETE
  ======================================================
  */

  const model =
    analyze(
      live.history
    );


  /*
  ======================================================
  FINAL DUPLICATE CHECK
  ======================================================
  */

  const doubleCheck =
    await getPredictionForIssue(
      targetIssue
    );


  if (doubleCheck) {

    resetAnalysis();

    return {

      result:
        doubleCheck.prediction,

      confidence:
        Number(
          doubleCheck.confidence || 0
        ),

      status: "PENDING",

      targetPeriod:
        String(
          doubleCheck.target_issue
        ),

      actualNumber:
        doubleCheck.actual_number,

      actualResult:
        doubleCheck.actual_result,

      analysisSeconds:
        ANALYSIS_SECONDS,

      analysisRemaining: 0,

      analysisProgress: 100,

      analysis: null
    };
  }


  /*
  ======================================================
  SAVE REAL PREDICTION
  ======================================================
  */

  const saved =
    await savePrediction(
      targetIssue,
      model.prediction,
      model.confidence
    );


  resetAnalysis();


  console.log(
    "[PREDICTION]",
    "Period:",
    saved.target_issue,
    "Result:",
    saved.prediction,
    "Confidence:",
    saved.confidence + "%"
  );


  return {

    result:
      saved.prediction,

    confidence:
      Number(
        saved.confidence || 0
      ),

    status: "PENDING",

    targetPeriod:
      String(
        saved.target_issue
      ),

    actualNumber: null,

    actualResult: null,

    analysisSeconds:
      ANALYSIS_SECONDS,

    analysisRemaining: 0,

    analysisProgress: 100,

    analysis:
      model
  };
}


/* =====================================================
   BUILD STATE
===================================================== */

async function buildState(
  key,
  device
) {

  const auth =
    await bindDevice(
      key,
      device
    );


  if (!auth.ok) {
    return auth;
  }


  const prediction =
    await getPredictionState();


  const latest =
    live.history[0] || null;


  const model =
    analyze(
      live.history
    );


  return {

    ok: true,

    live:
      live.ok,

    liveError:
      live.error,

    currentPeriod:
      live.currentIssue,

    nextPeriod:
      nextIssue(
        live.currentIssue
      ),

    latestResult:
      latest
        ? {

            issueNumber:
              latest.issueNumber,

            number:
              latest.number,

            result:
              latest.result

          }
        : null,

    prediction,

    model: {

      prediction:
        model.prediction,

      confidence:
        model.confidence,

      quality:
        model.quality,

      score:
        model.score,

      agreement:
        model.agreement,

      matches:
        model.matches,

      streak:
        model.streak,

      switchRate:
        model.switchRate,

      counts:
        model.counts,

      transitions:
        model.transitions,

      signals:
        model.signals

    },

    recentResults:
      live.history.slice(
        0,
        30
      ),

    source: {

      provider:
        "WingoBot",

      fetched:
        live.fetched,

      updated:
        live.updated,

      lastFetch:
        live.lastFetch

    },

    analysisSession: {

      active:
        analysisSession.active,

      issue:
        analysisSession.issue,

      targetIssue:
        analysisSession.targetIssue,

      startedAt:
        analysisSession.startedAt,

      endsAt:
        analysisSession.endsAt

    },

    serverTime:
      now(),

    fetchRunning
  };
}


/* =====================================================
   BODY READER
===================================================== */

function readBody(req) {

  return new Promise(
    (resolve, reject) => {

      let body = "";


      req.on(
        "data",
        chunk => {

          body +=
            chunk.toString();


          if (
            body.length >
            1024 * 1024
          ) {

            reject(
              new Error(
                "Request body too large"
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


/* =====================================================
   JSON RESPONSE
===================================================== */

function sendJson(
  res,
  status,
  data
) {

  res.writeHead(
    status,
    {

      "Content-Type":
        "application/json; charset=utf-8",

      "Cache-Control":
        "no-store, no-cache, must-revalidate",

      Pragma:
        "no-cache",

      Expires:
        "0",

      "Access-Control-Allow-Origin":
        "*"

    }
  );


  res.end(
    JSON.stringify(data)
  );
}


/* =====================================================
   FILE SERVER
===================================================== */

function serveFile(
  res,
  fileName
) {

  const file =
    path.join(
      __dirname,
      fileName
    );


  if (
    !fs.existsSync(file)
  ) {

    return sendJson(
      res,
      404,
      {

        ok: false,

        error:
          "File not found: " +
          fileName

      }
    );
  }


  let contentType =
    "text/plain; charset=utf-8";


  if (
    fileName.endsWith(".html")
  ) {

    contentType =
      "text/html; charset=utf-8";
  }


  if (
    fileName.endsWith(".css")
  ) {

    contentType =
      "text/css; charset=utf-8";
  }


  if (
    fileName.endsWith(".js")
  ) {

    contentType =
      "application/javascript; charset=utf-8";
  }


  res.writeHead(
    200,
    {

      "Content-Type":
        contentType,

      "Cache-Control":
        "no-cache, no-store, must-revalidate",

      Pragma:
        "no-cache",

      Expires:
        "0"

    }
  );


  fs.createReadStream(
    file
  ).pipe(res);
}


/* =====================================================
   ADMIN AUTH
===================================================== */

function isAdmin(url) {

  return (
    url.searchParams.get("key") ===
    ADMIN_KEY
  );
}


/* =====================================================
   HTTP SERVER
===================================================== */

const server =
  http.createServer(
    async (
      req,
      res
    ) => {

      try {

        const url =
          new URL(
            req.url,
            `http://${req.headers.host}`
          );


        /*
        -----------------------------------------------
        PREDICTION PAGE
        -----------------------------------------------
        */

        if (
          url.pathname === "/" ||
          url.pathname === "/prediction.html"
        ) {

          return serveFile(
            res,
            "prediction.html"
          );
        }


        /*
        -----------------------------------------------
        ADMIN PAGE
        -----------------------------------------------
        */

        if (
          url.pathname === "/admin.html"
        ) {

          return serveFile(
            res,
            "admin.html"
          );
        }


        /*
        -----------------------------------------------
        HEALTH
        -----------------------------------------------
        */

        if (
          url.pathname === "/health"
        ) {

          return sendJson(
            res,
            200,
            {

              ok: true,

              game:
                "WINGO 1 MINUTE",

              model:
                MODEL_VERSION,

              database:
                Boolean(pool),

              databaseMode:
                pool
                  ? "POSTGRESQL"
                  : "MEMORY",

              wingoBot:
                live.ok,

              tokenConfigured:
                Boolean(
                  WINGOBOT_TOKEN
                ),

              currentIssue:
                live.currentIssue,

              resultCount:
                live.history.length,

              liveError:
                live.error,

              fetchRunning,

              analysis:
                analysisSession,

              lastFetch:
                live.lastFetch,

              serverTime:
                new Date()
                  .toISOString()

            }
          );
        }


        /*
        -----------------------------------------------
        PUBLIC STATE
        -----------------------------------------------
        */

        if (
          url.pathname === "/api/state"
        ) {

          const key =
            url.searchParams.get("key") ||
            DEFAULT_ACCESS_KEY;


          const device =
            url.searchParams.get("device") ||
            "unknown";


          const state =
            await buildState(
              key,
              device
            );


          return sendJson(
            res,
            state.ok
              ? 200
              : 403,
            state
          );
        }


        /*
        -----------------------------------------------
        KEY CHECK
        -----------------------------------------------
        */

        if (
          url.pathname === "/api/key/check"
        ) {

          const key =
            url.searchParams.get("key");


          const device =
            url.searchParams.get("device") ||
            "test-device";


          const result =
            await bindDevice(
              key,
              device
            );


          return sendJson(
            res,
            result.ok
              ? 200
              : 403,
            result
          );
        }


        /*
        -----------------------------------------------
        ADMIN STATUS
        -----------------------------------------------
        */

        if (
          url.pathname === "/api/admin/status"
        ) {

          if (
            !isAdmin(url)
          ) {

            return sendJson(
              res,
              401,
              {
                ok: false,
                error: "Unauthorized"
              }
            );
          }


          return sendJson(
            res,
            200,
            {

              ok: true,

              live,

              database:
                Boolean(pool),

              model:
                MODEL_VERSION,

              fetchRunning,

              analysis:
                analysisSession

            }
          );
        }


        /*
        -----------------------------------------------
        ADMIN LIVE TEST
        -----------------------------------------------
        */

        if (
          url.pathname === "/api/admin/live-test"
        ) {

          if (
            !isAdmin(url)
          ) {

            return sendJson(
              res,
              401,
              {
                ok: false
              }
            );
          }


          try {

            const data =
              await fetchWingo();


            return sendJson(
              res,
              200,
              {

                ok: true,

                success: true,

                currentIssue:
                  data.currentIssue,

                resultCount:
                  data.history.length,

                fetched:
                  data.fetched,

                updated:
                  data.updated,

                history:
                  data.history

              }
            );

          } catch (error) {

            return sendJson(
              res,
              200,
              {

                ok: true,

                success: false,

                error:
                  error.message

              }
            );
          }
        }


        /*
        -----------------------------------------------
        ADMIN MODEL TEST
        -----------------------------------------------
        */

        if (
          url.pathname === "/api/admin/model-test"
        ) {

          if (
            !isAdmin(url)
          ) {

            return sendJson(
              res,
              401,
              {
                ok: false
              }
            );
          }


          return sendJson(
            res,
            200,
            {

              ok: true,

              analysis:
                analyze(
                  live.history
                )

            }
          );
        }


        /*
        -----------------------------------------------
        GET KEYS
        -----------------------------------------------
        */

        if (
          url.pathname === "/api/admin/keys" &&
          req.method === "GET"
        ) {

          if (
            !isAdmin(url)
          ) {

            return sendJson(
              res,
              401,
              {
                ok: false
              }
            );
          }


          return sendJson(
            res,
            200,
            {

              ok: true,

              keys:
                await listKeys()

            }
          );
        }


        /*
        -----------------------------------------------
        CREATE KEY
        -----------------------------------------------
        */

        if (
          url.pathname === "/api/admin/keys" &&
          req.method === "POST"
        ) {

          if (
            !isAdmin(url)
          ) {

            return sendJson(
              res,
              401,
              {
                ok: false
              }
            );
          }


          const body =
            await readBody(req);


          const item =
            await createKey(
              body.key
            );


          return sendJson(
            res,
            200,
            {

              ok: true,

              key:
                item

            }
          );
        }


        /*
        -----------------------------------------------
        RESET DEVICE
        -----------------------------------------------
        */

        if (
          url.pathname === "/api/admin/reset-device" &&
          req.method === "POST"
        ) {

          if (
            !isAdmin(url)
          ) {

            return sendJson(
              res,
              401,
              {
                ok: false
              }
            );
          }


          const body =
            await readBody(req);


          await resetDevice(
            String(
              body.key || ""
            ).trim()
          );


          return sendJson(
            res,
            200,
            {
              ok: true
            }
          );
        }


        /*
        -----------------------------------------------
        DELETE KEY
        -----------------------------------------------
        */

        if (
          url.pathname === "/api/admin/delete-key" &&
          req.method === "POST"
        ) {

          if (
            !isAdmin(url)
          ) {

            return sendJson(
              res,
              401,
              {
                ok: false
              }
            );
          }


          const body =
            await readBody(req);


          await deleteKey(
            String(
              body.key || ""
            ).trim()
          );


          return sendJson(
            res,
            200,
            {
              ok: true
            }
          );
        }


        /*
        -----------------------------------------------
        PREDICTION HISTORY
        -----------------------------------------------
        */

        if (
          url.pathname === "/api/admin/predictions"
        ) {

          if (
            !isAdmin(url)
          ) {

            return sendJson(
              res,
              401,
              {
                ok: false
              }
            );
          }


          let predictions;


          if (pool) {

            const r =
              await pool.query(`
                SELECT *
                FROM prediction_records
                ORDER BY id DESC
                LIMIT 200
              `);

            predictions =
              r.rows;

          } else {

            predictions =
              memory.predictions;
          }


          return sendJson(
            res,
            200,
            {

              ok: true,

              predictions

            }
          );
        }


        /*
        -----------------------------------------------
        404
        -----------------------------------------------
        */

        return sendJson(
          res,
          404,
          {

            ok: false,

            error:
              "Not found"

          }
        );


      } catch (error) {

        console.error(
          "[SERVER ERROR]",
          error
        );


        return sendJson(
          res,
          500,
          {

            ok: false,

            error:
              error.message

          }
        );
      }
    }
  );


/* =====================================================
   START
===================================================== */

async function start() {

  try {

    await initDatabase();

    await ensureDefaultKey();


    /*
      First live fetch.
    */

    await refreshLive();


    /*
      API refresh every second.
    */

    setInterval(
      refreshLive,
      LIVE_POLL
    );


    server.listen(
      PORT,
      "0.0.0.0",
      () => {

        console.log(
          "=========================================="
        );

        console.log(
          "DY AI WINGO 1 MINUTE"
        );

        console.log(
          "MODEL:",
          MODEL_VERSION
        );

        console.log(
          "API POLL:",
          LIVE_POLL + "ms"
        );

        console.log(
          "ANALYSIS:",
          ANALYSIS_SECONDS + " SECONDS"
        );

        console.log(
          "SKIP:",
          SKIP_COUNT + " ROUNDS"
        );

        console.log(
          "FLOW:",
          "ROUND START -> 4 SEC ANALYSIS -> PREDICTION -> 4 SKIPS"
        );

        console.log(
          "FETCH LOCK:",
          "ENABLED"
        );

        console.log(
          "DATABASE:",
          pool
            ? "POSTGRESQL"
            : "MEMORY"
        );

        console.log(
          "WINGOBOT TOKEN:",
          WINGOBOT_TOKEN
            ? "CONFIGURED"
            : "MISSING"
        );

        console.log(
          "=========================================="
        );
      }
    );

  } catch (error) {

    console.error(
      "[START ERROR]",
      error
    );

    process.exit(1);
  }
}


start();
