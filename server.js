const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;

const DB = process.env.DATABASE_URL;
const ADMIN_KEY = process.env.ADMIN_KEY || 'dy4427574';
const TOKEN = process.env.WINGOBOT_TOKEN || '';

const API_URL =
  'https://api.wingobot.com/v2/30-sec-game-history';

const ROUND_SECONDS = 30;

/*
====================================================
 DY AI WINGO 30S
 REAL HISTORY + SMOOTH SYNC ENGINE
====================================================

Important:
- No fixed +2 period offset.
- WingoBot data is cached.
- New API period automatically re-syncs timing.
- If API temporarily fails, previous valid data remains.
- Prediction is statistical only.
*/

const pool = new Pool({
  connectionString: DB,
  ssl: DB ? { rejectUnauthorized: false } : undefined,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});


/* ==================================================
   GLOBAL WINGOBOT CACHE
================================================== */

const cache = {
  data: null,
  history: [],
  analysis: null,

  apiIssue: null,
  apiNumber: null,

  syncedAt: 0,
  lastSuccessAt: 0,

  fetching: false,
  error: null,

  /*
    Timing anchor.
    When a fresh API result arrives, we anchor
    the current known round to the current time.
  */
  anchorIssue: null,
  anchorTime: 0
};


/* ==================================================
   RESPONSE HELPERS
================================================== */

function send(res, code, obj) {
  if (res.headersSent) return;

  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });

  res.end(JSON.stringify(obj));
}


function admin(req) {
  return req.headers['x-admin-key'] === ADMIN_KEY;
}


function body(req) {
  return new Promise((resolve, reject) => {
    let s = '';

    req.on('data', chunk => {
      s += chunk;
      if (s.length > 1024 * 1024) {
        reject(new Error('BODY_TOO_LARGE'));
        req.destroy();
      }
    });

    req.on('end', () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch {
        reject(new Error('INVALID_JSON'));
      }
    });

    req.on('error', reject);
  });
}


/* ==================================================
   DATABASE
================================================== */

async function init() {
  if (!DB) {
    throw new Error('DATABASE_URL is not configured');
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


/* ==================================================
   WINGOBOT FETCH
================================================== */

async function fetchWingoBot() {
  if (!TOKEN) {
    throw new Error('WINGOBOT_TOKEN is not configured');
  }

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, 7000);

  try {
    const r = await fetch(API_URL, {
      method: 'GET',

      headers: {
        Authorization: 'Bearer ' + TOKEN,
        Accept: 'application/json'
      },

      cache: 'no-store',
      signal: controller.signal
    });

    const text = await r.text();

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(
        'WingoBot returned invalid JSON (HTTP ' +
        r.status +
        ')'
      );
    }

    if (!r.ok) {
      throw new Error(
        data.error ||
        data.message ||
        ('WingoBot API HTTP ' + r.status)
      );
    }

    return data;

  } finally {
    clearTimeout(timeout);
  }
}


/* ==================================================
   HISTORY CLEANER
================================================== */

function hist(data) {
  const source =
    Array.isArray(data?.history)
      ? data.history
      : [];

  return source
    .map(x => ({
      issueNumber:
        x.issueNumber ??
        null,

      number:
        Number(x.number),

      colour:
        x.colour ??
        '',

      premium:
        x.premium ??
        null,

      sum:
        x.sum ??
        null
    }))

    .filter(x =>
      Number.isInteger(x.number) &&
      x.number >= 0 &&
      x.number <= 9
    );
}


/* ==================================================
   BIG / SMALL
================================================== */

function bs(number) {
  return Number(number) >= 5
    ? 'BIG'
    : 'SMALL';
}


/* ==================================================
   SAFE ISSUE NUMBER
================================================== */

function issueValue(value) {
  const n = Number(
    String(value ?? '')
      .replace(/\D/g, '')
  );

  return Number.isSafeInteger(n)
    ? n
    : null;
}


/*
  Increment issue number by one round.

  This is used only after observing the provider's
  real issue sequence. It is NOT a permanent +2
  calibration.
*/

function nextIssue(issue, rounds = 1) {
  const n = issueValue(issue);

  if (n === null) {
    return issue ?? null;
  }

  return String(n + rounds);
}


/* ==================================================
   TIMING ENGINE
================================================== */

function syncTiming(issue) {
  if (issue === null || issue === undefined) {
    return;
  }

  const normalized = String(issue);

  /*
    Only create a new anchor when provider gives us
    a different issue number.
  */

  if (
    cache.anchorIssue !== normalized ||
    !cache.anchorTime
  ) {
    cache.anchorIssue = normalized;
    cache.anchorTime = Date.now();
  }
}


/*
  Get active period.

  We treat the API's current issue as the latest
  known real issue and move forward according to
  elapsed 30-second rounds.

  This prevents a permanently stuck period.
*/

function getTiming() {
  if (!cache.anchorIssue || !cache.anchorTime) {
    return {
      period: cache.apiIssue,
      countdown: 30,
      estimated: false
    };
  }

  const elapsed =
    Math.max(
      0,
      Date.now() - cache.anchorTime
    );

  const roundsPassed =
    Math.floor(
      elapsed / (ROUND_SECONDS * 1000)
    );

  const period =
    nextIssue(
      cache.anchorIssue,
      roundsPassed
    );

  const elapsedInRound =
    elapsed %
    (ROUND_SECONDS * 1000);

  let countdown =
    ROUND_SECONDS -
    Math.floor(
      elapsedInRound / 1000
    );

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


/* ==================================================
   REAL HISTORY AI
================================================== */

function analyze(history) {
  const numbers =
    history
      .slice(0, 50)
      .map(x => x.number);

  if (numbers.length < 5) {
    return {
      prediction: null,
      number: null,
      confidence: 0,
      patternScore: 0,
      sampleSize: numbers.length,
      method: 'INSUFFICIENT_HISTORY',
      note:
        'Not enough historical results for statistical analysis.'
    };
  }


  /* -----------------------------------------------
     WINDOWS
  ------------------------------------------------ */

  const recent10 =
    numbers.slice(0, 10);

  const recent20 =
    numbers.slice(0, 20);

  const recent30 =
    numbers.slice(0, 30);


  /* -----------------------------------------------
     BIG / SMALL COUNTS
  ------------------------------------------------ */

  function ratioBig(arr) {
    if (!arr.length) return 0.5;

    return (
      arr.filter(n => n >= 5).length /
      arr.length
    );
  }

  const overallRatio =
    ratioBig(recent30);

  const ratio20 =
    ratioBig(recent20);

  const ratio10 =
    ratioBig(recent10);


  /* -----------------------------------------------
     STREAK
  ------------------------------------------------ */

  const latestType =
    bs(numbers[0]);

  let streak = 1;

  for (
    let i = 1;
    i < numbers.length;
    i++
  ) {
    if (
      bs(numbers[i]) === latestType
    ) {
      streak++;
    } else {
      break;
    }
  }


  /* -----------------------------------------------
     TRANSITIONS
  ------------------------------------------------ */

  let same = 0;
  let flip = 0;

  for (
    let i = 0;
    i < numbers.length - 1;
    i++
  ) {
    if (
      bs(numbers[i]) ===
      bs(numbers[i + 1])
    ) {
      same++;
    } else {
      flip++;
    }
  }

  const transitionTotal =
    same + flip;

  const sameRatio =
    transitionTotal
      ? same / transitionTotal
      : 0.5;


  /* -----------------------------------------------
     RECENT MOMENTUM
  ------------------------------------------------ */

  let bigScore = 0;
  let smallScore = 0;

  /*
    Recent results receive more weight.
  */

  recent20.forEach((n, i) => {
    const weight =
      (recent20.length - i) /
      recent20.length;

    if (n >= 5) {
      bigScore += weight;
    } else {
      smallScore += weight;
    }
  });


  /* -----------------------------------------------
     BASE PROBABILITY
  ------------------------------------------------ */

  let bigProbability =
    0.5;

  bigProbability +=
    (overallRatio - 0.5) * 0.22;

  bigProbability +=
    (ratio20 - 0.5) * 0.28;

  bigProbability +=
    (ratio10 - 0.5) * 0.35;

  const momentumTotal =
    bigScore +
    smallScore;

  if (momentumTotal > 0) {
    bigProbability +=
      (
        (bigScore / momentumTotal) -
        0.5
      ) * 0.25;
  }


  /*
    Transition signal.

    If latest is BIG and historical tendency
    is same-result heavy, give a small BIG signal.

    If flip tendency is stronger, signal is reversed.
  */

  if (latestType === 'BIG') {
    bigProbability +=
      (sameRatio - 0.5) * 0.12;
  } else {
    bigProbability -=
      (sameRatio - 0.5) * 0.12;
  }


  /*
    Avoid extreme fake certainty.
  */

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
      ? 'BIG'
      : 'SMALL';


  /* -----------------------------------------------
     SIGNAL STRENGTH
  ------------------------------------------------ */

  const distance =
    Math.abs(
      bigProbability - 0.5
    );

  let confidence =
    50 +
    distance * 75;


  /*
    Conflicting windows reduce confidence.
  */

  const directions = [
    overallRatio >= 0.5,
    ratio20 >= 0.5,
    ratio10 >= 0.5,
    bigScore >= smallScore
  ];

  const yes =
    directions.filter(Boolean).length;

  const no =
    directions.length - yes;

  const agreement =
    Math.max(yes, no) /
    directions.length;


  confidence *=
    0.82 +
    agreement * 0.18;


  /*
    Very long streaks are NOT treated as guaranteed
    reversal. We simply reduce confidence because
    the pattern becomes less informative.
  */

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


  /* -----------------------------------------------
     NUMBER ANALYSIS
  ------------------------------------------------ */

  const frequency =
    Array(10).fill(0);

  const recency =
    Array(10).fill(0);

  recent30.forEach(n => {
    frequency[n]++;
  });

  recent10.forEach((n, index) => {
    recency[n] +=
      (recent10.length - index) /
      recent10.length;
  });


  /*
    Score each number using:
    - historical frequency
    - recent appearance
    - BIG/SMALL alignment
  */

  const candidates =
    Array
      .from(
        { length: 10 },
        (_, n) => {

          const freq =
            frequency[n] /
            Math.max(
              1,
              recent30.length
            );

          const rec =
            recency[n] /
            Math.max(
              1,
              recent10.length
            );

          return {
            n,

            score:
              freq * 0.55 +
              rec * 0.45
          };
        }
      )

      .filter(x =>
        bs(x.n) === prediction
      )

      .sort(
        (a, b) =>
          b.score - a.score ||
          a.n - b.n
      );


  const suggestedNumber =
    candidates[0]?.n ??
    (
      prediction === 'BIG'
        ? 5
        : 0
    );


  /* -----------------------------------------------
     PATTERN SCORE
  ------------------------------------------------ */

  const balanceSignal =
    Math.abs(
      overallRatio - 0.5
    );

  const recentSignal =
    Math.abs(
      ratio10 - 0.5
    );

  const agreementSignal =
    Math.abs(
      agreement - 0.5
    );


  let patternScore =
    45 +
    balanceSignal * 80 +
    recentSignal * 80 +
    agreementSignal * 30;


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

    number:
      suggestedNumber,

    confidence,

    patternScore,

    sampleSize:
      numbers.length,

    latestNumber:
      numbers[0],

    latestPrediction:
      bs(numbers[0]),

    streak,

    statistics: {

      bigPercent:
        Math.round(
          overallRatio * 100
        ),

      recent20BigPercent:
        Math.round(
          ratio20 * 100
        ),

      recent10BigPercent:
        Math.round(
          ratio10 * 100
        ),

      samePercent:
        Math.round(
          sameRatio * 100
        ),

      flipPercent:
        Math.round(
          (
            1 - sameRatio
          ) * 100
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
      'DY_AI_REAL_HISTORY_STATISTICAL',

    note:
      'Statistical estimate from historical results only. Future results are not guaranteed.'
  };
}


/* ==================================================
   UPDATE CACHE
================================================== */

function updateCache(data) {
  const history =
    hist(data);

  const apiIssue =
    data?.current?.issueNumber ??
    history[0]?.issueNumber ??
    null;

  const apiNumber =
    Number.isInteger(
      Number(
        data?.current?.number
      )
    )
      ? Number(data.current.number)
      : (
          history[0]?.number ??
          null
        );


  /*
    Detect a genuinely new provider issue.

    Only then do we reset the timing anchor.
  */

  if (
    apiIssue !== null &&
    String(apiIssue) !==
      String(cache.apiIssue ?? '')
  ) {

    cache.apiIssue =
      String(apiIssue);

    cache.anchorIssue =
      String(apiIssue);

    cache.anchorTime =
      Date.now();

  } else if (
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


  cache.data =
    data;

  cache.history =
    history;

  cache.apiNumber =
    apiNumber;

  cache.analysis =
    analyze(history);

  cache.syncedAt =
    Date.now();

  cache.lastSuccessAt =
    Date.now();

  cache.error =
    null;
}


/* ==================================================
   REFRESH CACHE
================================================== */

async function refreshWingo() {

  /*
    Prevent multiple simultaneous API calls.
  */

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
      'WINGOBOT REFRESH:',
      e.message
    );

    /*
      Do NOT erase old valid data.
    */

    return cache.data;

  } finally {

    cache.fetching =
      false;
  }
}


/*
  Background refresh.

  The API is refreshed independently from the
  frontend countdown.
*/

setInterval(() => {
  refreshWingo()
    .catch(() => {});
}, 3000);


/* ==================================================
   INITIAL API LOAD
================================================== */

async function initialWingoLoad() {
  await refreshWingo();
}


/* ==================================================
   AUTH
================================================== */

async function auth(req, res) {

  const key =
    String(
      req.headers['x-access-key'] ||
      ''
    ).trim();

  const device =
    String(
      req.headers['x-device-id'] ||
      ''
    ).trim();


  if (!key || !device) {

    send(res, 401, {
      success: false,
      error:
        'ACCESS_HEADERS_REQUIRED'
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
        'INVALID_ACCESS_KEY'
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
        'KEY_BOUND_TO_ANOTHER_DEVICE'
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


/* ==================================================
   STATE RESPONSE
================================================== */

function stateObject() {

  const timing =
    getTiming();

  const a =
    cache.analysis ||
    analyze(cache.history);


  return {

    success:
      true,

    source:
      'WingoBot',

    realHistory:
      cache.history.length > 0,

    synced:
      cache.lastSuccessAt > 0,

    stale:
      cache.lastSuccessAt
        ? Date.now() -
          cache.lastSuccessAt >
          15000
        : true,

    lastSync:
      cache.lastSuccessAt || null,

    period:
      timing.period,

    current: {

      issueNumber:
        timing.period,

      number:
        cache.apiNumber
    },

    apiPeriod:
      cache.apiIssue,

    countdown:
      timing.countdown,

    timing: {

      roundSeconds:
        ROUND_SECONDS,

      roundsPassed:
        timing.roundsPassed || 0,

      estimated:
        timing.estimated,

      status:
        cache.error
          ? 'USING_LAST_VALID_DATA'
          : 'SYNCED'
    },

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

    method:
      a.method,

    latestNumber:
      a.latestNumber,

    latestPrediction:
      a.latestPrediction,

    streak:
      a.streak,

    statistics:
      a.statistics || null,

    history:
      cache.history.slice(0, 30),

    stats:
      cache.data?.stats ||
      null,

    apiError:
      cache.error || null,

    note:
      a.note
  };
}


/* ==================================================
   MAIN HANDLER
================================================== */

async function handle(req, res) {

  const u =
    new URL(
      req.url,
      'http://localhost'
    );


  /* -----------------------------------------------
     OPTIONS
  ------------------------------------------------ */

  if (req.method === 'OPTIONS') {

    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',

      'Access-Control-Allow-Headers':
        'Content-Type,X-Admin-Key,X-Access-Key,X-Device-ID',

      'Access-Control-Allow-Methods':
        'GET,POST,DELETE,OPTIONS'
    });

    return res.end();
  }


  /* -----------------------------------------------
     HEALTH
  ------------------------------------------------ */

  if (
    u.pathname === '/health' ||
    u.pathname === '/api/health'
  ) {

    return send(res, 200, {

      success: true,

      ok: true,

      service:
        'DY AI Wingo 30S',

      wingobot:
        !!TOKEN,

      cached:
        !!cache.data,

      lastSync:
        cache.lastSuccessAt || null
    });
  }


  /* =================================================
     ADMIN PING
  ================================================= */

  if (
    u.pathname === '/api/admin/ping' &&
    req.method === 'GET'
  ) {

    if (!admin(req)) {

      return send(res, 401, {
        success: false,
        error: 'UNAUTHORIZED'
      });
    }

    return send(res, 200, {
      success: true
    });
  }


  /* =================================================
     ADMIN STATUS
  ================================================= */

  if (
    u.pathname === '/api/admin/status' &&
    req.method === 'GET'
  ) {

    if (!admin(req)) {

      return send(res, 401, {
        success: false,
        error: 'UNAUTHORIZED'
      });
    }


    let database = false;

    try {
      await pool.query('SELECT 1');
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


  /* =================================================
     ADMIN KEYS GET
  ================================================= */

  if (
    u.pathname === '/api/admin/keys' &&
    req.method === 'GET'
  ) {

    if (!admin(req)) {

      return send(res, 401, {
        success: false,
        error: 'UNAUTHORIZED'
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


  /* =================================================
     ADMIN CREATE KEY
  ================================================= */

  if (
    u.pathname === '/api/admin/keys' &&
    req.method === 'POST'
  ) {

    if (!admin(req)) {

      return send(res, 401, {
        success: false,
        error: 'UNAUTHORIZED'
      });
    }


    const b =
      await body(req);


    const k =
      String(
        b.key ??
        b.access_key ??
        b.customKey ??
        ''
      ).trim()
      ||
      (
        'DY-USER-' +
        crypto
          .randomBytes(5)
          .toString('hex')
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

      if (e.code === '23505') {

        return send(res, 409, {
          success: false,
          error:
            'KEY_ALREADY_EXISTS'
        });
      }

      throw e;
    }
  }


  /* =================================================
     ADMIN DELETE KEY
  ================================================= */

  if (
    u.pathname === '/api/admin/keys' &&
    req.method === 'DELETE'
  ) {

    if (!admin(req)) {

      return send(res, 401, {
        success: false,
        error: 'UNAUTHORIZED'
      });
    }


    const b =
      await body(req);


    const k =
      String(
        b.key ??
        b.access_key ??
        ''
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


  /* =================================================
     RESET DEVICE
  ================================================= */

  if (
    u.pathname === '/api/admin/reset-device' &&
    req.method === 'POST'
  ) {

    if (!admin(req)) {

      return send(res, 401, {
        success: false,
        error: 'UNAUTHORIZED'
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
          String(
            b.key || ''
          )
        ]
      );
    }


    return send(res, 200, {
      success: true
    });
  }


  /* =================================================
     ADMIN WINGOBOT TEST
  ================================================= */

  if (
    u.pathname === '/api/admin/wingo-test' &&
    req.method === 'GET'
  ) {

    if (!admin(req)) {

      return send(res, 401, {
        success: false,
        error: 'UNAUTHORIZED'
      });
    }


    await refreshWingo();


    if (!cache.data) {

      return send(res, 502, {

        success: false,

        error:
          'WINGOBOT_API_FAILED',

        message:
          cache.error ||
          'No WingoBot data available'
      });
    }


    return send(res, 200, {

      success: true,

      source:
        'WingoBot',

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


  /* =================================================
     KEY CHECK
  ================================================= */

  if (
    u.pathname === '/api/key/check' &&
    req.method === 'GET'
  ) {

    const r =
      await auth(req, res);

    if (!r) return;


    return send(res, 200, {

      success: true,

      valid: true,

      status:
        r.device_id
          ? 'LIVE'
          : 'UNBOUND',

      key:
        r.access_key
    });
  }


  /* =================================================
     REAL AI STATE
  ================================================= */

  if (
    u.pathname === '/api/state' &&
    req.method === 'GET'
  ) {

    const r =
      await auth(req, res);

    if (!r) return;


    /*
      If there is no cached data, wait for one API
      request. Normally the background cache already
      has it.
    */

    if (!cache.data) {
      await refreshWingo();
    }


    if (!cache.data) {

      return send(res, 502, {

        success: false,

        source:
          'WingoBot',

        realHistory:
          false,

        error:
          'WINGOBOT_API_FAILED',

        message:
          cache.error ||
          'No valid WingoBot data available'
      });
    }


    return send(
      res,
      200,
      stateObject()
    );
  }


  /* =================================================
     HISTORY
  ================================================= */

  if (
    u.pathname === '/api/history' &&
    req.method === 'GET'
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

        error:
          'WINGOBOT_API_FAILED',

        message:
          cache.error ||
          'No history available'
      });
    }


    return send(res, 200, {

      success: true,

      source:
        'WingoBot',

      realHistory:
        true,

      history:
        cache.history.slice(0, 30),

      current:
        cache.data.current ||
        null,

      apiPeriod:
        cache.apiIssue,

      activePeriod:
        getTiming().period,

      stats:
        cache.data.stats ||
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
    u.pathname === '/' ||
    u.pathname === '/prediction.html'
  ) {

    file =
      'prediction.html';

  } else if (
    u.pathname === '/admin' ||
    u.pathname === '/admin.html'
  ) {

    file =
      'admin.html';

  } else if (
    u.pathname === '/music.mp3'
  ) {

    file =
      'music.mp3';

  } else {

    file =
      u.pathname.replace(
        /^\//,
        ''
      );
  }


  file =
    path.resolve(
      ROOT,
      file
    );


  const rootResolved =
    path.resolve(ROOT);


  if (
    file !== rootResolved &&
    !file.startsWith(
      rootResolved + path.sep
    )
  ) {

    return send(res, 403, {
      success: false,
      error: 'FORBIDDEN'
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
          error: 'NOT_FOUND'
        });
      }


      const ext =
        path
          .extname(file)
          .toLowerCase();


      const types = {

        '.html':
          'text/html; charset=utf-8',

        '.css':
          'text/css; charset=utf-8',

        '.js':
          'application/javascript; charset=utf-8',

        '.json':
          'application/json; charset=utf-8',

        '.png':
          'image/png',

        '.jpg':
          'image/jpeg',

        '.jpeg':
          'image/jpeg',

        '.svg':
          'image/svg+xml',

        '.mp3':
          'audio/mpeg'
      };


      /* -------------------------------------------
         MP3 RANGE
      ------------------------------------------- */

      if (
        ext === '.mp3' &&
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
              'Content-Range':
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

            'Content-Type':
              'audio/mpeg',

            'Content-Range':
              `bytes ${start}-${safeEnd}/${s.size}`,

            'Accept-Ranges':
              'bytes',

            'Content-Length':
              safeEnd - start + 1,

            'Cache-Control':
              'public, max-age=3600'
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


      /* -------------------------------------------
         NORMAL FILE
      ------------------------------------------- */

      res.writeHead(
        200,
        {

          'Content-Type':
            types[ext] ||
            'application/octet-stream',

          'Cache-Control':
            ext === '.mp3'
              ? 'public, max-age=3600'
              : 'no-store'
        }
      );


      fs
        .createReadStream(file)
        .pipe(res);
    }
  );
}


/* ==================================================
   SERVER START
================================================== */

(async () => {

  try {

    await init();

    /*
      Try loading real API data before accepting
      normal traffic.
    */

    await initialWingoLoad();


    http
      .createServer(
        (req, res) => {

          handle(req, res)
            .catch(e => {

              console.error(
                'SERVER ERROR:',
                e
              );


              if (!res.headersSent) {

                send(res, 500, {

                  success: false,

                  error:
                    e.message ||
                    'SERVER_ERROR'
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
            '================================'
          );

          console.log(
            'DY AI WINGO 30S ONLINE'
          );

          console.log(
            'PORT:',
            PORT
          );

          console.log(
            'WINGOBOT:',
            !!TOKEN
          );

          console.log(
            'REAL HISTORY:',
            cache.history.length > 0
          );

          console.log(
            'API PERIOD:',
            cache.apiIssue
          );

          console.log(
            '================================'
          );
        }
      );

  } catch (e) {

    console.error(
      'STARTUP ERROR:',
      e
    );

    process.exit(1);
  }

})();
