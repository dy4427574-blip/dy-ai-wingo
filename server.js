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
  process.env.MODEL || "DY-AI-1MIN-V16"
).trim();

const POLL_MS = 1000;
const ANALYSIS_MS = 4000;
const SKIP_ROUNDS = 4;
const REQUEST_TIMEOUT = 8000;


/* =========================================================
   DATABASE
========================================================= */

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


/* =========================================================
   MEMORY FALLBACK
========================================================= */

const memory = {
  keys: new Map(),
  predictions: [],
  keyId: 1,
  predictionId: 1
};


/* =========================================================
   LIVE STATE
========================================================= */

const live = {
  ok: false,
  currentIssue: null,
  history: [],
  fetched: 0,
  updated: null,
  error: null,
  lastFetch: 0,
  lastIssueChange: 0
};


/* =========================================================
   ANALYSIS STATE
========================================================= */

const analysis = {
  active: false,
  issue: null,
  startedAt: 0,
  endsAt: 0
};


/* =========================================================
   LOCKS
========================================================= */

let fetchRunning = false;
let predictionRunning = false;


/* =========================================================
   HELPERS
========================================================= */

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


function issueBigInt(issue) {
  try {
    return BigInt(String(issue));
  } catch {
    return null;
  }
}


function issueDiff(current, previous) {
  const a = issueBigInt(current);
  const b = issueBigInt(previous);

  if (a === null || b === null) {
    return null;
  }

  return Number(a - b);
}


function nextIssue(issue) {
  const n = issueBigInt(issue);

  if (n === null) {
    return null;
  }

  return (n + 1n).toString();
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


/* =========================================================
   DATABASE INITIALIZATION
========================================================= */

async function initDatabase() {

  if (!pool) {
    console.log("[DB] MEMORY MODE");
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

  console.log("[DB] POSTGRESQL READY");
}


/* =========================================================
   DEFAULT KEY
========================================================= */

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
        id: memory.keyId++,
        access_key: DEFAULT_ACCESS_KEY,
        device_id: null,
        created_at: now(),
        last_seen: 0
      }
    );

  }
}


/* =========================================================
   GET KEY
========================================================= */

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


/* =========================================================
   DEVICE BINDING
========================================================= */

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


/* =========================================================
   CREATE KEY
========================================================= */

async function createKey(customKey) {

  const requested =
    String(customKey || "").trim();

  const key =
    requested || makeKey();

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
        id: memory.keyId++,
        access_key: key,
        device_id: null,
        created_at: now(),
        last_seen: 0
      }
    );

  }

  return memory.keys.get(key);
}


/* =========================================================
   LIST KEYS
========================================================= */

async function listKeys() {

  if (pool) {

    const r = await pool.query(`
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


/* =========================================================
   RESET DEVICE
========================================================= */

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


/* =========================================================
   DELETE KEY
========================================================= */

async function deleteKey(key) {

  if (
    key === DEFAULT_ACCESS_KEY
  ) {

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


/* =========================================================
   NORMALIZE HISTORY
========================================================= */

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


/* =========================================================
   WINGOBOT REQUEST
========================================================= */

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
      REQUEST_TIMEOUT
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

          cache:
            "no-store",

          signal:
            controller.signal
        }
      );

    const text =
      await response.text();

    let data;

    try {

      data =
        JSON.parse(text);

    } catch {

      throw new Error(
        "WingoBot returned invalid JSON"
      );

    }

    if (!response.ok) {

      throw new Error(
        `WingoBot HTTP ${response.status}`
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
        "WingoBot history empty"
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


/* =========================================================
   LIVE REFRESH
========================================================= */

async function refreshLive() {

  if (fetchRunning) {
    return;
  }

  fetchRunning = true;

  try {

    const data =
      await fetchWingo();

    const previousIssue =
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

    if (
      previousIssue &&
      String(previousIssue) !==
      String(data.currentIssue)
    ) {

      live.lastIssueChange =
        now();

      /*
       New round.
       Existing analysis belongs to
       old round, so clear it.
      */

      analysis.active = false;
      analysis.issue = null;
      analysis.startedAt = 0;
      analysis.endsAt = 0;

      console.log(
        "[NEW ISSUE]",
        data.currentIssue
      );

    }

    await settlePredictions();

  } catch (error) {

    live.error =
      error.message;

    console.error(
      "[WINGOBOT ERROR]",
      error.message
    );

    /*
      Old valid data is retained.
    */

    if (!live.currentIssue) {
      live.ok = false;
    }

  } finally {

    fetchRunning = false;

  }
}


/* =========================================================
   AI ENGINE
========================================================= */

function analyzeAI(history) {

  const rows =
    Array.isArray(history)

      ? history
          .filter(
            x =>
              x.result === "BIG" ||
              x.result === "SMALL"
          )
          .slice(0, 100)

      : [];


  if (rows.length < 10) {

    return {

      prediction: "SMALL",

      confidence: 50,

      quality: "INSUFFICIENT",

      score: 0,

      agreement: 0,

      patternMatches: 0,

      streak: 0,

      switchRate: 0,

      entropy: 1,

      signals: {},

      transitions: {},

      windows: {}

    };

  }


  const seq =
    rows.map(
      x => x.result
    );


  /* =====================================================
     RECENCY SIGNAL
  ===================================================== */

  let recentBig = 0;
  let recentSmall = 0;

  const recent =
    seq.slice(0, 12);

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


  /* =====================================================
     TRANSITION SIGNAL
  ===================================================== */

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

    if (total) {

      transitionScore =
        (BB - BS) / total;

    }

  } else {

    const total =
      SB + SS;

    if (total) {

      transitionScore =
        (SB - SS) / total;

    }

  }


  /* =====================================================
     PATTERN MATCHING
  ===================================================== */

  const PATTERN_LENGTH = 5;

  const currentPattern =
    seq
      .slice(
        0,
        PATTERN_LENGTH
      )
      .join("-");

  let patternBig = 0;
  let patternSmall = 0;
  let patternMatches = 0;

  for (
    let i = PATTERN_LENGTH;
    i < seq.length;
    i++
  ) {

    const oldPattern =
      seq
        .slice(
          i,
          i + PATTERN_LENGTH
        )
        .join("-");

    if (
      oldPattern ===
      currentPattern
    ) {

      const following =
        seq[i - 1];

      if (
        following === "BIG"
      ) {

        patternBig++;

      } else if (
        following === "SMALL"
      ) {

        patternSmall++;

      }

      patternMatches++;

    }

  }


  let patternScore = 0;

  if (
    patternMatches > 0
  ) {

    patternScore =
      (
        patternBig -
        patternSmall
      ) /
      patternMatches;

  }


  /* =====================================================
     STREAK
  ===================================================== */

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
    streak >= 5
  ) {

    streakScore =
      latest === "BIG"
        ? -0.30
        : 0.30;

  } else if (
    streak >= 3
  ) {

    streakScore =
      latest === "BIG"
        ? -0.12
        : 0.12;

  }


  /* =====================================================
     MULTI WINDOW
  ===================================================== */

  function bigRatio(arr) {

    if (!arr.length) {
      return 0.5;
    }

    let count = 0;

    for (
      const x of arr
    ) {

      if (x === "BIG") {
        count++;
      }

    }

    return count / arr.length;

  }


  const shortRatio =
    bigRatio(
      seq.slice(0, 5)
    );

  const mediumRatio =
    bigRatio(
      seq.slice(0, 20)
    );

  const longRatio =
    bigRatio(seq);


  const multiWindowScore =

    (
      shortRatio -
      0.5
    ) * 0.50 +

    (
      mediumRatio -
      0.5
    ) * 0.30 +

    (
      longRatio -
      0.5
    ) * 0.20;


  /* =====================================================
     SWITCH RATE
  ===================================================== */

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
    switchRate >= 0.75
  ) {

    switchScore =
      latest === "BIG"
        ? -0.10
        : 0.10;

  }


  /* =====================================================
     ENTROPY
  ===================================================== */

  const bigCount =
    seq.filter(
      x => x === "BIG"
    ).length;

  const p =
    bigCount /
    seq.length;

  let entropy = 0;

  if (
    p > 0 &&
    p < 1
  ) {

    entropy =
      -(
        p *
        Math.log2(p)
      ) -
      (
        (1 - p) *
        Math.log2(1 - p)
      );

  }


  /* =====================================================
     REVERSAL
  ===================================================== */

  let reversalScore = 0;

  if (
    streak >= 4
  ) {

    reversalScore =
      latest === "BIG"
        ? -0.18
        : 0.18;

  }


  /* =====================================================
     ENSEMBLE SCORE
  ===================================================== */

  const score =

    recentScore * 0.20 +

    transitionScore * 0.23 +

    patternScore * 0.27 +

    multiWindowScore * 0.10 +

    streakScore * 0.08 +

    switchScore * 0.04 +

    reversalScore * 0.08;


  /* =====================================================
     AGREEMENT
  ===================================================== */

  const signals = [

    recentScore,
    transitionScore,
    patternScore,
    multiWindowScore,
    streakScore,
    switchScore,
    reversalScore

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


  /* =====================================================
     FINAL RESULT
  ===================================================== */

  let prediction;

  if (
    score > 0.025
  ) {

    prediction =
      "BIG";

  } else if (
    score < -0.025
  ) {

    prediction =
      "SMALL";

  } else if (
    transitionScore >
    recentScore
  ) {

    prediction =
      "BIG";

  } else if (
    transitionScore <
    recentScore
  ) {

    prediction =
      "SMALL";

  } else {

    /*
      Neutral zone:
      alternate instead of simply
      selecting the most frequent side.
    */

    prediction =
      latest === "BIG"
        ? "SMALL"
        : "BIG";

  }


  /* =====================================================
     CONFIDENCE
  ===================================================== */

  let confidence =

    50 +

    Math.abs(score) * 65 +

    agreement * 12 +

    Math.min(
      10,
      patternMatches * 2
    );


  if (
    entropy < 0.75
  ) {

    confidence -= 5;

  }


  confidence =
    Math.round(
      Math.max(
        50,
        Math.min(
          88,
          confidence
        )
      )
    );


  let quality =
    "WEAK";

  if (
    agreement >= 0.70 &&
    patternMatches >= 2 &&
    Math.abs(score) >= 0.15
  ) {

    quality =
      "STRONG";

  } else if (
    agreement >= 0.50
  ) {

    quality =
      "MODERATE";

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
        agreement.toFixed(3)
      ),

    patternMatches,

    streak,

    switchRate:
      Number(
        switchRate.toFixed(3)
      ),

    entropy:
      Number(
        entropy.toFixed(3)
      ),

    signals: {

      recency:
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

      multiWindow:
        Number(
          multiWindowScore.toFixed(3)
        ),

      streak:
        Number(
          streakScore.toFixed(3)
        ),

      switch:
        Number(
          switchScore.toFixed(3)
        ),

      reversal:
        Number(
          reversalScore.toFixed(3)
        )

    },

    transitions: {
      BB,
      BS,
      SB,
      SS
    },

    windows: {

      short:
        Number(
          shortRatio.toFixed(3)
        ),

      medium:
        Number(
          mediumRatio.toFixed(3)
        ),

      long:
        Number(
          longRatio.toFixed(3)
        )

    }

  };

}


/* =====================================================
   GET PREDICTION FOR ISSUE
========================================================= */

async function getPrediction(issue) {

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
        [
          String(issue)
        ]
      );

    return (
      r.rows[0] ||
      null
    );

  }

  return (
    memory.predictions.find(
      p =>
        String(
          p.target_issue
        ) ===
        String(issue)
    ) ||
    null
  );

}


/* =====================================================
   GET LAST REAL PREDICTION
========================================================= */

async function getLastPrediction() {

  if (pool) {

    const r =
      await pool.query(`
        SELECT *
        FROM prediction_records
        WHERE prediction IN ('BIG','SMALL')
        ORDER BY id DESC
        LIMIT 1
      `);

    return (
      r.rows[0] ||
      null
    );

  }

  return (
    memory.predictions
      .filter(
        p =>
          p.prediction === "BIG" ||
          p.prediction === "SMALL"
      )[0] ||
    null
  );

}


/* =====================================================
   SAVE PREDICTION
========================================================= */

async function savePrediction(
  issue,
  prediction,
  confidence
) {

  const existing =
    await getPrediction(issue);

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
        VALUES
        ($1,$2,$3,$4,$5)
        RETURNING *
        `,
        [
          String(issue),
          prediction,
          Number(confidence),
          MODEL_VERSION,
          now()
        ]
      );

    return r.rows[0];

  }


  const item = {

    id:
      memory.predictionId++,

    target_issue:
      String(issue),

    prediction,

    confidence:
      Number(confidence),

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


  memory.predictions.unshift(
    item
  );


  if (
    memory.predictions.length >
    500
  ) {

    memory.predictions =
      memory.predictions.slice(
        0,
        500
      );

  }


  return item;

}


/* =====================================================
   SETTLE PREDICTIONS
========================================================= */

async function settlePredictions() {

  if (
    !live.history.length
  ) {
    return;
  }


  for (
    const row of
    live.history.slice(0, 100)
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
          )

          &&

          (
            p.prediction === "BIG" ||
            p.prediction === "SMALL"
          )

          &&

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
   CYCLE RULE
========================================================= */

async function getCycleState(
  currentIssue
) {

  const last =
    await getLastPrediction();


  /*
    No previous prediction:
    prediction allowed.
  */

  if (!last) {

    return {

      mode:
        "PREDICTION",

      skipRound:
        0,

      skipRemaining:
        0,

      lastPrediction:
        null

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

      mode:
        "PREDICTION",

      skipRound:
        0,

      skipRemaining:
        0,

      lastPrediction:
        last

    };

  }


  /*
    Same period:
    existing prediction should already
    be handled before this function.
  */

  if (
    diff === 0
  ) {

    return {

      mode:
        "PREDICTION_EXISTING",

      skipRound:
        0,

      skipRemaining:
        0,

      lastPrediction:
        last

    };

  }


  /*
    EXACT 4 SKIP ROUNDS.

    Prediction 100
    101 skip 1
    102 skip 2
    103 skip 3
    104 skip 4
    105 prediction allowed
  */

  if (
    diff >= 1 &&
    diff <= SKIP_ROUNDS
  ) {

    return {

      mode:
        "SKIP",

      skipRound:
        diff,

      skipRemaining:
        SKIP_ROUNDS - diff,

      lastPrediction:
        last

    };

  }


  /*
    Four skips finished.
  */

  if (
    diff > SKIP_ROUNDS
  ) {

    return {

      mode:
        "PREDICTION",

      skipRound:
        0,

      skipRemaining:
        0,

      lastPrediction:
        last

    };

  }


  return {

    mode:
      "PREDICTION",

    skipRound:
      0,

    skipRemaining:
      0,

    lastPrediction:
      last

  };

}


/* =====================================================
   START ANALYSIS
========================================================= */

function startAnalysis(issue) {

  if (
    analysis.active &&
    analysis.issue ===
      String(issue)
  ) {

    return;

  }


  analysis.active =
    true;

  analysis.issue =
    String(issue);

  analysis.startedAt =
    now();

  analysis.endsAt =
    now() +
    ANALYSIS_MS;


  console.log(
    "[ANALYSIS START]",
    issue
  );

}


/* =====================================================
   RESET ANALYSIS
========================================================= */

function resetAnalysis() {

  analysis.active =
    false;

  analysis.issue =
    null;

  analysis.startedAt =
    0;

  analysis.endsAt =
    0;

}


/* =====================================================
   PREDICTION STATE
========================================================= */

async function getPredictionState() {

  if (
    !live.ok ||
    !live.currentIssue
  ) {

    return {

      result:
        "WAIT",

      status:
        "OFFLINE",

      confidence:
        0,

      targetPeriod:
        null,

      analysisRemaining:
        0,

      analysisProgress:
        0,

      skipRound:
        0,

      skipTotal:
        SKIP_ROUNDS,

      skipRemaining:
        0

    };

  }


  const currentIssue =
    String(
      live.currentIssue
    );


  /*
  ========================================================
  EXISTING PREDICTION FIRST
  ========================================================
  */

  const existing =
    await getPrediction(
      currentIssue
    );


  if (existing) {

    resetAnalysis();


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

      status,

      confidence:
        Number(
          existing.confidence || 0
        ),

      targetPeriod:
        String(
          existing.target_issue
        ),

      actualNumber:
        existing.actual_number,

      actualResult:
        existing.actual_result,

      analysisRemaining:
        0,

      analysisProgress:
        100,

      analysisTotal:
        4,

      skipRound:
        0,

      skipTotal:
        SKIP_ROUNDS,

      skipRemaining:
        0

    };

  }


  /*
  ========================================================
  CHECK CYCLE
  ========================================================
  */

  const cycle =
    await getCycleState(
      currentIssue
    );


  /*
  ========================================================
  SKIP MODE
  ========================================================
  */

  if (
    cycle.mode === "SKIP"
  ) {

    /*
      IMPORTANT:
      No analysis is started here.
    */

    resetAnalysis();


    return {

      result:
        "SKIP",

      status:
        "COOLDOWN",

      confidence:
        0,

      targetPeriod:
        currentIssue,

      skipRound:
        cycle.skipRound,

      skipTotal:
        SKIP_ROUNDS,

      skipRemaining:
        cycle.skipRemaining,

      analysisRemaining:
        0,

      analysisProgress:
        0,

      analysisTotal:
        4

    };

  }


  /*
  ========================================================
  PREDICTION ROUND
  ========================================================
  */

  startAnalysis(
    currentIssue
  );


  const remainingMs =
    Math.max(
      0,
      analysis.endsAt -
      now()
    );


  const elapsedMs =
    Math.max(
      0,
      now() -
      analysis.startedAt
    );


  /*
  ========================================================
  4 SECOND ANALYSIS
  ========================================================
  */

  if (
    remainingMs > 0
  ) {

    const remaining =
      Math.ceil(
        remainingMs / 1000
      );


    const progress =
      Math.min(
        100,
        Math.floor(
          (
            elapsedMs /
            ANALYSIS_MS
          ) * 100
        )
      );


    return {

      result:
        "WAIT",

      status:
        "ANALYZING",

      confidence:
        0,

      targetPeriod:
        currentIssue,

      analysisRemaining:
        remaining,

      analysisProgress:
        progress,

      analysisTotal:
        4,

      skipRound:
        0,

      skipTotal:
        SKIP_ROUNDS,

      skipRemaining:
        0

    };

  }


  /*
  ========================================================
  FINALIZE PREDICTION
  ========================================================
  */

  if (
    predictionRunning
  ) {

    return {

      result:
        "WAIT",

      status:
        "FINALIZING",

      confidence:
        0,

      targetPeriod:
        currentIssue,

      analysisRemaining:
        0,

      analysisProgress:
        100,

      analysisTotal:
        4,

      skipRound:
        0,

      skipTotal:
        SKIP_ROUNDS,

      skipRemaining:
        0

    };

  }


  predictionRunning =
    true;


  try {

    /*
      Duplicate check again.
    */

    const doubleCheck =
      await getPrediction(
        currentIssue
      );


    if (doubleCheck) {

      resetAnalysis();


      return {

        result:
          doubleCheck.prediction,

        status:
          doubleCheck.actual_result
            ? (
                doubleCheck.prediction ===
                doubleCheck.actual_result
                  ? "WIN"
                  : "LOSS"
              )
            : "PENDING",

        confidence:
          Number(
            doubleCheck.confidence || 0
          ),

        targetPeriod:
          String(
            doubleCheck.target_issue
          ),

        actualNumber:
          doubleCheck.actual_number,

        actualResult:
          doubleCheck.actual_result,

        analysisRemaining:
          0,

        analysisProgress:
          100,

        analysisTotal:
          4

      };

    }


    /*
      AI runs ONLY after 4 seconds.
    */

    const ai =
      analyzeAI(
        live.history
      );


    const prediction =
      ai.prediction === "BIG" ||
      ai.prediction === "SMALL"

        ? ai.prediction

        : "SMALL";


    const saved =
      await savePrediction(
        currentIssue,
        prediction,
        ai.confidence
      );


    resetAnalysis();


    console.log(
      "[PREDICTION]",
      currentIssue,
      prediction,
      ai.confidence + "%",
      ai.quality
    );


    return {

      result:
        saved.prediction,

      status:
        "PENDING",

      confidence:
        Number(
          saved.confidence || 0
        ),

      targetPeriod:
        String(
          saved.target_issue
        ),

      actualNumber:
        saved.actual_number,

      actualResult:
        saved.actual_result,

      analysisRemaining:
        0,

      analysisProgress:
        100,

      analysisTotal:
        4,

      ai: {

        quality:
          ai.quality,

        score:
          ai.score,

        agreement:
          ai.agreement,

        patternMatches:
          ai.patternMatches,

        streak:
          ai.streak,

        switchRate:
          ai.switchRate,

        entropy:
          ai.entropy,

        signals:
          ai.signals,

        transitions:
          ai.transitions,

        windows:
          ai.windows

      }

    };

  } finally {

    predictionRunning =
      false;

  }

}


/* =========================================================
   PUBLIC STATE
========================================================= */

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
    live.history[0] ||
    null;


  const ai =
    analyzeAI(
      live.history
    );


  return {

    ok:
      true,

    live:
      live.ok,

    liveError:
      live.error,

    currentPeriod:
      live.currentIssue,

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

    ai: {

      model:
        MODEL_VERSION,

      prediction:
        ai.prediction,

      confidence:
        ai.confidence,

      quality:
        ai.quality,

      score:
        ai.score,

      agreement:
        ai.agreement,

      patternMatches:
        ai.patternMatches,

      streak:
        ai.streak,

      switchRate:
        ai.switchRate,

      entropy:
        ai.entropy,

      signals:
        ai.signals,

      transitions:
        ai.transitions,

      windows:
        ai.windows

    },

    cycle: {

      analysisSeconds:
        ANALYSIS_MS / 1000,

      skipRounds:
        SKIP_ROUNDS

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
        analysis.active,

      issue:
        analysis.issue,

      startedAt:
        analysis.startedAt,

      endsAt:
        analysis.endsAt

    },

    serverTime:
      now()

  };

}


/* =========================================================
   BODY READER
========================================================= */

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


/* =========================================================
   JSON RESPONSE
========================================================= */

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
        "no-store, no-cache, must-revalidate, proxy-revalidate",

      Pragma:
        "no-cache",

      Expires:
        "0",

      "Access-Control-Allow-Origin":
        "*",

      "Access-Control-Allow-Headers":
        "Content-Type",

      "Access-Control-Allow-Methods":
        "GET,POST,OPTIONS"

    }
  );


  res.end(
    JSON.stringify(data)
  );

}


/* =========================================================
   ADMIN AUTH
========================================================= */

function adminAuthorized(url) {

  return (
    url.searchParams.get(
      "key"
    ) ===
    ADMIN_KEY
  );

}


/* =========================================================
   FILE SERVER
========================================================= */

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

  } else if (
    fileName.endsWith(".css")
  ) {

    contentType =
      "text/css; charset=utf-8";

  } else if (
    fileName.endsWith(".js")
  ) {

    contentType =
      "application/javascript; charset=utf-8";

  } else if (
    fileName.endsWith(".mp3")
  ) {

    contentType =
      "audio/mpeg";

  }


  res.writeHead(
    200,
    {

      "Content-Type":
        contentType,

      "Cache-Control":
        "no-cache, no-store, must-revalidate"

    }
  );


  fs.createReadStream(
    file
  ).pipe(res);

}
async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => {
      data += chunk;
      if (data.length > 2_000_000) {
        reject(new Error("Request too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(text);
}

function adminAuthorized(req) {
  const url = new URL(req.url, "http://localhost");
  const key =
    req.headers["x-admin-key"] ||
    req.headers["authorization"]?.replace(/^Bearer\s+/i, "") ||
    url.searchParams.get("key");

  return String(key || "").trim() === ADMIN_KEY;
}

async function dbQuery(text, params = []) {
  if (!pool) return null;
  return pool.query(text, params);
}

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

  const r = await pool.query(
    "SELECT id FROM access_keys WHERE access_key=$1 LIMIT 1",
    [DEFAULT_ACCESS_KEY]
  );

  if (!r.rows.length) {
    await pool.query(
      `INSERT INTO access_keys
       (access_key,device_id,created_at,last_seen)
       VALUES($1,NULL,$2,0)`,
      [DEFAULT_ACCESS_KEY, now()]
    );
  }
}

async function keyCheck(key, deviceId) {
  key = String(key || "").trim();
  deviceId = String(deviceId || "").trim();

  if (!key || !deviceId) {
    return {
      ok: false,
      error: "KEY_AND_DEVICE_REQUIRED"
    };
  }

  if (!pool) {
    const item = memory.keys.get(key);

    if (!item) {
      return {
        ok: false,
        error: "INVALID_KEY"
      };
    }

    if (item.device_id && item.device_id !== deviceId) {
      return {
        ok: false,
        error: "KEY_ALREADY_USED"
      };
    }

    item.device_id = deviceId;
    item.last_seen = now();

    return {
      ok: true,
      key: item.access_key,
      deviceId,
      bound: true
    };
  }

  const r = await pool.query(
    "SELECT * FROM access_keys WHERE access_key=$1 LIMIT 1",
    [key]
  );

  if (!r.rows.length) {
    return {
      ok: false,
      error: "INVALID_KEY"
    };
  }

  const item = r.rows[0];

  if (item.device_id && item.device_id !== deviceId) {
    return {
      ok: false,
      error: "KEY_ALREADY_USED"
    };
  }

  await pool.query(
    `UPDATE access_keys
     SET device_id=$1,last_seen=$2
     WHERE id=$3`,
    [deviceId, now(), item.id]
  );

  return {
    ok: true,
    key: item.access_key,
    deviceId,
    bound: true
  };
}

async function verifyAccess(req) {
  const key =
    req.headers["x-access-key"] ||
    req.headers["authorization"]?.replace(/^Bearer\s+/i, "");

  const deviceId =
    req.headers["x-device-id"] ||
    req.headers["x-device"];

  return keyCheck(key, deviceId);
}

function cleanNumber(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 9
    ? n
    : null;
}

function normalizeHistory(raw) {
  let arr = [];

  if (Array.isArray(raw)) {
    arr = raw;
  } else if (raw && Array.isArray(raw.data)) {
    arr = raw.data;
  } else if (raw && Array.isArray(raw.history)) {
    arr = raw.history;
  } else if (raw && Array.isArray(raw.results)) {
    arr = raw.results;
  } else if (raw && Array.isArray(raw.list)) {
    arr = raw.list;
  } else if (raw && raw.data && Array.isArray(raw.data.list)) {
    arr = raw.data.list;
  }

  const out = [];

  for (const item of arr) {
    if (typeof item === "number" || typeof item === "string") {
      const n = cleanNumber(item);
      if (n !== null) {
        out.push({
          issue: null,
          number: n,
          result: resultType(n)
        });
      }
      continue;
    }

    if (!item || typeof item !== "object") continue;

    const possibleNumber =
      item.number ??
      item.result ??
      item.openNumber ??
      item.open_num ??
      item.num ??
      item.value;

    let n = cleanNumber(possibleNumber);

    if (n === null && typeof item.result === "string") {
      const m = item.result.match(/\d/);
      if (m) n = Number(m[0]);
    }

    if (n === null) continue;

    const issue =
      item.issue ??
      item.period ??
      item.periodNumber ??
      item.period_id ??
      item.draw ??
      item.id ??
      null;

    out.push({
      issue: issue === null ? null : String(issue),
      number: n,
      result: resultType(n)
    });
  }

  const seen = new Set();
  return out.filter(x => {
    const k = `${x.issue}|${x.number}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function fetchWingo() {
  if (!WINGOBOT_TOKEN) {
    throw new Error("WINGOBOT_TOKEN is missing");
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT
  );

  try {
    const r = await fetch(WINGOBOT_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${WINGOBOT_TOKEN}`,
        Accept: "application/json"
      },
      signal: controller.signal
    });

    if (!r.ok) {
      throw new Error(`WingoBot HTTP ${r.status}`);
    }

    const json = await r.json();
    const history = normalizeHistory(json);

    if (!history.length) {
      throw new Error("No usable history returned");
    }

    let currentIssue =
      json.currentIssue ??
      json.current_issue ??
      json.issue ??
      json.period ??
      json.periodNumber ??
      null;

    if (currentIssue !== null) {
      currentIssue = String(currentIssue);
    }

    if (!currentIssue) {
      const withIssue = history.find(x => x.issue);
      if (withIssue) currentIssue = withIssue.issue;
    }

    return {
      history,
      currentIssue,
      raw: json
    };
  } finally {
    clearTimeout(timer);
  }
}

function orderedHistory(history) {
  return [...history]
    .filter(x => Number.isInteger(x.number))
    .slice(0, 100);
}

function shannonEntropy(values) {
  if (!values.length) return 0;

  let b = 0;
  let s = 0;

  for (const v of values) {
    if (v === "BIG") b++;
    else s++;
  }

  const total = b + s;
  if (!total) return 0;

  const pb = b / total;
  const ps = s / total;

  let e = 0;

  if (pb > 0) e -= pb * Math.log2(pb);
  if (ps > 0) e -= ps * Math.log2(ps);

  return e;
}

function patternSignal(results) {
  if (results.length < 6) return 0;

  const last5 = results.slice(0, 5).join("");

  let big = 0;
  let small = 0;
  let matches = 0;

  for (let i = 6; i < results.length; i++) {
    const old = results.slice(i, i + 5).join("");

    if (old === last5) {
      matches++;

      const next = results[i - 1];

      if (next === "BIG") big++;
      if (next === "SMALL") small++;
    }
  }

  if (!matches) return 0;

  return (big - small) / matches;
}

function transitionSignal(results) {
  if (results.length < 2) return 0;

  const a = results[1];
  const b = results[0];

  let score = 0;

  if (a === "BIG" && b === "BIG") score += 0.10;
  if (a === "SMALL" && b === "SMALL") score -= 0.10;

  if (a !== b) {
    if (b === "BIG") score += 0.05;
    else score -= 0.05;
  }

  return score;
}

function streakSignal(results) {
  if (!results.length) return 0;

  const first = results[0];
  let count = 0;

  for (const x of results) {
    if (x !== first) break;
    count++;
  }

  if (count >= 5) {
    return first === "BIG" ? -0.35 : 0.35;
  }

  if (count === 4) {
    return first === "BIG" ? -0.22 : 0.22;
  }

  if (count === 3) {
    return first === "BIG" ? -0.12 : 0.12;
  }

  return 0;
}

function weightedSignal(results, count) {
  const data = results.slice(0, count);

  if (!data.length) return 0;

  let score = 0;
  let weight = 0;

  for (let i = 0; i < data.length; i++) {
    const w = count - i;

    score +=
      (data[i] === "BIG" ? 1 : -1) * w;

    weight += w;
  }

  return weight ? score / weight : 0;
}

function numberSignal(numbers) {
  if (!numbers.length) return 0;

  let score = 0;

  for (let i = 0; i < numbers.length; i++) {
    const n = numbers[i];
    const w = numbers.length - i;

    if (n >= 7) score += 0.10 * w;
    else if (n <= 2) score -= 0.10 * w;
  }

  const max =
    ((numbers.length * (numbers.length + 1)) / 2) * 0.10;

  if (!max) return 0;

  return score / max;
}

function analyzeAI(history) {
  const data = orderedHistory(history);

  if (data.length < 10) {
    return {
      prediction: null,
      confidence: 0,
      quality: "INSUFFICIENT",
      reason: "Need at least 10 results"
    };
  }

  const results = data.map(x => x.result);
  const numbers = data.map(x => x.number);

  const short = weightedSignal(results, Math.min(6, results.length));
  const medium = weightedSignal(results, Math.min(12, results.length));
  const long = weightedSignal(results, Math.min(24, results.length));

  const transition = transitionSignal(results);
  const streak = streakSignal(results);
  const pattern = patternSignal(results);
  const number = numberSignal(numbers);

  const entropy = shannonEntropy(
    results.slice(0, 20)
  );

  let switches = 0;

  for (let i = 1; i < Math.min(20, results.length); i++) {
    if (results[i] !== results[i - 1]) switches++;
  }

  const switchRate =
    Math.min(1, switches / 19);

  let score =
    short * 0.30 +
    medium * 0.18 +
    long * 0.10 +
    transition * 0.10 +
    streak * 0.12 +
    pattern * 0.12 +
    number * 0.08;

  if (switchRate > 0.70) {
    score *= 0.85;
  }

  if (entropy > 0.98) {
    score *= 0.75;
  }

  score = Math.max(-1, Math.min(1, score));

  const prediction =
    score >= 0 ? "BIG" : "SMALL";

  const strength = Math.abs(score);

  let confidence =
    50 + Math.round(strength * 42);

  if (entropy > 0.98) confidence -= 7;
  if (data.length < 15) confidence -= 5;

  confidence = Math.max(
    51,
    Math.min(91, confidence)
  );

  let quality = "MEDIUM";

  if (confidence >= 75) quality = "HIGH";
  else if (confidence < 62) quality = "LOW";

  return {
    prediction,
    confidence,
    quality,
    score: Number(score.toFixed(4)),
    entropy: Number(entropy.toFixed(4)),
    switchRate: Number(switchRate.toFixed(4)),
    signals: {
      short: Number(short.toFixed(4)),
      medium: Number(medium.toFixed(4)),
      long: Number(long.toFixed(4)),
      transition: Number(transition.toFixed(4)),
      streak: Number(streak.toFixed(4)),
      pattern: Number(pattern.toFixed(4)),
      number: Number(number.toFixed(4))
    },
    sampleSize: data.length,
    model: MODEL_VERSION
  };
}

async function getPrediction(issue) {
  if (!issue) return null;

  if (!pool) {
    return (
      memory.predictions
        .filter(x => x.target_issue === String(issue))
        .sort((a, b) => b.created_at - a.created_at)[0] ||
      null
    );
  }

  const r = await pool.query(
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
        .sort((a, b) => b.created_at - a.created_at)[0] ||
      null
    );
  }

  const r = await pool.query(
    `SELECT *
     FROM prediction_records
     ORDER BY id DESC
     LIMIT 1`
  );

  return r.rows[0] || null;
}

async function savePrediction(issue, ai) {
  if (!issue || !ai?.prediction) return null;

  const existing = await getPrediction(issue);

  if (existing) return existing;

  const row = {
    id: memory.predictionId++,
    target_issue: String(issue),
    prediction: ai.prediction,
    confidence: ai.confidence,
    model_version: MODEL_VERSION,
    actual_number: null,
    actual_result: null,
    created_at: now(),
    settled_at: null
  };

  if (!pool) {
    memory.predictions.push(row);
    return row;
  }

  const r = await pool.query(
    `INSERT INTO prediction_records
      (target_issue,prediction,confidence,model_version,created_at)
     VALUES($1,$2,$3,$4,$5)
     RETURNING *`,
    [
      row.target_issue,
      row.prediction,
      row.confidence,
      row.model_version,
      row.created_at
    ]
  );

  return r.rows[0];
}

async function settlePredictions() {
  if (!live.history.length) return;

  const map = new Map();

  for (const x of live.history) {
    if (x.issue !== null) {
      map.set(String(x.issue), x.number);
    }
  }

  if (!map.size) return;

  if (!pool) {
    for (const p of memory.predictions) {
      if (
        p.actual_result === null &&
        map.has(String(p.target_issue))
      ) {
        const n = map.get(String(p.target_issue));
        p.actual_number = n;
        p.actual_result = resultType(n);
        p.settled_at = now();
      }
    }
    return;
  }

  const rows = await pool.query(`
    SELECT id,target_issue,prediction
    FROM prediction_records
    WHERE actual_result IS NULL
    ORDER BY id DESC
    LIMIT 100
  `);

  for (const p of rows.rows) {
    const n = map.get(String(p.target_issue));

    if (n === undefined) continue;

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

async function getCycleState(currentIssue) {
  const last = await getLastPrediction();

  if (!last) {
    return {
      mode: "PREDICT",
      skipRound: 0,
      skipTotal: 0,
      skipRemaining: 0
    };
  }

  const diff = issueDiff(
    currentIssue,
    last.target_issue
  );

  if (diff === null) {
    return {
      mode: "PREDICT",
      skipRound: 0,
      skipTotal: 0,
      skipRemaining: 0
    };
  }

  if (diff <= 0) {
    return {
      mode: "PREDICTED",
      skipRound: 0,
      skipTotal: 0,
      skipRemaining: 0
    };
  }

  if (diff >= 1 && diff <= SKIP_ROUNDS) {
    return {
      mode: "SKIP",
      skipRound: diff,
      skipTotal: SKIP_ROUNDS,
      skipRemaining: SKIP_ROUNDS - diff + 1
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

async function tickPredictionEngine() {
  if (
    !live.ok ||
    !live.currentIssue ||
    predictionRunning
  ) {
    return;
  }

  predictionRunning = true;

  try {
    const issue = String(live.currentIssue);

    const existing = await getPrediction(issue);

    if (existing) {
      resetAnalysis();
      return;
    }

    const cycle = await getCycleState(issue);

    if (cycle.mode === "SKIP") {
      resetAnalysis();
      return;
    }

    if (cycle.mode !== "PREDICT") {
      resetAnalysis();
      return;
    }

    if (!analysis.active || analysis.issue !== issue) {
      analysis.active = true;
      analysis.issue = issue;
      analysis.startedAt = now();
      analysis.endsAt =
        analysis.startedAt + ANALYSIS_MS;

      return;
    }

    if (now() < analysis.endsAt) {
      return;
    }

    const ai = analyzeAI(live.history);

    if (!ai.prediction) {
      resetAnalysis();
      return;
    }

    await savePrediction(issue, ai);

    resetAnalysis();

    await settlePredictions();

  } catch (e) {
    console.error(
      "Prediction engine error:",
      e.message
    );
  } finally {
    predictionRunning = false;
  }
}

async function refreshLive() {
  if (fetchRunning) return;

  fetchRunning = true;

  try {
    const data = await fetchWingo();

    const previous = live.currentIssue;

    live.history = data.history;
    live.currentIssue = data.currentIssue;
    live.ok = true;
    live.error = null;
    live.fetched++;
    live.updated = now();
    live.lastFetch = now();

    if (
      previous &&
      live.currentIssue &&
      String(previous) !== String(live.currentIssue)
    ) {
      live.lastIssueChange = now();
      resetAnalysis();
    }

    await settlePredictions();

  } catch (e) {
    live.ok = false;
    live.error = e.message;
    live.updated = now();
  } finally {
    fetchRunning = false;
  }
}

async function predictionView() {
  const issue = live.currentIssue;

  if (!issue) {
    return {
      result: "WAIT",
      status: "WAITING",
      prediction: null,
      message: "Waiting for live game data"
    };
  }

  const existing = await getPrediction(issue);

  if (existing) {
    return {
      result: existing.prediction,
      status: "PREDICTED",
      prediction: existing.prediction,
      confidence: Number(existing.confidence || 0),
      model: existing.model_version,
      issue,
      analysis: {
        active: false,
        elapsed: ANALYSIS_MS,
        remaining: 0,
        complete: true
      }
    };
  }

  const cycle = await getCycleState(issue);

  if (cycle.mode === "SKIP") {
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

  if (
    !analysis.active ||
    analysis.issue !== String(issue)
  ) {
    analysis.active = true;
    analysis.issue = String(issue);
    analysis.startedAt = now();
    analysis.endsAt =
      analysis.startedAt + ANALYSIS_MS;
  }

  const elapsed =
    Math.max(
      0,
      Math.min(
        ANALYSIS_MS,
        now() - analysis.startedAt
      )
    );

  const remaining =
    Math.max(
      0,
      analysis.endsAt - now()
    );

  if (remaining > 0) {
    return {
      result: "ANALYZING",
      status: "ANALYZING",
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

  await tickPredictionEngine();

  const after = await getPrediction(issue);

  if (after) {
    return {
      result: after.prediction,
      status: "PREDICTED",
      prediction: after.prediction,
      confidence: Number(after.confidence || 0),
      model: after.model_version,
      issue,
      cycle,
      analysis: {
        active: false,
        elapsed: ANALYSIS_MS,
        remaining: 0,
        complete: true
      }
    };
  }

  return {
    result: "ANALYZING",
    status: "ANALYZING",
    prediction: null,
    issue,
    cycle,
    analysis: {
      active: true,
      elapsed: ANALYSIS_MS,
      remaining: 0,
      complete: false
    }
  };
}

async function buildState() {
  const pred = await predictionView();

  const ai =
    live.history.length >= 10
      ? analyzeAI(live.history)
      : null;

  return {
    ok: true,

    currentPeriod: live.currentIssue,

    latestResult:
      live.history[0]
        ? {
            issue: live.history[0].issue,
            number: live.history[0].number,
            result: live.history[0].result
          }
        : null,

    prediction: pred,

    ai: ai
      ? {
          model: ai.model,
          confidence: ai.confidence,
          quality: ai.quality,
          sampleSize: ai.sampleSize,
          score: ai.score
        }
      : null,

    cycle:
      await getCycleState(live.currentIssue),

    recentResults:
      live.history.slice(0, 10),

    source: {
      ok: live.ok,
      fetched: live.fetched,
      updated: live.updated,
      error: live.error
    },

    analysisSession: {
      active: analysis.active,
      issue: analysis.issue,
      startedAt: analysis.startedAt,
      endsAt: analysis.endsAt,
      duration: ANALYSIS_MS
    },

    timing: {
      pollMs: POLL_MS,
      analysisMs: ANALYSIS_MS,
      skipRounds: SKIP_ROUNDS
    }
  };
}

async function adminKeys() {
  if (!pool) {
    return [...memory.keys.values()].map(x => ({
      id: x.id,
      access_key: x.access_key,
      device_id: x.device_id,
      created_at: x.created_at,
      last_seen: x.last_seen
    }));
  }

  const r = await pool.query(`
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

async function createAccessKey(custom) {
  const key =
    String(custom || "").trim() || makeKey();

  if (!pool) {
    if (memory.keys.has(key)) {
      throw new Error("KEY_ALREADY_EXISTS");
    }

    const item = {
      id: memory.keyId++,
      access_key: key,
      device_id: null,
      created_at: now(),
      last_seen: 0
    };

    memory.keys.set(key, item);
    return item;
  }

  const r = await pool.query(
    `INSERT INTO access_keys
     (access_key,device_id,created_at,last_seen)
     VALUES($1,NULL,$2,0)
     RETURNING *`,
    [key, now()]
  );

  return r.rows[0];
}

async function resetDevice(key) {
  if (!pool) {
    const item = memory.keys.get(String(key));

    if (!item) {
      throw new Error("KEY_NOT_FOUND");
    }

    item.device_id = null;
    item.last_seen = 0;

    return item;
  }

  const r = await pool.query(
    `UPDATE access_keys
     SET device_id=NULL,last_seen=0
     WHERE access_key=$1
     RETURNING *`,
    [String(key)]
  );

  if (!r.rows.length) {
    throw new Error("KEY_NOT_FOUND");
  }

  return r.rows[0];
}

async function deleteKey(key) {
  if (String(key) === DEFAULT_ACCESS_KEY) {
    throw new Error("DEFAULT_KEY_CANNOT_BE_DELETED");
  }

  if (!pool) {
    const ok = memory.keys.delete(String(key));

    if (!ok) {
      throw new Error("KEY_NOT_FOUND");
    }

    return true;
  }

  const r = await pool.query(
    `DELETE FROM access_keys
     WHERE access_key=$1`,
    [String(key)]
  );

  if (!r.rowCount) {
    throw new Error("KEY_NOT_FOUND");
  }

  return true;
}

async function adminPredictions() {
  if (!pool) {
    return [...memory.predictions]
      .sort((a, b) => b.id - a.id)
      .slice(0, 200);
  }

  const r = await pool.query(`
    SELECT *
    FROM prediction_records
    ORDER BY id DESC
    LIMIT 200
  `);

  return r.rows;
}

async function modelTest() {
  const data = orderedHistory(live.history);

  if (data.length < 20) {
    return {
      ok: false,
      error: "Need at least 20 historical results"
    };
  }

  let total = 0;
  let correct = 0;

  for (
    let i = data.length - 1;
    i >= 10;
    i--
  ) {
    const previous = data.slice(i);

    const ai = analyzeAI(previous);

    if (!ai.prediction) continue;

    total++;

    if (
      ai.prediction ===
      data[i - 1].result
    ) {
      correct++;
    }
  }

  return {
    ok: true,
    total,
    correct,
    accuracy: total
      ? Number(((correct / total) * 100).toFixed(2))
      : 0
  };
}

async function adminStatus() {
  const keys = await adminKeys();
  const predictions = await adminPredictions();

  const settled =
    predictions.filter(
      x => x.actual_result
    );

  const wins =
    settled.filter(
      x => x.prediction === x.actual_result
    ).length;

  const losses =
    settled.filter(
      x =>
        x.prediction &&
        x.actual_result &&
        x.prediction !== x.actual_result
    ).length;

  return {
    ok: true,
    serverTime: now(),
    uptime: process.uptime(),
    live,
    analysis,
    cycle:
      await getCycleState(live.currentIssue),
    stats: {
      keys: keys.length,
      predictions: predictions.length,
      settled: settled.length,
      wins,
      losses,
      accuracy: settled.length
        ? Number(
            ((wins / settled.length) * 100)
              .toFixed(2)
          )
        : 0
    }
  };
}

async function handle(req, res) {
  const url = new URL(
    req.url,
    `http://${req.headers.host || "localhost"}`
  );

  const pathname = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers":
        "Content-Type,X-Access-Key,X-Device-ID,X-Admin-Key,Authorization",
      "Access-Control-Allow-Methods":
        "GET,POST,OPTIONS"
    });
    return res.end();
  }

  if (
    pathname === "/health" &&
    req.method === "GET"
  ) {
    return sendJson(res, 200, {
      ok: true,
      service: "DY AI WinGo",
      time: now()
    });
  }

  if (
    pathname === "/api/key/check" &&
    req.method === "POST"
  ) {
    try {
      const body = await readBody(req);

      const result = await keyCheck(
        body.key,
        body.deviceId
      );

      return sendJson(
        res,
        result.ok ? 200 : 403,
        result
      );
    } catch (e) {
      return sendJson(res, 500, {
        ok: false,
        error: e.message
      });
    }
  }

  if (
    pathname === "/api/state" &&
    req.method === "GET"
  ) {
    const auth = await verifyAccess(req);

    if (!auth.ok) {
      return sendJson(res, 403, auth);
    }

    try {
      return sendJson(
        res,
        200,
        await buildState()
      );
    } catch (e) {
      return sendJson(res, 500, {
        ok: false,
        error: e.message
      });
    }
  }

  if (
    pathname.startsWith("/api/admin/")
  ) {
    if (!adminAuthorized(req)) {
      return sendJson(res, 401, {
        ok: false,
        error: "ADMIN_UNAUTHORIZED"
      });
    }

    try {
      if (
        pathname === "/api/admin/keys" &&
        req.method === "GET"
      ) {
        return sendJson(res, 200, {
          ok: true,
          keys: await adminKeys()
        });
      }

      if (
        pathname === "/api/admin/keys" &&
        req.method === "POST"
      ) {
        const body = await readBody(req);

        const item =
          await createAccessKey(body.key);

        return sendJson(res, 200, {
          ok: true,
          key: item
        });
      }

      if (
        pathname === "/api/admin/reset-device" &&
        req.method === "POST"
      ) {
        const body = await readBody(req);

        const item =
          await resetDevice(body.key);

        return sendJson(res, 200, {
          ok: true,
          key: item
        });
      }

      if (
        pathname === "/api/admin/delete-key" &&
        req.method === "POST"
      ) {
        const body = await readBody(req);

        await deleteKey(body.key);

        return sendJson(res, 200, {
          ok: true
        });
      }

      if (
        pathname === "/api/admin/predictions" &&
        req.method === "GET"
      ) {
        return sendJson(res, 200, {
          ok: true,
          predictions:
            await adminPredictions()
        });
      }

      if (
        pathname === "/api/admin/status" &&
        req.method === "GET"
      ) {
        return sendJson(
          res,
          200,
          await adminStatus()
        );
      }

      if (
        pathname === "/api/admin/model-test" &&
        req.method === "GET"
      ) {
        return sendJson(
          res,
          200,
          await modelTest()
        );
      }

      if (
        pathname === "/api/admin/live-test" &&
        req.method === "GET"
      ) {
        const data =
          await fetchWingo();

        return sendJson(res, 200, {
          ok: true,
          currentIssue: data.currentIssue,
          count: data.history.length,
          history: data.history.slice(0, 20),
          ai: analyzeAI(data.history)
        });
      }

      if (
        pathname === "/api/admin/ping" &&
        req.method === "GET"
      ) {
        return sendJson(res, 200, {
          ok: true,
          admin: true,
          time: now()
        });
      }

      return sendJson(res, 404, {
        ok: false,
        error: "ADMIN_ROUTE_NOT_FOUND"
      });

    } catch (e) {
      return sendJson(res, 500, {
        ok: false,
        error: e.message
      });
    }
  }

  if (
    req.method === "GET" &&
    pathname === "/"
  ) {
    return serveFile(
      res,
      "prediction.html"
    );
  }

  if (
    req.method === "GET" &&
    pathname === "/prediction.html"
  ) {
    return serveFile(
      res,
      "prediction.html"
    );
  }

  if (
    req.method === "GET" &&
    pathname === "/admin.html"
  ) {
    return serveFile(
      res,
      "admin.html"
    );
  }

  if (
    req.method === "GET" &&
    pathname === "/music.mp3"
  ) {
    return serveFile(
      res,
      "music.mp3"
    );
  }

  return sendText(
    res,
    404,
    "Not Found"
  );
}

const server = http.createServer(
  (req, res) => {
    handle(req, res).catch(e => {
      console.error(e);

      if (!res.headersSent) {
        sendJson(res, 500, {
          ok: false,
          error: "SERVER_ERROR"
        });
      }
    });
  }
);

async function start() {
  try {
    await initDB();

    console.log(
      "================================"
    );
    console.log(
      " DY AI WinGo Server"
    );
    console.log(
      " Model:",
      MODEL_VERSION
    );
    console.log(
      " Poll:",
      POLL_MS,
      "ms"
    );
    console.log(
      " Analysis:",
      ANALYSIS_MS,
      "ms"
    );
    console.log(
      " Skip:",
      SKIP_ROUNDS,
      "rounds"
    );
    console.log(
      " Database:",
      pool ? "PostgreSQL" : "Memory"
    );
    console.log(
      " WingoBot:",
      WINGOBOT_TOKEN
        ? "TOKEN SET"
        : "TOKEN MISSING"
    );
    console.log(
      "================================"
    );

    server.listen(
      PORT,
      "0.0.0.0",
      () => {
        console.log(
          `Server running on port ${PORT}`
        );
      }
    );

    await refreshLive();

    setInterval(
      async () => {
        await refreshLive();
        await tickPredictionEngine();
      },
      POLL_MS
    );

    setInterval(
      async () => {
        await tickPredictionEngine();
      },
      250
    );

  } catch (e) {
    console.error(
      "STARTUP ERROR:",
      e
    );
    process.exit(1);
  }
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

start();
