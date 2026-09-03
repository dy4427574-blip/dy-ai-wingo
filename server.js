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

const ADMIN_KEY =
  String(process.env.ADMIN_KEY || "dy4427574").trim();

const WINGOBOT_TOKEN =
  String(process.env.WINGOBOT_TOKEN || "").trim();

const WINGOBOT_URL =
  String(
    process.env.WINGOBOT_URL ||
      "https://api.wingobot.com/v2/30-sec-game-history"
  ).trim();

const ROUND_SECONDS = 30;

const LIVE_RESULTS_LIMIT = 30;
const WINLOSS_LIMIT = 30;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

/* =========================================================
   GLOBAL STATE
========================================================= */

const state = {
  ready: false,
  database: false,
  wingobot: false,

  history: [],
  analysis: null,

  settledIssue: null,
  targetIssue: null,

  providerCurrentIssue: null,
  providerCountdown: null,

  historySignature: "",
  lastHistoryUpdate: 0,

  timerAnchorMs: Date.now(),

  lastError: null
};

/* =========================================================
   RESPONSE HELPERS
========================================================= */

function now() {
  return Date.now();
}

function json(res, status, data) {
  const body = JSON.stringify(data);

  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    Pragma: "no-cache",
    "Access-Control-Allow-Origin": "*"
  });

  res.end(body);
}

function success(data = {}) {
  return {
    ok: true,
    success: true,
    ...data
  };
}

function failure(message, extra = {}) {
  return {
    ok: false,
    success: false,
    error: message,
    message,
    ...extra
  };
}

function text(res, status, body, contentType = "text/plain") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });

  res.end(body);
}

/* =========================================================
   BASIC HELPERS
========================================================= */

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function cleanIssue(value) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return null;
  }

  const s = String(value).trim();

  return s || null;
}

function issueNumeric(value) {
  const s = cleanIssue(value);

  if (!s) {
    return null;
  }

  const digits = s.replace(/\D/g, "");

  if (!digits) {
    return null;
  }

  try {
    return BigInt(digits);
  } catch {
    return null;
  }
}

function compareIssueDesc(a, b) {
  const aa = issueNumeric(a);
  const bb = issueNumeric(b);

  if (aa !== null && bb !== null) {
    if (aa > bb) return -1;
    if (aa < bb) return 1;
    return 0;
  }

  return String(b || "").localeCompare(
    String(a || ""),
    undefined,
    { numeric: true }
  );
}

function nextIssue(issue) {
  const n = issueNumeric(issue);

  if (n === null) {
    return null;
  }

  return String(n + 1n);
}

function getNumber(row) {
  const candidates = [
    row?.number,
    row?.num,
    row?.result,
    row?.winningNumber,
    row?.winning_number
  ];

  for (const value of candidates) {
    const n = safeNumber(value);

    if (
      n !== null &&
      Number.isInteger(n) &&
      n >= 0 &&
      n <= 9
    ) {
      return n;
    }
  }

  return null;
}

function sideFromNumber(n) {
  if (
    n === null ||
    n === undefined
  ) {
    return null;
  }

  return Number(n) >= 5
    ? "BIG"
    : "SMALL";
}

function normalizeSide(value, number) {
  if (
    value !== undefined &&
    value !== null
  ) {
    const s =
      String(value)
        .trim()
        .toUpperCase();

    if (s.includes("BIG")) {
      return "BIG";
    }

    if (s.includes("SMALL")) {
      return "SMALL";
    }
  }

  return sideFromNumber(number);
}

/* =========================================================
   READ BODY
========================================================= */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk;

      if (body.length > 1024 * 1024) {
        reject(
          new Error("Request body too large")
        );

        req.destroy();
      }
    });

    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        resolve({});
      }
    });

    req.on("error", reject);
  });
}

/* =========================================================
   ADMIN AUTH
========================================================= */

function getAdminKey(req) {
  const headerKey =
    req.headers["x-admin-key"];

  const authorization =
    req.headers["authorization"];

  const value =
    headerKey ||
    authorization ||
    "";

  return String(value)
    .replace(/^Bearer\s+/i, "")
    .trim();
}

function adminAuthorized(req) {
  const supplied =
    getAdminKey(req);

  return Boolean(
    supplied &&
    ADMIN_KEY &&
    supplied === ADMIN_KEY
  );
}

function requireAdmin(req, res) {
  if (!adminAuthorized(req)) {
    json(
      res,
      401,
      failure("Invalid admin key.")
    );

    return false;
  }

  return true;
}

/* =========================================================
   DATABASE SETUP
========================================================= */

async function ensureDatabase() {
  if (!process.env.DATABASE_URL) {
    console.log(
      "DATABASE_URL not configured."
    );

    state.database = false;
    return;
  }

  const client =
    await pool.connect();

  try {
    /* -----------------------------------------
       ACCESS KEYS
    ----------------------------------------- */

    await client.query(`
      CREATE TABLE IF NOT EXISTS access_keys (
        id SERIAL PRIMARY KEY,
        access_key TEXT UNIQUE NOT NULL,
        device_id TEXT,
        created_at BIGINT NOT NULL,
        last_seen BIGINT DEFAULT 0
      )
    `);

    /* -----------------------------------------
       PREDICTIONS BASE TABLE
    ----------------------------------------- */

    await client.query(`
      CREATE TABLE IF NOT EXISTS predictions (
        id SERIAL PRIMARY KEY,
        target_issue TEXT,
        issue_number TEXT,
        prediction TEXT,
        predicted_number INTEGER,
        confidence NUMERIC DEFAULT 0,
        created_at BIGINT NOT NULL,
        actual_number INTEGER,
        actual_side TEXT,
        outcome TEXT,
        pattern_score NUMERIC DEFAULT 0,
        agreement NUMERIC DEFAULT 0,
        model_accuracy NUMERIC DEFAULT 0,
        backtest_samples INTEGER DEFAULT 0
      )
    `);

    /*
      IMPORTANT:
      Tumhare purane DB me issue_number NOT NULL ho sakta hai.
      Isliye dono columns ko maintain karenge.
    */

    const columns = [
      ["target_issue", "TEXT"],
      ["issue_number", "TEXT"],
      ["prediction", "TEXT"],
      ["predicted_number", "INTEGER"],
      ["confidence", "NUMERIC DEFAULT 0"],
      ["created_at", "BIGINT DEFAULT 0"],
      ["actual_number", "INTEGER"],
      ["actual_side", "TEXT"],
      ["outcome", "TEXT"],
      ["pattern_score", "NUMERIC DEFAULT 0"],
      ["agreement", "NUMERIC DEFAULT 0"],
      ["model_accuracy", "NUMERIC DEFAULT 0"],
      ["backtest_samples", "INTEGER DEFAULT 0"]
    ];

    for (
      const [name, definition]
      of columns
    ) {
      await client.query(`
        ALTER TABLE predictions
        ADD COLUMN IF NOT EXISTS ${name} ${definition}
      `);
    }

    /*
      OLD ROW MIGRATION:
      target_issue <-> issue_number sync.
    */

    await client.query(`
      UPDATE predictions
      SET target_issue = issue_number
      WHERE
        target_issue IS NULL
        AND issue_number IS NOT NULL
    `);

    await client.query(`
      UPDATE predictions
      SET issue_number = target_issue
      WHERE
        issue_number IS NULL
        AND target_issue IS NOT NULL
    `);

    /*
      If old issue_number is NOT NULL,
      every new insert below provides it.
    */

    await client.query(`
      CREATE INDEX IF NOT EXISTS
      idx_predictions_target_issue
      ON predictions(target_issue)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS
      idx_predictions_issue_number
      ON predictions(issue_number)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS
      idx_predictions_created_at
      ON predictions(created_at DESC)
    `);

    state.database = true;

    console.log(
      "DATABASE READY"
    );
  } finally {
    client.release();
  }
}

/* =========================================================
   WINGOBOT FETCH
========================================================= */

async function fetchWingo() {
  if (!WINGOBOT_TOKEN) {
    throw new Error(
      "WINGOBOT_TOKEN is not configured."
    );
  }

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      12000
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

    const raw =
      await response.text();

    let data = {};

    try {
      data =
        raw
          ? JSON.parse(raw)
          : {};
    } catch {
      throw new Error(
        "WingoBot returned invalid JSON."
      );
    }

    if (!response.ok) {
      throw new Error(
        `WingoBot HTTP ${response.status}: ` +
        `${data?.message || raw.slice(0, 200)}`
      );
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

/* =========================================================
   NORMALIZE HISTORY
========================================================= */

function normalizeHistory(data) {
  let rows = [];

  if (
    Array.isArray(
      data?.history
    )
  ) {
    rows =
      data.history;
  } else if (
    Array.isArray(
      data?.data?.history
    )
  ) {
    rows =
      data.data.history;
  } else if (
    Array.isArray(
      data?.data
    )
  ) {
    rows =
      data.data;
  } else if (
    Array.isArray(
      data?.results
    )
  ) {
    rows =
      data.results;
  } else if (
    Array.isArray(
      data?.records
    )
  ) {
    rows =
      data.records;
  }

  const normalized = [];

  for (const row of rows) {
    if (
      !row ||
      typeof row !== "object"
    ) {
      continue;
    }

    const issue =
      cleanIssue(
        row.issueNumber ??
        row.issue_number ??
        row.period ??
        row.issue ??
        row.id
      );

    const number =
      getNumber(row);

    if (
      !issue ||
      number === null
    ) {
      continue;
    }

    normalized.push({
      issueNumber: issue,

      number,

      side:
        normalizeSide(
          row.colour ??
          row.color ??
          row.side ??
          row.bigSmall ??
          row.big_small,

          number
        ),

      colour:
        row.colour ??
        row.color ??
        null,

      premium:
        row.premium ??
        null,

      sum:
        row.sum ??
        null
    });
  }

  /*
    Remove duplicate issue numbers.
  */

  const map =
    new Map();

  for (
    const row
    of normalized
  ) {
    if (
      !map.has(
        row.issueNumber
      )
    ) {
      map.set(
        row.issueNumber,
        row
      );
    }
  }

  return Array.from(
    map.values()
  ).sort(
    (a, b) =>
      compareIssueDesc(
        a.issueNumber,
        b.issueNumber
      )
  );
}

/* =========================================================
   CURRENT ISSUE
========================================================= */

function extractCurrentIssue(data) {
  return cleanIssue(
    data?.current?.issueNumber ??
    data?.current?.issue_number ??
    data?.current?.period ??
    data?.currentIssue ??
    data?.current_issue ??
    null
  );
}

/* =========================================================
   COUNTDOWN
========================================================= */

function extractCountdown(data) {
  const candidates = [
    data?.countdown,
    data?.countdownSeconds,
    data?.countdown_seconds,
    data?.current?.countdown,
    data?.current?.countdownSeconds,
    data?.current?.countdown_seconds,
    data?.timer,
    data?.remaining
  ];

  for (
    const value
    of candidates
  ) {
    const n =
      Number(value);

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
   TIMER
========================================================= */

function updateTimerAnchor() {
  state.timerAnchorMs =
    now();
}

function getEstimatedCountdown() {
  if (
    state.providerCountdown !== null &&
    Number.isFinite(
      state.providerCountdown
    )
  ) {
    const elapsed =
      Math.floor(
        (
          now() -
          state.timerAnchorMs
        ) / 1000
      );

    const value =
      state.providerCountdown -
      elapsed;

    if (
      value >= 0 &&
      value <= 30
    ) {
      return value;
    }
  }

  const elapsed =
    Math.floor(
      (
        now() -
        state.timerAnchorMs
      ) / 1000
    );

  let value =
    ROUND_SECONDS -
    (
      elapsed %
      ROUND_SECONDS
    );

  if (value <= 0) {
    value = 30;
  }

  return value;
}

/* =========================================================
   DATA HELPERS
========================================================= */

function getSequence(history) {
  return history
    .map(
      row => row.side
    )
    .filter(
      side =>
        side === "BIG" ||
        side === "SMALL"
    );
}

function getNumbers(history) {
  return history
    .map(
      row => row.number
    )
    .filter(
      n =>
        Number.isInteger(n) &&
        n >= 0 &&
        n <= 9
    );
}

/* =========================================================
   TRANSITION MODEL
========================================================= */

function transitionModel(history) {
  const seq =
    getSequence(history);

  if (
    seq.length < 10
  ) {
    return null;
  }

  let bigAfterBig = 0;
  let bigAfterSmall = 0;
  let smallAfterBig = 0;
  let smallAfterSmall = 0;

  for (
    let i = 0;
    i < seq.length - 1;
    i++
  ) {
    const current =
      seq[i + 1];

    const next =
      seq[i];

    if (
      current === "BIG" &&
      next === "BIG"
    ) {
      bigAfterBig++;
    }

    if (
      current === "BIG" &&
      next === "SMALL"
    ) {
      smallAfterBig++;
    }

    if (
      current === "SMALL" &&
      next === "BIG"
    ) {
      bigAfterSmall++;
    }

    if (
      current === "SMALL" &&
      next === "SMALL"
    ) {
      smallAfterSmall++;
    }
  }

  const last =
    seq[0];

  let bigRate;
  let smallRate;

  if (
    last === "BIG"
  ) {
    const total =
      bigAfterBig +
      smallAfterBig;

    if (!total) {
      return null;
    }

    bigRate =
      bigAfterBig /
      total;

    smallRate =
      smallAfterBig /
      total;
  } else {
    const total =
      bigAfterSmall +
      smallAfterSmall;

    if (!total) {
      return null;
    }

    bigRate =
      bigAfterSmall /
      total;

    smallRate =
      smallAfterSmall /
      total;
  }

  return {
    name:
      "Transition Model",

    side:
      bigRate >= smallRate
        ? "BIG"
        : "SMALL",

    strength:
      Math.round(
        Math.max(
          bigRate,
          smallRate
        ) * 100
      ),

    sample:
      Math.max(
        bigAfterBig +
        smallAfterBig +
        bigAfterSmall +
        smallAfterSmall,
        1
      )
  };
}

/* =========================================================
   SEQUENCE MODEL
========================================================= */

function sequenceModel(history) {
  const seq =
    getSequence(history);

  if (
    seq.length < 12
  ) {
    return null;
  }

  const windows =
    [3, 4, 5];

  const votes = {
    BIG: 0,
    SMALL: 0
  };

  let totalWeight = 0;

  for (
    const size
    of windows
  ) {
    if (
      seq.length <= size
    ) {
      continue;
    }

    const pattern =
      seq
        .slice(0, size)
        .join(",");

    let matches = 0;
    let big = 0;
    let small = 0;

    for (
      let i = size;
      i < seq.length;
      i++
    ) {
      const previous =
        seq
          .slice(
            i - size,
            i
          )
          .join(",");

      if (
        previous !==
        pattern
      ) {
        continue;
      }

      matches++;

      if (
        seq[i] === "BIG"
      ) {
        big++;
      } else {
        small++;
      }
    }

    if (
      !matches
    ) {
      continue;
    }

    const side =
      big >= small
        ? "BIG"
        : "SMALL";

    const rate =
      Math.max(
        big,
        small
      ) / matches;

    const weight =
      size *
      Math.log2(
        matches + 1
      );

    votes[side] +=
      rate * weight;

    totalWeight +=
      weight;
  }

  if (
    !totalWeight
  ) {
    return null;
  }

  const side =
    votes.BIG >=
    votes.SMALL
      ? "BIG"
      : "SMALL";

  const totalVotes =
    votes.BIG +
    votes.SMALL;

  return {
    name:
      "Pattern Sequence",

    side,

    strength:
      Math.round(
        (
          Math.max(
            votes.BIG,
            votes.SMALL
          ) /
          Math.max(
            totalVotes,
            1
          )
        ) * 100
      ),

    sample:
      Math.round(
        totalWeight
      )
  };
}

/* =========================================================
   RECENCY MODEL
========================================================= */

function recencyModel(history) {
  const seq =
    getSequence(history);

  if (
    seq.length < 8
  ) {
    return null;
  }

  const windows = [
    {
      size: 5,
      weight: 1.8
    },
    {
      size: 10,
      weight: 1.4
    },
    {
      size: 20,
      weight: 1.0
    },
    {
      size: 50,
      weight: 0.7
    },
    {
      size: 100,
      weight: 0.45
    }
  ];

  let big = 0;
  let small = 0;

  for (
    const window
    of windows
  ) {
    const slice =
      seq.slice(
        0,
        Math.min(
          window.size,
          seq.length
        )
      );

    if (
      !slice.length
    ) {
      continue;
    }

    let b = 0;
    let s = 0;

    for (
      const side
      of slice
    ) {
      if (
        side === "BIG"
      ) {
        b++;
      } else {
        s++;
      }
    }

    const total =
      b + s;

    big +=
      (
        b / total
      ) *
      window.weight;

    small +=
      (
        s / total
      ) *
      window.weight;
  }

  const side =
    big >= small
      ? "BIG"
      : "SMALL";

  const total =
    big + small;

  return {
    name:
      "Recency Model",

    side,

    strength:
      Math.round(
        Math.max(
          big,
          small
        ) /
        Math.max(
          total,
          1
        ) *
        100
      ),

    sample:
      seq.length
  };
}

/* =========================================================
   ALTERNATION MODEL
========================================================= */

function alternationModel(history) {
  const seq =
    getSequence(history);

  if (
    seq.length < 8
  ) {
    return null;
  }

  const recent =
    seq.slice(
      0,
      12
    );

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

  const alternationRate =
    changes /
    Math.max(
      recent.length - 1,
      1
    );

  const last =
    recent[0];

  let side;

  if (
    alternationRate >= 0.62
  ) {
    side =
      last === "BIG"
        ? "SMALL"
        : "BIG";
  } else {
    const big =
      recent.filter(
        x => x === "BIG"
      ).length;

    const small =
      recent.length -
      big;

    side =
      big >= small
        ? "BIG"
        : "SMALL";
  }

  return {
    name:
      "Alternation Model",

    side,

    strength:
      Math.round(
        Math.max(
          alternationRate,
          1 -
          alternationRate
        ) * 100
      ),

    sample:
      recent.length
  };
}

/* =========================================================
   NUMBER STRUCTURE
========================================================= */

function numberStructureModel(history) {
  const nums =
    getNumbers(history);

  if (
    nums.length < 12
  ) {
    return null;
  }

  const recent =
    nums.slice(
      0,
      Math.min(
        30,
        nums.length
      )
    );

  let big = 0;
  let small = 0;

  for (
    const n
    of recent
  ) {
    if (n >= 5) {
      big++;
    } else {
      small++;
    }
  }

  const side =
    big >= small
      ? "BIG"
      : "SMALL";

  return {
    name:
      "Number Structure",

    side,

    strength:
      Math.round(
        Math.max(
          big,
          small
        ) /
        Math.max(
          recent.length,
          1
        ) *
        100
      ),

    sample:
      recent.length
  };
}

/* =========================================================
   LONG HISTORY
========================================================= */

function longHistoryModel(history) {
  const seq =
    getSequence(history);

  if (
    seq.length < 30
  ) {
    return null;
  }

  let big = 0;
  let small = 0;

  /*
    ALL returned API history is used.
  */

  for (
    let i = 0;
    i < seq.length;
    i++
  ) {
    const weight =
      1 /
      Math.sqrt(
        i + 1
      );

    if (
      seq[i] === "BIG"
    ) {
      big += weight;
    } else {
      small += weight;
    }
  }

  const side =
    big >= small
      ? "BIG"
      : "SMALL";

  const total =
    big + small;

  return {
    name:
      "Long History",

    side,

    strength:
      Math.round(
        Math.max(
          big,
          small
        ) /
        Math.max(
          total,
          1
        ) * 100
      ),

    sample:
      seq.length
  };
}

/* =========================================================
   HISTORICAL PATTERN
========================================================= */

function historicalPatternModel(history) {
  const seq =
    getSequence(history);

  if (
    seq.length < 20
  ) {
    return null;
  }

  const patternLength = 4;

  const pattern =
    seq
      .slice(
        0,
        patternLength
      )
      .join(",");

  let matches = 0;
  let big = 0;
  let small = 0;

  for (
    let i = patternLength;
    i < seq.length;
    i++
  ) {
    const previous =
      seq
        .slice(
          i -
            patternLength,
          i
        )
        .join(",");

    if (
      previous !==
      pattern
    ) {
      continue;
    }

    matches++;

    if (
      seq[i] === "BIG"
    ) {
      big++;
    } else {
      small++;
    }
  }

  if (
    matches < 2
  ) {
    return null;
  }

  const side =
    big >= small
      ? "BIG"
      : "SMALL";

  return {
    name:
      "Historical Pattern",

    side,

    strength:
      Math.round(
        Math.max(
          big,
          small
        ) /
        matches *
        100
      ),

    sample:
      matches
  };
}

/* =========================================================
   MODEL GENERATOR
========================================================= */

function generateModels(history) {
  const models = [];

  const candidates = [
    transitionModel(history),
    sequenceModel(history),
    recencyModel(history),
    alternationModel(history),
    numberStructureModel(history),
    longHistoryModel(history),
    historicalPatternModel(history)
  ];

  for (
    const model
    of candidates
  ) {
    if (
      model &&
      (
        model.side === "BIG" ||
        model.side === "SMALL"
      )
    ) {
      models.push(model);
    }
  }

  if (
    models.length === 0 &&
    history.length >= 2
  ) {
    const recent =
      getSequence(history);

    if (
      recent.length
    ) {
      const big =
        recent.filter(
          x => x === "BIG"
        ).length;

      const small =
        recent.length -
        big;

      models.push({
        name:
          "Adaptive Fallback",

        side:
          big >= small
            ? "BIG"
            : "SMALL",

        strength:
          Math.round(
            Math.max(
              big,
              small
            ) /
            recent.length *
            100
          ),

        sample:
          recent.length
      });
    }
  }

  return models;
}

/* =========================================================
   SINGLE PREDICTION
========================================================= */

function predictSide(history) {
  const models =
    generateModels(history);

  if (
    !models.length
  ) {
    return {
      side: null,
      confidence: 0,
      agreement: 0,
      patternScore: 0,
      models: []
    };
  }

  const votes = {
    BIG: 0,
    SMALL: 0
  };

  let totalWeight = 0;

  for (
    const model
    of models
  ) {
    const sampleFactor =
      Math.min(
        1.5,
        0.55 +
        Math.log10(
          Math.max(
            model.sample || 1,
            1
          )
        ) * 0.25
      );

    const strengthFactor =
      Math.max(
        0.35,
        Math.min(
          1.15,
          (
            model.strength ||
            50
          ) / 100
        )
      );

    const weight =
      sampleFactor *
      strengthFactor;

    votes[
      model.side
    ] += weight;

    totalWeight +=
      weight;
  }

  const side =
    votes.BIG >=
    votes.SMALL
      ? "BIG"
      : "SMALL";

  const winningVote =
    Math.max(
      votes.BIG,
      votes.SMALL
    );

  const agreement =
    totalWeight > 0
      ? Math.round(
          winningVote /
          totalWeight *
          100
        )
      : 0;

  const averageStrength =
    models.reduce(
      (sum, model) =>
        sum +
        Number(
          model.strength ||
          0
        ),
      0
    ) /
    models.length;

  const patternScore =
    Math.round(
      averageStrength *
      0.55 +
      agreement *
      0.45
    );

  let confidence =
    Math.round(
      agreement *
      0.55 +
      averageStrength *
      0.45
    );

  /*
    Conservative when history is limited.
  */

  if (
    history.length < 30
  ) {
    confidence =
      Math.min(
        confidence,
        60
      );
  }

  confidence =
    Math.max(
      50,
      Math.min(
        confidence,
        78
      )
    );

  return {
    side,
    confidence,
    agreement,
    patternScore,
    models
  };
}

/* =========================================================
   FAST WALK FORWARD BACKTEST
========================================================= */

function backtest(history) {
  if (
    history.length < 35
  ) {
    return {
      samples: 0,
      accuracy: null,
      wins: 0,
      losses: 0
    };
  }

  const chronological =
    [...history].reverse();

  const maxTests = 200;

  const start =
    Math.max(
      15,
      chronological.length -
      maxTests
    );

  let tested = 0;
  let correct = 0;

  for (
    let i = start;
    i < chronological.length;
    i++
  ) {
    const training =
      chronological.slice(
        0,
        i
      );

    if (
      training.length < 15
    ) {
      continue;
    }

    const actual =
      chronological[i]?.side;

    if (
      actual !== "BIG" &&
      actual !== "SMALL"
    ) {
      continue;
    }

    const result =
      predictSide(training);

    if (
      !result.side
    ) {
      continue;
    }

    tested++;

    if (
      result.side === actual
    ) {
      correct++;
    }
  }

  if (
    !tested
  ) {
    return {
      samples: 0,
      accuracy: null,
      wins: 0,
      losses: 0
    };
  }

  return {
    samples: tested,

    wins:
      correct,

    losses:
      tested -
      correct,

    accuracy:
      Math.round(
        correct /
        tested *
        100
      )
  };
}

/* =========================================================
   ADAPTIVE ENSEMBLE
========================================================= */

function adaptiveEnsemble(history) {
  const prediction =
    predictSide(history);

  const validation =
    backtest(history);

  let confidence =
    prediction.confidence;

  if (
    validation.samples >= 20 &&
    validation.accuracy !== null
  ) {
    confidence =
      Math.round(
        confidence * 0.60 +
        validation.accuracy * 0.40
      );
  } else {
    confidence =
      Math.min(
        confidence,
        60
      );
  }

  confidence =
    Math.max(
      50,
      Math.min(
        confidence,
        78
      )
    );

  let status;

  if (
    validation.samples < 20
  ) {
    status =
      "EARLY SIGNAL";
  } else if (
    confidence >= 70
  ) {
    status =
      "STRONGER SIGNAL";
  } else if (
    confidence >= 62
  ) {
    status =
      "MODERATE SIGNAL";
  } else {
    status =
      "WEAK SIGNAL";
  }

  return {
    prediction:
      prediction.side ||
      "WAIT",

    predictedNumber:
      chooseNumber(
        history,
        prediction.side
      ),

    confidence,

    agreement:
      prediction.agreement,

    patternScore:
      prediction.patternScore,

    status,

    avgModelAccuracy:
      validation.accuracy,

    backtestSamples:
      validation.samples,

    backtestWins:
      validation.wins,

    backtestLosses:
      validation.losses,

    models:
      prediction.models.map(
        model => ({
          name:
            model.name,

          side:
            model.side,

          accuracy:
            null,

          weight:
            Number(
              model.sample ||
              0
            ),

          strength:
            model.strength,

          tested:
            model.sample
        })
      )
  };
}

/* =========================================================
   NUMBER CHOICE
========================================================= */

function chooseNumber(
  history,
  side
) {
  if (
    side !== "BIG" &&
    side !== "SMALL"
  ) {
    return null;
  }

  const nums =
    getNumbers(history);

  if (
    !nums.length
  ) {
    return null;
  }

  const allowed =
    side === "BIG"
      ? [5, 6, 7, 8, 9]
      : [0, 1, 2, 3, 4];

  const frequency =
    new Map();

  for (
    const n
    of allowed
  ) {
    frequency.set(
      n,
      0
    );
  }

  /*
    Recent history has higher weight.
  */

  nums
    .slice(
      0,
      Math.min(
        100,
        nums.length
      )
    )
    .forEach(
      (n, index) => {
        if (
          !frequency.has(n)
        ) {
          return;
        }

        const weight =
          1 /
          Math.sqrt(
            index + 1
          );

        frequency.set(
          n,
          frequency.get(n) +
          weight
        );
      }
    );

  let best =
    allowed[0];

  let bestScore =
    -Infinity;

  for (
    const n
    of allowed
  ) {
    const score =
      frequency.get(n) ||
      0;

    if (
      score > bestScore
    ) {
      bestScore =
        score;

      best =
        n;
    }
  }

  return best;
}

/* =========================================================
   SAVE PREDICTION
========================================================= */

async function savePrediction(
  targetIssue,
  analysis
) {
  const issue =
    cleanIssue(
      targetIssue
    );

  if (!issue) {
    console.log(
      "SAVE PREDICTION SKIPPED: target issue missing"
    );

    return false;
  }

  if (!analysis) {
    return false;
  }

  try {
    /*
      IMPORTANT:
      Both target_issue AND old issue_number
      are supplied.

      This fixes:
      column "issue_number" does not exist /
      NOT NULL errors from older DB schemas.
    */

    await pool.query(
      `
      INSERT INTO predictions
      (
        target_issue,
        issue_number,
        prediction,
        predicted_number,
        confidence,
        created_at,
        actual_number,
        actual_side,
        outcome,
        pattern_score,
        agreement,
        model_accuracy,
        backtest_samples
      )
      VALUES
      (
        $1,
        $1,
        $2,
        $3,
        $4,
        $5,
        NULL,
        NULL,
        NULL,
        $6,
        $7,
        $8,
        $9
      )
      `,
      [
        issue,

        analysis.prediction ||
          null,

        analysis.predictedNumber,

        analysis.confidence ||
          0,

        now(),

        analysis.patternScore ||
          0,

        analysis.agreement ||
          0,

        analysis.avgModelAccuracy ??
          0,

        analysis.backtestSamples ||
          0
      ]
    );

    console.log(
      "PREDICTION SAVED:",
      issue
    );

    return true;
  } catch (error) {
    console.error(
      "SAVE PREDICTION ERROR:",
      error.message
    );

    return false;
  }
}

/* =========================================================
   SETTLE PREDICTIONS
========================================================= */

async function settlePredictions(
  history
) {
  if (
    !state.database ||
    !Array.isArray(history)
  ) {
    return;
  }

  for (
    const result
    of history.slice(
      0,
      100
    )
  ) {
    const issue =
      cleanIssue(
        result.issueNumber
      );

    const number =
      getNumber(result);

    const actualSide =
      normalizeSide(
        result.side,
        number
      );

    if (
      !issue ||
      number === null ||
      !actualSide
    ) {
      continue;
    }

    try {
      const resultDb =
        await pool.query(
          `
          SELECT
            id,
            target_issue,
            issue_number,
            prediction,
            outcome
          FROM predictions
          WHERE
            target_issue = $1
            OR issue_number = $1
          ORDER BY id DESC
          LIMIT 1
          `,
          [issue]
        );

      if (
        !resultDb.rows.length
      ) {
        continue;
      }

      const prediction =
        resultDb.rows[0];

      if (
        prediction.outcome ===
          "WIN" ||
        prediction.outcome ===
          "LOSS"
      ) {
        continue;
      }

      const predicted =
        String(
          prediction.prediction ||
          ""
        ).toUpperCase();

      if (
        predicted !== "BIG" &&
        predicted !== "SMALL"
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
        UPDATE predictions
        SET
          actual_number = $1,
          actual_side = $2,
          outcome = $3
        WHERE id = $4
        `,
        [
          number,
          actualSide,
          outcome,
          prediction.id
        ]
      );

      console.log(
        "SETTLED:",
        issue,
        outcome
      );
    } catch (error) {
      console.error(
        "SETTLE ERROR:",
        error.message
      );
    }
  }
}

/* =========================================================
   W/L HISTORY
========================================================= */

async function getWinLossHistory() {
  if (
    !state.database
  ) {
    return {
      rows: [],
      stats: {
        win: 0,
        loss: 0,
        rate: 0
      }
    };
  }

  try {
    const result =
      await pool.query(`
        SELECT *
        FROM predictions
        ORDER BY
          created_at DESC NULLS LAST,
          id DESC
        LIMIT 500
      `);

    const rows =
      result.rows.map(
        row => {
          const prediction =
            String(
              row.prediction ??
              row.predicted_side ??
              row.side ??
              ""
            ).toUpperCase();

          const actualNumber =
            row.actual_number ??
            row.result_number ??
            row.resultNumber ??
            null;

          let actualSide =
            row.actual_side ??
            row.result_side ??
            row.resultSide ??
            null;

          if (
            !actualSide
          ) {
            actualSide =
              normalizeSide(
                null,
                safeNumber(
                  actualNumber
                )
              );
          }

          let outcome =
            row.outcome ??
            row.result ??
            row.status ??
            null;

          if (
            outcome
          ) {
            const o =
              String(
                outcome
              ).toUpperCase();

            if (
              o === "WIN" ||
              o === "LOSS"
            ) {
              outcome = o;
            } else {
              outcome = null;
            }
          }

          if (
            !outcome &&
            (
              prediction ===
                "BIG" ||
              prediction ===
                "SMALL"
            ) &&
            actualSide
          ) {
            outcome =
              prediction ===
              actualSide
                ? "WIN"
                : "LOSS";
          }

          return {
            id:
              row.id,

            target_issue:
              cleanIssue(
                row.target_issue ??
                row.issue_number ??
                row.period ??
                row.issue
              ),

            number:
              safeNumber(
                actualNumber
              ),

            prediction:
              prediction ===
                "BIG" ||
              prediction ===
                "SMALL"
                ? prediction
                : null,

            outcome:
              outcome ===
                "WIN" ||
              outcome ===
                "LOSS"
                ? outcome
                : null,

            confidence:
              safeNumber(
                row.confidence
              ),

            created_at:
              safeNumber(
                row.created_at
              )
          };
        }
      );

    const settled =
      rows.filter(
        row =>
          row.outcome ===
            "WIN" ||
          row.outcome ===
            "LOSS"
      );

    /*
      Performance is based on latest 30
      settled predictions.
    */

    const recent =
      settled.slice(
        0,
        WINLOSS_LIMIT
      );

    const wins =
      recent.filter(
        row =>
          row.outcome ===
          "WIN"
      ).length;

    const losses =
      recent.filter(
        row =>
          row.outcome ===
          "LOSS"
      ).length;

    const total =
      wins + losses;

    return {
      rows: recent,

      stats: {
        win: wins,
        loss: losses,

        rate:
          total
            ? Math.round(
                wins /
                total *
                100
              )
            : 0
      }
    };
  } catch (error) {
    console.error(
      "W/L HISTORY ERROR:",
      error.message
    );

    return {
      rows: [],
      stats: {
        win: 0,
        loss: 0,
        rate: 0
      }
    };
  }
}

/* =========================================================
   COMBINED LIVE + W/L
========================================================= */

async function getCombinedResults() {
  const live =
    state.history.slice(
      0,
      LIVE_RESULTS_LIMIT
    );

  const wl =
    await getWinLossHistory();

  const predictionMap =
    new Map();

  for (
    const row
    of wl.rows
  ) {
    if (
      row.target_issue &&
      !predictionMap.has(
        row.target_issue
      )
    ) {
      predictionMap.set(
        row.target_issue,
        row
      );
    }
  }

  return live.map(
    result => {
      const issue =
        cleanIssue(
          result.issueNumber
        );

      const matched =
        predictionMap.get(
          issue
        );

      return {
        issueNumber:
          issue,

        number:
          result.number,

        side:
          result.side,

        prediction:
          matched?.prediction ||
          null,

        outcome:
          matched?.outcome ||
          null
      };
    }
  );
}

/* =========================================================
   LIVE UPDATE
========================================================= */

let updateRunning = false;

async function updateLiveState() {
  if (
    updateRunning
  ) {
    return;
  }

  updateRunning = true;

  try {
    const data =
      await fetchWingo();

    const history =
      normalizeHistory(data);

    if (
      !history.length
    ) {
      throw new Error(
        "WingoBot returned no valid history."
      );
    }

    const currentIssue =
      extractCurrentIssue(
        data
      );

    const providerCountdown =
      extractCountdown(
        data
      );

    state.providerCurrentIssue =
      currentIssue;

    state.providerCountdown =
      providerCountdown;

    const settled =
      history[0];

    const settledIssue =
      cleanIssue(
        settled.issueNumber
      );

    if (
      !settledIssue
    ) {
      throw new Error(
        "Latest settled issue is missing."
      );
    }

    let targetIssue =
      nextIssue(
        settledIssue
      );

    const currentNum =
      issueNumeric(
        currentIssue
      );

    const settledNum =
      issueNumeric(
        settledIssue
      );

    if (
      currentNum !== null &&
      settledNum !== null &&
      currentNum > settledNum
    ) {
      targetIssue =
        currentIssue;
    }

    if (
      !targetIssue
    ) {
      targetIssue =
        nextIssue(
          settledIssue
        );
    }

    if (
      !targetIssue
    ) {
      throw new Error(
        "Unable to determine target issue."
      );
    }

    const signature =
      history
        .slice(
          0,
          20
        )
        .map(
          row =>
            `${row.issueNumber}:${row.number}`
        )
        .join("|");

    const changed =
      signature !==
      state.historySignature;

    state.history =
      history;

    state.settledIssue =
      settledIssue;

    state.targetIssue =
      targetIssue;

    state.lastHistoryUpdate =
      now();

    state.wingobot =
      true;

    if (
      providerCountdown !== null
    ) {
      updateTimerAnchor();
    }

    /*
      IMPORTANT:
      Prediction changes only when actual
      history changes / target changes.
    */

    if (
      changed ||
      !state.analysis ||
      state.analysis.targetIssue !==
        targetIssue
    ) {
      /*
        First settle previous predictions.
      */

      await settlePredictions(
        history
      );

      /*
        FULL API HISTORY goes into AI.
        UI is only limited to 30.
      */

      const analysis =
        adaptiveEnsemble(
          history
        );

      analysis.targetIssue =
        targetIssue;

      analysis.settledIssue =
        settledIssue;

      state.analysis =
        analysis;

      await savePrediction(
        targetIssue,
        analysis
      );

      state.historySignature =
        signature;

      console.log(
        "======================================"
      );

      console.log(
        "WINGO UPDATE"
      );

      console.log(
        "SETTLED:",
        settledIssue
      );

      console.log(
        "TARGET:",
        targetIssue
      );

      console.log(
        "PREDICTION:",
        analysis.prediction
      );

      console.log(
        "CONFIDENCE:",
        analysis.confidence + "%"
      );

      console.log(
        "HISTORY USED:",
        history.length
      );

      console.log(
        "======================================"
      );
    }

    state.ready = true;
    state.lastError = null;

  } catch (error) {
    state.wingobot = false;

    state.lastError =
      error.message;

    console.error(
      "WINGO UPDATE ERROR:",
      error.message
    );
  } finally {
    updateRunning = false;
  }
}

/* =========================================================
   API: KEY CHECK
========================================================= */

async function keyCheck(
  req,
  res
) {
  const body =
    await readBody(req);

  const key =
    String(
      body.key ??
      body.access_key ??
      ""
    ).trim();

  const deviceId =
    String(
      body.device_id ??
      ""
    ).trim();

  if (!key) {
    json(
      res,
      400,
      failure(
        "Access key required."
      )
    );

    return;
  }

  if (
    !state.database
  ) {
    json(
      res,
      503,
      failure(
        "Database unavailable."
      )
    );

    return;
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
      json(
        res,
        401,
        failure(
          "Invalid access key."
        )
      );

      return;
    }

    const row =
      result.rows[0];

    if (
      row.device_id &&
      deviceId &&
      row.device_id !==
        deviceId
    ) {
      json(
        res,
        403,
        failure(
          "This key is already bound to another device."
        )
      );

      return;
    }

    if (
      !row.device_id &&
      deviceId
    ) {
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
          now(),
          row.id
        ]
      );
    } else {
      await pool.query(
        `
        UPDATE access_keys
        SET
          last_seen = $1
        WHERE id = $2
        `,
        [
          now(),
          row.id
        ]
      );
    }

    json(
      res,
      200,
      success({
        message:
          "Access granted.",
        access: true
      })
    );

  } catch (error) {
    json(
      res,
      500,
      failure(
        error.message
      )
    );
  }
}

/* =========================================================
   API: STATE
========================================================= */

async function stateApi(
  req,
  res
) {
  const combined =
    await getCombinedResults();

  const winLoss =
    await getWinLossHistory();

  json(
    res,
    200,
    success({
      ready:
        state.ready,

      settledIssue:
        state.settledIssue,

      targetIssue:
        state.targetIssue,

      providerCurrentIssue:
        state.providerCurrentIssue,

      countdown:
        getEstimatedCountdown(),

      providerCountdown:
        state.providerCountdown,

      analysis:
        state.analysis,

      history:
        state.history.slice(
          0,
          LIVE_RESULTS_LIMIT
        ),

      historyCount:
        state.history.length,

      results:
        combined,

      winLoss,

      lastUpdated:
        state.lastHistoryUpdate,

      error:
        state.lastError
    })
  );
}

/* =========================================================
   API: HISTORY
========================================================= */

async function historyApi(
  req,
  res
) {
  const data =
    await getWinLossHistory();

  json(
    res,
    200,
    success({
      rows:
        data.rows.slice(
          0,
          WINLOSS_LIMIT
        ),

      wins:
        data.stats.win,

      losses:
        data.stats.loss,

      rate:
        data.stats.rate,

      stats:
        data.stats
    })
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
    !requireAdmin(req, res)
  ) {
    return;
  }

  json(
    res,
    200,
    success({
      message:
        "Admin authentication successful.",

      time:
        now()
    })
  );
}

/* =========================================================
   ADMIN STATUS
========================================================= */

async function adminStatus(
  req,
  res
) {
  if (
    !requireAdmin(req, res)
  ) {
    return;
  }

  json(
    res,
    200,
    success({
      server: true,

      database:
        state.database,

      wingobot:
        state.wingobot,

      providerFetched:
        state.history.length,

      historyLength:
        state.history.length,

      targetIssue:
        state.targetIssue,

      settledIssue:
        state.settledIssue,

      lastUpdated:
        state.lastHistoryUpdate,

      countdown:
        getEstimatedCountdown(),

      modelVersion:
        "ADAPTIVE-PRO",

      error:
        state.lastError
    })
  );
}

/* =========================================================
   ADMIN KEYS GET
========================================================= */

async function adminKeysGet(
  req,
  res
) {
  if (
    !requireAdmin(req, res)
  ) {
    return;
  }

  if (
    !state.database
  ) {
    json(
      res,
      503,
      failure(
        "Database unavailable."
      )
    );

    return;
  }

  try {
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

    json(
      res,
      200,
      success({
        keys:
          result.rows
      })
    );

  } catch (error) {
    json(
      res,
      500,
      failure(
        error.message
      )
    );
  }
}

/* =========================================================
   GENERATE KEY
========================================================= */

function generateAccessKey() {
  const random =
    crypto
      .randomBytes(8)
      .toString("hex")
      .toUpperCase();

  return `DYAI-${random}`;
}

/* =========================================================
   ADMIN KEYS CREATE
========================================================= */

async function adminKeysCreate(
  req,
  res
) {
  if (
    !requireAdmin(req, res)
  ) {
    return;
  }

  if (
    !state.database
  ) {
    json(
      res,
      503,
      failure(
        "Database unavailable."
      )
    );

    return;
  }

  const body =
    await readBody(req);

  let count =
    Number(
      body.count || 1
    );

  count =
    Math.max(
      1,
      Math.min(
        100,
        Math.floor(count)
      )
    );

  const keys = [];

  try {
    for (
      let i = 0;
      i < count;
      i++
    ) {
      let key =
        generateAccessKey();

      let inserted =
        false;

      for (
        let attempt = 0;
        attempt < 10;
        attempt++
      ) {
        try {
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
            ($1, NULL, $2, 0)
            `,
            [
              key,
              now()
            ]
          );

          inserted = true;
          break;

        } catch (error) {
          if (
            error.code ===
            "23505"
          ) {
            key =
              generateAccessKey();

            continue;
          }

          throw error;
        }
      }

      if (
        inserted
      ) {
        keys.push(key);
      }
    }

    json(
      res,
      200,
      success({
        keys,

        /*
          Admin HTML compatibility:
          It expects data.key for one-key creation.
        */

        key:
          keys.length === 1
            ? keys[0]
            : null
      })
    );

  } catch (error) {
    json(
      res,
      500,
      failure(
        error.message
      )
    );
  }
}

/* =========================================================
   ADMIN DELETE KEY
========================================================= */

async function adminKeysDelete(
  req,
  res
) {
  if (
    !requireAdmin(req, res)
  ) {
    return;
  }

  if (
    !state.database
  ) {
    json(
      res,
      503,
      failure(
        "Database unavailable."
      )
    );

    return;
  }

  const body =
    await readBody(req);

  const id =
    Number(
      body.id
    );

  if (
    !Number.isInteger(id)
  ) {
    json(
      res,
      400,
      failure(
        "Invalid key ID."
      )
    );

    return;
  }

  try {
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
      success()
    );

  } catch (error) {
    json(
      res,
      500,
      failure(
        error.message
      )
    );
  }
}

/* =========================================================
   ADMIN RESET DEVICE
========================================================= */

async function adminResetDevice(
  req,
  res
) {
  if (
    !requireAdmin(req, res)
  ) {
    return;
  }

  if (
    !state.database
  ) {
    json(
      res,
      503,
      failure(
        "Database unavailable."
      )
    );

    return;
  }

  const body =
    await readBody(req);

  const id =
    Number(
      body.id
    );

  if (
    !Number.isInteger(id)
  ) {
    json(
      res,
      400,
      failure(
        "Invalid key ID."
      )
    );

    return;
  }

  try {
    await pool.query(
      `
      UPDATE access_keys
      SET
        device_id = NULL,
        last_seen = 0
      WHERE id = $1
      `,
      [id]
    );

    json(
      res,
      200,
      success()
    );

  } catch (error) {
    json(
      res,
      500,
      failure(
        error.message
      )
    );
  }
}

/* =========================================================
   ADMIN WINGOBOT TEST
========================================================= */

async function adminWingoTest(
  req,
  res
) {
  if (
    !requireAdmin(req, res)
  ) {
    return;
  }

  try {
    const data =
      await fetchWingo();

    const history =
      normalizeHistory(
        data
      );

    const fetched =
      data?.stats?.fetched ??
      history.length;

    json(
      res,
      200,
      success({
        current:
          extractCurrentIssue(
            data
          ),

        countdown:
          extractCountdown(
            data
          ),

        fetched,

        last_updated:
          data?.stats?.last_updated ??
          null,

        /*
          Both names for compatibility.
        */

        historyCount:
          history.length,

        historyLength:
          history.length,

        latest:
          history.slice(
            0,
            10
          )
      })
    );

  } catch (error) {
    json(
      res,
      500,
      failure(
        error.message
      )
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
    !requireAdmin(req, res)
  ) {
    return;
  }

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
      json(
        res,
        200,
        failure(
          "No usable history."
        )
      );

      return;
    }

    const analysis =
      adaptiveEnsemble(
        history
      );

    /*
      Admin HTML expects data.analysis.
      We provide both nested and top-level.
    */

    json(
      res,
      200,
      success({
        history:
          history.length,

        analysis,

        prediction:
          analysis.prediction,

        predictedNumber:
          analysis.predictedNumber,

        confidence:
          analysis.confidence,

        patternScore:
          analysis.patternScore,

        agreement:
          analysis.agreement,

        avgModelAccuracy:
          analysis.avgModelAccuracy,

        backtestSamples:
          analysis.backtestSamples,

        status:
          analysis.status,

        models:
          analysis.models
      })
    );

  } catch (error) {
    json(
      res,
      500,
      failure(
        error.message
      )
    );
  }
}

/* =========================================================
   STATIC FILE SERVER
========================================================= */

function getMime(filePath) {
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

    ".png":
      "image/png",

    ".jpg":
      "image/jpeg",

    ".jpeg":
      "image/jpeg",

    ".gif":
      "image/gif",

    ".svg":
      "image/svg+xml",

    ".ico":
      "image/x-icon",

    ".mp3":
      "audio/mpeg",

    ".wav":
      "audio/wav",

    ".webp":
      "image/webp"
  };

  return (
    types[ext] ||
    "application/octet-stream"
  );
}

/* =========================================================
   FILE SERVER + MP3 RANGE
========================================================= */

function serveFile(
  req,
  res,
  filePath
) {
  if (
    !fs.existsSync(
      filePath
    )
  ) {
    text(
      res,
      404,
      "Not Found"
    );

    return;
  }

  const stat =
    fs.statSync(
      filePath
    );

  const size =
    stat.size;

  const mime =
    getMime(
      filePath
    );

  const range =
    req.headers.range;

  if (
    range &&
    range.startsWith(
      "bytes="
    )
  ) {
    const parts =
      range
        .replace(
          "bytes=",
          ""
        )
        .split("-");

    const start =
      parseInt(
        parts[0],
        10
      );

    const end =
      parts[1]
        ? parseInt(
            parts[1],
            10
          )
        : size - 1;

    if (
      Number.isNaN(start) ||
      start < 0 ||
      start >= size
    ) {
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

    const safeEnd =
      Math.min(
        end,
        size - 1
      );

    const chunkSize =
      safeEnd -
      start +
      1;

    res.writeHead(
      206,
      {
        "Content-Type":
          mime,

        "Content-Length":
          chunkSize,

        "Content-Range":
          `bytes ${start}-${safeEnd}/${size}`,

        "Accept-Ranges":
          "bytes",

        "Cache-Control":
          "public, max-age=3600"
      }
    );

    fs.createReadStream(
      filePath,
      {
        start,
        end: safeEnd
      }
    ).pipe(res);

    return;
  }

  res.writeHead(
    200,
    {
      "Content-Type":
        mime,

      "Content-Length":
        size,

      "Accept-Ranges":
        "bytes",

      "Cache-Control":
        "public, max-age=3600"
    }
  );

  fs.createReadStream(
    filePath
  ).pipe(res);
}

/* =========================================================
   ROUTER
========================================================= */

async function router(
  req,
  res
) {
  const url =
    new URL(
      req.url,
      `http://${req.headers.host || "localhost"}`
    );

  const pathname =
    url.pathname;

  /* OPTIONS */

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
          "Content-Type, x-admin-key, Authorization",

        "Access-Control-Allow-Methods":
          "GET, POST, DELETE, OPTIONS"
      }
    );

    res.end();

    return;
  }

  /* HEALTH */

  if (
    pathname ===
    "/health"
  ) {
    json(
      res,
      200,
      success({
        status:
          "healthy",

        database:
          state.database,

        wingobot:
          state.wingobot,

        uptime:
          process.uptime()
      })
    );

    return;
  }

  /* KEY CHECK */

  if (
    pathname ===
      "/api/key/check" &&
    req.method ===
      "POST"
  ) {
    await keyCheck(
      req,
      res
    );

    return;
  }

  /* STATE */

  if (
    pathname ===
      "/api/state" &&
    req.method ===
      "GET"
  ) {
    await stateApi(
      req,
      res
    );

    return;
  }

  /* HISTORY */

  if (
    pathname ===
      "/api/history" &&
    req.method ===
      "GET"
  ) {
    await historyApi(
      req,
      res
    );

    return;
  }

  /* ADMIN PING */

  if (
    pathname ===
      "/api/admin/ping" &&
    req.method ===
      "GET"
  ) {
    await adminPing(
      req,
      res
    );

    return;
  }

  /* ADMIN STATUS */

  if (
    pathname ===
      "/api/admin/status" &&
    req.method ===
      "GET"
  ) {
    await adminStatus(
      req,
      res
    );

    return;
  }

  /* ADMIN KEYS GET */

  if (
    pathname ===
      "/api/admin/keys" &&
    req.method ===
      "GET"
  ) {
    await adminKeysGet(
      req,
      res
    );

    return;
  }

  /* ADMIN KEYS CREATE */

  if (
    pathname ===
      "/api/admin/keys" &&
    req.method ===
      "POST"
  ) {
    await adminKeysCreate(
      req,
      res
    );

    return;
  }

  /* ADMIN KEYS DELETE */

  if (
    pathname ===
      "/api/admin/keys" &&
    req.method ===
      "DELETE"
  ) {
    await adminKeysDelete(
      req,
      res
    );

    return;
  }

  /* RESET DEVICE */

  if (
    pathname ===
      "/api/admin/reset-device" &&
    req.method ===
      "POST"
  ) {
    await adminResetDevice(
      req,
      res
    );

    return;
  }

  /* WINGOBOT TEST */

  if (
    pathname ===
      "/api/admin/wingo-test" &&
    req.method ===
      "GET"
  ) {
    await adminWingoTest(
      req,
      res
    );

    return;
  }

  /* MODEL TEST */

  if (
    pathname ===
      "/api/admin/model-test" &&
    req.method ===
      "GET"
  ) {
    await adminModelTest(
      req,
      res
    );

    return;
  }

  /* STATIC */

  let requested =
    decodeURIComponent(
      pathname
    );

  if (
    requested === "/" ||
    requested === ""
  ) {
    requested =
      "/prediction.html";
  }

  requested =
    requested.replace(
      /\.\./g,
      ""
    );

  const filePath =
    path.join(
      __dirname,
      requested
    );

  if (
    fs.existsSync(
      filePath
    ) &&
    fs.statSync(
      filePath
    ).isFile()
  ) {
    serveFile(
      req,
      res,
      filePath
    );

    return;
  }

  if (
    requested ===
    "/admin"
  ) {
    const adminPath =
      path.join(
        __dirname,
        "admin.html"
      );

    serveFile(
      req,
      res,
      adminPath
    );

    return;
  }

  text(
    res,
    404,
    "Not Found"
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
        await router(
          req,
          res
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
            failure(
              "Internal server error."
            )
          );
        } else {
          res.end();
        }
      }
    }
  );

/* =========================================================
   STARTUP
========================================================= */

async function start() {
  console.log(
    "======================================"
  );

  console.log(
    "DY AI WINGO 30S SERVER STARTING"
  );

  console.log(
    "======================================"
  );

  try {
    await ensureDatabase();
  } catch (error) {
    state.database =
      false;

    console.error(
      "DATABASE STARTUP ERROR:",
      error.message
    );
  }

  server.listen(
    PORT,
    "0.0.0.0",
    () => {
      console.log(
        `SERVER LISTENING ON PORT ${PORT}`
      );

      console.log(
        "ADMIN KEY:",
        ADMIN_KEY
          ? "CONFIGURED"
          : "MISSING"
      );

      console.log(
        "WINGOBOT TOKEN:",
        WINGOBOT_TOKEN
          ? "CONFIGURED"
          : "MISSING"
      );

      /*
        First update immediately.
      */

      updateLiveState();

      /*
        Refresh provider every 3 seconds.
      */

      setInterval(
        () => {
          updateLiveState();
        },
        3000
      );
    }
  );
}

/* =========================================================
   SHUTDOWN
========================================================= */

async function shutdown(
  signal
) {
  console.log(
    `${signal} received. Shutting down...`
  );

  try {
    await pool.end();
  } catch {}

  server.close(
    () => {
      process.exit(0);
    }
  );

  setTimeout(
    () => {
      process.exit(0);
    },
    5000
  );
}

process.on(
  "SIGTERM",
  () =>
    shutdown(
      "SIGTERM"
    )
);

process.on(
  "SIGINT",
  () =>
    shutdown(
      "SIGINT"
    )
);

process.on(
  "unhandledRejection",
  error => {
    console.error(
      "UNHANDLED REJECTION:",
      error
    );
  }
);

process.on(
  "uncaughtException",
  error => {
    console.error(
      "UNCAUGHT EXCEPTION:",
      error
    );
  }
);

/* =========================================================
   RUN
========================================================= */

start();
