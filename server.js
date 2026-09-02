const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

/* =========================================================
   CONFIG
========================================================= */

const PORT = Number(process.env.PORT || 10000);

const DATABASE_URL =
  process.env.DATABASE_URL;

const ADMIN_KEY =
  process.env.ADMIN_KEY || "dy4427574";

const WINGOBOT_TOKEN =
  process.env.WINGOBOT_TOKEN || "";

const ROUND_SECONDS = 30;

const API_REFRESH_MS = 1000;

const API_URL =
  "https://api.wingobot.com/v2/30-sec-game-history";


/* =========================================================
   DATABASE
========================================================= */

if (!DATABASE_URL) {
  console.error(
    "DATABASE_URL is missing"
  );

  process.exit(1);
}

const pool = new Pool({
  connectionString:
    DATABASE_URL,

  ssl: {
    rejectUnauthorized: false
  }
});


/* =========================================================
   LIVE CACHE
========================================================= */

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
   RESPONSE HELPERS
========================================================= */

function json(res, code, obj) {

  const body =
    JSON.stringify(obj);

  res.writeHead(code, {

    "Content-Type":
      "application/json; charset=utf-8",

    "Cache-Control":
      "no-store",

    "Access-Control-Allow-Origin":
      "*"

  });

  res.end(body);
}


function sendFile(
  res,
  filename,
  contentType
) {

  const filePath =
    path.join(
      __dirname,
      filename
    );

  fs.readFile(
    filePath,
    (err, data) => {

      if (err) {

        res.writeHead(
          404,
          {
            "Content-Type":
              "text/plain; charset=utf-8"
          }
        );

        return res.end(
          "File not found"
        );
      }

      res.writeHead(
        200,
        {
          "Content-Type":
            contentType,

          "Cache-Control":
            "no-store"
        }
      );

      res.end(data);
    }
  );
}


/* =========================================================
   GENERAL HELPERS
========================================================= */

function clamp(
  number,
  min,
  max
) {

  return Math.max(
    min,
    Math.min(max, number)
  );
}


function bigSmall(number) {

  return Number(number) >= 5
    ? "BIG"
    : "SMALL";
}


/* =========================================================
   ISSUE NUMBER
========================================================= */

function nextIssue(
  issue,
  step = 1
) {

  if (!issue) {
    return null;
  }

  const value =
    String(issue);

  const match =
    value.match(
      /^(.*?)(\d+)$/
    );

  if (!match) {
    return null;
  }

  const prefix =
    match[1];

  const digits =
    match[2];

  const width =
    digits.length;

  const next =
    (
      BigInt(digits) +
      BigInt(step)
    )
      .toString()
      .padStart(
        width,
        "0"
      );

  return prefix + next;
}


/* =========================================================
   HISTORY CLEANING
========================================================= */

function cleanHistory(rows) {

  if (!Array.isArray(rows)) {
    return [];
  }

  return rows

    .filter(row =>

      row &&
      row.issueNumber != null &&
      row.number != null

    )

    .map(row => ({

      issueNumber:
        String(
          row.issueNumber
        ),

      number:
        Number(
          row.number
        ),

      colour:
        row.colour ??
        null,

      premium:
        row.premium ??
        null,

      sum:
        row.sum ??
        null

    }))

    .filter(row =>

      Number.isFinite(
        row.number
      ) &&

      row.number >= 0 &&

      row.number <= 9

    )

    .sort((a, b) =>

      String(
        b.issueNumber
      ).localeCompare(
        String(
          a.issueNumber
        )
      )

    );
}


/* =========================================================
   BIG / SMALL SEQUENCE HELPERS
========================================================= */

function transitionScore(
  sequence
) {

  if (
    sequence.length < 2
  ) {
    return 0;
  }

  let same = 0;

  let flip = 0;

  for (
    let i = 0;
    i < sequence.length - 1;
    i++
  ) {

    if (
      sequence[i] ===
      sequence[i + 1]
    ) {

      same++;

    } else {

      flip++;
    }
  }

  return (
    flip - same
  ) /
  Math.max(
    1,
    sequence.length - 1
  );
}


function currentStreak(
  sequence
) {

  if (
    !sequence.length
  ) {
    return 0;
  }

  const first =
    sequence[0];

  let count = 1;

  for (
    let i = 1;
    i < sequence.length;
    i++
  ) {

    if (
      sequence[i] === first
    ) {

      count++;

    } else {

      break;
    }
  }

  return count;
}


function alternatingStrength(
  sequence
) {

  if (
    sequence.length < 3
  ) {
    return 0;
  }

  let flips = 0;

  for (
    let i = 0;
    i < sequence.length - 1;
    i++
  ) {

    if (
      sequence[i] !==
      sequence[i + 1]
    ) {

      flips++;
    }
  }

  return (
    flips /
    (sequence.length - 1)
  );
}


function continuationStrength(
  sequence
) {

  if (
    sequence.length < 3
  ) {
    return 0;
  }

  let same = 0;

  for (
    let i = 0;
    i < sequence.length - 1;
    i++
  ) {

    if (
      sequence[i] ===
      sequence[i + 1]
    ) {

      same++;
    }
  }

  return (
    same /
    (sequence.length - 1)
  );
}


/* =========================================================
   DY AI BIG / SMALL ENGINE
========================================================= */

function analyze(
  history,
  targetPeriod
) {

  /*
    Minimum history.

    We don't want to make a signal
    from only 2-3 results.
  */

  if (
    history.length < 10
  ) {

    return {

      ready: false,

      targetPeriod,

      prediction: null,

      number: null,

      confidence: 0,

      patternScore: 0,

      sampleSize:
        history.length,

      modelStatus:
        "WAITING FOR HISTORY"

    };
  }


  /*
    Newest result is index 0.
  */

  const sequence =
    history.map(
      row =>
        bigSmall(
          row.number
        )
    );


  const recent3 =
    sequence.slice(0, 3);

  const recent5 =
    sequence.slice(0, 5);

  const recent7 =
    sequence.slice(0, 7);

  const recent10 =
    sequence.slice(0, 10);

  const recent15 =
    sequence.slice(0, 15);

  const recent20 =
    sequence.slice(0, 20);

  const recent30 =
    sequence.slice(0, 30);


  /*
    =====================================================
    IMPORTANT:

    We DO NOT calculate:

      BIG count
      SMALL count
      number frequency

    as the main prediction.

    The engine studies the ORDER and BEHAVIOUR
    of the sequence.
    =====================================================
  */


  let bigScore = 0;

  let smallScore = 0;


  /* =====================================================
     1. MICRO PATTERN — LAST 3
  ===================================================== */

  if (
    recent3.length === 3
  ) {

    /*
      AAA pattern
    */

    if (
      recent3[0] === recent3[1] &&
      recent3[1] === recent3[2]
    ) {

      /*
        Three same in a row.

        Don't blindly continue.
        Treat it as a continuation + reversal
        conflict and use streak length later.
      */

      if (
        recent3[0] === "BIG"
      ) {

        bigScore += 0.75;

      } else {

        smallScore += 0.75;
      }
    }


    /*
      ABA pattern

      Example:

      BIG
      SMALL
      BIG

      This indicates alternating behaviour.
    */

    if (
      recent3[0] === recent3[2] &&
      recent3[0] !== recent3[1]
    ) {

      if (
        recent3[0] === "BIG"
      ) {

        smallScore += 1.15;

      } else {

        bigScore += 1.15;
      }
    }


    /*
      AAB pattern

      Example:

      BIG
      BIG
      SMALL
    */

    if (
      recent3[0] === recent3[1] &&
      recent3[1] !== recent3[2]
    ) {

      if (
        recent3[2] === "BIG"
      ) {

        bigScore += 0.45;

      } else {

        smallScore += 0.45;
      }
    }


    /*
      ABB pattern
    */

    if (
      recent3[0] !== recent3[1] &&
      recent3[1] === recent3[2]
    ) {

      if (
        recent3[0] === "BIG"
      ) {

        smallScore += 0.35;

      } else {

        bigScore += 0.35;
      }
    }
  }


  /* =====================================================
     2. LAST 5 TRANSITION BEHAVIOUR
  ===================================================== */

  const t5 =
    transitionScore(
      recent5
    );

  const alt5 =
    alternatingStrength(
      recent5
    );

  const cont5 =
    continuationStrength(
      recent5
    );


  /*
    Strong alternating sequence
  */

  if (
    alt5 >= 0.75
  ) {

    if (
      sequence[0] === "BIG"
    ) {

      smallScore += 1.20;

    } else {

      bigScore += 1.20;
    }
  }


  /*
    Strong continuation sequence
  */

  if (
    cont5 >= 0.75
  ) {

    if (
      sequence[0] === "BIG"
    ) {

      bigScore += 0.95;

    } else {

      smallScore += 0.95;
    }
  }


  /*
    General transition signal
  */

  if (
    t5 > 0.30
  ) {

    if (
      sequence[0] === "BIG"
    ) {

      smallScore += 0.75;

    } else {

      bigScore += 0.75;
    }

  } else if (
    t5 < -0.30
  ) {

    if (
      sequence[0] === "BIG"
    ) {

      bigScore += 0.75;

    } else {

      smallScore += 0.75;
    }
  }


  /* =====================================================
     3. STREAK ANALYSIS
  ===================================================== */

  const streak =
    currentStreak(
      sequence
    );


  /*
    1-2 same:
    no strong decision.
  */

  if (
    streak === 3
  ) {

    /*
      Moderate continuation signal.
    */

    if (
      sequence[0] === "BIG"
    ) {

      bigScore += 0.35;

    } else {

      smallScore += 0.35;
    }
  }


  /*
    4+ same:

    Reversal becomes more interesting.
  */

  if (
    streak >= 4
  ) {

    if (
      sequence[0] === "BIG"
    ) {

      smallScore +=
        1.10 +
        Math.min(
          0.8,
          (streak - 4) *
          0.15
        );

    } else {

      bigScore +=
        1.10 +
        Math.min(
          0.8,
          (streak - 4) *
          0.15
        );
    }
  }


  /* =====================================================
     4. SHORT WINDOW PATTERN
  ===================================================== */

  function patternDirection(
    arr
  ) {

    if (
      arr.length < 3
    ) {
      return 0;
    }

    let value = 0;

    for (
      let i = 0;
      i < arr.length - 1;
      i++
    ) {

      const weight =
        1 /
        (1 + i * 0.16);

      if (
        arr[i] ===
        arr[i + 1]
      ) {

        /*
          Recent continuation.
        */

        value +=
          arr[i] === "BIG"
            ? 0.42 * weight
            : -0.42 * weight;

      } else {

        /*
          Flip behaviour.
        */

        value +=
          arr[i] === "BIG"
            ? -0.18 * weight
            : 0.18 * weight;
      }
    }

    return value;
  }


  const p7 =
    patternDirection(
      recent7
    );

  const p10 =
    patternDirection(
      recent10
    );

  const p15 =
    patternDirection(
      recent15
    );

  const p20 =
    patternDirection(
      recent20
    );

  const p30 =
    patternDirection(
      recent30
    );


  /* =====================================================
     5. MULTI WINDOW AGREEMENT
  ===================================================== */

  if (
    p7 > 0.25
  ) {

    bigScore += 0.70;

  } else if (
    p7 < -0.25
  ) {

    smallScore += 0.70;
  }


  if (
    p10 > 0.30
  ) {

    bigScore += 0.55;

  } else if (
    p10 < -0.30
  ) {

    smallScore += 0.55;
  }


  if (
    p15 > 0.35
  ) {

    bigScore += 0.45;

  } else if (
    p15 < -0.35
  ) {

    smallScore += 0.45;
  }


  if (
    p20 > 0.45
  ) {

    bigScore += 0.30;

  } else if (
    p20 < -0.45
  ) {

    smallScore += 0.30;
  }


  if (
    p30 > 0.55
  ) {

    bigScore += 0.20;

  } else if (
    p30 < -0.55
  ) {

    smallScore += 0.20;
  }


  /* =====================================================
     6. REVERSAL PRESSURE
  ===================================================== */

  const recent8 =
    recent7.length >= 5
      ? recent7
      : recent10;


  const recentTransition =
    transitionScore(
      recent8
    );


  /*
    Very high flipping behaviour.
  */

  if (
    recentTransition > 0.45
  ) {

    if (
      sequence[0] === "BIG"
    ) {

      smallScore += 0.70;

    } else {

      bigScore += 0.70;
    }
  }


  /*
    Very high continuation behaviour.
  */

  if (
    recentTransition < -0.45
  ) {

    if (
      sequence[0] === "BIG"
    ) {

      bigScore += 0.55;

    } else {

      smallScore += 0.55;
    }
  }


  /* =====================================================
     7. VOLATILITY
  ===================================================== */

  const transitions10 =
    transitionScore(
      recent10
    );

  const transitions20 =
    transitionScore(
      recent20
    );


  const volatility =
    Math.abs(
      transitions10
    ) +
    Math.abs(
      transitions20
    );


  /*
    High volatility means the sequence is unstable.

    Reduce confidence rather than pretending
    the model has a strong signal.
  */

  const unstable =
    volatility < 0.18;


  /* =====================================================
     8. FINAL DECISION
  ===================================================== */

  const difference =
    Math.abs(
      bigScore -
      smallScore
    );


  let prediction;

  if (
    bigScore >
    smallScore
  ) {

    prediction =
      "BIG";

  } else if (
    smallScore >
    bigScore
  ) {

    prediction =
      "SMALL";

  } else {

    /*
      Exact tie:

      Use the latest sequence behaviour,
      not BIG/SMALL count.
    */

    prediction =
      sequence[0] === "BIG"
        ? "SMALL"
        : "BIG";
  }


  /* =====================================================
     9. SIGNAL AGREEMENT
  ===================================================== */

  let bigSignals = 0;

  let smallSignals = 0;


  if (
    p7 > 0.25
  ) {

    bigSignals++;

  } else if (
    p7 < -0.25
  ) {

    smallSignals++;
  }


  if (
    p10 > 0.30
  ) {

    bigSignals++;

  } else if (
    p10 < -0.30
  ) {

    smallSignals++;
  }


  if (
    p15 > 0.35
  ) {

    bigSignals++;

  } else if (
    p15 < -0.35
  ) {

    smallSignals++;
  }


  if (
    p20 > 0.45
  ) {

    bigSignals++;

  } else if (
    p20 < -0.45
  ) {

    smallSignals++;
  }


  if (
    p30 > 0.55
  ) {

    bigSignals++;

  } else if (
    p30 < -0.55
  ) {

    smallSignals++;
  }


  const agreement =
    prediction === "BIG"
      ? bigSignals
      : smallSignals;


  /* =====================================================
     10. CONFIDENCE
  ===================================================== */

  let confidence =
    50 +
    difference * 5 +
    agreement * 2;


  /*
    Don't produce fake high confidence
    when the pattern is unstable.
  */

  if (
    unstable
  ) {

    confidence -= 4;
  }


  confidence =
    clamp(
      Math.round(
        confidence
      ),
      51,
      72
    );


  /* =====================================================
     11. PATTERN SCORE
  ===================================================== */

  const patternStrength =

    Math.abs(p7) * 22 +

    Math.abs(p10) * 18 +

    Math.abs(p15) * 14 +

    Math.abs(t5) * 14 +

    Math.abs(
      transitions10
    ) * 10 +

    Math.abs(
      transitions20
    ) * 8;


  const patternScore =
    clamp(
      Math.round(
        50 +
        patternStrength
      ),
      50,
      90
    );


  /* =====================================================
     12. MODEL STATUS
  ===================================================== */

  let modelStatus;

  if (
    confidence >= 66
  ) {

    modelStatus =
      "STRONG SIGNAL";

  } else if (
    confidence >= 59
  ) {

    modelStatus =
      "MODERATE SIGNAL";

  } else {

    modelStatus =
      "LOW SIGNAL";
  }


  return {

    ready: true,

    targetPeriod,

    prediction,

    /*
      NUMBER IS NOT USED.
    */

    number: null,

    confidence,

    patternScore,

    sampleSize:
      history.length,

    streak,

    transition:
      Number(
        t5.toFixed(3)
      ),

    modelStatus,

    signalAgreement: {
      big:
        bigSignals,

      small:
        smallSignals
    },

    patternWindows: {
      micro:
        Number(
          p7.toFixed(3)
        ),

      short:
        Number(
          p10.toFixed(3)
        ),

      medium:
        Number(
          p15.toFixed(3)
        ),

      long:
        Number(
          p20.toFixed(3)
        ),

      extended:
        Number(
          p30.toFixed(3)
        )
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

  if (
    !WINGOBOT_TOKEN
  ) {

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


  if (
    !response.ok
  ) {

    throw new Error(
      `WingoBot HTTP ${response.status}`
    );
  }


  return await response.json();
}


/* =========================================================
   CACHE UPDATE
========================================================= */

async function updateCache(
  data
) {

  const history =
    cleanHistory(
      data.history ||
      data.data ||
      data.results ||
      []
    );


  if (
    !history.length
  ) {

    throw new Error(
      "WingoBot returned no history"
    );
  }


  const settledIssue =
    history[0].issueNumber;


  /*
    We compare the newest few REAL
    settled results.

    This prevents the same prediction
    from regenerating every second.
  */

  const signature =
    history
      .slice(0, 5)
      .map(
        row =>
          `${row.issueNumber}:${row.number}`
      )
      .join("|");


  const historyChanged =
    signature !==
    cache.historySignature;


  cache.data =
    data;

  cache.history =
    history;


  cache.apiIssue =
    data?.current?.issueNumber != null
      ? String(
          data.current.issueNumber
        )
      : null;


  cache.apiNumber =
    data?.current?.number ??
    null;


  cache.settledIssue =
    settledIssue;


  /*
    Prediction is always for the next
    issue after the latest settled result.
  */

  cache.targetIssue =
    nextIssue(
      settledIssue,
      1
    );


  cache.lastSuccessAt =
    Date.now();

  cache.error =
    null;


  /*
    CRITICAL:

    Only create a new prediction when
    actual history changes.
  */

  if (
    historyChanged
  ) {

    cache.historySignature =
      signature;


    cache.historyVersion++;


    cache.lastHistoryChangeAt =
      Date.now();


    /*
      Timer anchor is based on actual
      observed settled result change.
    */

    cache.anchorIssue =
      settledIssue;


    cache.anchorTime =
      Date.now();


    /*
      Generate BIG/SMALL analysis.
    */

    cache.analysis =
      analyze(
        cache.history,
        cache.targetIssue
      );
  }
}


/* =========================================================
   API REFRESH
========================================================= */

async function refreshWingo() {

  if (
    cache.fetching
  ) {

    return;
  }


  cache.fetching =
    true;


  try {

    const data =
      await fetchWingoBot();


    await updateCache(
      data
    );

  } catch (
    error
  ) {

    cache.error =
      error.message ||
      "WingoBot API error";

  } finally {

    cache.fetching =
      false;
  }
}


/* =========================================================
   TIMER
========================================================= */

function getTiming() {

  if (
    !cache.anchorTime
  ) {

    return {

      countdown:
        null,

      estimated:
        true,

      status:
        "WAITING FOR SYNC"

    };
  }


  const elapsed =
    Math.floor(
      (
        Date.now() -
        cache.anchorTime
      ) / 1000
    );


  const countdown =
    Math.max(
      1,

      ROUND_SECONDS -
      (
        elapsed %
        ROUND_SECONDS
      )
    );


  return {

    countdown,

    /*
      The endpoint doesn't expose
      the exact provider countdown.
    */

    estimated:
      true,

    status:
      "SYNCED / ESTIMATED",

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

    ok:
      true,


    serverTime:
      Date.now(),


    /*
      Latest actual settled period.
    */

    settledPeriod:
      cache.settledIssue,


    /*
      Prediction target.
    */

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


    /*
      Number intentionally disabled.
    */

    number:
      null,


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


    signalAgreement:
      analysis?.signalAgreement ||
      null,


    patternWindows:
      analysis?.patternWindows ||
      null,


    error:
      cache.error,


    note:
      "BIG/SMALL statistical sequence analysis. Random outcomes are not guaranteed."

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
   ACCESS KEY CHECK
========================================================= */

async function checkKey(
  accessKey,
  deviceId
) {

  if (
    !accessKey ||
    !deviceId
  ) {

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
      [
        accessKey
      ]
    );


  if (
    !result.rows.length
  ) {

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


  if (
    !row.device_id
  ) {

    await pool.query(
      `
      UPDATE access_keys

      SET
        device_id=$1,
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
   ADMIN AUTH
========================================================= */

function adminOk(
  req,
  url
) {

  const key =
    req.headers[
      "x-admin-key"
    ] ||

    url.searchParams.get(
      "key"
    ) ||

    "";


  return (
    key ===
    ADMIN_KEY
  );
}


/* =========================================================
   REQUEST BODY
========================================================= */

function readJsonBody(
  req
) {

  return new Promise(
    (
      resolve,
      reject
    ) => {

      let body = "";


      req.on(
        "data",
        chunk => {

          body += chunk;


          if (
            body.length >
            1024 * 1024
          ) {

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

            reject(
              new Error(
                "Invalid JSON"
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
   ADMIN KEYS
========================================================= */

async function handleAdminKeys(
  req,
  res,
  url
) {

  if (
    !adminOk(
      req,
      url
    )
  ) {

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
      await readJsonBody(
        req
      );


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
        access_key:
          key
      }
    );
  }


  if (
    req.method === "DELETE"
  ) {

    const body =
      await readJsonBody(
        req
      );


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
      [
        key
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


  return json(
    res,
    405,
    {
      ok: false
    }
  );
}


/* =========================================================
   MP3
========================================================= */

function serveMp3(
  req,
  res
) {

  const filePath =
    path.join(
      __dirname,
      "music.mp3"
    );


  if (
    !fs.existsSync(
      filePath
    )
  ) {

    res.writeHead(404);

    return res.end();
  }


  const stat =
    fs.statSync(
      filePath
    );


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
      .createReadStream(
        filePath
      )
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

async function route(
  req,
  res
) {

  const url =
    new URL(
      req.url,
      `http://${
        req.headers.host ||
        "localhost"
      }`
    );


  /* CORS */

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


  /* HEALTH */

  if (
    url.pathname ===
    "/health"
  ) {

    return json(
      res,
      200,
      {

        ok: true,

        time:
          Date.now(),

        wingo:
          !!cache.lastSuccessAt

      }
    );
  }


  /* STATE */

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


  /* HISTORY */

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


  /* KEY */

  if (
    url.pathname ===
      "/api/key/check" &&
    req.method === "POST"
  ) {

    try {

      const body =
        await readJsonBody(
          req
        );


      const result =
        await checkKey(

          String(
            body.key ||
            ""
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

    } catch (
      error
    ) {

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


  /* ADMIN KEYS */

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


  /* RESET DEVICE */

  if (
    url.pathname ===
      "/api/admin/reset-device" &&
    req.method === "POST"
  ) {

    if (
      !adminOk(
        req,
        url
      )
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
      await readJsonBody(
        req
      );


    await pool.query(
      `
      UPDATE access_keys

      SET device_id=NULL

      WHERE access_key=$1
      `,
      [
        String(
          body.key ||
          ""
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


  /* ADMIN STATUS */

  if (
    url.pathname ===
    "/api/admin/status"
  ) {

    if (
      !adminOk(
        req,
        url
      )
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


  /* ADMIN PING */

  if (
    url.pathname ===
    "/api/admin/ping"
  ) {

    if (
      !adminOk(
        req,
        url
      )
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

        pong:
          Date.now()

      }
    );
  }


  /* WINGOBOT TEST */

  if (
    url.pathname ===
    "/api/admin/wingo-test"
  ) {

    if (
      !adminOk(
        req,
        url
      )
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

    } catch (
      error
    ) {

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


  /* PREDICTION PAGE */

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


  /* ADMIN PAGE */

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


  /* MUSIC */

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
      First live synchronization.
    */

    await refreshWingo();


    /*
      Refresh WingoBot every second.

      IMPORTANT:
      This does NOT create a new prediction
      every second.

      New prediction only happens when
      settled history changes.
    */

    setInterval(
      refreshWingo,
      API_REFRESH_MS
    );


    const server =
      http.createServer(
        (
          req,
          res
        ) => {

          route(
            req,
            res
          )
            .catch(
              error => {

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

              }
            );

        }
      );


    server.listen(
      PORT,
      () => {

        console.log(
          `DY AI server running on ${PORT}`
        );

        console.log(
          "BIG/SMALL AI engine active"
        );

      }
    );

  } catch (
    error
  ) {

    console.error(
      "Startup error:",
      error
    );

    process.exit(1);
  }

})();
