"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

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
    process.env.MODEL || "DY-AI-1MIN-V9"
  ).trim();

const LIVE_POLL = 1000;

/*
=========================================================
IMPORTANT
=========================================================

Prediction cycle:

REAL PREDICTION
      ↓
4 completed result rounds SKIP
      ↓
4-second analysis
      ↓
REAL PREDICTION
      ↓
4 completed result rounds SKIP
      ↓
...

The skip counter is derived from the LAST REAL
prediction target issue, so browser refresh does NOT
reset the cycle.
=========================================================
*/

const SKIP_COUNT = 4;


/* =====================================================
   DATABASE
===================================================== */

let pool = null;

if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString:
      process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    }
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
   LIVE CACHE
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
    console.log(
      "[DATABASE] MEMORY MODE"
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

  /*
    Automatically make sure the default key exists.
  */

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
    `,
    [
      DEFAULT_ACCESS_KEY,
      null,
      now(),
      0
    ]
  );

  console.log(
    "[DATABASE] POSTGRESQL READY"
  );
}


/* =====================================================
   ACCESS KEY
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

  if (
    !memory.keys.has(
      DEFAULT_ACCESS_KEY
    )
  ) {

    memory.keys.set(
      DEFAULT_ACCESS_KEY,
      {
        id: 1,
        access_key:
          DEFAULT_ACCESS_KEY,
        device_id: null,
        created_at: now(),
        last_seen: 0
      }
    );
  }
}


async function getKey(key) {

  if (!key) {
    return null;
  }

  if (pool) {

    const r =
      await pool.query(
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

  return (
    memory.keys.get(key) ||
    null
  );
}


async function bindDevice(
  key,
  device
) {

  await ensureDefaultKey();

  const item =
    await getKey(key);

  if (!item) {

    return {
      ok: false,
      error:
        "Invalid access key"
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

    item.last_seen =
      now();
  }

  return {
    ok: true
  };
}


async function createKey(
  customKey
) {

  const key =
    String(
      customKey || ""
    ).trim() ||
    makeKey();

  if (pool) {

    const r =
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


async function resetDevice(
  key
) {

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

    item.device_id =
      null;

    item.last_seen =
      0;
  }
}


async function deleteKey(
  key
) {

  if (
    key ===
    DEFAULT_ACCESS_KEY
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


/* =====================================================
   WINGOBOT API
===================================================== */

function normalizeHistory(
  history
) {

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
   LIVE REFRESH
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
   REAL PATTERN ENGINE
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
          .slice(0,50)
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

      switchRate:
        0,

      counts: {
        big: 0,
        small: 0
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


  for (
    const x of seq
  ) {

    if (
      x === "BIG"
    ) {
      big++;
    } else {
      small++;
    }
  }


  /* --------------------------------------------------
     RECENCY
  -------------------------------------------------- */

  let recentBig = 0;
  let recentSmall = 0;


  const recent =
    seq.slice(0,10);


  for (
    let i = 0;
    i < recent.length;
    i++
  ) {

    const weight =
      recent.length - i;


    if (
      recent[i] ===
      "BIG"
    ) {

      recentBig +=
        weight;

    } else {

      recentSmall +=
        weight;
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


  /* --------------------------------------------------
     TRANSITIONS
  -------------------------------------------------- */

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
        (
          BB -
          BS
        ) / total;
    }

  } else {

    const total =
      SB + SS;

    if (total > 0) {

      transitionScore =
        (
          SB -
          SS
        ) / total;
    }
  }


  /* --------------------------------------------------
     STREAK
  -------------------------------------------------- */

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


  /*
    Streak is only one signal.
    It NEVER directly decides the result.
  */

  let streakScore = 0;


  if (
    streak >= 4
  ) {

    const opposite =
      latest === "BIG"
        ? "SMALL"
        : "BIG";


    let oppositeCount = 0;
    let sameCount = 0;


    for (
      let i = 4;
      i < seq.length;
      i++
    ) {

      const block =
        seq.slice(
          i,
          i + 4
        );


      if (
        block.length < 4
      ) {
        continue;
      }


      if (
        block.every(
          x =>
            x === block[0]
        )
      ) {

        const following =
          seq[i - 1];


        if (
          following ===
          opposite
        ) {

          oppositeCount++;

        } else {

          sameCount++;
        }
      }
    }


    if (
      oppositeCount >
      sameCount
    ) {

      streakScore =
        latest === "BIG"
          ? -0.25
          : 0.25;
    }
  }


  /* --------------------------------------------------
     SWITCH RATE
  -------------------------------------------------- */

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


  /* --------------------------------------------------
     HISTORICAL 4-SEQUENCE
  -------------------------------------------------- */

  const pattern =
    seq
      .slice(0,4)
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
      oldPattern ===
      pattern
    ) {

      const following =
        seq[i - 1];


      if (
        following ===
        "BIG"
      ) {

        matchBig++;

      } else if (
        following ===
        "SMALL"
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
      ) / matches;
  }


  /* --------------------------------------------------
     SHORT / MEDIUM / LONG
  -------------------------------------------------- */

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
      seq.slice(0,5)
    );


  const medium =
    ratio(
      seq.slice(0,15)
    );


  const long =
    ratio(seq);


  const directionScore =
    (
      short -
      0.5
    ) * 0.50 +

    (
      medium -
      0.5
    ) * 0.30 +

    (
      long -
      0.5
    ) * 0.20;


  /* --------------------------------------------------
     ENSEMBLE SCORE
  -------------------------------------------------- */

  const score =

    recentScore *
    0.24 +

    transitionScore *
    0.25 +

    patternScore *
    0.25 +

    directionScore *
    0.14 +

    streakScore *
    0.07 +

    switchScore *
    0.05;


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


  const agreement =
    Math.max(
      positive,
      negative
    ) /
    signals.length;


  /*
    IMPORTANT:
    We do not simply say:
    BIG count > SMALL count => BIG.

    Multiple signals must agree.
  */

  let prediction =
    "SKIP";


  if (
    Math.abs(score) >= 0.085 &&
    agreement >= 0.50
  ) {

    prediction =
      score > 0
        ? "BIG"
        : "SMALL";
  }


  let confidence = 0;


  if (
    prediction !== "SKIP"
  ) {

    confidence =
      Math.round(
        Math.max(
          50,
          Math.min(
            85,

            50 +

            Math.abs(score) *
            70 +

            agreement *
            10 +

            Math.min(
              7,
              matches * 1.5
            )
          )
        )
      );
  }


  let quality =
    "WEAK";


  if (
    agreement >= 0.75 &&
    matches >= 3
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
   PREDICTION DATABASE
===================================================== */

async function getPredictionForIssue(
  issue
) {

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


/* -----------------------------------------------------
   LAST REAL PREDICTION

   Only BIG / SMALL count.

   WAIT / SKIP / MODEL_SKIP do NOT count.
----------------------------------------------------- */

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


  const rows =
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
      );


  return rows[0] || null;
}


/* =====================================================
   SAVE REAL PREDICTION
===================================================== */

async function savePrediction(
  targetIssue,
  prediction,
  confidence
) {

  /*
    Double protection:
    never save two predictions
    for same target issue.
  */

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
          String(
            targetIssue
          ),

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
    live.history.slice(0,50)
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
    }
  }
}


/* =====================================================
   HARD 4-ROUND SKIP ENGINE
===================================================== */

async function getCycleState(
  currentIssue
) {

  const lastReal =
    await getLastRealPrediction();


  /*
    No REAL prediction yet.
    Prediction is allowed.
  */

  if (
    !lastReal
  ) {

    return {

      mode:
        "PREDICTION",

      skipRound:
        0,

      remaining:
        0,

      lastPrediction:
        null
    };
  }


  const difference =
    issueDiff(
      currentIssue,
      lastReal.target_issue
    );


  /*
    If issue numbers cannot be compared,
    do not incorrectly force skip.
  */

  if (
    difference === null
  ) {

    return {

      mode:
        "PREDICTION",

      skipRound:
        0,

      remaining:
        0,

      lastPrediction:
        lastReal
    };
  }


  /*
  ======================================================
  EXACT RULE

  Last REAL prediction target = 10801

  Current 10801:
      existing prediction

  Current 10802:
      SKIP 1/4

  Current 10803:
      SKIP 2/4

  Current 10804:
      SKIP 3/4

  Current 10805:
      SKIP 4/4

  Current 10806:
      NEW PREDICTION

  ======================================================
  */

  if (
    difference >= 1 &&
    difference <= SKIP_COUNT
  ) {

    return {

      mode:
        "SKIP",

      skipRound:
        difference,

      remaining:
        SKIP_COUNT -
        difference,

      lastPrediction:
        lastReal
    };
  }


  /*
    difference >= 5 means all 4 skips
    are completed.

    New prediction is allowed.
  */

  return {

    mode:
      "PREDICTION",

    skipRound:
      0,

    remaining:
      0,

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

      result:
        "WAIT",

      confidence:
        0,

      status:
        "OFFLINE",

      targetPeriod:
        null
    };
  }


  const currentIssue =
    String(
      live.currentIssue
    );


  const targetIssue =
    nextIssue(
      currentIssue
    );


  if (!targetIssue) {

    return {

      result:
        "WAIT",

      confidence:
        0,

      status:
        "OFFLINE",

      targetPeriod:
        null
    };
  }


  /*
    FIRST:
    If this exact target already has a
    prediction, always show that prediction.
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
        existing.actual_result
    };
  }


  /*
    SECOND:
    HARD 4-ROUND SKIP CHECK.
  */

  const cycle =
    await getCycleState(
      currentIssue
    );


  if (
    cycle.mode ===
    "SKIP"
  ) {

    return {

      result:
        "SKIP",

      confidence:
        0,

      status:
        "COOLDOWN",

      targetPeriod:
        targetIssue,

      skipRound:
        cycle.skipRound,

      skipTotal:
        SKIP_COUNT,

      skipRemaining:
        cycle.remaining,

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
    THIRD:
    Prediction is allowed.

    Wait until the final 4 seconds
    of the minute for analysis.
  */

  const second =
    new Date()
      .getSeconds();


  if (
    second < 56
  ) {

    return {

      result:
        "WAIT",

      confidence:
        0,

      status:
        "WAIT_ANALYSIS",

      targetPeriod:
        targetIssue,

      secondsUntilAnalysis:
        56 - second
    };
  }


  /*
    FOURTH:
    Run actual pattern engine.
  */

  const model =
    analyze(
      live.history
    );


  /*
    Conflicting / weak signals:
    don't create a real prediction.

    IMPORTANT:
    MODEL_SKIP is NOT a cycle prediction,
    so it does not start the 4-round cooldown.
  */

  if (
    model.prediction !==
      "BIG" &&
    model.prediction !==
      "SMALL"
  ) {

    return {

      result:
        "SKIP",

      confidence:
        0,

      status:
        "MODEL_SKIP",

      targetPeriod:
        targetIssue,

      analysis:
        model
    };
  }


  /*
    FINAL PROTECTION:
    Re-check target immediately before insert.
  */

  const doubleCheck =
    await getPredictionForIssue(
      targetIssue
    );


  if (doubleCheck) {

    return {

      result:
        doubleCheck.prediction,

      confidence:
        Number(
          doubleCheck.confidence || 0
        ),

      status:
        "PENDING",

      targetPeriod:
        String(
          doubleCheck.target_issue
        ),

      actualNumber:
        doubleCheck.actual_number,

      actualResult:
        doubleCheck.actual_result
    };
  }


  /*
    SAVE REAL PREDICTION.
  */

  const saved =
    await savePrediction(
      targetIssue,
      model.prediction,
      model.confidence
    );


  return {

    result:
      saved.prediction,

    confidence:
      Number(
        saved.confidence || 0
      ),

    status:
      "PENDING",

    targetPeriod:
      String(
        saved.target_issue
      ),

    actualNumber:
      null,

    actualResult:
      null,

    analysis:
      model
  };
}


/* =====================================================
   BUILD PUBLIC STATE
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
    live.history[0] ||
    null;


  const model =
    analyze(
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
        live.updated
    },

    serverTime:
      now()
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
        "no-store",

      "Access-Control-Allow-Origin":
        "*"
    }
  );


  res.end(
    JSON.stringify(
      data
    )
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
        ok:
          false,

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
        "no-cache"
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
    url.searchParams.get(
      "key"
    ) === ADMIN_KEY
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


        /* ---------------------------------------------
           PREDICTION PAGE
        --------------------------------------------- */

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


        /* ---------------------------------------------
           ADMIN PAGE
        --------------------------------------------- */

        if (
          url.pathname ===
            "/admin.html"
        ) {

          return serveFile(
            res,
            "admin.html"
          );
        }


        /* ---------------------------------------------
           HEALTH
        --------------------------------------------- */

        if (
          url.pathname ===
            "/health"
        ) {

          return sendJson(
            res,
            200,
            {

              ok:
                true,

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

              serverTime:
                new Date()
                  .toISOString()
            }
          );
        }


        /* ---------------------------------------------
           PUBLIC STATE
        --------------------------------------------- */

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


        /* ---------------------------------------------
           KEY CHECK
        --------------------------------------------- */

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
            ) ||
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


        /* ---------------------------------------------
           ADMIN STATUS
        --------------------------------------------- */

        if (
          url.pathname ===
            "/api/admin/status"
        ) {

          if (
            !isAdmin(url)
          ) {

            return sendJson(
              res,
              401,
              {
                ok:
                  false,

                error:
                  "Unauthorized"
              }
            );
          }


          return sendJson(
            res,
            200,
            {

              ok:
                true,

              live,

              database:
                Boolean(pool),

              model:
                MODEL_VERSION

            }
          );
        }


        /* ---------------------------------------------
           ADMIN LIVE TEST
        --------------------------------------------- */

        if (
          url.pathname ===
            "/api/admin/live-test"
        ) {

          if (
            !isAdmin(url)
          ) {

            return sendJson(
              res,
              401,
              {
                ok:
                  false
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

                ok:
                  true,

                success:
                  true,

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

                ok:
                  true,

                success:
                  false,

                error:
                  error.message

              }
            );
          }
        }


        /* ---------------------------------------------
           ADMIN MODEL TEST
        --------------------------------------------- */

        if (
          url.pathname ===
            "/api/admin/model-test"
        ) {

          if (
            !isAdmin(url)
          ) {

            return sendJson(
              res,
              401,
              {
                ok:
                  false
              }
            );
          }


          return sendJson(
            res,
            200,
            {

              ok:
                true,

              analysis:
                analyze(
                  live.history
                )

            }
          );
        }


        /* ---------------------------------------------
           GET KEYS
        --------------------------------------------- */

        if (
          url.pathname ===
            "/api/admin/keys" &&
          req.method ===
            "GET"
        ) {

          if (
            !isAdmin(url)
          ) {

            return sendJson(
              res,
              401,
              {
                ok:
                  false
              }
            );
          }


          return sendJson(
            res,
            200,
            {

              ok:
                true,

              keys:
                await listKeys()

            }
          );
        }


        /* ---------------------------------------------
           CREATE KEY
        --------------------------------------------- */

        if (
          url.pathname ===
            "/api/admin/keys" &&
          req.method ===
            "POST"
        ) {

          if (
            !isAdmin(url)
          ) {

            return sendJson(
              res,
              401,
              {
                ok:
                  false
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

              ok:
                true,

              key:
                item

            }
          );
        }


        /* ---------------------------------------------
           RESET DEVICE
        --------------------------------------------- */

        if (
          url.pathname ===
            "/api/admin/reset-device" &&
          req.method ===
            "POST"
        ) {

          if (
            !isAdmin(url)
          ) {

            return sendJson(
              res,
              401,
              {
                ok:
                  false
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
              ok:
                true
            }
          );
        }


        /* ---------------------------------------------
           DELETE KEY
        --------------------------------------------- */

        if (
          url.pathname ===
            "/api/admin/delete-key" &&
          req.method ===
            "POST"
        ) {

          if (
            !isAdmin(url)
          ) {

            return sendJson(
              res,
              401,
              {
                ok:
                  false
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
              ok:
                true
            }
          );
        }


        /* ---------------------------------------------
           PREDICTION HISTORY
        --------------------------------------------- */

        if (
          url.pathname ===
            "/api/admin/predictions"
        ) {

          if (
            !isAdmin(url)
          ) {

            return sendJson(
              res,
              401,
              {
                ok:
                  false
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

              ok:
                true,

              predictions

            }
          );
        }


        /* ---------------------------------------------
           404
        --------------------------------------------- */

        return sendJson(
          res,
          404,
          {

            ok:
              false,

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

            ok:
              false,

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
      First API fetch immediately.
    */

    await refreshLive();


    /*
      Live API refresh every 1 second.
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
          "LIVE POLL:",
          LIVE_POLL,
          "ms"
        );

        console.log(
          "SKIP RULE:",
          "4 ROUNDS"
        );

        console.log(
          "ANALYSIS:",
          "4 SECONDS"
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
