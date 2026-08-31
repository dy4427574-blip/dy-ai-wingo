<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DY AI Pro Admin</title>

<style>
*{box-sizing:border-box}

body{
  margin:0;
  background:#070b16;
  color:#f5f7ff;
  font-family:Arial,sans-serif;
}

.container{
  max-width:900px;
  margin:auto;
  padding:16px;
}

.card{
  background:#10172a;
  border:1px solid #293657;
  border-radius:20px;
  padding:20px;
  margin:13px 0;
  box-shadow:0 12px 35px #0005;
}

.header{
  display:flex;
  justify-content:space-between;
  align-items:center;
  gap:10px;
}

.logo{
  font-size:23px;
  font-weight:900;
}

.badge{
  background:#18233d;
  padding:8px 13px;
  border-radius:50px;
  font-size:12px;
}

input,button,select{
  width:100%;
  padding:13px;
  margin-top:9px;
  border-radius:12px;
  border:1px solid #34405f;
  background:#0b1120;
  color:#fff;
  outline:none;
}

button{
  background:#635bff;
  border:0;
  font-weight:800;
  cursor:pointer;
}

.danger{
  background:#c83b57;
}

.green{
  background:#16885b;
}

.muted{
  color:#9aa7c4;
  font-size:13px;
}

.error{
  color:#ff7285;
}

.success{
  color:#62e6a7;
}

.hidden{
  display:none;
}

.stats{
  display:grid;
  grid-template-columns:repeat(2,1fr);
  gap:10px;
}

.stat{
  background:#0b1120;
  border:1px solid #293657;
  border-radius:15px;
  padding:15px;
}

.stat-title{
  color:#9aa7c4;
  font-size:12px;
}

.stat-value{
  font-size:27px;
  font-weight:900;
  margin-top:6px;
}

.key-row{
  display:grid;
  grid-template-columns:1fr auto;
  gap:10px;
  padding:15px 0;
  border-bottom:1px solid #293657;
}

.key-name{
  font-weight:800;
  word-break:break-all;
}

.details{
  color:#9aa7c4;
  font-size:12px;
  margin-top:6px;
  line-height:1.6;
}

.status{
  display:inline-block;
  padding:5px 9px;
  border-radius:50px;
  font-size:11px;
  font-weight:800;
}

.online{
  background:#123d2e;
  color:#62e6a7;
}

.offline{
  background:#252b3b;
  color:#9aa7c4;
}

.expired{
  background:#43212a;
  color:#ff7285;
}

.disabled{
  background:#382f19;
  color:#ffd166;
}

.actions{
  display:flex;
  gap:6px;
  flex-wrap:wrap;
  align-items:center;
}

.actions button{
  width:auto;
  margin:0;
  padding:8px 10px;
  font-size:11px;
}

@media(max-width:600px){
  .key-row{
    grid-template-columns:1fr;
  }

  .stats{
    grid-template-columns:1fr 1fr;
  }
}
</style>
</head>

<body>

<div class="container">

<!-- LOGIN -->

<div id="loginBox" class="card">

  <div class="logo">
    DY AI Pro Admin
  </div>

  <p class="muted">
    Administrator control panel
  </p>

  <input
    id="adminKey"
    type="password"
    placeholder="Admin key"
  >

  <button onclick="login()">
    UNLOCK ADMIN
  </button>

  <p id="loginMessage"></p>

</div>


<!-- ADMIN -->

<div id="adminPanel" class="hidden">

  <div class="card header">

    <div>
      <div class="logo">
        DY AI Control Center
      </div>

      <div class="muted">
        Live system management
      </div>
    </div>

    <div class="badge">
      ADMIN
    </div>

  </div>


  <!-- SYSTEM -->

  <div class="card">

    <h2>Live System</h2>

    <div class="stats">

      <div class="stat">
        <div class="stat-title">
          TOTAL KEYS
        </div>

        <div
          id="totalKeys"
          class="stat-value"
        >
          0
        </div>
      </div>

      <div class="stat">
        <div class="stat-title">
          ONLINE
        </div>

        <div
          id="onlineKeys"
          class="stat-value"
        >
          0
        </div>
      </div>

      <div class="stat">
        <div class="stat-title">
          OFFLINE
        </div>

        <div
          id="offlineKeys"
          class="stat-value"
        >
          0
        </div>
      </div>

      <div class="stat">
        <div class="stat-title">
          TIMER
        </div>

        <div
          id="timer"
          class="stat-value"
        >
          00:30
        </div>
      </div>

    </div>

  </div>


  <!-- CURRENT ROUND -->

  <div class="card">

    <h2>Current Round</h2>

    <div class="stats">

      <div class="stat">
        <div class="stat-title">
          PERIOD
        </div>

        <div class="stat-value">
          ********
        </div>
      </div>

      <div class="stat">
        <div class="stat-title">
          PREDICTION
        </div>

        <div
          id="prediction"
          class="stat-value"
        >
          —
        </div>
      </div>

      <div class="stat">
        <div class="stat-title">
          NUMBER
        </div>

        <div
          id="number"
          class="stat-value"
        >
          —
        </div>
      </div>

    </div>

    <p
      id="serverStatus"
      class="muted"
    >
      Connecting...
    </p>

  </div>


  <!-- CREATE -->

  <div class="card">

    <h2>Create Access Key</h2>

    <input
      id="newKey"
      placeholder="Custom key (optional)"
    >

    <select id="expiry">

      <option value="0">
        No Expiry
      </option>

      <option value="1">
        1 Day
      </option>

      <option value="7">
        7 Days
      </option>

      <option value="30">
        30 Days
      </option>

      <option value="90">
        90 Days
      </option>

      <option value="365">
        365 Days
      </option>

    </select>

    <button onclick="createKey()">
      CREATE ACCESS KEY
    </button>

    <p id="createMessage"></p>

  </div>


  <!-- KEYS -->

  <div class="card">

    <div class="header">

      <h2>
        User Keys
      </h2>

      <button
        onclick="loadKeys()"
        style="width:auto"
      >
        Refresh
      </button>

    </div>

    <div id="keyList">
      Loading...
    </div>

  </div>


  <div class="card">

    <button
      class="danger"
      onclick="logout()"
    >
      LOGOUT
    </button>

  </div>

</div>

</div>


<script>

let adminToken = "";


/* LOGIN */

async function login(){

  adminToken =
    document
      .getElementById("adminKey")
      .value
      .trim();

  if(!adminToken){

    showLogin(
      "Enter admin key.",
      "error"
    );

    return;
  }

  try{

    const response =
      await fetch(
        "/api/admin/keys",
        {
          cache:"no-store",
          headers:{
            "X-Admin-Key":
              adminToken
          }
        }
      );

    if(!response.ok){
      throw new Error();
    }

    document
      .getElementById("loginBox")
      .classList
      .add("hidden");

    document
      .getElementById("adminPanel")
      .classList
      .remove("hidden");

    await loadAll();

  }catch(error){

    showLogin(
      "Wrong admin key or server unavailable.",
      "error"
    );

    adminToken="";

  }
}


/* LOGIN MESSAGE */

function showLogin(text,type){

  const el =
    document.getElementById(
      "loginMessage"
    );

  el.textContent=text;
  el.className=type;

}


/* LOAD */

async function loadAll(){

  await loadKeys();
  await loadStatus();

}


/* KEYS */

async function loadKeys(){

  try{

    const response =
      await fetch(
        "/api/admin/keys",
        {
          cache:"no-store",
          headers:{
            "X-Admin-Key":
              adminToken
          }
        }
      );

    if(!response.ok){
      throw new Error();
    }

    const data =
      await response.json();

    renderKeys(
      data.keys || []
    );

  }catch(error){

    document
      .getElementById("keyList")
      .innerHTML =
      "<p class='error'>Unable to load keys.</p>";

  }
}


/* RENDER */

function renderKeys(keys){

  document
    .getElementById("totalKeys")
    .textContent =
    keys.length;


  if(!keys.length){

    document
      .getElementById("keyList")
      .innerHTML =
      "<p class='muted'>No keys created.</p>";

    return;
  }


  const box =
    document.getElementById(
      "keyList"
    );

  box.innerHTML="";


  keys.forEach(item => {

    const row =
      document.createElement(
        "div"
      );

    row.className="key-row";


    const left =
      document.createElement(
        "div"
      );


    const name =
      document.createElement(
        "div"
      );

    name.className="key-name";
    name.textContent=item.key;


    const status =
      document.createElement(
        "span"
      );

    status.className="status";


    if(item.status==="ONLINE"){

      status.classList.add(
        "online"
      );

      status.textContent=
        "● ONLINE";

    }
    else if(
      item.status==="EXPIRED"
    ){

      status.classList.add(
        "expired"
      );

      status.textContent=
        "● EXPIRED";

    }
    else if(
      item.active===false
    ){

      status.classList.add(
        "disabled"
      );

      status.textContent=
        "● DISABLED";

    }
    else{

      status.classList.add(
        "offline"
      );

      status.textContent=
        "● OFFLINE";

    }


    const details =
      document.createElement(
        "div"
      );

    details.className="details";

    details.innerHTML =
      "Status: " +
      status.outerHTML +
      "<br>" +
      "Last Seen: " +
      formatTime(
        item.lastSeen
      ) +
      "<br>" +
      "Created: " +
      formatTime(
        item.createdAt
      ) +
      "<br>" +
      "Expiry: " +
      formatExpiry(
        item.expiresAt
      );


    left.appendChild(name);
    left.appendChild(details);


    const actions =
      document.createElement(
        "div"
      );

    actions.className="actions";


    const toggle =
      document.createElement(
        "button"
      );

    toggle.textContent =
      item.active
        ? "DISABLE"
        : "ENABLE";

    toggle.className =
      item.active
        ? "danger"
        : "green";

    toggle.onclick =
      () =>
        toggleKey(
          item.key,
          !item.active
        );


    const del =
      document.createElement(
        "button"
      );

    del.textContent="DELETE";
    del.className="danger";

    del.onclick =
      () =>
        deleteKey(
          item.key
        );


    actions.appendChild(
      toggle
    );

    actions.appendChild(
      del
    );


    row.appendChild(left);
    row.appendChild(actions);

    box.appendChild(row);

  });

}


/* CREATE */

async function createKey(){

  const custom =
    document
      .getElementById("newKey")
      .value
      .trim();

  const days =
    Number(
      document
        .getElementById("expiry")
        .value
    );


  try{

    const response =
      await fetch(
        "/api/admin/keys",
        {
          method:"POST",

          headers:{
            "Content-Type":
              "application/json",

            "X-Admin-Key":
              adminToken
          },

          body:JSON.stringify({
            key:custom,
            days:days
          })
        }
      );


    const data =
      await response.json();


    if(!response.ok){
      throw new Error(
        data.error || "Error"
      );
    }


    document
      .getElementById("newKey")
      .value="";


    document
      .getElementById(
        "createMessage"
      )
      .textContent =
      "Created: " +
      data.key;


    document
      .getElementById(
        "createMessage"
      )
      .className="success";


    await loadKeys();

  }catch(error){

    document
      .getElementById(
        "createMessage"
      )
      .textContent =
      error.message;

    document
      .getElementById(
        "createMessage"
      )
      .className="error";

  }

}


/* ENABLE / DISABLE */

async function toggleKey(
  key,
  active
){

  try{

    const response =
      await fetch(
        "/api/admin/key-status",
        {
          method:"POST",

          headers:{
            "Content-Type":
              "application/json",

            "X-Admin-Key":
              adminToken
          },

          body:JSON.stringify({
            key:key,
            active:active
          })
        }
      );


    if(!response.ok){
      throw new Error();
    }


    await loadKeys();

  }catch(error){

    alert(
      "Unable to change key status."
    );

  }

}


/* DELETE */

async function deleteKey(key){

  if(
    !confirm(
      "Delete key " +
      key +
      "?"
    )
  ){
    return;
  }


  try{

    const response =
      await fetch(
        "/api/admin/keys",
        {
          method:"DELETE",

          headers:{
            "Content-Type":
              "application/json",

            "X-Admin-Key":
              adminToken
          },

          body:JSON.stringify({
            key:key
          })
        }
      );


    if(!response.ok){
      throw new Error();
    }


    await loadKeys();

  }catch(error){

    alert(
      "Unable to delete key."
    );

  }

}


/* SYSTEM STATUS */

async function loadStatus(){

  try{

    const response =
      await fetch(
        "/api/admin/status",
        {
          cache:"no-store",
          headers:{
            "X-Admin-Key":
              adminToken
          }
        }
      );


    if(!response.ok){
      throw new Error();
    }


    const data =
      await response.json();


    document
      .getElementById(
        "onlineKeys"
      )
      .textContent =
      data.onlineKeys;


    document
      .getElementById(
        "offlineKeys"
      )
      .textContent =
      data.offlineKeys;


    document
      .getElementById(
        "prediction"
      )
      .textContent =
      data.prediction;


    document
      .getElementById(
        "number"
      )
      .textContent =
      data.number;


    document
      .getElementById(
        "timer"
      )
      .textContent =
      "00:" +
      String(
        data.countdown
      ).padStart(
        2,
        "0"
      );


    document
      .getElementById(
        "serverStatus"
      )
      .textContent =
      "● Server connected";

    document
      .getElementById(
        "serverStatus"
      )
      .className=
      "success";

  }catch(error){

    document
      .getElementById(
        "serverStatus"
      )
      .textContent =
      "Server connection unavailable";

    document
      .getElementById(
        "serverStatus"
      )
      .className=
      "error";

  }

}


/* TIME */

function formatTime(value){

  if(!value){
    return "Never";
  }

  return new Date(
    value
  ).toLocaleString();

}


function formatExpiry(value){

  if(!value){
    return "Never";
  }

  if(
    Number(value) <=
    Date.now()
  ){
    return "Expired";
  }

  return new Date(
    value
  ).toLocaleString();

}


/* AUTO REFRESH */

setInterval(
  async function(){

    if(adminToken){

      await loadKeys();
      await loadStatus();

    }

  },
  5000
);


/* LOGOUT */

function logout(){

  adminToken="";

  document
    .getElementById(
      "adminPanel"
    )
    .classList
    .add("hidden");

  document
    .getElementById(
      "loginBox"
    )
    .classList
    .remove("hidden");

  document
    .getElementById(
      "adminKey"
    )
    .value="";

}

</script>

</body>
</html>
