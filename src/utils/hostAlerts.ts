// Start/end tracking for a host resource alert (CPU, memory, disk). The start and
// end conditions differ, and each must hold for a number of consecutive polls, so a
// reading that hovers near the line is one episode instead of a stream of them.
export interface HostAlertTrackerOptions {
    // Which direction is bad: a high CPU pressure, a low free-memory ratio.
    worse: 'higher' | 'lower';
    // True while the reading is in the alert range / back out of it. They are not
    // each other's negation: the gap between them is the hysteresis band, where an
    // open alert stays open and a closed one stays closed.
    breached: (value: number) => boolean;
    cleared: (value: number) => boolean;
    // Consecutive polls the condition must hold before the alert starts / ends.
    startPolls: number;
    endPolls: number;
}

export interface HostAlertChange {
    change: 'started' | 'ended';
    // The reading furthest into the alert range since the breach began, and (on
    // 'ended') how many polls the alert was open.
    worst: number;
    polls: number;
}

export interface HostAlertTracker {
    readonly active: boolean;
    // Feeds one reading; returns the transition it caused, if any.
    update(value: number): HostAlertChange | null;
}

export function createHostAlertTracker(options: HostAlertTrackerOptions): HostAlertTracker {
    const further = (a: number, b: number): number =>
        options.worse === 'higher' ? Math.max(a, b) : Math.min(a, b);
    let active = false;
    let breachStreak = 0;
    let clearStreak = 0;
    let polls = 0;
    let worst = 0;
    return {
        get active() {
            return active;
        },
        update(value) {
            if (!active) {
                if (!options.breached(value)) {
                    breachStreak = 0;
                    return null;
                }
                worst = breachStreak === 0 ? value : further(worst, value);
                breachStreak++;
                if (breachStreak < options.startPolls) return null;
                active = true;
                breachStreak = 0;
                clearStreak = 0;
                polls = 0;
                return { change: 'started', worst, polls: 0 };
            }
            polls++;
            if (options.breached(value)) worst = further(worst, value);
            clearStreak = options.cleared(value) ? clearStreak + 1 : 0;
            if (clearStreak < options.endPolls) return null;
            active = false;
            clearStreak = 0;
            return { change: 'ended', worst, polls };
        },
    };
}
