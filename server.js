const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 10000);
const ADMIN_KEY = process.env.ADMIN_KEY || "change-this-admin-key";
const WINGOBOT_TOKEN = process.env.WINGOBOT_TOKEN || "";

const WINGOBOT_URL =
  "https://api.wingobot.com/v2/30-sec-game-history";

const ROUND_SECONDS = 30;
const LIVE_LIMIT = 30;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});

const cache = {
  history: [],
  settledIssue: null,
  targetIssue: null,
  analysis: null,
  version: 0,
  signature: "",
  lastUpdated: 0,
  anchorTime: 0,
  providerCountdown: null,
  error: null
};


/* =========================================================
   DATABASE
========================================================= */

async function initDatabase() {
  if (!process.env.DATABASE_URL) {
    console.log("DATABASE_URL is not configured");
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


/* =========================================================
   HTTP
========================================================= */

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
    let body = "";

    req.on("data", chunk => {
      body += chunk;
    });

    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
  });
}


/* =========================================================
   HELPERS
========================================================= */

function clean(value) {
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
  return side === "BIG" ? "SMALL" : "BIG";
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

function nextIssue(issue) {
  const value = clean(issue);

  const match =
    value.match(/^(.*?)(\d+)$/);

  if (!match) {
    return null;
  }

  try {
    return (
      match[1] +
      (
        BigInt(match[2]) + 1n
      )
        .toString()
        .padStart(
          match[2].length,
          "0"
        )
    );
  } catch {
    return null;
  }
}


/* =========================================================
   WINGOBOT
========================================================= */

async function fetchWingo() {
  if (!WINGOBOT_TOKEN) {
    throw new Error(
      "WINGOBOT_TOKEN is not configured"
    );
  }

  const response = await fetch(
    WINGOBOT_URL,
    {
      method: "GET",
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
      issueNumber: clean(
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
        row.premium ?? "",

      sum:
        row.sum ?? ""
    }))

    .filter(row =>
      row.issueNumber &&
      Number.isFinite(row.number)
    )

    .sort((a, b) =>
      compareIssues(
        b.issueNumber,
        a.issueNumber
      )
    );
}

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


/* =========================================================
   AI DATA
========================================================= */

function getSequence(history, limit = 100) {
  return history
    .slice(0, limit)
    .map(row =>
      classify(row.number)
    )
    .filter(Boolean);
}


/* =========================================================
   MODEL 1 - TRANSITION
========================================================= */

function transitionModel(sequence) {
  if (sequence.length < 15) {
    return null;
  }

  const current = sequence[0];

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
    if (sequence[i] !== current) {
      continue;
    }

    const next =
      sequence[i - 1];

    if (!next) {
      continue;
    }

    const weight =
      1 /
      (1 + i * 0.08);

    votes[next] += weight;

    matches++;
  }

  if (matches < 2) {
    return null;
  }

  const total =
    votes.BIG +
    votes.SMALL;

  return {
    name: "Transition",

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


/* =========================================================
   MODEL 2 - SEQUENCE
========================================================= */

function sequenceModel(sequence) {
  if (sequence.length < 20) {
    return null;
  }

  const votes = {
    BIG: 0,
    SMALL: 0
  };

  let matches = 0;

  for (const length of [3, 4, 5]) {
    const pattern =
      sequence
        .slice(0, length)
        .join("");

    for (
      let i = length + 1;
      i < sequence.length;
      i++
    ) {
      const oldPattern =
        sequence
          .slice(i, i + length)
          .join("");

      if (
        oldPattern !== pattern
      ) {
        continue;
      }

      const result =
        sequence[i - 1];

      if (!result) {
        continue;
      }

      const weight =
        1 /
        (1 + i * 0.08);

      votes[result] += weight;

      matches++;
    }
  }

  if (matches < 2) {
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


/* =========================================================
   MODEL 3 - RUN / REVERSAL
========================================================= */

function runModel(sequence) {
  if (sequence.length < 15) {
    return null;
  }

  let currentRun = 1;

  while (
    currentRun < sequence.length &&
    sequence[currentRun] === sequence[0]
  ) {
    currentRun++;
  }

  if (currentRun < 2) {
    return null;
  }

  const current =
    sequence[0];

  let matched = 0;
  let reversed = 0;

  for (
    let i = 1;
    i < sequence.length - 1;
    i++
  ) {
    if (sequence[i] !== current) {
      continue;
    }

    let length = 1;

    while (
      i + length < sequence.length &&
      sequence[i + length] === current
    ) {
      length++;
    }

    if (length === currentRun) {
      matched++;

      if (
        sequence[i - 1] !== current
      ) {
        reversed++;
      }
    }
  }

  if (matched < 2) {
    return null;
  }

  const reversalRate =
    reversed / matched;

  return {
    name: "Run/Reversal",

    side:
      reversalRate >= 0.60
        ? opposite(current)
        : current,

    strength:
      Math.abs(
        reversalRate - 0.50
      ) * 2,

    matches: matched
  };
}


/* =========================================================
   MODEL 4 - ALTERNATION
========================================================= */

function alternationModel(sequence) {
  if (sequence.length < 15) {
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

  if (rate < 0.70) {
    return null;
  }

  return {
    name: "Alternation",

    side:
      opposite(sequence[0]),

    strength: rate,

    matches: changes
  };
}


/* =========================================================
   MODEL 5 - RECENCY
========================================================= */

function recencyModel(sequence) {
  if (sequence.length < 15) {
    return null;
  }

  let bigScore = 0;
  let smallScore = 0;
  let used = 0;

  for (
    const size of [
      6,
      10,
      15,
      25,
      40
    ]
  ) {
    if (sequence.length < size) {
      continue;
    }

    let big = 0;
    let small = 0;

    sequence
      .slice(0, size)
      .forEach((side, index) => {

        const weight =
          1 /
          Math.sqrt(index + 1);

        if (side === "BIG") {
          big += weight;
        } else {
          small += weight;
        }
      });

    if (
      Math.abs(big - small) < 0.25
    ) {
      continue;
    }

    if (big > small) {
      bigScore +=
        big - small;
    } else {
      smallScore +=
        small - big;
    }

    used++;
  }

  if (!used) {
    return null;
  }

  const total =
    bigScore +
    smallScore;

  return {
    name: "Recency",

    side:
      bigScore >= smallScore
        ? "BIG"
        : "SMALL",

    strength:
      total
        ? Math.abs(
            bigScore -
            smallScore
          ) / total
        : 0,

    matches: used
  };
}


/* =========================================================
   ALL MODELS
========================================================= */

function generateModels(history) {
  const sequence =
    getSequence(
      history,
      100
    );

  return [
    transitionModel(sequence),
    sequenceModel(sequence),
    runModel(sequence),
    alternationModel(sequence),
    recencyModel(sequence)
  ].filter(Boolean);
}


/* =========================================================
   WALK-FORWARD BACKTEST
========================================================= */

function backtestModel(
  history,
  modelName
) {
  if (history.length < 35) {
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
      20,
      chronological.length - 60
    );

  for (
    let i = start;
    i < chronological.length;
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

    const model =
      generateModels(
        training
      ).find(
        x =>
          x.name === modelName
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
            (wins * 1000) /
            tested
          ) / 10
        : null
  };
}


/* =========================================================
   ADAPTIVE ENSEMBLE
========================================================= */

function adaptiveEnsemble(history) {
  const models =
    generateModels(history);

  if (!models.length) {
    return {
      prediction: null,
      confidence: 0,
      patternScore: 0,
      agreement: 0,
      backtestSamples: 0,
      avgModelAccuracy: null,
      status: "INSUFFICIENT DATA",
      models: []
    };
  }

  let bigVote = 0;
  let smallVote = 0;

  let totalSamples = 0;
  let accuracySum = 0;
  let accuracyCount = 0;

  const details = [];

  for (const model of models) {

    const test =
      backtestModel(
        history,
        model.name
      );

    let weight = 1;

    if (
      test.accuracy !== null &&
      test.tested >= 8
    ) {
      weight =
        0.75 +
        Math.max(
          0,
          test.accuracy - 50
        ) * 0.025;

      weight =
        Math.min(
          1.50,
          weight
        );

      totalSamples +=
        test.tested;

      accuracySum +=
        test.accuracy;

      accuracyCount++;
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
        0.60 +
        strength * 0.40
      );

    if (
      model.side === "BIG"
    ) {
      bigVote += vote;
    } else {
      smallVote += vote;
    }

    details.push({
      name: model.name,
      side: model.side,
      strength:
        Math.round(
          strength * 100
        ),
      weight:
        Math.round(
          weight * 100
        ) / 100,
      tested: test.tested,
      accuracy: test.accuracy
    });
  }

  const total =
    bigVote +
    smallVote;

  const prediction =
    bigVote >= smallVote
      ? "BIG"
      : "SMALL";

  const agreement =
    details.filter(
      model =>
        model.side === prediction
    ).length /
    details.length;

  const margin =
    total
      ? Math.abs(
          bigVote -
          smallVote
        ) / total
      : 0;

  const avgAccuracy =
    accuracyCount
      ? Math.round(
          (
            accuracySum /
            accuracyCount
          ) * 10
        ) / 10
      : null;

  let confidence =
    50 +
    margin * 22;

  if (avgAccuracy !== null) {
    confidence +=
      Math.max(
        0,
        avgAccuracy - 50
      ) * 0.30;
  }

  confidence +=
    Math.max(
      0,
      agreement - 0.50
    ) * 12;

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
    "LOW SIGNAL";

  if (
    agreement >= 0.60 &&
    margin >= 0.08 &&
    totalSamples >= 8
  ) {
    status =
      "ADAPTIVE SIGNAL";
  }

  if (
    agreement >= 0.75 &&
    margin >= 0.15 &&
    totalSamples >= 20 &&
    avgAccuracy !== null &&
    avgAccuracy >= 53
  ) {
    status =
      "STRONG STRUCTURAL SIGNAL";
  }

  if (totalSamples < 8) {
    confidence =
      Math.min(
        confidence,
        60
      );

    status =
      "LOW SIGNAL";
  }

  return {
    prediction,

    confidence,

    patternScore:
      Math.round(
        Math.max(
          45,
          Math.min(
            85,
            45 +
            margin * 30 +
            Math.max(
              0,
              agreement - 0.50
            ) * 20
          )
        )
      ),

    agreement:
      Math.round(
        agreement * 100
      ),

    backtestSamples:
      totalSamples,

    avgModelAccuracy:
      avgAccuracy,

    status,

    models: details
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
    ($1,$2,$3,$4,$5)
    ON CONFLICT(target_issue)
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


/* =========================================================
   SETTLE PREDICTION
========================================================= */

async function settlePrediction(row) {
  if (
    !process.env.DATABASE_URL ||
    !row?.issueNumber
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
    WHERE target_issue = $3
      AND result IS NULL
    `,
    [
      actual,
      Date.now(),
      row.issueNumber
    ]
  );
}


/* =========================================================
   LAST 30 WIN/LOSS
========================================================= */

async function getWinLoss() {
  if (!process.env.DATABASE_URL) {
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
      LIMIT 30
    `);

  const rows =
    result.rows;

  const win =
    rows.filter(
      row =>
        row.result === "WIN"
    ).length;

  const loss =
    rows.filter(
      row =>
        row.result === "LOSS"
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
              (win * 1000) /
              (win + loss)
            ) / 10
          : 0
    }
  };
}


/* =========================================================
   LIVE UPDATE
========================================================= */

async function updateCache() {
  try {
    const data =
      await fetchWingo();

    const history =
      normalizeHistory(data);

    if (!history.length) {
      throw new Error(
        "No history received from provider"
      );
    }

    const settledIssue =
      history[0].issueNumber;

    const providerCurrent =
      clean(
        data?.current?.issueNumber
      );

    let targetIssue = null;

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
        .slice(0, 10)
        .map(
          row =>
            `${row.issueNumber}:${row.number}`
        )
        .join("|");

    const changed =
      signature !==
      cache.signature;

    /*
      IMPORTANT:
      FULL history stays in backend.
      Frontend receives only 30.
    */

    cache.history =
      history;

    cache.settledIssue =
      settledIssue;

    cache.targetIssue =
      targetIssue;

    cache.providerCountdown =
      extractCountdown(data);

    cache.lastUpdated =
      Date.now();

    cache.error =
      null;

    if (changed) {

      cache.signature =
        signature;

      cache.version++;

      /*
        Settle exact period first.
      */

      await settlePrediction(
        history[0]
      );

      /*
        AI uses FULL provider history.
      */

      cache.analysis =
        adaptiveEnsemble(
          history
        );

      /*
        Save prediction for exact
        target issue.
      */

      await savePrediction(
        targetIssue,
        cache.analysis
      );

      cache.anchorTime =
        Date.now();

      console.log(
        "[NEW RESULT]",
        settledIssue,
        "TARGET:",
        targetIssue,
        "PREDICTION:",
        cache.analysis?.prediction,
        "CONF:",
        cache.analysis?.confidence
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


/* =========================================================
   TIMER
========================================================= */

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
    seconds =
      ROUND_SECONDS;
  }

  return {
    seconds,
    exact: false
  };
}


/* =========================================================
   ADMIN AUTH
========================================================= */

function isAdmin(req) {
  return (
    req.headers["x-admin-key"] ===
    ADMIN_KEY
  );
}


/* =========================================================
   API ROUTES
========================================================= */

async function handleAPI(
  req,
  res,
  url
) {

  /* HEALTH */

  if (
    url.pathname === "/health"
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
    url.pathname === "/api/state" &&
    req.method === "GET"
  ) {

    return sendJSON(
      res,
      200,
      {
        ok: true,

        /*
          Only latest 30 sent to browser.
        */

        history:
          cache.history.slice(
            0,
            LIVE_LIMIT
          ),

        settledIssue:
          cache.settledIssue,

        targetIssue:
          cache.targetIssue,

        historyVersion:
          cache.version,

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


  /* WIN/LOSS */

  if (
    url.pathname === "/api/history" &&
    req.method === "GET"
  ) {

    return sendJSON(
      res,
      200,
      await getWinLoss()
    );
  }


  /* ACCESS KEY */

  if (
    url.pathname === "/api/key/check" &&
    req.method === "POST"
  ) {

    const data =
      await readBody(req);

    const key =
      String(
        data.key ||
        data.access_key ||
        ""
      ).trim();

    const deviceId =
      String(
        req.headers["x-device-id"] ||
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
      row.device_id !== deviceId
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
     ADMIN
  ======================================================= */

  if (
    !url.pathname.startsWith(
      "/api/admin/"
    )
  ) {
    return null;
  }

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

        database:
          !!process.env.DATABASE_URL,

        provider:
          !!WINGOBOT_TOKEN,

        time:
          Date.now()
      }
    );
  }


  /* ADMIN STATUS */

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

        targetIssue:
          cache.targetIssue,

        analysis:
          cache.analysis
      }
    );
  }


  /* WINGO TEST */

  if (
    url.pathname ===
    "/api/admin/wingo-test"
  ) {

    try {

      const data =
        await fetchWingo();

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


  /* MODEL TEST */

  if (
    url.pathname ===
    "/api/admin/model-test"
  ) {

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
  }


  /* GET KEYS */

  if (
    url.pathname ===
    "/api/admin/keys" &&
    req.method === "GET"
  ) {

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


  /* CREATE KEYS */

  if (
    url.pathname ===
    "/api/admin/keys" &&
    req.method === "POST"
  ) {

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

      let created =
        false;

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

        if (result.rowCount) {
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
    req.method === "DELETE"
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


  /* RESET DEVICE */

  if (
    url.pathname ===
    "/api/admin/reset-device" &&
    req.method === "POST"
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
    !fs.existsSync(filePath)
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
    path.extname(
      filePath
    ).toLowerCase();

  const contentTypes = {
    ".html":
      "text/html; charset=utf-8",

    ".css":
      "text/css; charset=utf-8",

    ".js":
      "application/javascript; charset=utf-8",

    ".json":
      "application/json; charset=utf-8"
  };


  /* MP3 WITH RANGE SUPPORT */

  if (ext === ".mp3") {

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

        let end =
          match[2]
            ? Number(
                match[2]
              )
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
                end - start + 1
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
        contentTypes[ext] ||
        "application/octet-stream"
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
    async (req, res) => {

      try {

        const url =
          new URL(
            req.url,
            `http://${
              req.headers.host ||
              "localhost"
            }`
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


/* =========================================================
   START
========================================================= */

(async () => {

  try {

    await initDatabase();

    await updateCache();

    /*
      Live provider polling.
      Prediction changes only when
      settled history changes.
    */

    setInterval(
      updateCache,
      1000
    );

    server.listen(
      PORT,
      () => {
        console.log(
          `DY AI WINGO running on port ${PORT}`
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
