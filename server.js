"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

/* =========================================================
   CONFIG
========================================================= */

const PORT =
  Number(process.env.PORT || 10000);

const ADMIN_KEY =
  String(
    process.env.ADMIN_KEY ||
    "dy4427574"
  ).trim();

const DEFAULT_ACCESS_KEY =
  String(
    process.env.DEFAULT_ACCESS_KEY ||
    "DY-JPMSUULN"
  ).trim();

const WINGOBOT_URL =
  "https://api.wingobot.com/v2/1-min-game-history";

const WINGOBOT_TOKEN =
  String(
    process.env.WINGOBOT_TOKEN || ""
  )
    .replace(/^Bearer\s+/i, "")
    .replace(/^["']|["']$/g, "")
    .replace(/\r|\n/g, "")
    .trim();

const MODEL_VERSION =
  String(
    process.env.MODEL ||
    "DY-AI-ADAPTIVE-V3"
  ).trim();

/*
  Live API:
  every 1 second
*/
const POLL_MS = 1000;

/*
  Analysis:
  first 4 seconds
*/
const ANALYSIS_MS = 4000;

/*
  After one prediction:
  next 4 rounds skip
*/
const SKIP_ROUNDS = 4;

/*
  API timeout
*/
const REQUEST_TIMEOUT = 8000;


/* =========================================================
   DATABASE
========================================================= */

let pool = null;

if (process.env.DATABASE_URL) {

  pool = new Pool({

    connectionString:
      process.env.DATABASE_URL,

    ssl: {
      rejectUnauthorized: false
    },

    max: 5
  });
}


/* =========================================================
   MEMORY FALLBACK
========================================================= */

const memory = {

  keys:
    new Map(),

  predictions:
    [],

  keyId:
    1,

  predictionId:
    1
};


/* =========================================================
   LIVE STATE
========================================================= */

const live = {

  ok:
    false,

  currentIssue:
    null,

  history:
    [],

  error:
    null,

  updated:
    0,

  fetched:
    0,

  lastIssue:
    null,

  lastIssueChange:
    0
};


/* =========================================================
   ANALYSIS STATE
========================================================= */

const analysis = {

  active:
    false,

  issue:
    null,

  startedAt:
    0,

  endsAt:
    0
};


/* =========================================================
   LOCKS
========================================================= */

let fetching = false;
let engineBusy = false;


/* =========================================================
   UTILITY
========================================================= */

function now() {

  return Date.now();
}


function resultType(number) {

  const n =
    Number(number);

  if (
    !Number.isInteger(n) ||
    n < 0 ||
    n > 9
  ) {

    return null;
  }

  return n >= 5
    ? "BIG"
    : "SMALL";
}


function bit(number) {

  return Number(number) >= 5
    ? 1
    : 0;
}


function issueBigInt(issue) {

  try {

    return BigInt(
      String(issue)
    );

  } catch {

    return null;
  }
}


function issueDiff(
  current,
  previous
) {

  const a =
    issueBigInt(
      current
    );

  const b =
    issueBigInt(
      previous
    );

  if (
    a === null ||
    b === null
  ) {

    return null;
  }

  return Number(
    a - b
  );
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


function average(
  arr
) {

  if (!arr.length) {
    return 0;
  }

  return (
    arr.reduce(
      (a,b) => a + b,
      0
    ) /
    arr.length
  );
}


/* =========================================================
   DATABASE INITIALIZATION
========================================================= */

async function initDB() {

  if (!pool) {

    if (
      !memory.keys.has(
        DEFAULT_ACCESS_KEY
      )
    ) {

      memory.keys.set(
        DEFAULT_ACCESS_KEY,
        {

          id:
            memory.keyId++,

          access_key:
            DEFAULT_ACCESS_KEY,

          device_id:
            null,

          created_at:
            now(),

          last_seen:
            0
        }
      );
    }

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


  const exists =
    await pool.query(
      `
      SELECT id
      FROM access_keys
      WHERE access_key=$1
      LIMIT 1
      `,
      [
        DEFAULT_ACCESS_KEY
      ]
    );


  if (!exists.rows.length) {

    await pool.query(
      `
      INSERT INTO access_keys
      (
        access_key,
        device_id,
        created_at,
        last_seen
      )
      VALUES($1,NULL,$2,0)
      `,
      [
        DEFAULT_ACCESS_KEY,
        now()
      ]
    );
  }
}


/* =========================================================
   NUMBER NORMALIZER
========================================================= */

function cleanNumber(value) {

  if (
    value &&
    typeof value ===
      "object"
  ) {

    value =
      value.number ??
      value.value ??
      value.openNumber ??
      value.open_num ??
      value.winNumber ??
      value.win_number ??
      value.num;
  }


  const n =
    Number(value);


  if (
    !Number.isInteger(n) ||
    n < 0 ||
    n > 9
  ) {

    return null;
  }


  return n;
}


/* =========================================================
   HISTORY NORMALIZER
========================================================= */

function normalizeHistory(
  raw
) {

  const candidates = [

    raw,

    raw?.data,
    raw?.result,
    raw?.list,
    raw?.history,
    raw?.results,
    raw?.records,

    raw?.data?.data,
    raw?.data?.list,
    raw?.data?.history,
    raw?.data?.results,
    raw?.data?.records,

    raw?.result?.data,
    raw?.result?.list,
    raw?.result?.history,
    raw?.result?.results,
    raw?.result?.records
  ];


  let arr = [];


  for (
    const candidate of
      candidates
  ) {

    if (
      Array.isArray(
        candidate
      )
    ) {

      arr =
        candidate;

      break;
    }
  }


  const output = [];


  for (
    const item of arr
  ) {

    if (
      typeof item ===
        "number" ||
      typeof item ===
        "string"
    ) {

      const number =
        cleanNumber(
          item
        );


      if (
        number !== null
      ) {

        output.push({

          issue:
            null,

          number,

          result:
            resultType(
              number
            )
        });
      }

      continue;
    }


    if (
      !item ||
      typeof item !==
        "object"
    ) {

      continue;
    }


    const number =
      cleanNumber(

        item.number ??
        item.openNumber ??
        item.open_num ??
        item.num ??
        item.value ??
        item.result ??
        item.winNumber ??
        item.win_number

      );


    if (
      number === null
    ) {

      continue;
    }


    const issue =

      item.issue ??
      item.period ??
      item.periodNumber ??
      item.period_number ??
      item.period_id ??
      item.periodId ??
      item.issueNumber ??
      item.issue_number ??
      item.draw ??
      item.round ??
      item.roundNumber ??
      item.round_number;


    output.push({

      issue:

        issue === undefined ||
        issue === null

          ? null

          : String(
              issue
            ),

      number,

      result:
        resultType(
          number
        )
    });
  }


  /*
    Remove duplicates
  */

  const seen =
    new Set();

  const clean = [];


  for (
    const item of
      output
  ) {

    const key =
      String(
        item.issue
      ) +
      "|" +
      String(
        item.number
      );


    if (
      seen.has(key)
    ) {

      continue;
    }


    seen.add(key);

    clean.push(
      item
    );
  }


  return clean;
}


/* =========================================================
   CURRENT ISSUE DETECTOR
========================================================= */

function findCurrentIssue(
  obj
) {

  if (
    !obj ||
    typeof obj !==
      "object"
  ) {

    return null;
  }


  const direct =

    obj.currentIssue ??
    obj.current_issue ??
    obj.currentPeriod ??
    obj.current_period ??
    obj.currentPeriodNumber ??
    obj.current_period_number;


  if (
    direct !== undefined &&
    direct !== null &&
    String(
      direct
    ).trim()
  ) {

    return String(
      direct
    ).trim();
  }


  const nested = [

    obj.current,
    obj.game,

    obj.data?.current,
    obj.data?.game,

    obj.result?.current,
    obj.result?.game
  ];


  for (
    const item of
      nested
  ) {

    if (
      !item ||
      typeof item !==
        "object"
    ) {

      continue;
    }


    const issue =

      item.issue ??
      item.period ??
      item.periodNumber ??
      item.period_number ??
      item.issueNumber ??
      item.issue_number;


    if (
      issue !== undefined &&
      issue !== null &&
      String(
        issue
      ).trim()
    ) {

      return String(
        issue
      ).trim();
    }
  }


  return null;
}


/* =========================================================
   DERIVE CURRENT ISSUE
========================================================= */

function deriveCurrentIssue(
  history
) {

  const issues =
    history
      .map(
        item =>
          issueBigInt(
            item.issue
          )
      )
      .filter(
        x =>
          x !== null
      );


  if (!issues.length) {
    return null;
  }


  let max =
    issues[0];


  for (
    const item of
      issues
  ) {

    if (
      item > max
    ) {

      max =
        item;
    }
  }


  return (
    max + 1n
  ).toString();
}


/* =========================================================
   WINGOBOT FETCH
========================================================= */

async function fetchWingo() {

  if (
    !WINGOBOT_TOKEN
  ) {

    throw new Error(
      "WINGOBOT_TOKEN_MISSING"
    );
  }


  const controller =
    new AbortController();


  const timer =
    setTimeout(
      () =>
        controller.abort(),
      REQUEST_TIMEOUT
    );


  try {

    const response =
      await fetch(
        WINGOBOT_URL,
        {

          method:
            "GET",

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


    if (
      !response.ok
    ) {

      throw new Error(
        `WINGOBOT_HTTP_${response.status}`
      );
    }


    const raw =
      await response.json();


    const history =
      normalizeHistory(
        raw
      );


    if (
      !history.length
    ) {

      throw new Error(
        "HISTORY_NOT_FOUND"
      );
    }


    let currentIssue =
      findCurrentIssue(
        raw
      );


    /*
      Fallback:
      latest settled issue + 1
    */

    if (
      !currentIssue
    ) {

      currentIssue =
        deriveCurrentIssue(
          history
        );
    }


    if (
      !currentIssue
    ) {

      throw new Error(
        "CURRENT_PERIOD_NOT_FOUND"
      );
    }


    return {

      currentIssue,

      history,

      raw
    };

  }
  finally {

    clearTimeout(
      timer
    );
  }
}


/* =========================================================
   ACCESS KEY CHECK
========================================================= */

async function checkKey(
  key,
  deviceId
) {

  key =
    String(
      key || ""
    ).trim();


  deviceId =
    String(
      deviceId || ""
    ).trim();


  if (
    !key ||
    !deviceId
  ) {

    return {

      ok:
        false,

      error:
        "KEY_AND_DEVICE_REQUIRED"
    };
  }


  if (!pool) {

    const item =
      memory.keys.get(
        key
      );


    if (!item) {

      return {

        ok:
          false,

        error:
          "INVALID_KEY"
      };
    }


    if (
      item.device_id &&
      item.device_id !==
        deviceId
    ) {

      return {

        ok:
          false,

        error:
          "KEY_ALREADY_USED_ON_ANOTHER_DEVICE"
      };
    }


    item.device_id =
      deviceId;

    item.last_seen =
      now();


    return {
      ok:
        true
    };
  }


  const r =
    await pool.query(
      `
      SELECT *
      FROM access_keys
      WHERE access_key=$1
      LIMIT 1
      `,
      [
        key
      ]
    );


  if (
    !r.rows.length
  ) {

    return {

      ok:
        false,

      error:
        "INVALID_KEY"
    };
  }


  const item =
    r.rows[0];


  if (
    item.device_id &&
    item.device_id !==
      deviceId
  ) {

    return {

      ok:
        false,

      error:
        "KEY_ALREADY_USED_ON_ANOTHER_DEVICE"
    };
  }


  await pool.query(
    `
    UPDATE access_keys
    SET device_id=$1,
        last_seen=$2
    WHERE id=$3
    `,
    [
      deviceId,
      now(),
      item.id
    ]
  );


  return {
    ok:
      true
  };
}


/* =========================================================
   VERIFY USER
========================================================= */

async function verifyAccess(
  req
) {

  return checkKey(

    req.headers[
      "x-access-key"
    ],

    req.headers[
      "x-device-id"
    ]
  );
}


/* =========================================================
   FEATURE ENGINE
========================================================= */

function buildFeatures(
  numbers
) {

  const n =
    numbers.length;


  if (
    n < 25
  ) {

    return null;
  }


  const f = [];


  /*
    A.
    Last 12 BIG/SMALL bits
  */

  for (
    let i = 1;
    i <= 12;
    i++
  ) {

    f.push(
      bit(
        numbers[
          n - i
        ]
      )
    );
  }


  /*
    B.
    Last 8 digits normalized
  */

  for (
    let i = 1;
    i <= 8;
    i++
  ) {

    f.push(

      (
        Number(
          numbers[
            n - i
          ]
        ) - 4.5
      ) / 4.5

    );
  }


  /*
    C.
    Current streak
  */

  const latest =
    bit(
      numbers[
        n - 1
      ]
    );


  let streak =
    0;


  for (
    let i =
      n - 1;

    i >= 0;

    i--
  ) {

    if (
      bit(
        numbers[i]
      ) !==
      latest
    ) {

      break;
    }


    streak++;
  }


  f.push(
    Math.min(
      streak,
      10
    ) / 10
  );


  /*
    D.
    Last 10 transition rate
  */

  let changes10 =
    0;


  for (
    let i =
      Math.max(
        1,
        n - 10
      );

    i < n;

    i++
  ) {

    if (
      bit(
        numbers[i]
      ) !==
      bit(
        numbers[i - 1]
      )
    ) {

      changes10++;
    }
  }


  f.push(
    changes10 / 10
  );


  /*
    E.
    Last 20 transition rate
  */

  let changes20 =
    0;


  for (
    let i =
      Math.max(
        1,
        n - 20
      );

    i < n;

    i++
  ) {

    if (
      bit(
        numbers[i]
      ) !==
      bit(
        numbers[i - 1]
      )
    ) {

      changes20++;
    }
  }


  f.push(
    changes20 / 20
  );


  /*
    F.
    Alternating structure
  */

  let alternating =
    0;


  for (
    let i =
      Math.max(
        2,
        n - 10
      );

    i < n;

    i++
  ) {

    const a =
      bit(
        numbers[i]
      );

    const b =
      bit(
        numbers[i - 1]
      );

    const c =
      bit(
        numbers[i - 2]
      );


    if (
      a === c &&
      a !== b
    ) {

      alternating++;
    }
  }


  f.push(
    alternating / 8
  );


  /*
    G.
    Recent average
  */

  const recent15 =
    numbers.slice(
      -15
    ).map(Number);


  f.push(

    (
      average(
        recent15
      ) - 4.5
    ) / 4.5

  );


  /*
    H.
    Recent BIG ratio
  */

  let big15 =
    0;


  for (
    const number of
      recent15
  ) {

    big15 +=
      bit(number);
  }


  f.push(
    big15 / recent15.length
  );


  /*
    I.
    Recent BIG ratio 30
  */

  const recent30 =
    numbers.slice(
      -30
    );


  let big30 =
    0;


  for (
    const number of
      recent30
  ) {

    big30 +=
      bit(number);
  }


  f.push(
    big30 /
    recent30.length
  );


  /*
    J.
    Digit movement
  */

  let movement =
    0;


  const movementStart =
    Math.max(
      1,
      n - 12
    );


  for (
    let i =
      movementStart;

    i < n;

    i++
  ) {

    movement +=
      Math.abs(
        Number(
          numbers[i]
        ) -
        Number(
          numbers[i - 1]
        )
      );
  }


  f.push(
    movement /
    108
  );


  /*
    K.
    Digit range
  */

  const ten =
    numbers
      .slice(-10)
      .map(Number);


  const min =
    Math.min(
      ...ten
    );

  const max =
    Math.max(
      ...ten
    );


  f.push(
    (
      max - min
    ) / 9
  );


  /*
    L.
    Even ratio
  */

  let even =
    0;


  for (
    const number of
      ten
  ) {

    if (
      number % 2 ===
      0
    ) {

      even++;
    }
  }


  f.push(
    even /
    ten.length
  );


  /*
    M.
    High digit ratio
  */

  let high =
    0;


  for (
    const number of
      ten
  ) {

    if (
      number >= 7
    ) {

      high++;
    }
  }


  f.push(
    high /
    ten.length
  );


  /*
    N.
    Low digit ratio
  */

  let low =
    0;


  for (
    const number of
      ten
  ) {

    if (
      number <= 2
    ) {

      low++;
    }
  }


  f.push(
    low /
    ten.length
  );


  return f;
}


/* =========================================================
   SIGMOID
========================================================= */

function sigmoid(x) {

  if (
    x > 30
  ) {
    return 1;
  }


  if (
    x < -30
  ) {
    return 0;
  }


  return (
    1 /
    (
      1 +
      Math.exp(-x)
    )
  );
}


/* =========================================================
   DOT PRODUCT
========================================================= */

function dot(
  a,
  b
) {

  let sum =
    0;


  const length =
    Math.min(
      a.length,
      b.length
    );


  for (
    let i = 0;
    i < length;
    i++
  ) {

    sum +=
      a[i] *
      b[i];
  }


  return sum;
}


/* =========================================================
   TRAIN LOGISTIC MODEL
========================================================= */

function trainModel(
  X,
  y
) {

  if (
    X.length < 25
  ) {

    return null;
  }


  const dimensions =
    X[0].length +
    1;


  const weights =
    new Array(
      dimensions
    ).fill(0);


  const epochs =
    500;


  const learningRate =
    0.018;


  const regularization =
    0.010;


  for (
    let epoch = 0;
    epoch < epochs;
    epoch++
  ) {

    const gradient =
      new Array(
        dimensions
      ).fill(0);


    for (
      let i = 0;
      i < X.length;
      i++
    ) {

      const row =
        [
          1,
          ...X[i]
        ];


      const prediction =
        sigmoid(
          dot(
            weights,
            row
          )
        );


      const error =
        prediction -
        y[i];


      for (
        let j = 0;
        j < dimensions;
        j++
      ) {

        gradient[j] +=
          error *
          row[j];
      }
    }


    for (
      let j = 0;
      j < dimensions;
      j++
    ) {

      const penalty =
        j === 0

          ? 0

          : regularization *
            weights[j];


      weights[j] -=

        learningRate *
        (
          gradient[j] /
          X.length +
          penalty
        );
    }
  }


  return weights;
}


/* =========================================================
   TRAINING SET
========================================================= */

function createTrainingSet(
  numbers,
  end
) {

  const X = [];
  const y = [];


  for (
    let t = 25;
    t < end;
    t++
  ) {

    const history =
      numbers.slice(
        0,
        t
      );


    const feature =
      buildFeatures(
        history
      );


    if (!feature) {
      continue;
    }


    X.push(
      feature
    );


    y.push(
      bit(
        numbers[t]
      )
    );
  }


  return {
    X,
    y
  };
}


/* =========================================================
   WALK-FORWARD VALIDATION
========================================================= */

function walkForwardValidation(
  numbers
) {

  if (
    numbers.length < 60
  ) {

    return {

      samples:
        0,

      accuracy:
        0.5,

      baseline:
        0.5,

      edge:
        0,

      valid:
        false
    };
  }


  /*
    Test on later observations.
  */

  const start =
    Math.max(
      40,
      Math.floor(
        numbers.length *
        0.55
      )
    );


  let correct =
    0;


  let total =
    0;


  let big =
    0;


  let small =
    0;


  for (
    let t =
      start;

    t < numbers.length;

    t++
  ) {

    const training =
      createTrainingSet(
        numbers,
        t
      );


    if (
      training.X.length <
      25
    ) {

      continue;
    }


    const model =
      trainModel(
        training.X,
        training.y
      );


    if (!model) {
      continue;
    }


    const current =
      buildFeatures(
        numbers.slice(
          0,
          t
        )
      );


    if (!current) {
      continue;
    }


    const probability =
      sigmoid(
        dot(
          model,
          [
            1,
            ...current
          ]
        )
      );


    const prediction =
      probability >=
      0.5
        ? 1
        : 0;


    const actual =
      bit(
        numbers[t]
      );


    if (
      prediction ===
      actual
    ) {

      correct++;
    }


    if (
      actual === 1
    ) {

      big++;

    } else {

      small++;
    }


    total++;
  }


  if (
    total === 0
  ) {

    return {

      samples:
        0,

      accuracy:
        0.5,

      baseline:
        0.5,

      edge:
        0,

      valid:
        false
    };
  }


  const accuracy =
    correct /
    total;


  const baseline =
    Math.max(
      big,
      small
    ) /
    total;


  return {

    samples:
      total,

    accuracy:
      Number(
        accuracy.toFixed(4)
      ),

    baseline:
      Number(
        baseline.toFixed(4)
      ),

    edge:
      Number(
        (
          accuracy -
          baseline
        ).toFixed(4)
      ),

    valid:
      total >= 10
  };
}


/* =========================================================
   MARKOV MODEL
========================================================= */

function markovModel(
  numbers
) {

  if (
    numbers.length < 30
  ) {

    return {

      probability:
        0.5,

      samples:
        0
    };
  }


  /*
    3-result context.
  */

  const context =
    numbers
      .slice(-3)
      .map(bit)
      .join("");


  let weightedBig =
    0;


  let totalWeight =
    0;


  let matches =
    0;


  for (
    let i = 3;
    i < numbers.length;
    i++
  ) {

    const historical =
      numbers
        .slice(
          i - 3,
          i
        )
        .map(bit)
        .join("");


    if (
      historical !==
      context
    ) {

      continue;
    }


    matches++;


    const age =
      numbers.length -
      i;


    const weight =
      1 /
      (
        1 +
        age * 0.025
      );


    weightedBig +=
      bit(
        numbers[i]
      ) *
      weight;


    totalWeight +=
      weight;
  }


  if (
    totalWeight ===
    0
  ) {

    return {

      probability:
        0.5,

      samples:
        0
    };
  }


  return {

    probability:
      weightedBig /
      totalWeight,

    samples:
      matches
  };
}


/* =========================================================
   PATTERN MODEL
========================================================= */

function patternModel(
  numbers
) {

  if (
    numbers.length < 40
  ) {

    return {

      probability:
        0.5,

      matches:
        0
    };
  }


  /*
    Current 7-result pattern.
  */

  const current =
    numbers
      .slice(-7)
      .map(bit);


  const matches = [];


  for (
    let i = 7;
    i < numbers.length;
    i++
  ) {

    const historical =
      numbers
        .slice(
          i - 7,
          i
        )
        .map(bit);


    let distance =
      0;


    for (
      let j = 0;
      j < 7;
      j++
    ) {

      if (
        historical[j] !==
        current[j]
      ) {

        distance++;
      }
    }


    /*
      Only close historical
      patterns are accepted.
    */

    if (
      distance <= 2
    ) {

      matches.push({

        distance,

        outcome:
          bit(
            numbers[i]
          ),

        age:
          numbers.length -
          i
      });
    }
  }


  if (
    !matches.length
  ) {

    return {

      probability:
        0.5,

      matches:
        0
    };
  }


  let weighted =
    0;


  let weightTotal =
    0;


  for (
    const item of
      matches
  ) {

    const distanceWeight =

      item.distance === 0
        ? 1

        : item.distance === 1
          ? 0.70

          : 0.40;


    const ageWeight =
      1 /
      (
        1 +
        item.age * 0.02
      );


    const weight =
      distanceWeight *
      ageWeight;


    weighted +=
      item.outcome *
      weight;


    weightTotal +=
      weight;
  }


  return {

    probability:
      weighted /
      weightTotal,

    matches:
      matches.length
  };
}


/* =========================================================
   STREAK MODEL
========================================================= */

function streakModel(
  numbers
) {

  if (
    numbers.length < 25
  ) {

    return {

      probability:
        0.5,

      strength:
        0
    };
  }


  const latest =
    bit(
      numbers[
        numbers.length - 1
      ]
    );


  let streak =
    0;


  for (
    let i =
      numbers.length - 1;

    i >= 0;

    i--
  ) {

    if (
      bit(
        numbers[i]
      ) !==
      latest
    ) {

      break;
    }


    streak++;
  }


  /*
    Limit huge streaks.
  */

  const target =
    Math.min(
      streak,
      8
    );


  let big =
    0;


  let total =
    0;


  for (
    let i = 1;
    i < numbers.length - 1;
    i++
  ) {

    const side =
      bit(
        numbers[i - 1]
      );


    let s =
      1;


    for (
      let j =
        i - 2;

      j >= 0 &&
      j >= i - 9;

      j--
    ) {

      if (
        bit(
          numbers[j]
        ) !==
        side
      ) {

        break;
      }


      s++;
    }


    if (
      Math.min(
        s,
        8
      ) !==
      target
    ) {

      continue;
    }


    big +=
      bit(
        numbers[i]
      );


    total++;
  }


  if (
    total < 4
  ) {

    return {

      probability:
        0.5,

      strength:
        0
    };
  }


  return {

    probability:
      big /
      total,

    strength:
      clamp(
        total / 15,
        0,
        1
      )
  };
}


/* =========================================================
   ENTROPY
========================================================= */

function binaryEntropy(
  numbers
) {

  if (
    numbers.length < 5
  ) {

    return 1;
  }


  let ones =
    0;


  for (
    const number of
      numbers
  ) {

    ones +=
      bit(number);
  }


  const p =
    ones /
    numbers.length;


  if (
    p <= 0 ||
    p >= 1
  ) {

    return 0;
  }


  return -(

    p *
    Math.log2(p)

    +

    (1-p) *
    Math.log2(
      1-p
    )

  );
}


/* =========================================================
   TRANSITION ENTROPY
========================================================= */

function transitionEntropy(
  numbers
) {

  if (
    numbers.length < 5
  ) {

    return 1;
  }


  let same =
    0;


  let change =
    0;


  for (
    let i = 1;
    i < numbers.length;
    i++
  ) {

    if (
      bit(
        numbers[i]
      ) ===
      bit(
        numbers[i - 1]
      )
    ) {

      same++;

    } else {

      change++;
    }
  }


  const total =
    same +
    change;


  if (
    total === 0
  ) {

    return 1;
  }


  const p =
    same /
    total;


  if (
    p <= 0 ||
    p >= 1
  ) {

    return 0;
  }


  return -(

    p *
    Math.log2(p)

    +

    (1-p) *
    Math.log2(
      1-p
    )

  );
}


/* =========================================================
   ADAPTIVE MODEL WEIGHTS
========================================================= */

function adaptiveWeights(
  numbers
) {

  const validation =
    walkForwardValidation(
      numbers
    );


  let weights = {

    ml:
      0.42,

    markov:
      0.24,

    pattern:
      0.21,

    streak:
      0.13
  };


  /*
    If validation is weak,
    do not blindly trust ML.
  */

  if (
    !validation.valid
  ) {

    weights.ml =
      0.30;

    weights.markov =
      0.28;

    weights.pattern =
      0.24;

    weights.streak =
      0.18;
  }


  /*
    Bad recent validation:
    lower ML weight.
  */

  if (
    validation.edge <
    0
  ) {

    weights.ml *=
      0.55;

  }

  /*
    Positive validation:
    slightly increase ML.
  */

  else if (
    validation.edge >=
    0.04
  ) {

    weights.ml *=
      1.20;
  }


  const total =
    Object.values(
      weights
    ).reduce(
      (a,b) =>
        a + b,
      0
    );


  for (
    const key of
      Object.keys(
        weights
      )
  ) {

    weights[key] /=
      total;
  }


  return {

    weights,

    validation
  };
}


/* =========================================================
   MAIN AI ENGINE
========================================================= */

function analyzeAI(
  history
) {

  /*
    API normally returns newest first.
    AI works oldest -> newest.
  */

  const numbers =
    history
      .filter(
        item =>
          Number.isInteger(
            Number(
              item.number
            )
          )
      )
      .map(
        item =>
          Number(
            item.number
          )
      )
      .reverse();


  if (
    numbers.length <
    35
  ) {

    return {

      prediction:
        null,

      confidence:
        0,

      quality:
        "INSUFFICIENT",

      evidence:
        "NOT_ENOUGH_DATA",

      sampleSize:
        numbers.length,

      model:
        MODEL_VERSION
    };
  }


  /*
    ML training.
  */

  const training =
    createTrainingSet(
      numbers,
      numbers.length
    );


  const model =
    trainModel(
      training.X,
      training.y
    );


  if (!model) {

    return {

      prediction:
        null,

      confidence:
        0,

      quality:
        "MODEL_ERROR",

      sampleSize:
        numbers.length,

      model:
        MODEL_VERSION
    };
  }


  const current =
    buildFeatures(
      numbers
    );


  const mlProbability =
    sigmoid(
      dot(
        model,
        [
          1,
          ...current
        ]
      )
    );


  /*
    Other independent signals.
  */

  const markov =
    markovModel(
      numbers
    );


  const pattern =
    patternModel(
      numbers
    );


  const streak =
    streakModel(
      numbers
    );


  /*
    Adaptive weighting.
  */

  const adaptive =
    adaptiveWeights(
      numbers
    );


  const w =
    adaptive.weights;


  /*
    Ensemble.
  */

  let probability =

    mlProbability *
    w.ml

    +

    markov.probability *
    w.markov

    +

    pattern.probability *
    w.pattern

    +

    streak.probability *
    w.streak;


  /*
    Randomness test.
  */

  const recent24 =
    numbers.slice(
      -24
    );


  const entropy =
    binaryEntropy(
      recent24
    );


  const transitionEntropyValue =
    transitionEntropy(
      recent24
    );


  const randomness =
    (
      entropy +
      transitionEntropyValue
    ) / 2;


  /*
    When sequence looks very
    close to random, reduce
    directional strength.
  */

  if (
    randomness >=
    0.97
  ) {

    probability =
      0.5 +
      (
        probability -
        0.5
      ) *
      0.40;

  }
  else if (
    randomness >=
    0.93
  ) {

    probability =
      0.5 +
      (
        probability -
        0.5
      ) *
      0.70;
  }


  /*
    Signal agreement.
  */

  const signals = [

    mlProbability,

    markov.probability,

    pattern.probability,

    streak.probability

  ];


  const direction =
    probability >=
    0.5
      ? 1
      : 0;


  let agreement =
    0;


  for (
    const signal of
      signals
  ) {

    const signalDirection =
      signal >=
      0.5
        ? 1
        : 0;


    if (
      signalDirection ===
      direction
    ) {

      agreement++;
    }
  }


  /*
    Model strength.
  */

  const strength =
    Math.abs(
      probability -
      0.5
    ) * 2;


  /*
    Confidence.
  */

  let confidence =
    50 +
    strength * 22;


  confidence +=
    (
      agreement -
      2
    ) * 4;


  if (
    adaptive.validation.valid
  ) {

    const positiveEdge =
      Math.max(
        0,
        adaptive.validation.edge
      );


    confidence +=
      Math.min(
        12,
        positiveEdge *
        180
      );
  }


  /*
    High randomness lowers
    confidence.
  */

  if (
    randomness >=
    0.93
  ) {

    confidence -=
      8;
  }


  confidence =
    Math.round(
      clamp(
        confidence,
        51,
        91
      )
    );


  /*
    Quality.
  */

  let quality =
    "LOW";


  if (
    adaptive.validation.valid &&
    adaptive.validation.edge >=
      0.03 &&
    agreement >= 3 &&
    confidence >= 70
  ) {

    quality =
      "HIGH";

  }
  else if (
    adaptive.validation.valid &&
    adaptive.validation.edge >=
      0.01 &&
    agreement >= 2
  ) {

    quality =
      "MEDIUM";
  }


  /*
    Evidence.
  */

  let evidence =
    "WEAK";


  if (
    adaptive.validation.valid &&
    adaptive.validation.edge >=
      0.02
  ) {

    evidence =
      "SUPPORTED";
  }


  return {

    prediction:
      direction === 1
        ? "BIG"
        : "SMALL",

    confidence,

    quality,

    evidence,

    sampleSize:
      numbers.length,

    model:
      MODEL_VERSION,

    probability:
      Number(
        probability.toFixed(4)
      ),

    mlProbability:
      Number(
        mlProbability.toFixed(4)
      ),

    markovProbability:
      Number(
        markov.probability.toFixed(4)
      ),

    patternProbability:
      Number(
        pattern.probability.toFixed(4)
      ),

    streakProbability:
      Number(
        streak.probability.toFixed(4)
      ),

    agreement,

    randomness:
      Number(
        randomness.toFixed(4)
      ),

    patternMatches:
      pattern.matches,

    markovSamples:
      markov.samples,

    validation:
      adaptive.validation,

    weights:
      w
  };
}


/* =========================================================
   PREDICTION DB
========================================================= */

async function getPrediction(
  issue
) {

  if (!issue) {
    return null;
  }


  if (!pool) {

    return (

      memory.predictions
        .filter(
          item =>
            item.target_issue ===
            String(issue)
        )
        .sort(
          (a,b) =>
            b.created_at -
            a.created_at
        )[0]

      ||

      null
    );
  }


  const r =
    await pool.query(
      `
      SELECT *
      FROM prediction_records
      WHERE target_issue=$1
      ORDER BY id DESC
      LIMIT 1
      `,
      [
        String(issue)
      ]
    );


  return (
    r.rows[0] ||
    null
  );
}


/* =========================================================
   LAST PREDICTION
========================================================= */

async function getLastPrediction() {

  if (!pool) {

    return (

      [
        ...memory.predictions
      ]
        .sort(
          (a,b) =>
            b.created_at -
            a.created_at
        )[0]

      ||

      null
    );
  }


  const r =
    await pool.query(`
      SELECT *
      FROM prediction_records
      ORDER BY id DESC
      LIMIT 1
    `);


  return (
    r.rows[0] ||
    null
  );
}


/* =========================================================
   SAVE PREDICTION
========================================================= */

async function savePrediction(
  issue,
  ai
) {

  const existing =
    await getPrediction(
      issue
    );


  if (existing) {
    return existing;
  }


  if (!pool) {

    const row = {

      id:
        memory.predictionId++,

      target_issue:
        String(issue),

      prediction:
        ai.prediction,

      confidence:
        ai.confidence,

      model_version:
        MODEL_VERSION,

      actual_number:
        null,

      actual_result:
        null,

      created_at:
        now(),

      settled_at:
        null
    };


    memory.predictions.push(
      row
    );


    return row;
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
      VALUES($1,$2,$3,$4,$5)
      RETURNING *
      `,
      [

        String(issue),

        ai.prediction,

        ai.confidence,

        MODEL_VERSION,

        now()

      ]
    );


  return r.rows[0];
}


/* =========================================================
   SETTLE
========================================================= */

async function settlePredictions() {

  const resultMap =
    new Map();


  for (
    const item of
      live.history
  ) {

    if (
      item.issue !==
      null
    ) {

      resultMap.set(

        String(
          item.issue
        ),

        Number(
          item.number
        )

      );
    }
  }


  if (
    !resultMap.size
  ) {

    return;
  }


  if (!pool) {

    for (
      const prediction of
        memory.predictions
    ) {

      if (
        prediction.actual_result !==
          null
      ) {

        continue;
      }


      if (
        !resultMap.has(
          prediction.target_issue
        )
      ) {

        continue;
      }


      const number =
        resultMap.get(
          prediction.target_issue
        );


      prediction.actual_number =
        number;


      prediction.actual_result =
        resultType(
          number
        );


      prediction.settled_at =
        now();
    }


    return;
  }


  const r =
    await pool.query(`
      SELECT id,target_issue
      FROM prediction_records
      WHERE actual_result IS NULL
      ORDER BY id DESC
      LIMIT 100
    `);


  for (
    const item of
      r.rows
  ) {

    const issue =
      String(
        item.target_issue
      );


    if (
      !resultMap.has(
        issue
      )
    ) {

      continue;
    }


    const number =
      resultMap.get(
        issue
      );


    await pool.query(
      `
      UPDATE prediction_records
      SET actual_number=$1,
          actual_result=$2,
          settled_at=$3
      WHERE id=$4
      `,
      [

        number,

        resultType(
          number
        ),

        now(),

        item.id

      ]
    );
  }
}


/* =========================================================
   SKIP CYCLE
========================================================= */

async function getCycle(
  currentIssue
) {

  const last =
    await getLastPrediction();


  /*
    No previous prediction.
    Predict current round.
  */

  if (!last) {

    return {

      mode:
        "PREDICT",

      skipRound:
        0,

      skipTotal:
        SKIP_ROUNDS,

      skipRemaining:
        0
    };
  }


  const difference =
    issueDiff(

      currentIssue,

      last.target_issue

    );


  /*
    If issue format cannot
    be calculated, don't lock
    user forever.
  */

  if (
    difference === null
  ) {

    return {

      mode:
        "PREDICT",

      skipRound:
        0,

      skipTotal:
        SKIP_ROUNDS,

      skipRemaining:
        0
    };
  }


  /*
    Same issue:
    already predicted.
  */

  if (
    difference <= 0
  ) {

    return {

      mode:
        "PREDICTED",

      skipRound:
        0,

      skipTotal:
        SKIP_ROUNDS,

      skipRemaining:
        0
    };
  }


  /*
    Next 4 rounds are SKIP.
  */

  if (
    difference >= 1 &&
    difference <=
      SKIP_ROUNDS
  ) {

    return {

      mode:
        "SKIP",

      skipRound:
        difference,

      skipTotal:
        SKIP_ROUNDS,

      skipRemaining:
        SKIP_ROUNDS -
        difference +
        1
    };
  }


  /*
    4 skip rounds completed.
  */

  return {

    mode:
      "PREDICT",

    skipRound:
      0,

    skipTotal:
      SKIP_ROUNDS,

    skipRemaining:
      0
  };
}


/* =========================================================
   RESET ANALYSIS
========================================================= */

function resetAnalysis() {

  analysis.active =
    false;

  analysis.issue =
    null;

  analysis.startedAt =
    0;

  analysis.endsAt =
    0;
}


/* =========================================================
   ENGINE TICK
========================================================= */

async function engineTick() {

  if (
    engineBusy
  ) {

    return;
  }


  if (
    !live.ok ||
    !live.currentIssue
  ) {

    return;
  }


  engineBusy =
    true;


  try {

    const issue =
      String(
        live.currentIssue
      );


    /*
      Existing prediction?
    */

    const existing =
      await getPrediction(
        issue
      );


    if (existing) {

      resetAnalysis();

      return;
    }


    /*
      Check cycle.
    */

    const cycle =
      await getCycle(
        issue
      );


    /*
      IMPORTANT:
      no analysis during SKIP.
    */

    if (
      cycle.mode ===
      "SKIP"
    ) {

      resetAnalysis();

      return;
    }


    /*
      Start analysis immediately.
    */

    if (
      !analysis.active ||
      analysis.issue !==
        issue
    ) {

      analysis.active =
        true;

      analysis.issue =
        issue;

      analysis.startedAt =
        now();

      analysis.endsAt =
        now() +
        ANALYSIS
