const http = require("http");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "dy4427574";

/*
  In-memory data.
  NOTE: Render Free instances can restart, so production persistence
  should use PostgreSQL rather than local files.
*/

const db = {
  keys: new Map(),
  round: null
};

/*
  --------------------------------------------------
  ROUND ENGINE
  --------------------------------------------------
*/

function getRound() {
  const period = Math.floor(Date.now() / 30000);
  const endsAt = (period + 1) * 30000;

  if (!db.round || db.round.period !== period) {
    const number = crypto.randomInt(0, 10);

    db.round = {
      period,
      number,
      prediction: number >= 5 ? "BIG" : "SMALL",
      confidence: crypto.randomInt(55, 86),
      createdAt: Date.now(),
      endsAt
    };
  }

  return db.round;
}

/*
  --------------------------------------------------
  HELPERS
  --------------------------------------------------
*/

function sendJSON(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "Content-Type, X-Admin-Key, X-Access-Key",
    "Access-Control-Allow-Methods":
      "GET, POST, DELETE, OPTIONS"
  });

  res.end(JSON.stringify(data));
}

function sendHTML(res, filename) {
  const fs = require("fs");
  const path = require("path");

  const file = path.join(__dirname, filename);

  if (!fs.existsSync(file)) {
    return sendJSON(res, 404, {
      error: "FILE_NOT_FOUND",
      file: filename
    });
  }

  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache"
  });

  fs.createReadStream(file).pipe(res);
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk;
    });

    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

function isAdmin(req) {
  return req.headers["x-admin-key"] === ADMIN_KEY;
}

function generateKey() {
  return (
    "DY-" +
    crypto.randomBytes(5).toString("hex").toUpperCase()
  );
}

function getKeyStatus(item) {
  const onlineFor = Date.now() - item.lastSeen;

  return onlineFor <= 90000
    ? "LIVE"
    : "OFFLINE";
}

/*
  --------------------------------------------------
  SERVER
  --------------------------------------------------
*/

const server = http.createServer(async (req, res) => {

  /*
    CORS PREFLIGHT
  */

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers":
        "Content-Type, X-Admin-Key, X-Access-Key",
      "Access-Control-Allow-Methods":
        "GET, POST, DELETE, OPTIONS"
    });

    return res.end();
  }

  const url = new URL(
    req.url,
    `http://${req.headers.host || "localhost"}`
  );

  /*
    ------------------------------------------------
    FRONTEND
    ------------------------------------------------
  */

  if (
    url.pathname === "/" ||
    url.pathname === "/index.html" ||
    url.pathname === "/prediction.html"
  ) {
    return sendHTML(res, "prediction.html");
  }

  if (url.pathname === "/admin.html") {
    return sendHTML(res, "admin.html");
  }

  /*
    ------------------------------------------------
    HEALTH
    ------------------------------------------------
  */

  if (
    url.pathname === "/health" &&
    req.method === "GET"
  ) {
    return sendJSON(res, 200, {
      status: "ok",
      service: "DY AI",
      uptime: process.uptime(),
      time: Date.now()
    });
  }

  /*
    ------------------------------------------------
    USER LOGIN / KEY CHECK
    ------------------------------------------------
  */

  if (
    url.pathname === "/api/key/check" &&
    req.method === "GET"
  ) {

    const accessKey =
      String(req.headers["x-access-key"] || "").trim();

    if (!accessKey || !db.keys.has(accessKey)) {
      return sendJSON(res, 401, {
        valid: false,
        status: "INVALID"
      });
    }

    const item = db.keys.get(accessKey);

    item.lastSeen = Date.now();

    return sendJSON(res, 200, {
      valid: true,
      status: getKeyStatus(item),
      createdAt: item.createdAt,
      lastSeen: item.lastSeen
    });
  }

  /*
    ------------------------------------------------
    USER PREDICTION STATE
    ------------------------------------------------
  */

  if (
    url.pathname === "/api/state" &&
    req.method === "GET"
  ) {

    const accessKey =
      String(req.headers["x-access-key"] || "").trim();

    if (!accessKey || !db.keys.has(accessKey)) {
      return sendJSON(res, 401, {
        error: "INVALID_KEY"
      });
    }

    const keyData = db.keys.get(accessKey);

    keyData.lastSeen = Date.now();

    const round = getRound();

    return sendJSON(res, 200, {
      success: true,

      period:
        String(round.period),

      countdown:
        Math.max(
          0,
          Math.ceil(
            (round.endsAt - Date.now()) / 1000
          )
        ),

      prediction:
        round.prediction,

      number:
        round.number,

      confidence:
        round.confidence,

      keyStatus:
        getKeyStatus(keyData)
    });
  }

  /*
    ------------------------------------------------
    ADMIN - LIST KEYS
    ------------------------------------------------
  */

  if (
    url.pathname === "/api/admin/keys" &&
    req.method === "GET"
  ) {

    if (!isAdmin(req)) {
      return sendJSON(res, 401, {
        error: "UNAUTHORIZED"
      });
    }

    const keys = Array.from(db.keys.entries())
      .map(([key, item]) => ({
        key,
        status: getKeyStatus(item),
        createdAt: item.createdAt,
        lastSeen: item.lastSeen
      }));

    return sendJSON(res, 200, {
      success: true,
      total: keys.length,
      live: keys.filter(k => k.status === "LIVE").length,
      offline: keys.filter(k => k.status === "OFFLINE").length,
      keys
    });
  }

  /*
    ------------------------------------------------
    ADMIN - CREATE KEY
    ------------------------------------------------
  */

  if (
    url.pathname === "/api/admin/keys" &&
    req.method === "POST"
  ) {

    if (!isAdmin(req)) {
      return sendJSON(res, 401, {
        error: "UNAUTHORIZED"
      });
    }

    const body = await readBody(req);

    let key =
      String(body.key || "").trim();

    if (!key) {
      key = generateKey();
    }

    if (db.keys.has(key)) {
      return sendJSON(res, 409, {
        error: "KEY_ALREADY_EXISTS"
      });
    }

    db.keys.set(key, {
      createdAt: Date.now(),
      lastSeen: 0
    });

    return sendJSON(res, 200, {
      success: true,
      key
    });
  }

  /*
    ------------------------------------------------
    ADMIN - DELETE KEY
    ------------------------------------------------
  */

  if (
    url.pathname === "/api/admin/keys" &&
    req.method === "DELETE"
  ) {

    if (!isAdmin(req)) {
      return sendJSON(res, 401, {
        error: "UNAUTHORIZED"
      });
    }

    const body = await readBody(req);

    const key =
      String(body.key || "").trim();

    if (!db.keys.has(key)) {
      return sendJSON(res, 404, {
        error: "KEY_NOT_FOUND"
      });
    }

    db.keys.delete(key);

    return sendJSON(res, 200, {
      success: true,
      deleted: key
    });
  }

  /*
    ------------------------------------------------
    ADMIN - STATUS
    ------------------------------------------------
  */

  if (
    url.pathname === "/api/admin/status" &&
    req.method === "GET"
  ) {

    if (!isAdmin(req)) {
      return sendJSON(res, 401, {
        error: "UNAUTHORIZED"
      });
    }

    const round = getRound();

    const allKeys =
      Array.from(db.keys.entries());

    const live =
      allKeys.filter(
        ([, item]) =>
          getKeyStatus(item) === "LIVE"
      ).length;

    const offline =
      allKeys.length - live;

    return sendJSON(res, 200, {
      success: true,

      server: "LIVE",

      users: allKeys.length,

      live,
      offline,

      round: {
        period: round.period,
        prediction: round.prediction,
        number: round.number,
        confidence: round.confidence,
        countdown: Math.max(
          0,
          Math.ceil(
            (round.endsAt - Date.now()) / 1000
          )
        )
      },

      uptime: process.uptime(),
      timestamp: Date.now()
    });
  }

  /*
    ------------------------------------------------
    ADMIN - PING
    ------------------------------------------------
  */

  if (
    url.pathname === "/api/admin/ping" &&
    req.method === "GET"
  ) {

    if (!isAdmin(req)) {
      return sendJSON(res, 401, {
        error: "UNAUTHORIZED"
      });
    }

    return sendJSON(res, 200, {
      success: true,
      message: "Admin connection active",
      timestamp: Date.now()
    });
  }

  /*
    ------------------------------------------------
    404
    ------------------------------------------------
  */

  return sendJSON(res, 404, {
    error: "NOT_FOUND",
    path: url.pathname
  });
});

/*
  --------------------------------------------------
  ROUND CLOCK
  --------------------------------------------------
*/

setInterval(() => {
  getRound();
}, 1000);

/*
  --------------------------------------------------
  START
  --------------------------------------------------
*/

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "DY AI server running on port " + PORT
    );
  }
);
