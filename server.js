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
   25 RULE PATTERN ENGINE

   A = SMALL
   B = BIG
===================================================== */

const RULES = [
    { id: 1, pattern: "ABABABABAB" },
    { id: 2, pattern: "AABBAABB" },
    { id: 3, pattern: "AAABBBAAABBB" },
    { id: 4, pattern: "AAAABBBBAAAABBBB" },
    { id: 5, pattern: "AABAABAAB" },
    { id: 6, pattern: "AAAAAAAA BBBBBBBB" },
    { id: 7, pattern: "ABBABBABB" },
    { id: 8, pattern: "AAABAAABAAAB" },
    { id: 9, pattern: "AAABBAAABB" },
    { id: 10, pattern: "AAAAB B A BB AAAA" },
    { id: 11, pattern: "ABBBABBBABBB" },
    { id: 12, pattern: "ABABBABBB" },
    { id: 13, pattern: "AABBAAABBBAAAABBBB" },
    { id: 14, pattern: "ABBAAABBBB" },
    { id: 15, pattern: "AAAABBBAAB" },
    { id: 16, pattern: "ABAABBAAABBB" },
    { id: 17, pattern: "AABBBABBB AA" },
    { id: 18, pattern: "ABBAAAABBBBBBBB" },
    { id: 19, pattern: "ABBBABBB" },
    { id: 20, pattern: "AABBBAABBB" },
    { id: 21, pattern: "ABAABAAAB" },
    { id: 22, pattern: "AABAABBAABBB" },
    { id: 23, pattern: "AAAABA AA AAB" },
    { id: 24, pattern: "AAAABBAAAABB" },
    { id: 25, pattern: "AAAABBBAAAABBB" }
];

for (const rule of RULES) {
    rule.pattern =
        rule.pattern.replace(/[^AB]/g, "");
}


/* =====================================================
   OPPOSITE PATTERN LIBRARY
===================================================== */

function oppositePattern(pattern) {
    return pattern
        .split("")
        .map(x => x === "A" ? "B" : "A")
        .join("");
}

const PATTERN_LIBRARY = [];

for (const rule of RULES) {

    PATTERN_LIBRARY.push({
        rule: rule.id,
        type: "original",
        pattern: rule.pattern
    });

    PATTERN_LIBRARY.push({
        rule: rule.id,
        type: "opposite",
        pattern: oppositePattern(
            rule.pattern
        )
    });
}


/* =====================================================
   NUMBER -> A/B
===================================================== */

function numberToAB(value) {

    const n = Number(value);

    if (!Number.isInteger(n)) {
        return null;
    }

    if (n < 0 || n > 9) {
        return null;
    }

    return n <= 4
        ? "A"
        : "B";
}


function abToType(value) {

    if (value === "A") {
        return "SMALL";
    }

    if (value === "B") {
        return "BIG";
    }

    return null;
}


/* =====================================================
   CLEAN HISTORY
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
        .filter(number =>
            Number.isInteger(number) &&
            number >= 0 &&
            number <= 9
        );
}


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

        APercent: total
            ? +(A / total * 100).toFixed(2)
            : 0,

        BPercent: total
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
   ALL RUNS
===================================================== */

function allRuns(history) {

    const output = [];

    if (!history.length) {
        return output;
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

            output.push({
                side,
                length
            });

            side = history[i];
            length = 1;
        }
    }

    output.push({
        side,
        length
    });

    return output;
}


/* =====================================================
   LONGEST STREAK
===================================================== */

function longestStreak(history, side) {

    const runs =
        allRuns(history);

    let longest = 0;

    for (const run of runs) {

        if (
            run.side === side &&
            run.length > longest
        ) {
            longest = run.length;
        }
    }

    return longest;
}


/* =====================================================
   SWITCH RATE
===================================================== */

function switchRate(history) {

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
   ALTERNATION
===================================================== */

function alternationInfo(history) {

    if (history.length < 2) {

        return {
            length: 0,
            active: false,
            broken: false
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
        active: length >= 4,
        broken:
            length > 1 &&
            length < 4
    };
}


/* =====================================================
   SUFFIX MATCH
===================================================== */

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


/* =====================================================
   FIND RULES
===================================================== */

function findRules(history) {

    const matches = [];

    for (
        const item of PATTERN_LIBRARY
    ) {

        const matched =
            suffixMatch(
                history,
                item.pattern
            );

        if (matched < 2) {
            continue;
        }

        let next = null;

        if (
            matched <
            item.pattern.length
        ) {

            next =
                item.pattern[matched];
        }

        matches.push({
            rule: item.rule,
            type: item.type,
            pattern: item.pattern,
            matched,
            next
        });
    }

    return matches;
}


/* =====================================================
   RULE WEIGHT

   Short matches intentionally weak.
===================================================== */

function ruleWeight(matched) {

    if (matched >= 12) return 14;
    if (matched >= 10) return 12;
    if (matched >= 8) return 10;
    if (matched >= 7) return 8;
    if (matched >= 6) return 7;
    if (matched >= 5) return 6;
    if (matched >= 4) return 3;
    if (matched >= 3) return 1;

    return 0.25;
}


/* =====================================================
   RULE SUPPORT
===================================================== */

function calculateRuleSupport(matches) {

    let A = 0;
    let B = 0;

    const evidence = [];

    for (
        const match of matches
    ) {

        if (!match.next) {
            continue;
        }

        const weight =
            ruleWeight(
                match.matched
            );

        if (match.next === "A") {
            A += weight;
        }

        if (match.next === "B") {
            B += weight;
        }

        evidence.push({
            rule: match.rule,
            type: match.type,
            matched: match.matched,
            expectedNext: match.next,
            weight:
                +weight.toFixed(2)
        });
    }

    const total =
        A + B;

    return {

        A: +A.toFixed(2),
        B: +B.toFixed(2),

        total:
            +total.toFixed(2),

        APercent:
            total
                ? +(A / total * 100).toFixed(2)
                : 0,

        BPercent:
            total
                ? +(B / total * 100).toFixed(2)
                : 0,

        evidence
    };
}


/* =====================================================
   HISTORICAL NEXT EVIDENCE

   Same pattern history me pehle aaya ho to uske
   baad actual A/B kya aaya tha wo dekha jayega.
===================================================== */

function historicalNextEvidence(
    history,
    pattern
) {

    if (pattern.length < 3) {

        return {
            A: 0,
            B: 0,
            total: 0,
            APercent: 0,
            BPercent: 0,
            occurrences: 0
        };
    }

    let A = 0;
    let B = 0;
    let occurrences = 0;

    for (
        let i = 0;
        i + pattern.length <
        history.length;
        i++
    ) {

        const part =
            history
                .slice(
                    i,
                    i + pattern.length
                )
                .join("");

        if (
            part !== pattern
        ) {
            continue;
        }

        const next =
            history[
                i + pattern.length
            ];

        occurrences++;

        if (next === "A") {
            A++;
        }

        if (next === "B") {
            B++;
        }
    }

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
                : 0,

        occurrences
    };
}


/* =====================================================
   PARTIAL HISTORICAL EVIDENCE
===================================================== */

function partialHistoricalEvidence(history) {

    const output = [];

    const maxLength =
        Math.min(
            8,
            history.length
        );

    for (
        let len = maxLength;
        len >= 4;
        len--
    ) {

        const suffix =
            history
                .slice(-len)
                .join("");

        let A = 0;
        let B = 0;
        let occurrences = 0;

        for (
            let i = 0;
            i + len <
            history.length;
            i++
        ) {

            const part =
                history
                    .slice(
                        i,
                        i + len
                    )
                    .join("");

            if (
                part !== suffix
            ) {
                continue;
            }

            const next =
                history[i + len];

            occurrences++;

            if (next === "A") {
                A++;
            }

            if (next === "B") {
                B++;
            }
        }

        if (occurrences > 0) {

            output.push({

                length: len,

                pattern:
                    suffix,

                A,
                B,

                occurrences,

                APercent:
                    +(A /
                        occurrences *
                        100
                    ).toFixed(2),

                BPercent:
                    +(B /
                        occurrences *
                        100
                    ).toFixed(2)
            });
        }
    }

    output.sort(
        (a, b) =>
            b.length - a.length ||
            b.occurrences -
            a.occurrences
    );

    return output;
}


/* =====================================================
   TRANSITION MATRIX
===================================================== */

function transitionMatrix(history) {

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
   MOMENTUM
===================================================== */

function momentum(history) {

    if (history.length < 20) {

        return {
            recent: null,
            previous: null,
            shift: "LOW_DATA",
            classification: "LOW_DATA"
        };
    }

    const recent =
        countAB(
            history.slice(-10)
        );

    const previous =
        countAB(
            history.slice(-20, -10)
        );

    const shift =
        (
            recent.BPercent -
            recent.APercent
        ) -
        (
            previous.BPercent -
            previous.APercent
        );

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
   RUN ANALYSIS
===================================================== */

function runAnalysis(history) {

    const runs =
        allRuns(history);

    const lengths =
        runs.map(
            x => x.length
        );

    const average =
        lengths.length
            ? lengths.reduce(
                (a, b) => a + b,
                0
            ) / lengths.length
            : 0;

    const sorted =
        [...lengths].sort(
            (a, b) => a - b
        );

    let median = 0;

    if (sorted.length) {

        const middle =
            Math.floor(
                sorted.length / 2
            );

        if (
            sorted.length % 2
        ) {

            median =
                sorted[middle];

        } else {

            median =
                (
                    sorted[middle - 1] +
                    sorted[middle]
                ) / 2;
        }
    }

    const frequency = {};

    for (
        const length of lengths
    ) {

        frequency[length] =
            (frequency[length] || 0) + 1;
    }

    let mostCommon = 0;

    for (
        const key of Object.keys(
            frequency
        )
    ) {

        if (
            !mostCommon ||
            frequency[key] >
            frequency[mostCommon]
        ) {

            mostCommon =
                Number(key);
        }
    }

    return {

        runs,

        average:
            +average.toFixed(2),

        median:
            +median.toFixed(2),

        longest:
            lengths.length
                ? Math.max(...lengths)
                : 0,

        mostCommon
    };
}


/* =====================================================
   REPEATING BLOCKS
===================================================== */

function repeatingBlocks(history) {

    const output = [];

    for (
        let length = 2;
        length <= 6;
        length++
    ) {

        if (
            history.length <
            length * 3
        ) {
            continue;
        }

        const block =
            history
                .slice(-length)
                .join("");

        let repeats = 0;

        for (
            let i =
                history.length -
                length;

            i >= 0;

            i -= length
        ) {

            const part =
                history
                    .slice(
                        i,
                        i + length
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
                length,
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
        const number of numbers
    ) {

        if (
            Number.isInteger(number)
        ) {
            frequency[number]++;
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
                        (a, b) => a + b,
                        0
                    ) /
                    numbers.length
                ).toFixed(2)
                : 0
    };
}


/* =====================================================
   REVERSAL ENGINE

   IMPORTANT:
   Yahi anti-streak ka main part hai.
===================================================== */

function reversalEngine(history) {

    const current =
        currentStreak(history);

    const runs =
        runAnalysis(history);

    const result = {

        currentSide:
            current.side,

        currentLength:
            current.length,

        scoreA: 0,
        scoreB: 0,

        reasons: [],

        watch: false,

        strength: "NONE"
    };

    if (
        !current.side ||
        current.length < 3
    ) {
        return result;
    }

    const opposite =
        current.side === "A"
            ? "B"
            : "A";


    /* R1 */

    if (
        current.length >= 5 &&
        current.length >
        runs.median + 1
    ) {

        if (opposite === "A") {
            result.scoreA += 2;
        } else {
            result.scoreB += 2;
        }

        result.reasons.push(
            "Current streak is longer than typical run."
        );
    }


    /* R2 */

    if (
        current.length >= 6
    ) {

        if (opposite === "A") {
            result.scoreA += 3;
        } else {
            result.scoreB += 3;
        }

        result.reasons.push(
            "Extended same-side streak detected."
        );
    }


    /* R3 */

    const recent =
        transitionMatrix(
            history.slice(-20)
        );

    if (
        current.side === "A" &&
        recent.afterA.switch >= 55
    ) {

        result.scoreB += 2;

        result.reasons.push(
            "Recent history often switches after SMALL."
        );
    }

    if (
        current.side === "B" &&
        recent.afterB.switch >= 55
    ) {

        result.scoreA += 2;

        result.reasons.push(
            "Recent history often switches after BIG."
        );
    }


    /* R4 */

    const switching =
        switchRate(
            history.slice(-20)
        );

    if (
        switching.rate >= 60
    ) {

        if (opposite === "A") {
            result.scoreA += 1;
        } else {
            result.scoreB += 1;
        }

        result.reasons.push(
            "High recent switching regime."
        );
    }


    /* R5 */

    if (
        current.length >= 4 &&
        current.length >=
        runs.longest - 1
    ) {

        if (opposite === "A") {
            result.scoreA += 2;
        } else {
            result.scoreB += 2;
        }

        result.reasons.push(
            "Current streak is near historical maximum."
        );
    }


    /* LIMIT */

    result.scoreA =
        Math.min(
            8,
            result.scoreA
        );

    result.scoreB =
        Math.min(
            8,
            result.scoreB
        );


    const maxScore =
        Math.max(
            result.scoreA,
            result.scoreB
        );

    if (
        maxScore >= 4
    ) {

        result.watch = true;

        result.strength =
            maxScore >= 6
                ? "STRONG"
                : "MODERATE";
    }

    return result;
}


/* =====================================================
   FAILED REVERSAL
===================================================== */

function failedReversal(history) {

    if (
        history.length < 8
    ) {

        return {
            detected: false,
            reason: ""
        };
    }

    const recent =
        history.slice(-8);

    const runs =
        allRuns(recent);

    if (
        runs.length < 3
    ) {

        return {
            detected: false,
            reason: ""
        };
    }

    const last =
        runs.at(-1);

    const previous =
        runs.at(-2);

    if (
        previous.length === 1 &&
        last.length >= 2
    ) {

        return {
            detected: true,

            reason:
                "Short reversal attempt failed and current side continued."
        };
    }

    return {
        detected: false,
        reason: ""
    };
}


/* =====================================================
   ANTI-STREAK ADJUSTMENT

   Same side ko endlessly repeat hone se rokta hai.
===================================================== */

function antiStreakAdjustment(
    history,
    candidate
) {

    const current =
        currentStreak(history);

    if (!current.side) {
        return 0;
    }


    /*
      Current side same prediction:

      4 streak = small penalty
      5 streak = medium
      6 streak = strong
      7+ = very strong
    */

    if (
        candidate ===
        current.side
    ) {

        if (
            current.length >= 7
        ) {
            return -7;
        }

        if (
            current.length >= 6
        ) {
            return -5;
        }

        if (
            current.length >= 5
        ) {
            return -3;
        }

        if (
            current.length >= 4
        ) {
            return -1.5;
        }
    }


    /*
      Opposite ko sirf modest bonus.
      Isliye forced alternation nahi hoga.
    */

    if (
        candidate !== current.side &&
        current.length >= 5
    ) {

        return 1.5;
    }

    return 0;
}


/* =====================================================
   CONFIDENCE
===================================================== */

function calculateConfidence(
    scoreA,
    scoreB,
    historyLength
) {

    const total =
        Math.abs(scoreA) +
        Math.abs(scoreB);

    if (!total) {
        return 0;
    }

    let confidence =
        Math.abs(
            scoreA - scoreB
        ) /
        total *
        100;


    /* SAMPLE SIZE PENALTY */

    if (
        historyLength < 10
    ) {

        confidence *= 0.55;

    } else if (
        historyLength < 20
    ) {

        confidence *= 0.75;

    } else if (
        historyLength < 30
    ) {

        confidence *= 0.88;
    }


    return Math.max(
        0,
        Math.min(
            95,
            Math.round(
                confidence
            )
        )
    );
}


/* =====================================================
   MAIN ANALYSIS
===================================================== */

function analyze(results) {

    const numbers =
        cleanNumbers(results);

    const history =
        numbers
            .map(numberToAB)
            .filter(Boolean);


    if (
        history.length < 3
    ) {

        return {

            status:
                "INSUFFICIENT DATA",

            prediction:
                null,

            confidence:
                0,

            message:
                "More historical results required."
        };
    }


    const stats =
        countAB(history);

    const streak =
        currentStreak(history);

    const switching =
        switchRate(history);

    const alternation =
        alternationInfo(history);

    const runs =
        runAnalysis(history);

    const blocks =
        repeatingBlocks(history);

    const momentumData =
        momentum(history);

    const transitions =
        transitionMatrix(history);

    const recentTransitions =
        transitionMatrix(
            history.slice(-20)
        );

    const digits =
        digitAnalysis(numbers);

    const matches =
        findRules(history);

    const ruleSupport =
        calculateRuleSupport(
            matches
        );

    const reversal =
        reversalEngine(history);

    const failed =
        failedReversal(history);

    const historicalPatterns =
        partialHistoricalEvidence(
            history
        );


    /* =================================================
       START SCORE
    ================================================= */

    let scoreA =
        ruleSupport.A;

    let scoreB =
        ruleSupport.B;


    /* =================================================
       HISTORICAL ACTUAL NEXT EVIDENCE
    ================================================= */

    if (
        historicalPatterns.length
    ) {

        const best =
            historicalPatterns[0];

        const weight =
            Math.min(
                8,
                best.length
            );

        scoreA +=
            best.A *
            weight;

        scoreB +=
            best.B *
            weight;
    }


    /* =================================================
       TRANSITION
    ================================================= */

    if (
        streak.side === "A"
    ) {

        scoreA +=
            recentTransitions
                .afterA
                .same *
            0.04;

        scoreB +=
            recentTransitions
                .afterA
                .switch *
            0.04;

    } else {

        scoreA +=
            recentTransitions
                .afterB
                .switch *
            0.04;

        scoreB +=
            recentTransitions
                .afterB
                .same *
            0.04;
    }


    /* =================================================
       MOMENTUM
    ================================================= */

    if (
        momentumData.classification ===
        "TOWARD_BIG"
    ) {

        scoreB += 2;
    }

    if (
        momentumData.classification ===
        "TOWARD_SMALL"
    ) {

        scoreA += 2;
    }


    /* =================================================
       SWITCHING
    ================================================= */

    if (
        switching.rate >= 60
    ) {

        if (
            streak.side === "A"
        ) {

            scoreB += 2;

        } else {

            scoreA += 2;
        }

    } else if (
        switching.rate < 40
    ) {

        /*
          Streak-dominant regime.
          Automatic reversal nahi.
        */

        if (
            streak.side === "A"
        ) {

            scoreA += 1;

        } else {

            scoreB += 1;
        }
    }


    /* =================================================
       REVERSAL
    ================================================= */

    scoreA +=
        reversal.scoreA *
        1.5;

    scoreB +=
        reversal.scoreB *
        1.5;


    /* =================================================
       FAILED REVERSAL PROTECTION
    ================================================= */

    if (
        failed.detected
    ) {

        if (
            streak.side === "A"
        ) {

            scoreA += 2;

        } else {

            scoreB += 2;
        }
    }


    /* =================================================
       ANTI-STREAK
    ================================================= */

    scoreA +=
        antiStreakAdjustment(
            history,
            "A"
        );

    scoreB +=
        antiStreakAdjustment(
            history,
            "B"
        );


    /* =================================================
       FREQUENCY
    ================================================= */

    if (
        history.length >= 20
    ) {

        const diff =
            stats.APercent -
            stats.BPercent;

        scoreA +=
            diff * 0.03;

        scoreB -=
            diff * 0.03;
    }


    /* =================================================
       CLEAN SCORE
    ================================================= */

    scoreA =
        +Math.max(
            0,
            scoreA
        ).toFixed(2);

    scoreB =
        +Math.max(
            0,
            scoreB
        ).toFixed(2);


    const difference =
        Math.abs(
            scoreA -
            scoreB
        );

    const total =
        scoreA +
        scoreB;


    /* =================================================
       DECISION
    ================================================= */

    let prediction = null;


    /*
      Very close scores:
      NO CLEAR SIGNAL
    */

    if (
        total > 0 &&
        difference >=
        Math.max(
            2.5,
            total * 0.10
        )
    ) {

        prediction =
            scoreA > scoreB
                ? "SMALL"
                : "BIG";
    }


    /* =================================================
       SPECIAL ANTI-STREAK CHECK
    ================================================= */

    if (
        prediction ===
            abToType(
                streak.side
            ) &&
        streak.length >= 5
    ) {

        const opposite =
            streak.side === "A"
                ? "B"
                : "A";

        const oppositeScore =
            opposite === "A"
                ? scoreA
                : scoreB;

        const sameScore =
            streak.side === "A"
                ? scoreA
                : scoreB;


        const historicalSupportsOpposite =
            historicalPatterns.some(
                item => {

                    if (
                        item.length < 5
                    ) {
                        return false;
                    }

                    return opposite === "A"
                        ? item.APercent >= 65
                        : item.BPercent >= 65;
                }
            );


        const strongOpposite =
            oppositeScore >
            sameScore * 0.90 &&
            (
                reversal.watch ||
                historicalSupportsOpposite
            );


        if (
            strongOpposite
        ) {

            prediction =
                abToType(
                    opposite
                );
        }
    }


    /* =================================================
       CONFIDENCE
    ================================================= */

    const confidence =
        prediction
            ? calculateConfidence(
                scoreA,
                scoreB,
                history.length
            )
            : 0;


    /* =================================================
       CLASSIFICATION
    ================================================= */

    let classification =
        "NO CLEAR SIGNAL";


    if (
        history.length < 10
    ) {

        classification =
            "INSUFFICIENT DATA";

    } else if (
        !prediction
    ) {

        classification =
            "MIXED / CONFLICTING";

    } else if (
        failed.detected &&
        prediction ===
            abToType(
                streak.side
            )
    ) {

        classification =
            "FAILED REVERSAL";

    } else if (
        reversal.watch &&
        prediction !==
            abToType(
                streak.side
            )
    ) {

        classification =
            "REVERSAL WATCH";

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

        status:
            "OK",

        prediction,

        confidence,

        classification,

        thinkingDurationMs:
            THINKING_DURATION_MS,

        current:
            abToType(
                streak.side
            ),

        currentAB:
            streak.side,

        currentStreak:
            streak.length,

        historyLength:
            history.length,

        stats,

        switching,

        alternation,

        runs,

        repeatingBlocks:
            blocks,

        momentum:
            momentumData,

        transitions,

        recentTransitions,

        digits,

        matchedRules:
            matches,

        ruleSupport: {

            A:
                ruleSupport.A,

            B:
                ruleSupport.B,

            APercent:
                ruleSupport.APercent,

            BPercent:
                ruleSupport.BPercent
        },

        historicalNextEvidence:
            historicalPatterns.slice(
                0,
                5
            ),

        reversal,

        failedReversal:
            failed,

        score: {

            SMALL:
                scoreA,

            BIG:
                scoreB,

            difference:
                +difference.toFixed(2)
        },

        message:
            "Historical pattern analysis only. No future result is guaranteed."
    };
}


/* =====================================================
   WINGOBOT API
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
                    "Authorization":
                        `Bearer ${WINGOBOT_TOKEN}`,

                    "Accept":
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
   MODEL CACHE
===================================================== */

let modelCache = {

    prediction:
        null,

    confidence:
        0,

    targetIssue:
        null,

    analysis:
        null,

    generatedAt:
        0
};


/* =====================================================
   NEXT ISSUE
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
   GENERATE MODEL
===================================================== */

function generateModel(wingo) {

    const numbers =
        wingo.history
            .map(
                x => x.number
            );


    /*
      API newest-first hoti hai,
      analysis chronological order me.
    */

    const chronological =
        [
            ...numbers
        ].reverse();


    const analysis =
        analyze(
            chronological
        );


    const targetIssue =
        getNextIssue(
            wingo.currentIssue ||
            wingo.history[0]?.issue
        );


    modelCache = {

        prediction:
            analysis.prediction,

        confidence:
            analysis.confidence,

        targetIssue,

        analysis,

        generatedAt:
            Date.now()
    };


    return modelCache;
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
            "25RULE-ANTI-STREAK-V2",
            Date.now()
        ]
    );
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


        await settlePredictions(
            wingo.history
        );


        const model =
            generateModel(
                wingo
            );


        await savePrediction(
            model
        );


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

            model,

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
                            JSON.parse(body)
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
   JSON RESPONSE
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
   STATIC FILES
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
        !fs.existsSync(filePath)
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


    /* MP3 RANGE */

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

                /* OPTIONS */

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
                                "25RULE-ANTI-STREAK-V2",

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


                    let predictions = [];


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
                        const prediction
                        of predictions
                    ) {

                        map.set(
                            String(
                                prediction.target_issue
                            ),
                            prediction
                        );
                    }


                    const merged =
                        live.map(
                            row => {

                                const prediction =
                                    map.get(
                                        String(
                                            row.issue
                                        )
                                    );


                                return {

                                    ...row,

                                    prediction:
                                        prediction
                                            ?.prediction ||
                                        null,

                                    confidence:
                                        prediction
                                            ?.confidence ||
                                        0,

                                    outcome:
                                        prediction
                                            ?.actual_result ||
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
                                    SELECT COUNT(*)::int AS count
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
                                "25RULE-ANTI-STREAK-V2"
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


                /* =================================================
                   ADMIN MODEL TEST

                   IMPORTANT:
                   Yahan bracket/syntax correct hai.
                ================================================= */

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


                /* ADMIN GET KEYS */

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
                            body.key || ""
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


                    const key =
                        String(
                            body.key || ""
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


                    const key =
                        String(
                            body.key || ""
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
   DATABASE INIT
===================================================== */

async function initDB() {

    if (!pool) {

        console.log(
            "DATABASE_URL not configured."
        );

        return;
    }


    await pool.query(
        `
        CREATE TABLE IF NOT EXISTS access_keys
        (
            id SERIAL PRIMARY KEY,
            access_key TEXT UNIQUE NOT NULL,
            device_id TEXT,
            created_at BIGINT NOT NULL,
            last_seen BIGINT DEFAULT 0
        );
        `
    );


    await pool.query(
        `
        CREATE TABLE IF NOT EXISTS prediction_records
        (
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
        `
    );


    console.log(
        "Database initialized."
    );
}


/* =====================================================
   START SERVER
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
                    "Model: 25RULE-ANTI-STREAK-V2"
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
