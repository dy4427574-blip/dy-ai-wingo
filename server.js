const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "dy4427574";

const DATA_FILE = path.join(__dirname, "data.json");

let db = {
  keys: [],
  round: null
};

function loadDB() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const saved = JSON.parse(
        fs.readFileSync(DATA_FILE, "utf8")
      );

      if (Array.isArray(saved.keys)) {
        db.keys = saved.keys;
      }

      if (saved.round) {
        db.round = saved.round;
      }
    }
  } catch (error) {
    console.log("Database load error:", error.message);
  }
}

function saveDB() {
  try {
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify(db, null, 2)
    );
  } catch (error) {
    console.log("Database save error:", error.message);
  }
}

loadDB();

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
      endsAt
    };

    saveDB();
  }

  return db.round;
}

function sendJSON(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "Content-Type, X-Admin-Key, X-Access-Key"
  });

  res.end(JSON.stringify(data));
}

function sendHTML(res, filename) {
  const file = path.join(__dirname, filename);

  if (!fs.existsSync(file)) {
    res.writeHead(404, {
      "Content-Type": "text/plain; charset=utf-8"
    });

    res.end("File not found: " + filename);
    return;
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

    req.on("data", (chunk) => {
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

const server = http.createServer(async (req, res) => {

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers":
        "Content-Type, X-Admin-Key, X-Access-Key"
    });

    return res.end();
  }

  const url = new URL(
    req.url,
    `http://${req.headers.host || "localhost"}`
  );

  /*
   * FRONTEND
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
   * USER PREDICTION
   */

  if (
    url.pathname === "/api/state" &&
    req.method === "GET"
  ) {

    const accessKey =
      req.headers["x-access-key"];

    if (
      !accessKey ||
      !db.keys.includes(accessKey)
    ) {
      return sendJSON(res, 401, {
        error: "INVALID_KEY"
      });
    }

    const round = getRound();

    return sendJSON(res, 200, {
      period: "********",
      countdown: Math.max(
        0,
        Math.ceil(
          (round.endsAt - Date.now()) / 1000
        )
      ),
      prediction: round.prediction,
      number: round.number,
      confidence: round.confidence
    });
  }

  /*
   * ADMIN AUTH
   */

  function isAdmin() {
    return (
      req.headers["x-admin-key"] === ADMIN_KEY
    );
  }

  /*
   * ADMIN - LIST KEYS
   */

  if (
    url.pathname === "/api/admin/keys" &&
    req.method === "GET"
  ) {

    if (!isAdmin()) {
      return sendJSON(res, 401, {
        error: "UNAUTHORIZED"
      });
    }

    return sendJSON(res, 200, {
      keys: db.keys
    });
  }

  /*
   * ADMIN - CREATE KEY
   */

  if (
    url.pathname === "/api/admin/keys" &&
    req.method === "POST"
  ) {

    if (!isAdmin()) {
      return sendJSON(res, 401, {
        error: "UNAUTHORIZED"
      });
    }

    const body = await readBody(req);

    let key = String(
      body.key || ""
    ).trim();

    if (!key) {
      key =
        "DY-" +
        crypto
          .randomBytes(5)
          .toString("hex")
          .toUpperCase();
    }

    if (!db.keys.includes(key)) {
      db.keys.push(key);
      saveDB();
    }

    return sendJSON(res, 200, {
      success: true,
      key,
      keys: db.keys
    });
  }

  /*
   * ADMIN - DELETE KEY
   */

  if (
    url.pathname === "/api/admin/keys" &&
    req.method === "DELETE"
  ) {

    if (!isAdmin()) {
      return sendJSON(res, 401, {
        error: "UNAUTHORIZED"
      });
    }

    const body = await readBody(req);

    db.keys = db.keys.filter(
      (key) => key !== body.key
    );

    saveDB();

    return sendJSON(res, 200, {
      success: true,
      keys: db.keys
    });
  }

  /*
   * ADMIN - STATUS
   */

  if (
    url.pathname === "/api/admin/status" &&
    req.method === "GET"
  ) {

    if (!isAdmin()) {
      return sendJSON(res, 401, {
        error: "UNAUTHORIZED"
      });
    }

    const round = getRound();

    return sendJSON(res, 200, {
      users: db.keys.length,
      prediction: round.prediction,
      number: round.number,
      countdown: Math.max(
        0,
        Math.ceil(
          (round.endsAt - Date.now()) / 1000
        )
      )
    });
  }

  /*
   * HEALTH CHECK
   */

  if (
    url.pathname === "/health"
  ) {
    return sendJSON(res, 200, {
      status: "ok",
      service: "DY AI"
    });
  }

  res.writeHead(404, {
    "Content-Type":
      "text/plain; charset=utf-8"
  });

  res.end("Not Found");
});

/*
 * Keep server-side round clock running.
 */

setInterval(() => {
  getRound();
}, 1000);

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "DY AI server running on port " + PORT
    );
  }
);
