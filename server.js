<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">

  <title>DY AI • Admin Panel</title>

  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: Inter, Arial, sans-serif;
      background:
        radial-gradient(circle at top left, rgba(30, 136, 229, .18), transparent 30%),
        radial-gradient(circle at bottom right, rgba(124, 58, 237, .16), transparent 30%),
        #070b14;
      color: #fff;
      min-height: 100vh;
    }

    button,
    input {
      font: inherit;
    }

    .hidden {
      display: none !important;
    }

    /* LOGIN */

    .login-screen {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }

    .login-card {
      width: 100%;
      max-width: 430px;
      padding: 30px 24px;
      border-radius: 24px;
      background: rgba(14, 20, 34, .88);
      border: 1px solid rgba(255,255,255,.09);
      box-shadow: 0 25px 80px rgba(0,0,0,.45);
      backdrop-filter: blur(20px);
    }

    .logo {
      width: 74px;
      height: 74px;
      margin: 0 auto 18px;
      border-radius: 22px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg,#2563eb,#7c3aed);
      font-size: 25px;
      font-weight: 900;
      box-shadow: 0 12px 35px rgba(37,99,235,.35);
    }

    .login-card h1 {
      text-align: center;
      font-size: 25px;
      margin-bottom: 7px;
    }

    .login-card p {
      text-align: center;
      color: #8d99ad;
      font-size: 13px;
      margin-bottom: 25px;
    }

    .input {
      width: 100%;
      padding: 15px;
      border-radius: 14px;
      border: 1px solid #263149;
      outline: none;
      background: #0b1120;
      color: white;
      margin-bottom: 13px;
    }

    .input:focus {
      border-color: #3b82f6;
    }

    .btn {
      width: 100%;
      padding: 14px;
      border: 0;
      border-radius: 14px;
      color: white;
      cursor: pointer;
      font-weight: 800;
      transition: .2s;
    }

    .btn:active {
      transform: scale(.98);
    }

    .btn-primary {
      background: linear-gradient(135deg,#2563eb,#7c3aed);
    }

    .error {
      margin-top: 13px;
      padding: 11px;
      border-radius: 11px;
      background: rgba(239,68,68,.12);
      color: #ff8585;
      font-size: 13px;
      text-align: center;
    }

    /* APP */

    .app {
      display: none;
      min-height: 100vh;
    }

    .topbar {
      position: sticky;
      top: 0;
      z-index: 20;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 15px 18px;
      background: rgba(7,11,20,.86);
      border-bottom: 1px solid rgba(255,255,255,.07);
      backdrop-filter: blur(18px);
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 11px;
    }

    .brand-logo {
      width: 43px;
      height: 43px;
      border-radius: 13px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg,#2563eb,#7c3aed);
      font-size: 14px;
      font-weight: 900;
    }

    .brand h2 {
      font-size: 16px;
    }

    .brand span {
      display: block;
      color: #76839a;
      font-size: 11px;
      margin-top: 2px;
    }

    .logout {
      border: 1px solid #27324a;
      background: #0e1524;
      color: #cbd5e1;
      padding: 9px 13px;
      border-radius: 11px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 700;
    }

    .container {
      max-width: 1200px;
      margin: auto;
      padding: 18px;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(12,1fr);
      gap: 15px;
    }

    .card {
      background: rgba(14,20,34,.84);
      border: 1px solid rgba(255,255,255,.07);
      border-radius: 20px;
      padding: 18px;
      box-shadow: 0 15px 50px rgba(0,0,0,.18);
    }

    .col-12 { grid-column: span 12; }
    .col-8 { grid-column: span 8; }
    .col-6 { grid-column: span 6; }
    .col-4 { grid-column: span 4; }

    .title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }

    .title h3 {
      font-size: 15px;
    }

    .title span {
      font-size: 11px;
      color: #718096;
    }

    /* STATUS */

    .status-grid {
      display: grid;
      grid-template-columns: repeat(4,1fr);
      gap: 10px;
    }

    .status-box {
      background: #0a101d;
      border: 1px solid #1b263b;
      border-radius: 14px;
      padding: 13px;
    }

    .status-box small {
      color: #718096;
      display: block;
      margin-bottom: 7px;
      font-size: 10px;
    }

    .status-box strong {
      font-size: 14px;
      word-break: break-word;
    }

    .live {
      color: #22c55e !important;
    }

    .offline {
      color: #ef4444 !important;
    }

    /* AI */

    .ai-box {
      text-align: center;
      padding: 8px;
    }

    .prediction {
      width: 150px;
      height: 150px;
      border-radius: 50%;
      margin: 8px auto 15px;
      display: flex;
      align-items: center;
      justify-content: center;
      background:
        radial-gradient(circle,#18243a 45%,transparent 46%),
        linear-gradient(135deg,#2563eb,#7c3aed);
      box-shadow: 0 0 45px rgba(59,130,246,.18);
    }

    .prediction strong {
      font-size: 29px;
      letter-spacing: 1px;
    }

    .confidence {
      font-size: 13px;
      color: #9ba8bb;
      margin-bottom: 7px;
    }

    .regime {
      display: inline-block;
      padding: 6px 10px;
      border-radius: 20px;
      background: #111b2e;
      color: #93c5fd;
      font-size: 11px;
      font-weight: 800;
    }

    .reason {
      color: #7d8aa0;
      font-size: 12px;
      margin-top: 13px;
      line-height: 1.6;
    }

    /* BUTTONS */

    .actions {
      display: grid;
      grid-template-columns: repeat(2,1fr);
      gap: 9px;
    }

    .action-btn {
      padding: 12px;
      border-radius: 12px;
      border: 1px solid #25324b;
      background: #0c1423;
      color: #dbeafe;
      cursor: pointer;
      font-size: 12px;
      font-weight: 800;
    }

    .action-btn:hover {
      background: #131e33;
    }

    /* KEY */

    .key-create {
      display: grid;
      grid-template-columns: 1fr 130px;
      gap: 9px;
      margin-bottom: 15px;
    }

    .key-create button {
      border: 0;
      border-radius: 13px;
      background: linear-gradient(135deg,#2563eb,#7c3aed);
      color: white;
      font-weight: 800;
      cursor: pointer;
    }

    .key-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      max-height: 450px;
      overflow-y: auto;
    }

    .key-row {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 10px;
      align-items: center;
      padding: 12px;
      border-radius: 13px;
      background: #0a101d;
      border: 1px solid #19243a;
    }

    .key-value {
      font-family: monospace;
      font-size: 12px;
      color: #dbeafe;
      word-break: break-all;
    }

    .key-meta {
      color: #697890;
      font-size: 10px;
      margin-top: 5px;
    }

    .key-actions {
      display: flex;
      gap: 6px;
    }

    .mini-btn {
      border: 1px solid #26334c;
      background: #111a2a;
      color: #cbd5e1;
      border-radius: 9px;
      padding: 8px;
      cursor: pointer;
      font-size: 10px;
      font-weight: 700;
    }

    .mini-btn.danger {
      color: #fca5a5;
      border-color: rgba(239,68,68,.25);
    }

    /* LOG */

    .log {
      max-height: 280px;
      overflow-y: auto;
      background: #070c16;
      border-radius: 13px;
      padding: 10px;
    }

    .log-row {
      border-bottom: 1px solid #121c2c;
      padding: 9px 5px;
      font-family: monospace;
      font-size: 10px;
      color: #8fa0b7;
      line-height: 1.5;
    }

    .log-row:last-child {
      border-bottom: 0;
    }

    /* TABLE */

    .table-wrap {
      overflow-x: auto;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 600px;
    }

    th {
      color: #64748b;
      font-size: 10px;
      text-align: left;
      padding: 10px;
      border-bottom: 1px solid #1c2638;
    }

    td {
      padding: 11px 10px;
      font-size: 11px;
      border-bottom: 1px solid #121c2b;
    }

    .badge {
      display: inline-flex;
      padding: 5px 8px;
      border-radius: 8px;
      font-size: 9px;
      font-weight: 900;
    }

    .badge-win {
      color: #4ade80;
      background: rgba(34,197,94,.1);
    }

    .badge-loss {
      color: #fb7185;
      background: rgba(244,63,94,.1);
    }

    .badge-pending {
      color: #fbbf24;
      background: rgba(245,158,11,.1);
    }

    /* TOAST */

    .toast {
      position: fixed;
      right: 18px;
      bottom: 18px;
      z-index: 100;
      max-width: 340px;
      padding: 13px 16px;
      border-radius: 13px;
      background: #111827;
      border: 1px solid #26344d;
      box-shadow: 0 20px 50px rgba(0,0,0,.4);
      color: #dbeafe;
      font-size: 12px;
      transform: translateY(120px);
      opacity: 0;
      transition: .25s;
    }

    .toast.show {
      transform: translateY(0);
      opacity: 1;
    }

    footer {
      text-align: center;
      color: #4d5b70;
      font-size: 10px;
      padding: 25px 10px;
    }

    @media(max-width:850px) {
      .col-8,
      .col-6,
      .col-4 {
        grid-column: span 12;
      }

      .status-grid {
        grid-template-columns: repeat(2,1fr);
      }
    }

    @media(max-width:520px) {
      .container {
        padding: 12px;
      }

      .card {
        padding: 14px;
        border-radius: 17px;
      }

      .status-grid {
        grid-template-columns: repeat(2,1fr);
      }

      .key-create {
        grid-template-columns: 1fr;
      }

      .key-create button {
        min-height: 45px;
      }

      .key-row {
        grid-template-columns: 1fr;
      }

      .key-actions {
        justify-content: flex-start;
      }

      .topbar {
        padding: 12px;
      }

      .prediction {
        width: 135px;
        height: 135px;
      }
    }
  </style>
</head>

<body>

  <!-- LOGIN -->

  <section class="login-screen" id="loginScreen">

    <div class="login-card">

      <div class="logo">DY</div>

      <h1>DY AI ADMIN</h1>

      <p>Secure administrator control panel</p>

      <input
        id="adminKey"
        class="input"
        type="password"
        placeholder="Enter Admin Key"
        autocomplete="off"
      >

      <button class="btn btn-primary" onclick="login()">
        LOGIN TO ADMIN
      </button>

      <div id="loginError" class="error hidden"></div>

    </div>

  </section>


  <!-- APP -->

  <main class="app" id="app">

    <header class="topbar">

      <div class="brand">

        <div class="brand-logo">DY</div>

        <div>
          <h2>DY AI WINGO</h2>
          <span>Administrator Panel • V4</span>
        </div>

      </div>

      <button class="logout" onclick="logout()">
        LOGOUT
      </button>

    </header>


    <div class="container">

      <div class="grid">

        <!-- SYSTEM STATUS -->

        <section class="card col-12">

          <div class="title">
            <h3>⚡ SYSTEM STATUS</h3>
            <span id="lastUpdate">Waiting...</span>
          </div>

          <div class="status-grid">

            <div class="status-box">
              <small>SERVER</small>
              <strong id="serverStatus">CHECKING</strong>
            </div>

            <div class="status-box">
              <small>DATABASE</small>
              <strong id="dbStatus">CHECKING</strong>
            </div>

            <div class="status-box">
              <small>WINGOBOT</small>
              <strong id="wingoStatus">CHECKING</strong>
            </div>

            <div class="status-box">
              <small>MODEL</small>
              <strong id="modelVersion">DY-AI-BS-V4</strong>
            </div>

          </div>

        </section>


        <!-- CURRENT AI -->

        <section class="card col-4">

          <div class="title">
            <h3>🤖 CURRENT AI</h3>
            <span>LIVE</span>
          </div>

          <div class="ai-box">

            <div class="prediction">
              <strong id="currentPrediction">—</strong>
            </div>

            <div class="confidence">
              Confidence: <b id="currentConfidence">—</b>
            </div>

            <div class="regime" id="currentRegime">
              WAITING
            </div>

            <div class="reason" id="currentReason">
              Waiting for live prediction data...
            </div>

          </div>

        </section>


        <!-- GAME INFO -->

        <section class="card col-4">

          <div class="title">
            <h3>🎯 GAME INFO</h3>
            <span>30 SEC</span>
          </div>

          <div class="status-box" style="margin-bottom:10px;">
            <small>CURRENT ISSUE</small>
            <strong id="currentIssue">—</strong>
          </div>

          <div class="status-box" style="margin-bottom:10px;">
            <small>TARGET ISSUE</small>
            <strong id="targetIssue">—</strong>
          </div>

          <div class="status-box">
            <small>HISTORY COUNT</small>
            <strong id="historyCount">0</strong>
          </div>

        </section>


        <!-- DIAGNOSTICS -->

        <section class="card col-4">

          <div class="title">
            <h3>🛠 DIAGNOSTICS</h3>
            <span>TOOLS</span>
          </div>

          <div class="actions">

            <button class="action-btn" onclick="pingServer()">
              PING
            </button>

            <button class="action-btn" onclick="testWingo()">
              WINGO TEST
            </button>

            <button class="action-btn" onclick="testModel()">
              MODEL TEST
            </button>

            <button class="action-btn" onclick="refreshAll()">
              REFRESH
            </button>

          </div>

        </section>


        <!-- ACCESS KEYS -->

        <section class="card col-8">

          <div class="title">
            <h3>🔑 ACCESS KEY MANAGEMENT</h3>
            <span id="keyCount">0 KEYS</span>
          </div>

          <div class="key-create">

            <input
              id="newKey"
              class="input"
              style="margin:0;"
              placeholder="Custom key or leave empty for auto"
              autocomplete="off"
            >

            <button onclick="createKey()">
              + CREATE KEY
            </button>

          </div>

          <div class="key-list" id="keyList">
            <div style="color:#64748b;font-size:12px;text-align:center;padding:20px;">
              Loading keys...
            </div>
          </div>

        </section>


        <!-- ADMIN LOG -->

        <section class="card col-4">

          <div class="title">
            <h3>📋 ADMIN LOG</h3>
            <span>LIVE</span>
          </div>

          <div class="log" id="logBox">
            <div class="log-row">
              [SYSTEM] Admin panel initialized.
            </div>
          </div>

        </section>


        <!-- MODEL TEST -->

        <section class="card col-12">

          <div class="title">
            <h3>🧠 V4 MODEL INFORMATION</h3>
            <span>BIG / SMALL ONLY</span>
          </div>

          <div class="status-grid">

            <div class="status-box">
              <small>MODEL VERSION</small>
              <strong>DY-AI-BS-V4</strong>
            </div>

            <div class="status-box">
              <small>NUMBER MODEL</small>
              <strong>DISABLED</strong>
            </div>

            <div class="status-box">
              <small>OUTPUT</small>
              <strong>BIG / SMALL</strong>
            </div>

            <div class="status-box">
              <small>SETTLEMENT</small>
              <strong>EXACT ISSUE</strong>
            </div>

          </div>

        </section>


        <!-- PREDICTION HISTORY -->

        <section class="card col-12">

          <div class="title">
            <h3>📊 RECENT PREDICTIONS</h3>
            <span>LAST 30</span>
          </div>

          <div class="table-wrap">

            <table>

              <thead>
                <tr>
                  <th>PERIOD</th>
                  <th>PREDICTION</th>
                  <th>CONFIDENCE</th>
                  <th>RESULT</th>
                  <th>STATUS</th>
                </tr>
              </thead>

              <tbody id="predictionTable">

                <tr>
                  <td colspan="5" style="text-align:center;color:#64748b;">
                    Loading...
                  </td>
                </tr>

              </tbody>

            </table>

          </div>

        </section>

      </div>


      <footer>
        DY AI Wingo • Administrator Panel • V4
        <br>
        AI estimates are not guaranteed outcomes.
      </footer>

    </div>

  </main>


  <div class="toast" id="toast"></div>


<script>

  let ADMIN_KEY = "";
  let stateTimer = null;


  /* -------------------------
     BASIC HELPERS
  ------------------------- */

  function $(id) {
    return document.getElementById(id);
  }


  function esc(value) {

    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");

  }


  function toast(message) {

    const el = $("toast");

    el.textContent = message;

    el.classList.add("show");

    clearTimeout(window.toastTimer);

    window.toastTimer = setTimeout(() => {
      el.classList.remove("show");
    }, 2600);

  }


  function log(message) {

    const box = $("logBox");

    const row = document.createElement("div");

    row.className = "log-row";

    const time = new Date().toLocaleTimeString();

    row.textContent = `[${time}] ${message}`;

    box.prepend(row);

    while (box.children.length > 80) {
      box.removeChild(box.lastChild);
    }

  }


  async function api(url, options = {}) {

    const headers = {
      ...(options.headers || {})
    };

    if (ADMIN_KEY) {
      headers["x-admin-key"] = ADMIN_KEY;
    }

    const response = await fetch(url, {
      ...options,
      headers
    });

    let data = null;

    try {
      data = await response.json();
    } catch {
      data = {};
    }

    if (!response.ok) {

      const message =
        data.error ||
        data.message ||
        `HTTP ${response.status}`;

      throw new Error(message);
    }

    return data;

  }


  /* -------------------------
     LOGIN
  ------------------------- */

  async function login() {

    const key = $("adminKey").value.trim();

    if (!key) {

      showLoginError("Admin key enter karo.");

      return;
    }

    $("loginError").classList.add("hidden");

    try {

      const data = await api("/api/admin/status", {
        headers: {
          "x-admin-key": key
        }
      });

      if (
        data &&
        (
          data.ok === true ||
          data.status === "ok" ||
          data.success === true
        )
      ) {

        ADMIN_KEY = key;

        $("loginScreen").style.display = "none";
        $("app").style.display = "block";

        log("Admin login successful.");

        await refreshAll();

        if (!stateTimer) {

          stateTimer = setInterval(() => {

            refreshState(false);

          }, 3000);

        }

        return;
      }

      showLoginError("Invalid admin key.");

    } catch (error) {

      console.error(error);

      showLoginError(
        error.message || "Admin login failed."
      );

    }

  }


  function showLoginError(message) {

    const el = $("loginError");

    el.textContent = message;

    el.classList.remove("hidden");

  }


  function logout() {

    ADMIN_KEY = "";

    if (stateTimer) {

      clearInterval(stateTimer);

      stateTimer = null;

    }

    $("app").style.display = "none";
    $("loginScreen").style.display = "flex";

    $("adminKey").value = "";

    log("Admin logged out.");

  }


  $("adminKey").addEventListener("keydown", function(e) {

    if (e.key === "Enter") {
      login();
    }

  });


  /* -------------------------
     STATUS
  ------------------------- */

  async function refreshStatus() {

    try {

      const data = await api("/api/admin/status");

      $("serverStatus").textContent =
        data.server ||
        data.status ||
        "ONLINE";

      $("serverStatus").className = "live";

      $("dbStatus").textContent =
        data.database ||
        data.db ||
        "CONNECTED";

      $("dbStatus").className =
        String(data.database || data.db || "")
          .toLowerCase()
          .includes("fail")
          ? "offline"
          : "live";

      $("wingoStatus").textContent =
        data.wingobot ||
        data.wingo ||
        "CONNECTED";

      $("wingoStatus").className =
        String(
          data.wingobot ||
          data.wingo ||
          ""
        )
          .toLowerCase()
          .includes("fail")
          ? "offline"
          : "live";

      $("modelVersion").textContent =
        data.model_version ||
        data.model ||
        "DY-AI-BS-V4";

    } catch (error) {

      $("serverStatus").textContent = "ERROR";
      $("serverStatus").className = "offline";

      log("Status error: " + error.message);

    }

  }


  /* -------------------------
     STATE
  ------------------------- */

  async function refreshState(writeLog = true) {

    try {

      const data = await api("/api/state");

      const state = data.state || data;

      const prediction =
        state.prediction ||
        data.prediction ||
        {};

      const target =
        state.targetIssue ||
        state.target_issue ||
        data.targetIssue ||
        data.target_issue ||
        prediction.target_issue ||
        "—";

      const current =
        state.currentIssue ||
        state.current_issue ||
        data.currentIssue ||
        data.current_issue ||
        "—";

      $("currentIssue").textContent = current;
      $("targetIssue").textContent = target;

      const side =
        prediction.prediction ||
        prediction.side ||
        state.predictionSide ||
        state.prediction ||
        "—";

      $("currentPrediction").textContent =
        String(side).toUpperCase();

      const confidence =
        prediction.confidence ??
        state.confidence ??
        "—";

      $("currentConfidence").textContent =
        confidence === "—"
          ? "—"
          : `${confidence}%`;

      $("currentRegime").textContent =
        prediction.regime ||
        state.regime ||
        "MIXED";

      $("currentReason").textContent =
        prediction.reason ||
        state.reason ||
        "Live V4 model analysis.";

      const history =
        state.history ||
        data.history ||
        [];

      $("historyCount").textContent =
        Array.isArray(history)
          ? history.length
          : 0;

      $("lastUpdate").textContent =
        new Date().toLocaleTimeString();

      if (writeLog) {
        log("State refreshed.");
      }

      renderPredictionHistory(
        state.predictions ||
        state.predictionHistory ||
        data.predictions ||
        data.predictionHistory ||
        []
      );

    } catch (error) {

      log("State error: " + error.message);

    }

  }


  /* -------------------------
     PREDICTION HISTORY
  ------------------------- */

  function renderPredictionHistory(rows) {

    const tbody = $("predictionTable");

    if (!Array.isArray(rows) || rows.length === 0) {

      tbody.innerHTML = `
        <tr>
          <td colspan="5"
              style="text-align:center;color:#64748b;padding:25px;">
            No prediction records found.
          </td>
        </tr>
      `;

      return;
    }

    tbody.innerHTML = rows
      .slice(0, 30)
      .map(row => {

        const period =
          row.target_issue ||
          row.targetIssue ||
          row.issueNumber ||
          row.period ||
          "—";

        const prediction =
          row.prediction ||
          row.side ||
          "—";

        const confidence =
          row.confidence == null
            ? "—"
            : `${row.confidence}%`;

        const result =
          row.actual_result ||
          row.actualResult ||
          row.result ||
          "—";

        const statusRaw =
          row.status ||
          (
            result === "BIG" ||
            result === "SMALL"
              ? (
                  String(prediction).toUpperCase() ===
                  String(result).toUpperCase()
                    ? "WIN"
                    : "LOSS"
                )
              : "PENDING"
          );

        const status =
          String(statusRaw).toUpperCase();

        let badge = "badge-pending";

        if (status === "WIN") {
          badge = "badge-win";
        }

        if (status === "LOSS") {
          badge = "badge-loss";
        }

        return `
          <tr>

            <td>${esc(period)}</td>

            <td>
              <b>${esc(String(prediction).toUpperCase())}</b>
            </td>

            <td>${esc(confidence)}</td>

            <td>
              ${esc(String(result).toUpperCase())}
            </td>

            <td>
              <span class="badge ${badge}">
                ${esc(status)}
              </span>
            </td>

          </tr>
        `;

      })
      .join("");

  }


  /* -------------------------
     ACCESS KEYS
  ------------------------- */

  async function loadKeys() {

    try {

      const data = await api("/api/admin/keys");

      const keys =
        Array.isArray(data)
          ? data
          : (
              data.keys ||
              data.data ||
              []
            );

      renderKeys(keys);

    } catch (error) {

      $("keyList").innerHTML = `
        <div style="color:#fb7185;text-align:center;padding:20px;font-size:12px;">
          Failed to load keys.
        </div>
      `;

      log("Key load error: " + error.message);

    }

  }


  function renderKeys(keys) {

    $("keyCount").textContent =
      `${keys.length} KEY${keys.length === 1 ? "" : "S"}`;

    const box = $("keyList");

    if (!keys.length) {

      box.innerHTML = `
        <div style="color:#64748b;text-align:center;padding:20px;font-size:12px;">
          No access keys found.
        </div>
      `;

      return;
    }

    box.innerHTML = keys.map(key => {

      const value =
        key.access_key ||
        key.key ||
        key.token ||
        "—";

      const device =
        key.device_id
          ? `Device: ${key.device_id}`
          : "Device: Not bound";

      const created =
        key.created_at
          ? formatDate(key.created_at)
          : "—";

      const lastSeen =
        key.last_seen
          ? formatDate(key.last_seen)
          : "Never";

      const id =
        key.id ??
        "";

      return `
        <div class="key-row">

          <div>

            <div class="key-value">
              ${esc(value)}
            </div>

            <div class="key-meta">
              ${esc(device)}
              • Created: ${esc(created)}
              • Last seen: ${esc(lastSeen)}
            </div>

          </div>

          <div class="key-actions">

            <button
              class="mini-btn"
              onclick="resetDevice('${esc(value)}')">
              RESET DEVICE
            </button>

            <button
              class="mini-btn danger"
              onclick="deleteKey(${Number(id)}, '${esc(value)}')">
              DELETE
            </button>

          </div>

        </div>
      `;

    }).join("");

  }


  function formatDate(value) {

    let date;

    if (typeof value === "number") {

      date = new Date(
        value < 100000000000
          ? value * 1000
          : value
      );

    } else {

      date = new Date(value);

    }

    if (Number.isNaN(date.getTime())) {
      return String(value);
    }

    return date.toLocaleString();

  }


  function randomKey() {

    const chars =
      "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    let output = "DY-";

    for (let i = 0; i < 12; i++) {

      output +=
        chars[
          Math.floor(
            Math.random() * chars.length
          )
        ];

    }

    return output;

  }


  async function createKey() {

    let key =
      $("newKey").value.trim();

    if (!key) {
      key = randomKey();
    }

    try {

      const data = await api("/api/admin/keys", {

        method: "POST",

        headers: {
          "Content-Type": "application/json"
        },

        body: JSON.stringify({
          access_key: key,
          key: key
        })

      });

      $("newKey").value = "";

      toast("Access key created.");
      log(`Key created: ${key}`);

      await loadKeys();

    } catch (error) {

      toast(error.message);
      log("Key create failed: " + error.message);

    }

  }


  async function resetDevice(key) {

    if (
      !confirm(
        `Device binding reset karna hai?\n\n${key}`
      )
    ) {
      return;
    }

    try {

      await api("/api/admin/reset-device", {

        method: "POST",

        headers: {
          "Content-Type": "application/json"
        },

        body: JSON.stringify({
          access_key: key,
          key: key
        })

      });

      toast("Device reset successfully.");
      log(`Device reset: ${key}`);

      await loadKeys();

    } catch (error) {

      toast(error.message);
      log("Device reset failed: " + error.message);

    }

  }


  async function deleteKey(id, key) {

    if (
      !confirm(
        `Delete this access key?\n\n${key}`
      )
    ) {
      return;
    }

    try {

      const query =
        id !== ""
          ? `?id=${encodeURIComponent(id)}`
          : `?access_key=${encodeURIComponent(key)}`;

      await api(
        "/api/admin/keys" + query,
        {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            id,
            access_key: key,
            key
          })
        }
      );

      toast("Key deleted.");
      log(`Key deleted: ${key}`);

      await loadKeys();

    } catch (error) {

      toast(error.message);
      log("Key delete failed: " + error.message);

    }

  }


  /* -------------------------
     DIAGNOSTICS
  ------------------------- */

  async function pingServer() {

    try {

      const start = performance.now();

      const data =
        await api("/api/admin/ping");

      const ms =
        Math.round(
          performance.now() - start
        );

      toast(`PING OK • ${ms} ms`);

      log(
        `Ping successful • ${ms} ms`
      );

      console.log(data);

    } catch (error) {

      toast("Ping failed.");
      log("Ping failed: " + error.message);

    }

  }


  async function testWingo() {

    toast("Testing WingoBot...");

    try {

      const data =
        await api("/api/admin/wingo-test");

      log(
        "WingoBot test: " +
        JSON.stringify(data)
      );

      toast("WingoBot test complete.");

    } catch (error) {

      toast("WingoBot test failed.");
      log(
        "WingoBot test failed: " +
        error.message
      );

    }

  }


  async function testModel() {

    toast("Testing V4 model...");

    try {

      const data =
        await api("/api/admin/model-test");

      log(
        "Model test: " +
        JSON.stringify(data)
      );

      toast("V4 model test complete.");

    } catch (error) {

      toast("Model test failed.");
      log(
        "Model test failed: " +
        error.message
      );

    }

  }


  /* -------------------------
     REFRESH
  ------------------------- */

  async function refreshAll() {

    toast("Refreshing...");

    await Promise.all([
      refreshStatus(),
      refreshState(false),
      loadKeys()
    ]);

    $("lastUpdate").textContent =
      new Date().toLocaleTimeString();

    log("Full admin refresh complete.");

  }


  /* -------------------------
     AUTO LOGIN
  ------------------------- */

  window.addEventListener("load", () => {

    const saved =
      sessionStorage.getItem(
        "dy_admin_key"
      );

    if (saved) {

      $("adminKey").value = saved;

    }

  });


  /* Save key only for current browser session */

  const originalLogin = login;

  login = async function() {

    const key =
      $("adminKey").value.trim();

    if (!key) {

      showLoginError(
        "Admin key enter karo."
      );

      return;

    }

    try {

      const data =
        await fetch(
          "/api/admin/status",
          {
            headers: {
              "x-admin-key": key
            }
          }
        );

      let json = {};

      try {
        json = await data.json();
      } catch {}

      if (!data.ok) {

        throw new Error(
          json.error ||
          json.message ||
          "Invalid admin key."
        );

      }

      ADMIN_KEY = key;

      sessionStorage.setItem(
        "dy_admin_key",
        key
      );

      $("loginError")
        .classList
        .add("hidden");

      $("loginScreen").style.display =
        "none";

      $("app").style.display =
        "block";

      log("Admin login successful.");

      await refreshAll();

      if (!stateTimer) {

        stateTimer =
          setInterval(
            () => refreshState(false),
            3000
          );

      }

    } catch (error) {

      console.error(error);

      showLoginError(
        error.message ||
        "Admin login failed."
      );

    }

  };


  const originalLogout = logout;

  logout = function() {

    sessionStorage.removeItem(
      "dy_admin_key"
    );

    ADMIN_KEY = "";

    if (stateTimer) {

      clearInterval(stateTimer);

      stateTimer = null;

    }

    $("app").style.display =
      "none";

    $("loginScreen").style.display =
      "flex";

    $("adminKey").value = "";

  };


  /* -------------------------
     SECURITY / TAB VISIBILITY
  ------------------------- */

  document.addEventListener(
    "visibilitychange",
    () => {

      if (
        !document.hidden &&
        ADMIN_KEY
      ) {
        refreshAll();
      }

    }
  );

</script>

</body>
</html>
