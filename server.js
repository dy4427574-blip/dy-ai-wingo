"use strict";

/*
=========================================================
 DY AI WINGO 30S - SERVER
 25 RULE PATTERN + REVERSAL / ANTI-STREAK ENGINE
=========================================================

 A = SMALL (0-4)
 B = BIG   (5-9)

 IMPORTANT:
 - Historical pattern analysis only
 - No guaranteed prediction
 - Same-side prediction is penalized when streak
   becomes unusually persistent
 - No forced BIG/SMALL alternation
=========================================================
*/

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

const pool = DATABASE_URL
    ? new Pool({
        connectionString: DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    })
    : null;


/* =======================================================
   DATABASE
======================================================= */

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


/* =======================================================
   25 RULE PATTERN ENGINE
======================================================= */

const RULES = [
    { id: 1,  pattern: "ABABABABAB" },
    { id: 2,  pattern: "AABBAABB" },
    { id: 3,  pattern: "AAABBBAAABBB" },
    { id: 4,  pattern: "AAAABBBBAAAABBBB" },
    { id: 5,  pattern: "AABAABAAB" },
    { id: 6,  pattern: "AAAAAAAA BBBBBBBB" },
    { id: 7,  pattern: "ABBABBABB" },
    { id: 8,  pattern: "AAABAAABAAAB" },
    { id: 9,  pattern: "AAABBAAABB" },
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
    rule.pattern = rule.pattern.replace(/[^AB]/g, "");
}


/* =======================================================
   OPPOSITE PATTERN
======================================================= */

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
        pattern: oppositePattern(rule.pattern)
    });
}


/* =======================================================
   NUMBER -> A/B
======================================================= */

function numberToAB(number) {
    const n = Number(number);

    if (!Number.isInteger(n)) return null;
    if (n < 0 || n > 9) return null;

    return n <= 4 ? "A" : "B";
}

function abToType(ab) {
    if (ab === "A") return "SMALL";
    if (ab === "B") return "BIG";
    return null;
}


/* =======================================================
   CLEAN HISTORY
======================================================= */

function cleanNumbers(results) {
    if (!Array.isArray(results)) return [];

    return results
        .map(x => {
            if (typeof x === "object" && x !== null) {
                return Number(
                    x.number ??
                    x.actual_number ??
                    x.value
                );
            }

            return Number(x);
        })
        .filter(n =>
            Number.isInteger(n) &&
            n >= 0 &&
            n <= 9
        );
}

function convertHistory(results) {
    return cleanNumbers(results)
        .map(numberToAB)
        .filter(Boolean);
}


/* =======================================================
   BASIC STATS
======================================================= */

function countAB(history) {
    let A = 0;
    let B = 0;

    for (const x of history) {
        if (x === "A") A++;
        if (x === "B") B++;
    }

    const total = A + B;

    return {
        A,
        B,
        total,
        APercent: total ? +(A / total * 100).toFixed(2) : 0,
        BPercent: total ? +(B / total * 100).toFixed(2) : 0
    };
}


/* =======================================================
   STREAK
======================================================= */

function currentStreak(history) {
    if (!history.length) {
        return {
            side: null,
            length: 0
        };
    }

    const side = history[history.length - 1];
    let length = 0;

    for (let i = history.length - 1; i >= 0; i--) {
        if (history[i] !== side) break;
        length++;
    }

    return {
        side,
        length
    };
}


function longestStreak(history, side) {
    let current = 0;
    let longest = 0;

    for (const x of history) {
        if (x === side) {
            current++;
            longest = Math.max(longest, current);
        } else {
            current = 0;
        }
    }

    return longest;
}


function allRuns(history) {
    const runs = [];

    if (!history.length) return runs;

    let side = history[0];
    let length = 1;

    for (let i = 1; i < history.length; i++) {
        if (history[i] === side) {
            length++;
        } else {
            runs.push({ side, length });

            side = history[i];
            length = 1;
        }
    }

    runs.push({ side, length });

    return runs;
}


/* =======================================================
   SWITCHING
======================================================= */

function switchRate(history) {
    if (history.length < 2) {
        return {
            switches: 0,
            rate: 0
        };
    }

    let switches = 0;

    for (let i = 1; i < history.length; i++) {
        if (history[i] !== history[i - 1]) {
            switches++;
        }
    }

    return {
        switches,
        rate: +(switches / (history.length - 1) * 100).toFixed(2)
    };
}


/* =======================================================
   ALTERNATION
======================================================= */

function alternationInfo(history) {
    if (history.length < 2) {
        return {
            length: 0,
            active: false,
            broken: false
        };
    }

    let len = 1;

    for (let i = history.length - 1; i > 0; i--) {
        if (history[i] === history[i - 1]) break;
        len++;
    }

    const active = len >= 4;

    return {
        length: len,
        active,
        broken: !active && len > 1
    };
}


/* =======================================================
   SUFFIX MATCH
======================================================= */

function suffixMatch(history, pattern) {
    const maxLength = Math.min(
        history.length,
        pattern.length
    );

    let best = 0;

    for (let len = 1; len <= maxLength; len++) {
        const h = history
            .slice(history.length - len)
            .join("");

        const p = pattern
            .slice(0, len);

        if (h === p) {
            best = len;
        }
    }

    return best;
}


/* =======================================================
   25 RULE MATCH
======================================================= */

function findRules(history) {
    const matches = [];

    for (const item of PATTERN_LIBRARY) {
        const matched = suffixMatch(
            history,
            item.pattern
        );

        /*
         IMPORTANT FIX:
         2-3 character matches are too common.
         They are kept only as weak evidence.
        */

        if (matched >= 2) {
            let next = null;

            if (matched < item.pattern.length) {
                next = item.pattern[matched];
            }

            matches.push({
                rule: item.rule,
                type: item.type,
                pattern: item.pattern,
                matched,
                next
            });
        }
    }

    return matches;
}


/* =======================================================
   RULE WEIGHT
======================================================= */

function ruleWeight(matched) {

    if (matched >= 12) return 14;
    if (matched >= 10) return 12;
    if (matched >= 8) return 10;
    if (matched >= 7) return 8;
    if (matched >= 6) return 7;
    if (matched >= 5) return 6;
    if (matched >= 4) return 3;

    /*
      2-3 match:
      VERY LOW weight.
      This prevents random short matches
      from controlling prediction.
    */

    if (matched >= 3) return 1;

    return 0.25;
}


/* =======================================================
   RULE SUPPORT
======================================================= */

function calculateRuleSupport(matches) {

    let A = 0;
    let B = 0;

    const evidence = [];

    for (const match of matches) {

        if (!match.next) continue;

        const weight = ruleWeight(match.matched);

        if (match.next === "A") A += weight;
        if (match.next === "B") B += weight;

        evidence.push({
            rule: match.rule,
            matched: match.matched,
            expectedNext: match.next,
            weight: +weight.toFixed(2),
            type: match.type
        });
    }

    const total = A + B;

    return {
        A: +A.toFixed(2),
        B: +B.toFixed(2),
        total: +total.toFixed(2),
        APercent: total
            ? +(A / total * 100).toFixed(2)
            : 0,
        BPercent: total
            ? +(B / total * 100).toFixed(2)
            : 0,
        evidence
    };
}


/* =======================================================
   HISTORICAL NEXT-EVENT EVIDENCE

   THIS IS THE MAIN FIX.

   Pattern ko sirf dekh kar next assume nahi karenge.
   History me same pattern/prefix pehle kab aaya tha,
   uske baad actual me A/B kya aaya tha,
   wo check hoga.
======================================================= */

function historicalNextEvidence(history, pattern) {

    let A = 0;
    let B = 0;
    let occurrences = 0;

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

    /*
      Full pattern ko search karenge.
      Prefix/suffix ko historical occurrences ke
      saath compare karenge.
    */

    for (let i = 0; i <= history.length - pattern.length - 1; i++) {

        let same = true;

        for (let j = 0; j < pattern.length; j++) {
            if (history[i + j] !== pattern[j]) {
                same = false;
                break;
            }
        }

        if (!same) continue;

        const next = history[i + pattern.length];

        occurrences++;

        if (next === "A") A++;
        if (next === "B") B++;
    }

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
            : 0,
        occurrences
    };
}


/* =======================================================
   PARTIAL HISTORICAL EVIDENCE

   Current ending ke last 5-8 symbols ko search karta hai.
======================================================= */

function partialHistoricalEvidence(history) {

    const candidates = [];

    const maxLen = Math.min(8, history.length);

    for (let len = maxLen; len >= 4; len--) {

        const suffix = history
            .slice(history.length - len)
            .join("");

        let A = 0;
        let B = 0;
        let occurrences = 0;

        for (
            let i = 0;
            i <= history.length - len - 1;
            i++
        ) {

            const part = history
                .slice(i, i + len)
                .join("");

            if (part !== suffix) continue;

            const next = history[i + len];

            occurrences++;

            if (next === "A") A++;
            if (next === "B") B++;
        }

        if (occurrences > 0) {
            candidates.push({
                length: len,
                pattern: suffix,
                A,
                B,
                occurrences,
                APercent: +(A / occurrences * 100).toFixed(2),
                BPercent: +(B / occurrences * 100).toFixed(2)
            });
        }
    }

    /*
      Longest reliable historical match gets priority.
    */

    candidates.sort((a, b) => {
        if (b.length !== a.length) {
            return b.length - a.length;
        }

        return b.occurrences - a.occurrences;
    });

    return candidates;
}


/* =======================================================
   MOMENTUM
======================================================= */

function momentum(history) {

    if (history.length < 20) {
        return {
            recent: null,
            previous: null,
            shift: "LOW_DATA"
        };
    }

    const recent = history.slice(-10);
    const previous = history.slice(-20, -10);

    const r = countAB(recent);
    const p = countAB(previous);

    const recentBias =
        r.BPercent - r.APercent;

    const previousBias =
        p.BPercent - p.APercent;

    const shift =
        recentBias - previousBias;

    let classification = "STABLE";

    if (shift >= 20) {
        classification = "TOWARD_BIG";
    } else if (shift <= -20) {
        classification = "TOWARD_SMALL";
    } else if (Math.abs(shift) >= 10) {
        classification = "SHIFTING";
    }

    return {
        recent: r,
        previous: p,
        shift: +shift.toFixed(2),
        classification
    };
}


/* =======================================================
   TRANSITION MATRIX
======================================================= */

function transitionMatrix(history) {

    const matrix = {
        AA: 0,
        AB: 0,
        BA: 0,
        BB: 0
    };

    for (let i = 1; i < history.length; i++) {

        const pair =
            history[i - 1] +
            history[i];

        if (matrix[pair] !== undefined) {
            matrix[pair]++;
        }
    }

    const afterA =
        matrix.AA + matrix.AB;

    const afterB =
        matrix.BA + matrix.BB;

    return {
        matrix,

        afterA: {
            same: afterA
                ? +(matrix.AA / afterA * 100).toFixed(2)
                : 0,
            switch: afterA
                ? +(matrix.AB / afterA * 100).toFixed(2)
                : 0
        },

        afterB: {
            switch: afterB
                ? +(matrix.BA / afterB * 100).toFixed(2)
                : 0,
            same: afterB
                ? +(matrix.BB / afterB * 100).toFixed(2)
                : 0
        }
    };
}


/* =======================================================
   RECENT TRANSITION MATRIX
======================================================= */

function recentTransition(history) {

    return transitionMatrix(
        history.slice(-20)
    );
}


/* =======================================================
   RUN PATTERN ANALYSIS
======================================================= */

function runAnalysis(history) {

    const runs = allRuns(history);

    const lengths = runs.map(x => x.length);

    const avg = lengths.length
        ? lengths.reduce((a, b) => a + b, 0) /
          lengths.length
        : 0;

    const sorted = [...lengths].sort((a, b) => a - b);

    let median = 0;

    if (sorted.length) {
        const mid = Math.floor(sorted.length / 2);

        median =
            sorted.length % 2
                ? sorted[mid]
                : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    const freq = {};

    for (const n of lengths) {
        freq[n] = (freq[n] || 0) + 1;
    }

    let mostCommon = null;

    for (const key of Object.keys(freq)) {
        if (
            mostCommon === null ||
            freq[key] > freq[mostCommon]
        ) {
            mostCommon = key;
        }
    }

    return {
        runs,
        average: +avg.toFixed(2),
        median: +median.toFixed(2),
        longest: lengths.length
            ? Math.max(...lengths)
            : 0,
        mostCommon: mostCommon
            ? Number(mostCommon)
            : 0
    };
}


/* =======================================================
   REPEATING BLOCKS
======================================================= */

function repeatingBlocks(history) {

    const output = [];

    for (let len = 2; len <= 6; len++) {

        if (history.length < len * 3) continue;

        const block = history
            .slice(-len)
            .join("");

        let count = 0;

        for (
            let i = history.length - len;
            i >= 0;
            i -= len
        ) {

            const part = history
                .slice(i, i + len)
                .join("");

            if (part === block) {
                count++;
            } else {
                break;
            }
        }

        if (count >= 2) {
            output.push({
                length: len,
                block,
                repeats: count
            });
        }
    }

    return output;
}


/* =======================================================
   DIGIT ANALYSIS
======================================================= */

function digitAnalysis(numbers) {

    const freq = Array(10).fill(0);

    for (const n of numbers) {
        if (Number.isInteger(n)) {
            freq[n]++;
        }
    }

    const total = numbers.length;

    let repeatedLast = false;

    if (numbers.length >= 2) {
        repeatedLast =
            numbers[numbers.length - 1] ===
            numbers[numbers.length - 2];
    }

    return {
        frequency: freq,
        repeatedLast,
        average: total
            ? +(
                numbers.reduce((a, b) => a + b, 0) /
                total
            ).toFixed(2)
            : 0
    };
}


/* =======================================================
   STREAK REVERSAL ENGINE

   MAIN ANTI-STREAK FIX.
======================================================= */

function reversalEngine(history) {

    const current = currentStreak(history);
    const runs = runAnalysis(history);

    const result = {
        currentSide: current.side,
        currentLength: current.length,
        scoreA: 0,
        scoreB: 0,
        reasons: [],
        watch: false,
        strength: "NONE"
    };

    if (!current.side || current.length < 3) {
        return result;
    }

    const opposite =
        current.side === "A"
            ? "B"
            : "A";

    /*
      R1: Current streak unusually long
    */

    if (
        current.length >= 5 &&
        current.length > runs.median + 1
    ) {

        if (opposite === "A") {
            result.scoreA += 2;
        } else {
            result.scoreB += 2;
        }

        result.reasons.push(
            "Current streak is longer than recent typical run."
        );
    }

    /*
      R2: Very long streak
    */

    if (current.length >= 6) {

        if (opposite === "A") {
            result.scoreA += 3;
        } else {
            result.scoreB += 3;
        }

        result.reasons.push(
            "Extended same-side streak detected."
        );
    }

    /*
      R3: Recent transition switch tendency
    */

    const recent = recentTransition(history);

    if (current.side === "A") {

        if (recent.afterA.switch >= 55) {
            result.scoreB += 2;

            result.reasons.push(
                "Recent history often switches after SMALL."
            );
        }

    } else {

        if (recent.afterB.switch >= 55) {
            result.scoreA += 2;

            result.reasons.push(
                "Recent history often switches after BIG."
            );
        }
    }

    /*
      R4: Alternation / switching tendency
    */

    const sw = switchRate(
        history.slice(-20)
    );

    if (sw.rate >= 60) {

        if (opposite === "A") {
            result.scoreA += 1;
        } else {
            result.scoreB += 1;
        }

        result.reasons.push(
            "Recent switching regime supports opposite-side watch."
        );
    }

    /*
      R5: Current streak reaches unusual zone
    */

    if (
        current.length >= 4 &&
        current.length >= runs.longest - 1
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

    /*
      R6: Cooldown-style protection.
      Never allow reversal score to grow infinitely.
    */

    result.scoreA =
        Math.min(8, result.scoreA);

    result.scoreB =
        Math.min(8, result.scoreB);

    const maxScore =
        Math.max(
            result.scoreA,
            result.scoreB
        );

    if (maxScore >= 4) {
        result.watch = true;
        result.strength =
            maxScore >= 6
                ? "STRONG"
                : "MODERATE";
    }

    return result;
}


/* =======================================================
   FAILED REVERSAL DETECTOR
======================================================= */

function failedReversal(history) {

    if (history.length < 8) {
        return {
            detected: false,
            reason: ""
        };
    }

    const current = currentStreak(history);

    /*
      If last attempted switch immediately failed
      and same side continued, don't repeatedly
      call reversal on every next period.
    */

    const last8 = history.slice(-8);

    const runs = allRuns(last8);

    if (runs.length < 3) {
        return {
            detected: false,
            reason: ""
        };
    }

    const last = runs[runs.length - 1];
    const prev = runs[runs.length - 2];

    if (
        prev.length === 1 &&
        last.length >= 2 &&
        last.side === current.side
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


/* =======================================================
   ANTI-STREAK SCORE

   Ye decide karta hai ki model ko same side
   repeat karne se pehle kitna caution rakhna hai.
======================================================= */

function antiStreakAdjustment(
    history,
    candidate
) {

    const current =
        currentStreak(history);

    if (!current.side) return 0;

    let penalty = 0;

    /*
      Candidate same as current streak:
      long streak -> penalty
    */

    if (candidate === current.side) {

        if (current.length >= 7) {
            penalty = 7;
        } else if (current.length >= 6) {
            penalty = 5;
        } else if (current.length >= 5) {
            penalty = 3;
        } else if (current.length >= 4) {
            penalty = 1.5;
        }
    }

    /*
      Candidate opposite:
      only small bonus.
      This prevents forced reversal.
    */

    if (
        candidate !== current.side &&
        current.length >= 5
    ) {
        penalty = -1.5;
    }

    return penalty;
}


/* =======================================================
   CONFIDENCE
======================================================= */

function calculateConfidence(
    scoreA,
    scoreB,
    historyLength
) {

    const total =
        Math.abs(scoreA) +
        Math.abs(scoreB);

    if (!total) return 0;

    let confidence =
        Math.abs(scoreA - scoreB) /
        total *
        100;

    /*
      Sample size penalty.
    */

    if (historyLength < 10) {
        confidence *= 0.55;
    } else if (historyLength < 20) {
        confidence *= 0.75;
    } else if (historyLength < 30) {
        confidence *= 0.88;
    }

    return Math.max(
        0,
        Math.min(
            95,
            Math.round(confidence)
        )
    );
}


/* =======================================================
   MAIN ANALYSIS
======================================================= */

function analyze(results) {

    const numbers = cleanNumbers(results);
    const history = numbers
        .map(numberToAB)
        .filter(Boolean);

    if (history.length < 3) {
        return {
            status: "INSUFFICIENT DATA",
            prediction: null,
            confidence: 0,
            message:
                "More historical results required."
        };
    }

    const stats = countAB(history);

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
        recentTransition(history);

    const digits =
        digitAnalysis(numbers);

    const matches =
        findRules(history);

    const ruleSupport =
        calculateRuleSupport(matches);

    const reversal =
        reversalEngine(history);

    const failed =
        failedReversal(history);

    const historicalPatterns =
        partialHistoricalEvidence(history);


    /* ===================================================
       SCORE
    =================================================== */

    let scoreA = 0;
    let scoreB = 0;


    /* -----------------------------------------------
       1. 25 RULE SUPPORT
    ------------------------------------------------ */

    scoreA += ruleSupport.A * 1.00;
    scoreB += ruleSupport.B * 1.00;


    /* -----------------------------------------------
       2. HISTORICAL ACTUAL NEXT EVIDENCE
    ------------------------------------------------ */

    let historicalA = 0;
    let historicalB = 0;

    if (historicalPatterns.length) {

        /*
          Only strongest useful match.
        */

        const best =
            historicalPatterns[0];

        const evidenceWeight =
            Math.min(
                8,
                best.length
            );

        historicalA =
            best.A *
            evidenceWeight;

        historicalB =
            best.B *
            evidenceWeight;

        scoreA += historicalA;
        scoreB += historicalB;
    }


    /* -----------------------------------------------
       3. TRANSITION
    ------------------------------------------------ */

    if (streak.side === "A") {

        scoreA +=
            recentTransitions.afterA.same *
            0.04;

        scoreB +=
            recentTransitions.afterA.switch *
            0.04;

    } else {

        scoreA +=
            recentTransitions.afterB.switch *
            0.04;

        scoreB +=
            recentTransitions.afterB.same *
            0.04;
    }


    /* -----------------------------------------------
       4. MOMENTUM
    ------------------------------------------------ */

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


    /* -----------------------------------------------
       5. SWITCHING
    ------------------------------------------------ */

    if (switching.rate >= 60) {

        /*
          High switching -> opposite side
          gets a modest support.
        */

        if (streak.side === "A") {
            scoreB += 2;
        } else {
            scoreA += 2;
        }

    } else if (switching.rate < 40) {

        /*
          Streak-dominant regime:
          do NOT automatically reverse.
          Current side gets only a modest continuation
          support.
        */

        if (streak.side === "A") {
            scoreA += 1;
        } else {
            scoreB += 1;
        }
    }


    /* -----------------------------------------------
       6. REVERSAL ENGINE
    ------------------------------------------------ */

    scoreA += reversal.scoreA * 1.5;
    scoreB += reversal.scoreB * 1.5;


    /* -----------------------------------------------
       7. FAILED REVERSAL PROTECTION
    ------------------------------------------------ */

    if (failed.detected) {

        /*
          Failed reversal means don't repeatedly
          flip just because a reversal was expected.
        */

        if (streak.side === "A") {
            scoreA += 2;
        } else {
            scoreB += 2;
        }
    }


    /* -----------------------------------------------
       8. ANTI-STREAK
    ------------------------------------------------ */

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


    /* -----------------------------------------------
       9. CURRENT FREQUENCY
    ------------------------------------------------ */

    if (stats.total >= 20) {

        const diff =
            stats.APercent -
            stats.BPercent;

        /*
          Frequency is intentionally low weight.
          It should never dominate alone.
        */

        scoreA += diff * 0.03;
        scoreB -= diff * 0.03;
    }


    /* =================================================
       FINAL DECISION
    ================================================= */

    scoreA = +Math.max(0, scoreA).toFixed(2);
    scoreB = +Math.max(0, scoreB).toFixed(2);

    const difference =
        Math.abs(scoreA - scoreB);

    const scoreTotal =
        scoreA + scoreB;

    let prediction = null;

    /*
      IMPORTANT:
      Very small difference = NO CLEAR SIGNAL.
      This prevents random flip/flop.
    */

    if (
        scoreTotal > 0 &&
        difference >= Math.max(
            2.5,
            scoreTotal * 0.10
        )
    ) {

        prediction =
            scoreA > scoreB
                ? "SMALL"
                : "BIG";
    }


    /*
      Special anti-streak rule:
      If same side has been repeating and
      opposite has strong multi-source evidence,
      don't allow old same-side bias to continue forever.
    */

    if (
        prediction === streak.side &&
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

        const strongOpposite =
            oppositeScore >
            sameScore * 0.90 &&
            (
                reversal.watch ||
                historicalPatterns.some(
                    x =>
                        x.length >= 5 &&
                        (
                            x.BPercent >= 65 ||
                            x.APercent >= 65
                        )
                )
            );

        if (strongOpposite) {

            prediction =
                opposite === "A"
                    ? "SMALL"
                    : "BIG";
        }
    }


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

    if (history.length < 10) {
        classification =
            "INSUFFICIENT DATA";
    } else if (!prediction) {
        classification =
            "MIXED / CONFLICTING";
    } else if (
        failed.detected &&
        prediction === abToType(streak.side)
    ) {
        classification =
            "FAILED REVERSAL";
    } else if (
        reversal.watch &&
        prediction !== abToType(streak.side)
    ) {
        classification =
            "REVERSAL WATCH";
    } else if (confidence >= 75) {
        classification =
            "STRONG HISTORICAL BIAS";
    } else if (confidence >= 55) {
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

        thinkingDurationMs:
            THINKING_DURATION_MS,

        current:
            abToType(streak.side),

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
            A: ruleSupport.A,
            B: ruleSupport.B,
            APercent: ruleSupport.APercent,
            BPercent: ruleSupport.BPercent
        },

        historicalNextEvidence:
            historicalPatterns.slice(0, 5),

        reversal,

        failedReversal:
            failed,

        score: {
            SMALL: scoreA,
            BIG: scoreB,
            difference:
                +difference.toFixed(2)
        },

        message:
            "Historical pattern analysis only. No future result is guaranteed."
    };
}


/* =======================================================
   WINGOBOT API
======================================================= */

async function fetchWingoHistory() {

    if (!WINGOBOT_TOKEN) {
        throw new Error(
            "WINGOBOT_TOKEN not configured"
        );
    }

    const response =
        await fetch(WINGOBOT_URL, {
            method: "GET",
            headers: {
                "Authorization":
                    `Bearer ${WINGOBOT_TOKEN}`,
                "Accept":
                    "application/json"
            }
        });

    if (!response.ok) {
        throw new Error(
            `WingoBot HTTP ${response.status}`
        );
    }

    const data =
        await response.json();

    return data;
}


/* =======================================================
   NORMALIZE WINGO RESPONSE
======================================================= */

function normalizeWingo(data) {

    const rows =
        Array.isArray(data?.history)
            ? data.history
            : Array.isArray(data?.data)
                ? data.data
                : Array.isArray(data?.results)
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
                    !Number.isInteger(number) ||
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
                            numberToAB(number)
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

    const currentIssue =
        String(
            data?.current?.issueNumber ??
            data?.current?.issue ??
            history[0]?.issue ??
            ""
        );

    return {
        currentIssue,
        history,
        fetched:
            data?.stats?.fetched ??
            history.length,

        lastUpdated:
            data?.stats?.last_updated ??
            Date.now()
    };
}


/* =======================================================
   MODEL CACHE
======================================================= */

let modelCache = {
    prediction: null,
    confidence: 0,
    targetIssue: null,
    analysis: null,
    generatedAt: 0
};


/* =======================================================
   NEXT ISSUE
======================================================= */

function getNextIssue(issue) {

    if (!issue) return null;

    const match =
        String(issue).match(/\d+/);

    if (!match) return null;

    const prefix =
        String(issue).slice(
            0,
            match.index
        );

    const number =
        BigInt(match[0]);

    return (
        prefix +
        String(number + 1n)
    );
}


/* =======================================================
   GENERATE MODEL
======================================================= */

function generateModel(wingo) {

    const numbers =
        wingo.history
            .map(x => x.number);

    /*
      Wingo history usually comes newest first.
      Analysis requires chronological order.
    */

    const chronological =
        [...numbers].reverse();

    const analysis =
        analyze(chronological);

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


/* =======================================================
   SETTLE PREDICTIONS
======================================================= */

async function settlePredictions(history) {

    if (!pool) return;

    for (const row of history) {

        if (!row.issue) continue;

        const actualType =
            row.type;

        if (!actualType) continue;

        await pool.query(
            `
            UPDATE prediction_records
            SET
                actual_number = $1,
                actual_result = CASE
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
                actualType,
                Date.now(),
                row.issue
            ]
        );
    }
}


/* =======================================================
   SAVE PREDICTION
======================================================= */

async function savePrediction(model) {

    if (!pool) return;

    if (!model.prediction) return;

    if (!model.targetIssue) return;

    /*
      Don't insert same target twice.
    */

    const existing =
        await pool.query(
            `
            SELECT id
            FROM prediction_records
            WHERE target_issue = $1
            LIMIT 1
            `,
            [model.targetIssue]
        );

    if (existing.rows.length) return;

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
            model.targetIssue,
            model.prediction,
            model.confidence,
            "25RULE-ANTI-STREAK-V2",
            Date.now()
        ]
    );
}


/* =======================================================
   LOAD LIVE STATE
======================================================= */

async function getLiveState() {

    try {

        const raw =
            await fetchWingoHistory();

        const wingo =
            normalizeWingo(raw);

        await settlePredictions(
            wingo.history
        );

        /*
          Always regenerate model
          from latest history.
        */

        const model =
            generateModel(wingo);

        await savePrediction(model);

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


/* =======================================================
   AUTH HELPERS
======================================================= */

function header(req, name) {

    return (
        req.headers[name.toLowerCase()] ||
        ""
    );
}

function adminAuthorized(req) {

    return (
        header(req, "x-admin-key") ===
        ADMIN_KEY
    );
}

async function keyAuthorized(req) {

    if (!pool) return false;

    const accessKey =
        header(req, "x-access-key");

    const deviceId =
        header(req, "x-device-id");

    if (!accessKey || !deviceId) {
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
            [accessKey]
        );

    if (!result.rows.length) {
        return false;
    }

    const row =
        result.rows[0];

    /*
      One access key -> one browser device.
    */

    if (
        row.device_id &&
        row.device_id !== deviceId
    ) {
        return false;
    }

    if (!row.device_id) {

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
                Date.now(),
                row.id
            ]
        );

    } else {

        await pool.query(
            `
            UPDATE access_keys
            SET last_seen = $1
            WHERE id = $2
            `,
            [
                Date.now(),
                row.id
            ]
        );
    }

    return true;
}


/* =======================================================
   BODY PARSER
======================================================= */

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


/* =======================================================
   JSON RESPONSE
======================================================= */

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


/* =======================================================
   STATIC FILE
======================================================= */

function serveStatic(
    req,
    res,
    pathname
) {

    let fileName;

    if (
        pathname === "/" ||
        pathname === "/prediction"
    ) {
        fileName =
            "prediction.html";

    } else if (
        pathname === "/admin"
    ) {
        fileName =
            "admin.html";

    } else if (
        pathname === "/prediction.html"
    ) {
        fileName =
            "prediction.html";

    } else if (
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

    if (!fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end("File not found");
        return;
    }

    const stat =
        fs.statSync(filePath);

    const ext =
        path.extname(filePath)
            .toLowerCase();

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

    const contentType =
        contentTypes[ext] ||
        "application/octet-stream";


    /*
      MP3 Range support.
    */

    if (ext === ".mp3") {

        const range =
            req.headers.range;

        if (range) {

            const match =
                range.match(
                    /bytes=(\d*)-(\d*)/
                );

            if (match) {

                const start =
                    Number(match[1] || 0);

                const end =
                    Number(
                        match[2] ||
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
                                contentType,

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
    }


    res.writeHead(
        200,
        {
            "Content-Type":
                contentType,

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


/* =======================================================
   SERVER
======================================================= */

const server =
    http.createServer(
        async (req, res) => {

            try {

                if (
                    req.method === "OPTIONS"
                ) {
                    sendJSON(
                        res,
                        204,
                        {}
                    );
                    return;
                }

                const url =
                    new URL(
                        req.url,
                        `http://${req.headers.host}`
                    );

                const pathname =
                    url.pathname;


                /* =========================================
                   HEALTH
                ========================================= */

                if (
                    pathname === "/health"
                ) {

                    sendJSON(
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

                    return;
                }


                /* =========================================
                   KEY CHECK
                ========================================= */

                if (
                    pathname === "/api/key/check" &&
                    req.method === "GET"
                ) {

                    const valid =
                        await keyAuthorized(req);

                    sendJSON(
                        res,
                        200,
                        {
                            ok: true,
                            valid
                        }
                    );

                    return;
                }


                /* =========================================
                   STATE
                ========================================= */

                if (
                    pathname === "/api/state" &&
                    req.method === "GET"
                ) {

                    const valid =
                        await keyAuthorized(req);

                    if (!valid) {

                        sendJSON(
                            res,
                            401,
                            {
                                ok: false,
                                error:
                                    "Invalid access key or device."
                            }
                        );

                        return;
                    }

                    const state =
                        await getLiveState();

                    sendJSON(
                        res,
                        200,
                        state
                    );

                    return;
                }


                /* =========================================
                   HISTORY
                ========================================= */

                if (
                    pathname === "/api/history" &&
                    req.method === "GET"
                ) {

                    const valid =
                        await keyAuthorized(req);

                    if (!valid) {

                        sendJSON(
                            res,
                            401,
                            {
                                ok: false,
                                error:
                                    "Unauthorized"
                            }
                        );

                        return;
                    }

                    let live = [];

                    try {

                        const raw =
                            await fetchWingoHistory();

                        const wingo =
                            normalizeWingo(raw);

                        live =
                            wingo.history;

                    } catch {}

                    let predictions = [];

                    if (pool) {

                        const result =
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
                            );

                        predictions =
                            result.rows;
                    }

                    const map =
                        new Map();

                    for (const p of predictions) {
                        map.set(
                            String(p.target_issue),
                            p
                        );
                    }

                    const merged =
                        live.map(row => {

                            const p =
                                map.get(
                                    String(row.issue)
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
                        });

                    sendJSON(
                        res,
                        200,
                        {
                            ok: true,
                            history:
                                merged
                        }
                    );

                    return;
                }


                /* =========================================
                   ADMIN STATUS
                ========================================= */

                if (
                    pathname === "/api/admin/status" &&
                    req.method === "GET"
                ) {

                    if (!adminAuthorized(req)) {

                        sendJSON(
                            res,
                            401,
                            {
                                ok: false
                            }
                        );

                        return;
                    }

                    const state =
                        await getLiveState();

                    let keys = 0;

                    if (pool) {

                        const result =
                            await pool.query(
                                `
                                SELECT COUNT(*)::int AS count
                                FROM access_keys
                                `
                            );

                        keys =
                            result.rows[0].count;
                    }

                    sendJSON(
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

                    return;
                }


                /* =========================================
                   ADMIN PING
                ========================================= */

                if (
                    pathname === "/api/admin/ping" &&
                    req.method === "GET"
                ) {

                    if (!adminAuthorized(req)) {

                        sendJSON(
                            res,
                            401,
                            {
                                ok: false
                            }
                        );

                        return;
                    }

                    sendJSON(
                        res,
                        200,
                        {
                            ok: true,
                            time: Date.now(),
                            model:
                                "25RULE-ANTI-STREAK-V2"
                        }
                    );

                    return;
                }


                /* =========================================
                   ADMIN WINGO TEST
                ========================================= */

                if (
                    pathname === "/api/admin/wingo-test" &&
                    req.method === "GET"
                ) {

                    if (!adminAuthorized(req)) {

                        sendJSON(
                            res,
                            401,
                            {
                                ok: false
                            }
                        );

                        return;
                    }

                    try {

                        const raw =
                            await fetchWingoHistory();

                        const normalized =
                            normalizeWingo(raw);

                        sendJSON(
                            res,
                            200,
                            {
                                ok: true,

                                currentIssue:
                                    normalized.currentIssue,

                                count:
                                    normalized.history.length,

                                sample:
                                    normalized.history.slice(
                                        0,
                                        10
                                    )
                            }
                        );

                    } catch (error) {

                        sendJSON(
                            res,
                            500,
                            {
                                ok: false,
                                error:
                                    error.message
                            }
                        );
                    }

                    return;
                }


                /* =========================================
                   ADMIN MODEL TEST
                ========================================= */

                if (
                    pathname === "/api/admin/model-test" &&
                    req.method === "GET"
                {

                    if (!adminAuthorized(req)) {

                        sendJSON(
                            res,
                            401,
                            {
                                ok: false
                            }
                        );

                        return;
                    }

                    const state =
                        await getLiveState();

                    sendJSON(
                        res,
                        200,
                        {
                            ok: true,

                            model:
                                state.model
                        }
                    );

                    return;
                }


                /* =========================================
                   ADMIN KEYS GET
                ========================================= */

                if (
                    pathname === "/api/admin/keys" &&
                    req.method === "GET"
                ) {

                    if (!adminAuthorized(req)) {

                        sendJSON(
                            res,
                            401,
                            {
                                ok: false
                            }
                        );

                        return;
                    }

                    if (!pool) {

                        sendJSON(
                            res,
                            200,
                            {
                                ok: true,
                                keys: []
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

                    return;
                }


                /* =========================================
                   ADMIN CREATE KEY
                ========================================= */

                if (
                    pathname === "/api/admin/keys" &&
                    req.method === "POST"
                ) {

                    if (!adminAuthorized(req)) {

                        sendJSON(
                            res,
                            401,
                            {
                                ok: false
                            }
                        );

                        return;
                    }

                    if (!pool) {

                        sendJSON(
                            res,
                            500,
                            {
                                ok: false,
                                error:
                                    "Database unavailable"
                            }
                        );

                        return;
                    }

                    const body =
                        await readBody(req);

                    const requested =
                        String(
                            body.key ||
                            ""
                        ).trim();

                    const accessKey =
                        requested ||
                        crypto
                            .randomBytes(12)
                            .toString("hex");

                    await pool.query(
                        `
                        INSERT INTO access_keys
                        (
                            access_key,
                            created_at
                        )
                        VALUES ($1,$2)
                        ON CONFLICT (access_key)
                        DO NOTHING
                        `,
                        [
                            accessKey,
                            Date.now()
                        ]
                    );

                    sendJSON(
                        res,
                        200,
                        {
                            ok: true,
                            key:
                                accessKey
                        }
                    );

                    return;
                }


                /* =========================================
                   ADMIN DELETE KEY
                ========================================= */

                if (
                    pathname === "/api/admin/keys" &&
                    req.method === "DELETE"
                ) {

                    if (!adminAuthorized(req)) {

                        sendJSON(
                            res,
                            401,
                            {
                                ok: false
                            }
                        );

                        return;
                    }

                    if (!pool) {

                        sendJSON(
                            res,
                            500,
                            {
                                ok: false
                            }
                        );

                        return;
                    }

                    const body =
                        await readBody(req);

                    const key =
                        String(
                            body.key ||
                            ""
                        ).trim();

                    if (!key) {

                        sendJSON(
                            res,
                            400,
                            {
                                ok: false,
                                error:
                                    "Key required"
                            }
                        );

                        return;
                    }

                    await pool.query(
                        `
                        DELETE FROM access_keys
                        WHERE access_key = $1
                        `,
                        [key]
                    );

                    sendJSON(
                        res,
                        200,
                        {
                            ok: true
                        }
                    );

                    return;
                }


                /* =========================================
                   RESET DEVICE
                ========================================= */

                if (
                    pathname === "/api/admin/reset-device" &&
                    req.method === "POST"
                ) {

                    if (!adminAuthorized(req)) {

                        sendJSON(
                            res,
                            401,
                            {
                                ok: false
                            }
                        );

                        return;
                    }

                    if (!pool) {

                        sendJSON(
                            res,
                            500,
                            {
                                ok: false
                            }
                        );

                        return;
                    }

                    const body =
                        await readBody(req);

                    const key =
                        String(
                            body.key ||
                            ""
                        ).trim();

                    if (!key) {

                        sendJSON(
                            res,
                            400,
                            {
                                ok: false,
                                error:
                                    "Key required"
                            }
                        );

                        return;
                    }

                    await pool.query(
                        `
                        UPDATE access_keys
                        SET device_id = NULL
                        WHERE access_key = $1
                        `,
                        [key]
                    );

                    sendJSON(
                        res,
                        200,
                        {
                            ok: true
                        }
                    );

                    return;
                }


                /* =========================================
                   STATIC
                ========================================= */

                if (
                    req.method === "GET"
                ) {
                    serveStatic(
                        req,
                        res,
                        pathname
                    );

                    return;
                }


                res.writeHead(
                    404
                );

                res.end(
                    "Not Found"
                );

            } catch (error) {

                console.error(
                    "Server error:",
                    error
                );

                sendJSON(
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


/* =======================================================
   START
======================================================= */

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
