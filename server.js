const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 10000);

const ADMIN_KEY =
  process.env.ADMIN_KEY ||
  "change-this-admin-key";

const WINGOBOT_TOKEN =
  process.env.WINGOBOT_TOKEN || "";

const WINGOBOT_URL =
  "https://api.wingobot.com/v2/30-sec-game-history";

const ROUND_SECONDS = 30;

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
   DATABASE
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
   RESPONSE
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
   BIG / SMALL
===================================================== */

function classify(number) {

  const n = Number(number);

  if (!Number.isFinite(n)) {
    return null;
  }

  return n >= 5
    ? "BIG"
    : "SMALL";
}


/* =====================================================
   ISSUE HELPERS
===================================================== */

function cleanIssue(value) {

  return String(
    value || ""
  ).trim();

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

  const match =
    s.match(/^(.*?)(\d+)$/);

  if (!match) {
    return null;
  }

  const prefix = match[1];
  const digits = match[2];

  try {

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


/* =====================================================
   NORMALIZE HISTORY
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

      issueNumber:
        cleanIssue(
          row.issueNumber ??
          row.issue ??
          row.period
        ),

      number:
        Number(row.number),

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
   WEIGHTED VOTE
===================================================== */

function weightedVote(signals) {

  let big = 0;
  let small = 0;

  for (const signal of signals) {

    const weight =
      Number(signal.weight) || 0;

    if (signal.side === "BIG") {
      big += weight;
    }

    if (signal.side === "SMALL") {
      small += weight;
    }

  }

  return {
    big,
    small
  };

}


/* =====================================================
   EXACT PATTERN
===================================================== */

function exactPattern(sequence, length) {

  if (
    sequence.length <
    length + 2
  ) {
    return null;
  }

  const current =
    sequence
      .slice(0, length)
      .join("");

  const signals = [];

  for (
    let i = length + 1;
    i < sequence.length;
    i++
  ) {

    const old =
      sequence
        .slice(i, i + length)
        .join("");

    if (old !== current) {
      continue;
    }

    signals.push({

      side:
        sequence[i - 1],

      weight:
        1 /
        (
          1 +
          i * 0.07
        )

    });

  }

  if (!signals.length) {
    return null;
  }

  const vote =
    weightedVote(signals);

  return {

    side:
      vote.big >= vote.small
        ? "BIG"
        : "SMALL",

    matches:
      signals.length,

    weight:
      Math.min(
        1.6,
        vote.big +
        vote.small
      ),

    type:
      "exact"

  };

}


/* =====================================================
   SIMILAR PATTERN
===================================================== */

function similarPattern(sequence, length) {

  if (
    sequence.length <
    length + 2
  ) {
    return null;
  }

  const current =
    sequence.slice(0, length);

  const maxDistance =
    length <= 5
      ? 1
      : 2;

  const signals = [];

  for (
    let i = length + 1;
    i < sequence.length;
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
        current[j] !==
        old[j]
      ) {

        distance++;

      }

    }

    if (
      distance >
      maxDistance
    ) {
      continue;
    }

    const similarity =
      1 -
      distance / length;

    signals.push({

      side:
        sequence[i - 1],

      weight:
        similarity *
        0.5 /
        (
          1 +
          i * 0.08
        )

    });

  }

  if (!signals.length) {
    return null;
  }

  const vote =
    weightedVote(signals);

  return {

    side:
      vote.big >= vote.small
        ? "BIG"
        : "SMALL",

    matches:
      signals.length,

    weight:
      Math.min(
        1.3,
        vote.big +
        vote.small
      ),

    type:
      "similar"

  };

}


/* =====================================================
   TRANSITION
===================================================== */

function transitionSignal(sequence) {

  if (sequence.length < 8) {
    return null;
  }

  const current =
    sequence[0];

  const signals = [];

  for (
    let i = 1;
    i < sequence.length - 1;
    i++
  ) {

    if (
      sequence[i] ===
      current
    ) {

      signals.push({

        side:
          sequence[i - 1],

        weight:
          0.8 /
          (
            1 +
            i * 0.06
          )

      });

    }

  }

  if (!signals.length) {
    return null;
  }

  const vote =
    weightedVote(signals);

  return {

    side:
      vote.big >= vote.small
        ? "BIG"
        : "SMALL",

    matches:
      signals.length,

    weight:
      Math.min(
        1.2,
        vote.big +
        vote.small
      ),

    type:
      "transition"

  };

}


/* =====================================================
   RUN
===================================================== */

function runSignal(sequence) {

  if (sequence.length < 8) {
    return null;
  }

  let currentRun = 1;

  while (
    currentRun <
      sequence.length &&
    sequence[currentRun] ===
      sequence[0]
  ) {

    currentRun++;

  }

  const signals = [];

  for (
    let i = currentRun + 1;
    i < sequence.length;
    i++
  ) {

    let run = 1;

    while (
      i + run <
        sequence.length &&
      sequence[i + run] ===
        sequence[i]
    ) {

      run++;

    }

    if (run === currentRun) {

      signals.push({

        side:
          sequence[i - 1],

        weight:
          0.75 /
          (
            1 +
            i * 0.07
          )

      });

    }

  }

  if (!signals.length) {
    return null;
  }

  const vote =
    weightedVote(signals);

  return {

    side:
      vote.big >= vote.small
        ? "BIG"
        : "SMALL",

    matches:
      signals.length,

    weight:
      Math.min(
        1,
        vote.big +
        vote.small
      ),

    type:
      "run"

  };

}


/* =====================================================
   ALTERNATION
===================================================== */

function alternationSignal(sequence) {

  if (sequence.length < 7) {
    return null;
  }

  for (
    let i = 0;
    i < 6;
    i++
  ) {

    if (
      sequence[i] ===
      sequence[i + 1]
    ) {

      return null;

    }

  }

  return {

    side:
      sequence[0] === "BIG"
        ? "SMALL"
        : "BIG",

    matches: 1,

    weight: 0.35,

    type:
      "alternation"

  };

}


/* =====================================================
   ANALYSIS
===================================================== */

function analyze(history) {

  const sequence =
    history
      .slice(0, 60)
      .map(row =>
        classify(row.number)
      )
      .filter(Boolean);

  if (sequence.length < 8) {

    return {

      prediction:
        sequence[0] === "BIG"
          ? "SMALL"
          : "BIG",

      confidence: 51,

      patternScore: 50,

      status:
        "LOW SIGNAL",

      agreement: 0,

      evidence: 0,

      matches: {

        exact: 0,
        similar: 0,
        transition: 0,
        runs: 0

      }

    };

  }

  const signals = [];

  for (
    const length of
    [2, 3, 4, 5, 6, 8]
  ) {

    const exact =
      exactPattern(
        sequence,
        length
      );

    if (exact) {

      exact.weight *=
        length >= 4
          ? 1.25
          : 0.9;

      signals.push(exact);

    }

    const similar =
      similarPattern(
        sequence,
        length
      );

    if (similar) {
      signals.push(similar);
    }

  }

  const transition =
    transitionSignal(sequence);

  if (transition) {
    signals.push(transition);
  }

  const run =
    runSignal(sequence);

  if (run) {
    signals.push(run);
  }

  const alternating =
    alternationSignal(sequence);

  if (alternating) {
    signals.push(alternating);
  }

  const vote =
    weightedVote(signals);

  const total =
    vote.big +
    vote.small;

  const prediction =
    vote.big >= vote.small
      ? "BIG"
      : "SMALL";

  const margin =
    total
      ? Math.abs(
          vote.big -
          vote.small
        ) / total
      : 0;

  const sides =
    signals.map(
      x => x.side
    );

  const agreement =
    sides.length
      ? Math.max(

          sides.filter(
            x => x === "BIG"
          ).length,

          sides.filter(
            x => x === "SMALL"
          ).length

        ) / sides.length
      : 0;

  let confidence =
    Math.round(

      51 +
      margin * 18 +
      Math.max(
        0,
        agreement - 0.5
      ) * 18

    );

  confidence =
    Math.max(
      51,
      Math.min(
        72,
        confidence
      )
    );

  if (
    agreement < 0.55 ||
    margin < 0.08
  ) {

    confidence =
      Math.min(
        confidence,
        56
      );

  }

  const exactMatches =
    signals
      .filter(
        x => x.type === "exact"
      )
      .reduce(
        (total, x) =>
          total + x.matches,
        0
      );

  const similarMatches =
    signals
      .filter(
        x => x.type === "similar"
      )
      .reduce(
        (total, x) =>
          total + x.matches,
        0
      );

  const transitionMatches =
    signals
      .filter(
        x => x.type === "transition"
      )
      .reduce(
        (total, x) =>
          total + x.matches,
        0
      );

  const runMatches =
    signals
      .filter(
        x => x.type === "run"
      )
      .reduce(
        (total, x) =>
          total + x.matches,
        0
      );

  const patternScore =
    Math.max(

      50,

      Math.min(

        90,

        Math.round(

          50 +
          margin * 35 +
          Math.max(
            0,
            agreement - 0.5
          ) * 25

        )

      )

    );

  return {

    prediction,

    confidence,

    patternScore,

    status:
      agreement >= 0.65 &&
      margin >= 0.12
        ? "NORMAL SIGNAL"
        : "LOW SIGNAL",

    agreement:
      Math.round(
        agreement * 100
      ),

    evidence:
      signals.length,

    matches: {

      exact:
        exactMatches,

      similar:
        similarMatches,

      transition:
        transitionMatches,

      runs:
        runMatches

    },

    sequence:
      sequence.slice(0, 12)

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
        row.result !== first
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
      normalizeHistory(data);

    if (!history.length) {

      throw new Error(
        "No history received"
      );

    }

    const settledIssue =
      history[0].issueNumber;

    const providerCurrent =
      cleanIssue(
        data?.current?.issueNumber
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
      extractCountdown(data);

    cache.lastUpdated =
      Date.now();

    cache.error = null;

    if (changed) {

      cache.historySignature =
        signature;

      cache.historyVersion++;

      cache.analysis =
        analyze(history);

      cache.anchorTime =
        Date.now();

      await settlePrediction(
        history[0]
      );

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


  /* HISTORY */

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


  /* =================================================
     ACCESS KEY CHECK
     FIXED:
     accepts both access_key and key
  ================================================= */

  if (
    url.pathname ===
      "/api/key/check" &&
    req.method ===
      "POST"
  ) {

    const data =
      await readBody(req);


    /*
      IMPORTANT FIX
    */

    const key =
      String(
        data.access_key ||
        data.key ||
        ""
      ).trim();


    const device =
      String(
        req.headers["x-device-id"] ||
        data.device_id ||
        ""
      ).trim();


    if (!key) {

      return sendJSON(
        res,
        400,
        {
          ok: false,
          error:
            "Access key is required"
        }
      );

    }


    if (!device) {

      return sendJSON(
        res,
        400,
        {
          ok: false,
          error:
            "Device ID is required"
        }
      );

    }


    if (
      !process.env.DATABASE_URL
    ) {

      return sendJSON(
        res,
        503,
        {
          ok: false,
          error:
            "Database not configured"
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
          error:
            "Invalid access key"
        }
      );

    }


    const row =
      result.rows[0];


    /*
      If key is already bound,
      only same device can use it.
    */

    if (
      row.device_id &&
      row.device_id !== device
    ) {

      return sendJSON(
        res,
        403,
        {
          ok: false,
          error:
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
          "Access granted",

        access_key:
          row.access_key

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

    const admin =
      req.headers[
        "x-admin-key"
      ];


    if (
      admin !==
      ADMIN_KEY
    ) {

      return sendJSON(
        res,
        401,
        {
          ok: false,
          error:
            "Unauthorized"
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
            !!WINGOBOT_TOKEN

        }
      );

    }


    /* PING */

    if (
      url.pathname ===
      "/api/admin/ping"
    ) {

      return sendJSON(
        res,
        200,
        {
          ok: true,
          message:
            "Admin API online",
          time:
            Date.now()
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

            currentIssue:
              data?.current
                ?.issueNumber ||
              null,

            history:
              normalizeHistory(
                data
              ).slice(0, 5)

          }
        );

      } catch (error) {

        return sendJSON(
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


    /* CREATE KEY */

    if (
      url.pathname ===
        "/api/admin/keys" &&
      req.method ===
        "POST"
    ) {

      const data =
        await readBody(req);


      /*
        Custom key supported.
        If no custom key, random key.
      */

      const customKey =
        String(
          data.access_key ||
          data.key ||
          ""
        ).trim();


      if (customKey) {

        if (
          customKey.length < 4 ||
          customKey.length > 100
        ) {

          return sendJSON(
            res,
            400,
            {
              ok: false,
              error:
                "Invalid custom key"
            }
          );

        }


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

            RETURNING
              access_key
            `,
            [
              customKey,
              Date.now()
            ]
          );


        if (!result.rowCount) {

          return sendJSON(
            res,
            409,
            {
              ok: false,
              error:
                "Key already exists"
            }
          );

        }


        return sendJSON(
          res,
          200,
          {

            ok: true,

            access_key:
              customKey,

            keys: [
              customKey
            ]

          }
        );

      }


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
              (
                $1,
                $2
              )

              ON CONFLICT
              DO NOTHING

              RETURNING
                access_key
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

      const id =
        url.searchParams.get(
          "id"
        );


      const body =
        await readBody(req);


      const finalId =
        id ||
        body.id;


      if (!finalId) {

        return sendJSON(
          res,
          400,
          {
            ok: false,
            error:
              "Key ID required"
          }
        );

      }


      await pool.query(
        `
        DELETE FROM access_keys
        WHERE id = $1
        `,
        [finalId]
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
        await readBody(req);


      if (!data.id) {

        return sendJSON(
          res,
          400,
          {
            ok: false,
            error:
              "Key ID required"
          }
        );

      }


      await pool.query(
        `
        UPDATE access_keys

        SET
          device_id = NULL,
          last_seen = 0

        WHERE id = $1
        `,
        [data.id]
      );


      return sendJSON(
        res,
        200,
        {
          ok: true,
          message:
            "Device binding reset"
        }
      );

    }

  }


  return null;

}


/* =====================================================
   STATIC FILE SERVER
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
        error:
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
      "application/json; charset=utf-8"

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
          Number(match[1]);


        const end =
          match[2]
            ? Number(match[2])
            : stat.size - 1;


        if (
          start <
          stat.size &&
          end <
          stat.size
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
          "Server error:",
          error
        );


        sendJSON(
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
  );


/* =====================================================
   START
===================================================== */

(async () => {

  try {

    await initDatabase();

    await updateCache();


    setInterval(
      updateCache,
      1000
    );


    server.listen(
      PORT,
      () => {

        console.log(
          `DY AI server running on port ${PORT}`
        );

      }
    );

  } catch (error) {

    console.error(
      "Startup error:",
      error
    );

    process.exit(1);

  }

})();
