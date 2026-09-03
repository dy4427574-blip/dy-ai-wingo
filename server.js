<!DOCTYPE html>
<html lang="en">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1.0,user-scalable=no"
>

<title>DY AI WINGO</title>

<style>

*{
  box-sizing:border-box;
  margin:0;
  padding:0;
  font-family:Arial,Helvetica,sans-serif;
}

body{
  background:#060a13;
  color:#fff;
}

.container{
  max-width:560px;
  margin:auto;
  padding:10px;
}

.header,
.card,
.section,
.status{
  background:
    linear-gradient(
      145deg,
      #111b31,
      #0b1324
    );

  border:
    1px solid #293a5b;

  border-radius:19px;

  box-shadow:
    0 8px 25px #0007;
}

.header{
  padding:16px;
  text-align:center;
  margin-bottom:10px;
}

.logo{
  font-size:26px;
  font-weight:1000;
}

.logo span{
  color:#00e5ff;
}

.sub{
  color:#94a3b8;
  font-size:10px;
  margin-top:5px;
}

.topbar{
  display:flex;
  gap:8px;
  margin-top:13px;
}

.topbar button{
  flex:1;
  border:
    1px solid #293957;
  border-radius:12px;
  padding:11px;
  background:#18243b;
  color:#fff;
  font-weight:900;
}


/* LOGIN */

.login{
  background:#10182a;
  border:
    1px solid #263553;
  border-radius:18px;
  padding:18px;
}

input{
  width:100%;
  padding:13px;
  margin:9px 0;
  border-radius:12px;
  border:
    1px solid #34415d;
  background:#080d18;
  color:#fff;
  outline:none;
}

.loginBtn{
  width:100%;
  padding:13px;
  border:0;
  border-radius:12px;
  background:#00bcd4;
  color:#001018;
  font-weight:900;
}

.main{
  display:none;
}


/* GAME */

.game{
  overflow:hidden;
  border-radius:20px;
  border:
    1px solid #293a5b;
  background:#000;
  margin-bottom:10px;
}

.game iframe{
  width:100%;
  height:460px;
  display:block;
  border:0;
}

.openGame{
  display:block;
  padding:13px;
  text-align:center;
  background:#0d192d;
  color:#00e5ff;
  text-decoration:none;
  font-weight:900;
}


/* STATUS */

.status{
  padding:13px;
  margin-bottom:10px;
}

.statusRow{
  display:flex;
  justify-content:space-between;
  margin-bottom:8px;
}

.statusRow:last-child{
  margin-bottom:0;
}

.label{
  color:#94a3b8;
  font-size:11px;
}

.value{
  font-size:12px;
  font-weight:900;
}

.online{
  color:#22c55e;
}

.offline{
  color:#ef4444;
}


/* PREDICTION */

.predGrid{
  display:grid;
  grid-template-columns:
    1.15fr .85fr;
  gap:9px;
  margin-bottom:10px;
}

.card{
  padding:15px;
}

.title{
  color:#94a3b8;
  font-size:11px;
  font-weight:900;
}

.period{
  margin-top:7px;
  font-size:13px;
  font-weight:900;
  overflow:hidden;
  white-space:nowrap;
  text-overflow:ellipsis;
}

.timer{
  text-align:center;
  color:#00e5ff;
  font-size:38px;
  font-weight:1000;
  margin-top:10px;
}

.pred{
  text-align:center;
  font-size:31px;
  font-weight:1000;
  margin-top:4px;
}

.big{
  color:#22c55e;
}

.small{
  color:#f59e0b;
}

.wait{
  color:#64748b;
}

.conf{
  text-align:center;
  color:#cbd5e1;
  font-size:11px;
  margin-top:6px;
}

.signal{
  text-align:center;
  color:#00e5ff;
  font-size:9px;
  font-weight:900;
  margin-top:8px;
}


/* WIN LOSS */

.winloss{
  display:flex;
  flex-direction:column;
  justify-content:center;
}

.wl{
  display:flex;
  justify-content:space-around;
  margin-top:13px;
  text-align:center;
}

.wlNum{
  font-size:29px;
  font-weight:1000;
}

.win{
  color:#22c55e;
}

.loss{
  color:#ef4444;
}

.wlLabel{
  color:#94a3b8;
  font-size:9px;
}

.rate{
  text-align:center;
  color:#cbd5e1;
  font-size:11px;
  margin-top:10px;
}


/* AI */

.section{
  padding:14px;
  margin-bottom:10px;
}

.head{
  display:flex;
  justify-content:space-between;
  align-items:center;
  margin-bottom:11px;
}

.headTitle{
  font-size:14px;
  font-weight:1000;
}

.badge{
  background:#17243b;
  color:#00e5ff;
  border-radius:8px;
  padding:5px 8px;
  font-size:8px;
  font-weight:900;
}

.aiGrid{
  display:grid;
  grid-template-columns:
    1fr 1fr;
  gap:8px;
}

.metric{
  background:#080e1a;
  border-radius:11px;
  padding:10px;
}

.metricLabel{
  color:#64748b;
  font-size:9px;
}

.metricValue{
  margin-top:5px;
  font-weight:1000;
}


/* HISTORY */

.historyHeader,
.historyRow{
  display:grid;

  grid-template-columns:
    1.7fr
    .65fr
    .75fr
    .55fr;

  gap:5px;

  align-items:center;
}

.historyHeader{
  padding:
    0 7px 7px;

  color:#64748b;
  font-size:8px;
  font-weight:900;
  text-align:center;
}

.historyHeader div:first-child{
  text-align:left;
}

.historyRow{
  background:#080e1a;
  border-radius:11px;
  padding:11px 7px;
  margin-bottom:7px;
  font-size:9px;
}

.issue{
  overflow:hidden;
  white-space:nowrap;
  text-overflow:ellipsis;
  font-weight:800;
}

.number{
  text-align:center;
  color:#fff;
  font-size:12px;
  font-weight:1000;
}

.predText{
  text-align:center;
  font-weight:1000;
}

.winText{
  color:#22c55e;
  text-align:center;
  font-weight:1000;
}

.lossText{
  color:#ef4444;
  text-align:center;
  font-weight:1000;
}

.pending{
  color:#64748b;
  text-align:center;
}

.notice{
  color:#64748b;
  font-size:9px;
  line-height:1.5;
  margin-top:9px;
}

.empty{
  text-align:center;
  padding:20px;
  color:#64748b;
  font-size:11px;
}

.footer{
  text-align:center;
  color:#475569;
  font-size:9px;
  padding:
    10px 0 25px;
}


@media(max-width:380px){

  .predGrid{
    grid-template-columns:1fr;
  }

  .game iframe{
    height:420px;
  }

}

</style>

</head>


<body>

<div class="container">


<!-- HEADER -->

<div class="header">

  <div class="logo">
    DY <span>AI</span> WINGO
  </div>

  <div class="sub">
    30 SECOND STATISTICAL ANALYSIS
  </div>

  <div class="topbar">

    <button id="musicBtn">
      🔇 Music OFF
    </button>

    <button id="refreshBtn">
      🔄 Refresh
    </button>

  </div>

</div>


<!-- LOGIN -->

<div
  id="loginBox"
  class="login"
>

  <b>
    🔐 Access Key
  </b>

  <input
    id="keyInput"
    placeholder="Enter access key"
    autocomplete="off"
  >

  <button
    id="loginBtn"
    class="loginBtn"
  >
    LOGIN
  </button>

  <div
    id="loginMsg"
    class="notice"
  ></div>

</div>


<!-- MAIN -->

<div
  id="main"
  class="main"
>


<!-- GAME -->

<div class="game">

  <iframe
    src="https://www.tojvhr55.com/#/register?invitationCode=761671301584"
    allow="fullscreen"
  ></iframe>

  <a
    class="openGame"
    href="https://www.tojvhr55.com/#/register?invitationCode=761671301584"
    target="_blank"
    rel="noopener"
  >
    🎮 OPEN GAME
  </a>

</div>


<!-- STATUS -->

<div class="status">

  <div class="statusRow">

    <span class="label">
      Connection
    </span>

    <span
      id="connection"
      class="value online"
    >
      CONNECTING
    </span>

  </div>


  <div class="statusRow">

    <span class="label">
      Settled Period
    </span>

    <span
      id="settledIssue"
      class="value"
    >
      -
    </span>

  </div>


  <div class="statusRow">

    <span class="label">
      Next Period
    </span>

    <span
      id="targetIssue"
      class="value"
    >
      -
    </span>

  </div>

</div>


<!-- PREDICTION + WIN LOSS -->

<div class="predGrid">


  <div class="card">

    <div class="title">
      🎯 NEXT PREDICTION
    </div>

    <div
      id="predictionPeriod"
      class="period"
    >
      -
    </div>

    <div
      id="timer"
      class="timer"
    >
      30
    </div>

    <div
      id="prediction"
      class="pred wait"
    >
      WAIT
    </div>

    <div
      id="confidence"
      class="conf"
    >
      Confidence: -
    </div>

    <div
      id="signal"
      class="signal"
    >
      WAITING
    </div>

  </div>


  <div class="card winloss">

    <div class="title">
      📊 WIN / LOSS
    </div>

    <div class="wl">

      <div>

        <div
          id="winCount"
          class="wlNum win"
        >
          0
        </div>

        <div class="wlLabel">
          WIN
        </div>

      </div>


      <div>

        <div
          id="lossCount"
          class="wlNum loss"
        >
          0
        </div>

        <div class="wlLabel">
          LOSS
        </div>

      </div>

    </div>


    <div
      id="winRate"
      class="rate"
    >
      Rate: 0%
    </div>

  </div>

</div>


<!-- AI -->

<div class="section">

  <div class="head">

    <div class="headTitle">
      🧠 AI ANALYSIS
    </div>

    <div
      id="signalBadge"
      class="badge"
    >
      LOW SIGNAL
    </div>

  </div>


  <div class="aiGrid">

    <div class="metric">

      <div class="metricLabel">
        Pattern Score
      </div>

      <div
        id="patternScore"
        class="metricValue"
      >
        -
      </div>

    </div>


    <div class="metric">

      <div class="metricLabel">
        Model Agreement
      </div>

      <div
        id="agreement"
        class="metricValue"
      >
        -
      </div>

    </div>


    <div class="metric">

      <div class="metricLabel">
        Backtest Samples
      </div>

      <div
        id="backtest"
        class="metricValue"
      >
        -
      </div>

    </div>


    <div class="metric">

      <div class="metricLabel">
        Average Accuracy
      </div>

      <div
        id="accuracy"
        class="metricValue"
      >
        -
      </div>

    </div>

  </div>


  <div class="notice">
    Adaptive statistical analysis. Future outcomes are not guaranteed.
  </div>

</div>


<!-- HISTORY -->

<div class="section">

  <div class="head">

    <div class="headTitle">
      🎯 LIVE RESULT + WIN/LOSS
    </div>

    <div class="badge">
      LAST 30
    </div>

  </div>


  <div class="historyHeader">

    <div>
      PERIOD
    </div>

    <div>
      NUMBER
    </div>

    <div>
      PRED
    </div>

    <div>
      W/L
    </div>

  </div>


  <div id="history">

    <div class="empty">
      Loading...
    </div>

  </div>

</div>


<div class="footer">
  DY AI Wingo • Adaptive Statistical Analyzer
</div>


</div>

</div>


<audio
  id="music"
  src="/music.mp3"
  loop
></audio>


<script>

const $ =
  id =>
  document.getElementById(id);


/* =====================================================
   DEVICE
===================================================== */

let deviceId =
  localStorage.getItem(
    "dy_device_id"
  );

if (!deviceId) {

  deviceId =
    window.crypto &&
    crypto.randomUUID
      ? crypto.randomUUID()
      : "dy-" +
        Date.now() +
        "-" +
        Math.random()
          .toString(36)
          .slice(2);

  localStorage.setItem(
    "dy_device_id",
    deviceId
  );
}


/* =====================================================
   LOGIN
===================================================== */

const savedKey =
  localStorage.getItem(
    "dy_access_key"
  );

if (savedKey) {
  $("keyInput").value =
    savedKey;
}

async function login() {

  const key =
    $("keyInput")
      .value
      .trim();

  if (!key) {

    $("loginMsg")
      .textContent =
      "Access key enter karo.";

    return;
  }

  $("loginMsg")
    .textContent =
    "Checking access...";

  try {

    const r =
      await fetch(
        "/api/key/check",
        {
          method:"POST",

          headers:{
            "Content-Type":
              "application/json",

            "x-device-id":
              deviceId
          },

          body:
            JSON.stringify({
              key,
              device_id:
                deviceId
            })
        }
      );

    const d =
      await r.json();

    if (
      !r.ok ||
      !d.ok
    ) {

      $("loginMsg")
        .textContent =
        d.message ||
        "Invalid access key.";

      return;
    }

    localStorage.setItem(
      "dy_access_key",
      key
    );

    $("loginBox")
      .style.display =
      "none";

    $("main")
      .style.display =
      "block";

    start();

  } catch {

    $("loginMsg")
      .textContent =
      "Server connection error.";

  }
}

$("loginBtn")
  .addEventListener(
    "click",
    login
  );

$("keyInput")
  .addEventListener(
    "keydown",
    e => {
      if (e.key === "Enter") {
        login();
      }
    }
  );


/* =====================================================
   MUSIC
===================================================== */

const music =
  $("music");

let musicOn =
  false;

$("musicBtn")
  .addEventListener(
    "click",
    async () => {

      try {

        if (musicOn) {

          music.pause();

          musicOn =
            false;

          $("musicBtn")
            .textContent =
            "🔇 Music OFF";

        } else {

          await music.play();

          musicOn =
            true;

          $("musicBtn")
            .textContent =
            "🔊 Music ON";
        }

      } catch {

        $("musicBtn")
          .textContent =
          "▶️ TAP AGAIN";
      }
    }
  );


/* =====================================================
   APP STATE
===================================================== */

let started =
  false;

let lastVersion =
  -1;

let appState =
  null;

let winLoss =
  null;


/* =====================================================
   LOAD STATE
===================================================== */

async function loadState() {

  try {

    const r =
      await fetch(
        "/api/state",
        {
          cache:
            "no-store"
        }
      );

    const d =
      await r.json();

    appState =
      d;


    $("connection")
      .textContent =
      "ONLINE";

    $("connection")
      .className =
      "value online";


    $("settledIssue")
      .textContent =
      d.settledIssue ||
      "-";


    $("targetIssue")
      .textContent =
      d.targetIssue ||
      "-";


    $("predictionPeriod")
      .textContent =
      d.targetIssue ||
      "-";


    if (d.timing) {

      let sec =
        Number(
          d.timing.seconds
        );

      if (
        !Number.isFinite(sec)
      ) {
        sec = 30;
      }

      sec =
        Math.max(
          0,
          Math.min(
            30,
            Math.floor(sec)
          )
        );

      $("timer")
        .textContent =
        String(sec)
          .padStart(
            2,
            "0"
          );
    }


    /*
      Prediction updates only when
      a NEW settled result appears.
    */

    if (
      d.historyVersion !==
      lastVersion
    ) {

      lastVersion =
        d.historyVersion;

      renderAI(
        d.analysis
      );
    }


    renderHistory(
      d.history ||
      []
    );

  } catch {

    $("connection")
      .textContent =
      "OFFLINE";

    $("connection")
      .className =
      "value offline";
  }
}


/* =====================================================
   AI DISPLAY
===================================================== */

function renderAI(a) {

  if (
    !a ||
    !a.prediction
  ) {

    $("prediction")
      .textContent =
      "WAIT";

    $("prediction")
      .className =
      "pred wait";

    $("confidence")
      .textContent =
      "Confidence: 0%";

    $("signal")
      .textContent =
      a?.status ||
      "WAITING";

    return;
  }


  const p =
    a.prediction;


  $("prediction")
    .textContent =
    p;


  $("prediction")
    .className =
    "pred " +
    (
      p === "BIG"
        ? "big"
        : "small"
    );


  $("confidence")
    .textContent =
    `Confidence: ${
      a.confidence ?? 0
    }%`;


  $("signal")
    .textContent =
    a.status ||
    "LOW SIGNAL";


  $("signalBadge")
    .textContent =
    a.status ||
    "LOW SIGNAL";


  $("patternScore")
    .textContent =
    a.patternScore ??
    "-";


  $("agreement")
    .textContent =
    a.agreement != null
      ? a.agreement + "%"
      : "-";


  $("backtest")
    .textContent =
    a.backtestSamples ??
    0;


  $("accuracy")
    .textContent =
    a.avgModelAccuracy != null
      ? a.avgModelAccuracy + "%"
      : "N/A";
}


/* =====================================================
   WIN LOSS
===================================================== */

async function loadWinLoss() {

  try {

    const r =
      await fetch(
        "/api/history",
        {
          cache:
            "no-store"
        }
      );

    const d =
      await r.json();

    winLoss =
      d;


    const s =
      d.stats ||
      {};


    $("winCount")
      .textContent =
      s.win ??
      0;


    $("lossCount")
      .textContent =
      s.loss ??
      0;


    $("winRate")
      .textContent =
      `Rate: ${
        s.rate ?? 0
      }%`;


    if (appState) {

      renderHistory(
        appState.history ||
        []
      );
    }

  } catch {}
}


/* =====================================================
   HISTORY
===================================================== */

function renderHistory(rows) {

  const box =
    $("history");


  if (!rows.length) {

    box.innerHTML =
      `
      <div class="empty">
        No live results
      </div>
      `;

    return;
  }


  /*
    EXACTLY LAST 30.
  */

  const latest =
    rows.slice(
      0,
      30
    );


  /*
    Exact period -> prediction
    mapping.
  */

  const map =
    new Map();


  (
    winLoss?.rows ||
    []
  ).forEach(
    x => {

      map.set(
        String(
          x.target_issue
        ),
        x
      );

    }
  );


  box.innerHTML =
    latest
      .map(
        row => {

          const period =
            String(
              row.issueNumber
            );

          const number =
            Number(
              row.number
            );


          const record =
            map.get(
              period
            );


          const prediction =
            record?.prediction;


          const result =
            record?.result;


          let pred =
            `<span class="pending">-</span>`;


          if (
            prediction
          ) {

            pred =
              `
              <span class="${
                prediction === "BIG"
                  ? "big"
                  : "small"
              }">
                ${escapeHTML(
                  prediction
                )}
              </span>
              `;
          }


          let wl =
            `<span class="pending">-</span>`;


          if (
            result ===
            "WIN"
          ) {

            wl =
              `
              <span class="winText">
                WIN
              </span>
              `;

          } else if (
            result ===
            "LOSS"
          ) {

            wl =
              `
              <span class="lossText">
                LOSS
              </span>
              `;
          }


          return `

          <div class="historyRow">

            <div class="issue">
              ${escapeHTML(
                period
              )}
            </div>

            <div class="number">
              ${escapeHTML(
                number
              )}
            </div>

            <div class="predText">
              ${pred}
            </div>

            <div>
              ${wl}
            </div>

          </div>

          `;
        }
      )
      .join("");
}


/* =====================================================
   ESCAPE
===================================================== */

function escapeHTML(v) {

  return String(
    v ?? ""
  )
  .replace(
    /&/g,
    "&amp;"
  )
  .replace(
    /</g,
    "&lt;"
  )
  .replace(
    />/g,
    "&gt;"
  )
  .replace(
    /"/g,
    "&quot;"
  )
  .replace(
    /'/g,
    "&#039;"
  );
}


/* =====================================================
   START
===================================================== */

function start() {

  if (started) {
    return;
  }

  started =
    true;


  loadState();
  loadWinLoss();


  /*
    Smooth live update.
  */

  setInterval(
    loadState,
    1000
  );


  /*
    WIN/LOSS refresh.
  */

  setInterval(
    loadWinLoss,
    3000
  );
}


/* =====================================================
   REFRESH
===================================================== */

$("refreshBtn")
  .addEventListener(
    "click",
    () => {
      loadState();
      loadWinLoss();
    }
  );


/* =====================================================
   AUTO LOGIN
===================================================== */

if (savedKey) {
  login();
}

</script>

</body>
</html>
