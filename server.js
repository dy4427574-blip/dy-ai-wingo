"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 3000);

const ADMIN_KEY = String(
  process.env.ADMIN_KEY || "dy4427574"
).trim();

const WINGOBOT_TOKEN = String(
  process.env.WINGOBOT_TOKEN || ""
).trim();

const WINGOBOT_URL =
  "https://api.wingobot.com/v2/1-min-game-history";

const MODEL_VERSION = "DY-AI-ADAPTIVE-V4";

const ANALYSIS_TIME = 4000;
const POLL_TIME = 1000;
const ENGINE_TIME = 250;

const SKIP_ROUNDS = 4;

const MIN_HISTORY = 12;

/* =========================================================
   DATABASE
   ========================================================= */

let pool = null;
let dbReady = false;

if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    }
  });

  pool.on("error", function (err) {
    console.error(
      "POSTGRES ERROR:",
      err.message
    );
  });
}

/* =========================================================
   MEMORY FALLBACK
   ========================================================= */

const memory = {
  keys: [],
  predictions: []
};

/* =========================================================
   LIVE DATA
   ========================================================= */

const live = {
  online: false,
  history: [],
  currentIssue: null,
  latestNumber: null,
  latestResult: null,
  previousIssue: null,
  lastFetchAt: 0,
  lastError: null,
  source: "WingoBot"
};

/* =========================================================
   ANALYSIS
   ========================================================= */

const analysis = {
  active: false,
  issue: null,
  startedAt: 0,
  completed: false
};

/* =========================================================
   BASIC HELPERS
   ========================================================= */

function now() {
  return Date.now();
}

function str(value) {
  if (
    value === undefined ||
    value === null
  ) {
    return "";
  }

  return String(value).trim();
}

function clamp(value, min, max) {
  return Math.max(
    min,
    Math.min(max, value)
  );
}

function average(arr) {
  if (!arr.length) {
    return 0;
  }

  return (
    arr.reduce(
      (a, b) => a + b,
      0
    ) / arr.length
  );
}

function cleanNumber(value) {
  if (
    typeof value === "number" &&
    Number.isFinite(value)
  ) {
    const n = Math.trunc(value);

    if (n >= 0 && n <= 9) {
      return n;
    }
  }

  const s = str(value);

  if (!s) {
    return null;
  }

  const match = s.match(/[0-9]/);

  if (!match) {
    return null;
  }

  const n = Number(match[0]);

  if (
    !Number.isInteger(n) ||
    n < 0 ||
    n > 9
  ) {
    return null;
  }

  return n;
}

function resultFromNumber(number) {
  if (
    number === null ||
    number === undefined
  ) {
    return null;
  }

  return number >= 5
    ? "BIG"
    : "SMALL";
}

function sigmoid(x) {
  if (x < -50) {
    return 0;
  }

  if (x > 50) {
    return 1;
  }

  return 1 / (1 + Math.exp(-x));
}

/* =========================================================
   ISSUE HELPERS
   ========================================================= */

function issueDigits(issue) {
  const digits =
    str(issue).replace(/\D/g, "");

  return digits || null;
}

function nextIssue(issue) {
  const digits =
    issueDigits(issue);

  if (!digits) {
    return null;
  }

  try {
    return (
      BigInt(digits) + 1n
    )
      .toString()
      .padStart(
        digits.length,
        "0"
      );
  } catch {
    return null;
  }
}

function issueDiff(current, previous) {
  const a =
    issueDigits(current);

  const b =
    issueDigits(previous);

  if (!a || !b) {
    return null;
  }

  try {
    const difference =
      BigInt(a) - BigInt(b);

    if (
      difference >
      BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      return null;
    }

    if (
      difference <
      BigInt(Number.MIN_SAFE_INTEGER)
    ) {
      return null;
    }

    return Number(difference);
  } catch {
    return null;
  }
}

/* =========================================================
   WINGOBOT DATA NORMALIZATION
   ========================================================= */

function getPossibleArrays(object) {
  const arrays = [];

  if (
    !object ||
    typeof object !== "object"
  ) {
    return arrays;
  }

  for (
    const key of Object.keys(object)
  ) {
    if (
      Array.isArray(object[key])
    ) {
      arrays.push(
        object[key]
      );
    }
  }

  return arrays;
}

function findNumber(item) {
  if (
    item === null ||
    item === undefined
  ) {
    return null;
  }

  if (
    typeof item === "number"
  ) {
    return cleanNumber(item);
  }

  if (
    typeof item === "string"
  ) {
    return cleanNumber(item);
  }

  if (
    typeof item !== "object"
  ) {
    return null;
  }

  const keys = [
    "number",
    "result",
    "digit",
    "num",
    "value",
    "openNumber",
    "open_number",
    "winningNumber",
    "winning_number",
    "lotteryNumber",
    "lottery_number"
  ];

  for (
    const key of keys
  ) {
    if (
      Object.prototype.hasOwnProperty.call(
        item,
        key
      )
    ) {
      const n =
        cleanNumber(item[key]);

      if (n !== null) {
        return n;
      }
    }
  }

  return null;
}

function findIssue(item) {
  if (
    !item ||
    typeof item !== "object"
  ) {
    return null;
  }

  const keys = [
    "issue",
    "issueNumber",
    "issue_number",
    "period",
    "periodId",
    "period_id",
    "draw",
    "drawNumber",
    "draw_number"
  ];

  for (
    const key of keys
  ) {
    if (
      Object.prototype.hasOwnProperty.call(
        item,
        key
      )
    ) {
      const value =
        str(item[key]);

      const digits =
        issueDigits(value);

      if (
        digits &&
        digits.length >= 3
      ) {
        return digits;
      }
    }
  }

  return null;
}

function normalizeHistory(payload) {
  const output = [];
  const seen = new Set();

  if (!payload) {
    return output;
  }

  const arrays = [];

  if (Array.isArray(payload)) {
    arrays.push(payload);
  }

  arrays.push(
    ...getPossibleArrays(payload)
  );

  if (
    payload.data &&
    typeof payload.data === "object"
  ) {
    if (
      Array.isArray(
        payload.data
      )
    ) {
      arrays.push(
        payload.data
      );
    }

    arrays.push(
      ...getPossibleArrays(
        payload.data
      )
    );
  }

  if (
    payload.result &&
    typeof payload.result === "object"
  ) {
    if (
      Array.isArray(
        payload.result
      )
    ) {
      arrays.push(
        payload.result
      );
    }

    arrays.push(
      ...getPossibleArrays(
        payload.result
      )
    );
  }

  for (
    const array of arrays
  ) {
    for (
      const item of array
    ) {
      const number =
        findNumber(item);

      if (number === null) {
        continue;
      }

      const issue =
        findIssue(item);

      const unique =
        `${issue || ""}:${number}`;

      if (
        seen.has(unique)
      ) {
        continue;
      }

      seen.add(unique);

      output.push({
        issue,
        number,
        result:
          resultFromNumber(
            number
          )
      });
    }
  }

  return output;
}

/* =========================================================
   SORT HISTORY
   ========================================================= */

function sortHistory(history) {
  const list =
    Array.isArray(history)
      ? history.slice()
      : [];

  const usable =
    list.filter(
      item =>
        issueDigits(item.issue)
    );

  if (
    usable.length >= 2
  ) {
    usable.sort(
      function (a, b) {
        try {
          const A =
            BigInt(
              issueDigits(
                a.issue
              )
            );

          const B =
            BigInt(
              issueDigits(
                b.issue
              )
            );

          if (A < B) return -1;
          if (A > B) return 1;

          return 0;
        } catch {
          return 0;
        }
      }
    );

    return usable;
  }

  return list;
}

/* =========================================================
   CURRENT ISSUE
   ========================================================= */

function findCurrentIssue(payload) {
  if (
    !payload ||
    typeof payload !== "object"
  ) {
    return null;
  }

  const keys = [
    "currentIssue",
    "current_issue",
    "currentPeriod",
    "current_period",
    "currentPeriodId",
    "current_period_id",
    "currentIssueNumber",
    "current_issue_number",
    "nextIssue",
    "next_issue",
    "nextPeriod",
    "next_period"
  ];

  for (
    const key of keys
  ) {
    if (
      Object.prototype.hasOwnProperty.call(
        payload,
        key
      )
    ) {
      const digits =
        issueDigits(
          payload[key]
        );

      if (
        digits &&
        digits.length >= 3
      ) {
        return digits;
      }
    }
  }

  if (
    payload.data &&
    typeof payload.data === "object"
  ) {
    const found =
      findCurrentIssue(
        payload.data
      );

    if (found) {
      return found;
    }
  }

  if (
    payload.result &&
    typeof payload.result === "object"
  ) {
    const found =
      findCurrentIssue(
        payload.result
      );

    if (found) {
      return found;
    }
  }

  return null;
}

function deriveCurrentIssue(history) {
  if (!history.length) {
    return null;
  }

  const sorted =
    sortHistory(history);

  const last =
    sorted[
      sorted.length - 1
    ];

  if (
    !last ||
    !last.issue
  ) {
    return null;
  }

  return nextIssue(
    last.issue
  );
}

/* =========================================================
   WINGOBOT API
   ========================================================= */

async function fetchWingo() {
  if (!WINGOBOT_TOKEN) {
    throw new Error(
      "WINGOBOT_TOKEN missing"
    );
  }

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      8000
    );

  try {
    const response =
      await fetch(
        WINGOBOT_URL,
        {
          method: "GET",

          headers: {
            Authorization:
              "Bearer " +
              WINGOBOT_TOKEN,

            Accept:
              "application/json",

            "User-Agent":
              "DY-AI-Wingo/4.0"
          },

          signal:
            controller.signal
        }
      );

    if (!response.ok) {
      throw new Error(
        "WingoBot HTTP " +
        response.status
      );
    }

    const payload =
      await response.json();

    const rawHistory =
      normalizeHistory(
        payload
      );

    const history =
      sortHistory(
        rawHistory
      );

    if (!history.length) {
      throw new Error(
        "No result history found"
      );
    }

    const explicitIssue =
      findCurrentIssue(
        payload
      );

    const currentIssue =
      explicitIssue ||
      deriveCurrentIssue(
        history
      );

    const latest =
      history[
        history.length - 1
      ];

    live.online = true;

    live.history =
      history;

    live.currentIssue =
      currentIssue;

    live.latestNumber =
      latest
        ? latest.number
        : null;

    live.latestResult =
      latest
        ? latest.result
        : null;

    live.lastFetchAt =
      now();

    live.lastError =
      null;

    return {
      history,
      currentIssue,
      latest,
      payload
    };
  } finally {
    clearTimeout(timeout);
  }
}

/* =========================================================
   DATABASE INIT
   ========================================================= */

async function initDB() {
  if (!pool) {
    console.log(
      "DATABASE_URL not found - MEMORY MODE"
    );

    return;
  }

  try {
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

    dbReady = true;

    console.log(
      "POSTGRESQL READY"
    );
  } catch (error) {
    dbReady = false;

    console.error(
      "DATABASE INIT ERROR:",
      error.message
    );
  }
}

/* =========================================================
   ACCESS KEY FUNCTIONS
   ========================================================= */

async function getKey(accessKey) {
  const key =
    str(accessKey);

  if (!key) {
    return null;
  }

  if (
    dbReady &&
    pool
  ) {
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

    return (
      result.rows[0] ||
      null
    );
  }

  return (
    memory.keys.find(
      item =>
        item.access_key === key
    ) ||
    null
  );
}

async function createKey(accessKey) {
  let key =
    str(accessKey);

  if (!key) {
    key =
      "DY-" +
      crypto
        .randomBytes(8)
        .toString("hex")
        .toUpperCase();
  }

  if (
    dbReady &&
    pool
  ) {
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
        VALUES
        ($1, NULL, $2, 0)
        RETURNING *
        `,
        [
          key,
          now()
        ]
      );

    return result.rows[0];
  }

  if (
    memory.keys.some(
      item =>
        item.access_key === key
    )
  ) {
    throw new Error(
      "KEY ALREADY EXISTS"
    );
  }

  const item = {
    id:
      memory.keys.length + 1,

    access_key:
      key,

    device_id:
      null,

    created_at:
      now(),

    last_seen:
      0
  };

  memory.keys.push(
    item
  );

  return item;
}

async function listKeys() {
  if (
    dbReady &&
    pool
  ) {
    const result =
      await pool.query(`
        SELECT *
        FROM access_keys
        ORDER BY id DESC
      `);

    return result.rows;
  }

  return memory.keys
    .slice()
    .reverse();
}

async function resetKeyDevice(
  accessKey
) {
  const key =
    str(accessKey);

  if (
    dbReady &&
    pool
  ) {
    const result =
      await pool.query(
        `
        UPDATE access_keys
        SET
          device_id = NULL,
          last_seen = 0
        WHERE access_key = $1
        RETURNING *
        `,
        [key]
      );

    return (
      result.rows[0] ||
      null
    );
  }

  const item =
    memory.keys.find(
      x =>
        x.access_key === key
    );

  if (!item) {
    return null;
  }

  item.device_id = null;
  item.last_seen = 0;

  return item;
}

async function removeKey(
  accessKey
) {
  const key =
    str(accessKey);

  if (
    dbReady &&
    pool
  ) {
    const result =
      await pool.query(
        `
        DELETE FROM access_keys
        WHERE access_key = $1
        RETURNING *
        `,
        [key]
      );

    return (
      result.rows[0] ||
      null
    );
  }

  const index =
    memory.keys.findIndex(
      x =>
        x.access_key === key
    );

  if (index < 0) {
    return null;
  }

  return memory.keys.splice(
    index,
    1
  )[0];
}

async function checkAccess(
  accessKey,
  deviceId
) {
  const key =
    str(accessKey);

  const device =
    str(deviceId);

  if (!key || !device) {
    return {
      ok: false,
      message:
        "KEY AND DEVICE REQUIRED"
    };
  }

  const record =
    await getKey(key);

  if (!record) {
    return {
      ok: false,
      message:
        "INVALID ACCESS KEY"
    };
  }

  if (
    record.device_id &&
    record.device_id !== device
  ) {
    return {
      ok: false,
      message:
        "KEY ALREADY BOUND TO ANOTHER DEVICE"
    };
  }

  if (
    dbReady &&
    pool
  ) {
    await pool.query(
      `
      UPDATE access_keys
      SET
        device_id =
          COALESCE(device_id, $1),
        last_seen = $2
      WHERE access_key = $3
      `,
      [
        device,
        now(),
        key
      ]
    );
  } else {
    record.device_id =
      record.device_id ||
      device;

    record.last_seen =
      now();
  }

  return {
    ok: true,
    message:
      "ACCESS GRANTED"
  };
}

/* =========================================================
   AUTH
   ========================================================= */

function adminAuth(req, body) {
  const provided =
    str(
      req.headers[
        "x-admin-key"
      ]
    ) ||
    str(
      body &&
        body.adminKey
    );

  return (
    provided ===
    ADMIN_KEY
  );
}

async function userAuth(
  req,
  body
) {
  const accessKey =
    str(
      req.headers[
        "x-access-key"
      ]
    ) ||
    str(
      body &&
        body.accessKey
    );

  const deviceId =
    str(
      req.headers[
        "x-device-id"
      ]
    ) ||
    str(
      body &&
        body.deviceId
    );

  return checkAccess(
    accessKey,
    deviceId
  );
}

/* =========================================================
   FEATURE ENGINE
   ========================================================= */

function buildFeatures(
  history
) {
  const sorted =
    sortHistory(history);

  const numbers =
    sorted
      .map(
        x => x.number
      )
      .filter(
        x =>
          Number.isInteger(x) &&
          x >= 0 &&
          x <= 9
      );

  const bits =
    numbers.map(
      n =>
        n >= 5
          ? 1
          : 0
    );

  const last12 =
    bits.slice(-12);

  const last8Numbers =
    numbers.slice(-8);

  const last20 =
    bits.slice(-20);

  const bigCount =
    last20.filter(
      x => x === 1
    ).length;

  const smallCount =
    last20.filter(
      x => x === 0
    ).length;

  const bigRatio =
    last20.length
      ? bigCount /
        last20.length
      : 0.5;

  const smallRatio =
    1 - bigRatio;

  let streak =
    0;

  let streakValue =
    null;

  if (bits.length) {
    streakValue =
      bits[
        bits.length - 1
      ];

    for (
      let i =
        bits.length - 1;
      i >= 0;
      i--
    ) {
      if (
        bits[i] ===
        streakValue
      ) {
        streak++;
      } else {
        break;
      }
    }
  }

  let switches = 0;
  let transitions = 0;

  for (
    let i = 1;
    i < bits.length;
    i++
  ) {
    transitions++;

    if (
      bits[i] !==
      bits[i - 1]
    ) {
      switches++;
    }
  }

  const switchRate =
    transitions
      ? switches /
        transitions
      : 0.5;

  const altBits =
    bits.slice(-8);

  let alt =
    0;

  if (
    altBits.length >= 2
  ) {
    let count = 0;

    for (
      let i = 1;
      i < altBits.length;
      i++
    ) {
      count++;

      if (
        altBits[i] !==
        altBits[i - 1]
      ) {
        alt++;
      }
    }

    alt =
      count
        ? alt / count
        : 0;
  }

  const recentNumbers =
    numbers.slice(-10);

  const previousNumbers =
    numbers.slice(-20, -10);

  const avgRecent =
    average(
      recentNumbers
    );

  const avgPrevious =
    average(
      previousNumbers
    );

  const avgDelta =
    avgPrevious
      ? (
          avgRecent -
          avgPrevious
        ) / 9
      : 0;

  const highDigitRatio =
    numbers.length
      ? numbers.filter(
          n => n >= 7
        ).length /
        numbers.length
      : 0.5;

  const lowDigitRatio =
    numbers.length
      ? numbers.filter(
          n => n <= 2
        ).length /
        numbers.length
      : 0.5;

  let movement = 0;

  const movementNumbers =
    numbers.slice(-8);

  if (
    movementNumbers.length >= 2
  ) {
    let total = 0;

    let count = 0;

    for (
      let i = 1;
      i <
        movementNumbers.length;
      i++
    ) {
      total +=
        Math.abs(
          movementNumbers[i] -
          movementNumbers[i - 1]
        );

      count++;
    }

    movement =
      count
        ? total /
          count /
          9
        : 0;
  }

  let range = 0;

  if (
    recentNumbers.length
  ) {
    range =
      (
        Math.max(
          ...recentNumbers
        ) -
        Math.min(
          ...recentNumbers
        )
      ) / 9;
  }

  const evenRatio =
    numbers.length
      ? numbers.filter(
          n => n % 2 === 0
        ).length /
        numbers.length
      : 0.5;

  const vector = [
    bigRatio,
    smallRatio,
    switchRate,
    alt,
    Math.min(
      streak,
      10
    ) / 10,
    streakValue === 1
      ? 1
      : 0,
    avgRecent / 9,
    avgDelta,
    highDigitRatio,
    lowDigitRatio,
    movement,
    range,
    evenRatio
  ];

  for (
    let i = 0;
    i < 12;
    i++
  ) {
    vector.push(
      last12[i] === undefined
        ? 0.5
        : last12[i]
    );
  }

  for (
    let i = 0;
    i < 8;
    i++
  ) {
    vector.push(
      last8Numbers[i] === undefined
        ? 0.5
        : last8Numbers[i] / 9
    );
  }

  return {
    numbers,
    bits,
    vector,
    last12,
    bigRatio,
    smallRatio,
    switchRate,
    alternation: alt,
    streak,
    streakValue,
    avgRecent,
    avgPrevious,
    avgDelta,
    highDigitRatio,
    lowDigitRatio,
    movement,
    range,
    evenRatio
  };
}

/* =========================================================
   LOGISTIC MODEL
   ========================================================= */

function dot(a, b) {
  let sum = 0;

  for (
    let i = 0;
    i <
      Math.min(
        a.length,
        b.length
      );
    i++
  ) {
    sum +=
      a[i] * b[i];
  }

  return sum;
}

function createTrainingSet(
  history
) {
  const sorted =
    sortHistory(history);

  const samples = [];

  for (
    let i = 1;
    i < sorted.length;
    i++
  ) {
    const target =
      sorted[i].number;

    if (
      !Number.isInteger(
        target
      )
    ) {
      continue;
    }

    const past =
      sorted.slice(
        0,
        i
      );

    if (
      past.length <
      MIN_HISTORY
    ) {
      continue;
    }

    const features =
      buildFeatures(
        past
      );

    samples.push({
      x:
        features.vector,

      y:
        target >= 5
          ? 1
          : 0
    });
  }

  return samples;
}

function trainModel(
  samples
) {
  if (
    !samples ||
    samples.length <
      MIN_HISTORY
  ) {
    return null;
  }

  const size =
    samples[0].x.length;

  const weights =
    new Array(size).fill(0);

  let bias = 0;

  const learningRate =
    0.04;

  const epochs = 160;

  for (
    let epoch = 0;
    epoch < epochs;
    epoch++
  ) {
    const gradient =
      new Array(size).fill(0);

    let biasGradient = 0;

    for (
      const sample of samples
    ) {
      const probability =
        sigmoid(
          dot(
            weights,
            sample.x
          ) + bias
        );

      const error =
        probability -
        sample.y;

      for (
        let j = 0;
        j < size;
        j++
      ) {
        gradient[j] +=
          error *
          sample.x[j];
      }

      biasGradient +=
        error;
    }

    for (
      let j = 0;
      j < size;
      j++
    ) {
      weights[j] -=
        learningRate *
        gradient[j] /
        samples.length;
    }

    bias -=
      learningRate *
      biasGradient /
      samples.length;
  }

  return {
    weights,
    bias
  };
}

/* =========================================================
   WALK FORWARD TEST
   ========================================================= */

function walkForward(
  history
) {
  const samples =
    createTrainingSet(
      history
    );

  if (
    samples.length <
    MIN_HISTORY
  ) {
    return {
      accuracy: 0.5,
      baseline: 0.5,
      edge: 0,
      samples:
        samples.length,
      tested: 0
    };
  }

  const start =
    Math.max(
      MIN_HISTORY,
      Math.floor(
        samples.length *
        0.45
      )
    );

  let correct = 0;
  let tested = 0;

  for (
    let i = start;
    i < samples.length;
    i++
  ) {
    const model =
      trainModel(
        samples.slice(
          0,
          i
        )
      );

    if (!model) {
      continue;
    }

    const probability =
      sigmoid(
        dot(
          model.weights,
          samples[i].x
        ) + model.bias
      );

    const predicted =
      probability >= 0.5
        ? 1
        : 0;

    if (
      predicted ===
      samples[i].y
    ) {
      correct++;
    }

    tested++;
  }

  const accuracy =
    tested
      ? correct /
        tested
      : 0.5;

  const big =
    samples.filter(
      x => x.y === 1
    ).length;

  const small =
    samples.length -
    big;

  const baseline =
    samples.length
      ? Math.max(
          big,
          small
        ) /
        samples.length
      : 0.5;

  return {
    accuracy,
    baseline,
    edge:
      accuracy -
      baseline,
    samples:
      samples.length,
    tested
  };
}

/* =========================================================
   MARKOV MODEL
   ========================================================= */

function markovModel(
  bits
) {
  if (
    bits.length < 5
  ) {
    return {
      probability: 0.5,
      support: 0
    };
  }

  const recent =
    bits.slice(-80);

  const counts = {
    0: {
      0: 1,
      1: 1
    },

    1: {
      0: 1,
      1: 1
    }
  };

  for (
    let i = 1;
    i < recent.length;
    i++
  ) {
    counts[
      recent[i - 1]
    ][
      recent[i]
    ]++;
  }

  const last =
    recent[
      recent.length - 1
    ];

  const total =
    counts[last][0] +
    counts[last][1];

  return {
    probability:
      counts[last][1] /
      total,

    support:
      total - 2
  };
}

/* =========================================================
   3-BIT PATTERN MODEL
   ========================================================= */

function patternModel(
  bits
) {
  if (
    bits.length < 8
  ) {
    return {
      probability: 0.5,
      matches: 0
    };
  }

  const pattern =
    bits.slice(-3);

  let big = 1;
  let small = 1;
  let matches = 0;

  for (
    let i = 3;
    i < bits.length;
    i++
  ) {
    if (
      bits[i - 3] ===
        pattern[0] &&
      bits[i - 2] ===
        pattern[1] &&
      bits[i - 1] ===
        pattern[2]
    ) {
      matches++;

      if (
        bits[i] === 1
      ) {
        big++;
      } else {
        small++;
      }
    }
  }

  return {
    probability:
      big /
      (
        big +
        small
      ),

    matches
  };
}

/* =========================================================
   5-BIT PATTERN MODEL
   ========================================================= */

function longPatternModel(
  bits
) {
  if (
    bits.length < 12
  ) {
    return {
      probability: 0.5,
      matches: 0
    };
  }

  const pattern =
    bits.slice(-5);

  let big = 1;
  let small = 1;
  let matches = 0;

  for (
    let i = 5;
    i < bits.length;
    i++
  ) {
    let same = true;

    for (
      let j = 0;
      j < 5;
      j++
    ) {
      if (
        bits[
          i - 5 + j
        ] !== pattern[j]
      ) {
        same = false;
        break;
      }
    }

    if (!same) {
      continue;
    }

    matches++;

    if (
      bits[i] === 1
    ) {
      big++;
    } else {
      small++;
    }
  }

  return {
    probability:
      big /
      (
        big +
        small
      ),

    matches
  };
}

/* =========================================================
   STREAK MODEL
   ========================================================= */

function streakModel(
  features
) {
  if (
    !features.streak ||
    features.streakValue === null
  ) {
    return {
      probability: 0.5,
      support: 0
    };
  }

  const bits =
    features.bits;

  let same = 1;
  let opposite = 1;
  let support = 0;

  for (
    let i = 1;
    i < bits.length - 1;
    i++
  ) {
    let run = 1;

    for (
      let j = i - 1;
      j >= 0;
      j--
    ) {
      if (
        bits[j] ===
        bits[i]
      ) {
        run++;
      } else {
        break;
      }
    }

    if (
      run !==
      features.streak
    ) {
      continue;
    }

    support++;

    if (
      bits[i + 1] ===
      bits[i]
    ) {
      same++;
    } else {
      opposite++;
    }
  }

  if (!support) {
    return {
      probability: 0.5,
      support: 0
    };
  }

  const oppositeRate =
    opposite /
    (
      opposite +
      same
    );

  let probability;

  if (
    features.streakValue === 1
  ) {
    probability =
      1 -
      oppositeRate;
  } else {
    probability =
      oppositeRate;
  }

  return {
    probability:
      clamp(
        probability,
        0.05,
        0.95
      ),

    support
  };
}

/* =========================================================
   RANDOMNESS
   ========================================================= */

function entropy(
  bits
) {
  if (!bits.length) {
    return 1;
  }

  const ones =
    bits.filter(
      x => x === 1
    ).length;

  const p =
    ones /
    bits.length;

  if (
    p <= 0 ||
    p >= 1
  ) {
    return 0;
  }

  return -(
    p * Math.log2(p) +
    (1 - p) *
      Math.log2(1 - p)
  );
}

function randomnessScore(
  bits
) {
  if (
    bits.length < 4
  ) {
    return 1;
  }

  let switches = 0;

  for (
    let i = 1;
    i < bits.length;
    i++
  ) {
    if (
      bits[i] !==
      bits[i - 1]
    ) {
      switches++;
    }
  }

  const switchRate =
    switches /
    (bits.length - 1);

  const balance =
    entropy(bits);

  const switchEntropy =
    1 -
    Math.abs(
      switchRate -
      0.5
    ) *
      2;

  return clamp(
    (
      balance +
      switchEntropy
    ) / 2,
    0,
    1
  );
}

/* =========================================================
   AI ENGINE
   ========================================================= */

function analyzeAI(
  history
) {
  const features =
    buildFeatures(
      history
    );

  if (
    features.numbers.length <
    MIN_HISTORY
  ) {
    return {
      prediction: "WAIT",
      confidence: 0,
      quality: "LOW",
      evidence: "INSUFFICIENT",
      mlProbability: 0.5,
      markovProbability: 0.5,
      patternProbability: 0.5,
      longPatternProbability: 0.5,
      streakProbability: 0.5,
      agreement: 0,
      randomness: 1,
      validationAccuracy: 0.5,
      validationEdge: 0,
      trainingSamples: 0,
      patternMatches: 0,
      longPatternMatches: 0,
      modelVersion:
        MODEL_VERSION
    };
  }

  const samples =
    createTrainingSet(
      history
    );

  const model =
    trainModel(
      samples
    );

  const validation =
    walkForward(
      history
    );

  const mlProbability =
    model
      ? sigmoid(
          dot(
            model.weights,
            features.vector
          ) +
            model.bias
        )
      : 0.5;

  const markov =
    markovModel(
      features.bits
    );

  const pattern =
    patternModel(
      features.bits
    );

  const longPattern =
    longPatternModel(
      features.bits
    );

  const streak =
    streakModel(
      features
    );

  const randomness =
    randomnessScore(
      features.bits.slice(-30)
    );

  /*
   * Adaptive model weights.
   */

  let wML = 1;

  let wMarkov = 0.85;

  let wPattern = 0.8;

  let wLongPattern = 0.65;

  let wStreak = 0.65;

  if (
    validation.edge > 0
  ) {
    wML +=
      validation.edge * 5;
  }

  if (
    markov.support >= 5
  ) {
    wMarkov *= 1.15;
  }

  if (
    pattern.matches >= 2
  ) {
    wPattern *= 1.20;
  }

  if (
    longPattern.matches >= 2
  ) {
    wLongPattern *= 1.25;
  }

  if (
    streak.support >= 2
  ) {
    wStreak *= 1.15;
  }

  if (
    randomness > 0.92
  ) {
    wPattern *= 0.55;
    wLongPattern *= 0.45;
    wStreak *= 0.75;
  }

  const total =
    wML +
    wMarkov +
    wPattern +
    wLongPattern +
    wStreak;

  const probability =
    (
      mlProbability *
        wML +

      markov.probability *
        wMarkov +

      pattern.probability *
        wPattern +

      longPattern.probability *
        wLongPattern +

      streak.probability *
        wStreak
    ) /
    total;

  const prediction =
    probability >= 0.5
      ? "BIG"
      : "SMALL";

  const distance =
    Math.abs(
      probability - 0.5
    );

  let confidence =
    51 +
    distance * 100;

  if (
    validation.edge > 0
  ) {
    confidence +=
      validation.edge * 20;
  }

  if (
    randomness > 0.95
  ) {
    confidence -= 5;
  }

  confidence =
    Math.round(
      clamp(
        confidence,
        51,
        91
      )
    );

  const modelBits = [
    mlProbability >= 0.5
      ? 1
      : 0,

    markov.probability >= 0.5
      ? 1
      : 0,

    pattern.probability >= 0.5
      ? 1
      : 0,

    longPattern.probability >= 0.5
      ? 1
      : 0,

    streak.probability >= 0.5
      ? 1
      : 0
  ];

  const finalBit =
    probability >= 0.5
      ? 1
      : 0;

  const agreement =
    modelBits.filter(
      x =>
        x === finalBit
    ).length /
    modelBits.length;

  let quality = "LOW";

  if (
    confidence >= 68 &&
    agreement >= 0.6
  ) {
    quality = "MEDIUM";
  }

  if (
    confidence >= 78 &&
    agreement >= 0.8 &&
    randomness < 0.95 &&
    validation.edge >= 0
  ) {
    quality = "HIGH";
  }

  let evidence = "WEAK";

  if (
    agreement >= 0.6 &&
    samples.length >= 20
  ) {
    evidence =
      "SUPPORTED";
  }

  return {
    prediction,

    confidence,

    quality,

    evidence,

    mlProbability,

    markovProbability:
      markov.probability,

    patternProbability:
      pattern.probability,

    longPatternProbability:
      longPattern.probability,

    streakProbability:
      streak.probability,

    agreement,

    randomness,

    validationAccuracy:
      validation.accuracy,

    validationBaseline:
      validation.baseline,

    validationEdge:
      validation.edge,

    trainingSamples:
      samples.length,

    patternMatches:
      pattern.matches,

    longPatternMatches:
      longPattern.matches,

    streakSupport:
      streak.support,

    markovSupport:
      markov.support,

    weights: {
      ml: wML,
      markov: wMarkov,
      pattern: wPattern,
      longPattern:
        wLongPattern,
      streak: wStreak
    },

    modelVersion:
      MODEL_VERSION
  };
}

/* =========================================================
   PREDICTION STORAGE
   ========================================================= */

async function getLastPrediction() {
  if (
    dbReady &&
    pool
  ) {
    const result =
      await pool.query(`
        SELECT *
        FROM prediction_records
        ORDER BY id DESC
        LIMIT 1
      `);

    return (
      result.rows[0] ||
      null
    );
  }

  return (
    memory.predictions[
      memory.predictions.length - 1
    ] ||
    null
  );
}

async function getPredictionForIssue(
  issue
) {
  if (!issue) {
    return null;
  }

  if (
    dbReady &&
    pool
  ) {
    const result =
      await pool.query(
        `
        SELECT *
        FROM prediction_records
        WHERE target_issue = $1
        ORDER BY id DESC
        LIMIT 1
        `,
        [str(issue)]
      );

    return (
      result.rows[0] ||
      null
    );
  }

  return (
    memory.predictions
      .slice()
      .reverse()
      .find(
        item =>
          String(
            item.target_issue
          ) ===
          String(issue)
      ) ||
    null
  );
}

async function savePrediction(
  issue,
  ai
) {
  if (
    dbReady &&
    pool
  ) {
    const result =
      await pool.query(
        `
        INSERT INTO prediction_records
        (
          target_issue,
          prediction,
          confidence,
          model_version,
          actual_number,
          actual_result,
          created_at,
          settled_at
        )
        VALUES
        ($1,$2,$3,$4,NULL,NULL,$5,NULL)
        RETURNING *
        `,
        [
          str(issue),
          ai.prediction,
          Number(
            ai.confidence
          ),
          MODEL_VERSION,
          now()
        ]
      );

    return result.rows[0];
  }

  const item = {
    id:
      memory.predictions.length +
      1,

    target_issue:
      str(issue),

    prediction:
      ai.prediction,

    confidence:
      Number(
        ai.confidence
      ),

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
    item
  );

  return item;
}

/* =========================================================
   SETTLEMENT
   ========================================================= */

async function settlePredictions(
  history
) {
  if (!history.length) {
    return;
  }

  const resultMap =
    new Map();

  for (
    const item of history
  ) {
    if (
      item.issue &&
      Number.isInteger(
        item.number
      )
    ) {
      resultMap.set(
        str(item.issue),
        item.number
      );
    }
  }

  if (
    dbReady &&
    pool
  ) {
    const result =
      await pool.query(`
        SELECT *
        FROM prediction_records
        WHERE actual_number IS NULL
        ORDER BY id ASC
        LIMIT 200
      `);

    for (
      const prediction of result.rows
    ) {
      const number =
        resultMap.get(
          str(
            prediction.target_issue
          )
        );

      if (
        number === undefined
      ) {
        continue;
      }

      await pool.query(
        `
        UPDATE prediction_records
        SET
          actual_number = $1,
          actual_result = $2,
          settled_at = $3
        WHERE id = $4
        `,
        [
          number,
          resultFromNumber(
            number
          ),
          now(),
          prediction.id
        ]
      );
    }

    return;
  }

  for (
    const prediction of
      memory.predictions
  ) {
    if (
      prediction.actual_number !==
      null
    ) {
      continue;
    }

    const number =
      resultMap.get(
        str(
          prediction.target_issue
        )
      );

    if (
      number === undefined
    ) {
      continue;
    }

    prediction.actual_number =
      number;

    prediction.actual_result =
      resultFromNumber(
        number
      );

    prediction.settled_at =
      now();
  }
}

/* =========================================================
   CYCLE
   ========================================================= */

async function getCycle(
  currentIssue
) {
  const last =
    await getLastPrediction();

  if (!last) {
    return {
      mode: "PREDICT",
      skipRound: 0,
      skipRemaining: 0,
      skipTotal:
        SKIP_ROUNDS
    };
  }

  const difference =
    issueDiff(
      currentIssue,
      last.target_issue
    );

  if (
    difference === null
  ) {
    return {
      mode: "PREDICT",
      skipRound: 0,
      skipRemaining: 0,
      skipTotal:
        SKIP_ROUNDS
    };
  }

  if (
    difference <= 0
  ) {
    return {
      mode: "PREDICTED",
      skipRound: 0,
      skipRemaining: 0,
      skipTotal:
        SKIP_ROUNDS
    };
  }

  if (
    difference >= 1 &&
    difference <= SKIP_ROUNDS
  ) {
    return {
      mode: "SKIP",

      skipRound:
        difference,

      skipRemaining:
        SKIP_ROUNDS -
        difference +
        1,

      skipTotal:
        SKIP_ROUNDS
    };
  }

  return {
    mode: "PREDICT",

    skipRound: 0,

    skipRemaining: 0,

    skipTotal:
      SKIP_ROUNDS
  };
}

/* =========================================================
   ANALYSIS CONTROL
   ========================================================= */

function resetAnalysis() {
  analysis.active =
    false;

  analysis.issue =
    null;

  analysis.startedAt =
    0;

  analysis.completed =
    false;
}

function startAnalysis(
  issue
) {
  if (!issue) {
    return;
  }

  analysis.active =
    true;

  analysis.issue =
    str(issue);

  analysis.startedAt =
    now();

  analysis.completed =
    false;

  console.log(
    "[AI] ANALYSIS START:",
    issue
  );
}

/* =========================================================
   ENGINE
   ========================================================= */

async function engineTick() {
  try {
    const issue =
      live.currentIssue;

    if (!issue) {
      return;
    }

    const already =
      await getPredictionForIssue(
        issue
      );

    if (already) {
      resetAnalysis();
      return;
    }

    const cycle =
      await getCycle(
        issue
      );

    /*
     * SKIP = NO ANALYSIS
     */

    if (
      cycle.mode === "SKIP"
    ) {
      resetAnalysis();
      return;
    }

    if (
      cycle.mode !== "PREDICT"
    ) {
      return;
    }

    /*
     * START IMMEDIATELY
     */

    if (
      !analysis.active ||
      analysis.issue !==
        str(issue)
    ) {
      resetAnalysis();

      startAnalysis(
        issue
      );

      return;
    }

    const elapsed =
      now() -
      analysis.startedAt;

    /*
     * WAIT FOR 4 SECONDS
     */

    if (
      elapsed <
      ANALYSIS_TIME
    ) {
      return;
    }

    if (
      analysis.completed
    ) {
      return;
    }

    analysis.completed =
      true;

    const ai =
      analyzeAI(
        live.history
      );

    if (
      ai.prediction !==
        "BIG" &&
      ai.prediction !==
        "SMALL"
    ) {
      resetAnalysis();
      return;
    }

    const check =
      await getPredictionForIssue(
        issue
      );

    if (check) {
      resetAnalysis();
      return;
    }

    await savePrediction(
      issue,
      ai
    );

    console.log(
      "[AI] PREDICTION:",
      issue,
      ai.prediction,
      "CONF:",
      ai.confidence
    );

    resetAnalysis();

    await settlePredictions(
      live.history
    );
  } catch (error) {
    console.error(
      "ENGINE ERROR:",
      error.message
    );
  }
}

/* =========================================================
   LIVE REFRESH
   ========================================================= */

async function refreshLive() {
  try {
    const previous =
      live.currentIssue;

    const result =
      await fetchWingo();

    const current =
      result.currentIssue;

    if (
      previous &&
      current &&
      String(previous) !==
        String(current)
    ) {
      live.previousIssue =
        previous;

      console.log(
        "[LIVE] NEW ISSUE:",
        current
      );

      /*
       * New round.
       *
       * Engine will immediately
       * decide PREDICT or SKIP.
       */

      resetAnalysis();
    }

    await settlePredictions(
      live.history
    );
  } catch (error) {
    live.online =
      false;

    live.lastError =
      error.message;

    console.error(
      "LIVE ERROR:",
      error.message
    );
  }
}

/* =========================================================
   STATE
   ========================================================= */

async function buildState() {
  const issue =
    live.currentIssue;

  let cycle = {
    mode: "WAIT",
    skipRound: 0,
    skipRemaining: 0,
    skipTotal:
      SKIP_ROUNDS
  };

  let prediction = null;

  if (issue) {
    prediction =
      await getPredictionForIssue(
        issue
      );

    if (prediction) {
      cycle = {
        mode: "PREDICTED",
        skipRound: 0,
        skipRemaining: 0,
        skipTotal:
          SKIP_ROUNDS
      };
    } else {
      cycle =
        await getCycle(
          issue
        );
    }
  }

  let remaining =
    ANALYSIS_TIME;

  let elapsed = 0;

  if (
    analysis.active
  ) {
    elapsed =
      now() -
      analysis.startedAt;

    remaining =
      Math.max(
        0,
        ANALYSIS_TIME -
          elapsed
      );
  }

  const recentResults =
    live.history
      .slice()
      .reverse()
      .slice(0, 10)
      .map(
        item => ({
          issue:
            item.issue,

          number:
            item.number,

          result:
            item.result
        })
      );

  return {
    ok: true,

    online:
      live.online,

    source:
      live.source,

    currentPeriod:
      issue,

    latestNumber:
      live.latestNumber,

    latestResult:
      live.latestResult,

    lastFetchAt:
      live.lastFetchAt,

    lastError:
      live.lastError,

    prediction:
      prediction
        ? {
            issue:
              prediction.target_issue,

            result:
              prediction.prediction,

            confidence:
              Number(
                prediction.confidence
              ),

            modelVersion:
              prediction.model_version
          }
        : null,

    cycle,

    analysisSession: {
      active:
        analysis.active,

      issue:
        analysis.issue,

      elapsed:
        Math.min(
          elapsed,
          ANALYSIS_TIME
        ),

      remaining,

      total:
        ANALYSIS_TIME
    },

    recentResults
  };
}

/* =========================================================
   ADMIN STATUS
   ========================================================= */

async function predictionStats() {
  let rows = [];

  if (
    dbReady &&
    pool
  ) {
    const result =
      await pool.query(`
        SELECT *
        FROM prediction_records
        ORDER BY id DESC
        LIMIT 200
      `);

    rows =
      result.rows;
  } else {
    rows =
      memory.predictions
        .slice()
        .reverse()
        .slice(0, 200);
  }

  let settled = 0;
  let wins = 0;
  let losses = 0;

  for (
    const row of rows
  ) {
    if (
      !row.actual_result
    ) {
      continue;
    }

    settled++;

    if (
      row.prediction ===
      row.actual_result
    ) {
      wins++;
    } else {
      losses++;
    }
  }

  return {
    total:
      rows.length,

    settled,

    wins,

    losses,

    accuracy:
      settled
        ? wins / settled
        : 0,

    rows
  };
}

async function adminStatus() {
  const keys =
    await listKeys();

  const stats =
    await predictionStats();

  const onlineKeys =
    keys.filter(
      key =>
        key.last_seen &&
        now() -
          Number(
            key.last_seen
          ) <
          120000
    ).length;

  return {
    ok: true,

    server: {
      model:
        MODEL_VERSION,

      node:
        process.version,

      analysisSeconds:
        ANALYSIS_TIME /
        1000,

      skipRounds:
        SKIP_ROUNDS,

      pollSeconds:
        POLL_TIME /
        1000,

      database:
        dbReady
          ? "POSTGRESQL"
          : "MEMORY"
    },

    live: {
      online:
        live.online,

      currentIssue:
        live.currentIssue,

      latestNumber:
        live.latestNumber,

      latestResult:
        live.latestResult,

      historySize:
        live.history.length,

      lastError:
        live.lastError
    },

    analysis: {
      active:
        analysis.active,

      issue:
        analysis.issue,

      elapsed:
        analysis.active
          ? now() -
            analysis.startedAt
          : 0
    },

    keys: {
      total:
        keys.length,

      online:
        onlineKeys,

      rows:
        keys
    },

    predictions:
      stats
  };
}

/* =========================================================
   HTTP
   ========================================================= */

function sendJSON(
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
        "Content-Type, X-Access-Key, X-Device-ID, X-Admin-Key",

      "Access-Control-Allow-Methods":
        "GET, POST, OPTIONS"
    }
  );

  res.end(body);
}

function sendFile(
  res,
  filename,
  contentType
) {
  const file =
    path.join(
      __dirname,
      filename
    );

  if (
    !fs.existsSync(file)
  ) {
    sendJSON(
      res,
      404,
      {
        ok: false,
        message:
          filename +
          " not found"
      }
    );

    return;
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

function readBody(req) {
  return new Promise(
    function (
      resolve,
      reject
    ) {
      let data = "";

      req.on(
        "data",
        chunk => {
          data +=
            chunk.toString();

          if (
            data.length >
            1024 * 1024
          ) {
            reject(
              new Error(
                "BODY TOO LARGE"
              )
            );

            req.destroy();
          }
        }
      );

      req.on(
        "end",
        () => {
          if (!data) {
            resolve({});
            return;
          }

          try {
            resolve(
              JSON.parse(data)
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

/* =========================================================
   ROUTER
   ========================================================= */

async function router(
  req,
  res
) {
  const url =
    new URL(
      req.url,
      "http://" +
        (
          req.headers.host ||
          "localhost"
        )
    );

  const route =
    url.pathname;

  if (
    req.method ===
    "OPTIONS"
  ) {
    sendJSON(
      res,
      204,
      {}
    );

    return;
  }

  /* HOME */

  if (
    req.method === "GET" &&
    route === "/"
  ) {
    sendFile(
      res,
      "prediction.html",
      "text/html; charset=utf-8"
    );

    return;
  }

  /* PREDICTION PAGE */

  if (
    req.method === "GET" &&
    route ===
      "/prediction.html"
  ) {
    sendFile(
      res,
      "prediction.html",
      "text/html; charset=utf-8"
    );

    return;
  }

  /* ADMIN PAGE */

  if (
    req.method === "GET" &&
    route ===
      "/admin.html"
  ) {
    sendFile(
      res,
      "admin.html",
      "text/html; charset=utf-8"
    );

    return;
  }

  /* HEALTH */

  if (
    req.method === "GET" &&
    route === "/health"
  ) {
    sendJSON(
      res,
      200,
      {
        ok: true,
        service:
          "DY AI Wingo",
        model:
          MODEL_VERSION,
        online:
          live.online,
        currentIssue:
          live.currentIssue
      }
    );

    return;
  }

  /* KEY CHECK */

  if (
    req.method === "POST" &&
    route ===
      "/api/key/check"
  ) {
    try {
      const body =
        await readBody(req);

      const result =
        await userAuth(
          req,
          body
        );

      sendJSON(
        res,
        result.ok
          ? 200
          : 403,
        result
      );
    } catch (error) {
      sendJSON(
        res,
        500,
        {
          ok: false,
          message:
            error.message
        }
      );
    }

    return;
  }

  /* STATE */

  if (
    req.method === "GET" &&
    route ===
      "/api/state"
  ) {
    try {
      const state =
        await buildState();

      sendJSON(
        res,
        200,
        state
      );
    } catch (error) {
      sendJSON(
        res,
        500,
        {
          ok: false,
          message:
            error.message
        }
      );
    }

    return;
  }

  /* =======================================================
     ADMIN AUTH HELPER
     ======================================================= */

  const isAdminRoute =
    route.startsWith(
      "/api/admin/"
    );

  if (isAdminRoute) {
    let body = {};

    if (
      req.method === "POST"
    ) {
      body =
        await readBody(req);
    }

    if (
      !adminAuth(
        req,
        body
      )
    ) {
      sendJSON(
        res,
        403,
        {
          ok: false,
          message:
            "ADMIN AUTH FAILED"
        }
      );

      return;
    }

    /* ADMIN STATUS */

    if (
      route ===
        "/api/admin/status" &&
      req.method === "GET"
    ) {
      sendJSON(
        res,
        200,
        await adminStatus()
      );

      return;
    }

    /* ADMIN KEYS GET */

    if (
      route ===
        "/api/admin/keys" &&
      req.method === "GET"
    ) {
      sendJSON(
        res,
        200,
        {
          ok: true,
          keys:
            await listKeys()
        }
      );

      return;
    }

    /* ADMIN CREATE KEY */

    if (
      route ===
        "/api/admin/keys" &&
      req.method === "POST"
    ) {
      try {
        const key =
          str(
            body.accessKey
          );

        const created =
          await createKey(
            key
          );

        sendJSON(
          res,
          200,
          {
            ok: true,
            key: created
          }
        );
      } catch (error) {
        sendJSON(
          res,
          400,
          {
            ok: false,
            message:
              error.message
          }
        );
      }

      return;
    }

    /* RESET DEVICE */

    if (
      route ===
        "/api/admin/reset-device" &&
      req.method === "POST"
    ) {
      const result =
        await resetKeyDevice(
          body.accessKey
        );

      sendJSON(
        res,
        result
          ? 200
          : 404,
        result
          ? {
              ok: true,
              key: result
            }
          : {
              ok: false,
              message:
                "KEY NOT FOUND"
            }
      );

      return;
    }

    /* DELETE KEY */

    if (
      route ===
        "/api/admin/delete-key" &&
      req.method === "POST"
    ) {
      const result =
        await removeKey(
          body.accessKey
        );

      sendJSON(
        res,
        result
          ? 200
          : 404,
        result
          ? {
              ok: true,
              deleted:
                result
            }
          : {
              ok: false,
              message:
                "KEY NOT FOUND"
            }
      );

      return;
    }

    /* LIVE TEST */

    if (
      route ===
        "/api/admin/live-test" &&
      req.method === "GET"
    ) {
      try {
        const result =
          await fetchWingo();

        const ai =
          analyzeAI(
            result.history
          );

        sendJSON(
          res,
          200,
          {
            ok: true,

            source:
              "WingoBot",

            currentIssue:
              result.currentIssue,

            latest:
              result.latest,

            historySize:
              result.history.length,

            ai
          }
        );
      } catch (error) {
        sendJSON(
          res,
          500,
          {
            ok: false,
            message:
              error.message
          }
        );
      }

      return;
    }

    /* MODEL TEST */

    if (
      route ===
        "/api/admin/model-test" &&
      req.method === "GET"
    ) {
      if (
        !live.history.length
      ) {
        sendJSON(
          res,
          200,
          {
            ok: false,
            message:
              "NO LIVE HISTORY"
          }
        );

        return;
      }

      sendJSON(
        res,
        200,
        {
          ok: true,

          model:
            MODEL_VERSION,

          currentIssue:
            live.currentIssue,

          result:
            analyzeAI(
              live.history
            )
        }
      );

      return;
    }

    /* PREDICTION HISTORY */

    if (
      route ===
        "/api/admin/predictions" &&
      req.method === "GET"
    ) {
      sendJSON(
        res,
        200,
        await predictionStats()
      );

      return;
    }

    /* PING */

    if (
      route ===
        "/api/admin/ping" &&
      req.method === "GET"
    ) {
      sendJSON(
        res,
        200,
        {
          ok: true,
          pong: true,
          time: now()
        }
      );

      return;
    }

    sendJSON(
      res,
      404,
      {
        ok: false,
        message:
          "ADMIN ROUTE NOT FOUND"
      }
    );

    return;
  }

  /* 404 */

  sendJSON(
    res,
    404,
    {
      ok: false,
      message:
        "ROUTE NOT FOUND"
    }
  );
}

/* =========================================================
   SERVER
   ========================================================= */

const server =
  http.createServer(
    async function (
      req,
      res
    ) {
      try {
        await router(
          req,
          res
        );
      } catch (error) {
        console.error(
          "SERVER ERROR:",
          error
        );

        if (
          !res.headersSent
        ) {
          sendJSON(
            res,
            500,
            {
              ok: false,
              message:
                "INTERNAL SERVER ERROR"
            }
          );
        }
      }
    }
  );

/* =========================================================
   START
   ========================================================= */

async function start() {
  try {
    await initDB();

    server.listen(
      PORT,
      "0.0.0.0",
      function () {
        console.log(
          "================================"
        );

        console.log(
          "DY AI WINGO STARTED"
        );

        console.log(
          "PORT:",
          PORT
        );

        console.log(
          "NODE:",
          process.version
        );

        console.log(
          "MODEL:",
          MODEL_VERSION
        );

        console.log(
          "ANALYSIS:",
          ANALYSIS_TIME /
            1000,
          "SECONDS"
        );

        console.log(
          "SKIP:",
          SKIP_ROUNDS,
          "ROUNDS"
        );

        console.log(
          "POLL:",
          POLL_TIME /
            1000,
          "SECOND"
        );

        console.log(
          "DATABASE:",
          dbReady
            ? "POSTGRESQL"
            : "MEMORY"
        );

        console.log(
          "================================"
        );
      }
    );

    /*
     * First live API request.
     */

    await refreshLive();

    /*
     * Every 1 second:
     * WingoBot live update.
     */

    setInterval(
      refreshLive,
      POLL_TIME
    );

    /*
     * Every 250ms:
     * prediction engine.
     */

    setInterval(
      engineTick,
      ENGINE_TIME
    );

    /*
     * Initial engine check.
     */

    await engineTick();
  } catch (error) {
    console.error(
      "STARTUP ERROR:",
      error
    );

    process.exit(1);
  }
}

start();

/* =========================================================
   SHUTDOWN
   ========================================================= */

async function shutdown(
  signal
) {
  console.log(
    signal +
      " RECEIVED"
  );

  try {
    if (pool) {
      await pool.end();
    }
  } catch (error) {
    console.error(
      "DB CLOSE ERROR:",
      error.message
    );
  }

  server.close(
    function () {
      process.exit(0);
    }
  );

  setTimeout(
    function () {
      process.exit(0);
    },
    3000
  );
}

process.on(
  "SIGTERM",
  function () {
    shutdown("SIGTERM");
  }
);

process.on(
  "SIGINT",
  function () {
    shutdown("SIGINT");
  }
);
