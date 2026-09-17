"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 10000);

const API_URL =
  "https://api.wingobot.com/v2/1-min-game-history";

const WINGOBOT_TOKEN =
  String(process.env.WINGOBOT_TOKEN || "").trim();

const ADMIN_KEY =
  String(process.env.ADMIN_KEY || "dy4427574").trim();


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
    message: "WAITING FOR NEW PERIOD..."
  }
};

let lastPredictionPeriod = null;
let analysisTimer = null;
let requestRunning = false;


/* =====================================================
   CACHE CONTROL
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
   JSON
===================================================== */

function sendJSON(res, data, status = 200) {

  noCache(res);

  res.writeHead(status, {
    "Content-Type":
      "application/json; charset=utf-8"
  });

  res.end(
    JSON.stringify(data)
  );
}


/* =====================================================
   HTML
===================================================== */

function sendHTML(res, filename) {

  const filePath =
    path.join(__dirname, filename);

  if (!fs.existsSync(filePath)) {

    return sendJSON(
      res,
      {
        success: false,
        error: filename + " not found"
      },
      404
    );
  }

  noCache(res);

  res.writeHead(200, {
    "Content-Type":
      "text/html; charset=utf-8"
  });

  res.end(
    fs.readFileSync(filePath)
  );
}


/* =====================================================
   NUMBER → BIG / SMALL
===================================================== */

function getSize(number) {

  const n = Number(number);

  if (
    !Number.isInteger(n) ||
    n < 0 ||
    n > 9
  ) {
    return null;
  }

  return n <= 4
    ? "SMALL"
    : "BIG";
}


/* =====================================================
   EXACT WINGOBOT HISTORY
===================================================== */

function normalizeHistory(history) {

  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .map(row => {

      if (!row) {
        return null;
      }

      const issueNumber =
        row.issueNumber ??
        row.period ??
        row.issue ??
        null;

      const number =
        Number(row.number);

      if (
        issueNumber === null ||
        !Number.isInteger(number) ||
        number < 0 ||
        number > 9
      ) {
        return null;
      }

      return {

        issueNumber:
          String(issueNumber),

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

    })
    .filter(Boolean);
}


/* =====================================================
   PERIOD NUMBER
===================================================== */

function toBigIntPeriod(value) {

  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  const s =
    String(value);

  if (!/^\d+$/.test(s)) {
    return null;
  }

  try {
    return BigInt(s);
  } catch {
    return null;
  }
}


/* =====================================================
   NEXT PERIOD
===================================================== */

function getNextPeriod(currentPeriod, history) {

  const current =
    toBigIntPeriod(
      currentPeriod
    );

  if (current !== null) {

    const source =
      String(currentPeriod);

    return (
      current + 1n
    )
      .toString()
      .padStart(
        source.length,
        "0"
      );
  }


  if (
    Array.isArray(history) &&
    history.length
  ) {

    const latest =
      String(
        history[0].issueNumber
      );

    const n =
      toBigIntPeriod(
        latest
      );

    if (n !== null) {

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
   WINGOBOT API
===================================================== */

async function getWingoData() {

  if (!WINGOBOT_TOKEN) {

    throw new Error(
      "WINGOBOT_TOKEN is not configured in Render"
    );
  }


  const url =
    API_URL +
    "?_=" +
    Date.now();


  const response =
    await fetch(
      url,
      {
        method: "GET",

        cache: "no-store",

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


  if (!response.ok) {

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
      "Invalid JSON returned by WingoBot"
    );
  }


  if (data.success !== true) {

    throw new Error(
      data.error ||
      "WingoBot success=false"
    );
  }


  return data;
}


/* =====================================================
   ANALYSIS ENGINE
===================================================== */

function analysisEngine(history) {

  if (
    !Array.isArray(history) ||
    history.length < 10
  ) {

    return "NO CLEAR SIGNAL";
  }


  const rows =
    history.slice(0, 20);


  const sizes =
    rows.map(
      row => row.size
    );


  let bigScore = 0;
  let smallScore = 0;


  /* --------------------------------
     RECENCY
  -------------------------------- */

  sizes
    .slice(0, 10)
    .forEach(
      (value, index) => {

        const weight =
          10 - index;

        if (value === "BIG") {

          bigScore +=
            weight;

        } else if (
          value === "SMALL"
        ) {

          smallScore +=
            weight;
        }

      }
    );


  /* --------------------------------
     STREAK
  -------------------------------- */

  let streak = 1;

  for (
    let i = 1;
    i < sizes.length;
    i++
  ) {

    if (
      sizes[i] === sizes[0]
    ) {

      streak++;

    } else {

      break;
    }
  }


  if (streak >= 3) {

    if (
      sizes[0] === "BIG"
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

  let alternating = 0;

  for (
    let i = 0;
    i < Math.min(
      9,
      sizes.length - 1
    );
    i++
  ) {

    if (
      sizes[i] !==
      sizes[i + 1]
    ) {

      alternating++;
    }
  }


  if (
    alternating >= 7
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


  if (p3 === "BBB") {
    smallScore += 3;
  }

  if (p3 === "SSS") {
    bigScore += 3;
  }

  if (p3 === "BSB") {
    smallScore += 2;
  }

  if (p3 === "SBS") {
    bigScore += 2;
  }


  /* --------------------------------
     LAST 5
  -------------------------------- */

  const p5 =
    sizes
      .slice(0, 5)
      .join("");


  if (p5 === "BSBSB") {
    smallScore += 2;
  }

  if (p5 === "SBSBS") {
    bigScore += 2;
  }

  if (p5 === "BBBSS") {
    bigScore += 1;
  }

  if (p5 === "SSSBB") {
    smallScore += 1;
  }


  /* --------------------------------
     REPEATED BLOCK
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
     SHORT / LONG
  -------------------------------- */

  const short =
    sizes.slice(0, 5);

  const long =
    sizes.slice(0, 15);


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
    shortBig > shortSmall &&
    longBig > longSmall
  ) {

    bigScore += 3;
  }


  if (
    shortSmall > shortBig &&
    longSmall > longBig
  ) {

    smallScore += 3;
  }


  /* --------------------------------
     0 / 5 BOUNDARY
  -------------------------------- */

  const boundaryCount =
    rows
      .map(
        row => row.number
      )
      .filter(
        n =>
          n === 0 ||
          n === 5
      )
      .length;


  if (
    boundaryCount >= 3
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

function getPrediction(history) {

  const engine =
    analysisEngine(
      history
    );


  /*
     Opposite-output logic
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

function startFiveSecondAnalysis(
  targetPeriod,
  history
) {

  if (analysisTimer) {

    clearInterval(
      analysisTimer
    );

    analysisTimer = null;
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

          state.analysis.remaining =
            seconds;

          state.analysis.message =
            messages[seconds];

          return;
        }


        clearInterval(
          analysisTimer
        );

        analysisTimer = null;


        state.analysis = {

          active: false,

          remaining: 0,

          targetPeriod:
            targetPeriod,

          prediction:
            getPrediction(
              history
            ),

          message:
            "PREDICTION READY"

        };

      },
      1000
    );
}


/* =====================================================
   UPDATE API
===================================================== */

async function updateAPI() {

  if (requestRunning) {
    return;
  }


  requestRunning = true;


  try {

    const data =
      await getWingoData();


    const history =
      normalizeHistory(
        data.history
      );


    if (!history.length) {

      throw new Error(
        "API returned empty history"
      );
    }


    /*
       EXACT FIELD FROM YOUR API
    */

    const currentPeriod =
      data.current &&
      data.current.issueNumber
        ? String(
            data.current.issueNumber
          )
        : history[0]
            .issueNumber;


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
       NEW PERIOD
       → START 5 SECOND ANALYSIS
    */

    if (
      predictionPeriod &&
      predictionPeriod !==
        lastPredictionPeriod
    ) {

      lastPredictionPeriod =
        predictionPeriod;


      startFiveSecondAnalysis(
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
   EVERY SECOND
===================================================== */

updateAPI();


setInterval(
  updateAPI,
  1000
);


/* =====================================================
   SERVER
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


      /* ==============================
         STATE
      ============================== */

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

            nextPeriod:
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


      /* ==============================
         HISTORY
      ============================== */

      if (
        url.pathname ===
        "/api/history"
      ) {

        return sendJSON(
          res,
          {

            success: true,

            history:
              state.history

          }
        );
      }


      /* ==============================
         HEALTH
      ============================== */

      if (
        url.pathname ===
        "/api/health"
      ) {

        return sendJSON(
          res,
          {

            ok: true,

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


      /* ==============================
         ADMIN
      ============================== */

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


      /* ==============================
         PREDICTION
      ============================== */

      if (
        url.pathname === "/" ||
        url.pathname ===
          "/prediction"
      ) {

        return sendHTML(
          res,
          "prediction.html"
        );
      }


      /* ==============================
         ADMIN PAGE
      ============================== */

      if (
        url.pathname ===
        "/admin"
      ) {

        return sendHTML(
          res,
          "admin.html"
        );
      }


      /* ==============================
         MUSIC
      ============================== */

      if (
        url.pathname ===
        "/music.mp3"
      ) {

        const musicPath =
          path.join(
            __dirname,
            "music.mp3"
          );


        if (
          !fs.existsSync(
            musicPath
          )
        ) {

          res.writeHead(404);

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
            musicPath
          )
          .pipe(res);
      }


      /* ==============================
         404
      ============================== */

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
      "================================"
    );

    console.log(
      "DY AI WINGO STARTED"
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
      "POLL: EVERY 1 SECOND"
    );

    console.log(
      "ANALYSIS: 5 SECONDS"
    );

    console.log(
      "================================"
    );

  }
);
