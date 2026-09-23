const http = require("http");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const PORT = process.env.PORT || 10000;

const ADMIN_KEY =
  process.env.ADMIN_KEY || "dy4427574";

const WINGOBOT_TOKEN =
  process.env.WINGOBOT_TOKEN || "";

const WINGO_API =
  process.env.WINGO_API ||
  "https://api.wingobot.com/v2/1-min-game-history";

const MODEL_VERSION =
  "DY-AI-RANDOM-V1";

const API_REFRESH_MS = 1000;
const ENGINE_TICK_MS = 250;
const ANALYSIS_MS = 4000;
const SKIP_ROUNDS = 4;

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false,
  max: 5
});

let liveRefreshRunning = false;

const live = {
  online: false,
  history: [],
  currentIssue: null,
  latestIssue: null,
  latestNumber: null,
  latestResult: null,
  fetchedAt: 0,
  error: null
};

let analysis = {
  active: false,
  startedAt: 0,
  targetIssue: null,
  progress: 0
};

function now() {
  return Date.now();
}

function resultFromNumber(number) {
  const n = Number(number);

  if (!Number.isFinite(n)) {
    return null;
  }

  return n >= 5 ? "BIG" : "SMALL";
}

function parseIssue(value) {
  if (
    value === undefined ||
    value === null
  ) {
    return null;
  }

  const s = String(value).trim();

  if (!s) return null;

  const digits =
    s.replace(/[^\d]/g, "");

  return digits || null;
}

function issueNumber(value) {
  const issue = parseIssue(value);

  if (!issue) return null;

  try {
    return BigInt(issue);
  } catch {
    return null;
  }
}

function nextIssue(issue) {
  const n = issueNumber(issue);

  if (n === null) return null;

  return (n + 1n).toString();
}

function issueDiff(a, b) {
  const x = issueNumber(a);
  const y = issueNumber(b);

  if (x === null || y === null) {
    return null;
  }

  const d = x - y;

  if (d > 1000000n) return 1000000;
  if (d < -1000000n) return -1000000;

  return Number(d);
}

function firstValue(obj, keys) {
  if (
    !obj ||
    typeof obj !== "object"
  ) {
    return null;
  }

  for (const key of keys) {
    if (
      obj[key] !== undefined &&
      obj[key] !== null &&
      obj[key] !== ""
    ) {
      return obj[key];
    }
  }

  return null;
}

function collectObjects(
  value,
  output = [],
  depth = 0
) {
  if (
    depth > 7 ||
    value === null ||
    value === undefined
  ) {
    return output;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectObjects(
        item,
        output,
        depth + 1
      );
    }

    return output;
  }

  if (
    typeof value !== "object"
  ) {
    return output;
  }

  output.push(value);

  for (const key of Object.keys(value)) {
    const child = value[key];

    if (
      child &&
      typeof child === "object"
    ) {
      collectObjects(
        child,
        output,
        depth + 1
      );
    }
  }

  return output;
}

const ISSUE_KEYS = [
  "issueNumber",
  "issue",
  "issue_no",
  "issueNo",
  "period",
  "periodId",
  "period_id",
  "draw",
  "drawNumber",
  "draw_number"
];

const NUMBER_KEYS = [
  "number",
  "result",
  "resultNumber",
  "result_number",
  "digit",
  "num"
];

function normalizeRow(obj) {
  if (
    !obj ||
    typeof obj !== "object"
  ) {
    return null;
  }

  const rawIssue =
    firstValue(
      obj,
      ISSUE_KEYS
    );

  const issue =
    parseIssue(rawIssue);

  const rawNumber =
    firstValue(
      obj,
      NUMBER_KEYS
    );

  const number =
    Number(rawNumber);

  if (!issue) return null;

  if (
    !Number.isInteger(number) ||
    number < 0 ||
    number > 9
  ) {
    return null;
  }

  return {
    issue,
    number,
    result:
      resultFromNumber(number),
    colour:
      obj.colour ||
      obj.color ||
      null,
    premium:
      obj.premium ||
      null
  };
}

function normalizeHistory(payload) {
  const objects =
    collectObjects(payload);

  const rows = [];

  for (const obj of objects) {
    const row =
      normalizeRow(obj);

    if (row) {
      rows.push(row);
    }
  }

  const map = new Map();

  for (const row of rows) {
    map.set(
      `${row.issue}:${row.number}`,
      row
    );
  }

  const unique =
    Array.from(
      map.values()
    );

  unique.sort((a, b) => {
    const x =
      issueNumber(a.issue);

    const y =
      issueNumber(b.issue);

    if (x === null || y === null) {
      return 0;
    }

    if (x < y) return -1;
    if (x > y) return 1;

    return 0;
  });

  return unique.slice(-100);
}

function findLatest(history) {
  if (!history.length) {
    return null;
  }

  return history[
    history.length - 1
  ];
}

function findCurrentIssue(payload) {

  if (
    payload &&
    payload.current &&
    payload.current.issueNumber
  ) {
    const issue =
      parseIssue(
        payload.current.issueNumber
      );

    if (issue) {
      return issue;
    }
  }

  const objects =
    collectObjects(payload);

  for (const obj of objects) {

    const issue =
      parseIssue(
        firstValue(obj, [
          "currentIssue",
          "current_issue",
          "currentPeriod",
          "current_period",
          "currentPeriodId",
          "current_period_id",
          "currentIssueNumber",
          "current_issue_number"
        ])
      );

    if (issue) {
      return issue;
    }
  }

  return null;
}

async function fetchWingo() {

  if (!WINGOBOT_TOKEN) {
    throw new Error(
      "WINGOBOT_TOKEN is missing"
    );
  }

  const controller =
    new AbortController();

  const timer =
    setTimeout(() => {
      controller.abort();
    }, 8000);

  try {

    const url =
      WINGO_API +
      (
        WINGO_API.includes("?")
          ? "&"
          : "?"
      ) +
      "_=" +
      Date.now();

    const response =
      await fetch(url, {
        method: "GET",
        signal: controller.signal,
        headers: {
          Authorization:
            "Bearer " +
            WINGOBOT_TOKEN,

          Accept:
            "application/json",

          "Cache-Control":
            "no-cache",

          Pragma:
            "no-cache",

          "User-Agent":
            "DY-AI-WINGO-RANDOM-V1"
        }
      });

    if (!response.ok) {
      throw new Error(
        "Wingo API HTTP " +
        response.status
      );
    }

    const payload =
      await response.json();

    const history =
      normalizeHistory(
        payload
      );

    if (!history.length) {
      throw new Error(
        "No valid history received"
      );
    }

    const latest =
      findLatest(history);

    let currentIssue =
      findCurrentIssue(
        payload
      );

    const derivedCurrent =
      nextIssue(
        latest
          ? latest.issue
          : null
      );

    if (!currentIssue) {
      currentIssue =
        derivedCurrent;
    }
    else if (derivedCurrent) {

      const difference =
        issueDiff(
          currentIssue,
          derivedCurrent
        );

      if (
        difference !== null &&
        difference < 0
      ) {
        currentIssue =
          derivedCurrent;
      }
    }

    return {
      history,
      currentIssue,
      latestIssue:
        latest
          ? latest.issue
          : null,
      latestNumber:
        latest
          ? latest.number
          : null,
      latestResult:
        latest
          ? latest.result
          : null
    };

  } finally {
    clearTimeout(timer);
  }
}

function resetAnalysis() {
  analysis = {
    active: false,
    startedAt: 0,
    targetIssue: null,
    progress: 0
  };
}

async function getLastPrediction() {

  const result =
    await pool.query(`
      SELECT *
      FROM prediction_records
      ORDER BY id DESC
      LIMIT 1
    `);

  return (
    result.rows[0] ||
    null
  );
}

async function getPredictionForIssue(
  issue
) {

  if (!issue) {
    return null;
  }

  const result =
    await pool.query(
      `
      SELECT *
      FROM prediction_records
      WHERE target_issue = $1
      ORDER BY id DESC
      LIMIT 1
      `,
      [String(issue)]
    );

  return (
    result.rows[0] ||
    null
  );
}

function getCycle(
  lastPrediction
) {

  if (!lastPrediction) {
    return {
      mode: "PREDICT",
      skipRemaining: 0
    };
  }

  const diff =
    issueDiff(
      live.currentIssue,
      lastPrediction.target_issue
    );

  if (
    diff === null ||
    diff <= 0
  ) {
    return {
      mode: "PREDICTED",
      skipRemaining: 0
    };
  }

  if (diff <= SKIP_ROUNDS) {
    return {
      mode: "SKIP",
      skipRemaining:
        SKIP_ROUNDS -
        diff +
        1
    };
  }

  return {
    mode: "PREDICT",
    skipRemaining: 0
  };
}

/*
  RANDOM PREDICTION

  Every new prediction independently chooses
  BIG or SMALL using crypto.randomInt.

  It does not copy the previous result,
  does not follow a fixed pattern,
  and does not claim guaranteed accuracy.
*/
function analyzeAI() {

  const prediction =
    require("crypto")
      .randomInt(0, 2) === 0
      ? "BIG"
      : "SMALL";

  const confidence =
    require("crypto")
      .randomInt(50, 76);

  return {
    prediction,
    confidence,
    evidence:
      "RANDOM ENGINE"
  };
}

async function savePrediction(
  targetIssue,
  result
) {

  if (
    !targetIssue ||
    !result ||
    !result.prediction
  ) {
    return null;
  }

  const existing =
    await getPredictionForIssue(
      targetIssue
    );

  if (existing) {
    return existing;
  }

  const resultDb =
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
      VALUES ($1,$2,$3,$4,$5)
      RETURNING *
      `,
      [
        String(targetIssue),
        result.prediction,
        Number(
          result.confidence || 0
        ),
        MODEL_VERSION,
        now()
      ]
    );

  return resultDb.rows[0];
}

async function settlePredictions() {

  if (
    !live.latestIssue ||
    live.latestNumber === null
  ) {
    return;
  }

  const result =
    await pool.query(
      `
      SELECT *
      FROM prediction_records
      WHERE actual_number IS NULL
        AND target_issue = $1
      ORDER BY id DESC
      LIMIT 10
      `,
      [
        String(
          live.latestIssue
        )
      ]
    );

  for (
    const row of result.rows
  ) {

    const actualResult =
      resultFromNumber(
        live.latestNumber
      );

    await pool.query(
      `
      UPDATE prediction_records
      SET
        actual_number = $1,
        actual_result = $2,
        settled_at = $3
      WHERE id = $4
      `,
      [
        live.latestNumber,
        actualResult,
        now(),
        row.id
      ]
    );
  }
}

async function engineTick() {

  if (
    !live.online ||
    !live.currentIssue
  ) {
    return;
  }

  const lastPrediction =
    await getLastPrediction();

  const cycle =
    getCycle(
      lastPrediction
    );

  if (
    cycle.mode === "SKIP"
  ) {
    resetAnalysis();
    return;
  }

  if (
    cycle.mode !== "PREDICT"
  ) {
    resetAnalysis();
    return;
  }

  const existing =
    await getPredictionForIssue(
      live.currentIssue
    );

  if (existing) {
    resetAnalysis();
    return;
  }

  if (!analysis.active) {

    analysis = {
      active: true,
      startedAt: now(),
      targetIssue:
        live.currentIssue,
      progress: 0
    };

    return;
  }

  if (
    analysis.targetIssue !==
    live.currentIssue
  ) {
    resetAnalysis();
    return;
  }

  const elapsed =
    now() -
    analysis.startedAt;

  analysis.progress =
    Math.min(
      100,
      Math.round(
        (
          elapsed /
          ANALYSIS_MS
        ) * 100
      )
    );

  if (
    elapsed < ANALYSIS_MS
  ) {
    return;
  }

  const ai =
    analyzeAI();

  await savePrediction(
    live.currentIssue,
    ai
  );

  resetAnalysis();
}

async function refreshLive() {

  if (liveRefreshRunning) {
    return;
  }

  liveRefreshRunning = true;

  try {

    const previousIssue =
      live.currentIssue;

    const data =
      await fetchWingo();

    live.online = true;

    live.history =
      data.history;

    live.currentIssue =
      data.currentIssue;

    live.latestIssue =
      data.latestIssue;

    live.latestNumber =
      data.latestNumber;

    live.latestResult =
      data.latestResult;

    live.fetchedAt =
      now();

    live.error = null;

    if (
      previousIssue &&
      live.currentIssue &&
      previousIssue !==
        live.currentIssue
    ) {

      console.log(
        "[LIVE] PERIOD CHANGED:",
        previousIssue,
        "=>",
        live.currentIssue
      );

      resetAnalysis();
    }

    await settlePredictions();

  } catch (error) {

    live.online = false;

    live.error =
      error.message;

    console.error(
      "[LIVE ERROR]",
      error.message
    );

  } finally {

    liveRefreshRunning =
      false;
  }
}

async function buildState() {

  let lastPrediction =
    null;

  let currentPrediction =
    null;

  try {

    lastPrediction =
      await getLastPrediction();

    currentPrediction =
      await getPredictionForIssue(
        live.currentIssue
      );

  } catch (error) {

    console.error(
      "[DB STATE ERROR]",
      error.message
    );
  }

  const cycle =
    getCycle(
      lastPrediction
    );

  let prediction = null;

  if (currentPrediction) {

    prediction = {
      prediction:
        currentPrediction.prediction,

      confidence:
        currentPrediction.confidence,

      targetIssue:
        currentPrediction.target_issue,

      model:
        currentPrediction.model_version,

      createdAt:
        currentPrediction.created_at
    };
  }

  return {
    online:
      live.online,

    currentIssue:
      live.currentIssue,

    latestIssue:
      live.latestIssue,

    latestNumber:
      live.latestNumber,

    latestResult:
      live.latestResult,

    history:
      live.history.slice(-20),

    fetchedAt:
      live.fetchedAt,

    error:
      live.error,

    model:
      MODEL_VERSION,

    cycle,

    prediction,

    analysisSession: {
      active:
        analysis.active,

      targetIssue:
        analysis.targetIssue,

      progress:
        analysis.progress,

      elapsed:
        analysis.active
          ? now() -
            analysis.startedAt
          : 0
    }
  };
}

function sendJSON(
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
        "no-store, no-cache, must-revalidate, proxy-revalidate",

      Pragma:
        "no-cache",

      Expires:
        "0"
    }
  );

  res.end(body);
}

function sendFile(
  res,
  file
) {

  if (!fs.existsSync(file)) {
    res.writeHead(404);
    return res.end(
      "File not found"
    );
  }

  const ext =
    path.extname(file)
      .toLowerCase();

  const type =
    ext === ".html"
      ? "text/html; charset=utf-8"
      : ext === ".css"
      ? "text/css; charset=utf-8"
      : ext === ".js"
      ? "application/javascript; charset=utf-8"
      : "application/octet-stream";

  res.writeHead(
    200,
    {
      "Content-Type":
        type,

      "Cache-Control":
        "no-store, no-cache, must-revalidate, proxy-revalidate",

      Pragma:
        "no-cache",

      Expires:
        "0"
    }
  );

  fs.createReadStream(
    file
  ).pipe(res);
}

function adminAuth(req) {
  return (
    req.headers[
      "x-admin-key"
    ] === ADMIN_KEY
  );
}

async function readBody(req) {

  return new Promise(
    (resolve, reject) => {

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

          try {
            resolve(
              body
                ? JSON.parse(body)
                : {}
            );
          } catch {
            resolve({});
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

async function checkKey(
  body
) {

  const key =
    String(
      body.accessKey || ""
    ).trim();

  const deviceId =
    String(
      body.deviceId || ""
    ).trim();

  if (!key || !deviceId) {
    return {
      ok: false,
      message:
        "Access key and device ID required"
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
      message:
        "Invalid access key"
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
      message:
        "This key is already bound to another device"
    };
  }

  await pool.query(
    `
    UPDATE access_keys
    SET
      device_id =
        COALESCE(device_id,$1),
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
    message:
      "Access granted"
  };
}

async function adminKeys() {

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

  return result.rows;
}

async function createKey(
  body
) {

  let key =
    String(
      body.accessKey || ""
    ).trim();

  if (!key) {

    key =
      "DY-" +
      require("crypto")
        .randomBytes(5)
        .toString("hex")
        .toUpperCase();
  }

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
      [key, now()]
    );

  return result.rows[0];
}

async function resetDevice(
  body
) {

  const id =
    Number(body.id);

  if (!Number.isInteger(id)) {
    throw new Error(
      "Invalid key ID"
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
}

async function deleteKey(
  body
) {

  const id =
    Number(body.id);

  if (!Number.isInteger(id)) {
    throw new Error(
      "Invalid key ID"
    );
  }

  await pool.query(
    `
    DELETE FROM access_keys
    WHERE id = $1
    `,
    [id]
  );
}

async function predictionList() {

  const result =
    await pool.query(`
      SELECT *
      FROM prediction_records
      ORDER BY id DESC
      LIMIT 100
    `);

  return result.rows;
}

async function predictionStats() {

  const result =
    await pool.query(`
      SELECT
        COUNT(*)::int AS total,

        COUNT(*) FILTER (
          WHERE actual_result =
                prediction
        )::int AS wins,

        COUNT(*) FILTER (
          WHERE actual_result IS NOT NULL
          AND actual_result <> prediction
        )::int AS losses,

        COUNT(*) FILTER (
          WHERE actual_result IS NULL
        )::int AS pending

      FROM prediction_records
    `);

  return result.rows[0];
}

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
      confidence INTEGER DEFAULT 0,
      model_version TEXT,
      actual_number INTEGER,
      actual_result TEXT,
      created_at BIGINT NOT NULL,
      settled_at BIGINT
    )
  `);
}

async function router(
  req,
  res
) {

  const url =
    new URL(
      req.url,
      "http://" +
        req.headers.host
    );

  const pathname =
    url.pathname;

  try {

    if (
      req.method === "GET" &&
      (
        pathname === "/" ||
        pathname ===
          "/prediction.html"
      )
    ) {
      return sendFile(
        res,
        path.join(
          __dirname,
          "prediction.html"
        )
      );
    }

    if (
      req.method === "GET" &&
      pathname === "/admin.html"
    ) {
      return sendFile(
        res,
        path.join(
          __dirname,
          "admin.html"
        )
      );
    }

    if (
      req.method === "GET" &&
      pathname === "/health"
    ) {

      return sendJSON(
        res,
        200,
        {
          ok: true,
          online:
            live.online,
          currentIssue:
            live.currentIssue,
          latestIssue:
            live.latestIssue,
          latestNumber:
            live.latestNumber,
          fetchedAt:
            live.fetchedAt,
          error:
            live.error,
          model:
            MODEL_VERSION
        }
      );
    }

    if (
      req.method === "POST" &&
      pathname ===
        "/api/key/check"
    ) {

      const body =
        await readBody(req);

      return sendJSON(
        res,
        200,
        await checkKey(body)
      );
    }

    if (
      req.method === "GET" &&
      pathname === "/api/state"
    ) {

      return sendJSON(
        res,
        200,
        await buildState()
      );
    }

    if (
      req.method === "GET" &&
      pathname ===
        "/api/admin/status"
    ) {

      if (!adminAuth(req)) {
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

      return sendJSON(
        res,
        200,
        {
          ok: true,
          online:
            live.online,
          currentIssue:
            live.currentIssue,
          latestIssue:
            live.latestIssue,
          latestNumber:
            live.latestNumber,
          latestResult:
            live.latestResult,
          fetchedAt:
            live.fetchedAt,
          error:
            live.error,
          historyCount:
            live.history.length,
          model:
            MODEL_VERSION,
          tokenConfigured:
            Boolean(
              WINGOBOT_TOKEN
            )
        }
      );
    }

    if (
      req.method === "GET" &&
      pathname ===
        "/api/admin/keys"
    ) {

      if (!adminAuth(req)) {
        return sendJSON(
          res,
          401,
          { ok: false }
        );
      }

      return sendJSON(
        res,
        200,
        {
          ok: true,
          keys:
            await adminKeys()
        }
      );
    }

    if (
      req.method === "POST" &&
      pathname ===
        "/api/admin/keys"
    ) {

      if (!adminAuth(req)) {
        return sendJSON(
          res,
          401,
          { ok: false }
        );
      }

      const body =
        await readBody(req);

      return sendJSON(
        res,
        200,
        {
          ok: true,
          key:
            await createKey(body)
        }
      );
    }

    if (
      req.method === "POST" &&
      pathname ===
        "/api/admin/reset-device"
    ) {

      if (!adminAuth(req)) {
        return sendJSON(
          res,
          401,
          { ok: false }
        );
      }

      const body =
        await readBody(req);

      await resetDevice(body);

      return sendJSON(
        res,
        200,
        { ok: true }
      );
    }

    if (
      req.method === "POST" &&
      pathname ===
        "/api/admin/delete-key"
    ) {

      if (!adminAuth(req)) {
        return sendJSON(
          res,
          401,
          { ok: false }
        );
      }

      const body =
        await readBody(req);

      await deleteKey(body);

      return sendJSON(
        res,
        200,
        { ok: true }
      );
    }

    if (
      req.method === "GET" &&
      pathname ===
        "/api/admin/predictions"
    ) {

      if (!adminAuth(req)) {
        return sendJSON(
          res,
          401,
          { ok: false }
        );
      }

      return sendJSON(
        res,
        200,
        {
          ok: true,
          predictions:
            await predictionList(),
          stats:
            await predictionStats()
        }
      );
    }

    if (
      req.method === "GET" &&
      pathname ===
        "/api/admin/ping"
    ) {

      if (!adminAuth(req)) {
        return sendJSON(
          res,
          401,
          { ok: false }
        );
      }

      return sendJSON(
        res,
        200,
        {
          ok: true,
          time: now()
        }
      );
    }

    if (
      req.method === "GET" &&
      pathname ===
        "/api/admin/live-test"
    ) {

      if (!adminAuth(req)) {
        return sendJSON(
          res,
          401,
          { ok: false }
        );
      }

      const data =
        await fetchWingo();

      return sendJSON(
        res,
        200,
        {
          ok: true,
          data
        }
      );
    }

    if (
      req.method === "GET" &&
      pathname ===
        "/api/admin/model-test"
    ) {

      if (!adminAuth(req)) {
        return sendJSON(
          res,
          401,
          { ok: false }
        );
      }

      return sendJSON(
        res,
        200,
        {
          ok: true,
          model:
            MODEL_VERSION,
          engine:
            "RANDOM",
          historyCount:
            live.history.length,
          analysis:
            analyzeAI()
        }
      );
    }

    return sendJSON(
      res,
      404,
      {
        ok: false,
        message:
          "Not found"
      }
    );

  } catch (error) {

    console.error(
      "[ROUTE ERROR]",
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

async function start() {

  try {

    await initDB();

    const server =
      http.createServer(
        router
      );

    server.listen(
      PORT,
      "0.0.0.0",
      () => {
        console.log(
          "DY AI WinGo running on " +
          PORT
        );
      }
    );

    await refreshLive();

    setInterval(
      refreshLive,
      API_REFRESH_MS
    );

    setInterval(
      engineTick,
      ENGINE_TICK_MS
    );

  } catch (error) {

    console.error(
      "[START ERROR]",
      error
    );

    process.exit(1);
  }
}

process.on(
  "unhandledRejection",
  error => {
    console.error(
      "[UNHANDLED]",
      error
    );
  }
);

process.on(
  "uncaughtException",
  error => {
    console.error(
      "[UNCAUGHT]",
      error
    );
  }
);

start();
