"use strict";

/*
============================================================
                 DY AI WINGO SERVER
        TASHAN-WIN HUMAN PATTERN MATCH ENGINE
============================================================

A = SMALL
B = BIG

0-4 = SMALL
5-9 = BIG

MAIN RULE:

1. Live history -> A/B
2. Last history ko 25 master patterns se compare
3. Har pattern ka opposite automatically generate
4. EXACT MATCH ko highest priority
5. Exact match hone par:
      A / SMALL -> B / BIG
      B / BIG   -> A / SMALL
6. Multiple exact matches:
      longest pattern wins
7. Same length:
      ORIGINAL priority
8. Partial match:
      WATCH ONLY
      prediction = null
9. No pattern:
      prediction = null

IMPORTANT:
Historical pattern analysis only.
No result is guaranteed.
============================================================
*/


const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { Pool } = require("pg");


// ============================================================
// CONFIG
// ============================================================

const PORT =
    Number(process.env.PORT || 10000);

const ADMIN_KEY =
    String(process.env.ADMIN_KEY || "").trim();

const WINGOBOT_TOKEN =
    String(process.env.WINGOBOT_TOKEN || "").trim();

const DATABASE_URL =
    String(process.env.DATABASE_URL || "").trim();

const WINGOBOT_API =
    "https://api.wingobot.com/v2/30-sec-game-history";

const MODEL_VERSION =
    "DY-AI-TASHAN-PATTERN-V6";

const THINKING_DURATION_MS =
    3000;

const PROVIDER_REFRESH_MS =
    3000;

const REQUEST_TIMEOUT_MS =
    12000;


// ============================================================
// DATABASE
// ============================================================

let pool = null;


if (DATABASE_URL) {

    pool = new Pool({

        connectionString:
            DATABASE_URL,

        ssl:
            DATABASE_URL.includes("localhost")
                ? false
                : {
                    rejectUnauthorized: false
                }

    });

}


// ============================================================
// DATABASE INIT
// ============================================================

async function initDatabase() {

    if (!pool) {

        console.log(
            "[DB] DATABASE_URL not configured"
        );

        return;
    }


    await pool.query(`
        CREATE TABLE IF NOT EXISTS access_keys (
            id SERIAL PRIMARY KEY,
            access_key TEXT UNIQUE NOT NULL,
            device_id TEXT,
            created_at BIGINT NOT NULL,
            last_seen BIGINT DEFAULT 0
        );
    `);


    await pool.query(`
        CREATE TABLE IF NOT EXISTS prediction_records (
            id SERIAL PRIMARY KEY,
            target_issue TEXT NOT NULL,
            prediction TEXT NOT NULL,
            confidence INTEGER DEFAULT 0,
            model_version TEXT,
            actual_number INTEGER,
            actual_result TEXT,
            created_at BIGINT NOT NULL,
            settled_at BIGINT
        );
    `);


    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_prediction_issue
        ON prediction_records(target_issue);
    `);


    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_prediction_created
        ON prediction_records(created_at DESC);
    `);


    console.log("[DB] Database ready");

}


// ============================================================
// GLOBAL STATE
// ============================================================

let providerState = {

    ok: false,

    currentIssue: null,

    history: [],

    fetched: 0,

    lastUpdated: 0,

    error: null

};


let modelCache = {

    targetIssue: null,

    prediction: null,

    generatedAt: 0

};


let refreshInProgress = false;


// ============================================================
// BASIC HELPERS
// ============================================================

function now() {

    return Date.now();

}


function numberToSide(number) {

    const n =
        Number(number);


    if (
        !Number.isInteger(n) ||
        n < 0 ||
        n > 9
    ) {

        return null;

    }


    if (n <= 4) {

        return "A";

    }


    return "B";

}


function sideToLabel(side) {

    if (side === "A") {

        return "SMALL";

    }


    if (side === "B") {

        return "BIG";

    }


    return null;

}


function labelToSide(label) {

    const value =
        String(label || "")
            .toUpperCase()
            .trim();


    if (value === "SMALL") {

        return "A";

    }


    if (value === "BIG") {

        return "B";

    }


    return null;

}


function incrementIssue(issue) {

    if (
        issue === null ||
        issue === undefined
    ) {

        return null;

    }


    const value =
        String(issue);


    if (
        !/^\d+$/.test(value)
    ) {

        return null;

    }


    try {

        return (
            BigInt(value) + 1n
        )
            .toString()
            .padStart(
                value.length,
                "0"
            );

    } catch {

        return null;

    }

}


function compareIssue(a, b) {

    try {

        const aa =
            BigInt(String(a));

        const bb =
            BigInt(String(b));


        if (aa > bb) {

            return 1;

        }


        if (aa < bb) {

            return -1;

        }


        return 0;

    } catch {

        return 0;

    }

}


function randomKey() {

    return (
        "DY-" +
        crypto
            .randomBytes(12)
            .toString("hex")
            .toUpperCase()
    );

}


// ============================================================
// JSON RESPONSE
// ============================================================

function json(res, status, data) {

    const body =
        JSON.stringify(data);


    res.writeHead(

        status,

        {

            "Content-Type":
                "application/json; charset=utf-8",

            "Cache-Control":
                "no-store",

            "Access-Control-Allow-Origin":
                "*",

            "Access-Control-Allow-Headers":
                "Content-Type, X-Access-Key, X-Device-Id, X-Admin-Key",

            "Access-Control-Allow-Methods":
                "GET, POST, DELETE, OPTIONS"

        }

    );


    res.end(body);

}


function text(
    res,
    status,
    body,
    contentType =
        "text/plain; charset=utf-8"
) {

    res.writeHead(

        status,

        {

            "Content-Type":
                contentType,

            "Cache-Control":
                "no-store"

        }

    );


    res.end(body);

}


// ============================================================
// READ REQUEST BODY
// ============================================================

function readBody(req) {

    return new Promise(

        (resolve, reject) => {

            let data = "";


            req.on(
                "data",
                chunk => {

                    data += chunk;


                    if (
                        data.length >
                        1024 * 1024
                    ) {

                        reject(
                            new Error(
                                "Request body too large"
                            )
                        );

                        req.destroy();

                    }

                }
            );


            req.on(
                "end",
                () => {

                    if (!data) {

                        resolve({});

                        return;

                    }


                    try {

                        resolve(
                            JSON.parse(data)
                        );

                    } catch {

                        resolve({});

                    }

                }
            );


            req.on(
                "error",
                reject
            );

        }

    );

}


// ============================================================
// WINGOBOT REQUEST
// ============================================================

function fetchWingoBot() {

    return new Promise(

        (resolve, reject) => {

            if (!WINGOBOT_TOKEN) {

                reject(
                    new Error(
                        "WINGOBOT_TOKEN missing"
                    )
                );

                return;

            }


            const request =
                https.request(

                    WINGOBOT_API,

                    {

                        method: "GET",

                        timeout:
                            REQUEST_TIMEOUT_MS,

                        headers: {

                            Authorization:
                                `Bearer ${WINGOBOT_TOKEN}`,

                            Accept:
                                "application/json",

                            "User-Agent":
                                "DY-AI-Wingo/6.0"

                        }

                    },

                    response => {

                        let body = "";


                        response.on(
                            "data",
                            chunk => {

                                body += chunk;

                            }
                        );


                        response.on(
                            "end",
                            () => {

                                if (
                                    response.statusCode < 200 ||
                                    response.statusCode >= 300
                                ) {

                                    reject(
                                        new Error(
                                            `WingoBot HTTP ${response.statusCode}`
                                        )
                                    );

                                    return;

                                }


                                try {

                                    const parsed =
                                        JSON.parse(
                                            body
                                        );

                                    resolve(
                                        parsed
                                    );

                                } catch {

                                    reject(
                                        new Error(
                                            "Invalid WingoBot JSON"
                                        )
                                    );

                                }

                            }
                        );

                    }

                );


            request.on(
                "timeout",
                () => {

                    request.destroy(
                        new Error(
                            "WingoBot request timeout"
                        )
                    );

                }
            );


            request.on(
                "error",
                reject
            );


            request.end();

        }

    );

}


// ============================================================
// NORMALIZE HISTORY
// ============================================================

function normalizeHistory(payload) {

    const raw =

        Array.isArray(
            payload?.history
        )

            ? payload.history

            : Array.isArray(
                payload?.data
            )

                ? payload.data

                : Array.isArray(
                    payload?.results
                )

                    ? payload.results

                    : [];


    const output = [];


    for (
        const item of raw
    ) {

        const issue =

            item?.issueNumber ??
            item?.issue ??
            item?.period ??
            item?.periodNumber;


        const number =

            item?.number ??
            item?.result ??
            item?.openNumber ??
            item?.digit;


        const n =
            Number(number);


        if (

            issue !== undefined &&

            Number.isInteger(n) &&

            n >= 0 &&
            n <= 9

        ) {

            output.push({

                issueNumber:
                    String(issue),

                number:
                    n,

                colour:
                    item?.colour ??
                    item?.color ??
                    null,

                premium:
                    item?.premium ??
                    null,

                sum:
                    item?.sum ??
                    null

            });

        }

    }


    return output;

}


// ============================================================
// PROVIDER CURRENT ISSUE
// ============================================================

function getProviderCurrentIssue(payload) {

    return (

        payload?.current?.issueNumber

        ??

        payload?.currentIssue

        ??

        payload?.current?.issue

        ??

        payload?.current?.period

        ??

        null

    );

}


// ============================================================
// REFRESH PROVIDER
// ============================================================

async function refreshProvider() {

    if (refreshInProgress) {

        return providerState;

    }


    refreshInProgress = true;


    try {

        const payload =
            await fetchWingoBot();


        const history =
            normalizeHistory(
                payload
            );


        const currentIssue =
            getProviderCurrentIssue(
                payload
            );


        providerState = {

            ok: true,

            currentIssue:
                currentIssue !== null
                    ? String(currentIssue)
                    : history[0]?.issueNumber ||
                      null,

            history,

            fetched:
                Number(
                    payload?.stats?.fetched
                ) ||
                history.length,

            lastUpdated:
                Number(
                    payload?.stats?.last_updated
                ) ||
                now(),

            error:
                null

        };


        return providerState;

    } catch (error) {

        providerState = {

            ...providerState,

            ok: false,

            error:
                error.message ||
                "Provider error"

        };


        return providerState;

    } finally {

        refreshInProgress = false;

    }

}


// ============================================================
// ============================================================
//                 MASTER 25 PATTERNS
// ============================================================
// ============================================================

const MASTER_PATTERNS = {

    1:
        "ABABABABAB",

    2:
        "AABBAABB",

    3:
        "AAABBBAAABBB",

    4:
        "AAAABBBBAAAABBBB",

    5:
        "AABAABAAB",

    6:
        "AAAAAAAABBBBBBBB",

    7:
        "ABBABBABB",

    8:
        "AAABAAABAAAB",

    9:
        "AAABAAAB",

    10:
        "AAAABBABBAAAA",

    11:
        "ABBBABBBABBB",

    12:
        "ABABBABBB",

    13:
        "AABBAAABBBAAAABBBB",

    14:
        "ABBAAABBBB",

    15:
        "AAAABBBAAB",

    16:
        "ABAABBAAABBB",

    17:
        "AABBBAABBBAA",

    18:
        "ABBAAAABBBBBBBB",

    19:
        "ABBBABBB",

    20:
        "AABBBAABBB",

    21:
        "ABAABAAAB",

    22:
        "AABAABBAABBB",

    23:
        "AAAABAAAAB",

    24:
        "AAAABBAAAABB",

    25:
        "AAAABBBAAAABBB"

};


// ============================================================
// OPPOSITE PATTERN
// ============================================================

function oppositePattern(pattern) {

    return String(pattern)
        .split("")
        .map(char => {

            if (char === "A") {

                return "B";

            }


            if (char === "B") {

                return "A";

            }


            return char;

        })
        .join("");

}


// ============================================================
// BUILD PATTERN DATABASE
// ============================================================

const PATTERN_DATABASE = [];


for (
    const [id, pattern]
    of Object.entries(
        MASTER_PATTERNS
    )
) {

    const cleanPattern =
        String(pattern)
            .replace(
                /[^AB]/g,
                ""
            );


    if (
        !cleanPattern.length
    ) {

        continue;

    }


    /*
      ORIGINAL
    */

    PATTERN_DATABASE.push({

        rule:
            Number(id),

        type:
            "ORIGINAL",

        pattern:
            cleanPattern,

        length:
            cleanPattern.length

    });


    /*
      OPPOSITE
    */

    PATTERN_DATABASE.push({

        rule:
            Number(id),

        type:
            "OPPOSITE",

        pattern:
            oppositePattern(
                cleanPattern
            ),

        length:
            cleanPattern.length

    });

}


// ============================================================
// CONVERT HISTORY
// ============================================================

function convertHistory(numbers) {

    const output = [];


    for (
        const value of
            Array.isArray(numbers)
                ? numbers
                : []
    ) {

        let number;


        if (
            typeof value ===
            "object" &&
            value !== null
        ) {

            number =
                Number(
                    value.number ??
                    value.actual_number ??
                    value.value
                );

        } else {

            number =
                Number(value);

        }


        const side =
            numberToSide(
                number
            );


        if (
            side !== null
        ) {

            output.push(
                side
            );

        }

    }


    return output;

}


// ============================================================
// EXACT MATCH
// ============================================================

function exactMatch(
    history,
    pattern
) {

    if (
        history.length <
        pattern.length
    ) {

        return false;

    }


    const recent =
        history
            .slice(
                -pattern.length
            )
            .join("");


    return (
        recent ===
        pattern
    );

}


// ============================================================
// FIND EXACT MATCHES
// ============================================================

function findExactMatches(
    history
) {

    const matches = [];


    for (
        const item of
            PATTERN_DATABASE
    ) {

        if (
            exactMatch(
                history,
                item.pattern
            )
        ) {

            matches.push({

                ...item,

                matched:
                    item.length,

                matchPercent:
                    100

            });

        }

    }


    return matches;

}


// ============================================================
// PARTIAL MATCH
// ============================================================

function partialMatch(
    history,
    pattern
) {

    const maxLength =
        Math.min(
            history.length,
            pattern.length
        );


    let best = 0;


    for (
        let length = 2;
        length <= maxLength;
        length++
    ) {

        const recent =
            history
                .slice(-length)
                .join("");


        const patternPart =
            pattern
                .slice(
                    0,
                    length
                );


        if (
            recent ===
            patternPart
        ) {

            best =
                length;

        }

    }


    return best;

}


// ============================================================
// FIND PARTIAL MATCHES
// ============================================================

function findPartialMatches(
    history
) {

    const matches = [];


    for (
        const item of
            PATTERN_DATABASE
    ) {

        const matched =
            partialMatch(
                history,
                item.pattern
            );


        /*
          5+ match =
          WATCH ONLY.
        */

        if (
            matched >= 5 &&
            matched < item.length
        ) {

            matches.push({

                ...item,

                matched,

                matchPercent:
                    Math.round(
                        matched /
                        item.length *
                        100
                    )

            });

        }

    }


    return matches.sort(

        (a, b) => {

            /*
              First:
              longest matched portion
            */

            if (
                b.matched !==
                a.matched
            ) {

                return (
                    b.matched -
                    a.matched
                );

            }


            /*
              Then:
              longer template
            */

            if (
                b.length !==
                a.length
            ) {

                return (
                    b.length -
                    a.length
                );

            }


            /*
              ORIGINAL first
            */

            if (
                a.type ===
                    "ORIGINAL" &&
                b.type ===
                    "OPPOSITE"
            ) {

                return -1;

            }


            if (
                a.type ===
                    "OPPOSITE" &&
                b.type ===
                    "ORIGINAL"
            ) {

                return 1;

            }


            return 0;

        }

    );

}


// ============================================================
// REVERSAL PREDICTION
// ============================================================

function reversalPrediction(
    matchedPattern
) {

    if (
        !matchedPattern ||
        !matchedPattern.pattern
    ) {

        return {

            matchedSide:
                null,

            prediction:
                null,

            predictionCode:
                null,

            logic:
                "Invalid pattern."

        };

    }


    const last =
        matchedPattern.pattern[
            matchedPattern.pattern.length - 1
        ];


    /*
      A = SMALL
      B = BIG

      User's exact rule:

      A -> B
      B -> A
    */

    if (
        last === "A"
    ) {

        return {

            matchedSide:
                "SMALL",

            matchedSideCode:
                "A",

            prediction:
                "BIG",

            predictionCode:
                "B",

            logic:
                "Matched pattern ends with SMALL (A), therefore opposite prediction = BIG (B)."

        };

    }


    if (
        last === "B"
    ) {

        return {

            matchedSide:
                "BIG",

            matchedSideCode:
                "B",

            prediction:
                "SMALL",

            predictionCode:
                "A",

            logic:
                "Matched pattern ends with BIG (B), therefore opposite prediction = SMALL (A)."

        };

    }


    return {

        matchedSide:
            null,

        prediction:
            null,

        predictionCode:
            null,

        logic:
            "Invalid pattern."

    };

}


// ============================================================
// SELECT BEST EXACT MATCH
// ============================================================

function selectBestMatch(
    matches
) {

    if (
        !matches ||
        !matches.length
    ) {

        return null;

    }


    const sorted =
        matches.slice().sort(

            (a, b) => {

                /*
                  1. LONGEST PATTERN
                */

                if (
                    b.length !==
                    a.length
                ) {

                    return (
                        b.length -
                        a.length
                    );

                }


                /*
                  2. ORIGINAL PRIORITY
                */

                if (
                    a.type ===
                        "ORIGINAL" &&
                    b.type ===
                        "OPPOSITE"
                ) {

                    return -1;

                }


                if (
                    a.type ===
                        "OPPOSITE" &&
                    b.type ===
                        "ORIGINAL"
                ) {

                    return 1;

                }


                /*
                  3. RULE NUMBER
                */

                return (
                    a.rule -
                    b.rule
                );

            }

        );


    return sorted[0];

}


// ============================================================
// CURRENT STREAK
// ============================================================

function getCurrentStreak(
    history
) {

    if (
        !history.length
    ) {

        return null;

    }


    const last =
        history[
            history.length - 1
        ];


    let count = 1;


    for (
        let i =
            history.length - 2;

        i >= 0;

        i--
    ) {

        if (
            history[i] ===
            last
        ) {

            count++;

        } else {

            break;

        }

    }


    return {

        code:
            last,

        side:
            sideToLabel(
                last
            ),

        count

    };

}


// ============================================================
// WINDOW ANALYSIS
// ============================================================

function windowAnalysis(
    history,
    size
) {

    const data =
        history.slice(-size);


    if (
        !data.length
    ) {

        return {

            size:
                0,

            big:
                0,

            small:
                0,

            bigPercent:
                0,

            smallPercent:
                0

        };

    }


    const big =
        data.filter(
            x => x === "B"
        ).length;


    const small =
        data.filter(
            x => x === "A"
        ).length;


    return {

        size:
            data.length,

        big,

        small,

        bigPercent:
            Number(
                (
                    big /
                    data.length *
                    100
                ).toFixed(2)
            ),

        smallPercent:
            Number(
                (
                    small /
                    data.length *
                    100
                ).toFixed(2)
            )

    };

}


// ============================================================
// SWITCHING
// ============================================================

function switchingAnalysis(
    history
) {

    if (
        history.length < 2
    ) {

        return {

            switches:
                0,

            transitions:
                0,

            switchRate:
                0

        };

    }


    let switches = 0;


    for (
        let i = 1;
        i < history.length;
        i++
    ) {

        if (
            history[i] !==
            history[i - 1]
        ) {

            switches++;

        }

    }


    const transitions =
        history.length - 1;


    return {

        switches,

        transitions,

        switchRate:
            Number(
                (
                    switches /
                    transitions *
                    100
                ).toFixed(2)
            )

    };

}


// ============================================================
// PATTERN BREAK
// ============================================================

function detectPatternBreak(
    history
) {

    if (
        history.length < 6
    ) {

        return {

            detected:
                false,

            sequence:
                null

        };

    }


    const last6 =
        history.slice(-6);


    const first5 =
        last6.slice(0, 5);


    const alternating =
        first5.every(

            (value, index) => {

                if (
                    index === 0
                ) {

                    return true;

                }


                return (
                    value !==
                    first5[
                        index - 1
                    ]
                );

            }

        );


    const detected =
        alternating &&
        last6[4] ===
        last6[5];


    return {

        detected,

        sequence:
            last6.join("")

    };

}


// ============================================================
// PATTERN DESCRIPTION
// ============================================================

function patternDescription(
    match
) {

    if (!match) {

        return null;

    }


    const side =
        match.type ===
            "ORIGINAL"

            ? "MASTER"

            : "OPPOSITE";


    return {

        rule:
            match.rule,

        type:
            side,

        pattern:
            match.pattern,

        length:
            match.length,

        matched:
            match.matched ??
            match.length,

        percent:
            match.matchPercent ??
            100

    };

}


// ============================================================
// MAIN PATTERN ANALYZER
// ============================================================

function analyzePattern(
    numbers
) {

    const history =
        convertHistory(
            numbers
        );


    /*
      Need enough data for
      at least the shortest
      useful master pattern.
    */

    if (
        history.length < 5
    ) {

        return {

            status:
                "INSUFFICIENT_DATA",

            prediction:
                null,

            predictionCode:
                null,

            confidence:
                0,

            sequence:
                history.join(""),

            currentStreak:
                getCurrentStreak(
                    history
                ),

            message:
                "At least 5 valid results required.",

            warning:
                "No pattern prediction generated."

        };

    }


    /*
      EXACT MATCHES
    */

    const exactMatches =
        findExactMatches(
            history
        );


    /*
      PARTIAL MATCHES
    */

    const partialMatches =
        findPartialMatches(
            history
        );


    /*
      WINDOWS
    */

    const windows = {

        last5:
            windowAnalysis(
                history,
                5
            ),

        last10:
            windowAnalysis(
                history,
                10
            ),

        last20:
            windowAnalysis(
                history,
                20
            ),

        last30:
            windowAnalysis(
                history,
                30
            )

    };


    /*
      SWITCHING
    */

    const switching =
        switchingAnalysis(
            history
        );


    /*
      PATTERN BREAK
    */

    const patternBreak =
        detectPatternBreak(
            history
        );


    /*
      CURRENT STREAK
    */

    const streak =
        getCurrentStreak(
            history
        );


    /*
      EXACT MATCH
    */

    if (
        exactMatches.length > 0
    ) {

        const bestMatch =
            selectBestMatch(
                exactMatches
            );


        const reversal =
            reversalPrediction(
                bestMatch
            );


        return {

            status:
                "EXACT_PATTERN_MATCH",

            prediction:
                reversal.prediction,

            predictionCode:
                reversal.predictionCode,

            confidence:
                85,

            confidenceLevel:
                "PATTERN_MATCH",


            matchedRule:
                bestMatch.rule,

            matchedType:
                bestMatch.type,

            matchedPattern:
                bestMatch.pattern,

            patternLength:
                bestMatch.length,

            matchedSide:
                reversal.matchedSide,

            matchedSideCode:
                reversal.matchedSideCode,

            logic:
                reversal.logic,


            bestMatch:
                patternDescription(
                    bestMatch
                ),


            allMatches:
                exactMatches.map(
                    patternDescription
                ),


            partialMatches:
                partialMatches
                    .slice(0, 10)
                    .map(
                        patternDescription
                    ),


            currentStreak:
                streak,


            windows,


            switching,


            patternBreak,


            sequence:
                history.join(""),


            dataSize:
                history.length,


            engine:
                "25 MASTER + OPPOSITE + EXACT REVERSAL",


            warning:
                "Historical pattern/reversal logic only. The next result is not guaranteed."

        };

    }


    /*
      NO EXACT MATCH

      Partial = WATCH ONLY
    */

    if (
        partialMatches.length > 0
    ) {

        const bestPartial =
            partialMatches[0];


        return {

            status:
                "PARTIAL_PATTERN_WATCH",

            prediction:
                null,

            predictionCode:
                null,

            confidence:
                0,


            matchedRule:
                bestPartial.rule,

            matchedType:
                bestPartial.type,

            matchedPattern:
                bestPartial.pattern,

            matchedLength:
                bestPartial.matched,

            totalLength:
                bestPartial.length,

            matchPercent:
                bestPartial.matchPercent,


            bestMatch:
                patternDescription(
                    bestPartial
                ),


            partialMatches:
                partialMatches
                    .slice(0, 15)
                    .map(
                        patternDescription
                    ),


            currentStreak:
                streak,


            windows,


            switching,


            patternBreak,


            sequence:
                history.join(""),


            dataSize:
                history.length,


            engine:
                "25 MASTER + OPPOSITE + EXACT REVERSAL",


            message:
                "Partial pattern found. Exact match required before prediction.",


            warning:
                "Partial pattern is WATCH only. No prediction generated."

        };

    }


    /*
      NO PATTERN
    */

    return {

        status:
            "NO_PATTERN_MATCH",

        prediction:
            null,

        predictionCode:
            null,

        confidence:
            0,


        matchedRule:
            null,

        matchedType:
            null,

        matchedPattern:
            null,


        currentStreak:
            streak,


        windows,


        switching,


        patternBreak,


        sequence:
            history.join(""),


        dataSize:
            history.length,


        engine:
            "25 MASTER + OPPOSITE + EXACT REVERSAL",


        message:
            "No master pattern matched the current sequence.",


        warning:
            "No pattern-based prediction generated."

    };

}


// ============================================================
// TARGET ISSUE
// ============================================================

function resolveTargetIssue() {

    const history =
        providerState.history;


    if (
        !history.length
    ) {

        return null;

    }


    const newestIssue =
        history[0]?.issueNumber;


    const providerCurrent =
        providerState.currentIssue;


    /*
      If provider explicitly gives
      a current issue greater than
      the latest settled history,
      use it.
    */

    if (
        providerCurrent &&
        newestIssue &&
        compareIssue(
            providerCurrent,
            newestIssue
        ) > 0
    ) {

        return String(
            providerCurrent
        );

    }


    /*
      Otherwise:
      latest result + 1
    */

    return incrementIssue(
        newestIssue
    );

}


// ============================================================
// GENERATE MODEL
// ============================================================

async function generateModel() {

    /*
      WingoBot history normally:
      newest -> oldest

      Analyzer needs:
      oldest -> newest
    */

    const numbers =
        providerState.history
            .map(
                row =>
                    Number(
                        row.number
                    )
            )
            .filter(
                n =>
                    Number.isInteger(n) &&
                    n >= 0 &&
                    n <= 9
            )
            .reverse();


    const analysis =
        analyzePattern(
            numbers
        );


    const targetIssue =
        resolveTargetIssue();


    const generatedAt =
        now();


    modelCache = {

        targetIssue,

        prediction: {

            targetIssue,

            prediction:
                analysis.prediction ||
                null,

            predictionCode:
                analysis.predictionCode ||
                null,

            confidence:
                Number(
                    analysis.confidence ||
                    0
                ),

            confidenceLevel:
                analysis.confidenceLevel ||
                "NO_SIGNAL",

            status:
                analysis.status,

            classification:
                analysis.status,


            matchedRule:
                analysis.matchedRule ??
                null,

            matchedType:
                analysis.matchedType ??
                null,

            matchedPattern:
                analysis.matchedPattern ??
                null,

            matchedLength:
                analysis.matchedLength ??
                analysis.patternLength ??
                null,

            matchPercent:
                analysis.matchPercent ??
                (
                    analysis.status ===
                    "EXACT_PATTERN_MATCH"
                        ? 100
                        : null
                ),


            matchedSide:
                analysis.matchedSide ??
                null,


            reason:
                analysis.logic ||
                analysis.message ||
                "",


            modelVersion:
                MODEL_VERSION,


            generatedAt,


            analysis

        },


        generatedAt

    };


    /*
      Only exact pattern prediction
      is saved.

      Partial/no match:
      no DB prediction.
    */

    if (
        analysis.status ===
        "EXACT_PATTERN_MATCH" &&
        analysis.prediction
    ) {

        await savePrediction(
            targetIssue,
            analysis
        );

    }


    return modelCache;

}


// ============================================================
// SAVE PREDICTION
// ============================================================

async function savePrediction(
    targetIssue,
    analysis
) {

    if (
        !pool ||
        !targetIssue ||
        !analysis?.prediction
    ) {

        return;

    }


    try {

        const existing =
            await pool.query(
                `
                SELECT id
                FROM prediction_records
                WHERE target_issue = $1
                LIMIT 1
                `,
                [
                    String(
                        targetIssue
                    )
                ]
            );


        if (
            existing.rows.length
        ) {

            return;

        }


        await pool.query(
            `
            INSERT INTO prediction_records
            (
                target_issue,
                prediction,
                confidence,
                model_version,
                created_at
            )
            VALUES ($1,$2,$3,$4,$5)
            `,
            [

                String(
                    targetIssue
                ),

                String(
                    analysis.prediction
                ),

                Number(
                    analysis.confidence ||
                    85
                ),

                MODEL_VERSION,

                now()

            ]
        );


        console.log(
            `[MODEL] Saved ${targetIssue} -> ${analysis.prediction}`
        );


    } catch (error) {

        console.error(
            "[DB] savePrediction:",
            error.message
        );

    }

}


// ============================================================
// SETTLE PREDICTIONS
// ============================================================

async function settlePredictions() {

    if (!pool) {

        return;

    }


    const history =
        providerState.history
            .slice(
                0,
                100
            );


    for (
        const row of history
    ) {

        const actualNumber =
            Number(
                row.number
            );


        const actualSide =
            numberToSide(
                actualNumber
            );


        if (
            actualSide === null
        ) {

            continue;

        }


        try {

            const result =
                await pool.query(
                    `
                    SELECT
                        id,
                        prediction,
                        actual_result
                    FROM prediction_records
                    WHERE target_issue = $1
                    LIMIT 1
                    `,
                    [
                        String(
                            row.issueNumber
                        )
                    ]
                );


            if (
                !result.rows.length
            ) {

                continue;

            }


            const record =
                result.rows[0];


            if (
                record.actual_result
            ) {

                continue;

            }


            const predictionSide =
                labelToSide(
                    record.prediction
                );


            if (
                !predictionSide
            ) {

                continue;

            }


            const actualLabel =
                sideToLabel(
                    actualSide
                );


            const resultStatus =
                predictionSide ===
                actualSide

                    ? "WIN"

                    : "LOSS";


            await pool.query(
                `
                UPDATE prediction_records
                SET
                    actual_number = $1,
                    actual_result = $2,
                    settled_at = $3
                WHERE id = $4
                `,
                [

                    actualNumber,

                    resultStatus,

                    now(),

                    record.id

                ]
            );


            console.log(
                `[SETTLE] ${row.issueNumber} ${record.prediction} -> ${actualLabel} = ${resultStatus}`
            );


        } catch (error) {

            console.error(
                "[DB] settlePrediction:",
                error.message
            );

        }

    }

}


// ============================================================
// ACCESS KEY HEADERS
// ============================================================

function getAccessKey(req) {

    return String(
        req.headers[
            "x-access-key"
        ] || ""
    ).trim();

}


function getDeviceId(req) {

    return String(
        req.headers[
            "x-device-id"
        ] || ""
    ).trim();

}


function getAdminKey(req) {

    return String(
        req.headers[
            "x-admin-key"
        ] || ""
    ).trim();

}


// ============================================================
// VALIDATE ACCESS KEY
// ============================================================

async function validateAccess(req) {

    const accessKey =
        getAccessKey(req);


    const deviceId =
        getDeviceId(req);


    if (
        !accessKey ||
        !deviceId
    ) {

        return {

            ok: false,

            error:
                "ACCESS_KEY_OR_DEVICE_MISSING"

        };

    }


    if (!pool) {

        return {

            ok: false,

            error:
                "DATABASE_DISABLED"

        };

    }


    const result =
        await pool.query(
            `
            SELECT *
            FROM access_keys
            WHERE access_key = $1
            LIMIT 1
            `,
            [
                accessKey
            ]
        );


    if (
        !result.rows.length
    ) {

        return {

            ok: false,

            error:
                "INVALID_ACCESS_KEY"

        };

    }


    const row =
        result.rows[0];


    /*
      One key -> one browser device
    */

    if (
        row.device_id &&
        row.device_id !==
        deviceId
    ) {

        return {

            ok: false,

            error:
                "KEY_ALREADY_BOUND"

        };

    }


    if (
        !row.device_id
    ) {

        await pool.query(
            `
            UPDATE access_keys
            SET
                device_id = $1,
                last_seen = $2
            WHERE id = $3
            `,
            [

                deviceId,

                now(),

                row.id

            ]
        );

    } else {

        await pool.query(
            `
            UPDATE access_keys
            SET
                last_seen = $1
            WHERE id = $2
            `,
            [

                now(),

                row.id

            ]
        );

    }


    return {

        ok: true,

        id:
            row.id,

        key:
            row.access_key

    };

}


// ============================================================
// ADMIN AUTH
// ============================================================

function requireAdmin(req) {

    return (

        ADMIN_KEY.length > 0 &&

        getAdminKey(req) ===
        ADMIN_KEY

    );

}


// ============================================================
// KEY CHECK API
// ============================================================

async function keyCheck(
    req,
    res
) {

    const auth =
        await validateAccess(
            req
        );


    if (!auth.ok) {

        json(
            res,
            401,
            auth
        );

        return;

    }


    json(
        res,
        200,
        {

            ok: true,

            valid: true,

            key:
                auth.key,

            id:
                auth.id,

            modelVersion:
                MODEL_VERSION

        }
    );

}


// ============================================================
// STATE API
// ============================================================

async function stateApi(
    req,
    res
) {

    const auth =
        await validateAccess(
            req
        );


    if (!auth.ok) {

        json(
            res,
            401,
            auth
        );

        return;

    }


    await refreshProvider();


    await settlePredictions();


    const targetIssue =
        resolveTargetIssue();


    /*
      New target issue:
      generate fresh model.
    */

    if (

        !modelCache.prediction ||

        modelCache.targetIssue !==
        targetIssue

    ) {

        await generateModel();

    }


    /*
      If provider refreshed but
      current target is same, keep
      same prediction.
    */

    let predictionRecords = [];


    if (pool) {

        try {

            const dbResult =
                await pool.query(
                    `
                    SELECT
                        target_issue,
                        prediction,
                        confidence,
                        model_version,
                        actual_number,
                        actual_result,
                        created_at,
                        settled_at
                    FROM prediction_records
                    ORDER BY created_at DESC
                    LIMIT 100
                    `
                );


            predictionRecords =
                dbResult.rows;

        } catch (error) {

            console.error(
                "[DB] history:",
                error.message
            );

        }

    }


    const predictionMap =
        new Map();


    for (
        const record of
            predictionRecords
    ) {

        predictionMap.set(

            String(
                record.target_issue
            ),

            record

        );

    }


    /*
      LAST 30 LIVE RESULTS
    */

    const history =
        providerState.history
            .slice(
                0,
                30
            )
            .map(
                row => {

                    const number =
                        Number(
                            row.number
                        );


                    const side =
                        numberToSide(
                            number
                        );


                    const record =
                        predictionMap.get(
                            String(
                                row.issueNumber
                            )
                        );


                    const prediction =
                        record
                            ? String(
                                record.prediction ||
                                ""
                            ).toUpperCase()
                            : null;


                    let resultStatus =
                        "PENDING";


                    if (
                        record?.actual_result
                    ) {

                        resultStatus =
                            String(
                                record.actual_result
                            ).toUpperCase();

                    }


                    return {

                        issue:
                            row.issueNumber,

                        issueNumber:
                            row.issueNumber,

                        number,

                        actual:
                            number,

                        type:
                            side,

                        label:
                            sideToLabel(
                                side
                            ),

                        prediction:
                            prediction ||
                            null,

                        ai:
                            prediction ||
                            null,

                        confidence:
                            record
                                ? Number(
                                    record.confidence ||
                                    0
                                )
                                : null,

                        result:
                            resultStatus,

                        actualResult:
                            resultStatus,

                        modelVersion:
                            record?.model_version ||
                            null

                    };

                }
            );


    const model =
        modelCache.prediction;


    json(
        res,
        200,
        {

            ok: true,


            serverTime:
                now(),


            targetIssue,


            thinkingDurationMs:
                THINKING_DURATION_MS,


            current: {

                issueNumber:
                    providerState.currentIssue,

                issue:
                    providerState.currentIssue

            },


            model: {

                targetIssue:
                    model?.targetIssue ||
                    targetIssue,

                prediction:
                    model?.prediction ||
                    null,

                predictionCode:
                    model?.predictionCode ||
                    null,

                confidence:
                    model?.confidence ||
                    0,

                confidenceLevel:
                    model?.confidenceLevel ||
                    "NO_SIGNAL",

                status:
                    model?.status ||
                    "NO_PATTERN_MATCH",

                classification:
                    model?.classification ||
                    "NO_PATTERN_MATCH",

                matchedRule:
                    model?.matchedRule ??
                    null,

                matchedType:
                    model?.matchedType ??
                    null,

                matchedPattern:
                    model?.matchedPattern ??
                    null,

                matchedLength:
                    model?.matchedLength ??
                    null,

                matchPercent:
                    model?.matchPercent ??
                    null,

                matchedSide:
                    model?.matchedSide ??
                    null,

                reason:
                    model?.reason ||
                    "",

                modelVersion:
                    MODEL_VERSION,

                generatedAt:
                    model?.generatedAt ||
                    now(),

                analysis:
                    model?.analysis ||
                    null

            },


            prediction:
                model?.prediction ||
                null,


            provider: {

                ok:
                    providerState.ok,

                currentIssue:
                    providerState.currentIssue,

                historyCount:
                    providerState.history.length,

                fetched:
                    providerState.fetched,

                lastUpdated:
                    providerState.lastUpdated,

                error:
                    providerState.error

            },


            history

        }
    );

}


// ============================================================
// PREDICTION HISTORY API
// ============================================================

async function predictionHistory(
    res
) {

    if (!pool) {

        json(
            res,
            200,
            {

                ok: true,

                records: []

            }
        );

        return;

    }


    const result =
        await pool.query(
            `
            SELECT
                id,
                target_issue,
                prediction,
                confidence,
                model_version,
                actual_number,
                actual_result,
                created_at,
                settled_at
            FROM prediction_records
            ORDER BY created_at DESC
            LIMIT 100
            `
        );


    json(
        res,
        200,
        {

            ok: true,

            records:
                result.rows

        }
    );

}


// ============================================================
// ADMIN STATUS
// ============================================================

async function adminStatus(
    res
) {

    json(
        res,
        200,
        {

            ok: true,

            serverTime:
                now(),

            modelVersion:
                MODEL_VERSION,

            engine:
                "25 MASTER + OPPOSITE + EXACT REVERSAL",

            originalRules:
                Object.keys(
                    MASTER_PATTERNS
                ).length,

            totalPatterns:
                PATTERN_DATABASE.length,

            thinkingDurationMs:
                THINKING_DURATION_MS,


            provider: {

                ok:
                    providerState.ok,

                currentIssue:
                    providerState.currentIssue,

                historyCount:
                    providerState.history.length,

                fetched:
                    providerState.fetched,

                lastUpdated:
                    providerState.lastUpdated,

                error:
                    providerState.error

            },


            model:
                modelCache

        }
    );

}


// ============================================================
// ADMIN PING
// ============================================================

function adminPing(res) {

    json(
        res,
        200,
        {

            ok: true,

            message:
                "PONG",

            time:
                now(),

            modelVersion:
                MODEL_VERSION

        }
    );

}


// ============================================================
// ADMIN WINGO TEST
// ============================================================

async function adminWingoTest(
    res
) {

    const state =
        await refreshProvider();


    json(
        res,
        200,
        {

            ok:
                state.ok,

            currentIssue:
                state.currentIssue,

            historyCount:
                state.history.length,

            fetched:
                state.fetched,

            lastUpdated:
                state.lastUpdated,

            error:
                state.error,

            sample:
                state.history.slice(
                    0,
                    15
                )

        }
    );

}


// ============================================================
// ADMIN MODEL TEST
// ============================================================

async function adminModelTest(
    res
) {

    await refreshProvider();


    await settlePredictions();


    const model =
        await generateModel();


    json(
        res,
        200,
        {

            ok: true,

            targetIssue:
                model.targetIssue,

            prediction:
                model.prediction
                    ?.prediction ||
                null,

            predictionCode:
                model.prediction
                    ?.predictionCode ||
                null,

            confidence:
                model.prediction
                    ?.confidence ||
                0,

            confidenceLevel:
                model.prediction
                    ?.confidenceLevel ||
                "NO_SIGNAL",

            status:
                model.prediction
                    ?.status ||
                "NO_PATTERN_MATCH",

            classification:
                model.prediction
                    ?.classification ||
                "NO_PATTERN_MATCH",

            matchedRule:
                model.prediction
                    ?.matchedRule ??
                null,

            matchedType:
                model.prediction
                    ?.matchedType ??
                null,

            matchedPattern:
                model.prediction
                    ?.matchedPattern ??
                null,

            matchedLength:
                model.prediction
                    ?.matchedLength ??
                null,

            matchPercent:
                model.prediction
                    ?.matchPercent ??
                null,

            matchedSide:
                model.prediction
                    ?.matchedSide ??
                null,

            reason:
                model.prediction
                    ?.reason ||
                "",

            analysis:
                model.prediction
                    ?.analysis ||
                null

        }
    );

}


// ============================================================
// ADMIN KEY LIST
// ============================================================

async function adminKeysList(
    res
) {

    if (!pool) {

        json(
            res,
            500,
            {

                ok: false,

                error:
                    "DATABASE_DISABLED"

            }
        );

        return;

    }


    const result =
        await pool.query(
            `
            SELECT
                id,
                access_key,
                device_id,
                created_at,
                last_seen
            FROM access_keys
            ORDER BY id DESC
            `
        );


    json(
        res,
        200,
        {

            ok: true,

            keys:
                result.rows

        }
    );

}


// ============================================================
// ADMIN CREATE KEY
// ============================================================

async function adminKeysCreate(
    req,
    res
) {

    if (!pool) {

        json(
            res,
            500,
            {

                ok: false,

                error:
                    "DATABASE_DISABLED"

            }
        );

        return;

    }


    const body =
        await readBody(
            req
        );


    const customKey =
        String(
            body?.key ||
            body?.access_key ||
            ""
        ).trim();


    const key =
        customKey ||
        randomKey();


    try {

        const result =
            await pool.query(
                `
                INSERT INTO access_keys
                (
                    access_key,
                    created_at,
                    last_seen
                )
                VALUES ($1,$2,0)
                RETURNING *
                `,
                [

                    key,

                    now()

                ]
            );


        json(
            res,
            200,
            {

                ok: true,

                key:
                    result.rows[0]
                        .access_key,

                access_key:
                    result.rows[0]
                        .access_key,

                row:
                    result.rows[0]

            }
        );


    } catch (error) {

        json(
            res,
            400,
            {

                ok: false,

                error:
                    error.code ===
                    "23505"

                        ? "KEY_ALREADY_EXISTS"

                        : error.message

            }
        );

    }

}


// ============================================================
// ADMIN DELETE KEY
// ============================================================

async function adminKeysDelete(
    req,
    res,
    url
) {

    if (!pool) {

        json(
            res,
            500,
            {

                ok: false,

                error:
                    "DATABASE_DISABLED"

            }
        );

        return;

    }


    const body =
        await readBody(
            req
        );


    const id =
        url.searchParams.get(
            "id"
        ) ||
        body?.id;


    const key =
        url.searchParams.get(
            "key"
        ) ||
        body?.key;


    if (
        !id &&
        !key
    ) {

        json(
            res,
            400,
            {

                ok: false,

                error:
                    "ID_OR_KEY_REQUIRED"

            }
        );

        return;

    }


    let result;


    if (id) {

        result =
            await pool.query(
                `
                DELETE FROM access_keys
                WHERE id = $1
                RETURNING id, access_key
                `,
                [
                    Number(id)
                ]
            );

    } else {

        result =
            await pool.query(
                `
                DELETE FROM access_keys
                WHERE access_key = $1
                RETURNING id, access_key
                `,
                [
                    String(key)
                ]
            );

    }


    json(
        res,
        200,
        {

            ok: true,

            deleted:
                result.rows[0] ||
                null

        }
    );

}


// ============================================================
// ADMIN RESET DEVICE
// ============================================================

async function adminResetDevice(
    req,
    res
) {

    if (!pool) {

        json(
            res,
            500,
            {

                ok: false,

                error:
                    "DATABASE_DISABLED"

            }
        );

        return;

    }


    const body =
        await readBody(
            req
        );


    const id =
        body?.id;


    const key =
        body?.key ||
        body?.access_key;


    if (
        !id &&
        !key
    ) {

        json(
            res,
            400,
            {

                ok: false,

                error:
                    "ID_OR_KEY_REQUIRED"

            }
        );

        return;

    }


    let result;


    if (id) {

        result =
            await pool.query(
                `
                UPDATE access_keys
                SET device_id = NULL
                WHERE id = $1
                RETURNING id, access_key, device_id
                `,
                [
                    Number(id)
                ]
            );

    } else {

        result =
            await pool.query(
                `
                UPDATE access_keys
                SET device_id = NULL
                WHERE access_key = $1
                RETURNING id, access_key, device_id
                `,
                [
                    String(key)
                ]
            );

    }


    json(
        res,
        200,
        {

            ok: true,

            row:
                result.rows[0] ||
                null

        }
    );

}


// ============================================================
// HEALTH
// ============================================================

function health(res) {

    json(
        res,
        200,
        {

            ok: true,

            service:
                "DY AI WINGO",

            modelVersion:
                MODEL_VERSION,

            engine:
                "25 MASTER + OPPOSITE + EXACT REVERSAL",

            time:
                now(),

            providerOk:
                providerState.ok,

            historyCount:
                providerState.history.length

        }
    );

}


// ============================================================
// STATIC CONTENT TYPE
// ============================================================

function contentType(
    filePath
) {

    const ext =
        path
            .extname(filePath)
            .toLowerCase();


    const types = {

        ".html":
            "text/html; charset=utf-8",

        ".css":
            "text/css; charset=utf-8",

        ".js":
            "application/javascript; charset=utf-8",

        ".json":
            "application/json; charset=utf-8",

        ".mp3":
            "audio/mpeg",

        ".png":
            "image/png",

        ".jpg":
            "image/jpeg",

        ".jpeg":
            "image/jpeg",

        ".svg":
            "image/svg+xml",

        ".ico":
            "image/x-icon"

    };


    return (
        types[ext] ||
        "application/octet-stream"
    );

}


// ============================================================
// STATIC FILE SERVER
// ============================================================

function serveStatic(
    req,
    res,
    pathname
) {

    let requested =
        pathname === "/"
            ? "/prediction.html"
            : pathname;


    try {

        requested =
            decodeURIComponent(
                requested
            );

    } catch {

        text(
            res,
            400,
            "Bad Request"
        );

        return;

    }


    const root =
        path.resolve(
            __dirname
        );


    const filePath =
        path.resolve(
            root,
            "." + requested
        );


    if (
        !filePath.startsWith(
            root
        )
    ) {

        text(
            res,
            403,
            "Forbidden"
        );

        return;

    }


    fs.stat(
        filePath,
        (
            error,
            stats
        ) => {

            if (
                error ||
                !stats.isFile()
            ) {

                text(
                    res,
                    404,
                    "Not Found"
                );

                return;

            }


            const type =
                contentType(
                    filePath
                );


            /*
              MP3 RANGE SUPPORT
            */

            if (
                type ===
                    "audio/mpeg" &&
                req.headers.range
            ) {

                const match =
                    req.headers.range.match(
                        /bytes=(\d*)-(\d*)/
                    );


                if (!match) {

                    text(
                        res,
                        416,
                        "Invalid range"
                    );

                    return;

                }


                const size =
                    stats.size;


                let start =
                    match[1]
                        ? Number(
                            match[1]
                        )
                        : 0;


                let end =
                    match[2]
                        ? Number(
                            match[2]
                        )
                        : size - 1;


                if (
                    start >= size
                ) {

                    start = 0;

                }


                if (
                    end >= size
                ) {

                    end =
                        size - 1;

                }


                res.writeHead(
                    206,
                    {

                        "Content-Type":
                            type,

                        "Content-Range":
                            `bytes ${start}-${end}/${size}`,

                        "Accept-Ranges":
                            "bytes",

                        "Content-Length":
                            end - start + 1

                    }
                );


                fs.createReadStream(
                    filePath,
                    {
                        start,
                        end
                    }
                ).pipe(res);


                return;

            }


            res.writeHead(
                200,
                {

                    "Content-Type":
                        type,

                    "Cache-Control":
                        "no-cache"

                }
            );


            fs.createReadStream(
                filePath
            ).pipe(res);

        }
    );

}


// ============================================================
// ROUTER
// ============================================================

const server =
    http.createServer(

        async (
            req,
            res
        ) => {

            try {

                /*
                  CORS OPTIONS
                */

                if (
                    req.method ===
                    "OPTIONS"
                ) {

                    res.writeHead(
                        204,
                        {

                            "Access-Control-Allow-Origin":
                                "*",

                            "Access-Control-Allow-Headers":
                                "Content-Type, X-Access-Key, X-Device-Id, X-Admin-Key",

                            "Access-Control-Allow-Methods":
                                "GET, POST, DELETE, OPTIONS"

                        }
                    );


                    res.end();

                    return;

                }


                const url =
                    new URL(
                        req.url,
                        `http://${req.headers.host}`
                    );


                const pathname =
                    url.pathname;


                /*
                  HEALTH
                */

                if (
                    pathname ===
                    "/health"
                ) {

                    health(res);

                    return;

                }


                /*
                  KEY CHECK
                */

                if (
                    pathname ===
                        "/api/key/check" &&
                    req.method ===
                        "GET"
                ) {

                    await keyCheck(
                        req,
                        res
                    );

                    return;

                }


                /*
                  STATE
                */

                if (
                    pathname ===
                        "/api/state" &&
                    req.method ===
                        "GET"
                ) {

                    await stateApi(
                        req,
                        res
                    );

                    return;

                }


                /*
                  HISTORY
                */

                if (
                    pathname ===
                        "/api/history" &&
                    req.method ===
                        "GET"
                ) {

                    const auth =
                        await validateAccess(
                            req
                        );


                    if (!auth.ok) {

                        json(
                            res,
                            401,
                            auth
                        );

                        return;

                    }


                    await predictionHistory(
                        res
                    );

                    return;

                }


                /*
                  ADMIN AUTH
                */

                if (
                    pathname.startsWith(
                        "/api/admin/"
                    )
                ) {

                    if (
                        !requireAdmin(req)
                    ) {

                        json(
                            res,
                            401,
                            {

                                ok: false,

                                error:
                                    "ADMIN_UNAUTHORIZED"

                            }
                        );

                        return;

                    }

                }


                /*
                  ADMIN STATUS
                */

                if (
                    pathname ===
                        "/api/admin/status" &&
                    req.method ===
                        "GET"
                ) {

                    await adminStatus(
                        res
                    );

                    return;

                }


                /*
                  ADMIN PING
                */

                if (
                    pathname ===
                        "/api/admin/ping" &&
                    req.method ===
                        "GET"
                ) {

                    adminPing(
                        res
                    );

                    return;

                }


                /*
                  WINGOBOT TEST
                */

                if (
                    pathname ===
                        "/api/admin/wingo-test" &&
                    req.method ===
                        "GET"
                ) {

                    await adminWingoTest(
                        res
                    );

                    return;

                }


                /*
                  MODEL TEST
                */

                if (
                    pathname ===
                        "/api/admin/model-test" &&
                    req.method ===
                        "GET"
                ) {

                    await adminModelTest(
                        res
                    );

                    return;

                }


                /*
                  KEY LIST
                */

                if (
                    pathname ===
                        "/api/admin/keys" &&
                    req.method ===
                        "GET"
                ) {

                    await adminKeysList(
                        res
                    );

                    return;

                }


                /*
                  KEY CREATE
                */

                if (
                    pathname ===
                        "/api/admin/keys" &&
                    req.method ===
                        "POST"
                ) {

                    await adminKeysCreate(
                        req,
                        res
                    );

                    return;

                }


                /*
                  KEY DELETE
                */

                if (
                    pathname ===
                        "/api/admin/keys" &&
                    req.method ===
                        "DELETE"
                ) {

                    await adminKeysDelete(
                        req,
                        res,
                        url
                    );

                    return;

                }


                /*
                  RESET DEVICE
                */

                if (
                    pathname ===
                        "/api/admin/reset-device" &&
                    req.method ===
                        "POST"
                ) {

                    await adminResetDevice(
                        req,
                        res
                    );

                    return;

                }


                /*
                  STATIC
                */

                serveStatic(
                    req,
                    res,
                    pathname
                );

            } catch (error) {

                console.error(
                    "[SERVER ERROR]",
                    error
                );


                if (
                    !res.headersSent
                ) {

                    json(
                        res,
                        500,
                        {

                            ok: false,

                            error:
                                error.message ||
                                "Internal server error"

                        }
                    );

                } else {

                    res.end();

                }

            }

        }

    );


// ============================================================
// BACKGROUND REFRESH
// ============================================================

async function backgroundRefresh() {

    try {

        await refreshProvider();


        await settlePredictions();


        const target =
            resolveTargetIssue();


        /*
          Generate only when
          target changes.
        */

        if (

            target &&

            (
                !modelCache.prediction ||

                modelCache.targetIssue !==
                target

            )

        ) {

            await generateModel();

        }

    } catch (error) {

        console.error(
            "[BACKGROUND]",
            error.message
        );

    }

}


// ============================================================
// START SERVER
// ============================================================

async function start() {

    try {

        await initDatabase();


        await refreshProvider();


        await settlePredictions();


        await generateModel();


        server.listen(

            PORT,

            "0.0.0.0",

            () => {

                console.log(
                    "=========================================="
                );

                console.log(
                    "       DY AI WINGO SERVER STARTED"
                );

                console.log(
                    "=========================================="
                );

                console.log(
                    `PORT: ${PORT}`
                );

                console.log(
                    `MODEL: ${MODEL_VERSION}`
                );

                console.log(
                    `ORIGINAL RULES: ${
                        Object.keys(
                            MASTER_PATTERNS
                        ).length
                    }`
                );

                console.log(
                    `TOTAL PATTERNS: ${
                        PATTERN_DATABASE.length
                    }`
                );

                console.log(
                    `HISTORY: ${
                        providerState.history.length
                    }`
                );

                console.log(
                    `LATEST ISSUE: ${
                        providerState.history[0]
                            ?.issueNumber ||
                        "NONE"
                    }`
                );

                console.log(
                    `TARGET ISSUE: ${
                        modelCache.targetIssue ||
                        "NONE"
                    }`
                );

                console.log(
                    `STATUS: ${
                        modelCache.prediction
                            ?.status ||
                        "NO_PATTERN_MATCH"
                    }`
                );

                console.log(
                    `MATCHED RULE: ${
                        modelCache.prediction
                            ?.matchedRule ??
                        "NONE"
                    }`
                );

                console.log(
                    `MATCHED TYPE: ${
                        modelCache.prediction
                            ?.matchedType ??
                        "NONE"
                    }`
                );

                console.log(
                    `PREDICTION: ${
                        modelCache.prediction
                            ?.prediction ||
                        "NO PREDICTION"
                    }`
                );

                console.log(
                    "=========================================="
                );

            }

        );


        setInterval(
            backgroundRefresh,
            PROVIDER_REFRESH_MS
        );

    } catch (error) {

        console.error(
            "[STARTUP ERROR]",
            error
        );


        process.exit(1);

    }

}


// ============================================================
// ERROR HANDLERS
// ============================================================

process.on(
    "unhandledRejection",
    error => {

        console.error(
            "[UNHANDLED REJECTION]",
            error
        );

    }
);


process.on(
    "uncaughtException",
    error => {

        console.error(
            "[UNCAUGHT EXCEPTION]",
            error
        );

    }
);


// ============================================================
// BOOT
// ============================================================

start();
