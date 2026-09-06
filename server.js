"use strict";

/*
============================================================
                 DY AI WINGO SERVER
        25 RULE PATTERN + OPPOSITE ENGINE
============================================================

A = SMALL
B = BIG

0-4 = SMALL
5-9 = BIG

MAIN LOGIC:

1. History ko A/B me convert karo.
2. Tumhare diye hue 25 rules use karo.
3. Latest history suffix ko pattern ke PREFIX se match karo.
4. 2+ match ko candidate maana jayega.
5. Pattern ke next character ko historical signal maana jayega.
6. Multiple signals ko weighted support diya jayega.
7. Strong side ko prediction diya jayega.
8. Current side aur next signal opposite ho to reversal watch.
9. Random / forced alternation nahi.
10. Exact prediction guarantee nahi.

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
    "DY-AI-25-RULE-PATTERN-V1";


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
// 25 MASTER PATTERNS
// ============================================================

const RULES = [

    { id: 1, pattern: "ABABABABAB" },

    { id: 2, pattern: "AABBAABB" },

    { id: 3, pattern: "AAABBBAAABBB" },

    { id: 4, pattern: "AAAABBBBAAAABBBB" },

    { id: 5, pattern: "AABAABAAB" },

    {
        id: 6,
        pattern:
            "AAAAAAAA BBBBBBBB"
                .replace(/\s/g, "")
    },

    { id: 7, pattern: "ABBABBABB" },

    { id: 8, pattern: "AAABAAABAAAB" },

    { id: 9, pattern: "AAABBAAABB" },

    {
        id: 10,
        pattern:
            "AAAAB B A BB AAAA"
                .replace(/\s/g, "")
    },

    { id: 11, pattern: "ABBBABBBABBB" },

    { id: 12, pattern: "ABABBABBB" },

    {
        id: 13,
        pattern:
            "AABBAAABBBAAAABBBB"
    },

    { id: 14, pattern: "ABBAAABBBB" },

    { id: 15, pattern: "AAAABBBAAB" },

    { id: 16, pattern: "ABAABBAAABBB" },

    {
        id: 17,
        pattern:
            "AABBBABBB AA"
                .replace(/\s/g, "")
    },

    { id: 18, pattern: "ABBAAAABBBBBBBB" },

    { id: 19, pattern: "ABBBABBB" },

    { id: 20, pattern: "AABBBAABBB" },

    { id: 21, pattern: "ABAABAAAB" },

    { id: 22, pattern: "AABAABBAABBB" },

    {
        id: 23,
        pattern:
            "AAAABA AA AAB"
                .replace(/\s/g, "")
    },

    { id: 24, pattern: "AAAABBAAAABB" },

    { id: 25, pattern: "AAAABBBAAAABBB" }

];


// ============================================================
// CLEAN RULES
// ============================================================

for (
    const rule of RULES
) {

    rule.pattern =
        rule.pattern.replace(
            /[^AB]/g,
            ""
        );

}


// ============================================================
// OPPOSITE PATTERN
// ============================================================

function oppositePattern(
    pattern
) {

    return pattern
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
// BUILD PATTERN DATABASE
// ============================================================

const PATTERN_DATABASE = [];


for (
    const rule of RULES
) {

    PATTERN_DATABASE.push({

        id:
            `${rule.id}-ORIGINAL`,

        rule:
            rule.id,

        type:
            "ORIGINAL",

        pattern:
            rule.pattern

    });


    PATTERN_DATABASE.push({

        id:
            `${rule.id}-OPPOSITE`,

        rule:
            rule.id,

        type:
            "OPPOSITE",

        pattern:
            oppositePattern(
                rule.pattern
            )

    });

}


// ============================================================
// NUMBER -> A/B
// ============================================================

function numberToAB(
    number
) {

    const n =
        Number(number);


    if (
        !Number.isInteger(n)
    ) {

        return null;

    }


    if (
        n < 0 ||
        n > 9
    ) {

        return null;

    }


    /*
    0-4 SMALL = A
    5-9 BIG   = B
    */

    return n <= 4
        ? "A"
        : "B";

}


// ============================================================
// A/B -> LABEL
// ============================================================

function abToLabel(
    value
) {

    if (
        value === "A"
    ) {

        return "SMALL";

    }


    if (
        value === "B"
    ) {

        return "BIG";

    }


    return null;

}


// ============================================================
// OPPOSITE SIDE
// ============================================================

function oppositeSide(
    side
) {

    if (
        side === "A"
    ) {

        return "B";

    }


    if (
        side === "B"
    ) {

        return "A";

    }


    return null;

}


// ============================================================
// LABEL -> A/B
// ============================================================

function labelToAB(
    label
) {

    const value =
        String(
            label || ""
        )
            .trim()
            .toUpperCase();


    if (
        value === "SMALL"
    ) {

        return "A";

    }


    if (
        value === "BIG"
    ) {

        return "B";

    }


    return null;

}


// ============================================================
// CONVERT HISTORY
// ============================================================

function convertHistory(
    results
) {

    if (
        !Array.isArray(results)
    ) {

        return [];

    }


    const output = [];


    for (
        const item of results
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
            numberToAB(
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
// SUFFIX MATCH
// ============================================================

function suffixMatch(
    history,
    pattern
) {

    const maxLength =
        Math.min(
            history.length,
            pattern.length
        );


    let bestMatch = 0;


    for (
        let len = 1;
        len <= maxLength;
        len++
    ) {

        const historyPart =
            history
                .slice(
                    history.length - len
                )
                .join("");


        const patternPart =
            pattern.slice(
                0,
                len
            );


        if (
            historyPart ===
            patternPart
        ) {

            bestMatch = len;

        }

    }


    return bestMatch;

}


// ============================================================
// WEIGHT
// ============================================================

function calculateWeight(
    match
) {

    const length =
        Number(
            match.matched || 0
        );


    if (
        length >= 10
    ) {

        return 10;

    }


    if (
        length >= 8
    ) {

        return 8;

    }


    if (
        length >= 6
    ) {

        return 6;

    }


    if (
        length >= 5
    ) {

        return 5;

    }


    if (
        length >= 4
    ) {

        return 4;

    }


    if (
        length >= 3
    ) {

        return 3;

    }


    return 1;

}


// ============================================================
// FIND RULES
// ============================================================

function findRules(
    history
) {

    const matches = [];


    for (
        const rule of
            PATTERN_DATABASE
    ) {

        const matched =
            suffixMatch(
                history,
                rule.pattern
            );


        if (
            matched < 2
        ) {

            continue;

        }


        let next = null;


        if (
            matched <
            rule.pattern.length
        ) {

            next =
                rule.pattern[
                    matched
                ];

        }


        const weight =
            calculateWeight({

                matched

            });


        matches.push({

            id:
                rule.id,

            rule:
                rule.rule,

            type:
                rule.type,

            pattern:
                rule.pattern,

            matched,

            next,

            weight,

            matchPercent:
                Number(
                    (
                        matched /
                        rule.pattern.length *
                        100
                    ).toFixed(2)
                )

        });

    }


    /*
      Strongest first
    */

    matches.sort(
        (
            a,
            b
        ) => {

            if (
                b.matched !==
                a.matched
            ) {

                return (
                    b.matched -
                    a.matched
                );

            }


            return (
                b.weight -
                a.weight
            );

        }
    );


    return matches;

}


// ============================================================
// SUPPORT
// ============================================================

function calculateSupport(
    matches
) {

    let A = 0;

    let B = 0;


    const evidence = [];


    for (
        const match of matches
    ) {

        if (
            !match.next
        ) {

            continue;

        }


        const weight =
            calculateWeight(
                match
            );


        if (
            match.next === "A"
        ) {

            A += weight;

        }


        if (
            match.next === "B"
        ) {

            B += weight;

        }


        evidence.push({

            rule:
                match.rule,

            type:
                match.type,

            pattern:
                match.pattern,

            matched:
                match.matched,

            matchPercent:
                match.matchPercent,

            expectedNext:
                match.next,

            expectedLabel:
                abToLabel(
                    match.next
                ),

            weight

        });

    }


    const total =
        A + B;


    let APct = 0;

    let BPct = 0;


    if (
        total > 0
    ) {

        APct =
            Number(
                (
                    A /
                    total *
                    100
                ).toFixed(2)
            );


        BPct =
            Number(
                (
                    B /
                    total *
                    100
                ).toFixed(2)
            );

    }


    return {

        A,

        B,

        APct,

        BPct,

        total,

        evidence

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

            side: null,

            code: null,

            count: 0

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
            abToLabel(
                current
            ),

        code:
            current,

        count

    };

}


// ============================================================
// WINDOW
// ============================================================

function windowAnalysis(
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
// REVERSAL ANALYSIS
// ============================================================

function reversalAnalysis(
    history,
    support
) {

    if (
        !history.length
    ) {

        return {

            current: null,

            currentLabel: null,

            reversalWatch: false,

            prediction: null,

            reason: ""

        };

    }


    const current =
        history[
            history.length - 1
        ];


    let prediction = null;

    let reversalWatch =
        false;

    let reason = "";


    if (
        current === "A" &&
        support.B > support.A
    ) {

        reversalWatch =
            true;

        prediction =
            "BIG";

        reason =
            "Current SMALL hai aur matched pattern support BIG side ko stronger dikha raha hai.";

    }


    if (
        current === "B" &&
        support.A > support.B
    ) {

        reversalWatch =
            true;

        prediction =
            "SMALL";

        reason =
            "Current BIG hai aur matched pattern support SMALL side ko stronger dikha raha hai.";

    }


    return {

        current,

        currentLabel:
            abToLabel(
                current
            ),

        reversalWatch,

        prediction,

        predictionCode:
            labelToAB(
                prediction
            ),

        reason

    };

}


// ============================================================
// DECISION
// ============================================================

function decide(
    history,
    support
) {

    if (
        support.A === 0 &&
        support.B === 0
    ) {

        return {

            signal: null,

            signalCode: null,

            confidence: "LOW",

            confidencePercent: 0,

            difference: 0,

            status:
                "NO_MATCH"

        };

    }


    const difference =
        Math.abs(
            support.A -
            support.B
        );


    const total =
        support.A +
        support.B;


    const percentage =
        total === 0
            ? 0
            : difference /
                total *
                100;


    let confidence =
        "LOW";


    if (
        percentage >= 60
    ) {

        confidence =
            "HIGH";

    }
    else if (
        percentage >= 30
    ) {

        confidence =
            "MEDIUM";

    }


    let signal = null;


    if (
        support.A >
        support.B
    ) {

        signal =
            "SMALL";

    }
    else if (
        support.B >
        support.A
    ) {

        signal =
            "BIG";

    }
    else {

        signal = null;

        confidence =
            "LOW";

    }


    return {

        signal,

        signalCode:
            labelToAB(
                signal
            ),

        confidence,

        confidencePercent:
            Number(
                percentage.toFixed(2)
            ),

        difference:
            Number(
                percentage.toFixed(2)
            ),

        status:
            signal
                ? "SIGNAL"
                : "CONFLICT"

    };

}


// ============================================================
// MAIN ANALYZE
// ============================================================

function analyze(
    results
) {

    const history =
        convertHistory(
            results
        );


    if (
        history.length < 3
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
                history.join("")

        };

    }


    /*
      Pattern matching
    */

    const matches =
        findRules(
            history
        );


    /*
      Weighted support
    */

    const support =
        calculateSupport(
            matches
        );


    /*
      Reversal
    */

    const reversal =
        reversalAnalysis(
            history,
            support
        );


    /*
      Decision
    */

    const decision =
        decide(
            history,
            support
        );


    /*
      Prediction logic:

      If support says BIG
      -> BIG

      If support says SMALL
      -> SMALL

      BUT if current side is opposite,
      mark reversal.

      This prevents blindly following
      only the current streak.
    */

    let prediction =
        decision.signal;


    let predictionCode =
        decision.signalCode;


    /*
      If support is tied:
      no prediction.
    */

    if (
        support.A ===
        support.B
    ) {

        prediction = null;

        predictionCode = null;

    }


    /*
      If no matched next side:
      no prediction.
    */

    if (
        !support.total
    ) {

        prediction = null;

        predictionCode = null;

    }


    /*
      Status
    */

    let status =
        "NO_MATCH";


    if (
        matches.length > 0 &&
        prediction
    ) {

        const strongest =
            matches[0];


        if (
            strongest.matched >=
            strongest.pattern.length
        ) {

            status =
                "EXACT_PATTERN_MATCH";

        } else {

            status =
                "PATTERN_MATCH";

        }

    }
    else if (
        matches.length > 0
    ) {

        status =
            "PATTERN_CONFLICT";

    }


    /*
      Windows
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
      Switching
    */

    const switching =
        switchingAnalysis(
            history
        );


    /*
      Human reasons
    */

    const reasons = [];


    if (
        matches.length
    ) {

        reasons.push(
            `${matches.length} pattern candidates matched`
        );

    }


    if (
        matches[0]
    ) {

        reasons.push(
            `Strongest Rule ${matches[0].rule}: ${matches[0].matched} matched`
        );

    }


    if (
        support.A >
        support.B
    ) {

        reasons.push(
            `SMALL support ${support.A} > BIG support ${support.B}`
        );

    }
    else if (
        support.B >
        support.A
    ) {

        reasons.push(
            `BIG support ${support.B} > SMALL support ${support.A}`
        );

    }


    if (
        reversal.reversalWatch
    ) {

        reasons.push(
            `REVERSAL WATCH: ${reversal.currentLabel} -> ${reversal.prediction}`
        );

    }


    return {

        status,

        prediction,

        predictionCode,

        confidence:
            decision.confidencePercent,

        confidenceLevel:
            decision.confidence,


        rawResults:
            results,


        ABHistory:
            history.join(""),


        current:
            history[
                history.length - 1
            ],


        currentLabel:
            abToLabel(
                history[
                    history.length - 1
                ]
            ),


        currentStreak:
            currentStreak(
                history
            ),


        matchedRules:
            matches,


        support: {

            A:
                support.A,

            B:
                support.B,

            APercent:
                support.APct,

            BPercent:
                support.BPct,

            total:
                support.total

        },


        reversal,


        decision,


        windows,


        switching,


        reasons,


        bestMatch:
            matches[0]
                ? {

                    rule:
                        matches[0].rule,

                    type:
                        matches[0].type,

                    pattern:
                        matches[0].pattern,

                    matched:
                        matches[0].matched,

                    next:
                        matches[0].next,

                    weight:
                        matches[0].weight,

                    matchPercent:
                        matches[0]
                            .matchPercent

                }
                : null,


        message:
            prediction
                ? "Pattern support found."
                : "No clear pattern prediction.",


        warning:
            "Historical pattern analysis only. Next result is not guaranteed."

    };

}


// ============================================================
// ISSUE INCREMENT
// ============================================================

function incrementIssue(
    issue
) {

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


// ============================================================
// ISSUE COMPARE
// ============================================================

function compareIssue(
    a,
    b
) {

    try {

        const aa =
            BigInt(
                String(a)
            );


        const bb =
            BigInt(
                String(b)
            );


        if (
            aa > bb
        ) {

            return 1;

        }


        if (
            aa < bb
        ) {

            return -1;

        }


        return 0;

    } catch {

        return 0;

    }

}


// ============================================================
// WINGOBOT REQUEST
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

                        method:
                            "GET",

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
                                    response.statusCode <
                                        200 ||
                                    response.statusCode >=
                                        300
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
// NORMALIZE API HISTORY
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


    output.sort(
        (
            a,
            b
        ) =>
            compareIssue(
                b.issueNumber,
                a.issueNumber
            )
    );


    return output;

}


// ============================================================
// CURRENT ISSUE
// ============================================================

function getCurrentIssue(
    payload
) {

    return (

        payload?.current
            ?.issueNumber

        ??

        payload?.currentIssue

        ??

        payload?.current
            ?.issue

        ??

        payload?.current
            ?.period

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
                Date.now(),

            error:
                null

        };


        return providerState;

    } catch (
        error
    ) {

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
// TARGET ISSUE
// ============================================================

function resolveTargetIssue() {

    if (
        providerState.currentIssue
    ) {

        const latest =
            providerState.history[0]
                ?.issueNumber;


        if (
            latest &&
            compareIssue(
                providerState.currentIssue,
                latest
            ) > 0
        ) {

            return String(
                providerState.currentIssue
            );

        }

    }


    const latest =
        providerState.history[0]
            ?.issueNumber;


    return incrementIssue(
        latest
    );

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


    console.log(
        "[DB] Database ready"
    );

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

                Date.now()

            ]
        );


        console.log(
            `[DB] Saved ${targetIssue} -> ${analysis.prediction}`
        );

    } catch (
        error
    ) {

        console.error(
            "[DB SAVE]",
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

        const actualNumber =
            Number(
                row.number
            );


        const actualSide =
            numberToAB(
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
                labelToAB(
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

                    Date.now(),

                    record.id

                ]
            );


        } catch (
            error
        ) {

            console.error(
                "[SETTLE]",
                error.message
            );

        }

    }

}


// ============================================================
// GENERATE MODEL
// ============================================================

async function generateModel() {

    /*
      WingoBot history:
      newest -> oldest

      Engine ko:
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
        analyze(
            numbers
        );


    const targetIssue =
        resolveTargetIssue();


    const generatedAt =
        Date.now();


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
                "LOW",

            status:
                analysis.status,

            classification:
                analysis.status,

            matchedRule:
                analysis.bestMatch
                    ?.rule ??
                null,

            matchedType:
                analysis.bestMatch
                    ?.type ??
                null,

            matchedPattern:
                analysis.bestMatch
                    ?.pattern ??
                null,

            matchedLength:
                analysis.bestMatch
                    ?.matched ??
                null,

            matchPercent:
                analysis.bestMatch
                    ?.matchPercent ??
                null,

            matchedSide:
                analysis.currentLabel ||
                null,

            reason:
                analysis.reversal
                    ?.reason ||
                analysis.message ||
                "",

            modelVersion:
                MODEL_VERSION,

            generatedAt,

            analysis

        },

        generatedAt

    };


    if (
        analysis.prediction
    ) {

        await savePrediction(
            targetIssue,
            analysis
        );

    }


    console.log(
        `[MODEL] ${targetIssue} | ${analysis.status} | ${analysis.prediction || "NO PREDICTION"} | ${analysis.confidence || 0}%`
    );


    return modelCache;

}


// ============================================================
// ACCESS KEY
// ============================================================

function getAccessKey(
    req
) {

    return String(
        req.headers[
            "x-access-key"
        ] || ""
    ).trim();

}


function getDeviceId(
    req
) {

    return String(
        req.headers[
            "x-device-id"
        ] || ""
    ).trim();

}


function getAdminKey(
    req
) {

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
        getAccessKey(
            req
        );


    const deviceId =
        getDeviceId(
            req
        );


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

            Date.now(),

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

function requireAdmin(
    req
) {

    return (

        ADMIN_KEY.length > 0 &&

        getAdminKey(
            req
        ) ===
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

        sendJSON(
            res,
            401,
            auth
        );

        return;

    }


    sendJSON(
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

async function stateAPI(
    req,
    res
) {

    const auth =
        await validateAccess(
            req
        );


    if (!auth.ok) {

        sendJSON(
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
      new model.
    */

    if (

        !modelCache.prediction ||

        modelCache.targetIssue !==
        targetIssue

    ) {

        await generateModel();

    }


    /*
      Prediction DB records
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

        } catch (
            error
        ) {

            console.error(
                "[HISTORY DB]",
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
                        numberToAB(
                            number
                        );


                    const record =
                        recordMap.get(
                            String(
                                row.issueNumber
                            )
                        );


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
                            abToLabel(
                                side
                            ),

                        prediction:
                            record?.prediction ||
                            null,

                        ai:
                            record?.prediction ||
                            null,

                        confidence:
                            record
                                ? Number(
                                    record.confidence ||
                                    0
                                )
                                : null,

                        result:
                            record?.actual_result ||
                            "PENDING",

                        actualResult:
                            record?.actual_result ||
                            "PENDING"

                    };

                }
            );


    const model =
        modelCache.prediction;


    sendJSON(
        res,
        200,
        {

            ok: true,

            serverTime:
                Date.now(),


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
                    "LOW",

                status:
                    model?.status ||
                    "NO_MATCH",

                classification:
                    model?.classification ||
                    "NO_MATCH",

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
                    Date.now(),

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
// PREDICTION HISTORY
// ============================================================

async function predictionHistory(
    res
) {

    if (!pool) {

        sendJSON(
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


    sendJSON(
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

    sendJSON(
        res,
        200,
        {

            ok: true,

            serverTime:
                Date.now(),

            modelVersion:
                MODEL_VERSION,

            engine:
                "25 RULE PATTERN + OPPOSITE + WEIGHTED SUPPORT",

            masterRules:
                RULES.length,

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

function adminPing(
    res
) {

    sendJSON(
        res,
        200,
        {

            ok: true,

            message:
                "PONG",

            time:
                Date.now(),

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


    sendJSON(
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


    sendJSON(
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
                "LOW",

            status:
                model.prediction
                    ?.status ||
                "NO_MATCH",

            classification:
                model.prediction
                    ?.classification ||
                "NO_MATCH",

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

        sendJSON(
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


    sendJSON(
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

        sendJSON(
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


    const requested =
        String(
            body?.key ||
            body?.access_key ||
            ""
        ).trim();


    const key =
        requested ||
        (
            "DY-" +
            crypto
                .randomBytes(12)
                .toString("hex")
                .toUpperCase()
        );


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

                    Date.now()

                ]
            );


        sendJSON(
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

    } catch (
        error
    ) {

        sendJSON(
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

        sendJSON(
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

        sendJSON(
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


    sendJSON(
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

        sendJSON(
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

        sendJSON(
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


    sendJSON(
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
// JSON RESPONSE
// ============================================================

function sendJSON(
    res,
    status,
    data
) {

    const body =
        JSON.stringify(
            data
        );


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


    res.end(
        body
    );

}


// ============================================================
// READ BODY
// ============================================================

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

                    body += chunk;


                    if (
                        body.length >
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
// HEALTH
// ============================================================

function health(
    res
) {

    sendJSON(
        res,
        200,
        {

            ok: true,

            service:
                "DY AI WINGO",

            modelVersion:
                MODEL_VERSION,

            engine:
                "25 RULE PATTERN + OPPOSITE + WEIGHTED SUPPORT",

            time:
                Date.now(),

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

function getContentType(
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
// STATIC FILE
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

        res.writeHead(
            400
        );

        res.end(
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

        res.writeHead(
            403
        );

        res.end(
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

                res.writeHead(
                    404
                );

                res.end(
                    "Not Found"
                );

                return;

            }


            const type =
                getContentType(
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

                    res.writeHead(
                        416
                    );

                    res.end(
                        "Invalid Range"
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
                            end -
                            start +
                            1

                    }
                );


                fs.createReadStream(
                    filePath,
                    {
                        start,
                        end
                    }
                ).pipe(
                    res
                );


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
            ).pipe(
                res
            );

        }
    );

}


// ============================================================
// HTTP SERVER
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

                    health(
                        res
                    );

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

                    await stateAPI(
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


                    if (
                        !auth.ok
                    ) {

                        sendJSON(
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

                        sendJSON(
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


            } catch (
                error
            ) {

                console.error(
                    "[SERVER ERROR]",
                    error
                );


                if (
                    !res.headersSent
                ) {

                    sendJSON(
                        res,
                        500,
                        {

                            ok: false,

                            error:
                                error.message ||
                                "Internal Server Error"

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

    } catch (
        error
    ) {

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
                    "================================================"
                );

                console.log(
                    "             DY AI WINGO SERVER"
                );

                console.log(
                    "================================================"
                );

                console.log(
                    `PORT: ${PORT}`
                );

                console.log(
                    `MODEL: ${MODEL_VERSION}`
                );

                console.log(
                    `MASTER RULES: ${RULES.length}`
                );

                console.log(
                    `TOTAL PATTERNS: ${PATTERN_DATABASE.length}`
                );

                console.log(
                    `HISTORY: ${providerState.history.length}`
                );

                console.log(
                    `TARGET: ${modelCache.targetIssue || "NONE"}`
                );

                console.log(
                    `STATUS: ${
                        modelCache.prediction
                            ?.status ||
                        "NO_MATCH"
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
                    "================================================"
                );

            }
        );


        setInterval(
            backgroundRefresh,
            PROVIDER_REFRESH_MS
        );


    } catch (
        error
    ) {

        console.error(
            "[START ERROR]",
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
