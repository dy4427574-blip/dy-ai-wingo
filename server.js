const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "dy4427574";

const DB_FILE = path.join(__dirname, "data.json");

let db = {
  keys: [],
  round: null
};

try {
  if (fs.existsSync(DB_FILE)) {
    db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  }
} catch (e) {
  db = { keys: [], round: null };
}

function saveDB() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.log("Database save error:", e.message);
  }
}

function createRound() {
  const period = Math.floor(Date.now() / 30000);

  if (!db.round || db.round.period !== period) {
    const number = crypto.randomInt(0, 10);

    db.round = {
      period: period,
      number: number,
      prediction: number >= 5 ? "BIG" : "SMALL",
      confidence: 55 + crypto.randomInt(0, 31),
      endsAt: (period + 1) * 30000
    };

    saveDB();
  }

  return db.round;
}

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "Content-Type, X-Admin-Key, X-Access-Key"
  });

  res.end(JSON.stringify(data));
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

const server = http.createServer(async (req, res) => {

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers":
        "Content-Type, X-Admin-Key, X-Access-Key"
    });

    return res.end();
  }

  /* USER: CURRENT PREDICTION */

  if (req.url === "/api/state" && req.method === "GET") {

    const accessKey = req.headers["x-access-key"];

    if (!accessKey || !db.keys.includes(accessKey)) {
      return json(res, 401, {
        error: "INVALID_KEY"
      });
    }

    const round = createRound();

    return json(res, 200, {
      period: "********",
      countdown: Math.max(
        0,
        Math.ceil((round.endsAt - Date.now()) / 1000)
      ),
      prediction: round.prediction,
      number: round.number,
      confidence: round.confidence
    });
  }

  /* ADMIN: LIST KEYS */

  if (req.url === "/api/admin/keys" && req.method === "GET") {

    if (req.headers["x-admin-key"] !== ADMIN_KEY) {
      return json(res, 401, {
        error: "UNAUTHORIZED"
      });
    }

    return json(res, 200, {
      keys: db.keys
    });
  }

  /* ADMIN: CREATE KEY */

  if (req.url === "/api/admin/keys" && req.method === "POST") {

    if (req.headers["x-admin-key"] !== ADMIN_KEY) {
      return json(res, 401, {
        error: "UNAUTHORIZED"
      });
    }

    const body = await readBody(req);

    let key = String(body.key || "").trim();

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

    return json(res, 200, {
      success: true,
      key: key,
      keys: db.keys
    });
  }

  /* ADMIN: DELETE KEY */

  if (req.url === "/api/admin/keys" && req.method === "DELETE") {

    if (req.headers["x-admin-key"] !== ADMIN_KEY) {
      return json(res, 401, {
        error: "UNAUTHORIZED"
      });
    }

    const body = await readBody(req);

    db.keys = db.keys.filter(
      key => key !== body.key
    );

    saveDB();

    return json(res, 200, {
      success: true,
      keys: db.keys
    });
  }

  /* ADMIN: APP STATUS */

  if (req.url === "/api/admin/status" && req.method === "GET") {

    if (req.headers["x-admin-key"] !== ADMIN_KEY) {
      return json(res, 401, {
        error: "UNAUTHORIZED"
      });
    }

    const round = createRound();

    return json(res, 200, {
      users: db.keys.length,
      prediction: round.prediction,
      number: round.number,
      countdown: Math.max(
        0,
        Math.ceil((round.endsAt - Date.now()) / 1000)
      )
    });
  }

  /* FRONTEND FILES */

  let file;

  if (req.url === "/" || req.url === "/prediction.html") {
    file = path.join(__dirname, "prediction.html");
  } else if (req.url === "/admin.html") {
    file = path.join(__dirname, "admin.html");
  }

  if (file && fs.existsSync(file)) {

    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8"
    });

    return fs.createReadStream(file).pipe(res);
  }

  res.writeHead(404, {
    "Content-Type": "text/plain"
  });

  res.end("Not Found");
});

/* SERVER-SIDE 30 SECOND CLOCK */

setInterval(() => {
  createRound();
}, 1000);

createRound();

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `DY AI server running on port ${PORT}`
  );
});
