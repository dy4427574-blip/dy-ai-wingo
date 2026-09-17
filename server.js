"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 10000);

// WinGo 1M API
const LIVE_API_URL =
  process.env.LIVE_API_URL ||
  "https://draw.ar-lottery01.com/WinGo/WinGo_1M.json";

const HISTORY_API_URL =
  process.env.HISTORY_API_URL ||
  "https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json";

let state = {
  live: null,
  history: [],
  currentPeriod: null,
  nextPeriod: null,
  lastPoll: 0,
  lastError: null,

  analysis: {
    active: false,
    remaining: 0,
    targetPeriod: null,
    prediction: "WAITING",
    message: "Waiting for new period..."
  }
};

let lastSeenNext = null;
let analysisTimer = null;
let pollBusy = false;

/* =========================
   HELPERS
========================= */

function noStore(res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
}

function json(res, data, status = 200) {
  noStore(res);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(data));
}

function cleanPeriod(v) {
  if (v === undefined || v === null) return null;
  return String(v);
}

function normalizeNumber(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 9 ? n : null;
}

function toSize(n) {
  if (n === null) return null;
  return n <= 4 ? "SMALL" : "BIG";
}

/* =========================
   FETCH JSON
========================= */

async function fetchJSON(url) {
  const separator = url.includes("?") ? "&" : "?";

  const response = await fetch(
    url + separator + "_=" + Date.now(),
    {
      method: "GET",
      cache: "no-store",
      headers: {
        "Accept": "application/json",
        "Cache-Control": "no-cache"
      }
    }
  );

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

/* =========================
   NORMALIZE HISTORY
========================= */

function extractHistory(payload) {
  const possible =
    payload?.data?.list ||
    payload?.data?.records ||
    payload?.data ||
    payload?.list ||
    payload?.history ||
    [];

  if (!Array.isArray(possible)) return [];

  return possible
    .map(row => {
      const period =
        row.issueNumber ??
        row.issue ??
        row.period ??
        row.periodId ??
        row.issue;

      const number =
        normalizeNumber(
          row.number ??
          row.num ??
          row.result ??
          row.resultNumber
        );

      if (!period || number === null) return null;

      return {
        issueNumber: String(period),
        number,
        size: toSize(number)
      };
    })
    .filter(Boolean);
}

/* =========================
   LIVE DATA
========================= */

async function updateSource() {
  if (pollBusy) return;

  pollBusy = true;

  try {
    const [live, historyPayload] = await Promise.all([
      fetchJSON(LIVE_API_URL),
      fetchJSON(HISTORY_API_URL)
    ]);

    const current =
      live?.current?.issueNumber ??
      live?.current?.period ??
      live?.issueNumber ??
      live?.period ??
      null;

    const next =
      live?.next?.issueNumber ??
      live?.next?.period ??
      null;

    const history = extractHistory(historyPayload);

    state.live = live;
    state.history = history.slice(0, 30);
    state.currentPeriod = cleanPeriod(current);
    state.nextPeriod = cleanPeriod(next);
    state.lastPoll = Date.now();
    state.lastError = null;

    /*
      IMPORTANT:
      Only start a new analysis when API itself
      reports a genuinely new next period.
    */

    if (
      state.nextPeriod &&
      state.nextPeriod !== lastSeenNext
    ) {
      lastSeenNext = state.nextPeriod;

      startFiveSecondAnalysis(
        state.nextPeriod,
        state.history
      );
    }

  } catch (err) {
    state.lastError = err.message;
  } finally {
    pollBusy = false;
  }
}

/* =========================
   ANALYSIS ENGINE
========================= */

function getBigSmall(history) {
  return history
    .map(x => x.size)
    .filter(x => x === "BIG" || x === "SMALL");
}

function scorePrediction(history) {
  if (!Array.isArray(history) || history.length < 8) {
    return "NO CLEAR SIGNAL";
  }

  const rows = history.slice(0, 20);

  let bigScore = 0;
  let smallScore = 0;

  const sizes = getBigSmall(rows);

  if (sizes.length < 8) {
    return "NO CLEAR SIGNAL";
  }

  /* -------------------------
     Recent weighted structure
  ------------------------- */

  sizes.slice(0, 10).forEach((x, i) => {
    const weight = 10 - i;

    if (x === "BIG") bigScore += weight;
    else smallScore += weight;
  });

  /* -------------------------
     Current streak
  ------------------------- */

  let streak = 1;

  for (let i = 1; i < sizes.length; i++) {
    if (sizes[i] === sizes[0]) streak++;
    else break;
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

  /* -------------------------
     Alternation / chop
  ------------------------- */

  let alternations = 0;

  for (let i = 0; i < Math.min(9, sizes.length - 1); i++) {
    if (sizes[i] !== sizes[i + 1]) {
      alternations++;
    }
  }

  if (alternations >= 7) {
    // Strong chop = avoid forced signal
    return "NO CLEAR SIGNAL";
  }

  /* -------------------------
     Last 3 pattern
  ------------------------- */

  const p3 = sizes.slice(0, 3).join("");

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

  /* -------------------------
     Last 5 pattern
  ------------------------- */

  const p5 = sizes.slice(0, 5).join("");

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

  /* -------------------------
     Digit structure
  ------------------------- */

  const digits = rows
    .map(x => x.number)
    .filter(n => Number.isInteger(n));

  const recentDigits = digits.slice(0, 10);

  let boundary = 0;

  recentDigits.forEach(n => {
    if (n === 0 || n === 5) boundary++;
  });

  if (boundary >= 3) {
    // Boundary digits = lower signal confidence
    bigScore -= 1;
    smallScore -= 1;
  }

  /* -------------------------
     Short vs long agreement
  ------------------------- */

  const short = sizes.slice(0, 5);

  const shortBig = short.filter(x => x === "BIG").length;
  const shortSmall = short.filter(x => x === "SMALL").length;

  const long = sizes.slice(0, 15);

  const longBig = long.filter(x => x === "BIG").length;
  const longSmall = long.filter(x => x === "SMALL").length;

  if (shortBig > shortSmall && longBig > longSmall) {
    bigScore += 3;
  }

  if (shortSmall > shortBig && longSmall > longBig) {
    smallScore += 3;
  }

  /* -------------------------
     Final decision
  ------------------------- */

  const difference = Math.abs(bigScore - smallScore);

  if (difference < 4) {
    return "NO CLEAR SIGNAL";
  }

  return bigScore > smallScore ? "BIG" : "SMALL";
}

/*
  User wanted opposite-output behavior:
  Engine BIG -> displayed SMALL
  Engine SMALL -> displayed BIG
*/

function invertPrediction(enginePrediction) {
  if (enginePrediction === "BIG") return "SMALL";
  if (enginePrediction === "SMALL") return "BIG";
  return "NO CLEAR SIGNAL";
}

/* =========================
   5 SECOND ANALYSIS
========================= */

function startFiveSecondAnalysis(period, history) {
  if (analysisTimer) {
    clearInterval(analysisTimer);
    analysisTimer = null;
  }

  state.analysis = {
    active: true,
    remaining: 5,
    targetPeriod: period,
    prediction: "ANALYZING",
    message: "ANALYZING PATTERN..."
  };

  const messages = {
    5: "ANALYZING PATTERN...",
    4: "CHECKING RECENT RESULTS...",
    3: "COMPARING SEQUENCES...",
    2: "VALIDATING SIGNAL...",
    1: "FINALIZING PREDICTION..."
  };

  let remaining = 5;

  analysisTimer = setInterval(() => {
    remaining--;

    if (remaining > 0) {
      state.analysis.remaining = remaining;
      state.analysis.message = messages[remaining];
      return;
    }

    clearInterval(analysisTimer);
    analysisTimer = null;

    const engine = scorePrediction(history);
    const finalPrediction = invertPrediction(engine);

    state.analysis = {
      active: false,
      remaining: 0,
      targetPeriod: period,
      prediction: finalPrediction,
      message: "PREDICTION READY"
    };

  }, 1000);
}

/* =========================
   BACKGROUND POLLING
========================= */

updateSource();

setInterval(() => {
  updateSource();
}, 1000);

/* =========================
   HTTP SERVER
========================= */

const server = http.createServer(async (req, res) => {

  const url = new URL(
    req.url,
    `http://${req.headers.host || "localhost"}`
  );

  /* -------------------------
     API
  ------------------------- */

  if (url.pathname === "/api/state") {

    return json(res, {
      success: true,

      currentPeriod: state.currentPeriod,
      nextPeriod: state.nextPeriod,

      history: state.history.slice(0, 20),

      analysis: state.analysis,

      lastPoll: state.lastPoll,

      sourceStatus: state.lastError
        ? "ERROR"
        : Date.now() - state.lastPoll < 5000
          ? "LIVE"
          : "DELAYED",

      error: state.lastError
    });
  }

  if (url.pathname === "/api/history") {
    return json(res, {
      success: true,
      history: state.history.slice(0, 30)
    });
  }

  if (url.pathname === "/api/health") {
    return json(res, {
      ok: true,
      source: "WinGo 1M",
      lastPoll: state.lastPoll,
      sourceStatus:
        Date.now() - state.lastPoll < 5000
          ? "LIVE"
          : "DELAYED"
    });
  }

  /* -------------------------
     PAGES
  ------------------------- */

  let file = null;

  if (
    url.pathname === "/" ||
    url.pathname === "/prediction"
  ) {
    file = "prediction.html";
  }

  if (url.pathname === "/admin") {
    file = "admin.html";
  }

  if (file) {
    const filePath = path.join(__dirname, file);

    if (!fs.existsSync(filePath)) {
      return json(res, {
        success: false,
        error: "File not found"
      }, 404);
    }

    noStore(res);

    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8"
    });

    return res.end(
      fs.readFileSync(filePath)
    );
  }

  res.writeHead(404);
  res.end("Not Found");
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
