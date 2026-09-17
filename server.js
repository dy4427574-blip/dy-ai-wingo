"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");


/* =====================================================
   CONFIG
===================================================== */

const PORT =
  Number(process.env.PORT || 10000);


/*
   IMPORTANT:
   Token Render Environment Variable में रखना है.

   Render:
   WINGOBOT_TOKEN = YOUR_TOKEN
*/

const WINGOBOT_TOKEN =
  String(
    process.env.WINGOBOT_TOKEN || ""
  ).trim();


const ADMIN_KEY =
  String(
    process.env.ADMIN_KEY ||
    "dy4427574"
  ).trim();


const API_URL =
  "https://api.wingobot.com/v2/1-min-game-history";


/* =====================================================
   STATE
===================================================== */

let state = {

  success: false,

  currentPeriod: null,

  predictionPeriod: null,

  history: [],

  stats: null,

  sourceStatus: "CONNECTING",

  lastUpdate: 0,

  lastError: null,

  analysis: {

    active: false,

    remaining: 0,

    targetPeriod: null,

    prediction: "WAITING",

    message:
      "WAITING FOR NEW PERIOD..."

  }

};


let lastPredictionPeriod = null;

let analysisTimer = null;

let requestRunning = false;


/* =====================================================
   NO CACHE
===================================================== */

function noCache(res) {

  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate"
  );

  res.setHeader(
    "Pragma",
    "no-cache"
  );

  res.setHeader(
    "Expires",
    "0"
  );

}


/* =====================================================
   JSON RESPONSE
===================================================== */

function sendJSON(
  res,
  data,
  status = 200
) {

  noCache(res);

  res.writeHead(
    status,
    {
      "Content-Type":
        "application/json; charset=utf-8"
    }
  );

  res.end(
    JSON.stringify(data)
  );

}


/* =====================================================
   FILE RESPONSE
===================================================== */

function sendFile(
  res,
  filename
) {

  const filePath =
    path.join(
      __dirname,
      filename
    );


  if (
    !fs.existsSync(filePath)
  ) {

    return sendJSON(
      res,
      {
        success: false,
        error:
          "File not found: " +
          filename
      },
      404
    );

  }


  noCache(res);

  res.writeHead(
    200,
    {
      "Content-Type":
        "text/html; charset=utf-8"
    }
  );


  res.end(
    fs.readFileSync(
      filePath
    )
  );

}


/* =====================================================
   BIG / SMALL
===================================================== */

function getSize(number) {

  const n =
    Number(number);


  if (
    !Number.isInteger(n)
  ) {

    return null;

  }


  return n <= 4
    ? "SMALL"
    : "BIG";

}


/* =====================================================
   NORMALIZE EXACT WINGOBOT HISTORY
===================================================== */

function normalizeHistory(
  history
) {

  if (
    !Array.isArray(history)
  ) {

    return [];

  }


  return history

    .map(
      row => {

        if (
          !row ||
          typeof row !==
          "object"
        ) {

          return null;

        }


        const period =
          row.issueNumber ??
          row.period ??
          row.issue ??
          null;


        const number =
          Number(
            row.number
          );


        if (
          period === null ||
          !Number.isInteger(
            number
          ) ||
          number < 0 ||
          number > 9
        ) {

          return null;

        }


        return {

          issueNumber:
            String(period),

          number:

            number,

          size:
            getSize(number),

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

      }
    )

    .filter(Boolean);

}


/* =====================================================
   PERIOD TO BIGINT
===================================================== */

function periodNumber(
  value
) {

  if (
    value === null ||
    value === undefined
  ) {

    return null;

  }


  const s =
    String(value);


  if (
    !/^\d+$/.test(s)
  ) {

    return null;

  }


  try {

    return BigInt(s);

  } catch {

    return null;

  }

}


/* =====================================================
   GET NEXT PERIOD
===================================================== */

function getNextPeriod(
  currentPeriod,
  history
) {

  /*
     API current.issueNumber
     is the authoritative period.
  */

  if (
    currentPeriod
  ) {

    const current =
      String(
        currentPeriod
      );


    const n =
      periodNumber(
        current
      );


    if (
      n !== null
    ) {

      return (
        n + 1n
      )
      .toString()
      .padStart(
        current.length,
        "0"
      );

    }

  }


  /*
     Fallback:
     latest history + 1
  */

  if (
    Array.isArray(history) &&
    history.length
  ) {

    const latest =
      String(
        history[0]
          .issueNumber
      );


    const n =
      periodNumber(
        latest
      );


    if (
      n !== null
    ) {

      return (
        n + 1n
      )
      .toString()
      .padStart(
        latest.length,
        "0"
      );

    }

  }


  return null;

}


/* =====================================================
   EXACT WINGOBOT REQUEST
===================================================== */

async function fetchWingoBot() {

  if (
    !WINGOBOT_TOKEN
  ) {

    throw new Error(
      "WINGOBOT_TOKEN is not configured"
    );

  }


  const separator =
    API_URL.includes("?")
      ? "&"
      : "?";


  const requestURL =
    API_URL +
    separator +
    "_=" +
    Date.now();


  const response =
    await fetch(
      requestURL,
      {

        method:
          "GET",

        cache:
          "no-store",

        headers: {

          "Authorization":
            "Bearer " +
            WINGOBOT_TOKEN,

          "Accept":
            "application/json",

          "Cache-Control":
            "no-cache",

          "Pragma":
            "no-cache",

          "User-Agent":
            "DY-AI-Wingo/1.0"

        }

      }
    );


  const text =
    await response.text();


  if (
    !response.ok
  ) {

    throw new Error(
      "HTTP " +
      response.status
    );

  }


  let data;


  try {

    data =
      JSON.parse(text);

  } catch {

    throw new Error(
      "WingoBot returned invalid JSON"
    );

  }


  if (
    data.success !== true
  ) {

    throw new Error(
      data.error ||
      "WingoBot API returned success=false"
    );

  }


  return data;

}


/* =====================================================
   ANALYSIS ENGINE
===================================================== */

function calculateEngine(
  history
) {

  if (
    !Array.isArray(history) ||
    history.length < 10
  ) {

    return "NO CLEAR SIGNAL";

  }


  const rows =
    history.slice(
      0,
      20
    );


  const sizes =
    rows.map(
      row => row.size
    );


  let bigScore = 0;

  let smallScore = 0;


  /* --------------------------------
     RECENCY WEIGHT
  -------------------------------- */

  sizes
    .slice(0, 10)
    .forEach(
      (value, index) => {

        const weight =
          10 - index;


        if (
          value === "BIG"
        ) {

          bigScore +=
            weight;

        }


        if (
          value === "SMALL"
        ) {

          smallScore +=
            weight;

        }

      }
    );


  /* --------------------------------
     CURRENT STREAK
  -------------------------------- */

  let streak = 1;


  for (
    let i = 1;
    i < sizes.length;
    i++
  ) {

    if (
      sizes[i] ===
      sizes[0]
    ) {

      streak++;

    } else {

      break;

    }

  }


  if (
    streak >= 3
  ) {

    if (
      sizes[0] ===
      "BIG"
    ) {

      bigScore += 4;

      smallScore += 1;

    } else {

      smallScore += 4;

      bigScore += 1;

    }

  }


  /* --------------------------------
     ALTERNATION
  -------------------------------- */

  let alternation =
    0;


  for (
    let i = 0;
    i <
    Math.min(
      9,
      sizes.length - 1
    );
    i++
  ) {

    if (
      sizes[i] !==
      sizes[i + 1]
    ) {

      alternation++;

    }

  }


  /*
     Very strong chop:
     don't force a prediction.
  */

  if (
    alternation >= 7
  ) {

    return "NO CLEAR SIGNAL";

  }


  /* --------------------------------
     LAST 3
  -------------------------------- */

  const p3 =
    sizes
      .slice(0, 3)
      .join("");


  if (
    p3 === "BBB"
  ) {

    smallScore += 3;

  }


  if (
    p3 === "SSS"
  ) {

    bigScore += 3;

  }


  if (
    p3 === "BSB"
  ) {

    smallScore += 2;

  }


  if (
    p3 === "SBS"
  ) {

    bigScore += 2;

  }


  /* --------------------------------
     LAST 5
  -------------------------------- */

  const p5 =
    sizes
      .slice(0, 5)
      .join("");


  if (
    p5 === "BSBSB"
  ) {

    smallScore += 2;

  }


  if (
    p5 === "SBSBS"
  ) {

    bigScore += 2;

  }


  if (
    p5 === "BBBSS"
  ) {

    bigScore += 1;

  }


  if (
    p5 === "SSSBB"
  ) {

    smallScore += 1;

  }


  /* --------------------------------
     REPEATED 3 BLOCK
  -------------------------------- */

  const block1 =
    sizes
      .slice(0, 3)
      .join("");


  const block2 =
    sizes
      .slice(3, 6)
      .join("");


  if (
    block1 &&
    block1 === block2
  ) {

    if (
      block1 === "BBB"
    ) {

      smallScore += 2;

    }


    if (
      block1 === "SSS"
    ) {

      bigScore += 2;

    }

  }


  /* --------------------------------
     SHORT / LONG AGREEMENT
  -------------------------------- */

  const short =
    sizes.slice(
      0,
      5
    );


  const long =
    sizes.slice(
      0,
      15
    );


  const shortBig =
    short.filter(
      x => x === "BIG"
    ).length;


  const shortSmall =
    short.filter(
      x => x === "SMALL"
    ).length;


  const longBig =
    long.filter(
      x => x === "BIG"
    ).length;


  const longSmall =
    long.filter(
      x => x === "SMALL"
    ).length;


  if (
    shortBig >
      shortSmall &&
    longBig >
      longSmall
  ) {

    bigScore += 3;

  }


  if (
    shortSmall >
      shortBig &&
    longSmall >
      longBig
  ) {

    smallScore += 3;

  }


  /* --------------------------------
     DIGIT STRUCTURE
  -------------------------------- */

  const boundary =
    rows

      .map(
        row =>
          row.number
      )

      .filter(
        n =>
          n === 0 ||
          n === 5
      )

      .length;


  if (
    boundary >= 3
  ) {

    bigScore -= 1;

    smallScore -= 1;

  }


  /* --------------------------------
     FINAL
  -------------------------------- */

  const difference =
    Math.abs(
      bigScore -
      smallScore
    );


  if (
    difference < 4
  ) {

    return "NO CLEAR SIGNAL";

  }


  return (
    bigScore >
    smallScore
  )
    ? "BIG"
    : "SMALL";

}


/* =====================================================
   FINAL PREDICTION
===================================================== */

function makePrediction(
  history
) {

  const engine =
    calculateEngine(
      history
    );


  /*
     Opposite-output layer
  */

  if (
    engine === "BIG"
  ) {

    return "SMALL";

  }


  if (
    engine === "SMALL"
  ) {

    return "BIG";

  }


  return "NO CLEAR SIGNAL";

}


/* =====================================================
   5 SECOND ANALYSIS
===================================================== */

function startAnalysis(
  targetPeriod,
  history
) {

  if (
    analysisTimer
  ) {

    clearInterval(
      analysisTimer
    );

  }


  let seconds = 5;


  state.analysis = {

    active: true,

    remaining: 5,

    targetPeriod:
      targetPeriod,

    prediction:
      "ANALYZING",

    message:
      "ANALYZING PATTERN..."

  };


  const messages = {

    4:
      "CHECKING RECENT RESULTS...",

    3:
      "COMPARING SEQUENCES...",

    2:
      "VALIDATING SIGNAL...",

    1:
      "FINALIZING PREDICTION..."

  };


  analysisTimer =
    setInterval(
      () => {

        seconds--;


        if (
          seconds > 0
        ) {

          state.analysis
            .remaining =
            seconds;


          state.analysis
            .message =
            messages[
              seconds
            ];


          return;

        }


        clearInterval(
          analysisTimer
        );


        analysisTimer =
          null;


        const prediction =
          makePrediction(
            history
          );


        state.analysis = {

          active: false,

          remaining: 0,

          targetPeriod:
            targetPeriod,

          prediction:
            prediction,

          message:
            "PREDICTION READY"

        };

      },
      1000
    );

}


/* =====================================================
   UPDATE FROM WINGOBOT
===================================================== */

async function updateFromAPI() {

  if (
    requestRunning
  ) {

    return;

  }


  requestRunning = true;


  try {

    const data =
      await fetchWingoBot();


    const history =
      normalizeHistory(
        data.history
      );


    if (
      !history.length
    ) {

      throw new Error(
        "No history received"
      );

    }


    /*
       Exact API current period
    */

    const currentPeriod =
      data.current &&
      data.current.issueNumber
        ? String(
            data.current.issueNumber
          )
        : history[0]
            .issueNumber;


    /*
       Prediction period
    */

    const predictionPeriod =
      getNextPeriod(
        currentPeriod,
        history
      );


    state.success =
      true;


    state.currentPeriod =
      currentPeriod;


    state.predictionPeriod =
      predictionPeriod;


    state.history =
      history.slice(
        0,
        30
      );


    state.stats =
      data.stats ||
      null;


    state.lastUpdate =
      Date.now();


    state.lastError =
      null;


    state.sourceStatus =
      "LIVE";


    /*
       NEW PERIOD DETECTED
    */

    if (
      predictionPeriod &&
      predictionPeriod !==
        lastPredictionPeriod
    ) {

      lastPredictionPeriod =
        predictionPeriod;


      startAnalysis(
        predictionPeriod,
        state.history
      );

    }


  } catch (error) {

    state.success =
      false;


    state.lastError =
      error.message;


    state.sourceStatus =
      "ERROR";

  } finally {

    requestRunning =
      false;

  }

}


/* =====================================================
   POLL EVERY 1 SECOND
===================================================== */

updateFromAPI();


setInterval(
  updateFromAPI,
  1000
);


/* =====================================================
   HTTP SERVER
===================================================== */

const server =
  http.createServer(
    (req, res) => {

      const url =
        new URL(
          req.url,
          `http://${
            req.headers.host ||
            "localhost"
          }`
        );


      /* ============================================
         LIVE STATE
      ============================================ */

      if (
        url.pathname ===
        "/api/state"
      ) {

        return sendJSON(
          res,
          {

            success:
              state.success,

            currentPeriod:
              state.currentPeriod,

            predictionPeriod:
              state.predictionPeriod,

            history:
              state.history,

            stats:
              state.stats,

            analysis:
              state.analysis,

            sourceStatus:
              state.sourceStatus,

            lastUpdate:
              state.lastUpdate,

            error:
              state.lastError

          }
        );

      }


      /* ============================================
         HISTORY
      ============================================ */

      if (
        url.pathname ===
        "/api/history"
      ) {

        return sendJSON(
          res,
          {

            success:
              true,

            history:
              state.history

          }
        );

      }


      /* ============================================
         HEALTH
      ============================================ */

      if (
        url.pathname ===
        "/api/health"
      ) {

        return sendJSON(
          res,
          {

            ok:
              true,

            api:
              API_URL,

            method:
              "GET",

            tokenConfigured:
              Boolean(
                WINGOBOT_TOKEN
              ),

            sourceStatus:
              state.sourceStatus,

            lastUpdate:
              state.lastUpdate,

            lastError:
              state.lastError

          }
        );

      }


      /* ============================================
         ADMIN CHECK
      ============================================ */

      if (
        url.pathname ===
        "/api/admin/check"
      ) {

        const key =
          url.searchParams.get(
            "key"
          ) || "";


        return sendJSON(
          res,
          {

            success:
              key ===
              ADMIN_KEY

          }
        );

      }


      /* ============================================
         PREDICTION PAGE
      ============================================ */

      if (
        url.pathname === "/" ||
        url.pathname ===
          "/prediction"
      ) {

        return sendFile(
          res,
          "prediction.html"
        );

      }


      /* ============================================
         ADMIN PAGE
      ============================================ */

      if (
        url.pathname ===
        "/admin"
      ) {

        return sendFile(
          res,
          "admin.html"
        );

      }


      /* ============================================
         MUSIC
      ============================================ */

      if (
        url.pathname ===
        "/music.mp3"
      ) {

        const music =
          path.join(
            __dirname,
            "music.mp3"
          );


        if (
          !fs.existsSync(
            music
          )
        ) {

          res.writeHead(
            404
          );

          return res.end(
            "Music not found"
          );

        }


        res.writeHead(
          200,
          {
            "Content-Type":
              "audio/mpeg"
          }
        );


        return fs
          .createReadStream(
            music
          )
          .pipe(res);

      }


      /* ============================================
         404
      ============================================ */

      res.writeHead(
        404,
        {
          "Content-Type":
            "text/plain"
        }
      );


      res.end(
        "Not Found"
      );

    }
  );


/* =====================================================
   START
===================================================== */

server.listen(
  PORT,
  () => {

    console.log(
      "===================================="
    );

    console.log(
      "DY AI WINGO SERVER"
    );

    console.log(
      "PORT:",
      PORT
    );

    console.log(
      "API:",
      API_URL
    );

    console.log(
      "TOKEN:",
      WINGOBOT_TOKEN
        ? "CONFIGURED"
        : "NOT CONFIGURED"
    );

    console.log(
      "POLL:",
      "EVERY 1 SECOND"
    );

    console.log(
      "ANALYSIS:",
      "5 SECONDS"
    );

    console.log(
      "===================================="
    );

  }
);
