"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const { Pool } = require("pg");

/* =========================================================
   CONFIG
========================================================= */

const PORT = Number(process.env.PORT || 10000);

const DATABASE_URL =
  process.env.DATABASE_URL || "";

const WINGOBOT_TOKEN =
  process.env.WINGOBOT_TOKEN || "";

const ADMIN_KEY =
  process.env.ADMIN_KEY ||
  "dy4427574";

const WINGOBOT_HISTORY_URL =
  "https://api.wingobot.com/v2/30-sec-game-history";

const PUBLIC_DIR =
  __dirname;

const PREDICTION_FILE =
  path.join(
    PUBLIC_DIR,
    "prediction.html"
  );

const ADMIN_FILE =
  path.join(
    PUBLIC_DIR,
    "admin.html"
  );

const MUSIC_FILE =
  path.join(
    PUBLIC_DIR,
    "music.mp3"
  );


/* =========================================================
   DATABASE
========================================================= */

if (!DATABASE_URL) {
  console.warn(
    "[WARNING] DATABASE_URL is not configured."
  );
}

const pool = new Pool({
  connectionString: DATABASE_URL || undefined,

  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : undefined,

  max: 10,

  idleTimeoutMillis: 30000,

  connectionTimeoutMillis: 10000
});


let dbReady = false;


/* =========================================================
   LIVE MEMORY
========================================================= */

let liveState = {

  currentIssue: "",

  latestSettledIssue: "",

  targetIssue: "",

  countdown: 30,

  prediction: "WAIT",

  number: null,

  confidence: 0,

  status: "WAIT",

  analysis: {

    patternScore: 0,

    modelAgreement: 0,

    backtestSamples: 0,

    avgModelAccuracy: null

  },

  history: [],

  predictionHistory: [],

  wins: 0,

  losses: 0,

  skipped: 0,

  lastUpdated: 0,

  error: null

};


let updateInProgress = false;


/* =========================================================
   DATABASE INIT
========================================================= */

async function initDatabase() {

  if (!DATABASE_URL) {
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

        target_issue TEXT UNIQUE NOT NULL,

        prediction TEXT NOT NULL,

        predicted_number INTEGER,

        ai_prediction TEXT,

        ai_number INTEGER,

        mode TEXT DEFAULT 'AI MODE',

        randomized BOOLEAN DEFAULT FALSE,

        confidence INTEGER DEFAULT 0,

        status TEXT DEFAULT 'WAIT',

        created_at BIGINT NOT NULL,

        result_number INTEGER,

        result_side TEXT,

        outcome TEXT DEFAULT 'PENDING',

        settled_at BIGINT DEFAULT 0
      )
    `);


    /*
      IMPORTANT:
      Old broken records where WAIT was marked LOSS
      are repaired automatically.
    */

    await pool.query(`
      UPDATE prediction_records
      SET
        outcome = 'SKIPPED',
        settled_at = CASE
          WHEN settled_at IS NULL OR settled_at = 0
          THEN EXTRACT(EPOCH FROM NOW())::BIGINT
          ELSE settled_at
        END
      WHERE
        UPPER(TRIM(prediction)) = 'WAIT'
        AND UPPER(TRIM(outcome)) = 'LOSS'
    `);


    /*
      Remove old random-mode state from future records.
      Existing records remain visible but are treated as
      historical records.
    */

    await pool.query(`
      UPDATE prediction_records
      SET
        randomized = FALSE,
        mode = 'AI MODE'
      WHERE
        randomized = TRUE
        OR mode = 'RANDOM MIX'
    `);


    dbReady = true;

    console.log(
      "[DATABASE] Ready"
    );

  } catch (error) {

    console.error(
      "[DATABASE INIT ERROR]",
      error.message
    );

    dbReady = false;
  }
}


/* =========================================================
   BASIC HELPERS
========================================================= */

function now() {
  return Date.now();
}


function jsonResponse(
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
        "no-store, no-cache, must-revalidate",

      "Pragma":
        "no-cache",

      "Access-Control-Allow-Origin":
        "*",

      "Access-Control-Allow-Headers":
        "Content-Type, X-Admin-Key, X-Access-Key",

      "Access-Control-Allow-Methods":
        "GET, POST, DELETE, OPTIONS"
    }
  );


  res.end(body);
}


function textResponse(
  res,
  status,
  text,
  type = "text/plain"
) {

  res.writeHead(
    status,
    {
      "Content-Type":
        type,

      "Cache-Control":
        "no-store"
    }
  );

  res.end(text);
}


function safeJsonParse(text) {

  try {

    return JSON.parse(text);

  } catch {

    return {};
  }
}


function readBody(req) {

  return new Promise(
    resolve => {

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

            req.destroy();
          }

        }
      );


      req.on(
        "end",
        () => {

          resolve(
            safeJsonParse(body)
          );

        }
      );


      req.on(
        "error",
        () => resolve({})
      );

    }
  );
}


/* =========================================================
   NUMBER / SIDE HELPERS
========================================================= */

function cleanNumber(value) {

  const n =
    Number(value);

  if (
    !Number.isInteger(n) ||
    n < 0 ||
    n > 9
  ) {

    return null;
  }

  return n;
}


function sideFromNumber(number) {

  const n =
    cleanNumber(number);

  if (n === null) {
    return null;
  }

  return n >= 5
    ? "BIG"
    : "SMALL";
}


function normalizeSide(value) {

  if (!value) {
    return null;
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

  return null;
}


/* =========================================================
   ISSUE HELPERS
========================================================= */

function normalizeIssue(value) {

  if (
    value === null ||
    value === undefined
  ) {

    return "";
  }

  return String(value).trim();
}


function incrementIssue(issue) {

  const s =
    normalizeIssue(issue);

  if (!s) {
    return "";
  }


  /*
    Wingo issue numbers are numeric strings.
    BigInt avoids precision loss.
  */

  if (/^\d+$/.test(s)) {

    try {

      const next =
        (
          BigInt(s) +
          1n
        ).toString();


      if (
        next.length <
        s.length
      ) {

        return next.padStart(
          s.length,
          "0"
        );
      }


      return next;

    } catch {
      return "";
    }
  }


  return "";
}


/*
  IMPORTANT TARGET RESOLUTION

  latest settled = history[0]

  If API current is ahead:
      target = API current

  If API current is same/behind:
      target = latest settled + 1

  This fixes the screenshot case:
      settled 51103
      current 51104
      target 51104
*/

function resolveTargetIssue(
  currentIssue,
  latestSettledIssue
) {

  const current =
    normalizeIssue(
      currentIssue
    );

  const latest =
    normalizeIssue(
      latestSettledIssue
    );


  if (!latest) {

    return current;
  }


  if (!current) {

    return incrementIssue(
      latest
    );
  }


  if (
    /^\d+$/.test(current) &&
    /^\d+$/.test(latest)
  ) {

    try {

      const c =
        BigInt(current);

      const l =
        BigInt(latest);


      if (c > l) {

        return current;
      }


      return incrementIssue(
        latest
      );

    } catch {

      return incrementIssue(
        latest
      );
    }
  }


  if (
    current === latest
  ) {

    return incrementIssue(
      latest
    );
  }


  return current;
}


/* =========================================================
   WINGOBOT API
========================================================= */

async function fetchWingoHistory() {

  if (!WINGOBOT_TOKEN) {

    throw new Error(
      "WINGOBOT_TOKEN is missing"
    );
  }


  const response =
    await fetch(
      WINGOBOT_HISTORY_URL,
      {
        method: "GET",

        headers: {
          "Authorization":
            `Bearer ${WINGOBOT_TOKEN}`,

          "Accept":
            "application/json"
        }
      }
    );


  const text =
    await response.text();


  if (!response.ok) {

    throw new Error(
      `WingoBot HTTP ${response.status}: ${text.slice(0,300)}`
    );
  }


  const data =
    safeJsonParse(text);


  return data;
}


/* =========================================================
   HISTORY NORMALIZATION
========================================================= */

function normalizeHistory(apiData) {

  const raw =
    Array.isArray(
      apiData?.history
    )
      ? apiData.history
      : [];


  const result = [];


  for (
    const row of raw
  ) {

    const issue =
      normalizeIssue(
        row?.issueNumber
      );


    const number =
      cleanNumber(
        row?.number
      );


    if (
      !issue ||
      number === null
    ) {

      continue;
    }


    const calculatedSide =
      sideFromNumber(
        number
      );


    const apiSide =
      normalizeSide(
        row?.colour
      );


    result.push({

      issueNumber:
        issue,

      number:
        number,

      side:
        calculatedSide,

      colour:
        apiSide ||
        calculatedSide,

      premium:
        row?.premium ?? null,

      sum:
        row?.sum ?? null
    });
  }


  /*
    Newest first.
  */

  result.sort(
    (a, b) => {

      if (
        /^\d+$/.test(
          a.issueNumber
        ) &&
        /^\d+$/.test(
          b.issueNumber
        )
      ) {

        try {

          const aa =
            BigInt(
              a.issueNumber
            );

          const bb =
            BigInt(
              b.issueNumber
            );

          if (aa > bb) return -1;
          if (aa < bb) return 1;

        } catch {}
      }


      return 0;
    }
  );


  return result;
}


/* =========================================================
   SIDE ARRAYS
========================================================= */

function sides(history) {

  return history
    .map(
      row =>
        normalizeSide(
          row.side
        ) ||
        sideFromNumber(
          row.number
        )
    )
    .filter(Boolean);
}


/* =========================================================
   RECENCY SIGNAL
========================================================= */

function recencySignal(
  history
) {

  const windows = [
    3,
    5,
    8,
    12
  ];


  const signals = [];


  for (
    const size of windows
  ) {

    const arr =
      history
        .slice(0, size)
        .map(
          r => r.side
        )
        .filter(Boolean);


    if (
      arr.length <
      Math.min(
        size,
        3
      )
    ) {

      continue;
    }


    let big = 0;
    let small = 0;


    for (
      const side of arr
    ) {

      if (side === "BIG")
        big++;

      if (side === "SMALL")
        small++;
    }


    const total =
      big + small;


    if (!total)
      continue;


    signals.push({

      size,

      big:
        big / total,

      small:
        small / total,

      edge:
        Math.abs(
          big - small
        ) / total
    });
  }


  if (!signals.length) {

    return {
      side: null,
      strength: 0,
      agreement: 0
    };
  }


  let bigScore = 0;
  let smallScore = 0;

  let weights = 0;


  for (
    const s of signals
  ) {

    const weight =
      s.size === 3
        ? 1.40
        : s.size === 5
        ? 1.20
        : s.size === 8
        ? 1.00
        : 0.75;


    bigScore +=
      s.big *
      weight;

    smallScore +=
      s.small *
      weight;

    weights +=
      weight;
  }


  const big =
    bigScore / weights;

  const small =
    smallScore / weights;


  const side =
    big >= small
      ? "BIG"
      : "SMALL";


  const difference =
    Math.abs(
      big - small
    );


  const agreementCount =
    signals.filter(
      s =>
        (
          s.big >= s.small &&
          side === "BIG"
        ) ||
        (
          s.small >= s.big &&
          side === "SMALL"
        )
    ).length;


  return {

    side,

    strength:
      Math.min(
        1,
        difference * 2
      ),

    agreement:
      agreementCount /
      signals.length,

    big,

    small
  };
}


/* =========================================================
   TRANSITION ANALYSIS
========================================================= */

function transitionEvidence(
  history
) {

  if (
    history.length <
    5
  ) {

    return {
      side: null,
      strength: 0,
      agreement: 0,
      samples: 0
    };
  }


  const current =
    history[0]?.side;


  if (!current) {

    return {
      side: null,
      strength: 0,
      agreement: 0,
      samples: 0
    };
  }


  let bigNext = 0;
  let smallNext = 0;
  let samples = 0;


  /*
    Newest-first:

    history[i] = older current state
    history[i-1] = next result after it

    We skip i=0 because there is no newer
    result inside the historical array.
  */

  for (
    let i = 1;
    i < history.length;
    i++
  ) {

    const state =
      history[i]?.side;

    const next =
      history[i - 1]?.side;


    if (
      state !== current ||
      !next
    ) {

      continue;
    }


    samples++;


    if (
      next === "BIG"
    ) {

      bigNext++;

    }else{

      smallNext++;
    }
  }


  if (
    samples <
    3
  ) {

    return {
      side: null,
      strength: 0,
      agreement: 0,
      samples
    };
  }


  const big =
    bigNext / samples;

  const small =
    smallNext / samples;


  const side =
    big >= small
      ? "BIG"
      : "SMALL";


  return {

    side,

    strength:
      Math.abs(
        big - small
      ),

    agreement:
      Math.max(
        big,
        small
      ),

    samples,

    big,

    small
  };
}


/* =========================================================
   SEQUENCE ANALYSIS
========================================================= */

function sequenceEvidence(
  history
) {

  const arr =
    history
      .map(
        r => r.side
      )
      .filter(Boolean);


  if (
    arr.length <
    8
  ) {

    return {
      side: null,
      strength: 0,
      agreement: 0,
      samples: 0
    };
  }


  let weightedBig = 0;
  let weightedSmall = 0;

  let totalWeight = 0;

  let allSamples = 0;


  for (
    const length of [2,3,4]
  ) {

    if (
      arr.length <=
      length + 1
    ) {

      continue;
    }


    const currentPattern =
      arr
        .slice(
          0,
          length
        )
        .join(",");


    let big = 0;
    let small = 0;


    /*
      Example:

      newest:
      A B C

      Search older:
      X A B C

      In newest-first array the result following
      the matching older pattern is at i - 1.

      Because currentPattern starts at 0,
      an older matching sequence begins at i,
      and its next chronological result is i-1.
    */

    for (
      let i = length;
      i < arr.length;
      i++
    ) {

      const pattern =
        arr
          .slice(
            i,
            i + length
          )
          .join(",");


      if (
        pattern !==
        currentPattern
      ) {

        continue;
      }


      const next =
        arr[i - 1];


      if (
        next === "BIG"
      ){

        big++;

      }else if(
        next === "SMALL"
      ){

        small++;
      }
    }


    const samples =
      big + small;


    if (
      samples <
      2
    ) {

      continue;
    }


    const strength =
      Math.abs(
        big - small
      ) /
      samples;


    const side =
      big >= small
        ? "BIG"
        : "SMALL";


    /*
      Longer exact patterns get slightly more weight,
      but only when enough samples exist.
    */

    const weight =
      length === 4
        ? 1.30
        : length === 3
        ? 1.10
        : 0.90;


    weightedBig +=
      (
        big / samples
      ) *
      strength *
      weight;

    weightedSmall +=
      (
        small / samples
      ) *
      strength *
      weight;


    totalWeight +=
      weight;

    allSamples +=
      samples;
  }


  if (
    totalWeight <= 0
  ) {

    return {
      side: null,
      strength: 0,
      agreement: 0,
      samples: allSamples
    };
  }


  const big =
    weightedBig /
    totalWeight;

  const small =
    weightedSmall /
    totalWeight;


  const side =
    big >= small
      ? "BIG"
      : "SMALL";


  const max =
    Math.max(
      big,
      small
    );


  const min =
    Math.min(
      big,
      small
    );


  return {

    side,

    strength:
      Math.min(
        1,
        Math.abs(
          max - min
        ) * 2.5
      ),

    agreement:
      max > 0
        ? max /
          (
            max + min
          )
        : 0,

    samples:
      allSamples,

    big,

    small
  };
}


/* =========================================================
   STREAK ANALYSIS
========================================================= */

function streakEvidence(
  history
) {

  const arr =
    history
      .map(
        r => r.side
      )
      .filter(Boolean);


  if (
    arr.length <
    4
  ) {

    return {
      side: null,
      strength: 0,
      agreement: 0,
      streak: 0
    };
  }


  const current =
    arr[0];


  let streak = 1;


  for (
    let i = 1;
    i < arr.length;
    i++
  ) {

    if (
      arr[i] ===
      current
    ) {

      streak++;

    }else{

      break;
    }
  }


  if (
    streak < 2
  ) {

    return {
      side: current,
      strength: 0,
      agreement: 0.5,
      streak
    };
  }


  /*
    Streak itself is NOT treated as automatic reversal.
    We look at historical transitions after same-side streaks.
  */

  let afterBig = 0;
  let afterSmall = 0;

  let samples = 0;


  for (
    let i = 2;
    i < arr.length;
    i++
  ) {

    if (
      arr[i] !==
      current
    ) {

      continue;
    }


    const previous =
      arr[i - 1];


    if (
      previous !==
      current
    ) {

      continue;
    }


    const next =
      arr[i - 2];


    if (!next)
      continue;


    samples++;


    if (
      next === "BIG"
    ){

      afterBig++;

    }else{

      afterSmall++;
    }
  }


  if (
    samples <
    2
  ) {

    return {
      side: current,
      strength:
        Math.min(
          0.45,
          streak *
          0.07
        ),
      agreement: 0.5,
      streak
    };
  }


  const big =
    afterBig /
    samples;

  const small =
    afterSmall /
    samples;


  const side =
    big >= small
      ? "BIG"
      : "SMALL";


  return {

    side,

    strength:
      Math.min(
        1,
        Math.abs(
          big - small
        )
      ),

    agreement:
      Math.max(
        big,
        small
      ),

    streak,

    big,

    small
  };
}


/* =========================================================
   VOLATILITY
========================================================= */

function volatilitySignal(
  history
) {

  const arr =
    history
      .slice(0,12)
      .map(
        r => r.side
      )
      .filter(Boolean);


  if (
    arr.length <
    6
  ) {

    return {
      alternating: false,
      streaky: false,
      volatility: 0
    };
  }


  let switches = 0;


  for (
    let i = 1;
    i < arr.length;
    i++
  ) {

    if (
      arr[i] !==
      arr[i - 1]
    ) {

      switches++;
    }
  }


  const volatility =
    switches /
    (
      arr.length - 1
    );


  return {

    alternating:
      volatility >= 0.67,

    streaky:
      volatility <= 0.33,

    volatility
  };
}


/* =========================================================
   NUMBER ANALYSIS
========================================================= */

function numberAnalysis(
  history,
  targetSide
) {

  const counts = {
    0:0,
    1:0,
    2:0,
    3:0,
    4:0,
    5:0,
    6:0,
    7:0,
    8:0,
    9:0
  };


  const recent =
    history.slice(
      0,
      20
    );


  for (
    const row of recent
  ) {

    const n =
      cleanNumber(
        row.number
      );

    if (
      n !== null
    ) {

      counts[n]++;
    }
  }


  const candidates =
    targetSide === "BIG"
      ? [5,6,7,8,9]
      : [0,1,2,3,4];


  /*
    Don't simply choose most frequent number.
    Score combines:
      - frequency
      - recent absence
      - slight recency
  */

  const scored =
    candidates.map(
      n => {

        const frequency =
          counts[n];


        let lastIndex =
          999;


        for (
          let i = 0;
          i < recent.length;
          i++
        ) {

          if (
            Number(
              recent[i].number
            ) === n
          ) {

            lastIndex =
              i;

            break;
          }
        }


        const absence =
          Math.min(
            1,
            lastIndex /
            10
          );


        const frequencyPenalty =
          Math.min(
            1,
            frequency /
            5
          );


        const score =
          (
            absence *
            0.60
          ) +
          (
            (
              1 -
              frequencyPenalty
            ) *
            0.40
          );


        return {
          number:n,
          score
        };
      }
    );


  scored.sort(
    (a,b) =>
      b.score -
      a.score
  );


  return {

    number:
      scored[0]?.number ??
      (
        targetSide === "BIG"
          ? 5
          : 0
      ),

    candidates:scored
  };
}


/* =========================================================
   EXPERT ENSEMBLE
========================================================= */

function runModels(
  history
) {

  const recency =
    recencySignal(
      history
    );


  const transition =
    transitionEvidence(
      history
    );


  const sequence =
    sequenceEvidence(
      history
    );


  const streak =
    streakEvidence(
      history
    );


  const volatility =
    volatilitySignal(
      history
    );


  const votes = [];


  if (
    recency.side
  ){

    votes.push({
      name:"RECENCY",
      side:recency.side,
      strength:
        recency.strength,
      weight:1.30
    });
  }


  if (
    transition.side &&
    transition.samples >= 3
  ){

    votes.push({
      name:"TRANSITION",
      side:transition.side,
      strength:
        transition.strength,
      weight:1.20
    });
  }


  if (
    sequence.side &&
    sequence.samples >= 2
  ){

    votes.push({
      name:"SEQUENCE",
      side:sequence.side,
      strength:
        sequence.strength,
      weight:1.10
    });
  }


  if (
    streak.side &&
    streak.strength > 0
  ){

    votes.push({
      name:"STREAK",
      side:streak.side,
      strength:
        streak.strength,
      weight:0.75
    });
  }


  if (
    !votes.length
  ){

    return {

      side:null,

      edge:0,

      agreement:0,

      patternScore:0,

      models:[],

      recency,

      transition,

      sequence,

      streak,

      volatility
    };
  }


  let bigScore = 0;
  let smallScore = 0;

  let totalWeight = 0;


  for (
    const vote of votes
  ) {

    const contribution =
      vote.weight *
      Math.max(
        0.05,
        vote.strength
      );


    if (
      vote.side ===
      "BIG"
    ){

      bigScore +=
        contribution;

    }else{

      smallScore +=
        contribution;
    }


    totalWeight +=
      contribution;
  }


  if (
    totalWeight <= 0
  ){

    return {

      side:null,

      edge:0,

      agreement:0,

      patternScore:0,

      models:votes
    };
  }


  const side =
    bigScore >=
    smallScore
      ? "BIG"
      : "SMALL";


  const winning =
    Math.max(
      bigScore,
      smallScore
    );


  const losing =
    Math.min(
      bigScore,
      smallScore
    );


  const edge =
    (
      winning -
      losing
    ) /
    totalWeight;


  const agreement =
    votes.filter(
      v =>
        v.side ===
        side
    ).length /
    votes.length;


  const patternStrength =
    Math.max(
      sequence?.strength || 0,
      streak?.strength || 0
    );


  const patternScore =
    Math.round(
      Math.min(
        100,
        (
          patternStrength *
          100
        ) +
        (
          agreement *
          35
        )
      )
    );


  /*
    Alternating history:
    reduce confidence in simple recency/transition
    rather than pretending there is a strong edge.
  */

  let adjustedEdge =
    edge;


  if (
    volatility?.alternating
  ) {

    adjustedEdge *=
      0.78;
  }


  return {

    side,

    edge:
      adjustedEdge,

    agreement,

    patternScore,

    models:votes,

    recency,

    transition,

    sequence,

    streak,

    volatility
  };
}


/* =========================================================
   WALK-FORWARD BACKTEST
========================================================= */

function backtest(
  history
) {

  /*
    Need enough history to avoid fake accuracy.
  */

  if (
    history.length <
    25
  ){

    return {

      samples:0,

      accuracy:null,

      wins:0,

      losses:0
    };
  }


  let samples = 0;
  let wins = 0;
  let losses = 0;


  /*
    history is newest-first.

    For each target at index i:
      training data = i+1 onward
      actual target = history[i]

    We walk from older data toward newer data.
  */

  for (
    let i =
      history.length - 1;
    i >= 0;
    i--
  ) {

    const training =
      history.slice(
        i + 1
      );


    if (
      training.length <
      15
    ){

      continue;
    }


    const actual =
      history[i]?.side;


    if (!actual)
      continue;


    const model =
      runModels(
        training
      );


    if (
      !model.side
    ){

      continue;
    }


    /*
      Only count predictions where the historical
      model itself had enough edge.
    */

    if (
      model.edge <
      0.12
    ){

      continue;
    }


    samples++;


    if (
      model.side ===
      actual
    ){

      wins++;

    }else{

      losses++;
    }
  }


  return {

    samples,

    accuracy:
      samples
        ? Math.round(
            (
              wins /
              samples
            ) *
            100
          )
        : null,

    wins,

    losses
  };
}


/* =========================================================
   CONFIDENCE
========================================================= */

function adaptiveConfidence(
  model,
  test,
  historyLength
) {

  if (
    !model ||
    !model.side
  ){

    return 0;
  }


  /*
    Base confidence is intentionally conservative.
  */

  let confidence =
    50 +
    (
      model.edge *
      38
    ) +
    (
      Math.max(
        0,
        model.agreement -
        0.5
      ) *
      18
    );


  /*
    Backtest modifies confidence only if there
    are enough genuine walk-forward samples.
  */

  if (
    test &&
    test.samples >= 20 &&
    test.accuracy != null
  ){

    const backtestAdjustment =
      (
        test.accuracy -
        50
      ) *
      0.20;


    confidence +=
      backtestAdjustment;
  }


  /*
    Small history => strong cap.
    This prevents fake 80-90% confidence
    from only a few observations.
  */

  if (
    historyLength <
    15
  ){

    confidence =
      Math.min(
        confidence,
        64
      );

  }else if(
    historyLength <
    25
  ){

    confidence =
      Math.min(
        confidence,
        72
      );

  }else{

    confidence =
      Math.min(
        confidence,
        82
      );
  }


  return Math.round(
    Math.max(
      0,
      Math.min(
        82,
        confidence
      )
    )
  );
}


/* =========================================================
   PREDICTION DECISION
========================================================= */

function predictSide(
  history
) {

  if (
    !Array.isArray(history) ||
    history.length <
    10
  ){

    return {

      side:"WAIT",

      confidence:0,

      status:"INSUFFICIENT DATA",

      model:null,

      backtest:backtest(
        history || []
      )
    };
  }


  const model =
    runModels(
      history
    );


  const test =
    backtest(
      history
    );


  if (
    !model.side
  ){

    return {

      side:"WAIT",

      confidence:0,

      status:"NO CLEAR EDGE",

      model,

      backtest:test
    };
  }


  /*
    Stronger threshold.
    We don't want every tiny majority to become
    a prediction.
  */

  let minimumEdge =
    history.length >= 25
      ? 0.16
      : 0.19;


  /*
    If model agreement is weak, increase threshold.
  */

  if (
    model.agreement <
    0.60
  ){

    minimumEdge +=
      0.04;
  }


  const confidence =
    adaptiveConfidence(
      model,
      test,
      history.length
    );


  /*
    IMPORTANT:
    Do not force low-confidence predictions.

    70% is a practical minimum display threshold
    for this application.
  */

  if (
    model.edge <
    minimumEdge ||
    model.agreement <
    0.60 ||
    confidence <
    70
  ){

    return {

      side:"WAIT",

      confidence,

      status:
        model.agreement <
        0.60
          ? "NO CLEAR EDGE"
          : "WEAK SIGNAL",

      model,

      backtest:test
    };
  }


  let status =
    "EARLY SIGNAL";


  if (
    confidence >=
    78 &&
    model.agreement >=
    0.70
  ){

    status =
      "STRONGER SIGNAL";

  }else if(
    confidence >=
    74
  ){

    status =
      "MODERATE SIGNAL";
  }


  return {

    side:
      model.side,

    confidence,

    status,

    model,

    backtest:test
  };
}


/* =========================================================
   NUMBER SELECTION
========================================================= */

function chooseNumber(
  history,
  targetSide,
  targetIssue
) {

  if (
    targetSide !==
      "BIG" &&
    targetSide !==
      "SMALL"
  ){

    return null;
  }


  const analysis =
    numberAnalysis(
      history,
      targetSide
    );


  /*
    Deterministic selection based on target issue.

    This ensures the number does not change every
    second for the same target.
  */

  const candidates =
    analysis.candidates;


  if (
    !candidates.length
  ){

    return targetSide === "BIG"
      ? 5
      : 0;
  }


  /*
    Mostly choose top candidate.
    Small deterministic tie rotation avoids
    always displaying the same number when scores
    are identical.
  */

  const top =
    candidates.slice(
      0,
      Math.min(
        3,
        candidates.length
      )
    );


  let hash = 0;


  for (
    const ch of
    String(
      targetIssue || ""
    )
  ) {

    hash =
      (
        (
          hash << 5
        ) -
        hash +
        ch.charCodeAt(0)
      ) |
      0;
  }


  const index =
    Math.abs(hash) %
    top.length;


  return top[index].number;
}


/* =========================================================
   CREATE PREDICTION
========================================================= */

function createPrediction(
  history,
  targetIssue
) {

  const decision =
    predictSide(
      history
    );


  let side =
    decision.side;


  let number =
    null;


  if (
    side === "BIG" ||
    side === "SMALL"
  ){

    number =
      chooseNumber(
        history,
        side,
        targetIssue
      );
  }


  const model =
    decision.model;


  const test =
    decision.backtest;


  return {

    targetIssue,

    prediction:
      side,

    number,

    confidence:
      decision.confidence,

    status:
      decision.status,

    analysis: {

      patternScore:
        model?.patternScore ??
        0,

      modelAgreement:
        model
          ? Math.round(
              (
                model.agreement ||
                0
              ) *
              100
            )
          : 0,

      backtestSamples:
        test?.samples ??
        0,

      avgModelAccuracy:
        test?.accuracy ??
        null,

      recency:
        model?.recency ??
        null,

      transition:
        model?.transition ??
        null,

      sequence:
        model?.sequence ??
        null,

      streak:
        model?.streak ??
        null,

      volatility:
        model?.volatility ??
        null
    },

    /*
      Random mode intentionally disabled.
    */

    mode:
      "AI MODE",

    randomized:
      false,

    aiPrediction:
      side,

    aiNumber:
      number
  };
}


/* =========================================================
   PREDICTION DATABASE
========================================================= */

async function getPredictionRecord(
  issue
) {

  if (!dbReady) {
    return null;
  }


  const result =
    await pool.query(
      `
      SELECT *
      FROM prediction_records
      WHERE target_issue = $1
      LIMIT 1
      `,
      [String(issue)]
    );


  return result.rows[0] ||
    null;
}


/* =========================================================
   SAVE PREDICTION
========================================================= */

async function savePrediction(
  prediction
) {

  if (!dbReady) {
    return null;
  }


  /*
    WAIT is stored as WAIT but is NEVER
    settled as WIN/LOSS.
  */

  const result =
    await pool.query(
      `
      INSERT INTO prediction_records (
        target_issue,
        prediction,
        predicted_number,
        ai_prediction,
        ai_number,
        mode,
        randomized,
        confidence,
        status,
        created_at,
        outcome
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        'AI MODE',
        FALSE,
        $6,
        $7,
        $8,
        'PENDING'
      )
      ON CONFLICT (target_issue)
      DO NOTHING
      RETURNING *
      `,
      [

        prediction.targetIssue,

        prediction.prediction,

        prediction.number,

        prediction.aiPrediction,

        prediction.aiNumber,

        prediction.confidence,

        prediction.status,

        now()
      ]
    );


  return (
    result.rows[0] ||
    await getPredictionRecord(
      prediction.targetIssue
    )
  );
}


/* =========================================================
   SETTLE PREDICTIONS
========================================================= */

async function settlePredictions(
  history
) {

  if (
    !dbReady ||
    !Array.isArray(history) ||
    !history.length
  ){

    return;
  }


  /*
    Only records with actual BIG/SMALL predictions
    are eligible for WIN/LOSS.

    WAIT:
       PENDING -> SKIPPED

    Never:
       WAIT -> LOSS
  */

  await pool.query(`
    UPDATE prediction_records
    SET
      outcome = 'SKIPPED',
      settled_at = CASE
        WHEN settled_at IS NULL OR settled_at = 0
        THEN EXTRACT(EPOCH FROM NOW())::BIGINT
        ELSE settled_at
      END
    WHERE
      UPPER(TRIM(prediction)) = 'WAIT'
      AND outcome IN ('PENDING','LOSS','WIN')
  `);


  for (
    const actual of history
  ) {

    const issue =
      normalizeIssue(
        actual.issueNumber
      );


    const number =
      cleanNumber(
        actual.number
      );


    const actualSide =
      sideFromNumber(
        number
      );


    if (
      !issue ||
      number === null ||
      !actualSide
    ){

      continue;
    }


    /*
      Exact issue match only.
    */

    const result =
      await pool.query(
        `
        SELECT *
        FROM prediction_records
        WHERE target_issue = $1
        LIMIT 1
        `,
        [issue]
      );


    if (
      !result.rows.length
    ){

      continue;
    }


    const record =
      result.rows[0];


    /*
      Already settled => do nothing.
    */

    if (
      record.outcome ===
        "WIN" ||
      record.outcome ===
        "LOSS" ||
      record.outcome ===
        "SKIPPED"
    ){

      continue;
    }


    const prediction =
      normalizeSide(
        record.prediction
      );


    /*
      WAIT is skipped, never LOSS.
    */

    if (
      !prediction
    ){

      await pool.query(
        `
        UPDATE prediction_records
        SET
          result_number = $2,
          result_side = $3,
          outcome = 'SKIPPED',
          settled_at = $4
        WHERE target_issue = $1
        `,
        [
          issue,
          number,
          actualSide,
          now()
        ]
      );


      continue;
    }


    const outcome =
      prediction ===
      actualSide
        ? "WIN"
        : "LOSS";


    await pool.query(
      `
      UPDATE prediction_records
      SET
        result_number = $2,
        result_side = $3,
        outcome = $4,
        settled_at = $5
      WHERE target_issue = $1
      `,
      [

        issue,

        number,

        actualSide,

        outcome,

        now()
      ]
    );
  }
}


/* =========================================================
   GET PREDICTION HISTORY
========================================================= */

async function getPredictionHistory() {

  if (!dbReady) {

    return [];
  }


  const result =
    await pool.query(
      `
      SELECT
        target_issue,
        prediction,
        predicted_number,
        ai_prediction,
        ai_number,
        mode,
        randomized,
        confidence,
        status,
        created_at,
        result_number,
        result_side,
        outcome,
        settled_at
      FROM prediction_records
      ORDER BY id DESC
      LIMIT 30
      `
    );


  return result.rows;
}


/* =========================================================
   STATS
========================================================= */

async function getStats() {

  if (!dbReady) {

    return {

      wins:0,

      losses:0,

      skipped:0
    };
  }


  /*
    IMPORTANT:
    WAIT/SKIPPED are excluded from W/L.
  */

  const result =
    await pool.query(
      `
      SELECT
        COUNT(*) FILTER (
          WHERE outcome = 'WIN'
        ) AS wins,

        COUNT(*) FILTER (
          WHERE outcome = 'LOSS'
        ) AS losses,

        COUNT(*) FILTER (
          WHERE outcome = 'SKIPPED'
        ) AS skipped

      FROM prediction_records
      `
    );


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
      ),

    skipped:
      Number(
        row.skipped || 0
      )
  };
}


/* =========================================================
   COUNTDOWN
========================================================= */

function calculateCountdown(
  currentIssue,
  latestUpdated
) {

  /*
    WingoBot documented history endpoint does not expose
    an authoritative countdown field.

    Therefore this is only an estimated server timer.

    When stats.last_updated is available, use it as
    the synchronization anchor.
  */

  const updated =
    Number(
      latestUpdated || 0
    );


  if (
    !updated ||
    !Number.isFinite(updated)
  ){

    const seconds =
      Math.floor(
        (
          Date.now() / 1000
        )
      );


    return (
      30 -
      (
        seconds %
        30
      )
    );
  }


  const elapsed =
    Math.floor(
      (
        Date.now() -
        updated
      ) /
      1000
    );


  const remaining =
    30 -
    (
      elapsed %
      30
    );


  return Math.max(
    1,
    Math.min(
      30,
      remaining
    )
  );
}


/* =========================================================
   UPDATE LIVE STATE
========================================================= */

async function updateLiveState() {

  if (
    updateInProgress
  ){

    return liveState;
  }


  updateInProgress =
    true;


  try {

    const apiData =
      await fetchWingoHistory();


    const history =
      normalizeHistory(
        apiData
      );


    const currentIssue =
      normalizeIssue(
        apiData?.current?.issueNumber
      );


    const latestSettledIssue =
      history[0]?.issueNumber ||
      "";


    const targetIssue =
      resolveTargetIssue(
        currentIssue,
        latestSettledIssue
      );


    /*
      First settle previous predictions.
    */

    await settlePredictions(
      history
    );


    /*
      Check whether target already exists.
      If it exists, DO NOT generate a new prediction.
    */

    let record =
      await getPredictionRecord(
        targetIssue
      );


    if (
      !record &&
      targetIssue
    ){

      const prediction =
        createPrediction(
          history,
          targetIssue
        );


      record =
        await savePrediction(
          prediction
        );


      if (record) {

        console.log(
          `[PREDICTION CREATED] ${targetIssue} => ${prediction.prediction} ${prediction.number ?? ""} (${prediction.confidence}%)`
        );
      }
    }


    const stats =
      await getStats();


    const predictionHistory =
      await getPredictionHistory();


    let prediction =
      "WAIT";

    let number =
      null;

    let confidence =
      0;

    let status =
      "WAIT";

    let analysis = {

      patternScore:0,

      modelAgreement:0,

      backtestSamples:0,

      avgModelAccuracy:null
    };


    if (record) {

      prediction =
        normalizeSide(
          record.prediction
        ) ||
        "WAIT";


      number =
        record.predicted_number ??
        null;


      confidence =
        Number(
          record.confidence ||
          0
        );


      status =
        record.status ||
        "WAIT";


      /*
        Reconstruct details from current history so
        model details remain live, while prediction
        itself remains fixed for target.
      */

      const currentDecision =
        createPrediction(
          history,
          targetIssue
        );


      analysis =
        currentDecision.analysis;
    }


    liveState = {

      currentIssue,

      latestSettledIssue,

      targetIssue,

      countdown:
        calculateCountdown(
          currentIssue,
          apiData?.stats?.last_updated
        ),

      prediction,

      number,

      confidence,

      status,

      analysis,

      history:
        history.slice(0,30),

      predictionHistory,

      wins:
        stats.wins,

      losses:
        stats.losses,

      skipped:
        stats.skipped,

      lastUpdated:
        now(),

      providerUpdated:
        apiData?.stats?.last_updated ||
        null,

      mode:
        "AI MODE",

      randomized:
        false,

      aiPrediction:
        prediction,

      aiNumber:
        number,

      error:null
    };


    return liveState;

  } catch (error) {

    console.error(
      "[LIVE UPDATE ERROR]",
      error.message
    );


    liveState = {

      ...liveState,

      error:
        error.message,

      lastUpdated:
        now()
    };


    return liveState;

  } finally {

    updateInProgress =
      false;
  }
}


/* =========================================================
   ADMIN AUTH
========================================================= */

function isAdmin(req, body = {}) {

  const headerKey =
    req.headers[
      "x-admin-key"
    ];


  const bodyKey =
    body.admin_key ||
    body.adminKey;


  return (
    headerKey === ADMIN_KEY ||
    bodyKey === ADMIN_KEY
  );
}


/* =========================================================
   ACCESS KEY AUTH
========================================================= */

function getAccessKeyFromRequest(
  req
) {

  return (
    req.headers[
      "x-access-key"
    ] ||
    ""
  ).trim();
}


/* =========================================================
   KEY CHECK
========================================================= */

async function checkAccessKey(
  accessKey,
  deviceId
) {

  if (!dbReady) {

    return {

      success:false,

      error:
        "DATABASE_NOT_READY"
    };
  }


  const key =
    String(
      accessKey || ""
    ).trim();


  const device =
    String(
      deviceId || ""
    ).trim();


  if (
    !key ||
    !device
  ){

    return {

      success:false,

      error:
        "INVALID_REQUEST"
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
      [key]
    );


  if (
    !result.rows.length
  ){

    return {

      success:false,

      error:
        "INVALID_ACCESS_KEY"
    };
  }


  const row =
    result.rows[0];


  /*
    First device binds the key.
  */

  if (
    row.device_id &&
    row.device_id !==
      device
  ){

    return {

      success:false,

      error:
        "KEY_ALREADY_USED_ON_ANOTHER_DEVICE"
    };
  }


  await pool.query(
    `
    UPDATE access_keys
    SET
      device_id = $2,
      last_seen = $3
    WHERE access_key = $1
    `,
    [
      key,
      device,
      now()
    ]
  );


  return {

    success:true,

    error:null
  };
}


/* =========================================================
   ADMIN KEYS
========================================================= */

async function listKeys() {

  if (!dbReady)
    return [];


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


async function createAccessKey(
  requestedKey
) {

  if (!dbReady) {

    throw new Error(
      "DATABASE_NOT_READY"
    );
  }


  let key =
    String(
      requestedKey || ""
    ).trim();


  if (!key) {

    key =
      "DY-" +
      crypto
        .randomBytes(6)
        .toString("hex")
        .toUpperCase();
  }


  const result =
    await pool.query(
      `
      INSERT INTO access_keys (
        access_key,
        created_at
      )
      VALUES (
        $1,
        $2
      )
      RETURNING
        id,
        access_key,
        device_id,
        created_at,
        last_seen
      `,
      [
        key,
        now()
      ]
    );


  return result.rows[0];
}


/* =========================================================
   ADMIN MODEL TEST
========================================================= */

async function adminModelTest() {

  const history =
    Array.isArray(
      liveState.history
    )
      ? liveState.history
      : [];


  const prediction =
    createPrediction(
      history,
      liveState.targetIssue
    );


  return {

    success:true,

    liveTarget:
      liveState.targetIssue,

    latestSettled:
      liveState.latestSettledIssue,

    prediction:
      prediction.prediction,

    number:
      prediction.number,

    confidence:
      prediction.confidence,

    status:
      prediction.status,

    analysis:
      prediction.analysis,

    mode:
      "AI MODE",

    randomized:false
  };
}


/* =========================================================
   ADMIN WINGO TEST
========================================================= */

async function adminWingoTest() {

  try {

    const apiData =
      await fetchWingoHistory();


    const history =
      normalizeHistory(
        apiData
      );


    return {

      success:true,

      current:
        apiData?.current ||
        null,

      stats:
        apiData?.stats ||
        null,

      historyCount:
        history.length,

      latest:
        history[0] ||
        null,

      first10:
        history.slice(
          0,
          10
        )
    };

  } catch (error) {

    return {

      success:false,

      error:
        error.message
    };
  }
}


/* =========================================================
   STATIC FILE
========================================================= */

function serveStatic(
  req,
  res,
  pathname
) {

  let filePath;


  if (
    pathname === "/" ||
    pathname === "/prediction.html"
  ){

    filePath =
      PREDICTION_FILE;

  }else if(
    pathname === "/admin.html"
  ){

    filePath =
      ADMIN_FILE;

  }else if(
    pathname === "/music.mp3"
  ){

    filePath =
      MUSIC_FILE;

  }else{

    textResponse(
      res,
      404,
      "Not Found"
    );

    return;
  }


  if (
    !fs.existsSync(
      filePath
    )
  ){

    textResponse(
      res,
      404,
      "File not found"
    );

    return;
  }


  const ext =
    path.extname(
      filePath
    ).toLowerCase();


  const types = {

    ".html":
      "text/html; charset=utf-8",

    ".js":
      "application/javascript; charset=utf-8",

    ".css":
      "text/css; charset=utf-8",

    ".json":
      "application/json; charset=utf-8",

    ".mp3":
      "audio/mpeg"
  };


  const contentType =
    types[ext] ||
    "application/octet-stream";


  /*
    MP3 range support.
  */

  if (
    ext === ".mp3"
  ){

    serveAudio(
      req,
      res,
      filePath
    );

    return;
  }


  fs.readFile(
    filePath,
    (error, data) => {

      if (error) {

        textResponse(
          res,
          500,
          "Read error"
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


      res.end(data);
    }
  );
}


/* =========================================================
   AUDIO RANGE
========================================================= */

function serveAudio(
  req,
  res,
  filePath
) {

  fs.stat(
    filePath,
    (error, stats) => {

      if (error) {

        textResponse(
          res,
          404,
          "Audio not found"
        );

        return;
      }


      const size =
        stats.size;


      const range =
        req.headers.range;


      if (!range) {

        res.writeHead(
          200,
          {
            "Content-Type":
              "audio/mpeg",

            "Content-Length":
              size,

            "Accept-Ranges":
              "bytes"
          }
        );


        fs.createReadStream(
          filePath
        ).pipe(res);


        return;
      }


      const match =
        /bytes=(\d+)-(\d*)/
          .exec(range);


      if (!match) {

        res.writeHead(
          416,
          {
            "Content-Range":
              `bytes */${size}`
          }
        );

        res.end();

        return;
      }


      const start =
        Number(
          match[1]
        );


      let end =
        match[2]
          ? Number(
              match[2]
            )
          : size - 1;


      if (
        start >= size ||
        end >= size
      ){

        res.writeHead(
          416,
          {
            "Content-Range":
              `bytes */${size}`
          }
        );

        res.end();

        return;
      }


      const chunkSize =
        end -
        start +
        1;


      res.writeHead(
        206,
        {

          "Content-Type":
            "audio/mpeg",

          "Content-Length":
            chunkSize,

          "Content-Range":
            `bytes ${start}-${end}/${size}`,

          "Accept-Ranges":
            "bytes"
        }
      );


      fs.createReadStream(
        filePath,
        {
          start,
          end
        }
      ).pipe(res);
    }
  );
}


/* =========================================================
   SERVER
========================================================= */

const server =
  http.createServer(
    async (
      req,
      res
    ) => {

      try {

        if (
          req.method ===
          "OPTIONS"
        ){

          res.writeHead(
            204,
            {
              "Access-Control-Allow-Origin":
                "*",

              "Access-Control-Allow-Headers":
                "Content-Type, X-Admin-Key, X-Access-Key",

              "Access-Control-Allow-Methods":
                "GET, POST, DELETE, OPTIONS"
            }
          );

          res.end();

          return;
        }


        const parsed =
          new URL(
            req.url,
            `http://${req.headers.host || "localhost"}`
          );


        const pathname =
          parsed.pathname;


        /* =================================================
           HEALTH
        ================================================= */

        if (
          pathname ===
          "/health"
        ){

          jsonResponse(
            res,
            200,
            {

              ok:true,

              database:
                dbReady,

              wingoBot:
                Boolean(
                  WINGOBOT_TOKEN
                ),

              time:
                new Date().toISOString()
            }
          );

          return;
        }


        /* =================================================
           ACCESS KEY CHECK
        ================================================= */

        if (
          pathname ===
            "/api/key/check" &&
          req.method ===
            "POST"
        ){

          const body =
            await readBody(
              req
            );


          const result =
            await checkAccessKey(
              body.access_key ||
              body.accessKey,

              body.device_id ||
              body.deviceId
            );


          jsonResponse(
            res,
            result.success
              ? 200
              : 403,
            result
          );

          return;
        }


        /* =================================================
           LIVE STATE
        ================================================= */

        if (
          pathname ===
            "/api/state" &&
          req.method ===
            "GET"
        ){

          await updateLiveState();


          jsonResponse(
            res,
            200,
            liveState
          );

          return;
        }


        /* =================================================
           PREDICTION HISTORY
        ================================================= */

        if (
          pathname ===
            "/api/history" &&
          req.method ===
            "GET"
        ){

          await updateLiveState();


          const history =
            await getPredictionHistory();


          jsonResponse(
            res,
            200,
            {

              success:true,

              history
            }
          );

          return;
        }


        /* =================================================
           ADMIN STATUS
        ================================================= */

        if (
          pathname ===
            "/api/admin/status" &&
          req.method ===
            "GET"
        ){

          const body = {};


          if (
            !isAdmin(
              req,
              body
            )
          ){

            jsonResponse(
              res,
              403,
              {
                success:false,
                error:"UNAUTHORIZED"
              }
            );

            return;
          }


          await updateLiveState();


          jsonResponse(
            res,
            200,
            {

              success:true,

              database:
                dbReady,

              wingoBot:
                Boolean(
                  WINGOBOT_TOKEN
                ),

              currentIssue:
                liveState.currentIssue,

              latestSettledIssue:
                liveState.latestSettledIssue,

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

              mode:
                "AI MODE",

              randomized:false
            }
          );

          return;
        }


        /* =================================================
           ADMIN PING
        ================================================= */

        if (
          pathname ===
            "/api/admin/ping" &&
          req.method ===
            "POST"
        ){

          const body =
            await readBody(
              req
            );


          if (
            !isAdmin(
              req,
              body
            )
          ){

            jsonResponse(
              res,
              403,
              {
                success:false,
                error:"UNAUTHORIZED"
              }
            );

            return;
          }


          jsonResponse(
            res,
            200,
            {

              success:true,

              message:
                "Admin connection OK",

              time:
                new Date().toISOString()
            }
          );

          return;
        }


        /* =================================================
           ADMIN KEYS GET
        ================================================= */

        if (
          pathname ===
            "/api/admin/keys" &&
          req.method ===
            "GET"
        ){

          if (
            !isAdmin(
              req
            )
          ){

            jsonResponse(
              res,
              403,
              {
                success:false,
                error:"UNAUTHORIZED"
              }
            );

            return;
          }


          const keys =
            await listKeys();


          jsonResponse(
            res,
            200,
            {

              success:true,

              keys
            }
          );

          return;
        }


        /* =================================================
           ADMIN KEY CREATE
        ================================================= */

        if (
          pathname ===
            "/api/admin/keys" &&
          req.method ===
            "POST"
        ){

          const body =
            await readBody(
              req
            );


          if (
            !isAdmin(
              req,
              body
            )
          ){

            jsonResponse(
              res,
              403,
              {
                success:false,
                error:"UNAUTHORIZED"
              }
            );

            return;
          }


          try {

            const key =
              await createAccessKey(
                body.access_key ||
                body.accessKey ||
                body.key
              );


            jsonResponse(
              res,
              200,
              {

                success:true,

                key
              }
            );

          } catch (error) {

            jsonResponse(
              res,
              400,
              {

                success:false,

                error:
                  error.code ===
                  "23505"
                    ? "KEY_ALREADY_EXISTS"
                    : error.message
              }
            );
          }

          return;
        }


        /* =================================================
           ADMIN KEY DELETE
        ================================================= */

        if (
          pathname ===
            "/api/admin/keys" &&
          req.method ===
            "DELETE"
        ){

          const body =
            await readBody(
              req
            );


          if (
            !isAdmin(
              req,
              body
            )
          ){

            jsonResponse(
              res,
              403,
              {
                success:false,
                error:"UNAUTHORIZED"
              }
            );

            return;
          }


          const id =
            body.id;


          const accessKey =
            body.access_key ||
            body.accessKey ||
            body.key;


          let result;


          if (id) {

            result =
              await pool.query(
                `
                DELETE FROM access_keys
                WHERE id = $1
                RETURNING id, access_key
                `,
                [id]
              );

          }else{

            result =
              await pool.query(
                `
                DELETE FROM access_keys
                WHERE access_key = $1
                RETURNING id, access_key
                `,
                [accessKey]
              );
          }


          jsonResponse(
            res,
            200,
            {

              success:true,

              deleted:
                result.rows[0] ||
                null
            }
          );

          return;
        }


        /* =================================================
           RESET DEVICE
        ================================================= */

        if (
          pathname ===
            "/api/admin/reset-device" &&
          req.method ===
            "POST"
        ){

          const body =
            await readBody(
              req
            );


          if (
            !isAdmin(
              req,
              body
            )
          ){

            jsonResponse(
              res,
              403,
              {
                success:false,
                error:"UNAUTHORIZED"
              }
            );

            return;
          }


          const id =
            body.id;


          const accessKey =
            body.access_key ||
            body.accessKey ||
            body.key;


          let result;


          if (id) {

            result =
              await pool.query(
                `
                UPDATE access_keys
                SET
                  device_id = NULL,
                  last_seen = 0
                WHERE id = $1
                RETURNING id, access_key
                `,
                [id]
              );

          }else{

            result =
              await pool.query(
                `
                UPDATE access_keys
                SET
                  device_id = NULL,
                  last_seen = 0
                WHERE access_key = $1
                RETURNING id, access_key
                `,
                [accessKey]
              );
          }


          jsonResponse(
            res,
            200,
            {

              success:true,

              reset:
                result.rows[0] ||
                null
            }
          );

          return;
        }


        /* =================================================
           ADMIN WINGO TEST
        ================================================= */

        if (
          pathname ===
            "/api/admin/wingo-test" &&
          req.method ===
            "POST"
        ){

          const body =
            await readBody(
              req
            );


          if (
            !isAdmin(
              req,
              body
            )
          ){

            jsonResponse(
              res,
              403,
              {
                success:false,
                error:"UNAUTHORIZED"
              }
            );

            return;
          }


          const result =
            await adminWingoTest();


          jsonResponse(
            res,
            result.success
              ? 200
              : 502,
            result
          );

          return;
        }


        /* =================================================
           ADMIN MODEL TEST
        ================================================= */

        if (
          pathname ===
            "/api/admin/model-test" &&
          req.method ===
            "POST"
        ){

          const body =
            await readBody(
              req
            );


          if (
            !isAdmin(
              req,
              body
            )
          ){

            jsonResponse(
              res,
              403,
              {
                success:false,
                error:"UNAUTHORIZED"
              }
            );

            return;
          }


          await updateLiveState();


          const result =
            await adminModelTest();


          jsonResponse(
            res,
            200,
            result
          );

          return;
        }


        /* =================================================
           STATIC
        ================================================= */

        serveStatic(
          req,
          res,
          pathname
        );

      } catch (error) {

        console.error(
          "[SERVER ERROR]",
          error
        );


        jsonResponse(
          res,
          500,
          {

            success:false,

            error:
              "INTERNAL_SERVER_ERROR"
          }
        );
      }

    }
  );


/* =========================================================
   START
========================================================= */

async function start() {

  await initDatabase();


  /*
    Initial live update.
    Failure does not prevent server startup.
  */

  try {

    await updateLiveState();

  } catch (error) {

    console.error(
      "[INITIAL WINGO ERROR]",
      error.message
    );
  }


  /*
    Provider history is refreshed every 3 seconds.
    Frontend itself can poll every second for smooth
    timer/UI rendering.
  */

  setInterval(
    async () => {

      try {

        await updateLiveState();

      } catch (error) {

        console.error(
          "[POLL ERROR]",
          error.message
        );
      }

    },
    3000
  );


  server.listen(
    PORT,
    "0.0.0.0",
    () => {

      console.log(
        `DY AI Wingo server running on port ${PORT}`
      );

      console.log(
        `Database: ${dbReady ? "READY" : "NOT READY"}`
      );

      console.log(
        `WingoBot: ${WINGOBOT_TOKEN ? "TOKEN SET" : "TOKEN MISSING"}`
      );

    }
  );
}


start();


/* =========================================================
   GRACEFUL SHUTDOWN
========================================================= */

process.on(
  "SIGTERM",
  async () => {

    console.log(
      "SIGTERM received."
    );


    server.close(
      async () => {

        try {

          await pool.end();

        } catch {}


        process.exit(0);
      }
    );
  }
);


process.on(
  "SIGINT",
  async () => {

    console.log(
      "SIGINT received."
    );


    server.close(
      async () => {

        try {

          await pool.end();

        } catch {}


        process.exit(0);
      }
    );
  }
);
