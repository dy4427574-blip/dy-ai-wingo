"use strict";

const express = require("express");
const path = require("path");

const app = express();

const PORT = Number(process.env.PORT || 10000);

const WINGOBOT_TOKEN =
  String(process.env.WINGOBOT_TOKEN || "").trim();

const ADMIN_KEY =
  String(process.env.ADMIN_KEY || "").trim();

const API_URL =
  "https://api.wingobot.com/v2/1-min-game-history";

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

/* =====================================================
   HELPERS
===================================================== */

function normalizeRow(row) {
  const number = Number(row?.number);

  if (
    !Number.isInteger(number) ||
    number < 0 ||
    number > 9
  ) {
    return null;
  }

  return {
    issueNumber:
      row?.issueNumber ??
      row?.period ??
      row?.periodId ??
      null,

    number,

    colour:
      row?.colour ?? null,

    premium:
      row?.premium ?? null,

    sum:
      row?.sum ?? null,

    size:
      number <= 4
        ? "SMALL"
        : "BIG"
  };
}

function periodNumber(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  const s = String(value).trim();

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
   ADVANCED ANALYSIS
===================================================== */

function analyze(history) {

  if (!Array.isArray(history)) {
    return "NO CLEAR SIGNAL";
  }

  const rows =
    history
      .map(normalizeRow)
      .filter(Boolean)
      .slice(0, 20);

  if (rows.length < 10) {
    return "NO CLEAR SIGNAL";
  }

  const seq =
    rows.map(
      r => r.size === "BIG" ? 1 : 0
    );

  const nums =
    rows.map(r => r.number);

  let big = 0;
  let small = 0;

  /* =================================================
     A. RECENCY WEIGHT
  ================================================= */

  for (let i = 0; i < seq.length; i++) {

    const weight =
      Math.max(
        1,
        21 - i
      );

    if (seq[i] === 1) {
      big += weight;
    } else {
      small += weight;
    }
  }

  /* =================================================
     B. TRANSITION MATRIX
  ================================================= */

  let BB = 0;
  let BS = 0;
  let SB = 0;
  let SS = 0;

  for (let i = 0; i < seq.length - 1; i++) {

    const current = seq[i];
    const next = seq[i + 1];

    if (current === 1 && next === 1) BB++;
    if (current === 1 && next === 0) BS++;
    if (current === 0 && next === 1) SB++;
    if (current === 0 && next === 0) SS++;
  }

  /*
    Since newest is at index 0,
    inspect historical transitions.
  */

  const totalFromBig = BB + BS;
  const totalFromSmall = SB + SS;

  if (totalFromBig > 0) {

    const pBigAfterBig =
      BB / totalFromBig;

    if (pBigAfterBig > 0.65) {
      big += 3;
    } else if (pBigAfterBig < 0.35) {
      small += 3;
    }
  }

  if (totalFromSmall > 0) {

    const pBigAfterSmall =
      SB / totalFromSmall;

    if (pBigAfterSmall > 0.65) {
      big += 3;
    } else if (pBigAfterSmall < 0.35) {
      small += 3;
    }
  }

  /* =================================================
     C. CURRENT STREAK
  ================================================= */

  let streak = 1;

  while (
    streak < seq.length &&
    seq[streak] === seq[0]
  ) {
    streak++;
  }

  if (streak >= 4) {

    if (seq[0] === 1) {
      small +=
        streak >= 6 ? 6 : 4;
    } else {
      big +=
        streak >= 6 ? 6 : 4;
    }

  } else if (streak === 3) {

    /*
      Moderate continuation signal.
    */

    if (seq[0] === 1) {
      big += 2;
    } else {
      small += 2;
    }
  }

  /* =================================================
     D. ALTERNATION
  ================================================= */

  let switches = 0;

  for (let i = 0; i < 9; i++) {

    if (seq[i] !== seq[i + 1]) {
      switches++;
    }
  }

  if (switches >= 7) {

    /*
      Very high chop.
      Apply reversal pressure.
    */

    if (seq[0] === 1) {
      small += 4;
    } else {
      big += 4;
    }

  } else if (switches <= 2) {

    /*
      Low switching = continuation structure.
    */

    if (seq[0] === 1) {
      big += 4;
    } else {
      small += 4;
    }
  }

  /* =================================================
     E. LAST 3
  ================================================= */

  const p3 =
    seq.slice(0, 3).join("");

  const p5 =
    seq.slice(0, 5).join("");

  const p10 =
    seq.slice(0, 10).join("");

  if (p3 === "111") {
    small += 3;
  }

  if (p3 === "000") {
    big += 3;
  }

  if (p3 === "101") {
    small += 2;
  }

  if (p3 === "010") {
    big += 2;
  }

  /* =================================================
     F. LAST 5 STRUCTURE
  ================================================= */

  if (p5 === "10101") {
    small += 3;
  }

  if (p5 === "01010") {
    big += 3;
  }

  if (p5 === "11100") {
    big += 2;
  }

  if (p5 === "00011") {
    small += 2;
  }

  if (p5 === "11000") {
    big += 2;
  }

  if (p5 === "00111") {
    small += 2;
  }

  /* =================================================
     G. REPEATED BLOCK
  ================================================= */

  if (p10.length === 10) {

    const a =
      p10.slice(0, 3);

    const b =
      p10.slice(3, 6);

    const c =
      p10.slice(6, 9);

    if (a === b) {

      if (seq[0] === 1) {
        small += 2;
      } else {
        big += 2;
      }
    }

    if (b === c) {

      if (seq[0] === 1) {
        small += 2;
      } else {
        big += 2;
      }
    }
  }

  /* =================================================
     H. SHORT VS LONG WINDOW
  ================================================= */

  const short =
    seq.slice(0, 5);

  const long =
    seq.slice(0, 15);

  const shortBig =
    short.filter(x => x === 1).length;

  const shortSmall =
    short.length - shortBig;

  const longBig =
    long.filter(x => x === 1).length;

  const longSmall =
    long.length - longBig;

  if (
    shortBig > shortSmall &&
    longBig > longSmall
  ) {

    big += 4;

  } else if (
    shortSmall > shortBig &&
    longSmall > longBig
  ) {

    small += 4;
  }

  /* =================================================
     I. DIGIT STRUCTURE
  ================================================= */

  let low = 0;
  let high = 0;
  let zero = 0;
  let five = 0;

  for (const n of nums) {

    if (n <= 4) low++;
    else high++;

    if (n === 0) zero++;
    if (n === 5) five++;
  }

  /*
    Boundary digits get small
    structural weight only.
  */

  if (zero >= 2) {

    if (high >= low) {
      big += 2;
    }
  }

  if (five >= 2) {

    if (low >= high) {
      small += 2;
    }
  }

  /* =================================================
     J. RECENT REVERSAL
  ================================================= */

  if (seq.length >= 6) {

    const a = seq[0];
    const b = seq[1];
    const c = seq[2];
    const d = seq[3];
    const e = seq[4];
    const f = seq[5];

    if (
      a === 1 &&
      b === 1 &&
      c === 0 &&
      d === 0
    ) {
      big += 2;
    }

    if (
      a === 0 &&
      b === 0 &&
      c === 1 &&
      d === 1
    ) {
      small += 2;
    }

    if (
      a === 1 &&
      b === 0 &&
      c === 1 &&
      d === 0
    ) {
      small += 1;
    }

    if (
      a === 0 &&
      b === 1 &&
      c === 0 &&
      d === 1
    ) {
      big += 1;
    }

    /*
      6-result mirror structure.
    */

    if (
      a === f &&
      b === e &&
      c === d
    ) {

      if (a === 1) {
        small += 2;
      } else {
        big += 2;
      }
    }
  }

  /* =================================================
     K. CONFLICT FILTER
  ================================================= */

  const difference =
    Math.abs(
      big - small
    );

  /*
    Don't force a prediction
    when signals are too close.
  */

  if (difference < 4) {
    return "NO CLEAR SIGNAL";
  }

  /* =================================================
     L. ENGINE RESULT
  ================================================= */

  const engineResult =
    big > small
      ? "BIG"
      : "SMALL";

  /* =================================================
     M. OPPOSITE DISPLAY
  ================================================= */

  return engineResult === "BIG"
    ? "SMALL"
    : "BIG";
}


/* =====================================================
   FETCH WINGOBOT
===================================================== */

async function fetchHistory() {

  if (!WINGOBOT_TOKEN) {

    throw new Error(
      "WINGOBOT_TOKEN is not configured."
    );
  }

  const response =
    await fetch(
      API_URL,
      {
        method: "GET",

        headers: {
          Authorization:
            `Bearer ${WINGOBOT_TOKEN}`,

          Accept:
            "application/json",

          "User-Agent":
            "DY-AI-Wingo-1Min/2.0"
        },

        cache: "no-store"
      }
    );

  const text =
    await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {

    throw new Error(
      "Invalid JSON received from API."
    );
  }

  if (!response.ok) {

    throw new Error(
      data?.error ||
      data?.message ||
      `API HTTP ${response.status}`
    );
  }

  if (data?.success === false) {

    throw new Error(
      data?.error ||
      "WingoBot API error."
    );
  }

  const history =
    Array.isArray(data?.history)
      ? data.history
          .map(normalizeRow)
          .filter(Boolean)
      : [];

  const current =
    data?.current?.issueNumber ??
    data?.current?.period ??
    data?.current?.periodId ??
    null;

  return {
    history,
    current
  };
}


/* =====================================================
   API ENDPOINT
===================================================== */

app.get(
  "/api/history",
  async (req, res) => {

    try {

      const result =
        await fetchHistory();

      res.set(
        "Cache-Control",
        "no-store, no-cache, must-revalidate"
      );

      res.json({
        success: true,

        current: {
          issueNumber:
            result.current
        },

        history:
          result.history.slice(0, 20),

        serverTime:
          new Date().toISOString()
      });

    } catch (error) {

      console.error(
        "API ERROR:",
        error.message
      );

      res.status(502).json({

        success: false,

        error:
          error.message ||
          "Unable to fetch live data."
      });
    }
  }
);


/* =====================================================
   ADMIN
===================================================== */

app.post(
  "/api/admin/check",
  (req, res) => {

    const key =
      String(
        req.body?.key || ""
      ).trim();

    if (!ADMIN_KEY) {

      return res.status(500).json({
        success: false,
        error:
          "ADMIN_KEY is not configured."
      });
    }

    if (key !== ADMIN_KEY) {

      return res.status(401).json({
        success: false,
        error:
          "Invalid admin key."
      });
    }

    res.json({
      success: true
    });
  }
);


/* =====================================================
   PAGES
===================================================== */

app.get(
  "/",
  (req, res) => {

    res.sendFile(
      path.join(
        __dirname,
        "prediction.html"
      )
    );
  }
);

app.get(
  "/prediction",
  (req, res) => {

    res.sendFile(
      path.join(
        __dirname,
        "prediction.html"
      )
    );
  }
);

app.get(
  "/admin",
  (req, res) => {

    res.sendFile(
      path.join(
        __dirname,
        "admin.html"
      )
    );
  }
);


/* =====================================================
   404
===================================================== */

app.use(
  (req, res) => {

    res.status(404).json({
      success: false,
      error: "Route not found."
    });
  }
);


/* =====================================================
   START
===================================================== */

app.listen(
  PORT,
  () => {

    console.log(
      "===================================="
    );

    console.log(
      " DY AI WINGO 1 MINUTE v2"
    );

    console.log(
      "===================================="
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
      "ADMIN:",
      ADMIN_KEY
        ? "CONFIGURED"
        : "NOT CONFIGURED"
    );
  }
);
