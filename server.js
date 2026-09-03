const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 10000);
const ADMIN_KEY = process.env.ADMIN_KEY || "change-this-admin-key";
const TOKEN = process.env.WINGOBOT_TOKEN || "";
const API_URL = "https://api.wingobot.com/v2/30-sec-game-history";

const LIVE_LIMIT = 30;
const ROUND = 30;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});

const state = {
  history: [],
  settledIssue: null,
  targetIssue: null,
  analysis: null,
  version: 0,
  signature: "",
  updated: 0,
  anchor: 0,
  countdown: null,
  error: null
};


/* =====================================================
   DATABASE
===================================================== */

async function initDB() {
  if (!process.env.DATABASE_URL) {
    console.log("DATABASE_URL missing");
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
   HTTP HELPERS
===================================================== */

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });

  res.end(JSON.stringify(data));
}

function body(req) {
  return new Promise(resolve => {
    let b = "";

    req.on("data", x => b += x);

    req.on("end", () => {
      try {
        resolve(b ? JSON.parse(b) : {});
      } catch {
        resolve({});
      }
    });
  });
}


/* =====================================================
   BASIC HELPERS
===================================================== */

function issue(v) {
  return String(v || "").trim();
}

function bigSmall(n) {
  const x = Number(n);

  if (!Number.isFinite(x)) return null;

  return x >= 5 ? "BIG" : "SMALL";
}

function opposite(x) {
  return x === "BIG" ? "SMALL" : "BIG";
}

function compare(a, b) {
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

function nextIssue(v) {
  const s = issue(v);
  const m = s.match(/^(.*?)(\d+)$/);

  if (!m) return null;

  try {
    return (
      m[1] +
      (BigInt(m[2]) + 1n)
        .toString()
        .padStart(m[2].length, "0")
    );
  } catch {
    return null;
  }
}


/* =====================================================
   WINGOBOT
===================================================== */

async function getProvider() {
  if (!TOKEN) {
    throw new Error("WINGOBOT_TOKEN is not configured");
  }

  const r = await fetch(API_URL, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/json"
    }
  });

  if (!r.ok) {
    throw new Error(`WingoBot HTTP ${r.status}`);
  }

  return r.json();
}

function normalize(data) {
  const raw =
    Array.isArray(data?.history) ? data.history :
    Array.isArray(data?.data?.history) ? data.data.history :
    Array.isArray(data?.data) ? data.data :
    [];

  return raw
    .map(x => ({
      issueNumber: issue(
        x.issueNumber ??
        x.issue ??
        x.period
      ),

      number: Number(x.number),

      colour:
        x.colour ??
        x.color ??
        "",

      premium:
        x.premium ?? "",

      sum:
        x.sum ?? ""
    }))
    .filter(x =>
      x.issueNumber &&
      Number.isFinite(x.number)
    )
    .sort((a, b) =>
      compare(
        b.issueNumber,
        a.issueNumber
      )
    );
}

function providerCountdown(data) {
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

  for (const v of values) {
    const n = Number(v);

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
   AI MODELS
===================================================== */

function sequence(history, limit = 80) {
  return history
    .slice(0, limit)
    .map(x => bigSmall(x.number))
    .filter(Boolean);
}

function transitionModel(s) {
  if (s.length < 15) return null;

  const current = s[0];

  const vote = {
    BIG: 0,
    SMALL: 0
  };

  let matches = 0;

  for (let i = 1; i < s.length - 1; i++) {
    if (s[i] !== current) continue;

    const next = s[i - 1];

    if (!next) continue;

    const w = 1 / (1 + i * .08);

    vote[next] += w;
    matches++;
  }

  if (matches < 2) return null;

  const total =
    vote.BIG +
    vote.SMALL;

  return {
    name: "Transition",
    side:
      vote.BIG >= vote.SMALL
        ? "BIG"
        : "SMALL",
    strength:
      total
        ? Math.abs(
            vote.BIG -
            vote.SMALL
          ) / total
        : 0
  };
}

function sequenceModel(s) {
  if (s.length < 20) return null;

  const votes = {
    BIG: 0,
    SMALL: 0
  };

  let matches = 0;

  for (const len of [3, 4, 5]) {
    const pattern =
      s.slice(0, len).join("");

    for (
      let i = len + 1;
      i < s.length;
      i++
    ) {
      const old =
        s.slice(i, i + len).join("");

      if (old !== pattern) continue;

      const result = s[i - 1];

      if (!result) continue;

      const w = 1 / (1 + i * .08);

      votes[result] += w;
      matches++;
    }
  }

  if (matches < 2) return null;

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
        : 0
  };
}

function runModel(s) {
  if (s.length < 15) return null;

  let run = 1;

  while (
    run < s.length &&
    s[run] === s[0]
  ) {
    run++;
  }

  if (run < 2) return null;

  const current = s[0];

  let matched = 0;
  let reversed = 0;

  for (
    let i = 1;
    i < s.length - 1;
    i++
  ) {
    if (s[i] !== current) continue;

    let len = 1;

    while (
      i + len < s.length &&
      s[i + len] === current
    ) {
      len++;
    }

    if (len === run) {
      matched++;

      if (
        s[i - 1] !== current
      ) {
        reversed++;
      }
    }
  }

  if (matched < 2) return null;

  const rate =
    reversed / matched;

  return {
    name: "Run/Reversal",
    side:
      rate >= .60
        ? opposite(current)
        : current,
    strength:
      Math.abs(rate - .50) * 2
  };
}

function alternationModel(s) {
  if (s.length < 15) return null;

  const count =
    Math.min(10, s.length - 1);

  let changes = 0;

  for (let i = 0; i < count; i++) {
    if (s[i] !== s[i + 1]) {
      changes++;
    }
  }

  const rate =
    changes / count;

  if (rate < .70) return null;

  return {
    name: "Alternation",
    side: opposite(s[0]),
    strength: rate
  };
}

function recencyModel(s) {
  if (s.length < 15) return null;

  let big = 0;
  let small = 0;
  let used = 0;

  for (const size of [6, 10, 15, 25, 40]) {
    if (s.length < size) continue;

    let b = 0;
    let sm = 0;

    s.slice(0, size)
      .forEach((x, i) => {
        const w =
          1 / Math.sqrt(i + 1);

        if (x === "BIG") b += w;
        else sm += w;
      });

    if (
      Math.abs(b - sm) < .25
    ) {
      continue;
    }

    if (b > sm) {
      big += b - sm;
    } else {
      small += sm - b;
    }

    used++;
  }

  if (!used) return null;

  const total =
    big + small;

  return {
    name: "Recency",
    side:
      big >= small
        ? "BIG"
        : "SMALL",
    strength:
      total
        ? Math.abs(big - small) /
          total
        : 0
  };
}

function models(history) {
  const s = sequence(history);

  return [
    transitionModel(s),
    sequenceModel(s),
    runModel(s),
    alternationModel(s),
    recencyModel(s)
  ].filter(Boolean);
}


/* =====================================================
   WALK FORWARD BACKTEST
===================================================== */

function backtest(history, modelName) {
  if (history.length < 35) {
    return {
      tested: 0,
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
      chronological.length - 50
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
      bigSmall(
        chronological[i].number
      );

    if (!actual) continue;

    const m =
      models(training)
        .find(x =>
          x.name === modelName
        );

    if (!m) continue;

    if (m.side === actual) {
      wins++;
    } else {
      losses++;
    }
  }

  const tested =
    wins + losses;

  return {
    tested,
    accuracy:
      tested
        ? Math.round(
            wins * 1000 /
            tested
          ) / 10
        : null
  };
}


/* =====================================================
   ENSEMBLE
===================================================== */

function makePrediction(history) {
  const list =
    models(history);

  if (!list.length) {
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

  let big = 0;
  let small = 0;

  let testedTotal = 0;
  let accuracyTotal = 0;
  let accuracyModels = 0;

  const details = [];

  for (const m of list) {
    const bt =
      backtest(
        history,
        m.name
      );

    let weight = 1;

    if (
      bt.accuracy !== null &&
      bt.tested >= 8
    ) {
      weight =
        .75 +
        Math.max(
          0,
          bt.accuracy - 50
        ) * .025;

      weight =
        Math.min(
          1.5,
          weight
        );

      testedTotal +=
        bt.tested;

      accuracyTotal +=
        bt.accuracy;

      accuracyModels++;
    }

    const strength =
      Math.max(
        .10,
        Math.min(
          1,
          Number(m.strength) || 0
        )
      );

    const vote =
      weight *
      (.60 + strength * .40);

    if (m.side === "BIG") {
      big += vote;
    } else {
      small += vote;
    }

    details.push({
      name: m.name,
      side: m.side,
      strength:
        Math.round(
          strength * 100
        ),
      weight:
        Math.round(
          weight * 100
        ) / 100,
      tested: bt.tested,
      accuracy: bt.accuracy
    });
  }

  const total =
    big + small;

  const prediction =
    big >= small
      ? "BIG"
      : "SMALL";

  const agreement =
    details.filter(
      x =>
        x.side ===
        prediction
    ).length /
    details.length;

  const margin =
    total
      ? Math.abs(
          big - small
        ) / total
      : 0;

  const avgAccuracy =
    accuracyModels
      ? Math.round(
          (
            accuracyTotal /
            accuracyModels
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
      ) * .30;
  }

  confidence +=
    Math.max(
      0,
      agreement - .50
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
    agreement >= .60 &&
    margin >= .08 &&
    testedTotal >= 8
  ) {
    status =
      "ADAPTIVE SIGNAL";
  }

  if (
    agreement >= .75 &&
    margin >= .15 &&
    testedTotal >= 20 &&
    avgAccuracy !== null &&
    avgAccuracy >= 53
  ) {
    status =
      "STRONG STRUCTURAL SIGNAL";
  }

  if (testedTotal < 8) {
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
              agreement - .50
            ) * 20
          )
        )
      ),

    agreement:
      Math.round(
        agreement * 100
      ),

    backtestSamples:
      testedTotal,

    avgModelAccuracy:
      avgAccuracy,

    status,

    models: details
  };
}


/* =====================================================
   PREDICTION DB
===================================================== */

async function savePrediction(
  target,
  a
) {
  if (
    !process.env.DATABASE_URL ||
    !target ||
    !a?.prediction
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
      target,
      a.prediction,
      a.confidence,
      a.patternScore,
      Date.now()
    ]
  );
}

async function settle(row) {
  if (
    !process.env.DATABASE_URL ||
    !row?.issueNumber
  ) {
    return;
  }

  const actual =
    bigSmall(row.number);

  if (!actual) return;

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


/* =====================================================
   LAST 30 WIN LOSS
===================================================== */

async function winLoss() {
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

  const q =
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
    q.rows;

  const win =
    rows.filter(
      x =>
        x.result === "WIN"
    ).length;

  const loss =
    rows.filter(
      x =>
        x.result === "LOSS"
    ).length;

  return {
    rows,
    stats: {
      total: win + loss,
      win,
      loss,
      rate:
        win + loss
          ? Math.round(
              win * 1000 /
              (win + loss)
            ) / 10
          : 0
    }
  };
}


/* =====================================================
   UPDATE LIVE DATA
===================================================== */

async function update() {
  try {
    const data =
      await getProvider();

    const history =
      normalize(data);

    if (!history.length) {
      throw new Error(
        "No history received"
      );
    }

    const settled =
      history[0].issueNumber;

    const providerCurrent =
      issue(
        data?.current?.issueNumber
      );

    let target;

    if (
      providerCurrent &&
      compare(
        providerCurrent,
        settled
      ) > 0
    ) {
      target =
        providerCurrent;
    } else {
      target =
        nextIssue(settled);
    }

    const signature =
      history
        .slice(0, 10)
        .map(
          x =>
            `${x.issueNumber}:${x.number}`
        )
        .join("|");

    const changed =
      signature !==
      state.signature;

    /*
      FULL history remains in memory.
      Only API display is limited to 30.
    */
    state.history =
      history;

    state.settledIssue =
      settled;

    state.targetIssue =
      target;

    state.countdown =
      providerCountdown(data);

    state.updated =
      Date.now();

    state.error =
      null;

    if (changed) {
      state.signature =
        signature;

      state.version++;

      /*
        First settle the result that just arrived.
      */
      await settle(history[0]);

      /*
        AI uses FULL history.
      */
      state.analysis =
        makePrediction(history);

      /*
        Save prediction only for exact next period.
      */
      await savePrediction(
        target,
        state.analysis
      );

      state.anchor =
        Date.now();

      console.log(
        "NEW:",
        settled,
        "TARGET:",
        target,
        "PRED:",
        state.analysis?.prediction
      );
    }

  } catch (e) {
    state.error =
      e.message;

    console.log(
      "Provider error:",
      e.message
    );
  }
}


/* =====================================================
   TIMER
===================================================== */

function timing() {
  if (
    Number.isFinite(
      state.countdown
    )
  ) {
    return {
      seconds:
        Math.min(
          30,
          state.countdown
        ),
      exact: true
    };
  }

  if (!state.anchor) {
    return {
      seconds: 30,
      exact: false
    };
  }

  const elapsed =
    Math.floor(
      (Date.now() -
        state.anchor) /
      1000
    );

  let sec =
    ROUND -
    (
      elapsed %
      ROUND
    );

  if (sec === 0) {
    sec = ROUND;
  }

  return {
    seconds: sec,
    exact: false
  };
}


/* =====================================================
   ADMIN
===================================================== */

function admin(req) {
  return (
    req.headers["x-admin-key"] ===
    ADMIN_KEY
  );
}


/* =====================================================
   API ROUTES
===================================================== */

async function api(
  req,
  res,
  url
) {

  if (
    url.pathname ===
    "/health"
  ) {
    return json(
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
    req.method === "GET"
  ) {

    return json(
      res,
      200,
      {
        ok: true,

        /*
          Only latest 30 go to browser.
        */
        history:
          state.history.slice(
            0,
            LIVE_LIMIT
          ),

        settledIssue:
          state.settledIssue,

        targetIssue:
          state.targetIssue,

        historyVersion:
          state.version,

        lastUpdated:
          state.updated,

        timing:
          timing(),

        analysis:
          state.analysis,

        error:
          state.error
      }
    );
  }


  /* WIN LOSS */

  if (
    url.pathname ===
    "/api/history" &&
    req.method === "GET"
  ) {
    return json(
      res,
      200,
      await winLoss()
    );
  }


  /* ACCESS KEY */

  if (
    url.pathname ===
    "/api/key/check" &&
    req.method === "POST"
  ) {

    const d =
      await body(req);

    const key =
      String(
        d.key ||
        d.access_key ||
        ""
      ).trim();

    const device =
      String(
        req.headers["x-device-id"] ||
        d.device_id ||
        ""
      ).trim();

    if (
      !process.env.DATABASE_URL
    ) {
      return json(
        res,
        503,
        {
          ok: false,
          message:
            "Database not configured"
        }
      );
    }

    const q =
      await pool.query(
        `
        SELECT *
        FROM access_keys
        WHERE access_key = $1
        `,
        [key]
      );

    if (!q.rowCount) {
      return json(
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
      q.rows[0];

    if (
      row.device_id &&
      row.device_id !== device
    ) {
      return json(
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

    return json(
      res,
      200,
      {
        ok: true
      }
    );
  }


  /* ADMIN */

  if (
    !url.pathname.startsWith(
      "/api/admin/"
    )
  ) {
    return null;
  }

  if (!admin(req)) {
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
    url.pathname ===
    "/api/admin/ping"
  ) {
    return json(
      res,
      200,
      {
        ok: true,
        database:
          !!process.env.DATABASE_URL,
        provider:
          !!TOKEN,
        time:
          Date.now()
      }
    );
  }


  if (
    url.pathname ===
    "/api/admin/status"
  ) {
    return json(
      res,
      200,
      {
        ok: true,
        database:
          !!process.env.DATABASE_URL,
        wingobot:
          !!TOKEN,
        history:
          state.history.length,
        targetIssue:
          state.targetIssue,
        analysis:
          state.analysis
      }
    );
  }


  if (
    url.pathname ===
    "/api/admin/wingo-test"
  ) {
    try {
      const d =
        await getProvider();

      return json(
        res,
        200,
        {
          ok: true,
          current:
            d.current || null,
          history:
            normalize(d).slice(
              0,
              30
            )
        }
      );
    } catch (e) {
      return json(
        res,
        500,
        {
          ok: false,
          message:
            e.message
        }
      );
    }
  }


  if (
    url.pathname ===
    "/api/admin/model-test"
  ) {

    const a =
      makePrediction(
        state.history
      );

    return json(
      res,
      200,
      {
        ok: true,
        prediction:
          a.prediction,
        confidence:
          a.confidence,
        patternScore:
          a.patternScore,
        agreement:
          a.agreement,
        status:
          a.status,
        avgModelAccuracy:
          a.avgModelAccuracy,
        backtestSamples:
          a.backtestSamples,
        models:
          a.models
      }
    );
  }


  if (
    url.pathname ===
    "/api/admin/keys" &&
    req.method === "GET"
  ) {

    const q =
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
          q.rows
      }
    );
  }


  if (
    url.pathname ===
    "/api/admin/keys" &&
    req.method === "POST"
  ) {

    const d =
      await body(req);

    const count =
      Math.max(
        1,
        Math.min(
          100,
          Number(
            d.count || 1
          )
        )
      );

    const keys = [];

    for (
      let i = 0;
      i < count;
      i++
    ) {

      let done = false;

      while (!done) {

        const key =
          "DY-" +
          crypto
            .randomBytes(5)
            .toString("hex")
            .toUpperCase();

        const q =
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

        if (q.rowCount) {
          keys.push(key);
          done = true;
        }
      }
    }

    return json(
      res,
      200,
      {
        ok: true,
        keys
      }
    );
  }


  if (
    url.pathname ===
    "/api/admin/keys" &&
    req.method === "DELETE"
  ) {

    const d =
      await body(req);

    await pool.query(
      `
      DELETE FROM access_keys
      WHERE id = $1
      `,
      [d.id]
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
    "/api/admin/reset-device" &&
    req.method === "POST"
  ) {

    const d =
      await body(req);

    await pool.query(
      `
      UPDATE access_keys
      SET device_id = NULL
      WHERE id = $1
      `,
      [d.id]
    );

    return json(
      res,
      200,
      {
        ok: true
      }
    );
  }

  return null;
}


/* =====================================================
   STATIC FILES
===================================================== */

function staticFile(
  req,
  res,
  url
) {

  let file =
    url.pathname === "/"
      ? "/prediction.html"
      : url.pathname;

  if (file.includes("..")) {
    return json(
      res,
      400,
      { ok: false }
    );
  }

  const fp =
    path.join(
      __dirname,
      file
    );

  if (!fs.existsSync(fp)) {
    return json(
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
    path.extname(fp)
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

  if (ext === ".mp3") {

    const stat =
      fs.statSync(fp);

    const range =
      req.headers.range;

    if (range) {

      const m =
        range.match(
          /bytes=(\d+)-(\d*)/
        );

      if (m) {

        const start =
          Number(m[1]);

        let end =
          m[2]
            ? Number(m[2])
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
              fp,
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
      .createReadStream(fp)
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
    .createReadStream(fp)
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
          await api(
            req,
            res,
            url
          );

        if (
          handled !== null
        ) {
          return;
        }

        staticFile(
          req,
          res,
          url
        );

      } catch (e) {

        console.error(
          "SERVER ERROR:",
          e
        );

        json(
          res,
          500,
          {
            ok: false,
            message:
              e.message
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

    await initDB();

    await update();

    /*
      Provider check every second.
      AI prediction changes only when
      a new settled result is detected.
    */
    setInterval(
      update,
      1000
    );

    server.listen(
      PORT,
      () => {
        console.log(
          `DY AI running on ${PORT}`
        );
      }
    );

  } catch (e) {

    console.error(
      "START ERROR:",
      e
    );

    process.exit(1);
  }

})();
