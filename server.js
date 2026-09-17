"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
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

const MODEL_VERSION =
  String(
    process.env.MODEL || "DY-AI-ENSEMBLE-V5"
  ).trim();

const POLL_MS =
  Math.max(
    1000,
    Number(process.env.POLL || 3000)
  );

/*
=========================================================
TOKEN CLEANER
=========================================================
*/

function cleanToken(value) {
  let token = String(value || "").trim();

  token = token
    .replace(/^Bearer\s+/i, "")
    .trim();

  if (
    (token.startsWith('"') &&
      token.endsWith('"')) ||
    (token.startsWith("'") &&
      token.endsWith("'"))
  ) {
    token = token.slice(1, -1).trim();
  }

  token = token
    .replace(/\r/g, "")
    .replace(/\n/g, "")
    .trim();

  return token;
}

const WINGOBOT_TOKEN =
  cleanToken(
    process.env.WINGOBOT_TOKEN
  );

/*
=========================================================
DATABASE
=========================================================
*/

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

/*
=========================================================
MEMORY FALLBACK
=========================================================
*/

const memory = {
  keys: new Map(),
  predictions: []
};

/*
=========================================================
UTILITIES
=========================================================
*/

function now() {
  return Date.now();
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

function resultType(number) {
  const n = Number(number);

  if (!Number.isFinite(n)) {
    return null;
  }

  return n >= 5
    ? "BIG"
    : "SMALL";
}

function nextIssue(issue) {
  const value = String(issue || "");

  if (!/^\d+$/.test(value)) {
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

/*
=========================================================
DATABASE INIT
=========================================================
*/

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

  if (check.rowCount === 0) {

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

/*
=========================================================
ACCESS KEYS
=========================================================
*/

async function getKey(accessKey) {

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

async function createKey(accessKey) {

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

    if (result.rowCount) {
      return result.rows[0];
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

async function bindDevice(
  accessKey,
  deviceId
) {

  const key =
    await getKey(accessKey);

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

/*
=========================================================
WINGOBOT
=========================================================
*/

const live = {

  ok: false,

  currentIssue: null,

  history: [],

  fetched: null,

  updated: null,

  error: null,

  lastFetch: 0
};

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
            "Authorization":
              `Bearer ${WINGOBOT_TOKEN}`,

            "Accept":
              "application/json"
          },

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
        `Invalid JSON from WingoBot. HTTP ${response.status}`
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
        "No usable history received"
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
      `[WINGOBOT] ${live.currentIssue} | ${live.history.length} rows`
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

/*
=========================================================
REAL PATTERN / ENSEMBLE MODEL
=========================================================
*/

function calculateModel(
  history
) {

  const rows =
    Array.isArray(history)
      ? history
          .filter(
            x =>
              x.result === "BIG" ||
              x.result === "SMALL"
          )
          .slice(0, 60)
      : [];

  if (rows.length < 8) {

    return {

      prediction:
        "SKIP",

      confidence:
        0,

      quality:
        "INSUFFICIENT",

      signals: [],

      reason:
        "Need more live results"
    };
  }

  const seq =
    rows.map(
      x => x.result
    );

  let big = 0;
  let small = 0;

  for (const value of seq) {

    if (value === "BIG") {
      big++;
    } else {
      small++;
    }
  }

  /*
  -----------------------------------------
  SIGNAL 1: RECENCY
  -----------------------------------------
  */

  let recentBig = 0;
  let recentSmall = 0;

  const recent =
    seq.slice(
      0,
      Math.min(10, seq.length)
    );

  recent.forEach(
    (value, index) => {

      const weight =
        recent.length -
        index;

      if (value === "BIG") {
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
        ) / recentTotal
      : 0;

  /*
  -----------------------------------------
  SIGNAL 2: TRANSITION MATRIX
  -----------------------------------------
  */

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

  const latest =
    seq[0];

  let transitionScore = 0;

  if (latest === "BIG") {

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

  /*
  -----------------------------------------
  SIGNAL 3: STREAK / BREAK
  -----------------------------------------
  */

  let streak =
    1;

  for (
    let i = 1;
    i < seq.length;
    i++
  ) {

    if (
      seq[i] ===
      latest
    ) {

      streak++;

    } else {

      break;
    }
  }

  let streakScore = 0;

  if (streak >= 4) {

    /*
      Long streak does NOT automatically
      mean reversal.

      Use historical break behaviour.
    */

    let afterLong =
      {
        BIG: 0,
        SMALL: 0
      };

    for (
      let i = 3;
      i < seq.length - 1;
      i++
    ) {

      const a =
        seq[i];

      const b =
        seq[i - 1];

      const c =
        seq[i - 2];

      const d =
        seq[i - 3];

      if (
        a === b &&
        b === c &&
        c === d
      ) {

        afterLong[
          seq[i - 1] === "BIG"
            ? "SMALL"
            : "BIG"
        ]++;
      }
    }

    if (
      afterLong.BIG >
      afterLong.SMALL
    ) {

      streakScore = 0.15;

    } else if (
      afterLong.SMALL >
      afterLong.BIG
    ) {

      streakScore = -0.15;
    }
  }

  /*
  -----------------------------------------
  SIGNAL 4: ALTERNATION
  -----------------------------------------
  */

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

  let alternationScore = 0;

  if (switchRate >= 0.72) {

    /*
      Strong alternation environment:
      next side gets slight continuation
      signal based on previous transition.
    */

    alternationScore =
      latest === "BIG"
        ? -0.08
        : 0.08;

  } else if (
    switchRate <= 0.28
  ) {

    /*
      Sticky environment.
    */

    alternationScore =
      latest === "BIG"
        ? 0.08
        : -0.08;
  }

  /*
  -----------------------------------------
  SIGNAL 5: HISTORICAL SUFFIX MATCH
  -----------------------------------------
  */

  const patternLength =
    Math.min(
      4,
      seq.length - 2
    );

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

    const historicalPattern =
      seq
        .slice(
          i,
          i + patternLength
        )
        .join("-");

    if (
      historicalPattern ===
      pattern
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

  if (matches > 0) {

    patternScore =
      (
        matchBig -
        matchSmall
      ) /
      matches;

    patternScore =
      Math.max(
        -1,
        Math.min(
          1,
          patternScore
        )
      );
  }

  /*
  -----------------------------------------
  SIGNAL 6: SHORT/LONG DIRECTION
  -----------------------------------------
  */

  const short =
    seq.slice(
      0,
      Math.min(5, seq.length)
    );

  const medium =
    seq.slice(
      0,
      Math.min(15, seq.length)
    );

  function ratio(
    values
  ) {

    if (!values.length) {
      return 0;
    }

    let b = 0;

    for (const v of values) {

      if (v === "BIG") {
        b++;
      }
    }

    return (
      b / values.length
    );
  }

  const shortRatio =
    ratio(short);

  const mediumRatio =
    ratio(medium);

  const longRatio =
    ratio(seq);

  const directionScore =
    (
      (shortRatio - 0.5) * 0.50
    ) +
    (
      (mediumRatio - 0.5) * 0.30
    ) +
    (
      (longRatio - 0.5) * 0.20
    );

  /*
  -----------------------------------------
  SIGNAL 7: ENTROPY / RANDOMNESS
  -----------------------------------------
  */

  const p =
    seq.length
      ? big / seq.length
      : 0;

  let entropy = 0;

  if (
    p > 0 &&
    p < 1
  ) {

    entropy =
      -(
        p * Math.log2(p)
      ) -
      (
        (1 - p) *
        Math.log2(1 - p)
      );
  }

  /*
  entropy near 1 means roughly balanced.
  Balanced data alone should not generate
  high confidence.
  */

  /*
  -----------------------------------------
  ENSEMBLE
  -----------------------------------------
  */

  let score = 0;

  score +=
    recentScore *
    0.24;

  score +=
    transitionScore *
    0.22;

  score +=
    patternScore *
    0.20;

  score +=
    directionScore *
    0.16;

  score +=
    streakScore *
    0.08;

  score +=
    alternationScore *
    0.10;

  /*
  If no historical pattern matches,
  reduce confidence rather than inventing
  a pattern.
  */

  const patternQuality =
    matches >= 3
      ? 1
      : matches === 2
        ? 0.75
        : matches === 1
          ? 0.5
          : 0.25;

  /*
  Agreement between major signals.
  */

  const signalValues = [

    recentScore,

    transitionScore,

    patternScore,

    directionScore

  ];

  let positive = 0;
  let negative = 0;

  signalValues.forEach(
    value => {

      if (
        value > 0.05
      ) {
        positive++;
      }

      if (
        value < -0.05
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
    signalValues.length;

  /*
  Very weak edge = SKIP.
  */

  const absoluteScore =
    Math.abs(score);

  let prediction =
    "SKIP";

  if (
    absoluteScore >= 0.075 &&
    agreement >= 0.50
  ) {

    prediction =
      score > 0
        ? "BIG"
        : "SMALL";
  }

  /*
  Confidence is based on model edge,
  agreement, pattern quality and entropy.
  */

  let confidence = 0;

  if (
    prediction !== "SKIP"
  ) {

    const edge =
      Math.min(
        1,
        absoluteScore * 4
      );

    confidence =
      50 +
      (
        edge * 24
      ) +
      (
        agreement * 12
      ) +
      (
        patternQuality * 8
      );

    /*
      Balanced/high entropy data reduces
      confidence.
    */

    if (
      entropy >= 0.97
    ) {

      confidence -= 8;

    } else if (
      entropy >= 0.90
    ) {

      confidence -= 4;
    }

    confidence =
      Math.round(
        Math.max(
          50,
          Math.min(
            84,
            confidence
          )
        )
      );
  }

  let quality =
    "WEAK";

  if (
    agreement >= 0.75 &&
    patternQuality >= 0.75
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

    entropy:
      Number(
        entropy.toFixed(3)
      ),

    agreement:
      Number(
        agreement.toFixed(2)
      ),

    pattern,

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
        ? "Signals are conflicting or edge is too weak"
        : "Ensemble pattern agreement"
  };
}

/*
=========================================================
PREDICTION DATABASE
=========================================================
*/

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

async function getLatestPrediction() {

  if (pool) {

    const result =
      await pool.query(
        `
        SELECT *
        FROM prediction_records
        ORDER BY id DESC
        LIMIT 1
        `
      );

    return (
      result.rows[0] ||
      null
    );
  }

  return (
    memory.predictions[0] ||
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

    ...data,

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

async function settlePredictions() {

  if (!live.history.length) {
    return;
  }

  /*
    Only settle predictions for actual
    issues returned by the API.
  */

  for (
    const row of
    live.history.slice(0, 20)
  ) {

    if (!row.issueNumber) {
      continue;
    }

    const actual =
      row.result;

    if (pool) {

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
          row.number,
          actual,
          now(),
          row.issueNumber
        ]
      );

    } else {

      for (
        const prediction
        of memory.predictions
      ) {

        if (
          String(
            prediction.target_issue
          ) ===
          String(
            row.issueNumber
          ) &&
          !prediction.actual_result
        ) {

          prediction.actual_number =
            row.number;

          prediction.actual_result =
            actual;

          prediction.settled_at =
            now();
        }
      }
    }
  }
}

/*
=========================================================
4 ROUND COOLDOWN
=========================================================
*/

async function generatePrediction() {

  if (
    !live.ok ||
    !live.currentIssue ||
    live.history.length < 8
  ) {
    return null;
  }

  const target =
    nextIssue(
      live.currentIssue
    );

  if (!target) {
    return null;
  }

  /*
    If prediction already exists
    for this exact target, return it.
  */

  const existing =
    await getPrediction(
      target
    );

  if (existing) {

    return {
      ...existing,

      status:
        existing.actual_result
          ? (
              existing.prediction ===
              existing.actual_result
                ? "WIN"
                : "LOSS"
            )
          : "PENDING"
    };
  }

  /*
    ---------------------------------------
    FOUR COMPLETE ROUND COOLDOWN
    ---------------------------------------
  */

  const latest =
    await getLatestPrediction();

  if (latest) {

    try {

      const lastTarget =
        BigInt(
          String(
            latest.target_issue
          )
        );

      const current =
        BigInt(
          String(
            live.currentIssue
          )
        );

      const passed =
        Number(
          current -
          lastTarget
        );

      /*
        Previous prediction:
        10643

        10644 -> skip
        10645 -> skip
        10646 -> skip
        10647 -> skip
        10648 -> allowed
      */

      if (
        passed >= 1 &&
        passed <= 4
      ) {

        return {

          target_issue:
            target,

          prediction:
            "SKIP",

          confidence:
            0,

          model_version:
            MODEL_VERSION,

          created_at:
            now(),

          actual_number:
            null,

          actual_result:
            null,

          status:
            "COOLDOWN",

          skipRounds:
            5 - passed
        };
      }

    } catch {
      /*
        Non numeric issue:
        continue without cooldown calculation.
      */
    }
  }

  /*
    ---------------------------------------
    RUN ENSEMBLE
    ---------------------------------------
  */

  const model =
    calculateModel(
      live.history
    );

  /*
    Weak/conflicting signal.
    No fake prediction.
  */

  if (
    model.prediction ===
    "SKIP"
  ) {

    return {

      target_issue:
        target,

      prediction:
        "SKIP",

      confidence:
        0,

      model_version:
        MODEL_VERSION,

      created_at:
        now(),

      status:
        "MODEL_SKIP",

      analysis:
        model
    };
  }

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
    `[AI] ${target} -> ${model.prediction} | confidence ${model.confidence}% | ${model.quality}`
  );

  return {

    ...saved,

    status:
      "PENDING",

    analysis:
      model
  };
}

/*
=========================================================
STATE
=========================================================
*/

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

  const model =
    calculateModel(
      live.history
    );

  const prediction =
    await generatePrediction();

  const latest =
    live.history[0] ||
    null;

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
              prediction.target_issue,

            result:
              prediction.prediction,

            confidence:
              Number(
                prediction.confidence ||
                0
              ),

            status:
              prediction.status,

            actualNumber:
              prediction.actual_number ??
              null,

            actualResult:
              prediction.actual_result ??
              null,

            skipRounds:
              prediction.skipRounds ||
              0,

            model:
              prediction.model_version ||
              MODEL_VERSION
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

      signals:
        model.signals,

      transitions:
        model.transitions,

      counts:
        model.counts,

      reason:
        model.reason
    },

    recentResults:
      live.history
        .slice(0, 30)
        .map(row => ({

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
        })),

    source: {

      provider:
        "WingoBot",

      endpoint:
        WINGOBOT_URL,

      fetched:
        live.fetched,

      updated:
        live.updated,

      lastFetch:
        live.lastFetch
    },

    serverTime:
      now()
  };
}

/*
=========================================================
ADMIN
=========================================================
*/

function adminAuth(url) {

  return (
    url.searchParams.get(
      "key"
    ) === ADMIN_KEY
  );
}

async function getPredictions() {

  if (pool) {

    const result =
      await pool.query(
        `
        SELECT *
        FROM prediction_records
        ORDER BY id DESC
        LIMIT 200
        `
      );

    return result.rows;
  }

  return memory.predictions;
}

/*
=========================================================
RESPONSE
=========================================================
*/

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

/*
=========================================================
HTTP SERVER
=========================================================
*/

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
        HOME
        */

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

        if (
          url.pathname ===
            "/admin.html"
        ) {

          return serveFile(
            res,
            "admin.html"
          );
        }

        /*
        HEALTH
        */

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

        /*
        KEY CHECK
        */

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

        /*
        STATE
        */

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

        /*
        ADMIN STATUS
        */

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
                ok: false,
                error:
                  "Unauthorized"
              }
            );
          }

          return sendJson(
            res,
            200,
            {
              ok: true,

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

        /*
        LIVE TEST
        */

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
                ok: false,
                error:
                  "Unauthorized"
              }
            );
          }

          try {

            const direct =
              await fetchWingo();

            return sendJson(
              res,
              200,
              {
                ok: true,

                success: true,

                currentIssue:
                  direct.currentIssue,

                resultCount:
                  direct.history.length,

                fetched:
                  direct.fetched,

                updated:
                  direct.updated,

                history:
                  direct.history
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
                  error.message,

                tokenConfigured:
                  Boolean(
                    WINGOBOT_TOKEN
                  )
              }
            );
          }
        }

        /*
        MODEL TEST
        */

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
                ok: false,
                error:
                  "Unauthorized"
              }
            );
          }

          return sendJson(
            res,
            200,
            {
              ok: true,

              model:
                MODEL_VERSION,

              analysis:
                calculateModel(
                  live.history
                )
            }
          );
        }

        /*
        ADMIN KEYS GET
        */

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
                ok: false,
                error:
                  "Unauthorized"
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
        ADMIN CREATE KEY
        */

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
                ok: false,
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
                    ok: true,
                    key: created
                  }
                );

              } catch (error) {

                return sendJson(
                  res,
                  400,
                  {
                    ok: false,
                    error:
                      error.message
                  }
                );
              }
            }
          );

          return;
        }

        /*
        RESET DEVICE
        */

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
                ok: false,
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
                    ok: true
                  }
                );

              } catch (error) {

                return sendJson(
                  res,
                  400,
                  {
                    ok: false,
                    error:
                      error.message
                  }
                );
              }
            }
          );

          return;
        }

        /*
        DELETE KEY
        */

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
                ok: false,
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
                    ok: true
                  }
                );

              } catch (error) {

                return sendJson(
                  res,
                  400,
                  {
                    ok: false,
                    error:
                      error.message
                  }
                );
              }
            }
          );

          return;
        }

        /*
        PREDICTIONS
        */

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
                ok: false,
                error:
                  "Unauthorized"
              }
            );
          }

          return sendJson(
            res,
            200,
            {
              ok: true,

              predictions:
                await getPredictions()
            }
          );
        }

        /*
        404
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

/*
=========================================================
START
=========================================================
*/

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
          "================================"
        );

        console.log(
          " DY AI WINGO 1 MINUTE V5"
        );

        console.log(
          ` PORT: ${PORT}`
        );

        console.log(
          ` MODEL: ${MODEL_VERSION}`
        );

        console.log(
          ` TOKEN: ${
            WINGOBOT_TOKEN
              ? "CONFIGURED"
              : "MISSING"
          }`
        );

        console.log(
          ` DATABASE: ${
            databaseEnabled
              ? "POSTGRESQL"
              : "MEMORY"
          }`
        );

        console.log(
          "================================"
        );
      }
    );

  } catch (error) {

    console.error(
      "[STARTUP ERROR]",
      error
    );

    process.exit(1);
  }
}

start();
