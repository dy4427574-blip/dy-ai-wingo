const http = require("http");
const fs = require("fs");
const path = require("path");
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

/*
  Every new AI model gets a new version.
  Old prediction records will not contaminate
  the new model's W/L statistics.
*/
const MODEL_VERSION = "DY-AI-BS-V2";

const MAX_HISTORY = 500;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});


/* =========================================================
   STATE
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
      target_issue TEXT NOT NULL,
      prediction TEXT NOT NULL,
      number INTEGER,
      confidence NUMERIC DEFAULT 0,
      outcome TEXT DEFAULT 'PENDING',
      created_at BIGINT NOT NULL,
      settled_at BIGINT DEFAULT 0
    )
  `);

  await pool.query(`
    ALTER TABLE prediction_records
    ADD COLUMN IF NOT EXISTS model_version TEXT
  `);

  /*
    Old rows are intentionally kept in DB,
    but marked as legacy so they cannot affect
    the new AI's statistics.
  */

  await pool.query(`
    UPDATE prediction_records
    SET model_version = 'LEGACY'
    WHERE model_version IS NULL
  `);

  /*
    Same target can exist in different model versions.
  */

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS
    prediction_records_model_target_idx
    ON prediction_records(model_version, target_issue)
  `);
}


/* =========================================================
   HELPERS
========================================================= */

function now() {
  return Date.now();
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function opposite(side) {
  return side === "BIG" ? "SMALL" : "BIG";
}

function sideFromNumber(n) {

  const x = Number(n);

  if (!Number.isFinite(x))
    return null;

  return x >= 5 ? "BIG" : "SMALL";
}

function normalizeIssue(value) {

  if (
    value === undefined ||
    value === null
  ) {
    return null;
  }

  return String(value);
}


function incrementIssue(issue) {

  if (!issue)
    return null;

  const str = String(issue);

  const match =
    str.match(/^(.*?)(\d+)$/);

  if (!match)
    return null;

  const prefix = match[1];
  const digits = match[2];

  const next =
    (BigInt(digits) + 1n)
      .toString()
      .padStart(
        digits.length,
        "0"
      );

  return prefix + next;
}


/* =========================================================
   JSON
========================================================= */

function json(res, status, data) {

  const body =
    JSON.stringify(data);

  res.writeHead(status, {
    "Content-Type":
      "application/json; charset=utf-8",
    "Cache-Control":
      "no-store",
    "Access-Control-Allow-Origin":
      "*"
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
    "Content-Type":
      `${type}; charset=utf-8`,
    "Cache-Control":
      "no-store"
  });

  res.end(body);
}


/* =========================================================
   WINGOBOT API
========================================================= */

async function fetchWingoBot() {

  if (!WINGOBOT_TOKEN) {

    throw new Error(
      "WINGOBOT_TOKEN is not configured"
    );

  }

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      10000
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
          signal: controller.signal
        }
      );

    if (!response.ok) {

      throw new Error(
        `WingoBot HTTP ${response.status}`
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

function normalizeHistory(data) {

  const raw =
    Array.isArray(data?.history)
      ? data.history
      : [];

  const seen = new Set();

  const output = [];

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

    if (!issue)
      continue;

    if (
      !Number.isFinite(number) ||
      number < 0 ||
      number > 9
    ) {
      continue;
    }

    if (seen.has(issue))
      continue;

    seen.add(issue);

    output.push({
      issueNumber: issue,
      number,
      side:
        sideFromNumber(number),
      colour:
        row.colour ?? null,
      premium:
        row.premium ?? null,
      sum:
        row.sum ?? null
    });
  }

  return output.slice(
    0,
    MAX_HISTORY
  );
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

    providerState = {

      online: true,

      history,

      currentIssue:
        normalizeIssue(
          data?.current?.issueNumber
        ),

      lastUpdated:
        now(),

      error: null

    };

    /*
      Settle only after exact actual
      issue is present.
    */

    await settlePredictions(
      history
    );

    await ensurePrediction();

  } catch (error) {

    providerState.online = false;

    providerState.error =
      error.message ||
      String(error);

  }

}


/* =========================================================
   TARGET
========================================================= */

function getLatestSettled() {

  return (
    providerState.history[0] ||
    null
  );

}


function getTargetIssue() {

  const latest =
    getLatestSettled();

  if (!latest)
    return null;

  const latestIssue =
    String(
      latest.issueNumber
    );

  const current =
    providerState.currentIssue
      ? String(
          providerState.currentIssue
        )
      : null;

  /*
    If provider current issue is ahead,
    it is the target.

    Otherwise next issue after latest
    settled result becomes target.
  */

  if (
    current &&
    current !== latestIssue
  ) {

    return current;

  }

  return incrementIssue(
    latestIssue
  );
}


/* =========================================================
   SIDE HISTORY
========================================================= */

function sides(
  history,
  limit
) {

  return history
    .slice(0, limit)
    .map(x => x.side)
    .filter(Boolean);
}


/* =========================================================
   SHORT TREND
========================================================= */

function getShortTrend(history) {

  const arr =
    sides(history, 7);

  if (arr.length < 3) {

    return {
      side: null,
      strength: 0,
      big: 0,
      small: 0
    };

  }

  let big = 0;
  let small = 0;

  arr.forEach(side => {

    if (side === "BIG")
      big++;

    if (side === "SMALL")
      small++;

  });

  const side =
    big === small
      ? null
      : big > small
        ? "BIG"
        : "SMALL";

  const strength =
    Math.abs(
      big - small
    ) / arr.length;

  return {
    side,
    strength,
    big,
    small
  };
}


/* =========================================================
   MEDIUM TREND
========================================================= */

function getMediumTrend(history) {

  const arr =
    sides(history, 20);

  if (arr.length < 6) {

    return {
      side: null,
      strength: 0,
      big: 0,
      small: 0
    };

  }

  let big = 0;
  let small = 0;

  arr.forEach(side => {

    if (side === "BIG")
      big++;

    if (side === "SMALL")
      small++;

  });

  const side =
    big === small
      ? null
      : big > small
        ? "BIG"
        : "SMALL";

  const strength =
    Math.abs(
      big - small
    ) / arr.length;

  return {
    side,
    strength,
    big,
    small
  };
}


/* =========================================================
   CURRENT STREAK
========================================================= */

function getStreak(history) {

  const arr =
    sides(history, 50);

  if (!arr.length) {

    return {
      side: null,
      age: 0
    };

  }

  const side =
    arr[0];

  let age = 0;

  for (const x of arr) {

    if (x !== side)
      break;

    age++;

  }

  return {
    side,
    age
  };
}


/* =========================================================
   TRANSITION MODEL
========================================================= */

function getTransitionModel(history) {

  const arr =
    sides(history, 100);

  if (arr.length < 5) {

    return {
      side: null,
      continuation: .5,
      reversal: .5,
      samples: 0
    };

  }

  const table = {

    BIG: {
      BIG: 0,
      SMALL: 0
    },

    SMALL: {
      BIG: 0,
      SMALL: 0
    }

  };


  /*
    history[0] = newest
    history[i+1] = previous
  */

  for (
    let i = 0;
    i < arr.length - 1;
    i++
  ) {

    const previous =
      arr[i + 1];

    const current =
      arr[i];

    if (
      table[previous] &&
      table[previous][current]
      !== undefined
    ) {

      table[previous][current]++;

    }

  }


  const last =
    arr[0];

  const same =
    table[last][last];

  const reverse =
    table[last][opposite(last)];

  const total =
    same + reverse;


  if (!total) {

    return {
      side: last,
      continuation: .5,
      reversal: .5,
      samples: 0
    };

  }


  return {

    side: last,

    continuation:
      same / total,

    reversal:
      reverse / total,

    samples: total

  };

}


/* =========================================================
   RUN HISTORY
   Used to understand whether current
   streak is normal or becoming old.
========================================================= */

function getRunHistory(history) {

  const arr =
    sides(history, 80);

  const runs = [];

  if (!arr.length)
    return runs;


  let side =
    arr[0];

  let length = 1;


  for (
    let i = 1;
    i < arr.length;
    i++
  ) {

    if (arr[i] === side) {

      length++;

    } else {

      runs.push({
        side,
        length
      });

      side = arr[i];
      length = 1;

    }

  }


  runs.push({
    side,
    length
  });


  return runs;

}


/* =========================================================
   TREND BREAK MODEL
========================================================= */

function getBreakModel(
  history,
  streak,
  transition
) {

  if (
    !streak.side ||
    streak.age < 2
  ) {

    return {
      side: streak.side,
      risk: .20,
      evidence: []
    };

  }


  let risk = 0;

  const evidence = [];


  /*
    AGE PRESSURE

    This is deliberately gradual.

    A streak does NOT automatically
    mean reversal.
  */

  if (streak.age >= 3) {

    risk += .08;

  }

  if (streak.age >= 4) {

    risk += .10;

    evidence.push(
      "streak ageing"
    );

  }

  if (streak.age >= 5) {

    risk += .12;

  }

  if (streak.age >= 6) {

    risk += .12;

    evidence.push(
      "long streak"
    );

  }

  if (streak.age >= 7) {

    risk += .10;

  }


  /*
    Transition reversal evidence.
  */

  if (
    transition.reversal >
    transition.continuation
  ) {

    risk += .18;

    evidence.push(
      "reversal transition"
    );

  } else if (
    transition.reversal >= .40
  ) {

    risk += .08;

  }


  /*
    Look at previous runs of same side.

    If current streak is already much longer
    than historical runs, break pressure rises.
  */

  const runs =
    getRunHistory(history);


  const previousSameRuns =
    runs
      .slice(1)
      .filter(
        r =>
          r.side === streak.side
      )
      .map(
        r => r.length
      );


  if (
    previousSameRuns.length >= 2
  ) {

    const average =
      previousSameRuns.reduce(
        (a,b) => a + b,
        0
      ) /
      previousSameRuns.length;


    if (
      streak.age >
      average + 1
    ) {

      risk += .13;

      evidence.push(
        "above normal streak"
      );

    }


    if (
      streak.age >
      average + 2
    ) {

      risk += .12;

      evidence.push(
        "streak unusually old"
      );

    }

  }


  /*
    Recent instability.

    We don't call every alternation a break.
  */

  const recent =
    sides(history, 8);

  let changes = 0;

  for (
    let i = 0;
    i < recent.length - 1;
    i++
  ) {

    if (
      recent[i] !==
      recent[i + 1]
    ) {

      changes++;

    }

  }


  const instability =
    recent.length > 1
      ? changes /
        (recent.length - 1)
      : 0;


  if (
    instability >= .55
  ) {

    risk += .07;

    evidence.push(
      "recent instability"
    );

  }


  return {

    side: streak.side,

    risk:
      clamp(
        risk,
        .05,
        .90
      ),

    evidence

  };

}


/* =========================================================
   HISTORICAL PATTERN MODEL
========================================================= */

function historicalPattern(history) {

  const arr =
    sides(history, 80);

  if (arr.length < 10) {

    return {
      side: null,
      confidence: 0,
      samples: 0
    };

  }


  /*
    Compare the current recent sequence
    with older sequences of the same length.

    We use 5-result pattern.
  */

  const length = 5;

  const current =
    arr
      .slice(0, length)
      .join("-");


  let bigNext = 0;
  let smallNext = 0;
  let samples = 0;


  for (
    let i = length;
    i < arr.length;
    i++
  ) {

    const pattern =
      arr
        .slice(
          i - length,
          i
        )
        .join("-");


    if (
      pattern !== current
    ) {

      continue;

    }


    /*
      arr[i] is the result that came
      immediately after that historical pattern.
    */

    if (arr[i] === "BIG")
      bigNext++;

    if (arr[i] === "SMALL")
      smallNext++;

    samples++;

  }


  if (!samples) {

    return {
      side: null,
      confidence: 0,
      samples: 0
    };

  }


  const side =
    bigNext === smallNext
      ? null
      : bigNext > smallNext
        ? "BIG"
        : "SMALL";


  const confidence =
    Math.max(
      bigNext,
      smallNext
    ) /
    samples;


  return {

    side,

    confidence:
      clamp(
        confidence,
        0,
        1
      ),

    samples

  };

}


/* =========================================================
   REGIME
========================================================= */

function getRegime(
  short,
  medium,
  streak,
  transition,
  breakModel
) {

  if (
    breakModel.risk >= .68 &&
    streak.age >= 4
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
    streak.age <= 2 &&
    streak.side
  ) {

    return "NEW_TREND";

  }


  if (
    breakModel.risk >= .42
  ) {

    return "TREND_WEAKENING";

  }


  if (
    transition.continuation >= .65 &&
    breakModel.risk < .40
  ) {

    return "TREND_CONTINUING";

  }


  return "NEUTRAL";
}


/* =========================================================
   FINAL BIG/SMALL ENGINE
========================================================= */

function createPrediction(
  history,
  targetIssue
) {

  if (
    !history.length ||
    !targetIssue
  ) {

    return null;

  }


  const short =
    getShortTrend(history);

  const medium =
    getMediumTrend(history);

  const streak =
    getStreak(history);

  const transition =
    getTransitionModel(history);

  const breakModel =
    getBreakModel(
      history,
      streak,
      transition
    );

  const historical =
    historicalPattern(history);


  const regime =
    getRegime(
      short,
      medium,
      streak,
      transition,
      breakModel
    );


  /*
    Only BIG / SMALL.

    No number model.
    No number pressure.
  */

  const score = {
    BIG: 0,
    SMALL: 0
  };


  /* -------------------------------------------------------
     SHORT TREND
  ------------------------------------------------------- */

  if (short.side) {

    let weight = .85;

    /*
      Old trend gets less continuation power.
    */

    if (streak.age >= 4)
      weight *= .72;

    if (streak.age >= 6)
      weight *= .55;


    score[short.side] +=
      short.strength *
      weight;

  }


  /* -------------------------------------------------------
     MEDIUM TREND
  ------------------------------------------------------- */

  if (medium.side) {

    score[medium.side] +=
      medium.strength *
      .65;

  }


  /* -------------------------------------------------------
     TRANSITION
  ------------------------------------------------------- */

  if (transition.side) {

    let continuation =
      transition.continuation;

    let reversal =
      transition.reversal;


    /*
      Long streak = don't blindly follow
      transition continuation.
    */

    if (streak.age >= 4)
      continuation *= .72;

    if (streak.age >= 6)
      continuation *= .55;


    score[transition.side] +=
      continuation *
      .65;


    score[
      opposite(
        transition.side
      )
    ] +=
      reversal *
      .60;

  }


  /* -------------------------------------------------------
     BREAK MODEL
  ------------------------------------------------------- */

  if (breakModel.side) {

    score[
      opposite(
        breakModel.side
      )
    ] +=
      breakModel.risk *
      1.05;

  }


  /* -------------------------------------------------------
     HISTORICAL PATTERN
  ------------------------------------------------------- */

  if (
    historical.side &&
    historical.samples >= 2
  ) {

    score[historical.side] +=
      historical.confidence *
      .55;

  }


  /* -------------------------------------------------------
     ANTI BLIND TREND
  ------------------------------------------------------- */

  if (
    streak.age >= 5 &&
    streak.side
  ) {

    /*
      This does not force reversal.

      It simply makes the opposite side
      competitive when the streak becomes old.
    */

    const pressure =
      Math.min(
        .55,
        .10 +
        (
          streak.age - 5
        ) * .10
      );


    score[
      opposite(
        streak.side
      )
    ] += pressure;

  }


  /* -------------------------------------------------------
     SHORT / MEDIUM CONFLICT
  ------------------------------------------------------- */

  if (
    short.side &&
    medium.side &&
    short.side !== medium.side
  ) {

    score[short.side] *= .88;
    score[medium.side] *= .94;

  }


  /* -------------------------------------------------------
     FINAL SIDE
  ------------------------------------------------------- */

  let finalSide =
    score.BIG >= score.SMALL
      ? "BIG"
      : "SMALL";


  const difference =
    Math.abs(
      score.BIG -
      score.SMALL
    );


  /*
    When extremely close, use medium trend
    only as a tie-breaker.

    Not as a dominant signal.
  */

  if (
    difference < .06 &&
    medium.side
  ) {

    finalSide =
      medium.side;

  }


  /* -------------------------------------------------------
     MODEL AGREEMENT
  ------------------------------------------------------- */

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
        : opposite(
            transition.side
          )
    );

  }


  if (breakModel.side) {

    votes.push(
      breakModel.risk >= .55
        ? opposite(
            breakModel.side
          )
        : breakModel.side
    );

  }


  if (historical.side) {

    votes.push(
      historical.side
    );

  }


  const agreement =
    votes.length
      ? votes.filter(
          x =>
            x === finalSide
        ).length /
        votes.length
      : .50;


  /* -------------------------------------------------------
     CONFIDENCE
  ------------------------------------------------------- */

  let confidence = 50;


  confidence +=
    clamp(
      difference * 24,
      0,
      13
    );


  confidence +=
    agreement * 13;


  confidence +=
    short.strength * 5;


  confidence +=
    medium.strength * 4;


  /*
    Old streak = uncertainty,
    not confidence.
  */

  if (streak.age >= 4)
    confidence -= 5;

  if (streak.age >= 6)
    confidence -= 6;


  if (regime === "CONFLICT")
    confidence -= 7;


  if (
    regime === "POSSIBLE_BREAK"
  )
    confidence -= 3;


  /*
    Prevent fake 90-100% confidence.
  */

  confidence =
    clamp(
      Math.round(confidence),
      45,
      86
    );


  /* -------------------------------------------------------
     SUMMARY
  ------------------------------------------------------- */

  let summary;


  if (
    regime === "POSSIBLE_BREAK"
  ) {

    summary =
      "Current streak is old and break evidence is being checked. The model is not blindly following the trend.";

  } else if (
    regime === "TREND_WEAKENING"
  ) {

    summary =
      "The current trend is weakening. Continuation and reversal signals are being compared.";

  } else if (
    regime === "CONFLICT"
  ) {

    summary =
      "Short and medium signals disagree, so confidence has been reduced.";

  } else if (
    regime === "NEW_TREND"
  ) {

    summary =
      "A new trend is forming. The model is waiting for supporting signals instead of overcommitting.";

  } else if (
    regime === "TREND_CONTINUING"
  ) {

    summary =
      "Continuation has supporting evidence, but the trend is only one part of the decision.";

  } else {

    summary =
      "BIG/SMALL decision is based on trend, transition, streak behaviour and historical pattern comparison.";

  }


  return {

    targetIssue,

    prediction:
      finalSide,

    confidence,

    analysis: {

      regime,

      trend:
        short.side ||
        medium.side ||
        "NEUTRAL",

      trendStrength:
        Math.round(
          short.strength * 100
        ),

      trendAge:
        streak.age,

      breakRisk:
        Math.round(
          breakModel.risk * 100
        ),

      continuation:
        Math.round(
          transition.continuation *
          100
        ),

      modelAgreement:
        Math.round(
          agreement * 100
        ),

      shortTrend:
        short.side ||
        "NEUTRAL",

      mediumTrend:
        medium.side ||
        "NEUTRAL",

      historicalMatch:
        Math.round(
          historical.confidence *
          100
        ),

      summary

    }

  };

}


/* =========================================================
   ONE PREDICTION PER TARGET
========================================================= */

async function ensurePrediction() {

  const target =
    getTargetIssue();

  if (!target)
    return null;


  /*
    Same target = same prediction.
  */

  if (
    cachedTarget === target &&
    cachedPrediction
  ) {

    return cachedPrediction;

  }


  /*
    First check current model's DB record.
  */

  const existing =
    await pool.query(
      `
      SELECT *
      FROM prediction_records
      WHERE model_version = $1
        AND target_issue = $2
      LIMIT 1
      `,
      [
        MODEL_VERSION,
        target
      ]
    );


  if (
    existing.rows.length
  ) {

    const row =
      existing.rows[0];


    cachedTarget =
      target;


    cachedPrediction = {

      targetIssue:
        target,

      prediction:
        row.prediction,

      confidence:
        Number(
          row.confidence || 0
        ),

      analysis: {
        regime:
          "LOCKED",
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
      created_at,
      model_version
    )
    VALUES
    ($1,$2,NULL,$3,'PENDING',$4,$5)
    ON CONFLICT
    (model_version,target_issue)
    DO NOTHING
    `,
    [
      target,
      prediction.prediction,
      prediction.confidence,
      now(),
      MODEL_VERSION
    ]
  );


  cachedTarget =
    target;

  cachedPrediction =
    prediction;


  return prediction;

}


/* =========================================================
   EXACT PERIOD SETTLEMENT
========================================================= */

async function settlePredictions(
  history
) {

  if (!history.length)
    return;


  const actualMap =
    new Map(
      history.map(
        row => [
          String(
            row.issueNumber
          ),
          row
        ]
      )
    );


  const pending =
    await pool.query(
      `
      SELECT *
      FROM prediction_records
      WHERE model_version = $1
        AND outcome = 'PENDING'
      ORDER BY id DESC
      LIMIT 500
      `,
      [
        MODEL_VERSION
      ]
    );


  for (
    const prediction
    of pending.rows
  ) {

    /*
      EXACT TARGET MATCH ONLY.
    */

    const actual =
      actualMap.get(
        String(
          prediction.target_issue
        )
      );


    if (!actual)
      continue;


    const actualSide =
      sideFromNumber(
        actual.number
      );


    if (!actualSide)
      continue;


    const outcome =
      actualSide ===
      prediction.prediction
        ? "WIN"
        : "LOSS";


    await pool.query(
      `
      UPDATE prediction_records
      SET outcome = $1,
          settled_at = $2
      WHERE id = $3
        AND model_version = $4
      `,
      [
        outcome,
        now(),
        prediction.id,
        MODEL_VERSION
      ]
    );

  }

}


/* =========================================================
   STATS
========================================================= */

async function getStats() {

  const result =
    await pool.query(
      `
      SELECT
        outcome,
        COUNT(*)::int AS count
      FROM prediction_records
      WHERE model_version = $1
        AND outcome IN ('WIN','LOSS')
      GROUP BY outcome
      `,
      [
        MODEL_VERSION
      ]
    );


  let wins = 0;
  let losses = 0;


  for (
    const row of result.rows
  ) {

    if (
      row.outcome === "WIN"
    ) {

      wins =
        Number(
          row.count
        );

    }


    if (
      row.outcome === "LOSS"
    ) {

      losses =
        Number(
          row.count
        );

    }

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
              wins /
              total *
              100
            ).toFixed(1)
          )
        : 0

  };

}


/* =========================================================
   LAST 30
========================================================= */

async function getPredictionHistory() {

  const result =
    await pool.query(
      `
      SELECT
        target_issue,
        prediction,
        confidence,
        outcome,
        created_at,
        settled_at
      FROM prediction_records
      WHERE model_version = $1
      ORDER BY id DESC
      LIMIT 30
      `,
      [
        MODEL_VERSION
      ]
    );


  /*
    Attach actual result only if
    EXACT same issue exists.
  */

  const actualMap =
    new Map(
      providerState.history.map(
        row => [
          String(
            row.issueNumber
          ),
          row
        ]
      )
    );


  return result.rows.map(
    row => {

      const actual =
        actualMap.get(
          String(
            row.target_issue
          )
        );


      return {

        target_issue:
          row.target_issue,

        prediction:
          row.prediction,

        confidence:
          Number(
            row.confidence || 0
          ),

        outcome:
          row.outcome,

        actual_number:
          actual?.number ??
          null,

        actual_result:
          actual?.side ??
          null,

        created_at:
          row.created_at,

        settled_at:
          row.settled_at

      };

    }
  );

}


/* =========================================================
   BACKTEST
========================================================= */

function calculateBacktest(
  history
) {

  if (
    history.length < 20
  ) {

    return {

      samples: 0,
      wins: 0,
      losses: 0,
      accuracy: 0

    };

  }


  let wins = 0;
  let losses = 0;


  const max =
    Math.min(
      history.length - 1,
      100
    );


  for (
    let i = 0;
    i < max;
    i++
  ) {

    const actual =
      history[i];


    const training =
      history.slice(
        i + 1
      );


    if (
      !actual?.side ||
      training.length < 10
    ) {

      continue;

    }


    /*
      Backtest prediction for that
      historical target.

      IMPORTANT:
      No number prediction.
    */

    const prediction =
      createPrediction(
        training,
        actual.issueNumber
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
              wins /
              total *
              100
            ).toFixed(1)
          )
        : 0

  };

}


/* =========================================================
   ADMIN AUTH
========================================================= */

function isAdmin(req) {

  return Boolean(
    req.headers["x-admin-key"] &&
    req.headers["x-admin-key"] ===
      ADMIN_KEY
  );

}


function requireAdmin(
  req,
  res
) {

  if (!isAdmin(req)) {

    json(
      res,
      401,
      {
        ok: false,
        error: "Unauthorized"
      }
    );

    return false;

  }

  return true;

}


/* =========================================================
   BODY
========================================================= */

function readBody(req) {

  return new Promise(
    (resolve,reject)=>{

      let body = "";

      req.on(
        "data",
        chunk => {

          body += chunk;

          if (
            body.length >
            1024 * 1024
          ) {

            reject(
              new Error(
                "Request too large"
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
                "Invalid JSON"
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
   ACCESS KEY CHECK
========================================================= */

async function checkAccessKey(
  req,
  res
) {

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


    if (
      !key ||
      !deviceId
    ) {

      json(
        res,
        400,
        {
          ok:false,
          error:
            "Access key and device id required"
        }
      );

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


    if (
      !result.rows.length
    ) {

      json(
        res,
        403,
        {
          ok:false,
          error:
            "Invalid access key"
        }
      );

      return;

    }


    const row =
      result.rows[0];


    if (
      row.device_id &&
      row.device_id !== deviceId
    ) {

      json(
        res,
        403,
        {
          ok:false,
          error:
            "This key is already bound to another device"
        }
      );

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


    json(
      res,
      200,
      {
        ok:true
      }
    );


  } catch(error) {

    json(
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


/* =========================================================
   STATE
========================================================= */

async function getState() {

  const target =
    getTargetIssue();


  if (
    target !== cachedTarget
  ) {

    cachedTarget = null;
    cachedPrediction = null;

    await ensurePrediction();

  }


  const prediction =
    cachedPrediction ||
    await ensurePrediction();


  const stats =
    await getStats();


  const latest =
    getLatestSettled();


  const history =
    providerState.history;


  const backtest =
    calculateBacktest(
      history
    );


  /*
    Timer is an estimate because the
    documented history endpoint does not
    expose the authoritative game timer.
  */

  let countdown = 0;


  if (
    providerState.lastUpdated
  ) {

    const elapsed =
      Math.floor(
        (
          Date.now() -
          providerState.lastUpdated
        ) / 1000
      );


    countdown =
      ROUND_SECONDS -
      (
        elapsed %
        ROUND_SECONDS
      );

  }


  return {

    ready:
      providerState.online &&
      Boolean(prediction),

    providerOnline:
      providerState.online,

    gameUrl:
      GAME_URL,

    modelVersion:
      MODEL_VERSION,

    latestSettledIssue:
      latest?.issueNumber ||
      null,

    currentIssue:
      providerState.currentIssue,

    targetIssue:
      target,

    countdown,

    prediction:
      prediction?.prediction ||
      null,

    /*
      Number intentionally removed.
    */

    confidence:
      prediction?.confidence ||
      0,

    status:
      prediction
        ? "READY"
        : "WAITING",

    analysis:
      prediction?.analysis ||
      null,

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
   ADMIN STATUS
========================================================= */

async function adminStatus(
  req,
  res
) {

  if (
    !requireAdmin(
      req,
      res
    )
  )
    return;


  let dbOnline = false;


  try {

    await pool.query(
      "SELECT 1"
    );

    dbOnline = true;

  } catch {}


  json(
    res,
    200,
    {

      ok:true,

      modelVersion:
        MODEL_VERSION,

      server:{
        online:true,
        uptime:
          process.uptime()
      },

      database:{
        online:
          dbOnline
      },

      provider:{
        online:
          providerState.online,

        currentIssue:
          providerState.currentIssue,

        latestSettled:
          getLatestSettled()
            ?.issueNumber ||
          null,

        history:
          providerState.history.length,

        error:
          providerState.error
      }

    }
  );

}


/* =========================================================
   ADMIN PING
========================================================= */

async function adminPing(
  req,
  res
) {

  if (
    !requireAdmin(
      req,
      res
    )
  )
    return;


  try {

    const start =
      Date.now();


    const data =
      await fetchWingoBot();


    json(
      res,
      200,
      {

        ok:true,

        latency:
          Date.now() -
          start,

        currentIssue:
          data?.current
            ?.issueNumber ||
          null,

        historyCount:
          Array.isArray(
            data?.history
          )
            ? data.history.length
            : 0

      }
    );


  } catch(error) {

    json(
      res,
      502,
      {
        ok:false,
        error:
          error.message
      }
    );

  }

}


/* =========================================================
   ADMIN WINGO TEST
========================================================= */

async function adminWingoTest(
  req,
  res
) {

  if (
    !requireAdmin(
      req,
      res
    )
  )
    return;


  try {

    const data =
      await fetchWingoBot();


    const history =
      normalizeHistory(data);


    json(
      res,
      200,
      {

        ok:true,

        current:
          data?.current ||
          null,

        stats:
          data?.stats ||
          null,

        history:
          history.slice(
            0,
            10
          )

      }
    );


  } catch(error) {

    json(
      res,
      502,
      {
        ok:false,
        error:
          error.message
      }
    );

  }

}


/* =========================================================
   ADMIN MODEL TEST
========================================================= */

async function adminModelTest(
  req,
  res
) {

  if (
    !requireAdmin(
      req,
      res
    )
  )
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


  const backtest =
    calculateBacktest(
      providerState.history
    );


  json(
    res,
    200,
    {

      ok:true,

      modelVersion:
        MODEL_VERSION,

      targetIssue:
        target,

      prediction,

      backtest,

      historyUsed:
        providerState.history.length

    }
  );

}


/* =========================================================
   ADMIN KEYS
========================================================= */

async function adminKeys(
  req,
  res
) {

  if (
    !requireAdmin(
      req,
      res
    )
  )
    return;


  if (
    req.method === "GET"
  ) {

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


    json(
      res,
      200,
      {
        ok:true,
        keys:
          result.rows
      }
    );

    return;

  }


  if (
    req.method === "POST"
  ) {

    const body =
      await readBody(req);


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
          ok:false,
          error:
            "Access key required"
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
            created_at
          )
          VALUES
          ($1,$2)
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
          ok:true,
          key:
            result.rows[0]
        }
      );


    } catch(error) {

      if (
        error.code ===
        "23505"
      ) {

        json(
          res,
          409,
          {
            ok:false,
            error:
              "Access key already exists"
          }
        );

      } else {

        throw error;

      }

    }

    return;

  }


  if (
    req.method === "DELETE"
  ) {

    const body =
      await readBody(req);


    const id =
      Number(body.id);


    if (
      !Number.isInteger(id)
    ) {

      json(
        res,
        400,
        {
          ok:false,
          error:
            "Invalid key id"
        }
      );

      return;

    }


    await pool.query(
      `
      DELETE FROM access_keys
      WHERE id = $1
      `,
      [id]
    );


    json(
      res,
      200,
      {
        ok:true
      }
    );

    return;

  }


  json(
    res,
    405,
    {
      ok:false,
      error:
        "Method not allowed"
    }
  );

}


/* =========================================================
   RESET DEVICE
========================================================= */

async function resetDevice(
  req,
  res
) {

  if (
    !requireAdmin(
      req,
      res
    )
  )
    return;


  const body =
    await readBody(req);


  const id =
    Number(body.id);


  if (
    !Number.isInteger(id)
  ) {

    json(
      res,
      400,
      {
        ok:false,
        error:
          "Invalid key id"
      }
    );

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


  json(
    res,
    200,
    {
      ok:true
    }
  );

}


/* =========================================================
   STATIC FILES
========================================================= */

function serveFile(
  req,
  res,
  fileName
) {

  const filePath =
    path.join(
      __dirname,
      fileName
    );


  if (
    !fs.existsSync(
      filePath
    )
  ) {

    text(
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


  /*
    MP3 range support.
  */

  if (
    ext === ".mp3"
  ) {

    const stat =
      fs.statSync(
        filePath
      );


    const range =
      req.headers.range;


    if (range) {

      const match =
        range.match(
          /bytes=(\d*)-(\d*)/
        );


      if (match) {

        const start =
          match[1]
            ? Number(
                match[1]
              )
            : 0;


        const end =
          match[2]
            ? Number(
                match[2]
              )
            : stat.size - 1;


        const safeEnd =
          Math.min(
            end,
            stat.size - 1
          );


        res.writeHead(
          206,
          {

            "Content-Type":
              contentType,

            "Content-Range":
              `bytes ${start}-${safeEnd}/${stat.size}`,

            "Accept-Ranges":
              "bytes",

            "Content-Length":
              safeEnd - start + 1

          }
        );


        fs.createReadStream(
          filePath,
          {
            start,
            end:
              safeEnd
          }
        ).pipe(res);


        return;

      }

    }


    res.writeHead(
      200,
      {

        "Content-Type":
          contentType,

        "Accept-Ranges":
          "bytes",

        "Content-Length":
          stat.size

      }
    );


    fs.createReadStream(
      filePath
    ).pipe(res);


    return;

  }


  res.writeHead(
    200,
    {

      "Content-Type":
        `${contentType}; charset=utf-8`,

      "Cache-Control":
        "no-cache"

    }
  );


  fs.createReadStream(
    filePath
  ).pipe(res);

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

        const url =
          new URL(
            req.url,
            `http://${req.headers.host}`
          );


        /* HEALTH */

        if (
          url.pathname ===
          "/health"
        ) {

          json(
            res,
            200,
            {
              ok:true,
              service:
                "DY AI",
              modelVersion:
                MODEL_VERSION,
              providerOnline:
                providerState.online
            }
          );

          return;

        }


        /* ACCESS */

        if (
          url.pathname ===
          "/api/key/check"
        ) {

          await checkAccessKey(
            req,
            res
          );

          return;

        }


        /* STATE */

        if (
          url.pathname ===
          "/api/state"
        ) {

          const state =
            await getState();


          json(
            res,
            200,
            state
          );

          return;

        }


        /* HISTORY */

        if (
          url.pathname ===
          "/api/history"
        ) {

          json(
            res,
            200,
            {
              ok:true,
              history:
                providerState.history
            }
          );

          return;

        }


        /* ADMIN */

        if (
          url.pathname ===
          "/api/admin/status"
        ) {

          await adminStatus(
            req,
            res
          );

          return;

        }


        if (
          url.pathname ===
          "/api/admin/ping"
        ) {

          await adminPing(
            req,
            res
          );

          return;

        }


        if (
          url.pathname ===
          "/api/admin/wingo-test"
        ) {

          await adminWingoTest(
            req,
            res
          );

          return;

        }


        if (
          url.pathname ===
          "/api/admin/model-test"
        ) {

          await adminModelTest(
            req,
            res
          );

          return;

        }


        if (
          url.pathname ===
          "/api/admin/keys"
        ) {

          await adminKeys(
            req,
            res
          );

          return;

        }


        if (
          url.pathname ===
          "/api/admin/reset-device"
        ) {

          await resetDevice(
            req,
            res
          );

          return;

        }


        /* STATIC */

        if (
          url.pathname === "/" ||
          url.pathname ===
            "/prediction.html"
        ) {

          serveFile(
            req,
            res,
            "prediction.html"
          );

          return;

        }


        if (
          url.pathname ===
          "/admin.html"
        ) {

          serveFile(
            req,
            res,
            "admin.html"
          );

          return;

        }


        if (
          url.pathname ===
          "/music.mp3"
        ) {

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


        json(
          res,
          500,
          {
            ok:false,
            error:
              error.message ||
              "Internal server error"
          }
        );

      }

    }
  );


/* =========================================================
   START
========================================================= */

async function start() {

  try {

    await initDB();

    console.log(
      "Database initialized."
    );


    await updateProvider();

    console.log(
      "Provider initialized."
    );


    setInterval(
      updateProvider,
      PROVIDER_POLL_MS
    );


    server.listen(
      PORT,
      "0.0.0.0",
      () => {

        console.log(
          `DY AI running on port ${PORT}`
        );

        console.log(
          `Model: ${MODEL_VERSION}`
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
