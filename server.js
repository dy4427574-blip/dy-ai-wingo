const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 10000);
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_KEY = process.env.ADMIN_KEY || "dy4427574";
const WINGOBOT_TOKEN = process.env.WINGOBOT_TOKEN || "";

const API_URL =
  "https://api.wingobot.com/v2/30-sec-game-history";

const API_REFRESH_MS = 1000;
const ROUND_SECONDS = 30;

if (!DATABASE_URL) {
  console.error("DATABASE_URL is missing");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

const cache = {
  data: null,
  history: [],
  analysis: null,

  apiIssue: null,
  apiNumber: null,

  settledIssue: null,
  targetIssue: null,

  historySignature: "",
  historyVersion: 0,

  lastSuccessAt: 0,
  lastHistoryChangeAt: 0,

  anchorIssue: null,
  anchorTime: 0,

  fetching: false,
  error: null
};


/* =========================================================
   RESPONSE
========================================================= */

function json(res, code, obj) {
  const body = JSON.stringify(obj);

  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });

  res.end(body);
}


function sendFile(res, filename, contentType) {
  const filePath = path.join(__dirname, filename);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8"
      });

      return res.end("File not found");
    }

    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store"
    });

    res.end(data);
  });
}


/* =========================================================
   HELPERS
========================================================= */

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}


function bigSmall(number) {
  return Number(number) >= 5 ? "BIG" : "SMALL";
}


function nextIssue(issue, step = 1) {
  if (!issue) return null;

  const value = String(issue);

  const match = value.match(/^(.*?)(\d+)$/);

  if (!match) return null;

  const prefix = match[1];
  const digits = match[2];

  const next = (
    BigInt(digits) + BigInt(step)
  )
    .toString()
    .padStart(digits.length, "0");

  return prefix + next;
}


/* =========================================================
   HISTORY
========================================================= */

function cleanHistory(rows) {
  if (!Array.isArray(rows)) return [];

  return rows
    .filter(row =>
      row &&
      row.issueNumber != null &&
      row.number != null
    )
    .map(row => ({
      issueNumber: String(row.issueNumber),
      number: Number(row.number),
      colour: row.colour ?? null,
      premium: row.premium ?? null,
      sum: row.sum ?? null
    }))
    .filter(row =>
      Number.isFinite(row.number) &&
      row.number >= 0 &&
      row.number <= 9
    )
    .sort((a, b) =>
      String(b.issueNumber).localeCompare(
        String(a.issueNumber)
      )
    );
}


/* =========================================================
   BIG / SMALL PATTERN ENGINE
========================================================= */

function transitionScore(sequence) {
  if (sequence.length < 2) return 0;

  let same = 0;
  let flip = 0;

  for (let i = 0; i < sequence.length - 1; i++) {
    if (sequence[i] === sequence[i + 1]) {
      same++;
    } else {
      flip++;
    }
  }

  return (
    (flip - same) /
    Math.max(1, sequence.length - 1)
  );
}


function currentStreak(sequence) {
  if (!sequence.length) return 0;

  const first = sequence[0];
  let count = 1;

  for (let i = 1; i < sequence.length; i++) {
    if (sequence[i] === first) {
      count++;
    } else {
      break;
    }
  }

  return count;
}


/*
  Finds historical occurrences of the same recent
  BIG/SMALL sequence and checks what came next.

  This is sequence matching, not raw BIG/SMALL counting.
*/
function historicalPatternSignal(
  sequence,
  patternLength
) {
  if (
    sequence.length <
    patternLength + 2
  ) {
    return {
      big: 0,
      small: 0,
      matches: 0
    };
  }

  const recent =
    sequence
      .slice(0, patternLength)
      .join(",");

  let big = 0;
  let small = 0;
  let matches = 0;

  for (
    let i = patternLength + 1;
    i < sequence.length;
    i++
  ) {
    const pattern =
      sequence
        .slice(i, i + patternLength)
        .join(",");

    if (pattern !== recent) continue;

    const next =
      sequence[i - 1];

    /*
      More recent historical matches get
      more weight.
    */
    const weight =
      1 /
      (1 + i * 0.08);

    if (next === "BIG") {
      big += weight;
    } else {
      small += weight;
    }

    matches++;
  }

  return {
    big,
    small,
    matches
  };
}


/*
  Looks at what normally followed the current
  latest side in historical sequence positions.
*/
function transitionContext(sequence) {
  if (sequence.length < 4) {
    return {
      big: 0,
      small: 0,
      matches: 0
    };
  }

  const current =
    sequence[0];

  let big = 0;
  let small = 0;
  let matches = 0;

  for (
    let i = 1;
    i < sequence.length;
    i++
  ) {
    if (sequence[i] !== current) continue;

    const following =
      sequence[i - 1];

    const weight =
      1 /
      (1 + i * 0.10);

    if (following === "BIG") {
      big += weight;
    } else {
      small += weight;
    }

    matches++;
  }

  return {
    big,
    small,
    matches
  };
}


/*
  Historical run-context.
*/
function runContext(sequence) {
  const streak =
    currentStreak(sequence);

  if (streak < 2) {
    return {
      big: 0,
      small: 0,
      matches: 0
    };
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
    let len = 1;

    while (
      i + len < sequence.length &&
      sequence[i + len] ===
      sequence[i]
    ) {
      len++;
    }

    if (len >= streak) {
      const following =
        sequence[i - 1];

      const weight =
        1 /
        (1 + i * 0.10);

      if (following === "BIG") {
        big += weight;
      } else {
        small += weight;
      }

      matches++;
    }
  }

  return {
    big,
    small,
    matches
  };
}


/* =========================================================
   ANALYSIS
========================================================= */

function analyze(history, targetPeriod) {
  if (history.length < 10) {
    return {
      ready: false,
      targetPeriod,
      prediction: null,
      number: null,
      confidence: 0,
      patternScore: 0,
      sampleSize: history.length,
      modelStatus: "WAITING FOR HISTORY"
    };
  }

  const sequence =
    history.map(row =>
      bigSmall(row.number)
    );

  let bigScore = 0;
  let smallScore = 0;

  /*
    Exact sequence pattern matching.
  */
  const p3 =
    historicalPatternSignal(
      sequence,
      3
    );

  const p4 =
    historicalPatternSignal(
      sequence,
      4
    );

  const p5 =
    historicalPatternSignal(
      sequence,
      5
    );

  /*
    Pattern matches receive strong weight.
  */
  bigScore += p3.big * 1.20;
  smallScore += p3.small * 1.20;

  bigScore += p4.big * 1.45;
  smallScore += p4.small * 1.45;

  bigScore += p5.big * 1.70;
  smallScore += p5.small * 1.70;


  /*
    Transition context.
  */
  const transition =
    transitionContext(sequence);

  bigScore +=
    transition.big * 0.90;

  smallScore +=
    transition.small * 0.90;


  /*
    Historical run behaviour.
  */
  const runs =
    runContext(sequence);

  bigScore +=
    runs.big * 0.75;

  smallScore +=
    runs.small * 0.75;


  /*
    Recent sequence behaviour.
  */
  const recent5 =
    sequence.slice(0, 5);

  const recent10 =
    sequence.slice(0, 10);

  const recent20 =
    sequence.slice(0, 20);


  const t5 =
    transitionScore(recent5);

  const t10 =
    transitionScore(recent10);

  const t20 =
    transitionScore(recent20);


  /*
    Strong alternating behaviour.
  */
  if (t5 > 0.45) {
    if (sequence[0] === "BIG") {
      smallScore += 0.85;
    } else {
      bigScore += 0.85;
    }
  }


  /*
    Strong continuation behaviour.
  */
  if (t5 < -0.45) {
    if (sequence[0] === "BIG") {
      bigScore += 0.70;
    } else {
      smallScore += 0.70;
    }
  }


  /*
    Recent/medium agreement.
  */
  if (t10 > 0.35) {
    if (sequence[0] === "BIG") {
      smallScore += 0.40;
    } else {
      bigScore += 0.40;
    }
  }

  if (t10 < -0.35) {
    if (sequence[0] === "BIG") {
      bigScore += 0.40;
    } else {
      smallScore += 0.40;
    }
  }

  if (t20 > 0.35) {
    if (sequence[0] === "BIG") {
      smallScore += 0.25;
    } else {
      bigScore += 0.25;
    }
  }

  if (t20 < -0.35) {
    if (sequence[0] === "BIG") {
      bigScore += 0.25;
    } else {
      smallScore += 0.25;
    }
  }


  /*
    Current streak.
  */
  const streak =
    currentStreak(sequence);

  if (streak >= 4) {
    if (sequence[0] === "BIG") {
      smallScore +=
        0.70 +
        Math.min(
          0.50,
          (streak - 4) * 0.10
        );
    } else {
      bigScore +=
        0.70 +
        Math.min(
          0.50,
          (streak - 4) * 0.10
        );
    }
  }


  /*
    Micro ABA pattern.
  */
  if (
    sequence.length >= 3 &&
    sequence[0] === sequence[2] &&
    sequence[0] !== sequence[1]
  ) {
    if (sequence[0] === "BIG") {
      smallScore += 0.80;
    } else {
      bigScore += 0.80;
    }
  }


  /*
    AAA pattern.
  */
  if (
    sequence.length >= 3 &&
    sequence[0] === sequence[1] &&
    sequence[1] === sequence[2]
  ) {
    if (sequence[0] === "BIG") {
      bigScore += 0.35;
    } else {
      smallScore += 0.35;
    }
  }


  const difference =
    Math.abs(
      bigScore -
      smallScore
    );

  let prediction;

  if (bigScore > smallScore) {
    prediction = "BIG";
  } else if (smallScore > bigScore) {
    prediction = "SMALL";
  } else {
    prediction =
      sequence[0] === "BIG"
        ? "SMALL"
        : "BIG";
  }


  /*
    Signal agreement.
  */
  let agreement = 0;

  if (
    prediction === "BIG"
  ) {
    if (p3.big > p3.small) agreement++;
    if (p4.big > p4.small) agreement++;
    if (p5.big > p5.small) agreement++;
    if (transition.big > transition.small) agreement++;
    if (runs.big > runs.small) agreement++;
  } else {
    if (p3.small > p3.big) agreement++;
    if (p4.small > p4.big) agreement++;
    if (p5.small > p5.big) agreement++;
    if (transition.small > transition.big) agreement++;
    if (runs.small > runs.big) agreement++;
  }


  /*
    Confidence is signal strength only.
    It is NOT a probability of winning.
  */
  let confidence =
    51 +
    difference * 3 +
    agreement * 2;

  confidence =
    clamp(
      Math.round(confidence),
      51,
      72
    );


  const totalMatches =
    p3.matches +
    p4.matches +
    p5.matches +
    transition.matches +
    runs.matches;


  let patternScore =
    50 +
    difference * 4 +
    Math.min(
      25,
      totalMatches * 2
    );


  patternScore =
    clamp(
      Math.round(patternScore),
      50,
      90
    );


  let modelStatus;

  if (confidence >= 66) {
    modelStatus = "STRONG PATTERN";
  } else if (confidence >= 59) {
    modelStatus = "MODERATE PATTERN";
  } else {
    modelStatus = "LOW SIGNAL";
  }


  return {
    ready: true,

    targetPeriod,

    prediction,

    number: null,

    confidence,

    patternScore,

    sampleSize:
      history.length,

    streak,

    modelStatus,

    signalAgreement: {
      selected:
        agreement,

      total:
        5
    },

    matches: {
      pattern3:
        p3.matches,

      pattern4:
        p4.matches,

      pattern5:
        p5.matches,

      transition:
        transition.matches,

      runs:
        runs.matches
    },

    generatedFrom:
      history[0]?.issueNumber ||
      null
  };
}


/* =========================================================
   WINGOBOT
========================================================= */

async function fetchWingoBot() {
  if (!WINGOBOT_TOKEN) {
    throw new Error(
      "WINGOBOT_TOKEN is missing"
    );
  }

  const response =
    await fetch(
      API_URL,
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

  return await response.json();
}


/* =========================================================
   CACHE UPDATE
========================================================= */

async function updateCache(data) {
  const history =
    cleanHistory(
      data.history ||
      data.data ||
      data.results ||
      []
    );

  if (!history.length) {
    throw new Error(
      "WingoBot returned no history"
    );
  }

  const settledIssue =
    history[0].issueNumber;

  const signature =
    history
      .slice(0, 5)
      .map(row =>
        `${row.issueNumber}:${row.number}`
      )
      .join("|");

  const historyChanged =
    signature !==
    cache.historySignature;


  cache.data = data;
  cache.history = history;

  cache.apiIssue =
    data?.current?.issueNumber != null
      ? String(data.current.issueNumber)
      : null;

  cache.apiNumber =
    data?.current?.number ??
    null;

  cache.settledIssue =
    settledIssue;

  cache.targetIssue =
    nextIssue(
      settledIssue,
      1
    );

  cache.lastSuccessAt =
    Date.now();

  cache.error = null;


  /*
    CRITICAL:

    Only regenerate prediction when
    REAL settled history changes.
  */
  if (historyChanged) {

    cache.historySignature =
      signature;

    cache.historyVersion++;

    cache.lastHistoryChangeAt =
      Date.now();

    cache.anchorIssue =
      settledIssue;

    cache.anchorTime =
      Date.now();

    cache.analysis =
      analyze(
        history,
        cache.targetIssue
      );
  }
}


/* =========================================================
   REFRESH
========================================================= */

async function refreshWingo() {
  if (cache.fetching) return;

  cache.fetching = true;

  try {
    const data =
      await fetchWingoBot();

    await updateCache(data);

  } catch (error) {
    cache.error =
      error.message ||
      "WingoBot API error";
  } finally {
    cache.fetching = false;
  }
}


/* =========================================================
   TIMER
========================================================= */

function getTiming() {
  if (!cache.anchorTime) {
    return {
      countdown: null,
      estimated: true,
      status: "WAITING FOR SYNC"
    };
  }

  const elapsed =
    Math.floor(
      (Date.now() -
        cache.anchorTime) /
        1000
    );

  const countdown =
    Math.max(
      1,
      ROUND_SECONDS -
        (elapsed %
          ROUND_SECONDS)
    );

  return {
    countdown,
    estimated: true,
    status: "SYNCED / ESTIMATED",
    anchoredTo:
      cache.anchorIssue,
    anchorAge:
      elapsed
  };
}


/* =========================================================
   STATE
========================================================= */

function makeState() {
  const timing =
    getTiming();

  const analysis =
    cache.analysis;

  return {

    ok: true,

    serverTime:
      Date.now(),

    settledPeriod:
      cache.settledIssue,

    targetPeriod:
      cache.targetIssue,

    period:
      cache.targetIssue,

    countdown:
      timing.countdown,

    timing,

    prediction:
      analysis?.ready
        ? analysis.prediction
        : null,

    number: null,

    confidence:
      analysis?.ready
        ? analysis.confidence
        : 0,

    patternScore:
      analysis?.ready
        ? analysis.patternScore
        : 0,

    sampleSize:
      analysis?.sampleSize ||
      cache.history.length,

    analysisReady:
      !!analysis?.ready,

    modelStatus:
      analysis?.modelStatus ||
      "WAITING",

    predictionGeneratedFrom:
      analysis?.generatedFrom ||
      null,

    historyVersion:
      cache.historyVersion,

    latestResult:
      cache.history[0] ||
      null,

    history:
      cache.history.slice(0, 30),

    signalAgreement:
      analysis?.signalAgreement ||
      null,

    matches:
      analysis?.matches ||
      null,

    error:
      cache.error,

    note:
      "BIG/SMALL sequence analysis. Random outcomes are not guaranteed."
  };
}


/* =========================================================
   DATABASE
========================================================= */

async function ensureDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS access_keys (

      id SERIAL PRIMARY KEY,

      access_key TEXT UNIQUE NOT NULL,

      device_id TEXT,

      created_at BIGINT NOT NULL,

      last_seen BIGINT DEFAULT 0

    )
  `);
}


/* =========================================================
   KEY CHECK
========================================================= */

async function checkKey(
  accessKey,
  deviceId
) {
  if (!accessKey || !deviceId) {
    return {
      ok: false,
      message:
        "Missing key/device"
    };
  }

  const result =
    await pool.query(
      `
      SELECT *
      FROM access_keys
      WHERE access_key=$1
      LIMIT 1
      `,
      [accessKey]
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
        "Key already bound to another device"
    };
  }

  if (!row.device_id) {
    await pool.query(
      `
      UPDATE access_keys
      SET device_id=$1,
          last_seen=$2
      WHERE id=$3
      `,
      [
        deviceId,
        Date.now(),
        row.id
      ]
    );
  } else {
    await pool.query(
      `
      UPDATE access_keys
      SET last_seen=$1
      WHERE id=$2
      `,
      [
        Date.now(),
        row.id
      ]
    );
  }

  return {
    ok: true
  };
}


/* =========================================================
   ADMIN
========================================================= */

function adminOk(req, url) {
  const key =
    req.headers["x-admin-key"] ||
    url.searchParams.get("key") ||
    "";

  return key === ADMIN_KEY;
}


function readJsonBody(req) {
  return new Promise(
    (resolve, reject) => {

      let body = "";

      req.on("data", chunk => {

        body += chunk;

        if (
          body.length >
          1024 * 1024
        ) {
          req.destroy();
        }
      });

      req.on("end", () => {

        try {
          resolve(
            body
              ? JSON.parse(body)
              : {}
          );
        } catch {
          reject(
            new Error(
              "Invalid JSON"
            )
          );
        }
      });

      req.on(
        "error",
        reject
      );
    }
  );
}


async function handleAdminKeys(
  req,
  res,
  url
) {
  if (!adminOk(req, url)) {
    return json(
      res,
      401,
      {
        ok: false,
        message:
          "Unauthorized"
      }
    );
  }

  if (
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

    return json(
      res,
      200,
      {
        ok: true,
        keys:
          result.rows
      }
    );
  }

  if (
    req.method === "POST"
  ) {

    const body =
      await readJsonBody(req);

    const key =
      String(
        body.access_key ||
        body.key ||
        crypto
          .randomBytes(6)
          .toString("hex")
      );

    await pool.query(
      `
      INSERT INTO access_keys
      (
        access_key,
        created_at,
        last_seen
      )
      VALUES
      ($1,$2,0)
      `,
      [
        key,
        Date.now()
      ]
    );

    return json(
      res,
      200,
      {
        ok: true,
        access_key: key
      }
    );
  }

  if (
    req.method === "DELETE"
  ) {

    const body =
      await readJsonBody(req);

    const key =
      String(
        body.access_key ||
        body.key ||
        ""
      );

    await pool.query(
      `
      DELETE FROM access_keys
      WHERE access_key=$1
      `,
      [key]
    );

    return json(
      res,
      200,
      {
        ok: true
      }
    );
  }

  return json(
    res,
    405,
    {
      ok: false
    }
  );
}


/* =========================================================
   MUSIC
========================================================= */

function serveMp3(req, res) {
  const filePath =
    path.join(
      __dirname,
      "music.mp3"
    );

  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    return res.end();
  }

  const stat =
    fs.statSync(filePath);

  const size =
    stat.size;

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
          "bytes",

        "Cache-Control":
          "no-store"
      }
    );

    return fs
      .createReadStream(filePath)
      .pipe(res);
  }

  const match =
    range.match(
      /bytes=(\d*)-(\d*)/
    );

  if (!match) {
    res.writeHead(416);
    return res.end();
  }

  const start =
    match[1]
      ? Number(match[1])
      : 0;

  const end =
    match[2]
      ? Number(match[2])
      : size - 1;

  if (
    start >= size ||
    end >= size ||
    start > end
  ) {

    res.writeHead(
      416,
      {
        "Content-Range":
          `bytes */${size}`
      }
    );

    return res.end();
  }

  res.writeHead(
    206,
    {
      "Content-Type":
        "audio/mpeg",

      "Content-Range":
        `bytes ${start}-${end}/${size}`,

      "Content-Length":
        end - start + 1,

      "Accept-Ranges":
        "bytes",

      "Cache-Control":
        "no-store"
    }
  );

  fs
    .createReadStream(
      filePath,
      {
        start,
        end
      }
    )
    .pipe(res);
}


/* =========================================================
   ROUTER
========================================================= */

async function route(req, res) {

  const url =
    new URL(
      req.url,
      `http://${
        req.headers.host ||
        "localhost"
      }`
    );


  if (
    req.method === "OPTIONS"
  ) {

    res.writeHead(
      204,
      {
        "Access-Control-Allow-Origin":
          "*",

        "Access-Control-Allow-Headers":
          "Content-Type,X-Admin-Key,X-Device-ID",

        "Access-Control-Allow-Methods":
          "GET,POST,DELETE,OPTIONS"
      }
    );

    return res.end();
  }


  if (
    url.pathname ===
    "/health"
  ) {

    return json(
      res,
      200,
      {
        ok: true,
        time: Date.now(),
        wingo:
          !!cache.lastSuccessAt
      }
    );
  }


  if (
    url.pathname ===
    "/api/state"
  ) {

    return json(
      res,
      200,
      makeState()
    );
  }


  if (
    url.pathname ===
    "/api/history"
  ) {

    return json(
      res,
      200,
      {
        ok: true,

        settledPeriod:
          cache.settledIssue,

        history:
          cache.history
      }
    );
  }


  if (
    url.pathname ===
      "/api/key/check" &&
    req.method === "POST"
  ) {

    try {

      const body =
        await readJsonBody(req);

      const result =
        await checkKey(
          String(
            body.key || ""
          ),
          String(
            body.device_id ||
            req.headers[
              "x-device-id"
            ] ||
            ""
          )
        );

      return json(
        res,
        result.ok
          ? 200
          : 403,
        result
      );

    } catch (error) {

      return json(
        res,
        400,
        {
          ok: false,
          message:
            error.message
        }
      );
    }
  }


  if (
    url.pathname ===
    "/api/admin/keys"
  ) {

    return handleAdminKeys(
      req,
      res,
      url
    );
  }


  if (
    url.pathname ===
      "/api/admin/reset-device" &&
    req.method === "POST"
  ) {

    if (
      !adminOk(req, url)
    ) {

      return json(
        res,
        401,
        {
          ok: false
        }
      );
    }

    const body =
      await readJsonBody(req);

    await pool.query(
      `
      UPDATE access_keys
      SET device_id=NULL
      WHERE access_key=$1
      `,
      [
        String(
          body.key || ""
        )
      ]
    );

    return json(
      res,
      200,
      {
        ok: true
      }
    );
  }


  if (
    url.pathname ===
    "/api/admin/status"
  ) {

    if (
      !adminOk(req, url)
    ) {

      return json(
        res,
        401,
        {
          ok: false
        }
      );
    }

    return json(
      res,
      200,
      {
        ok: true,
        db: true,

        wingoLastSuccess:
          cache.lastSuccessAt,

        settledPeriod:
          cache.settledIssue,

        targetPeriod:
          cache.targetIssue,

        historyCount:
          cache.history.length,

        historyVersion:
          cache.historyVersion,

        error:
          cache.error
      }
    );
  }


  if (
    url.pathname ===
    "/api/admin/ping"
  ) {

    if (
      !adminOk(req, url)
    ) {

      return json(
        res,
        401,
        {
          ok: false
        }
      );
    }

    return json(
      res,
      200,
      {
        ok: true,
        pong: Date.now()
      }
    );
  }


  if (
    url.pathname ===
    "/api/admin/wingo-test"
  ) {

    if (
      !adminOk(req, url)
    ) {

      return json(
        res,
        401,
        {
          ok: false
        }
      );
    }

    try {

      const data =
        await fetchWingoBot();

      return json(
        res,
        200,
        {
          ok: true,

          current:
            data.current ||
            null,

          historyCount:
            Array.isArray(
              data.history
            )
              ? data.history.length
              : 0
        }
      );

    } catch (error) {

      return json(
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


  if (
    url.pathname === "/" ||
    url.pathname ===
      "/prediction.html"
  ) {

    return sendFile(
      res,
      "prediction.html",
      "text/html; charset=utf-8"
    );
  }


  if (
    url.pathname ===
    "/admin.html"
  ) {

    return sendFile(
      res,
      "admin.html",
      "text/html; charset=utf-8"
    );
  }


  if (
    url.pathname ===
    "/music.mp3"
  ) {

    return serveMp3(
      req,
      res
    );
  }


  return json(
    res,
    404,
    {
      ok: false,
      message:
        "Not found"
    }
  );
}


/* =========================================================
   START
========================================================= */

(async () => {

  try {

    await ensureDb();

    /*
      Initial sync.
    */
    await refreshWingo();


    /*
      Live API polling.
    */
    setInterval(
      refreshWingo,
      API_REFRESH_MS
    );


    const server =
      http.createServer(
        (req, res) => {

          route(req, res)
            .catch(error => {

              console.error(
                error
              );

              json(
                res,
                500,
                {
                  ok: false,
                  message:
                    "Server error"
                }
              );

            });

        }
      );


    server.listen(
      PORT,
      () => {

        console.log(
          `DY AI server running on ${PORT}`
        );

        console.log(
          "BIG/SMALL sequence engine active"
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
