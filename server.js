const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = process.env.PORT || 10000;

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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});


/* =========================================================
   GLOBAL STATE
========================================================= */

let providerState = {
  online: false,
  history: [],
  currentIssue: null,
  lastUpdated: 0,
  error: null
};

let cachedPrediction = null;
let cachedTarget = null;
let cachedHistorySignature = "";


/* =========================================================
   DATABASE
========================================================= */

async function initDB() {

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
      prediction TEXT NOT NULL,
      number INTEGER,
      confidence NUMERIC DEFAULT 0,
      outcome TEXT DEFAULT 'PENDING',
      created_at BIGINT NOT NULL,
      settled_at BIGINT DEFAULT 0
    )
  `);

  const columns = [
    ["prediction_records", "number", "INTEGER"],
    ["prediction_records", "confidence", "NUMERIC DEFAULT 0"],
    ["prediction_records", "outcome", "TEXT DEFAULT 'PENDING'"],
    ["prediction_records", "settled_at", "BIGINT DEFAULT 0"]
  ];

  for (const [table, column, type] of columns) {

    await pool.query(`
      ALTER TABLE ${table}
      ADD COLUMN IF NOT EXISTS ${column} ${type}
    `);

  }

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS
    prediction_records_target_issue_idx
    ON prediction_records(target_issue)
  `);
}


/* =========================================================
   HELPERS
========================================================= */

function now() {
  return Date.now();
}


function json(res, status, data) {

  const body = JSON.stringify(data);

  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });

  res.end(body);
}


function text(res, status, body, type = "text/plain") {

  res.writeHead(status, {
    "Content-Type": `${type}; charset=utf-8`,
    "Cache-Control": "no-store"
  });

  res.end(body);
}


function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}


function sideFromNumber(n) {

  const x = Number(n);

  if (!Number.isFinite(x)) return null;

  return x >= 5 ? "BIG" : "SMALL";
}


function opposite(side) {

  return side === "BIG"
    ? "SMALL"
    : "BIG";
}


function normalizeIssue(value) {

  if (value === undefined || value === null)
    return null;

  return String(value);
}


/* =========================================================
   ISSUE INCREMENT
========================================================= */

function incrementIssue(issue) {

  if (!issue) return null;

  const str = String(issue);

  const match = str.match(/^(.*?)(\d+)$/);

  if (!match) return null;

  const prefix = match[1];
  const digits = match[2];

  const next =
    (BigInt(digits) + 1n)
      .toString()
      .padStart(digits.length, "0");

  return prefix + next;
}


/* =========================================================
   FETCH WINGOBOT
========================================================= */

async function fetchWingoBot() {

  if (!WINGOBOT_TOKEN) {

    throw new Error(
      "WINGOBOT_TOKEN is not configured"
    );

  }

  const controller =
    new AbortController();

  const timer =
    setTimeout(() => controller.abort(), 10000);

  try {

    const response =
      await fetch(WINGOBOT_URL, {
        method: "GET",
        headers: {
          "Authorization":
            `Bearer ${WINGOBOT_TOKEN}`,
          "Accept":
            "application/json"
        },
        signal: controller.signal
      });

    if (!response.ok) {

      throw new Error(
        `WingoBot HTTP ${response.status}`
      );

    }

    const data =
      await response.json();

    return data;

  } finally {

    clearTimeout(timer);

  }
}


/* =========================================================
   NORMALIZE HISTORY
========================================================= */

function normalizeHistory(data) {

  const raw =
    Array.isArray(data?.history)
      ? data.history
      : [];

  const result = [];

  for (const row of raw) {

    const issue =
      normalizeIssue(
        row.issueNumber ??
        row.issue ??
        row.period
      );

    const number =
      Number(
        row.number ??
        row.num ??
        row.result
      );

    if (!issue) continue;

    if (
      !Number.isFinite(number) ||
      number < 0 ||
      number > 9
    ) {
      continue;
    }

    result.push({
      issueNumber: issue,
      number,
      side: sideFromNumber(number),
      colour: row.colour ?? null,
      premium: row.premium ?? null,
      sum: row.sum ?? null
    });
  }

  const seen = new Set();

  return result
    .filter(row => {

      if (seen.has(row.issueNumber))
        return false;

      seen.add(row.issueNumber);
      return true;

    })
    .slice(0, MAX_HISTORY);
}


/* =========================================================
   PROVIDER UPDATE
========================================================= */

async function updateProvider() {

  try {

    const data =
      await fetchWingoBot();

    const history =
      normalizeHistory(data);

    const currentIssue =
      normalizeIssue(
        data?.current?.issueNumber
      );

    providerState = {
      online: true,
      history,
      currentIssue,
      lastUpdated: now(),
      error: null
    };

    await settlePredictions(history);

    await ensurePrediction();

  } catch (error) {

    providerState.online = false;
    providerState.error =
      error.message || String(error);

  }

}


/* =========================================================
   TARGET RESOLVER
========================================================= */

function getLatestSettled() {

  return providerState.history[0] || null;
}


function getTargetIssue() {

  const latest =
    getLatestSettled();

  if (!latest) return null;

  const latestIssue =
    String(latest.issueNumber);

  const current =
    providerState.currentIssue
      ? String(providerState.currentIssue)
      : null;

  /*
    Provider current issue is already ahead
    => use it.

    Otherwise increment latest settled.
  */

  if (
    current &&
    current !== latestIssue
  ) {

    return current;

  }

  return incrementIssue(latestIssue);
}


/* =========================================================
   SIDE ARRAY
========================================================= */

function getSides(history, limit) {

  return history
    .slice(0, limit)
    .map(x => x.side)
    .filter(Boolean);
}


/* =========================================================
   SHORT TREND
========================================================= */

function shortTrend(history) {

  const arr =
    getSides(history, 7);

  if (arr.length < 3) {

    return {
      side: null,
      strength: 0,
      counts: {
        BIG: 0,
        SMALL: 0
      }
    };

  }

  let big = 0;
  let small = 0;

  arr.forEach(side => {

    if (side === "BIG") big++;
    if (side === "SMALL") small++;

  });

  const side =
    big === small
      ? null
      : big > small
        ? "BIG"
        : "SMALL";

  const strength =
    Math.abs(big - small) /
    arr.length;

  return {
    side,
    strength: clamp(strength, 0, 1),
    counts: { BIG: big, SMALL: small }
  };
}


/* =========================================================
   MEDIUM TREND
========================================================= */

function mediumTrend(history) {

  const arr =
    getSides(history, 20);

  if (arr.length < 6) {

    return {
      side: null,
      strength: 0,
      counts: {
        BIG: 0,
        SMALL: 0
      }
    };

  }

  let big = 0;
  let small = 0;

  arr.forEach(side => {

    if (side === "BIG") big++;
    if (side === "SMALL") small++;

  });

  const side =
    big === small
      ? null
      : big > small
        ? "BIG"
        : "SMALL";

  const strength =
    Math.abs(big - small) /
    arr.length;

  return {
    side,
    strength: clamp(strength, 0, 1),
    counts: { BIG: big, SMALL: small }
  };
}


/* =========================================================
   TREND AGE
========================================================= */

function trendAge(history) {

  const arr =
    getSides(history, 30);

  if (!arr.length) return 0;

  const first = arr[0];

  let age = 0;

  for (const side of arr) {

    if (side !== first)
      break;

    age++;

  }

  return age;
}


/* =========================================================
   TRANSITION MODEL
========================================================= */

function transitionModel(history) {

  const arr =
    getSides(history, 80);

  const transitions = {
    BIG: {
      BIG: 0,
      SMALL: 0
    },
    SMALL: {
      BIG: 0,
      SMALL: 0
    }
  };

  for (let i = 0; i < arr.length - 1; i++) {

    const current = arr[i];
    const previous = arr[i + 1];

    if (
      transitions[previous] &&
      transitions[previous][current] !== undefined
    ) {

      transitions[previous][current]++;

    }

  }

  const last =
    arr[0];

  if (!last) {

    return {
      side: null,
      continuation: .5,
      reversal: .5
    };

  }

  const same =
    transitions[last][last];

  const reverse =
    transitions[last][opposite(last)];

  const total =
    same + reverse;

  if (!total) {

    return {
      side: last,
      continuation: .5,
      reversal: .5
    };

  }

  return {
    side: last,
    continuation: same / total,
    reversal: reverse / total
  };
}


/* =========================================================
   STREAK / BREAK MODEL
========================================================= */

function trendBreakModel(history) {

  const arr =
    getSides(history, 30);

  if (arr.length < 5) {

    return {
      risk: .5,
      side: arr[0] || null,
      age: arr.length,
      breakScore: .5
    };

  }

  const side =
    arr[0];

  let age = 0;

  for (const x of arr) {

    if (x !== side) break;

    age++;

  }

  /*
    Longer streak ≠ automatic reversal.

    We increase break pressure gradually,
    but never force a reversal.
  */

  let agePressure = 0;

  if (age <= 2)
    agePressure = .05;
  else if (age === 3)
    agePressure = .12;
  else if (age === 4)
    agePressure = .22;
  else if (age === 5)
    agePressure = .32;
  else if (age === 6)
    agePressure = .42;
  else if (age === 7)
    agePressure = .50;
  else
    agePressure = .58;


  /*
    Look at previous streaks.
  */

  const previousRuns = [];

  let runSide = arr[arr.length - 1];
  let runLength = 1;

  for (let i = arr.length - 2; i >= 0; i--) {

    if (arr[i] === runSide) {

      runLength++;

    } else {

      previousRuns.push({
        side: runSide,
        length: runLength
      });

      runSide = arr[i];
      runLength = 1;

    }

  }

  previousRuns.push({
    side: runSide,
    length: runLength
  });


  const oppositeRuns =
    previousRuns
      .filter(x =>
        x.side === side
      )
      .map(x => x.length);


  let historicalBreak = .5;

  if (oppositeRuns.length) {

    const average =
      oppositeRuns.reduce(
        (a,b) => a+b,
        0
      ) / oppositeRuns.length;

    if (age >= average + 1)
      historicalBreak += .18;

    if (age >= average + 2)
      historicalBreak += .15;

  }


  /*
    Recent alternating behaviour.
  */

  const recent =
    arr.slice(0, 8);

  let changes = 0;

  for (let i = 0; i < recent.length - 1; i++) {

    if (recent[i] !== recent[i + 1])
      changes++;

  }

  const alternation =
    recent.length > 1
      ? changes / (recent.length - 1)
      : .5;

  const risk =
    clamp(
      agePressure * .62 +
      historicalBreak * .18 +
      alternation * .20,
      0,
      .95
    );

  return {
    risk,
    side,
    age,
    breakScore: risk
  };
}


/* =========================================================
   NUMBER MODEL
========================================================= */

function numberModel(history) {

  const arr =
    history
      .slice(0, 40)
      .map(x => Number(x.number))
      .filter(Number.isFinite);

  if (!arr.length) {

    return {
      number: null,
      side: null,
      pressure: 0,
      counts: {}
    };

  }

  const counts = {};

  for (let i = 0; i <= 9; i++)
    counts[i] = 0;

  arr.forEach(n => {

    if (counts[n] !== undefined)
      counts[n]++;

  });


  /*
    Frequency is NOT treated as
    "overdue = must appear".

    We combine frequency with recency.
  */

  const scores = {};

  for (let n = 0; n <= 9; n++) {

    const frequency =
      counts[n] / arr.length;

    let recency = 0;

    const index =
      arr.indexOf(n);

    if (index === -1) {

      recency = .18;

    } else {

      recency =
        1 -
        clamp(index / arr.length,0,1);

    }

    scores[n] =
      frequency * .55 +
      recency * .45;

  }


  let bestNumber = 0;

  for (let n = 1; n <= 9; n++) {

    if (
      scores[n] >
      scores[bestNumber]
    ) {

      bestNumber = n;

    }

  }


  const side =
    sideFromNumber(bestNumber);

  const maxScore =
    Math.max(...Object.values(scores));

  return {
    number: bestNumber,
    side,
    pressure: clamp(maxScore,0,1),
    counts
  };
}


/* =========================================================
   PATTERN MODEL
========================================================= */

function patternModel(history) {

  const arr =
    getSides(history, 10);

  if (arr.length < 4) {

    return {
      side: null,
      confidence: 0
    };

  }

  const recent =
    arr.slice(0, 4).join("");

  const patterns = {
    "BIGBIGBIGBIG": "BIG",
    "SMALLSMALLSMALLSMALL": "SMALL",

    "BIGBIGBIGSMALL": "BIG",
    "SMALLSMALLSMALLBIG": "SMALL",

    "BIGSMALLBIGSMALL": "BIG",
    "SMALLBIGSMALLBIG": "SMALL",

    "BIGSMALLSMALLBIG": "SMALL",
    "SMALLBIGBIGSMALL": "BIG"
  };

  const side =
    patterns[recent] || null;

  return {
    side,
    confidence:
      side ? .55 : .20
  };
}


/* =========================================================
   REGIME CLASSIFIER
========================================================= */

function classifyRegime(
  short,
  medium,
  transition,
  breakModel,
  age
) {

  if (!short.side && !medium.side)
    return "NO_CLEAR_TREND";


  if (
    breakModel.risk >= .68 &&
    age >= 4
  ) {

    return "POSSIBLE_BREAK";

  }


  if (
    short.side &&
    medium.side &&
    short.side !== medium.side
  ) {

    return "CONFLICT";

  }


  if (
    age <= 2 &&
    short.side
  ) {

    return "NEW_TREND";

  }


  if (
    transition.continuation >= .68 &&
    breakModel.risk < .45
  ) {

    return "TREND_CONTINUING";

  }


  if (
    breakModel.risk >= .42
  ) {

    return "TREND_WEAKENING";

  }


  return "NEUTRAL";
}


/* =========================================================
   FINAL AI ENGINE
========================================================= */

function createPrediction(history, targetIssue) {

  if (!history.length || !targetIssue)
    return null;


  const short =
    shortTrend(history);

  const medium =
    mediumTrend(history);

  const transition =
    transitionModel(history);

  const breakModel =
    trendBreakModel(history);

  const number =
    numberModel(history);

  const pattern =
    patternModel(history);

  const age =
    trendAge(history);


  const regime =
    classifyRegime(
      short,
      medium,
      transition,
      breakModel,
      age
    );


  /*
    Side scores.
  */

  const score = {
    BIG: 0,
    SMALL: 0
  };


  /* -----------------------------------------
     SHORT TREND
  ----------------------------------------- */

  if (short.side) {

    /*
      Do not give full power to trend.
    */

    const weight =
      age >= 5
        ? .75
        : .95;

    score[short.side] +=
      short.strength * weight;

  }


  /* -----------------------------------------
     MEDIUM TREND
  ----------------------------------------- */

  if (medium.side) {

    score[medium.side] +=
      medium.strength * .80;

  }


  /* -----------------------------------------
     TRANSITION
  ----------------------------------------- */

  if (transition.side) {

    const continuation =
      transition.continuation;

    const reversal =
      transition.reversal;


    /*
      If continuation is strong,
      support it.

      But if trend is old,
      reduce continuation.
    */

    let continuationWeight =
      continuation;


    if (age >= 4)
      continuationWeight *= .72;

    if (age >= 6)
      continuationWeight *= .55;


    score[transition.side] +=
      continuationWeight * .70;


    score[opposite(transition.side)] +=
      reversal * .55;

  }


  /* -----------------------------------------
     TREND BREAK
  ----------------------------------------- */

  if (breakModel.side) {

    score[
      opposite(breakModel.side)
    ] +=
      breakModel.risk * .95;

  }


  /* -----------------------------------------
     PATTERN
  ----------------------------------------- */

  if (pattern.side) {

    score[pattern.side] +=
      pattern.confidence * .45;

  }


  /* -----------------------------------------
     NUMBER MODEL
  ----------------------------------------- */

  if (number.side) {

    score[number.side] +=
      number.pressure * .35;

  }


  /* -----------------------------------------
     STREAK PROTECTION
  ----------------------------------------- */

  if (
    age >= 5 &&
    short.side
  ) {

    /*
      Explicit anti-blind-following.

      This does NOT force opposite.
      It only gives opposite some weight.
    */

    score[
      opposite(short.side)
    ] +=
      Math.min(
        .55,
        (age - 4) * .12
      );

  }


  /* -----------------------------------------
     SHORT/MEDIUM CONFLICT
  ----------------------------------------- */

  if (
    short.side &&
    medium.side &&
    short.side !== medium.side
  ) {

    /*
      When timeframes disagree,
      avoid overconfidence.
    */

    score[short.side] *= .86;
    score[medium.side] *= .92;

  }


  /* -----------------------------------------
     FINAL SIDE
  ----------------------------------------- */

  let finalSide =
    score.BIG >= score.SMALL
      ? "BIG"
      : "SMALL";


  /*
    If scores are extremely close,
    use the more stable medium signal.
  */

  const difference =
    Math.abs(
      score.BIG -
      score.SMALL
    );


  if (
    difference < .08 &&
    medium.side
  ) {

    finalSide =
      medium.side;

  }


  /*
    Suggested number.

    Keep number model separate from
    side decision.
  */

  let suggestedNumber =
    number.number;


  if (
    suggestedNumber === null ||
    sideFromNumber(suggestedNumber) !== finalSide
  ) {

    const candidates =
      history
        .slice(0,40)
        .map(x => Number(x.number))
        .filter(n =>
          Number.isFinite(n) &&
          sideFromNumber(n) === finalSide
        );


    if (candidates.length) {

      const count = {};

      candidates.forEach(n => {
        count[n] =
          (count[n] || 0) + 1;
      });


      suggestedNumber =
        Number(
          Object.keys(count)
            .sort(
              (a,b) =>
                count[b] -
                count[a]
            )[0]
        );

    } else {

      suggestedNumber =
        finalSide === "BIG"
          ? 7
          : 2;

    }

  }


  /* -----------------------------------------
     MODEL AGREEMENT
  ----------------------------------------- */

  const votes = [];

  if (short.side)
    votes.push(short.side);

  if (medium.side)
    votes.push(medium.side);

  if (transition.side) {

    votes.push(
      transition.continuation >=
      transition.reversal
        ? transition.side
        : opposite(transition.side)
    );

  }

  if (pattern.side)
    votes.push(pattern.side);

  if (number.side)
    votes.push(number.side);

  if (breakModel.side) {

    votes.push(
      breakModel.risk >= .58
        ? opposite(breakModel.side)
        : breakModel.side
    );

  }


  const agreement =
    votes.length
      ? votes.filter(
          x => x === finalSide
        ).length / votes.length
      : .5;


  /* -----------------------------------------
     CONFIDENCE
  ----------------------------------------- */

  let confidence = 50;

  confidence +=
    clamp(difference * 25,0,15);

  confidence +=
    agreement * 14;

  confidence +=
    short.strength * 7;

  confidence +=
    medium.strength * 5;


  /*
    Old streaks create uncertainty.

    Instead of increasing confidence
    just because streak is long,
    reduce it.
  */

  if (age >= 4)
    confidence -= 5;

  if (age >= 6)
    confidence -= 7;

  if (regime === "CONFLICT")
    confidence -= 6;

  if (regime === "POSSIBLE_BREAK")
    confidence -= 3;


  confidence =
    clamp(
      Math.round(confidence),
      45,
      88
    );


  /* -----------------------------------------
     SUMMARY
  ----------------------------------------- */

  let summary = "";

  if (regime === "POSSIBLE_BREAK") {

    summary =
      `Trend break risk is elevated. ` +
      `The model is comparing continuation ` +
      `against reversal instead of blindly following ` +
      `the current streak.`;

  } else if (regime === "TREND_WEAKENING") {

    summary =
      `The current trend is weakening. ` +
      `Short-term behaviour and transition signals ` +
      `are being given extra weight.`;

  } else if (regime === "CONFLICT") {

    summary =
      `Short and medium trends disagree. ` +
      `The model is reducing confidence rather than ` +
      `forcing a trend-following prediction.`;

  } else if (regime === "NEW_TREND") {

    summary =
      `A fresh trend is forming. ` +
      `The model is checking whether continuation ` +
      `has enough supporting signals.`;

  } else {

    summary =
      `Multiple independent signals were compared. ` +
      `The current trend is only one part of the final decision.`;

  }


  return {

    targetIssue,

    prediction: finalSide,

    number: suggestedNumber,

    confidence,

    analysis: {

      regime,

      trend:
        short.side || medium.side || "NEUTRAL",

      trendStrength:
        Math.round(
          short.strength * 100
        ),

      trendAge: age,

      breakRisk:
        Math.round(
          breakModel.risk * 100
        ),

      continuation:
        Math.round(
          transition.continuation * 100
        ),

      modelAgreement:
        Math.round(
          agreement * 100
        ),

      shortTrend:
        short.side || "NEUTRAL",

      mediumTrend:
        medium.side || "NEUTRAL",

      transition:
        Math.round(
          transition.continuation * 100
        ),

      numberPressure:
        Math.round(
          number.pressure * 100
        ),

      historicalMatch:
        Math.round(
          pattern.confidence * 100
        ),

      streakStructure:
        age >= 6
          ? "LONG STREAK"
          : age >= 4
            ? "STREAK"
            : age >= 2
              ? "SHORT STREAK"
              : "NORMAL",

      summary

    }

  };

}


/* =========================================================
   ENSURE ONE PREDICTION PER TARGET
========================================================= */

async function ensurePrediction() {

  const target =
    getTargetIssue();

  if (!target)
    return null;


  /*
    IMPORTANT:
    Same target = same prediction.
    We never regenerate it every second.
  */

  if (
    cachedTarget === target &&
    cachedPrediction
  ) {

    return cachedPrediction;

  }


  const existing =
    await pool.query(
      `
      SELECT *
      FROM prediction_records
      WHERE target_issue = $1
      LIMIT 1
      `,
      [target]
    );


  if (existing.rows.length) {

    const row =
      existing.rows[0];

    cachedTarget = target;

    cachedPrediction = {

      targetIssue: target,

      prediction:
        row.prediction,

      number:
        row.number,

      confidence:
        Number(row.confidence || 0),

      analysis: {
        regime: "LOCKED",
        summary:
          "Prediction locked for this target period."
      }

    };

    return cachedPrediction;

  }


  const prediction =
    createPrediction(
      providerState.history,
      target
    );


  if (!prediction)
    return null;


  await pool.query(
    `
    INSERT INTO prediction_records
    (
      target_issue,
      prediction,
      number,
      confidence,
      outcome,
      created_at
    )
    VALUES ($1,$2,$3,$4,'PENDING',$5)
    ON CONFLICT (target_issue)
    DO NOTHING
    `,
    [
      target,
      prediction.prediction,
      prediction.number,
      prediction.confidence,
      now()
    ]
  );


  cachedTarget = target;
  cachedPrediction = prediction;

  return prediction;
}


/* =========================================================
   SETTLE EXACT PERIOD ONLY
========================================================= */

async function settlePredictions(history) {

  if (!history.length)
    return;


  const actualMap =
    new Map(
      history.map(row => [
        String(row.issueNumber),
        row
      ])
    );


  const pending =
    await pool.query(
      `
      SELECT *
      FROM prediction_records
      WHERE outcome = 'PENDING'
      ORDER BY id DESC
      LIMIT 500
      `
    );


  for (const row of pending.rows) {

    const actual =
      actualMap.get(
        String(row.target_issue)
      );


    if (!actual)
      continue;


    const actualSide =
      sideFromNumber(actual.number);


    if (!actualSide)
      continue;


    const outcome =
      actualSide === row.prediction
        ? "WIN"
        : "LOSS";


    await pool.query(
      `
      UPDATE prediction_records
      SET outcome = $1,
          settled_at = $2
      WHERE id = $3
      `,
      [
        outcome,
        now(),
        row.id
      ]
    );

  }

}


/* =========================================================
   STATS
========================================================= */

async function getStats() {

  const result =
    await pool.query(`
      SELECT outcome, COUNT(*)::int AS count
      FROM prediction_records
      WHERE outcome IN ('WIN','LOSS')
      GROUP BY outcome
    `);

  let wins = 0;
  let losses = 0;

  for (const row of result.rows) {

    if (row.outcome === "WIN")
      wins = Number(row.count);

    if (row.outcome === "LOSS")
      losses = Number(row.count);

  }


  const total =
    wins + losses;

  return {
    wins,
    losses,
    accuracy:
      total
        ? Number(
            (
              wins / total * 100
            ).toFixed(1)
          )
        : 0
  };

}


/* =========================================================
   PREDICTION HISTORY
========================================================= */

async function getPredictionHistory() {

  const result =
    await pool.query(`
      SELECT
        target_issue,
        prediction,
        number,
        confidence,
        outcome,
        created_at,
        settled_at
      FROM prediction_records
      ORDER BY id DESC
      LIMIT 30
    `);

  return result.rows;

}


/* =========================================================
   BACKTEST
========================================================= */

function calculateBacktest(history) {

  if (history.length < 20) {

    return {
      samples: 0,
      wins: 0,
      losses: 0,
      accuracy: 0
    };

  }


  let wins = 0;
  let losses = 0;

  /*
    Walk through historical data.

    Only use data BEFORE the target row.
  */

  const max =
    Math.min(
      history.length - 1,
      120
    );


  for (let i = 0; i < max; i++) {

    const training =
      history.slice(i + 1);

    const actual =
      history[i];

    if (!actual?.side)
      continue;


    const target =
      actual.issueNumber;


    const prediction =
      createPrediction(
        training,
        target
      );


    if (!prediction)
      continue;


    if (
      prediction.prediction ===
      actual.side
    ) {

      wins++;

    } else {

      losses++;

    }

  }


  const total =
    wins + losses;


  return {

    samples: total,

    wins,

    losses,

    accuracy:
      total
        ? Number(
            (
              wins / total * 100
            ).toFixed(1)
          )
        : 0

  };

}


/* =========================================================
   ADMIN AUTH
========================================================= */

function isAdmin(req) {

  const key =
    req.headers["x-admin-key"];

  return Boolean(
    key &&
    key === ADMIN_KEY
  );

}


function requireAdmin(req,res) {

  if (!isAdmin(req)) {

    json(res,401,{
      ok:false,
      error:"Unauthorized"
    });

    return false;

  }

  return true;
}


/* =========================================================
   BODY
========================================================= */

function readBody(req) {

  return new Promise((resolve,reject)=>{

    let body = "";

    req.on("data",chunk=>{

      body += chunk;

      if(body.length > 1024 * 1024){

        reject(
          new Error("Request too large")
        );

        req.destroy();

      }

    });

    req.on("end",()=>{

      if(!body){

        resolve({});

        return;

      }

      try{

        resolve(
          JSON.parse(body)
        );

      }catch{

        reject(
          new Error("Invalid JSON")
        );

      }

    });

    req.on("error",reject);

  });

}


/* =========================================================
   ADMIN KEYS
========================================================= */

async function adminKeys(req,res) {

  if (!requireAdmin(req,res))
    return;


  if (req.method === "GET") {

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

    json(res,200,{
      ok:true,
      keys:result.rows
    });

    return;

  }


  if (req.method === "POST") {

    const body =
      await readBody(req);

    const key =
      String(
        body.access_key ||
        body.key ||
        ""
      ).trim();


    if (!key) {

      json(res,400,{
        ok:false,
        error:"Access key required"
      });

      return;

    }


    try {

      const result =
        await pool.query(
          `
          INSERT INTO access_keys
          (
            access_key,
            created_at
          )
          VALUES ($1,$2)
          RETURNING *
          `,
          [key,now()]
        );


      json(res,200,{
        ok:true,
        key:result.rows[0]
      });


    } catch(error) {

      if(error.code === "23505") {

        json(res,409,{
          ok:false,
          error:"Access key already exists"
        });

      } else {

        throw error;

      }

    }

    return;

  }


  if (req.method === "DELETE") {

    const body =
      await readBody(req);

    const id =
      Number(body.id);


    if(!Number.isInteger(id)) {

      json(res,400,{
        ok:false,
        error:"Invalid key id"
      });

      return;

    }


    await pool.query(
      `
      DELETE FROM access_keys
      WHERE id = $1
      `,
      [id]
    );


    json(res,200,{
      ok:true
    });

    return;

  }


  json(res,405,{
    ok:false,
    error:"Method not allowed"
  });

}


/* =========================================================
   RESET DEVICE
========================================================= */

async function resetDevice(req,res) {

  if (!requireAdmin(req,res))
    return;


  const body =
    await readBody(req);

  const id =
    Number(body.id);


  if(!Number.isInteger(id)) {

    json(res,400,{
      ok:false,
      error:"Invalid key id"
    });

    return;

  }


  await pool.query(
    `
    UPDATE access_keys
    SET device_id = NULL,
        last_seen = 0
    WHERE id = $1
    `,
    [id]
  );


  json(res,200,{
    ok:true
  });

}


/* =========================================================
   ADMIN STATUS
========================================================= */

async function adminStatus(req,res) {

  if (!requireAdmin(req,res))
    return;


  let dbOnline = false;

  try {

    await pool.query("SELECT 1");

    dbOnline = true;

  } catch {}


  json(res,200,{

    ok:true,

    server:{
      online:true,
      uptime:process.uptime()
    },

    database:{
      online:dbOnline
    },

    provider:{
      online:providerState.online,
      currentIssue:
        providerState.currentIssue,
      latestSettled:
        getLatestSettled()?.issueNumber || null,
      history:
        providerState.history.length,
      error:
        providerState.error
    }

  });

}


/* =========================================================
   PING
========================================================= */

async function adminPing(req,res) {

  if (!requireAdmin(req,res))
    return;


  try {

    const start =
      Date.now();

    const data =
      await fetchWingoBot();

    json(res,200,{

      ok:true,

      latency:
        Date.now() - start,

      currentIssue:
        data?.current?.issueNumber || null,

      historyCount:
        Array.isArray(data?.history)
          ? data.history.length
          : 0

    });

  } catch(error) {

    json(res,502,{

      ok:false,

      error:
        error.message

    });

  }

}


/* =========================================================
   WINGO TEST
========================================================= */

async function adminWingoTest(req,res) {

  if (!requireAdmin(req,res))
    return;


  try {

    const data =
      await fetchWingoBot();

    const history =
      normalizeHistory(data);


    json(res,200,{

      ok:true,

      current:
        data?.current || null,

      stats:
        data?.stats || null,

      history:history.slice(0,10)

    });

  } catch(error) {

    json(res,502,{

      ok:false,
      error:error.message

    });

  }

}


/* =========================================================
   MODEL TEST
========================================================= */

async function adminModelTest(req,res) {

  if (!requireAdmin(req,res))
    return;


  const target =
    getTargetIssue();


  const prediction =
    target
      ? createPrediction(
          providerState.history,
          target
        )
      : null;


  const bt =
    calculateBacktest(
      providerState.history
    );


  json(res,200,{

    ok:true,

    targetIssue:target,

    prediction,

    backtest:bt,

    historyUsed:
      providerState.history.length

  });

}


/* =========================================================
   ACCESS KEY CHECK
========================================================= */

async function checkAccessKey(req,res) {

  try {

    const body =
      await readBody(req);

    const key =
      String(
        body.access_key ||
        body.key ||
        ""
      ).trim();

    const deviceId =
      String(
        body.device_id ||
        ""
      ).trim();


    if(!key || !deviceId) {

      json(res,400,{
        ok:false,
        error:
          "Access key and device id required"
      });

      return;

    }


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


    if(!result.rows.length) {

      json(res,403,{
        ok:false,
        error:"Invalid access key"
      });

      return;

    }


    const row =
      result.rows[0];


    if(
      row.device_id &&
      row.device_id !== deviceId
    ) {

      json(res,403,{
        ok:false,
        error:
          "This key is already bound to another device"
      });

      return;

    }


    await pool.query(
      `
      UPDATE access_keys
      SET device_id = $1,
          last_seen = $2
      WHERE id = $3
      `,
      [
        deviceId,
        now(),
        row.id
      ]
    );


    json(res,200,{
      ok:true
    });

  } catch(error) {

    json(res,500,{
      ok:false,
      error:error.message
    });

  }

}


/* =========================================================
   MAIN STATE
========================================================= */

async function getState() {

  const target =
    getTargetIssue();


  if(
    target !== cachedTarget
  ) {

    cachedPrediction = null;
    cachedTarget = null;

    await ensurePrediction();

  }


  const prediction =
    cachedPrediction ||
    await ensurePrediction();


  const stats =
    await getStats();


  const history =
    providerState.history;


  const latest =
    getLatestSettled();


  const backtest =
    calculateBacktest(
      history
    );


  /*
    Estimated countdown.

    The provider history endpoint does not
    expose an authoritative timer field.

    So this is only an estimate.
  */

  let countdown = 0;

  if(providerState.lastUpdated){

    const elapsed =
      Math.floor(
        (
          Date.now() -
          providerState.lastUpdated
        ) / 1000
      );

    countdown =
      ROUND_SECONDS -
      (elapsed % ROUND_SECONDS);

  }


  return {

    ready:
      providerState.online &&
      Boolean(prediction),

    providerOnline:
      providerState.online,

    gameUrl:
      GAME_URL,

    latestSettledIssue:
      latest?.issueNumber || null,

    currentIssue:
      providerState.currentIssue,

    targetIssue:
      target,

    countdown,

    prediction:
      prediction?.prediction || null,

    number:
      prediction?.number ?? null,

    confidence:
      prediction?.confidence || 0,

    status:
      prediction
        ? "READY"
        : "WAITING",

    analysis:
      prediction?.analysis || null,

    predictionHistory:
      await getPredictionHistory(),

    wins:
      stats.wins,

    losses:
      stats.losses,

    accuracy:
      stats.accuracy,

    backtest,

    updatedAt:
      providerState.lastUpdated

  };

}


/* =========================================================
   STATIC FILE
========================================================= */

function serveFile(req,res,fileName) {

  const filePath =
    path.join(
      __dirname,
      fileName
    );


  if(!fs.existsSync(filePath)) {

    text(
      res,
      404,
      "File not found"
    );

    return;

  }


  const ext =
    path.extname(filePath)
      .toLowerCase();


  const types = {

    ".html":
      "text/html",

    ".css":
      "text/css",

    ".js":
      "application/javascript",

    ".json":
      "application/json",

    ".mp3":
      "audio/mpeg"

  };


  const contentType =
    types[ext] ||
    "application/octet-stream";


  if(ext === ".mp3") {

    const stat =
      fs.statSync(filePath);

    const range =
      req.headers.range;


    if(range) {

      const match =
        range.match(
          /bytes=(\d*)-(\d*)/
        );


      if(match) {

        const start =
          match[1]
            ? Number(match[1])
            : 0;

        const end =
          match[2]
            ? Number(match[2])
            : stat.size - 1;

        const safeEnd =
          Math.min(
            end,
            stat.size - 1
          );


        res.writeHead(206,{

          "Content-Type":
            contentType,

          "Content-Range":
            `bytes ${start}-${safeEnd}/${stat.size}`,

          "Accept-Ranges":
            "bytes",

          "Content-Length":
            safeEnd - start + 1

        });


        fs.createReadStream(
          filePath,
          {
            start,
            end:safeEnd
          }
        ).pipe(res);

        return;

      }

    }


    res.writeHead(200,{

      "Content-Type":
        contentType,

      "Accept-Ranges":
        "bytes",

      "Content-Length":
        stat.size

    });


    fs.createReadStream(
      filePath
    ).pipe(res);

    return;

  }


  res.writeHead(200,{
    "Content-Type":
      `${contentType}; charset=utf-8`,
    "Cache-Control":
      "no-cache"
  });


  fs.createReadStream(
    filePath
  ).pipe(res);

}


/* =========================================================
   HTTP SERVER
========================================================= */

const server =
  http.createServer(
    async (req,res)=>{

      try {

        const url =
          new URL(
            req.url,
            `http://${req.headers.host}`
          );


        /* Health */

        if(
          url.pathname ===
          "/health"
        ){

          json(res,200,{
            ok:true,
            service:"DY AI",
            providerOnline:
              providerState.online
          });

          return;

        }


        /* Access */

        if(
          url.pathname ===
          "/api/key/check"
        ){

          await checkAccessKey(
            req,
            res
          );

          return;

        }


        /* State */

        if(
          url.pathname ===
          "/api/state"
        ){

          const state =
            await getState();

          json(
            res,
            200,
            state
          );

          return;

        }


        /* History */

        if(
          url.pathname ===
          "/api/history"
        ){

          json(res,200,{
            ok:true,
            history:
              providerState.history
          });

          return;

        }


        /* Admin */

        if(
          url.pathname ===
          "/api/admin/status"
        ){

          await adminStatus(
            req,res
          );

          return;

        }


        if(
          url.pathname ===
          "/api/admin/ping"
        ){

          await adminPing(
            req,res
          );

          return;

        }


        if(
          url.pathname ===
          "/api/admin/wingo-test"
        ){

          await adminWingoTest(
            req,res
          );

          return;

        }


        if(
          url.pathname ===
          "/api/admin/model-test"
        ){

          await adminModelTest(
            req,res
          );

          return;

        }


        if(
          url.pathname ===
          "/api/admin/keys"
        ){

          await adminKeys(
            req,res
          );

          return;

        }


        if(
          url.pathname ===
          "/api/admin/reset-device"
        ){

          await resetDevice(
            req,res
          );

          return;

        }


        /* Static */

        if(
          url.pathname === "/" ||
          url.pathname === "/prediction.html"
        ){

          serveFile(
            req,
            res,
            "prediction.html"
          );

          return;

        }


        if(
          url.pathname ===
          "/admin.html"
        ){

          serveFile(
            req,
            res,
            "admin.html"
          );

          return;

        }


        if(
          url.pathname ===
          "/music.mp3"
        ){

          serveFile(
            req,
            res,
            "music.mp3"
          );

          return;

        }


        text(
          res,
          404,
          "Not Found"
        );


      } catch(error) {

        console.error(
          "SERVER ERROR:",
          error
        );

        json(res,500,{
          ok:false,
          error:
            error.message ||
            "Internal server error"
        });

      }

    }
  );


/* =========================================================
   START
========================================================= */

async function start(){

  try {

    await initDB();

    console.log(
      "Database initialized."
    );


    await updateProvider();

    console.log(
      "Initial provider update complete."
    );


    setInterval(
      updateProvider,
      PROVIDER_POLL_MS
    );


    server.listen(
      PORT,
      "0.0.0.0",
      ()=>{
        console.log(
          `DY AI running on port ${PORT}`
        );
      }
    );


  } catch(error) {

    console.error(
      "STARTUP ERROR:",
      error
    );

    process.exit(1);

  }

}


start();
