const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 10000);

const ADMIN_KEY =
  process.env.ADMIN_KEY || "dy4427574";

const WINGOBOT_TOKEN =
  process.env.WINGOBOT_TOKEN || "";

const WINGOBOT_URL =
  "https://api.wingobot.com/v2/30-sec-game-history";

const ROUND_SECONDS = 30;

const LIVE_RESULTS_LIMIT = 30;
const WINLOSS_LIMIT = 30;


/* =========================================================
   DATABASE
========================================================= */

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL || undefined,

  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});


async function initDatabase() {
  if (!process.env.DATABASE_URL) {
    console.log(
      "WARNING: DATABASE_URL not configured"
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

  console.log("Database initialized");
}


/* =========================================================
   GLOBAL LIVE STATE
========================================================= */

const state = {
  history: [],

  settledIssue: null,
  targetIssue: null,

  analysis: null,

  version: 0,

  historySignature: "",

  lastUpdated: 0,

  anchorTime: 0,

  providerCountdown: null,

  connected: false,

  error: null
};


/* =========================================================
   HTTP HELPERS
========================================================= */

function sendJSON(res, status, data) {
  res.writeHead(status, {
    "Content-Type":
      "application/json; charset=utf-8",

    "Cache-Control":
      "no-store",

    "Access-Control-Allow-Origin":
      "*",

    "Access-Control-Allow-Headers":
      "Content-Type, X-Admin-Key, X-Device-Id"
  });

  res.end(
    JSON.stringify(data)
  );
}


function readBody(req) {
  return new Promise(resolve => {
    let body = "";

    req.on("data", chunk => {
      body += chunk;
    });

    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(
          JSON.parse(body)
        );
      } catch {
        resolve({});
      }
    });
  });
}


/* =========================================================
   BASIC HELPERS
========================================================= */

function clean(value) {
  return String(value ?? "").trim();
}


function classify(number) {
  const n = Number(number);

  if (!Number.isFinite(n)) {
    return null;
  }

  return n >= 5
    ? "BIG"
    : "SMALL";
}


function opposite(side) {
  return side === "BIG"
    ? "SMALL"
    : "BIG";
}


function compareIssues(a, b) {
  try {
    const A = BigInt(
      String(a)
    );

    const B = BigInt(
      String(b)
    );

    if (A > B) return 1;
    if (A < B) return -1;

    return 0;
  } catch {
    return String(a)
      .localeCompare(
        String(b)
      );
  }
}


function nextIssue(issue) {
  const value = clean(issue);

  const match =
    value.match(
      /^(.*?)(\d+)$/
    );

  if (!match) {
    return null;
  }

  try {
    const prefix =
      match[1];

    const digits =
      match[2];

    const next =
      BigInt(digits) + 1n;

    return (
      prefix +
      next
        .toString()
        .padStart(
          digits.length,
          "0"
        )
    );
  } catch {
    return null;
  }
}


/* =========================================================
   PROVIDER
========================================================= */

async function fetchWingo() {
  if (!WINGOBOT_TOKEN) {
    throw new Error(
      "WINGOBOT_TOKEN missing"
    );
  }

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


function normalizeHistory(data) {
  let rows = [];

  if (
    Array.isArray(
      data?.history
    )
  ) {
    rows =
      data.history;
  }

  else if (
    Array.isArray(
      data?.data?.history
    )
  ) {
    rows =
      data.data.history;
  }

  else if (
    Array.isArray(
      data?.data
    )
  ) {
    rows =
      data.data;
  }

  return rows
    .map(row => ({
      issueNumber:
        clean(
          row.issueNumber ??
          row.issue ??
          row.period ??
          row.periodNumber
        ),

      number:
        Number(
          row.number ??
          row.result ??
          row.num
        ),

      colour:
        clean(
          row.colour ??
          row.color ??
          row.colourName
        ),

      premium:
        row.premium ?? "",

      sum:
        row.sum ?? ""
    }))

    .filter(row =>
      row.issueNumber &&
      Number.isFinite(row.number)
    )

    .sort(
      (a, b) =>
        compareIssues(
          b.issueNumber,
          a.issueNumber
        )
    );
}


function extractCountdown(data) {
  const candidates = [
    data?.countdown,
    data?.remainingSeconds,
    data?.seconds,
    data?.timeLeft,
    data?.current?.countdown,
    data?.current?.remainingSeconds,
    data?.current?.seconds,
    data?.current?.timeLeft
  ];

  for (const value of candidates) {
    const n = Number(value);

    if (
      Number.isFinite(n) &&
      n >= 0 &&
      n <= 30
    ) {
      return Math.floor(n);
    }
  }

  return null;
}


/* =========================================================
   AI / STATISTICAL ENGINE
========================================================= */

function getSequence(
  history,
  limit = 100
) {
  return history
    .slice(0, limit)
    .map(row =>
      classify(row.number)
    )
    .filter(Boolean);
}


/* =========================================================
   NUMBER WEIGHT
========================================================= */

function numberFeature(history) {
  const recent =
    history.slice(
      0,
      Math.min(
        30,
        history.length
      )
    );

  let big = 0;
  let small = 0;

  recent.forEach(
    (row, index) => {
      const weight =
        1 /
        Math.sqrt(
          index + 1
        );

      const side =
        classify(row.number);

      if (side === "BIG") {
        big += weight;
      }

      if (side === "SMALL") {
        small += weight;
      }
    }
  );

  return {
    big,
    small
  };
}


/* =========================================================
   TRANSITION MODEL
========================================================= */

function transitionModel(sequence) {
  if (
    sequence.length < 5
  ) {
    return null;
  }

  const current =
    sequence[0];

  let big = 0;
  let small = 0;

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

    if (!next) {
      continue;
    }

    const weight =
      1 /
      Math.sqrt(
        i + 1
      );

    if (next === "BIG") {
      big += weight;
    } else {
      small += weight;
    }

    matches++;
  }

  if (!matches) {
    return null;
  }

  const total =
    big + small;

  return {
    name: "Transition",

    side:
      big >= small
        ? "BIG"
        : "SMALL",

    strength:
      total
        ? Math.abs(
            big - small
          ) / total
        : 0,

    matches
  };
}


/* =========================================================
   SEQUENCE MODEL
========================================================= */

function sequenceModel(sequence) {
  if (
    sequence.length < 7
  ) {
    return null;
  }

  let big = 0;
  let small = 0;

  let matches = 0;

  for (
    const length of [2, 3, 4]
  ) {
    if (
      sequence.length <=
      length + 1
    ) {
      continue;
    }

    const pattern =
      sequence
        .slice(
          0,
          length
        )
        .join("");

    for (
      let i = length;
      i <
      sequence.length - 1;
      i++
    ) {
      const oldPattern =
        sequence
          .slice(
            i,
            i + length
          )
          .join("");

      if (
        oldPattern !== pattern
      ) {
        continue;
      }

      const next =
        sequence[i - 1];

      if (!next) {
        continue;
      }

      const weight =
        1 /
        Math.sqrt(
          i + 1
        );

      if (next === "BIG") {
        big += weight;
      } else {
        small += weight;
      }

      matches++;
    }
  }

  if (!matches) {
    return null;
  }

  const total =
    big + small;

  return {
    name: "Sequence",

    side:
      big >= small
        ? "BIG"
        : "SMALL",

    strength:
      total
        ? Math.abs(
            big - small
          ) / total
        : 0,

    matches
  };
}


/* =========================================================
   RUN MODEL
========================================================= */

function runModel(sequence) {
  if (
    sequence.length < 5
  ) {
    return null;
  }

  const current =
    sequence[0];

  let runLength = 1;

  while (
    runLength <
      sequence.length &&
    sequence[runLength] ===
      current
  ) {
    runLength++;
  }

  let matches = 0;
  let reversals = 0;

  for (
    let i = 0;
    i < sequence.length;
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
      sequence[
        i + length
      ] === current
    ) {
      length++;
    }

    if (
      length === runLength
    ) {
      matches++;

      if (
        i > 0 &&
        sequence[i - 1] !==
          current
      ) {
        reversals++;
      }
    }
  }

  if (
    matches < 1
  ) {
    return null;
  }

  const reversalRate =
    reversals / matches;

  return {
    name: "Run/Reversal",

    side:
      reversalRate >= 0.5
        ? opposite(current)
        : current,

    strength:
      Math.abs(
        reversalRate -
        0.5
      ) * 2,

    matches
  };
}


/* =========================================================
   ALTERNATION MODEL
========================================================= */

function alternationModel(sequence) {
  if (
    sequence.length < 6
  ) {
    return null;
  }

  const sample =
    Math.min(
      10,
      sequence.length - 1
    );

  let changes = 0;

  for (
    let i = 0;
    i < sample;
    i++
  ) {
    if (
      sequence[i] !==
      sequence[i + 1]
    ) {
      changes++;
    }
  }

  const rate =
    changes / sample;

  if (
    rate < 0.55
  ) {
    return null;
  }

  return {
    name: "Alternation",

    side:
      opposite(
        sequence[0]
      ),

    strength: rate,

    matches: changes
  };
}


/* =========================================================
   RECENCY MODEL
========================================================= */

function recencyModel(sequence) {
  if (
    sequence.length < 5
  ) {
    return null;
  }

  let big = 0;
  let small = 0;

  const sample =
    Math.min(
      25,
      sequence.length
    );

  for (
    let i = 0;
    i < sample;
    i++
  ) {
    const weight =
      1 /
      Math.sqrt(
        i + 1
      );

    if (
      sequence[i] ===
      "BIG"
    ) {
      big += weight;
    } else {
      small += weight;
    }
  }

  const total =
    big + small;

  if (!total) {
    return null;
  }

  return {
    name: "Recency",

    side:
      big >= small
        ? "BIG"
        : "SMALL",

    strength:
      Math.abs(
        big - small
      ) / total,

    matches: sample
  };
}


/* =========================================================
   NUMBER STRUCTURE
========================================================= */

function numberStructureModel(
  history
) {
  if (
    history.length < 5
  ) {
    return null;
  }

  let big = 0;
  let small = 0;

  const recent =
    history.slice(
      0,
      Math.min(
        20,
        history.length
      )
    );

  recent.forEach(
    (row, index) => {
      const n =
        Number(row.number);

      const weight =
        1 /
        Math.sqrt(
          index + 1
        );

      if (
        n >= 5
      ) {
        big += weight;
      } else {
        small += weight;
      }
    }
  );

  const total =
    big + small;

  return {
    name: "Number Structure",

    side:
      big >= small
        ? "BIG"
        : "SMALL",

    strength:
      total
        ? Math.abs(
            big - small
          ) / total
        : 0,

    matches:
      recent.length
  };
}


/* =========================================================
   GENERATE MODELS
========================================================= */

function generateModels(history) {
  const sequence =
    getSequence(
      history,
      100
    );

  const models = [
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

    recencyModel(
      sequence
    ),

    numberStructureModel(
      history
    )
  ].filter(Boolean);


  /*
    IMPORTANT FALLBACK

    Agar koi advanced model signal
    na de to prediction WAIT nahi hogi.
  */

  if (
    models.length === 0 &&
    sequence.length >= 2
  ) {
    const feature =
      numberFeature(
        history
      );

    const total =
      feature.big +
      feature.small;

    models.push({
      name:
        "Adaptive Fallback",

      side:
        feature.big >=
        feature.small
          ? "BIG"
          : "SMALL",

      strength:
        total
          ? Math.abs(
              feature.big -
              feature.small
            ) / total
          : 0,

      matches:
        sequence.length
    });
  }

  return models;
}


/* =========================================================
   SIMPLE WALK-FORWARD TEST
========================================================= */

function evaluateModel(
  history,
  modelName
) {
  if (
    history.length < 10
  ) {
    return {
      tested: 0,
      wins: 0,
      losses: 0,
      accuracy: null
    };
  }

  const chronological =
    [...history].reverse();

  let wins = 0;
  let losses = 0;

  const start =
    Math.max(
      6,
      chronological.length -
        50
    );

  for (
    let i = start;
    i <
      chronological.length;
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
        item =>
          item.name ===
          modelName
      );

    if (!model) {
      continue;
    }

    if (
      model.side === actual
    ) {
      wins++;
    } else {
      losses++;
    }
  }

  const tested =
    wins + losses;

  return {
    tested,

    wins,

    losses,

    accuracy:
      tested
        ? Math.round(
            (
              wins *
              1000
            ) / tested
          ) / 10
        : null
  };
}


/* =========================================================
   ADAPTIVE ENSEMBLE
========================================================= */

function adaptiveEnsemble(
  history
) {
  const models =
    generateModels(
      history
    );

  if (
    models.length === 0
  ) {
    return {
      prediction: null,

      confidence: 0,

      patternScore: 0,

      agreement: 0,

      backtestSamples: 0,

      avgModelAccuracy: null,

      status:
        "WAITING FOR RESULTS",

      models: []
    };
  }

  let bigVote = 0;
  let smallVote = 0;

  let sampleCount = 0;

  let accuracyTotal = 0;

  let accuracyModels = 0;

  const details = [];


  for (
    const model of models
  ) {
    const test =
      evaluateModel(
        history,
        model.name
      );

    let weight = 1;

    if (
      test.accuracy !== null &&
      test.tested >= 5
    ) {
      /*
        Adaptive weighting.

        Historical performance gives
        a model slightly more/less weight.
      */

      weight =
        0.85 +
        (
          test.accuracy -
          50
        ) *
        0.02;

      weight =
        Math.max(
          0.55,
          Math.min(
            1.45,
            weight
          )
        );

      sampleCount +=
        test.tested;

      accuracyTotal +=
        test.accuracy;

      accuracyModels++;
    }


    const strength =
      Math.max(
        0.10,
        Math.min(
          1,
          Number(
            model.strength
          ) || 0
        )
      );


    const vote =
      weight *
      (
        0.70 +
        strength *
        0.30
      );


    if (
      model.side ===
      "BIG"
    ) {
      bigVote += vote;
    } else {
      smallVote += vote;
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

      tested:
        test.tested,

      accuracy:
        test.accuracy
    });
  }


  const total =
    bigVote +
    smallVote;


  const prediction =
    bigVote >= smallVote
      ? "BIG"
      : "SMALL";


  const sameSide =
    details.filter(
      model =>
        model.side ===
        prediction
    ).length;


  const agreement =
    sameSide /
    details.length;


  const margin =
    total
      ? Math.abs(
          bigVote -
          smallVote
        ) / total
      : 0;


  const averageAccuracy =
    accuracyModels
      ? Math.round(
          (
            accuracyTotal /
            accuracyModels
          ) * 10
        ) / 10
      : null;


  /*
    Confidence intentionally capped.
    No claim of guaranteed accuracy.
  */

  let confidence =
    52 +
    margin * 18;


  confidence +=
    Math.max(
      0,
      agreement -
        0.50
    ) * 12;


  if (
    averageAccuracy !== null
  ) {
    confidence +=
      Math.max(
        0,
        averageAccuracy -
          50
      ) * 0.20;
  }


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


  let status =
    "STATISTICAL SIGNAL";


  if (
    agreement >= 0.67 &&
    margin >= 0.10
  ) {
    status =
      "STRONG SIGNAL";
  }


  if (
    sampleCount < 5
  ) {
    status =
      "EARLY SIGNAL";
  }


  const patternScore =
    Math.round(
      Math.max(
        45,
        Math.min(
          95,
          50 +
          margin * 30 +
          agreement * 15
        )
      )
    );


  return {
    prediction,

    confidence,

    patternScore,

    agreement:
      Math.round(
        agreement * 100
      ),

    backtestSamples:
      sampleCount,

    avgModelAccuracy:
      averageAccuracy,

    status,

    models:
      details
  };
}


/* =========================================================
   SAVE PREDICTION
========================================================= */

async function savePrediction(
  targetIssue,
  analysis
) {
  if (
    !process.env.DATABASE_URL
  ) {
    return;
  }

  if (
    !targetIssue ||
    !analysis ||
    !analysis.prediction
  ) {
    return;
  }

  try {
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
      ($1,$2,$3,$4,$5)

      ON CONFLICT
      (target_issue)

      DO UPDATE SET
        prediction =
          EXCLUDED.prediction,

        confidence =
          EXCLUDED.confidence,

        pattern_score =
          EXCLUDED.pattern_score
      `,
      [
        targetIssue,

        analysis.prediction,

        analysis.confidence,

        analysis.patternScore,

        Date.now()
      ]
    );
  } catch (error) {
    console.error(
      "Prediction save error:",
      error.message
    );
  }
}


/* =========================================================
   SETTLE PREDICTION
========================================================= */

async function settlePrediction(
  row
) {
  if (
    !process.env.DATABASE_URL
  ) {
    return;
  }

  if (
    !row ||
    !row.issueNumber
  ) {
    return;
  }

  const actual =
    classify(
      row.number
    );

  if (!actual) {
    return;
  }

  try {
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

      WHERE target_issue = $3
        AND result IS NULL
      `,
      [
        actual,
        Date.now(),
        row.issueNumber
      ]
    );
  } catch (error) {
    console.error(
      "Settlement error:",
      error.message
    );
  }
}


/* =========================================================
   WIN / LOSS HISTORY
========================================================= */

async function getWinLoss() {
  if (
    !process.env.DATABASE_URL
  ) {
    return {
      rows: [],

      stats: {
        total: 0,
        win: 0,
        loss: 0,
        rate: 0
      }
    };
  }


  /*
    Display only last 30
    settled predictions.
  */

  const result =
    await pool.query(`
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

      LIMIT ${WINLOSS_LIMIT}
    `);


  const rows =
    result.rows;


  const win =
    rows.filter(
      row =>
        row.result ===
        "WIN"
    ).length;


  const loss =
    rows.filter(
      row =>
        row.result ===
        "LOSS"
    ).length;


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
              (
                win * 100
              ) /
              (
                win + loss
              )
            * 10
            ) / 10
          : 0
    }
  };
}


/* =========================================================
   LIVE PROVIDER UPDATE
========================================================= */

async function updateLiveState() {
  try {
    const data =
      await fetchWingo();


    const history =
      normalizeHistory(
        data
      );


    if (
      !history.length
    ) {
      throw new Error(
        "Provider returned empty history"
      );
    }


    const settledIssue =
      history[0]
        .issueNumber;


    const providerCurrent =
      clean(
        data?.current
          ?.issueNumber
      );


    let targetIssue =
      null;


    /*
      Prefer provider current issue
      if it is ahead of settled.
    */

    if (
      providerCurrent &&
      compareIssues(
        providerCurrent,
        settledIssue
      ) > 0
    ) {
      targetIssue =
        providerCurrent;
    } else {
      targetIssue =
        nextIssue(
          settledIssue
        );
    }


    const signature =
      history
        .slice(
          0,
          15
        )
        .map(
          row =>
            `${row.issueNumber}:${row.number}`
        )
        .join("|");


    const historyChanged =
      signature !==
      state.historySignature;


    state.history =
      history;


    state.settledIssue =
      settledIssue;


    state.targetIssue =
      targetIssue;


    state.providerCountdown =
      extractCountdown(
        data
      );


    state.lastUpdated =
      Date.now();


    state.connected =
      true;


    state.error =
      null;


    /*
      ONLY create a new prediction
      when a new settled result arrives.
    */

    if (
      historyChanged
    ) {
      state.historySignature =
        signature;

      state.version++;


      /*
        First settle old prediction.
      */

      await settlePrediction(
        history[0]
      );


      /*
        AI gets complete provider
        history, not only displayed 30.
      */

      state.analysis =
        adaptiveEnsemble(
          history
        );


      /*
        Always save target prediction
        if a signal is available.
      */

      await savePrediction(
        targetIssue,
        state.analysis
      );


      state.anchorTime =
        Date.now();


      console.log(
        "================================"
      );

      console.log(
        "NEW WINGO RESULT:",
        settledIssue
      );

      console.log(
        "NEXT ISSUE:",
        targetIssue
      );

      console.log(
        "PREDICTION:",
        state.analysis
          ?.prediction
      );

      console.log(
        "CONFIDENCE:",
        state.analysis
          ?.confidence
      );

      console.log(
        "STATUS:",
        state.analysis
          ?.status
      );

      console.log(
        "================================"
      );
    }

  } catch (error) {
    state.connected =
      false;

    state.error =
      error.message;

    console.error(
      "WINGOBOT ERROR:",
      error.message
    );
  }
}


/* =========================================================
   TIMER
========================================================= */

function getTiming() {
  /*
    If provider supplies countdown,
    use it.
  */

  if (
    Number.isFinite(
      state.providerCountdown
    )
  ) {
    return {
      seconds:
        Math.max(
          0,
          Math.min(
            30,
            state.providerCountdown
          )
        ),

      exact:
        true
    };
  }


  /*
    Otherwise calculate a smooth
    local countdown from the moment
    the latest settled result arrived.
  */

  if (
    !state.anchorTime
  ) {
    return {
      seconds: 30,
      exact: false
    };
  }


  const elapsed =
    Math.floor(
      (
        Date.now() -
        state.anchorTime
      ) / 1000
    );


  let seconds =
    ROUND_SECONDS -
    (
      elapsed %
      ROUND_SECONDS
    );


  if (
    seconds <= 0 ||
    seconds > 30
  ) {
    seconds = 30;
  }


  return {
    seconds,
    exact: false
  };
}


/* =========================================================
   ADMIN
========================================================= */

function isAdmin(req) {
  const supplied =
    clean(
      req.headers[
        "x-admin-key"
      ]
    );

  return (
    supplied ===
    ADMIN_KEY
  );
}


/* =========================================================
   API HANDLER
========================================================= */

async function handleAPI(
  req,
  res,
  url
) {

  /* -------------------------
     HEALTH
  ------------------------- */

  if (
    url.pathname ===
    "/health"
  ) {
    return sendJSON(
      res,
      200,
      {
        ok: true,
        service:
          "DY AI WINGO",
        time:
          Date.now()
      }
    );
  }


  /* -------------------------
     STATE
  ------------------------- */

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

        connected:
          state.connected,

        /*
          Frontend gets latest 30.
        */

        history:
          state.history.slice(
            0,
            LIVE_RESULTS_LIMIT
          ),

        settledIssue:
          state.settledIssue,

        targetIssue:
          state.targetIssue,

        nextIssue:
          state.targetIssue,

        historyVersion:
          state.version,

        lastUpdated:
          state.lastUpdated,

        timing:
          getTiming(),

        analysis:
          state.analysis,

        error:
          state.error
      }
    );
  }


  /* -------------------------
     WIN / LOSS
  ------------------------- */

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


  /* -------------------------
     ACCESS KEY CHECK
  ------------------------- */

  if (
    url.pathname ===
      "/api/key/check" &&
    req.method ===
      "POST"
  ) {

    const data =
      await readBody(req);


    const key =
      clean(
        data.key ||
        data.access_key
      );


    const deviceId =
      clean(
        req.headers[
          "x-device-id"
        ] ||
        data.device_id
      );


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


    if (
      result.rowCount === 0
    ) {
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


    /*
      One key -> one browser.
    */

    if (
      row.device_id &&
      row.device_id !==
        deviceId
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
        deviceId,
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


  /* =======================================================
     ADMIN AUTH
  ======================================================= */

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


    /* -----------------------
       ADMIN PING
    ----------------------- */

    if (
      url.pathname ===
        "/api/admin/ping"
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

          time:
            Date.now()
        }
      );
    }


    /* -----------------------
       ADMIN STATUS
    ----------------------- */

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

          connected:
            state.connected,

          history:
            state.history.length,

          settledIssue:
            state.settledIssue,

          targetIssue:
            state.targetIssue,

          analysis:
            state.analysis,

          error:
            state.error
        }
      );
    }


    /* -----------------------
       WINGOBOT TEST
    ----------------------- */

    if (
      url.pathname ===
        "/api/admin/wingo-test"
    ) {

      try {
        const data =
          await fetchWingo();

        const history =
          normalizeHistory(
            data
          );

        return sendJSON(
          res,
          200,
          {
            ok: true,

            current:
              data.current ||
              null,

            fetched:
              history.length,

            history:
              history.slice(
                0,
                30
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


    /* -----------------------
       MODEL TEST
    ----------------------- */

    if (
      url.pathname ===
        "/api/admin/model-test"
    ) {

      const analysis =
        adaptiveEnsemble(
          state.history
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

          backtestSamples:
            analysis.backtestSamples,

          avgModelAccuracy:
            analysis.avgModelAccuracy,

          status:
            analysis.status,

          models:
            analysis.models
        }
      );
    }


    /* -----------------------
       GET ACCESS KEYS
    ----------------------- */

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


    /* -----------------------
       CREATE ACCESS KEYS
    ----------------------- */

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


      let count =
        Number(
          data.count || 1
        );


      if (
        !Number.isFinite(count)
      ) {
        count = 1;
      }


      count =
        Math.max(
          1,
          Math.min(
            100,
            Math.floor(count)
          )
        );


      const keys = [];


      for (
        let i = 0;
        i < count;
        i++
      ) {

        let inserted =
          false;


        while (
          !inserted
        ) {

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
              ($1,$2)

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
            keys.push(
              key
            );

            inserted =
              true;
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


    /* -----------------------
       DELETE ACCESS KEY
    ----------------------- */

    if (
      url.pathname ===
        "/api/admin/keys" &&
      req.method ===
        "DELETE"
    ) {

      const data =
        await readBody(req);


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


      await pool.query(
        `
        DELETE FROM access_keys
        WHERE id = $1
        `,
        [
          data.id
        ]
      );


      return sendJSON(
        res,
        200,
        {
          ok: true
        }
      );
    }


    /* -----------------------
       RESET DEVICE
    ----------------------- */

    if (
      url.pathname ===
        "/api/admin/reset-device" &&
      req.method ===
        "POST"
    ) {

      const data =
        await readBody(req);


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


      await pool.query(
        `
        UPDATE access_keys

        SET
          device_id = NULL

        WHERE id = $1
        `,
        [
          data.id
        ]
      );


      return sendJSON(
        res,
        200,
        {
          ok: true
        }
      );
    }


    return sendJSON(
      res,
      404,
      {
        ok: false,

        message:
          "Admin endpoint not found"
      }
    );
  }


  return null;
}


/* =========================================================
   STATIC FILE SERVER
========================================================= */

function serveStatic(
  req,
  res,
  url
) {
  let requestPath =
    url.pathname;


  if (
    requestPath === "/" ||
    requestPath === ""
  ) {
    requestPath =
      "/prediction.html";
  }


  /*
    Security:
    prevent ../ traversal.
  */

  if (
    requestPath.includes("..")
  ) {
    return sendJSON(
      res,
      400,
      {
        ok: false,

        message:
          "Invalid path"
      }
    );
  }


  const filePath =
    path.join(
      __dirname,
      requestPath
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


  const stat =
    fs.statSync(
      filePath
    );


  if (
    stat.isDirectory()
  ) {
    return sendJSON(
      res,
      403,
      {
        ok: false,

        message:
          "Directory access denied"
      }
    );
  }


  const ext =
    path.extname(
      filePath
    ).toLowerCase();


  const mime = {
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

    ".webp":
      "image/webp",

    ".svg":
      "image/svg+xml",

    ".ico":
      "image/x-icon",

    ".mp3":
      "audio/mpeg"
  };


  /* =======================================================
     MP3 RANGE SUPPORT
  ======================================================= */

  if (
    ext === ".mp3"
  ) {

    const range =
      req.headers.range;


    if (range) {

      const match =
        range.match(
          /bytes=(\d+)-(\d*)/
        );


      if (match) {

        let start =
          Number(
            match[1]
          );


        let end =
          match[2]
            ? Number(
                match[2]
              )
            : stat.size - 1;


        if (
          Number.isFinite(
            start
          ) &&
          Number.isFinite(
            end
          )
        ) {

          start =
            Math.max(
              0,
              start
            );


          end =
            Math.min(
              stat.size - 1,
              end
            );


          if (
            start <= end
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
                  end - start + 1,

                "Cache-Control":
                  "public, max-age=3600"
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
    }


    res.writeHead(
      200,
      {
        "Content-Type":
          "audio/mpeg",

        "Accept-Ranges":
          "bytes",

        "Content-Length":
          stat.size,

        "Cache-Control":
          "public, max-age=3600"
      }
    );


    return fs
      .createReadStream(
        filePath
      )
      .pipe(res);
  }


  /* =======================================================
     NORMAL FILE
  ======================================================= */

  res.writeHead(
    200,
    {
      "Content-Type":
        mime[ext] ||
        "application/octet-stream",

      "Cache-Control":
        ext === ".html"
          ? "no-cache"
          : "public, max-age=3600"
    }
  );


  fs
    .createReadStream(
      filePath
    )
    .pipe(res);
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

        /*
          CORS preflight
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
                "Content-Type, X-Admin-Key, X-Device-Id",

              "Access-Control-Allow-Methods":
                "GET, POST, DELETE, OPTIONS"
            }
          );

          return res.end();
        }


        const url =
          new URL(
            req.url,
            `http://${
              req.headers.host ||
              "localhost"
            }`
          );


        const result =
          await handleAPI(
            req,
            res,
            url
          );


        if (
          result !== null
        ) {
          return;
        }


        return serveStatic(
          req,
          res,
          url
        );

      } catch (error) {

        console.error(
          "SERVER ERROR:",
          error
        );


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
  );


/* =========================================================
   START APPLICATION
========================================================= */

async function start() {
  try {

    await initDatabase();


    /*
      First provider sync
    */

    await updateLiveState();


    /*
      Keep provider data fresh.
      This does NOT create a new prediction
      every second. Prediction changes only
      when the settled history changes.
    */

    setInterval(
      async () => {
        await updateLiveState();
      },
      1000
    );


    server.listen(
      PORT,
      () => {

        console.log(
          "================================"
        );

        console.log(
          "DY AI WINGO SERVER STARTED"
        );

        console.log(
          "PORT:",
          PORT
        );

        console.log(
          "WINGOBOT:",
          WINGOBOT_TOKEN
            ? "CONFIGURED"
            : "MISSING"
        );

        console.log(
          "DATABASE:",
          process.env.DATABASE_URL
            ? "CONFIGURED"
            : "MISSING"
        );

        console.log(
          "================================"
        );
      }
    );

  } catch (error) {

    console.error(
      "STARTUP ERROR:",
      error
    );

    process.exit(1);
  }
}


start();
