"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

/* =========================================================
   CONFIG
========================================================= */

const PORT = Number(process.env.PORT || 10000);

const DATABASE_URL =
  process.env.DATABASE_URL || "";

const ADMIN_KEY =
  process.env.ADMIN_KEY || "dy4427574";

const WINGOBOT_TOKEN =
  process.env.WINGOBOT_TOKEN || "";

const WINGOBOT_URL =
  "https://api.wingobot.com/v2/30-sec-game-history";

const GAME_URL =
  "https://www.shreewin38.com/#/register?invitationCode=88523152383";

const ROUND_SECONDS = 30;

const PROVIDER_POLL_MS = 3000;

const MAX_HISTORY = 500;


/* =========================================================
   DATABASE
========================================================= */

const pool = new Pool({
  connectionString: DATABASE_URL,

  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false
});


/* =========================================================
   LIVE STATE
========================================================= */

let liveState = {

  ready: false,

  providerOnline: false,

  latestSettledIssue: null,

  currentIssue: null,

  targetIssue: null,

  prediction: null,

  number: null,

  confidence: 0,

  status: "WAITING",

  countdown: ROUND_SECONDS,

  countdownAnchor: Date.now(),

  analysis: {

    trendDirection: "NONE",

    trendStrength: 0,

    trendAge: 0,

    trendStatus: "NO CLEAR TREND",

    continuationScore: 50,

    breakRisk: 50,

    transitionScore: 50,

    shortTrend: "NONE",

    mediumTrend: "NONE",

    numberPressure: "BALANCED",

    historicalMatches: 0,

    historicalScore: 50,

    modelAgreement: 0,

    patternScore: 0,

    backtestSamples: 0,

    avgModelAccuracy: null,

    bigScore: 50,

    smallScore: 50,

    numberCandidates: []

  },

  predictionHistory: [],

  wins: 0,

  losses: 0,

  updatedAt: 0,

  error: null
};


let providerHistory = [];

let providerCurrentIssue = null;

let lastTargetIssue = null;

let providerBusy = false;


/* =========================================================
   BASIC HELPERS
========================================================= */

function now() {
  return Date.now();
}


function str(value) {

  if (
    value === null ||
    value === undefined
  ) {
    return "";
  }

  return String(value).trim();
}


function clamp(value, min, max) {

  return Math.max(
    min,
    Math.min(
      max,
      Number(value) || 0
    )
  );
}


function round(value, digits = 2) {

  const p = Math.pow(10, digits);

  return (
    Math.round(
      Number(value || 0) * p
    ) / p
  );
}


/* =========================================================
   SIDE HELPERS
========================================================= */

function normalizeSide(value) {

  const v =
    str(value).toUpperCase();

  if (
    v === "BIG" ||
    v === "B"
  ) {
    return "BIG";
  }

  if (
    v === "SMALL" ||
    v === "S"
  ) {
    return "SMALL";
  }

  return null;
}


function sideFromNumber(number) {

  const n = Number(number);

  if (
    !Number.isInteger(n) ||
    n < 0 ||
    n > 9
  ) {
    return null;
  }

  return n >= 5
    ? "BIG"
    : "SMALL";
}


function normalizeNumber(value) {

  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const n = Number(value);

  if (
    !Number.isInteger(n) ||
    n < 0 ||
    n > 9
  ) {
    return null;
  }

  return n;
}


/* =========================================================
   ISSUE HELPERS
========================================================= */

function issueParts(issue) {

  const value = str(issue);

  if (!value) {
    return null;
  }

  const match =
    value.match(/^(.*?)(\d+)$/);

  if (!match) {

    return {
      prefix: value,
      number: null
    };
  }

  return {

    prefix: match[1],

    number: match[2]
  };
}


function compareIssues(a, b) {

  const aa = issueParts(a);

  const bb = issueParts(b);

  if (!aa || !bb) {
    return 0;
  }

  if (
    aa.number !== null &&
    bb.number !== null &&
    aa.prefix === bb.prefix
  ) {

    try {

      const na = BigInt(aa.number);

      const nb = BigInt(bb.number);

      if (na > nb) return 1;

      if (na < nb) return -1;

      return 0;

    } catch {

      return str(a).localeCompare(
        str(b)
      );
    }
  }

  return str(a).localeCompare(
    str(b)
  );
}


function incrementIssue(issue) {

  const p =
    issueParts(issue);

  if (
    !p ||
    p.number === null
  ) {
    return null;
  }

  try {

    const next =
      BigInt(p.number) + 1n;

    return (
      p.prefix +
      next
        .toString()
        .padStart(
          p.number.length,
          "0"
        )
    );

  } catch {

    return null;
  }
}


/* =========================================================
   DATABASE INIT
========================================================= */

async function initDatabase() {

  if (!DATABASE_URL) {

    throw new Error(
      "DATABASE_URL is missing."
    );
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

      target_issue TEXT UNIQUE NOT NULL,

      prediction TEXT,

      predicted_number INTEGER,

      confidence NUMERIC DEFAULT 0,

      status TEXT DEFAULT 'WAITING',

      outcome TEXT DEFAULT 'PENDING',

      actual_number INTEGER,

      actual_side TEXT,

      analysis JSONB DEFAULT '{}'::jsonb,

      created_at BIGINT NOT NULL,

      settled_at BIGINT DEFAULT 0

    )
  `);


  await pool.query(`
    ALTER TABLE prediction_records
    ADD COLUMN IF NOT EXISTS target_issue TEXT
  `);


  await pool.query(`
    ALTER TABLE prediction_records
    ADD COLUMN IF NOT EXISTS prediction TEXT
  `);


  await pool.query(`
    ALTER TABLE prediction_records
    ADD COLUMN IF NOT EXISTS predicted_number INTEGER
  `);


  await pool.query(`
    ALTER TABLE prediction_records
    ADD COLUMN IF NOT EXISTS confidence NUMERIC DEFAULT 0
  `);


  await pool.query(`
    ALTER TABLE prediction_records
    ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'WAITING'
  `);


  await pool.query(`
    ALTER TABLE prediction_records
    ADD COLUMN IF NOT EXISTS outcome TEXT DEFAULT 'PENDING'
  `);


  await pool.query(`
    ALTER TABLE prediction_records
    ADD COLUMN IF NOT EXISTS actual_number INTEGER
  `);


  await pool.query(`
    ALTER TABLE prediction_records
    ADD COLUMN IF NOT EXISTS actual_side TEXT
  `);


  await pool.query(`
    ALTER TABLE prediction_records
    ADD COLUMN IF NOT EXISTS analysis JSONB DEFAULT '{}'::jsonb
  `);


  await pool.query(`
    ALTER TABLE prediction_records
    ADD COLUMN IF NOT EXISTS created_at BIGINT DEFAULT 0
  `);


  await pool.query(`
    ALTER TABLE prediction_records
    ADD COLUMN IF NOT EXISTS settled_at BIGINT DEFAULT 0
  `);


  try {

    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
      prediction_records_target_issue_unique
      ON prediction_records(target_issue)
    `);

  } catch (error) {

    console.log(
      "Prediction index:",
      error.message
    );
  }
}


/* =========================================================
   FETCH WINGOBOT
========================================================= */

async function fetchWingo() {

  if (!WINGOBOT_TOKEN) {

    throw new Error(
      "WINGOBOT_TOKEN is missing."
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
              `Bearer ${WINGOBOT_TOKEN}`,

            Accept:
              "application/json"

          },

          signal:
            controller.signal
        }
      );


    if (!response.ok) {

      const text =
        await response.text();

      throw new Error(
        `WingoBot HTTP ${response.status}: ${text.slice(0, 200)}`
      );
    }


    return await response.json();

  } finally {

    clearTimeout(timeout);
  }
}


/* =========================================================
   NORMALIZE HISTORY
========================================================= */

function normalizeProvider(data) {

  const current =
    data?.current || {};


  const raw =
    Array.isArray(data?.history)
      ? data.history
      : [];


  const rows =
    raw
      .map(row => {

        const issue =
          str(
            row.issueNumber ??
            row.issue_number ??
            row.period
          );


        const number =
          normalizeNumber(
            row.number ??
            row.result ??
            row.winNumber
          );


        let side =
          normalizeSide(
            row.side ??
            row.resultSide ??
            row.bigSmall
          );


        if (
          !side &&
          number !== null
        ) {

          side =
            sideFromNumber(
              number
            );
        }


        return {

          issueNumber: issue,

          number,

          side,

          colour:
            str(
              row.colour ??
              row.color
            ),

          premium:
            row.premium ?? null,

          sum:
            row.sum ?? null
        };

      })

      .filter(
        row =>
          row.issueNumber &&
          row.number !== null &&
          row.side
      );


  rows.sort(
    (a, b) =>
      compareIssues(
        b.issueNumber,
        a.issueNumber
      )
  );


  const seen =
    new Set();

  const unique = [];


  for (
    const row of rows
  ) {

    if (
      seen.has(
        row.issueNumber
      )
    ) {
      continue;
    }


    seen.add(
      row.issueNumber
    );


    unique.push(row);
  }


  return {

    currentIssue:
      str(
        current.issueNumber ??
        current.issue_number ??
        current.period
      ) || null,

    history:
      unique.slice(
        0,
        MAX_HISTORY
      ),

    stats:
      data.stats || {}
  };
}


/* =========================================================
   TARGET RESOLVER
========================================================= */

function resolveTarget(
  currentIssue,
  history
) {

  const latest =
    history?.[0]?.issueNumber ||
    null;


  if (!latest) {

    return {

      latestSettledIssue: null,

      targetIssue:
        currentIssue
    };
  }


  /*
    IMPORTANT:

    Latest history row = latest settled result.

    If provider current is ahead,
    current becomes target.

    Otherwise next period is target.
  */

  if (
    currentIssue &&
    compareIssues(
      currentIssue,
      latest
    ) > 0
  ) {

    return {

      latestSettledIssue:
        latest,

      targetIssue:
        currentIssue
    };
  }


  return {

    latestSettledIssue:
      latest,

    targetIssue:
      incrementIssue(
        latest
      ) ||
      currentIssue ||
      latest
  };
}


/* =========================================================
   RECENT ROWS
========================================================= */

function recent(
  history,
  count
) {

  return (
    Array.isArray(history)
      ? history
      : []
  )
  .filter(
    row =>
      row &&
      row.number !== null &&
      row.side
  )
  .slice(
    0,
    count
  );
}


/* =========================================================
   SIDE COUNT
========================================================= */

function sideCounts(rows) {

  let big = 0;

  let small = 0;


  for (
    const row of rows
  ) {

    if (
      row.side === "BIG"
    ) {

      big++;

    } else if (
      row.side === "SMALL"
    ) {

      small++;
    }
  }


  return {
    big,
    small
  };
}


/* =========================================================
   SHORT TREND
========================================================= */

function shortTrend(history) {

  const rows =
    recent(
      history,
      5
    );


  if (
    rows.length < 3
  ) {

    return {

      direction: "NONE",

      strength: 0
    };
  }


  const counts =
    sideCounts(rows);


  const total =
    counts.big +
    counts.small;


  const bigPct =
    total
      ? counts.big /
        total *
        100
      : 50;


  const smallPct =
    total
      ? counts.small /
        total *
        100
      : 50;


  if (
    Math.abs(
      bigPct -
      smallPct
    ) < 20
  ) {

    return {

      direction: "MIXED",

      strength:
        Math.round(
          Math.abs(
            bigPct -
            smallPct
          )
        )
    };
  }


  return {

    direction:
      bigPct >
      smallPct
        ? "BIG"
        : "SMALL",

    strength:
      Math.round(
        Math.abs(
          bigPct -
          smallPct
        )
      )
  };
}


/* =========================================================
   MEDIUM TREND
========================================================= */

function mediumTrend(history) {

  const rows =
    recent(
      history,
      15
    );


  if (
    rows.length < 7
  ) {

    return {

      direction: "NONE",

      strength: 0
    };
  }


  const counts =
    sideCounts(rows);


  const total =
    counts.big +
    counts.small;


  const bigPct =
    counts.big /
    total *
    100;


  const smallPct =
    counts.small /
    total *
    100;


  if (
    Math.abs(
      bigPct -
      smallPct
    ) < 15
  ) {

    return {

      direction: "MIXED",

      strength:
        Math.round(
          Math.abs(
            bigPct -
            smallPct
          )
        )
    };
  }


  return {

    direction:
      bigPct >
      smallPct
        ? "BIG"
        : "SMALL",

    strength:
      Math.round(
        Math.abs(
          bigPct -
          smallPct
        )
      )
  };
}


/* =========================================================
   TREND AGE
========================================================= */

function trendAge(history) {

  const rows =
    recent(
      history,
      30
    );


  if (!rows.length) {

    return {

      side: null,

      age: 0
    };
  }


  const first =
    rows[0].side;


  let age = 0;


  for (
    const row of rows
  ) {

    if (
      row.side === first
    ) {

      age++;

    } else {

      break;
    }
  }


  return {

    side: first,

    age
  };
}


/* =========================================================
   TRANSITION MODEL
========================================================= */

function transitionModel(
  history
) {

  const rows =
    recent(
      history,
      60
    );


  if (
    rows.length < 8
  ) {

    return {

      next: "NONE",

      continuation: 50,

      reversal: 50,

      score: 50
    };
  }


  const last =
    rows[0].side;


  let same = 0;

  let opposite = 0;


  for (
    let i = 1;
    i < rows.length;
    i++
  ) {

    /*
      rows are newest first.

      If rows[i] is same side as current,
      it represents historical occurrences where
      that side was followed by rows[i-1].
    */

    if (
      rows[i].side === last
    ) {

      if (
        rows[i - 1].side === last
      ) {

        same++;

      } else {

        opposite++;
      }
    }
  }


  const total =
    same +
    opposite;


  if (!total) {

    return {

      next: "NONE",

      continuation: 50,

      reversal: 50,

      score: 50
    };
  }


  const continuation =
    same /
    total *
    100;


  const reversal =
    opposite /
    total *
    100;


  return {

    next:
      continuation >=
      reversal
        ? last
        : last === "BIG"
          ? "SMALL"
          : "BIG",

    continuation:
      Math.round(
        continuation
      ),

    reversal:
      Math.round(
        reversal
      ),

    score:
      Math.round(
        continuation
      )
  };
}


/* =========================================================
   NUMBER DISTRIBUTION
========================================================= */

function numberDistribution(
  history
) {

  const rows =
    recent(
      history,
      40
    );


  const counts =
    Array(10).fill(0);


  rows.forEach(
    (
      row,
      index
    ) => {

      const weight =
        Math.max(
          1,
          rows.length -
          index
        );


      counts[
        row.number
      ] += weight;
    }
  );


  const total =
    counts.reduce(
      (a, b) =>
        a + b,
      0
    );


  const big =
    counts
      .slice(5, 10)
      .reduce(
        (a, b) =>
          a + b,
        0
      );


  const small =
    counts
      .slice(0, 5)
      .reduce(
        (a, b) =>
          a + b,
        0
      );


  return {

    counts,

    big,

    small,

    bigPct:
      total
        ? big /
          total *
          100
        : 50,

    smallPct:
      total
        ? small /
          total *
          100
        : 50
  };
}


/* =========================================================
   TREND BREAK DETECTOR
========================================================= */

function trendBreakModel(
  history
) {

  const rows =
    recent(
      history,
      30
    );


  if (
    rows.length < 8
  ) {

    return {

      risk: 50,

      status:
        "NOT ENOUGH DATA"
    };
  }


  const age =
    trendAge(
      history
    );


  const short =
    shortTrend(
      history
    );


  const medium =
    mediumTrend(
      history
    );


  const transition =
    transitionModel(
      history
    );


  let risk = 25;


  /*
    Long streak increases break risk,
    but we do NOT assume reversal is guaranteed.
  */

  if (
    age.age >= 3
  ) {

    risk +=
      Math.min(
        20,
        (
          age.age -
          2
        ) *
        5
      );
  }


  if (
    age.age >= 6
  ) {

    risk += 10;
  }


  /*
    Short and medium trend disagreement.
  */

  if (
    short.direction !==
      "MIXED" &&
    medium.direction !==
      "MIXED" &&
    short.direction !==
      medium.direction
  ) {

    risk += 15;
  }


  /*
    Historical transition reversal evidence.
  */

  if (
    transition.reversal >= 60
  ) {

    risk += 12;
  }


  /*
    Very weak short trend = more uncertainty.
  */

  if (
    short.strength < 20
  ) {

    risk += 8;
  }


  risk =
    clamp(
      risk,
      5,
      90
    );


  let status =
    "TREND CONTINUING";


  if (
    risk >= 70
  ) {

    status =
      "HIGH BREAK RISK";

  } else if (
    risk >= 55
  ) {

    status =
      "TREND WEAKENING";

  } else if (
    risk <= 25
  ) {

    status =
      "TREND STABLE";
  }


  return {

    risk:
      Math.round(risk),

    status
  };
}


/* =========================================================
   HISTORICAL PATTERN MODEL
========================================================= */

function historicalPattern(
  history
) {

  const rows =
    recent(
      history,
      120
    );


  if (
    rows.length < 12
  ) {

    return {

      matches: 0,

      bigPct: 50,

      smallPct: 50,

      score: 50
    };
  }


  const length =
    5;


  const current =
    rows
      .slice(
        0,
        length
      )
      .map(
        r => r.side
      );


  let matches = 0;

  let big = 0;

  let small = 0;


  /*
    Compare older sequences.

    At index i, rows[i..i+4] is an old pattern.
    The following row represents what happened next.
  */

  for (
    let i = 1;
    i <=
      rows.length -
      length -
      1;
    i++
  ) {

    let similarity = 0;


    for (
      let j = 0;
      j < length;
      j++
    ) {

      if (
        rows[i + j].side ===
        current[j]
      ) {

        similarity++;
      }
    }


    /*
      Require strong similarity.
    */

    if (
      similarity >= 4
    ) {

      const next =
        rows[
          i + length
        ];


      if (!next) {
        continue;
      }


      matches++;


      if (
        next.side === "BIG"
      ) {

        big++;

      } else {

        small++;
      }
    }
  }


  if (!matches) {

    return {

      matches: 0,

      bigPct: 50,

      smallPct: 50,

      score: 50
    };
  }


  const bigPct =
    big /
    matches *
    100;


  const smallPct =
    small /
    matches *
    100;


  return {

    matches,

    bigPct:
      Math.round(bigPct),

    smallPct:
      Math.round(smallPct),

    score:
      Math.round(
        Math.max(
          bigPct,
          smallPct
        )
      )
  };
}


/* =========================================================
   STREAK STRUCTURE
========================================================= */

function streakStructure(
  history
) {

  const rows =
    recent(
      history,
      30
    );


  if (
    rows.length < 6
  ) {

    return {

      type: "UNKNOWN",

      strength: 0
    };
  }


  const sequence =
    rows.map(
      r => r.side
    );


  const first =
    sequence[0];


  let streak = 0;


  for (
    const side of sequence
  ) {

    if (
      side === first
    ) {

      streak++;

    } else {

      break;
    }
  }


  /*
    Alternating detection.
  */

  let alternating = true;


  for (
    let i = 1;
    i < sequence.length;
    i++
  ) {

    if (
      sequence[i] ===
      sequence[i - 1]
    ) {

      alternating = false;

      break;
    }
  }


  if (alternating) {

    return {

      type:
        "ALTERNATING",

      strength: 80
    };
  }


  if (
    streak >= 6
  ) {

    return {

      type:
        "LONG STREAK",

      strength:
        Math.min(
          100,
          60 +
          streak * 5
        )
    };
  }


  if (
    streak >= 3
  ) {

    return {

      type:
        "SHORT STREAK",

      strength:
        50 +
        streak * 5
    };
  }


  return {

    type:
      "MIXED",

    strength: 30
  };
}


/* =========================================================
   CORE SIDE MODEL
========================================================= */

function buildSideModel(
  history
) {

  const short =
    shortTrend(
      history
    );


  const medium =
    mediumTrend(
      history
    );


  const age =
    trendAge(
      history
    );


  const transition =
    transitionModel(
      history
    );


  const breakModel =
    trendBreakModel(
      history
    );


  const historical =
    historicalPattern(
      history
    );


  const distribution =
    numberDistribution(
      history
    );


  const streak =
    streakStructure(
      history
    );


  let big = 50;

  let small = 50;


  /*
    ======================================================
    SIGNAL 1 — SHORT TREND
    ======================================================
  */

  if (
    short.direction === "BIG"
  ) {

    big +=
      short.strength *
      0.30;

  } else if (
    short.direction === "SMALL"
  ) {

    small +=
      short.strength *
      0.30;
  }


  /*
    ======================================================
    SIGNAL 2 — MEDIUM TREND
    ======================================================
  */

  if (
    medium.direction === "BIG"
  ) {

    big +=
      medium.strength *
      0.22;

  } else if (
    medium.direction === "SMALL"
  ) {

    small +=
      medium.strength *
      0.22;
  }


  /*
    ======================================================
    SIGNAL 3 — TRANSITIONS
    ======================================================
  */

  if (
    transition.next === "BIG"
  ) {

    big +=
      (
        transition.continuation -
        50
      ) *
      0.22;

  } else if (
    transition.next === "SMALL"
  ) {

    small +=
      (
        transition.continuation -
        50
      ) *
      0.22;
  }


  /*
    ======================================================
    SIGNAL 4 — NUMBER DISTRIBUTION
    ======================================================
  */

  big +=
    (
      distribution.bigPct -
      50
    ) *
    0.10;


  small +=
    (
      distribution.smallPct -
      50
    ) *
    0.10;


  /*
    ======================================================
    SIGNAL 5 — HISTORICAL PATTERN
    ======================================================
  */

  if (
    historical.matches >= 2
  ) {

    big +=
      (
        historical.bigPct -
        50
      ) *
      0.18;


    small +=
      (
        historical.smallPct -
        50
      ) *
      0.18;
  }


  /*
    ======================================================
    SIGNAL 6 — TREND BREAK
    ======================================================

    Break risk does NOT automatically mean reverse.

    If reversal evidence is strong, opposite gets weight.
    Otherwise it mainly reduces confidence.
  */

  if (
    breakModel.risk >= 65
  ) {

    const current =
      age.side;


    const reversal =
      current === "BIG"
        ? "SMALL"
        : "BIG";


    const transitionReversal =
      transition.reversal;


    if (
      transitionReversal >= 60
    ) {

      if (
        reversal === "BIG"
      ) {

        big += 8;

      } else {

        small += 8;
      }

    } else {

      /*
        Reduce both certainty levels.
      */

      big -= 3;

      small -= 3;
    }
  }


  /*
    ======================================================
    LONG STREAK PROTECTION
    ======================================================

    Never blindly reverse a long streak.
  */

  if (
    streak.type ===
      "LONG STREAK"
  ) {

    /*
      Only confidence reduction is applied.
      Direction stays evidence-driven.
    */

    big -= 2;

    small -= 2;
  }


  big =
    clamp(
      big,
      0,
      100
    );


  small =
    clamp(
      small,
      0,
      100
    );


  const total =
    big +
    small;


  const bigScore =
    total
      ? big /
        total *
        100
      : 50;


  const smallScore =
    total
      ? small /
        total *
        100
      : 50;


  const prediction =
    bigScore >=
    smallScore
      ? "BIG"
      : "SMALL";


  const selected =
    prediction === "BIG"
      ? bigScore
      : smallScore;


  const other =
    prediction === "BIG"
      ? smallScore
      : bigScore;


  const margin =
    Math.abs(
      selected -
      other
    );


  /*
    ======================================================
    MODEL AGREEMENT
    ======================================================
  */

  const signals = [];


  if (
    short.direction !==
    "MIXED" &&
    short.direction !==
    "NONE"
  ) {

    signals.push(
      short.direction
    );
  }


  if (
    medium.direction !==
    "MIXED" &&
    medium.direction !==
    "NONE"
  ) {

    signals.push(
      medium.direction
    );
  }


  if (
    transition.next !==
    "NONE"
  ) {

    signals.push(
      transition.next
    );
  }


  if (
    historical.matches >= 2
  ) {

    signals.push(
      historical.bigPct >=
      historical.smallPct
        ? "BIG"
        : "SMALL"
    );
  }


  signals.push(
    distribution.bigPct >=
    distribution.smallPct
      ? "BIG"
      : "SMALL"
  );


  let agreement =
    signals.length
      ? signals.filter(
          s =>
            s === prediction
        ).length /
        signals.length *
        100
      : 50;


  agreement =
    Math.round(
      agreement
    );


  /*
    ======================================================
    CONFIDENCE
    ======================================================
  */

  let confidence =
    50 +
    margin *
    0.75;


  confidence +=
    (
      agreement -
      50
    ) *
    0.10;


  /*
    Break risk reduces confidence when uncertain.
  */

  if (
    breakModel.risk >= 60
  ) {

    confidence -=
      (
        breakModel.risk -
        55
      ) *
      0.20;
  }


  /*
    Conflicting short/medium trend.
  */

  if (
    short.direction !==
      "MIXED" &&
    medium.direction !==
      "MIXED" &&
    short.direction !==
      medium.direction
  ) {

    confidence -= 5;
  }


  confidence =
    clamp(
      Math.round(
        confidence
      ),
      50,
      89
    );


  /*
    ======================================================
    TREND STATUS
    ======================================================
  */

  let trendDirection =
    medium.direction;


  if (
    short.direction !==
      "MIXED" &&
    short.direction !==
      "NONE" &&
    medium.direction ===
      "MIXED"
  ) {

    trendDirection =
      short.direction;
  }


  if (
    trendDirection ===
      "NONE"
  ) {

    trendDirection =
      "NONE";
  }


  let trendStatus =
    "NO CLEAR TREND";


  if (
    breakModel.risk >= 70
  ) {

    trendStatus =
      "POSSIBLE BREAK";

  } else if (
    breakModel.risk >= 55
  ) {

    trendStatus =
      "TREND WEAKENING";

  } else if (
    trendDirection !==
      "NONE" &&
    trendDirection !==
      "MIXED"
  ) {

    if (
      age.age >= 4
    ) {

      trendStatus =
        "TREND CONTINUING";

    } else {

      trendStatus =
        "NEW TREND";
    }
  }


  const patternScore =
    Math.round(
      clamp(
        (
          margin *
          1.2
        ) +
        (
          agreement *
          0.35
        ) +
        (
          historical.matches *
          1.5
        ),
        0,
        100
      )
    );


  return {

    prediction,

    confidence,

    bigScore:
      round(bigScore),

    smallScore:
      round(smallScore),

    trendDirection,

    trendStrength:
      Math.round(
        Math.max(
          short.strength,
          medium.strength
        )
      ),

    trendAge:
      age.age,

    trendSide:
      age.side,

    trendStatus,

    continuationScore:
      transition.continuation,

    breakRisk:
      breakModel.risk,

    transitionScore:
      transition.score,

    shortTrend:
      short.direction,

    mediumTrend:
      medium.direction,

    numberPressure:
      distribution.bigPct >
      distribution.smallPct
        ? "BIG PRESSURE"
        : distribution.smallPct >
          distribution.bigPct
          ? "SMALL PRESSURE"
          : "BALANCED",

    historicalMatches:
      historical.matches,

    historicalScore:
      historical.score,

    modelAgreement:
      agreement,

    patternScore,

    streakType:
      streak.type,

    streakStrength:
      Math.round(
        streak.strength
      ),

    transitionNext:
      transition.next,

    signals
  };
}


/* =========================================================
   NUMBER MODEL
========================================================= */

function buildNumberModel(
  history,
  predictedSide
) {

  const rows =
    recent(
      history,
      70
    );


  const valid =
    predictedSide === "BIG"
      ? [5, 6, 7, 8, 9]
      : [0, 1, 2, 3, 4];


  const scores =
    Object.fromEntries(
      valid.map(
        n => [
          n,
          1
        ]
      )
    );


  /*
    Recent weighted frequency.
  */

  rows.forEach(
    (
      row,
      index
    ) => {

      if (
        !valid.includes(
          row.number
        )
      ) {
        return;
      }


      const weight =
        (
          rows.length -
          index
        ) /
        rows.length;


      scores[
        row.number
      ] +=
        weight * 8;
    }
  );


  /*
    Same-side historical frequency.
  */

  rows.forEach(
    (
      row,
      index
    ) => {

      if (
        row.side !==
          predictedSide ||
        !valid.includes(
          row.number
        )
      ) {
        return;
      }


      const weight =
        (
          rows.length -
          index
        ) /
        rows.length;


      scores[
        row.number
      ] +=
        weight * 5;
    }
  );


  /*
    Latest-number transition.
  */

  const latest =
    rows[0]?.number;


  if (
    latest !== undefined &&
    latest !== null
  ) {

    for (
      let i = 1;
      i < rows.length;
      i++
    ) {

      if (
        rows[i].number ===
        latest
      ) {

        const next =
          rows[
            i - 1
          ];


        if (
          next &&
          valid.includes(
            next.number
          )
        ) {

          scores[
            next.number
          ] += 3;
        }
      }
    }
  }


  const candidates =
    valid
      .map(
        number => ({

          number,

          score:
            round(
              scores[number]
            )

        })
      )
      .sort(
        (a, b) =>
          b.score -
          a.score
      );


  const best =
    candidates[0];


  const total =
    candidates.reduce(
      (
        sum,
        item
      ) =>
        sum +
        item.score,
      0
    );


  return {

    number:
      best?.number ?? null,

    score:
      best?.score ?? 0,

    share:
      total
        ? round(
            (
              best.score /
              total
            ) *
            100
          )
        : 20,

    candidates
  };
}


/* =========================================================
   BACKTEST
========================================================= */

function lightModel(
  history
) {

  const rows =
    recent(
      history,
      12
    );


  if (
    rows.length < 5
  ) {

    return null;
  }


  let big = 0;

  let small = 0;


  rows.forEach(
    (
      row,
      index
    ) => {

      const weight =
        rows.length -
        index;


      if (
        row.side ===
        "BIG"
      ) {

        big +=
          weight;

      } else {

        small +=
          weight;
      }
    }
  );


  /*
    Recent number mean.
  */

  let sum = 0;

  let weightSum = 0;


  rows.forEach(
    (
      row,
      index
    ) => {

      const weight =
        rows.length -
        index;


      sum +=
        row.number *
        weight;


      weightSum +=
        weight;
    }
  );


  const mean =
    weightSum
      ? sum /
        weightSum
      : 4.5;


  if (
    mean >
    4.5
  ) {

    big += 2;

  } else if (
    mean <
    4.5
  ) {

    small += 2;
  }


  return (
    big >=
    small
      ? "BIG"
      : "SMALL"
  );
}


function calculateBacktest(
  history
) {

  const rows =
    recent(
      history,
      180
    );


  if (
    rows.length < 20
  ) {

    return {

      samples: 0,

      accuracy: null
    };
  }


  const chronological =
    [...rows].reverse();


  let correct = 0;

  let samples = 0;


  const start =
    Math.max(
      10,
      chronological.length -
      70
    );


  for (
    let i = start;
    i < chronological.length;
    i++
  ) {

    const training =
      chronological
        .slice(
          0,
          i
        )
        .reverse();


    const actual =
      chronological[i];


    const predicted =
      lightModel(
        training
      );


    if (
      !predicted ||
      !actual
    ) {

      continue;
    }


    samples++;


    if (
      predicted ===
      actual.side
    ) {

      correct++;
    }
  }


  return {

    samples,

    accuracy:
      samples
        ? Math.round(
            correct /
            samples *
            100
          )
        : null
  };
}


/* =========================================================
   CREATE NEW PREDICTION
========================================================= */

function createPrediction(
  history
) {

  if (
    !Array.isArray(history) ||
    history.length < 5
  ) {

    return {

      prediction: null,

      number: null,

      confidence: 0,

      status:
        "WAITING FOR DATA",

      analysis:
        liveState.analysis
    };
  }


  const side =
    buildSideModel(
      history
    );


  const number =
    buildNumberModel(
      history,
      side.prediction
    );


  const backtest =
    calculateBacktest(
      history
    );


  let status =
    "SIGNAL READY";


  if (
    side.confidence < 60
  ) {

    status =
      "LOW CONFIDENCE";

  } else if (
    side.confidence < 70
  ) {

    status =
      "MODERATE LEAN";

  } else if (
    side.breakRisk >= 70
  ) {

    status =
      "BREAK RISK HIGH";

  } else if (
    side.confidence >= 80
  ) {

    status =
      "STRONGER LEAN";
  }


  return {

    prediction:
      side.prediction,

    number:
      number.number,

    confidence:
      side.confidence,

    status,

    analysis: {

      trendDirection:
        side.trendDirection,

      trendStrength:
        side.trendStrength,

      trendAge:
        side.trendAge,

      trendSide:
        side.trendSide,

      trendStatus:
        side.trendStatus,

      continuationScore:
        side.continuationScore,

      breakRisk:
        side.breakRisk,

      transitionScore:
        side.transitionScore,

      shortTrend:
        side.shortTrend,

      mediumTrend:
        side.mediumTrend,

      numberPressure:
        side.numberPressure,

      historicalMatches:
        side.historicalMatches,

      historicalScore:
        side.historicalScore,

      modelAgreement:
        side.modelAgreement,

      patternScore:
        side.patternScore,

      streakType:
        side.streakType,

      streakStrength:
        side.streakStrength,

      transitionNext:
        side.transitionNext,

      bigScore:
        side.bigScore,

      smallScore:
        side.smallScore,

      backtestSamples:
        backtest.samples,

      avgModelAccuracy:
        backtest.accuracy,

      numberShare:
        number.share,

      numberCandidates:
        number.candidates,

      signals:
        side.signals
    }
  };
}


/* =========================================================
   SAVE PREDICTION
========================================================= */

async function savePrediction(
  targetIssue,
  prediction
) {

  if (
    !targetIssue ||
    !prediction?.prediction
  ) {

    return null;
  }


  const result =
    await pool.query(
      `
      INSERT INTO prediction_records
      (
        target_issue,
        prediction,
        predicted_number,
        confidence,
        status,
        outcome,
        actual_number,
        actual_side,
        analysis,
        created_at,
        settled_at
      )
      VALUES
      (
        $1,
        $2,
        $3,
        $4,
        $5,
        'PENDING',
        NULL,
        NULL,
        $6::jsonb,
        $7,
        0
      )
      ON CONFLICT
      (target_issue)
      DO NOTHING
      RETURNING *
      `,
      [

        targetIssue,

        prediction.prediction,

        prediction.number,

        prediction.confidence,

        prediction.status,

        JSON.stringify(
          prediction.analysis || {}
        ),

        now()

      ]
    );


  if (
    result.rowCount
  ) {

    return result.rows[0];
  }


  const existing =
    await pool.query(
      `
      SELECT *
      FROM prediction_records
      WHERE target_issue = $1
      LIMIT 1
      `,
      [targetIssue]
    );


  return (
    existing.rows[0] ||
    null
  );
}


/* =========================================================
   SETTLE EXACT PERIOD
========================================================= */

async function settlePredictions(
  history
) {

  if (
    !history?.length
  ) {
    return;
  }


  const actualMap =
    new Map();


  for (
    const row of history
  ) {

    actualMap.set(
      row.issueNumber,
      row
    );
  }


  const pending =
    await pool.query(`
      SELECT *
      FROM prediction_records
      WHERE outcome = 'PENDING'
      ORDER BY id ASC
      LIMIT 200
    `);


  for (
    const prediction
    of pending.rows
  ) {

    const actual =
      actualMap.get(
        prediction.target_issue
      );


    /*
      EXACT TARGET MATCH ONLY.
    */

    if (!actual) {
      continue;
    }


    const predicted =
      normalizeSide(
        prediction.prediction
      );


    const actualSide =
      normalizeSide(
        actual.side
      );


    if (
      !predicted ||
      !actualSide
    ) {
      continue;
    }


    const outcome =
      predicted ===
      actualSide
        ? "WIN"
        : "LOSS";


    await pool.query(
      `
      UPDATE prediction_records

      SET
        outcome = $1,
        actual_number = $2,
        actual_side = $3,
        settled_at = $4

      WHERE id = $5
      `,
      [

        outcome,

        actual.number,

        actualSide,

        now(),

        prediction.id

      ]
    );
  }
}


/* =========================================================
   GET PREDICTION RECORDS
========================================================= */

async function getPredictionRecords() {

  const result =
    await pool.query(`
      SELECT
        target_issue,
        prediction,
        predicted_number,
        confidence,
        status,
        outcome,
        actual_number,
        actual_side,
        analysis,
        created_at,
        settled_at

      FROM prediction_records

      ORDER BY id DESC

      LIMIT 30
    `);


  return result.rows;
}


/* =========================================================
   BUILD LAST 30
========================================================= */

async function buildHistoryDisplay(
  history
) {

  const predictions =
    await getPredictionRecords();


  const map =
    new Map();


  for (
    const p of predictions
  ) {

    map.set(
      p.target_issue,
      p
    );
  }


  return history
    .slice(
      0,
      30
    )
    .map(
      actual => {

        const p =
          map.get(
            actual.issueNumber
          );


        return {

          target_issue:
            actual.issueNumber,

          result_number:
            actual.number,

          result_side:
            actual.side,

          prediction:
            p?.prediction ||
            null,

          predicted_number:
            p?.predicted_number ??
            null,

          confidence:
            p
              ? Number(
                  p.confidence ||
                  0
                )
              : null,

          status:
            p?.status ||
            null,

          outcome:
            p?.outcome ||
            null,

          analysis:
            p?.analysis ||
            {}
        };
      }
    );
}


/* =========================================================
   STATS
========================================================= */

async function getStats() {

  const result =
    await pool.query(`
      SELECT

        COUNT(*) FILTER
        (
          WHERE outcome = 'WIN'
        ) AS wins,

        COUNT(*) FILTER
        (
          WHERE outcome = 'LOSS'
        ) AS losses

      FROM prediction_records
    `);


  const row =
    result.rows[0] || {};


  return {

    wins:
      Number(
        row.wins || 0
      ),

    losses:
      Number(
        row.losses || 0
      )
  };
}


/* =========================================================
   COUNTDOWN
========================================================= */

function getCountdown() {

  const elapsed =
    Math.floor(
      (
        now() -
        liveState.countdownAnchor
      ) /
      1000
    );


  return clamp(
    ROUND_SECONDS -
    elapsed,
    0,
    ROUND_SECONDS
  );
}


/* =========================================================
   MAIN PROVIDER UPDATE
========================================================= */

async function updateLiveState() {

  if (providerBusy) {
    return;
  }


  providerBusy = true;


  try {

    const raw =
      await fetchWingo();


    const normalized =
      normalizeProvider(
        raw
      );


    if (
      !normalized.history.length
    ) {

      throw new Error(
        "No valid settled history."
      );
    }


    providerHistory =
      normalized.history;


    providerCurrentIssue =
      normalized.currentIssue;


    const resolved =
      resolveTarget(
        providerCurrentIssue,
        providerHistory
      );


    const latest =
      resolved.latestSettledIssue;


    const target =
      resolved.targetIssue;


    liveState.providerOnline =
      true;


    liveState.error =
      null;


    liveState.latestSettledIssue =
      latest;


    liveState.currentIssue =
      providerCurrentIssue;


    liveState.targetIssue =
      target;


    /*
      FIRST settle old predictions.
    */

    await settlePredictions(
      providerHistory
    );


    /*
      ONLY create a new prediction when
      target period changes.
    */

    if (
      target &&
      target !==
      lastTargetIssue
    ) {

      lastTargetIssue =
        target;


      liveState.countdownAnchor =
        now();


      const prediction =
        createPrediction(
          providerHistory
        );


      if (
        prediction.prediction
      ) {

        await savePrediction(
          target,
          prediction
        );
      }
    }


    /*
      Load exact target prediction
      from DB.
    */

    if (target) {

      const result =
        await pool.query(
          `
          SELECT *
          FROM prediction_records
          WHERE target_issue = $1
          LIMIT 1
          `,
          [target]
        );


      if (
        result.rowCount
      ) {

        const p =
          result.rows[0];


        liveState.prediction =
          normalizeSide(
            p.prediction
          );


        liveState.number =
          p.predicted_number !==
          null
            ? Number(
                p.predicted_number
              )
            : null;


        liveState.confidence =
          Number(
            p.confidence || 0
          );


        liveState.status =
          str(
            p.status
          ) ||
          "SIGNAL READY";


        liveState.analysis =
          p.analysis || {};
      }
    }


    /*
      Stats.
    */

    const stats =
      await getStats();


    liveState.wins =
      stats.wins;


    liveState.losses =
      stats.losses;


    /*
      LAST 30.
    */

    liveState.predictionHistory =
      await buildHistoryDisplay(
        providerHistory
      );


    liveState.countdown =
      getCountdown();


    liveState.ready =
      true;


    liveState.updatedAt =
      now();

  } catch (error) {

    console.error(
      "Provider update:",
      error.message
    );


    liveState.providerOnline =
      false;


    liveState.error =
      error.message;


    liveState.countdown =
      getCountdown();


    liveState.updatedAt =
      now();

  } finally {

    providerBusy = false;
  }
}


/* =========================================================
   PUBLIC STATE
========================================================= */

async function publicState() {

  liveState.countdown =
    getCountdown();


  return {

    success: true,

    ready:
      liveState.ready,

    providerOnline:
      liveState.providerOnline,

    latestSettledIssue:
      liveState.latestSettledIssue,

    currentIssue:
      liveState.currentIssue,

    targetIssue:
      liveState.targetIssue,

    prediction:
      liveState.prediction,

    number:
      liveState.number,

    confidence:
      liveState.confidence,

    status:
      liveState.status,

    countdown:
      liveState.countdown,

    analysis:
      liveState.analysis,

    predictionHistory:
      liveState.predictionHistory,

    wins:
      liveState.wins,

    losses:
      liveState.losses,

    updatedAt:
      liveState.updatedAt
  };
}


/* =========================================================
   ACCESS KEY CHECK
========================================================= */

async function checkKey(
  accessKey,
  deviceId
) {

  if (
    !accessKey
  ) {

    return {

      success: false,

      error:
        "INVALID_ACCESS_KEY"
    };
  }


  if (
    !deviceId
  ) {

    return {

      success: false,

      error:
        "DEVICE_ID_REQUIRED"
    };
  }


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


  if (
    !result.rowCount
  ) {

    return {

      success: false,

      error:
        "INVALID_ACCESS_KEY"
    };
  }


  const key =
    result.rows[0];


  if (
    key.device_id &&
    key.device_id !==
    deviceId
  ) {

    return {

      success: false,

      error:
        "KEY_ALREADY_USED_ON_ANOTHER_DEVICE"
    };
  }


  await pool.query(
    `
    UPDATE access_keys

    SET
      device_id =
        COALESCE(
          device_id,
          $1
        ),

      last_seen = $2

    WHERE id = $3
    `,
    [
      deviceId,
      now(),
      key.id
    ]
  );


  return {

    success: true,

    key:
      key.access_key
  };
}


/* =========================================================
   ADMIN AUTH
========================================================= */

function isAdmin(req) {

  return (
    ADMIN_KEY &&
    req.headers[
      "x-admin-key"
    ] ===
    ADMIN_KEY
  );
}


/* =========================================================
   ADMIN KEYS
========================================================= */

async function createKey() {

  const accessKey =
    "DY-" +
    crypto
      .randomBytes(8)
      .toString(
        "hex"
      )
      .toUpperCase();


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
      (
        $1,
        NULL,
        $2,
        0
      )

      RETURNING *
      `,
      [
        accessKey,
        now()
      ]
    );


  return result.rows[0];
}


async function listKeys() {

  const result =
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


  return result.rows;
}


async function deleteKey(id) {

  const result =
    await pool.query(
      `
      DELETE FROM access_keys
      WHERE id = $1
      `,
      [id]
    );


  return result.rowCount > 0;
}


async function resetDevice(id) {

  const result =
    await pool.query(
      `
      UPDATE access_keys

      SET
        device_id = NULL,
        last_seen = 0

      WHERE id = $1

      RETURNING *
      `,
      [id]
    );


  return (
    result.rows[0] ||
    null
  );
}


/* =========================================================
   ADMIN STATUS
========================================================= */

async function adminStatus() {

  const stats =
    await getStats();


  return {

    success: true,

    serverTime:
      now(),

    providerOnline:
      liveState.providerOnline,

    historyCount:
      providerHistory.length,

    latestSettledIssue:
      liveState.latestSettledIssue,

    currentIssue:
      liveState.currentIssue,

    targetIssue:
      liveState.targetIssue,

    prediction:
      liveState.prediction,

    number:
      liveState.number,

    confidence:
      liveState.confidence,

    wins:
      stats.wins,

    losses:
      stats.losses,

    error:
      liveState.error
  };
}


/* =========================================================
   ADMIN WINGOBOT TEST
========================================================= */

async function wingoTest() {

  try {

    const raw =
      await fetchWingo();


    const normalized =
      normalizeProvider(
        raw
      );


    const resolved =
      resolveTarget(
        normalized.currentIssue,
        normalized.history
      );


    return {

      success: true,

      currentIssue:
        normalized.currentIssue,

      latestSettledIssue:
        resolved.latestSettledIssue,

      targetIssue:
        resolved.targetIssue,

      historyCount:
        normalized.history.length,

      history:
        normalized.history.slice(
          0,
          10
        )
    };

  } catch (error) {

    return {

      success: false,

      error:
        error.message
    };
  }
}


/* =========================================================
   ADMIN MODEL TEST
========================================================= */

function modelTest() {

  if (
    !providerHistory.length
  ) {

    return {

      success: false,

      error:
        "History not loaded."
    };
  }


  const prediction =
    createPrediction(
      providerHistory
    );


  return {

    success: true,

    prediction:
      prediction.prediction,

    number:
      prediction.number,

    confidence:
      prediction.confidence,

    status:
      prediction.status,

    analysis:
      prediction.analysis
  };
}


/* =========================================================
   REQUEST BODY
========================================================= */

function readBody(req) {

  return new Promise(
    (
      resolve,
      reject
    ) => {

      let body = "";


      req.on(
        "data",
        chunk => {

          body +=
            chunk.toString();

          if (
            body.length >
            2 * 1024 * 1024
          ) {

            reject(
              new Error(
                "Body too large."
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
                "Invalid JSON."
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
  code,
  data
) {

  res.writeHead(
    code,
    {

      "Content-Type":
        "application/json; charset=utf-8",

      "Cache-Control":
        "no-store, no-cache, must-revalidate",

      "Pragma":
        "no-cache",

      "Access-Control-Allow-Origin":
        "*",

      "Access-Control-Allow-Headers":
        "Content-Type, X-Admin-Key",

      "Access-Control-Allow-Methods":
        "GET, POST, DELETE, OPTIONS"

    }
  );


  res.end(
    JSON.stringify(data)
  );
}


/* =========================================================
   STATIC FILE
========================================================= */

function serveFile(
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

    sendJson(
      res,
      404,
      {
        success: false,
        error:
          "FILE_NOT_FOUND"
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
        "no-store"

    }
  );


  fs.createReadStream(
    file
  ).pipe(
    res
  );
}


/* =========================================================
   MUSIC WITH RANGE
========================================================= */

function serveMusic(
  req,
  res
) {

  const file =
    path.join(
      __dirname,
      "music.mp3"
    );


  if (
    !fs.existsSync(file)
  ) {

    sendJson(
      res,
      404,
      {
        success: false,
        error:
          "MUSIC_NOT_FOUND"
      }
    );

    return;
  }


  const stat =
    fs.statSync(file);


  const range =
    req.headers.range;


  if (!range) {

    res.writeHead(
      200,
      {

        "Content-Type":
          "audio/mpeg",

        "Content-Length":
          stat.size,

        "Accept-Ranges":
          "bytes"

      }
    );


    fs.createReadStream(
      file
    ).pipe(
      res
    );

    return;
  }


  const match =
    range.match(
      /bytes=(\d*)-(\d*)/
    );


  if (!match) {

    res.writeHead(
      416
    );

    res.end();

    return;
  }


  const start =
    match[1]
      ? Number(
          match[1]
        )
      : 0;


  const requestedEnd =
    match[2]
      ? Number(
          match[2]
        )
      : stat.size - 1;


  const end =
    Math.min(
      requestedEnd,
      stat.size - 1
    );


  if (
    start > end ||
    start >= stat.size
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


  const size =
    end -
    start +
    1;


  res.writeHead(
    206,
    {

      "Content-Type":
        "audio/mpeg",

      "Content-Length":
        size,

      "Content-Range":
        `bytes ${start}-${end}/${stat.size}`,

      "Accept-Ranges":
        "bytes"

    }
  );


  fs.createReadStream(
    file,
    {
      start,
      end
    }
  ).pipe(
    res
  );
}


/* =========================================================
   ROUTER
========================================================= */

async function router(
  req,
  res
) {

  const parsed =
    new URL(
      req.url,
      `http://${req.headers.host || "localhost"}`
    );


  const pathname =
    parsed.pathname;


  /*
    OPTIONS
  */

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
          "Content-Type, X-Admin-Key",

        "Access-Control-Allow-Methods":
          "GET, POST, DELETE, OPTIONS"

      }
    );


    res.end();

    return;
  }


  /* =======================================================
     HEALTH
  ======================================================= */

  if (
    pathname ===
    "/health"
  ) {

    sendJson(
      res,
      200,
      {

        status:
          "ok",

        providerOnline:
          liveState.providerOnline,

        historyCount:
          providerHistory.length,

        database:
          !!DATABASE_URL,

        time:
          now()

      }
    );

    return;
  }


  /* =======================================================
     ACCESS KEY
  ======================================================= */

  if (
    pathname ===
      "/api/key/check" &&
    req.method ===
      "POST"
  ) {

    try {

      const body =
        await readBody(req);


      const result =
        await checkKey(

          str(
            body.access_key
          ),

          str(
            body.device_id
          )

        );


      sendJson(
        res,
        result.success
          ? 200
          : 403,
        result
      );

    } catch (error) {

      console.error(
        error
      );


      sendJson(
        res,
        500,
        {

          success: false,

          error:
            "DATABASE_NOT_READY"

        }
      );
    }


    return;
  }


  /* =======================================================
     PUBLIC STATE
  ======================================================= */

  if (
    pathname ===
      "/api/state" &&
    req.method ===
      "GET"
  ) {

    sendJson(
      res,
      200,
      await publicState()
    );

    return;
  }


  /* =======================================================
     PUBLIC HISTORY
  ======================================================= */

  if (
    pathname ===
      "/api/history" &&
    req.method ===
      "GET"
  ) {

    sendJson(
      res,
      200,
      {

        success: true,

        history:
          providerHistory.slice(
            0,
            100
          ),

        predictions:
          liveState.predictionHistory

      }
    );

    return;
  }


  /* =======================================================
     ADMIN
  ======================================================= */

  if (
    pathname.startsWith(
      "/api/admin/"
    )
  ) {

    if (
      !isAdmin(req)
    ) {

      sendJson(
        res,
        403,
        {

          success: false,

          error:
            "ADMIN_UNAUTHORIZED"

        }
      );

      return;
    }
  }


  /* =======================================================
     ADMIN STATUS
  ======================================================= */

  if (
    pathname ===
      "/api/admin/status" &&
    req.method ===
      "GET"
  ) {

    sendJson(
      res,
      200,
      await adminStatus()
    );

    return;
  }


  /* =======================================================
     ADMIN PING
  ======================================================= */

  if (
    pathname ===
      "/api/admin/ping" &&
    req.method ===
      "GET"
  ) {

    sendJson(
      res,
      200,
      {

        success: true,

        message:
          "ADMIN CONNECTED",

        time:
          now()

      }
    );

    return;
  }


  /* =======================================================
     ADMIN KEYS LIST
  ======================================================= */

  if (
    pathname ===
      "/api/admin/keys" &&
    req.method ===
      "GET"
  ) {

    sendJson(
      res,
      200,
      {

        success: true,

        keys:
          await listKeys()

      }
    );

    return;
  }


  /* =======================================================
     ADMIN CREATE KEY
  ======================================================= */

  if (
    pathname ===
      "/api/admin/keys" &&
    req.method ===
      "POST"
  ) {

    try {

      const key =
        await createKey();


      sendJson(
        res,
        200,
        {

          success: true,

          key

        }
      );

    } catch (error) {

      sendJson(
        res,
        500,
        {

          success: false,

          error:
            error.message

        }
      );
    }


    return;
  }


  /* =======================================================
     ADMIN DELETE KEY
  ======================================================= */

  if (
    pathname ===
      "/api/admin/keys" &&
    req.method ===
      "DELETE"
  ) {

    try {

      const body =
        await readBody(req);


      const id =
        Number(
          body.id
        );


      const deleted =
        await deleteKey(
          id
        );


      sendJson(
        res,
        200,
        {

          success:
            deleted

        }
      );

    } catch (error) {

      sendJson(
        res,
        500,
        {

          success: false,

          error:
            error.message

        }
      );
    }


    return;
  }


  /* =======================================================
     ADMIN RESET DEVICE
  ======================================================= */

  if (
    pathname ===
      "/api/admin/reset-device" &&
    req.method ===
      "POST"
  ) {

    try {

      const body =
        await readBody(req);


      const result =
        await resetDevice(
          Number(
            body.id
          )
        );


      sendJson(
        res,
        200,
        {

          success:
            !!result,

          key:
            result

        }
      );

    } catch (error) {

      sendJson(
        res,
        500,
        {

          success: false,

          error:
            error.message

        }
      );
    }


    return;
  }


  /* =======================================================
     WINGOBOT TEST
  ======================================================= */

  if (
    pathname ===
      "/api/admin/wingo-test" &&
    req.method ===
      "GET"
  ) {

    sendJson(
      res,
      200,
      await wingoTest()
    );

    return;
  }


  /* =======================================================
     MODEL TEST
  ======================================================= */

  if (
    pathname ===
      "/api/admin/model-test" &&
    req.method ===
      "GET"
  ) {

    sendJson(
      res,
      200,
      modelTest()
    );

    return;
  }


  /* =======================================================
     PREDICTION HTML
  ======================================================= */

  if (
    pathname === "/" ||
    pathname === "/prediction.html"
  ) {

    serveFile(
      res,
      "prediction.html",
      "text/html; charset=utf-8"
    );

    return;
  }


  /* =======================================================
     ADMIN HTML
  ======================================================= */

  if (
    pathname ===
    "/admin.html"
  ) {

    serveFile(
      res,
      "admin.html",
      "text/html; charset=utf-8"
    );

    return;
  }


  /* =======================================================
     MUSIC
  ======================================================= */

  if (
    pathname ===
    "/music.mp3"
  ) {

    serveMusic(
      req,
      res
    );

    return;
  }


  /* =======================================================
     404
  ======================================================= */

  sendJson(
    res,
    404,
    {

      success: false,

      error:
        "NOT_FOUND"

    }
  );
}


/* =========================================================
   SERVER
========================================================= */

const server =
  http.createServer(
    (
      req,
      res
    ) => {

      router(
        req,
        res
      )
      .catch(
        error => {

          console.error(
            "Router error:",
            error
          );


          if (
            !res.headersSent
          ) {

            sendJson(
              res,
              500,
              {

                success: false,

                error:
                  "INTERNAL_SERVER_ERROR"

              }
            );

          } else {

            res.end();
          }
        }
      );
    }
  );


/* =========================================================
   START
========================================================= */

async function start() {

  await initDatabase();


  server.listen(
    PORT,
    "0.0.0.0",
    () => {

      console.log(
        `DY AI Wingo server running on ${PORT}`
      );

    }
  );


  /*
    First history fetch.
  */

  await updateLiveState();


  /*
    Provider updates every 3 seconds.
  */

  setInterval(
    () => {

      updateLiveState()
        .catch(
          error =>
            console.error(
              "Polling:",
              error.message
            )
        );

    },
    PROVIDER_POLL_MS
  );
}


start()
  .catch(
    error => {

      console.error(
        "STARTUP ERROR:",
        error
      );

      process.exit(1);
    }
  );


/* =========================================================
   SHUTDOWN
========================================================= */

async function shutdown() {

  try {

    await pool.end();

  } catch {}


  server.close(
    () => {
      process.exit(0);
    }
  );


  setTimeout(
    () => process.exit(1),
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
