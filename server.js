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
  if (!row) return null;

  const number = Number(
    row.number ??
    row.num ??
    row.result ??
    row.resultNumber
  );

  if (
    !Number.isInteger(number) ||
    number < 0 ||
    number > 9
  ) {
    return null;
  }

  return {
    issueNumber:
      row.issueNumber ??
      row.period ??
      row.periodId ??
      row.issue ??
      null,

    number,

    size:
      number <= 4
        ? "SMALL"
        : "BIG",

    colour:
      row.colour ??
      row.color ??
      null
  };
}

function periodValue(value) {
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

  if (
    !Array.isArray(history) ||
    history.length < 10
  ) {
    return "NO CLEAR SIGNAL";
  }

  const rows =
    history
      .slice(0, 20)
      .filter(row =>
        Number.isInteger(
          Number(row.number)
        )
      );

  if (rows.length < 10) {
    return "NO CLEAR SIGNAL";
  }

  const seq =
    rows.map(row =>
      Number(row.number) <= 4
        ? 0
        : 1
    );

  const nums =
    rows.map(row =>
      Number(row.number)
    );

  let big = 0;
  let small = 0;

  /* =================================================
     1. RECENCY
  ================================================= */

  for (
    let i = 0;
    i < seq.length;
    i++
  ) {

    const weight =
      21 - i;

    if (seq[i] === 1) {
      big += weight;
    } else {
      small += weight;
    }
  }

  /* =================================================
     2. TRANSITION STRUCTURE
  ================================================= */

  let BB = 0;
  let BS = 0;
  let SB = 0;
  let SS = 0;

  for (
    let i = 0;
    i < seq.length - 1;
    i++
  ) {

    if (
      seq[i] === 1 &&
      seq[i + 1] === 1
    ) BB++;

    if (
      seq[i] === 1 &&
      seq[i + 1] === 0
    ) BS++;

    if (
      seq[i] === 0 &&
      seq[i + 1] === 1
    ) SB++;

    if (
      seq[i] === 0 &&
      seq[i + 1] === 0
    ) SS++;
  }

  const fromBig =
    BB + BS;

  const fromSmall =
    SB + SS;

  if (fromBig > 0) {

    const p =
      BB / fromBig;

    if (p >= 0.65) {
      big += 3;
    }

    if (p <= 0.35) {
      small += 3;
    }
  }

  if (fromSmall > 0) {

    const p =
      SB / fromSmall;

    if (p >= 0.65) {
      big += 3;
    }

    if (p <= 0.35) {
      small += 3;
    }
  }

  /* =================================================
     3. CURRENT STREAK
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

    if (seq[0] === 1) {
      big += 2;
    } else {
      small += 2;
    }
  }

  /* =================================================
     4. CHOP / ALTERNATION
  ================================================= */

  let switches = 0;

  for (let i = 0; i < 9; i++) {

    if (
      seq[i] !== seq[i + 1]
    ) {
      switches++;
    }
  }

  if (switches >= 7) {

    if (seq[0] === 1) {
      small += 4;
    } else {
      big += 4;
    }

  } else if (switches <= 2) {

    if (seq[0] === 1) {
      big += 4;
    } else {
      small += 4;
    }
  }

  /* =================================================
     5. LAST 3
  ================================================= */

  const p3 =
    seq
      .slice(0, 3)
      .join("");

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
     6. LAST 5
  ================================================= */

  const p5 =
    seq
      .slice(0, 5)
      .join("");

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
     7. REPEATED BLOCK
  ================================================= */

  const p10 =
    seq
      .slice(0, 10)
      .join("");

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
     8. SHORT VS LONG
  ================================================= */

  const short =
    seq.slice(0, 5);

  const long =
    seq.slice(0, 15);

  const shortBig =
    short.filter(
      x => x === 1
    ).length;

  const shortSmall =
    short.length - shortBig;

  const longBig =
    long.filter(
      x => x === 1
    ).length;

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
     9. DIGIT STRUCTURE
  ================================================= */

  let low = 0;
  let high = 0;
  let zero = 0;
  let five = 0;

  for (const n of nums) {

    if (n <= 4) {
      low++;
    } else {
      high++;
    }

    if (n === 0) {
      zero++;
    }

    if (n === 5) {
      five++;
    }
  }

  if (
    zero >= 2 &&
    high >= low
  ) {
    big += 2;
  }

  if (
    five >= 2 &&
    low >= high
  ) {
    small += 2;
  }

  /* =================================================
     10. REVERSAL STRUCTURE
  ================================================= */

  if (seq.length >= 6) {

    const a = seq[0];
    const b = seq[1];
    const c = seq[2];
    const d = seq[3];

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
  }

  /* =================================================
     FINAL SIGNAL
  ================================================= */

  const difference =
    Math.abs(
      big - small
    );

  if (difference < 4) {
    return "NO CLEAR SIGNAL";
  }

  const engine =
    big > small
      ? "BIG"
      : "SMALL";

  /*
     USER REQUEST:
     DISPLAY OPPOSITE
  */

  return engine === "BIG"
    ? "SMALL"
    : "BIG";
}

/* =====================================================
   FETCH WINGOBOT
===================================================== */

async function fetchLiveData() {

  if (!WINGOBOT_TOKEN) {
    throw new Error(
      "WINGOBOT_TOKEN is not configured in Render."
    );
  }

  const response =
    await fetch(
      API_URL +
      "?_=" +
      Date.now(),
      {
        method: "GET",

        headers: {
          Authorization:
            `Bearer ${WINGOBOT_TOKEN}`,

          Accept:
            "application/json",

          "Cache-Control":
            "no-cache",

          Pragma:
            "no-cache",

          "User-Agent":
            "DY-AI-Wingo/4.0"
        },

        cache: "no-store"
      }
    );

  const text =
    await response.text();

  let data;

  try {

    data =
      JSON.parse(text);

  } catch {

    throw new Error(
      "WingoBot returned invalid JSON."
    );
  }

  if (!response.ok) {

    throw new Error(
      data?.error ||
      data?.message ||
      `HTTP ${response.status}`
    );
  }

  if (data?.success === false) {

    throw new Error(
      data?.error ||
      "WingoBot API error."
    );
  }

  const history =
    Array.isArray(data.history)
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
    current,
    history
  };
}

/* =====================================================
   HISTORY ENDPOINT
===================================================== */

app.get(
  "/api/history",
  async (req, res) => {

    try {

      const result =
        await fetchLiveData();

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
          result.history
            .slice(0, 20),

        serverTime:
          Date.now()

      });

    } catch (error) {

      console.error(
        "WINGOBOT ERROR:",
        error.message
      );

      res.status(502).json({

        success: false,

        error:
          error.message

      });
    }
  }
);

/* =====================================================
   HEALTH
===================================================== */

app.get(
  "/api/health",
  (req, res) => {

    res.json({

      success: true,

      apiConfigured:
        Boolean(WINGOBOT_TOKEN),

      api:
        API_URL,

      serverTime:
        new Date().toISOString()

    });
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

    if (
      key !== ADMIN_KEY
    ) {

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

      error:
        "Route not found."

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
      " DY AI WINGO 1 MINUTE"
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
