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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));


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
   1 MINUTE HISTORY
===================================================== */

app.get("/api/history", async (req, res) => {

  try {

    if (!WINGOBOT_TOKEN) {

      return res.status(500).json({
        success: false,
        error: "WINGOBOT_TOKEN is not configured."
      });

    }


    const response = await fetch(API_URL, {

      method: "GET",

      headers: {
        "Authorization":
          `Bearer ${WINGOBOT_TOKEN}`,

        "Accept":
          "application/json",

        "User-Agent":
          "DY-AI-Wingo-1Min/1.0"
      }

    });


    const text =
      await response.text();


    let data;

    try {

      data = JSON.parse(text);

    } catch {

      return res.status(502).json({
        success: false,
        error:
          "WingoBot returned invalid JSON.",
        status:
          response.status
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
        error:
          data.error ||
          "WingoBot API returned an error."
      });

    }


    const rawHistory =
      Array.isArray(data.history)
        ? data.history
        : [];


    const history =
      rawHistory
        .map((row) => {

          const number =
            Number(row.number);


          let size = null;


          if (
            Number.isFinite(number) &&
            number >= 0 &&
            number <= 9
          ) {

            size =
              number <= 4
                ? "SMALL"
                : "BIG";

          }


          return {

            issueNumber:
              row.issueNumber ??
              row.period ??
              row.periodId ??
              null,

            number:
              Number.isFinite(number)
                ? number
                : null,

            colour:
              row.colour ?? null,

            premium:
              row.premium ?? null,

            sum:
              row.sum ?? null,

            size

          };

        })
        .filter(
          row =>
            row.number !== null &&
            row.size !== null
        );


    /*
     * IMPORTANT:
     *
     * Keep API current period separately.
     * It may represent the current/next round.
     */

    const apiCurrentPeriod =
      data?.current?.issueNumber ??
      data?.current?.period ??
      data?.current?.periodId ??
      null;


    res.json({

      success: true,

      current: {
        issueNumber:
          apiCurrentPeriod
      },

      history,

      stats: {

        fetched:
          data?.stats?.fetched ??
          history.length,

        last_updated:
          data?.stats?.last_updated ??
          new Date().toISOString()

      }

    });

  }
  catch (error) {

    console.error(
      "WINGOBOT ERROR:",
      error
    );

    res.status(500).json({

      success: false,

      error:
        "Unable to connect to WingoBot."

    });

  }

});


/* =====================================================
   ADMIN CHECK
===================================================== */

app.post("/api/admin/check", (req, res) => {

  const key =
    String(
      req.body?.key || ""
    ).trim();


  if (!ADMIN_KEY) {

    return res.status(500).json({

      success: false,

      error:
        "ADMIN_KEY is not configured."

    });

  }


  if (key !== ADMIN_KEY) {

    return res.status(401).json({

      success: false,

      error:
        "Invalid admin key."

    });

  }


  res.json({

    success: true

  });

});


/* =====================================================
   PAGES
===================================================== */

app.get("/", (req, res) => {

  res.sendFile(
    path.join(
      __dirname,
      "prediction.html"
    )
  );

});


app.get("/prediction", (req, res) => {

  res.sendFile(
    path.join(
      __dirname,
      "prediction.html"
    )
  );

});


app.get("/admin", (req, res) => {

  res.sendFile(
    path.join(
      __dirname,
      "admin.html"
    )
  );

});


/* =====================================================
   404
===================================================== */

app.use((req, res) => {

  res.status(404).json({

    success: false,

    error:
      "Route not found."

  });

});


/* =====================================================
   START
===================================================== */

app.listen(PORT, () => {

  console.log(
    "===================================="
  );

  console.log(
    " DY AI WINGO 1 MINUTE"
  );

  console.log(
    "===================================="
  );

  console.log(
    "PORT:",
    PORT
  );

  console.log(
    "API:",
    API_URL
  );

  console.log(
    "TOKEN:",
    WINGOBOT_TOKEN
      ? "CONFIGURED"
      : "NOT CONFIGURED"
  );

  console.log(
    "ADMIN:",
    ADMIN_KEY
      ? "CONFIGURED"
      : "NOT CONFIGURED"
  );

});
