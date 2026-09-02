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

const cache = {
  history: [],
  currentIssue: null,
  settledIssue: null,
  targetIssue: null,

  historyVersion: 0,
  historySignature: "",

  analysis: null,

  lastUpdated: 0,
  providerCountdown: null,
  anchorTime: 0,

  error: null
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
   JSON
===================================================== */

function sendJSON(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
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
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}


/* =====================================================
   BIG / SMALL
===================================================== */

function classify(number) {
  const n = Number(number);

  if (!Number.isFinite(n)) {
    return null;
  }

  return n >= 5 ? "BIG" : "SMALL";
}


/* =====================================================
   ISSUE HELPERS
===================================================== */

function cleanIssue(value) {
  return String(value || "").trim();
}


function compareIssues(a, b) {
  try {
    const A = BigInt(a);
    const B = BigInt(b);

    if (A > B) return 1;
    if (A < B) return -1;

    return 0;
  } catch {
    return String(a).localeCompare(String(b));
  }
}


function nextIssue(value) {
  const s = cleanIssue(value);

  const match = s.match(/^(.*?)(\d+)$/);

  if (!match) {
    return null;
  }

  const prefix = match[1];
  const digits = match[2];

  try {
    const next = BigInt(digits) + 1n;

    return (
      prefix +
      next.toString().padStart(digits.length, "0")
    );
  } catch {
    return null;
  }
}


/* =====================================================
   PROVIDER NORMALIZATION
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
    .map(row => ({
      issueNumber: cleanIssue(
        row.issueNumber ??
        row.issue ??
        row.period
      ),

      number: Number(row.number),

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
    }))
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
   WINGOBOT
===================================================== */

async function fetchWingoData() {
  if (!WINGOBOT_TOKEN) {
    throw new Error(
      "WINGOBOT_TOKEN is not configured"
    );
  }

  const response = await fetch(
    WINGOBOT_URL,
    {
      headers: {
        Authorization:
          `Bearer ${WINGOBOT_TOKEN}`,

        Accept: "application/json"
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
   BASIC HELPERS
===================================================== */

function sideOf(row) {
  return classify(row.number);
}


function sequenceFromHistory(history, limit = 80) {
  return history
    .slice(0, limit)
    .map(sideOf)
    .filter(Boolean);
}


function opposite(side) {
  return side === "BIG"
    ? "SMALL"
    : "BIG";
}


function makeVote() {
  return {
    BIG: 0,
    SMALL: 0
  };
}


function addVote(vote, side, weight) {
  if (
    side !== "BIG" &&
    side !== "SMALL"
  ) {
    return;
  }

  if (
    !Number.isFinite(weight) ||
    weight <= 0
  ) {
    return;
  }

  vote[side] += weight;
}


/* =====================================================
   MODEL 1
   EXACT HISTORICAL CONTEXT
===================================================== */

function exactContextModel(sequence, length) {
  if (sequence.length < length + 2) {
    return null;
  }

  const current =
    sequence
      .slice(0, length)
      .join("");

  const vote = makeVote();
  let matches = 0;

  for (
    let i = length;
    i < sequence.length - 1;
    i++
  ) {
    const old =
      sequence
        .slice(i, i + length)
        .join("");

    if (old !== current) {
      continue;
    }

    const next = sequence[i - 1];

    const recency =
      1 /
      (1 + i * 0.055);

    addVote(
      vote,
      next,
      1.25 * recency
    );

    matches++;
  }

  if (!matches) {
    return null;
  }

  const side =
    vote.BIG >= vote.SMALL
      ? "BIG"
      : "SMALL";

  const total =
    vote.BIG +
    vote.SMALL;

  return {
    name: `CTX-${length}`,
    side,
    matches,
    rawWeight: total,
    confidence:
      total
        ? Math.abs(
            vote.BIG -
            vote.SMALL
          ) / total
        : 0
  };
}


/* =====================================================
   MODEL 2
   PARTIAL / SIMILAR CONTEXT
===================================================== */

function similarContextModel(sequence, length) {
  if (sequence.length < length + 3) {
    return null;
  }

  const current =
    sequence.slice(0, length);

  const vote = makeVote();

  let matches = 0;

  for (
    let i = length;
    i < sequence.length - 1;
    i++
  ) {
    const old =
      sequence.slice(
        i,
        i + length
      );

    let distance = 0;

    for (
      let j = 0;
      j < length;
      j++
    ) {
      if (
        current[j] !== old[j]
      ) {
        distance++;
      }
    }

    const allowed =
      length <= 5 ? 1 : 2;

    if (distance > allowed) {
      continue;
    }

    const similarity =
      1 -
      distance / length;

    const next =
      sequence[i - 1];

    const weight =
      similarity *
      0.65 /
      (1 + i * 0.065);

    addVote(
      vote,
      next,
      weight
    );

    matches++;
  }

  if (!matches) {
    return null;
  }

  const side =
    vote.BIG >= vote.SMALL
      ? "BIG"
      : "SMALL";

  const total =
    vote.BIG +
    vote.SMALL;

  return {
    name: `SIM-${length}`,
    side,
    matches,
    rawWeight: total,
    confidence:
      total
        ? Math.abs(
            vote.BIG -
            vote.SMALL
          ) / total
        : 0
  };
}


/* =====================================================
   MODEL 3
   TRANSITION
===================================================== */

function transitionModel(sequence) {
  if (sequence.length < 10) {
    return null;
  }

  const current = sequence[0];

  const vote = makeVote();

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

    const weight =
      0.75 /
      (1 + i * 0.06);

    addVote(
      vote,
      next,
      weight
    );

    matches++;
  }

  if (!matches) {
    return null;
  }

  const side =
    vote.BIG >= vote.SMALL
      ? "BIG"
      : "SMALL";

  const total =
    vote.BIG +
    vote.SMALL;

  return {
    name: "TRANSITION",
    side,
    matches,
    rawWeight: total,
    confidence:
      total
        ? Math.abs(
            vote.BIG -
            vote.SMALL
          ) / total
        : 0
  };
}


/* =====================================================
   MODEL 4
   RUN STRUCTURE
===================================================== */

function runStructureModel(sequence) {
  if (sequence.length < 10) {
    return null;
  }

  let currentRun = 1;

  while (
    currentRun < sequence.length &&
    sequence[currentRun] ===
      sequence[0]
  ) {
    currentRun++;
  }

  const vote = makeVote();

  let matches = 0;

  for (
    let i = 0;
    i < sequence.length - 2;
    i++
  ) {
    let run = 1;

    while (
      i + run < sequence.length &&
      sequence[i + run] ===
        sequence[i]
    ) {
      run++;
    }

    if (
      run !== currentRun
    ) {
      continue;
    }

    if (i === 0) {
      continue;
    }

    const next =
      sequence[i - 1];

    const weight =
      0.7 /
      (1 + i * 0.07);

    addVote(
      vote,
      next,
      weight
    );

    matches++;
  }

  if (!matches) {
    return null;
  }

  const side =
    vote.BIG >= vote.SMALL
      ? "BIG"
      : "SMALL";

  const total =
    vote.BIG +
    vote.SMALL;

  return {
    name: "RUN",
    side,
    matches,
    rawWeight: total,
    confidence:
      total
        ? Math.abs(
            vote.BIG -
            vote.SMALL
          ) / total
        : 0
  };
}


/* =====================================================
   MODEL 5
   REVERSAL / ALTERNATION
===================================================== */

function reversalModel(sequence) {
  if (sequence.length < 8) {
    return null;
  }

  let alternating = true;

  for (
    let i = 0;
    i < 7;
    i++
  ) {
    if (
      sequence[i] ===
      sequence[i + 1]
    ) {
      alternating = false;
      break;
    }
  }

  if (!alternating) {
    return null;
  }

  return {
    name: "REVERSAL",
    side: opposite(sequence[0]),
    matches: 1,
    rawWeight: 0.45,
    confidence: 0.35
  };
}


/* =====================================================
   MODEL 6
   REPEATED BLOCK
===================================================== */

function repeatedBlockModel(sequence) {
  if (sequence.length < 12) {
    return null;
  }

  for (
    const length of [2, 3, 4]
  ) {
    const block =
      sequence.slice(
        0,
        length
      );

    const previous =
      sequence.slice(
        length,
        length * 2
      );

    if (
      block.join("") ===
      previous.join("")
    ) {
      return {
        name:
          `BLOCK-${length}`,

        side:
          sequence[length - 1],

        matches: 1,

        rawWeight: 0.6,

        confidence: 0.45
      };
    }
  }

  return null;
}


/* =====================================================
   MODEL 7
   MIRROR STRUCTURE
===================================================== */

function mirrorModel(sequence) {
  if (sequence.length < 10) {
    return null;
  }

  const a =
    sequence.slice(0, 5);

  const b =
    sequence.slice(5, 10);

  let same = 0;

  for (
    let i = 0;
    i < 5;
    i++
  ) {
    if (
      a[i] ===
      b[i]
    ) {
      same++;
    }
  }

  if (same < 4) {
    return null;
  }

  return {
    name: "MIRROR",
    side:
      opposite(
        sequence[0]
      ),
    matches: same,
    rawWeight: 0.5,
    confidence:
      same / 5
  };
}


/* =====================================================
   MODEL 8
   DIGIT STRUCTURE
   Uses actual numbers, not only BIG/SMALL.
===================================================== */

function digitStructureModel(history) {
  if (history.length < 12) {
    return null;
  }

  const nums =
    history
      .slice(0, 30)
      .map(x => Number(x.number))
      .filter(
        n =>
          Number.isInteger(n) &&
          n >= 0 &&
          n <= 9
      );

  if (nums.length < 12) {
    return null;
  }

  const latest =
    nums[0];

  const recentPattern =
    nums
      .slice(0, 4)
      .join("");

  const vote = makeVote();

  let matches = 0;

  for (
    let i = 4;
    i < nums.length - 4;
    i++
  ) {
    const pattern =
      nums
        .slice(i, i + 4)
        .join("");

    if (
      pattern !==
      recentPattern
    ) {
      continue;
    }

    const next =
      classify(
        nums[i - 1]
      );

    addVote(
      vote,
      next,
      0.8 /
      (1 + i * 0.08)
    );

    matches++;
  }

  if (!matches) {
    return null;
  }

  const side =
    vote.BIG >= vote.SMALL
      ? "BIG"
      : "SMALL";

  const total =
    vote.BIG +
    vote.SMALL;

  return {
    name: "DIGIT-PATTERN",
    side,
    matches,
    rawWeight: total,
    confidence:
      total
        ? Math.abs(
            vote.BIG -
            vote.SMALL
          ) / total
        : 0
  };
}


/* =====================================================
   BUILD MODELS
===================================================== */

function buildModels(history) {
  const sequence =
    sequenceFromHistory(
      history,
      80
    );

  const models = [];

  for (
    const length of
    [2, 3, 4, 5, 6, 8]
  ) {
    const exact =
      exactContextModel(
        sequence,
        length
      );

    if (exact) {
      models.push(exact);
    }

    const similar =
      similarContextModel(
        sequence,
        length
      );

    if (similar) {
      models.push(similar);
    }
  }

  const transition =
    transitionModel(
      sequence
    );

  if (transition) {
    models.push(transition);
  }

  const run =
    runStructureModel(
      sequence
    );

  if (run) {
    models.push(run);
  }

  const reversal =
    reversalModel(
      sequence
    );

  if (reversal) {
    models.push(reversal);
  }

  const block =
    repeatedBlockModel(
      sequence
    );

  if (block) {
    models.push(block);
  }

  const mirror =
    mirrorModel(
      sequence
    );

  if (mirror) {
    models.push(mirror);
  }

  const digit =
    digitStructureModel(
      history
    );

  if (digit) {
    models.push(digit);
  }

  return models;
}


/* =====================================================
   WALK-FORWARD MODEL VALIDATION
   ===================================================== */

function testModelAt(
  history,
  modelName,
  index
) {
  const slice =
    history.slice(
      index
    );

  if (
    slice.length < 12
  ) {
    return null;
  }

  const sequence =
    sequenceFromHistory(
      slice,
      80
    );

  if (
    sequence.length < 8
  ) {
    return null;
  }

  let model = null;

  if (
    modelName.startsWith("CTX-")
  ) {
    const n =
      Number(
        modelName.split("-")[1]
      );

    model =
      exactContextModel(
        sequence,
        n
      );
  }

  else if (
    modelName.startsWith("SIM-")
  ) {
    const n =
      Number(
        modelName.split("-")[1]
      );

    model =
      similarContextModel(
        sequence,
        n
      );
  }

  else if (
    modelName ===
    "TRANSITION"
  ) {
    model =
      transitionModel(
        sequence
      );
  }

  else if (
    modelName ===
    "RUN"
  ) {
    model =
      runStructureModel(
        sequence
      );
  }

  else if (
    modelName ===
    "REVERSAL"
  ) {
    model =
      reversalModel(
        sequence
      );
  }

  else if (
    modelName.startsWith(
      "BLOCK-"
    )
  ) {
    model =
      repeatedBlockModel(
        sequence
      );
  }

  else if (
    modelName ===
    "MIRROR"
  ) {
    model =
      mirrorModel(
        sequence
      );
  }

  else if (
    modelName ===
    "DIGIT-PATTERN"
  ) {
    model =
      digitStructureModel(
        slice
      );
  }

  if (!model) {
    return null;
  }

  return model;
}


function validateModels(history, models) {
  const performance = {};

  for (
    const model of models
  ) {
    performance[model.name] = {
      tested: 0,
      wins: 0,
      losses: 0,
      accuracy: 0,
      weight: 1
    };
  }

  /*
    Walk-forward testing:
    prediction is generated only
    from data before the tested result.
  */

  const maxTests =
    Math.min(
      24,
      Math.max(
        0,
        history.length - 14
      )
    );

  for (
    let step = 1;
    step <= maxTests;
    step++
  ) {
    const index = step;

    const actual =
      classify(
        history[index - 1]?.number
      );

    if (!actual) {
      continue;
    }

    for (
      const model of models
    ) {
      const result =
        testModelAt(
          history,
          model.name,
          index
        );

      if (!result) {
        continue;
      }

      if (
        !performance[
          model.name
        ]
      ) {
        continue;
      }

      performance[
        model.name
      ].tested++;

      if (
        result.side === actual
      ) {
        performance[
          model.name
        ].wins++;
      } else {
        performance[
          model.name
        ].losses++;
      }
    }
  }

  for (
    const name of
    Object.keys(performance)
  ) {
    const p =
      performance[name];

    if (
      p.tested > 0
    ) {
      p.accuracy =
        p.wins /
        p.tested;
    }

    /*
      Adaptive weight.

      No model gets unlimited influence.
      Poor recent validation reduces its
      contribution instead of forcing it
      to keep predicting the same side.
    */

    if (
      p.tested >= 3
    ) {
      p.weight =
        0.55 +
        Math.max(
          0,
          Math.min(
            0.9,
            (
              p.accuracy -
              0.5
            ) * 2
          )
        );

      if (
        p.accuracy < 0.40
      ) {
        p.weight *= 0.55;
      }
    }
  }

  return performance;
}


/* =====================================================
   ADAPTIVE ENSEMBLE
===================================================== */

function adaptiveEnsemble(
  history
) {
  const models =
    buildModels(
      history
    );

  if (!models.length) {
    return {
      prediction:
        sequenceFromHistory(
          history,
          2
        )[0] === "BIG"
          ? "SMALL"
          : "BIG",

      confidence: 51,
      patternScore: 50,
      agreement: 0,
      evidence: 0,
      status: "LOW SIGNAL",
      models: []
    };
  }

  const performance =
    validateModels(
      history,
      models
    );

  const vote = makeVote();

  const details = [];

  for (
    const model of models
  ) {
    const p =
      performance[
        model.name
      ];

    let adaptiveWeight =
      p?.weight || 1;

    /*
      Stronger historical match gets
      more influence, but capped.
    */

    const confidenceBoost =
      0.75 +
      Math.min(
        0.75,
        model.confidence * 1.5
      );

    adaptiveWeight *=
      confidenceBoost;

    adaptiveWeight =
      Math.max(
        0.15,
        Math.min(
          1.8,
          adaptiveWeight
        )
      );

    addVote(
      vote,
      model.side,
      model.rawWeight *
        adaptiveWeight
    );

    details.push({
      name: model.name,
      side: model.side,
      matches: model.matches,

      accuracy:
        p
          ? Math.round(
              p.accuracy * 100
            )
          : null,

      tested:
        p
          ? p.tested
          : 0,

      weight:
        Number(
          adaptiveWeight.toFixed(3)
        )
    });
  }

  const total =
    vote.BIG +
    vote.SMALL;

  if (!total) {
    return {
      prediction: "BIG",
      confidence: 51,
      patternScore: 50,
      agreement: 0,
      evidence: models.length,
      status: "LOW SIGNAL",
      models: details
    };
  }

  const prediction =
    vote.BIG >= vote.SMALL
      ? "BIG"
      : "SMALL";

  const margin =
    Math.abs(
      vote.BIG -
      vote.SMALL
    ) / total;

  let agreeWeight =
    0;

  let totalModelWeight =
    0;

  for (
    const model of models
  ) {
    const p =
      performance[
        model.name
      ];

    const w =
      Math.max(
        0.15,
        Math.min(
          1.8,
          (
            p?.weight || 1
          ) *
          (
            0.75 +
            Math.min(
              0.75,
              model.confidence * 1.5
            )
          )
        )
      );

    totalModelWeight += w;

    if (
      model.side ===
      prediction
    ) {
      agreeWeight += w;
    }
  }

  const agreement =
    totalModelWeight
      ? agreeWeight /
        totalModelWeight
      : 0;

  /*
    Confidence intentionally stays moderate.
    Statistical history cannot justify 90-100%.
  */

  let confidence =
    Math.round(
      50 +
      margin * 22 +
      Math.max(
        0,
        agreement - 0.5
      ) * 22
    );

  confidence =
    Math.max(
      51,
      Math.min(
        74,
        confidence
      )
    );

  /*
    Conflicting models => lower confidence.
  */

  if (
    agreement < 0.58 ||
    margin < 0.06
  ) {
    confidence =
      Math.min(
        confidence,
        55
      );
  }

  const patternScore =
    Math.max(
      50,
      Math.min(
        90,
        Math.round(
          50 +
          margin * 40 +
          Math.max(
            0,
            agreement - 0.5
          ) * 25
        )
      )
    );

  let status =
    "LOW SIGNAL";

  if (
    agreement >= 0.68 &&
    margin >= 0.12
  ) {
    status =
      "ADAPTIVE SIGNAL";
  }

  return {
    prediction,

    confidence,

    patternScore,

    status,

    agreement:
      Math.round(
        agreement * 100
      ),

    evidence:
      models.length,

    vote: {
      big:
        Number(
          vote.BIG.toFixed(3)
        ),

      small:
        Number(
          vote.SMALL.toFixed(3)
        )
    },

    models:
      details.slice(
        0,
        20
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
    !analysis
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
    classify(
      row.number
    );

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
   WIN LOSS
===================================================== */

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
      x =>
        x.result ===
        "WIN"
    ).length;

  const loss =
    rows.filter(
      x =>
        x.result ===
        "LOSS"
    ).length;

  let streak = "-";

  if (rows.length) {
    const first =
      rows[0].result;

    let count = 0;

    for (
      const row of rows
    ) {
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
   CACHE
===================================================== */

async function updateCache() {
  try {
    const data =
      await fetchWingoData();

    const history =
      normalizeHistory(
        data
      );

    if (
      !history.length
    ) {
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
        .slice(0, 10)
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
      Prediction changes only after
      a new settled result arrives.
    */

    if (changed) {
      cache.historySignature =
        signature;

      cache.historyVersion++;

      /*
        First settle previous
        target.
      */

      await settlePrediction(
        history[0]
      );

      /*
        Generate adaptive
        statistical analysis.
      */

      cache.analysis =
        adaptiveEnsemble(
          history
        );

      cache.anchorTime =
        Date.now();

      /*
        Save prediction for
        next target.
      */

      await savePrediction(
        targetIssue,
        cache.analysis
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

  if (
    !cache.anchorTime
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
        cache.anchorTime
      ) / 1000
    );

  let seconds =
    ROUND_SECONDS -
    (
      elapsed %
      ROUND_SECONDS
    );

  if (
    seconds === 0
  ) {
    seconds =
      ROUND_SECONDS;
  }

  return {
    seconds,
    exact: false
  };
}


/* =====================================================
   ADMIN AUTH
===================================================== */

function checkAdmin(req) {
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

  /* HEALTH */

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


  /* STATE */

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


  /* WIN LOSS */

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


  /* ACCESS KEY */

  if (
    url.pathname ===
      "/api/key/check" &&
    req.method ===
      "POST"
  ) {
    const data =
      await readBody(
        req
      );

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

    if (
      !result.rowCount
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

    if (
      row.device_id &&
      row.device_id !==
        device
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

    if (
      !checkAdmin(req)
    ) {
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


    /* ADMIN PING */

    if (
      url.pathname ===
        "/api/admin/ping"
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


    /* STATUS */

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

          target:
            cache.targetIssue,

          version:
            cache.historyVersion
        }
      );
    }


    /* WINGOBOT TEST */

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


    /* LIST KEYS */

    if (
      url.pathname ===
        "/api/admin/keys" &&
      req.method ===
        "GET"
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


    /* CREATE KEYS */

    if (
      url.pathname ===
        "/api/admin/keys" &&
      req.method ===
        "POST"
    ) {
      const data =
        await readBody(
          req
        );

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
        let created =
          false;

        while (!created) {
          const key =
            "DY-" +
            crypto
              .randomBytes(5)
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


    /* DELETE KEY */

    if (
      url.pathname ===
        "/api/admin/keys" &&
      req.method ===
        "DELETE"
    ) {
      const data =
        await readBody(
          req
        );

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


    /* RESET DEVICE */

    if (
      url.pathname ===
        "/api/admin/reset-device" &&
      req.method ===
        "POST"
    ) {
      const data =
        await readBody(
          req
        );

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
      "application/json"
  };


  /* MP3 */

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
          Number(
            match[1]
          );

        const end =
          match[2]
            ? Number(
                match[2]
              )
            : stat.size - 1;

        if (
          start <
          stat.size &&
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
    async (
      req,
      res
    ) => {

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
      Server starts even if the first
      provider request temporarily fails.
    */

    await updateCache();

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
