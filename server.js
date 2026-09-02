<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>DY AI WINGO 30S</title>

<style>
*{
  box-sizing:border-box;
  margin:0;
  padding:0;
  font-family:Arial,sans-serif;
}

body{
  background:#060b14;
  color:#fff;
  min-height:100vh;
}

.container{
  width:100%;
  max-width:1050px;
  margin:auto;
  padding:14px;
}

.card{
  background:#0d1523;
  border:1px solid #1d2b40;
  border-radius:20px;
  padding:16px;
  margin-bottom:14px;
  box-shadow:0 8px 30px rgba(0,0,0,.25);
}

.hidden{
  display:none!important;
}

/* LOGIN */

.login{
  max-width:430px;
  margin:80px auto;
}

.logo{
  text-align:center;
  margin-bottom:20px;
}

.logo h1{
  color:#00e5ff;
  font-size:28px;
  margin-bottom:5px;
}

.logo p{
  color:#7f8da3;
  font-size:13px;
}

input{
  width:100%;
  padding:14px;
  background:#070d17;
  border:1px solid #26364d;
  border-radius:11px;
  color:white;
  outline:none;
  margin-bottom:10px;
}

input:focus{
  border-color:#00e5ff;
}

button{
  width:100%;
  padding:13px;
  border:0;
  border-radius:11px;
  background:#007cff;
  color:white;
  font-weight:bold;
  cursor:pointer;
}

button:active{
  transform:scale(.98);
}

.msg{
  margin-top:10px;
  padding:10px;
  border-radius:9px;
  font-size:13px;
  display:none;
}

.error{
  background:#35131b;
  color:#ff6c83;
}

.success{
  background:#103326;
  color:#4cffae;
}

/* HEADER */

.top{
  text-align:center;
  margin-bottom:14px;
}

.top h1{
  color:#00e5ff;
  font-size:24px;
}

.top p{
  color:#718096;
  font-size:12px;
  margin-top:5px;
}

/* PERIOD */

.period-box{
  display:flex;
  justify-content:space-between;
  align-items:center;
  gap:12px;
}

.period-title{
  color:#8795a9;
  font-size:12px;
}

.period{
  color:#fff;
  font-size:16px;
  font-weight:bold;
  margin-top:5px;
  word-break:break-all;
}

.timer{
  min-width:75px;
  text-align:center;
}

.timer-label{
  color:#8795a9;
  font-size:11px;
}

#timer{
  color:#00f5a0;
  font-size:25px;
  font-weight:bold;
  margin-top:3px;
}

/* PREDICTION */

.prediction-card{
  text-align:center;
}

.prediction-label{
  color:#8491a5;
  font-size:12px;
  letter-spacing:1px;
  margin-bottom:12px;
}

/* BIG SMALL + WIN LOSS */

.prediction-row{
  display:flex;
  justify-content:center;
  align-items:center;
  gap:16px;
  margin:8px 0 17px;
}

.prediction{
  font-size:34px;
  font-weight:900;
  letter-spacing:1px;
}

.prediction.big{
  color:#ff617b;
}

.prediction.small{
  color:#4d9dff;
}

.result-status{
  min-width:105px;
  padding:10px 13px;
  border-radius:11px;
  font-size:14px;
  font-weight:bold;
  white-space:nowrap;
}

.result-status.win{
  background:#103b2b;
  color:#4cffae;
  border:1px solid #1d6849;
}

.result-status.loss{
  background:#3a151e;
  color:#ff6b82;
  border:1px solid #713044;
}

.result-status.pending{
  background:#171f2c;
  color:#aab5c5;
  border:1px solid #29384d;
}

.analysis-grid{
  display:grid;
  grid-template-columns:repeat(4,1fr);
  gap:8px;
}

.analysis-item{
  background:#080e18;
  border:1px solid #1b293b;
  border-radius:10px;
  padding:10px 5px;
}

.analysis-item span{
  display:block;
  color:#718096;
  font-size:10px;
  margin-bottom:5px;
}

.analysis-item b{
  font-size:12px;
}

.evidence{
  color:#718096;
  font-size:11px;
  line-height:1.5;
  margin-top:12px;
}

/* HISTORY */

.title-row{
  display:flex;
  justify-content:space-between;
  align-items:center;
  margin-bottom:12px;
}

.title-row h2{
  font-size:17px;
}

.title-row span{
  color:#718096;
  font-size:11px;
}

.table-head,
.history-row{
  display:grid;
  grid-template-columns:1.8fr .6fr .8fr;
  align-items:center;
  gap:8px;
}

.table-head{
  color:#68758a;
  font-size:10px;
  padding:7px 0;
  border-bottom:1px solid #1c2939;
}

.history-row{
  padding:12px 0;
  border-bottom:1px solid #1a2636;
  font-size:12px;
}

.history-row:last-child{
  border-bottom:0;
}

.issue{
  font-weight:bold;
  word-break:break-all;
}

.number{
  font-weight:bold;
}

.big-text{
  color:#ff617b;
  font-weight:bold;
}

.small-text{
  color:#4d9dff;
  font-weight:bold;
}

/* GAME */

.game-frame{
  width:100%;
  height:620px;
  border:0;
  border-radius:18px;
  background:#101722;
  display:block;
}

.game-note{
  color:#758298;
  font-size:11px;
  line-height:1.5;
  margin-top:10px;
}

/* GRID */

.desktop-grid{
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:14px;
  align-items:start;
}

.left-column,
.right-column{
  min-width:0;
}

.loading{
  text-align:center;
  color:#758298;
  padding:20px;
  font-size:13px;
}

/* MOBILE */

@media(max-width:700px){

  .container{
    padding:9px;
  }

  .card{
    border-radius:17px;
    padding:13px;
  }

  .desktop-grid{
    display:block;
  }

  .analysis-grid{
    grid-template-columns:repeat(2,1fr);
  }

  .prediction{
    font-size:30px;
  }

  .prediction-row{
    gap:12px;
  }

  .game-frame{
    height:600px;
  }

}

@media(max-width:380px){

  .prediction{
    font-size:27px;
  }

  .result-status{
    min-width:88px;
    font-size:12px;
    padding:9px;
  }

  .period{
    font-size:13px;
  }

  #timer{
    font-size:22px;
  }

}
</style>
</head>

<body>

<!-- LOGIN -->

<div id="loginScreen" class="container">

  <div class="card login">

    <div class="logo">
      <h1>DY AI WINGO</h1>
      <p>30 Second Prediction Panel</p>
    </div>

    <input
      id="accessKey"
      type="text"
      placeholder="Enter Access Key"
      autocomplete="off"
    >

    <button onclick="login()">
      LOGIN
    </button>

    <div id="loginMsg" class="msg"></div>

  </div>

</div>


<!-- APP -->

<div id="app" class="container hidden">

  <div class="top">
    <h1>DY AI WINGO 30S</h1>
    <p>Statistical Analysis • Live History</p>
  </div>


  <!-- PERIOD -->

  <div class="card">

    <div class="period-box">

      <div>

        <div class="period-title">
          TARGET PERIOD
        </div>

        <div
          id="targetIssue"
          class="period"
        >
          Loading...
        </div>

      </div>

      <div class="timer">

        <div class="timer-label">
          TIMER
        </div>

        <div id="timer">
          00:30
        </div>

      </div>

    </div>

  </div>


  <div class="desktop-grid">


    <!-- LEFT -->

    <div class="left-column">


      <!-- PREDICTION -->

      <div class="card prediction-card">

        <div class="prediction-label">
          CURRENT ANALYSIS
        </div>


        <!-- BIG SMALL + WIN LOSS -->

        <div class="prediction-row">

          <div
            id="prediction"
            class="prediction"
          >
            --
          </div>

          <div
            id="resultStatus"
            class="result-status pending"
          >
            ⏳ PENDING
          </div>

        </div>


        <div class="analysis-grid">

          <div class="analysis-item">
            <span>CONFIDENCE</span>
            <b id="confidence">--</b>
          </div>

          <div class="analysis-item">
            <span>PATTERN</span>
            <b id="patternScore">--</b>
          </div>

          <div class="analysis-item">
            <span>SIGNAL</span>
            <b id="signal">--</b>
          </div>

          <div class="analysis-item">
            <span>AGREEMENT</span>
            <b id="agreement">--</b>
          </div>

        </div>


        <div
          id="evidence"
          class="evidence"
        >
          Waiting for analysis...
        </div>

      </div>


      <!-- LIVE RESULT HISTORY -->

      <div class="card">

        <div class="title-row">

          <h2>
            LIVE RESULT HISTORY
          </h2>

          <span>
            BIG / SMALL
          </span>

        </div>


        <div class="table-head">

          <div>PERIOD</div>
          <div>NUMBER</div>
          <div>SIZE</div>

        </div>


        <div id="liveHistory">

          <div class="loading">
            Loading history...
          </div>

        </div>

      </div>


    </div>


    <!-- RIGHT -->

    <div class="right-column">


      <!-- LIVE GAME -->

      <div class="card">

        <div class="title-row">

          <h2>
            LIVE GAME
          </h2>

          <span>
            30 SEC
          </span>

        </div>


        <iframe
          id="gameFrame"
          class="game-frame"
          src="https://www.tojvhr55.com/#/register?invitationCode=761671301584"
          allow="fullscreen"
          loading="eager"
          referrerpolicy="no-referrer"
        ></iframe>


        <div class="game-note">
          Live game provider page iframe ke andar
          load hota hai. Agar provider iframe
          embedding block karta hai to browser
          security ki wajah se blank/error aa sakta hai.
        </div>

      </div>


    </div>

  </div>

</div>


<script>

/* =====================================================
   GLOBAL
===================================================== */

let loggedIn = false;

let lastHistoryVersion = null;

let targetEndTime = 0;

let serverOffset = 0;

let lastTargetIssue = "";

let currentPrediction = "";

let currentPredictionPeriod = "";


/* =====================================================
   DEVICE ID
===================================================== */

function getDeviceId(){

  let id =
    localStorage.getItem(
      "dy_device_id"
    );

  if(!id){

    id =
      "dy-" +
      crypto.randomUUID();

    localStorage.setItem(
      "dy_device_id",
      id
    );

  }

  return id;

}


/* =====================================================
   API
===================================================== */

async function api(
  url,
  options = {}
){

  const response =
    await fetch(
      url,
      options
    );


  let data;

  try{

    data =
      await response.json();

  }catch{

    throw new Error(
      "Server response invalid"
    );

  }


  if(!response.ok){

    throw new Error(
      data.error ||
      data.message ||
      "Request failed"
    );

  }


  return data;

}


/* =====================================================
   LOGIN
===================================================== */

async function login(){

  const key =
    document
      .getElementById(
        "accessKey"
      )
      .value
      .trim();


  const msg =
    document
      .getElementById(
        "loginMsg"
      );


  if(!key){

    msg.style.display =
      "block";

    msg.className =
      "msg error";

    msg.textContent =
      "Access key enter karo.";

    return;

  }


  try{

    const data =
      await api(
        "/api/key/check",
        {

          method:"POST",

          headers:{
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({

              access_key:key,

              device_id:
                getDeviceId()

            })

        }
      );


    if(!data.ok){

      throw new Error(
        data.error ||
        data.message ||
        "Invalid access key"
      );

    }


    localStorage.setItem(
      "dy_access_key",
      key
    );


    loggedIn = true;


    document
      .getElementById(
        "loginScreen"
      )
      .classList.add(
        "hidden"
      );


    document
      .getElementById(
        "app"
      )
      .classList.remove(
        "hidden"
      );


    startApplication();


  }catch(error){

    msg.style.display =
      "block";

    msg.className =
      "msg error";

    msg.textContent =
      error.message ||
      "Login failed";

  }

}


/* =====================================================
   LOAD STATE
===================================================== */

async function loadState(){

  if(!loggedIn){
    return;
  }


  try{

    const key =
      localStorage.getItem(
        "dy_access_key"
      );


    const data =
      await api(
        "/api/state",
        {

          headers:{

            "x-access-key":
              key,

            "x-device-id":
              getDeviceId()

          }

        }
      );


    /* PERIOD */

    const target =
      data.targetIssue ||
      data.currentIssue ||
      "--";


    document
      .getElementById(
        "targetIssue"
      )
      .textContent =
      target;


    /*
      TIMER
    */

    if(data.timing){

      if(
        data.timing.serverNow
      ){

        serverOffset =
          Number(
            data.timing.serverNow
          ) -
          Date.now();

      }

      /*
        Server currently returns
        seconds instead of targetEnd.
      */

      if(
        Number.isFinite(
          Number(
            data.timing.seconds
          )
        )
      ){

        targetEndTime =
          Date.now() +
          (
            Number(
              data.timing.seconds
            ) * 1000
          );

      }

    }


    /*
      Prediction only refreshes
      when history version changes.
    */

    if(
      lastHistoryVersion !==
      data.historyVersion
    ){

      lastHistoryVersion =
        data.historyVersion;


      currentPrediction =
        String(
          data.analysis?.prediction ||
          ""
        ).toUpperCase();


      currentPredictionPeriod =
        target;


      renderPrediction(
        data.analysis
      );

    }


    renderLiveHistory(
      data.history || []
    );


    /*
      IMPORTANT:
      Check actual WIN/LOSS
      every state refresh.
    */

    await updatePredictionResult();


  }catch(error){

    console.log(
      "State error:",
      error.message
    );

  }

}


/* =====================================================
   RENDER PREDICTION
===================================================== */

function renderPrediction(
  analysis
){

  const predictionEl =
    document.getElementById(
      "prediction"
    );


  if(!analysis){

    predictionEl.textContent =
      "--";

    predictionEl.className =
      "prediction";


    setResultStatus(
      "PENDING"
    );


    return;

  }


  const value =
    String(
      analysis.prediction ||
      ""
    ).toUpperCase();


  predictionEl.textContent =
    value ||
    "--";


  predictionEl.className =
    "prediction " +
    (
      value === "BIG"
        ? "big"
        : "small"
    );


  document.getElementById(
    "confidence"
  ).textContent =
    analysis.confidence != null
      ? analysis.confidence + "%"
      : "--";


  document.getElementById(
    "patternScore"
  ).textContent =
    analysis.patternScore != null
      ? analysis.patternScore
      : "--";


  document.getElementById(
    "signal"
  ).textContent =
    analysis.status ||
    analysis.signal ||
    "--";


  document.getElementById(
    "agreement"
  ).textContent =
    analysis.agreement != null
      ? analysis.agreement
      : "--";


  const matches =
    analysis.matches || {};


  document.getElementById(
    "evidence"
  ).textContent =
    "Evidence: " +
    (
      analysis.evidence ??
      0
    ) +
    " • Exact: " +
    (
      matches.exact ??
      0
    ) +
    " • Similar: " +
    (
      matches.similar ??
      0
    );


  setResultStatus(
    "PENDING"
  );

}


/* =====================================================
   WIN LOSS RESULT
===================================================== */

async function updatePredictionResult(){

  if(
    !currentPredictionPeriod ||
    !currentPrediction
  ){

    setResultStatus(
      "PENDING"
    );

    return;

  }


  try{

    const data =
      await api(
        "/api/history"
      );


    const rows =
      Array.isArray(
        data.rows
      )
        ? data.rows
        : [];


    /*
      Find the exact prediction
      period in settled database.
    */

    const found =
      rows.find(
        row =>
          String(
            row.target_issue
          ) ===
          String(
            currentPredictionPeriod
          )
      );


    if(!found){

      setResultStatus(
        "PENDING"
      );

      return;

    }


    const result =
      String(
        found.result ||
        ""
      ).toUpperCase();


    if(result === "WIN"){

      setResultStatus(
        "WIN"
      );

      return;

    }


    if(result === "LOSS"){

      setResultStatus(
        "LOSS"
      );

      return;

    }


    setResultStatus(
      "PENDING"
    );


  }catch(error){

    console.log(
      "WIN/LOSS error:",
      error.message
    );

  }

}


/* =====================================================
   SET RESULT STATUS
===================================================== */

function setResultStatus(
  result
){

  const el =
    document.getElementById(
      "resultStatus"
    );


  if(result === "WIN"){

    el.className =
      "result-status win";

    el.textContent =
      "✓ WIN";

    return;

  }


  if(result === "LOSS"){

    el.className =
      "result-status loss";

    el.textContent =
      "✕ LOSS";

    return;

  }


  el.className =
    "result-status pending";

  el.textContent =
    "⏳ PENDING";

}


/* =====================================================
   LIVE HISTORY
===================================================== */

function renderLiveHistory(
  history
){

  const box =
    document.getElementById(
      "liveHistory"
    );


  if(
    !Array.isArray(history) ||
    !history.length
  ){

    box.innerHTML =
      `
      <div class="loading">
        No live history available
      </div>
      `;

    return;

  }


  box.innerHTML =
    history
      .slice(0,15)
      .map(
        row => {

          const number =
            row.number ??
            "-";


          const size =
            String(
              row.size ||
              row.bigSmall ||
              (
                Number(number) >= 5
                  ? "BIG"
                  : "SMALL"
              )
            ).toUpperCase();


          const sizeClass =
            size === "BIG"
              ? "big-text"
              : "small-text";


          return `

            <div class="history-row">

              <div class="issue">
                ${escapeHtml(
                  row.issueNumber ||
                  row.period ||
                  "-"
                )}
              </div>

              <div class="number">
                ${escapeHtml(
                  String(number)
                )}
              </div>

              <div class="${sizeClass}">
                ${escapeHtml(size)}
              </div>

            </div>

          `;

        }
      )
      .join("");

}


/* =====================================================
   TIMER
===================================================== */

function renderTimer(){

  const el =
    document.getElementById(
      "timer"
    );


  if(
    !targetEndTime
  ){

    el.textContent =
      "00:30";

    return;

  }


  const now =
    Date.now() +
    serverOffset;


  const remaining =
    targetEndTime -
    now;


  if(
    remaining <= 0
  ){

    el.textContent =
      "00:00";

    return;

  }


  let seconds =
    Math.ceil(
      remaining /
      1000
    );


  seconds =
    Math.max(
      0,
      Math.min(
        30,
        seconds
      )
    );


  el.textContent =
    "00:" +
    String(seconds)
      .padStart(
        2,
        "0"
      );

}


/* =====================================================
   AUTO LOGIN
===================================================== */

async function autoLogin(){

  const key =
    localStorage.getItem(
      "dy_access_key"
    );


  if(!key){
    return;
  }


  try{

    const data =
      await api(
        "/api/key/check",
        {

          method:"POST",

          headers:{
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({

              access_key:key,

              device_id:
                getDeviceId()

            })

        }
      );


    if(!data.ok){

      throw new Error(
        "Access expired"
      );

    }


    loggedIn = true;


    document
      .getElementById(
        "loginScreen"
      )
      .classList.add(
        "hidden"
      );


    document
      .getElementById(
        "app"
      )
      .classList.remove(
        "hidden"
      );


    startApplication();


  }catch(error){

    localStorage.removeItem(
      "dy_access_key"
    );

    console.log(
      error.message
    );

  }

}


/* =====================================================
   START
===================================================== */

function startApplication(){

  loadState();


  /*
    Server state every second.
  */

  setInterval(
    loadState,
    1000
  );


  /*
    Smooth timer.
  */

  setInterval(
    renderTimer,
    250
  );

}


/* =====================================================
   ESCAPE
===================================================== */

function escapeHtml(
  value
){

  return String(value)

    .replaceAll(
      "&",
      "&amp;"
    )

    .replaceAll(
      "<",
      "&lt;"
    )

    .replaceAll(
      ">",
      "&gt;"
    )

    .replaceAll(
      '"',
      "&quot;"
    )

    .replaceAll(
      "'",
      "&#039;"
    );

}


/* =====================================================
   ENTER LOGIN
===================================================== */

document
  .getElementById(
    "accessKey"
  )
  .addEventListener(
    "keydown",
    function(e){

      if(
        e.key === "Enter"
      ){

        login();

      }

    }
  );


/* =====================================================
   LOAD
===================================================== */

window.addEventListener(
  "load",
  autoLogin
);

</script>

</body>
</html>
