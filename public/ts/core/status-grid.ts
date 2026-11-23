import type { ActivityEvent, PipelineGroup, PipelineView, RejectedPublish } from '../types.js';
import type { InputStatus, OutStatus, StatusIssue } from './status.js';
import { adviceByOutput } from './output-advice.js';
import { isProblem, pipelineProblems, type StatusTally } from './problems.js';

// The Status view: one card per pipeline with a dot for every output. Pure functions that
// turn the dashboard's state into what the view draws, so the DOM code stays thin.

export interface StatusDot {
    id: string;
    name: string;
    status: OutStatus;
    // The first thing wrong with it, or '': a problem with its status, else its current error.
    message: string;
    // Everything wrong with it, for the tooltip (empty when nothing is).
    issues: StatusIssue[];
    // The advice about it: the dot gets a yellow outline and the tooltip lists these. Not a
    // problem, so no status, count or filter changes.
    notices: string[];
}

export interface StatusCard {
    id: string;
    name: string;
    groupId: number | null;
    // "RTMP", "SRT", "Relay" or "Bonded" while the input is connected, else ''.
    type: string;
    inputStatus: InputStatus;
    inputMessage: string;
    // The input dot's tooltip: what is wrong with the input and the link in, and what is
    // wrong with the relay's forward to SRS and its status.
    inputIssues: StatusIssue[];
    forwardIssues: StatusIssue[];
    forwardStatus: OutStatus;
    dots: StatusDot[];
    tally: StatusTally;
    // The card belongs in the Issues view (see PipelineProblems.hasProblem in core/problems.ts).
    hasIssue: boolean;
    severity: 'error' | 'warn' | 'none';
}

function inputTypeLabel(p: PipelineView): string {
    if (!p.input.connected) return '';
    if (p.srtBonding.acceptedBySrs) return p.srtBonding.input.bonded ? 'Bonded' : 'Relay';
    return p.input.isSrt ? 'SRT' : 'RTMP';
}

// What the relay path needs to be judged: whether the relay process runs, and the time.
export interface RelayContext {
    relayProcessRunning: boolean;
    nowMs: number;
}

export function buildStatusCards(pipelines: PipelineView[], relay: RelayContext): StatusCard[] {
    const ctx = { ...relay, advice: adviceByOutput(pipelines) };
    return pipelines.map((p) => {
        const rolled = pipelineProblems(p, ctx);
        return {
            id: p.id,
            name: p.name,
            groupId: p.groupId,
            type: inputTypeLabel(p),
            inputStatus: rolled.input.status,
            inputMessage: rolled.input.message,
            inputIssues: rolled.input.inputSide,
            forwardIssues: rolled.input.forwardSide,
            forwardStatus: rolled.relay.output,
            dots: rolled.outputs.map(
                ({ output, status, message, issues, notices }): StatusDot => ({
                    id: output.id,
                    name: output.name,
                    status,
                    message,
                    issues,
                    notices,
                }),
            ),
            tally: rolled.tally,
            hasIssue: rolled.hasProblem,
            severity: rolled.severity,
        };
    });
}

// The rejected publishers (what SRS refused: a wrong or unassigned key, a play request) as the
// one red card the Status view shows, so a refused encoder is not missed there. `omitted` are
// the entries beyond the API's row cap. 0 when nothing was refused lately (the server
// forgets an entry five minutes after its last attempt).
export function rejectedPublishersCount(
    rejected: readonly RejectedPublish[],
    omitted: number,
): number {
    return rejected.length + omitted;
}

export interface StatusTotals {
    inputs: { good: number; problem: number; off: number };
    outputs: StatusTally;
    pipelinesWithIssues: number;
}

export function statusTotals(cards: StatusCard[]): StatusTotals {
    const totals: StatusTotals = {
        inputs: { good: 0, problem: 0, off: 0 },
        outputs: { good: 0, warn: 0, error: 0, off: 0 },
        pipelinesWithIssues: 0,
    };
    for (const card of cards) {
        if (isProblem(card.inputStatus)) totals.inputs.problem += 1;
        else if (card.inputStatus === 'off') totals.inputs.off += 1;
        else totals.inputs.good += 1;
        for (const key of ['good', 'warn', 'error', 'off'] as const) {
            totals.outputs[key] += card.tally[key];
        }
        if (card.hasIssue) totals.pipelinesWithIssues += 1;
    }
    return totals;
}

export interface StatusGroup {
    id: number | null;
    name: string;
    cards: StatusCard[];
}

// The cards in the sidebar's order: groups by position, each with its pipelines in order,
// then the ungrouped ones. A group with nothing to show is left out, and a pipeline whose
// group no longer exists counts as ungrouped.
export function groupStatusCards(
    cards: StatusCard[],
    groups: PipelineGroup[],
    issuesOnly: boolean,
): StatusGroup[] {
    const shown = issuesOnly ? cards.filter((c) => c.hasIssue) : cards;
    const known = new Set(groups.map((g) => g.id));
    const result: StatusGroup[] = [...groups]
        .sort((a, b) => a.position - b.position)
        .map((g) => ({ id: g.id, name: g.name, cards: shown.filter((c) => c.groupId === g.id) }));
    result.push({
        id: null,
        name: result.length > 0 ? 'Ungrouped' : '',
        cards: shown.filter((c) => c.groupId === null || !known.has(c.groupId)),
    });
    return result.filter((g) => g.cards.length > 0);
}

// The warnings and errors among GET /api/events (newest first), as the last `max` of them
// oldest first, to read like the other logs.
export function problemEvents(events: ActivityEvent[], max: number): ActivityEvent[] {
    return events
        .filter((e) => e.severity === 'error' || e.severity === 'warning')
        .slice(0, max)
        .reverse();
}
