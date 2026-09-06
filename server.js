"use strict";

/*
============================================================
                 DY AI WINGO SERVER
        HUMAN PATTERN + OPPOSITE PATTERN ENGINE
============================================================

0-4 = SMALL = S
5-9 = BIG   = B

ENGINE:

1. Supplied 10-result patterns
2. Automatic opposite patterns
3. Exact current last-10 matching
4. Partial current pattern matching
5. Historical occurrence search
6. Historical NEXT result analysis
7. Original vs Opposite comparison
8. Pattern confidence
9. Conflict protection
10. Pattern-break information
11. Streak / switching information
12. PostgreSQL prediction history
13. WIN / LOSS settlement
14. WingoBot live history
15. Access-key system
16. Admin system

IMPORTANT:

Pattern matching is historical analysis only.
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
    "DY-AI-HUMAN-PATTERN-V5";

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


    console.log("[DB] Ready");
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


function numberToBS(number) {

    const n =
        Number(number);


    if (
        !Number.isInteger(n) ||
        n < 0 ||
        n > 9
    ) {

        return null;

    }


    return n >= 5
        ? "B"
        : "S";

}


function bsToLabel(bs) {

    if (bs === "B") {

        return "BIG";

    }


    if (bs === "S") {

        return "SMALL";

    }


    return null;

}


function labelToBS(label) {

    const value =
        String(label || "")
            .toUpperCase()
            .trim();


    if (value === "BIG") {

        return "B";

    }


    if (value === "SMALL") {

        return "S";

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


        if (aa > bb) return 1;

        if (aa < bb) return -1;

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
// BODY
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
                                "Body too large"
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
// WINGOBOT FETCH
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
                                "DY-AI-Wingo/5.0"

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
                                        JSON.parse(body)
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
// NORMALIZE WINGOBOT HISTORY
// ============================================================

function normalizeHistory(payload) {

    const raw =

        Array.isArray(payload?.history)
            ? payload.history

            : Array.isArray(payload?.data)
                ? payload.data

                : Array.isArray(payload?.results)
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
// CURRENT ISSUE
// ============================================================

function providerCurrentIssue(payload) {

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
            providerCurrentIssue(
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
//              HUMAN PATTERN DEFINITIONS
// ============================================================
// ============================================================

const ORIGINAL_PATTERNS = {

    1:
        "BSBSSSBBSB",

    2:
        "BSBBSBSSSS",

    3:
        "BBBSBSSBBB",

    4:
        "BBBBBSBSSB",

    5:
        "BBSBBBSSBB",

    6:
        "BBBSSBSBBS",

    7:
        "BSBSBBSBSS",

    9:
        "BSSBSSBBBS",

    10:
        "BSSSBSBBSS"

};


// ============================================================
// OPPOSITE PATTERN
// ============================================================

function oppositePattern(pattern) {

    return String(pattern)
        .split("")
        .map(
            x =>
                x === "B"
                    ? "S"
                    : "B"
        )
        .join("");

}


// ============================================================
// BUILD PATTERNS
// ============================================================

const PATTERNS = [];


for (
    const [id, pattern]
    of Object.entries(
        ORIGINAL_PATTERNS
    )
) {

    const clean =
        String(pattern)
            .replace(
                /[^BS]/g,
                ""
            );


    if (
        clean.length !== 10
    ) {

        continue;

    }


    PATTERNS.push({

        id:
            `${id}-ORIGINAL`,

        sourceRule:
            Number(id),

        type:
            "ORIGINAL",

        pattern:
            clean

    });


    PATTERNS.push({

        id:
            `${id}-OPPOSITE`,

        sourceRule:
            Number(id),

        type:
            "OPPOSITE",

        pattern:
            oppositePattern(
                clean
            )

    });

}


// ============================================================
// NUMBER HISTORY
// ============================================================

function convertResults(results) {

    const output = [];


    for (
        const value of
            Array.isArray(results)
                ? results
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


        const bs =
            numberToBS(
                number
            );


        if (bs !== null) {

            output.push(bs);

        }

    }


    return output;

}


// ============================================================
// EXACT LAST 10
// ============================================================

function exactLast10Match(
    history,
    pattern
) {

    if (
        history.length <
        pattern.length
    ) {

        return false;

    }


    const last =
        history
            .slice(
                -pattern.length
            )
            .join("");


    return (
        last ===
        pattern
    );

}


// ============================================================
// PARTIAL CURRENT MATCH
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


    for (
        let length = 1;
        length <= max;
        length++
    ) {

        const historyPart =
            history
                .slice(-length)
                .join("");


        const patternPart =
            pattern.slice(
                0,
                length
            );


        if (
            historyPart ===
            patternPart
        ) {

            best = length;

        }

    }


    return best;

}


// ============================================================
// FIND EXACT CURRENT MATCHES
// ============================================================

function findExactMatches(
    history
) {

    const matches = [];


    for (
        const rule of
            PATTERNS
    ) {

        if (
            exactLast10Match(
                history,
                rule.pattern
            )
        ) {

            matches.push({

                ...rule,

                matched:
                    10,

                percentage:
                    100

            });

        }

    }


    return matches;

}


// ============================================================
// FIND PARTIAL CURRENT MATCHES
// ============================================================

function findPartialMatches(
    history
) {

    const matches = [];


    for (
        const rule of
            PATTERNS
    ) {

        const matched =
            partialMatch(
                history,
                rule.pattern
            );


        /*
          Minimum 5.

          5/10 = candidate only.
          6/10+ = stronger.
        */

        if (
            matched >= 5 &&
            matched < 10
        ) {

            matches.push({

                ...rule,

                matched,

                percentage:
                    Math.round(
                        matched /
                        rule.pattern.length *
                        100
                    )

            });

        }

    }


    return matches;

}


// ============================================================
// HISTORICAL NEXT RESULT SEARCH
// ============================================================

/*
IMPORTANT:

Current pattern itself 10 characters ka hai.

Prediction tab niklegi jab:

PAST:
same 10-result pattern
        +
uske immediately baad actual result

Example:

Past:
BSBSSSBBSB -> B

Agar current bhi:
BSBSSSBBSB

to historical evidence:
NEXT = BIG

Ye actual pattern-following logic hai.
*/


function historicalNextEvidence(
    history,
    pattern,
    excludeCurrent = true
) {

    const sequence =
        history.join("");


    const occurrences = [];


    if (
        sequence.length <=
        pattern.length
    ) {

        return occurrences;

    }


    for (
        let i = 0;

        i + pattern.length <
        sequence.length;

        i++
    ) {

        const current =
            sequence.slice(
                i,
                i + pattern.length
            );


        if (
            current !==
            pattern
        ) {

            continue;

        }


        const next =
            sequence[
                i + pattern.length
            ];


        /*
          Last 10 current sequence
          ko historical evidence me
          dobara count nahi karna.
        */

        if (
            excludeCurrent &&
            i + pattern.length >=
            sequence.length
        ) {

            continue;

        }


        occurrences.push({

            index:
                i,

            matchedPattern:
                pattern,

            next,

            nextLabel:
                bsToLabel(next)

        });

    }


    return occurrences;

}


// ============================================================
// PREFIX HISTORICAL EVIDENCE
// ============================================================

function historicalPrefixEvidence(
    history,
    prefix,
    excludeCurrent = true
) {

    const sequence =
        history.join("");


    const occurrences = [];


    if (
        sequence.length <=
        prefix.length
    ) {

        return occurrences;

    }


    for (
        let i = 0;

        i + prefix.length <
        sequence.length;

        i++
    ) {

        const current =
            sequence.slice(
                i,
                i + prefix.length
            );


        if (
            current !==
            prefix
        ) {

            continue;

        }


        const next =
            sequence[
                i + prefix.length
            ];


        if (
            excludeCurrent &&
            i + prefix.length >=
            sequence.length
        ) {

            continue;

        }


        occurrences.push({

            index:
                i,

            matchedPattern:
                prefix,

            next,

            nextLabel:
                bsToLabel(next)

        });

    }


    return occurrences;

}


// ============================================================
// COUNT NEXT RESULTS
// ============================================================

function countNextEvidence(
    evidence
) {

    let B = 0;
    let S = 0;


    for (
        const row of
            evidence
    ) {

        if (
            row.next === "B"
        ) {

            B++;

        }


        if (
            row.next === "S"
        ) {

            S++;

        }

    }


    const total =
        B + S;


    return {

        B,

        S,

        total,

        bigPercent:
            total
                ? Number(
                    (
                        B /
                        total *
                        100
                    ).toFixed(2)
                )
                : 0,

        smallPercent:
            total
                ? Number(
                    (
                        S /
                        total *
                        100
                    ).toFixed(2)
                )
                : 0

    };

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

        return {

            side:
                null,

            label:
                null,

            count:
                0

        };

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

        side:
            current,

        label:
            bsToLabel(
                current
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

            size: 0,

            B: 0,

            S: 0,

            bigPercent: 0,

            smallPercent: 0

        };

    }


    const B =
        data.filter(
            x => x === "B"
        ).length;


    const S =
        data.filter(
            x => x === "S"
        ).length;


    return {

        size:
            data.length,

        B,

        S,

        bigPercent:
            Number(
                (
                    B /
                    data.length *
                    100
                ).toFixed(2)
            ),

        smallPercent:
            Number(
                (
                    S /
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

            switches: 0,

            transitions: 0,

            switchRate: 0

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
            (x, i) => {

                if (
                    i === 0
                ) {

                    return true;

                }


                return (
                    x !==
                    first5[i - 1]
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
// RUN ANALYSIS
// ============================================================

function runAnalysis(
    history
) {

    const runs = [];


    if (
        !history.length
    ) {

        return {

            runs: [],

            current:
                null

        };

    }


    let current =
        history[0];

    let length = 1;


    for (
        let i = 1;
        i < history.length;
        i++
    ) {

        if (
            history[i] ===
            current
        ) {

            length++;

        } else {

            runs.push({

                side:
                    current,

                label:
                    bsToLabel(
                        current
                    ),

                length

            });


            current =
                history[i];

            length = 1;

        }

    }


    runs.push({

        side:
            current,

        label:
            bsToLabel(
                current
            ),

        length

    });


    const lengths =
        runs.map(
            x => x.length
        );


    const longest =
        lengths.length
            ? Math.max(
                ...lengths
            )
            : 0;


    const average =
        lengths.length
            ? Number(
                (
                    lengths.reduce(
                        (a, b) =>
                            a + b,
                        0
                    ) /
                    lengths.length
                ).toFixed(2)
            )
            : 0;


    return {

        totalRuns:
            runs.length,

        longest,

        average,

        current:
            runs[runs.length - 1],

        runs:
            runs.slice(-20)

    };

}


// ============================================================
// PATTERN MATCH SCORING
// ============================================================

function matchWeight(
    matched,
    exact
) {

    if (exact) {

        return 12;

    }


    if (
        matched >= 9
    ) {

        return 10;

    }


    if (
        matched >= 8
    ) {

        return 8;

    }


    if (
        matched >= 7
    ) {

        return 6;

    }


    if (
        matched >= 6
    ) {

        return 4;

    }


    if (
        matched >= 5
    ) {

        return 2;

    }


    return 0;

}


// ============================================================
// BUILD EVIDENCE FOR CURRENT PATTERNS
// ============================================================

function buildPatternEvidence(
    history,
    exactMatches,
    partialMatches
) {

    const all = [];


    /*
      EXACT:
      use 10/10 pattern
    */

    for (
        const match of
            exactMatches
    ) {

        const evidence =
            historicalNextEvidence(
                history,
                match.pattern,
                true
            );


        const counts =
            countNextEvidence(
                evidence
            );


        all.push({

            ...match,

            matchType:
                "EXACT",

            weight:
                matchWeight(
                    10,
                    true
                ),

            historicalOccurrences:
                evidence.length,

            historicalNext:
                counts,

            evidence:
                evidence.slice(-20)

        });

    }


    /*
      PARTIAL:
      use current matching prefix.
    */

    for (
        const match of
            partialMatches
    ) {

        const prefix =
            match.pattern.slice(
                0,
                match.matched
            );


        const evidence =
            historicalPrefixEvidence(
                history,
                prefix,
                true
            );


        const counts =
            countNextEvidence(
                evidence
            );


        all.push({

            ...match,

            matchType:
                "PARTIAL",

            prefix,

            weight:
                matchWeight(
                    match.matched,
                    false
                ),

            historicalOccurrences:
                evidence.length,

            historicalNext:
                counts,

            evidence:
                evidence.slice(-20)

        });

    }


    return all;

}


// ============================================================
// AGGREGATE HISTORICAL PATTERN SUPPORT
// ============================================================

function aggregatePatternSupport(
    evidence
) {

    let B = 0;
    let S = 0;


    const details = [];


    for (
        const item of
            evidence
    ) {

        const next =
            item.historicalNext;


        /*
          No historical occurrence
          = no prediction evidence.
        */

        if (
            !next ||
            next.total === 0
        ) {

            continue;

        }


        const baseWeight =
            item.weight;


        const bigRate =
            next.bigPercent /
            100;


        const smallRate =
            next.smallPercent /
            100;


        /*
          Historical support:

          Pattern weight
          × historical next-side rate
        */

        B +=
            baseWeight *
            bigRate;


        S +=
            baseWeight *
            smallRate;


        details.push({

            rule:
                item.sourceRule,

            id:
                item.id,

            type:
                item.type,

            matchType:
                item.matchType,

            pattern:
                item.pattern,

            matched:
                item.matched,

            weight:
                baseWeight,

            historicalOccurrences:
                next.total,

            historicalBig:
                next.B,

            historicalSmall:
                next.S,

            historicalBigPercent:
                next.bigPercent,

            historicalSmallPercent:
                next.smallPercent

        });

    }


    const total =
        B + S;


    return {

        B:
            Number(B.toFixed(3)),

        S:
            Number(S.toFixed(3)),

        total:
            Number(total.toFixed(3)),

        bigPercent:
            total
                ? Number(
                    (
                        B /
                        total *
                        100
                    ).toFixed(2)
                )
                : 0,

        smallPercent:
            total
                ? Number(
                    (
                        S /
                        total *
                        100
                    ).toFixed(2)
                )
                : 0,

        details

    };

}


// ============================================================
// PATTERN DECISION
// ============================================================

function patternDecision(
    history,
    evidence,
    support,
    exactMatches
) {

    if (
        !evidence.length
    ) {

        return {

            prediction:
                null,

            confidence:
                0,

            status:
                "NO_PATTERN",

            reason:
                "No supplied pattern matched."

        };

    }


    if (
        support.total <= 0
    ) {

        return {

            prediction:
                null,

            confidence:
                0,

            status:
                "PATTERN_FOUND_NO_HISTORY",

            reason:
                "Pattern matched, but historical next-result evidence was not found."

        };

    }


    const difference =
        Math.abs(
            support.B -
            support.S
        );


    const balance =
        support.total
            ? difference /
              support.total
            : 0;


    /*
      If both sides are too close,
      do not force prediction.
    */

    if (
        balance < 0.20
    ) {

        return {

            prediction:
                null,

            confidence:
                Math.round(
                    Math.max(
                        support.bigPercent,
                        support.smallPercent
                    )
                ),

            status:
                "CONFLICTING_PATTERN",

            reason:
                "Matched patterns give conflicting historical next-side evidence."

        };

    }


    let predictionSide;


    if (
        support.B >
        support.S
    ) {

        predictionSide = "B";

    } else {

        predictionSide = "S";

    }


    /*
      Need stronger historical evidence.
    */

    const sidePercent =
        predictionSide === "B"
            ? support.bigPercent
            : support.smallPercent;


    const strongestMatch =
        evidence
            .slice()
            .sort(
                (a, b) =>
                    (
                        b.matched -
                        a.matched
                    ) ||
                    (
                        b.weight -
                        a.weight
                    )
            )[0];


    /*
      Minimum historical confidence.
    */

    if (
        sidePercent < 60
    ) {

        return {

            prediction:
                null,

            confidence:
                Math.round(
                    sidePercent
                ),

            status:
                "WEAK_PATTERN",

            reason:
                "Pattern matched, but historical next-side support is below threshold."

        };

    }


    /*
      Partial 5/10 alone is too weak.
    */

    const hasStrongMatch =
        evidence.some(
            x =>
                x.matched >= 7
        );


    const hasExact =
        exactMatches.length >
        0;


    if (
        !hasExact &&
        !hasStrongMatch &&
        sidePercent < 70
    ) {

        return {

            prediction:
                null,

            confidence:
                Math.round(
                    sidePercent
                ),

            status:
                "PARTIAL_PATTERN_WEAK",

            reason:
                "Only weak partial pattern evidence is available."

        };

    }


    let confidence =
        Math.round(
            sidePercent
        );


    /*
      Exact match bonus,
      capped below 100.
    */

    if (
        hasExact
    ) {

        confidence += 5;

    }


    if (
        strongestMatch &&
        strongestMatch.matched >= 9
    ) {

        confidence += 3;

    }


    confidence =
        Math.min(
            95,
            confidence
        );


    return {

        prediction:
            bsToLabel(
                predictionSide
            ),

        predictionSide,

        confidence,

        status:
            hasExact
                ? "EXACT_PATTERN_MATCH"
                : "PARTIAL_PATTERN_MATCH",

        reason:
            hasExact

                ? "Exact 10-result template matched and historical next-result evidence supports the prediction."

                : "Current suffix matches a supplied template and historical next-result evidence supports the prediction.",

        strongestMatch:

            strongestMatch
                ? {

                    rule:
                        strongestMatch.sourceRule,

                    id:
                        strongestMatch.id,

                    type:
                        strongestMatch.type,

                    matched:
                        strongestMatch.matched,

                    pattern:
                        strongestMatch.pattern

                }
                : null

    };

}


// ============================================================
// HUMAN INTERPRETATION
// ============================================================

function humanInterpretation(
    exactMatches,
    partialMatches,
    evidence,
    decision,
    streak,
    windows,
    switching,
    patternBreak
) {

    const reasons = [];


    if (
        exactMatches.length
    ) {

        reasons.push(
            `EXACT ${exactMatches.length} TEMPLATE MATCH`
        );

    }


    if (
        partialMatches.length
    ) {

        reasons.push(
            `${partialMatches.length} PARTIAL TEMPLATE MATCH`
        );

    }


    if (
        decision.status ===
        "EXACT_PATTERN_MATCH"
    ) {

        reasons.push(
            "HISTORICAL NEXT-RESULT SUPPORT FOUND"
        );

    }


    if (
        decision.status ===
        "CONFLICTING_PATTERN"
    ) {

        reasons.push(
            "PATTERN EVIDENCE CONFLICT"
        );

    }


    if (
        streak.count >= 3
    ) {

        reasons.push(
            `${streak.label} STREAK × ${streak.count}`
        );

    }


    if (
        windows.last5.bigPercent >= 70
    ) {

        reasons.push(
            "LAST 5 BIG DOMINANT"
        );

    }


    if (
        windows.last5.smallPercent >= 70
    ) {

        reasons.push(
            "LAST 5 SMALL DOMINANT"
        );

    }


    if (
        switching.switchRate >= 70
    ) {

        reasons.push(
            "HIGH SWITCHING"
        );

    }


    if (
        switching.switchRate <= 30
    ) {

        reasons.push(
            "LOW SWITCHING / STREAK MODE"
        );

    }


    if (
        patternBreak.detected
    ) {

        reasons.push(
            "PATTERN BREAK DETECTED"
        );

    }


    if (
        !reasons.length
    ) {

        reasons.push(
            "NO STRONG HUMAN PATTERN EVIDENCE"
        );

    }


    return reasons;

}


// ============================================================
// MAIN ANALYZER
// ============================================================

function analyze(results) {

    const history =
        convertResults(
            results
        );


    if (
        history.length < 10
    ) {

        return {

            status:
                "INSUFFICIENT_DATA",

            prediction:
                null,

            confidence:
                0,

            sequence:
                history.join(""),

            message:
                "At least 10 valid results required for the 10-result pattern engine."

        };

    }


    const exactMatches =
        findExactMatches(
            history
        );


    const partialMatches =
        findPartialMatches(
            history
        );


    const streak =
        currentStreak(
            history
        );


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


    const switching =
        switchingAnalysis(
            history
        );


    const patternBreak =
        detectPatternBreak(
            history
        );


    const runs =
        runAnalysis(
            history
        );


    /*
      Build evidence from
      exact + partial matches.
    */

    const evidence =
        buildPatternEvidence(
            history,
            exactMatches,
            partialMatches
        );


    /*
      Historical next-side support.
    */

    const support =
        aggregatePatternSupport(
            evidence
        );


    /*
      Final pattern decision.
    */

    const decision =
        patternDecision(
            history,
            evidence,
            support,
            exactMatches
        );


    const reasons =
        humanInterpretation(
            exactMatches,
            partialMatches,
            evidence,
            decision,
            streak,
            windows,
            switching,
            patternBreak
        );


    /*
      Original / opposite count.
    */

    let originalMatches = 0;

    let oppositeMatches = 0;


    for (
        const row of
            exactMatches
    ) {

        if (
            row.type ===
            "ORIGINAL"
        ) {

            originalMatches++;

        }


        if (
            row.type ===
            "OPPOSITE"
        ) {

            oppositeMatches++;

        }

    }


    return {

        status:
            decision.status,

        prediction:
            decision.prediction ||
            null,

        confidence:
            decision.confidence ||
            0,

        confidenceLevel:

            decision.confidence >= 80
                ? "HIGH"

                : decision.confidence >= 70
                    ? "MEDIUM"

                    : decision.confidence >= 60
                        ? "LOW-MEDIUM"

                        : "LOW",


        sequence:
            history.join(""),


        dataSize:
            history.length,


        current:
            streak,


        windows,


        switching,


        runs,


        patternBreak,


        exactMatches,


        partialMatches,


        evidence,


        support,


        decision,


        summary: {

            originalMatches,

            oppositeMatches,

            totalExactMatches:
                exactMatches.length,

            totalPartialMatches:
                partialMatches.length,

            totalEvidenceRows:
                evidence.length

        },


        humanReasons:
            reasons,


        engine:
            "10 RESULT HUMAN PATTERN + OPPOSITE",


        modelVersion:
            MODEL_VERSION,


        originalPatterns:
            Object.keys(
                ORIGINAL_PATTERNS
            ).length,


        totalPatterns:
            PATTERNS.length,


        warning:
            "Historical pattern analysis only. No future result is guaranteed."

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
        history[0]?.issueNumber;


    const current =
        providerState.currentIssue;


    if (
        current &&
        latest &&
        compareIssue(
            current,
            latest
        ) > 0
    ) {

        return String(current);

    }


    return incrementIssue(
        latest
    );

}


// ============================================================
// GENERATE MODEL
// ============================================================

async function generateModel() {

    const providerHistory =
        providerState.history;


    /*
      WingoBot:
      newest -> oldest

      Analyzer:
      oldest -> newest
    */

    const numbers =
        providerHistory
            .map(
                row =>
                    Number(row.number)
            )
            .filter(
                n =>
                    Number.isInteger(n) &&
                    n >= 0 &&
                    n <= 9
            )
            .reverse();


    const analysis =
        analyze(
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

            confidence:
                Number(
                    analysis.confidence ||
                    0
                ),

            confidenceLevel:
                analysis.confidenceLevel ||
                "LOW",

            status:
                analysis.status,

            classification:
                analysis.status,

            pattern:

                analysis.decision
                    ?.strongestMatch
                    ? `RULE ${analysis.decision.strongestMatch.rule}`
                    : "NONE",


            matchedPattern:

                analysis.decision
                    ?.strongestMatch
                    ?.type ||
                null,


            matchedSequence:

                analysis.decision
                    ?.strongestMatch
                    ?.pattern ||
                null,


            reason:
                analysis.decision
                    ?.reason ||
                "No pattern prediction.",


            modelVersion:
                MODEL_VERSION,


            generatedAt,


            analysis

        },


        generatedAt

    };


    await savePrediction(
        targetIssue,
        analysis
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

    /*
      IMPORTANT:

      NO PATTERN =
      NO DB PREDICTION

      Isse UI me fake prediction
      nahi banegi.
    */

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


    } catch (error) {

        console.error(
            "[DB] save prediction:",
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


    for (
        const row of
            providerState.history.slice(
                0,
                100
            )
    ) {

        const number =
            Number(row.number);


        const actualBS =
            numberToBS(
                number
            );


        if (!actualBS) {

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


            const prediction =
                String(
                    record.prediction ||
                    ""
                )
                    .toUpperCase();


            const actualLabel =
                bsToLabel(
                    actualBS
                );


            const actualResult =
                prediction ===
                actualLabel
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

                    number,

                    actualResult,

                    now(),

                    record.id

                ]
            );


        } catch (error) {

            console.error(
                "[DB] settle:",
                error.message
            );

        }

    }

}


// ============================================================
// ACCESS KEY
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

async function validateAccess(req) {

    const key =
        getAccessKey(req);


    const device =
        getDeviceId(req);


    if (
        !key ||
        !device
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
                key
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
            device
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

                device,

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

        key:
            row.access_key,

        id:
            row.id

    };

}


// ============================================================
// ADMIN AUTH
// ============================================================

function requireAdmin(req) {

    return (

        ADMIN_KEY &&

        getAdminKey(req) ===
            ADMIN_KEY

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
      New target =
      new analysis.
    */

    if (

        !modelCache.prediction ||

        modelCache.targetIssue !==
            targetIssue

    ) {

        await generateModel();

    }


    /*
      Prediction DB records.
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
                "[DB] state history:",
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
      Live history:
      newest -> oldest
    */

    const history =
        providerState.history
            .slice(0, 30)
            .map(
                row => {

                    const number =
                        Number(
                            row.number
                        );


                    const bs =
                        numberToBS(
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


                    let result =
                        "PENDING";


                    if (
                        record?.actual_result
                    ) {

                        result =
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

                        type:
                            bs,

                        label:
                            bsToLabel(
                                bs
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

                        result,

                        actualResult:
                            result,

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

                confidence:
                    model?.confidence ||
                    0,

                confidenceLevel:
                    model?.confidenceLevel ||
                    "LOW",

                status:
                    model?.status ||
                    "NO_PATTERN",

                classification:
                    model?.classification ||
                    "NO_PATTERN",

                pattern:
                    model?.pattern ||
                    "NONE",

                matchedPattern:
                    model?.matchedPattern ||
                    null,

                matchedSequence:
                    model?.matchedSequence ||
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

            id:
                auth.id,

            modelVersion:
                MODEL_VERSION

        }
    );

}


// ============================================================
// PREDICTION HISTORY
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
                "10 RESULT HUMAN PATTERN + OPPOSITE",

            originalRules:
                Object.keys(
                    ORIGINAL_PATTERNS
                ).length,

            totalPatterns:
                PATTERNS.length,

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
                    10
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

            confidence:
                model.prediction
                    ?.confidence ||
                0,

            confidenceLevel:
                model.prediction
                    ?.confidenceLevel ||
                "LOW",

            status:
                model.prediction
                    ?.status ||
                "NO_PATTERN",

            classification:
                model.prediction
                    ?.classification ||
                "NO_PATTERN",

            pattern:
                model.prediction
                    ?.pattern ||
                "NONE",

            matchedPattern:
                model.prediction
                    ?.matchedPattern ||
                null,

            matchedSequence:
                model.prediction
                    ?.matchedSequence ||
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


    const custom =
        String(
            body?.key ||
            body?.access_key ||
            ""
        ).trim();


    const key =
        custom ||
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
// RESET DEVICE
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
                "10 RESULT HUMAN PATTERN + OPPOSITE",

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
                  ACCESS KEY CHECK
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
                  ADMIN
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
                  STATIC FILES
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
                    `DY AI WINGO running on ${PORT}`
                );


                console.log(
                    `MODEL: ${MODEL_VERSION}`
                );


                console.log(
                    `ORIGINAL RULES: ${
                        Object.keys(
                            ORIGINAL_PATTERNS
                        ).length
                    }`
                );


                console.log(
                    `TOTAL PATTERNS: ${
                        PATTERNS.length
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
                    `TARGET: ${
                        modelCache.targetIssue ||
                        "NONE"
                    }`
                );


                console.log(
                    `STATUS: ${
                        modelCache.prediction
                            ?.status ||
                        "NO_PATTERN"
                    }`
                );


                console.log(
                    `PATTERN: ${
                        modelCache.prediction
                            ?.pattern ||
                        "NONE"
                    }`
                );


                console.log(
                    `PREDICTION: ${
                        modelCache.prediction
                            ?.prediction ||
                        "NO PATTERN"
                    }`

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
