const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;

const DB = process.env.DATABASE_URL;
const ADMIN_KEY = process.env.ADMIN_KEY || "dy4427574";
const TOKEN = process.env.WINGOBOT_TOKEN || "";

const API_URL =
  "https://api.wingobot.com/v2/30-sec-game-history";

const ROUND_SECONDS = 30;
const API_REFRESH_MS = 1000;

const pool = new Pool({
  connectionString: DB,
  ssl: DB ? { rejectUnauthorized: false } : undefined,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});


/* =====================================================
   LIVE CACHE
===================================================== */

const cache = {
  data: null,
  history: [],
  analysis: null,

  apiIssue: null,
  apiNumber: null,

  lastSuccessAt: 0,
  syncedAt: 0,

  anchorIssue: null,
  anchorTime: 0,

  fetching: false,
  error: null
};


/* =====================================================
   RESPONSE
===================================================== */

function send(res, code, data) {
  if (res.headersSent) return;

  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Access-Control-Allow-Origin": "*"
  });

  res.end(JSON.stringify(data));
}


function admin(req) {
  return req.headers["x-admin-key"] === ADMIN_KEY;
}


function body(req) {
  return new Promise((resolve, reject) => {
    let s = "";

    req.on("data", chunk => {
      s += chunk;

      if (s.length > 1024 * 1024) {
        reject(new Error("BODY_TOO_LARGE"));
        req.destroy();
      }
    });

    req.on("end", () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch {
        reject(new Error("INVALID_JSON"));
      }
    });

    req.on("error", reject);
  });
}


/* =====================================================
   DATABASE
===================================================== */

async function init() {
  if (!DB) {
    throw new Error("DATABASE_URL is not configured");
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS access_keys(
      id SERIAL PRIMARY KEY,
      access_key TEXT UNIQUE NOT NULL,
      device_id TEXT,
      created_at BIGINT NOT NULL,
      last_seen BIGINT DEFAULT 0
    )
  `);
}


/* =====================================================
   WINGOBOT
===================================================== */

async function fetchWingoBot() {
  if (!TOKEN) {
    throw new Error(
      "WINGOBOT_TOKEN is not configured"
    );
  }

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, 7000);

  try {
    const r = await fetch(API_URL, {
      method: "GET",

      headers: {
        Authorization: "Bearer " + TOKEN,
        Accept: "application/json"
      },

      cache: "no-store",
      signal: controller.signal
    });

    const text = await r.text();

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(
        "WingoBot returned invalid JSON HTTP " +
        r.status
      );
    }

    if (!r.ok) {
      throw new Error(
        data.error ||
        data.message ||
        ("WingoBot API HTTP " + r.status)
      );
    }

    return data;

  } finally {
    clearTimeout(timeout);
  }
}


/* =====================================================
   HISTORY CLEAN
===================================================== */

function hist(data) {
  const source =
    Array.isArray(data?.history)
      ? data.history
      : [];

  return source
    .map(x => ({
      issueNumber:
        x.issueNumber ?? null,

      number:
        Number(x.number),

      colour:
        x.colour ?? "",

      premium:
        x.premium ?? null,

      sum:
        x.sum ?? null
    }))

    .filter(x =>
      Number.isInteger(x.number) &&
      x.number >= 0 &&
      x.number <= 9
    );
}


/* =====================================================
   BIG SMALL
===================================================== */

function bs(n) {
  return Number(n) >= 5
    ? "BIG"
    : "SMALL";
}


/* =====================================================
   ISSUE
===================================================== */

function issueValue(value) {
  const n = Number(
    String(value ?? "")
      .replace(/\D/g, "")
  );

  return Number.isSafeInteger(n)
    ? n
    : null;
}


function nextIssue(issue, rounds = 1) {
  const n = issueValue(issue);

  if (n === null) {
    return issue ?? null;
  }

  return String(n + rounds);
}


/* =====================================================
   TIMING
===================================================== */

function syncAnchor(issue) {
  if (issue === null || issue === undefined) {
    return;
  }

  const normalized = String(issue);

  if (
    !cache.anchorIssue ||
    cache.anchorIssue !== normalized
  ) {
    cache.anchorIssue = normalized;
    cache.anchorTime = Date.now();
  }
}


function getTiming() {
  if (
    !cache.anchorIssue ||
    !cache.anchorTime
  ) {
    return {
      period: cache.apiIssue,
      countdown: 30,
      roundsPassed: 0,
      estimated: false
    };
  }

  const elapsed =
    Math.max(
      0,
      Date.now() - cache.anchorTime
    );

  const roundMs =
    ROUND_SECONDS * 1000;

  const roundsPassed =
    Math.floor(
      elapsed / roundMs
    );

  const period =
    nextIssue(
      cache.anchorIssue,
      roundsPassed
    );

  const inside =
    elapsed % roundMs;

  let countdown =
    ROUND_SECONDS -
    Math.floor(inside / 1000);

  if (countdown < 1) {
    countdown = 1;
  }

  if (countdown > ROUND_SECONDS) {
    countdown = ROUND_SECONDS;
  }

  return {
    period,
    countdown,
    roundsPassed,
    estimated: roundsPassed > 0
  };
}


/* =====================================================
   REAL HISTORY AI
===================================================== */

function analyze(history) {

  const nums =
    history
      .slice(0, 50)
      .map(x => x.number);

  if (nums.length < 5) {
    return {
      prediction: null,
      number: null,
      confidence: 0,
      patternScore: 0,
      sampleSize: nums.length,
      method: "INSUFFICIENT_HISTORY",
      note:
        "Not enough history for analysis."
    };
  }


  const r10 = nums.slice(0, 10);
  const r20 = nums.slice(0, 20);
  const r30 = nums.slice(0, 30);


  const ratioBig = arr =>
    arr.length
      ? arr.filter(n => n >= 5).length / arr.length
      : 0.5;


  const overall = ratioBig(r30);
  const medium = ratioBig(r20);
  const recent = ratioBig(r10);


  /* STREAK */

  const latestType = bs(nums[0]);

  let streak = 1;

  for (
    let i = 1;
    i < nums.length;
    i++
  ) {
    if (
      bs(nums[i]) === latestType
    ) {
      streak++;
    } else {
      break;
    }
  }


  /* SAME / FLIP */

  let same = 0;
  let flip = 0;

  for (
    let i = 0;
    i < nums.length - 1;
    i++
  ) {
    if (
      bs(nums[i]) ===
      bs(nums[i + 1])
    ) {
      same++;
    } else {
      flip++;
    }
  }

  const totalTransition =
    same + flip;

  const sameRatio =
    totalTransition
      ? same / totalTransition
      : 0.5;


  /* MOMENTUM */

  let bigMomentum = 0;
  let smallMomentum = 0;

  r20.forEach((n, i) => {

    const weight =
      (r20.length - i) /
      r20.length;

    if (n >= 5) {
      bigMomentum += weight;
    } else {
      smallMomentum += weight;
    }
  });


  let bigProbability = 0.5;

  bigProbability +=
    (overall - 0.5) * 0.22;

  bigProbability +=
    (medium - 0.5) * 0.28;

  bigProbability +=
    (recent - 0.5) * 0.35;


  const momentumTotal =
    bigMomentum +
    smallMomentum;

  if (momentumTotal > 0) {
    bigProbability +=
      (
        bigMomentum / momentumTotal -
        0.5
      ) * 0.25;
  }


  if (latestType === "BIG") {
    bigProbability +=
      (sameRatio - 0.5) * 0.12;
  } else {
    bigProbability -=
      (sameRatio - 0.5) * 0.12;
  }


  bigProbability =
    Math.max(
      0.08,
      Math.min(
        0.92,
        bigProbability
      )
    );


  const prediction =
    bigProbability >= 0.5
      ? "BIG"
      : "SMALL";


  /* AGREEMENT */

  const signals = [
    overall >= 0.5,
    medium >= 0.5,
    recent >= 0.5,
    bigMomentum >= smallMomentum
  ];

  const yes =
    signals.filter(Boolean).length;

  const no =
    signals.length - yes;

  const agreement =
    Math.max(yes, no) /
    signals.length;


  let confidence =
    50 +
    Math.abs(
      bigProbability - 0.5
    ) * 75;

  confidence *=
    0.82 +
    agreement * 0.18;


  if (streak >= 4) {
    confidence -= 4;
  }


  confidence =
    Math.round(
      Math.max(
        51,
        Math.min(
          82,
          confidence
        )
      )
    );


  /* NUMBER */

  const freq =
    Array(10).fill(0);

  const rec =
    Array(10).fill(0);

  r30.forEach(n => {
    freq[n]++;
  });

  r10.forEach((n, i) => {
    rec[n] +=
      (r10.length - i) /
      r10.length;
  });


  const candidates =
    Array
      .from(
        { length: 10 },
        (_, n) => ({

          n,

          score:
            (
              freq[n] /
              Math.max(1, r30.length)
            ) * 0.55 +

            (
              rec[n] /
              Math.max(1, r10.length)
            ) * 0.45
        })
      )

      .filter(x =>
        bs(x.n) === prediction
      )

      .sort(
        (a, b) =>
          b.score - a.score ||
          a.n - b.n
      );


  const number =
    candidates[0]?.n ??
    (
      prediction === "BIG"
        ? 5
        : 0
    );


  /* PATTERN */

  let patternScore =
    45 +
    Math.abs(overall - 0.5) * 80 +
    Math.abs(recent - 0.5) * 80 +
    Math.abs(agreement - 0.5) * 30;

  if (streak >= 3) {
    patternScore -= 5;
  }

  patternScore =
    Math.round(
      Math.max(
        0,
        Math.min(
          100,
          patternScore
        )
      )
    );


  return {

    prediction,

    number,

    confidence,

    patternScore,

    sampleSize:
      nums.length,

    latestNumber:
      nums[0],

    latestPrediction:
      latestType,

    streak,

    statistics: {

      bigPercent:
        Math.round(
          overall * 100
        ),

      recent20BigPercent:
        Math.round(
          medium * 100
        ),

      recent10BigPercent:
        Math.round(
          recent * 100
        ),

      samePercent:
        Math.round(
          sameRatio * 100
        ),

      flipPercent:
        Math.round(
          (1 - sameRatio) * 100
        ),

      bigProbability:
        Math.round(
          bigProbability * 100
        ),

      smallProbability:
        Math.round(
          (1 - bigProbability) * 100
        )
    },

    method:
      "DY_AI_REAL_HISTORY_STATISTICAL",

    note:
      "Statistical estimate from historical results only. Future results are not guaranteed."
  };
}


/* =====================================================
   CACHE UPDATE
===================================================== */

function updateCache(data) {

  const history =
    hist(data);

  const apiIssue =
    data?.current?.issueNumber ??
    history[0]?.issueNumber ??
    null;


  const apiNumber =
    Number.isInteger(
      Number(data?.current?.number)
    )
      ? Number(data.current.number)
      : (
          history[0]?.number ??
          null
        );


  /*
    IMPORTANT:

    New API issue = new timing anchor.

    We never permanently add +2.
  */

  if (
    apiIssue !== null &&
    String(apiIssue) !==
      String(cache.apiIssue ?? "")
  ) {

    cache.apiIssue =
      String(apiIssue);

    cache.anchorIssue =
      String(apiIssue);

    cache.anchorTime =
      Date.now();
  }


  if (
    !cache.anchorIssue &&
    apiIssue !== null
  ) {

    cache.apiIssue =
      String(apiIssue);

    cache.anchorIssue =
      String(apiIssue);

    cache.anchorTime =
      Date.now();
  }


  cache.data = data;
  cache.history = history;
  cache.apiNumber = apiNumber;

  cache.analysis =
    analyze(history);

  cache.syncedAt =
    Date.now();

  cache.lastSuccessAt =
    Date.now();

  cache.error = null;
}


/* =====================================================
   REFRESH
===================================================== */

async function refreshWingo() {

  if (cache.fetching) {
    return cache.data;
  }

  cache.fetching = true;

  try {

    const data =
      await fetchWingoBot();

    updateCache(data);

    return data;

  } catch (e) {

    cache.error =
      e.message;

    console.error(
      "WINGOBOT:",
      e.message
    );

    return cache.data;

  } finally {

    cache.fetching = false;
  }
}


/*
  EXACTLY 1 SECOND REFRESH
*/

setInterval(() => {

  refreshWingo()
    .catch(() => {});

}, API_REFRESH_MS);


/* =====================================================
   AUTH
===================================================== */

async function auth(req, res) {

  const key =
    String(
      req.headers["x-access-key"] ||
      ""
    ).trim();

  const device =
    String(
      req.headers["x-device-id"] ||
      ""
    ).trim();


  if (!key || !device) {

    send(res, 401, {
      success: false,
      error:
        "ACCESS_HEADERS_REQUIRED"
    });

    return null;
  }


  const q =
    await pool.query(
      `
      SELECT *
      FROM access_keys
      WHERE access_key=$1
      LIMIT 1
      `,
      [key]
    );


  if (!q.rows.length) {

    send(res, 401, {
      success: false,
      error:
        "INVALID_ACCESS_KEY"
    });

    return null;
  }


  const row =
    q.rows[0];


  if (
    row.device_id &&
    row.device_id !== device
  ) {

    send(res, 403, {
      success: false,
      error:
        "KEY_BOUND_TO_ANOTHER_DEVICE"
    });

    return null;
  }


  await pool.query(
    `
    UPDATE access_keys
    SET
      device_id=COALESCE(device_id,$1),
      last_seen=$2
    WHERE id=$3
    `,
    [
      device,
      Date.now(),
      row.id
    ]
  );


  return row;
}


/* =====================================================
   STATE
===================================================== */

function makeState() {

  const timing =
    getTiming();

  const a =
    cache.analysis ||
    analyze(cache.history);


  return {

    success: true,

    source:
      "WingoBot",

    realHistory:
      cache.history.length > 0,

    synced:
      cache.lastSuccessAt > 0,

    stale:
      cache.lastSuccessAt
        ? (
            Date.now() -
            cache.lastSuccessAt
          ) > 5000
        : true,

    lastSync:
      cache.lastSuccessAt || null,

    period:
      timing.period,

    countdown:
      timing.countdown,

    current: {

      issueNumber:
        timing.period,

      number:
        cache.apiNumber
    },

    apiPeriod:
      cache.apiIssue,

    prediction:
      a.prediction,

    number:
      a.number,

    confidence:
      a.confidence,

    patternScore:
      a.patternScore,

    sampleSize:
      a.sampleSize,

    latestNumber:
      a.latestNumber,

    latestPrediction:
      a.latestPrediction,

    streak:
      a.streak,

    statistics:
      a.statistics || null,

    method:
      a.method,

    history:
      cache.history.slice(0, 30),

    stats:
      cache.data?.stats || null,

    timing: {

      roundSeconds:
        ROUND_SECONDS,

      roundsPassed:
        timing.roundsPassed || 0,

      estimated:
        timing.estimated,

      status:
        cache.error
          ? "USING_LAST_VALID_DATA"
          : "LIVE"
    },

    apiError:
      cache.error || null,

    note:
      a.note
  };
}


/* =====================================================
   SERVER
===================================================== */

async function handle(req, res) {

  const u =
    new URL(
      req.url,
      "http://localhost"
    );


  /* OPTIONS */

  if (req.method === "OPTIONS") {

    res.writeHead(204, {

      "Access-Control-Allow-Origin": "*",

      "Access-Control-Allow-Headers":
        "Content-Type,X-Admin-Key,X-Access-Key,X-Device-ID",

      "Access-Control-Allow-Methods":
        "GET,POST,DELETE,OPTIONS"
    });

    return res.end();
  }


  /* HEALTH */

  if (
    u.pathname === "/health" ||
    u.pathname === "/api/health"
  ) {

    return send(res, 200, {

      success: true,

      ok: true,

      service:
        "DY AI Wingo 30S",

      wingobot:
        !!TOKEN,

      realHistory:
        cache.history.length > 0,

      lastSync:
        cache.lastSuccessAt || null
    });
  }


  /* ADMIN PING */

  if (
    u.pathname === "/api/admin/ping" &&
    req.method === "GET"
  ) {

    if (!admin(req)) {

      return send(res, 401, {
        success: false,
        error: "UNAUTHORIZED"
      });
    }

    return send(res, 200, {
      success: true
    });
  }


  /* ADMIN STATUS */

  if (
    u.pathname === "/api/admin/status" &&
    req.method === "GET"
  ) {

    if (!admin(req)) {

      return send(res, 401, {
        success: false,
        error: "UNAUTHORIZED"
      });
    }


    let database = false;

    try {

      await pool.query("SELECT 1");

      database = true;

    } catch {}


    return send(res, 200, {

      success: true,

      database,

      wingobot:
        !!TOKEN,

      realHistory:
        cache.history.length > 0,

      apiPeriod:
        cache.apiIssue,

      lastSync:
        cache.lastSuccessAt,

      apiError:
        cache.error,

      uptime:
        process.uptime(),

      timing:
        getTiming()
    });
  }


  /* ADMIN KEYS GET */

  if (
    u.pathname === "/api/admin/keys" &&
    req.method === "GET"
  ) {

    if (!admin(req)) {

      return send(res, 401, {
        success: false,
        error: "UNAUTHORIZED"
      });
    }


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


    return send(res, 200, {

      success: true,

      keys:
        q.rows.map(x => ({

          ...x,

          key:
            x.access_key,

          live:
            Number(x.last_seen || 0) > 0 &&
            Date.now() -
            Number(x.last_seen || 0)
            <= 90000
        }))
    });
  }


  /* CREATE KEY */

  if (
    u.pathname === "/api/admin/keys" &&
    req.method === "POST"
  ) {

    if (!admin(req)) {

      return send(res, 401, {
        success: false,
        error: "UNAUTHORIZED"
      });
    }


    const b =
      await body(req);


    const k =
      String(
        b.key ??
        b.access_key ??
        b.customKey ??
        ""
      ).trim()
      ||
      (
        "DY-USER-" +
        crypto
          .randomBytes(5)
          .toString("hex")
          .toUpperCase()
      );


    try {

      const q =
        await pool.query(
          `
          INSERT INTO access_keys
          (
            access_key,
            created_at,
            last_seen
          )
          VALUES($1,$2,0)
          RETURNING *
          `,
          [
            k,
            Date.now()
          ]
        );


      return send(res, 200, {

        success: true,

        key: k,

        access_key: k,

        item:
          q.rows[0]
      });

    } catch (e) {

      if (e.code === "23505") {

        return send(res, 409, {
          success: false,
          error:
            "KEY_ALREADY_EXISTS"
        });
      }

      throw e;
    }
  }


  /* DELETE KEY */

  if (
    u.pathname === "/api/admin/keys" &&
    req.method === "DELETE"
  ) {

    if (!admin(req)) {

      return send(res, 401, {
        success: false,
        error: "UNAUTHORIZED"
      });
    }


    const b =
      await body(req);


    const k =
      String(
        b.key ??
        b.access_key ??
        ""
      ).trim();


    await pool.query(
      `
      DELETE FROM access_keys
      WHERE access_key=$1
      `,
      [k]
    );


    return send(res, 200, {
      success: true
    });
  }


  /* RESET DEVICE */

  if (
    u.pathname === "/api/admin/reset-device" &&
    req.method === "POST"
  ) {

    if (!admin(req)) {

      return send(res, 401, {
        success: false,
        error: "UNAUTHORIZED"
      });
    }


    const b =
      await body(req);


    if (b.id) {

      await pool.query(
        `
        UPDATE access_keys
        SET
          device_id=NULL,
          last_seen=0
        WHERE id=$1
        `,
        [Number(b.id)]
      );

    } else {

      await pool.query(
        `
        UPDATE access_keys
        SET
          device_id=NULL,
          last_seen=0
        WHERE access_key=$1
        `,
        [
          String(b.key || "")
        ]
      );
    }


    return send(res, 200, {
      success: true
    });
  }


  /* WINGOBOT TEST */

  if (
    u.pathname === "/api/admin/wingo-test" &&
    req.method === "GET"
  ) {

    if (!admin(req)) {

      return send(res, 401, {
        success: false,
        error: "UNAUTHORIZED"
      });
    }


    await refreshWingo();


    if (!cache.data) {

      return send(res, 502, {

        success: false,

        error:
          "WINGOBOT_API_FAILED",

        message:
          cache.error ||
          "No WingoBot data"
      });
    }


    return send(res, 200, {

      success: true,

      source:
        "WingoBot",

      current:
        cache.data.current ||
        null,

      apiPeriod:
        cache.apiIssue,

      activePeriod:
        getTiming().period,

      countdown:
        getTiming().countdown,

      history:
        cache.history.slice(0, 20),

      stats:
        cache.data.stats ||
        null,

      analysis:
        cache.analysis,

      lastSync:
        cache.lastSuccessAt
    });
  }


  /* KEY CHECK */

  if (
    u.pathname === "/api/key/check" &&
    req.method === "GET"
  ) {

    const r =
      await auth(req, res);

    if (!r) return;


    return send(res, 200, {

      success: true,

      valid: true,

      status:
        r.device_id
          ? "LIVE"
          : "UNBOUND",

      key:
        r.access_key
    });
  }


  /* =================================================
     LIVE STATE
  ================================================= */

  if (
    u.pathname === "/api/state" &&
    req.method === "GET"
  ) {

    const r =
      await auth(req, res);

    if (!r) return;


    if (!cache.data) {
      await refreshWingo();
    }


    if (!cache.data) {

      return send(res, 502, {

        success: false,

        source:
          "WingoBot",

        realHistory:
          false,

        error:
          "WINGOBOT_API_FAILED",

        message:
          cache.error ||
          "No valid data"
      });
    }


    return send(
      res,
      200,
      makeState()
    );
  }


  /* HISTORY */

  if (
    u.pathname === "/api/history" &&
    req.method === "GET"
  ) {

    const r =
      await auth(req, res);

    if (!r) return;


    if (!cache.data) {
      await refreshWingo();
    }


    return send(res, 200, {

      success: true,

      source:
        "WingoBot",

      realHistory:
        true,

      history:
        cache.history.slice(0, 30),

      current:
        cache.data?.current ||
        null,

      activePeriod:
        getTiming().period,

      apiPeriod:
        cache.apiIssue,

      stats:
        cache.data?.stats ||
        null,

      lastSync:
        cache.lastSuccessAt
    });
  }


  /* =================================================
     STATIC FILES
  ================================================= */

  let file;


  if (
    u.pathname === "/" ||
    u.pathname === "/prediction.html"
  ) {

    file = "prediction.html";

  } else if (
    u.pathname === "/admin" ||
    u.pathname === "/admin.html"
  ) {

    file = "admin.html";

  } else if (
    u.pathname === "/music.mp3"
  ) {

    file = "music.mp3";

  } else {

    file =
      u.pathname.replace(
        /^\//,
        ""
      );
  }


  const root =
    path.resolve(ROOT);

  file =
    path.resolve(
      ROOT,
      file
    );


  if (
    file !== root &&
    !file.startsWith(
      root + path.sep
    )
  ) {

    return send(res, 403, {
      success: false,
      error: "FORBIDDEN"
    });
  }


  fs.stat(
    file,
    (e, s) => {

      if (
        e ||
        !s.isFile()
      ) {

        return send(res, 404, {
          success: false,
          error: "NOT_FOUND"
        });
      }


      const ext =
        path
          .extname(file)
          .toLowerCase();


      const types = {

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

        ".svg":
          "image/svg+xml",

        ".mp3":
          "audio/mpeg"
      };


      /* MP3 */

      if (
        ext === ".mp3" &&
        req.headers.range
      ) {

        const range =
          req.headers.range.match(
            /bytes=(\d+)-(\d*)/
          );


        if (!range) {

          res.writeHead(416);

          return res.end();
        }


        const start =
          Number(range[1]);

        const end =
          range[2]
            ? Number(range[2])
            : s.size - 1;


        if (
          start >= s.size ||
          start > end
        ) {

          res.writeHead(
            416,
            {
              "Content-Range":
                `bytes */${s.size}`
            }
          );

          return res.end();
        }


        const safeEnd =
          Math.min(
            end,
            s.size - 1
          );


        res.writeHead(
          206,
          {

            "Content-Type":
              "audio/mpeg",

            "Content-Range":
              `bytes ${start}-${safeEnd}/${s.size}`,

            "Accept-Ranges":
              "bytes",

            "Content-Length":
              safeEnd - start + 1,

            "Cache-Control":
              "public, max-age=3600"
          }
        );


        return fs
          .createReadStream(
            file,
            {
              start,
              end: safeEnd
            }
          )
          .pipe(res);
      }


      res.writeHead(
        200,
        {

          "Content-Type":
            types[ext] ||
            "application/octet-stream",

          "Cache-Control":
            ext === ".mp3"
              ? "public, max-age=3600"
              : "no-store"
        }
      );


      fs
        .createReadStream(file)
        .pipe(res);
    }
  );
}


/* =====================================================
   START
===================================================== */

(async () => {

  try {

    await init();

    /*
      Initial API load.
    */

    await refreshWingo();


    http
      .createServer(
        (req, res) => {

          handle(req, res)
            .catch(e => {

              console.error(
                "SERVER ERROR:",
                e
              );

              if (!res.headersSent) {

                send(res, 500, {

                  success: false,

                  error:
                    e.message ||
                    "SERVER_ERROR"
                });

              } else {

                res.end();
              }
            });
        }
      )
      .listen(
        PORT,
        () => {

          console.log(
            "================================"
          );

          console.log(
            "DY AI WINGO 30S ONLINE"
          );

          console.log(
            "PORT:",
            PORT
          );

          console.log(
            "WINGOBOT:",
            !!TOKEN
          );

          console.log(
            "API REFRESH: 1 SECOND"
          );

          console.log(
            "REAL HISTORY:",
            cache.history.length > 0
          );

          console.log(
            "API PERIOD:",
            cache.apiIssue
          );

          console.log(
            "================================"
          );
        }
      );

  } catch (e) {

    console.error(
      "STARTUP ERROR:",
      e
    );

    process.exit(1);
  }

})();
