const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 10000);

const ADMIN_KEY =
  process.env.ADMIN_KEY || "change-this-admin-key";

const WINGOBOT_TOKEN =
  process.env.WINGOBOT_TOKEN || "";

const WINGOBOT_URL =
  "https://api.wingobot.com/v2/30-sec-game-history";

const ROUND_SECONDS = 30;

/* =====================================================
   DATABASE
===================================================== */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});


/* =====================================================
   CACHE
===================================================== */

const cache = {
  history: [],
  currentIssue: null,
  settledIssue: null,
  targetIssue: null,

  historyVersion: 0,
  historySignature: "",

  analysis: null,

  lastUpdated: 0,
  anchorTime: 0,

  providerCountdown: null,

  error: null,

  modelStats: {}
};


/* =====================================================
   DATABASE INIT
===================================================== */

async function initDatabase() {

  if (!process.env.DATABASE_URL) {
    console.log("DATABASE_URL not configured");
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
    CREATE TABLE IF NOT EXISTS predictions (
      id SERIAL PRIMARY KEY,
      target_issue TEXT UNIQUE NOT NULL,
      prediction TEXT NOT NULL,
      confidence INTEGER DEFAULT 0,
      pattern_score INTEGER DEFAULT 0,
      created_at BIGINT NOT NULL,
      actual TEXT,
      result TEXT,
      settled_at BIGINT DEFAULT 0
    )
  `);

  console.log("Database ready");
}


/* =====================================================
   JSON RESPONSE
===================================================== */

function sendJSON(res, status, data) {

  res.writeHead(status, {
    "Content-Type":
      "application/json; charset=utf-8",

    "Cache-Control":
      "no-store",

    "Access-Control-Allow-Origin":
      "*"
  });

  res.end(JSON.stringify(data));
}


function readBody(req) {

  return new Promise(resolve => {

    let data = "";

    req.on("data", chunk => {
      data += chunk;
    });

    req.on("end", () => {

      try {
        resolve(
          data
            ? JSON.parse(data)
            : {}
        );
      } catch {
        resolve({});
      }

    });

  });

}


/* =====================================================
   BASIC HELPERS
===================================================== */

function cleanIssue(value) {

  return String(value || "").trim();

}


function classify(number) {

  const n = Number(number);

  if (!Number.isFinite(n)) {
    return null;
  }

  return n >= 5 ? "BIG" : "SMALL";
}


function opposite(side) {

  return side === "BIG"
    ? "SMALL"
    : "BIG";

}


function compareIssues(a, b) {

  try {

    const A = BigInt(a);
    const B = BigInt(b);

    if (A > B) return 1;
    if (A < B) return -1;

    return 0;

  } catch {

    return String(a)
      .localeCompare(String(b));

  }

}


function nextIssue(value) {

  const s = cleanIssue(value);

  const match = s.match(/^(.*?)(\d+)$/);

  if (!match) {
    return null;
  }

  try {

    const prefix = match[1];
    const digits = match[2];

    const next =
      BigInt(digits) + 1n;

    return (
      prefix +
      next.toString().padStart(
        digits.length,
        "0"
      )
    );

  } catch {

    return null;

  }

}


/* =====================================================
   NORMALIZE PROVIDER HISTORY
===================================================== */

function normalizeHistory(data) {

  const rows =
    Array.isArray(data?.history)
      ? data.history

      : Array.isArray(data?.data?.history)
        ? data.data.history

        : Array.isArray(data?.data)
          ? data.data

          : [];

  return rows
    .map(row => {

      const number =
        Number(row.number);

      return {

        issueNumber:
          cleanIssue(
            row.issueNumber ??
            row.issue ??
            row.period
          ),

        number,

        colour:
          row.colour ??
          row.color ??
          "",

        premium:
          row.premium ??
          "",

        sum:
          row.sum ??
          ""

      };

    })
    .filter(row =>
      row.issueNumber &&
      Number.isFinite(row.number)
    );

}


/* =====================================================
   COUNTDOWN
===================================================== */

function extractCountdown(data) {

  const values = [

    data?.countdown,
    data?.remainingSeconds,
    data?.seconds,
    data?.timeLeft,

    data?.current?.countdown,
    data?.current?.remainingSeconds,
    data?.current?.seconds,
    data?.current?.timeLeft

  ];

  for (const value of values) {

    const n = Number(value);

    if (
      Number.isFinite(n) &&
      n >= 0 &&
      n <= 120
    ) {

      return Math.floor(n);

    }

  }

  return null;
}


/* =====================================================
   PROVIDER
===================================================== */

async function fetchWingoData() {

  if (!WINGOBOT_TOKEN) {

    throw new Error(
      "WINGOBOT_TOKEN is not configured"
    );

  }

  const response =
    await fetch(
      WINGOBOT_URL,
      {
        headers: {
          Authorization:
            `Bearer ${WINGOBOT_TOKEN}`,

          Accept:
            "application/json"
        }
      }
    );

  if (!response.ok) {

    throw new Error(
      `WingoBot HTTP ${response.status}`
    );

  }

  return response.json();
}


/* =====================================================
   SEQUENCE
===================================================== */

function getSequence(history, limit = 80) {

  return history
    .slice(0, limit)
    .map(row => {

      const side =
        classify(row.number);

      return side;

    })
    .filter(Boolean);

}


/* =====================================================
   NUMBER FEATURES
===================================================== */

function numberFeature(history) {

  if (!history.length) {
    return null;
  }

  const n =
    Number(history[0].number);

  if (!Number.isFinite(n)) {
    return null;
  }

  /*
    Number itself is NOT used as a
    direct "number prediction".

    It is only converted into
    structural features.
  */

  return {

    parity:
      n % 2 === 0
        ? "EVEN"
        : "ODD",

    low:
      n <= 2,

    middle:
      n >= 3 &&
      n <= 6,

    high:
      n >= 7

  };

}


/* =====================================================
   MODEL 1
   RECENT TRANSITION
===================================================== */

function transitionModel(sequence) {

  if (sequence.length < 10) {
    return null;
  }

  const current =
    sequence[0];

  const votes = {
    BIG: 0,
    SMALL: 0
  };

  let matches = 0;

  for (
    let i = 1;
    i < sequence.length - 1;
    i++
  ) {

    if (
      sequence[i] !== current
    ) {
      continue;
    }

    const next =
      sequence[i - 1];

    if (!next) continue;

    votes[next] +=
      1 /
      (1 + i * 0.04);

    matches++;

  }

  if (!matches) {
    return null;
  }

  const side =
    votes.BIG >= votes.SMALL
      ? "BIG"
      : "SMALL";

  const total =
    votes.BIG +
    votes.SMALL;

  return {

    name: "Transition",
    side,

    strength:
      total
        ? Math.abs(
            votes.BIG -
            votes.SMALL
          ) / total
        : 0,

    matches

  };

}


/* =====================================================
   MODEL 2
   SEQUENCE MATCH
===================================================== */

function sequenceModel(sequence) {

  if (sequence.length < 14) {
    return null;
  }

  const lengths =
    [3, 4, 5, 6, 7];

  const votes = {
    BIG: 0,
    SMALL: 0
  };

  let matches = 0;

  for (const len of lengths) {

    if (
      sequence.length <
      len + 2
    ) {
      continue;
    }

    const current =
      sequence
        .slice(0, len)
        .join("");

    for (
      let i = len + 1;
      i < sequence.length;
      i++
    ) {

      const old =
        sequence
          .slice(i, i + len)
          .join("");

      if (old !== current) {
        continue;
      }

      const result =
        sequence[i - 1];

      if (!result) continue;

      const weight =
        1 /
        (1 + i * 0.06);

      votes[result] += weight;

      matches++;

    }

  }

  if (!matches) {
    return null;
  }

  const total =
    votes.BIG +
    votes.SMALL;

  return {

    name: "Sequence",
    side:
      votes.BIG >= votes.SMALL
        ? "BIG"
        : "SMALL",

    strength:
      total
        ? Math.abs(
            votes.BIG -
            votes.SMALL
          ) / total
        : 0,

    matches

  };

}


/* =====================================================
   MODEL 3
   RUN / REVERSAL
===================================================== */

function runModel(sequence) {

  if (sequence.length < 8) {
    return null;
  }

  let run = 1;

  while (
    run < sequence.length &&
    sequence[run] === sequence[0]
  ) {

    run++;

  }

  const current =
    sequence[0];

  let sameRun = 0;
  let oppositeAfter = 0;

  for (
    let i = 0;
    i < sequence.length - 1;
    i++
  ) {

    if (
      sequence[i] !== current
    ) {
      continue;
    }

    let length = 1;

    while (
      i + length <
        sequence.length &&
      sequence[i + length] ===
        current
    ) {

      length++;

    }

    if (
      length === run &&
      i > 0
    ) {

      sameRun++;

      if (
        sequence[i - 1] !==
        current
      ) {

        oppositeAfter++;

      }

    }

  }

  if (!sameRun) {
    return null;
  }

  /*
    This model is intentionally cautious.
    It does not simply assume every run
    must reverse.
  */

  const reversalRate =
    oppositeAfter / sameRun;

  let side;

  if (reversalRate >= 0.60) {

    side = opposite(current);

  } else {

    side = current;

  }

  return {

    name: "Run/Reversal",
    side,

    strength:
      Math.abs(
        reversalRate - 0.5
      ) * 2,

    matches: sameRun

  };

}


/* =====================================================
   MODEL 4
   ALTERNATION / BREAK
===================================================== */

function alternationModel(sequence) {

  if (sequence.length < 10) {
    return null;
  }

  let alternating = 0;

  for (
    let i = 0;
    i < Math.min(8, sequence.length - 1);
    i++
  ) {

    if (
      sequence[i] !==
      sequence[i + 1]
    ) {

      alternating++;

    }

  }

  const rate =
    alternating / 8;

  if (rate < 0.625) {
    return null;
  }

  return {

    name: "Alternation",
    side:
      opposite(sequence[0]),

    strength:
      rate,

    matches: alternating

  };

}


/* =====================================================
   MODEL 5
   NUMBER STRUCTURE
===================================================== */

function numberStructureModel(history) {

  if (history.length < 12) {
    return null;
  }

  const current =
    numberFeature(history);

  if (!current) {
    return null;
  }

  const votes = {
    BIG: 0,
    SMALL: 0
  };

  let matches = 0;

  for (
    let i = 1;
    i < Math.min(history.length, 50);
    i++
  ) {

    const feature =
      numberFeature(
        history.slice(i)
      );

    if (!feature) continue;

    let similarity = 0;

    if (
      feature.parity ===
      current.parity
    ) {
      similarity += 0.25;
    }

    if (
      feature.low ===
      current.low
    ) {
      similarity += 0.25;
    }

    if (
      feature.middle ===
      current.middle
    ) {
      similarity += 0.25;
    }

    if (
      feature.high ===
      current.high
    ) {
      similarity += 0.25;
    }

    if (
      similarity < 0.50
    ) {
      continue;
    }

    const result =
      classify(
        history[i - 1].number
      );

    if (!result) continue;

    votes[result] +=
      similarity /
      (1 + i * 0.05);

    matches++;

  }

  if (!matches) {
    return null;
  }

  const total =
    votes.BIG +
    votes.SMALL;

  return {

    name: "Number Structure",

    side:
      votes.BIG >= votes.SMALL
        ? "BIG"
        : "SMALL",

    strength:
      total
        ? Math.abs(
            votes.BIG -
            votes.SMALL
          ) / total
        : 0,

    matches

  };

}


/* =====================================================
   MODEL 6
   RECENCY WEIGHTED TRANSITIONS
===================================================== */

function recencyModel(sequence) {

  if (sequence.length < 12) {
    return null;
  }

  const windows =
    [5, 8, 12, 20];

  const votes = {
    BIG: 0,
    SMALL: 0
  };

  let used = 0;

  for (const window of windows) {

    if (
      sequence.length <
      window
    ) {
      continue;
    }

    const part =
      sequence.slice(
        0,
        window
      );

    let big = 0;
    let small = 0;

    /*
      Not used as raw frequency.
      We compare directional transitions
      inside the window.
    */

    for (
      let i = 0;
      i < part.length - 1;
      i++
    ) {

      const a = part[i];
      const b = part[i + 1];

      if (a === b) {

        if (a === "BIG") {
          big += 0.25;
        } else {
          small += 0.25;
        }

      } else {

        if (a === "BIG") {
          small += 0.50;
        } else {
          big += 0.50;
        }

      }

    }

    const total =
      big + small;

    if (!total) continue;

    const side =
      big >= small
        ? "BIG"
        : "SMALL";

    const confidence =
      Math.abs(big - small) /
      total;

    votes[side] +=
      confidence /
      Math.sqrt(window);

    used++;

  }

  if (!used) {
    return null;
  }

  return {

    name: "Multi Window",
    side:
      votes.BIG >= votes.SMALL
        ? "BIG"
        : "SMALL",

    strength:
      Math.abs(
        votes.BIG -
        votes.SMALL
      ) /
      Math.max(
        0.0001,
        votes.BIG +
        votes.SMALL
      ),

    matches: used

  };

}


/* =====================================================
   MODEL LIST
===================================================== */

function generateModels(history) {

  const sequence =
    getSequence(
      history,
      80
    );

  return [

    transitionModel(
      sequence
    ),

    sequenceModel(
      sequence
    ),

    runModel(
      sequence
    ),

    alternationModel(
      sequence
    ),

    numberStructureModel(
      history
    ),

    recencyModel(
      sequence
    )

  ].filter(Boolean);

}


/* =====================================================
   WALK FORWARD BACKTEST
===================================================== */

function backtestModel(
  history,
  modelName
) {

  const chronological =
    [...history].reverse();

  if (
    chronological.length < 30
  ) {

    return {
      tested: 0,
      wins: 0,
      losses: 0,
      accuracy: 50
    };

  }

  let wins = 0;
  let losses = 0;

  const maxTests =
    Math.min(
      chronological.length - 12,
      100
    );

  for (
    let i = 12;
    i < chronological.length &&
    i < 12 + maxTests;
    i++
  ) {

    const training =
      chronological
        .slice(0, i)
        .reverse();

    const actual =
      classify(
        chronological[i].number
      );

    if (!actual) {
      continue;
    }

    const models =
      generateModels(
        training
      );

    const model =
      models.find(
        x =>
          x.name ===
          modelName
      );

    if (!model) {
      continue;
    }

    if (
      model.side ===
      actual
    ) {

      wins++;

    } else {

      losses++;

    }

  }

  const total =
    wins + losses;

  return {

    tested: total,
    wins,
    losses,

    accuracy:
      total
        ? Math.round(
            wins * 1000 / total
          ) / 10
        : 50

  };

}


/* =====================================================
   ADAPTIVE MODEL WEIGHTS
===================================================== */

function getAdaptiveWeights(
  history,
  models
) {

  const result = {};

  for (const model of models) {

    const stats =
      backtestModel(
        history,
        model.name
      );

    /*
      Baseline weight.
      Accuracy does NOT directly mean
      future certainty.
    */

    const accuracy =
      stats.accuracy;

    const distance =
      Math.abs(
        accuracy - 50
      );

    let weight =
      0.70 +
      distance * 0.035;

    /*
      Weak sample size = lower influence.
    */

    if (
      stats.tested < 15
    ) {

      weight *= 0.80;

    }

    if (
      stats.tested < 8
    ) {

      weight *= 0.65;

    }

    result[model.name] = {

      weight,

      tested:
        stats.tested,

      wins:
        stats.wins,

      losses:
        stats.losses,

      accuracy:
        stats.accuracy

    };

  }

  return result;

}


/* =====================================================
   ADAPTIVE ENSEMBLE
===================================================== */

function adaptiveEnsemble(
  history
) {

  const models =
    generateModels(
      history
    );

  if (!models.length) {

    return {

      prediction: null,

      confidence: 0,

      patternScore: 0,

      agreement: 0,

      evidence: 0,

      status:
        "INSUFFICIENT DATA",

      models: [],

      modelStats: {}

    };

  }

  const weights =
    getAdaptiveWeights(
      history,
      models
    );

  let big = 0;
  let small = 0;

  const details = [];

  for (const model of models) {

    const info =
      weights[
        model.name
      ];

    const weight =
      info?.weight || 0.5;

    /*
      Strength controls influence.
      Weak model signals are not allowed
      to dominate the ensemble.
    */

    const strength =
      Math.max(
        0.15,
        Math.min(
          1,
          Number(model.strength) || 0
        )
      );

    const contribution =
      weight *
      (
        0.55 +
        strength * 0.45
      );

    if (
      model.side ===
      "BIG"
    ) {

      big += contribution;

    } else {

      small += contribution;

    }

    details.push({

      name:
        model.name,

      side:
        model.side,

      strength:
        Math.round(
          strength * 100
        ),

      weight:
        Math.round(
          weight * 100
        ) / 100,

      contribution:
        Math.round(
          contribution * 100
        ) / 100,

      accuracy:
        info?.accuracy ??
        50,

      tested:
        info?.tested ??
        0,

      matches:
        model.matches

    });

  }

  const total =
    big + small;

  const prediction =
    big >= small
      ? "BIG"
      : "SMALL";

  const margin =
    total
      ? Math.abs(
          big - small
        ) / total
      : 0;

  const predictionModels =
    details.filter(
      x =>
        x.side ===
        prediction
    ).length;

  const agreement =
    details.length
      ? predictionModels /
        details.length
      : 0;

  /*
    Confidence deliberately capped.
    Historical patterns cannot justify
    fake 90-100% certainty.
  */

  let confidence =
    50 +
    margin * 24 +
    Math.max(
      0,
      agreement - 0.5
    ) * 24;

  confidence =
    Math.round(
      Math.max(
        50,
        Math.min(
          76,
          confidence
        )
      )
    );

  /*
    Strong agreement but weak backtest
    should still remain cautious.
  */

  const tested =
    details.reduce(
      (sum, x) =>
        sum + x.tested,
      0
    );

  const avgAccuracy =
    details.length
      ? details.reduce(
          (sum, x) =>
            sum + Number(x.accuracy || 50),
          0
        ) / details.length
      : 50;

  /*
    Pattern score measures structural
    agreement, not probability of winning.
  */

  const patternScore =
    Math.round(
      Math.max(
        50,
        Math.min(
          90,
          50 +
          margin * 35 +
          Math.max(
            0,
            agreement - 0.5
          ) * 30
        )
      )
    );

  let status =
    "LOW SIGNAL";

  if (
    agreement >= 0.67 &&
    margin >= 0.12 &&
    tested >= 30
  ) {

    status =
      "ADAPTIVE SIGNAL";

  }

  if (
    agreement >= 0.80 &&
    margin >= 0.20 &&
    avgAccuracy >= 55
  ) {

    status =
      "STRONG STRUCTURAL SIGNAL";

  }

  /*
    If models are nearly tied, don't pretend
    there is a strong directional signal.
  */

  if (
    margin < 0.05 ||
    agreement < 0.55
  ) {

    status =
      "LOW SIGNAL";

  }

  return {

    prediction,

    confidence,

    patternScore,

    agreement:
      Math.round(
        agreement * 100
      ),

    evidence:
      details.length,

    status,

    vote: {

      big:
        Math.round(
          big * 100
        ) / 100,

      small:
        Math.round(
          small * 100
        ) / 100

    },

    avgModelAccuracy:
      Math.round(
        avgAccuracy * 10
      ) / 10,

    backtestSamples:
      tested,

    models:
      details,

    modelStats:
      weights,

    sequence:
      getSequence(
        history,
        12
      )

  };

}


/* =====================================================
   SAVE PREDICTION
===================================================== */

async function savePrediction(
  targetIssue,
  analysis
) {

  if (
    !process.env.DATABASE_URL ||
    !targetIssue ||
    !analysis?.prediction
  ) {

    return;

  }

  await pool.query(
    `
    INSERT INTO predictions
    (
      target_issue,
      prediction,
      confidence,
      pattern_score,
      created_at
    )
    VALUES
    (
      $1,
      $2,
      $3,
      $4,
      $5
    )
    ON CONFLICT
    (
      target_issue
    )
    DO NOTHING
    `,
    [
      targetIssue,
      analysis.prediction,
      analysis.confidence,
      analysis.patternScore,
      Date.now()
    ]
  );

}


/* =====================================================
   SETTLE
===================================================== */

async function settlePrediction(row) {

  if (
    !process.env.DATABASE_URL ||
    !row
  ) {

    return;

  }

  const actual =
    classify(row.number);

  if (!actual) {
    return;
  }

  await pool.query(
    `
    UPDATE predictions
    SET
      actual = $1,
      result =
        CASE
          WHEN prediction = $1
          THEN 'WIN'
          ELSE 'LOSS'
        END,
      settled_at = $2
    WHERE
      target_issue = $3
      AND result IS NULL
    `,
    [
      actual,
      Date.now(),
      row.issueNumber
    ]
  );

}


/* =====================================================
   WIN / LOSS
===================================================== */

async function getWinLoss() {

  if (!process.env.DATABASE_URL) {

    return {

      rows: [],

      stats: {
        total: 0,
        win: 0,
        loss: 0,
        rate: 0,
        streak: "-"
      }

    };

  }

  const result =
    await pool.query(
      `
      SELECT
        target_issue,
        prediction,
        confidence,
        pattern_score,
        created_at,
        actual,
        result,
        settled_at
      FROM predictions
      WHERE result IS NOT NULL
      ORDER BY id DESC
      LIMIT 100
      `
    );

  const rows =
    result.rows;

  const win =
    rows.filter(
      x => x.result === "WIN"
    ).length;

  const loss =
    rows.filter(
      x => x.result === "LOSS"
    ).length;

  let streak = "-";

  if (rows.length) {

    const first =
      rows[0].result;

    let count = 0;

    for (const row of rows) {

      if (
        row.result !==
        first
      ) {

        break;

      }

      count++;

    }

    streak =
      `${first} ${count}`;

  }

  return {

    rows,

    stats: {

      total:
        win + loss,

      win,

      loss,

      rate:
        win + loss
          ? Math.round(
              win * 1000 /
              (win + loss)
            ) / 10
          : 0,

      streak

    }

  };

}


/* =====================================================
   UPDATE CACHE
===================================================== */

async function updateCache() {

  try {

    const data =
      await fetchWingoData();

    const history =
      normalizeHistory(
        data
      );

    if (!history.length) {

      throw new Error(
        "No history received"
      );

    }

    const settledIssue =
      history[0].issueNumber;

    const providerCurrent =
      cleanIssue(
        data?.current
          ?.issueNumber
      );

    const targetIssue =
      providerCurrent &&
      compareIssues(
        providerCurrent,
        settledIssue
      ) > 0

        ? providerCurrent

        : nextIssue(
            settledIssue
          );

    const signature =
      history
        .slice(0, 8)
        .map(
          row =>
            `${row.issueNumber}:${row.number}`
        )
        .join("|");

    const changed =
      signature !==
      cache.historySignature;

    cache.history =
      history;

    cache.currentIssue =
      providerCurrent ||
      settledIssue;

    cache.settledIssue =
      settledIssue;

    cache.targetIssue =
      targetIssue;

    cache.providerCountdown =
      extractCountdown(
        data
      );

    cache.lastUpdated =
      Date.now();

    cache.error =
      null;

    /*
      IMPORTANT:
      Analysis changes only after a
      genuinely new settled result.
    */

    if (changed) {

      cache.historySignature =
        signature;

      cache.historyVersion++;

      /*
        First settle the result that
        just became available.
      */

      await settlePrediction(
        history[0]
      );

      /*
        Then calculate a completely new
        adaptive analysis.
      */

      cache.analysis =
        adaptiveEnsemble(
          history
        );

      cache.modelStats =
        cache.analysis?.modelStats ||
        {};

      cache.anchorTime =
        Date.now();

      /*
        Save prediction for next target.
      */

      await savePrediction(
        targetIssue,
        cache.analysis
      );

      console.log(
        "NEW RESULT:",
        settledIssue,
        "TARGET:",
        targetIssue,
        "PRED:",
        cache.analysis?.prediction,
        "CONF:",
        cache.analysis?.confidence,
        "STATUS:",
        cache.analysis?.status
      );

    }

  } catch (error) {

    cache.error =
      error.message;

    console.error(
      "Provider error:",
      error.message
    );

  }

}


/* =====================================================
   TIMER
===================================================== */

function getTiming() {

  if (
    Number.isFinite(
      cache.providerCountdown
    )
  ) {

    return {

      seconds:
        Math.min(
          30,
          cache.providerCountdown
        ),

      exact: true

    };

  }

  if (!cache.anchorTime) {

    return {

      seconds: 30,
      exact: false

    };

  }

  const elapsed =
    Math.floor(
      (
        Date.now() -
        cache.anchorTime
      ) / 1000
    );

  let seconds =
    ROUND_SECONDS -
    (
      elapsed %
      ROUND_SECONDS
    );

  if (seconds === 0) {
    seconds = ROUND_SECONDS;
  }

  return {

    seconds,
    exact: false

  };

}


/* =====================================================
   ADMIN AUTH
===================================================== */

function isAdmin(req) {

  return (
    req.headers["x-admin-key"] ===
    ADMIN_KEY
  );

}


/* =====================================================
   API
===================================================== */

async function handleAPI(
  req,
  res,
  url
) {

  /* ---------------- HEALTH ---------------- */

  if (
    url.pathname ===
    "/health"
  ) {

    return sendJSON(
      res,
      200,
      {
        ok: true,
        time: Date.now()
      }
    );

  }


  /* ---------------- STATE ---------------- */

  if (
    url.pathname ===
      "/api/state" &&
    req.method ===
      "GET"
  ) {

    return sendJSON(
      res,
      200,
      {

        ok: true,

        history:
          cache.history.slice(
            0,
            30
          ),

        currentIssue:
          cache.currentIssue,

        settledIssue:
          cache.settledIssue,

        targetIssue:
          cache.targetIssue,

        historyVersion:
          cache.historyVersion,

        lastUpdated:
          cache.lastUpdated,

        timing:
          getTiming(),

        analysis:
          cache.analysis,

        error:
          cache.error

      }
    );

  }


  /* ---------------- WIN LOSS ---------------- */

  if (
    url.pathname ===
      "/api/history" &&
    req.method ===
      "GET"
  ) {

    return sendJSON(
      res,
      200,
      await getWinLoss()
    );

  }


  /* ---------------- KEY CHECK ---------------- */

  if (
    url.pathname ===
      "/api/key/check" &&
    req.method ===
      "POST"
  ) {

    const data =
      await readBody(req);

    const key =
      String(
        data.key || ""
      ).trim();

    const device =
      String(
        req.headers[
          "x-device-id"
        ] ||
        data.device_id ||
        ""
      ).trim();

    if (
      !process.env.DATABASE_URL
    ) {

      return sendJSON(
        res,
        503,
        {
          ok: false,
          message:
            "Database not configured"
        }
      );

    }

    if (!key) {

      return sendJSON(
        res,
        400,
        {
          ok: false,
          message:
            "Access key required"
        }
      );

    }

    const result =
      await pool.query(
        `
        SELECT *
        FROM access_keys
        WHERE access_key = $1
        `,
        [key]
      );

    if (!result.rowCount) {

      return sendJSON(
        res,
        401,
        {
          ok: false,
          message:
            "Invalid access key"
        }
      );

    }

    const row =
      result.rows[0];

    if (
      row.device_id &&
      row.device_id !== device
    ) {

      return sendJSON(
        res,
        403,
        {
          ok: false,
          message:
            "Key already bound to another device"
        }
      );

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
        Date.now(),
        row.id
      ]
    );

    return sendJSON(
      res,
      200,
      {
        ok: true,
        message:
          "Access granted"
      }
    );

  }


  /* =================================================
     ADMIN
  ================================================= */

  if (
    url.pathname.startsWith(
      "/api/admin/"
    )
  ) {

    if (!isAdmin(req)) {

      return sendJSON(
        res,
        401,
        {
          ok: false,
          message:
            "Unauthorized"
        }
      );

    }


    /* ---------------- PING ---------------- */

    if (
      url.pathname ===
      "/api/admin/ping"
    ) {

      return sendJSON(
        res,
        200,
        {
          ok: true,
          time: Date.now(),
          provider:
            !!WINGOBOT_TOKEN,
          database:
            !!process.env.DATABASE_URL
        }
      );

    }


    /* ---------------- STATUS ---------------- */

    if (
      url.pathname ===
      "/api/admin/status"
    ) {

      return sendJSON(
        res,
        200,
        {

          ok: true,

          database:
            !!process.env.DATABASE_URL,

          wingobot:
            !!WINGOBOT_TOKEN,

          history:
            cache.history.length,

          historyVersion:
            cache.historyVersion,

          targetIssue:
            cache.targetIssue,

          analysis:
            cache.analysis

        }
      );

    }


    /* ---------------- WINGOBOT TEST ---------------- */

    if (
      url.pathname ===
      "/api/admin/wingo-test"
    ) {

      try {

        const data =
          await fetchWingoData();

        return sendJSON(
          res,
          200,
          {

            ok: true,

            current:
              data.current ||
              null,

            history:
              normalizeHistory(
                data
              ).slice(
                0,
                10
              )

          }
        );

      } catch (error) {

        return sendJSON(
          res,
          500,
          {
            ok: false,
            message:
              error.message
          }
        );

      }

    }


    /* ---------------- MODEL TEST ---------------- */

    if (
      url.pathname ===
      "/api/admin/model-test"
    ) {

      try {

        const analysis =
          adaptiveEnsemble(
            cache.history
          );

        return sendJSON(
          res,
          200,
          {

            ok: true,

            prediction:
              analysis.prediction,

            confidence:
              analysis.confidence,

            patternScore:
              analysis.patternScore,

            agreement:
              analysis.agreement,

            status:
              analysis.status,

            avgModelAccuracy:
              analysis.avgModelAccuracy,

            backtestSamples:
              analysis.backtestSamples,

            models:
              analysis.models

          }
        );

      } catch (error) {

        return sendJSON(
          res,
          500,
          {
            ok: false,
            message:
              error.message
          }
        );

      }

    }


    /* ---------------- LIST KEYS ---------------- */

    if (
      url.pathname ===
        "/api/admin/keys" &&
      req.method ===
        "GET"
    ) {

      if (
        !process.env.DATABASE_URL
      ) {

        return sendJSON(
          res,
          503,
          {
            ok: false,
            message:
              "Database not configured"
          }
        );

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

      return sendJSON(
        res,
        200,
        {
          ok: true,
          keys:
            result.rows
        }
      );

    }


    /* ---------------- CREATE KEYS ---------------- */

    if (
      url.pathname ===
        "/api/admin/keys" &&
      req.method ===
        "POST"
    ) {

      if (
        !process.env.DATABASE_URL
      ) {

        return sendJSON(
          res,
          503,
          {
            ok: false,
            message:
              "Database not configured"
          }
        );

      }

      const data =
        await readBody(req);

      const count =
        Math.max(
          1,
          Math.min(
            100,
            Number(
              data.count || 1
            )
          )
        );

      const keys = [];

      for (
        let i = 0;
        i < count;
        i++
      ) {

        let created = false;

        while (!created) {

          const key =
            "DY-" +
            crypto
              .randomBytes(5)
              .toString("hex")
              .toUpperCase();

          const result =
            await pool.query(
              `
              INSERT INTO access_keys
              (
                access_key,
                created_at
              )
              VALUES
              (
                $1,
                $2
              )
              ON CONFLICT
              DO NOTHING
              RETURNING access_key
              `,
              [
                key,
                Date.now()
              ]
            );

          if (
            result.rowCount
          ) {

            keys.push(key);
            created = true;

          }

        }

      }

      return sendJSON(
        res,
        200,
        {
          ok: true,
          keys
        }
      );

    }


    /* ---------------- DELETE KEY ---------------- */

    if (
      url.pathname ===
        "/api/admin/keys" &&
      req.method ===
        "DELETE"
    ) {

      const data =
        await readBody(req);

      await pool.query(
        `
        DELETE FROM access_keys
        WHERE id = $1
        `,
        [data.id]
      );

      return sendJSON(
        res,
        200,
        {
          ok: true
        }
      );

    }


    /* ---------------- RESET DEVICE ---------------- */

    if (
      url.pathname ===
        "/api/admin/reset-device" &&
      req.method ===
        "POST"
    ) {

      const data =
        await readBody(req);

      await pool.query(
        `
        UPDATE access_keys
        SET device_id = NULL
        WHERE id = $1
        `,
        [data.id]
      );

      return sendJSON(
        res,
        200,
        {
          ok: true
        }
      );

    }

  }

  return null;

}


/* =====================================================
   STATIC SERVER
===================================================== */

function serveStatic(
  req,
  res,
  url
) {

  let filename =
    url.pathname === "/"
      ? "/prediction.html"
      : url.pathname;

  if (
    filename.includes("..")
  ) {

    return sendJSON(
      res,
      400,
      {
        ok: false
      }
    );

  }

  const filePath =
    path.join(
      __dirname,
      filename
    );

  if (
    !fs.existsSync(
      filePath
    )
  ) {

    return sendJSON(
      res,
      404,
      {
        ok: false,
        message:
          "File not found"
      }
    );

  }

  const ext =
    path
      .extname(
        filePath
      )
      .toLowerCase();

  const types = {

    ".html":
      "text/html; charset=utf-8",

    ".css":
      "text/css; charset=utf-8",

    ".js":
      "application/javascript; charset=utf-8",

    ".json":
      "application/json",

    ".mp3":
      "audio/mpeg"

  };


  /* =================================================
     MP3 RANGE SUPPORT
  ================================================= */

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
          /bytes=(\d+)-(\d*)/
        );

      if (match) {

        const start =
          Number(match[1]);

        let end =
          match[2]
            ? Number(match[2])
            : stat.size - 1;

        end =
          Math.min(
            end,
            stat.size - 1
          );

        if (
          start >= 0 &&
          start < stat.size &&
          end >= start
        ) {

          res.writeHead(
            206,
            {

              "Content-Type":
                "audio/mpeg",

              "Accept-Ranges":
                "bytes",

              "Content-Range":
                `bytes ${start}-${end}/${stat.size}`,

              "Content-Length":
                end -
                start +
                1

            }
          );

          return fs
            .createReadStream(
              filePath,
              {
                start,
                end
              }
            )
            .pipe(res);

        }

      }

    }

    res.writeHead(
      200,
      {

        "Content-Type":
          "audio/mpeg",

        "Accept-Ranges":
          "bytes",

        "Content-Length":
          stat.size

      }
    );

    return fs
      .createReadStream(
        filePath
      )
      .pipe(res);

  }


  res.writeHead(
    200,
    {

      "Content-Type":
        types[ext] ||
        "application/octet-stream"

    }
  );

  fs
    .createReadStream(
      filePath
    )
    .pipe(res);

}


/* =====================================================
   SERVER
===================================================== */

const server =
  http.createServer(
    async (req, res) => {

      try {

        const url =
          new URL(
            req.url,
            `http://${req.headers.host || "localhost"}`
          );

        const handled =
          await handleAPI(
            req,
            res,
            url
          );

        if (
          handled !== null
        ) {

          return;

        }

        serveStatic(
          req,
          res,
          url
        );

      } catch (error) {

        console.error(
          "SERVER ERROR:",
          error
        );

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

    }
  );


/* =====================================================
   START
===================================================== */

(async () => {

  try {

    await initDatabase();

    /*
      First provider fetch.
    */

    await updateCache();

    /*
      Keep provider data fresh.
    */

    setInterval(
      updateCache,
      1000
    );

    server.listen(
      PORT,
      () => {

        console.log(
          `DY AI server running on ${PORT}`
        );

      }
    );

  } catch (error) {

    console.error(
      "START ERROR:",
      error
    );

    process.exit(1);

  }

})();
