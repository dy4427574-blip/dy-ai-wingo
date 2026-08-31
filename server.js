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
    console.log("DB load error:", error.message);
  }
}

function saveDB() {
  try {
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify(db, null, 2)
    );
  } catch (error) {
    console.log("DB save error:", error.message);
  }
}

loadDB();

function normalizeKeys() {
  db.keys = db.keys.map((item) => {
    if (typeof item === "string") {
      return {
        key: item,
        active: true,
        createdAt: Date.now(),
        expiresAt: null,
        lastSeen: null
      };
    }

    return {
      key: item.key,
      active: item.active !== false,
      createdAt: item.createdAt || Date.now(),
      expiresAt:
        item.expiresAt === undefined
          ? null
          : item.expiresAt,
      lastSeen:
        item.lastSeen === undefined
          ? null
          : item.lastSeen
    };
  });
}

normalizeKeys();
saveDB();

function getKey(key) {
  return db.keys.find(
    (item) => item.key === key
  );
}

function isExpired(item) {
  return (
    item.expiresAt !== null &&
    Number(item.expiresAt) <= Date.now()
  );
}

function keyValid(item) {
  return (
    item &&
    item.active === true &&
    !isExpired(item)
  );
}

function getOnlineStatus(item) {
  if (!item.lastSeen) {
    return "OFFLINE";
  }

  return Date.now() - item.lastSeen <= 20000
    ? "ONLINE"
    : "OFFLINE";
}

function getRound() {

  const period =
    Math.floor(Date.now() / 30000);

  const endsAt =
    (period + 1) * 30000;

  if (
    !db.round ||
    db.round.period !== period
  ) {

    /*
     * SIMULATION ONLY.
     * This is not a real Wingo result feed.
     */

    const number =
      crypto.randomInt(0, 10);

    db.round = {
      period,
      number,
      prediction:
        number >= 5
          ? "BIG"
          : "SMALL",
      confidence:
        crypto.randomInt(55, 86),
      endsAt
    };

    saveDB();
  }

  return db.round;
}

function sendJSON(
  res,
  status,
  data
) {

  res.writeHead(status, {
    "Content-Type":
      "application/json; charset=utf-8",

    "Cache-Control":
      "no-store",

    "Access-Control-Allow-Origin":
      "*",

    "Access-Control-Allow-Headers":
      "Content-Type, X-Admin-Key, X-Access-Key"
  });

  res.end(
    JSON.stringify(data)
  );
}

function sendHTML(
  res,
  filename
) {

  const file =
    path.join(__dirname, filename);

  if (!fs.existsSync(file)) {

    res.writeHead(404, {
      "Content-Type":
        "text/plain; charset=utf-8"
    });

    return res.end(
      "File not found: " + filename
    );
  }

  res.writeHead(200, {
    "Content-Type":
      "text/html; charset=utf-8",

    "Cache-Control":
      "no-cache"
  });

  fs.createReadStream(file)
    .pipe(res);
}

function readBody(req) {

  return new Promise(
    (resolve) => {

      let body = "";

      req.on(
        "data",
        (chunk) => {
          body += chunk;
        }
      );

      req.on(
        "end",
        () => {

          try {
            resolve(
              JSON.parse(
                body || "{}"
              )
            );
          } catch {
            resolve({});
          }

        }
      );

    }
  );
}

const server =
  http.createServer(
    async (req, res) => {

      if (
        req.method ===
        "OPTIONS"
      ) {

        res.writeHead(204, {
          "Access-Control-Allow-Origin":
            "*",

          "Access-Control-Allow-Headers":
            "Content-Type, X-Admin-Key, X-Access-Key"
        });

        return res.end();
      }

      const url =
        new URL(
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

        return sendHTML(
          res,
          "prediction.html"
        );
      }

      if (
        url.pathname ===
        "/admin.html"
      ) {

        return sendHTML(
          res,
          "admin.html"
        );
      }


      /*
       * ADMIN AUTH
       */

      function isAdmin() {

        return (
          req.headers[
            "x-admin-key"
          ] === ADMIN_KEY
        );

      }


      /*
       * USER STATE
       */

      if (
        url.pathname ===
          "/api/state" &&
        req.method === "GET"
      ) {

        const accessKey =
          req.headers[
            "x-access-key"
          ];

        const userKey =
          getKey(accessKey);

        if (
          !keyValid(userKey)
        ) {

          return sendJSON(
            res,
            401,
            {
              error:
                "INVALID_OR_DISABLED_KEY"
            }
          );

        }

        userKey.lastSeen =
          Date.now();

        saveDB();

        const round =
          getRound();

        return sendJSON(
          res,
          200,
          {
            period:
              "********",

            countdown:
              Math.max(
                0,
                Math.ceil(
                  (
                    round.endsAt -
                    Date.now()
                  ) / 1000
                )
              ),

            prediction:
              round.prediction,

            number:
              round.number,

            confidence:
              round.confidence
          }
        );
      }


      /*
       * USER HEARTBEAT
       */

      if (
        url.pathname ===
          "/api/heartbeat" &&
        req.method === "POST"
      ) {

        const accessKey =
          req.headers[
            "x-access-key"
          ];

        const userKey =
          getKey(accessKey);

        if (
          !keyValid(userKey)
        ) {

          return sendJSON(
            res,
            401,
            {
              error:
                "INVALID_OR_DISABLED_KEY"
            }
          );

        }

        userKey.lastSeen =
          Date.now();

        saveDB();

        return sendJSON(
          res,
          200,
          {
            success: true,
            status: "ONLINE"
          }
        );
      }


      /*
       * ADMIN - LIST KEYS
       */

      if (
        url.pathname ===
          "/api/admin/keys" &&
        req.method === "GET"
      ) {

        if (!isAdmin()) {

          return sendJSON(
            res,
            401,
            {
              error:
                "UNAUTHORIZED"
            }
          );

        }

        const keys =
          db.keys.map(
            (item) => ({
              key: item.key,

              active:
                item.active,

              status:
                isExpired(item)
                  ? "EXPIRED"
                  : getOnlineStatus(
                      item
                    ),

              createdAt:
                item.createdAt,

              expiresAt:
                item.expiresAt,

              lastSeen:
                item.lastSeen
            })
          );

        return sendJSON(
          res,
          200,
          {
            keys
          }
        );
      }


      /*
       * ADMIN - CREATE KEY
       */

      if (
        url.pathname ===
          "/api/admin/keys" &&
        req.method === "POST"
      ) {

        if (!isAdmin()) {

          return sendJSON(
            res,
            401,
            {
              error:
                "UNAUTHORIZED"
            }
          );

        }

        const body =
          await readBody(req);

        let key =
          String(
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

        const days =
          Number(
            body.days || 0
          );

        const exists =
          getKey(key);

        if (exists) {

          return sendJSON(
            res,
            409,
            {
              error:
                "KEY_ALREADY_EXISTS"
            }
          );

        }

        let expiresAt =
          null;

        if (
          Number.isFinite(days) &&
          days > 0
        ) {

          expiresAt =
            Date.now() +
            days *
              24 *
              60 *
              60 *
              1000;

        }

        const newKey = {
          key,
          active: true,
          createdAt:
            Date.now(),
          expiresAt,
          lastSeen: null
        };

        db.keys.push(
          newKey
        );

        saveDB();

        return sendJSON(
          res,
          200,
          {
            success: true,
            key: newKey
          }
        );
      }


      /*
       * ADMIN - DELETE KEY
       */

      if (
        url.pathname ===
          "/api/admin/keys" &&
        req.method === "DELETE"
      ) {

        if (!isAdmin()) {

          return sendJSON(
            res,
            401,
            {
              error:
                "UNAUTHORIZED"
            }
          );

        }

        const body =
          await readBody(req);

        db.keys =
          db.keys.filter(
            (item) =>
              item.key !==
              body.key
          );

        saveDB();

        return sendJSON(
          res,
          200,
          {
            success: true
          }
        );
      }


      /*
       * ADMIN - ENABLE / DISABLE
       */

      if (
        url.pathname ===
          "/api/admin/key-status" &&
        req.method === "POST"
      ) {

        if (!isAdmin()) {

          return sendJSON(
            res,
            401,
            {
              error:
                "UNAUTHORIZED"
            }
          );

        }

        const body =
          await readBody(req);

        const item =
          getKey(body.key);

        if (!item) {

          return sendJSON(
            res,
            404,
            {
              error:
                "KEY_NOT_FOUND"
            }
          );

        }

        item.active =
          body.active === true;

        saveDB();

        return sendJSON(
          res,
          200,
          {
            success: true,
            active:
              item.active
          }
        );
      }


      /*
       * ADMIN - STATUS
       */

      if (
        url.pathname ===
          "/api/admin/status" &&
        req.method === "GET"
      ) {

        if (!isAdmin()) {

          return sendJSON(
            res,
            401,
            {
              error:
                "UNAUTHORIZED"
            }
          );

        }

        const round =
          getRound();

        const online =
          db.keys.filter(
            (item) =>
              keyValid(item) &&
              getOnlineStatus(
                item
              ) === "ONLINE"
          ).length;

        return sendJSON(
          res,
          200,
          {
            totalKeys:
              db.keys.length,

            onlineKeys:
              online,

            offlineKeys:
              db.keys.length -
              online,

            prediction:
              round.prediction,

            number:
              round.number,

            countdown:
              Math.max(
                0,
                Math.ceil(
                  (
                    round.endsAt -
                    Date.now()
                  ) / 1000
                )
              )
          }
        );
      }


      /*
       * HEALTH
       */

      if (
        url.pathname ===
        "/health"
      ) {

        return sendJSON(
          res,
          200,
          {
            status: "ok",
            service: "DY AI"
          }
        );
      }


      /*
       * 404
       */

      res.writeHead(
        404,
        {
          "Content-Type":
            "text/plain; charset=utf-8"
        }
      );

      res.end(
        "Not Found"
      );

    }
  );


/*
 * SERVER ROUND CLOCK
 */

setInterval(
  () => {
    getRound();
  },
  1000
);

getRound();


server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "DY AI server running on port " +
      PORT
    );
  }
);
