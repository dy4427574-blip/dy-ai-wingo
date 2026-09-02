const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "dy4427574";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});

/* --------------------------------------------------
   DATABASE
-------------------------------------------------- */

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS access_keys (
      id SERIAL PRIMARY KEY,
      access_key TEXT UNIQUE NOT NULL,
      device_id TEXT,
      created_at BIGINT NOT NULL,
      last_seen BIGINT DEFAULT 0
    )
  `);

  console.log("Database ready");
}

/* --------------------------------------------------
   ROUND ENGINE
-------------------------------------------------- */

let round = null;

function getRound() {
  const period = Math.floor(Date.now() / 30000);
  const endsAt = (period + 1) * 30000;

  if (!round || round.period !== period) {
    const number = crypto.randomInt(0, 10);

    round = {
      period,
      number,
      prediction: number >= 5 ? "BIG" : "SMALL",
      confidence: crypto.randomInt(55, 86),
      endsAt
    };
  }

  return round;
}

/* --------------------------------------------------
   JSON RESPONSE
-------------------------------------------------- */

function sendJSON(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "Content-Type, X-Admin-Key, X-Access-Key, X-Device-ID",
    "Access-Control-Allow-Methods":
      "GET, POST, DELETE, OPTIONS"
  });

  res.end(JSON.stringify(data));
}

/* --------------------------------------------------
   HTML
-------------------------------------------------- */

function sendHTML(res, filename) {
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

/* --------------------------------------------------
   MUSIC FILE
   Supports MP3 + mobile range requests
-------------------------------------------------- */

function sendMusic(res, req) {
  const file = path.join(__dirname, "music.mp3");

  if (!fs.existsSync(file)) {
    return sendJSON(res, 404, {
      error: "MUSIC_NOT_FOUND",
      path: "/music.mp3"
    });
  }

  const stat = fs.statSync(file);
  const fileSize = stat.size;

  const range = req.headers.range;

  /* Normal request */

  if (!range) {
    res.writeHead(200, {
      "Content-Type": "audio/mpeg",
      "Content-Length": fileSize,
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=3600"
    });

    return fs.createReadStream(file).pipe(res);
  }

  /* Range request */

  const match = range.match(/bytes=(\d*)-(\d*)/);

  if (!match) {
    res.writeHead(416, {
      "Content-Range": `bytes */${fileSize}`
    });

    return res.end();
  }

  let start = match[1]
    ? parseInt(match[1], 10)
    : 0;

  let end = match[2]
    ? parseInt(match[2], 10)
    : fileSize - 1;

  if (Number.isNaN(start)) {
    start = 0;
  }

  if (Number.isNaN(end) || end >= fileSize) {
    end = fileSize - 1;
  }

  if (start > end || start >= fileSize) {
    res.writeHead(416, {
      "Content-Range": `bytes */${fileSize}`
    });

    return res.end();
  }

  const chunkSize =
    end - start + 1;

  res.writeHead(206, {
    "Content-Type": "audio/mpeg",
    "Content-Length": chunkSize,
    "Content-Range":
      `bytes ${start}-${end}/${fileSize}`,
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=3600"
  });

  fs.createReadStream(file, {
    start,
    end
  }).pipe(res);
}

/* --------------------------------------------------
   BODY
-------------------------------------------------- */

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

/* --------------------------------------------------
   ADMIN
-------------------------------------------------- */

function isAdmin(req) {
  return req.headers["x-admin-key"] === ADMIN_KEY;
}

function generateKey() {
  return (
    "DY-" +
    crypto.randomBytes(5).toString("hex").toUpperCase()
  );
}

function keyStatus(item) {
  if (!item.device_id) return "UNBOUND";

  if (
    item.last_seen &&
    Date.now() - Number(item.last_seen) <= 90000
  ) {
    return "LIVE";
  }

  return "OFFLINE";
}

/* --------------------------------------------------
   DEVICE CHECK
-------------------------------------------------- */

async function checkAccessKey(req) {
  const accessKey =
    String(req.headers["x-access-key"] || "").trim();

  const deviceId =
    String(req.headers["x-device-id"] || "").trim();

  if (!accessKey) {
    return {
      ok: false,
      status: 401,
      error: "INVALID_KEY"
    };
  }

  if (!deviceId) {
    return {
      ok: false,
      status: 400,
      error: "DEVICE_ID_REQUIRED"
    };
  }

  const result = await pool.query(
    `
    SELECT *
    FROM access_keys
    WHERE access_key = $1
    `,
    [accessKey]
  );

  if (result.rows.length === 0) {
    return {
      ok: false,
      status: 401,
      error: "INVALID_KEY"
    };
  }

  const item = result.rows[0];

  if (!item.device_id) {
    await pool.query(
      `
      UPDATE access_keys
      SET device_id = $1,
          last_seen = $2
      WHERE access_key = $3
      `,
      [deviceId, Date.now(), accessKey]
    );

    return {
      ok: true,
      key: accessKey,
      deviceId
    };
  }

  if (item.device_id !== deviceId) {
    return {
      ok: false,
      status: 403,
      error: "DEVICE_MISMATCH",
      message:
        "This key is already linked to another device."
    };
  }

  await pool.query(
    `
    UPDATE access_keys
    SET last_seen = $1
    WHERE access_key = $2
    `,
    [Date.now(), accessKey]
  );

  return {
    ok: true,
    key: accessKey,
    deviceId
  };
}

/* --------------------------------------------------
   SERVER
-------------------------------------------------- */

const server = http.createServer(async (req, res) => {

  try {

    /* CORS */

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers":
          "Content-Type, X-Admin-Key, X-Access-Key, X-Device-ID",
        "Access-Control-Allow-Methods":
          "GET, POST, DELETE, OPTIONS"
      });

      return res.end();
    }

    const url = new URL(
      req.url,
      `http://${req.headers.host || "localhost"}`
    );

    /* ------------------------------------------------
       FRONTEND
    ------------------------------------------------ */

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

    /* ------------------------------------------------
       MUSIC
    ------------------------------------------------ */

    if (
      url.pathname === "/music.mp3" &&
      (req.method === "GET" || req.method === "HEAD")
    ) {

      if (req.method === "HEAD") {

        const file =
          path.join(__dirname, "music.mp3");

        if (!fs.existsSync(file)) {
          return sendJSON(res, 404, {
            error: "MUSIC_NOT_FOUND",
            path: "/music.mp3"
          });
        }

        const stat =
          fs.statSync(file);

        res.writeHead(200, {
          "Content-Type": "audio/mpeg",
          "Content-Length": stat.size,
          "Accept-Ranges": "bytes"
        });

        return res.end();
      }

      return sendMusic(res, req);
    }

    /* ------------------------------------------------
       HEALTH
    ------------------------------------------------ */

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

    /* ------------------------------------------------
       KEY CHECK
    ------------------------------------------------ */

    if (
      url.pathname === "/api/key/check" &&
      req.method === "GET"
    ) {

      const auth =
        await checkAccessKey(req);

      if (!auth.ok) {
        return sendJSON(res, auth.status, {
          valid: false,
          error: auth.error,
          message:
            auth.message ||
            "Access denied"
        });
      }

      const result =
        await pool.query(
          `
          SELECT *
          FROM access_keys
          WHERE access_key = $1
          `,
          [auth.key]
        );

      const item =
        result.rows[0];

      return sendJSON(res, 200, {
        valid: true,
        status: keyStatus(item),
        deviceBound: !!item.device_id,
        createdAt:
          Number(item.created_at),
        lastSeen:
          Number(item.last_seen || 0)
      });

    }

    /* ------------------------------------------------
       USER STATE
    ------------------------------------------------ */

    if (
      url.pathname === "/api/state" &&
      req.method === "GET"
    ) {

      const auth =
        await checkAccessKey(req);

      if (!auth.ok) {
        return sendJSON(res, auth.status, {
          success: false,
          error: auth.error,
          message:
            auth.message ||
            "Access denied"
        });
      }

      const current =
        getRound();

      return sendJSON(res, 200, {
        success: true,

        period:
          String(current.period),

        countdown:
          Math.max(
            0,
            Math.ceil(
              (current.endsAt -
                Date.now()) / 1000
            )
          ),

        prediction:
          current.prediction,

        number:
          current.number,

        confidence:
          current.confidence,

        keyStatus:
          "LIVE"
      });

    }

    /* ------------------------------------------------
       ADMIN LIST KEYS
    ------------------------------------------------ */

    if (
      url.pathname === "/api/admin/keys" &&
      req.method === "GET"
    ) {

      if (!isAdmin(req)) {
        return sendJSON(res, 401, {
          error: "UNAUTHORIZED"
        });
      }

      const result =
        await pool.query(`
          SELECT
            access_key,
            device_id,
            created_at,
            last_seen
          FROM access_keys
          ORDER BY id DESC
        `);

      const keys =
        result.rows.map(item => ({
          key:
            item.access_key,

          deviceId:
            item.device_id || null,

          status:
            keyStatus(item),

          createdAt:
            Number(item.created_at),

          lastSeen:
            Number(item.last_seen || 0)
        }));

      return sendJSON(res, 200, {
        success: true,
        total:
          keys.length,

        live:
          keys.filter(
            k => k.status === "LIVE"
          ).length,

        offline:
          keys.filter(
            k => k.status === "OFFLINE"
          ).length,

        unbound:
          keys.filter(
            k => k.status === "UNBOUND"
          ).length,

        keys
      });

    }

    /* ------------------------------------------------
       ADMIN CREATE KEY
    ------------------------------------------------ */

    if (
      url.pathname === "/api/admin/keys" &&
      req.method === "POST"
    ) {

      if (!isAdmin(req)) {
        return sendJSON(res, 401, {
          error: "UNAUTHORIZED"
        });
      }

      const body =
        await readBody(req);

      let key =
        String(
          body.key || ""
        ).trim();

      if (!key) {
        key =
          generateKey();
      }

      try {

        await pool.query(
          `
          INSERT INTO access_keys
          (
            access_key,
            device_id,
            created_at,
            last_seen
          )
          VALUES
          ($1, NULL, $2, 0)
          `,
          [key, Date.now()]
        );

      } catch (error) {

        if (error.code === "23505") {
          return sendJSON(res, 409, {
            error:
              "KEY_ALREADY_EXISTS"
          });
        }

        throw error;
      }

      return sendJSON(res, 200, {
        success: true,
        key
      });

    }

    /* ------------------------------------------------
       ADMIN DELETE KEY
    ------------------------------------------------ */

    if (
      url.pathname === "/api/admin/keys" &&
      req.method === "DELETE"
    ) {

      if (!isAdmin(req)) {
        return sendJSON(res, 401, {
          error: "UNAUTHORIZED"
        });
      }

      const body =
        await readBody(req);

      const key =
        String(
          body.key || ""
        ).trim();

      const result =
        await pool.query(
          `
          DELETE FROM access_keys
          WHERE access_key = $1
          `,
          [key]
        );

      if (result.rowCount === 0) {
        return sendJSON(res, 404, {
          error:
            "KEY_NOT_FOUND"
        });
      }

      return sendJSON(res, 200, {
        success: true,
        deleted: key
      });

    }

    /* ------------------------------------------------
       ADMIN RESET DEVICE
    ------------------------------------------------ */

    if (
      url.pathname === "/api/admin/reset-device" &&
      req.method === "POST"
    ) {

      if (!isAdmin(req)) {
        return sendJSON(res, 401, {
          error: "UNAUTHORIZED"
        });
      }

      const body =
        await readBody(req);

      const key =
        String(
          body.key || ""
        ).trim();

      if (!key) {
        return sendJSON(res, 400, {
          error:
            "KEY_REQUIRED"
        });
      }

      const result =
        await pool.query(
          `
          UPDATE access_keys
          SET device_id = NULL,
              last_seen = 0
          WHERE access_key = $1
          `,
          [key]
        );

      if (result.rowCount === 0) {
        return sendJSON(res, 404, {
          error:
            "KEY_NOT_FOUND"
        });
      }

      return sendJSON(res, 200, {
        success: true,
        message:
          "Device binding has been reset."
      });

    }

    /* ------------------------------------------------
       ADMIN STATUS
    ------------------------------------------------ */

    if (
      url.pathname === "/api/admin/status" &&
      req.method === "GET"
    ) {

      if (!isAdmin(req)) {
        return sendJSON(res, 401, {
          error:
            "UNAUTHORIZED"
        });
      }

      const result =
        await pool.query(`
          SELECT *
          FROM access_keys
        `);

      const users =
        result.rows.length;

      const live =
        result.rows.filter(
          item =>
            keyStatus(item) === "LIVE"
        ).length;

      const offline =
        result.rows.filter(
          item =>
            keyStatus(item) === "OFFLINE"
        ).length;

      const unbound =
        result.rows.filter(
          item =>
            keyStatus(item) === "UNBOUND"
        ).length;

      const current =
        getRound();

      const countdown =
        Math.max(
          0,
          Math.ceil(
            (current.endsAt -
              Date.now()) / 1000
          )
        );

      return sendJSON(res, 200, {

        success: true,

        server:
          "LIVE",

        users,

        live,
        offline,
        unbound,

        prediction:
          current.prediction,

        number:
          current.number,

        countdown,

        round: {
          period:
            current.period,

          prediction:
            current.prediction,

          number:
            current.number,

          confidence:
            current.confidence,

          countdown
        },

        uptime:
          process.uptime(),

        timestamp:
          Date.now()
      });

    }

    /* ------------------------------------------------
       ADMIN PING
    ------------------------------------------------ */

    if (
      url.pathname === "/api/admin/ping" &&
      req.method === "GET"
    ) {

      if (!isAdmin(req)) {
        return sendJSON(res, 401, {
          error:
            "UNAUTHORIZED"
        });
      }

      return sendJSON(res, 200, {
        success: true,
        message:
          "Admin connection active",
        timestamp:
          Date.now()
      });

    }

    /* ------------------------------------------------
       404
    ------------------------------------------------ */

    return sendJSON(res, 404, {
      error:
        "NOT_FOUND",
      path:
        url.pathname
    });

  } catch (error) {

    console.error(
      "SERVER ERROR:",
      error
    );

    return sendJSON(res, 500, {
      error:
        "INTERNAL_SERVER_ERROR",
      message:
        "Server error"
    });

  }

});

/* --------------------------------------------------
   ROUND CLOCK
-------------------------------------------------- */

setInterval(() => {
  getRound();
}, 1000);

/* --------------------------------------------------
   START
-------------------------------------------------- */

async function start() {

  try {

    await initDB();

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

  } catch (error) {

    console.error(
      "Database startup failed:",
      error
    );

    process.exit(1);
  }
}

start();
