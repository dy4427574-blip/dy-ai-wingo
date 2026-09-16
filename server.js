const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

/* =========================================================
   CONFIG
========================================================= */

const PORT = Number(process.env.PORT || 10000);

const DATABASE_URL =
  process.env.DATABASE_URL || "";

const ADMIN_KEY =
  process.env.ADMIN_KEY || "dy4427574";

/*
  Actual Lottery7 API:
  LIVE_API_URL=https://...
  LIVE_API_TOKEN=...
*/

const LIVE_API_URL =
  process.env.LIVE_API_URL || "";

const LIVE_API_TOKEN =
  process.env.LIVE_API_TOKEN || "";

/*
  WingoBot fallback
*/

const WINGOBOT_TOKEN =
  process.env.WINGOBOT_TOKEN || "";

const WINGOBOT_URL =
  "https://api.wingobot.com/v2/30-sec-game-history";

const POLL_MS = 1000;
const COOLDOWN_ROUNDS = 5;
const THINKING_MS = 3000;

const MODEL_VERSION =
  "DY-AI-LIVE-V14";

/* =========================================================
   DATABASE
========================================================= */

if (!DATABASE_URL) {
  console.error(
    "ERROR: DATABASE_URL is missing"
  );
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

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

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    idx_prediction_target
    ON prediction_records(target_issue)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    idx_prediction_created
    ON prediction_records(created_at)
  `);

  console.log("DATABASE READY");
}

/* =========================================================
   BASIC HELPERS
========================================================= */

function now() {
  return Date.now();
}

function toNumber(v) {
  if (
    v === null ||
    v === undefined ||
    v === ""
  ) {
    return null;
  }

  const n = Number(v);

  return Number.isFinite(n)
    ? Math.trunc(n)
    : null;
}

function clamp(v, min, max) {
  return Math.max(
    min,
    Math.min(max, v)
  );
}

function percent(a, b) {
  return b
    ? (a / b) * 100
    : 0;
}

function avg(arr) {
  if (!arr.length) return 0;

  return (
    arr.reduce(
      (a, b) => a + b,
      0
    ) / arr.length
  );
}

function med(arr) {
  if (!arr.length) return 0;

  const x = [...arr].sort(
    (a, b) => a - b
  );

  const m =
    Math.floor(x.length / 2);

  return x.length % 2
    ? x[m]
    : (x[m - 1] + x[m]) / 2;
}

function opposite(x) {
  if (x === "BIG") return "SMALL";
  if (x === "SMALL") return "BIG";
  return null;
}

function resultOf(n) {
  const x = toNumber(n);

  if (
    x === null ||
    x < 0 ||
    x > 9
  ) {
    return null;
  }

  return x >= 5
    ? "BIG"
    : "SMALL";
}

/* =========================================================
   SAFE ISSUE ID
========================================================= */

function normalizeIssue(v) {
  if (
    v === null ||
    v === undefined
  ) {
    return null;
  }

  const s =
    String(v).trim();

  if (!/^\d+$/.test(s)) {
    return null;
  }

  return s;
}

function compareIssues(a, b) {
  const x =
    normalizeIssue(a);

  const y =
    normalizeIssue(b);

  if (!x || !y) return null;

  if (x.length !== y.length) {
    return x.length > y.length
      ? 1
      : -1;
  }

  if (x === y) return 0;

  return x > y ? 1 : -1;
}

function incrementIssue(v) {
  const s =
    normalizeIssue(v);

  if (!s) return null;

  const a =
    s.split("");

  let carry = 1;

  for (
    let i = a.length - 1;
    i >= 0;
    i--
  ) {
    const d =
      Number(a[i]) + carry;

    if (d >= 10) {
      a[i] = "0";
      carry = 1;
    } else {
      a[i] = String(d);
      carry = 0;
      break;
    }
  }

  if (carry) {
    a.unshift("1");
  }

  return a.join("");
}

function issueDistance(a, b) {
  const x =
    normalizeIssue(a);

  const y =
    normalizeIssue(b);

  if (
    !x ||
    !y ||
    x.length !== y.length
  ) {
    return null;
  }

  try {
    const d =
      BigInt(y) - BigInt(x);

    if (
      d < -1000000n ||
      d > 1000000n
    ) {
      return null;
    }

    return Number(d);
  } catch {
    return null;
  }
}

/* =========================================================
   HTTP HELPERS
========================================================= */

function sendJSON(
  res,
  status,
  data
) {
  const body =
    JSON.stringify(data);

  res.writeHead(status, {
    "Content-Type":
      "application/json; charset=utf-8",
    "Cache-Control":
      "no-store, no-cache, must-revalidate",
    "Pragma":
      "no-cache",
    "Access-Control-Allow-Origin":
      "*",
    "Access-Control-Allow-Headers":
      "Content-Type, X-Access-Key, X-Device-Id, X-Admin-Key",
    "Access-Control-Allow-Methods":
      "GET,POST,DELETE,OPTIONS",
    "Content-Length":
      Buffer.byteLength(body)
  });

  res.end(body);
}

function sendText(
  res,
  status,
  body,
  type = "text/plain"
) {
  res.writeHead(status, {
    "Content-Type":
      `${type}; charset=utf-8`,
    "Cache-Control":
      "no-store"
  });

  res.end(body);
}

function readBody(req) {
  return new Promise(
    (resolve, reject) => {
      let body = "";

      req.on(
        "data",
        chunk => {
          body +=
            chunk.toString();

          if (
            body.length >
            2 * 1024 * 1024
          ) {
            reject(
              new Error(
                "REQUEST_TOO_LARGE"
              )
            );

            req.destroy();
          }
        }
      );

      req.on(
        "end",
        () => {
          if (!body) {
            resolve({});
            return;
          }

          try {
            resolve(
              JSON.parse(body)
            );
          } catch {
            reject(
              new Error(
                "INVALID_JSON"
              )
            );
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

/* =========================================================
   FETCH JSON
========================================================= */

function fetchJSON(
  url,
  headers = {},
  timeout = 8000
) {
  return new Promise(
    (resolve, reject) => {
      let u;

      try {
        u = new URL(url);
      } catch {
        reject(
          new Error(
            "INVALID_URL"
          )
        );

        return;
      }

      const client =
        u.protocol === "https:"
          ? https
          : http;

      const req =
        client.request(
          u,
          {
            method: "GET",
            headers: {
              Accept:
                "application/json",
              "User-Agent":
                "DY-AI-LIVE/14.0",
              ...headers
            }
          },
          response => {
            let body = "";

            response.setEncoding(
              "utf8"
            );

            response.on(
              "data",
              chunk => {
                body += chunk;

                if (
                  body.length >
                  15 * 1024 * 1024
                ) {
                  req.destroy(
                    new Error(
                      "RESPONSE_TOO_LARGE"
                    )
                  );
                }
              }
            );

            response.on(
              "end",
              () => {
                if (
                  response.statusCode <
                    200 ||
                  response.statusCode >=
                    300
                ) {
                  reject(
                    new Error(
                      `HTTP_${response.statusCode}`
                    )
                  );

                  return;
                }

                try {
                  resolve(
                    JSON.parse(body)
                  );
                } catch {
                  reject(
                    new Error(
                      "INVALID_API_JSON"
                    )
                  );
                }
              }
            );
          }
        );

      req.setTimeout(
        timeout,
        () => {
          req.destroy(
            new Error(
              "API_TIMEOUT"
            )
          );
        }
      );

      req.on(
        "error",
        reject
      );

      req.end();
    }
  );
}

/* =========================================================
   NORMALIZE API DATA
========================================================= */

function normalizeRow(row) {
  if (
    !row ||
    typeof row !== "object"
  ) {
    return null;
  }

  const issue =
    normalizeIssue(
      row.issueNumber ??
      row.issue ??
      row.period ??
      row.periodId ??
      row.periodID ??
      row.drawNumber ??
      row.draw ??
      row.id
    );

  const number =
    toNumber(
      row.number ??
      row.resultNumber ??
      row.result ??
      row.winNumber ??
      row.digit ??
      row.openNumber
    );

  if (!issue) return null;

  if (
    number === null ||
    number < 0 ||
    number > 9
  ) {
    return null;
  }

  return {
    issue,
    number,
    result:
      resultOf(number),
    colour:
      row.colour ??
      row.color ??
      null,
    premium:
      row.premium ??
      null,
    sum:
      toNumber(row.sum)
  };
}

function extractRows(payload) {
  const arrays = [];

  if (
    Array.isArray(payload)
  ) {
    arrays.push(payload);
  }

  if (
    payload &&
    typeof payload ===
      "object"
  ) {
    const candidates = [
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
    ];

    for (
      const arr of candidates
    ) {
      if (
        Array.isArray(arr)
      ) {
        arrays.push(arr);
      }
    }
  }

  for (
    const arr of arrays
  ) {
    const out = [];

    for (
      const item of arr
    ) {
      const row =
        normalizeRow(item);

      if (row) {
        out.push(row);
      }
    }

    if (out.length) {
      return out;
    }
  }

  return [];
}

function extractCurrentIssue(
  payload
) {
  const candidates = [
    payload?.current?.issueNumber,
    payload?.current?.issue,
    payload?.currentIssue,
    payload?.current_issue,
    payload?.data?.current?.issueNumber,
    payload?.data?.current?.issue,
    payload?.result?.current?.issueNumber,
    payload?.result?.current?.issue
  ];

  for (
    const value of candidates
  ) {
    const issue =
      normalizeIssue(value);

    if (issue) {
      return issue;
    }
  }

  return null;
}

function cleanRows(rows) {
  const map =
    new Map();

  for (
    const row of rows
  ) {
    if (!row?.issue) {
      continue;
    }

    map.set(
      row.issue,
      row
    );
  }

  return [
    ...map.values()
  ].sort(
    (a, b) =>
      compareIssues(
        a.issue,
        b.issue
      ) || 0
  );
}

/* =========================================================
   LIVE API
========================================================= */

async function fetchLiveAPI() {
  if (!LIVE_API_URL) {
    throw new Error(
      "LIVE_API_URL_NOT_CONFIGURED"
    );
  }

  const headers = {};

  if (LIVE_API_TOKEN) {
    headers.Authorization =
      `Bearer ${LIVE_API_TOKEN}`;

    headers["X-API-Key"] =
      LIVE_API_TOKEN;
  }

  const payload =
    await fetchJSON(
      LIVE_API_URL,
      headers
    );

  const rows =
    cleanRows(
      extractRows(payload)
    );

  let currentIssue =
    extractCurrentIssue(
      payload
    );

  if (
    !currentIssue &&
    rows.length
  ) {
    currentIssue =
      incrementIssue(
        rows[
          rows.length - 1
        ].issue
      );
  }

  return {
    source:
      "LOTTERY7_LIVE_API",
    currentIssue,
    rows,
    fetchedAt:
      now()
  };
}

/* =========================================================
   WINGOBOT
========================================================= */

async function fetchWingoBot() {
  if (!WINGOBOT_TOKEN) {
    throw new Error(
      "WINGOBOT_TOKEN_NOT_CONFIGURED"
    );
  }

  const payload =
    await fetchJSON(
      WINGOBOT_URL,
      {
        Authorization:
          `Bearer ${WINGOBOT_TOKEN}`
      }
    );

  const rows =
    cleanRows(
      extractRows(payload)
    );

  let currentIssue =
    extractCurrentIssue(
      payload
    );

  if (
    !currentIssue &&
    rows.length
  ) {
    currentIssue =
      incrementIssue(
        rows[
          rows.length - 1
        ].issue
      );
  }

  return {
    source:
      "WINGOBOT",
    currentIssue,
    rows,
    fetchedAt:
      now()
  };
}

/* =========================================================
   LIVE CACHE
========================================================= */

const live = {
  source: null,
  currentIssue: null,
  rows: [],
  fetchedAt: 0,
  lastSuccess: 0,
  lastError: null
};

async function refreshLive() {
  /*
    1. Actual live API first.
  */

  if (LIVE_API_URL) {
    try {
      const data =
        await fetchLiveAPI();

      if (
        data.rows.length
      ) {
        live.source =
          data.source;

        live.currentIssue =
          data.currentIssue;

        live.rows =
          data.rows;

        live.fetchedAt =
          data.fetchedAt;

        live.lastSuccess =
          now();

        live.lastError =
          null;

        return data;
      }
    } catch (err) {
      live.lastError =
        "LIVE_API: " +
        err.message;

      console.error(
        live.lastError
      );
    }
  }

  /*
    2. WingoBot fallback.
  */

  if (WINGOBOT_TOKEN) {
    try {
      const data =
        await fetchWingoBot();

      if (
        data.rows.length
      ) {
        live.source =
          data.source;

        live.currentIssue =
          data.currentIssue;

        live.rows =
          data.rows;

        live.fetchedAt =
          data.fetchedAt;

        live.lastSuccess =
          now();

        live.lastError =
          null;

        return data;
      }
    } catch (err) {
      live.lastError =
        "WINGOBOT: " +
        err.message;

      console.error(
        live.lastError
      );
    }
  }

  return null;
}

/* =========================================================
   ANALYSIS: SEQUENCE
========================================================= */

function sequence(rows) {
  return rows
    .map(
      x => x.result
    )
    .filter(
      x =>
        x === "BIG" ||
        x === "SMALL"
    );
}

/* =========================================================
   WINDOWS
========================================================= */

function windowStats(
  seq,
  size
) {
  const data =
    seq.slice(-size);

  let big = 0;
  let small = 0;
  let switches = 0;

  for (
    const x of data
  ) {
    if (x === "BIG") {
      big++;
    }

    if (x === "SMALL") {
      small++;
    }
  }

  for (
    let i = 1;
    i < data.length;
    i++
  ) {
    if (
      data[i] !==
      data[i - 1]
    ) {
      switches++;
    }
  }

  return {
    size,
    total:
      data.length,
    big,
    small,
    bigPct:
      percent(
        big,
        data.length
      ),
    smallPct:
      percent(
        small,
        data.length
      ),
    switches,
    switchRate:
      data.length > 1
        ? percent(
            switches,
            data.length - 1
          )
        : 0
  };
}

/* =========================================================
   STREAKS
========================================================= */

function getStreak(seq) {
  if (!seq.length) {
    return {
      side: null,
      length: 0
    };
  }

  const side =
    seq[seq.length - 1];

  let length = 1;

  for (
    let i =
      seq.length - 2;
    i >= 0;
    i--
  ) {
    if (
      seq[i] !== side
    ) {
      break;
    }

    length++;
  }

  return {
    side,
    length
  };
}

function getRuns(seq) {
  const out = [];

  if (!seq.length) {
    return out;
  }

  let side = seq[0];
  let length = 1;

  for (
    let i = 1;
    i < seq.length;
    i++
  ) {
    if (
      seq[i] === side
    ) {
      length++;
    } else {
      out.push({
        side,
        length
      });

      side =
        seq[i];

      length = 1;
    }
  }

  out.push({
    side,
    length
  });

  return out;
}

function getRunStats(
  seq,
  side
) {
  const lengths =
    getRuns(seq)
      .filter(
        x => x.side === side
      )
      .map(
        x => x.length
      );

  const frequency = {};

  for (
    const x of lengths
  ) {
    frequency[x] =
      (frequency[x] || 0) +
      1;
  }

  let common = 0;

  if (lengths.length) {
    common =
      Number(
        Object.keys(
          frequency
        ).sort(
          (a, b) =>
            frequency[b] -
            frequency[a]
        )[0]
      );
  }

  return {
    average:
      Number(
        avg(lengths).toFixed(2)
      ),
    median:
      Number(
        med(lengths).toFixed(2)
      ),
    longest:
      lengths.length
        ? Math.max(
            ...lengths
          )
        : 0,
    common,
    count:
      lengths.length
  };
}

/* =========================================================
   ALTERNATION
========================================================= */

function alternation(seq) {
  if (seq.length < 2) {
    return {
      length: 0,
      broken: false
    };
  }

  let length = 1;

  for (
    let i =
      seq.length - 1;
    i > 0;
    i--
  ) {
    if (
      seq[i] ===
      seq[i - 1]
    ) {
      break;
    }

    length++;
  }

  return {
    length,
    broken:
      length >= 4
  };
}

/* =========================================================
   TRANSITION MATRIX
========================================================= */

function transitionMatrix(
  seq
) {
  const m = {
    BIG: {
      BIG: 0,
      SMALL: 0
    },

    SMALL: {
      BIG: 0,
      SMALL: 0
    }
  };

  for (
    let i = 1;
    i < seq.length;
    i++
  ) {
    m[
      seq[i - 1]
    ][
      seq[i]
    ]++;
  }

  return m;
}

function transitionRate(
  matrix,
  from,
  to
) {
  if (!matrix[from]) {
    return 0;
  }

  const total =
    matrix[from].BIG +
    matrix[from].SMALL;

  if (!total) {
    return 0;
  }

  return percent(
    matrix[from][to],
    total
  );
}

/* =========================================================
   MOMENTUM
========================================================= */

function getMomentum(seq) {
  if (seq.length < 10) {
    return {
      recentBig: 50,
      previousBig: 50,
      delta: 0,
      state:
        "LOW_DATA"
    };
  }

  const recent =
    seq.slice(-5);

  const previous =
    seq.slice(-10, -5);

  const recentBig =
    percent(
      recent.filter(
        x => x === "BIG"
      ).length,
      recent.length
    );

  const previousBig =
    percent(
      previous.filter(
        x => x === "BIG"
      ).length,
      previous.length
    );

  const delta =
    recentBig -
    previousBig;

  let state =
    "STABLE";

  if (delta >= 20) {
    state =
      "BIG_MOMENTUM";
  }

  if (delta <= -20) {
    state =
      "SMALL_MOMENTUM";
  }

  return {
    recentBig,
    previousBig,
    delta,
    state
  };
}

/* =========================================================
   PATTERN BLOCKS
========================================================= */

function findBlocks(seq) {
  const found = [];

  for (
    let size = 2;
    size <= 6;
    size++
  ) {
    if (
      seq.length <
      size * 2
    ) {
      continue;
    }

    const last =
      seq
        .slice(-size)
        .map(
          x =>
            x === "BIG"
              ? "B"
              : "S"
        )
        .join("");

    const previous =
      seq
        .slice(
          -size * 2,
          -size
        )
        .map(
          x =>
            x === "BIG"
              ? "B"
              : "S"
        )
        .join("");

    if (
      last === previous
    ) {
      found.push({
        length: size,
        pattern: last
      });
    }
  }

  return found;
}

/* =========================================================
   DIGIT ANALYSIS
========================================================= */

function digitAnalysis(
  rows
) {
  const frequency =
    Array(10).fill(0);

  const digits =
    rows
      .slice(-100)
      .map(
        x => x.number
      );

  for (
    const n of digits
  ) {
    if (
      Number.isInteger(n) &&
      n >= 0 &&
      n <= 9
    ) {
      frequency[n]++;
    }
  }

  return {
    frequency,
    average:
      Number(
        avg(digits).toFixed(2)
      ),
    median:
      Number(
        med(digits).toFixed(2)
      ),
    latest:
      digits.length
        ? digits[
            digits.length - 1
          ]
        : null
  };
}

/* =========================================================
   REVERSAL ENGINE
========================================================= */

function reversalEngine(
  seq,
  w30,
  matrix
) {
  const current =
    getStreak(seq);

  if (!current.side) {
    return {
      score: 0,
      max: 18,
      watch: false,
      side: null,
      components: {}
    };
  }

  const run =
    getRunStats(
      seq,
      current.side
    );

  const other =
    opposite(
      current.side
    );

  const components = {
    R1: 0,
    R2: 0,
    R3: 0,
    R4: 0,
    R5: 0,
    R6: 0
  };

  /*
    R1: unusual streak
  */

  if (
    current.length >= 3 &&
    run.average > 0 &&
    current.length >=
      run.average * 1.5
  ) {
    components.R1 = 3;
  } else if (
    current.length >= 3 &&
    current.length >
      run.average
  ) {
    components.R1 = 2;
  } else if (
    current.length >= 2
  ) {
    components.R1 = 1;
  }

  /*
    R2: transition reversal
  */

  const switchToOther =
    transitionRate(
      matrix,
      current.side,
      other
    );

  if (
    switchToOther >= 65
  ) {
    components.R2 = 3;
  } else if (
    switchToOther >= 55
  ) {
    components.R2 = 2;
  } else if (
    switchToOther >= 45
  ) {
    components.R2 = 1;
  }

  /*
    R3: recent imbalance
  */

  const sidePct =
    current.side === "BIG"
      ? w30.bigPct
      : w30.smallPct;

  if (sidePct >= 70) {
    components.R3 = 3;
  } else if (
    sidePct >= 60
  ) {
    components.R3 = 2;
  } else if (
    sidePct >= 55
  ) {
    components.R3 = 1;
  }

  /*
    R4: alternation
  */

  const alt =
    alternation(seq);

  if (
    alt.length >= 5 &&
    current.length === 1
  ) {
    components.R4 = 2;
  } else if (
    alt.length >= 4
  ) {
    components.R4 = 1;
  }

  /*
    R5: run anomaly
  */

  if (
    current.length >= 3 &&
    run.common > 0 &&
    current.length >=
      run.common + 2
  ) {
    components.R5 = 2;
  } else if (
    current.length >= 2 &&
    run.common > 0 &&
    current.length >
      run.common
  ) {
    components.R5 = 1;
  }

  /*
    R6: switching environment
  */

  if (
    w30.switchRate >= 60 &&
    current.length >= 2
  ) {
    components.R6 = 2;
  } else if (
    w30.switchRate >= 50 &&
    current.length >= 2
  ) {
    components.R6 = 1;
  }

  const score =
    Object.values(
      components
    ).reduce(
      (a, b) => a + b,
      0
    );

  return {
    score,
    max: 18,
    watch:
      score >= 8 &&
      current.length >= 2,
    side:
      score >= 8
        ? other
        : null,
    components,
    current,
    switchToOther
  };
}

/* =========================================================
   FULL ANALYSIS ENGINE
========================================================= */

function fullAnalysis(
  rows
) {
  const seq =
    sequence(rows);

  const total =
    seq.length;

  if (total < 10) {
    return {
      prediction: null,
      confidence: 0,
      signal:
        "INSUFFICIENT DATA",
      total,
      reason:
        "Need at least 10 valid results"
    };
  }

  const windows = {};

  for (
    const size of [
      5,
      10,
      20,
      30,
      50,
      100
    ]
  ) {
    windows[size] =
      windowStats(
        seq,
        Math.min(
          size,
          total
        )
      );
  }

  const current =
    getStreak(seq);

  const w5 =
    windows[5];

  const w10 =
    windows[10];

  const w20 =
    windows[20];

  const w30 =
    windows[30];

  const w50 =
    windows[50];

  const allTransitions =
    transitionMatrix(seq);

  const recentTransitions =
    transitionMatrix(
      seq.slice(-20)
    );

  const momentum =
    getMomentum(seq);

  const reversal =
    reversalEngine(
      seq,
      w30,
      allTransitions
    );

  const alt =
    alternation(seq);

  const block =
    findBlocks(seq);

  const digits =
    digitAnalysis(rows);

  const bigRuns =
    getRunStats(
      seq,
      "BIG"
    );

  const smallRuns =
    getRunStats(
      seq,
      "SMALL"
    );

  let big = 0;
  let small = 0;

  /*
    1. RECENT WINDOWS 20%
  */

  const weights = [
    [5, 0.35],
    [10, 0.30],
    [20, 0.20],
    [30, 0.15]
  ];

  for (
    const [
      size,
      weight
    ] of weights
  ) {
    const w =
      windows[size];

    big +=
      (w.bigPct / 100) *
      20 *
      weight;

    small +=
      (w.smallPct / 100) *
      20 *
      weight;
  }

  /*
    2. FREQUENCY 15%
  */

  big +=
    (w50.bigPct / 100) *
    15;

  small +=
    (w50.smallPct / 100) *
    15;

  /*
    3. STREAK STRUCTURE 10%
  */

  if (
    current.side === "BIG"
  ) {
    if (
      current.length <=
      bigRuns.average + 0.5
    ) {
      big += 6;
    } else {
      small += 6;
    }
  }

  if (
    current.side === "SMALL"
  ) {
    if (
      current.length <=
      smallRuns.average + 0.5
    ) {
      small += 6;
    } else {
      big += 6;
    }
  }

  /*
    4. SWITCHING 10%
  */

  if (
    w30.switchRate >= 60
  ) {
    if (
      current.side === "BIG"
    ) {
      small += 7;
      big += 3;
    } else {
      big += 7;
      small += 3;
    }
  } else if (
    w30.switchRate < 40
  ) {
    if (
      current.length <= 2
    ) {
      if (
        current.side === "BIG"
      ) {
        big += 7;
      } else {
        small += 7;
      }
    } else {
      if (
        current.side === "BIG"
      ) {
        small += 5;
      } else {
        big += 5;
      }
    }
  } else {
    big +=
      (w30.bigPct / 100) *
      5;

    small +=
      (w30.smallPct / 100) *
      5;
  }

  /*
    5. TRANSITION MATRIX 15%
  */

  if (current.side) {
    const nextBig =
      transitionRate(
        recentTransitions,
        current.side,
        "BIG"
      );

    const nextSmall =
      transitionRate(
        recentTransitions,
        current.side,
        "SMALL"
      );

    big +=
      (nextBig / 100) *
      15;

    small +=
      (nextSmall / 100) *
      15;
  }

  /*
    6. MOMENTUM 10%
  */

  if (
    momentum.state ===
    "BIG_MOMENTUM"
  ) {
    big += 7;
    small += 3;
  } else if (
    momentum.state ===
    "SMALL_MOMENTUM"
  ) {
    small += 7;
    big += 3;
  } else {
    big +=
      (momentum.recentBig / 100) *
      10;

    small +=
      ((100 -
        momentum.recentBig) /
        100) *
      10;
  }

  /*
    7. PATTERN 10%
  */

  if (block.length) {
    const last =
      block[
        block.length - 1
      ];

    const tail =
      seq
        .slice(-last.length)
        .map(
          x =>
            x === "BIG"
              ? "B"
              : "S"
        )
        .join("");

    if (
      tail === last.pattern
    ) {
      const before =
        seq[
          seq.length -
          last.length -
          1
        ];

      if (
        before === "BIG"
      ) {
        big += 3;
      }

      if (
        before === "SMALL"
      ) {
        small += 3;
      }
    }
  }

  /*
    8. DIGIT 5%
  */

  const lastDigits =
    rows
      .slice(-20)
      .map(
        x => x.number
      );

  const digitBig =
    lastDigits.filter(
      n => n >= 5
    ).length;

  const digitSmall =
    lastDigits.filter(
      n => n <= 4
    ).length;

  big +=
    (percent(
      digitBig,
      lastDigits.length
    ) / 100) *
    5;

  small +=
    (percent(
      digitSmall,
      lastDigits.length
    ) / 100) *
    5;

  /*
    9. REVERSAL 5%
  */

  if (reversal.watch) {
    if (
      reversal.side === "BIG"
    ) {
      big +=
        (reversal.score / 18) *
        5;
    }

    if (
      reversal.side === "SMALL"
    ) {
      small +=
        (reversal.score / 18) *
        5;
    }
  }

  /*
    NORMALIZE
  */

  const rawTotal =
    big + small;

  let bigPct =
    rawTotal
      ? (big / rawTotal) * 100
      : 50;

  let smallPct =
    rawTotal
      ? (small / rawTotal) * 100
      : 50;

  /*
    ANTI-STUCK.
    Extreme streak gets opposite pressure.
  */

  if (
    current.length >= 4
  ) {
    if (
      current.side === "BIG"
    ) {
      smallPct += 5;
      bigPct -= 5;
    } else {
      bigPct += 5;
      smallPct -= 5;
    }
  }

  /*
    Extreme last-5 imbalance.
  */

  if (
    w5.bigPct >= 80
  ) {
    smallPct += 3;
    bigPct -= 3;
  }

  if (
    w5.smallPct >= 80
  ) {
    bigPct += 3;
    smallPct -= 3;
  }

  bigPct =
    clamp(
      bigPct,
      0,
      100
    );

  smallPct =
    clamp(
      smallPct,
      0,
      100
    );

  /*
    CONFLICT PENALTY
  */

  const difference =
    Math.abs(
      bigPct -
      smallPct
    );

  let penalty = 0;

  if (
    difference < 6
  ) {
    penalty += 15;
  } else if (
    difference < 10
  ) {
    penalty += 8;
  }

  /*
    SAMPLE PENALTY
  */

  if (
    total < 20
  ) {
    penalty += 15;
  } else if (
    total < 30
  ) {
    penalty += 8;
  }

  let confidence =
    Math.round(
      clamp(
        50 +
          difference *
            0.85 -
          penalty,
        50,
        94
      )
    );

  /*
    CLASSIFICATION
  */

  let signal =
    "NO CLEAR SIGNAL";

  if (
    difference < 5
  ) {
    signal =
      "MIXED / CONFLICTING";
  } else if (
    reversal.watch &&
    reversal.score >= 10
  ) {
    signal =
      "REVERSAL WATCH";
  } else if (
    difference >= 25 &&
    confidence >= 75
  ) {
    signal =
      "STRONG HISTORICAL BIAS";
  } else if (
    difference >= 12
  ) {
    signal =
      "MODERATE HISTORICAL BIAS";
  } else {
    signal =
      "WEAK HISTORICAL BIAS";
  }

  /*
    FINAL SIGNAL ONLY IF EVIDENCE EXISTS.
  */

  let prediction = null;

  if (
    total >= 10 &&
    difference >= 6 &&
    confidence >= 55
  ) {
    prediction =
      bigPct >= smallPct
        ? "BIG"
        : "SMALL";
  }

  return {
    prediction,

    confidence,

    signal,

    total,

    scores: {
      BIG:
        Number(
          bigPct.toFixed(2)
        ),
      SMALL:
        Number(
          smallPct.toFixed(2)
        )
    },

    currentStreak:
      current,

    momentum,

    switching: {
      last5:
        w5.switchRate,
      last10:
        w10.switchRate,
      last20:
        w20.switchRate,
      last30:
        w30.switchRate,
      last50:
        w50.switchRate
    },

    transitions: {
      all:
        allTransitions,
      recent20:
        recentTransitions
    },

    reversal,

    alternation:
      alt,

    patterns:
      block,

    runs: {
      BIG:
        bigRuns,
      SMALL:
        smallRuns
    },

    digit:
      digits,

    windows,

    modelVersion:
      MODEL_VERSION,

    thinkingMs:
      THINKING_MS,

    generatedAt:
      now()
  };
}

/* =========================================================
   DATABASE PREDICTIONS
========================================================= */

async function getPending() {
  const r =
    await pool.query(`
      SELECT *
      FROM prediction_records
      WHERE actual_result IS NULL
      ORDER BY id DESC
      LIMIT 1
    `);

  return r.rows[0] || null;
}

async function getLatestPrediction() {
  const r =
    await pool.query(`
      SELECT *
      FROM prediction_records
      ORDER BY id DESC
      LIMIT 1
    `);

  return r.rows[0] || null;
}

async function getPredictions(
  limit = 100
) {
  const r =
    await pool.query(
      `
      SELECT *
      FROM prediction_records
      ORDER BY id DESC
      LIMIT $1
      `,
      [limit]
    );

  return r.rows;
}

/* =========================================================
   SETTLE PREDICTION
========================================================= */

async function settlePrediction(
  rows
) {
  const pending =
    await getPending();

  if (!pending) {
    return null;
  }

  const target =
    normalizeIssue(
      pending.target_issue
    );

  if (!target) {
    return null;
  }

  const actualRow =
    rows.find(
      x =>
        x.issue ===
        target
    );

  if (!actualRow) {
    return null;
  }

  const actual =
    resultOf(
      actualRow.number
    );

  if (!actual) {
    return null;
  }

  const prediction =
    pending.prediction;

  if (
    prediction !== "BIG" &&
    prediction !== "SMALL"
  ) {
    return null;
  }

  const outcome =
    prediction === actual
      ? "WIN"
      : "LOSS";

  await pool.query(
    `
    UPDATE prediction_records
    SET
      actual_number = $1,
      actual_result = $2,
      settled_at = $3
    WHERE id = $4
      AND actual_result IS NULL
    `,
    [
      actualRow.number,
      outcome,
      now(),
      pending.id
    ]
  );

  console.log(
    `[SETTLED] ${target} ${prediction} ${actual} ${outcome}`
  );

  return outcome;
}

/* =========================================================
   STALE PREDICTION
========================================================= */

async function cleanupStale(
  latestIssue
) {
  const pending =
    await getPending();

  if (!pending) {
    return false;
  }

  const comparison =
    compareIssues(
      pending.target_issue,
      latestIssue
    );

  if (
    comparison === null
  ) {
    return false;
  }

  if (
    comparison <= 0
  ) {
    /*
      Old target with no result available.
      Never count it as LOSS.
    */

    await pool.query(
      `
      UPDATE prediction_records
      SET
        actual_result = 'SKIPPED',
        settled_at = $1
      WHERE id = $2
        AND actual_result IS NULL
      `,
      [
        now(),
        pending.id
      ]
    );

    console.log(
      `[SKIPPED] stale target ${pending.target_issue}`
    );

    return true;
  }

  return false;
}

/* =========================================================
   COOLDOWN
========================================================= */

async function cooldown(
  latestCompleted
) {
  const last =
    await getLatestPrediction();

  if (!last) {
    return {
      active: false,
      completed: 0,
      remaining: 0
    };
  }

  /*
    Pending is NOT cooldown.
  */

  if (!last.actual_result) {
    return {
      active: false,
      completed: 0,
      remaining: 0
    };
  }

  /*
    Skipped is NOT cooldown.
  */

  if (
    last.actual_result ===
    "SKIPPED"
  ) {
    return {
      active: false,
      completed: 0,
      remaining: 0
    };
  }

  const d =
    issueDistance(
      last.target_issue,
      latestCompleted
    );

  if (
    d === null ||
    d < 0
  ) {
    return {
      active: false,
      completed: 0,
      remaining: 0
    };
  }

  if (
    d <
    COOLDOWN_ROUNDS
  ) {
    return {
      active: true,
      completed: d,
      remaining:
        COOLDOWN_ROUNDS - d,
      lastPredictionIssue:
        last.target_issue
    };
  }

  return {
    active: false,
    completed: d,
    remaining: 0,
    lastPredictionIssue:
      last.target_issue
  };
}

/* =========================================================
   CREATE PREDICTION
========================================================= */

async function insertPrediction(
  target,
  analysis
) {
  if (
    !target ||
    !analysis ||
    !analysis.prediction
  ) {
    return null;
  }

  const pending =
    await getPending();

  if (pending) {
    return pending;
  }

  const latest =
    live.rows[
      live.rows.length - 1
    ];

  if (!latest) {
    return null;
  }

  const cd =
    await cooldown(
      latest.issue
    );

  if (cd.active) {
    return null;
  }

  const r =
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
      RETURNING *
      `,
      [
        String(target),
        analysis.prediction,
        analysis.confidence,
        MODEL_VERSION,
        now()
      ]
    );

  return r.rows[0] || null;
}

/* =========================================================
   RUNTIME
========================================================= */

let modelBusy = false;

const runtime = {
  lastAnalysis: null,
  lastAnalysisAt: 0,
  lastPredictionIssue: null,
  lastPredictionAt: 0
};

/* =========================================================
   MODEL WORKER
========================================================= */

async function runModel() {
  if (modelBusy) {
    return;
  }

  modelBusy = true;

  try {
    const rows =
      cleanRows(
        live.rows
      );

    if (!rows.length) {
      return;
    }

    const latest =
      rows[
        rows.length - 1
      ];

    /*
      First settle old prediction.
    */

    await settlePrediction(
      rows
    );

    /*
      Then remove stale prediction.
    */

    await cleanupStale(
      latest.issue
    );

    /*
      If pending exists,
      don't create another.
    */

    const pending =
      await getPending();

    if (pending) {
      return;
    }

    /*
      Check cooldown.
    */

    const cd =
      await cooldown(
        latest.issue
      );

    if (cd.active) {
      return;
    }

    /*
      Target = next issue.
    */

    const target =
      incrementIssue(
        latest.issue
      );

    if (!target) {
      return;
    }

    /*
      Full analysis.
    */

    const analysis =
      fullAnalysis(rows);

    runtime.lastAnalysis =
      analysis;

    runtime.lastAnalysisAt =
      now();

    /*
      Never force weak prediction.
    */

    if (
      !analysis.prediction ||
      analysis.confidence < 55
    ) {
      return;
    }

    /*
      Duplicate target protection.
    */

    const duplicate =
      await pool.query(
        `
        SELECT id
        FROM prediction_records
        WHERE target_issue = $1
        LIMIT 1
        `,
        [target]
      );

    if (
      duplicate.rows.length
    ) {
      return;
    }

    /*
      Insert.
    */

    const prediction =
      await insertPrediction(
        target,
        analysis
      );

    if (prediction) {
      runtime.lastPredictionIssue =
        target;

      runtime.lastPredictionAt =
        now();

      console.log(
        `[PREDICTION] ${target} => ${analysis.prediction} | ${analysis.confidence}%`
      );
    }

  } catch (err) {
    console.error(
      "MODEL ERROR:",
      err.message
    );
  } finally {
    modelBusy = false;
  }
}

/* =========================================================
   ACCESS KEY
========================================================= */

async function validateAccess(
  req
) {
  const accessKey =
    String(
      req.headers[
        "x-access-key"
      ] || ""
    ).trim();

  const deviceId =
    String(
      req.headers[
        "x-device-id"
      ] || ""
    ).trim();

  if (!accessKey) {
    return {
      ok: false,
      error:
        "ACCESS_KEY_REQUIRED"
    };
  }

  if (!deviceId) {
    return {
      ok: false,
      error:
        "DEVICE_ID_REQUIRED"
    };
  }

  const r =
    await pool.query(
      `
      SELECT *
      FROM access_keys
      WHERE access_key = $1
      LIMIT 1
      `,
      [accessKey]
    );

  const key =
    r.rows[0];

  if (!key) {
    return {
      ok: false,
      error:
        "INVALID_ACCESS_KEY"
    };
  }

  /*
    First browser binds key.
  */

  if (!key.device_id) {
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
        key.id
      ]
    );

    return {
      ok: true
    };
  }

  if (
    String(key.device_id) !==
    String(deviceId)
  ) {
    return {
      ok: false,
      error:
        "DEVICE_MISMATCH"
    };
  }

  await pool.query(
    `
    UPDATE access_keys
    SET last_seen = $1
    WHERE id = $2
    `,
    [
      now(),
      key.id
    ]
  );

  return {
    ok: true
  };
}

/* =========================================================
   ADMIN
========================================================= */

function isAdmin(req) {
  return (
    String(
      req.headers[
        "x-admin-key"
      ] || ""
    ).trim() ===
    ADMIN_KEY
  );
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

/* =========================================================
   STATE
========================================================= */

async function buildState() {
  const rows =
    cleanRows(
      live.rows
    );

  const latest =
    rows[
      rows.length - 1
    ] || null;

  if (latest) {
    await settlePrediction(
      rows
    );

    await cleanupStale(
      latest.issue
    );
  }

  const pending =
    await getPending();

  const cd =
    await cooldown(
      latest?.issue ||
      null
    );

  let prediction = null;
  let targetIssue = null;
  let confidence = 0;
  let status = "WAITING";

  /*
    IMPORTANT:
    Pending prediction is always shown.
  */

  if (pending) {
    prediction =
      pending.prediction;

    targetIssue =
      pending.target_issue;

    confidence =
      Number(
        pending.confidence ||
        0
      );

    status = "PENDING";
  } else if (cd.active) {
    status = "COOLDOWN";
  } else {
    status = "ANALYSING";
  }

  /*
    LAST 30
  */

  const historyRows =
    rows
      .slice(-30)
      .reverse();

  const predictions =
    await getPredictions(
      100
    );

  const map =
    new Map();

  for (
    const p of predictions
  ) {
    map.set(
      String(
        p.target_issue
      ),
      p
    );
  }

  const history =
    historyRows.map(
      row => {
        const p =
          map.get(
            String(
              row.issue
            )
          );

        return {
          issue:
            row.issue,

          number:
            row.number,

          result:
            row.result,

          prediction:
            p?.prediction ||
            null,

          confidence:
            p
              ? Number(
                  p.confidence ||
                  0
                )
              : null,

          outcome:
            p?.actual_result ||
            null,

          predictionId:
            p?.id ||
            null
        };
      }
    );

  return {
    ok: true,

    source: {
      name:
        live.source ||
        "NONE",

      currentIssue:
        live.currentIssue,

      latestCompletedIssue:
        latest?.issue ||
        null,

      latestCompletedNumber:
        latest?.number ??
        null,

      fetchedAt:
        live.fetchedAt,

      ageMs:
        live.fetchedAt
          ? now() -
            live.fetchedAt
          : null,

      healthy:
        Boolean(
          live.lastSuccess
        ),

      error:
        live.lastError
    },

    current: {
      issue:
        live.currentIssue ||
        (
          latest
            ? incrementIssue(
                latest.issue
              )
            : null
        )
    },

    model: {
      prediction,
      targetIssue,
      confidence,
      status,
      version:
        MODEL_VERSION,
      thinkingMs:
        THINKING_MS,
      lastAnalysisAt:
        runtime.lastAnalysisAt,
      analysis:
        runtime.lastAnalysis
    },

    cooldown: cd,

    history
  };
}

/* =========================================================
   ADMIN STATUS
========================================================= */

async function adminStatus() {
  const keys =
    await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (
          WHERE device_id IS NOT NULL
        )::int AS bound,
        COUNT(*) FILTER (
          WHERE device_id IS NULL
        )::int AS unused
      FROM access_keys
    `);

  const predictions =
    await pool.query(`
      SELECT
        COUNT(*)::int AS total,

        COUNT(*) FILTER (
          WHERE actual_result = 'WIN'
        )::int AS wins,

        COUNT(*) FILTER (
          WHERE actual_result = 'LOSS'
        )::int AS losses,

        COUNT(*) FILTER (
          WHERE actual_result = 'SKIPPED'
        )::int AS skipped,

        COUNT(*) FILTER (
          WHERE actual_result IS NULL
        )::int AS pending
      FROM prediction_records
    `);

  return {
    ok: true,

    keys:
      keys.rows[0],

    predictions:
      predictions.rows[0],

    live: {
      source:
        live.source,

      currentIssue:
        live.currentIssue,

      latestCompletedIssue:
        live.rows.length
          ? live.rows[
              live.rows.length - 1
            ].issue
          : null,

      rows:
        live.rows.length,

      fetchedAt:
        live.fetchedAt,

      ageMs:
        live.fetchedAt
          ? now() -
            live.fetchedAt
          : null,

      healthy:
        Boolean(
          live.lastSuccess
        ),

      error:
        live.lastError
    },

    model: {
      version:
        MODEL_VERSION,

      lastPredictionIssue:
        runtime.lastPredictionIssue,

      lastPredictionAt:
        runtime.lastPredictionAt,

      lastAnalysisAt:
        runtime.lastAnalysisAt
    }
  };
}

/* =========================================================
   STATIC FILES
========================================================= */

const MIME = {
  ".html":
    "text/html",
  ".css":
    "text/css",
  ".js":
    "application/javascript",
  ".json":
    "application/json",
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
  ".webp":
    "image/webp",
  ".mp3":
    "audio/mpeg",
  ".wav":
    "audio/wav"
};

function serveStatic(
  req,
  res,
  pathname
) {
  let file;

  if (
    pathname === "/" ||
    pathname === ""
  ) {
    file =
      path.join(
        process.cwd(),
        "prediction.html"
      );
  } else {
    const clean =
      pathname
        .replace(/^\/+/, "")
        .replace(/\.\./g, "");

    file =
      path.join(
        process.cwd(),
        clean
      );
  }

  if (!fs.existsSync(file)) {
    sendText(
      res,
      404,
      "Not Found"
    );

    return;
  }

  const ext =
    path.extname(file)
      .toLowerCase();

  const type =
    MIME[ext] ||
    "application/octet-stream";

  /*
    MP3 range support.
  */

  if (ext === ".mp3") {
    const stat =
      fs.statSync(file);

    const total =
      stat.size;

    const range =
      req.headers.range;

    if (range) {
      const match =
        /bytes=(\d*)-(\d*)/.exec(
          range
        );

      if (match) {
        const start =
          match[1]
            ? Number(
                match[1]
              )
            : 0;

        const end =
          match[2]
            ? Number(
                match[2]
              )
            : total - 1;

        const safeStart =
          clamp(
            start,
            0,
            total - 1
          );

        const safeEnd =
          clamp(
            end,
            safeStart,
            total - 1
          );

        const length =
          safeEnd -
          safeStart +
          1;

        res.writeHead(
          206,
          {
            "Content-Type":
              type,

            "Content-Range":
              `bytes ${safeStart}-${safeEnd}/${total}`,

            "Accept-Ranges":
              "bytes",

            "Content-Length":
              length
          }
        );

        fs.createReadStream(
          file,
          {
            start:
              safeStart,
            end:
              safeEnd
          }
        ).pipe(res);

        return;
      }
    }

    res.writeHead(
      200,
      {
        "Content-Type":
          type,

        "Content-Length":
          total,

        "Accept-Ranges":
          "bytes"
      }
    );

    fs.createReadStream(
      file
    ).pipe(res);

    return;
  }

  fs.readFile(
    file,
    (err, data) => {
      if (err) {
        sendText(
          res,
          500,
          "FILE_READ_ERROR"
        );

        return;
      }

      res.writeHead(
        200,
        {
          "Content-Type":
            `${type}; charset=utf-8`,
          "Cache-Control":
            "no-cache"
        }
      );

      res.end(data);
    }
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
        /*
          CORS
        */

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
                "Content-Type, X-Access-Key, X-Device-Id, X-Admin-Key",

              "Access-Control-Allow-Methods":
                "GET,POST,DELETE,OPTIONS"
            }
          );

          res.end();

          return;
        }

        const url =
          new URL(
            req.url,
            `http://${req.headers.host || "localhost"}`
          );

        const pathname =
          url.pathname;

        /* ===============================================
           HEALTH
        =============================================== */

        if (
          pathname ===
            "/health"
        ) {
          sendJSON(
            res,
            200,
            {
              ok: true,
              service:
                "DY AI WinGo",
              version:
                MODEL_VERSION,
              uptime:
                process.uptime(),
              time:
                now()
            }
          );

          return;
        }

        /* ===============================================
           KEY CHECK
        =============================================== */

        if (
          pathname ===
            "/api/key/check" &&
          req.method ===
            "GET"
        ) {
          const auth =
            await validateAccess(
              req
            );

          sendJSON(
            res,
            auth.ok
              ? 200
              : 401,
            auth
          );

          return;
        }

        /* ===============================================
           STATE
        =============================================== */

        if (
          pathname ===
            "/api/state" &&
          req.method ===
            "GET"
        ) {
          const auth =
            await validateAccess(
              req
            );

          if (!auth.ok) {
            sendJSON(
              res,
              401,
              auth
            );

            return;
          }

          sendJSON(
            res,
            200,
            await buildState()
          );

          return;
        }

        /* ===============================================
           HISTORY
        =============================================== */

        if (
          pathname ===
            "/api/history" &&
          req.method ===
            "GET"
        ) {
          const auth =
            await validateAccess(
              req
            );

          if (!auth.ok) {
            sendJSON(
              res,
              401,
              auth
            );

            return;
          }

          sendJSON(
            res,
            200,
            {
              ok: true,
              history:
                await getPredictions(
                  100
                )
            }
          );

          return;
        }

        /* ===============================================
           ADMIN AUTH
        =============================================== */

        if (
          pathname.startsWith(
            "/api/admin/"
          )
        ) {
          if (!isAdmin(req)) {
            sendJSON(
              res,
              401,
              {
                ok: false,
                error:
                  "ADMIN_AUTH_REQUIRED"
              }
            );

            return;
          }
        }

        /* ===============================================
           ADMIN STATUS
        =============================================== */

        if (
          pathname ===
            "/api/admin/status" &&
          req.method ===
            "GET"
        ) {
          sendJSON(
            res,
            200,
            await adminStatus()
          );

          return;
        }

        /* ===============================================
           ADMIN PING
        =============================================== */

        if (
          pathname ===
            "/api/admin/ping" &&
          req.method ===
            "GET"
        ) {
          sendJSON(
            res,
            200,
            {
              ok: true,
              admin: true,
              time:
                now()
            }
          );

          return;
        }

        /* ===============================================
           LIVE API TEST
        =============================================== */

        if (
          pathname ===
            "/api/admin/live-test" &&
          req.method ===
            "GET"
        ) {
          if (!LIVE_API_URL) {
            sendJSON(
              res,
              400,
              {
                ok: false,
                error:
                  "LIVE_API_URL_NOT_CONFIGURED"
              }
            );

            return;
          }

          try {
            const data =
              await fetchLiveAPI();

            sendJSON(
              res,
              200,
              {
                ok: true,
                source:
                  data.source,
                currentIssue:
                  data.currentIssue,
                rows:
                  data.rows.length,
                latest:
                  data.rows.length
                    ? data.rows[
                        data.rows.length -
                          1
                      ]
                    : null
              }
            );
          } catch (err) {
            sendJSON(
              res,
              500,
              {
                ok: false,
                error:
                  err.message
              }
            );
          }

          return;
        }

        /* ===============================================
           WINGOBOT TEST
        =============================================== */

        if (
          pathname ===
            "/api/admin/wingo-test" &&
          req.method ===
            "GET"
        ) {
          try {
            const data =
              await fetchWingoBot();

            sendJSON(
              res,
              200,
              {
                ok: true,
                source:
                  data.source,
                currentIssue:
                  data.currentIssue,
                rows:
                  data.rows.length,
                latest:
                  data.rows.length
                    ? data.rows[
                        data.rows.length -
                          1
                      ]
                    : null
              }
            );
          } catch (err) {
            sendJSON(
              res,
              500,
              {
                ok: false,
                error:
                  err.message
              }
            );
          }

          return;
        }

        /* ===============================================
           MODEL TEST
        =============================================== */

        if (
          pathname ===
            "/api/admin/model-test" &&
          req.method ===
            "GET"
        ) {
          sendJSON(
            res,
            200,
            {
              ok: true,
              analysis:
                fullAnalysis(
                  cleanRows(
                    live.rows
                  )
                )
            }
          );

          return;
        }

        /* ===============================================
           ADMIN PREDICTIONS
        =============================================== */

        if (
          pathname ===
            "/api/admin/predictions" &&
          req.method ===
            "GET"
        ) {
          sendJSON(
            res,
            200,
            {
              ok: true,
              predictions:
                await getPredictions(
                  200
                )
            }
          );

          return;
        }

        /* ===============================================
           ADMIN KEYS - GET
        =============================================== */

        if (
          pathname ===
            "/api/admin/keys" &&
          req.method ===
            "GET"
        ) {
          const r =
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

          sendJSON(
            res,
            200,
            {
              ok: true,
              keys:
                r.rows
            }
          );

          return;
        }

        /* ===============================================
           ADMIN KEYS - CREATE
        =============================================== */

        if (
          pathname ===
            "/api/admin/keys" &&
          req.method ===
            "POST"
        ) {
          let body;

          try {
            body =
              await readBody(
                req
              );
          } catch (err) {
            sendJSON(
              res,
              400,
              {
                ok: false,
                error:
                  err.message
              }
            );

            return;
          }

          const requested =
            String(
              body.access_key ||
              body.key ||
              ""
            ).trim();

          const accessKey =
            requested ||
            generateKey();

          if (
            accessKey.length < 4
          ) {
            sendJSON(
              res,
              400,
              {
                ok: false,
                error:
                  "KEY_TOO_SHORT"
              }
            );

            return;
          }

          try {
            const r =
              await pool.query(
                `
                INSERT INTO access_keys
                (
                  access_key,
                  created_at
                )
                VALUES
                ($1,$2)
                RETURNING *
                `,
                [
                  accessKey,
                  now()
                ]
              );

            sendJSON(
              res,
              200,
              {
                ok: true,
                key:
                  r.rows[0]
              }
            );
          } catch (err) {
            if (
              err.code ===
              "23505"
            ) {
              sendJSON(
                res,
                409,
                {
                  ok: false,
                  error:
                    "KEY_ALREADY_EXISTS"
                }
              );
            } else {
              throw err;
            }
          }

          return;
        }

        /* ===============================================
           ADMIN KEYS - DELETE
        =============================================== */

        if (
          pathname ===
            "/api/admin/keys" &&
          req.method ===
            "DELETE"
        ) {
          const id =
            url.searchParams.get(
              "id"
            );

          const key =
            url.searchParams.get(
              "key"
            );

          if (
            !id &&
            !key
          ) {
            sendJSON(
              res,
              400,
              {
                ok: false,
                error:
                  "ID_OR_KEY_REQUIRED"
              }
            );

            return;
          }

          if (id) {
            await pool.query(
              `
              DELETE FROM access_keys
              WHERE id = $1
              `,
              [id]
            );
          } else {
            await pool.query(
              `
              DELETE FROM access_keys
              WHERE access_key = $1
              `,
              [key]
            );
          }

          sendJSON(
            res,
            200,
            {
              ok: true
            }
          );

          return;
        }

        /* ===============================================
           RESET DEVICE
        =============================================== */

        if (
          pathname ===
            "/api/admin/reset-device" &&
          req.method ===
            "POST"
        ) {
          let body;

          try {
            body =
              await readBody(
                req
              );
          } catch (err) {
            sendJSON(
              res,
              400,
              {
                ok: false,
                error:
                  err.message
              }
            );

            return;
          }

          const id =
            body.id;

          const key =
            body.access_key ||
            body.key;

          if (
            !id &&
            !key
          ) {
            sendJSON(
              res,
              400,
              {
                ok: false,
                error:
                  "ID_OR_KEY_REQUIRED"
              }
            );

            return;
          }

          if (id) {
            await pool.query(
              `
              UPDATE access_keys
              SET device_id = NULL
              WHERE id = $1
              `,
              [id]
            );
          } else {
            await pool.query(
              `
              UPDATE access_keys
              SET device_id = NULL
              WHERE access_key = $1
              `,
              [key]
            );
          }

          sendJSON(
            res,
            200,
            {
              ok: true
            }
          );

          return;
        }

        /* ===============================================
           STATIC
        =============================================== */

        serveStatic(
          req,
          res,
          pathname
        );

      } catch (err) {
        console.error(
          "SERVER ERROR:",
          err
        );

        if (
          !res.headersSent
        ) {
          sendJSON(
            res,
            500,
            {
              ok: false,
              error:
                "INTERNAL_SERVER_ERROR",
              message:
                err.message
            }
          );
        } else {
          res.end();
        }
      }
    }
  );

/* =========================================================
   LIVE WORKER
========================================================= */

let workerBusy = false;

async function liveWorker() {
  if (workerBusy) {
    return;
  }

  workerBusy = true;

  try {
    await refreshLive();

    if (
      live.rows.length
    ) {
      await runModel();
    }
  } catch (err) {
    console.error(
      "WORKER ERROR:",
      err.message
    );
  } finally {
    workerBusy = false;
  }
}

/* =========================================================
   START
========================================================= */

async function start() {
  await initDB();

  server.listen(
    PORT,
    "0.0.0.0",
    () => {
      console.log(
        "================================"
      );

      console.log(
        `DY AI SERVER : ${PORT}`
      );

      console.log(
        `MODEL : ${MODEL_VERSION}`
      );

      console.log(
        `POLL : ${POLL_MS}ms`
      );

      console.log(
        `COOLDOWN : ${COOLDOWN_ROUNDS}`
      );

      console.log(
        `LIVE API : ${
          LIVE_API_URL
            ? "CONFIGURED"
            : "NOT CONFIGURED"
        }`
      );

      console.log(
        `WINGOBOT : ${
          WINGOBOT_TOKEN
            ? "CONFIGURED"
            : "NOT CONFIGURED"
        }`
      );

      console.log(
        "================================"
      );

      /*
        Initial live request.
      */

      liveWorker();

      /*
        Continue live polling.
      */

      setInterval(
        liveWorker,
        POLL_MS
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
    `${signal} received`
  );

  try {
    await pool.end();
  } catch (err) {
    console.error(
      "DB CLOSE:",
      err.message
    );
  }

  server.close(
    () => {
      process.exit(0);
    }
  );

  setTimeout(
    () => {
      process.exit(1);
    },
    5000
  );
}

process.on(
  "SIGTERM",
  () =>
    shutdown("SIGTERM")
);

process.on(
  "SIGINT",
  () =>
    shutdown("SIGINT")
);

process.on(
  "unhandledRejection",
  err => {
    console.error(
      "UNHANDLED REJECTION:",
      err
    );
  }
);

process.on(
  "uncaughtException",
  err => {
    console.error(
      "UNCAUGHT EXCEPTION:",
      err
    );
  }
);

/* =========================================================
   RUN
========================================================= */

start().catch(
  err => {
    console.error(
      "STARTUP FAILED:",
      err
    );

    process.exit(1);
  }
);
