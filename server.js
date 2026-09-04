const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL || "";
const WINGOBOT_TOKEN = process.env.WINGOBOT_TOKEN || "";
const ADMIN_KEY = process.env.ADMIN_KEY || "";

const MODEL_VERSION = "DY-AI-BS-V8";

const GAME_URL =
  "https://www.shreewin38.com/#/register?invitationCode=88523152383";

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes("localhost")
        ? false
        : { rejectUnauthorized: false }
    })
  : null;

let provider = {
  history: [],
  currentIssue: null,
  lastUpdated: 0,
  fetched: 0,
  error: null
};

let lastPrediction = null;


/* =========================
   BASIC
========================= */

function now() {
  return Date.now();
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);

  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });

  res.end(body);
}

function sendText(res, status, text, type = "text/plain") {
  res.writeHead(status, {
    "Content-Type": `${type}; charset=utf-8`,
    "Cache-Control": "no-store"
  });

  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk;

      if (body.length > 1024 * 1024) {
        reject(new Error("Request too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!body) return resolve({});

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });

    req.on("error", reject);
  });
}

function adminAuth(req) {
  const key =
    req.headers["x-admin-key"] ||
    String(req.headers.authorization || "")
      .replace(/^Bearer\s+/i, "");

  return !!ADMIN_KEY && key === ADMIN_KEY;
}

function requireAdmin(req, res) {
  if (!adminAuth(req)) {
    sendJson(res, 401, {
      ok: false,
      error: "Unauthorized"
    });
    return false;
  }

  return true;
}


/* =========================
   ISSUE
========================= */

function incrementIssue(issue) {
  try {
    return (BigInt(issue) + 1n).toString();
  } catch {
    return null;
  }
}

function resolveTargetIssue() {
  const history = provider.history;

  if (!history.length) {
    return provider.currentIssue;
  }

  const latest = history[0].issueNumber;

  if (!provider.currentIssue) {
    return incrementIssue(latest);
  }

  try {
    const current = BigInt(provider.currentIssue);
    const latestBig = BigInt(latest);

    if (current > latestBig) {
      return current.toString();
    }

    return (latestBig + 1n).toString();
  } catch {
    return provider.currentIssue;
  }
}


/* =========================
   NORMALIZE API DATA
========================= */

function normalizeSide(row) {
  const direct = String(
    row.result ||
    row.bigSmall ||
    row.big_small ||
    row.side ||
    row.colour ||
    row.color ||
    ""
  )
    .trim()
    .toUpperCase();

  if (
    direct === "BIG" ||
    direct === "B"
  ) {
    return "BIG";
  }

  if (
    direct === "SMALL" ||
    direct === "S"
  ) {
    return "SMALL";
  }

  const number = Number(row.number);

  if (
    Number.isInteger(number) &&
    number >= 0 &&
    number <= 9
  ) {
    return number >= 5
      ? "BIG"
      : "SMALL";
  }

  return null;
}

function normalizeRow(row) {
  if (!row) return null;

  const issue = String(
    row.issueNumber ||
    row.issue ||
    row.period ||
    row.periodNumber ||
    ""
  ).trim();

  if (!issue) return null;

  const number =
    row.number === undefined ||
    row.number === null ||
    row.number === ""
      ? null
      : Number(row.number);

  return {
    issueNumber: issue,
    number:
      Number.isInteger(number)
        ? number
        : null,
    side: normalizeSide(row)
  };
}

function sortHistory(rows) {
  return rows
    .filter(x => x && x.issueNumber && x.side)
    .sort((a, b) => {
      try {
        const aa = BigInt(a.issueNumber);
        const bb = BigInt(b.issueNumber);

        if (aa > bb) return -1;
        if (aa < bb) return 1;

        return 0;
      } catch {
        return String(b.issueNumber)
          .localeCompare(String(a.issueNumber));
      }
    });
}


/* =========================
   WINGOBOT
========================= */

function fetchWingoBot() {
  return new Promise((resolve, reject) => {
    if (!WINGOBOT_TOKEN) {
      return reject(
        new Error("WINGOBOT_TOKEN missing")
      );
    }

    const req = https.request(
      "https://api.wingobot.com/v2/30-sec-game-history",
      {
        method: "GET",
        headers: {
          Authorization:
            `Bearer ${WINGOBOT_TOKEN}`,
          Accept: "application/json",
          "User-Agent":
            "DY-AI-BS-V8"
        }
      },
      response => {
        let body = "";

        response.on("data", chunk => {
          body += chunk;
        });

        response.on("end", () => {
          if (
            response.statusCode < 200 ||
            response.statusCode >= 300
          ) {
            return reject(
              new Error(
                `WingoBot HTTP ${response.statusCode}`
              )
            );
          }

          try {
            resolve(JSON.parse(body));
          } catch {
            reject(
              new Error(
                "Invalid WingoBot JSON"
              )
            );
          }
        });
      }
    );

    req.setTimeout(15000, () => {
      req.destroy(
        new Error("WingoBot timeout")
      );
    });

    req.on("error", reject);
    req.end();
  });
}

function extractHistory(payload) {
  const source =
    payload?.history ||
    payload?.data?.history ||
    payload?.results ||
    payload?.data ||
    [];

  if (!Array.isArray(source)) {
    return [];
  }

  return sortHistory(
    source
      .map(normalizeRow)
      .filter(Boolean)
  );
}

async function refreshProvider() {
  try {
    const payload =
      await fetchWingoBot();

    provider = {
      history:
        extractHistory(payload),

      currentIssue:
        String(
          payload?.current?.issueNumber ||
          payload?.data?.current?.issueNumber ||
          ""
        ).trim() || null,

      lastUpdated:
        Number(
          payload?.stats?.last_updated
        ) ||
        Number(
          payload?.data?.stats?.last_updated
        ) ||
        now(),

      fetched:
        Number(
          payload?.stats?.fetched
        ) ||
        Number(
          payload?.data?.stats?.fetched
        ) ||
        extractHistory(payload).length,

      error: null
    };

    return provider;
  } catch (err) {
    provider.error = err.message;
    throw err;
  }
}


/* =========================
   DATABASE
========================= */

async function initDb() {
  if (!pool) return;

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
      confidence INTEGER DEFAULT 0,
      model_version TEXT,
      actual_number INTEGER,
      actual_result TEXT,
      created_at BIGINT NOT NULL,
      settled_at BIGINT
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    idx_prediction_target
    ON prediction_records(target_issue)
  `);
}

function generateKey() {
  return (
    "DY-" +
    crypto
      .randomBytes(10)
      .toString("hex")
      .toUpperCase()
  );
}


/* =========================
   ACCESS KEYS
========================= */

async function checkKey(key, deviceId) {
  if (!pool) {
    return {
      ok: false,
      error: "Database unavailable"
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

  if (!result.rows.length) {
    return {
      ok: false,
      error: "Invalid access key"
    };
  }

  const row =
    result.rows[0];

  if (
    row.device_id &&
    row.device_id !== deviceId
  ) {
    return {
      ok: false,
      error:
        "Key already bound to another device"
    };
  }

  await pool.query(
    `
    UPDATE access_keys
    SET
      device_id = COALESCE(device_id, $1),
      last_seen = $2
    WHERE id = $3
    `,
    [
      deviceId,
      now(),
      row.id
    ]
  );

  return {
    ok: true,
    key: row.access_key
  };
}


/* =========================
   PREDICTION ENGINE
========================= */

/*
  Important:
  - Uses only already settled history.
  - Does not use target result.
  - Multiple independent signals.
  - Prevents permanent BIG/SMALL sticking.
*/

function sideValue(side) {
  return side === "BIG"
    ? 1
    : -1;
}

function opposite(side) {
  return side === "BIG"
    ? "SMALL"
    : "BIG";
}

function countSide(rows, side) {
  return rows.filter(
    x => x.side === side
  ).length;
}

function lastSide(rows) {
  return rows[0]?.side || null;
}


/* Recent weighted */

function recentSignal(rows, n = 12) {
  const data =
    rows.slice(0, n);

  if (!data.length) return 0;

  let score = 0;
  let weight = 0;

  for (
    let i = 0;
    i < data.length;
    i++
  ) {
    const w =
      Math.max(
        1,
        data.length - i
      );

    score +=
      sideValue(data[i].side) *
      w;

    weight += w;
  }

  return score / weight;
}


/* Window balance */

function windowSignal(rows, n) {
  const data =
    rows.slice(0, n);

  if (!data.length) return 0;

  const big =
    countSide(data, "BIG");

  const small =
    countSide(data, "SMALL");

  return (
    (big - small) /
    data.length
  );
}


/* Transition */

function transitionSignal(rows) {
  if (rows.length < 2) return 0;

  const current =
    rows[0].side;

  let same = 0;
  let change = 0;

  for (
    let i = 0;
    i < Math.min(rows.length - 1, 50);
    i++
  ) {
    const a =
      rows[i].side;

    const b =
      rows[i + 1].side;

    if (a === current) {
      if (b === current) {
        same++;
      } else {
        change++;
      }
    }
  }

  const total =
    same + change;

  if (!total) return 0;

  /*
    Positive = current side tends to continue.
    Negative = current side tends to reverse.
  */

  return (
    (same - change) /
    total
  );
}


/* Current streak */

function streakInfo(rows) {
  if (!rows.length) {
    return {
      side: null,
      length: 0
    };
  }

  const side =
    rows[0].side;

  let length = 0;

  for (const row of rows) {
    if (row.side !== side) break;
    length++;
  }

  return {
    side,
    length
  };
}


/* Streak/reversal */

function streakSignal(rows) {
  const streak =
    streakInfo(rows);

  if (!streak.side) return 0;

  /*
    Small streaks:
    continuation is allowed.

    Long streaks:
    reversal gets more weight.

    This avoids blindly following
    a side forever.
  */

  if (streak.length <= 2) {
    return sideValue(
      streak.side
    ) * 0.25;
  }

  if (streak.length === 3) {
    return sideValue(
      streak.side
    ) * 0.05;
  }

  if (streak.length === 4) {
    return sideValue(
      opposite(streak.side)
    ) * 0.25;
  }

  if (streak.length >= 5) {
    return sideValue(
      opposite(streak.side)
    ) * 0.45;
  }

  return 0;
}


/* Alternation */

function alternationSignal(rows) {
  const data =
    rows.slice(0, 10);

  if (data.length < 4) {
    return 0;
  }

  let alternating = 0;

  for (
    let i = 0;
    i < data.length - 1;
    i++
  ) {
    if (
      data[i].side !==
      data[i + 1].side
    ) {
      alternating++;
    }
  }

  const ratio =
    alternating /
    (data.length - 1);

  if (ratio >= 0.75) {
    return sideValue(
      opposite(data[0].side)
    ) * 0.35;
  }

  if (ratio <= 0.25) {
    return sideValue(
      data[0].side
    ) * 0.15;
  }

  return 0;
}


/* Sequence */

function sequenceSignal(rows) {
  if (rows.length < 6) return 0;

  const seq =
    rows
      .slice(0, 5)
      .map(x =>
        x.side === "BIG"
          ? "B"
          : "S"
      )
      .join("");

  let bigNext = 0;
  let smallNext = 0;
  let matches = 0;

  for (
    let i = 5;
    i < rows.length - 1;
    i++
  ) {
    const historical =
      rows
        .slice(i, i + 5)
        .map(x =>
          x.side === "BIG"
            ? "B"
            : "S"
        )
        .join("");

    if (historical === seq) {
      matches++;

      const next =
        rows[i - 1]?.side;

      if (next === "BIG") {
        bigNext++;
      }

      if (next === "SMALL") {
        smallNext++;
      }
    }
  }

  if (matches < 2) {
    return 0;
  }

  return (
    (bigNext - smallNext) /
    matches
  ) * 0.45;
}


/* Trend consistency */

function consistencySignal(rows) {
  if (rows.length < 10) return 0;

  const a =
    windowSignal(rows, 5);

  const b =
    windowSignal(rows, 10);

  const c =
    windowSignal(rows, 20);

  const direction =
    a + b + c;

  if (Math.abs(direction) < 0.4) {
    return 0;
  }

  return Math.max(
    -0.45,
    Math.min(
      0.45,
      direction / 3
    )
  );
}


/* Change-point detector */

function changePointSignal(rows) {
  if (rows.length < 10) return 0;

  const recent =
    rows.slice(0, 4);

  const previous =
    rows.slice(4, 10);

  const r =
    windowSignal(
      recent,
      recent.length
    );

  const p =
    windowSignal(
      previous,
      previous.length
    );

  const difference =
    r - p;

  /*
    Strong recent change gets
    extra weight.
  */

  return Math.max(
    -0.4,
    Math.min(
      0.4,
      difference
    )
  );
}


/* Main engine */

function calculatePrediction(rows) {
  if (rows.length < 5) {
    return {
      prediction:
        rows[0]?.side ||
        "SMALL",
      reason:
        "Insufficient history",
      regime:
        "LOW_DATA",
      confidence: 45
    };
  }

  const recent =
    recentSignal(rows, 12);

  const short =
    windowSignal(rows, 5);

  const medium =
    windowSignal(rows, 15);

  const long =
    windowSignal(rows, 40);

  const transition =
    transitionSignal(rows);

  const streak =
    streakSignal(rows);

  const alternate =
    alternationSignal(rows);

  const sequence =
    sequenceSignal(rows);

  const consistency =
    consistencySignal(rows);

  const change =
    changePointSignal(rows);

  /*
    Weighted ensemble.

    Recent gets strongest weight.
    Long-term is deliberately lighter
    so old history cannot overpower
    current behaviour.
  */

  let score = 0;

  score += recent * 0.25;
  score += short * 0.16;
  score += medium * 0.12;
  score += long * 0.05;

  score += transition * 0.12;
  score += streak * 0.10;
  score += alternate * 0.07;
  score += sequence * 0.06;
  score += consistency * 0.04;
  score += change * 0.03;


  /* =========================
     ANTI-STICKINESS
  ========================= */

  const streak =
    streakInfo(rows);

  const current =
    rows[0].side;

  if (
    streak.side &&
    streak.length >= 4
  ) {
    /*
      Do not allow the same side
      to dominate merely because
      it has been repeating.
    */

    if (
      score *
        sideValue(current) >
      0
    ) {
      score *= 0.62;
    }
  }


  /* =========================
     CONFLICT HANDLING
  ========================= */

  const directions = [
    recent,
    short,
    medium,
    transition,
    streak,
    alternate,
    sequence,
    change
  ];

  const positives =
    directions.filter(
      x => x > 0.12
    ).length;

  const negatives =
    directions.filter(
      x => x < -0.12
    ).length;

  const conflict =
    positives >= 2 &&
    negatives >= 2;

  if (conflict) {
    score *= 0.72;
  }


  /* =========================
     FINAL SIDE
  ========================= */

  let prediction;

  if (score > 0) {
    prediction = "BIG";
  } else {
    prediction = "SMALL";
  }


  /* =========================
     REGIME
  ========================= */

  let regime = "MIXED";

  if (
    alternate > 0.25
  ) {
    regime = "ALTERNATING";
  } else if (
    Math.abs(streak) > 0.3
  ) {
    regime = "STREAK";
  } else if (
    Math.abs(transition) > 0.35
  ) {
    regime = "TRANSITION";
  } else if (
    Math.abs(change) > 0.25
  ) {
    regime = "SHIFT";
  } else if (
    Math.abs(consistency) > 0.25
  ) {
    regime = "TREND";
  }


  /* =========================
     CONFIDENCE
  ========================= */

  const magnitude =
    Math.min(
      1,
      Math.abs(score)
    );

  let confidence =
    Math.round(
      50 +
      magnitude * 32
    );

  if (conflict) {
    confidence -= 7;
  }

  confidence =
    Math.max(
      45,
      Math.min(
        86,
        confidence
      )
    );


  /* =========================
     REASON
  ========================= */

  const reasons = [];

  if (
    Math.abs(recent) > 0.3
  ) {
    reasons.push(
      "recent trend"
    );
  }

  if (
    Math.abs(transition) > 0.3
  ) {
    reasons.push(
      "transition"
    );
  }

  if (
    Math.abs(streak) > 0.3
  ) {
    reasons.push(
      "streak/reversal"
    );
  }

  if (
    Math.abs(alternate) > 0.25
  ) {
    reasons.push(
      "alternation"
    );
  }

  if (
    Math.abs(sequence) > 0.2
  ) {
    reasons.push(
      "sequence"
    );
  }

  if (
    Math.abs(change) > 0.2
  ) {
    reasons.push(
      "trend shift"
    );
  }

  return {
    prediction,
    confidence,
    regime,
    reason:
      reasons.length
        ? reasons.join(" + ")
        : "ensemble analysis",
    score:
      Number(score.toFixed(4)),
    signals: {
      recent:
        Number(recent.toFixed(3)),
      short:
        Number(short.toFixed(3)),
      medium:
        Number(medium.toFixed(3)),
      long:
        Number(long.toFixed(3)),
      transition:
        Number(transition.toFixed(3)),
      streak:
        Number(streak.toFixed(3)),
      alternation:
        Number(alternate.toFixed(3)),
      sequence:
        Number(sequence.toFixed(3)),
      consistency:
        Number(consistency.toFixed(3)),
      change:
        Number(change.toFixed(3))
    }
  };
}


/* =========================
   PREDICTION RECORD
========================= */

async function savePrediction(
  targetIssue,
  result
) {
  if (!pool) return;

  await pool.query(
    `
    INSERT INTO prediction_records
    (
      target_issue,
      prediction,
      confidence,
      model_version,
      created_at
    )
    VALUES
    ($1,$2,$3,$4,$5)
    `,
    [
      targetIssue,
      result.prediction,
      result.confidence,
      MODEL_VERSION,
      now()
    ]
  );
}

async function getStoredPrediction(
  targetIssue
) {
  if (!pool) return null;

  const result =
    await pool.query(
      `
      SELECT *
      FROM prediction_records
      WHERE target_issue = $1
      ORDER BY id DESC
      LIMIT 1
      `,
      [targetIssue]
    );

  return result.rows[0] || null;
}


/* =========================
   SETTLEMENT
========================= */

async function settlePredictions() {
  if (!pool) return;

  for (const actual of provider.history) {
    if (!actual.side) continue;

    await pool.query(
      `
      UPDATE prediction_records
      SET
        actual_number = $1,
        actual_result = $2,
        settled_at =
          COALESCE(
            settled_at,
            $3
          )
      WHERE target_issue = $4
        AND actual_result IS NULL
      `,
      [
        actual.number,
        actual.side,
        now(),
        actual.issueNumber
      ]
    );
  }
}


/* =========================
   LAST 30
========================= */

async function getPredictionHistory() {
  if (!pool) return [];

  const result =
    await pool.query(`
      SELECT
        id,
        target_issue,
        prediction,
        confidence,
        model_version,
        actual_number,
        actual_result,
        created_at,
        settled_at
      FROM prediction_records
      ORDER BY id DESC
      LIMIT 30
    `);

  const actualMap =
    new Map(
      provider.history.map(row => [
        row.issueNumber,
        row
      ])
    );

  return result.rows.map(row => {
    const actual =
      actualMap.get(
        row.target_issue
      );

    let status =
      "PENDING";

    if (actual?.side) {
      status =
        actual.side ===
        row.prediction
          ? "WIN"
          : "LOSS";
    }

    return {
      id: row.id,
      targetIssue:
        row.target_issue,
      prediction:
        row.prediction,
      confidence:
        row.confidence,
      actual:
        actual?.side || null,
      actualNumber:
        actual?.number ?? null,
      status,
      modelVersion:
        row.model_version,
      createdAt:
        row.created_at
    };
  });
}


/* =========================
   STATE
========================= */

async function buildState() {
  const target =
    resolveTargetIssue();

  if (
    target &&
    provider.history.length >= 5
  ) {
    const existing =
      await getStoredPrediction(
        target
      );

    if (existing) {

      lastPrediction = {
        prediction:
          existing.prediction,
        confidence:
          existing.confidence,
        reason:
          "Stored prediction",
        regime:
          "STORED",
        targetIssue:
          target
      };

    } else {

      const analysis =
        calculatePrediction(
          provider.history
        );

      lastPrediction = {
        ...analysis,
        targetIssue:
          target
      };

      await savePrediction(
        target,
        analysis
      );
    }
  }

  return {
    ok: true,

    model:
      MODEL_VERSION,

    gameUrl:
      GAME_URL,

    currentIssue:
      provider.currentIssue,

    targetIssue:
      target,

    prediction:
      lastPrediction?.prediction ||
      null,

    confidence:
      lastPrediction?.confidence ||
      null,

    reason:
      lastPrediction?.reason ||
      null,

    regime:
      lastPrediction?.regime ||
      null,

    providerLastUpdated:
      provider.lastUpdated,

    fetched:
      provider.fetched,

    history:
      provider.history
        .slice(0, 30),

    error:
      provider.error
  };
}


/* =========================
   API
========================= */

async function handleApi(
  req,
  res,
  url
) {

  /* STATE */

  if (
    url.pathname ===
    "/api/state"
  ) {

    try {

      if (
        !provider.history.length ||
        provider.error
      ) {
        await refreshProvider();
      }

      await settlePredictions();

      return sendJson(
        res,
        200,
        await buildState()
      );

    } catch (err) {

      return sendJson(
        res,
        200,
        await buildState()
      );
    }
  }


  /* HISTORY */

  if (
    url.pathname ===
    "/api/history"
  ) {

    try {

      if (
        !provider.history.length
      ) {
        await refreshProvider();
      }

      await settlePredictions();

      return sendJson(
        res,
        200,
        {
          ok: true,
          history:
            await getPredictionHistory()
        }
      );

    } catch (err) {

      return sendJson(
        res,
        500,
        {
          ok: false,
          error: err.message
        }
      );
    }
  }


  /* KEY */

  if (
    url.pathname ===
    "/api/key/check" &&
    req.method === "POST"
  ) {

    try {

      const body =
        await readBody(req);

      const key =
        String(
          body.key || ""
        ).trim();

      const deviceId =
        String(
          body.deviceId || ""
        ).trim();

      if (!key || !deviceId) {
        return sendJson(
          res,
          400,
          {
            ok: false,
            error:
              "Key and device ID required"
          }
        );
      }

      return sendJson(
        res,
        200,
        await checkKey(
          key,
          deviceId
        )
      );

    } catch (err) {

      return sendJson(
        res,
        500,
        {
          ok: false,
          error: err.message
        }
      );
    }
  }


  /* ADMIN STATUS */

  if (
    url.pathname ===
    "/api/admin/status"
  ) {

    if (
      !requireAdmin(req, res)
    ) return;

    return sendJson(
      res,
      200,
      {
        ok: true,
        server: true,
        database: !!pool,
        wingobot:
          !!WINGOBOT_TOKEN,
        model:
          MODEL_VERSION,
        output:
          "BIG / SMALL",
        history:
          provider.history.length
      }
    );
  }


  /* ADMIN PING */

  if (
    url.pathname ===
    "/api/admin/ping"
  ) {

    if (
      !requireAdmin(req, res)
    ) return;

    let database = false;

    if (pool) {
      try {
        await pool.query(
          "SELECT 1"
        );
        database = true;
      } catch {}
    }

    return sendJson(
      res,
      200,
      {
        ok: true,
        server: true,
        database,
        time: now()
      }
    );
  }


  /* WINGOBOT TEST */

  if (
    url.pathname ===
    "/api/admin/wingo-test"
  ) {

    if (
      !requireAdmin(req, res)
    ) return;

    try {

      const payload =
        await fetchWingoBot();

      const history =
        extractHistory(
          payload
        );

      return sendJson(
        res,
        200,
        {
          ok: true,
          current:
            payload?.current ||
            null,
          fetched:
            payload?.stats?.fetched ||
            history.length,
          historyCount:
            history.length
        }
      );

    } catch (err) {

      return sendJson(
        res,
        500,
        {
          ok: false,
          error: err.message
        }
      );
    }
  }


  /* MODEL TEST */

  if (
    url.pathname ===
    "/api/admin/model-test"
  ) {

    if (
      !requireAdmin(req, res)
    ) return;

    if (
      provider.history.length < 5
    ) {
      return sendJson(
        res,
        400,
        {
          ok: false,
          error:
            "Not enough history"
        }
      );
    }

    const analysis =
      calculatePrediction(
        provider.history
      );

    return sendJson(
      res,
      200,
      {
        ok: true,
        model:
          MODEL_VERSION,
        analysis,
        historyUsed:
          provider.history.length
      }
    );
  }


  /* REFRESH */

  if (
    url.pathname ===
    "/api/admin/refresh"
  ) {

    if (
      !requireAdmin(req, res)
    ) return;

    try {

      await refreshProvider();

      return sendJson(
        res,
        200,
        {
          ok: true,
          history:
            provider.history.length,
          currentIssue:
            provider.currentIssue
        }
      );

    } catch (err) {

      return sendJson(
        res,
        500,
        {
          ok: false,
          error: err.message
        }
      );
    }
  }


  /* CREATE KEY */

  if (
    url.pathname ===
    "/api/admin/keys" &&
    req.method === "POST"
  ) {

    if (
      !requireAdmin(req, res)
    ) return;

    if (!pool) {
      return sendJson(
        res,
        500,
        {
          ok: false,
          error:
            "Database unavailable"
        }
      );
    }

    try {

      const key =
        generateKey();

      await pool.query(
        `
        INSERT INTO access_keys
        (
          access_key,
          created_at
        )
        VALUES
        ($1,$2)
        `,
        [
          key,
          now()
        ]
      );

      return sendJson(
        res,
        200,
        {
          ok: true,
          access_key:
            key
        }
      );

    } catch (err) {

      return sendJson(
        res,
        500,
        {
          ok: false,
          error: err.message
        }
      );
    }
  }


  /* LIST KEYS */

  if (
    url.pathname ===
    "/api/admin/keys" &&
    req.method === "GET"
  ) {

    if (
      !requireAdmin(req, res)
    ) return;

    if (!pool) {
      return sendJson(
        res,
        500,
        {
          ok: false,
          error:
            "Database unavailable"
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

    return sendJson(
      res,
      200,
      {
        ok: true,
        keys:
          result.rows
      }
    );
  }


  /* DELETE KEY */

  if (
    url.pathname ===
    "/api/admin/keys" &&
    req.method === "DELETE"
  ) {

    if (
      !requireAdmin(req, res)
    ) return;

    if (!pool) {
      return sendJson(
        res,
        500,
        {
          ok: false,
          error:
            "Database unavailable"
        }
      );
    }

    const id =
      Number(
        url.searchParams.get("id")
      );

    if (!id) {
      return sendJson(
        res,
        400,
        {
          ok: false,
          error:
            "Invalid ID"
        }
      );
    }

    await pool.query(
      `
      DELETE FROM access_keys
      WHERE id = $1
      `,
      [id]
    );

    return sendJson(
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

    if (
      !requireAdmin(req, res)
    ) return;

    if (!pool) {
      return sendJson(
        res,
        500,
        {
          ok: false,
          error:
            "Database unavailable"
        }
      );
    }

    const body =
      await readBody(req);

    const id =
      Number(body.id);

    if (!id) {
      return sendJson(
        res,
        400,
        {
          ok: false,
          error:
            "Invalid ID"
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
      [id]
    );

    return sendJson(
      res,
      200,
      {
        ok: true
      }
    );
  }


  return sendJson(
    res,
    404,
    {
      ok: false,
      error:
        "API route not found"
    }
  );
}


/* =========================
   STATIC
========================= */

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

  if (!fs.existsSync(file)) {
    return sendText(
      res,
      404,
      "File not found"
    );
  }

  res.writeHead(
    200,
    {
      "Content-Type":
        contentType,
      "Cache-Control":
        "no-cache"
    }
  );

  fs.createReadStream(
    file
  ).pipe(res);
}


/* =========================
   SERVER
========================= */

const server =
  http.createServer(
    async (req, res) => {

      try {

        const url =
          new URL(
            req.url,
            `http://${req.headers.host || "localhost"}`
          );


        if (
          req.method ===
          "OPTIONS"
        ) {

          res.writeHead(
            204,
            {
              "Access-Control-Allow-Origin":
                "*",
              "Access-Control-Allow-Methods":
                "GET,POST,DELETE,OPTIONS",
              "Access-Control-Allow-Headers":
                "Content-Type,X-Admin-Key,Authorization"
            }
          );

          return res.end();
        }


        /* HEALTH */

        if (
          url.pathname ===
          "/health"
        ) {

          return sendJson(
            res,
            200,
            {
              ok: true,
              model:
                MODEL_VERSION,
              database:
                !!pool,
              wingobot:
                !!WINGOBOT_TOKEN,
              time:
                now()
            }
          );
        }


        /* API */

        if (
          url.pathname
            .startsWith("/api/")
        ) {

          return await handleApi(
            req,
            res,
            url
          );
        }


        /* PAGES */

        if (
          url.pathname === "/" ||
          url.pathname ===
            "/prediction.html"
        ) {

          return serveFile(
            res,
            "prediction.html",
            "text/html; charset=utf-8"
          );
        }


        if (
          url.pathname ===
          "/admin.html"
        ) {

          return serveFile(
            res,
            "admin.html",
            "text/html; charset=utf-8"
          );
        }


        /* MUSIC */

        if (
          url.pathname ===
          "/music.mp3"
        ) {

          const file =
            path.join(
              __dirname,
              "music.mp3"
            );

          if (
            !fs.existsSync(file)
          ) {
            return sendText(
              res,
              404,
              "Music not found"
            );
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

            return fs
              .createReadStream(file)
              .pipe(res);
          }

          const match =
            /bytes=(\d+)-(\d*)/
              .exec(range);

          if (!match) {
            res.writeHead(416);
            return res.end();
          }

          const start =
            Number(match[1]);

          const end =
            match[2]
              ? Number(match[2])
              : stat.size - 1;

          if (
            start >= stat.size ||
            end >= stat.size ||
            start > end
          ) {
            res.writeHead(416);
            return res.end();
          }

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
              file,
              {
                start,
                end
              }
            )
            .pipe(res);
        }


        return sendText(
          res,
          404,
          "Not found"
        );

      } catch (err) {

        console.error(err);

        return sendJson(
          res,
          500,
          {
            ok: false,
            error:
              "Internal server error"
          }
        );
      }
    }
  );


/* =========================
   BOOT
========================= */

async function boot() {

  await initDb();

  try {
    await refreshProvider();

    console.log(
      "WingoBot history:",
      provider.history.length
    );

  } catch (err) {

    console.log(
      "Initial provider error:",
      err.message
    );
  }


  setInterval(
    async () => {

      try {

        await refreshProvider();

        await settlePredictions();

      } catch (err) {

        provider.error =
          err.message;
      }

    },
    3000
  );


  server.listen(
    PORT,
    () => {

      console.log(
        `DY AI BS V8 running on ${PORT}`
      );

    }
  );
}

boot();
