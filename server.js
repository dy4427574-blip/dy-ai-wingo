"use strict";

const express = require("express");
const path = require("path");

const app = express();

const PORT = Number(process.env.PORT || 10000);

const WINGOBOT_TOKEN =
  String(process.env.WINGOBOT_TOKEN || "").trim();

const ADMIN_KEY =
  String(process.env.ADMIN_KEY || "").trim();

const API_URL =
  "https://api.wingobot.com/v2/1-min-game-history";

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname)));

function authError(res, message) {
  return res.status(500).json({
    success: false,
    error: message
  });
}

/* =====================================================
   HEALTH
===================================================== */

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    game: "Wingo 1 Minute",
    apiConfigured: Boolean(WINGOBOT_TOKEN),
    serverTime: new Date().toISOString()
  });
});

/* =====================================================
   WINGOBOT API
===================================================== */

app.get("/api/history", async (req, res) => {
  try {
    if (!WINGOBOT_TOKEN) {
      return authError(
        res,
        "WINGOBOT_TOKEN environment variable is not configured."
      );
    }

    const response = await fetch(API_URL, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${WINGOBOT_TOKEN}`,
        "Accept": "application/json",
        "User-Agent": "DY-AI-Wingo-1Min/1.0"
      }
    });

    const text = await response.text();

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      return res.status(502).json({
        success: false,
        error: "WingoBot returned a non-JSON response.",
        status: response.status
      });
    }

    if (!response.ok) {
      return res.status(response.status).json({
        success: false,
        error:
          data?.error ||
          data?.message ||
          "WingoBot API request failed."
      });
    }

    if (data.success === false) {
      return res.status(502).json({
        success: false,
        error: data.error || "WingoBot API returned an error."
      });
    }

    const history = Array.isArray(data.history)
      ? data.history
      : [];

    const cleanHistory = history
      .map((row) => {
        const number = Number(row.number);

        let size = null;

        if (Number.isFinite(number)) {
          if (number >= 0 && number <= 4) {
            size = "SMALL";
          } else if (number >= 5 && number <= 9) {
            size = "BIG";
          }
        }

        return {
          issueNumber:
            row.issueNumber ??
            row.period ??
            row.periodId ??
            null,

          number: Number.isFinite(number)
            ? number
            : null,

          colour: row.colour ?? null,

          premium: row.premium ?? null,

          sum: row.sum ?? null,

          size
        };
      })
      .filter((row) => row.number !== null);

    res.json({
      success: true,

      current: {
        issueNumber:
          data?.current?.issueNumber ??
          cleanHistory[0]?.issueNumber ??
          null
      },

      history: cleanHistory,

      stats: {
        fetched:
          data?.stats?.fetched ??
          cleanHistory.length,

        last_updated:
          data?.stats?.last_updated ??
          new Date().toISOString()
      },

      source: "WingoBot 1-Minute API"
    });

  } catch (error) {
    console.error("API ERROR:", error);

    res.status(500).json({
      success: false,
      error: "Unable to connect to WingoBot API."
    });
  }
});

/* =====================================================
   SERVER-SIDE ADMIN STATUS
===================================================== */

app.post("/api/admin/check", (req, res) => {
  const key = String(req.body?.key || "").trim();

  if (!ADMIN_KEY) {
    return res.status(500).json({
      success: false,
      error: "ADMIN_KEY is not configured."
    });
  }

  if (key !== ADMIN_KEY) {
    return res.status(401).json({
      success: false,
      error: "Invalid admin key."
    });
  }

  res.json({
    success: true,
    message: "Admin authentication successful."
  });
});

/* =====================================================
   PAGES
===================================================== */

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "prediction.html"));
});

app.get("/prediction", (req, res) => {
  res.sendFile(path.join(__dirname, "prediction.html"));
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

/* =====================================================
   404
===================================================== */

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Route not found."
  });
});

/* =====================================================
   START
===================================================== */

app.listen(PORT, () => {
  console.log("======================================");
  console.log(" DY AI WINGO 1-MINUTE SERVER");
  console.log("======================================");
  console.log(`PORT: ${PORT}`);
  console.log(`API: ${API_URL}`);
  console.log(
    `WINGOBOT TOKEN: ${WINGOBOT_TOKEN ? "CONFIGURED" : "NOT CONFIGURED"}`
  );
  console.log(
    `ADMIN KEY: ${ADMIN_KEY ? "CONFIGURED" : "NOT CONFIGURED"}`
  );
  console.log("======================================");
});
