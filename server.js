"use strict";

/*
============================================================
                 DY AI WINGO SERVER
        HUMAN PATTERN + OPPOSITE ENGINE
============================================================

A = SMALL
B = BIG

0-4 = SMALL
5-9 = BIG

ENGINE:

1. WingoBot se live history
2. Numbers -> A/B
3. 25 Master patterns
4. Har pattern ka opposite
5. EXACT match = strongest
6. Strong PARTIAL match = prediction allowed
7. Weak partial = WATCH
8. Multiple matches = weighted consensus
9. Prediction = matched pattern endpoint ka opposite
10. No forced alternation
11. No random prediction

IMPORTANT:
Historical pattern analysis only.
Prediction guaranteed nahi hai.
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
    String(
        process.env.ADMIN_KEY || ""
    ).trim();

const WINGOBOT_TOKEN =
    String(
        process.env.WINGOBOT_TOKEN || ""
    ).trim();

const DATABASE_URL =
    String(
        process.env.DATABASE_URL || ""
    ).trim();


const WINGOBOT_API =
    "https://api.wingobot.com/v2/30-sec-game-history";


const MODEL_VERSION =
    "DY-AI-TASHAN-PATTERN-V7";


const THINKING_DURATION_MS =
    3000;


const PROVIDER_REFRESH_MS =
    3000;


const REQUEST_TIMEOUT_MS =
    12000;


// ============================================================
// PATTERN SETTINGS
// ============================================================

/*
Exact match:
100%

Strong partial:
70%+ AND minimum 7 matched

Very strong partial:
80%+

Weak partial:
below 70%
*/

const PARTIAL_MIN_MATCH =
    7;

const PARTIAL_MIN_PERCENT =
    70;


/*
Minimum support required when
several partial patterns are present.
*/

const MIN_PARTIAL_SUPPORT =
    6;


/*
If two sides are too close,
do not generate prediction.
*/

const MIN_SUPPORT_GAP =
    25;


// ============================================================
// DATABASE
// ============================================================

let pool = null;


if (DATABASE_URL) {

    pool = new Pool({

        connectionString:
            DATABASE_URL,

        ssl:
            DATABASE_URL.includes(
                "localhost"
            )
                ? false
                : {
                    rejectUnauthorized: false
                }

    });

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


let refreshInProgress =
    false;


// ============================================================
// DATABASE INIT
// ============================================================

async function initDatabase() {

    if (!pool) {

        console.log(
            "[DB] DATABASE_URL missing"
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


    console.log(
        "[DB] Ready"
    );

}


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


    return n <= 4
        ? "A"
        : "B";

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
            .trim()
            .toUpperCase();


    if (value === "SMALL") {

        return "A";

    }


    if (value === "BIG") {

        return "B";

    }


    return null;

}


function oppositeSide(side) {

    if (side === "A") {

        return "B";

    }


    if (side === "B") {

        return "A";

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
            BigInt(
                String(a)
            );

        const bb =
            BigInt(
                String(b)
            );


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
// JSON
// ============================================================

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
    type =
        "text/plain; charset=utf-8"
) {

    res.writeHead(

        status,

        {

            "Content-Type":
                type,

            "Cache-Control":
                "no-store"

        }

    );


    res.end(body);

}


// ============================================================
// BODY
// ============================================================

function readBody(req) {

    return new Promise(
        (
            resolve,
            reject
        ) => {

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
                            JSON.parse(
                                data
                            )
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
// WINGOBOT API
// ============================================================

function fetchWingoBot() {

    return new Promise(
        (
            resolve,
            reject
        ) => {

            if (
                !WINGOBOT_TOKEN
            ) {

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
                                "DY-AI-Wingo"

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

                                    resolve(
                                        JSON.parse(
                                            body
                                        )
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
                            "WingoBot timeout"
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
// NORMALIZE WINGOBOT
// ============================================================

function normalizeHistory(
    payload
) {

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


    const result = [];


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

            result.push({

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


    /*
      Newest first.
    */

    result.sort(
        (
            a,
            b
        ) =>
            compareIssue(
                b.issueNumber,
                a.issueNumber
            )
    );


    return result;

}


// ============================================================
// CURRENT ISSUE
// ============================================================

function getCurrentIssue(
    payload
) {

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

    if (
        refreshInProgress
    ) {

        return providerState;

    }


    refreshInProgress =
        true;


    try {

        const payload =
            await fetchWingoBot();


        const history =
            normalizeHistory(
                payload
            );


        const currentIssue =
            getCurrentIssue(
                payload
            );


        providerState = {

            ok: true,

            currentIssue:
                currentIssue !== null
                    ? String(
                        currentIssue
                    )
                    : (
                        history[0]
                            ?.issueNumber ||
                        null
                    ),

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

        refreshInProgress =
            false;

    }

}


// ============================================================
// 25 MASTER PATTERNS
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

function oppositePattern(
    pattern
) {

    return String(pattern)
        .split("")
        .map(
            char =>
                char === "A"
                    ? "B"
                    : "A"
        )
        .join("");

}


// ============================================================
// PATTERN DATABASE
// ============================================================

const PATTERN_DATABASE = [];


for (
    const [
        id,
        pattern
    ]
    of Object.entries(
        MASTER_PATTERNS
    )
) {

    const clean =
        String(pattern)
            .replace(
                /[^AB]/g,
                ""
            );


    PATTERN_DATABASE.push({

        rule:
            Number(id),

        type:
            "ORIGINAL",

        pattern:
            clean,

        length:
            clean.length

    });


    PATTERN_DATABASE.push({

        rule:
            Number(id),

        type:
            "OPPOSITE",

        pattern:
            oppositePattern(
                clean
            ),

        length:
            clean.length

    });

}


// ============================================================
// CONVERT NUMBERS
// ============================================================

function convertHistory(
    numbers
) {

    const output = [];


    if (
        !Array.isArray(numbers)
    ) {

        return output;

    }


    for (
        const item of numbers
    ) {

        let number;


        if (
            item &&
            typeof item ===
                "object"
        ) {

            number =
                Number(
                    item.number ??
                    item.actual_number ??
                    item.value
                );

        } else {

            number =
                Number(item);

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
// EXACT MATCHES
// ============================================================

function findExactMatches(
    history
) {

    return PATTERN_DATABASE
        .filter(
            item =>
                exactMatch(
                    history,
                    item.pattern
                )
        )
        .map(
            item => ({

                ...item,

                matched:
                    item.length,

                matchPercent:
                    100

            })
        );

}


// ============================================================
// PARTIAL MATCH
// ============================================================

function partialMatch(
    history,
    pattern
) {

    const max =
        Math.min(
            history.length,
            pattern.length
        );


    let best = 0;


    /*
      Compare current suffix
      against pattern prefix.

      Example:

      History:
      B S B S S B B

      Pattern:
      B S B S S B B B

      7/8 matched.
    */

    for (
        let length = 2;
        length <= max;
        length++
    ) {

        const recent =
            history
                .slice(
                    -length
                )
                .join("");


        const expected =
            pattern.slice(
                0,
                length
            );


        if (
            recent ===
            expected
        ) {

            best =
                length;

        }

    }


    return best;

}


// ============================================================
// ALL PARTIAL MATCHES
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


        if (
            matched <
            PARTIAL_MIN_MATCH
        ) {

            continue;

        }


        /*
          Don't treat full match
          as partial.
        */

        if (
            matched >=
            item.length
        ) {

            continue;

        }


        const percent =
            Math.round(
                matched /
                item.length *
                100
            );


        if (
            percent <
            PARTIAL_MIN_PERCENT
        ) {

            continue;

        }


        matches.push({

            ...item,

            matched,

            matchPercent:
                percent

        });

    }


    return matches.sort(

        (a, b) => {

            if (
                b.matched !==
                a.matched
            ) {

                return (
                    b.matched -
                    a.matched
                );

            }


            if (
                b.matchPercent !==
                a.matchPercent
            ) {

                return (
                    b.matchPercent -
                    a.matchPercent
                );

            }


            if (
                b.length !==
                a.length
            ) {

                return (
                    b.length -
                    a.length
                );

            }


            if (
                a.type ===
                    "ORIGINAL" &&
                b.type ===
                    "OPPOSITE"
            ) {

                return -1;

            }


            return 0;

        }

    );

}


// ============================================================
// CURRENT STREAK
// ============================================================

function currentStreak(
    history
) {

    if (
        !history.length
    ) {

        return null;

    }


    const current =
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
            current
        ) {

            count++;

        } else {

            break;

        }

    }


    return {

        code:
            current,

        side:
            sideToLabel(
                current
            ),

        count

    };

}


// ============================================================
// WINDOW ANALYSIS
// ============================================================

function analyzeWindow(
    history,
    size
) {

    const data =
        history.slice(
            -size
        );


    if (
        !data.length
    ) {

        return {

            size: 0,

            big: 0,

            small: 0,

            bigPercent: 0,

            smallPercent: 0

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

function switching(
    history
) {

    if (
        history.length < 2
    ) {

        return {

            switches: 0,

            transitions: 0,

            rate: 0

        };

    }


    let count = 0;


    for (
        let i = 1;
        i < history.length;
        i++
    ) {

        if (
            history[i] !==
            history[i - 1]
        ) {

            count++;

        }

    }


    const transitions =
        history.length - 1;


    return {

        switches:
            count,

        transitions,

        rate:
            Number(
                (
                    count /
                    transitions *
                    100
                ).toFixed(2)
            )

    };

}


// ============================================================
// PATTERN BREAK
// ============================================================

function patternBreak(
    history
) {

    if (
        history.length < 6
    ) {

        return {

            detected: false,

            sequence: null

        };

    }


    const last6 =
        history.slice(-6);


    const first5 =
        last6.slice(0, 5);


    const alternating =
        first5.every(
            (
                value,
                index
            ) => {

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


    return {

        detected:
            alternating &&
            last6[4] ===
            last6[5],

        sequence:
            last6.join("")

    };

}


// ============================================================
// PARTIAL NEXT SIDE
// ============================================================

function getPatternNextSide(
    match
) {

    if (
        !match ||
        !match.pattern
    ) {

        return null;

    }


    /*
      For partial:

      matched portion ends at
      match.matched - 1

      The next pattern symbol is:

      pattern[matched]

      That is the continuation.

      User wants opposite of the
      matched endpoint, so we use
      the endpoint itself for reversal.
    */

    const index =
        (
            match.matched ??
            match.length
        ) - 1;


    const matchedSide =
        match.pattern[index];


    if (
        matchedSide !== "A" &&
        matchedSide !== "B"
    ) {

        return null;

    }


    return {

        matchedSide,

        matchedLabel:
            sideToLabel(
                matchedSide
            ),

        predictionSide:
            oppositeSide(
                matchedSide
            ),

        prediction:
            sideToLabel(
                oppositeSide(
                    matchedSide
                )
            )

    };

}


// ============================================================
// EXACT DECISION
// ============================================================

function exactDecision(
    matches
) {

    if (
        !matches.length
    ) {

        return null;

    }


    /*
      Longest pattern first.
    */

    const sorted =
        matches.slice().sort(

            (a, b) => {

                if (
                    b.length !==
                    a.length
                ) {

                    return (
                        b.length -
                        a.length
                    );

                }


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


                return (
                    a.rule -
                    b.rule
                );

            }

        );


    const best =
        sorted[0];


    const info =
        getPatternNextSide({

            ...best,

            matched:
                best.length

        });


    if (!info) {

        return null;

    }


    return {

        prediction:
            info.prediction,

        predictionCode:
            info.predictionSide,

        matchedSide:
            info.matchedLabel,

        matchedSideCode:
            info.matchedSide,

        matchedRule:
            best.rule,

        matchedType:
            best.type,

        matchedPattern:
            best.pattern,

        matchedLength:
            best.length,

        matchPercent:
            100,

        confidence:
            90,

        confidenceLevel:
            "EXACT_PATTERN",

        logic:
            `${best.type} Rule ${best.rule} exact match. Matched endpoint ${info.matchedLabel}; opposite = ${info.prediction}.`,

        bestMatch:
            best,

        allMatches:
            matches

    };

}


// ============================================================
// PARTIAL CONSENSUS
// ============================================================

function partialDecision(
    matches
) {

    if (
        !matches.length
    ) {

        return null;

    }


    let bigSupport = 0;
    let smallSupport = 0;


    const evidence = [];


    for (
        const match of
            matches
    ) {

        const info =
            getPatternNextSide(
                match
            );


        if (!info) {

            continue;

        }


        /*
          Weight:

          7 match  = 7
          8 match  = 9
          9 match  = 11
          etc.
        */

        let weight =
            match.matched;


        if (
            match.matchPercent >=
            85
        ) {

            weight += 3;

        } else if (
            match.matchPercent >=
            75
        ) {

            weight += 2;

        }


        if (
            match.type ===
            "ORIGINAL"
        ) {

            weight += 1;

        }


        if (
            info.predictionSide ===
            "B"
        ) {

            bigSupport +=
                weight;

        } else {

            smallSupport +=
                weight;

        }


        evidence.push({

            rule:
                match.rule,

            type:
                match.type,

            matched:
                match.matched,

            total:
                match.length,

            percent:
                match.matchPercent,

            matchedSide:
                info.matchedLabel,

            oppositePrediction:
                info.prediction,

            weight

        });

    }


    const total =
        bigSupport +
        smallSupport;


    if (
        total < MIN_PARTIAL_SUPPORT
    ) {

        return null;

    }


    const gap =
        Math.abs(
            bigSupport -
            smallSupport
        );


    /*
      Too close = conflict.
    */

    if (
        gap <
        MIN_SUPPORT_GAP
    ) {

        return {

            prediction:
                null,

            predictionCode:
                null,

            confidence:
                0,

            confidenceLevel:
                "CONFLICT",

            status:
                "CONFLICTING_PARTIAL",

            bigSupport,

            smallSupport,

            gap,

            evidence

        };

    }


    const predictionSide =
        bigSupport >
        smallSupport
            ? "B"
            : "A";


    const winningSupport =
        Math.max(
            bigSupport,
            smallSupport
        );


    const losingSupport =
        Math.min(
            bigSupport,
            smallSupport
        );


    const ratio =
        winningSupport /
        total;


    let confidence =
        Math.round(
            55 +
            ratio * 30
        );


    if (
        confidence > 84
    ) {

        confidence = 84;

    }


    return {

        prediction:
            sideToLabel(
                predictionSide
            ),

        predictionCode:
            predictionSide,

        confidence,

        confidenceLevel:
            "STRONG_PARTIAL",

        status:
            "STRONG_PARTIAL_PATTERN",

        bigSupport,

        smallSupport,

        gap,

        evidence,

        logic:
            `Strong partial pattern consensus. BIG support ${bigSupport}, SMALL support ${smallSupport}.`

    };

}


// ============================================================
// MAIN PATTERN ENGINE
// ============================================================

function analyzePattern(
    numbers
) {

    const history =
        convertHistory(
            numbers
        );


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

            message:
                "At least 5 valid results required."

        };

    }


    /*
      EXACT
    */

    const exactMatches =
        findExactMatches(
            history
        );


    /*
      PARTIAL
    */

    const partialMatches =
        findPartialMatches(
            history
        );


    /*
      Supporting analytics
    */

    const windows = {

        last5:
            analyzeWindow(
                history,
                5
            ),

        last10:
            analyzeWindow(
                history,
                10
            ),

        last20:
            analyzeWindow(
                history,
                20
            ),

        last30:
            analyzeWindow(
                history,
                30
            )

    };


    const streak =
        currentStreak(
            history
        );


    const switchInfo =
        switching(
            history
        );


    const breakInfo =
        patternBreak(
            history
        );


    /*
      ========================================================
      EXACT MATCH HAS TOP PRIORITY
      ========================================================
    */

    if (
        exactMatches.length > 0
    ) {

        const decision =
            exactDecision(
                exactMatches
            );


        if (decision) {

            return {

                status:
                    "EXACT_PATTERN_MATCH",

                prediction:
                    decision.prediction,

                predictionCode:
                    decision.predictionCode,

                confidence:
                    decision.confidence,

                confidenceLevel:
                    decision.confidenceLevel,


                matchedRule:
                    decision.matchedRule,

                matchedType:
                    decision.matchedType,

                matchedPattern:
                    decision.matchedPattern,

                matchedLength:
                    decision.matchedLength,

                matchPercent:
                    100,


                matchedSide:
                    decision.matchedSide,

                matchedSideCode:
                    decision.matchedSideCode,


                logic:
                    decision.logic,


                bestMatch:
                    {

                        rule:
                            decision.bestMatch.rule,

                        type:
                            decision.bestMatch.type,

                        pattern:
                            decision.bestMatch.pattern,

                        length:
                            decision.bestMatch.length

                    },


                allMatches:
                    decision.allMatches.map(
                        item => ({

                            rule:
                                item.rule,

                            type:
                                item.type,

                            pattern:
                                item.pattern,

                            length:
                                item.length

                        })
                    ),


                partialMatches:
                    partialMatches
                        .slice(0, 10),


                currentStreak:
                    streak,


                windows,


                switching:
                    switchInfo,


                patternBreak:
                    breakInfo,


                sequence:
                    history.join(""),


                dataSize:
                    history.length,


                engine:
                    "25 MASTER + OPPOSITE + EXACT PRIORITY",


                message:
                    "Exact pattern matched. Opposite-side pattern rule activated.",


                warning:
                    "Historical pattern analysis only; no result is guaranteed."

            };

        }

    }


    /*
      ========================================================
      STRONG PARTIAL MATCH
      ========================================================
    */

    const partial =
        partialDecision(
            partialMatches
        );


    if (
        partial &&
        partial.prediction
    ) {

        const best =
            partialMatches[0];


        return {

            status:
                "STRONG_PARTIAL_PATTERN",

            prediction:
                partial.prediction,

            predictionCode:
                partial.predictionCode,

            confidence:
                partial.confidence,

            confidenceLevel:
                partial.confidenceLevel,


            matchedRule:
                best?.rule ??
                null,

            matchedType:
                best?.type ??
                null,

            matchedPattern:
                best?.pattern ??
                null,

            matchedLength:
                best?.matched ??
                null,

            matchPercent:
                best?.matchPercent ??
                null,


            matchedSide:
                best
                    ? getPatternNextSide(
                        best
                    )?.matchedLabel ||
                    null
                    : null,


            logic:
                partial.logic,


            support: {

                big:
                    partial.bigSupport,

                small:
                    partial.smallSupport,

                gap:
                    partial.gap

            },


            bestMatch:
                best
                    ? {

                        rule:
                            best.rule,

                        type:
                            best.type,

                        pattern:
                            best.pattern,

                        matched:
                            best.matched,

                        length:
                            best.length,

                        percent:
                            best.matchPercent

                    }
                    : null,


            partialMatches:
                partialMatches
                    .slice(
                        0,
                        15
                    ),


            evidence:
                partial.evidence,


            currentStreak:
                streak,


            windows,


            switching:
                switchInfo,


            patternBreak:
                breakInfo,


            sequence:
                history.join(""),


            dataSize:
                history.length,


            engine:
                "25 MASTER + OPPOSITE + EXACT + STRONG PARTIAL",


            message:
                "Strong partial pattern consensus found.",


            warning:
                "Partial historical pattern is not a guarantee."

        };

    }


    /*
      ========================================================
      CONFLICT
      ========================================================
    */

    if (
        partial &&
        partial.status ===
        "CONFLICTING_PARTIAL"
    ) {

        return {

            status:
                "CONFLICTING_PARTIAL",

            prediction:
                null,

            predictionCode:
                null,

            confidence:
                0,


            support: {

                big:
                    partial.bigSupport,

                small:
                    partial.smallSupport,

                gap:
                    partial.gap

            },


            partialMatches:
                partialMatches
                    .slice(
                        0,
                        15
                    ),


            currentStreak:
                streak,


            windows,


            switching:
                switchInfo,


            patternBreak:
                breakInfo,


            sequence:
                history.join(""),


            dataSize:
                history.length,


            engine:
                "25 MASTER + OPPOSITE + EXACT + STRONG PARTIAL",


            message:
                "Patterns are conflicting. Prediction withheld.",


            warning:
                "No forced prediction during pattern conflict."

        };

    }


    /*
      ========================================================
      PARTIAL WATCH
      ========================================================
    */

    const watch =
        partialMatches[0];


    if (watch) {

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
                watch.rule,

            matchedType:
                watch.type,

            matchedPattern:
                watch.pattern,

            matchedLength:
                watch.matched,

            matchPercent:
                watch.matchPercent,


            currentStreak:
                streak,


            windows,


            switching:
                switchInfo,


            patternBreak:
                breakInfo,


            partialMatches:
                partialMatches
                    .slice(
                        0,
                        15
                    ),


            sequence:
                history.join(""),


            dataSize:
                history.length,


            engine:
                "25 MASTER + OPPOSITE + EXACT + STRONG PARTIAL",


            message:
                "Partial similarity found but support is not strong enough.",


            warning:
                "Prediction withheld until stronger pattern evidence appears."

        };

    }


    /*
      ========================================================
      NO PATTERN
      ========================================================
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

        matchedLength:
            null,

        matchPercent:
            null,


        currentStreak:
            streak,


        windows,


        switching:
            switchInfo,


        patternBreak:
            breakInfo,


        sequence:
            history.join(""),


        dataSize:
            history.length,


        engine:
            "25 MASTER + OPPOSITE + EXACT + STRONG PARTIAL",


        message:
            "No usable master pattern found.",


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


    const latest =
        history[0]
            ?.issueNumber;


    const providerCurrent =
        providerState.currentIssue;


    if (

        providerCurrent &&
        latest &&

        compareIssue(
            providerCurrent,
            latest
        ) > 0

    ) {

        return String(
            providerCurrent
        );

    }


    return incrementIssue(
        latest
    );

}


// ============================================================
// GENERATE MODEL
// ============================================================

async function generateModel() {

    /*
      WingoBot:
      newest -> oldest

      Engine:
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


    /*
      Build model object
    */

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
                null,


            matchPercent:
                analysis.matchPercent ??
                null,


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
      Save only when there is
      an actual usable prediction.
    */

    if (

        analysis.prediction &&

        (
            analysis.status ===
                "EXACT_PATTERN_MATCH" ||

            analysis.status ===
                "STRONG_PARTIAL_PATTERN"

        )

    ) {

        await savePrediction(
            targetIssue,
            analysis
        );

    }


    console.log(
        `[MODEL] Target=${targetIssue} Status=${analysis.status} Prediction=${analysis.prediction || "NONE"}`
    );


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
                    0
                ),

                MODEL_VERSION,

                now()

            ]
        );


        console.log(
            `[DB] Prediction saved: ${targetIssue} -> ${analysis.prediction}`
        );


    } catch (error) {

        console.error(
            "[DB SAVE]",
            error.message
        );

    }

}


// ============================================================
// SETTLE
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


            const predictedSide =
                labelToSide(
                    record.prediction
                );


            if (
                !predictedSide
            ) {

                continue;

            }


            const resultStatus =
                predictedSide ===
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
                `[SETTLE] ${row.issueNumber} ${record.prediction} -> ${resultStatus}`
            );


        } catch (error) {

            console.error(
                "[DB SETTLE]",
                error.message
            );

        }

    }

}


// ============================================================
// ACCESS AUTH
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
// VALIDATE ACCESS
// ============================================================

async function validateAccess(
    req
) {

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


    await pool.query(
        `
        UPDATE access_keys
        SET
            device_id = COALESCE(device_id, $1),
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
// KEY CHECK
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
      IMPORTANT:
      Generate fresh model if target
      changed OR no model exists.
    */

    if (

        !modelCache.prediction ||

        modelCache.targetIssue !==
        targetIssue

    ) {

        await generateModel();

    }


    /*
      DB predictions
    */

    let records = [];


    if (pool) {

        try {

            const result =
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


            records =
                result.rows;

        } catch (error) {

            console.error(
                "[DB HISTORY]",
                error.message
            );

        }

    }


    const recordMap =
        new Map();


    for (
        const record of records
    ) {

        recordMap.set(

            String(
                record.target_issue
            ),

            record

        );

    }


    /*
      LAST 30
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


                    const predictionRecord =
                        recordMap.get(
                            String(
                                row.issueNumber
                            )
                        );


                    let prediction =
                        null;


                    let result =
                        "PENDING";


                    if (
                        predictionRecord
                    ) {

                        prediction =
                            String(
                                predictionRecord.prediction ||
                                ""
                            ).toUpperCase();


                        if (
                            predictionRecord.actual_result
                        ) {

                            result =
                                String(
                                    predictionRecord.actual_result
                                ).toUpperCase();

                        }

                    }


                    return {

                        issue:
                            row.issueNumber,

                        issueNumber:
                            row.issueNumber,

                        actual:
                            number,

                        number,

                        type:
                            side,

                        label:
                            sideToLabel(
                                side
                            ),

                        prediction,

                        ai:
                            prediction,

                        confidence:
                            predictionRecord
                                ? Number(
                                    predictionRecord.confidence ||
                                    0
                                )
                                : null,

                        result,

                        actualResult:
                            result,

                        modelVersion:
                            predictionRecord
                                ?.model_version ||
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
                "25 MASTER + OPPOSITE + EXACT + STRONG PARTIAL",

            originalRules:
                Object.keys(
                    MASTER_PATTERNS
                ).length,

            totalPatterns:
                PATTERN_DATABASE.length,

            thinkingDurationMs:
                THINKING_DURATION_MS,


            settings: {

                partialMinimumMatched:
                    PARTIAL_MIN_MATCH,

                partialMinimumPercent:
                    PARTIAL_MIN_PERCENT,

                minimumPartialSupport:
                    MIN_PARTIAL_SUPPORT,

                minimumSupportGap:
                    MIN_SUPPORT_GAP

            },


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

function adminPing(
    res
) {

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
                    20
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
// ADMIN KEYS LIST
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

function health(
    res
) {

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
                "25 MASTER + OPPOSITE + EXACT + STRONG PARTIAL",

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
// CONTENT TYPE
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
// STATIC SERVER
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
              MP3 RANGE
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
// SERVER
// ============================================================

const server =
    http.createServer(
        async (
            req,
            res
        ) => {

            try {

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
                        !requireAdmin(
                            req
                        )
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
                  WINGO TEST
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
// BACKGROUND
// ============================================================

async function backgroundRefresh() {

    try {

        await refreshProvider();


        await settlePredictions();


        const target =
            resolveTargetIssue();


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
// START
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
                    "=============================================="
                );

                console.log(
                    "          DY AI WINGO SERVER"
                );

                console.log(
                    "=============================================="
                );

                console.log(
                    `PORT: ${PORT}`
                );

                console.log(
                    `MODEL: ${MODEL_VERSION}`
                );

                console.log(
                    `MASTER RULES: ${
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
                    `TARGET: ${
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
                    `PREDICTION: ${
                        modelCache.prediction
                            ?.prediction ||
                        "NONE"
                    }`
                );

                console.log(
                    `CONFIDENCE: ${
                        modelCache.prediction
                            ?.confidence ||
                        0
                    }%`
                );

                console.log(
                    "=============================================="
                );

            }
        );


        setInterval(
            backgroundRefresh,
            PROVIDER_REFRESH_MS
        );


    } catch (error) {

        console.error(
            "[START ERROR]",
            error
        );


        process.exit(1);

    }

}


// ============================================================
// PROCESS ERRORS
// ============================================================

process.on(
    "unhandledRejection",
    error => {

        console.error(
            "[UNHANDLED]",
            error
        );

    }
);


process.on(
    "uncaughtException",
    error => {

        console.error(
            "[UNCAUGHT]",
            error
        );

    }
);


// ============================================================
// BOOT
// ============================================================

start();
