"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const { Pool } = require("pg");

/* =====================================================
   SETTINGS
===================================================== */

const PORT = Number(process.env.PORT || 10000);

const ADMIN_KEY =
  String(process.env.ADMIN_KEY || "dy4427574").trim();

const DEFAULT_ACCESS_KEY =
  String(
    process.env.DEFAULT_ACCESS_KEY || "DY-JPMSUULN"
  ).trim();

const WINGOBOT_URL =
  "https://api.wingobot.com/v2/1-min-game-history";

const WINGOBOT_TOKEN =
  String(process.env.WINGOBOT_TOKEN || "")
    .replace(/^Bearer\s+/i, "")
    .replace(/^["']|["']$/g, "")
    .replace(/\r|\n/g, "")
    .trim();

const MODEL_VERSION =
  String(
    process.env.MODEL || "DY-AI-ENSEMBLE-V6"
  ).trim();

const POLL_MS =
  Math.max(
    1000,
    Number(process.env.POLL || 3000)
  );

/*
  New prediction is allowed only during
  final 4 seconds of current round.
*/
const ANALYSIS_SECONDS = 4;

/*
  After a REAL prediction:
  next 4 rounds are SKIP.
*/
const SKIP_ROUNDS = 4;


/* =====================================================
   DATABASE
===================================================== */

let pool = null;
let databaseEnabled = false;

if (process.env.DATABASE_URL) {

  try {

    pool = new Pool({
      connectionString:
        process.env.DATABASE_URL,

      ssl: {
        rejectUnauthorized: false
      }
    });

    databaseEnabled = true;

  } catch (error) {

    console.error(
      "[DB INIT ERROR]",
      error.message
    );
  }
}


/* =====================================================
   MEMORY FALLBACK
===================================================== */

const memory = {

  keys: new Map(),

  predictions: []
};


/* =====================================================
   LIVE CACHE
===================================================== */

const live = {

  ok: false,

  currentIssue: null,

  history: [],

  fetched: null,

  updated: null,

  error: null,

  lastFetch: 0
};


/* =====================================================
   BASIC HELPERS
===================================================== */

function now() {
  return Date.now();
}


function resultType(number) {

  const n =
    Number(number);

  if (
    !Number.isFinite(n)
  ) {
    return null;
  }

  return n >= 5
    ? "BIG"
    : "SMALL";
}


function nextIssue(issue) {

  const value =
    String(issue || "");

  if (
    !/^\d+$/.test(value)
  ) {
    return null;
  }

  try {

    return (
      BigInt(value) + 1n
    ).toString();

  } catch {

    return null;
  }
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


/* =====================================================
   DATABASE INIT
===================================================== */

async function initDatabase() {

  if (!pool) {
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

  const check =
    await pool.query(
      `
      SELECT id
      FROM access_keys
      WHERE access_key = $1
      LIMIT 1
      `,
      [DEFAULT_ACCESS_KEY]
    );

  if (
    check.rowCount === 0
  ) {

    await pool.query(
      `
      INSERT INTO access_keys
      (
        access_key,
        device_id,
        created_at,
        last_seen
      )
      VALUES ($1,$2,$3,$4)
      `,
      [
        DEFAULT_ACCESS_KEY,
        null,
        now(),
        0
      ]
    );
  }
}


/* =====================================================
   ACCESS KEY FUNCTIONS
===================================================== */

async function getKey(
  accessKey
) {

  if (!accessKey) {
    return null;
  }

  if (pool) {

    const result =
      await pool.query(
        `
        SELECT *
        FROM access_keys
        WHERE access_key = $1
        LIMIT 1
        `,
        [accessKey]
      );

    return (
      result.rows[0] ||
      null
    );
  }

  return (
    memory.keys.get(
      accessKey
    ) || null
  );
}


async function createKey(
  accessKey
) {

  const key =
    accessKey ||
    generateKey();

  if (pool) {

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
        VALUES ($1,$2,$3,$4)
        ON CONFLICT(access_key)
        DO NOTHING
        RETURNING *
        `,
        [
          key,
          null,
          now(),
          0
        ]
      );

    if (
      result.rowCount
    ) {
      return result.rows[0];
    }

    return getKey(key);
  }

  if (
    !memory.keys.has(key)
  ) {

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


async function bindDevice(
  accessKey,
  deviceId
) {

  const key =
    await getKey(
      accessKey
    );

  if (!key) {

    return {
      ok: false,
      error:
        "Invalid access key"
    };
  }

  if (
    key.device_id &&
    key.device_id !== deviceId
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
        device_id = COALESCE(device_id,$1),
        last_seen = $2
      WHERE access_key = $3
      `,
      [
        deviceId,
        now(),
        accessKey
      ]
    );

  } else {

    key.device_id =
      key.device_id ||
      deviceId;

    key.last_seen =
      now();
  }

  return {
    ok: true
  };
}


async function resetDevice(
  accessKey
) {

  if (pool) {

    await pool.query(
      `
      UPDATE access_keys
      SET
        device_id = NULL,
        last_seen = 0
      WHERE access_key = $1
      `,
      [accessKey]
    );

    return;
  }

  const key =
    memory.keys.get(
      accessKey
    );

  if (key) {

    key.device_id = null;
    key.last_seen = 0;
  }
}


async function deleteKey(
  accessKey
) {

  if (pool) {

    await pool.query(
      `
      DELETE FROM access_keys
      WHERE access_key = $1
      `,
      [accessKey]
    );

    return;
  }

  memory.keys.delete(
    accessKey
  );
}


async function listKeys() {

  if (pool) {

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

  return Array.from(
    memory.keys.values()
  );
}


/* =====================================================
   WINGOBOT API
===================================================== */

function normalizeHistory(
  history
) {

  if (
    !Array.isArray(history)
  ) {
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
            row.issueNumber ??
            ""
          ),

        number,

        result:
          resultType(number),

        colour:
          row.colour ??
          null,

        premium:
          row.premium ??
          null,

        sum:
          row.sum ??
          null
      };
    })
    .filter(Boolean);
}


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
      15000
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
              "application/json"
          },

          signal:
            controller.signal
        }
      );

    const raw =
      await response.text();

    let data;

    try {

      data =
        JSON.parse(raw);

    } catch {

      throw new Error(
        `Invalid JSON. HTTP ${response.status}`
      );
    }

    if (
      !response.ok
    ) {

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

    if (
      history.length === 0
    ) {

      throw new Error(
        "No usable history"
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

    clearTimeout(
      timeout
    );
  }
}


/* =====================================================
   REFRESH LIVE
===================================================== */

async function refreshLive() {

  try {

    const data =
      await fetchWingo();

    live.ok =
      true;

    live.currentIssue =
      data.currentIssue;

    live.history =
      data.history;

    live.fetched =
      data.fetched;

    live.updated =
      data.updated;

    live.error =
      null;

    live.lastFetch =
      now();

    console.log(
      `[WINGOBOT] ${live.currentIssue} | ${live.history.length} results`
    );

    await settlePredictions();

  } catch (error) {

    live.ok =
      false;

    live.error =
      error.message;

    console.error(
      "[WINGOBOT ERROR]",
      error.message
    );
  }
}


/* =====================================================
   REAL ENSEMBLE AI MODEL
===================================================== */

function calculateModel(
  history
) {

  const rows =
    Array.isArray(history)
      ? history
          .filter(
            r =>
              r.result === "BIG" ||
              r.result === "SMALL"
          )
          .slice(0,60)
      : [];

  if (
    rows.length < 10
  ) {

    return {

      prediction:
        "SKIP",

      confidence:
        0,

      quality:
        "INSUFFICIENT",

      score:
        0,

      agreement:
        0,

      matches:
        0,

      streak:
        0,

      signals: {},

      counts: {
        big: 0,
        small: 0
      },

      reason:
        "Insufficient historical data"
    };
  }


  const seq =
    rows.map(
      r => r.result
    );


  /* =================================================
     COUNTS
  ================================================= */

  let big = 0;
  let small = 0;

  seq.forEach(
    r => {

      if (r === "BIG") {
        big++;
      } else {
        small++;
      }
    }
  );


  /* =================================================
     SIGNAL 1 — RECENCY
  ================================================= */

  let recentBig = 0;
  let recentSmall = 0;

  const recent =
    seq.slice(0,10);

  recent.forEach(
    (r,i) => {

      const weight =
        recent.length - i;

      if (r === "BIG") {

        recentBig += weight;

      } else {

        recentSmall += weight;
      }
    }
  );

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
     SIGNAL 2 — TRANSITIONS
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
    ) BB++;

    if (
      previous === "BIG" &&
      current === "SMALL"
    ) BS++;

    if (
      previous === "SMALL" &&
      current === "BIG"
    ) SB++;

    if (
      previous === "SMALL" &&
      current === "SMALL"
    ) SS++;
  }

  let transitionScore = 0;

  if (
    seq[0] === "BIG"
  ) {

    const total =
      BB + BS;

    if (total) {

      transitionScore =
        (BB - BS) /
        total;
    }

  } else {

    const total =
      SB + SS;

    if (total) {

      transitionScore =
        (SB - SS) /
        total;
    }
  }


  /* =================================================
     SIGNAL 3 — STREAK
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

  /*
    Long streak does NOT automatically
    mean reversal.
  */

  if (
    streak >= 4
  ) {

    let breakBig = 0;
    let breakSmall = 0;

    for (
      let i = 4;
      i < seq.length;
      i++
    ) {

      if (
        seq[i] ===
        seq[i-1] &&
        seq[i-1] ===
        seq[i-2] &&
        seq[i-2] ===
        seq[i-3]
      ) {

        const next =
          seq[i-4];

        if (
          next === "BIG"
        ) {
          breakBig++;
        }

        if (
          next === "SMALL"
        ) {
          breakSmall++;
        }
      }
    }

    if (
      breakBig >
      breakSmall
    ) {

      streakScore =
        0.25;

    } else if (
      breakSmall >
      breakBig
    ) {

      streakScore =
        -0.25;
    }
  }


  /* =================================================
     SIGNAL 4 — ALTERNATION
  ================================================= */

  let switches = 0;

  for (
    let i = 0;
    i < seq.length - 1;
    i++
  ) {

    if (
      seq[i] !==
      seq[i+1]
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


  let alternationScore = 0;

  if (
    switchRate >= 0.70
  ) {

    alternationScore =
      latest === "BIG"
        ? -0.15
        : 0.15;

  } else if (
    switchRate <= 0.30
  ) {

    alternationScore =
      latest === "BIG"
        ? 0.10
        : -0.10;
  }


  /* =================================================
     SIGNAL 5 — HISTORICAL SEQUENCE MATCH
  ================================================= */

  const patternLength = 4;

  const pattern =
    seq
      .slice(
        0,
        patternLength
      )
      .join("-");

  let matchBig = 0;
  let matchSmall = 0;
  let matches = 0;

  for (
    let i = patternLength;
    i < seq.length;
    i++
  ) {

    const historical =
      seq
        .slice(
          i,
          i + patternLength
        )
        .join("-");

    if (
      historical ===
      pattern
    ) {

      const following =
        seq[i - 1];

      if (
        following === "BIG"
      ) {
        matchBig++;
      }

      if (
        following === "SMALL"
      ) {
        matchSmall++;
      }

      matches++;
    }
  }

  let patternScore = 0;

  if (matches) {

    patternScore =
      (
        matchBig -
        matchSmall
      ) /
      matches;
  }


  /* =================================================
     SIGNAL 6 — SHORT/MEDIUM/LONG
  ================================================= */

  function bigRatio(
    array
  ) {

    if (!array.length) {
      return 0.5;
    }

    return (
      array.filter(
        x => x === "BIG"
      ).length /
      array.length
    );
  }

  const shortRatio =
    bigRatio(
      seq.slice(0,5)
    );

  const mediumRatio =
    bigRatio(
      seq.slice(0,15)
    );

  const longRatio =
    bigRatio(seq);


  const directionScore =
    (
      shortRatio - 0.5
    ) * 0.50
    +
    (
      mediumRatio - 0.5
    ) * 0.30
    +
    (
      longRatio - 0.5
    ) * 0.20;


  /* =================================================
     SIGNAL 7 — ENTROPY
  ================================================= */

  const p =
    big /
    Math.max(
      1,
      seq.length
    );

  let entropy = 0;

  if (
    p > 0 &&
    p < 1
  ) {

    entropy =
      -(
        p * Math.log2(p)
      )
      -
      (
        (1-p) *
        Math.log2(1-p)
      );
  }


  /* =================================================
     ENSEMBLE SCORE

     NOTE:
     Count alone is NOT used as prediction.
  ================================================= */

  let score = 0;

  score +=
    recentScore *
    0.22;

  score +=
    transitionScore *
    0.24;

  score +=
    patternScore *
    0.24;

  score +=
    directionScore *
    0.14;

  score +=
    streakScore *
    0.08;

  score +=
    alternationScore *
    0.08;


  /* =================================================
     SIGNAL AGREEMENT
  ================================================= */

  const majorSignals = [

    recentScore,

    transitionScore,

    patternScore,

    directionScore

  ];

  let positive = 0;
  let negative = 0;

  majorSignals.forEach(
    s => {

      if (
        s > 0.05
      ) {
        positive++;
      }

      if (
        s < -0.05
      ) {
        negative++;
      }
    }
  );

  const agreement =
    Math.max(
      positive,
      negative
    ) /
    majorSignals.length;


  /* =================================================
     PATTERN QUALITY
  ================================================= */

  let patternQuality = 0.25;

  if (
    matches >= 4
  ) {

    patternQuality = 1;

  } else if (
    matches === 3
  ) {

    patternQuality = 0.85;

  } else if (
    matches === 2
  ) {

    patternQuality = 0.65;

  } else if (
    matches === 1
  ) {

    patternQuality = 0.45;
  }


  /* =================================================
     FINAL DECISION
  ================================================= */

  const edge =
    Math.abs(score);


  let prediction =
    "SKIP";


  /*
    Weak edge = SKIP.
  */

  if (
    edge >= 0.085 &&
    agreement >= 0.50
  ) {

    prediction =
      score > 0
        ? "BIG"
        : "SMALL";
  }


  /* =================================================
     CONFIDENCE
  ================================================= */

  let confidence = 0;

  if (
    prediction !== "SKIP"
  ) {

    confidence =
      50
      +
      Math.min(
        20,
        edge * 70
      )
      +
      agreement * 10
      +
      patternQuality * 7;


    /*
      High entropy = less confidence.
    */

    if (
      entropy >= 0.97
    ) {

      confidence -= 7;

    } else if (
      entropy >= 0.90
    ) {

      confidence -= 3;
    }


    confidence =
      Math.round(
        Math.max(
          50,
          Math.min(
            85,
            confidence
          )
        )
      );
  }


  let quality =
    "WEAK";

  if (
    agreement >= 0.75 &&
    patternQuality >= 0.65
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
        agreement.toFixed(2)
      ),

    entropy:
      Number(
        entropy.toFixed(3)
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
        ),

      streak:
        Number(
          streakScore.toFixed(3)
        ),

      alternation:
        Number(
          alternationScore.toFixed(3)
        )
    },

    reason:
      prediction === "SKIP"
        ? "Signals weak or conflicting"
        : "Multiple pattern signals agree"
  };
}


/* =====================================================
   PREDICTION DATABASE
===================================================== */

async function getPredictions() {

  if (pool) {

    const result =
      await pool.query(`
        SELECT *
        FROM prediction_records
        ORDER BY id DESC
        LIMIT 200
      `);

    return result.rows;
  }

  return memory.predictions;
}


async function getPrediction(
  target
) {

  if (pool) {

    const result =
      await pool.query(
        `
        SELECT *
        FROM prediction_records
        WHERE target_issue = $1
        ORDER BY id DESC
        LIMIT 1
        `,
        [target]
      );

    return (
      result.rows[0] ||
      null
    );
  }

  return (
    memory.predictions.find(
      p =>
        String(
          p.target_issue
        ) === String(target)
    ) ||
    null
  );
}


async function getLatestRealPrediction() {

  if (pool) {

    const result =
      await pool.query(`
        SELECT *
        FROM prediction_records
        WHERE prediction IN ('BIG','SMALL')
        ORDER BY id DESC
        LIMIT 1
      `);

    return (
      result.rows[0] ||
      null
    );
  }

  return (
    memory.predictions
      .filter(
        p =>
          p.prediction === "BIG" ||
          p.prediction === "SMALL"
      )
      .sort(
        (a,b) =>
          Number(b.id || 0) -
          Number(a.id || 0)
      )[0] ||
    null
  );
}


async function savePrediction(
  data
) {

  if (pool) {

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
        VALUES ($1,$2,$3,$4,$5)
        RETURNING *
        `,
        [
          data.target_issue,
          data.prediction,
          data.confidence,
          data.model_version,
          data.created_at
        ]
      );

    return result.rows[0];
  }

  const item = {

    id:
      memory.predictions.length + 1,

    target_issue:
      data.target_issue,

    prediction:
      data.prediction,

    confidence:
      data.confidence,

    model_version:
      data.model_version,

    created_at:
      data.created_at,

    actual_number:
      null,

    actual_result:
      null,

    settled_at:
      null
  };

  memory.predictions.unshift(
    item
  );

  memory.predictions =
    memory.predictions.slice(
      0,
      500
    );

  return item;
}


/* =====================================================
   SETTLE PREDICTIONS
===================================================== */

async function settlePredictions() {

  if (
    !live.history.length
  ) {
    return;
  }

  for (
    const row of
    live.history.slice(0,30)
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
          actual_number = $1,
          actual_result = $2,
          settled_at = $3
        WHERE target_issue = $4
          AND prediction IN ('BIG','SMALL')
          AND actual_result IS NULL
        `,
        [
          row.number,
          row.result,
          now(),
          row.issueNumber
        ]
      );

    } else {

      memory.predictions
        .forEach(
          p => {

            if (
              String(
                p.target_issue
              ) ===
              String(
                row.issueNumber
              ) &&
              (
                p.prediction ===
                "BIG" ||
                p.prediction ===
                "SMALL"
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
        );
    }
  }
}


/* =====================================================
   PROPER 4-ROUND SKIP LOGIC
===================================================== */

function cooldownInfo(
  currentIssue,
  lastPrediction
) {

  if (
    !lastPrediction
  ) {
    return null;
  }

  if (
    lastPrediction.prediction !== "BIG" &&
    lastPrediction.prediction !== "SMALL"
  ) {
    return null;
  }

  try {

    const current =
      BigInt(
        String(currentIssue)
      );

    const predictionTarget =
      BigInt(
        String(
          lastPrediction.target_issue
        )
      );

    /*
      IMPORTANT:

      Prediction target = 10643

      current 10642:
      prediction is active

      current 10643:
      result arrived
      next target 10644 = SKIP 1

      current 10644:
      next target 10645 = SKIP 2

      current 10645:
      next target 10646 = SKIP 3

      current 10646:
      next target 10647 = SKIP 4

      current 10647:
      next target 10648 = NEW prediction
    */

    const skipRound =
      Number(
        current -
        predictionTarget
      ) + 1;

    if (
      skipRound >= 1 &&
      skipRound <= SKIP_ROUNDS
    ) {

      return {

        active: true,

        skipRound,

        remaining:
          SKIP_ROUNDS -
          skipRound +
          1
      };
    }

    return null;

  } catch {

    return null;
  }
}


/* =====================================================
   GENERATE PREDICTION
===================================================== */

async function generatePrediction() {

  if (
    !live.ok ||
    !live.currentIssue ||
    live.history.length < 10
  ) {

    return {

      result:
        "SKIP",

      status:
        "WAITING_DATA",

      confidence:
        0
    };
  }


  const current =
    String(
      live.currentIssue
    );

  const target =
    nextIssue(
      current
    );


  if (!target) {

    return null;
  }


  /*
  =====================================================
  FIRST: CHECK ACTIVE REAL PREDICTION
  =====================================================
  */

  const existing =
    await getPrediction(
      target
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

      ...existing,

      targetPeriod:
        existing.target_issue,

      result:
        existing.prediction,

      status,

      actualNumber:
        existing.actual_number,

      actualResult:
        existing.actual_result
    };
  }


  /*
  =====================================================
  SECOND: 4 ROUND COOLDOWN
  =====================================================
  */

  const lastReal =
    await getLatestRealPrediction();


  const cooldown =
    cooldownInfo(
      current,
      lastReal
    );


  if (cooldown) {

    return {

      targetPeriod:
        target,

      result:
        "SKIP",

      confidence:
        0,

      status:
        "COOLDOWN",

      skipRound:
        cooldown.skipRound,

      skipTotal:
        SKIP_ROUNDS,

      skipRemaining:
        cooldown.remaining,

      model:
        MODEL_VERSION
    };
  }


  /*
  =====================================================
  THIRD: ONLY CREATE NEW PREDICTION DURING
          FINAL 4 SECONDS
  =====================================================
  */

  const seconds =
    new Date().getSeconds();


  if (
    seconds < 56
  ) {

    return {

      targetPeriod:
        target,

      result:
        "WAIT",

      confidence:
        0,

      status:
        "WAIT_ANALYSIS",

      secondsUntilAnalysis:
        56 - seconds
    };
  }


  /*
  =====================================================
  RUN MODEL
  =====================================================
  */

  const model =
    calculateModel(
      live.history
    );


  /*
    Weak model = no saved prediction.
    Therefore cooldown does NOT start.
  */

  if (
    model.prediction ===
    "SKIP"
  ) {

    return {

      targetPeriod:
        target,

      result:
        "SKIP",

      confidence:
        0,

      status:
        "MODEL_SKIP",

      analysis:
        model
    };
  }


  /*
  =====================================================
  SAVE REAL PREDICTION
  =====================================================
  */

  const saved =
    await savePrediction({

      target_issue:
        target,

      prediction:
        model.prediction,

      confidence:
        model.confidence,

      model_version:
        MODEL_VERSION,

      created_at:
        now()
    });


  console.log(
    `[AI] ${target} => ${model.prediction} | ${model.confidence}%`
  );


  return {

    ...saved,

    targetPeriod:
      target,

    result:
      model.prediction,

    status:
      "PENDING",

    actualNumber:
      null,

    actualResult:
      null,

    analysis:
      model
  };
}


/* =====================================================
   BUILD STATE
===================================================== */

async function buildState(
  accessKey,
  deviceId
) {

  const access =
    await bindDevice(
      accessKey,
      deviceId
    );

  if (!access.ok) {

    return access;
  }


  const prediction =
    await generatePrediction();


  const latest =
    live.history[0] ||
    null;


  const model =
    calculateModel(
      live.history
    );


  return {

    ok: true,

    game:
      "WINGO 1 MINUTE",

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

    prediction:
      prediction
        ? {

            targetPeriod:
              prediction.targetPeriod,

            result:
              prediction.result,

            confidence:
              Number(
                prediction.confidence ||
                0
              ),

            status:
              prediction.status,

            actualNumber:
              prediction.actualNumber ??
              null,

            actualResult:
              prediction.actualResult ??
              null,

            skipRound:
              prediction.skipRound ||
              0,

            skipTotal:
              prediction.skipTotal ||
              SKIP_ROUNDS,

            skipRemaining:
              prediction.skipRemaining ||
              0,

            secondsUntilAnalysis:
              prediction.secondsUntilAnalysis ||
              0
          }
        : null,

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

      entropy:
        model.entropy,

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
        model.signals,

      reason:
        model.reason
    },

    recentResults:
      live.history
        .slice(0,30)
        .map(
          row => ({

            issueNumber:
              row.issueNumber,

            number:
              row.number,

            result:
              row.result,

            colour:
              row.colour,

            premium:
              row.premium,

            sum:
              row.sum
          })
        ),

    source: {

      provider:
        "WingoBot",

      fetched:
        live.fetched,

      updated:
        live.updated
    },

    serverTime:
      now()
  };
}


/* =====================================================
   ADMIN HELPERS
===================================================== */

function adminAuth(
  url
) {

  return (
    url.searchParams.get(
      "key"
    ) === ADMIN_KEY
  );
}


/* =====================================================
   JSON
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
        "no-store",

      "Access-Control-Allow-Origin":
        "*"
    }
  );

  res.end(
    JSON.stringify(
      data,
      null,
      2
    )
  );
}


/* =====================================================
   FILE SERVER
===================================================== */

function serveFile(
  res,
  filename
) {

  const file =
    path.join(
      __dirname,
      filename
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
          "File not found"
      }
    );
  }


  const ext =
    path.extname(file)
      .toLowerCase();


  const types = {

    ".html":
      "text/html; charset=utf-8",

    ".css":
      "text/css; charset=utf-8",

    ".js":
      "application/javascript; charset=utf-8",

    ".json":
      "application/json; charset=utf-8",

    ".png":
      "image/png",

    ".jpg":
      "image/jpeg",

    ".jpeg":
      "image/jpeg",

    ".svg":
      "image/svg+xml"
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
    file
  ).pipe(res);
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


        /* HOME */

        if (
          url.pathname === "/" ||
          url.pathname ===
            "/prediction.html"
        ) {

          return serveFile(
            res,
            "prediction.html"
          );
        }


        /* ADMIN PAGE */

        if (
          url.pathname ===
            "/admin.html"
        ) {

          return serveFile(
            res,
            "admin.html"
          );
        }


        /* HEALTH */

        if (
          url.pathname ===
            "/health"
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
                databaseEnabled,

              databaseMode:
                databaseEnabled
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

              time:
                new Date().toISOString()
            }
          );
        }


        /* KEY CHECK */

        if (
          url.pathname ===
            "/api/key/check"
        ) {

          const key =
            url.searchParams.get(
              "key"
            );

          const device =
            url.searchParams.get(
              "device"
            );

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


        /* STATE */

        if (
          url.pathname ===
            "/api/state"
        ) {

          const key =
            url.searchParams.get(
              "key"
            ) ||
            DEFAULT_ACCESS_KEY;

          const device =
            url.searchParams.get(
              "device"
            ) ||
            "unknown";

          const result =
            await buildState(
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


        /* ADMIN STATUS */

        if (
          url.pathname ===
            "/api/admin/status"
        ) {

          if (
            !adminAuth(url)
          ) {

            return sendJson(
              res,
              401,
              {
                ok:false,
                error:
                  "Unauthorized"
              }
            );
          }

          return sendJson(
            res,
            200,
            {

              ok:true,

              live,

              model:
                MODEL_VERSION,

              database:
                databaseEnabled,

              databaseMode:
                databaseEnabled
                  ? "POSTGRESQL"
                  : "MEMORY",

              tokenConfigured:
                Boolean(
                  WINGOBOT_TOKEN
                )
            }
          );
        }


        /* LIVE TEST */

        if (
          url.pathname ===
            "/api/admin/live-test"
        ) {

          if (
            !adminAuth(url)
          ) {

            return sendJson(
              res,
              401,
              {
                ok:false,
                error:
                  "Unauthorized"
              }
            );
          }


          try {

            const result =
              await fetchWingo();

            return sendJson(
              res,
              200,
              {

                ok:true,

                success:true,

                currentIssue:
                  result.currentIssue,

                resultCount:
                  result.history.length,

                fetched:
                  result.fetched,

                updated:
                  result.updated,

                history:
                  result.history
              }
            );

          } catch(error) {

            return sendJson(
              res,
              200,
              {

                ok:true,

                success:false,

                error:
                  error.message,

                tokenConfigured:
                  Boolean(
                    WINGOBOT_TOKEN
                  )
              }
            );
          }
        }


        /* MODEL TEST */

        if (
          url.pathname ===
            "/api/admin/model-test"
        ) {

          if (
            !adminAuth(url)
          ) {

            return sendJson(
              res,
              401,
              {
                ok:false,
                error:
                  "Unauthorized"
              }
            );
          }


          return sendJson(
            res,
            200,
            {

              ok:true,

              model:
                MODEL_VERSION,

              analysis:
                calculateModel(
                  live.history
                )
            }
          );
        }


        /* ADMIN KEYS GET */

        if (
          url.pathname ===
            "/api/admin/keys" &&
          req.method === "GET"
        ) {

          if (
            !adminAuth(url)
          ) {

            return sendJson(
              res,
              401,
              {
                ok:false,
                error:
                  "Unauthorized"
              }
            );
          }


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


        /* ADMIN CREATE KEY */

        if (
          url.pathname ===
            "/api/admin/keys" &&
          req.method === "POST"
        ) {

          if (
            !adminAuth(url)
          ) {

            return sendJson(
              res,
              401,
              {
                ok:false,
                error:
                  "Unauthorized"
              }
            );
          }


          let body = "";

          req.on(
            "data",
            chunk => {
              body += chunk;
            }
          );


          req.on(
            "end",
            async () => {

              try {

                const data =
                  body
                    ? JSON.parse(body)
                    : {};

                const custom =
                  String(
                    data.key || ""
                  ).trim();


                const created =
                  await createKey(
                    custom ||
                    null
                  );


                return sendJson(
                  res,
                  200,
                  {

                    ok:true,

                    key:
                      created
                  }
                );

              } catch(error) {

                return sendJson(
                  res,
                  400,
                  {

                    ok:false,

                    error:
                      error.message
                  }
                );
              }
            }
          );

          return;
        }


        /* RESET DEVICE */

        if (
          url.pathname ===
            "/api/admin/reset-device" &&
          req.method === "POST"
        ) {

          if (
            !adminAuth(url)
          ) {

            return sendJson(
              res,
              401,
              {
                ok:false,
                error:
                  "Unauthorized"
              }
            );
          }


          let body = "";

          req.on(
            "data",
            chunk => {
              body += chunk;
            }
          );


          req.on(
            "end",
            async () => {

              try {

                const data =
                  body
                    ? JSON.parse(body)
                    : {};


                await resetDevice(
                  String(
                    data.key || ""
                  ).trim()
                );


                return sendJson(
                  res,
                  200,
                  {
                    ok:true
                  }
                );

              } catch(error) {

                return sendJson(
                  res,
                  400,
                  {

                    ok:false,

                    error:
                      error.message
                  }
                );
              }
            }
          );

          return;
        }


        /* DELETE KEY */

        if (
          url.pathname ===
            "/api/admin/delete-key" &&
          req.method === "POST"
        ) {

          if (
            !adminAuth(url)
          ) {

            return sendJson(
              res,
              401,
              {
                ok:false,
                error:
                  "Unauthorized"
              }
            );
          }


          let body = "";

          req.on(
            "data",
            chunk => {
              body += chunk;
            }
          );


          req.on(
            "end",
            async () => {

              try {

                const data =
                  body
                    ? JSON.parse(body)
                    : {};


                await deleteKey(
                  String(
                    data.key || ""
                  ).trim()
                );


                return sendJson(
                  res,
                  200,
                  {
                    ok:true
                  }
                );

              } catch(error) {

                return sendJson(
                  res,
                  400,
                  {

                    ok:false,

                    error:
                      error.message
                  }
                );
              }
            }
          );

          return;
        }


        /* PREDICTIONS */

        if (
          url.pathname ===
            "/api/admin/predictions"
        ) {

          if (
            !adminAuth(url)
          ) {

            return sendJson(
              res,
              401,
              {
                ok:false,
                error:
                  "Unauthorized"
              }
            );
          }


          return sendJson(
            res,
            200,
            {

              ok:true,

              predictions:
                await getPredictions()
            }
          );
        }


        /* 404 */

        return sendJson(
          res,
          404,
          {
            ok:false,
            error:
              "Not found"
          }
        );


      } catch(error) {

        console.error(
          "[SERVER ERROR]",
          error
        );

        return sendJson(
          res,
          500,
          {

            ok:false,

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

    await createKey(
      DEFAULT_ACCESS_KEY
    );

    await refreshLive();


    setInterval(
      refreshLive,
      POLL_MS
    );


    server.listen(
      PORT,
      "0.0.0.0",
      () => {

        console.log(
          "===================================="
        );

        console.log(
          " DY AI WINGO 1 MINUTE V6"
        );

        console.log(
          "===================================="
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
          "TOKEN:",
          WINGOBOT_TOKEN
            ? "CONFIGURED"
            : "MISSING"
        );

        console.log(
          "DATABASE:",
          databaseEnabled
            ? "POSTGRESQL"
            : "MEMORY"
        );

        console.log(
          "===================================="
        );
      }
    );

  } catch(error) {

    console.error(
      "[START ERROR]",
      error
    );

    process.exit(1);
  }
}

start();
