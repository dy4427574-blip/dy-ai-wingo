"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 10000);

const DATABASE_URL = process.env.DATABASE_URL || "";
const ADMIN_KEY = process.env.ADMIN_KEY || "dy4427574";
const WINGOBOT_TOKEN = process.env.WINGOBOT_TOKEN || "";

const WINGOBOT_URL =
    "https://api.wingobot.com/v2/30-sec-game-history";

const THINKING_DURATION_MS = 3000;

/*
=========================================================
 DY AI WINGO - OWN ANALYSIS ENGINE V3

 Prediction cycle:

 1 prediction
       ↓
 prediction settles
       ↓
 5 complete rounds WAIT
       ↓
 fresh full analysis
       ↓
 next prediction

 No forced alternation.
 No endless same-side prediction.
 No prediction during cooldown.

 A = SMALL 0-4
 B = BIG   5-9
=========================================================
*/


/* =====================================================
   DATABASE
===================================================== */

const pool = DATABASE_URL
    ? new Pool({
        connectionString: DATABASE_URL,
        ssl: {
            rejectUnauthorized: false
        }
    })
    : null;


/* =====================================================
   DATABASE INIT
===================================================== */

async function initDB() {

    if (!pool) {
        console.log("DATABASE_URL not configured.");
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

    console.log("Database initialized.");
}


/* =====================================================
   NUMBER MAPPING
===================================================== */

function numberToAB(value) {

    const n = Number(value);

    if (!Number.isInteger(n)) {
        return null;
    }

    if (n < 0 || n > 9) {
        return null;
    }

    return n <= 4 ? "A" : "B";
}


function abToType(value) {

    if (value === "A") return "SMALL";
    if (value === "B") return "BIG";

    return null;
}


/* =====================================================
   CLEAN NUMBERS
===================================================== */

function cleanNumbers(results) {

    if (!Array.isArray(results)) {
        return [];
    }

    return results
        .map(item => {

            if (
                item &&
                typeof item === "object"
            ) {
                return Number(
                    item.number ??
                    item.actual_number ??
                    item.value
                );
            }

            return Number(item);
        })
        .filter(n =>
            Number.isInteger(n) &&
            n >= 0 &&
            n <= 9
        );
}


/* =====================================================
   HISTORY
===================================================== */

function convertHistory(results) {

    return cleanNumbers(results)
        .map(numberToAB)
        .filter(Boolean);
}


/* =====================================================
   BASIC STATS
===================================================== */

function countAB(history) {

    const A =
        history.filter(x => x === "A").length;

    const B =
        history.filter(x => x === "B").length;

    const total = A + B;

    return {
        A,
        B,
        total,

        APercent:
            total
                ? +(A / total * 100).toFixed(2)
                : 0,

        BPercent:
            total
                ? +(B / total * 100).toFixed(2)
                : 0
    };
}


/* =====================================================
   CURRENT STREAK
===================================================== */

function currentStreak(history) {

    if (!history.length) {
        return {
            side: null,
            length: 0
        };
    }

    const side =
        history[history.length - 1];

    let length = 0;

    for (
        let i = history.length - 1;
        i >= 0;
        i--
    ) {

        if (history[i] !== side) {
            break;
        }

        length++;
    }

    return {
        side,
        length
    };
}


/* =====================================================
   RUN ANALYSIS
===================================================== */

function getRuns(history) {

    const runs = [];

    if (!history.length) {
        return runs;
    }

    let side = history[0];
    let length = 1;

    for (
        let i = 1;
        i < history.length;
        i++
    ) {

        if (history[i] === side) {

            length++;

        } else {

            runs.push({
                side,
                length
            });

            side = history[i];
            length = 1;
        }
    }

    runs.push({
        side,
        length
    });

    return runs;
}


function runStats(history) {

    const runs =
        getRuns(history);

    const lengths =
        runs.map(x => x.length);

    if (!lengths.length) {

        return {
            runs: [],
            average: 0,
            median: 0,
            longest: 0
        };
    }

    const average =
        lengths.reduce(
            (a, b) => a + b,
            0
        ) / lengths.length;

    const sorted =
        [...lengths].sort(
            (a, b) => a - b
        );

    const middle =
        Math.floor(
            sorted.length / 2
        );

    const median =
        sorted.length % 2
            ? sorted[middle]
            : (
                sorted[middle - 1] +
                sorted[middle]
            ) / 2;

    return {

        runs,

        average:
            +average.toFixed(2),

        median:
            +median.toFixed(2),

        longest:
            Math.max(...lengths)
    };
}


/* =====================================================
   SWITCHING
===================================================== */

function switchingStats(history) {

    if (history.length < 2) {

        return {
            switches: 0,
            rate: 0
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

    return {

        switches,

        rate:
            +(switches /
                (history.length - 1) *
                100
            ).toFixed(2)
    };
}


/* =====================================================
   TRANSITION ANALYSIS
===================================================== */

function transitions(history) {

    const matrix = {
        AA: 0,
        AB: 0,
        BA: 0,
        BB: 0
    };

    for (
        let i = 1;
        i < history.length;
        i++
    ) {

        const pair =
            history[i - 1] +
            history[i];

        if (
            matrix[pair] !== undefined
        ) {
            matrix[pair]++;
        }
    }

    const afterA =
        matrix.AA +
        matrix.AB;

    const afterB =
        matrix.BA +
        matrix.BB;

    return {

        matrix,

        afterA: {

            same:
                afterA
                    ? +(matrix.AA /
                        afterA *
                        100
                    ).toFixed(2)
                    : 0,

            switch:
                afterA
                    ? +(matrix.AB /
                        afterA *
                        100
                    ).toFixed(2)
                    : 0
        },

        afterB: {

            switch:
                afterB
                    ? +(matrix.BA /
                        afterB *
                        100
                    ).toFixed(2)
                    : 0,

            same:
                afterB
                    ? +(matrix.BB /
                        afterB *
                        100
                    ).toFixed(2)
                    : 0
        }
    };
}


/* =====================================================
   WINDOW ANALYSIS
===================================================== */

function windowsAnalysis(history) {

    const sizes =
        [5, 10, 20, 30, 50, 100];

    const output = {};

    for (
        const size of sizes
    ) {

        if (
            history.length < size
        ) {
            continue;
        }

        const part =
            history.slice(-size);

        const stats =
            countAB(part);

        output[size] = {

            A: stats.A,
            B: stats.B,

            APercent:
                stats.APercent,

            BPercent:
                stats.BPercent,

            switching:
                switchingStats(part),

            streak:
                currentStreak(part),

            longestA:
                runStats(part).runs
                    .filter(x => x.side === "A")
                    .reduce(
                        (m, x) =>
                            Math.max(
                                m,
                                x.length
                            ),
                        0
                    ),

            longestB:
                runStats(part).runs
                    .filter(x => x.side === "B")
                    .reduce(
                        (m, x) =>
                            Math.max(
                                m,
                                x.length
                            ),
                        0
                    )
        };
    }

    return output;
}


/* =====================================================
   MOMENTUM
===================================================== */

function momentumAnalysis(history) {

    if (history.length < 20) {

        return {
            status: "LOW_DATA"
        };
    }

    const recent =
        history.slice(-10);

    const previous =
        history.slice(-20, -10);

    const r =
        countAB(recent);

    const p =
        countAB(previous);

    const recentBias =
        r.BPercent -
        r.APercent;

    const previousBias =
        p.BPercent -
        p.APercent;

    const shift =
        recentBias -
        previousBias;

    let classification =
        "STABLE";

    if (shift >= 20) {

        classification =
            "TOWARD_BIG";

    } else if (shift <= -20) {

        classification =
            "TOWARD_SMALL";

    } else if (
        Math.abs(shift) >= 10
    ) {

        classification =
            "SHIFTING";
    }

    return {

        recent,
        previous,

        shift:
            +shift.toFixed(2),

        classification
    };
}


/* =====================================================
   ALTERNATION
===================================================== */

function alternationAnalysis(history) {

    if (history.length < 2) {

        return {
            length: 0,
            active: false
        };
    }

    let length = 1;

    for (
        let i = history.length - 1;
        i > 0;
        i--
    ) {

        if (
            history[i] ===
            history[i - 1]
        ) {
            break;
        }

        length++;
    }

    return {

        length,

        active:
            length >= 4
    };
}


/* =====================================================
   REPEATING BLOCK
===================================================== */

function repeatingBlocks(history) {

    const output = [];

    for (
        let size = 2;
        size <= 6;
        size++
    ) {

        if (
            history.length <
            size * 3
        ) {
            continue;
        }

        const block =
            history
                .slice(-size)
                .join("");

        let repeats = 0;

        for (
            let i =
                history.length - size;

            i >= 0;

            i -= size
        ) {

            const part =
                history
                    .slice(
                        i,
                        i + size
                    )
                    .join("");

            if (
                part === block
            ) {

                repeats++;

            } else {

                break;
            }
        }

        if (repeats >= 2) {

            output.push({
                size,
                block,
                repeats
            });
        }
    }

    return output;
}


/* =====================================================
   DIGIT ANALYSIS
===================================================== */

function digitAnalysis(numbers) {

    const frequency =
        Array(10).fill(0);

    for (
        const n of numbers
    ) {

        if (
            Number.isInteger(n)
        ) {
            frequency[n]++;
        }
    }

    return {

        frequency,

        repeatedLast:
            numbers.length >= 2 &&
            numbers.at(-1) ===
            numbers.at(-2),

        average:
            numbers.length
                ? +(
                    numbers.reduce(
                        (a, b) =>
                            a + b,
                        0
                    ) /
                    numbers.length
                ).toFixed(2)
                : 0
    };
}


/* =====================================================
   RECENT SIDE BIAS
===================================================== */

function sideBias(history, size) {

    const part =
        history.slice(-size);

    const stats =
        countAB(part);

    return (
        stats.BPercent -
        stats.APercent
    );
}


/* =====================================================
   HISTORICAL SEQUENCE ANALYSIS

   Current last N sequence ko history me search karke
   dekhta hai ki uske baad actual me kya hua.
===================================================== */

function historicalSequence(
    history
) {

    const results = [];

    const maxLength =
        Math.min(
            8,
            Math.floor(
                history.length / 3
            )
        );

    for (
        let length = maxLength;
        length >= 4;
        length--
    ) {

        const pattern =
            history
                .slice(-length)
                .join("");

        let A = 0;
        let B = 0;

        for (
            let i = 0;
            i + length <
            history.length;
            i++
        ) {

            const part =
                history
                    .slice(
                        i,
                        i + length
                    )
                    .join("");

            if (
                part !== pattern
            ) {
                continue;
            }

            const next =
                history[i + length];

            if (next === "A") {
                A++;
            }

            if (next === "B") {
                B++;
            }
        }

        const total =
            A + B;

        if (total > 0) {

            results.push({

                length,

                pattern,

                occurrences:
                    total,

                A,
                B,

                APercent:
                    +(A /
                        total *
                        100
                    ).toFixed(2),

                BPercent:
                    +(B /
                        total *
                        100
                    ).toFixed(2)
            });
        }
    }

    return results;
}


/* =====================================================
   OWN ANALYSIS ENGINE

   Multiple independent components.
===================================================== */

function fullAnalysis(numbers) {

    const history =
        convertHistory(numbers);

    if (
        history.length < 10
    ) {

        return {

            status:
                "INSUFFICIENT DATA",

            prediction:
                null,

            confidence:
                0,

            historyLength:
                history.length
        };
    }


    const stats =
        countAB(history);

    const streak =
        currentStreak(history);

    const runs =
        runStats(history);

    const switching =
        switchingStats(history);

    const windows =
        windowsAnalysis(history);

    const transition =
        transitions(history);

    const recentTransition =
        transitions(
            history.slice(-20)
        );

    const momentum =
        momentumAnalysis(history);

    const alternation =
        alternationAnalysis(history);

    const blocks =
        repeatingBlocks(history);

    const digits =
        digitAnalysis(numbers);

    const historical =
        historicalSequence(history);


    /* =================================================
       SCORES

       Separate BIG / SMALL support.
    ================================================= */

    let small = 0;
    let big = 0;

    const reasons = [];


    /* =================================================
       1. RECENT WINDOW - 20%
    ================================================= */

    const w5 =
        windows[5];

    const w10 =
        windows[10];

    const w20 =
        windows[20];

    if (w5) {

        small +=
            w5.APercent *
            0.08;

        big +=
            w5.BPercent *
            0.08;
    }

    if (w10) {

        small +=
            w10.APercent *
            0.05;

        big +=
            w10.BPercent *
            0.05;
    }

    if (w20) {

        small +=
            w20.APercent *
            0.03;

        big +=
            w20.BPercent *
            0.03;
    }


    /* =================================================
       2. FREQUENCY - LOW WEIGHT
    ================================================= */

    const frequencyBias =
        stats.APercent -
        stats.BPercent;

    small +=
        frequencyBias *
        0.04;

    big -=
        frequencyBias *
        0.04;


    /* =================================================
       3. STREAK STRUCTURE
    ================================================= */

    if (
        streak.side === "A"
    ) {

        /*
          Short streak:
          continuation still possible.
        */

        if (
            streak.length <= 2
        ) {

            small += 2;

        } else if (
            streak.length === 3
        ) {

            small += 0.5;

        } else if (
            streak.length >= 4
        ) {

            /*
              Long streak:
              do not blindly continue.
            */

            big +=
                Math.min(
                    6,
                    streak.length * 0.8
                );

            reasons.push(
                `SMALL streak ${streak.length}; continuation penalized.`
            );
        }

    } else if (
        streak.side === "B"
    ) {

        if (
            streak.length <= 2
        ) {

            big += 2;

        } else if (
            streak.length === 3
        ) {

            big += 0.5;

        } else if (
            streak.length >= 4
        ) {

            small +=
                Math.min(
                    6,
                    streak.length * 0.8
                );

            reasons.push(
                `BIG streak ${streak.length}; continuation penalized.`
            );
        }
    }


    /* =================================================
       4. SWITCHING
    ================================================= */

    if (
        switching.rate >= 60
    ) {

        if (
            streak.side === "A"
        ) {

            big += 4;

        } else {

            small += 4;
        }

        reasons.push(
            "High switching regime."
        );

    } else if (
        switching.rate < 40
    ) {

        /*
          Streak-dominant:
          don't force reversal.
        */

        if (
            streak.side === "A"
        ) {

            small += 2;

        } else {

            big += 2;
        }
    }


    /* =================================================
       5. TRANSITION
    ================================================= */

    if (
        streak.side === "A"
    ) {

        small +=
            recentTransition
                .afterA
                .same *
            0.04;

        big +=
            recentTransition
                .afterA
                .switch *
            0.04;

    } else {

        small +=
            recentTransition
                .afterB
                .switch *
            0.04;

        big +=
            recentTransition
                .afterB
                .same *
            0.04;
    }


    /* =================================================
       6. MOMENTUM
    ================================================= */

    if (
        momentum.classification ===
        "TOWARD_BIG"
    ) {

        big += 5;

        reasons.push(
            "Recent momentum moved toward BIG."
        );
    }

    if (
        momentum.classification ===
        "TOWARD_SMALL"
    ) {

        small += 5;

        reasons.push(
            "Recent momentum moved toward SMALL."
        );
    }


    /* =================================================
       7. HISTORICAL SEQUENCE
    ================================================= */

    if (
        historical.length
    ) {

        /*
          Longest historical sequence gets
          highest weight, but only when it has
          enough occurrences.
        */

        const useful =
            historical.find(
                x =>
                    x.occurrences >= 2
            ) ||
            historical[0];

        if (
            useful
        ) {

            const reliability =
                Math.min(
                    1,
                    useful.occurrences /
                    5
                );

            small +=
                useful.APercent *
                0.05 *
                reliability;

            big +=
                useful.BPercent *
                0.05 *
                reliability;

            reasons.push(
                `Historical sequence ${useful.pattern} checked (${useful.occurrences} occurrences).`
            );
        }
    }


    /* =================================================
       8. ALTERNATION
    ================================================= */

    if (
        alternation.active
    ) {

        if (
            streak.side === "A"
        ) {

            big += 2;

        } else {

            small += 2;
        }

        reasons.push(
            "Recent alternation detected."
        );
    }


    /* =================================================
       9. REPEATING BLOCK
    ================================================= */

    if (
        blocks.length
    ) {

        const strongest =
            blocks[0];

        const next =
            strongest.block[
                0
            ];

        if (
            next === "A"
        ) {

            small += 2;

        } else {

            big += 2;
        }
    }


    /* =================================================
       10. VERY LONG STREAK PROTECTION

       MAIN FIX AGAINST:

       SMALL SMALL SMALL SMALL...
       or
       BIG BIG BIG BIG...
    ================================================= */

    if (
        streak.length >= 5
    ) {

        if (
            streak.side === "A"
        ) {

            small -=
                streak.length >= 7
                    ? 8
                    : 5;

            big +=
                streak.length >= 7
                    ? 6
                    : 3;

            reasons.push(
                "Long SMALL streak anti-repeat protection."
            );

        } else {

            big -=
                streak.length >= 7
                    ? 8
                    : 5;

            small +=
                streak.length >= 7
                    ? 6
                    : 3;

            reasons.push(
                "Long BIG streak anti-repeat protection."
            );
        }
    }


    /* =================================================
       11. CONFLICT CHECK
    ================================================= */

    small =
        Math.max(
            0,
            small
        );

    big =
        Math.max(
            0,
            big
        );


    const total =
        small + big;

    const difference =
        Math.abs(
            small - big
        );


    /*
      If scores are too close,
      no prediction.
    */

    let prediction = null;

    if (
        total > 0 &&
        difference >=
        Math.max(
            3,
            total * 0.12
        )
    ) {

        prediction =
            small > big
                ? "SMALL"
                : "BIG";
    }


    /* =================================================
       12. CONFIDENCE
    ================================================= */

    let confidence = 0;

    if (
        prediction
    ) {

        confidence =
            Math.round(
                difference /
                total *
                100
            );

        /*
          More data = more stable,
          but never show fake 100%.
        */

        if (
            history.length < 20
        ) {

            confidence =
                Math.round(
                    confidence *
                    0.70
                );

        } else if (
            history.length < 30
        ) {

            confidence =
                Math.round(
                    confidence *
                    0.85
                );
        }

        confidence =
            Math.min(
                92,
                confidence
            );
    }


    /* =================================================
       13. CLASSIFICATION
    ================================================= */

    let classification =
        "NO CLEAR SIGNAL";

    if (
        !prediction
    ) {

        classification =
            "MIXED / CONFLICTING";

    } else if (
        confidence >= 75
    ) {

        classification =
            "STRONG HISTORICAL BIAS";

    } else if (
        confidence >= 55
    ) {

        classification =
            "MODERATE HISTORICAL BIAS";

    } else {

        classification =
            "WEAK HISTORICAL BIAS";
    }


    return {

        status: "OK",

        prediction,

        confidence,

        classification,

        historyLength:
            history.length,

        current:
            abToType(
                streak.side
            ),

        currentAB:
            streak.side,

        currentStreak:
            streak.length,

        stats,

        windows,

        switching,

        transition,

        recentTransition,

        momentum,

        runs,

        alternation,

        repeatingBlocks:
            blocks,

        digits,

        historicalSequence:
            historical.slice(
                0,
                5
            ),

        score: {

            SMALL:
                +small.toFixed(2),

            BIG:
                +big.toFixed(2),

            difference:
                +difference.toFixed(2)
        },

        reasons,

        thinkingDurationMs:
            THINKING_DURATION_MS,

        message:
            "Historical analysis only. Future results are not guaranteed."
    };
}


/* =====================================================
   WINGOBOT
===================================================== */

async function fetchWingoHistory() {

    if (!WINGOBOT_TOKEN) {

        throw new Error(
            "WINGOBOT_TOKEN not configured"
        );
    }

    const response =
        await fetch(
            WINGOBOT_URL,
            {
                method: "GET",

                headers: {
                    Authorization:
                        `Bearer ${WINGOBOT_TOKEN}`,

                    Accept:
                        "application/json"
                }
            }
        );


    if (!response.ok) {

        throw new Error(
            `WingoBot HTTP ${response.status}`
        );
    }


    return response.json();
}


/* =====================================================
   NORMALIZE WINGO
===================================================== */

function normalizeWingo(data) {

    const rows =
        Array.isArray(
            data?.history
        )
            ? data.history

            : Array.isArray(
                data?.data
            )
                ? data.data

                : Array.isArray(
                    data?.results
                )
                    ? data.results
                    : [];


    const history =
        rows
            .map(row => {

                const number =
                    Number(
                        row.number ??
                        row.result ??
                        row.value
                    );


                if (
                    !Number.isInteger(
                        number
                    ) ||
                    number < 0 ||
                    number > 9
                ) {
                    return null;
                }


                return {

                    issue:
                        String(
                            row.issueNumber ??
                            row.issue ??
                            row.period ??
                            ""
                        ),

                    number,

                    type:
                        abToType(
                            numberToAB(
                                number
                            )
                        ),

                    colour:
                        row.colour ??
                        row.color ??
                        "",

                    premium:
                        row.premium ??
                        null,

                    sum:
                        row.sum ??
                        null
                };
            })
            .filter(Boolean);


    return {

        currentIssue:
            String(
                data?.current
                    ?.issueNumber ??
                data?.current
                    ?.issue ??
                history[0]
                    ?.issue ??
                ""
            ),

        history,

        fetched:
            data?.stats
                ?.fetched ??
            history.length,

        lastUpdated:
            data?.stats
                ?.last_updated ??
            Date.now()
    };
}


/* =====================================================
   ISSUE NUMBER
===================================================== */

function getNextIssue(issue) {

    if (!issue) {
        return null;
    }

    const match =
        String(issue)
            .match(/\d+/);

    if (!match) {
        return null;
    }

    const prefix =
        String(issue).slice(
            0,
            match.index
        );

    const number =
        BigInt(match[0]);

    return (
        prefix +
        String(
            number + 1n
        )
    );
}


/* =====================================================
   ISSUE TO NUMBER

   Useful for cooldown calculation.
===================================================== */

function issueNumberPart(issue) {

    if (!issue) {
        return null;
    }

    const match =
        String(issue)
            .match(/\d+$/);

    if (!match) {
        return null;
    }

    try {
        return BigInt(
            match[0]
        );
    } catch {
        return null;
    }
}


/* =====================================================
   COMPLETED ROUNDS AFTER PREDICTION
===================================================== */

function completedRoundsAfter(
    history,
    targetIssue
) {

    const target =
        issueNumberPart(
            targetIssue
        );

    if (
        target === null
    ) {
        return 0;
    }

    let count = 0;

    for (
        const row of history
    ) {

        const issue =
            issueNumberPart(
                row.issue
            );

        if (
            issue !== null &&
            issue > target
        ) {
            count++;
        }
    }

    return count;
}


/* =====================================================
   LATEST PREDICTION FROM DB
===================================================== */

async function getLatestPrediction() {

    if (!pool) {
        return null;
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
            ORDER BY id DESC
            LIMIT 1
            `
        );

    return (
        result.rows[0] ||
        null
    );
}


/* =====================================================
   COOLDOWN STATUS

   One prediction ke baad exactly 5 completed
   rounds wait.
===================================================== */

async function getCooldownStatus(
    history
) {

    const latest =
        await getLatestPrediction();

    if (!latest) {

        return {

            active: false,

            waitRounds: 0,

            completedRounds: 0,

            requiredRounds: 5,

            lastPrediction: null
        };
    }


    /*
      Prediction abhi settle nahi hui.
    */

    if (
        !latest.actual_result
    ) {

        return {

            active: true,

            waitRounds: 5,

            completedRounds: 0,

            requiredRounds: 5,

            reason:
                "Previous prediction is still pending.",

            lastPrediction:
                latest
        };
    }


    const completed =
        completedRoundsAfter(
            history,
            latest.target_issue
        );


    const remaining =
        Math.max(
            0,
            5 - completed
        );


    return {

        active:
            remaining > 0,

        waitRounds:
            remaining,

        completedRounds:
            Math.min(
                5,
                completed
            ),

        requiredRounds:
            5,

        lastPrediction:
            latest,

        reason:
            remaining > 0
                ? "5-round cooldown active."
                : "Cooldown complete."
    };
}


/* =====================================================
   MODEL CACHE
===================================================== */

let modelCache = {

    prediction: null,

    confidence: 0,

    targetIssue: null,

    analysis: null,

    cooldown: {

        active: false,

        waitRounds: 0,

        completedRounds: 0,

        requiredRounds: 5
    },

    generatedAt: 0
};


/* =====================================================
   CREATE NEW PREDICTION

   IMPORTANT:
   New prediction ONLY after cooldown complete.
===================================================== */

async function createPredictionIfAllowed(
    wingo
) {

    const cooldown =
        await getCooldownStatus(
            wingo.history
        );


    /*
      COOLDOWN ACTIVE
    */

    if (
        cooldown.active
    ) {

        return {

            prediction: null,

            confidence: 0,

            targetIssue: null,

            cooldown,

            analysis: null,

            thinkingDurationMs:
                THINKING_DURATION_MS
        };
    }


    /*
      Fresh full analysis.
    */

    const numbers =
        [
            ...wingo.history
                .map(
                    x => x.number
                )
        ]
        .reverse();


    const analysis =
        fullAnalysis(
            numbers
        );


    /*
      No clear signal:
      don't save a fake prediction.
    */

    if (
        !analysis.prediction
    ) {

        return {

            prediction: null,

            confidence:
                analysis.confidence,

            targetIssue:
                null,

            cooldown,

            analysis,

            thinkingDurationMs:
                THINKING_DURATION_MS
        };
    }


    const targetIssue =
        getNextIssue(
            wingo.currentIssue ||
            wingo.history[0]?.issue
        );


    return {

        prediction:
            analysis.prediction,

        confidence:
            analysis.confidence,

        targetIssue,

        cooldown,

        analysis,

        thinkingDurationMs:
            THINKING_DURATION_MS
    };
}


/* =====================================================
   SAVE PREDICTION
===================================================== */

async function savePrediction(
    model
) {

    if (
        !pool ||
        !model.prediction ||
        !model.targetIssue
    ) {
        return;
    }


    const existing =
        await pool.query(
            `
            SELECT id
            FROM prediction_records
            WHERE target_issue = $1
            LIMIT 1
            `,
            [
                model.targetIssue
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
        VALUES
        ($1,$2,$3,$4,$5)
        `,
        [
            model.targetIssue,
            model.prediction,
            model.confidence,
            "OWN-FULL-ANALYSIS-V3",
            Date.now()
        ]
    );
}


/* =====================================================
   SETTLE PREDICTIONS
===================================================== */

async function settlePredictions(
    history
) {

    if (!pool) {
        return;
    }


    for (
        const row of history
    ) {

        if (
            !row.issue ||
            !row.type
        ) {
            continue;
        }


        await pool.query(
            `
            UPDATE prediction_records
            SET
                actual_number = $1,

                actual_result =
                    CASE
                        WHEN prediction = $2
                        THEN 'WIN'
                        ELSE 'LOSS'
                    END,

                settled_at = $3

            WHERE target_issue = $4

              AND actual_result IS NULL
            `,
            [
                row.number,
                row.type,
                Date.now(),
                row.issue
            ]
        );
    }
}


/* =====================================================
   LIVE STATE
===================================================== */

async function getLiveState() {

    try {

        const raw =
            await fetchWingoHistory();


        const wingo =
            normalizeWingo(
                raw
            );


        /*
          First settle old prediction.
        */

        await settlePredictions(
            wingo.history
        );


        /*
          Then check cooldown.
        */

        const model =
            await createPredictionIfAllowed(
                wingo
            );


        /*
          Save ONLY if cooldown is complete
          and a real prediction exists.
        */

        if (
            model.prediction &&
            model.targetIssue
        ) {

            await savePrediction(
                model
            );
        }


        const latest =
            await getLatestPrediction();


        const finalCooldown =
            await getCooldownStatus(
                wingo.history
            );


        /*
          During cooldown, don't expose a new
          prediction as current prediction.
        */

        modelCache = {

            prediction:
                finalCooldown.active
                    ? null
                    : model.prediction,

            confidence:
                finalCooldown.active
                    ? 0
                    : model.confidence,

            targetIssue:
                finalCooldown.active
                    ? null
                    : model.targetIssue,

            analysis:
                model.analysis,

            cooldown:
                finalCooldown,

            lastPrediction:
                latest,

            generatedAt:
                Date.now()
        };


        return {

            ok: true,

            currentIssue:
                wingo.currentIssue,

            history:
                wingo.history,

            fetched:
                wingo.fetched,

            lastUpdated:
                wingo.lastUpdated,

            model:
                modelCache,

            thinkingDurationMs:
                THINKING_DURATION_MS
        };

    } catch (error) {

        console.error(
            "Live state error:",
            error.message
        );


        return {

            ok: false,

            error:
                error.message,

            model:
                modelCache,

            thinkingDurationMs:
                THINKING_DURATION_MS
        };
    }
}


/* =====================================================
   AUTH
===================================================== */

function header(
    req,
    name
) {

    return (
        req.headers[
            name.toLowerCase()
        ] || ""
    );
}


function adminAuthorized(req) {

    return (
        header(
            req,
            "x-admin-key"
        ) ===
        ADMIN_KEY
    );
}


async function keyAuthorized(req) {

    if (!pool) {
        return false;
    }


    const accessKey =
        header(
            req,
            "x-access-key"
        );

    const deviceId =
        header(
            req,
            "x-device-id"
        );


    if (
        !accessKey ||
        !deviceId
    ) {
        return false;
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
        return false;
    }


    const row =
        result.rows[0];


    if (
        row.device_id &&
        row.device_id !== deviceId
    ) {

        return false;
    }


    await pool.query(
        `
        UPDATE access_keys
        SET
            device_id =
                COALESCE(
                    device_id,
                    $1
                ),

            last_seen = $2

        WHERE id = $3
        `,
        [
            deviceId,
            Date.now(),
            row.id
        ]
    );


    return true;
}


/* =====================================================
   BODY
===================================================== */

function readBody(req) {

    return new Promise(
        (resolve, reject) => {

            let body = "";

            req.on(
                "data",
                chunk => {
                    body += chunk;
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


/* =====================================================
   JSON
===================================================== */

function sendJSON(
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
                "no-store, no-cache, must-revalidate",

            "Access-Control-Allow-Origin":
                "*",

            "Access-Control-Allow-Headers":
                "Content-Type, X-Access-Key, X-Device-Id, X-Admin-Key",

            "Access-Control-Allow-Methods":
                "GET,POST,DELETE,OPTIONS"
        }
    );


    res.end(body);
}


/* =====================================================
   STATIC
===================================================== */

function serveStatic(
    req,
    res,
    pathname
) {

    let fileName;


    if (
        pathname === "/" ||
        pathname === "/prediction" ||
        pathname === "/prediction.html"
    ) {

        fileName =
            "prediction.html";

    } else if (
        pathname === "/admin" ||
        pathname === "/admin.html"
    ) {

        fileName =
            "admin.html";

    } else if (
        pathname === "/music.mp3"
    ) {

        fileName =
            "music.mp3";

    } else {

        res.writeHead(404);
        res.end("Not Found");
        return;
    }


    const filePath =
        path.join(
            __dirname,
            fileName
        );


    if (
        !fs.existsSync(
            filePath
        )
    ) {

        res.writeHead(404);
        res.end(
            "File not found"
        );

        return;
    }


    const stat =
        fs.statSync(
            filePath
        );


    const ext =
        path.extname(
            filePath
        ).toLowerCase();


    const contentTypes = {

        ".html":
            "text/html; charset=utf-8",

        ".js":
            "application/javascript; charset=utf-8",

        ".css":
            "text/css; charset=utf-8",

        ".json":
            "application/json",

        ".mp3":
            "audio/mpeg"
    };


    if (
        ext === ".mp3" &&
        req.headers.range
    ) {

        const match =
            req.headers.range.match(
                /bytes=(\d*)-(\d*)/
            );


        if (match) {

            const start =
                Number(
                    match[1] || 0
                );

            const end =
                Math.min(
                    Number(
                        match[2] ||
                        stat.size - 1
                    ),
                    stat.size - 1
                );


            if (
                start <= end &&
                start < stat.size
            ) {

                res.writeHead(
                    206,
                    {

                        "Content-Type":
                            "audio/mpeg",

                        "Content-Range":
                            `bytes ${start}-${end}/${stat.size}`,

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
        }
    }


    res.writeHead(
        200,
        {

            "Content-Type":
                contentTypes[ext] ||
                "application/octet-stream",

            "Content-Length":
                stat.size,

            "Cache-Control":
                ext === ".html"
                    ? "no-cache"
                    : "public, max-age=300"
        }
    );


    fs.createReadStream(
        filePath
    ).pipe(res);
}


/* =====================================================
   SERVER
===================================================== */

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

                    return sendJSON(
                        res,
                        204,
                        {}
                    );
                }


                const url =
                    new URL(
                        req.url,
                        `http://${req.headers.host || "localhost"}`
                    );


                const pathname =
                    url.pathname;


                /* HEALTH */

                if (
                    pathname ===
                    "/health"
                ) {

                    return sendJSON(
                        res,
                        200,
                        {

                            ok: true,

                            service:
                                "DY AI WinGo",

                            model:
                                "OWN-FULL-ANALYSIS-V3",

                            cooldownRounds:
                                5,

                            thinkingDurationMs:
                                THINKING_DURATION_MS
                        }
                    );
                }


                /* KEY CHECK */

                if (
                    pathname ===
                        "/api/key/check" &&
                    req.method ===
                        "GET"
                ) {

                    const valid =
                        await keyAuthorized(
                            req
                        );


                    return sendJSON(
                        res,
                        200,
                        {
                            ok: true,
                            valid
                        }
                    );
                }


                /* STATE */

                if (
                    pathname ===
                        "/api/state" &&
                    req.method ===
                        "GET"
                ) {

                    const valid =
                        await keyAuthorized(
                            req
                        );


                    if (!valid) {

                        return sendJSON(
                            res,
                            401,
                            {

                                ok: false,

                                error:
                                    "Invalid access key or device."
                            }
                        );
                    }


                    const state =
                        await getLiveState();


                    return sendJSON(
                        res,
                        200,
                        state
                    );
                }


                /* HISTORY */

                if (
                    pathname ===
                        "/api/history" &&
                    req.method ===
                        "GET"
                ) {

                    const valid =
                        await keyAuthorized(
                            req
                        );


                    if (!valid) {

                        return sendJSON(
                            res,
                            401,
                            {
                                ok: false,
                                error:
                                    "Unauthorized"
                            }
                        );
                    }


                    let live = [];


                    try {

                        const raw =
                            await fetchWingoHistory();


                        live =
                            normalizeWingo(
                                raw
                            ).history;

                    } catch {}


                    let predictions =
                        [];


                    if (pool) {

                        predictions =
                            (
                                await pool.query(
                                    `
                                    SELECT
                                        target_issue,
                                        prediction,
                                        confidence,
                                        actual_number,
                                        actual_result,
                                        model_version,
                                        created_at,
                                        settled_at
                                    FROM prediction_records
                                    ORDER BY id DESC
                                    LIMIT 100
                                    `
                                )
                            ).rows;
                    }


                    const map =
                        new Map();


                    for (
                        const p
                        of predictions
                    ) {

                        map.set(
                            String(
                                p.target_issue
                            ),
                            p
                        );
                    }


                    const merged =
                        live.map(
                            row => {

                                const p =
                                    map.get(
                                        String(
                                            row.issue
                                        )
                                    );


                                return {

                                    ...row,

                                    prediction:
                                        p?.prediction ||
                                        null,

                                    confidence:
                                        p?.confidence ||
                                        0,

                                    outcome:
                                        p?.actual_result ||
                                        null
                                };
                            }
                        );


                    return sendJSON(
                        res,
                        200,
                        {
                            ok: true,
                            history:
                                merged
                        }
                    );
                }


                /* ADMIN STATUS */

                if (
                    pathname ===
                        "/api/admin/status" &&
                    req.method ===
                        "GET"
                ) {

                    if (
                        !adminAuthorized(
                            req
                        )
                    ) {

                        return sendJSON(
                            res,
                            401,
                            {
                                ok: false
                            }
                        );
                    }


                    const state =
                        await getLiveState();


                    let keys = 0;


                    if (pool) {

                        keys =
                            (
                                await pool.query(
                                    `
                                    SELECT
                                        COUNT(*)::int AS count
                                    FROM access_keys
                                    `
                                )
                            )
                                .rows[0]
                                .count;
                    }


                    return sendJSON(
                        res,
                        200,
                        {

                            ok: true,

                            keys,

                            model:
                                state.model,

                            currentIssue:
                                state.currentIssue,

                            historyCount:
                                state.history?.length ||
                                0
                        }
                    );
                }


                /* ADMIN PING */

                if (
                    pathname ===
                        "/api/admin/ping" &&
                    req.method ===
                        "GET"
                ) {

                    if (
                        !adminAuthorized(
                            req
                        )
                    ) {

                        return sendJSON(
                            res,
                            401,
                            {
                                ok: false
                            }
                        );
                    }


                    return sendJSON(
                        res,
                        200,
                        {

                            ok: true,

                            time:
                                Date.now(),

                            model:
                                "OWN-FULL-ANALYSIS-V3",

                            cooldownRounds:
                                5
                        }
                    );
                }


                /* WINGO TEST */

                if (
                    pathname ===
                        "/api/admin/wingo-test" &&
                    req.method ===
                        "GET"
                ) {

                    if (
                        !adminAuthorized(
                            req
                        )
                    ) {

                        return sendJSON(
                            res,
                            401,
                            {
                                ok: false
                            }
                        );
                    }


                    try {

                        const raw =
                            await fetchWingoHistory();


                        const wingo =
                            normalizeWingo(
                                raw
                            );


                        return sendJSON(
                            res,
                            200,
                            {

                                ok: true,

                                currentIssue:
                                    wingo.currentIssue,

                                count:
                                    wingo.history.length,

                                sample:
                                    wingo.history.slice(
                                        0,
                                        10
                                    )
                            }
                        );

                    } catch (error) {

                        return sendJSON(
                            res,
                            500,
                            {

                                ok: false,

                                error:
                                    error.message
                            }
                        );
                    }
                }


                /* MODEL TEST */

                if (
                    pathname ===
                        "/api/admin/model-test" &&
                    req.method ===
                        "GET"
                ) {

                    if (
                        !adminAuthorized(
                            req
                        )
                    ) {

                        return sendJSON(
                            res,
                            401,
                            {
                                ok: false
                            }
                        );
                    }


                    const state =
                        await getLiveState();


                    return sendJSON(
                        res,
                        200,
                        {

                            ok: true,

                            model:
                                state.model
                        }
                    );
                }


                /* GET KEYS */

                if (
                    pathname ===
                        "/api/admin/keys" &&
                    req.method ===
                        "GET"
                ) {

                    if (
                        !adminAuthorized(
                            req
                        )
                    ) {

                        return sendJSON(
                            res,
                            401,
                            {
                                ok: false
                            }
                        );
                    }


                    if (!pool) {

                        return sendJSON(
                            res,
                            200,
                            {
                                ok: true,
                                keys: []
                            }
                        );
                    }


                    const rows =
                        (
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
                            )
                        ).rows;


                    return sendJSON(
                        res,
                        200,
                        {
                            ok: true,
                            keys: rows
                        }
                    );
                }


                /* CREATE KEY */

                if (
                    pathname ===
                        "/api/admin/keys" &&
                    req.method ===
                        "POST"
                ) {

                    if (
                        !adminAuthorized(
                            req
                        )
                    ) {

                        return sendJSON(
                            res,
                            401,
                            {
                                ok: false
                            }
                        );
                    }


                    if (!pool) {

                        return sendJSON(
                            res,
                            500,
                            {

                                ok: false,

                                error:
                                    "Database unavailable"
                            }
                        );
                    }


                    const body =
                        await readBody(
                            req
                        );


                    const requested =
                        String(
                            body.key ||
                            ""
                        ).trim();


                    const accessKey =
                        requested ||
                        crypto
                            .randomBytes(
                                12
                            )
                            .toString(
                                "hex"
                            );


                    await pool.query(
                        `
                        INSERT INTO access_keys
                        (
                            access_key,
                            created_at
                        )
                        VALUES
                        ($1,$2)
                        ON CONFLICT
                        (access_key)
                        DO NOTHING
                        `,
                        [
                            accessKey,
                            Date.now()
                        ]
                    );


                    return sendJSON(
                        res,
                        200,
                        {
                            ok: true,
                            key:
                                accessKey
                        }
                    );
                }


                /* DELETE KEY */

                if (
                    pathname ===
                        "/api/admin/keys" &&
                    req.method ===
                        "DELETE"
                ) {

                    if (
                        !adminAuthorized(
                            req
                        )
                    ) {

                        return sendJSON(
                            res,
                            401,
                            {
                                ok: false
                            }
                        );
                    }


                    if (!pool) {

                        return sendJSON(
                            res,
                            500,
                            {
                                ok: false
                            }
                        );
                    }


                    const body =
                        await readBody(
                            req
                        );


                    const key =
                        String(
                            body.key ||
                            ""
                        ).trim();


                    if (!key) {

                        return sendJSON(
                            res,
                            400,
                            {

                                ok: false,

                                error:
                                    "Key required"
                            }
                        );
                    }


                    await pool.query(
                        `
                        DELETE FROM access_keys
                        WHERE access_key = $1
                        `,
                        [
                            key
                        ]
                    );


                    return sendJSON(
                        res,
                        200,
                        {
                            ok: true
                        }
                    );
                }


                /* RESET DEVICE */

                if (
                    pathname ===
                        "/api/admin/reset-device" &&
                    req.method ===
                        "POST"
                ) {

                    if (
                        !adminAuthorized(
                            req
                        )
                    ) {

                        return sendJSON(
                            res,
                            401,
                            {
                                ok: false
                            }
                        );
                    }


                    if (!pool) {

                        return sendJSON(
                            res,
                            500,
                            {
                                ok: false
                            }
                        );
                    }


                    const body =
                        await readBody(
                            req
                        );


                    const key =
                        String(
                            body.key ||
                            ""
                        ).trim();


                    if (!key) {

                        return sendJSON(
                            res,
                            400,
                            {

                                ok: false,

                                error:
                                    "Key required"
                            }
                        );
                    }


                    await pool.query(
                        `
                        UPDATE access_keys
                        SET device_id = NULL
                        WHERE access_key = $1
                        `,
                        [
                            key
                        ]
                    );


                    return sendJSON(
                        res,
                        200,
                        {
                            ok: true
                        }
                    );
                }


                /* STATIC */

                if (
                    req.method ===
                    "GET"
                ) {

                    return serveStatic(
                        req,
                        res,
                        pathname
                    );
                }


                return sendJSON(
                    res,
                    404,
                    {

                        ok: false,

                        error:
                            "Not Found"
                    }
                );

            } catch (error) {

                console.error(
                    "Server error:",
                    error
                );


                return sendJSON(
                    res,
                    500,
                    {

                        ok: false,

                        error:
                            "Internal server error"
                    }
                );
            }
        }
    );


/* =====================================================
   START
===================================================== */

(async () => {

    try {

        await initDB();


        server.listen(
            PORT,
            () => {

                console.log(
                    `DY AI WinGo server running on port ${PORT}`
                );

                console.log(
                    "Model: OWN-FULL-ANALYSIS-V3"
                );

                console.log(
                    "Cooldown: 5 rounds"
                );

                console.log(
                    "Thinking:",
                    THINKING_DURATION_MS,
                    "ms"
                );
            }
        );

    } catch (error) {

        console.error(
            "Startup failed:",
            error
        );

        process.exit(1);
    }

})();
