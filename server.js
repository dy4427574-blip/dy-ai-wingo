"use strict";

const express = require("express");
const path = require("path");

const app = express();

const PORT = Number(process.env.PORT || 10000);

/*
=====================================================
CONFIG
=====================================================
*/

const LIVE_API_URL =
  String(process.env.LIVE_API_URL || "").trim();

const LIVE_API_TOKEN =
  String(process.env.LIVE_API_TOKEN || "").trim();

const ADMIN_KEY =
  String(process.env.ADMIN_KEY || "").trim();

/*
Optional:
If API needs Authorization header.
Example:
Authorization: Bearer XXXXX
*/

const API_AUTH_TYPE =
  String(
    process.env.API_AUTH_TYPE || "Bearer"
  ).trim();


app.use(express.json());
app.use(express.urlencoded({
  extended: true
}));

app.use(express.static(__dirname));


/*
=====================================================
HELPERS
=====================================================
*/

function toBigIntPeriod(value) {

  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  const s =
    String(value).trim();

  if (!/^\d+$/.test(s)) {
    return null;
  }

  try {
    return BigInt(s);
  } catch {
    return null;
  }
}


function normalizeRow(row) {

  if (!row) {
    return null;
  }

  const number =
    Number(
      row.number ??
      row.num ??
      row.result ??
      row.resultNumber ??
      row.openNumber
    );

  if (
    !Number.isInteger(number) ||
    number < 0 ||
    number > 9
  ) {
    return null;
  }

  const issueNumber =
    row.issueNumber ??
    row.issue ??
    row.period ??
    row.periodId ??
    row.issue ??
    row.id ??
    null;

  return {

    issueNumber,

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


/*
=====================================================
EXTRACT HISTORY
=====================================================
*/

function extractHistory(data) {

  let source = null;

  if (
    Array.isArray(data)
  ) {
    source = data;
  }

  else if (
    Array.isArray(data?.history)
  ) {
    source = data.history;
  }

  else if (
    Array.isArray(data?.data)
  ) {
    source = data.data;
  }

  else if (
    Array.isArray(data?.data?.list)
  ) {
    source = data.data.list;
  }

  else if (
    Array.isArray(data?.data?.records)
  ) {
    source = data.data.records;
  }

  else if (
    Array.isArray(data?.result)
  ) {
    source = data.result;
  }

  else if (
    Array.isArray(data?.records)
  ) {
    source = data.records;
  }

  else {
    source = [];
  }


  return source
    .map(normalizeRow)
    .filter(Boolean)
    .slice(0, 50);
}


/*
=====================================================
CURRENT PERIOD
=====================================================
*/

function extractCurrentPeriod(data) {

  return (

    data?.current?.issueNumber ??

    data?.current?.issue ??

    data?.current?.period ??

    data?.current?.periodId ??

    data?.issueNumber ??

    data?.issue ??

    data?.period ??

    data?.periodId ??

    data?.data?.current?.issueNumber ??

    data?.data?.current?.period ??

    data?.data?.issueNumber ??

    data?.data?.issue ??

    data?.data?.period ??

    data?.data?.periodId ??

    null

  );
}


/*
=====================================================
LIVE API
=====================================================
*/

async function fetchLiveData() {

  if (!LIVE_API_URL) {

    throw new Error(
      "LIVE_API_URL is not configured."
    );
  }


  const headers = {

    "Accept":
      "application/json",

    "Cache-Control":
      "no-cache",

    "Pragma":
      "no-cache",

    "User-Agent":
      "DY-AI-Live/3.0"

  };


  if (LIVE_API_TOKEN) {

    headers[
      "Authorization"
    ] =
      `${API_AUTH_TYPE} ${LIVE_API_TOKEN}`;
  }


  const separator =
    LIVE_API_URL.includes("?")
      ? "&"
      : "?";


  const url =
    LIVE_API_URL +
    separator +
    "_ts=" +
    Date.now();


  const response =
    await fetch(
      url,
      {
        method: "GET",
        headers,
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
      "Live API returned invalid JSON."
    );
  }


  if (!response.ok) {

    throw new Error(
      data?.message ||
      data?.error ||
      `HTTP ${response.status}`
    );
  }


  const history =
    extractHistory(data);


  const current =
    extractCurrentPeriod(data);


  return {

    current,

    history

  };
}


/*
=====================================================
ANALYSIS ENGINE
=====================================================
*/

function analyze(history) {

  if (
    !Array.isArray(history) ||
    history.length < 10
  ) {

    return {
      prediction:
        "NO CLEAR SIGNAL"
    };
  }


  const rows =
    history
      .slice(0, 20);


  const seq =
    rows.map(
      row =>
        row.size === "BIG"
          ? 1
          : 0
    );


  const numbers =
    rows.map(
      row =>
        row.number
    );


  let big = 0;

  let small = 0;


  /*
  -----------------------------------------------
  RECENCY
  -----------------------------------------------
  */

  for (
    let i = 0;
    i < seq.length;
    i++
  ) {

    const weight =
      21 - i;


    if (seq[i] === 1) {
      big += weight;
    }

    else {
      small += weight;
    }
  }


  /*
  -----------------------------------------------
  TRANSITIONS
  -----------------------------------------------
  */

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

    else if (p <= 0.35) {
      small += 3;
    }
  }


  if (fromSmall > 0) {

    const p =
      SB / fromSmall;


    if (p >= 0.65) {
      big += 3;
    }

    else if (p <= 0.35) {
      small += 3;
    }
  }


  /*
  -----------------------------------------------
  STREAK
  -----------------------------------------------
  */

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
        streak >= 6
          ? 6
          : 4;

    }

    else {

      big +=
        streak >= 6
          ? 6
          : 4;
    }

  }

  else if (streak === 3) {

    if (seq[0] === 1) {
      big += 2;
    }

    else {
      small += 2;
    }
  }


  /*
  -----------------------------------------------
  ALTERNATION
  -----------------------------------------------
  */

  let switches = 0;


  for (
    let i = 0;
    i < 9;
    i++
  ) {

    if (
      seq[i] !== seq[i + 1]
    ) {

      switches++;
    }
  }


  if (switches >= 7) {

    if (seq[0] === 1) {
      small += 4;
    }

    else {
      big += 4;
    }

  }

  else if (switches <= 2) {

    if (seq[0] === 1) {
      big += 4;
    }

    else {
      small += 4;
    }
  }


  /*
  -----------------------------------------------
  PATTERN 3
  -----------------------------------------------
  */

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


  /*
  -----------------------------------------------
  PATTERN 5
  -----------------------------------------------
  */

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


  /*
  -----------------------------------------------
  SHORT VS LONG
  -----------------------------------------------
  */

  const short =
    seq.slice(0, 5);


  const long =
    seq.slice(0, 15);


  const shortBig =
    short.filter(
      x => x === 1
    ).length;


  const shortSmall =
    short.length -
    shortBig;


  const longBig =
    long.filter(
      x => x === 1
    ).length;


  const longSmall =
    long.length -
    longBig;


  if (
    shortBig > shortSmall &&
    longBig > longSmall
  ) {

    big += 4;

  }

  else if (
    shortSmall > shortBig &&
    longSmall > longBig
  ) {

    small += 4;
  }


  /*
  -----------------------------------------------
  DIGIT STRUCTURE
  -----------------------------------------------
  */

  let low = 0;
  let high = 0;

  let zero = 0;
  let five = 0;


  for (
    const n of numbers
  ) {

    if (n <= 4) {
      low++;
    }

    else {
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


  /*
  -----------------------------------------------
  FINAL SIGNAL
  -----------------------------------------------
  */

  const difference =
    Math.abs(
      big - small
    );


  if (
    difference < 4
  ) {

    return {
      prediction:
        "NO CLEAR SIGNAL"
    };
  }


  const engine =
    big > small
      ? "BIG"
      : "SMALL";


  /*
  IMPORTANT:
  Existing opposite-prediction requirement.
  */

  const prediction =
    engine === "BIG"
      ? "SMALL"
      : "BIG";


  return {
    prediction
  };
}


/*
=====================================================
HEALTH
=====================================================
*/

app.get(
  "/api/health",
  (req, res) => {

    res.json({

      success: true,

      liveApiConfigured:
        Boolean(LIVE_API_URL),

      tokenConfigured:
        Boolean(LIVE_API_TOKEN),

      time:
        new Date().toISOString()

    });
  }
);


/*
=====================================================
LIVE DATA ENDPOINT
=====================================================
*/

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

    }

    catch (error) {

      console.error(
        "LIVE API ERROR:",
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


/*
=====================================================
ADMIN CHECK
=====================================================
*/

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


/*
=====================================================
PAGES
=====================================================
*/

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


/*
=====================================================
404
=====================================================
*/

app.use(
  (req, res) => {

    res.status(404).json({

      success: false,

      error:
        "Route not found."

    });
  }
);


/*
=====================================================
START
=====================================================
*/

app.listen(
  PORT,
  () => {

    console.log(
      "===================================="
    );

    console.log(
      " DY AI WINGO LIVE v3"
    );

    console.log(
      "===================================="
    );

    console.log(
      "PORT:",
      PORT
    );

    console.log(
      "LIVE API:",
      LIVE_API_URL
        ? "CONFIGURED"
        : "NOT CONFIGURED"
    );

    console.log(
      "TOKEN:",
      LIVE_API_TOKEN
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
