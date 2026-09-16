const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 10000);
const DATABASE_URL = process.env.DATABASE_URL || "";
const ADMIN_KEY = process.env.ADMIN_KEY || "dy4427574";

const LIVE_API_URL = process.env.LIVE_API_URL || "";
const LIVE_API_TOKEN = process.env.LIVE_API_TOKEN || "";

const WINGOBOT_TOKEN = process.env.WINGOBOT_TOKEN || "";
const WINGOBOT_URL =
  "https://api.wingobot.com/v2/30-sec-game-history";

const POLL = 1000;
const COOLDOWN = 5;
const MODEL = "DY-AI-LIVE-V16";

if (!DATABASE_URL) {
  console.error("DATABASE_URL missing");
  process.exit(1);
}

const db = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* =========================
   DATABASE
========================= */

async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS access_keys(
      id SERIAL PRIMARY KEY,
      access_key TEXT UNIQUE NOT NULL,
      device_id TEXT,
      created_at BIGINT NOT NULL,
      last_seen BIGINT DEFAULT 0
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS prediction_records(
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

/* =========================
   HELPERS
========================= */

const now = () => Date.now();

function issue(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return /^\d+$/.test(s) ? s : null;
}

function cmp(a, b) {
  a = issue(a);
  b = issue(b);
  if (!a || !b) return null;
  if (a.length !== b.length) return a.length > b.length ? 1 : -1;
  return a === b ? 0 : a > b ? 1 : -1;
}

function nextIssue(v) {
  v = issue(v);
  if (!v) return null;

  const a = v.split("");
  let carry = 1;

  for (let i = a.length - 1; i >= 0; i--) {
    let n = Number(a[i]) + carry;
    if (n >= 10) {
      a[i] = "0";
      carry = 1;
    } else {
      a[i] = String(n);
      carry = 0;
      break;
    }
  }

  if (carry) a.unshift("1");
  return a.join("");
}

function distance(a, b) {
  a = issue(a);
  b = issue(b);
  if (!a || !b || a.length !== b.length) return null;

  try {
    return Number(BigInt(b) - BigInt(a));
  } catch {
    return null;
  }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function bs(n) {
  n = num(n);
  if (n === null || n < 0 || n > 9) return null;
  return n >= 5 ? "BIG" : "SMALL";
}

function avg(a) {
  return a.length
    ? a.reduce((x, y) => x + y, 0) / a.length
    : 0;
}

function pct(a, b) {
  return b ? (a / b) * 100 : 0;
}

/* =========================
   HTTP
========================= */

function json(res, code, data) {
  const body = JSON.stringify(data);

  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "Content-Type,X-Access-Key,X-Device-Id,X-Admin-Key",
    "Access-Control-Allow-Methods":
      "GET,POST,DELETE,OPTIONS"
  });

  res.end(body);
}

function getJSON(url, headers = {}) {
  return new Promise((resolve, reject) => {
    let u;

    try {
      u = new URL(url);
    } catch {
      return reject(new Error("INVALID_URL"));
    }

    const client = u.protocol === "https:" ? https : http;

    const req = client.get(
      u,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": "DY-AI-LIVE/16.0",
          ...headers
        }
      },
      r => {
        let body = "";

        r.setEncoding("utf8");

        r.on("data", x => {
          body += x;
          if (body.length > 15e6) {
            req.destroy();
            reject(new Error("RESPONSE_TOO_LARGE"));
          }
        });

        r.on("end", () => {
          if (r.statusCode < 200 || r.statusCode >= 300) {
            return reject(
              new Error("HTTP_" + r.statusCode)
            );
          }

          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error("INVALID_JSON"));
          }
        });
      }
    );

    req.setTimeout(8000, () => {
      req.destroy();
      reject(new Error("API_TIMEOUT"));
    });

    req.on("error", reject);
  });
}

/* =========================
   NORMALIZE API
========================= */

function normalizeRow(x) {
  if (!x || typeof x !== "object") return null;

  const id = issue(
    x.issueNumber ??
    x.issue ??
    x.period ??
    x.periodId ??
    x.periodID ??
    x.drawNumber ??
    x.draw ??
    x.id
  );

  const n = num(
    x.number ??
    x.resultNumber ??
    x.result ??
    x.winNumber ??
    x.digit ??
    x.openNumber
  );

  if (!id || n === null || n < 0 || n > 9) return null;

  return {
    issue: id,
    number: n,
    result: bs(n)
  };
}

function arrays(payload) {
  if (Array.isArray(payload)) return [payload];

  if (!payload || typeof payload !== "object") return [];

  return [
    payload.history,
    payload.results,
    payload.records,
    payload.list,
    payload.rows,
    payload.data,
    payload.data?.history,
    payload.data?.results,
    payload.data?.records,
    payload.data?.list,
    payload.result?.history,
    payload.result?.results,
    payload.result?.records,
    payload.result?.list
  ].filter(Array.isArray);
}

function rowsFrom(payload) {
  for (const a of arrays(payload)) {
    const out = a.map(normalizeRow).filter(Boolean);
    if (out.length) return clean(out);
  }

  return [];
}

function clean(rows) {
  const m = new Map();

  for (const r of rows) {
    if (r.issue) m.set(r.issue, r);
  }

  return [...m.values()].sort(
    (a, b) => cmp(a.issue, b.issue)
  );
}

function currentFrom(payload) {
  const a = [
    payload?.current?.issueNumber,
    payload?.current?.issue,
    payload?.currentIssue,
    payload?.current_issue,
    payload?.data?.current?.issueNumber,
    payload?.data?.current?.issue
  ];

  for (const x of a) {
    const i = issue(x);
    if (i) return i;
  }

  return null;
}

/* =========================
   LIVE SOURCE
========================= */

const live = {
  source: "NONE",
  current: null,
  rows: [],
  fetched: 0,
  error: null
};

async function customAPI() {
  if (!LIVE_API_URL)
    throw new Error("LIVE_API_URL_NOT_CONFIGURED");

  const headers = {};

  if (LIVE_API_TOKEN) {
    headers.Authorization =
      "Bearer " + LIVE_API_TOKEN;
  }

  const p = await getJSON(
    LIVE_API_URL,
    headers
  );

  const rows = rowsFrom(p);

  let current = currentFrom(p);

  if (!current && rows.length)
    current = nextIssue(rows.at(-1).issue);

  return {
    source: "LOTTERY7_LIVE_API",
    current,
    rows
  };
}

async function wingoAPI() {
  if (!WINGOBOT_TOKEN)
    throw new Error("WINGOBOT_TOKEN_NOT_CONFIGURED");

  const p = await getJSON(
    WINGOBOT_URL,
    {
      Authorization:
        "Bearer " + WINGOBOT_TOKEN
    }
  );

  const rows = rowsFrom(p);

  let current = currentFrom(p);

  if (!current && rows.length)
    current = nextIssue(rows.at(-1).issue);

  return {
    source: "WINGOBOT",
    current,
    rows
  };
}

async function refresh() {
  let data = null;

  if (LIVE_API_URL) {
    try {
      data = await customAPI();
    } catch (e) {
      live.error = "LIVE_API: " + e.message;
    }
  }

  if (!data && WINGOBOT_TOKEN) {
    try {
      data = await wingoAPI();
    } catch (e) {
      live.error = "WINGOBOT: " + e.message;
    }
  }

  if (!data || !data.rows.length) return;

  live.source = data.source;
  live.current = data.current;
  live.rows = data.rows;
  live.fetched = now();
  live.error = null;
}

/* =========================
   ANALYSIS
========================= */

function streak(s) {
  if (!s.length) return { side: null, length: 0 };

  const side = s.at(-1);
  let n = 1;

  for (let i = s.length - 2; i >= 0; i--) {
    if (s[i] !== side) break;
    n++;
  }

  return { side, length: n };
}

function runs(s, side) {
  const a = [];
  let n = 0;

  for (const x of s) {
    if (x === side) n++;
    else if (n) {
      a.push(n);
      n = 0;
    }
  }

  if (n) a.push(n);

  return a;
}

function matrix(s) {
  const m = {
    BIG: { BIG: 0, SMALL: 0 },
    SMALL: { BIG: 0, SMALL: 0 }
  };

  for (let i = 1; i < s.length; i++)
    m[s[i - 1]][s[i]]++;

  return m;
}

function trans(m, from, to) {
  const total =
    m[from].BIG +
    m[from].SMALL;

  return pct(m[from][to], total);
}

function analyze(rows) {
  const s = rows.map(x => x.result);

  if (s.length < 10) {
    return {
      prediction: null,
      confidence: 0,
      signal: "INSUFFICIENT DATA"
    };
  }

  const w5 = s.slice(-5);
  const w10 = s.slice(-10);
  const w20 = s.slice(-20);
  const w30 = s.slice(-30);
  const w50 = s.slice(-50);

  const count = a => ({
    big: a.filter(x => x === "BIG").length,
    small: a.filter(x => x === "SMALL").length
  });

  const c5 = count(w5);
  const c10 = count(w10);
  const c20 = count(w20);
  const c30 = count(w30);
  const c50 = count(w50);

  const st = streak(s);

  const bigRuns = runs(s, "BIG");
  const smallRuns = runs(s, "SMALL");

  const bm = avg(bigRuns);
  const sm = avg(smallRuns);

  const mAll = matrix(s);
  const m20 = matrix(w20);

  let B = 0;
  let S = 0;

  /* Recent 5/10/20/30 */
  B += pct(c5.big, 5) * 0.20;
  S += pct(c5.small, 5) * 0.20;

  B += pct(c10.big, 10) * 0.15;
  S += pct(c10.small, 10) * 0.15;

  B += pct(c20.big, 20) * 0.10;
  S += pct(c20.small, 20) * 0.10;

  B += pct(c30.big, 30) * 0.10;
  S += pct(c30.small, 30) * 0.10;

  /* Frequency */
  B += pct(c50.big, 50) * 0.15;
  S += pct(c50.small, 50) * 0.15;

  /* Streak structure */
  if (st.side === "BIG") {
    if (st.length <= bm + 0.5) B += 7;
    else S += 7;
  }

  if (st.side === "SMALL") {
    if (st.length <= sm + 0.5) S += 7;
    else B += 7;
  }

  /* Switching */
  let switches = 0;

  for (let i = 1; i < w30.length; i++)
    if (w30[i] !== w30[i - 1]) switches++;

  const switchRate =
    pct(switches, Math.max(1, w30.length - 1));

  if (switchRate >= 60) {
    if (st.side === "BIG") S += 6;
    else B += 6;
  } else if (switchRate < 40) {
    if (st.side === "BIG") B += 5;
    else S += 5;
  }

  /* Transition */
  if (st.side) {
    B += trans(
      m20,
      st.side,
      "BIG"
    ) * 0.12;

    S += trans(
      m20,
      st.side,
      "SMALL"
    ) * 0.12;
  }

  /* Momentum */
  const recentBig =
    pct(
      w5.filter(x => x === "BIG").length,
      5
    );

  const oldBig =
    pct(
      s.slice(-10, -5)
        .filter(x => x === "BIG").length,
      5
    );

  const delta =
    recentBig - oldBig;

  if (delta >= 20) {
    B += 6;
    S += 2;
  } else if (delta <= -20) {
    S += 6;
    B += 2;
  }

  /* Reversal pressure */
  if (st.length >= 4) {
    if (st.side === "BIG") S += 5;
    else B += 5;
  }

  if (c5.big >= 4) {
    S += 3;
    B -= 1;
  }

  if (c5.small >= 4) {
    B += 3;
    S -= 1;
  }

  const total = Math.max(1, B + S);

  let bp = (B / total) * 100;
  let sp = (S / total) * 100;

  bp = Math.max(0, Math.min(100, bp));
  sp = Math.max(0, Math.min(100, sp));

  const diff = Math.abs(bp - sp);

  let confidence =
    Math.round(
      Math.max(
        50,
        Math.min(
          94,
          50 + diff * 0.9
        )
      )
    );

  let prediction = null;

  if (diff >= 6 && confidence >= 55) {
    prediction =
      bp >= sp
        ? "BIG"
        : "SMALL";
  }

  let signal = "NO CLEAR SIGNAL";

  if (diff < 6)
    signal = "MIXED / CONFLICTING";
  else if (diff < 12)
    signal = "WEAK HISTORICAL BIAS";
  else if (diff < 25)
    signal = "MODERATE HISTORICAL BIAS";
  else
    signal = "STRONG HISTORICAL BIAS";

  return {
    prediction,
    confidence,
    signal,

    scores: {
      BIG: Number(bp.toFixed(2)),
      SMALL: Number(sp.toFixed(2))
    },

    streak: st,

    switchRate:
      Number(switchRate.toFixed(2)),

    momentum: {
      recentBig,
      previousBig: oldBig,
      delta
    },

    transition: mAll,

    sample: s.length,

    generatedAt: now()
  };
}

/* =========================
   PREDICTION DB
========================= */

async function pending() {
  const r = await db.query(`
    SELECT *
    FROM prediction_records
    WHERE actual_result IS NULL
    ORDER BY id DESC
    LIMIT 1
  `);

  return r.rows[0] || null;
}

async function latestPrediction() {
  const r = await db.query(`
    SELECT *
    FROM prediction_records
    ORDER BY id DESC
    LIMIT 1
  `);

  return r.rows[0] || null;
}

async function settle(rows) {
  const p = await pending();
  if (!p) return;

  const found =
    rows.find(x => x.issue === p.target_issue);

  if (!found) return;

  const actual = found.result;

  const outcome =
    actual === p.prediction
      ? "WIN"
      : "LOSS";

  await db.query(
    `
    UPDATE prediction_records
    SET
      actual_number=$1,
      actual_result=$2,
      settled_at=$3
    WHERE id=$4
      AND actual_result IS NULL
    `,
    [
      found.number,
      outcome,
      now(),
      p.id
    ]
  );
}

async function skipOld(latestIssue) {
  const p = await pending();
  if (!p) return;

  const d =
    distance(
      p.target_issue,
      latestIssue
    );

  if (d !== null && d >= 0) {
    await db.query(
      `
      UPDATE prediction_records
      SET
        actual_result='SKIPPED',
        settled_at=$1
      WHERE id=$2
        AND actual_result IS NULL
      `,
      [
        now(),
        p.id
      ]
    );
  }
}

async function cooldown(latestIssue) {
  const p =
    await latestPrediction();

  if (!p || !p.actual_result) {
    return {
      active: false,
      completed: 0,
      remaining: 0
    };
  }

  if (p.actual_result === "SKIPPED") {
    return {
      active: false,
      completed: 0,
      remaining: 0
    };
  }

  const d =
    distance(
      p.target_issue,
      latestIssue
    );

  if (d === null || d < 0) {
    return {
      active: false,
      completed: 0,
      remaining: 0
    };
  }

  return {
    active: d < COOLDOWN,
    completed: d,
    remaining: Math.max(0, COOLDOWN - d)
  };
}

/* =========================
   MODEL WORKER
========================= */

let busy = false;

const runtime = {
  analysis: null,
  analysisAt: 0,
  predictionIssue: null
};

async function modelWorker() {
  if (busy) return;

  busy = true;

  try {
    const rows = live.rows;

    if (!rows.length) return;

    const latest = rows.at(-1);

    await settle(rows);
    await skipOld(latest.issue);

    const p = await pending();

    if (p) return;

    const cd =
      await cooldown(
        latest.issue
      );

    if (cd.active) return;

    const analysis =
      analyze(rows);

    runtime.analysis =
      analysis;

    runtime.analysisAt =
      now();

    if (!analysis.prediction) return;

    const target =
      nextIssue(
        latest.issue
      );

    if (!target) return;

    const duplicate =
      await db.query(
        `
        SELECT id
        FROM prediction_records
        WHERE target_issue=$1
        LIMIT 1
        `,
        [target]
      );

    if (duplicate.rows.length)
      return;

    await db.query(
      `
      INSERT INTO prediction_records
      (
        target_issue,
        prediction,
        confidence,
        model_version,
        created_at
      )
      VALUES($1,$2,$3,$4,$5)
      `,
      [
        target,
        analysis.prediction,
        analysis.confidence,
        MODEL,
        now()
      ]
    );

    runtime.predictionIssue =
      target;

    console.log(
      "PREDICTION:",
      target,
      analysis.prediction,
      analysis.confidence + "%"
    );

  } catch (e) {
    console.error(
      "MODEL:",
      e.message
    );
  } finally {
    busy = false;
  }
}

/* =========================
   ACCESS KEY
========================= */

async function auth(req) {
  const key =
    String(
      req.headers["x-access-key"] || ""
    ).trim();

  const device =
    String(
      req.headers["x-device-id"] || ""
    ).trim();

  if (!key)
    return {
      ok: false,
      error: "ACCESS_KEY_REQUIRED"
    };

  if (!device)
    return {
      ok: false,
      error: "DEVICE_ID_REQUIRED"
    };

  const r =
    await db.query(
      `
      SELECT *
      FROM access_keys
      WHERE access_key=$1
      LIMIT 1
      `,
      [key]
    );

  const k = r.rows[0];

  if (!k)
    return {
      ok: false,
      error: "INVALID_ACCESS_KEY"
    };

  if (!k.device_id) {
    await db.query(
      `
      UPDATE access_keys
      SET device_id=$1,last_seen=$2
      WHERE id=$3
      `,
      [
        device,
        now(),
        k.id
      ]
    );

    return { ok: true };
  }

  if (
    String(k.device_id) !==
    device
  ) {
    return {
      ok: false,
      error: "DEVICE_MISMATCH"
    };
  }

  await db.query(
    `
    UPDATE access_keys
    SET last_seen=$1
    WHERE id=$2
    `,
    [
      now(),
      k.id
    ]
  );

  return { ok: true };
}

function admin(req) {
  return (
    String(
      req.headers["x-admin-key"] || ""
    ) === ADMIN_KEY
  );
}

/* =========================
   STATE
========================= */

async function state() {
  const rows = live.rows;
  const last = rows.at(-1) || null;

  if (last) {
    await settle(rows);
    await skipOld(last.issue);
  }

  const p = await pending();

  const cd =
    await cooldown(
      last?.issue || null
    );

  const predictions =
    await db.query(`
      SELECT *
      FROM prediction_records
      ORDER BY id DESC
      LIMIT 200
    `);

  const map = new Map();

  for (const x of predictions.rows)
    map.set(
      String(x.target_issue),
      x
    );

  const history =
    rows
      .slice(-30)
      .reverse()
      .map(x => {
        const p =
          map.get(
            String(x.issue)
          );

        return {
          issue: x.issue,
          number: x.number,
          result: x.result,
          prediction:
            p?.prediction || null,
          confidence:
            p
              ? Number(p.confidence || 0)
              : null,
          outcome:
            p?.actual_result || null
        };
      });

  return {
    ok: true,

    source: {
      name: live.source,
      currentIssue:
        live.current ||
        (last
          ? nextIssue(last.issue)
          : null),
      latestIssue:
        last?.issue || null,
      latestNumber:
        last?.number ?? null,
      latestResult:
        last?.result || null,
      fetchedAt: live.fetched,
      ageMs:
        live.fetched
          ? now() - live.fetched
          : null,
      error: live.error,
      healthy:
        Boolean(live.fetched)
    },

    model: {
      prediction:
        p?.prediction || null,

      targetIssue:
        p?.target_issue || null,

      confidence:
        p
          ? Number(p.confidence || 0)
          : 0,

      status:
        p
          ? "PREDICTION_READY"
          : cd.active
            ? "WAITING"
            : "ANALYSING",

      signal:
        runtime.analysis?.signal ||
        null,

      analysis:
        runtime.analysis || null,

      version: MODEL
    },

    cooldown: cd,

    history
  };
}

/* =========================
   FRONTEND
========================= */

const HTML = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport"
content="width=device-width,initial-scale=1">

<title>DY AI WinGo</title>

<style>
*{box-sizing:border-box}
body{
 margin:0;
 background:#05080d;
 color:white;
 font-family:Arial,sans-serif
}
.wrap{
 max-width:720px;
 margin:auto;
 padding:12px
}
.card{
 background:linear-gradient(145deg,#10151d,#070a0f);
 border:1px solid #27313d;
 border-radius:24px;
 padding:20px;
 margin-bottom:14px;
 box-shadow:0 0 25px #0008
}
.logo{
 font-size:28px;
 font-weight:900;
 letter-spacing:2px
}
.logo b{color:#ff9841}
.sub{
 color:#687486;
 letter-spacing:4px;
 font-size:10px;
 margin-top:7px
}
.center{text-align:center}
.label{
 color:#687486;
 font-size:11px;
 letter-spacing:3px
}
.period-title{
 color:#6d798b;
 font-size:10px;
 letter-spacing:2px;
 margin-top:20px
}
.period{
 margin-top:7px;
 font-weight:900;
 font-size:17px;
 word-break:break-all
}
.pred{
 margin:20px 0 8px;
 font-size:52px;
 font-weight:1000;
 letter-spacing:3px
}
.big{
 color:#ff9841;
 text-shadow:0 0 20px #ff9841
}
.small{
 color:#58a8ff;
 text-shadow:0 0 20px #58a8ff
}
.wait{color:#758194}
.conf{font-weight:bold}
.signal{
 color:#788496;
 font-size:11px;
 margin-top:10px
}
.grid{
 display:grid;
 grid-template-columns:repeat(3,1fr);
 gap:9px;
 margin-top:15px
}
.box{
 background:#080c12;
 border:1px solid #232d39;
 border-radius:16px;
 padding:13px 6px;
 text-align:center
}
.box small{
 display:block;
 color:#657184;
 font-size:8px;
 letter-spacing:1px;
 margin-bottom:8px
}
.box strong{
 font-size:12px;
 word-break:break-all
}
.online{color:#4ee38a}
.offline{color:#ff6262}
.head,.row{
 display:grid;
 grid-template-columns:1.65fr .55fr .7fr .5fr;
 gap:5px;
 padding:12px 5px;
 border-bottom:1px solid #18202a;
 font-size:10px;
 align-items:center
}
.head{
 color:#687486;
 font-size:8px
}
.row:last-child{border:0}
.issue{word-break:break-all}
.rb{color:#ff9841}
.rs{color:#58a8ff}
.win{color:#4ee38a;font-weight:bold}
.loss{color:#ff6262;font-weight:bold}
.skip{color:#7c8796}
.login input{
 width:100%;
 background:#080c12;
 color:white;
 border:1px solid #303b49;
 padding:15px;
 border-radius:14px;
 outline:none
}
button{
 width:100%;
 border:0;
 padding:15px;
 border-radius:14px;
 margin-top:10px;
 background:#ff9841;
 font-weight:900
}
#app{display:none}
</style>
</head>

<body>
<div class="wrap">

<div class="card">
 <div class="logo">DY <b>AI</b> WinGo</div>
 <div class="sub">30 SECOND ANALYSIS ENGINE</div>
</div>

<div id="login" class="card center">
 <h3>ACCESS KEY</h3>
 <input id="key" placeholder="Enter access key">
 <button onclick="login()">ENTER</button>
 <p id="msg"></p>
</div>

<div id="app">

<div class="card center">
 <div class="label">NEXT PREDICTION</div>

 <div class="period-title">
 PREDICTION PERIOD ID
 </div>

 <div id="target" class="period">--</div>

 <div id="pred" class="pred wait">--</div>

 <div id="conf" class="conf">
 Confidence --
 </div>

 <div id="signal" class="signal">
 Waiting for analysis
 </div>
</div>

<div class="card">
 <h3>LIVE RESULT</h3>

 <div class="grid">

  <div class="box">
   <small>CURRENT ISSUE</small>
   <strong id="current">--</strong>
  </div>

  <div class="box">
   <small>LAST NUMBER</small>
   <strong id="number">--</strong>
  </div>

  <div class="box">
   <small>RESULT</small>
   <strong id="result">--</strong>
  </div>

 </div>

 <p id="connection" class="center">
 Connecting...
 </p>
</div>

<div class="card">
 <div style="display:flex;justify-content:space-between">
  <h3>LIVE HISTORY</h3>
  <span style="color:#687486">LAST 30</span>
 </div>

 <div class="head">
  <div>ISSUE</div>
  <div>NUMBER</div>
  <div>RESULT</div>
  <div>W/L</div>
 </div>

 <div id="history"></div>
</div>

</div>
</div>

<script>
let key =
 localStorage.getItem("dy_key") || "";

let device =
 localStorage.getItem("dy_device");

if(!device){
 device =
  crypto.randomUUID ?
  crypto.randomUUID() :
  "d-"+Date.now()+"-"+Math.random();

 localStorage.setItem(
  "dy_device",
  device
 );
}

const $ = id =>
 document.getElementById(id);

let lastTarget = null;

async function login(){
 const k =
  $("key").value.trim();

 if(!k){
  $("msg").textContent =
   "Enter access key";
  return;
 }

 try{
  const r =
   await fetch(
    "/api/key/check",
    {
     headers:{
      "X-Access-Key":k,
      "X-Device-Id":device
     },
     cache:"no-store"
    }
   );

  const d =
   await r.json();

  if(!d.ok){
   $("msg").textContent =
    d.error || "Access denied";
   return;
  }

  key=k;

  localStorage.setItem(
   "dy_key",
   key
  );

  $("login").style.display="none";
  $("app").style.display="block";

  load();

 }catch(e){
  $("msg").textContent =
   "Server error";
 }
}

async function autoLogin(){
 if(!key)return;

 try{
  const r =
   await fetch(
    "/api/key/check",
    {
     headers:{
      "X-Access-Key":key,
      "X-Device-Id":device
     },
     cache:"no-store"
    }
   );

  const d =
   await r.json();

  if(d.ok){
   $("login").style.display="none";
   $("app").style.display="block";
   load();
  }
 }catch(e){}
}

async function load(){
 try{
  const r =
   await fetch(
    "/api/state?t="+Date.now(),
    {
     headers:{
      "X-Access-Key":key,
      "X-Device-Id":device
     },
     cache:"no-store"
    }
   );

  const d =
   await r.json();

  if(!d.ok)return;

  const s=d.source||{};
  const m=d.model||{};

  $("current").textContent =
   s.currentIssue || "--";

  $("number").textContent =
   s.latestNumber ?? "--";

  $("result").textContent =
   s.latestResult || "--";

  $("target").textContent =
   m.targetIssue || "--";

  if(m.prediction==="BIG"){
   $("pred").textContent="BIG";
   $("pred").className="pred big";
  }
  else if(m.prediction==="SMALL"){
   $("pred").textContent="SMALL";
   $("pred").className="pred small";
  }
  else{
   $("pred").textContent="--";
   $("pred").className="pred wait";
  }

  $("conf").textContent =
   m.prediction ?
   "Confidence "+m.confidence+"%" :
   "Confidence --";

  $("signal").textContent =
   m.signal ||
   "Waiting for analysis";

  const age=s.ageMs;

  if(
   s.healthy &&
   (age===null || age<5000)
  ){
   $("connection").textContent =
    "● LIVE • "+(s.name||"API");

   $("connection").className =
    "center online";
  }
  else if(s.healthy){
   $("connection").textContent =
    "API connected • updating";

   $("connection").className =
    "center";
  }
  else{
   $("connection").textContent =
    "Waiting for live API";

   $("connection").className =
    "center offline";
  }

  renderHistory(
   d.history||[]
  );

 }catch(e){
  $("connection").textContent =
   "Connection error";
 }
}

function renderHistory(a){
 $("history").innerHTML =
  a.map(x=>{

   const rc =
    x.result==="BIG" ?
    "rb" :
    "rs";

   let out="--";
   let oc="";

   if(x.outcome==="WIN"){
    out="WIN";
    oc="win";
   }

   if(x.outcome==="LOSS"){
    out="LOSS";
    oc="loss";
   }

   if(x.outcome==="SKIPPED"){
    out="SKIP";
    oc="skip";
   }

   return \`
    <div class="row">
     <div class="issue">\${esc(x.issue)}</div>
     <div>\${x.number ?? "--"}</div>
     <div class="\${rc}">
      \${x.result || "--"}
     </div>
     <div class="\${oc}">
      \${out}
     </div>
    </div>
   \`;
  }).join("");
}

function esc(x){
 return String(x)
  .replace(/&/g,"&amp;")
  .replace(/</g,"&lt;")
  .replace(/>/g,"&gt;")
  .replace(/"/g,"&quot;")
  .replace(/'/g,"&#039;");
}

setInterval(()=>{
 if(key)load();
},1000);

autoLogin();
</script>
</body>
</html>
`;

/* =========================
   SERVER
========================= */

const server =
  http.createServer(
    async (req, res) => {

      try {

        if(req.method === "OPTIONS"){
          res.writeHead(204,{
            "Access-Control-Allow-Origin":"*",
            "Access-Control-Allow-Headers":
              "Content-Type,X-Access-Key,X-Device-Id,X-Admin-Key",
            "Access-Control-Allow-Methods":
              "GET,POST,DELETE,OPTIONS"
          });
          return res.end();
        }

        const u =
          new URL(
            req.url,
            "http://" +
            (req.headers.host || "localhost")
          );

        const p=u.pathname;

        /* HOME */

        if(p === "/" || p === "/prediction.html"){
          res.writeHead(200,{
            "Content-Type":
              "text/html; charset=utf-8",
            "Cache-Control":"no-cache"
          });

          return res.end(HTML);
        }

        /* HEALTH */

        if(p === "/health"){
          return json(res,200,{
            ok:true,
            model:MODEL,
            source:live.source,
            currentIssue:live.current,
            latestIssue:
              live.rows.at(-1)?.issue || null,
            rows:live.rows.length
          });
        }

        /* KEY CHECK */

        if(
          p === "/api/key/check" &&
          req.method === "GET"
        ){
          const a =
            await auth(req);

          return json(
            res,
            a.ok ? 200 : 401,
            a
          );
        }

        /* STATE */

        if(
          p === "/api/state" &&
          req.method === "GET"
        ){
          const a =
            await auth(req);

          if(!a.ok)
            return json(res,401,a);

          return json(
            res,
            200,
            await state()
          );
        }

        /* ADMIN STATUS */

        if(
          p === "/api/admin/status"
        ){
          if(!admin(req))
            return json(res,401,{
              ok:false,
              error:"ADMIN_AUTH_REQUIRED"
            });

          const k =
            await db.query(`
              SELECT
               COUNT(*)::int total,
               COUNT(*) FILTER(
                WHERE device_id IS NULL
               )::int unused
              FROM access_keys
            `);

          const pr =
            await db.query(`
              SELECT
               COUNT(*)::int total,
               COUNT(*) FILTER(
                WHERE actual_result='WIN'
               )::int wins,
               COUNT(*) FILTER(
                WHERE actual_result='LOSS'
               )::int losses,
               COUNT(*) FILTER(
                WHERE actual_result IS NULL
               )::int pending
              FROM prediction_records
            `);

          return json(res,200,{
            ok:true,
            keys:k.rows[0],
            predictions:pr.rows[0],
            live:{
              source:live.source,
              currentIssue:live.current,
              latestIssue:
                live.rows.at(-1)?.issue || null,
              rows:live.rows.length,
              ageMs:
                live.fetched
                  ? now()-live.fetched
                  : null,
              error:live.error
            }
          });
        }

        /* ADMIN LIVE TEST */

        if(
          p === "/api/admin/live-test"
        ){
          if(!admin(req))
            return json(res,401,{
              ok:false,
              error:"ADMIN_AUTH_REQUIRED"
            });

          try{
            const x =
              LIVE_API_URL ?
              await customAPI() :
              await wingoAPI();

            return json(res,200,{
              ok:true,
              source:x.source,
              currentIssue:x.current,
              latest:x.rows.at(-1)||null,
              rows:x.rows.length
            });
          }catch(e){
            return json(res,500,{
              ok:false,
              error:e.message
            });
          }
        }

        /* ADMIN MODEL TEST */

        if(
          p === "/api/admin/model-test"
        ){
          if(!admin(req))
            return json(res,401,{
              ok:false,
              error:"ADMIN_AUTH_REQUIRED"
            });

          return json(res,200,{
            ok:true,
            analysis:
              analyze(live.rows)
          });
        }

        /* ADMIN PREDICTIONS */

        if(
          p === "/api/admin/predictions"
        ){
          if(!admin(req))
            return json(res,401,{
              ok:false,
              error:"ADMIN_AUTH_REQUIRED"
            });

          const r =
            await db.query(`
              SELECT *
              FROM prediction_records
              ORDER BY id DESC
              LIMIT 200
            `);

          return json(res,200,{
            ok:true,
            predictions:r.rows
          });
        }

        /* CREATE KEY */

        if(
          p === "/api/admin/keys" &&
          req.method === "POST"
        ){
          if(!admin(req))
            return json(res,401,{
              ok:false,
              error:"ADMIN_AUTH_REQUIRED"
            });

          const key =
            "DY-" +
            crypto
              .randomBytes(8)
              .toString("hex")
              .toUpperCase();

          const r =
            await db.query(
              `
              INSERT INTO access_keys
              (access_key,created_at)
              VALUES($1,$2)
              RETURNING *
              `,
              [key,now()]
            );

          return json(res,200,{
            ok:true,
            key:r.rows[0]
          });
        }

        /* LIST KEYS */

        if(
          p === "/api/admin/keys" &&
          req.method === "GET"
        ){
          if(!admin(req))
            return json(res,401,{
              ok:false,
              error:"ADMIN_AUTH_REQUIRED"
            });

          const r =
            await db.query(`
              SELECT
               id,
               access_key,
               device_id,
               created_at,
               last_seen
              FROM access_keys
              ORDER BY id DESC
            `);

          return json(res,200,{
            ok:true,
            keys:r.rows
          });
        }

        /* RESET DEVICE */

        if(
          p === "/api/admin/reset-device" &&
          req.method === "POST"
        ){
          if(!admin(req))
            return json(res,401,{
              ok:false,
              error:"ADMIN_AUTH_REQUIRED"
            });

          const key =
            new URL(
              req.url,
              "http://localhost"
            ).searchParams.get("key");

          if(!key)
            return json(res,400,{
              ok:false,
              error:"KEY_REQUIRED"
            });

          await db.query(
            `
            UPDATE access_keys
            SET device_id=NULL
            WHERE access_key=$1
            `,
            [key]
          );

          return json(res,200,{
            ok:true
          });
        }

        return json(res,404,{
          ok:false,
          error:"NOT_FOUND"
        });

      } catch(e) {

        console.error(
          "SERVER ERROR:",
          e
        );

        return json(res,500,{
          ok:false,
          error:"SERVER_ERROR",
          message:e.message
        });
      }
    }
  );

/* =========================
   WORKER
========================= */

let worker = false;

async function tick(){

  if(worker)return;

  worker=true;

  try{
    await refresh();

    if(live.rows.length)
      await modelWorker();

  }catch(e){
    console.error(
      "WORKER:",
      e.message
    );
  }

  worker=false;
}

/* =========================
   START
========================= */

async function start(){

  await initDB();

  server.listen(
    PORT,
    "0.0.0.0",
    ()=>{
      console.log(
        "================================"
      );

      console.log(
        "DY AI WIN GO LIVE"
      );

      console.log(
        "MODEL:",
        MODEL
      );

      console.log(
        "PORT:",
        PORT
      );

      console.log(
        "POLL:",
        POLL,
        "ms"
      );

      console.log(
        "LIVE API:",
        LIVE_API_URL
          ? "YES"
          : "NO"
      );

      console.log(
        "WINGOBOT:",
        WINGOBOT_TOKEN
          ? "YES"
          : "NO"
      );

      console.log(
        "================================"
      );

      tick();

      setInterval(
        tick,
        POLL
      );
    }
  );
}

process.on(
  "SIGTERM",
  async ()=>{
    await db.end();
    process.exit(0);
  }
);

process.on(
  "SIGINT",
  async ()=>{
    await db.end();
    process.exit(0);
  }
);

start().catch(e=>{
  console.error(
    "STARTUP FAILED:",
    e
  );

  process.exit(1);
});
