"use strict";

/*
=========================================================
 DY AI WINGO - COMPLETE SERVER
=========================================================

 FEATURES
 --------------------------------------------------------
 1. PostgreSQL
 2. Admin authentication
 3. Access-key authentication
 4. Device binding
 5. Admin device reset
 6. Live API support
 7. WingoBot fallback
 8. Safe large Period/Issue IDs
 9. BIG / SMALL analysis
10. Prediction records
11. WIN / LOSS settlement
12. Stale prediction cleanup
13. 5-round cooldown
14. Admin API
15. Prediction API
16. Static prediction.html
17. Static admin.html
18. Health endpoint

 ENVIRONMENT VARIABLES
 --------------------------------------------------------

 DATABASE_URL
 ADMIN_KEY
 LIVE_API_URL
 LIVE_API_TOKEN
 WINGOBOT_TOKEN

 Optional:

 COOLDOWN=5
 POLL=1000
 MODEL=DY-AI-LIVE-V4

=========================================================
*/

const http = require("http");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");


/* =====================================================
   CONFIG
===================================================== */

const PORT =
    Number(process.env.PORT || 10000);

const DATABASE_URL =
    process.env.DATABASE_URL || "";

const ADMIN_KEY =
    String(
        process.env.ADMIN_KEY ||
        "dy4427574"
    ).trim();

const LIVE_API_URL =
    String(
        process.env.LIVE_API_URL ||
        ""
    ).trim();

const LIVE_API_TOKEN =
    String(
        process.env.LIVE_API_TOKEN ||
        ""
    ).trim();

const WINGOBOT_URL =
    String(
        process.env.WINGOBOT_URL ||
        "https://api.wingobot.com/v2/30-sec-game-history"
    ).trim();

const WINGOBOT_TOKEN =
    String(
        process.env.WINGOBOT_TOKEN ||
        ""
    ).trim();

const POLL =
    Math.max(
        1000,
        Number(
            process.env.POLL || 1000
        )
    );

const COOLDOWN =
    Math.max(
        0,
        Number(
            process.env.COOLDOWN || 5
        )
    );

const MODEL =
    String(
        process.env.MODEL ||
        "DY-AI-LIVE-V4"
    );


/* =====================================================
   DATABASE
===================================================== */

const pool =
    DATABASE_URL
        ? new Pool({
            connectionString:
                DATABASE_URL,

            ssl: {
                rejectUnauthorized:
                    false
            },

            max: 5,

            idleTimeoutMillis:
                30000,

            connectionTimeoutMillis:
                10000
        })
        : null;


/* =====================================================
   DATABASE INIT
===================================================== */

async function initDB() {

    if (!pool) {

        console.log(
            "DATABASE_URL not configured."
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
        )
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
        )
    `);


    await pool.query(`
        CREATE INDEX IF NOT EXISTS
        idx_prediction_target
        ON prediction_records(target_issue)
    `);


    await pool.query(`
        CREATE INDEX IF NOT EXISTS
        idx_prediction_created
        ON prediction_records(created_at)
    `);


    console.log(
        "PostgreSQL ready."
    );

}


/* =====================================================
   RESPONSE HELPERS
===================================================== */

function json(
    res,
    status,
    data
) {

    const body =
        JSON.stringify(data);


    res.writeHead(
        status,
        {
            "Content-Type":
                "application/json; charset=utf-8",

            "Cache-Control":
                "no-store, no-cache, must-revalidate, proxy-revalidate",

            "Pragma":
                "no-cache",

            "Expires":
                "0",

            "Access-Control-Allow-Origin":
                "*",

            "Access-Control-Allow-Headers":
                "Content-Type, Authorization, X-Admin-Key, X-Access-Key, X-Device-Id",

            "Access-Control-Allow-Methods":
                "GET,POST,OPTIONS"
        }
    );


    res.end(body);

}


function text(
    res,
    status,
    body
) {

    res.writeHead(
        status,
        {
            "Content-Type":
                "text/plain; charset=utf-8",

            "Cache-Control":
                "no-store"
        }
    );

    res.end(body);

}


/* =====================================================
   BASIC HELPERS
===================================================== */

function now() {

    return Date.now();

}


function normalizeIssue(value) {

    if (
        value === undefined ||
        value === null
    ) {

        return "";

    }

    return String(value).trim();

}


function isValidDigit(number) {

    return (
        Number.isInteger(number) &&
        number >= 0 &&
        number <= 9
    );

}


function resultOf(number) {

    if (
        !isValidDigit(number)
    ) {

        return null;

    }


    return number <= 4
        ? "SMALL"
        : "BIG";

}


/* =====================================================
   SAFE ISSUE COMPARISON
===================================================== */

function compareIssue(
    a,
    b
) {

    a =
        normalizeIssue(a);

    b =
        normalizeIssue(b);


    if (
        /^\d+$/.test(a) &&
        /^\d+$/.test(b)
    ) {

        try {

            const A =
                BigInt(a);

            const B =
                BigInt(b);


            if (A < B) {
                return -1;
            }

            if (A > B) {
                return 1;
            }

            return 0;

        } catch (_) {}

    }


    return a.localeCompare(
        b,
        undefined,
        {
            numeric: true
        }
    );

}


/* =====================================================
   NEXT ISSUE
===================================================== */

function nextIssue(
    issue
) {

    issue =
        normalizeIssue(issue);


    if (
        !/^\d+$/.test(issue)
    ) {

        return "";

    }


    try {

        return (
            BigInt(issue) + 1n
        ).toString();

    } catch (_) {

        return "";

    }

}


/* =====================================================
   ISSUE DISTANCE
===================================================== */

function issueDistance(
    older,
    newer
) {

    older =
        normalizeIssue(older);

    newer =
        normalizeIssue(newer);


    if (
        !/^\d+$/.test(older) ||
        !/^\d+$/.test(newer)
    ) {

        return null;

    }


    try {

        const A =
            BigInt(older);

        const B =
            BigInt(newer);

        if (B < A) {
            return null;
        }

        return Number(
            B - A
        );

    } catch (_) {

        return null;

    }

}


/* =====================================================
   FETCH JSON
===================================================== */

async function fetchJSON(
    url,
    headers = {}
) {

    const controller =
        new AbortController();


    const timeout =
        setTimeout(
            () => {
                controller.abort();
            },
            8000
        );


    try {

        const response =
            await fetch(
                url,
                {
                    method:
                        "GET",

                    headers,

                    signal:
                        controller.signal
                }
            );


        const raw =
            await response.text();


        let data;


        try {

            data =
                JSON.parse(raw);

        } catch (_) {

            throw new Error(
                "INVALID_JSON"
            );

        }


        if (
            !response.ok
        ) {

            throw new Error(
                "HTTP_" +
                response.status
            );

        }


        return data;

    } finally {

        clearTimeout(
            timeout
        );

    }

}


/* =====================================================
   PICK VALUE
===================================================== */

function pick(
    obj,
    keys
) {

    if (
        !obj ||
        typeof obj !== "object"
    ) {

        return null;

    }


    for (
        const key of keys
    ) {

        if (
            obj[key] !==
                undefined &&
            obj[key] !==
                null
        ) {

            return obj[key];

        }

    }


    return null;

}


/* =====================================================
   NORMALIZE API ROW
===================================================== */

function normalizeRow(
    row
) {

    if (
        !row ||
        typeof row !== "object"
    ) {

        return null;

    }


    const issue =
        normalizeIssue(
            pick(
                row,
                [
                    "issueNumber",
                    "issue",
                    "period",
                    "periodNumber",
                    "drawNumber",
                    "draw_id",
                    "drawId",
                    "id"
                ]
            )
        );


    let rawNumber =
        pick(
            row,
            [
                "number",
                "result",
                "digit",
                "openNumber",
                "winningNumber",
                "winning_number"
            ]
        );


    /*
       Some APIs return number as
       "4" / "04" / "Result: 4"
    */

    if (
        typeof rawNumber ===
        "string"
    ) {

        const match =
            rawNumber.match(
                /\d/
            );


        if (match) {

            rawNumber =
                Number(
                    match[0]
                );

        }

    }


    const number =
        Number(rawNumber);


    if (
        !issue ||
        !isValidDigit(number)
    ) {

        return null;

    }


    return {

        issue,

        number,

        result:
            resultOf(number),

        colour:
            pick(
                row,
                [
                    "colour",
                    "color"
                ]
            ),

        premium:
            pick(
                row,
                [
                    "premium"
                ]
            ),

        sum:
            pick(
                row,
                [
                    "sum"
                ]
            )

    };

}


/* =====================================================
   EXTRACT ROW ARRAY FROM API
===================================================== */

function extractRows(
    data
) {

    if (
        Array.isArray(data)
    ) {

        return data;

    }


    if (
        Array.isArray(
            data?.history
        )
    ) {

        return data.history;

    }


    if (
        Array.isArray(
            data?.results
        )
    ) {

        return data.results;

    }


    if (
        Array.isArray(
            data?.records
        )
    ) {

        return data.records;

    }


    if (
        Array.isArray(
            data?.data
        )
    ) {

        return data.data;

    }


    if (
        Array.isArray(
            data?.data?.history
        )
    ) {

        return data.data.history;

    }


    if (
        Array.isArray(
            data?.data?.results
        )
    ) {

        return data.data.results;

    }


    return [];

}


/* =====================================================
   LIVE CACHE
===================================================== */

let liveCache = {

    rows: [],

    currentIssue: "",

    fetchedAt: 0,

    source: "NONE",

    error: null

};


/* =====================================================
   CUSTOM LIVE API
===================================================== */

async function fetchCustomLive() {

    if (!LIVE_API_URL) {

        throw new Error(
            "LIVE_API_URL_NOT_CONFIGURED"
        );

    }


    const headers = {};


    if (LIVE_API_TOKEN) {

        headers.Authorization =
            "Bearer " +
            LIVE_API_TOKEN;

    }


    const data =
        await fetchJSON(
            LIVE_API_URL,
            headers
        );


    const rawRows =
        extractRows(
            data
        );


    const rows =
        rawRows
            .map(
                normalizeRow
            )
            .filter(Boolean)
            .sort(
                (
                    a,
                    b
                ) =>
                    compareIssue(
                        a.issue,
                        b.issue
                    )
            );


    const currentIssue =
        normalizeIssue(
            data?.current?.issueNumber ||
            data?.current?.issue ||
            data?.currentIssue ||
            data?.current_period ||
            data?.issueNumber ||
            ""
        );


    if (!rows.length) {

        throw new Error(
            "CUSTOM_API_NO_RESULTS"
        );

    }


    return {

        rows,

        currentIssue:
            currentIssue ||
            rows[
                rows.length - 1
            ].issue,

        source:
            "CUSTOM_API"

    };

}


/* =====================================================
   WINGOBOT
===================================================== */

async function fetchWingoBot() {

    if (!WINGOBOT_TOKEN) {

        throw new Error(
            "WINGOBOT_TOKEN_NOT_CONFIGURED"
        );

    }


    const data =
        await fetchJSON(
            WINGOBOT_URL,
            {
                Authorization:
                    "Bearer " +
                    WINGOBOT_TOKEN
            }
        );


    const rawRows =
        extractRows(
            data
        );


    const rows =
        rawRows
            .map(
                normalizeRow
            )
            .filter(Boolean)
            .sort(
                (
                    a,
                    b
                ) =>
                    compareIssue(
                        a.issue,
                        b.issue
                    )
            );


    const currentIssue =
        normalizeIssue(
            data?.current?.issueNumber ||
            data?.current?.issue ||
            data?.currentIssue ||
            ""
        );


    if (!rows.length) {

        throw new Error(
            "WINGOBOT_NO_RESULTS"
        );

    }


    return {

        rows,

        currentIssue:
            currentIssue ||
            rows[
                rows.length - 1
            ].issue,

        source:
            "WINGOBOT"

    };

}


/* =====================================================
   REFRESH LIVE SOURCE
===================================================== */

async function refreshLive() {

    let data = null;

    let error = null;


    /*
       Priority #1:
       Actual custom live API
    */

    if (
        LIVE_API_URL
    ) {

        try {

            data =
                await fetchCustomLive();

            error = null;

        } catch (e) {

            error =
                e.message;

            console.log(
                "Custom LIVE API:",
                e.message
            );

        }

    }


    /*
       Priority #2:
       WingoBot fallback
    */

    if (!data) {

        try {

            data =
                await fetchWingoBot();

            error = null;

        } catch (e) {

            error =
                error ||
                e.message;

            console.log(
                "WingoBot:",
                e.message
            );

        }

    }


    if (data) {

        liveCache = {

            rows:
                data.rows.slice(
                    -500
                ),

            currentIssue:
                data.currentIssue,

            fetchedAt:
                now(),

            source:
                data.source,

            error:
                null

        };

    } else {

        liveCache.error =
            error ||
            "LIVE_DATA_UNAVAILABLE";

    }


    return liveCache;

}


/* =====================================================
   ANALYSIS HELPERS
===================================================== */

function percentage(
    a,
    b
) {

    if (!b) {
        return 0;
    }


    return (
        a / b
    ) * 100;

}


function average(
    arr
) {

    if (!arr.length) {
        return 0;
    }


    return (
        arr.reduce(
            (
                sum,
                value
            ) =>
                sum + value,
            0
        ) /
        arr.length
    );

}


function median(
    arr
) {

    if (!arr.length) {
        return 0;
    }


    const values =
        [
            ...arr
        ].sort(
            (
                a,
                b
            ) =>
                a - b
        );


    const middle =
        Math.floor(
            values.length / 2
        );


    if (
        values.length %
        2 === 1
    ) {

        return values[
            middle
        ];

    }


    return (
        values[
            middle - 1
        ] +
        values[
            middle
        ]
    ) / 2;

}


/* =====================================================
   SWITCH COUNT
===================================================== */

function countSwitches(
    sequence
) {

    let count = 0;


    for (
        let i = 1;
        i < sequence.length;
        i++
    ) {

        if (
            sequence[i] !==
            sequence[i - 1]
        ) {

            count++;

        }

    }


    return count;

}


/* =====================================================
   STREAK INFO
===================================================== */

function streakInfo(
    sequence
) {

    if (
        !sequence.length
    ) {

        return {

            current:
                null,

            currentLength:
                0,

            longestBig:
                0,

            longestSmall:
                0

        };

    }


    const current =
        sequence[
            sequence.length - 1
        ];


    let currentLength =
        1;


    for (
        let i =
            sequence.length - 2;
        i >= 0;
        i--
    ) {

        if (
            sequence[i] ===
            current
        ) {

            currentLength++;

        } else {

            break;

        }

    }


    let longestBig = 0;

    let longestSmall = 0;

    let run = 0;

    let previous = null;


    for (
        const value of sequence
    ) {

        if (
            value ===
            previous
        ) {

            run++;

        } else {

            run = 1;

            previous =
                value;

        }


        if (
            value ===
            "BIG"
        ) {

            longestBig =
                Math.max(
                    longestBig,
                    run
                );

        } else {

            longestSmall =
                Math.max(
                    longestSmall,
                    run
                );

        }

    }


    return {

        current,

        currentLength,

        longestBig,

        longestSmall

    };

}


/* =====================================================
   RUN LENGTHS
===================================================== */

function runLengths(
    sequence
) {

    if (
        !sequence.length
    ) {

        return [];

    }


    const runs = [];

    let side =
        sequence[0];

    let length = 1;


    for (
        let i = 1;
        i < sequence.length;
        i++
    ) {

        if (
            sequence[i] ===
            side
        ) {

            length++;

        } else {

            runs.push({
                side,
                length
            });

            side =
                sequence[i];

            length = 1;

        }

    }


    runs.push({
        side,
        length
    });


    return runs;

}


/* =====================================================
   TRANSITION MATRIX
===================================================== */

function transitionMatrix(
    sequence
) {

    const matrix = {

        BIG: {
            BIG: 0,
            SMALL: 0
        },

        SMALL: {
            BIG: 0,
            SMALL: 0
        }

    };


    for (
        let i = 1;
        i < sequence.length;
        i++
    ) {

        const from =
            sequence[i - 1];

        const to =
            sequence[i];


        if (
            matrix[from] &&
            matrix[from][to] !==
                undefined
        ) {

            matrix[from][to]++;

        }

    }


    return matrix;

}


/* =====================================================
   DIGIT ANALYSIS
===================================================== */

function digitAnalysis(
    rows
) {

    const frequency =
        Array(10).fill(0);


    const gaps =
        Array(10).fill(null);


    for (
        let i = 0;
        i < rows.length;
        i++
    ) {

        const number =
            rows[i].number;


        if (
            isValidDigit(number)
        ) {

            frequency[
                number
            ]++;

        }

    }


    for (
        let digit = 0;
        digit <= 9;
        digit++
    ) {

        let gap = 0;

        let found = false;


        for (
            let i =
                rows.length - 1;
            i >= 0;
            i--
        ) {

            if (
                rows[i].number ===
                digit
            ) {

                found = true;

                break;

            }


            gap++;

        }


        gaps[digit] =
            found
                ? gap
                : null;

    }


    const numbers =
        rows.map(
            x => x.number
        );


    return {

        frequency,

        gaps,

        average:
            Number(
                average(
                    numbers
                ).toFixed(2)
            ),

        median:
            Number(
                median(
                    numbers
                ).toFixed(2)
            )

    };

}


/* =====================================================
   PATTERN ANALYSIS
===================================================== */

function patternAnalysis(
    sequence
) {

    const result = {

        alternation:
            false,

        alternationLength:
            0,

        repeatedBlocks: [],

        recentPattern:
            ""

    };


    const recent =
        sequence.slice(-12);


    result.recentPattern =
        recent.join("");


    /*
       Alternation
    */

    let length = 1;


    for (
        let i = recent.length - 1;
        i > 0;
        i--
    ) {

        if (
            recent[i] !==
            recent[i - 1]
        ) {

            length++;

        } else {

            break;

        }

    }


    if (
        length >= 4
    ) {

        result.alternation =
            true;

        result.alternationLength =
            length;

    }


    /*
       Repeating blocks
    */

    for (
        let size = 2;
        size <= 6;
        size++
    ) {

        if (
            sequence.length <
            size * 2
        ) {

            continue;

        }


        const first =
            sequence
                .slice(-size)
                .join("");


        const second =
            sequence
                .slice(
                    -size * 2,
                    -size
                )
                .join("");


        if (
            first ===
            second
        ) {

            result.repeatedBlocks
                .push(
                    size
                );

        }

    }


    return result;

}


/* =====================================================
   FULL ANALYSIS
===================================================== */

function analyze(
    rows
) {

    const validRows =
        rows
            .filter(
                row =>
                    row &&
                    isValidDigit(
                        row.number
                    ) &&
                    (
                        row.result ===
                        "BIG" ||
                        row.result ===
                        "SMALL"
                    )
            )
            .sort(
                (
                    a,
                    b
                ) =>
                    compareIssue(
                        a.issue,
                        b.issue
                    )
            );


    const last100 =
        validRows.slice(-100);


    const sequence =
        last100.map(
            row =>
                row.result
        );


    const total =
        sequence.length;


    if (!total) {

        return {

            prediction:
                "SKIP",

            confidence:
                0,

            classification:
                "INSUFFICIENT DATA",

            total: 0,

            big: 0,

            small: 0

        };

    }


    const big =
        sequence.filter(
            x =>
                x === "BIG"
        ).length;


    const small =
        total - big;


    const bigPct =
        percentage(
            big,
            total
        );


    const smallPct =
        percentage(
            small,
            total
        );


    const switches =
        countSwitches(
            sequence
        );


    const switchRate =
        total > 1
            ? percentage(
                switches,
                total - 1
            )
            : 0;


    const streak =
        streakInfo(
            sequence
        );


    const runs =
        runLengths(
            sequence
        );


    const transitions =
        transitionMatrix(
            sequence
        );


    const recent5 =
        sequence.slice(-5);


    const recent10 =
        sequence.slice(-10);


    const recent20 =
        sequence.slice(-20);


    const previous5 =
        sequence.slice(
            -10,
            -5
        );


    let bigScore = 0;

    let smallScore = 0;


    /*
       ===============================================
       FREQUENCY
       ===============================================
    */

    if (
        big > small
    ) {

        bigScore +=
            1.5;

    }


    if (
        small > big
    ) {

        smallScore +=
            1.5;

    }


    /*
       ===============================================
       RECENT WINDOW
       ===============================================
    */

    const windows = [
        5,
        10,
        20,
        30,
        50
    ];


    const weights = [
        35,
        25,
        20,
        12,
        8
    ];


    let weightedBig = 0;

    let weightedSmall = 0;


    for (
        let i = 0;
        i < windows.length;
        i++
    ) {

        const window =
            sequence.slice(
                -windows[i]
            );


        if (!window.length) {
            continue;
        }


        const wb =
            window.filter(
                x =>
                    x === "BIG"
            ).length;


        const ws =
            window.length -
            wb;


        weightedBig +=
            (
                wb /
                window.length
            ) *
            weights[i];


        weightedSmall +=
            (
                ws /
                window.length
            ) *
            weights[i];

    }


    bigScore +=
        weightedBig / 100;


    smallScore +=
        weightedSmall / 100;


    /*
       ===============================================
       MOMENTUM
       ===============================================
    */

    if (
        recent5.length &&
        previous5.length
    ) {

        const rb =
            recent5.filter(
                x =>
                    x === "BIG"
            ).length;


        const pb =
            previous5.filter(
                x =>
                    x === "BIG"
            ).length;


        if (
            rb > pb
        ) {

            bigScore +=
                0.8;

        }


        if (
            rb < pb
        ) {

            smallScore +=
                0.8;

        }

    }


    /*
       ===============================================
       TRANSITION
       ===============================================
    */

    const last =
        sequence[
            sequence.length - 1
        ];


    if (
        last &&
        transitions[last]
    ) {

        const same =
            transitions[last][last];


        const opposite =
            last === "BIG"
                ? transitions[last].SMALL
                : transitions[last].BIG;


        if (
            same >
            opposite
        ) {

            if (
                last === "BIG"
            ) {

                bigScore +=
                    0.7;

            } else {

                smallScore +=
                    0.7;

            }

        }


        if (
            opposite >
            same
        ) {

            if (
                last === "BIG"
            ) {

                smallScore +=
                    0.7;

            } else {

                bigScore +=
                    0.7;

            }

        }

    }


    /*
       ===============================================
       STREAK / REVERSAL PRESSURE
       ===============================================
    */

    if (
        streak.current ===
            "BIG" &&
        streak.currentLength >= 4
    ) {

        smallScore +=
            Math.min(
                1.3,
                streak.currentLength *
                0.18
            );

    }


    if (
        streak.current ===
            "SMALL" &&
        streak.currentLength >= 4
    ) {

        bigScore +=
            Math.min(
                1.3,
                streak.currentLength *
                0.18
            );

    }


    /*
       ===============================================
       SWITCHING
       ===============================================
    */

    if (
        switchRate >= 60
    ) {

        if (
            last === "BIG"
        ) {

            smallScore +=
                0.35;

        } else {

            bigScore +=
                0.35;

        }

    }


    if (
        switchRate < 40
    ) {

        if (
            last === "BIG"
        ) {

            bigScore +=
                0.30;

        } else {

            smallScore +=
                0.30;

        }

    }


    /*
       ===============================================
       ALTERNATION
       ===============================================
    */

    const recent8 =
        sequence.slice(-8);


    let alternating =
        recent8.length >= 6;


    for (
        let i = 1;
        i < recent8.length;
        i++
    ) {

        if (
            recent8[i] ===
            recent8[i - 1]
        ) {

            alternating =
                false;

            break;

        }

    }


    if (
        alternating
    ) {

        if (
            last === "BIG"
        ) {

            smallScore +=
                0.65;

        } else {

            bigScore +=
                0.65;

        }

    }


    /*
       ===============================================
       REPEATING BLOCKS
       ===============================================
    */

    const patterns =
        patternAnalysis(
            sequence
        );


    for (
        const size of
        patterns.repeatedBlocks
    ) {

        const block =
            sequence.slice(
                -size
            );


        const final =
            block[
                block.length - 1
            ];


        if (
            final === "BIG"
        ) {

            smallScore +=
                0.18;

        } else {

            bigScore +=
                0.18;

        }

    }


    /*
       ===============================================
       CONTRADICTION CONTROL
       ===============================================
    */

    const difference =
        Math.abs(
            bigScore -
            smallScore
        );


    if (
        difference < 0.30
    ) {

        bigScore *=
            0.85;

        smallScore *=
            0.85;

    }


    /*
       ===============================================
       DECISION
       ===============================================
    */

    let prediction =
        bigScore >=
        smallScore
            ? "BIG"
            : "SMALL";


    /*
       Confidence is model strength,
       NOT a guarantee.
    */

    let confidence =
        50 +
        (
            Math.abs(
                bigScore -
                smallScore
            ) * 10
        );


    confidence =
        Math.round(
            Math.max(
                50,
                Math.min(
                    92,
                    confidence
                )
            )
        );


    /*
       Sample-size penalty
    */

    if (
        total < 10
    ) {

        confidence =
            Math.min(
                confidence,
                55
            );

    } else if (
        total < 20
    ) {

        confidence =
            Math.min(
                confidence,
                62
            );

    }


    /*
       Classification
    */

    let classification;


    if (
        total < 10
    ) {

        classification =
            "INSUFFICIENT DATA";

        prediction =
            "SKIP";

    } else if (
        difference < 0.30
    ) {

        classification =
            "NO CLEAR SIGNAL";

    } else if (
        difference < 0.60
    ) {

        classification =
            "WEAK HISTORICAL BIAS";

    } else if (
        difference < 1.00
    ) {

        classification =
            "MODERATE HISTORICAL BIAS";

    } else {

        classification =
            "STRONG HISTORICAL BIAS";

    }


    /*
       Extra conflict protection
    */

    const recentBig =
        recent20.filter(
            x =>
                x === "BIG"
        ).length;


    const recentSmall =
        recent20.length -
        recentBig;


    if (
        recent20.length >= 10 &&
        Math.abs(
            recentBig -
            recentSmall
        ) <= 1 &&
        difference < 0.55
    ) {

        classification =
            "MIXED / CONFLICTING";

        confidence =
            Math.min(
                confidence,
                58
            );

    }


    const digits =
        digitAnalysis(
            last100
        );


    return {

        prediction,

        confidence,

        classification,

        total,

        big,

        small,

        bigPct:
            Number(
                bigPct.toFixed(2)
            ),

        smallPct:
            Number(
                smallPct.toFixed(2)
            ),

        switchRate:
            Number(
                switchRate.toFixed(2)
            ),

        streak,

        recent5,

        recent10,

        recent20,

        weighted: {

            big:
                Number(
                    weightedBig.toFixed(2)
                ),

            small:
                Number(
                    weightedSmall.toFixed(2)
                )

        },

        scores: {

            big:
                Number(
                    bigScore.toFixed(3)
                ),

            small:
                Number(
                    smallScore.toFixed(3)
                )

        },

        transitions,

        patterns,

        digits,

        runs:
            runs.slice(-20)

    };

}


/* =====================================================
   GET LATEST PREDICTION
===================================================== */

async function getLatestPrediction() {

    if (!pool) {
        return null;
    }


    const result =
        await pool.query(`
            SELECT *
            FROM prediction_records
            ORDER BY id DESC
            LIMIT 1
        `);


    return (
        result.rows[0] ||
        null
    );

}


/* =====================================================
   GET PENDING PREDICTION
===================================================== */

async function getPendingPrediction() {

    if (!pool) {
        return null;
    }


    const result =
        await pool.query(`
            SELECT *
            FROM prediction_records
            WHERE actual_result IS NULL
            ORDER BY id DESC
            LIMIT 1
        `);


    return (
        result.rows[0] ||
        null
    );

}


/* =====================================================
   CREATE PREDICTION
===================================================== */

async function createPrediction(
    targetIssue,
    analysis
) {

    if (
        !pool ||
        !targetIssue ||
        !analysis ||
        !analysis.prediction ||
        analysis.prediction === "SKIP"
    ) {

        return null;

    }


    /*
       Prevent duplicate pending target.
    */

    const existing =
        await pool.query(
            `
            SELECT *
            FROM prediction_records
            WHERE target_issue = $1
            AND actual_result IS NULL
            LIMIT 1
            `,
            [
                targetIssue
            ]
        );


    if (
        existing.rows.length
    ) {

        return existing.rows[0];

    }


    const result =
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
            VALUES
            ($1,$2,$3,$4,$5)
            RETURNING *
            `,
            [
                targetIssue,

                analysis.prediction,

                Number(
                    analysis.confidence ||
                    0
                ),

                MODEL,

                now()
            ]
        );


    return (
        result.rows[0] ||
        null
    );

}


/* =====================================================
   SETTLE PREDICTION
===================================================== */

async function settlePrediction(
    prediction,
    actualRow
) {

    if (
        !pool ||
        !prediction ||
        !actualRow
    ) {

        return prediction;

    }


    if (
        prediction.actual_result
    ) {

        return prediction;

    }


    const actual =
        actualRow.result;


    const actualNumber =
        actualRow.number;


    const status =
        prediction.prediction ===
            actual
            ? "WIN"
            : "LOSS";


    const result =
        await pool.query(
            `
            UPDATE prediction_records
            SET
                actual_number = $1,
                actual_result = $2,
                settled_at = $3
            WHERE id = $4
            RETURNING *
            `,
            [
                actualNumber,

                status,

                now(),

                prediction.id
            ]
        );


    return (
        result.rows[0] ||
        prediction
    );

}


/* =====================================================
   STALE PENDING CLEANUP
===================================================== */

async function cleanupStalePending(
    currentIssue,
    rows
) {

    if (
        !pool ||
        !currentIssue
    ) {

        return;

    }


    const pending =
        await getPendingPrediction();


    if (!pending) {
        return;
    }


    /*
       If target is older than current
       and cannot be settled, skip it.
    */

    if (
        compareIssue(
            pending.target_issue,
            currentIssue
        ) < 0
    ) {

        const actualRow =
            rows.find(
                row =>
                    compareIssue(
                        row.issue,
                        pending.target_issue
                    ) === 0
            );


        if (actualRow) {

            await settlePrediction(
                pending,
                actualRow
            );

        } else {

            await pool.query(
                `
                UPDATE prediction_records
                SET
                    actual_result = 'SKIPPED',
                    settled_at = $1
                WHERE id = $2
                AND actual_result IS NULL
                `,
                [
                    now(),
                    pending.id
                ]
            );

        }

    }

}


/* =====================================================
   COOLDOWN
===================================================== */

async function getCooldown() {

    if (!pool) {

        return {

            active:
                false,

            wait:
                0,

            completed:
                0

        };

    }


    const last =
        await getLatestPrediction();


    if (!last) {

        return {

            active:
                false,

            wait:
                0,

            completed:
                0

        };

    }


    /*
       Current pending prediction
       should NOT activate cooldown.
    */

    if (
        !last.actual_result
    ) {

        return {

            active:
                false,

            wait:
                0,

            completed:
                0,

            pending:
                true

        };

    }


    /*
       Count completed prediction
       records after the previous
       prediction.

       SKIPPED is not counted.
    */

    const result =
        await pool.query(
            `
            SELECT COUNT(*)::int AS count
            FROM prediction_records
            WHERE id > $1
            AND actual_result IN ('WIN','LOSS')
            `,
            [
                last.id
            ]
        );


    const completed =
        Number(
            result.rows[0]?.count ||
            0
        );


    if (
        completed >=
        COOLDOWN
    ) {

        return {

            active:
                false,

            wait:
                0,

            completed

        };

    }


    return {

        active:
            true,

        wait:
            COOLDOWN -
            completed,

        completed

    };

}


/* =====================================================
   BUILD STATE
===================================================== */

async function buildState() {

    /*
       Get latest live source.
    */

    await refreshLive();


    const rows =
        liveCache.rows || [];


    const currentIssue =
        normalizeIssue(
            liveCache.currentIssue
        );


    /*
       Clean old pending prediction.
    */

    await cleanupStalePending(
        currentIssue,
        rows
    );


    /*
       Settle current pending prediction
       if its target is now available.
    */

    let pending =
        await getPendingPrediction();


    if (
        pending &&
        currentIssue
    ) {

        const targetRow =
            rows.find(
                row =>
                    compareIssue(
                        row.issue,
                        pending.target_issue
                    ) === 0
            );


        if (
            targetRow
        ) {

            pending =
                await settlePrediction(
                    pending,
                    targetRow
                );

        }

    }


    /*
       Fresh analysis.
    */

    const analysis =
        analyze(
            rows
        );


    /*
       Get cooldown AFTER settlement.
    */

    let cooldown =
        await getCooldown();


    /*
       Get current pending again.
    */

    pending =
        await getPendingPrediction();


    /*
       If pending is older than current,
       cleanup may have skipped it.
    */

    if (
        pending &&
        currentIssue &&
        compareIssue(
            pending.target_issue,
            currentIssue
        ) < 0
    ) {

        pending = null;

    }


    /*
       Create a fresh prediction only when:
       - no pending prediction
       - cooldown complete
       - enough data
       - model has a signal
    */

    if (
        !pending &&
        !cooldown.active &&
        currentIssue &&
        rows.length >= 10 &&
        analysis.prediction !==
            "SKIP"
    ) {

        const target =
            nextIssue(
                currentIssue
            );


        if (target) {

            pending =
                await createPrediction(
                    target,
                    analysis
                );

        }

    }


    /*
       Refresh cooldown after possible
       prediction creation.
    */

    cooldown =
        await getCooldown();


    /*
       Last 30 actual results.
    */

    const last30 =
        rows
            .slice(-30)
            .reverse();


    /*
       Prediction history.
    */

    let predictionHistory =
        [];


    if (pool) {

        const result =
            await pool.query(`
                SELECT *
                FROM prediction_records
                ORDER BY id DESC
                LIMIT 100
            `);


        predictionHistory =
            result.rows;

    }


    /*
       Latest result.
    */

    const latest =
        rows.length
            ? rows[
                rows.length - 1
              ]
            : null;


    return {

        ok:
            true,

        model:
            MODEL,

        serverTime:
            now(),

        poll:
            POLL,

        cooldownRounds:
            COOLDOWN,

        source:
            liveCache.source,

        fetchedAt:
            liveCache.fetchedAt,

        liveError:
            liveCache.error,

        currentIssue,

        latest,

        nextIssue:
            nextIssue(
                currentIssue
            ),

        dataCount:
            rows.length,

        analysis,

        prediction:
            pending
                ? {

                    id:
                        pending.id,

                    targetIssue:
                        pending.target_issue,

                    prediction:
                        pending.prediction,

                    confidence:
                        pending.confidence,

                    model:
                        pending.model_version,

                    actualNumber:
                        pending.actual_number,

                    status:
                        pending.actual_result

                }
                : null,

        cooldown,

        last30,

        history:
            predictionHistory

    };

}


/* =====================================================
   READ BODY
===================================================== */

function readBody(
    req
) {

    return new Promise(
        (
            resolve,
            reject
        ) => {

            let body = "";


            req.on(
                "data",
                chunk => {

                    body +=
                        chunk;


                    if (
                        body.length >
                        1024 * 1024
                    ) {

                        reject(
                            new Error(
                                "BODY_TOO_LARGE"
                            )
                        );

                        req.destroy();

                    }

                }
            );


            req.on(
                "end",
                () => {

                    if (!body) {

                        resolve({});

                        return;

                    }


                    try {

                        resolve(
                            JSON.parse(
                                body
                            )
                        );

                    } catch (_) {

                        reject(
                            new Error(
                                "INVALID_JSON"
                            )
                        );

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


/* =====================================================
   ADMIN AUTH
===================================================== */

function isAdmin(
    req,
    url
) {

    const queryKey =
        url.searchParams.get(
            "key"
        ) || "";


    const headerKey =
        String(
            req.headers[
                "x-admin-key"
            ] || ""
        ).trim();


    const authorization =
        String(
            req.headers[
                "authorization"
            ] || ""
        ).trim();


    let bearerKey = "";


    if (
        authorization
            .toLowerCase()
            .startsWith(
                "bearer "
            )
    ) {

        bearerKey =
            authorization
                .slice(7)
                .trim();

    }


    return (
        queryKey ===
            ADMIN_KEY ||

        headerKey ===
            ADMIN_KEY ||

        bearerKey ===
            ADMIN_KEY
    );

}


/* =====================================================
   ACCESS KEY CHECK
   GET + POST + HEADER SUPPORT
===================================================== */

async function checkAccessKey(
    req,
    url
) {

    if (!pool) {

        return {

            status: 500,

            data: {

                ok:
                    false,

                valid:
                    false,

                error:
                    "DATABASE_NOT_CONFIGURED"

            }

        };

    }


    let body = {};


    /*
       POST JSON
    */

    if (
        req.method ===
        "POST"
    ) {

        try {

            body =
                await readBody(
                    req
                );

        } catch (e) {

            return {

                status:
                    400,

                data: {

                    ok:
                        false,

                    valid:
                        false,

                    error:
                        e.message

                }

            };

        }

    }


    /*
       Query support
    */

    const queryKey =
        String(
            url.searchParams.get(
                "key"
            ) || ""
        ).trim();


    const queryDevice =
        String(
            url.searchParams.get(
                "deviceId"
            ) || ""
        ).trim();


    /*
       Header support
    */

    const headerKey =
        String(
            req.headers[
                "x-access-key"
            ] || ""
        ).trim();


    const headerDevice =
        String(
            req.headers[
                "x-device-id"
            ] || ""
        ).trim();


    /*
       Final key
    */

    const accessKey =
        String(
            body.key ||
            queryKey ||
            headerKey ||
            ""
        ).trim();


    const deviceId =
        String(
            body.deviceId ||
            queryDevice ||
            headerDevice ||
            ""
        ).trim();


    if (!accessKey) {

        return {

            status:
                400,

            data: {

                ok:
                    false,

                valid:
                    false,

                error:
                    "ACCESS_KEY_REQUIRED"

            }

        };

    }


    if (!deviceId) {

        return {

            status:
                400,

            data: {

                ok:
                    false,

                valid:
                    false,

                error:
                    "DEVICE_ID_REQUIRED"

            }

        };

    }


    /*
       Find access key
    */

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

            status:
                401,

            data: {

                ok:
                    false,

                valid:
                    false,

                error:
                    "INVALID_ACCESS_KEY"

            }

        };

    }


    const row =
        result.rows[0];


    /*
       Existing device binding
    */

    if (
        row.device_id &&
        row.device_id !==
            deviceId
    ) {

        return {

            status:
                403,

            data: {

                ok:
                    false,

                valid:
                    false,

                error:
                    "KEY_BOUND_TO_OTHER_DEVICE"

            }

        };

    }


    /*
       First login:
       bind this browser/device.
    */

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


    return {

        status:
            200,

        data: {

            ok:
                true,

            valid:
                true,

            message:
                "ACCESS_KEY_VALID",

            key:
                row.access_key,

            deviceId

        }

    };

}


/* =====================================================
   STATIC FILE - NORMAL
===================================================== */

function serveFile(
    res,
    filePath,
    contentType
) {

    if (
        !fs.existsSync(
            filePath
        )
    ) {

        return json(
            res,
            404,
            {

                ok:
                    false,

                error:
                    "FILE_NOT_FOUND",

                file:
                    path.basename(
                        filePath
                    )

            }
        );

    }


    const data =
        fs.readFileSync(
            filePath
        );


    res.writeHead(
        200,
        {

            "Content-Type":
                contentType,

            "Cache-Control":
                "no-cache, no-store, must-revalidate",

            "Pragma":
                "no-cache",

            "Expires":
                "0"

        }
    );


    res.end(data);

}


/* =====================================================
   STATIC MP3 RANGE
===================================================== */

function serveRangeFile(
    req,
    res,
    filePath,
    contentType
) {

    if (
        !fs.existsSync(
            filePath
        )
    ) {

        return json(
            res,
            404,
            {
                ok:
                    false,

                error:
                    "FILE_NOT_FOUND"
            }
        );

    }


    const stat =
        fs.statSync(
            filePath
        );


    const total =
        stat.size;


    const range =
        req.headers.range;


    if (!range) {

        res.writeHead(
            200,
            {

                "Content-Type":
                    contentType,

                "Content-Length":
                    total,

                "Accept-Ranges":
                    "bytes"

            }
        );


        return fs
            .createReadStream(
                filePath
            )
            .pipe(res);

    }


    const match =
        range.match(
            /bytes=(\d*)-(\d*)/
        );


    if (!match) {

        res.writeHead(
            416
        );

        return res.end();

    }


    const start =
        match[1]
            ? Number(
                match[1]
            )
            : 0;


    const end =
        match[2]
            ? Number(
                match[2]
            )
            : total - 1;


    if (
        start < 0 ||
        end >= total ||
        start > end
    ) {

        res.writeHead(
            416
        );

        return res.end();

    }


    const length =
        end - start + 1;


    res.writeHead(
        206,
        {

            "Content-Range":
                `bytes ${start}-${end}/${total}`,

            "Accept-Ranges":
                "bytes",

            "Content-Length":
                length,

            "Content-Type":
                contentType

        }
    );


    fs
        .createReadStream(
            filePath,
            {
                start,
                end
            }
        )
        .pipe(res);

}


/* =====================================================
   HTTP SERVER
===================================================== */

const server =
    http.createServer(
        async (
            req,
            res
        ) => {

            try {

                /*
                   OPTIONS
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
                                "Content-Type, Authorization, X-Admin-Key, X-Access-Key, X-Device-Id",

                            "Access-Control-Allow-Methods":
                                "GET,POST,OPTIONS"
                        }
                    );

                    return res.end();

                }


                const url =
                    new URL(
                        req.url,
                        `http://${req.headers.host}`
                    );


                const p =
                    url.pathname;


                /* =================================================
                   HEALTH
                ================================================= */

                if (
                    p ===
                    "/health"
                ) {

                    return json(
                        res,
                        200,
                        {

                            ok:
                                true,

                            service:
                                "DY AI WinGo",

                            uptime:
                                process.uptime(),

                            database:
                                !!pool,

                            liveAPI:
                                !!LIVE_API_URL,

                            wingoBot:
                                !!WINGOBOT_TOKEN,

                            source:
                                liveCache.source,

                            currentIssue:
                                liveCache.currentIssue,

                            time:
                                now()

                        }
                    );

                }


                /* =================================================
                   HOME
                ================================================= */

                if (
                    p === "/" ||
                    p === "/prediction.html"
                ) {

                    return serveFile(
                        res,
                        path.join(
                            process.cwd(),
                            "prediction.html"
                        ),
                        "text/html; charset=utf-8"
                    );

                }


                /* =================================================
                   ADMIN PAGE
                ================================================= */

                if (
                    p ===
                    "/admin.html"
                ) {

                    return serveFile(
                        res,
                        path.join(
                            process.cwd(),
                            "admin.html"
                        ),
                        "text/html; charset=utf-8"
                    );

                }


                /* =================================================
                   MUSIC
                ================================================= */

                if (
                    p ===
                    "/music.mp3"
                ) {

                    return serveRangeFile(
                        req,
                        res,
                        path.join(
                            process.cwd(),
                            "music.mp3"
                        ),
                        "audio/mpeg"
                    );

                }


                /* =================================================
                   ACCESS KEY CHECK
                ================================================= */

                if (
                    p ===
                    "/api/key/check" &&
                    (
                        req.method ===
                        "GET" ||

                        req.method ===
                        "POST"
                    )
                ) {

                    const result =
                        await checkAccessKey(
                            req,
                            url
                        );


                    return json(
                        res,
                        result.status,
                        result.data
                    );

                }


                /* =================================================
                   STATE
                ================================================= */

                if (
                    p ===
                    "/api/state" &&
                    req.method ===
                    "GET"
                ) {

                    return json(
                        res,
                        200,
                        await buildState()
                    );

                }


                /* =================================================
                   HISTORY
                ================================================= */

                if (
                    p ===
                    "/api/history" &&
                    req.method ===
                    "GET"
                ) {

                    if (!pool) {

                        return json(
                            res,
                            500,
                            {

                                ok:
                                    false,

                                error:
                                    "DATABASE_NOT_CONFIGURED"

                            }
                        );

                    }


                    const result =
                        await pool.query(`
                            SELECT *
                            FROM prediction_records
                            ORDER BY id DESC
                            LIMIT 100
                        `);


                    return json(
                        res,
                        200,
                        {

                            ok:
                                true,

                            rows:
                                result.rows

                        }
                    );

                }


                /* =================================================
                   ADMIN PING
                ================================================= */

                if (
                    p ===
                    "/api/admin/ping"
                ) {

                    if (
                        !isAdmin(
                            req,
                            url
                        )
                    ) {

                        return json(
                            res,
                            401,
                            {

                                ok:
                                    false,

                                error:
                                    "UNAUTHORIZED"

                            }
                        );

                    }


                    return json(
                        res,
                        200,
                        {

                            ok:
                                true,

                            pong:
                                true,

                            time:
                                now()

                        }
                    );

                }


                /* =================================================
                   ADMIN STATUS
                ================================================= */

                if (
                    p ===
                    "/api/admin/status"
                ) {

                    if (
                        !isAdmin(
                            req,
                            url
                        )
                    ) {

                        return json(
                            res,
                            401,
                            {

                                ok:
                                    false,

                                error:
                                    "UNAUTHORIZED"

                            }
                        );

                    }


                    return json(
                        res,
                        200,
                        {

                            ok:
                                true,

                            serverTime:
                                now(),

                            uptime:
                                process.uptime(),

                            database:
                                !!pool,

                            liveConfigured:
                                !!LIVE_API_URL,

                            wingoBotConfigured:
                                !!WINGOBOT_TOKEN,

                            source:
                                liveCache.source,

                            fetchedAt:
                                liveCache.fetchedAt,

                            currentIssue:
                                liveCache.currentIssue,

                            error:
                                liveCache.error,

                            model:
                                MODEL,

                            cooldown:
                                COOLDOWN

                        }
                    );

                }


                /* =================================================
                   ADMIN LIVE TEST
                ================================================= */

                if (
                    p ===
                    "/api/admin/live-test"
                ) {

                    if (
                        !isAdmin(
                            req,
                            url
                        )
                    ) {

                        return json(
                            res,
                            401,
                            {

                                ok:
                                    false,

                                error:
                                    "UNAUTHORIZED"

                            }
                        );

                    }


                    const data =
                        await refreshLive();


                    return json(
                        res,
                        200,
                        {

                            ok:
                                data.rows.length >
                                0,

                            source:
                                data.source,

                            currentIssue:
                                data.currentIssue,

                            fetchedAt:
                                data.fetchedAt,

                            count:
                                data.rows.length,

                            rows:
                                data.rows.slice(
                                    -30
                                ),

                            error:
                                data.error

                        }
                    );

                }


                /* =================================================
                   ADMIN WINGOBOT TEST
                ================================================= */

                if (
                    p ===
                    "/api/admin/wingo-test"
                ) {

                    if (
                        !isAdmin(
                            req,
                            url
                        )
                    ) {

                        return json(
                            res,
                            401,
                            {
                                ok:
                                    false,

                                error:
                                    "UNAUTHORIZED"
                            }
                        );

                    }


                    try {

                        const data =
                            await fetchWingoBot();


                        return json(
                            res,
                            200,
                            {

                                ok:
                                    true,

                                source:
                                    data.source,

                                currentIssue:
                                    data.currentIssue,

                                count:
                                    data.rows.length,

                                rows:
                                    data.rows.slice(
                                        -30
                                    )

                            }
                        );

                    } catch (e) {

                        return json(
                            res,
                            200,
                            {

                                ok:
                                    false,

                                error:
                                    e.message

                            }
                        );

                    }

                }


                /* =================================================
                   ADMIN MODEL TEST
                ================================================= */

                if (
                    p ===
                    "/api/admin/model-test"
                ) {

                    if (
                        !isAdmin(
                            req,
                            url
                        )
                    ) {

                        return json(
                            res,
                            401,
                            {
                                ok:
                                    false
                            }
                        );

                    }


                    await refreshLive();


                    const analysis =
                        analyze(
                            liveCache.rows
                        );


                    return json(
                        res,
                        200,
                        {

                            ok:
                                true,

                            model:
                                MODEL,

                            source:
                                liveCache.source,

                            currentIssue:
                                liveCache.currentIssue,

                            analysis

                        }
                    );

                }


                /* =================================================
                   ADMIN KEYS - GET
                ================================================= */

                if (
                    p ===
                    "/api/admin/keys" &&
                    req.method ===
                    "GET"
                ) {

                    if (
                        !isAdmin(
                            req,
                            url
                        )
                    ) {

                        return json(
                            res,
                            401,
                            {
                                ok:
                                    false,

                                error:
                                    "UNAUTHORIZED"
                            }
                        );

                    }


                    if (!pool) {

                        return json(
                            res,
                            500,
                            {

                                ok:
                                    false,

                                error:
                                    "DATABASE_NOT_CONFIGURED"

                            }
                        );

                    }


                    const result =
                        await pool.query(`
                            SELECT
                                id,
                                access_key,
                                device_id,
                                created_at,
                                last_seen
                            FROM access_keys
                            ORDER BY id DESC
                        `);


                    return json(
                        res,
                        200,
                        {

                            ok:
                                true,

                            rows:
                                result.rows

                        }
                    );

                }


                /* =================================================
                   ADMIN KEYS - POST
                ================================================= */

                if (
                    p ===
                    "/api/admin/keys" &&
                    req.method ===
                    "POST"
                ) {

                    if (
                        !isAdmin(
                            req,
                            url
                        )
                    ) {

                        return json(
                            res,
                            401,
                            {

                                ok:
                                    false,

                                error:
                                    "UNAUTHORIZED"

                            }
                        );

                    }


                    if (!pool) {

                        return json(
                            res,
                            500,
                            {

                                ok:
                                    false,

                                error:
                                    "DATABASE_NOT_CONFIGURED"

                            }
                        );

                    }


                    let body;


                    try {

                        body =
                            await readBody(
                                req
                            );

                    } catch (e) {

                        return json(
                            res,
                            400,
                            {

                                ok:
                                    false,

                                error:
                                    e.message

                            }
                        );

                    }


                    let accessKey =
                        String(
                            body.key ||
                            ""
                        ).trim();


                    /*
                       Auto key
                    */

                    if (
                        !accessKey
                    ) {

                        accessKey =
                            "DY-" +
                            Math.random()
                                .toString(
                                    36
                                )
                                .slice(
                                    2,
                                    10
                                )
                                .toUpperCase();

                    }


                    try {

                        const result =
                            await pool.query(
                                `
                                INSERT INTO access_keys
                                (
                                    access_key,
                                    created_at
                                )
                                VALUES
                                ($1,$2)
                                RETURNING *
                                `,
                                [
                                    accessKey,
                                    now()
                                ]
                            );


                        return json(
                            res,
                            200,
                            {

                                ok:
                                    true,

                                key:
                                    result.rows[0]

                            }
                        );

                    } catch (e) {

                        if (
                            e.code ===
                            "23505"
                        ) {

                            return json(
                                res,
                                409,
                                {

                                    ok:
                                        false,

                                    error:
                                        "KEY_ALREADY_EXISTS"

                                }
                            );

                        }


                        throw e;

                    }

                }


                /* =================================================
                   ADMIN RESET DEVICE
                ================================================= */

                if (
                    p ===
                    "/api/admin/reset-device" &&
                    req.method ===
                    "POST"
                ) {

                    if (
                        !isAdmin(
                            req,
                            url
                        )
                    ) {

                        return json(
                            res,
                            401,
                            {
                                ok:
                                    false,

                                error:
                                    "UNAUTHORIZED"
                            }
                        );

                    }


                    if (!pool) {

                        return json(
                            res,
                            500,
                            {

                                ok:
                                    false,

                                error:
                                    "DATABASE_NOT_CONFIGURED"

                            }
                        );

                    }


                    const body =
                        await readBody(
                            req
                        );


                    const id =
                        Number(
                            body.id
                        );


                    if (
                        !Number.isInteger(
                            id
                        ) ||
                        id <= 0
                    ) {

                        return json(
                            res,
                            400,
                            {

                                ok:
                                    false,

                                error:
                                    "VALID_ID_REQUIRED"

                            }
                        );

                    }


                    const result =
                        await pool.query(
                            `
                            UPDATE access_keys
                            SET
                                device_id = NULL,
                                last_seen = 0
                            WHERE id = $1
                            RETURNING *
                            `,
                            [
                                id
                            ]
                        );


                    return json(
                        res,
                        200,
                        {

                            ok:
                                result.rows.length >
                                0,

                            row:
                                result.rows[0] ||
                                null

                        }
                    );

                }


                /* =================================================
                   ADMIN PREDICTIONS
                ================================================= */

                if (
                    p ===
                    "/api/admin/predictions"
                ) {

                    if (
                        !isAdmin(
                            req,
                            url
                        )
                    ) {

                        return json(
                            res,
                            401,
                            {
                                ok:
                                    false,

                                error:
                                    "UNAUTHORIZED"
                            }
                        );

                    }


                    if (!pool) {

                        return json(
                            res,
                            500,
                            {

                                ok:
                                    false,

                                error:
                                    "DATABASE_NOT_CONFIGURED"

                            }
                        );

                    }


                    const result =
                        await pool.query(`
                            SELECT *
                            FROM prediction_records
                            ORDER BY id DESC
                            LIMIT 200
                        `);


                    return json(
                        res,
                        200,
                        {

                            ok:
                                true,

                            rows:
                                result.rows

                        }
                    );

                }


                /* =================================================
                   404
                ================================================= */

                return json(
                    res,
                    404,
                    {

                        ok:
                            false,

                        error:
                            "NOT_FOUND",

                        path:
                            p

                    }
                );


            } catch (error) {

                console.error(
                    "SERVER ERROR:",
                    error
                );


                return json(
                    res,
                    500,
                    {

                        ok:
                            false,

                        error:
                            error.message ||
                            "SERVER_ERROR"

                    }
                );

            }

        }
    );


/* =====================================================
   START SERVER
===================================================== */

(async () => {

    try {

        await initDB();


        server.listen(
            PORT,
            "0.0.0.0",
            () => {

                console.log(
                    "======================================"
                );

                console.log(
                    " DY AI WinGo Server"
                );

                console.log(
                    " PORT:",
                    PORT
                );

                console.log(
                    " MODEL:",
                    MODEL
                );

                console.log(
                    " COOLDOWN:",
                    COOLDOWN
                );

                console.log(
                    " DATABASE:",
                    pool
                        ? "CONNECTED"
                        : "NOT CONFIGURED"
                );

                console.log(
                    " LIVE API:",
                    LIVE_API_URL
                        ? "CONFIGURED"
                        : "NOT CONFIGURED"
                );

                console.log(
                    " WINGOBOT:",
                    WINGOBOT_TOKEN
                        ? "CONFIGURED"
                        : "NOT CONFIGURED"
                );

                console.log(
                    " ADMIN KEY:",
                    ADMIN_KEY
                        ? "CONFIGURED"
                        : "MISSING"
                );

                console.log(
                    "======================================"
                );

            }
        );

    } catch (error) {

        console.error(
            "START ERROR:",
            error
        );

        process.exit(
            1
        );

    }

})();
