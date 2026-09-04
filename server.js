"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

/* =========================================================
   DY AI WINGO 30S — V5
   ========================================================= */

const PORT =
  Number(process.env.PORT || 10000);

const ADMIN_KEY =
  process.env.ADMIN_KEY || "dy4427574";

const WINGOBOT_TOKEN =
  process.env.WINGOBOT_TOKEN || "";

const WINGOBOT_URL =
  "https://api.wingobot.com/v2/30-sec-game-history";

const GAME_URL =
  "https://www.shreewin38.com/#/register?invitationCode=88523152383";

const MODEL_VERSION =
  "DY-AI-BS-V5";

const ROOT =
  __dirname;


/* =========================================================
   DATABASE
========================================================= */

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
   BASIC HELPERS
========================================================= */

function now() {
  return Date.now();
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
   ISSUE HELPERS
========================================================= */

function compareIssue(a, b) {

  const aa =
    String(a);

  const bb =
    String(b);

  if (
    /^\d+$/.test(aa) &&
    /^\d+$/.test(bb)
  ) {

    const A =
      BigInt(aa);

    const B =
      BigInt(bb);

    if (A > B) return 1;
    if (A < B) return -1;

    return 0;
  }

  return aa.localeCompare(bb);
}


function incrementIssue(issue) {

  const value =
    String(issue || "").trim();

  if (!/^\d+$/.test(value)) {
    return "";
  }

  try {

    return (
      BigInt(value) + 1n
    ).toString();

  } catch {

    return "";

  }

}


/* =========================================================
   DATABASE INIT
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
   NORMALIZE PROVIDER ROW
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
    Number is used ONLY to normalize
    provider's actual BIG/SMALL result.
    It is NOT used as a prediction target.
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
   WINGOBOT
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


  const settled =
    history.find(
      row =>
        row &&
        (
          row.result === "BIG" ||
          row.result === "SMALL"
        )
    );


  const latestIssue =
    settled
      ? String(
          settled.issueNumber
        )
      : String(
          history[0].issueNumber
        );


  const current =
    currentIssue
      ? String(currentIssue)
      : "";


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
   V5 DATA
========================================================= */

function sides(history) {

  return history
    .map(row => row.result)
    .filter(
      side =>
        side === "BIG" ||
        side === "SMALL"
    );

}


function toValue(side) {

  return side === "BIG"
    ? 1
    : -1;

}


function clamp(
  value,
  min,
  max
) {

  return Math.max(
    min,
    Math.min(max, value)
  );

}


/* =========================================================
   BALANCED BASELINE
========================================================= */

function globalBalance(arr) {

  if (!arr.length) {
    return 0;
  }


  let big = 0;


  for (const side of arr) {

    if (side === "BIG") {
      big++;
    }

  }


  const p =
    big / arr.length;


  /*
    + = BIG excess
    - = SMALL excess
  */

  return (
    p - 0.5
  ) * 2;

}


/* =========================================================
   RECENT WEIGHTED SIGNAL
========================================================= */

function recentSignal(
  arr,
  count
) {

  const values =
    arr.slice(
      0,
      count
    );


  if (!values.length) {
    return 0;
  }


  let numerator = 0;
  let denominator = 0;


  for (
    let i = 0;
    i < values.length;
    i++
  ) {

    const weight =
      values.length - i;


    numerator +=
      toValue(values[i]) *
      weight;


    denominator +=
      weight;

  }


  return (
    numerator /
    denominator
  );

}


/* =========================================================
   WINDOW BALANCE
========================================================= */

function windowSignal(
  arr,
  count
) {

  const values =
    arr.slice(
      0,
      count
    );


  if (!values.length) {
    return 0;
  }


  let score = 0;


  for (
    const side of values
  ) {

    score +=
      toValue(side);

  }


  return (
    score /
    values.length
  );

}


/* =========================================================
   TRANSITIONS
========================================================= */

function transitionSignal(
  arr,
  count
) {

  const values =
    arr.slice(
      0,
      count + 1
    );


  if (values.length < 2) {
    return 0;
  }


  let same = 0;
  let change = 0;


  for (
    let i = 0;
    i < values.length - 1;
    i++
  ) {

    if (
      values[i] ===
      values[i + 1]
    ) {

      same++;

    } else {

      change++;

    }

  }


  const total =
    same + change;


  if (!total) {
    return 0;
  }


  return (
    (same - change) /
    total
  );

}


/* =========================================================
   STREAK
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
    const value of arr
  ) {

    if (value !== side) {
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
   ALTERNATION
========================================================= */

function alternationRate(
  arr,
  count
) {

  const values =
    arr.slice(
      0,
      count
    );


  if (values.length < 2) {
    return 0;
  }


  let changes = 0;


  for (
    let i = 0;
    i < values.length - 1;
    i++
  ) {

    if (
      values[i] !==
      values[i + 1]
    ) {

      changes++;

    }

  }


  return (
    changes /
    (values.length - 1)
  );

}


/* =========================================================
   MARKOV / TRANSITION PROBABILITY
========================================================= */

function conditionalSignal(
  arr,
  count
) {

  const values =
    arr.slice(
      0,
      Math.min(
        arr.length,
        count
      )
    );


  if (values.length < 4) {
    return 0;
  }


  let bigAfterBig = 0;
  let totalAfterBig = 0;

  let bigAfterSmall = 0;
  let totalAfterSmall = 0;


  for (
    let i = 1;
    i < values.length;
    i++
  ) {

    const previous =
      values[i - 1];

    const current =
      values[i];


    if (
      previous === "BIG"
    ) {

      totalAfterBig++;

      if (
        current === "BIG"
      ) {
        bigAfterBig++;
      }

    } else {

      totalAfterSmall++;

      if (
        current === "BIG"
      ) {
        bigAfterSmall++;
      }

    }

  }


  /*
    Laplace smoothing prevents
    extreme 0/1 probabilities.
  */

  const pAfterBig =
    (
      bigAfterBig + 1
    ) /
    (
      totalAfterBig + 2
    );


  const pAfterSmall =
    (
      bigAfterSmall + 1
    ) /
    (
      totalAfterSmall + 2
    );


  const last =
    values[0];


  const p =
    last === "BIG"
      ? pAfterBig
      : pAfterSmall;


  return (
    p - 0.5
  ) * 2;

}


/* =========================================================
   PATTERN SIGNAL
========================================================= */

function patternSignal(
  arr,
  patternLength = 3
) {

  if (
    arr.length <
    patternLength + 4
  ) {

    return 0;

  }


  const key =
    arr
      .slice(
        0,
        patternLength
      )
      .map(
        x =>
          x === "BIG"
            ? "B"
            : "S"
      )
      .join("");


  let matches = 0;
  let nextBig = 0;
  let nextSmall = 0;


  for (
    let i = patternLength;
    i < arr.length;
    i++
  ) {

    const previous =
      arr
        .slice(
          i - patternLength,
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
      previous !== key
    ) {
      continue;
    }


    matches++;


    if (
      arr[i] === "BIG"
    ) {

      nextBig++;

    } else {

      nextSmall++;

    }

  }


  if (!matches) {
    return 0;
  }


  /*
    Shrink tiny samples so one match
    cannot dominate the whole model.
  */

  const raw =
    (
      nextBig -
      nextSmall
    ) /
    matches;


  const reliability =
    clamp(
      matches / 8,
      0,
      1
    );


  return (
    raw *
    reliability
  );

}


/* =========================================================
   STREAK BREAK
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
      (streak.length - 2) /
      5,
      0,
      1
    );


  /*
    Long BIG streak => controlled SMALL
    pressure.
    Long SMALL streak => controlled BIG
    pressure.
  */

  return (
    streak.side === "BIG"
      ? -strength
      : strength
  );

}


/* =========================================================
   REVERSAL CONFIRMATION
========================================================= */

function reversalSignal(
  arr
) {

  if (
    arr.length < 4
  ) {
    return 0;
  }


  const latest =
    arr[0];

  const second =
    arr[1];

  const third =
    arr[2];

  const fourth =
    arr[3];


  /*
    Example:
    BIG BIG SMALL SMALL
    means recent direction may
    be shifting toward SMALL.
  */

  if (
    latest === second &&
    third === fourth &&
    latest !== third
  ) {

    return (
      latest === "BIG"
        ? -1
        : 1
    );

  }


  /*
    One isolated opposite result is
    not enough for a full reversal.
  */

  return 0;

}


/* =========================================================
   REGIME
========================================================= */

function classifyRegime(
  arr,
  f
) {

  if (
    arr.length < 3
  ) {

    return "MIXED";

  }


  if (
    f.alternation >= 0.72
  ) {

    return "ALTERNATING";

  }


  if (
    f.streakLength >= 4
  ) {

    return "STREAK_BREAK";

  }


  if (
    Math.abs(
      f.recent -
      f.medium
    ) >= 0.42
  ) {

    return "CONFLICT";

  }


  if (
    Math.abs(
      f.transition
    ) < 0.08
  ) {

    return "TRANSITION";

  }


  if (
    Math.abs(f.recent) >= 0.40 &&
    Math.abs(f.medium) >= 0.30
  ) {

    return "TREND";

  }


  if (
    Math.abs(
      f.recent
    ) >= 0.35
  ) {

    return "SHORT_SHIFT";

  }


  return "MIXED";

}


/* =========================================================
   V5 MODEL
========================================================= */

function calculateV5(
  history
) {

  const arr =
    sides(history);


  if (!arr.length) {

    return {

      prediction: "BIG",

      confidence: 45,

      regime: "MIXED",

      reason:
        "Waiting for settled BIG/SMALL history.",

      score: 0,

      model_version:
        MODEL_VERSION

    };

  }


  const recent =
    recentSignal(
      arr,
      5
    );


  const micro =
    windowSignal(
      arr,
      3
    );


  const short =
    windowSignal(
      arr,
      7
    );


  const medium =
    windowSignal(
      arr,
      15
    );


  const long =
    windowSignal(
      arr,
      40
    );


  const transition =
    transitionSignal(
      arr,
      20
    );


  const conditional =
    conditionalSignal(
      arr,
      30
    );


  const pattern =
    patternSignal(
      arr,
      3
    );


  const pattern4 =
    patternSignal(
      arr,
      4
    );


  const alternation =
    alternationRate(
      arr,
      8
    );


  const streak =
    streakInfo(
      arr
    );


  const streakBreak =
    streakBreakSignal(
      arr
    );


  const reversal =
    reversalSignal(
      arr
    );


  const global =
    globalBalance(
      arr.slice(
        0,
        60
      )
    );


  const f = {

    recent,

    micro,

    short,

    medium,

    long,

    transition,

    conditional,

    pattern,

    pattern4,

    alternation,

    streakLength:
      streak.length,

    streakBreak,

    reversal,

    global

  };


  const regime =
    classifyRegime(
      arr,
      f
    );


  /*
    ========================================================
    BALANCED ENSEMBLE

    IMPORTANT:
    Every component is centered around ZERO.

    +1 = BIG
    -1 = SMALL

    Global historical imbalance is used
    as a correction, not as a reason to
    permanently predict the majority side.
    ========================================================
  */

  let score = 0;


  /*
    Most important:
    recent 3-5 rounds
  */

  score +=
    recent * 0.25;


  /*
    Micro movement
  */

  score +=
    micro * 0.12;


  /*
    Short window
  */

  score +=
    short * 0.12;


  /*
    Medium context
  */

  score +=
    medium * 0.10;


  /*
    Transition behaviour
  */

  score +=
    transition * 0.10;


  /*
    Conditional next-side behaviour
  */

  score +=
    conditional * 0.11;


  /*
    Pattern signals
  */

  score +=
    pattern * 0.04;

  score +=
    pattern4 * 0.03;


  /*
    Long window gets very low weight
    so BIG/SMALL imbalance cannot
    dominate the model.
  */

  score +=
    long * 0.03;


  /*
    Historical balance correction.

    If last 60 has too many BIGs,
    slightly pulls score toward SMALL.
    If too many SMALLs, pulls toward BIG.
  */

  score -=
    global * 0.08;


  /*
    Streak break
  */

  score +=
    streakBreak * 0.08;


  /*
    Reversal confirmation
  */

  score +=
    reversal * 0.05;


  /* ======================================================
     REGIME-SPECIFIC CALIBRATION
  ====================================================== */


  if (
    regime === "ALTERNATING"
  ) {

    /*
      In alternating conditions,
      following the latest result is
      usually less useful than checking
      the opposite side.
    */

    const opposite =
      arr[0] === "BIG"
        ? -1
        : 1;


    score +=
      opposite * 0.10;

  }


  if (
    regime === "STREAK_BREAK"
  ) {

    score +=
      streakBreak * 0.07;

  }


  if (
    regime === "CONFLICT"
  ) {

    /*
      Conflicting windows should produce
      weaker confidence and a smaller score.
    */

    score *=
      0.62;

  }


  if (
    regime === "TRANSITION"
  ) {

    score *=
      0.78;

  }


  /*
    Prevent any single component from
    forcing an extreme result.
  */

  score =
    clamp(
      score,
      -1,
      1
    );


  /* ======================================================
     SIDE DECISION
  ====================================================== */

  let prediction;


  if (
    score > 0
  ) {

    prediction =
      "BIG";

  } else if (
    score < 0
  ) {

    prediction =
      "SMALL";

  } else {

    /*
      Perfect neutral case:
      use the better-supported conditional
      signal first, then short window.

      This avoids hard-coded BIG default.
    */

    if (
      conditional > 0
    ) {

      prediction =
        "BIG";

    } else if (
      conditional < 0
    ) {

      prediction =
        "SMALL";

    } else if (
      short > 0
    ) {

      prediction =
        "BIG";

    } else {

      prediction =
        "SMALL";

    }

  }


  /* ======================================================
     SIGNAL AGREEMENT
  ====================================================== */

  const signals = [

    recent,

    micro,

    short,

    medium,

    transition,

    conditional,

    pattern,

    streakBreak

  ];


  const nonZero =
    signals.filter(
      x =>
        Math.abs(x) >
        0.04
    );


  let agreement = 0;


  if (nonZero.length) {

    let positive = 0;
    let negative = 0;


    for (
      const value of nonZero
    ) {

      if (
        value > 0
      ) {

        positive++;

      } else {

        negative++;

      }

    }


    agreement =
      Math.max(
        positive,
        negative
      ) /
      nonZero.length;

  }


  /* ======================================================
     CONFIDENCE
  ====================================================== */

  let confidence =
    45 +
    Math.round(
      Math.abs(score) * 28
    );


  confidence +=
    Math.round(
      Math.max(
        0,
        agreement - 0.50
      ) * 16
    );


  if (
    arr.length < 8
  ) {

    confidence -= 5;

  }


  if (
    regime === "CONFLICT"
  ) {

    confidence -= 8;

  }


  if (
    regime === "TRANSITION"
  ) {

    confidence -= 4;

  }


  if (
    regime === "MIXED"
  ) {

    confidence -= 2;

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
    regime === "ALTERNATING"
  ) {

    reason =
      "V5 detected alternating behaviour and reduced blind trend-following.";

  } else if (
    regime === "STREAK_BREAK"
  ) {

    reason =
      "V5 detected an extended streak and applied controlled reversal pressure.";

  } else if (
    regime === "CONFLICT"
  ) {

    reason =
      "Recent and medium windows disagree, so V5 reduced signal strength.";

  } else if (
    regime === "TREND"
  ) {

    reason =
      "Recent and medium windows are aligned, with historical balance correction.";

  } else if (
    regime === "TRANSITION"
  ) {

    reason =
      "Transition behaviour detected; V5 is keeping the directional signal conservative.";

  } else if (
    regime === "SHORT_SHIFT"
  ) {

    reason =
      "Recent rounds show a short-term shift while longer context is kept at low weight.";

  } else {

    reason =
      "V5 combines recent rounds, transitions, streaks, patterns and balance calibration.";

  }


  return {

    prediction,

    confidence,

    regime,

    reason,

    score,

    agreement,

    features: {

      recent,
      micro,
      short,
      medium,
      long,
      transition,
      conditional,
      pattern,
      pattern4,
      alternation,
      streakLength:
        streak.length,
      streakBreak,
      reversal,
      global

    },

    model_version:
      MODEL_VERSION

  };

}


/* =========================================================
   FIND PREDICTION
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
   CREATE PREDICTION
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
    calculateV5(
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
        LIMIT 300
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
        EXACT PERIOD ONLY.
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


        if (actual) {

          actualResult =
            actual.result;


          status =
            row.prediction ===
            actualResult
              ? "WIN"
              : "LOSS";

        } else if (
          row.actual_result ===
            "BIG" ||
          row.actual_result ===
            "SMALL"
        ) {

          actualResult =
            row.actual_result;


          status =
            row.prediction ===
            actualResult
              ? "WIN"
              : "LOSS";

        }


        return {

          id:
            row.id,

          target_issue:
            issue,

          prediction:
            row.prediction,

          confidence:
            row.confidence,

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
   BUILD STATE
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
    calculateV5(
      history
    );


  const predictions =
    await last30(
      history
    );


  const stats =
    await getStats();


  const prediction =
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

        };


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
      provider.lastUpdated || 0,

    provider_last_updated:
      provider.lastUpdated || 0,

    history,

    prediction,

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
   ACCESS CHECK
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

  const clean =
    path.basename(
      filename
    );


  return path.join(
    ROOT,
    clean
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
           ACCESS CHECK
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
            await checkAccess(req);


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
            await checkAccess(req);


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
            calculateV5(
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

              number_model:
                "DISABLED",

              features:
                model.features

            }
          );

          return;

        }


        /* ================================================
           ADMIN KEYS — GET
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
           ADMIN KEYS — CREATE
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
           ADMIN KEYS — DELETE
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
        `Game: ${GAME_URL}`
      );

      console.log(
        `Model: ${MODEL_VERSION}`
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
