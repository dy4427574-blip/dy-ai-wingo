<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta name="theme-color" content="#06101c">
<title>DY AI Wingo 30S</title>

<style>
*{
  box-sizing:border-box;
}

html,body{
  margin:0;
  padding:0;
  background:#050b14;
  color:#eef5ff;
  font-family:Arial,sans-serif;
}

body{
  min-height:100vh;
}

.wrap{
  width:min(980px,100%);
  margin:auto;
  padding:10px;
}

.top,
.head,
.predtop{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:10px;
}

.brand{
  font-size:20px;
  font-weight:900;
}

.brand span{
  color:#36c7ff;
}

.pill,
.tag{
  background:#0a1725;
  border:1px solid #1d3853;
  border-radius:9px;
  color:#91a9c0;
  font-size:10px;
  padding:6px 9px;
}

.card{
  background:#081421;
  border:1px solid #1b334b;
  border-radius:17px;
  margin:10px 0;
  overflow:hidden;
  box-shadow:0 10px 30px #0005;
}

.head{
  padding:13px 14px;
  border-bottom:1px solid #183047;
}

.title{
  font-size:12px;
  font-weight:900;
  letter-spacing:.7px;
}

.sub{
  font-size:9px;
  color:#718aa3;
}

.game{
  height:410px;
  background:#02060b;
  position:relative;
}

.game iframe{
  width:100%;
  height:100%;
  border:0;
  display:block;
}

.fallback{
  display:none;
  position:absolute;
  inset:0;
  align-items:center;
  justify-content:center;
  flex-direction:column;
  gap:10px;
  text-align:center;
  color:#8299af;
  padding:20px;
}

.open{
  border:0;
  border-radius:11px;
  padding:12px 18px;
  background:#1683ff;
  color:#fff;
  font-weight:900;
}

.grid{
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:8px;
  padding:11px;
}

.box{
  background:#07121e;
  border:1px solid #19334b;
  border-radius:12px;
  padding:11px;
}

.lab{
  font-size:9px;
  color:#718aa3;
  text-transform:uppercase;
}

.val{
  font-size:13px;
  font-weight:900;
  margin-top:5px;
  word-break:break-all;
}

.timer{
  font-size:24px;
  color:#38c8ff;
}

.pred{
  margin:0 11px 11px;
  padding:15px;
  border:1px solid #23415e;
  border-radius:15px;
  background:linear-gradient(135deg,#091a2a,#07111d);
}

.predname{
  font-size:9px;
  color:#7891aa;
  text-transform:uppercase;
}

.prediction{
  font-size:30px;
  font-weight:1000;
  margin-top:3px;
}

.big{
  color:#ff8585;
}

.small{
  color:#53d8ff;
}

.conf{
  font-size:22px;
  font-weight:1000;
}

.tags{
  display:flex;
  gap:6px;
  flex-wrap:wrap;
  margin-top:8px;
}

.wl{
  display:grid;
  grid-template-columns:repeat(3,1fr);
  gap:8px;
  padding:0 11px 11px;
}

.wbox{
  text-align:center;
  background:#07121e;
  border:1px solid #19334b;
  border-radius:11px;
  padding:9px;
}

.wbox b{
  display:block;
  font-size:18px;
  margin-top:3px;
}

.win{
  color:#56e6a7;
}

.loss{
  color:#ff7777;
}

.analysis{
  display:grid;
  grid-template-columns:repeat(4,1fr);
  gap:8px;
  padding:11px;
}

.ast{
  padding:10px;
  background:#07121e;
  border:1px solid #19334b;
  border-radius:11px;
}

.num{
  font-size:17px;
  font-weight:900;
  margin-top:4px;
}

.table{
  overflow:auto;
  padding:8px 11px 13px;
}

table{
  width:100%;
  border-collapse:collapse;
  min-width:500px;
}

th,
td{
  text-align:left;
  padding:9px;
  border-bottom:1px solid #142a3f;
}

th{
  font-size:9px;
  color:#718aa3;
}

td{
  font-size:11px;
}

.n{
  font-size:15px;
  font-weight:900;
}

.badge{
  display:inline-block;
  border-radius:7px;
  padding:5px 8px;
  font-size:9px;
  font-weight:900;
}

.bgb{
  background:#ff66661c;
  color:#ff8888;
}

.bsm{
  background:#42d5ff1c;
  color:#55dcff;
}

.bwin{
  background:#4de69c1c;
  color:#59e7a8;
}

.bloss{
  background:#ff66661c;
  color:#ff7777;
}

.empty{
  text-align:center;
  color:#6d849b;
  padding:22px;
}

.foot{
  text-align:center;
  color:#4d647b;
  font-size:9px;
  padding:10px;
}

.login{
  position:fixed;
  inset:0;
  z-index:50;
  background:#040a12;
  display:flex;
  align-items:center;
  justify-content:center;
  padding:20px;
}

.loginbox{
  width:min(390px,100%);
  background:#091624;
  border:1px solid #1d3853;
  border-radius:19px;
  padding:23px;
}

.loginbox h1{
  margin:0 0 6px;
}

.loginbox p{
  color:#7d95ab;
  font-size:11px;
}

.loginbox input{
  width:100%;
  padding:13px;
  border-radius:10px;
  border:1px solid #24415d;
  background:#06101b;
  color:#fff;
  outline:0;
}

.loginbox button{
  width:100%;
  margin-top:10px;
  padding:13px;
  border:0;
  border-radius:10px;
  background:#1683ff;
  color:#fff;
  font-weight:900;
}

.err{
  color:#ff7777;
  font-size:11px;
  min-height:16px;
  margin-top:8px;
}

.hide{
  display:none!important;
}

@media(max-width:650px){

  .game{
    height:430px;
  }

  .analysis{
    grid-template-columns:1fr 1fr;
  }

  .brand{
    font-size:18px;
  }

}
</style>
</head>

<body>

<!-- ================= LOGIN ================= -->

<div id="login" class="login">

  <div class="loginbox">

    <h1>
      DY
      <span style="color:#38c7ff">AI</span>
      Wingo
    </h1>

    <p>
      Premium access key enter karo.
    </p>

    <input
      id="key"
      placeholder="Access Key"
      autocomplete="off"
    >

    <button id="loginBtn">
      UNLOCK PREMIUM
    </button>

    <div
      id="err"
      class="err"
    ></div>

  </div>

</div>


<!-- ================= APP ================= -->

<main
  id="app"
  class="wrap hide"
>

  <!-- TOP -->

  <div class="top">

    <div class="brand">
      DY
      <span>AI</span>
      WINGO 30S
    </div>

    <div
      id="conn"
      class="pill"
    >
      CONNECTING...
    </div>

  </div>


  <!-- ================= GAME ================= -->

  <section class="card">

    <div class="head">

      <div class="title">
        LIVE GAME
      </div>

      <div class="sub">
        30 SECOND
      </div>

    </div>

    <div class="game">

      <iframe
        id="game"
        src="https://www.tojvhr55.com/#/register?invitationCode=761671301584"
        allow="fullscreen"
        referrerpolicy="no-referrer"
      ></iframe>

      <div
        id="fallback"
        class="fallback"
      >

        <b>
          GAME WINDOW BLOCKED
        </b>

        <span>
          External game iframe block kar sakta hai.
        </span>

        <button
          class="open"
          onclick="openGame()"
        >
          OPEN GAME
        </button>

      </div>

    </div>

  </section>


  <!-- ================= ROUND CONTROL ================= -->

  <section class="card">

    <div class="head">

      <div class="title">
        ROUND CONTROL
      </div>

      <div
        id="updated"
        class="sub"
      >
        --
      </div>

    </div>


    <div class="grid">

      <div class="box">

        <div class="lab">
          Settled Period
        </div>

        <div
          id="settled"
          class="val"
        >
          --
        </div>

      </div>


      <div class="box">

        <div class="lab">
          Next Period
        </div>

        <div
          id="next"
          class="val"
        >
          --
        </div>

      </div>


      <div class="box">

        <div class="lab">
          Next Prediction
        </div>

        <div
          id="target"
          class="val"
        >
          --
        </div>

      </div>


      <div class="box">

        <div class="lab">
          Countdown
        </div>

        <div
          id="timer"
          class="val timer"
        >
          --
        </div>

      </div>

    </div>


    <!-- PREDICTION -->

    <div class="pred">

      <div class="predtop">

        <div>

          <div class="predname">
            AI Prediction
          </div>

          <div
            id="prediction"
            class="prediction"
          >
            WAIT
          </div>

          <div class="tags">

            <span class="tag">
              NUMBER:
              <b id="prednum">
                --
              </b>
            </span>

            <span
              id="status"
              class="tag"
            >
              INSUFFICIENT DATA
            </span>

          </div>

        </div>


        <div
          style="text-align:right"
        >

          <div class="predname">
            Confidence
          </div>

          <div
            id="confidence"
            class="conf"
          >
            0%
          </div>

        </div>

      </div>

    </div>


    <!-- WIN LOSS -->

    <div class="wl">

      <div class="wbox">

        <div class="lab">
          Wins
        </div>

        <b
          id="wins"
          class="win"
        >
          0
        </b>

      </div>


      <div class="wbox">

        <div class="lab">
          Losses
        </div>

        <b
          id="losses"
          class="loss"
        >
          0
        </b>

      </div>


      <div class="wbox">

        <div class="lab">
          Rate
        </div>

        <b id="rate">
          0%
        </b>

      </div>

    </div>

  </section>


  <!-- ================= AI ANALYSIS ================= -->

  <section class="card">

    <div class="head">

      <div class="title">
        AI ANALYSIS
      </div>

      <div
        id="count"
        class="sub"
      >
        0 DATA
      </div>

    </div>


    <div class="analysis">

      <div class="ast">

        <div class="lab">
          Pattern Score
        </div>

        <div
          id="pattern"
          class="num"
        >
          0
        </div>

      </div>


      <div class="ast">

        <div class="lab">
          Model Agreement
        </div>

        <div
          id="agree"
          class="num"
        >
          0%
        </div>

      </div>


      <div class="ast">

        <div class="lab">
          Backtest Samples
        </div>

        <div
          id="samples"
          class="num"
        >
          0
        </div>

      </div>


      <div class="ast">

        <div class="lab">
          Average Accuracy
        </div>

        <div
          id="accuracy"
          class="num"
        >
          N/A
        </div>

      </div>

    </div>

  </section>


  <!-- ================= LIVE RESULTS ================= -->

  <section class="card">

    <div class="head">

      <div class="title">
        LIVE RESULTS + WIN/LOSS
      </div>

      <div class="sub">
        LAST 30
      </div>

    </div>


    <div class="table">

      <table>

        <thead>

          <tr>

            <th>
              Period
            </th>

            <th>
              Number
            </th>

            <th>
              Pred
            </th>

            <th>
              W/L
            </th>

          </tr>

        </thead>


        <tbody id="rows">

          <tr>

            <td
              colspan="4"
              class="empty"
            >
              Loading...
            </td>

          </tr>

        </tbody>

      </table>

    </div>

  </section>


  <div class="foot">

    DY AI statistical analysis
    • No prediction is guaranteed

  </div>

</main>


<!-- ================= MUSIC ================= -->

<audio
  id="music"
  src="/music.mp3"
  preload="auto"
  loop
></audio>


<script>

/* =========================================================
   CONFIG
   ========================================================= */

const GAME_URL =
  "https://www.tojvhr55.com/#/register?invitationCode=761671301584";


/* =========================================================
   DEVICE ID
   ========================================================= */

let deviceId =
  localStorage.getItem(
    "dy_ai_device_id"
  );

if (!deviceId) {

  deviceId =
    (
      crypto.randomUUID
        ? crypto.randomUUID()
        : "dy-" +
          Date.now() +
          "-" +
          Math.random()
            .toString(36)
            .slice(2)
    );

  localStorage.setItem(
    "dy_ai_device_id",
    deviceId
  );

}


/* =========================================================
   VARIABLES
   ========================================================= */

let timer = 0;

let lastTimerAt = 0;

let lastVersion = -1;


/* =========================================================
   SHORT SELECTOR
   ========================================================= */

const $ =
  id =>
    document.getElementById(id);


/* =========================================================
   ESCAPE HTML
   ========================================================= */

function esc(value) {

  return String(
    value ?? ""
  )
  .replace(
    /[&<>"']/g,
    function(m) {

      return {
        "&":"&amp;",
        "<":"&lt;",
        ">":"&gt;",
        '"':"&quot;",
        "'":"&#039;"

      }[m];

    }
  );

}


/* =========================================================
   OPEN GAME
   ========================================================= */

function openGame() {

  window.open(
    GAME_URL,
    "_blank",
    "noopener,noreferrer"
  );

}


/* =========================================================
   SHOW APP
   ========================================================= */

function showApp() {

  $("login")
    .classList
    .add("hide");

  $("app")
    .classList
    .remove("hide");

}


/* =========================================================
   LOGIN
   ========================================================= */

async function doLogin() {

  const key =
    $("key")
      .value
      .trim();

  if (!key) {

    $("err").textContent =
      "Access key enter karo.";

    return;

  }


  $("loginBtn").disabled =
    true;

  $("loginBtn").textContent =
    "CHECKING...";


  try {

    const response =
      await fetch(
        "/api/key/check",
        {
          method:"POST",

          headers:{
            "Content-Type":
              "application/json"
          },

          body:JSON.stringify({
            key:key,
            device_id:deviceId
          })
        }
      );


    const data =
      await response.json();


    if (!data.ok) {

      throw new Error(
        data.error ||
        "Invalid access key"
      );

    }


    localStorage.setItem(
      "dy_ai_access_key",
      key
    );


    showApp();


    const music =
      $("music");

    music.volume =
      0.35;

    music.play()
      .catch(
        () => {}
      );


    load();


  }
  catch(error) {

    $("err").textContent =
      error.message ||
      "Login failed";

  }
  finally {

    $("loginBtn").disabled =
      false;

    $("loginBtn").textContent =
      "UNLOCK PREMIUM";

  }

}


/* =========================================================
   AUTO LOGIN
   ========================================================= */

async function autoLogin() {

  const key =
    localStorage.getItem(
      "dy_ai_access_key"
    );


  if (!key) {
    return;
  }


  try {

    const response =
      await fetch(
        "/api/key/check",
        {
          method:"POST",

          headers:{
            "Content-Type":
              "application/json"
          },

          body:JSON.stringify({
            key:key,
            device_id:deviceId
          })
        }
      );


    const data =
      await response.json();


    if (data.ok) {

      showApp();

      load();

    }
    else {

      localStorage.removeItem(
        "dy_ai_access_key"
      );

    }

  }
  catch(error) {}

}


/* =========================================================
   CONNECTION
   ========================================================= */

function connection(ok) {

  $("conn").textContent =
    ok
      ? "● LIVE"
      : "● OFFLINE";


  $("conn").style.color =
    ok
      ? "#55e6a5"
      : "#ff7777";

}


/* =========================================================
   RENDER STATE
   ========================================================= */

function render(data) {


  /* ROUND */

  $("settled").textContent =
    data.settledIssue ||
    "--";


  $("next").textContent =
    data.nextIssue ||
    "--";


  $("target").textContent =
    data.targetIssue ||
    "--";


  $("count").textContent =
    (
      data.historyCount ||
      0
    ) +
    " DATA";


  $("updated").textContent =
    data.lastFetchAt
      ? new Date(
          data.lastFetchAt
        ).toLocaleTimeString()
      : "--";


  /* PREDICTION */

  const prediction =
    data.prediction;


  $("prediction").textContent =
    prediction?.prediction ||
    "WAIT";


  $("prediction").className =
    "prediction " +
    (
      prediction?.prediction ===
      "BIG"
        ? "big"
        : prediction?.prediction ===
          "SMALL"
            ? "small"
            : ""
    );


  $("prednum").textContent =
    prediction?.predictedNumber ??
    "--";


  $("confidence").textContent =
    (
      prediction?.confidence ||
      0
    ) +
    "%";


  $("status").textContent =
    prediction?.status ||
    "INSUFFICIENT DATA";


  /* ANALYSIS */

  $("pattern").textContent =
    prediction?.patternScore ??
    0;


  $("agree").textContent =
    (
      prediction?.agreement ??
      0
    ) +
    "%";


  $("samples").textContent =
    prediction?.backtest?.samples ??
    0;


  $("accuracy").textContent =
    prediction?.backtest?.accuracy ==
    null
      ? "N/A"
      : Math.round(
          prediction.backtest.accuracy
        ) +
        "%";


  /* WIN LOSS */

  $("wins").textContent =
    data.winLoss?.wins ??
    0;


  $("losses").textContent =
    data.winLoss?.losses ??
    0;


  $("rate").textContent =
    (
      data.winLoss?.rate ??
      0
    ) +
    "%";


  /* TIMER */

  if (
    typeof data.countdown ===
    "number"
  ) {

    timer =
      Math.max(
        0,
        Math.min(
          30,
          Math.floor(
            data.countdown
          )
        )
      );

    lastTimerAt =
      Date.now();

  }


  /* =======================================================
     LIVE TABLE

     Only exact target_issue mapping is used.
     No wrong period mapping.
     ======================================================= */

  const winRows =
    data.winLoss?.rows ||
    [];


  const predictionMap =
    new Map();


  winRows.forEach(
    item => {

      predictionMap.set(
        String(
          item.target_issue
        ),
        item
      );

    }
  );


  const liveRows =
    (
      data.history ||
      []
    ).slice(
      0,
      30
    );


  if (!liveRows.length) {

    $("rows").innerHTML =
      `
      <tr>
        <td
          colspan="4"
          class="empty"
        >
          No live results.
        </td>
      </tr>
      `;

  }
  else {

    $("rows").innerHTML =
      liveRows
      .map(
        item => {

          const issue =
            String(
              item.issueNumber
            );


          const matched =
            predictionMap.get(
              issue
            );


          let predictionHtml =
            `
            <span
              style="color:#536c83"
            >
              —
            </span>
            `;


          let resultHtml =
            `
            <span
              style="color:#536c83"
            >
              —
            </span>
            `;


          if (matched) {

            predictionHtml =
              `
              <span
                class="badge ${
                  matched.prediction ===
                  "BIG"
                    ? "bgb"
                    : "bsm"
                }"
              >
                ${esc(
                  matched.prediction
                )}
              </span>
              `;


            if (
              matched.status ===
              "WIN"
            ) {

              resultHtml =
                `
                <span
                  class="badge bwin"
                >
                  WIN
                </span>
                `;

            }
            else if (
              matched.status ===
              "LOSS"
            ) {

              resultHtml =
                `
                <span
                  class="badge bloss"
                >
                  LOSS
                </span>
                `;

            }

          }


          return `
            <tr>

              <td>
                ${esc(
                  issue.length > 8
                    ? issue.slice(-8)
                    : issue
                )}
              </td>

              <td class="n">
                ${esc(
                  item.number
                )}
              </td>

              <td>
                ${predictionHtml}
              </td>

              <td>
                ${resultHtml}
              </td>

            </tr>
          `;

        }
      )
      .join("");

  }


  connection(
    !data.error
  );


  /*
    History version changes only when
    server receives a new settled result.
  */

  lastVersion =
    data.historyVersion;

}


/* =========================================================
   LOAD STATE
   ========================================================= */

async function load() {

  try {

    const response =
      await fetch(
        "/api/state?t=" +
        Date.now(),
        {
          cache:"no-store"
        }
      );


    if (!response.ok) {

      throw new Error(
        "Server error"
      );

    }


    const data =
      await response.json();


    if (!data.success) {

      throw new Error(
        data.error ||
        "State unavailable"
      );

    }


    render(data);

  }
  catch(error) {

    connection(false);

  }

}


/* =========================================================
   SMOOTH LIVE POLLING
   ========================================================= */

setInterval(
  load,
  1000
);


/* =========================================================
   SMOOTH TIMER
   ========================================================= */

setInterval(
  function() {

    if (!lastTimerAt) {
      return;
    }


    const elapsed =
      Math.floor(
        (
          Date.now() -
          lastTimerAt
        ) / 1000
      );


    const value =
      Math.max(
        0,
        timer - elapsed
      );


    $("timer").textContent =
      String(value)
        .padStart(
          2,
          "0"
        ) +
      "s";

  },
  250
);


/* =========================================================
   LOGIN EVENTS
   ========================================================= */

$("loginBtn")
  .addEventListener(
    "click",
    doLogin
  );


$("key")
  .addEventListener(
    "keydown",
    function(event) {

      if (
        event.key ===
        "Enter"
      ) {

        doLogin();

      }

    }
  );


/* =========================================================
   MUSIC
   ========================================================= */

document.addEventListener(
  "click",
  function() {

    $("music")
      .play()
      .catch(
        () => {}
      );

  },
  {
    once:true
  }
);


/* =========================================================
   AUTO LOGIN
   ========================================================= */

autoLogin();

</script>

</body>
</html>
