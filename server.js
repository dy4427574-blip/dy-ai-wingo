"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

/* =========================================================
   DY AI WINGO — V6
   FULL SERVER
   ========================================================= */

const PORT = Number(process.env.PORT || 10000);

const ADMIN_KEY =
  process.env.ADMIN_KEY || "dy4427574";

const WINGOBOT_TOKEN =
  process.env.WINGOBOT_TOKEN || "";

const WINGOBOT_URL =
  "https://api.wingobot.com/v2/30-sec-game-history";

const GAME_URL =
  "https://www.shreewin38.com/#/register?invitationCode=88523152383";

const MODEL_VERSION =
  "DY-AI-BS-V6";

const ROOT =
  __dirname;

let pool = null;

if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString:
      process.env.DATABASE_URL,

    ssl:
      process.env.DATABASE_URL.includes("localhost")
        ? false
        : { rejectUnauthorized: false },

    max: 5,

    idleTimeoutMillis:
      30000,

    connectionTimeoutMillis:
      10000
  });
}


/* =========================================================
   PROVIDER CACHE
========================================================= */

let providerCache = {
  history: [],
  currentIssue: "",
  lastUpdated: 0,
  fetched: 0,
  fetchedAt: 0,
  error: null
};

let lastProviderFetch = 0;


/* =========================================================
   BASIC
========================================================= */

function now() {
  return Date.now();
}


function clamp(v, min, max) {
  return Math.max(
    min,
    Math.min(max, v)
  );
}


function json(res, status, data) {

  const body =
    JSON.stringify(data);

  res.writeHead(status, {
    "Content-Type":
      "application/json; charset=utf-8",

    "Cache-Control":
      "no-store",

    "Access-Control-Allow-Origin":
      "*",

    "Access-Control-Allow-Headers":
      "Content-Type, x-access-key, x-device-id, x-admin-key",

    "Access-Control-Allow-Methods":
      "GET,POST,DELETE,OPTIONS"
  });

  res.end(body);
}


function text(
  res,
  status,
  body,
  type = "text/plain"
) {

  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store"
  });

  res.end(body);
}


function parseBody(req) {

  return new Promise(resolve => {

    let raw = "";

    req.on("data", chunk => {

      raw += chunk.toString();

      if (raw.length > 1024 * 1024) {
        req.destroy();
      }

    });

    req.on("end", () => {

      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }

    });

    req.on("error", () => {
      resolve({});
    });

  });

}


function header(req, name) {

  const value =
    req.headers[name.toLowerCase()];

  if (Array.isArray(value)) {
    return value[0];
  }

  return value || "";
}


function safeEqual(a, b) {

  if (
    typeof a !== "string" ||
    typeof b !== "string"
  ) {
    return false;
  }

  const aa =
    Buffer.from(a);

  const bb =
    Buffer.from(b);

  if (aa.length !== bb.length) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(
      aa,
      bb
    );
  } catch {
    return false;
  }

}


function adminAuthorized(req) {

  return safeEqual(
    header(req, "x-admin-key"),
    ADMIN_KEY
  );

}


function accessKey(req, body = {}) {

  return String(
    header(req, "x-access-key") ||
    body.access_key ||
    body.key ||
    ""
  ).trim();

}


function deviceId(req, body = {}) {

  return String(
    header(req, "x-device-id") ||
    body.device_id ||
    ""
  ).trim();

}


/* =========================================================
   ISSUE
========================================================= */

function compareIssue(a, b) {

  const aa = String(a);
  const bb = String(b);

  if (
    /^\d+$/.test(aa) &&
    /^\d+$/.test(bb)
  ) {

    const A = BigInt(aa);
    const B = BigInt(bb);

    if (A > B) return 1;
    if (A < B) return -1;

    return 0;
  }

  return aa.localeCompare(bb);
}


function incrementIssue(issue) {

  const s =
    String(issue || "").trim();

  if (!/^\d+$/.test(s)) {
    return "";
  }

  try {
    return (
      BigInt(s) + 1n
    ).toString();
  } catch {
    return "";
  }

}


/* =========================================================
   DATABASE
========================================================= */

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

  const columns = [
    ["confidence", "INTEGER DEFAULT 0"],
    ["model_version", "TEXT"],
    ["actual_number", "INTEGER"],
    ["actual_result", "TEXT"],
    ["settled_at", "BIGINT"]
  ];

  for (const [name, type] of columns) {

    try {

      await pool.query(
        `ALTER TABLE prediction_records
         ADD COLUMN IF NOT EXISTS ${name} ${type}`
      );

    } catch {}

  }

  await pool.query(`
    UPDATE prediction_records
    SET model_version = 'LEGACY'
    WHERE model_version IS NULL
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS
    prediction_records_model_issue_idx
    ON prediction_records(model_version,target_issue)
  `);

}


/* =========================================================
   NORMALIZE
========================================================= */

function normalizeSide(value) {

  if (
    value === undefined ||
    value === null
  ) {
    return "";
  }

  const s =
    String(value)
      .trim()
      .toUpperCase();

  if (
    s === "BIG" ||
    s === "B"
  ) {
    return "BIG";
  }

  if (
    s === "SMALL" ||
    s === "S"
  ) {
    return "SMALL";
  }

  return "";
}


function normalizeHistoryRow(row) {

  if (!row) {
    return null;
  }

  const issue =
    row.issueNumber ??
    row.issue_number ??
    row.period ??
    row.issue;

  if (
    issue === undefined ||
    issue === null
  ) {
    return null;
  }

  const issueNumber =
    String(issue).trim();

  if (!issueNumber) {
    return null;
  }

  let number = null;

  if (
    row.number !== undefined &&
    row.number !== null &&
    row.number !== ""
  ) {

    const n =
      Number(row.number);

    if (
      Number.isInteger(n) &&
      n >= 0 &&
      n <= 9
    ) {
      number = n;
    }

  }

  let result =
    normalizeSide(
      row.result ||
      row.bigSmall ||
      row.big_small ||
      row.size ||
      row.colour ||
      row.color
    );

  /*
    Number is ONLY used to determine
    the provider's actual side.

    It is NOT predicted.
  */

  if (
    !result &&
    number !== null
  ) {

    result =
      number >= 5
        ? "BIG"
        : "SMALL";

  }

  return {
    issueNumber,
    number,
    result,

    colour:
      row.colour ||
      row.color ||
      "",

    premium:
      row.premium ??
      null,

    sum:
      row.sum ??
      null
  };

}


/* =========================================================
   WINGOBOT FETCH
========================================================= */

async function fetchWingoHistory(
  force = false
) {

  if (
    !force &&
    providerCache.history.length &&
    now() - lastProviderFetch < 2500
  ) {
    return providerCache;
  }

  if (!WINGOBOT_TOKEN) {

    providerCache.error =
      "WINGOBOT_TOKEN is missing";

    return providerCache;
  }

  lastProviderFetch =
    now();

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
            AbortSignal.timeout(12000)
        }
      );

    if (!response.ok) {

      throw new Error(
        `WingoBot HTTP ${response.status}`
      );

    }

    const data =
      await response.json();

    const raw =
      Array.isArray(data.history)
        ? data.history
        : [];

    const history =
      raw
        .map(normalizeHistoryRow)
        .filter(Boolean)
        .sort(
          (a, b) =>
            compareIssue(
              b.issueNumber,
              a.issueNumber
            )
        );

    const currentIssue =
      data.current &&
      data.current.issueNumber
        ? String(
            data.current.issueNumber
          )
        : "";

    const stats =
      data.stats || {};

    const lastUpdated =
      Number(
        stats.last_updated ||
        data.last_updated ||
        data.lastUpdated ||
        now()
      );

    providerCache = {

      history,

      currentIssue,

      lastUpdated,

      fetched:
        Number(
          stats.fetched ||
          history.length
        ),

      fetchedAt:
        now(),

      error:
        null
    };

    return providerCache;

  } catch (error) {

    providerCache.error =
      error.message ||
      "Provider fetch failed";

    return providerCache;

  }

}


/* =========================================================
   TARGET
========================================================= */

function resolveTarget(
  history,
  currentIssue
) {

  if (
    !Array.isArray(history) ||
    !history.length
  ) {

    return currentIssue
      ? String(currentIssue)
      : "";

  }

  const latestSettled =
    history.find(
      row =>
        row &&
        (
          row.result === "BIG" ||
          row.result === "SMALL"
        )
    );

  const latestIssue =
    latestSettled
      ? String(
          latestSettled.issueNumber
        )
      : String(
          history[0].issueNumber
        );

  const current =
    currentIssue
      ? String(currentIssue)
      : "";

  /*
    If provider current issue is ahead,
    it is the correct target.
  */

  if (
    current &&
    compareIssue(
      current,
      latestIssue
    ) > 0
  ) {
    return current;
  }

  return incrementIssue(
    latestIssue
  );

}


/* =========================================================
   SIDE DATA
========================================================= */

function getSides(history) {

  return history
    .map(
      row => row.result
    )
    .filter(
      side =>
        side === "BIG" ||
        side === "SMALL"
    );

}


function valueOf(side) {

  return side === "BIG"
    ? 1
    : -1;

}


/* =========================================================
   SIGNAL 1 — RECENT
========================================================= */

function recentSignal(
  arr,
  n = 5
) {

  const x =
    arr.slice(0, n);

  if (!x.length) {
    return 0;
  }

  let num = 0;
  let den = 0;

  for (
    let i = 0;
    i < x.length;
    i++
  ) {

    const w =
      x.length - i;

    num +=
      valueOf(x[i]) * w;

    den += w;
  }

  return den
    ? num / den
    : 0;

}


/* =========================================================
   SIGNAL 2 — WINDOW BALANCE
========================================================= */

function windowSignal(
  arr,
  n
) {

  const x =
    arr.slice(0, n);

  if (!x.length) {
    return 0;
  }

  let total = 0;

  for (const side of x) {
    total += valueOf(side);
  }

  return (
    total /
    x.length
  );

}


/* =========================================================
   SIGNAL 3 — TRANSITION
========================================================= */

function transitionStats(
  arr,
  n = 40
) {

  const x =
    arr.slice(
      0,
      Math.min(
        arr.length,
        n
      )
    );

  let BB = 0;
  let BS = 0;
  let SB = 0;
  let SS = 0;

  for (
    let i = 0;
    i < x.length - 1;
    i++
  ) {

    const current =
      x[i];

    const next =
      x[i + 1];

    /*
      x is newest -> oldest.

      For prediction after newest result,
      we need historical transition behaviour.
    */

    if (
      current === "BIG" &&
      next === "BIG"
    ) {
      BB++;
    }

    if (
      current === "BIG" &&
      next === "SMALL"
    ) {
      BS++;
    }

    if (
      current === "SMALL" &&
      next === "BIG"
    ) {
      SB++;
    }

    if (
      current === "SMALL" &&
      next === "SMALL"
    ) {
      SS++;
    }

  }

  const smooth =
    1;

  const pBB =
    (BB + smooth) /
    (
      BB +
      BS +
      smooth * 2
    );

  const pSB =
    (SB + smooth) /
    (
      SB +
      SS +
      smooth * 2
    );

  const last =
    x[0];

  const pBig =
    last === "BIG"
      ? pBB
      : pSB;

  return {
    BB,
    BS,
    SB,
    SS,
    signal:
      (pBig - 0.5) * 2
  };

}


/* =========================================================
   SIGNAL 4 — STREAK
========================================================= */

function streakInfo(arr) {

  if (!arr.length) {

    return {
      side: "",
      length: 0
    };

  }

  const side =
    arr[0];

  let length = 0;

  for (
    const x of arr
  ) {

    if (x !== side) {
      break;
    }

    length++;

  }

  return {
    side,
    length
  };

}


/* =========================================================
   SIGNAL 5 — STREAK BREAK
========================================================= */

function streakBreakSignal(
  arr
) {

  const streak =
    streakInfo(arr);

  if (
    streak.length < 3
  ) {
    return 0;
  }

  const strength =
    clamp(
      (
        streak.length - 2
      ) / 5,
      0,
      1
    );

  return (
    streak.side === "BIG"
      ? -strength
      : strength
  );

}


/* =========================================================
   SIGNAL 6 — ALTERNATION
========================================================= */

function alternationSignal(
  arr,
  n = 8
) {

  const x =
    arr.slice(0, n);

  if (x.length < 3) {
    return 0;
  }

  let changes = 0;

  for (
    let i = 0;
    i < x.length - 1;
    i++
  ) {

    if (
      x[i] !== x[i + 1]
    ) {
      changes++;
    }

  }

  const rate =
    changes /
    (x.length - 1);

  /*
    High alternation:
    latest result is less likely to
    simply repeat.
  */

  if (
    rate >= 0.70
  ) {

    return (
      x[0] === "BIG"
        ? -1
        : 1
    );

  }

  /*
    Low alternation:
    no automatic trend-following.
  */

  return 0;

}


/* =========================================================
   SIGNAL 7 — REVERSAL
========================================================= */

function reversalSignal(
  arr
) {

  if (arr.length < 5) {
    return 0;
  }

  const a = arr[0];
  const b = arr[1];
  const c = arr[2];
  const d = arr[3];
  const e = arr[4];

  /*
    Stronger reversal shape:
    
    B B S S S
    => pressure toward B

    S S B B B
    => pressure toward S
  */

  if (
    a === b &&
    c === d &&
    d === e &&
    a !== c
  ) {

    return (
      a === "BIG"
        ? -1
        : 1
    );

  }

  /*
    Two latest opposite from
    previous three.
  */

  if (
    a === b &&
    c === d &&
    a !== c
  ) {

    return (
      a === "BIG"
        ? -0.65
        : 0.65
    );

  }

  return 0;

}


/* =========================================================
   SIGNAL 8 — PATTERN
========================================================= */

function patternSignal(
  arr,
  len = 3
) {

  if (
    arr.length <
    len + 6
  ) {
    return 0;
  }

  const latestKey =
    arr
      .slice(0, len)
      .map(
        x =>
          x === "BIG"
            ? "B"
            : "S"
      )
      .join("");

  let matches = 0;
  let big = 0;
  let small = 0;

  /*
    Historical windows.
  */

  for (
    let i = len;
    i < arr.length;
    i++
  ) {

    const key =
      arr
        .slice(
          i - len,
          i
        )
        .map(
          x =>
            x === "BIG"
              ? "B"
              : "S"
        )
        .join("");

    if (
      key !== latestKey
    ) {
      continue;
    }

    /*
      Ignore immediate newest window
      when it would be leaking current
      prediction context.
    */

    matches++;

    if (
      arr[i] === "BIG"
    ) {
      big++;
    } else {
      small++;
    }

  }

  if (!matches) {
    return 0;
  }

  const raw =
    (
      big -
      small
    ) / matches;

  const reliability =
    clamp(
      matches / 10,
      0,
      1
    );

  return (
    raw *
    reliability
  );

}


/* =========================================================
   SIGNAL 9 — BALANCE
========================================================= */

function balanceSignal(
  arr,
  n = 60
) {

  const x =
    arr.slice(0, n);

  if (!x.length) {
    return 0;
  }

  let big = 0;

  for (
    const side of x
  ) {

    if (
      side === "BIG"
    ) {
      big++;
    }

  }

  const p =
    big / x.length;

  return (
    p - 0.5
  ) * 2;

}


/* =========================================================
   FEATURE BUILDER
========================================================= */

function featuresFor(
  arr
) {

  const transition =
    transitionStats(
      arr,
      40
    );

  const streak =
    streakInfo(arr);

  return {

    recent:
      recentSignal(
        arr,
        5
      ),

    micro:
      windowSignal(
        arr,
        3
      ),

    short:
      windowSignal(
        arr,
        7
      ),

    medium:
      windowSignal(
        arr,
        15
      ),

    long:
      windowSignal(
        arr,
        40
      ),

    transition:
      transition.signal,

    conditional:
      transition.signal,

    streakBreak:
      streakBreakSignal(
        arr
      ),

    alternation:
      alternationSignal(
        arr,
        8
      ),

    reversal:
      reversalSignal(
        arr
      ),

    pattern3:
      patternSignal(
        arr,
        3
      ),

    pattern4:
      patternSignal(
        arr,
        4
      ),

    balance:
      balanceSignal(
        arr,
        60
      ),

    streakSide:
      streak.side,

    streakLength:
      streak.length

  };

}


/* =========================================================
   RAW SCORE
========================================================= */

function rawScore(
  f,
  weights
) {

  let score = 0;

  score +=
    f.recent *
    weights.recent;

  score +=
    f.micro *
    weights.micro;

  score +=
    f.short *
    weights.short;

  score +=
    f.medium *
    weights.medium;

  score +=
    f.transition *
    weights.transition;

  score +=
    f.streakBreak *
    weights.streakBreak;

  score +=
    f.alternation *
    weights.alternation;

  score +=
    f.reversal *
    weights.reversal;

  score +=
    f.pattern3 *
    weights.pattern3;

  score +=
    f.pattern4 *
    weights.pattern4;

  /*
    Balance is a correction only.
  */

  score -=
    f.balance *
    weights.balance;

  return clamp(
    score,
    -1,
    1
  );

}


/* =========================================================
   DEFAULT WEIGHTS
========================================================= */

const DEFAULT_WEIGHTS = {

  recent:
    0.21,

  micro:
    0.08,

  short:
    0.10,

  medium:
    0.08,

  transition:
    0.15,

  streakBreak:
    0.12,

  alternation:
    0.09,

  reversal:
    0.08,

  pattern3:
    0.04,

  pattern4:
    0.02,

  balance:
    0.03

};


/* =========================================================
   WALK-FORWARD BACKTEST
========================================================= */

function evaluateWeights(
  arr,
  weights
) {

  /*
    IMPORTANT:

    For every historical target,
    only older results are used.

    No future-result leakage.
  */

  if (
    arr.length < 25
  ) {

    return {

      accuracy:
        0.5,

      coverage:
        0,

      wins: 0,

      losses: 0,

      predictions: 0

    };

  }

  let wins = 0;
  let losses = 0;

  /*
    Test from older history toward
    newer history.

    arr[0] is newest.
  */

  const start =
    Math.min(
      arr.length - 1,
      100
    );

  const end =
    8;

  for (
    let i = start;
    i >= end;
    i--
  ) {

    /*
      arr[i] is the actual result
      we are pretending to predict.

      Available history is strictly
      arr[i+1 ...].
    */

    const training =
      arr.slice(
        i + 1
      );

    if (
      training.length < 8
    ) {
      continue;
    }

    const f =
      featuresFor(
        training
      );

    const score =
      rawScore(
        f,
        weights
      );

    /*
      If neutral, use a deterministic
      tie-break based on transition,
      not hard-coded BIG.
    */

    let predicted;

    if (
      score > 0
    ) {

      predicted =
        "BIG";

    } else if (
      score < 0
    ) {

      predicted =
        "SMALL";

    } else {

      predicted =
        f.transition >= 0
          ? "BIG"
          : "SMALL";

    }

    const actual =
      arr[i];

    if (
      predicted === actual
    ) {

      wins++;

    } else {

      losses++;

    }

  }

  const total =
    wins + losses;

  return {

    accuracy:
      total
        ? wins / total
        : 0.5,

    coverage:
      total,

    wins,

    losses,

    predictions:
      total

  };

}


/* =========================================================
   ADAPTIVE WEIGHTS
========================================================= */

function adaptiveWeights(
  arr
) {

  const candidates = [];


  /*
    Candidate A:
    balanced default
  */

  candidates.push({
    name: "BALANCED",
    weights: {
      ...DEFAULT_WEIGHTS
    }
  });


  /*
    Candidate B:
    recent + transition
  */

  candidates.push({
    name: "TRANSITION",
    weights: {
      ...DEFAULT_WEIGHTS,

      recent:
        0.18,

      transition:
        0.21,

      streakBreak:
        0.15,

      alternation:
        0.11
    }
  });


  /*
    Candidate C:
    reversal focused
  */

  candidates.push({
    name: "REVERSAL",
    weights: {
      ...DEFAULT_WEIGHTS,

      recent:
        0.16,

      transition:
        0.14,

      streakBreak:
        0.18,

      reversal:
        0.15,

      alternation:
        0.11
    }
  });


  /*
    Candidate D:
    recent balanced
  */

  candidates.push({
    name: "RECENT",
    weights: {
      ...DEFAULT_WEIGHTS,

      recent:
        0.26,

      micro:
        0.10,

      short:
        0.13,

      medium:
        0.07,

      transition:
        0.13,

      streakBreak:
        0.11
    }
  });


  let best =
    candidates[0];

  let bestScore =
    -Infinity;


  for (
    const candidate
    of candidates
  ) {

    const result =
      evaluateWeights(
        arr,
        candidate.weights
      );


    /*
      Accuracy is not enough.

      Penalize very low sample count.
      Penalize extreme one-sided behaviour.
    */

    let score =
      result.accuracy;


    if (
      result.predictions < 20
    ) {

      score -=
        0.03;

    }


    /*
      Don't select a candidate solely
      because it accidentally predicts
      one side more often.
    */

    const bias =
      Math.abs(
        (
          result.wins -
          result.losses
        ) /
        Math.max(
          result.predictions,
          1
        )
      );


    if (
      bias > 0.65
    ) {

      score -=
        0.04;

    }


    if (
      score > bestScore
    ) {

      bestScore =
        score;

      best =
        candidate;

    }

  }


  const test =
    evaluateWeights(
      arr,
      best.weights
    );


  return {

    name:
      best.name,

    weights:
      best.weights,

    backtest:
      test

  };

}


/* =========================================================
   V6 MODEL
========================================================= */

function calculateV6(
  history
) {

  const arr =
    getSides(
      history
    );


  if (!arr.length) {

    return {

      prediction:
        "SMALL",

      confidence:
        45,

      regime:
        "NO_DATA",

      reason:
        "Waiting for settled BIG/SMALL history.",

      score:
        0,

      model_version:
        MODEL_VERSION

    };

  }


  const adaptive =
    adaptiveWeights(
      arr
    );


  const f =
    featuresFor(
      arr
    );


  let score =
    rawScore(
      f,
      adaptive.weights
    );


  /* ======================================================
     REGIME
  ====================================================== */

  let regime =
    "MIXED";


  if (
    f.alternation !== 0
  ) {

    regime =
      "ALTERNATING";

  } else if (
    f.streakLength >= 4
  ) {

    regime =
      "STREAK_BREAK";

  } else if (
    Math.abs(
      f.recent -
      f.medium
    ) > 0.45
  ) {

    regime =
      "CONFLICT";

  } else if (
    Math.abs(
      f.transition
    ) < 0.08
  ) {

    regime =
      "TRANSITION";

  } else if (
    Math.abs(f.recent) > 0.4 &&
    Math.abs(f.medium) > 0.3
  ) {

    regime =
      "TREND";

  } else if (
    Math.abs(f.recent) > 0.32
  ) {

    regime =
      "SHORT_SHIFT";

  }


  /* ======================================================
     REGIME CALIBRATION
  ====================================================== */

  if (
    regime ===
    "ALTERNATING"
  ) {

    /*
      Alternating signal already contains
      reversal direction.

      Don't blindly add another huge
      opposite-side bonus.
    */

    score =
      score * 0.88;

  }


  if (
    regime ===
    "STREAK_BREAK"
  ) {

    score +=
      f.streakBreak *
      0.08;

  }


  if (
    regime ===
    "CONFLICT"
  ) {

    score *=
      0.58;

  }


  if (
    regime ===
    "TRANSITION"
  ) {

    score *=
      0.78;

  }


  /*
    HARD ANTI-STICKINESS:

    If model has a long streak and
    current score still follows that
    same side weakly, pull it toward
    neutral.

    This does NOT force reversal.
  */

  if (
    f.streakLength >= 4
  ) {

    const sameDirection =
      (
        f.streakSide === "BIG" &&
        score > 0
      ) ||
      (
        f.streakSide === "SMALL" &&
        score < 0
      );


    if (
      sameDirection &&
      Math.abs(score) < 0.38
    ) {

      score *=
        0.35;

    }

  }


  /*
    If recent and transition disagree,
    reduce recent trend pressure.
  */

  if (
    f.recent *
    f.transition <
    -0.10
  ) {

    score *=
      0.72;

  }


  score =
    clamp(
      score,
      -1,
      1
    );


  /* ======================================================
     SIDE
  ====================================================== */

  let prediction;


  if (
    score > 0.035
  ) {

    prediction =
      "BIG";

  } else if (
    score < -0.035
  ) {

    prediction =
      "SMALL";

  } else {

    /*
      Neutral zone.

      Use strongest directional signal,
      not a permanent BIG default.
    */

    const options = [

      {
        name: "transition",
        value:
          f.transition
      },

      {
        name: "reversal",
        value:
          f.reversal
      },

      {
        name: "alternation",
        value:
          f.alternation
      },

      {
        name: "recent",
        value:
          f.recent
      },

      {
        name: "short",
        value:
          f.short
      }

    ];


    options.sort(
      (a, b) =>
        Math.abs(b.value) -
        Math.abs(a.value)
    );


    const strongest =
      options[0];


    if (
      strongest &&
      strongest.value >= 0
    ) {

      prediction =
        "BIG";

    } else {

      prediction =
        "SMALL";

    }

  }


  /* ======================================================
     AGREEMENT
  ====================================================== */

  const signalValues = [

    f.recent,
    f.micro,
    f.short,
    f.medium,
    f.transition,
    f.streakBreak,
    f.alternation,
    f.reversal,
    f.pattern3,
    f.pattern4

  ];


  let positive = 0;
  let negative = 0;
  let active = 0;


  for (
    const v of signalValues
  ) {

    if (
      Math.abs(v) < 0.05
    ) {
      continue;
    }

    active++;

    if (
      v > 0
    ) {
      positive++;
    } else {
      negative++;
    }

  }


  const agreement =
    active
      ? Math.max(
          positive,
          negative
        ) / active
      : 0.5;


  /* ======================================================
     CONFIDENCE
  ====================================================== */

  let confidence =
    45 +
    Math.round(
      Math.abs(score) * 24
    );


  confidence +=
    Math.round(
      Math.max(
        0,
        agreement - 0.5
      ) * 14
    );


  if (
    adaptive.backtest.predictions >= 20
  ) {

    /*
      Backtest only adjusts confidence
      slightly. It never guarantees future
      results.
    */

    if (
      adaptive.backtest.accuracy >=
      0.60
    ) {

      confidence +=
        3;

    } else if (
      adaptive.backtest.accuracy <
      0.48
    ) {

      confidence -=
        5;

    }

  }


  if (
    regime ===
    "CONFLICT"
  ) {

    confidence -=
      9;

  }


  if (
    regime ===
    "TRANSITION"
  ) {

    confidence -=
      4;

  }


  if (
    arr.length < 15
  ) {

    confidence -=
      5;

  }


  confidence =
    Math.round(
      clamp(
        confidence,
        45,
        86
      )
    );


  /* ======================================================
     REASON
  ====================================================== */

  let reason;


  if (
    regime ===
    "ALTERNATING"
  ) {

    reason =
      "V6 detected alternating behaviour and reduced simple trend repetition.";

  } else if (
    regime ===
    "STREAK_BREAK"
  ) {

    reason =
      "V6 detected a long streak and applied controlled anti-stickiness.";

  } else if (
    regime ===
    "CONFLICT"
  ) {

    reason =
      "Recent and medium signals conflict, so V6 reduced directional strength.";

  } else if (
    regime ===
    "TREND"
  ) {

    reason =
      "Recent and medium signals align; transition and balance checks are also applied.";

  } else if (
    regime ===
    "TRANSITION"
  ) {

    reason =
      "Transition behaviour is mixed, so V6 is keeping the signal conservative.";

  } else {

    reason =
      "V6 combines recent, transition, reversal, streak, pattern and adaptive backtest signals.";

  }


  return {

    prediction,

    confidence,

    regime,

    reason,

    score,

    agreement,

    model_version:
      MODEL_VERSION,

    adaptive:

      {

        strategy:
          adaptive.name,

        backtest:
          adaptive.backtest

      },

    features:
      f

  };

}


/* =========================================================
   PREDICTION DB
========================================================= */

async function findPrediction(
  targetIssue
) {

  if (!pool) {
    return null;
  }

  try {

    const result =
      await pool.query(
        `
        SELECT *
        FROM prediction_records
        WHERE target_issue = $1
          AND model_version = $2
        ORDER BY id DESC
        LIMIT 1
        `,
        [
          targetIssue,
          MODEL_VERSION
        ]
      );

    return (
      result.rows[0] ||
      null
    );

  } catch {

    return null;

  }

}


/* =========================================================
   CREATE
========================================================= */

async function getOrCreatePrediction(
  targetIssue,
  history
) {

  if (!targetIssue) {
    return null;
  }

  const existing =
    await findPrediction(
      targetIssue
    );

  if (existing) {
    return existing;
  }

  const model =
    calculateV6(
      history
    );


  if (pool) {

    try {

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
          ON CONFLICT
          (model_version,target_issue)
          DO NOTHING
          RETURNING *
          `,
          [
            targetIssue,
            model.prediction,
            model.confidence,
            MODEL_VERSION,
            now()
          ]
        );


      if (
        result.rows.length
      ) {

        return result.rows[0];

      }


      return await findPrediction(
        targetIssue
      );

    } catch (error) {

      console.error(
        "Create prediction:",
        error.message
      );

    }

  }


  return {

    target_issue:
      targetIssue,

    prediction:
      model.prediction,

    confidence:
      model.confidence,

    model_version:
      MODEL_VERSION,

    created_at:
      now(),

    actual_result:
      null

  };

}


/* =========================================================
   SETTLEMENT
========================================================= */

async function settlePredictions(
  history
) {

  if (
    !pool ||
    !Array.isArray(history)
  ) {
    return;
  }

  const actualMap =
    new Map();


  for (
    const row of history
  ) {

    if (
      row &&
      row.issueNumber &&
      (
        row.result === "BIG" ||
        row.result === "SMALL"
      )
    ) {

      actualMap.set(
        String(
          row.issueNumber
        ),
        row
      );

    }

  }


  if (!actualMap.size) {
    return;
  }


  try {

    const pending =
      await pool.query(
        `
        SELECT *
        FROM prediction_records
        WHERE model_version = $1
          AND actual_result IS NULL
        ORDER BY id DESC
        LIMIT 500
        `,
        [MODEL_VERSION]
      );


    for (
      const record
      of pending.rows
    ) {

      const actual =
        actualMap.get(
          String(
            record.target_issue
          )
        );


      /*
        EXACT TARGET ONLY.
      */

      if (!actual) {
        continue;
      }


      if (
        actual.result !== "BIG" &&
        actual.result !== "SMALL"
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
          AND actual_result IS NULL
        `,
        [
          actual.number,
          actual.result,
          now(),
          record.id
        ]
      );

    }

  } catch (error) {

    console.error(
      "Settlement:",
      error.message
    );

  }

}


/* =========================================================
   LAST 30
========================================================= */

async function last30(
  history
) {

  if (!pool) {
    return [];
  }

  try {

    const result =
      await pool.query(
        `
        SELECT *
        FROM prediction_records
        WHERE model_version = $1
        ORDER BY id DESC
        LIMIT 30
        `,
        [MODEL_VERSION]
      );


    const actualMap =
      new Map();


    for (
      const row of history
    ) {

      if (
        row &&
        row.issueNumber &&
        (
          row.result === "BIG" ||
          row.result === "SMALL"
        )
      ) {

        actualMap.set(
          String(
            row.issueNumber
          ),
          row
        );

      }

    }


    return result.rows.map(
      row => {

        const issue =
          String(
            row.target_issue
          );


        const actual =
          actualMap.get(
            issue
          );


        let actualResult =
          null;

        let status =
          "PENDING";


        /*
          Exact actual result has priority.
        */

        if (actual) {

          actualResult =
            actual.result;


          status =
            row.prediction ===
            actualResult
              ? "WIN"
              : "LOSS";

        } else if (
          row.actual_result === "BIG" ||
          row.actual_result === "SMALL"
        ) {

          actualResult =
            row.actual_result;


          status =
            row.prediction ===
            actualResult
              ? "WIN"
              : "LOSS";

        }


        /*
          No actual result means PENDING.
        */

        if (
          actualResult !== "BIG" &&
          actualResult !== "SMALL"
        ) {

          actualResult =
            null;

          status =
            "PENDING";

        }


        return {

          id:
            row.id,

          target_issue:
            issue,

          prediction:
            row.prediction,

          confidence:
            Number(
              row.confidence || 0
            ),

          model_version:
            row.model_version,

          actual_number:
            actual
              ? actual.number
              : row.actual_number,

          actual_result:
            actualResult,

          status,

          created_at:
            row.created_at,

          settled_at:
            row.settled_at

        };

      }
    );

  } catch (error) {

    console.error(
      "Last30:",
      error.message
    );

    return [];

  }

}


/* =========================================================
   STATS
========================================================= */

async function getStats() {

  if (!pool) {

    return {

      wins: 0,
      losses: 0,
      pending: 0,
      total: 0,
      winRate: 0

    };

  }


  try {

    const result =
      await pool.query(
        `
        SELECT

          COUNT(*) FILTER (
            WHERE actual_result IS NOT NULL
          ) AS settled,

          COUNT(*) FILTER (
            WHERE actual_result = prediction
          ) AS wins,

          COUNT(*) FILTER (
            WHERE actual_result IS NOT NULL
            AND actual_result <> prediction
          ) AS losses,

          COUNT(*) FILTER (
            WHERE actual_result IS NULL
          ) AS pending

        FROM prediction_records

        WHERE model_version = $1
        `,
        [MODEL_VERSION]
      );


    const row =
      result.rows[0] || {};


    const wins =
      Number(
        row.wins || 0
      );


    const losses =
      Number(
        row.losses || 0
      );


    const pending =
      Number(
        row.pending || 0
      );


    const total =
      wins + losses;


    return {

      wins,

      losses,

      pending,

      total,

      winRate:
        total
          ? Math.round(
              wins /
              total *
              100
            )
          : 0

    };

  } catch {

    return {

      wins: 0,
      losses: 0,
      pending: 0,
      total: 0,
      winRate: 0

    };

  }

}


/* =========================================================
   STATE
========================================================= */

async function buildState() {

  const provider =
    await fetchWingoHistory();


  const history =
    provider.history || [];


  await settlePredictions(
    history
  );


  const target =
    resolveTarget(
      history,
      provider.currentIssue
    );


  const record =
    await getOrCreatePrediction(
      target,
      history
    );


  const model =
    calculateV6(
      history
    );


  const predictions =
    await last30(
      history
    );


  const stats =
    await getStats();


  return {

    ok: true,

    model_version:
      MODEL_VERSION,

    game_url:
      GAME_URL,

    currentIssue:
      provider.currentIssue,

    current_issue:
      provider.currentIssue,

    targetIssue:
      target,

    target_issue:
      target,

    providerLastUpdated:
      provider.lastUpdated,

    provider_last_updated:
      provider.lastUpdated,

    history,

    prediction:
      record
        ? {

            target_issue:
              record.target_issue,

            prediction:
              record.prediction,

            confidence:
              Number(
                record.confidence ||
                model.confidence
              ),

            regime:
              model.regime,

            reason:
              model.reason,

            model_version:
              MODEL_VERSION,

            actual_result:
              record.actual_result ||
              null

          }
        : {

            target_issue:
              target,

            prediction:
              model.prediction,

            confidence:
              model.confidence,

            regime:
              model.regime,

            reason:
              model.reason,

            model_version:
              MODEL_VERSION,

            actual_result:
              null

          },

    predictions,

    stats,

    wins:
      stats.wins,

    losses:
      stats.losses,

    winRate:
      stats.winRate,

    provider: {

      fetched:
        provider.fetched,

      last_updated:
        provider.lastUpdated,

      fetched_at:
        provider.fetchedAt,

      error:
        provider.error

    }

  };

}


/* =========================================================
   ACCESS
========================================================= */

async function checkAccess(
  req,
  body = {}
) {

  if (!pool) {

    return {

      ok: false,

      error:
        "Database is not configured."

    };

  }


  const key =
    accessKey(
      req,
      body
    );


  const device =
    deviceId(
      req,
      body
    );


  if (!key) {

    return {

      ok: false,

      error:
        "Access key required."

    };

  }


  if (!device) {

    return {

      ok: false,

      error:
        "Device ID required."

    };

  }


  try {

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


    if (
      !result.rows.length
    ) {

      return {

        ok: false,

        error:
          "Invalid access key."

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

        error:
          "This key is already bound to another device."

      };

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
        device,
        now(),
        row.id
      ]
    );


    return {

      ok: true,

      valid: true,

      success: true,

      key:
        row.access_key,

      device_bound:
        Boolean(row.device_id),

      last_seen:
        now()

    };

  } catch (error) {

    return {

      ok: false,

      error:
        error.message

    };

  }

}


/* =========================================================
   ADMIN STATUS
========================================================= */

async function adminStatus() {

  let database =
    "NOT CONFIGURED";


  if (pool) {

    try {

      await pool.query(
        "SELECT 1"
      );

      database =
        "CONNECTED";

    } catch {

      database =
        "ERROR";

    }

  }


  const provider =
    await fetchWingoHistory();


  return {

    ok: true,

    status:
      "ok",

    server:
      "ONLINE",

    database,

    db:
      database,

    wingobot:
      provider.error
        ? "ERROR"
        : "CONNECTED",

    wingo:
      provider.error
        ? "ERROR"
        : "CONNECTED",

    model:
      MODEL_VERSION,

    model_version:
      MODEL_VERSION,

    number_model:
      "DISABLED",

    output:
      "BIG / SMALL",

    settlement:
      "EXACT ISSUE",

    adaptive_model:
      "WALK-FORWARD",

    game_url:
      GAME_URL,

    provider_error:
      provider.error

  };

}


/* =========================================================
   ADMIN KEYS
========================================================= */

async function listKeys() {

  if (!pool) {
    return [];
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


  return result.rows;

}


function generateKey() {

  return (
    "DY-" +
    crypto
      .randomBytes(8)
      .toString("hex")
      .toUpperCase()
  );

}


/* =========================================================
   STATIC FILES
========================================================= */

function contentType(file) {

  const ext =
    path.extname(file)
      .toLowerCase();


  const map = {

    ".html":
      "text/html; charset=utf-8",

    ".css":
      "text/css; charset=utf-8",

    ".js":
      "application/javascript; charset=utf-8",

    ".json":
      "application/json; charset=utf-8",

    ".mp3":
      "audio/mpeg",

    ".png":
      "image/png",

    ".jpg":
      "image/jpeg",

    ".jpeg":
      "image/jpeg",

    ".svg":
      "image/svg+xml",

    ".ico":
      "image/x-icon"

  };


  return (
    map[ext] ||
    "application/octet-stream"
  );

}


function safeFilePath(
  filename
) {

  return path.join(
    ROOT,
    path.basename(
      filename
    )
  );

}


function serveFile(
  req,
  res,
  filename
) {

  const full =
    safeFilePath(
      filename
    );


  if (
    !fs.existsSync(full)
  ) {

    text(
      res,
      404,
      "File not found"
    );

    return;

  }


  const stat =
    fs.statSync(full);


  const type =
    contentType(full);


  /*
    MP3 RANGE SUPPORT
  */

  if (
    type === "audio/mpeg"
  ) {

    const range =
      req.headers.range;


    if (!range) {

      res.writeHead(
        200,
        {

          "Content-Type":
            type,

          "Content-Length":
            stat.size,

          "Accept-Ranges":
            "bytes"

        }
      );


      fs.createReadStream(
        full
      ).pipe(res);


      return;

    }


    const match =
      /bytes=(\d*)-(\d*)/
        .exec(range);


    if (!match) {

      res.writeHead(
        416
      );

      res.end();

      return;

    }


    let start =
      match[1]
        ? Number(match[1])
        : 0;


    let end =
      match[2]
        ? Number(match[2])
        : stat.size - 1;


    if (
      start < 0 ||
      end >= stat.size ||
      start > end
    ) {

      res.writeHead(
        416,
        {
          "Content-Range":
            `bytes */${stat.size}`
        }
      );

      res.end();

      return;

    }


    const length =
      end - start + 1;


    res.writeHead(
      206,
      {

        "Content-Type":
          type,

        "Content-Length":
          length,

        "Content-Range":
          `bytes ${start}-${end}/${stat.size}`,

        "Accept-Ranges":
          "bytes"

      }
    );


    fs.createReadStream(
      full,
      {
        start,
        end
      }
    ).pipe(res);


    return;

  }


  res.writeHead(
    200,
    {

      "Content-Type":
        type,

      "Content-Length":
        stat.size,

      "Cache-Control":
        "no-cache"

    }
  );


  fs.createReadStream(
    full
  ).pipe(res);

}


/* =========================================================
   SERVER
========================================================= */

const server =
  http.createServer(
    async (req, res) => {

      try {

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
                "Content-Type, x-access-key, x-device-id, x-admin-key",

              "Access-Control-Allow-Methods":
                "GET,POST,DELETE,OPTIONS"

            }
          );

          res.end();

          return;

        }


        const url =
          new URL(
            req.url,
            `http://${req.headers.host || "localhost"}`
          );


        const pathname =
          url.pathname;


        /* ================================================
           HEALTH
        ================================================ */

        if (
          pathname ===
          "/health"
        ) {

          json(
            res,
            200,
            {

              ok: true,

              status:
                "healthy",

              model:
                MODEL_VERSION,

              time:
                now()

            }
          );

          return;

        }


        /* ================================================
           ROOT
        ================================================ */

        if (
          pathname === "/" ||
          pathname === "/prediction"
        ) {

          serveFile(
            req,
            res,
            "prediction.html"
          );

          return;

        }


        /* ================================================
           ADMIN PAGE
        ================================================ */

        if (
          pathname ===
          "/admin.html"
        ) {

          serveFile(
            req,
            res,
            "admin.html"
          );

          return;

        }


        /* ================================================
           KEY CHECK
        ================================================ */

        if (
          pathname ===
          "/api/key/check" &&
          req.method === "POST"
        ) {

          const body =
            await parseBody(req);


          const result =
            await checkAccess(
              req,
              body
            );


          json(
            res,
            result.ok
              ? 200
              : 403,
            result
          );

          return;

        }


        /* ================================================
           STATE
        ================================================ */

        if (
          pathname ===
          "/api/state" &&
          req.method === "GET"
        ) {

          const key =
            accessKey(req);


          const device =
            deviceId(req);


          if (
            !key ||
            !device
          ) {

            json(
              res,
              401,
              {

                ok: false,

                error:
                  "Access key and device ID required."

              }
            );

            return;

          }


          const access =
            await checkAccess(
              req
            );


          if (!access.ok) {

            json(
              res,
              403,
              access
            );

            return;

          }


          const state =
            await buildState();


          json(
            res,
            200,
            state
          );

          return;

        }


        /* ================================================
           HISTORY
        ================================================ */

        if (
          pathname ===
          "/api/history" &&
          req.method === "GET"
        ) {

          const access =
            await checkAccess(
              req
            );


          if (!access.ok) {

            json(
              res,
              403,
              access
            );

            return;

          }


          const provider =
            await fetchWingoHistory();


          await settlePredictions(
            provider.history
          );


          const predictions =
            await last30(
              provider.history
            );


          const stats =
            await getStats();


          json(
            res,
            200,
            {

              ok: true,

              predictions,

              history:
                predictions,

              stats,

              model_version:
                MODEL_VERSION

            }
          );

          return;

        }


        /* ================================================
           ADMIN AUTH
        ================================================ */

        if (
          pathname.startsWith(
            "/api/admin/"
          )
        ) {

          if (
            !adminAuthorized(req)
          ) {

            json(
              res,
              401,
              {

                ok: false,

                error:
                  "Unauthorized admin request."

              }
            );

            return;

          }

        }


        /* ================================================
           ADMIN STATUS
        ================================================ */

        if (
          pathname ===
          "/api/admin/status" &&
          req.method === "GET"
        ) {

          json(
            res,
            200,
            await adminStatus()
          );

          return;

        }


        /* ================================================
           ADMIN PING
        ================================================ */

        if (
          pathname ===
          "/api/admin/ping" &&
          req.method === "GET"
        ) {

          json(
            res,
            200,
            {

              ok: true,

              message:
                "PONG",

              model:
                MODEL_VERSION,

              time:
                now()

            }
          );

          return;

        }


        /* ================================================
           WINGO TEST
        ================================================ */

        if (
          pathname ===
          "/api/admin/wingo-test" &&
          req.method === "GET"
        ) {

          const provider =
            await fetchWingoHistory(
              true
            );


          json(
            res,
            provider.error
              ? 502
              : 200,
            {

              ok:
                !provider.error,

              currentIssue:
                provider.currentIssue,

              historyCount:
                provider.history.length,

              fetched:
                provider.fetched,

              lastUpdated:
                provider.lastUpdated,

              error:
                provider.error

            }
          );

          return;

        }


        /* ================================================
           MODEL TEST
        ================================================ */

        if (
          pathname ===
          "/api/admin/model-test" &&
          req.method === "GET"
        ) {

          const provider =
            await fetchWingoHistory(
              true
            );


          const model =
            calculateV6(
              provider.history
            );


          json(
            res,
            200,
            {

              ok: true,

              model_version:
                MODEL_VERSION,

              prediction:
                model.prediction,

              confidence:
                model.confidence,

              regime:
                model.regime,

              reason:
                model.reason,

              score:
                Number(
                  model.score.toFixed(4)
                ),

              agreement:
                Number(
                  model.agreement.toFixed(4)
                ),

              history_used:
                provider.history.length,

              adaptive_strategy:
                model.adaptive &&
                model.adaptive.strategy,

              backtest:
                model.adaptive &&
                model.adaptive.backtest,

              number_model:
                "DISABLED",

              features:
                model.features

            }
          );

          return;

        }


        /* ================================================
           ADMIN KEYS GET
        ================================================ */

        if (
          pathname ===
          "/api/admin/keys" &&
          req.method === "GET"
        ) {

          json(
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


        /* ================================================
           ADMIN KEY CREATE
        ================================================ */

        if (
          pathname ===
          "/api/admin/keys" &&
          req.method === "POST"
        ) {

          if (!pool) {

            json(
              res,
              503,
              {

                ok: false,

                error:
                  "Database is not configured."

              }
            );

            return;

          }


          const body =
            await parseBody(req);


          let key =
            String(
              body.access_key ||
              body.key ||
              ""
            ).trim();


          if (!key) {
            key =
              generateKey();
          }


          if (
            key.length < 4 ||
            key.length > 200
          ) {

            json(
              res,
              400,
              {

                ok: false,

                error:
                  "Invalid access key length."

              }
            );

            return;

          }


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


            json(
              res,
              200,
              {

                ok: true,

                key:
                  result.rows[0]

              }
            );

          } catch (error) {

            if (
              error.code ===
              "23505"
            ) {

              json(
                res,
                409,
                {

                  ok: false,

                  error:
                    "This access key already exists."

                }
              );

            } else {

              json(
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

          return;

        }


        /* ================================================
           ADMIN KEY DELETE
        ================================================ */

        if (
          pathname ===
          "/api/admin/keys" &&
          req.method === "DELETE"
        ) {

          if (!pool) {

            json(
              res,
              503,
              {

                ok: false,

                error:
                  "Database is not configured."

              }
            );

            return;

          }


          const body =
            await parseBody(req);


          const id =
            body.id ||
            url.searchParams.get(
              "id"
            );


          const key =
            body.access_key ||
            body.key ||
            url.searchParams.get(
              "access_key"
            );


          let result;


          if (id) {

            result =
              await pool.query(
                `
                DELETE FROM access_keys
                WHERE id = $1
                RETURNING id,access_key
                `,
                [id]
              );

          } else if (key) {

            result =
              await pool.query(
                `
                DELETE FROM access_keys
                WHERE access_key = $1
                RETURNING id,access_key
                `,
                [key]
              );

          } else {

            json(
              res,
              400,
              {

                ok: false,

                error:
                  "Key or ID required."

              }
            );

            return;

          }


          if (
            !result.rows.length
          ) {

            json(
              res,
              404,
              {

                ok: false,

                error:
                  "Key not found."

              }
            );

            return;

          }


          json(
            res,
            200,
            {

              ok: true,

              deleted:
                result.rows[0]

            }
          );

          return;

        }


        /* ================================================
           RESET DEVICE
        ================================================ */

        if (
          pathname ===
          "/api/admin/reset-device" &&
          req.method === "POST"
        ) {

          if (!pool) {

            json(
              res,
              503,
              {

                ok: false,

                error:
                  "Database is not configured."

              }
            );

            return;

          }


          const body =
            await parseBody(req);


          const key =
            String(
              body.access_key ||
              body.key ||
              ""
            ).trim();


          if (!key) {

            json(
              res,
              400,
              {

                ok: false,

                error:
                  "Access key required."

              }
            );

            return;

          }


          const result =
            await pool.query(
              `
              UPDATE access_keys
              SET device_id = NULL
              WHERE access_key = $1
              RETURNING id,access_key
              `,
              [key]
            );


          if (
            !result.rows.length
          ) {

            json(
              res,
              404,
              {

                ok: false,

                error:
                  "Access key not found."

              }
            );

            return;

          }


          json(
            res,
            200,
            {

              ok: true,

              reset:
                result.rows[0]

            }
          );

          return;

        }


        /* ================================================
           MUSIC
        ================================================ */

        if (
          pathname ===
          "/music.mp3"
        ) {

          serveFile(
            req,
            res,
            "music.mp3"
          );

          return;

        }


        /* ================================================
           404
        ================================================ */

        json(
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
          "SERVER ERROR:",
          error
        );


        if (
          !res.headersSent
        ) {

          json(
            res,
            500,
            {

              ok: false,

              error:
                "Internal server error",

              message:
                error.message

            }
          );

        } else {

          res.end();

        }

      }

    }
  );


/* =========================================================
   START
========================================================= */

async function start() {

  try {

    await initDatabase();

    console.log(
      "Database initialization complete."
    );

  } catch (error) {

    console.error(
      "Database initialization failed:",
      error.message
    );

  }


  server.listen(
    PORT,
    "0.0.0.0",
    () => {

      console.log(
        `DY AI Wingo ${MODEL_VERSION} running on port ${PORT}`
      );

      console.log(
        `Model: ${MODEL_VERSION}`
      );

      console.log(
        `Game: ${GAME_URL}`
      );

    }
  );

}


start();


/* =========================================================
   BACKGROUND REFRESH
========================================================= */

setInterval(
  async () => {

    try {

      const provider =
        await fetchWingoHistory(
          true
        );


      if (
        provider.history.length
      ) {

        await settlePredictions(
          provider.history
        );

      }

    } catch (error) {

      console.error(
        "Background refresh:",
        error.message
      );

    }

  },
  3000
);


/* =========================================================
   SHUTDOWN
========================================================= */

async function shutdown() {

  console.log(
    "Shutting down..."
  );


  try {

    if (pool) {
      await pool.end();
    }

  } catch {}


  server.close(
    () => {
      process.exit(0);
    }
  );


  setTimeout(
    () => process.exit(0),
    5000
  );

}


process.on(
  "SIGTERM",
  shutdown
);

process.on(
  "SIGINT",
  shutdown
);
