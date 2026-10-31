import type { ActivityEvent, PipelineGroup, PipelineView } from '../types.js';
import { inputHealth, outputHealth, type InputStatus, type OutStatus } from './status.js';
import { isProblem, tallyStatuses, type StatusTally } from './overview-filter.js';

// The Status view: one card per pipeline with a dot for every output. Pure functions that
// turn the dashboard's state into what the view draws, so the DOM code stays thin.

export interface StatusDot {
    id: string;
    name: string;
    status: OutStatus;
    // The first thing wrong with it, or ''.
    message: string;
}

export interface StatusCard {
    id: string;
    name: string;
    groupId: number | null;
    // "RTMP", "SRT", "Relay" or "Bonded" while the input is connected, else ''.
    type: string;
    inputStatus: InputStatus;
    inputMessage: string;
    dots: StatusDot[];
    tally: StatusTally;
    // The card belongs in the Issues view: its input or an output has a warning or an error
    // (an offline input counts through its outputs, which then warn that it is not live).
    hasIssue: boolean;
    severity: 'error' | 'warn' | 'none';
}

function inputTypeLabel(p: PipelineView): string {
    if (!p.input.connected) return '';
    if (p.srtBonding.acceptedBySrs) return p.srtBonding.input.bonded ? 'Bonded' : 'Relay';
    return p.input.isSrt ? 'SRT' : 'RTMP';
}

export function buildStatusCards(pipelines: PipelineView[]): StatusCard[] {
    return pipelines.map((p) => {
        const input = inputHealth(p.input);
        const dots = p.outs.map((o): StatusDot => {
            const health = outputHealth(o, p.input);
            return {
                id: o.id,
                name: o.name,
                status: health.status,
                message: health.issues[0]?.message ?? '',
            };
        });
        const tally = tallyStatuses(dots.map((d) => d.status));
        const severity =
            tally.error > 0 || input.status === 'error'
                ? 'error'
                : tally.warn > 0 || input.status === 'warn'
                  ? 'warn'
                  : 'none';
        return {
            id: p.id,
            name: p.name,
            groupId: p.groupId,
            type: inputTypeLabel(p),
            inputStatus: input.status,
            inputMessage: input.issues[0]?.message ?? '',
            dots,
            tally,
            hasIssue: isProblem(input.status) || tally.warn > 0 || tally.error > 0,
            severity,
        };
    });
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
