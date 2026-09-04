"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

/* =========================================================
   CONFIG
========================================================= */

const PORT = Number(process.env.PORT || 10000);

const ADMIN_KEY = String(
  process.env.ADMIN_KEY || ""
).trim();

const WINGOBOT_TOKEN = String(
  process.env.WINGOBOT_TOKEN || ""
).trim();

const DATABASE_URL = String(
  process.env.DATABASE_URL || ""
).trim();

const HOST = "0.0.0.0";

const WINGOBOT_API =
  "https://api.wingobot.com/v2/30-sec-game-history";

const PUBLIC_DIR = path.resolve(__dirname);

const MODEL_VERSION = "DY-AI-STAT-V3";

const THINKING_DURATION_MS = 4000;


/* =========================================================
   DATABASE
========================================================= */

let pool = null;

if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });
}


async function initDatabase() {

  if (!pool) {
    console.log(
      "DATABASE_URL not configured"
    );
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
    CREATE INDEX IF NOT EXISTS idx_prediction_target
    ON prediction_records(target_issue)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_prediction_created
    ON prediction_records(created_at DESC)
  `);

  console.log("Database ready");
}


/* =========================================================
   MEMORY STATE
========================================================= */

let providerState = {
  ok: false,
  currentIssue: null,
  history: [],
  fetched: 0,
  lastUpdated: 0,
  error: null,
  fetchedAt: 0
};


let modelCache = {
  targetIssue: null,
  prediction: null,

  confidence: 0,
  confidenceLevel: "LOW",

  reason: "",

  modelVersion:
    MODEL_VERSION,

  generatedAt: 0,

  thinkingDurationMs:
    THINKING_DURATION_MS,

  analysis: null
};


/* =========================================================
   HELPERS
========================================================= */

function now() {
  return Date.now();
}


function json(res, status, data) {

  const body =
    JSON.stringify(data);

  res.writeHead(status, {
    "Content-Type":
      "application/json; charset=utf-8",

    "Cache-Control":
      "no-store",

    "Access-Control-Allow-Origin":
      "*",

    "Access-Control-Allow-Headers":
      "Content-Type, X-Access-Key, X-Device-Id, X-Admin-Key, Authorization",

    "Access-Control-Allow-Methods":
      "GET, POST, DELETE, OPTIONS"
  });

  res.end(body);
}


function text(
  res,
  status,
  body,
  type = "text/plain"
) {

  const contentType =
    type.includes("charset")
      ? type
      : `${type}; charset=utf-8`;

  res.writeHead(status, {
    "Content-Type":
      contentType,

    "Cache-Control":
      "no-store"
  });

  res.end(body);
}


function safeNumber(value) {

  const n =
    Number(value);

  return Number.isFinite(n)
    ? n
    : null;
}


function issueString(value) {

  if (
    value === undefined ||
    value === null
  ) {
    return null;
  }

  return (
    String(value).trim() || null
  );
}


function incrementIssue(issue) {

  const s =
    issueString(issue);

  if (!s) {
    return null;
  }

  if (/^\d+$/.test(s)) {

    try {

      return (
        BigInt(s) + 1n
      ).toString();

    } catch {

      return null;
    }
  }

  return null;
}


function clamp(
  value,
  min,
  max
) {

  return Math.max(
    min,
    Math.min(
      max,
      value
    )
  );
}


function round2(value) {

  return Number(
    Number(value || 0)
      .toFixed(2)
  );
}


function percentage(
  count,
  total
) {

  if (!total) {
    return 0;
  }

  return round2(
    (count / total) * 100
  );
}


/* =========================================================
   RESULT NORMALIZATION
========================================================= */

function normalizeResult(row) {

  if (!row) {
    return null;
  }

  const number =
    safeNumber(
      row.number ??
      row.resultNumber ??
      row.digit
    );

  if (
    number !== null &&
    Number.isInteger(number) &&
    number >= 0 &&
    number <= 9
  ) {

    return number >= 5
      ? "BIG"
      : "SMALL";
  }


  const raw =
    String(
      row.result ??
      row.bigSmall ??
      row.size ??
      ""
    )
      .trim()
      .toUpperCase();


  if (raw === "BIG") {
    return "BIG";
  }

  if (raw === "SMALL") {
    return "SMALL";
  }

  return null;
}


function normalizeHistory(input) {

  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map((row) => {

      const issue =
        issueString(
          row.issueNumber ??
          row.issue ??
          row.period ??
          row.periodNumber
        );


      const number =
        safeNumber(
          row.number ??
          row.resultNumber ??
          row.digit
        );


      const result =
        normalizeResult(row);


      return {

        issueNumber:
          issue,

        number:
          number !== null &&
          Number.isInteger(number) &&
          number >= 0 &&
          number <= 9
            ? number
            : null,

        result,

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
      };

    })
    .filter(
      (x) =>
        x.issueNumber
    );
}


/* =========================================================
   WINGOBOT FETCH
========================================================= */

function fetchJson(
  url,
  headers = {}
) {

  return new Promise(
    (resolve, reject) => {

      const request =
        https.get(
          url,
          {
            headers: {
              Accept:
                "application/json",

              "User-Agent":
                "DY-AI-Wingo/3.0",

              ...headers
            },

            timeout: 15000
          },

          (response) => {

            let body = "";

            response.setEncoding(
              "utf8"
            );


            response.on(
              "data",
              (chunk) => {
                body += chunk;
              }
            );


            response.on(
              "end",
              () => {

                const status =
                  response.statusCode ||
                  0;


                if (
                  status < 200 ||
                  status >= 300
                ) {

                  reject(
                    new Error(
                      `WingoBot HTTP ${status}: ${body.slice(0, 300)}`
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
                      "WingoBot returned invalid JSON"
                    )
                  );
                }
              }
            );
          }
        );


      request.on(
        "timeout",
        () => {

          request.destroy(
            new Error(
              "WingoBot request timeout"
            )
          );
        }
      );


      request.on(
        "error",
        reject
      );
    }
  );
}


async function refreshProvider() {

  if (!WINGOBOT_TOKEN) {

    providerState.ok =
      false;

    providerState.error =
      "WINGOBOT_TOKEN environment variable missing";

    return;
  }


  try {

    const data =
      await fetchJson(
        WINGOBOT_API,
        {
          Authorization:
            `Bearer ${WINGOBOT_TOKEN}`
        }
      );


    const history =
      normalizeHistory(
        data.history
      );


    const currentIssue =
      issueString(
        data?.current?.issueNumber ??
        data?.current?.issue ??
        null
      );


    let lastUpdated =
      safeNumber(
        data?.stats?.last_updated ??
        data?.last_updated
      ) || 0;


    /*
      Seconds / milliseconds dono handle.
    */

    if (
      lastUpdated > 0 &&
      lastUpdated < 100000000000
    ) {

      lastUpdated *= 1000;
    }


    providerState = {

      ok: true,

      currentIssue,

      history,

      fetched:
        safeNumber(
          data?.stats?.fetched
        ) ||
        history.length,

      lastUpdated,

      error: null,

      fetchedAt:
        now()
    };


    /*
      Exact issue settlement.
    */

    await settlePredictions(
      history
    );


    const target =
      resolveTargetIssue();


    /*
      Target change hone par complete analysis
      dobara calculate hoga.
    */

    if (
      target &&
      modelCache.targetIssue !==
        target
    ) {

      generatePrediction();
    }

  } catch (error) {

    providerState.ok =
      false;

    providerState.error =
      error?.message ||
      "Provider error";


    console.error(
      "Provider refresh error:",
      providerState.error
    );
  }
}


/* =========================================================
   TARGET ISSUE
========================================================= */

function resolveTargetIssue() {

  const history =
    providerState.history ||
    [];


  const latestSettled =
    history.length > 0
      ? history[0]?.issueNumber
      : null;


  const current =
    providerState.currentIssue;


  if (
    current &&
    latestSettled
  ) {

    if (
      compareNumericIssues(
        current,
        latestSettled
      ) > 0
    ) {

      return current;
    }


    return incrementIssue(
      latestSettled
    );
  }


  if (current) {
    return current;
  }


  if (latestSettled) {

    return incrementIssue(
      latestSettled
    );
  }


  return null;
}


function compareNumericIssues(
  a,
  b
) {

  const x =
    issueString(a);

  const y =
    issueString(b);


  if (!x || !y) {
    return 0;
  }


  if (
    /^\d+$/.test(x) &&
    /^\d+$/.test(y)
  ) {

    try {

      const bx =
        BigInt(x);

      const by =
        BigInt(y);


      if (bx > by) {
        return 1;
      }

      if (bx < by) {
        return -1;
      }

      return 0;

    } catch {

      return x.localeCompare(y);
    }
  }


  return x.localeCompare(y);
}


/* =========================================================
   BASIC SEQUENCE
========================================================= */

function getResults(
  rows,
  limit = 50
) {

  return (rows || [])
    .map(normalizeResult)
    .filter(Boolean)
    .slice(0, limit);
}


/*
  Provider history newest -> oldest.
  For current streak:
  sequence[0] = latest settled result.
*/


function convertSequence(rows) {

  return getResults(
    rows,
    50
  );
}


/* =========================================================
   FREQUENCY ANALYSIS
========================================================= */

function frequencyAnalysis(sequence) {

  const total =
    sequence.length;


  const bigCount =
    sequence.filter(
      x => x === "BIG"
    ).length;


  const smallCount =
    sequence.filter(
      x => x === "SMALL"
    ).length;


  return {

    total,

    bigCount,

    smallCount,

    bigPercent:
      percentage(
        bigCount,
        total
      ),

    smallPercent:
      percentage(
        smallCount,
        total
      )
  };
}


function calculateWindow(
  sequence,
  size
) {

  const data =
    sequence.slice(
      0,
      size
    );


  const frequency =
    frequencyAnalysis(
      data
    );


  const switching =
    switchingAnalysis(
      data
    );


  const streak =
    currentStreak(
      data
    );


  return {

    size,

    available:
      data.length,

    bigCount:
      frequency.bigCount,

    smallCount:
      frequency.smallCount,

    bigPercent:
      frequency.bigPercent,

    smallPercent:
      frequency.smallPercent,

    currentStreak:
      streak,

    switches:
      switching.switches,

    transitions:
      switching.transitions,

    switchRate:
      switching.switchRate,

    dominant:
      frequency.bigCount >
      frequency.smallCount
        ? "BIG"
        : frequency.smallCount >
          frequency.bigCount
          ? "SMALL"
          : "BALANCED"
  };
}


/* =========================================================
   STREAK ANALYSIS
========================================================= */

function currentStreak(
  sequence
) {

  if (!sequence.length) {

    return {
      side: null,
      length: 0
    };
  }


  const side =
    sequence[0];


  let length = 1;


  for (
    let i = 1;
    i < sequence.length;
    i++
  ) {

    if (
      sequence[i] !== side
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


function runLengths(
  sequence
) {

  const runs = [];


  if (!sequence.length) {
    return runs;
  }


  let side =
    sequence[0];

  let length = 1;


  for (
    let i = 1;
    i < sequence.length;
    i++
  ) {

    if (
      sequence[i] === side
    ) {

      length++;

    } else {

      runs.push({
        side,
        length
      });

      side =
        sequence[i];

      length = 1;
    }
  }


  runs.push({
    side,
    length
  });


  return runs;
}


function countRunLengths(
  runs,
  side
) {

  const counts = {};


  for (
    const run of runs
  ) {

    if (
      run.side !== side
    ) {
      continue;
    }


    counts[run.length] =
      (counts[run.length] || 0) +
      1;
  }


  return counts;
}


function modeRunLength(
  runs,
  side
) {

  const counts =
    countRunLengths(
      runs,
      side
    );


  const entries =
    Object.entries(counts);


  if (!entries.length) {
    return null;
  }


  entries.sort(
    (a, b) => {

      if (
        Number(b[1]) !==
        Number(a[1])
      ) {

        return (
          Number(b[1]) -
          Number(a[1])
        );
      }


      return (
        Number(a[0]) -
        Number(b[0])
      );
    }
  );


  return Number(
    entries[0][0]
  );
}


function longestRun(
  runs,
  side
) {

  const values =
    runs
      .filter(
        r =>
          r.side === side
      )
      .map(
        r =>
          r.length
      );


  return values.length
    ? Math.max(...values)
    : 0;
}


function runAnalysis(
  sequence
) {

  const runs =
    runLengths(
      sequence
    );


  const current =
    currentStreak(
      sequence
    );


  const bigRuns =
    runs.filter(
      r =>
        r.side === "BIG"
    );


  const smallRuns =
    runs.filter(
      r =>
        r.side === "SMALL"
    );


  return {

    runs,

    currentStreak:
      current,

    mostCommonBigStreak:
      modeRunLength(
        runs,
        "BIG"
      ),

    mostCommonSmallStreak:
      modeRunLength(
        runs,
        "SMALL"
      ),

    longestBigStreak:
      longestRun(
        runs,
        "BIG"
      ),

    longestSmallStreak:
      longestRun(
        runs,
        "SMALL"
      ),

    bigRunCount:
      bigRuns.length,

    smallRunCount:
      smallRuns.length,

    distribution: {
      big:
        countRunLengths(
          runs,
          "BIG"
        ),

      small:
        countRunLengths(
          runs,
          "SMALL"
        )
    }
  };
}


/* =========================================================
   SWITCHING ANALYSIS
========================================================= */

function switchingAnalysis(
  sequence
) {

  let switches = 0;

  const transitions =
    Math.max(
      0,
      sequence.length - 1
    );


  for (
    let i = 0;
    i < sequence.length - 1;
    i++
  ) {

    if (
      sequence[i] !==
      sequence[i + 1]
    ) {

      switches++;
    }
  }


  const switchRate =
    percentage(
      switches,
      transitions
    );


  let classification =
    "BALANCED";


  if (
    switchRate >= 65
  ) {

    classification =
      "HIGH SWITCHING";

  } else if (
    switchRate <= 35
  ) {

    classification =
      "LOW SWITCHING";
  }


  return {

    switches,

    transitions,

    switchRate,

    classification
  };
}


/* =========================================================
   TRANSITION MATRIX
========================================================= */

function transitionAnalysis(
  sequence
) {

  let BB = 0;
  let BS = 0;
  let SB = 0;
  let SS = 0;


  /*
    sequence newest -> oldest.

    Chronological transition:
    older state -> newer state

    Therefore:
    previous = sequence[i + 1]
    next     = sequence[i]
  */

  for (
    let i = 0;
    i < sequence.length - 1;
    i++
  ) {

    const previous =
      sequence[i + 1];

    const next =
      sequence[i];


    if (
      previous === "BIG" &&
      next === "BIG"
    ) {
      BB++;
    }


    if (
      previous === "BIG" &&
      next === "SMALL"
    ) {
      BS++;
    }


    if (
      previous === "SMALL" &&
      next === "BIG"
    ) {
      SB++;
    }


    if (
      previous === "SMALL" &&
      next === "SMALL"
    ) {
      SS++;
    }
  }


  const afterBig =
    BB + BS;


  const afterSmall =
    SB + SS;


  return {

    counts: {

      BB,
      BS,
      SB,
      SS
    },


    probabilities: {

      "B→B":
        percentage(
          BB,
          afterBig
        ),

      "B→S":
        percentage(
          BS,
          afterBig
        ),

      "S→B":
        percentage(
          SB,
          afterSmall
        ),

      "S→S":
        percentage(
          SS,
          afterSmall
        )
    },


    previousStateTotals: {

      BIG:
        afterBig,

      SMALL:
        afterSmall
    },


    sampleSize:
      Math.max(
        0,
        sequence.length - 1
      )
  };
}


/* =========================================================
   PATTERN DETECTION HELPERS
========================================================= */

function alternatingPattern(
  sequence
) {

  if (
    sequence.length < 2
  ) {

    return {
      detected: false,
      length: sequence.length
    };
  }


  let length = 1;


  for (
    let i = 1;
    i < sequence.length;
    i++
  ) {

    if (
      sequence[i] ===
      sequence[i - 1]
    ) {

      break;
    }

    length++;
  }


  return {

    detected:
      length >= 4,

    length,

    sequence:
      sequence
        .slice(0, length)
        .join("-")
  };
}


function repeatedBlockPattern(
  sequence,
  blockSize
) {

  if (
    sequence.length <
    blockSize * 2
  ) {

    return {
      detected: false,
      blockSize,
      repetitions: 0
    };
  }


  const recent =
    sequence.slice(
      0,
      blockSize * 3
    );


  const firstBlock =
    recent.slice(
      0,
      blockSize
    );


  let repetitions = 1;


  for (
    let start = blockSize;
    start + blockSize <= recent.length;
    start += blockSize
  ) {

    const block =
      recent.slice(
        start,
        start + blockSize
      );


    if (
      block.join("") ===
      firstBlock.join("")
    ) {

      repetitions++;

    } else {

      break;
    }
  }


  return {

    detected:
      repetitions >= 2,

    blockSize,

    repetitions,

    block:
      firstBlock.join("-")
  };
}


function runStructurePattern(
  sequence,
  firstLength,
  secondLength
) {

  const runs =
    runLengths(
      sequence
    );


  if (
    runs.length < 4
  ) {

    return {
      detected: false,
      runPattern:
        `${firstLength}-${secondLength}`
    };
  }


  let matches = 0;


  /*
    Run order newest -> oldest.
    We only compare lengths.
  */

  for (
    let i = 0;
    i < runs.length - 1;
    i += 2
  ) {

    const a =
      runs[i]?.length;

    const b =
      runs[i + 1]?.length;


    if (
      a === firstLength &&
      b === secondLength
    ) {

      matches++;
    }
  }


  return {

    detected:
      matches >= 2,

    matches,

    runPattern:
      `${firstLength}-${secondLength}`
  };
}


function increasingRuns(
  sequence
) {

  const runs =
    runLengths(
      sequence
    );


  if (
    runs.length < 4
  ) {

    return {
      detected: false,
      lengths:
        runs.map(
          r =>
            r.length
        )
    };
  }


  /*
    Check chronological order.
    Since array is newest -> oldest,
    reverse run lengths first.
  */

  const lengths =
    runs
      .map(
        r =>
          r.length
      )
      .reverse();


  let increasingPairs = 0;


  for (
    let i = 1;
    i < lengths.length;
    i++
  ) {

    if (
      lengths[i] >
      lengths[i - 1]
    ) {

      increasingPairs++;
    }
  }


  const pairs =
    Math.max(
      0,
      lengths.length - 1
    );


  return {

    detected:
      pairs >= 3 &&
      increasingPairs /
        pairs >= 0.70,

    ratio:
      pairs
        ? round2(
            increasingPairs /
            pairs
          )
        : 0,

    lengths
  };
}


function decreasingRuns(
  sequence
) {

  const runs =
    runLengths(
      sequence
    );


  if (
    runs.length < 4
  ) {

    return {
      detected: false,
      lengths:
        runs.map(
          r =>
            r.length
        )
    };
  }


  const lengths =
    runs
      .map(
        r =>
          r.length
      )
      .reverse();


  let decreasingPairs = 0;


  for (
    let i = 1;
    i < lengths.length;
    i++
  ) {

    if (
      lengths[i] <
      lengths[i - 1]
    ) {

      decreasingPairs++;
    }
  }


  const pairs =
    Math.max(
      0,
      lengths.length - 1
    );


  return {

    detected:
      pairs >= 3 &&
      decreasingPairs /
        pairs >= 0.70,

    ratio:
      pairs
        ? round2(
            decreasingPairs /
            pairs
          )
        : 0,

    lengths
  };
}


/* =========================================================
   REPEATING BLOCK SIMILARITY
========================================================= */

function repeatingBlockAnalysis(
  sequence
) {

  const possibleSizes =
    [2, 3, 4, 5];


  const matches = [];


  for (
    const size of possibleSizes
  ) {

    if (
      sequence.length <
      size * 2
    ) {
      continue;
    }


    const current =
      sequence.slice(
        0,
        size
      );


    /*
      Search older blocks for same sequence.
    */

    for (
      let start = size;
      start + size <=
        sequence.length;
      start++
    ) {

      const block =
        sequence.slice(
          start,
          start + size
        );


      let same = 0;


      for (
        let i = 0;
        i < size;
        i++
      ) {

        if (
          current[i] ===
          block[i]
        ) {

          same++;
        }
      }


      const similarity =
        percentage(
          same,
          size
        );


      if (
        similarity >= 75
      ) {

        matches.push({

          blockSize:
            size,

          start,

          similarity,

          current:
            current.join("-"),

          previous:
            block.join("-")
        });
      }
    }
  }


  matches.sort(
    (a, b) =>
      b.similarity -
      a.similarity
  );


  const best =
    matches[0] || null;


  return {

    detected:
      Boolean(best),

    best,

    matches:
      matches.slice(
        0,
        10
      )
  };
}


/* =========================================================
   PATTERN MASTER ANALYSIS
========================================================= */

function patternAnalysis(
  sequence
) {

  const alternating =
    alternatingPattern(
      sequence
    );


  const pattern22 =
    repeatedBlockPattern(
      sequence,
      2
    );


  const pattern33 =
    repeatedBlockPattern(
      sequence,
      3
    );


  const pattern12 =
    runStructurePattern(
      sequence,
      1,
      2
    );


  const pattern21 =
    runStructurePattern(
      sequence,
      2,
      1
    );


  const increasing =
    increasingRuns(
      sequence
    );


  const decreasing =
    decreasingRuns(
      sequence
    );


  const repeating =
    repeatingBlockAnalysis(
      sequence
    );


  const detected = [];


  if (
    alternating.detected
  ) {

    detected.push({

      name:
        "ALTERNATING",

      strength:
        patternStrength(
          alternating.length,
          sequence.length
        ),

      detail:
        `Alternating length ${alternating.length}`
    });
  }


  if (
    pattern22.detected
  ) {

    detected.push({

      name:
        "2-2 PATTERN",

      strength:
        "MEDIUM",

      detail:
        `Repeated ${pattern22.block}`
    });
  }


  if (
    pattern33.detected
  ) {

    detected.push({

      name:
        "3-3 PATTERN",

      strength:
        "MEDIUM",

      detail:
        `Repeated ${pattern33.block}`
    });
  }


  if (
    pattern12.detected
  ) {

    detected.push({

      name:
        "1-2 PATTERN",

      strength:
        "MEDIUM",

      detail:
        `${pattern12.matches} matching run pairs`
    });
  }


  if (
    pattern21.detected
  ) {

    detected.push({

      name:
        "2-1 PATTERN",

      strength:
        "MEDIUM",

      detail:
        `${pattern21.matches} matching run pairs`
    });
  }


  if (
    increasing.detected
  ) {

    detected.push({

      name:
        "INCREASING STREAK",

      strength:
        patternStrength(
          Math.round(
            increasing.ratio * 10
          ),
          10
        ),

      detail:
        "Run lengths increasing"
    });
  }


  if (
    decreasing.detected
  ) {

    detected.push({

      name:
        "DECREASING STREAK",

      strength:
        patternStrength(
          Math.round(
            decreasing.ratio * 10
          ),
          10
        ),

      detail:
        "Run lengths decreasing"
    });
  }


  if (
    repeating.detected
  ) {

    detected.push({

      name:
        "REPEATING BLOCK DETECTED",

      strength:
        repeating.best &&
        repeating.best.similarity >= 90
          ? "HIGH"
          : "MEDIUM",

      detail:
        repeating.best
          ? `${repeating.best.similarity}% block similarity`
          : "Similar block found"
    });
  }


  /*
    Same streak.
  */

  const current =
    currentStreak(
      sequence
    );


  if (
    current.length >= 3
  ) {

    detected.push({

      name:
        "SAME STREAK",

      strength:
        current.length >= 5
          ? "HIGH"
          : current.length >= 3
            ? "MEDIUM"
            : "LOW",

      detail:
        `${current.side} ${current.length} rounds`
    });
  }


  /*
    Majority bias descriptive only.
  */

  const frequency =
    frequencyAnalysis(
      sequence
    );


  let majority =
    "BALANCED";


  if (
    frequency.bigPercent >
    frequency.smallPercent
  ) {

    majority =
      "BIG DOMINANT";

  } else if (
    frequency.smallPercent >
    frequency.bigPercent
  ) {

    majority =
      "SMALL DOMINANT";
  }


  if (
    majority !== "BALANCED"
  ) {

    detected.push({

      name:
        "MAJORITY BIAS",

      strength:
        Math.abs(
          frequency.bigPercent -
          frequency.smallPercent
        ) >= 20
          ? "HIGH"
          : "MEDIUM",

      detail:
        majority
    });
  }


  /*
    If nothing significant detected.
  */

  if (!detected.length) {

    detected.push({

      name:
        "NO STRONG PATTERN",

      strength:
        "LOW",

      detail:
        "Sequence does not show a strong repeated structure"
    });
  }


  /*
    Highest strength first.
  */

  const rank = {
    HIGH: 3,
    MEDIUM: 2,
    LOW: 1
  };


  detected.sort(
    (a, b) =>
      (rank[b.strength] || 0) -
      (rank[a.strength] || 0)
  );


  return {

    primary:
      detected[0],

    detected,

    alternating,

    pattern22,

    pattern33,

    pattern12,

    pattern21,

    increasing,

    decreasing,

    repeating,

    majority
  };
}


function patternStrength(
  value,
  total
) {

  if (
    !total ||
    !value
  ) {
    return "LOW";
  }


  const ratio =
    value / total;


  if (
    ratio >= 0.70
  ) {
    return "HIGH";
  }


  if (
    ratio >= 0.45
  ) {
    return "MEDIUM";
  }


  return "LOW";
}


/* =========================================================
   EMPIRICAL RUN CONTINUATION
========================================================= */

function historicalStreakSupport(
  sequence
) {

  const current =
    currentStreak(
      sequence
    );


  if (
    !current.side ||
    current.length < 1
  ) {

    return {
      big: 50,
      small: 50,
      evidence: "NONE"
    };
  }


  /*
    Find historical runs of the same side and see
    whether the next chronological result continued
    the run or switched.

    This is historical descriptive evidence only.
  */

  const runs =
    runLengths(
      sequence
    );


  const side =
    current.side;


  const matchingRuns =
    runs.filter(
      r =>
        r.side === side
    );


  let continuation = 0;
  let reversal = 0;


  /*
    A run in newest->oldest order has older run after it.
    For historical runs, a run is followed chronologically
    by the next newer run.
  */

  for (
    let i = 1;
    i < runs.length;
    i++
  ) {

    const run =
      runs[i];


    if (
      run.side !== side
    ) {
      continue;
    }


    if (
      run.length >=
      current.length
    ) {

      /*
        The current run-length bucket occurred historically.
        The next chronological state after that run is
        the opposite side because runs alternate.
      */

      continuation +=
        run.length >
        current.length
          ? 1
          : 0;

      reversal++;
    }
  }


  if (
    reversal < 3
  ) {

    return {

      big: 50,

      small: 50,

      evidence:
        "INSUFFICIENT"
    };
  }


  /*
    This component is intentionally weak.
  */

  const continuationRate =
    continuation /
    reversal;


  let sideScore =
    50;


  if (
    continuationRate >=
    0.60
  ) {

    sideScore = 55;

  } else if (
    continuationRate <=
    0.40
  ) {

    sideScore = 45;
  }


  if (
    side === "BIG"
  ) {

    return {

      big:
        sideScore,

      small:
        100 - sideScore,

      evidence:
        `${matchingRuns.length} historical BIG runs`
    };
  }


  return {

    big:
      100 - sideScore,

    small:
      sideScore,

    evidence:
      `${matchingRuns.length} historical SMALL runs`
  };
}


/* =========================================================
   STATISTICAL COMPONENTS
========================================================= */

function frequencyComponent(
  sequence
) {

  /*
    Frequency component uses recent windows.
    It does NOT simply select majority.
  */

  const w10 =
    frequencyAnalysis(
      sequence.slice(0, 10)
    );

  const w20 =
    frequencyAnalysis(
      sequence.slice(0, 20)
    );

  const w50 =
    frequencyAnalysis(
      sequence.slice(0, 50)
    );


  const big =
    (
      w10.bigPercent * 0.50 +
      w20.bigPercent * 0.30 +
      w50.bigPercent * 0.20
    );


  const small =
    100 - big;


  return {

    big:
      round2(big),

    small:
      round2(small),

    evidence:
      "Recent frequency windows"
  };
}


function switchingComponent(
  sequence
) {

  const switching =
    switchingAnalysis(
      sequence.slice(
        0,
        20
      )
    );


  const current =
    currentStreak(
      sequence
    );


  if (
    !current.side
  ) {

    return {
      big: 50,
      small: 50,
      evidence: "NONE"
    };
  }


  /*
    High switching:
    opposite of current side gets mild support.

    Low switching:
    current side gets mild support.

    Balanced:
    neutral.

    This is not a guarantee.
  */

  if (
    switching.classification ===
    "HIGH SWITCHING"
  ) {

    return {

      big:
        current.side === "BIG"
          ? 46
          : 54,

      small:
        current.side === "BIG"
          ? 54
          : 46,

      evidence:
        `High switching ${switching.switchRate}%`
    };
  }


  if (
    switching.classification ===
    "LOW SWITCHING"
  ) {

    return {

      big:
        current.side === "BIG"
          ? 54
          : 46,

      small:
        current.side === "BIG"
          ? 46
          : 54,

      evidence:
        `Low switching ${switching.switchRate}%`
    };
  }


  return {

    big: 50,

    small: 50,

    evidence:
      `Balanced switching ${switching.switchRate}%`
  };
}


function runComponent(
  sequence
) {

  const runs =
    runLengths(
      sequence
    );


  const current =
    currentStreak(
      sequence
    );


  if (
    !current.side ||
    !runs.length
  ) {

    return {

      big: 50,

      small: 50,

      evidence:
        "No run data"
    };
  }


  const common =
    current.side === "BIG"
      ? modeRunLength(
          runs,
          "BIG"
        )
      : modeRunLength(
          runs,
          "SMALL"
        );


  if (!common) {

    return {

      big: 50,

      small: 50,

      evidence:
        "Insufficient run history"
    };
  }


  /*
    Current run significantly longer than common:
    mild reversal support.

    Current run around common:
    neutral / mild continuation.

    This is deliberately capped.
  */

  if (
    current.length >=
      common + 2
  ) {

    return {

      big:
        current.side === "BIG"
          ? 44
          : 56,

      small:
        current.side === "BIG"
          ? 56
          : 44,

      evidence:
        `Current ${current.length} vs common ${common}`
    };
  }


  if (
    current.length <=
      Math.max(
        1,
        common - 1
      )
  ) {

    return {

      big:
        current.side === "BIG"
          ? 53
          : 47,

      small:
        current.side === "BIG"
          ? 47
          : 53,

      evidence:
        `Current ${current.length} vs common ${common}`
    };
  }


  return {

    big: 50,

    small: 50,

    evidence:
      `Current ${current.length} near common ${common}`
  };
}


function transitionComponent(
  sequence
) {

  const transition =
    transitionAnalysis(
      sequence
    );


  const current =
    currentStreak(
      sequence
    );


  if (
    !current.side
  ) {

    return {
      big: 50,
      small: 50,
      evidence:
        "No current state"
    };
  }


  if (
    current.side === "BIG"
  ) {

    const big =
      transition.probabilities[
        "B→B"
      ];

    const small =
      transition.probabilities[
        "B→S"
      ];


    if (
      transition.previousStateTotals.BIG <
      3
    ) {

      return {
        big: 50,
        small: 50,
        evidence:
          "Insufficient B transition sample"
      };
    }


    return {

      big,

      small,

      evidence:
        `After BIG: B→B ${big}% / B→S ${small}%`
    };
  }


  const big =
    transition.probabilities[
      "S→B"
    ];

  const small =
    transition.probabilities[
      "S→S"
    ];


  if (
    transition.previousStateTotals.SMALL <
    3
  ) {

    return {
      big: 50,
      small: 50,
      evidence:
        "Insufficient S transition sample"
    };
  }


  return {

    big,

    small,

    evidence:
      `After SMALL: S→B ${big}% / S→S ${small}%`
  };
}


function repeatingComponent(
  sequence
) {

  const repeating =
    repeatingBlockAnalysis(
      sequence
    );


  if (
    !repeating.detected ||
    !repeating.best
  ) {

    return {

      big: 50,

      small: 50,

      evidence:
        "No reliable repeated block"
    };
  }


  /*
    IMPORTANT:
    We DO NOT assume that a repeated block
    will repeat again.

    Therefore pattern similarity contributes
    only a small statistical weight.
  */

  const similarity =
    repeating.best.similarity;


  if (
    similarity < 90
  ) {

    return {

      big: 50,

      small: 50,

      evidence:
        `${similarity}% similarity only`
    };
  }


  return {

    big: 50,

    small: 50,

    evidence:
      `Repeated block ${similarity}% similar; no future assumption`
  };
}


/* =========================================================
   SUPPORT CALCULATION
========================================================= */

function normalizeComponent(
  component
) {

  const big =
    clamp(
      safeNumber(
        component.big
      ) ?? 50,
      0,
      100
    );


  const small =
    clamp(
      safeNumber(
        component.small
      ) ?? 50,
      0,
      100
    );


  const total =
    big + small;


  if (!total) {

    return {
      big: 50,
      small: 50
    };
  }


  return {

    big:
      round2(
        (big / total) *
        100
      ),

    small:
      round2(
        (small / total) *
        100
      )
  };
}


/* =========================================================
   CONFIDENCE
========================================================= */

function confidenceLevel(
  supportBig,
  supportSmall,
  sampleSize,
  agreement
) {

  if (
    sampleSize < 10
  ) {

    return {
      level: "LOW",
      score: 0,
      reason:
        "Insufficient Data"
    };
  }


  const edge =
    Math.abs(
      supportBig -
      supportSmall
    );


  if (
    edge < 4
  ) {

    return {

      level:
        "LOW",

      score:
        Math.round(
          edge * 5
        ),

      reason:
        "Low Confidence"
    };
  }


  if (
    agreement < 0.50
  ) {

    return {

      level:
        "LOW",

      score:
        Math.round(
          30 +
          edge
        ),

      reason:
        "Mixed Evidence"
    };
  }


  if (
    agreement < 0.67
  ) {

    return {

      level:
        "MEDIUM",

      score:
        Math.round(
          45 +
          edge
        ),

      reason:
        "Moderate agreement"
    };
  }


  return {

    level:
      "HIGH",

    score:
      Math.round(
        55 +
        edge
      ),

    reason:
      "Multiple components agree"
  };
}


/* =========================================================
   COMPLETE STATISTICAL ANALYSIS
========================================================= */

function completeAnalysis(
  rows
) {

  const sequence =
    convertSequence(
      rows
    );


  const total =
    sequence.length;


  if (
    total < 5
  ) {

    return {

      status:
        "INSUFFICIENT_DATA",

      totalResults:
        total,

      sequence,

      overall:
        frequencyAnalysis(
          sequence
        ),

      windows: {},

      currentStreak:
        currentStreak(
          sequence
        ),

      longestBigStreak: 0,

      longestSmallStreak: 0,

      switchRate: 0,

      switching: {
        classification:
          "INSUFFICIENT_DATA"
      },

      transitions: {
        counts: {},
        probabilities: {}
      },

      runs: {
        runs: []
      },

      patterns: {

        primary: {
          name:
            "INSUFFICIENT DATA",

          strength:
            "LOW"
        },

        detected: []
      },

      statisticalSupport: {

        big: 50,

        small: 50
      },

      confidence: {

        level:
          "LOW",

        score: 0,

        reason:
          "Insufficient Data"
      },

      evidenceConflict:
        false,

      components: {},

      warning:
        "Historical patterns do not guarantee the next result."
    };
  }


  /*
    Overall.
  */

  const overall =
    frequencyAnalysis(
      sequence
    );


  /*
    Windows.
  */

  const windows = {

    last5:
      calculateWindow(
        sequence,
        5
      ),

    last10:
      calculateWindow(
        sequence,
        10
      ),

    last20:
      calculateWindow(
        sequence,
        20
      ),

    last30:
      calculateWindow(
        sequence,
        30
      ),

    last50:
      calculateWindow(
        sequence,
        50
      )
  };


  /*
    Streaks / runs.
  */

  const runs =
    runAnalysis(
      sequence
    );


  const current =
    runs.currentStreak;


  /*
    Switching.
  */

  const switching =
    switchingAnalysis(
      sequence
    );


  /*
    Transitions.
  */

  const transitions =
    transitionAnalysis(
      sequence
    );


  /*
    Patterns.
  */

  const patterns =
    patternAnalysis(
      sequence
    );


  /*
    Six required weighted components:

    Frequency      20%
    Streak         15%
    Switching      15%
    Runs           15%
    Transition     20%
    Repeating      15%
  */


  const frequency =
    normalizeComponent(
      frequencyComponent(
        sequence
      )
    );


  const streak =
    normalizeComponent(
      historicalStreakSupport(
        sequence
      )
    );


  const switchingComp =
    normalizeComponent(
      switchingComponent(
        sequence
      )
    );


  const runComp =
    normalizeComponent(
      runComponent(
        sequence
      )
    );


  const transitionComp =
    normalizeComponent(
      transitionComponent(
        sequence
      )
    );


  const repeatingComp =
    normalizeComponent(
      repeatingComponent(
        sequence
      )
    );


  const components = {

    frequency: {
      weight: 20,
      big:
        frequency.big,
      small:
        frequency.small,
      evidence:
        frequencyComponent(
          sequence
        ).evidence
    },


    streak: {
      weight: 15,
      big:
        streak.big,
      small:
        streak.small,
      evidence:
        historicalStreakSupport(
          sequence
        ).evidence
    },


    switching: {
      weight: 15,
      big:
        switchingComp.big,
      small:
        switchingComp.small,
      evidence:
        switchingComponent(
          sequence
        ).evidence
    },


    runs: {
      weight: 15,
      big:
        runComp.big,
      small:
        runComp.small,
      evidence:
        runComponent(
          sequence
        ).evidence
    },


    transitions: {
      weight: 20,
      big:
        transitionComp.big,
      small:
        transitionComp.small,
      evidence:
        transitionComponent(
          sequence
        ).evidence
    },


    repeating: {
      weight: 15,
      big:
        repeatingComp.big,
      small:
        repeatingComp.small,
      evidence:
        repeatingComponent(
          sequence
        ).evidence
    }
  };


  /*
    Weighted support.
  */

  let supportBig =
    components.frequency.big * 0.20 +

    components.streak.big * 0.15 +

    components.switching.big * 0.15 +

    components.runs.big * 0.15 +

    components.transitions.big * 0.20 +

    components.repeating.big * 0.15;


  let supportSmall =
    components.frequency.small * 0.20 +

    components.streak.small * 0.15 +

    components.switching.small * 0.15 +

    components.runs.small * 0.15 +

    components.transitions.small * 0.20 +

    components.repeating.small * 0.15;


  /*
    Normalize final support to 100.
  */

  const supportTotal =
    supportBig +
    supportSmall;


  supportBig =
    supportTotal
      ? (
          supportBig /
          supportTotal
        ) * 100
      : 50;


  supportSmall =
    supportTotal
      ? (
          supportSmall /
          supportTotal
        ) * 100
      : 50;


  supportBig =
    round2(
      supportBig
    );


  supportSmall =
    round2(
      supportSmall
    );


  /*
    Evidence agreement.

    Count components supporting the final side.
    Neutral components are not counted as conflict.
  */

  const componentArray =
    Object.values(
      components
    );


  const finalSide =
    supportBig >=
    supportSmall
      ? "BIG"
      : "SMALL";


  let directional = 0;
  let agreeing = 0;


  for (
    const component of
      componentArray
  ) {

    const edge =
      Math.abs(
        component.big -
        component.small
      );


    /*
      4 points se kam difference = neutral.
    */

    if (
      edge < 4
    ) {
      continue;
    }


    directional++;


    const side =
      component.big >
      component.small
        ? "BIG"
        : "SMALL";


    if (
      side === finalSide
    ) {

      agreeing++;
    }
  }


  const agreement =
    directional
      ? agreeing /
        directional
      : 0;


  const evidenceConflict =
    directional >= 3 &&
    agreement < 0.50;


  const confidence =
    confidenceLevel(
      supportBig,
      supportSmall,
      total,
      agreement
    );


  /*
    If strong conflict, force LOW confidence.
  */

  if (
    evidenceConflict
  ) {

    confidence.level =
      "LOW";

    confidence.reason =
      "Mixed Evidence";
  }


  /*
    Nearly balanced support = low confidence.
  */

  if (
    Math.abs(
      supportBig -
      supportSmall
    ) < 4
  ) {

    confidence.level =
      "LOW";

    confidence.reason =
      "Low Confidence";
  }


  /*
    Statistical pattern score is descriptive.
  */

  return {

    status:
      "COMPLETE",

    totalResults:
      total,

    sequence,

    overall,


    windows,


    currentStreak:
      current,


    longestBigStreak:
      runs.longestBigStreak,


    longestSmallStreak:
      runs.longestSmallStreak,


    switchRate:
      switching.switchRate,


    switching: {

      switches:
        switching.switches,

      transitions:
        switching.transitions,

      switchRate:
        switching.switchRate,

      classification:
        switching.classification
    },


    transitions,


    runs,


    patterns,


    statisticalSupport: {

      big:
        supportBig,

      small:
        supportSmall
    },


    confidence,


    evidenceConflict,


    agreement:
      round2(
        agreement * 100
      ),


    components,


    /*
      This is the statistical lean.
      It is NOT a guaranteed future result.
    */

    statisticalLean:
      finalSide,


    warning:
      "Historical patterns do not guarantee the next result.",

    safetyLabel:
      "STATISTICAL PATTERN SCORE"
  };
}


/* =========================================================
   MODEL
========================================================= */

function calculateModel(
  rows
) {

  const analysis =
    completeAnalysis(
      rows
    );


  if (
    analysis.status !==
    "COMPLETE"
  ) {

    return {

      prediction:
        null,

      confidence:
        0,

      confidenceLevel:
        "LOW",

      reason:
        "Insufficient Data",

      modelVersion:
        MODEL_VERSION,

      analysis,

      thinkingDurationMs:
        THINKING_DURATION_MS
    };
  }


  const big =
    analysis
      .statisticalSupport
      .big;


  const small =
    analysis
      .statisticalSupport
      .small;


  /*
    Statistical lean only.
  */

  const prediction =
    big >= small
      ? "BIG"
      : "SMALL";


  let reason =
    analysis.confidence.reason;


  if (
    analysis.evidenceConflict
  ) {

    reason =
      "Mixed Evidence";

  } else if (
    Math.abs(
      big - small
    ) < 4
  ) {

    reason =
      "Low Confidence";

  } else {

    const pattern =
      analysis.patterns
        ?.primary
        ?.name;


    reason =
      pattern &&
      pattern !==
        "NO STRONG PATTERN"

        ? `${pattern} · ${analysis.confidence.level}`
        : `Multi-factor statistical analysis · ${analysis.confidence.level}`;
  }


  /*
    Never claim certainty.
  */

  return {

    prediction,

    confidence:
      clamp(
        Math.round(
          Math.abs(
            big - small
          )
        ),
        0,
        100
      ),

    confidenceLevel:
      analysis.confidence.level,

    reason,

    modelVersion:
      MODEL_VERSION,

    analysis,

    thinkingDurationMs:
      THINKING_DURATION_MS,

    warning:
      "Historical patterns do not guarantee the next result."
  };
}


/* =========================================================
   GENERATE / SAVE PREDICTION
========================================================= */

function generatePrediction() {

  const target =
    resolveTargetIssue();


  if (!target) {
    return null;
  }


  /*
    Same target ka cached analysis use karo.
  */

  if (
    modelCache.targetIssue ===
      target &&
    modelCache.analysis
  ) {

    return modelCache;
  }


  const model =
    calculateModel(
      providerState.history
    );


  modelCache = {

    targetIssue:
      target,

    prediction:
      model.prediction,

    confidence:
      model.confidence,

    confidenceLevel:
      model.confidenceLevel,

    reason:
      model.reason,

    modelVersion:
      model.modelVersion,

    generatedAt:
      now(),

    thinkingDurationMs:
      THINKING_DURATION_MS,

    analysis:
      model.analysis
  };


  if (
    model.prediction
  ) {

    savePrediction(
      modelCache
    ).catch(
      (error) => {

        console.error(
          "Prediction save error:",
          error.message
        );
      }
    );
  }


  return modelCache;
}


async function savePrediction(
  prediction
) {

  if (!pool) {
    return;
  }


  if (
    !prediction?.targetIssue ||
    !prediction?.prediction
  ) {

    return;
  }


  /*
    Same target issue ka duplicate record
    create nahi karna.
  */

  const existing =
    await pool.query(
      `
      SELECT id
      FROM prediction_records
      WHERE target_issue = $1
      ORDER BY id DESC
      LIMIT 1
      `,
      [
        prediction.targetIssue
      ]
    );


  if (
    existing.rows.length
  ) {

    return;
  }


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
    `,
    [

      prediction.targetIssue,

      prediction.prediction,

      prediction.confidence,

      prediction.modelVersion,

      now()
    ]
  );
}


/* =========================================================
   SETTLEMENT
========================================================= */

async function settlePredictions(
  history
) {

  if (!pool) {
    return;
  }


  if (
    !Array.isArray(history)
  ) {

    return;
  }


  for (
    const row of history
  ) {

    const issue =
      row?.issueNumber;


    const actual =
      normalizeResult(row);


    /*
      Invalid / pending row:
      NEVER WIN/LOSS.
    */

    if (
      !issue ||
      !actual
    ) {

      continue;
    }


    const actualNumber =
      safeNumber(
        row.number
      );


    await pool.query(
      `
      UPDATE prediction_records
      SET
        actual_number = $1,
        actual_result = $2,
        settled_at = $3
      WHERE target_issue = $4
        AND actual_result IS NULL
      `,
      [

        actualNumber,

        actual,

        now(),

        issue

      ]
    );
  }
}


/* =========================================================
   ACCESS KEY
========================================================= */

async function validateAccessKey(
  accessKey,
  deviceId
) {

  if (!pool) {

    return {

      ok: true,

      mode:
        "database-not-configured"
    };
  }


  if (!accessKey) {

    return {

      ok: false,

      error:
        "Access key required"
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
      [
        accessKey
      ]
    );


  if (
    !result.rows.length
  ) {

    return {

      ok: false,

      error:
        "Invalid access key"
    };
  }


  const row =
    result.rows[0];


  /*
    First device automatically binds.
  */

  if (!row.device_id) {

    await pool.query(
      `
      UPDATE access_keys
      SET
        device_id = $1,
        last_seen = $2
      WHERE id = $3
      `,
      [

        deviceId || null,

        now(),

        row.id

      ]
    );


    return {

      ok: true,

      bound: true
    };
  }


  if (!deviceId) {

    return {

      ok: false,

      error:
        "Device ID required"
    };
  }


  if (
    String(row.device_id) !==
    String(deviceId)
  ) {

    return {

      ok: false,

      error:
        "This key is already linked to another device"
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
      row.id
    ]
  );


  return {
    ok: true
  };
}


/* =========================================================
   ADMIN AUTH
========================================================= */

function adminAuthorized(req) {

  if (!ADMIN_KEY) {
    return false;
  }


  const supplied =
    String(
      req.headers[
        "x-admin-key"
      ] || ""
    ).trim();


  return (
    supplied &&
    supplied === ADMIN_KEY
  );
}


/* =========================================================
   BODY PARSER
========================================================= */

function readBody(req) {

  return new Promise(
    (resolve, reject) => {

      let body = "";


      req.on(
        "data",
        (chunk) => {

          body += chunk;


          if (
            body.length >
            1024 * 1024
          ) {

            req.destroy();


            reject(
              new Error(
                "Request body too large"
              )
            );
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
                "Invalid JSON body"
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
   ADMIN API - ACCESS KEYS
========================================================= */

async function adminKeys(
  req,
  res,
  url
) {

  if (!adminAuthorized(req)) {

    json(res, 401, {

      ok: false,

      error:
        "Unauthorized"

    });

    return;
  }


  if (!pool) {

    json(res, 500, {

      ok: false,

      error:
        "DATABASE_URL not configured"

    });

    return;
  }


  /* GET */

  if (
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


    json(res, 200, {

      ok: true,

      keys:
        result.rows

    });

    return;
  }


  /* POST */

  if (
    req.method ===
    "POST"
  ) {

    const body =
      await readBody(req);


    let key =
      String(
        body.key ||
        body.access_key ||
        ""
      ).trim();


    if (!key) {

      key =
        "DY-" +
        Math.random()
          .toString(36)
          .slice(2, 12)
          .toUpperCase();
    }


    try {

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
          [
            key,
            now()
          ]
        );


      json(res, 200, {

        ok: true,

        access_key:
          result.rows[0]
            .access_key,

        key:
          result.rows[0]

      });

    } catch (error) {

      if (
        error.code ===
        "23505"
      ) {

        json(res, 409, {

          ok: false,

          error:
            "Key already exists"

        });

        return;
      }


      throw error;
    }


    return;
  }


  /* DELETE */

  if (
    req.method ===
    "DELETE"
  ) {

    let id =
      url.searchParams.get(
        "id"
      );


    let key =
      url.searchParams.get(
        "key"
      );


    if (!id && !key) {

      try {

        const body =
          await readBody(req);


        id =
          body.id
            ? String(
                body.id
              )
            : null;


        key =
          body.key ||
          body.access_key ||
          null;

      } catch {
        // ignore
      }
    }


    if (!id && !key) {

      json(res, 400, {

        ok: false,

        error:
          "id or key required"

      });

      return;
    }


    if (id) {

      await pool.query(
        `
        DELETE FROM access_keys
        WHERE id = $1
        `,
        [
          id
        ]
      );

    } else {

      await pool.query(
        `
        DELETE FROM access_keys
        WHERE access_key = $1
        `,
        [
          key
        ]
      );
    }


    json(res, 200, {

      ok: true

    });

    return;
  }


  json(res, 405, {

    ok: false,

    error:
      "Method not allowed"

  });
}


/* =========================================================
   RESET DEVICE
========================================================= */

async function resetDevice(
  req,
  res
) {

  if (!adminAuthorized(req)) {

    json(res, 401, {

      ok: false,

      error:
        "Unauthorized"

    });

    return;
  }


  if (!pool) {

    json(res, 500, {

      ok: false,

      error:
        "DATABASE_URL not configured"

    });

    return;
  }


  const body =
    await readBody(req);


  const id =
    body.id;


  const key =
    String(
      body.key ||
      body.access_key ||
      ""
    ).trim();


  if (!id && !key) {

    json(res, 400, {

      ok: false,

      error:
        "id or key required"

    });

    return;
  }


  if (id) {

    await pool.query(
      `
      UPDATE access_keys
      SET
        device_id = NULL,
        last_seen = 0
      WHERE id = $1
      `,
      [
        id
      ]
    );

  } else {

    await pool.query(
      `
      UPDATE access_keys
      SET
        device_id = NULL,
        last_seen = 0
      WHERE access_key = $1
      `,
      [
        key
      ]
    );
  }


  json(res, 200, {

    ok: true,

    message:
      "Device binding reset"

  });
}


/* =========================================================
   ADMIN STATUS
========================================================= */

async function adminStatus(
  req,
  res
) {

  if (!adminAuthorized(req)) {

    json(res, 401, {

      ok: false,

      error:
        "Unauthorized"

    });

    return;
  }


  let db = false;


  if (pool) {

    try {

      await pool.query(
        "SELECT 1"
      );

      db = true;

    } catch {

      db = false;
    }
  }


  json(res, 200, {

    ok: true,

    server: true,

    database:
      db,

    wingobot:
      Boolean(
        WINGOBOT_TOKEN
      ),

    provider:
      providerState.ok,

    currentIssue:
      providerState.currentIssue,

    historyCount:
      providerState.history.length,

    targetIssue:
      resolveTargetIssue(),

    thinkingDurationMs:
      THINKING_DURATION_MS,

    model:
      modelCache
  });
}


/* =========================================================
   ACCESS CHECK API
========================================================= */

async function keyCheck(
  req,
  res
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


  try {

    const result =
      await validateAccessKey(
        accessKey,
        deviceId
      );


    json(
      res,
      200,
      result
    );

  } catch (error) {

    json(res, 500, {

      ok: false,

      error:
        error.message

    });
  }
}


/* =========================================================
   MAIN STATE API
========================================================= */

async function stateApi(
  req,
  res
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


  try {

    const auth =
      await validateAccessKey(
        accessKey,
        deviceId
      );


    if (!auth.ok) {

      json(
        res,
        403,
        auth
      );

      return;
    }


    const target =
      resolveTargetIssue();


    const prediction =
      target
        ? (
            modelCache.targetIssue ===
              target

              ? modelCache

              : generatePrediction()
          )

        : null;


    json(res, 200, {

      ok: true,


      provider: {

        connected:
          providerState.ok,

        currentIssue:
          providerState.currentIssue,

        fetched:
          providerState.fetched,

        lastUpdated:
          providerState.lastUpdated,

        fetchedAt:
          providerState.fetchedAt,

        error:
          providerState.error

      },


      targetIssue:
        target,


      /*
        4-second UI thinking signal.
      */

      thinkingDurationMs:
        THINKING_DURATION_MS,


      prediction:
        prediction

          ? {

              targetIssue:
                prediction.targetIssue,

              prediction:
                prediction.prediction,

              confidence:
                prediction.confidence,

              confidenceLevel:
                prediction.confidenceLevel,

              reason:
                prediction.reason,

              modelVersion:
                prediction.modelVersion,

              generatedAt:
                prediction.generatedAt,

              thinkingDurationMs:
                prediction.thinkingDurationMs,

              statisticalSupport:
                prediction.analysis
                  ?.statisticalSupport ||
                null,

              analysis:
                prediction.analysis ||
                null,

              warning:
                "Historical patterns do not guarantee the next result."

            }

          : null,


      history:
        providerState.history
          .slice(0, 30)
          .map(
            (row) => ({

              issueNumber:
                row.issueNumber,

              number:
                row.number,

              result:
                row.result,

              colour:
                row.colour,

              premium:
                row.premium,

              sum:
                row.sum

            })
          )

    });

  } catch (error) {

    json(res, 500, {

      ok: false,

      error:
        error.message

    });
  }
}


/* =========================================================
   HISTORY API
========================================================= */

async function historyApi(
  req,
  res
) {

  if (!pool) {

    json(res, 200, {

      ok: true,

      history: []

    });

    return;
  }


  try {

    const result =
      await pool.query(
        `
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
        ORDER BY created_at DESC
        LIMIT 30
        `
      );


    json(res, 200, {

      ok: true,

      history:
        result.rows

    });

  } catch (error) {

    json(res, 500, {

      ok: false,

      error:
        error.message

    });
  }
}


/* =========================================================
   ADMIN PING
========================================================= */

async function adminPing(
  req,
  res
) {

  if (!adminAuthorized(req)) {

    json(res, 401, {

      ok: false,

      error:
        "Unauthorized"

    });

    return;
  }


  json(res, 200, {

    ok: true,

    message:
      "PONG",

    time:
      now()

  });
}


/* =========================================================
   ADMIN WINGO TEST
========================================================= */

async function adminWingoTest(
  req,
  res
) {

  if (!adminAuthorized(req)) {

    json(res, 401, {

      ok: false,

      error:
        "Unauthorized"

    });

    return;
  }


  try {

    await refreshProvider();


    json(res, 200, {

      ok:
        providerState.ok,

      currentIssue:
        providerState.currentIssue,

      historyCount:
        providerState.history.length,

      error:
        providerState.error

    });

  } catch (error) {

    json(res, 500, {

      ok: false,

      error:
        error.message

    });
  }
}


/* =========================================================
   ADMIN MODEL TEST
========================================================= */

async function adminModelTest(
  req,
  res
) {

  if (!adminAuthorized(req)) {

    json(res, 401, {

      ok: false,

      error:
        "Unauthorized"

    });

    return;
  }


  const result =
    calculateModel(
      providerState.history
    );


  json(res, 200, {

    ok: true,

    targetIssue:
      resolveTargetIssue(),

    thinkingDurationMs:
      THINKING_DURATION_MS,

    model:
      result

  });
}


/* =========================================================
   STATIC FILE SERVER
========================================================= */

function contentType(file) {

  const ext =
    path.extname(file)
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

    ".ico":
      "image/x-icon",

    ".mp3":
      "audio/mpeg",

    ".wav":
      "audio/wav",

    ".webp":
      "image/webp",

    ".txt":
      "text/plain; charset=utf-8"

  };


  return (
    types[ext] ||
    "application/octet-stream"
  );
}


/* =========================================================
   STATIC SERVER
========================================================= */

function serveStatic(
  req,
  res,
  pathname
) {

  let requested =
    pathname === "/"
      ? "/prediction.html"
      : pathname;


  try {

    requested =
      decodeURIComponent(
        requested
      );

  } catch {

    text(
      res,
      400,
      "Bad Request"
    );

    return;
  }


  const filePath =
    path.resolve(
      PUBLIC_DIR,
      "." + requested
    );


  /*
    Strong path traversal protection.
  */

  if (
    filePath !==
      PUBLIC_DIR &&
    !filePath.startsWith(
      PUBLIC_DIR +
      path.sep
    )
  ) {

    text(
      res,
      403,
      "Forbidden"
    );

    return;
  }


  fs.stat(
    filePath,
    (error, stat) => {

      if (
        error ||
        !stat.isFile()
      ) {

        text(
          res,
          404,
          "Not Found"
        );

        return;
      }


      const type =
        contentType(
          filePath
        );


      /* =====================================================
         MP3
      ===================================================== */

      if (
        type ===
        "audio/mpeg"
      ) {

        const range =
          req.headers.range;


        if (range) {

          const match =
            /^bytes=(\d*)-(\d*)$/
              .exec(
                range
              );


          if (!match) {

            res.writeHead(
              416,
              {

                "Content-Range":
                  `bytes */${stat.size}`

              }
            );


            res.end();

            return;
          }


          const fileSize =
            stat.size;


          let start =
            match[1]
              ? Number(
                  match[1]
                )
              : 0;


          let end =
            match[2]
              ? Number(
                  match[2]
                )
              : fileSize - 1;


          if (
            !Number.isFinite(
              start
            ) ||
            !Number.isFinite(
              end
            ) ||
            start < 0 ||
            start >= fileSize ||
            end < start
          ) {

            res.writeHead(
              416,
              {

                "Content-Range":
                  `bytes */${fileSize}`

              }
            );


            res.end();

            return;
          }


          end =
            Math.min(
              end,
              fileSize - 1
            );


          const chunkSize =
            end -
            start +
            1;


          res.writeHead(
            206,
            {

              "Content-Type":
                "audio/mpeg",

              "Content-Length":
                String(
                  chunkSize
                ),

              "Content-Range":
                `bytes ${start}-${end}/${fileSize}`,

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
              end
            }
          ).pipe(res);


          return;
        }


        /*
          Normal MP3 request.
        */

        res.writeHead(
          200,
          {

            "Content-Type":
              "audio/mpeg",

            "Content-Length":
              String(
                stat.size
              ),

            "Accept-Ranges":
              "bytes",

            "Cache-Control":
              "public, max-age=3600"

          }
        );


        fs.createReadStream(
          filePath
        ).pipe(res);


        return;
      }


      /* =====================================================
         NORMAL FILE
      ===================================================== */

      const headers = {

        "Content-Type":
          type,

        "Content-Length":
          String(
            stat.size
          ),

        "Cache-Control":
          type.startsWith(
            "text/html"
          )
            ? "no-store"
            : "public, max-age=3600"

      };


      /*
        IMPORTANT:
        Undefined header value kabhi nahi bhejenge.
      */

      res.writeHead(
        200,
        headers
      );


      fs.createReadStream(
        filePath
      ).pipe(res);

    }
  );
}


/* =========================================================
   HTTP SERVER
========================================================= */

const server =
  http.createServer(
    async (
      req,
      res
    ) => {

      try {

        /* =================================================
           OPTIONS / CORS
        ================================================= */

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
                "Content-Type, X-Access-Key, X-Device-Id, X-Admin-Key, Authorization",

              "Access-Control-Allow-Methods":
                "GET, POST, DELETE, OPTIONS",

              "Access-Control-Max-Age":
                "86400"

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


        /* =================================================
           HEALTH
        ================================================= */

        if (
          pathname ===
          "/health"
        ) {

          json(
            res,
            200,
            {

              ok: true,

              service:
                "DY AI Wingo",

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


        /* =================================================
           KEY CHECK
        ================================================= */

        if (
          pathname ===
            "/api/key/check" &&
          req.method ===
            "GET"
        ) {

          await keyCheck(
            req,
            res
          );

          return;
        }


        /* =================================================
           STATE
        ================================================= */

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


        /* =================================================
           HISTORY
        ================================================= */

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


        /* =================================================
           ADMIN KEYS
        ================================================= */

        if (
          pathname ===
          "/api/admin/keys"
        ) {

          await adminKeys(
            req,
            res,
            url
          );

          return;
        }


        /* =================================================
           ADMIN RESET DEVICE
        ================================================= */

        if (
          pathname ===
            "/api/admin/reset-device" &&
          req.method ===
            "POST"
        ) {

          await resetDevice(
            req,
            res
          );

          return;
        }


        /* =================================================
           ADMIN STATUS
        ================================================= */

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


        /* =================================================
           ADMIN PING
        ================================================= */

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


        /* =================================================
           ADMIN WINGO TEST
        ================================================= */

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


        /* =================================================
           ADMIN MODEL TEST
        ================================================= */

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


        /* =================================================
           STATIC FILES
        ================================================= */

        serveStatic(
          req,
          res,
          pathname
        );

      } catch (error) {

        console.error(
          "Server request error:",
          error
        );


        /*
          Response already started ho to
          dobara headers nahi bhejne.
        */

        if (
          !res.headersSent
        ) {

          json(
            res,
            500,
            {

              ok: false,

              error:
                "Internal server error"

            }
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

  try {

    await initDatabase();


    server.listen(
      PORT,
      HOST,
      () => {

        console.log(
          `DY AI server running on port ${PORT}`
        );


        console.log(
          `Model: ${MODEL_VERSION}`
        );


        console.log(
          `Thinking duration: ${THINKING_DURATION_MS}ms`
        );


        console.log(
          `WingoBot token: ${
            WINGOBOT_TOKEN
              ? "configured"
              : "missing"
          }`
        );


        console.log(
          `Database: ${
            pool
              ? "configured"
              : "missing"
          }`
        );
      }
    );


    /*
      Initial provider fetch.
    */

    await refreshProvider();


    /*
      Refresh every 3 seconds.
    */

    setInterval(
      () => {

        refreshProvider()
          .catch(
            (error) => {

              console.error(
                "Refresh loop:",
                error.message
              );

            }
          );

      },
      3000
    );

  } catch (error) {

    console.error(
      "Startup error:",
      error
    );


    /*
      Server ko unnecessary crash se bachane ke liye.
    */

    if (
      !server.listening
    ) {

      server.listen(
        PORT,
        HOST,
        () => {

          console.log(
            `DY AI server running on port ${PORT}`
          );

        }
      );
    }
  }
}


/* =========================================================
   PROCESS ERROR HANDLERS
========================================================= */

process.on(
  "unhandledRejection",
  (error) => {

    console.error(
      "Unhandled rejection:",
      error
    );

  }
);


process.on(
  "uncaughtException",
  (error) => {

    console.error(
      "Uncaught exception:",
      error
    );

  }
);


/* =========================================================
   START
========================================================= */

start();
