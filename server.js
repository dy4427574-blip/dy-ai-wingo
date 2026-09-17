"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 10000);

const API_URL =
  "https://api.wingobot.com/v2/1-min-game-history";

const TOKEN =
  String(process.env.WINGOBOT_TOKEN || "").trim();

const ADMIN_KEY =
  String(process.env.ADMIN_KEY || "dy4427574").trim();

let state = {
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
let fetching = false;


/* =========================
   RESPONSE
========================= */

function noCache(res) {
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate"
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
}

function json(res, data, code = 200) {
  noCache(res);

  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8"
  });

  res.end(JSON.stringify(data));
}

function page(res, file) {
  const filePath = path.join(__dirname, file);

  if (!fs.existsSync(filePath)) {
    return json(
      res,
      {
        success: false,
        error: `${file} not found`
      },
      404
    );
  }

  noCache(res);

  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8"
  });

  res.end(fs.readFileSync(filePath));
}


/* =========================
   BIG / SMALL
========================= */

function getSize(number) {
  const n = Number(number);

  if (!Number.isInteger(n) || n < 0 || n > 9) {
    return null;
  }

  return n <= 4 ? "SMALL" : "BIG";
}


/* =========================
   API HISTORY
========================= */

function normalizeHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .map(row => {
      const period =
        row?.issueNumber ??
        row?.period ??
        row?.issue ??
        null;

      const number = Number(row?.number);

      if (
        period === null ||
        !Number.isInteger(number) ||
        number < 0 ||
        number > 9
      ) {
        return null;
      }

      return {
        issueNumber: String(period),
        number,
        size: getSize(number),
        colour: row.colour ?? null,
        premium: row.premium ?? null,
        sum: row.sum ?? null
      };
    })
    .filter(Boolean);
}


/* =========================
   PERIOD
========================= */

function nextPeriod(period) {
  if (!period) return null;

  const text = String(period);

  if (!/^\d+$/.test(text)) {
    return null;
  }

  try {
    return (BigInt(text) + 1n)
      .toString()
      .padStart(text.length, "0");
  } catch {
    return null;
  }
}


/* =========================
   WINGOBOT REQUEST
========================= */

async function fetchWingo() {
  if (!TOKEN) {
    throw new Error(
      "WINGOBOT_TOKEN missing in Render"
    );
  }

  const url =
    API_URL +
    "?_=" +
    Date.now();

  const response = await fetch(url, {
    method: "GET",
    cache: "no-store",

    headers: {
      "Authorization": `Bearer ${TOKEN}`,
      "Accept": "application/json",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
      "User-Agent": "DY-AI-Wingo/1.0"
    }
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}`
    );
  }

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      "WingoBot returned invalid JSON"
    );
  }

  if (data.success !== true) {
    throw new Error(
      data.error ||
      "WingoBot returned success=false"
    );
  }

  return data;
}


/* =========================
   ANALYSIS
========================= */

function analyze(history) {
  if (
    !Array.isArray(history) ||
    history.length < 10
  ) {
    return "NO CLEAR SIGNAL";
  }

  const rows = history.slice(0, 20);

  const sizes = rows.map(
    x => x.size
  );

  let big = 0;
  let small = 0;


  /* RECENCY */

  sizes.slice(0, 10).forEach(
    (value, index) => {

      const weight = 10 - index;

      if (value === "BIG") {
        big += weight;
      } else {
        small += weight;
      }

    }
  );


  /* STREAK */

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
      big += 4;
      small += 1;
    } else {
      small += 4;
      big += 1;
    }

  }


  /* ALTERNATION */

  let alternate = 0;

  for (
    let i = 0;
    i < Math.min(9, sizes.length - 1);
    i++
  ) {
    if (
      sizes[i] !== sizes[i + 1]
    ) {
      alternate++;
    }
  }

  if (alternate >= 7) {
    return "NO CLEAR SIGNAL";
  }


  /* LAST 3 */

  const p3 =
    sizes.slice(0, 3).join("");

  if (p3 === "BBB") small += 3;
  if (p3 === "SSS") big += 3;
  if (p3 === "BSB") small += 2;
  if (p3 === "SBS") big += 2;


  /* LAST 5 */

  const p5 =
    sizes.slice(0, 5).join("");

  if (p5 === "BSBSB") small += 2;
  if (p5 === "SBSBS") big += 2;


  /* REPEATED BLOCK */

  const a =
    sizes.slice(0, 3).join("");

  const b =
    sizes.slice(3, 6).join("");

  if (a && a === b) {

    if (a === "BBB") {
      small += 2;
    }

    if (a === "SSS") {
      big += 2;
    }
  }


  /* SHORT / LONG */

  const short =
    sizes.slice(0, 5);

  const long =
    sizes.slice(0, 15);

  const shortBig =
    short.filter(x => x === "BIG").length;

  const shortSmall =
    short.filter(x => x === "SMALL").length;

  const longBig =
    long.filter(x => x === "BIG").length;

  const longSmall =
    long.filter(x => x === "SMALL").length;

  if (
    shortBig > shortSmall &&
    longBig > longSmall
  ) {
    big += 3;
  }

  if (
    shortSmall > shortBig &&
    longSmall > longBig
  ) {
    small += 3;
  }


  /* 0 / 5 */

  const boundary =
    rows.filter(
      x =>
        x.number === 0 ||
        x.number === 5
    ).length;

  if (boundary >= 3) {
    big -= 1;
    small -= 1;
  }


  const difference =
    Math.abs(big - small);

  if (difference < 4) {
    return "NO CLEAR SIGNAL";
  }

  return big > small
    ? "BIG"
    : "SMALL";
}


/* =========================
   PREDICTION
========================= */

function prediction(history) {

  const result =
    analyze(history);

  /*
    Opposite layer
  */

  if (result === "BIG") {
    return "SMALL";
  }

  if (result === "SMALL") {
    return "BIG";
  }

  return "NO CLEAR SIGNAL";
}


/* =========================
   5 SECOND ANALYSIS
========================= */

function startAnalysis(
  period,
  history
) {

  if (analysisTimer) {
    clearInterval(analysisTimer);
  }

  let seconds = 5;

  state.analysis = {
    active: true,
    remaining: 5,
    targetPeriod: period,
    prediction: "ANALYZING",
    message: "ANALYZING PATTERN..."
  };


  const messages = {
    4: "CHECKING RECENT RESULTS...",
    3: "COMPARING SEQUENCES...",
    2: "VALIDATING SIGNAL...",
    1: "FINALIZING PREDICTION..."
  };


  analysisTimer =
    setInterval(() => {

      seconds--;

      if (seconds > 0) {

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
        targetPeriod: period,
        prediction:
          prediction(history),
        message:
          "PREDICTION READY"
      };

    }, 1000);
}


/* =========================
   UPDATE API
========================= */

async function update() {

  if (fetching) return;

  fetching = true;

  try {

    const data =
      await fetchWingo();


    const history =
      normalizeHistory(
        data.history
      );


    if (!history.length) {
      throw new Error(
        "History is empty"
      );
    }


    /*
      EXACT API FIELD
    */

    const current =
      data.current?.issueNumber
        ? String(
            data.current.issueNumber
          )
        : history[0].issueNumber;


    const next =
      nextPeriod(current);


    state.currentPeriod =
      current;

    state.predictionPeriod =
      next;

    state.history =
      history.slice(0, 30);

    state.stats =
      data.stats || null;

    state.lastUpdate =
      Date.now();

    state.lastError =
      null;

    state.sourceStatus =
      "LIVE";


    /*
      NEW PERIOD
    */

    if (
      next &&
      next !== lastPredictionPeriod
    ) {

      lastPredictionPeriod =
        next;

      startAnalysis(
        next,
        state.history
      );
    }


  } catch (error) {

    state.sourceStatus =
      "ERROR";

    state.lastError =
      error.message;

  } finally {

    fetching = false;
  }
}


/* =========================
   EVERY SECOND
========================= */

update();

setInterval(
  update,
  1000
);


/* =========================
   SERVER
========================= */

const server =
  http.createServer(
    (req, res) => {

      const url =
        new URL(
          req.url,
          `http://${req.headers.host || "localhost"}`
        );


      /* STATE */

      if (
        url.pathname ===
        "/api/state"
      ) {

        return json(
          res,
          {
            success:
              state.sourceStatus ===
              "LIVE",

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


      /* HISTORY */

      if (
        url.pathname ===
        "/api/history"
      ) {

        return json(
          res,
          {
            success: true,
            history:
              state.history
          }
        );
      }


      /* HEALTH */

      if (
        url.pathname ===
        "/api/health"
      ) {

        return json(
          res,
          {
            ok: true,

            api:
              API_URL,

            tokenConfigured:
              Boolean(TOKEN),

            sourceStatus:
              state.sourceStatus,

            lastUpdate:
              state.lastUpdate,

            error:
              state.lastError
          }
        );
      }


      /* ADMIN */

      if (
        url.pathname ===
        "/api/admin/check"
      ) {

        const key =
          url.searchParams.get(
            "key"
          ) || "";

        return json(
          res,
          {
            success:
              key === ADMIN_KEY
          }
        );
      }


      /* PREDICTION */

      if (
        url.pathname === "/" ||
        url.pathname ===
        "/prediction"
      ) {

        return page(
          res,
          "prediction.html"
        );
      }


      /* ADMIN PAGE */

      if (
        url.pathname === "/admin"
      ) {

        return page(
          res,
          "admin.html"
        );
      }


      /* MUSIC */

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
          !fs.existsSync(music)
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
          .createReadStream(music)
          .pipe(res);
      }


      res.writeHead(404);

      res.end("Not Found");

    }
  );


/* =========================
   START
========================= */

server.listen(
  PORT,
  () => {

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
      TOKEN
        ? "CONFIGURED"
        : "MISSING"
    );

    console.log(
      "POLL: 1 SECOND"
    );

    console.log(
      "ANALYSIS: 5 SECONDS"
    );

  }
);
