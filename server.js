"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 10000);

/* =====================================================
   API CONFIG
===================================================== */

const API_URL = String(
  process.env.LIVE_API_URL ||
  "https://api.wingobot.com/v2/1-min-game-history"
).trim();

const API_METHOD = String(
  process.env.LIVE_API_METHOD || "GET"
).toUpperCase();

const API_TOKEN = String(
  process.env.WINGOBOT_TOKEN || ""
).trim();

const ADMIN_KEY = String(
  process.env.ADMIN_KEY || "dy4427574"
).trim();


/* =====================================================
   GLOBAL STATE
===================================================== */

let state = {
  history: [],

  currentPeriod: null,
  nextPeriod: null,

  sourceStatus: "CONNECTING",
  lastPoll: 0,
  lastError: null,

  analysis: {
    active: false,
    remaining: 0,
    targetPeriod: null,
    prediction: "WAITING",
    message: "WAITING FOR NEW PERIOD..."
  }
};

let lastDetectedPeriod = null;
let analysisTimer = null;
let pollBusy = false;


/* =====================================================
   HTTP HELPERS
===================================================== */

function noStore(res) {
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate"
  );

  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
}


function sendJSON(res, data, code = 200) {
  noStore(res);

  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8"
  });

  res.end(JSON.stringify(data));
}


function sendFile(res, filename, contentType) {

  const filePath = path.join(__dirname, filename);

  if (!fs.existsSync(filePath)) {

    return sendJSON(
      res,
      {
        success: false,
        error: "File not found: " + filename
      },
      404
    );
  }

  noStore(res);

  res.writeHead(200, {
    "Content-Type": contentType
  });

  res.end(
    fs.readFileSync(filePath)
  );
}


/* =====================================================
   PERIOD PARSER
===================================================== */

function periodOf(row) {

  if (!row || typeof row !== "object") {
    return null;
  }

  const value =
    row.issueNumber ??
    row.issue ??
    row.period ??
    row.periodId ??
    row.issueId ??
    row.id;

  if (
    value === undefined ||
    value === null
  ) {
    return null;
  }

  return String(value);
}


/* =====================================================
   NUMBER PARSER
===================================================== */

function numberOf(row) {

  if (!row || typeof row !== "object") {
    return null;
  }

  const values = [

    row.number,
    row.num,
    row.result,
    row.resultNumber,
    row.openNumber,
    row.winNumber,
    row.lotteryNumber

  ];

  for (const value of values) {

    const number = Number(value);

    if (
      Number.isInteger(number) &&
      number >= 0 &&
      number <= 9
    ) {
      return number;
    }
  }

  return null;
}


/* =====================================================
   BIG / SMALL
===================================================== */

function sizeOf(number) {

  if (number <= 4) {
    return "SMALL";
  }

  return "BIG";
}


/* =====================================================
   FIND HISTORY INSIDE API RESPONSE
===================================================== */

function findRows(value, depth = 0) {

  if (
    depth > 7 ||
    value === null ||
    value === undefined
  ) {
    return [];
  }


  /* ARRAY */

  if (Array.isArray(value)) {

    const direct = value

      .map(row => {

        const period = periodOf(row);
        const number = numberOf(row);

        if (
          period &&
          number !== null
        ) {

          return {
            issueNumber: period,
            number,
            size: sizeOf(number)
          };

        }

        return null;

      })

      .filter(Boolean);


    if (direct.length) {
      return direct;
    }


    for (const item of value) {

      const found =
        findRows(item, depth + 1);

      if (found.length) {
        return found;
      }

    }

    return [];
  }


  /* OBJECT */

  if (typeof value === "object") {

    const preferredKeys = [

      "list",
      "records",
      "history",
      "data",
      "result",
      "rows",
      "items",
      "games",
      "lotteryData"

    ];


    for (const key of preferredKeys) {

      if (value[key] !== undefined) {

        const found =
          findRows(
            value[key],
            depth + 1
          );

        if (found.length) {
          return found;
        }

      }

    }


    for (const key of Object.keys(value)) {

      const found =
        findRows(
          value[key],
          depth + 1
        );

      if (found.length) {
        return found;
      }

    }

  }

  return [];
}


/* =====================================================
   FIND CURRENT / NEXT PERIOD
===================================================== */

function findCurrentPeriod(
  value,
  depth = 0
) {

  if (
    depth > 6 ||
    value === null ||
    value === undefined ||
    typeof value !== "object"
  ) {
    return null;
  }


  if (Array.isArray(value)) {

    for (const item of value) {

      const found =
        findCurrentPeriod(
          item,
          depth + 1
        );

      if (found) {
        return found;
      }

    }

    return null;
  }


  const keys = [

    "currentPeriod",
    "currentIssue",
    "currentIssueNumber",

    "current",

    "nextPeriod",
    "nextIssue",
    "nextIssueNumber",

    "period",
    "issueNumber"

  ];


  for (const key of keys) {

    const valueAtKey =
      value[key];

    if (
      valueAtKey !== undefined &&
      valueAtKey !== null &&
      typeof valueAtKey !== "object"
    ) {

      const stringValue =
        String(valueAtKey);

      if (
        /\d{6,}/.test(stringValue)
      ) {
        return stringValue;
      }

    }

  }


  for (const key of Object.keys(value)) {

    const found =
      findCurrentPeriod(
        value[key],
        depth + 1
      );

    if (found) {
      return found;
    }

  }


  return null;
}


/* =====================================================
   FETCH API
===================================================== */

async function fetchSource() {

  if (!API_URL) {
    throw new Error(
      "LIVE_API_URL is empty"
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


  const headers = {

    "Accept":
      "application/json",

    "Cache-Control":
      "no-cache",

    "Pragma":
      "no-cache",

    "User-Agent":
      "DY-AI-Wingo/1.0"

  };


  /*
     Token stays on SERVER.
     It is never sent to browser HTML.
  */

  if (API_TOKEN) {

    headers.Authorization =
      `Bearer ${API_TOKEN}`;

  }


  const response =
    await fetch(
      requestURL,
      {
        method: API_METHOD,
        headers
      }
    );


  const text =
    await response.text();


  if (!response.ok) {

    throw new Error(
      `HTTP ${response.status}`
    );

  }


  let payload;

  try {

    payload =
      JSON.parse(text);

  } catch {

    throw new Error(
      "API returned non-JSON data"
    );

  }


  return payload;
}


/* =====================================================
   ADVANCED ANALYSIS ENGINE
===================================================== */

function scoreEngine(history) {

  if (
    !Array.isArray(history) ||
    history.length < 8
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
     RECENCY WEIGHT
  -------------------------------- */

  sizes
    .slice(0, 10)
    .forEach(
      (value, index) => {

        const weight =
          10 - index;

        if (value === "BIG") {

          bigScore += weight;

        } else {

          smallScore += weight;

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
      sizes[i] === sizes[0]
    ) {

      streak++;

    } else {

      break;

    }

  }


  if (streak >= 3) {

    if (sizes[0] === "BIG") {

      bigScore += 4;
      smallScore += 1;

    } else {

      smallScore += 4;
      bigScore += 1;

    }

  }


  /* --------------------------------
     ALTERNATION / CHOP
  -------------------------------- */

  let alternations = 0;


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

      alternations++;

    }

  }


  if (alternations >= 7) {

    return "NO CLEAR SIGNAL";

  }


  /* --------------------------------
     LAST 3 PATTERN
  -------------------------------- */

  const pattern3 =
    sizes
      .slice(0, 3)
      .join("");


  if (
    pattern3 === "BBB"
  ) {

    smallScore += 3;

  }


  if (
    pattern3 === "SSS"
  ) {

    bigScore += 3;

  }


  if (
    pattern3 === "BSB"
  ) {

    smallScore += 2;

  }


  if (
    pattern3 === "SBS"
  ) {

    bigScore += 2;

  }


  /* --------------------------------
     LAST 5 PATTERN
  -------------------------------- */

  const pattern5 =
    sizes
      .slice(0, 5)
      .join("");


  if (
    pattern5 === "BSBSB"
  ) {

    smallScore += 2;

  }


  if (
    pattern5 === "SBSBS"
  ) {

    bigScore += 2;

  }


  if (
    pattern5 === "BBBSS"
  ) {

    bigScore += 1;

  }


  if (
    pattern5 === "SSSBB"
  ) {

    smallScore += 1;

  }


  /* --------------------------------
     REPEATED 3-BLOCK
  -------------------------------- */

  const blockA =
    sizes
      .slice(0, 3)
      .join("");


  const blockB =
    sizes
      .slice(3, 6)
      .join("");


  if (
    blockA &&
    blockA === blockB
  ) {

    if (
      blockA === "BBB"
    ) {

      smallScore += 2;

    }


    if (
      blockA === "SSS"
    ) {

      bigScore += 2;

    }

  }


  /* --------------------------------
     SHORT / LONG AGREEMENT
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
     DIGIT STRUCTURE
  -------------------------------- */

  const boundaryCount =
    rows

      .map(
        x => x.number
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
     FINAL SIGNAL
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
   OPPOSITE PREDICTION LAYER
===================================================== */

function finalPrediction(
  history
) {

  const engine =
    scoreEngine(history);


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
  period,
  history
) {

  if (analysisTimer) {

    clearInterval(
      analysisTimer
    );

  }


  let remaining = 5;


  state.analysis = {

    active: true,

    remaining: 5,

    targetPeriod: period,

    prediction: "ANALYZING",

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

        remaining--;


        if (
          remaining > 0
        ) {

          state.analysis.remaining =
            remaining;

          state.analysis.message =
            messages[remaining];

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
            period,

          prediction:
            finalPrediction(
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
   LIVE POLLING
===================================================== */

async function poll() {

  if (pollBusy) {
    return;
  }


  pollBusy = true;


  try {

    const payload =
      await fetchSource();


    const history =
      findRows(payload);


    if (!history.length) {

      throw new Error(
        "No valid result history found"
      );

    }


    state.history =
      history.slice(0, 30);


    const apiPeriod =
      findCurrentPeriod(
        payload
      );


    const latestSettled =
      state.history[0]
        ?.issueNumber ||
      null;


    state.currentPeriod =
      apiPeriod ||
      latestSettled;


    /*
       If API does not expose
       an explicit next period,
       fallback to latest + 1.
    */

    if (
      apiPeriod &&
      latestSettled &&
      apiPeriod !== latestSettled
    ) {

      state.nextPeriod =
        apiPeriod;

    } else if (
      latestSettled &&
      /^\d+$/.test(
        latestSettled
      )
    ) {

      try {

        state.nextPeriod =
          (
            BigInt(
              latestSettled
            ) + 1n
          )
          .toString()
          .padStart(
            latestSettled.length,
            "0"
          );

      } catch {

        state.nextPeriod =
          null;

      }

    } else {

      state.nextPeriod =
        null;

    }


    state.lastPoll =
      Date.now();


    state.lastError =
      null;


    state.sourceStatus =
      "LIVE";


    /*
       NEW PERIOD DETECTED
       => 5 SECOND ANALYSIS
    */

    if (
      state.nextPeriod &&
      state.nextPeriod !==
        lastDetectedPeriod
    ) {

      lastDetectedPeriod =
        state.nextPeriod;


      startAnalysis(
        state.nextPeriod,
        state.history
      );

    }


  } catch (error) {

    state.lastError =
      error.message;


    state.sourceStatus =
      "ERROR";

  } finally {

    pollBusy = false;

  }

}


/* =====================================================
   START POLLING
===================================================== */

poll();


setInterval(
  poll,
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


      /* ==============================
         STATE API
      ============================== */

      if (
        url.pathname ===
        "/api/state"
      ) {

        return sendJSON(
          res,
          {

            success: true,

            currentPeriod:
              state.currentPeriod,

            nextPeriod:
              state.nextPeriod,

            history:
              state.history.slice(
                0,
                20
              ),

            analysis:
              state.analysis,

            sourceStatus:
              state.sourceStatus ===
                "LIVE" &&
              Date.now() -
                state.lastPoll <=
                5000
                ? "LIVE"
                : state.sourceStatus,

            lastPoll:
              state.lastPoll,

            error:
              state.lastError

          }
        );

      }


      /* ==============================
         HISTORY API
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
              state.history.slice(
                0,
                30
              )

          }
        );

      }


      /* ==============================
         HEALTH API
      ============================== */

      if (
        url.pathname ===
        "/api/health"
      ) {

        return sendJSON(
          res,
          {

            ok: true,

            source:
              API_URL,

            method:
              API_METHOD,

            tokenConfigured:
              Boolean(
                API_TOKEN
              ),

            lastPoll:
              state.lastPoll,

            status:
              state.sourceStatus

          }
        );

      }


      /* ==============================
         ADMIN CHECK
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
         PREDICTION PAGE
      ============================== */

      if (
        url.pathname === "/" ||
        url.pathname ===
          "/prediction"
      ) {

        return sendFile(
          res,
          "prediction.html",
          "text/html; charset=utf-8"
        );

      }


      /* ==============================
         ADMIN PAGE
      ============================== */

      if (
        url.pathname === "/admin"
      ) {

        return sendFile(
          res,
          "admin.html",
          "text/html; charset=utf-8"
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

          return sendJSON(
            res,
            {
              success: false
            },
            404
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
         NOT FOUND
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
   SERVER START
===================================================== */

server.listen(
  PORT,
  () => {

    console.log(
      "================================="
    );

    console.log(
      "DY AI WINGO SERVER STARTED"
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
      "METHOD:",
      API_METHOD
    );

    console.log(
      "TOKEN:",
      API_TOKEN
        ? "CONFIGURED"
        : "NOT CONFIGURED"
    );

    console.log(
      "================================="
    );

  }
);
