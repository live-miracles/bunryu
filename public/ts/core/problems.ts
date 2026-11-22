import type { OutputView, PipelineView } from '../types.js';
import { relayHealth, relayIssueList, type RelayHealth } from './relay-status.js';
import {
    lastErrorLine,
    summarizeOutputError,
    type InputStatus,
    type OutStatus,
    type StatusIssue,
} from './status.js';

// What is a Problem, and what status a pipeline's dot shows, worked out once. The sidebar,
// the Status view, the Overview and the Outputs list draw what this returns and decide
// nothing about it themselves, so they cannot disagree. Pure, so a test needs no DOM.
//
// Two answers are kept apart on purpose (see GLOSSARY.md):
//   - Status is the colour of a dot and the counts beside it: the server's verdict and, for
//     an input, the relay in front of it.
//   - A Problem is what a list, filter or "has issues" flag picks out: a warning or error
//     status.
//
// Two things are in neither and show on the output's card only: the advice about how an
// output is configured (core/output-advice.ts), and the error a stopped output keeps after
// repeated failures (a few outputs are always broken: that must not turn a pipeline red).

type Status = OutStatus | InputStatus;

export const isProblem = (status: Status): boolean => status === 'warn' || status === 'error';
export const isOffline = (status: Status): boolean => status === 'off';

// An error beats a warning beats a healthy status beats off.
const RANK: Record<Status, number> = { off: 0, good: 1, warn: 2, error: 3 };
export function worstStatus(a: Status, b: Status): Status {
    return RANK[b] > RANK[a] ? b : a;
}

// How many of a pipeline's (or a group's) outputs are in each status.
export type StatusTally = Record<Status, number>;

export function tallyStatuses(statuses: Status[]): StatusTally {
    const tally: StatusTally = { good: 0, warn: 0, error: 0, off: 0 };
    for (const status of statuses) tally[status] += 1;
    return tally;
}

// The one status that stands for a tally: an error beats a warning beats a healthy output,
// and no healthy output at all reads as off.
export function worstOfTally(tally: StatusTally): Status {
    return tally.error > 0 ? 'error' : tally.warn > 0 ? 'warn' : tally.good > 0 ? 'good' : 'off';
}

// An input nobody publishes to is "off", not a problem. It becomes one in the Issues view
// when outputs of its pipeline are in trouble, because their cause is this row.
export function affectedOutputCount(inputStatus: Status, outputStatuses: Status[]): number {
    return inputStatus === 'off' ? outputStatuses.filter(isProblem).length : 0;
}

export type ProblemSeverity = 'error' | 'warning';

export interface OutputProblem {
    output: OutputView;
    // The dot's status: the server's verdict.
    status: OutStatus;
    // null when the output is not a Problem.
    severity: ProblemSeverity | null;
    // The first thing to look at, or '': its verdict's first issue, else its current error
    // (for a stopped output, the one it was stopped after).
    message: string;
}

// An output's own error line, which an output keeps while stopped only after repeated
// failures (the server clears it otherwise). While it runs it is a crash being retried; while
// stopped it is not a Problem.
function hasErrorLine(output: OutputView): boolean {
    return output.lastErrorAt !== null && lastErrorLine(output) !== '';
}

export function outputProblem(output: OutputView): OutputProblem {
    const status = output.verdict.status;
    const errorLine = hasErrorLine(output);
    const severity: ProblemSeverity | null =
        status === 'error' || (errorLine && output.desiredState !== 'stopped')
            ? 'error'
            : status === 'warn' || output.warningReason
              ? 'warning'
              : null;
    const message =
        output.verdict.issues[0]?.message ||
        (errorLine
            ? summarizeOutputError(output.lastError, 'Stopped after repeated failures.')
            : '') ||
        '';
    return { output, status, severity, message };
}

// What a render needs to judge pipelines: whether the relay runs, and the time.
export interface ProblemContext {
    relayProcessRunning: boolean;
    nowMs: number;
}

export interface PipelineProblems {
    pipeline: PipelineView;
    // The relay path in front of the input (an SRT input through the relay).
    relay: RelayHealth;
    // The left half of the pipeline's dot: the input's verdict, raised to the relay's
    // warning or error when the relay is worse. The relay never turns an input that is off
    // into a healthy one. `issues` is the input's and the relay's, for the tooltip, and
    // `message` the one that explains the status.
    input: { status: InputStatus; issues: StatusIssue[]; message: string };
    // One entry per output of the pipeline, in order, and per shared encode (not counted
    // among the outputs).
    outputs: OutputProblem[];
    renditions: OutputProblem[];
    // The outputs' statuses.
    tally: StatusTally;
    // The Status view's card colour.
    severity: 'error' | 'warn' | 'none';
    // The pipeline belongs in the Issues view: its input is a warning or an error, or an
    // output is a Problem. An offline input counts through its outputs.
    hasProblem: boolean;
}

export function pipelineProblems(pipeline: PipelineView, ctx: ProblemContext): PipelineProblems {
    const verdict = pipeline.input.verdict;
    const relay = relayHealth(pipeline, ctx.relayProcessRunning, ctx.nowMs);
    let status: InputStatus = verdict.status;
    for (const half of [relay.input, relay.output]) {
        if (isProblem(half)) status = worstStatus(status, half);
    }
    const issues = [...verdict.issues, ...relayIssueList(relay)];
    const wanted = status === 'error' ? 'error' : 'warning';
    const message = (issues.find((i) => i.severity === wanted) ?? issues[0])?.message ?? '';

    const outputs = pipeline.outs.map(outputProblem);
    const renditions = pipeline.renditions.map(outputProblem);
    const severity =
        status === 'error' || outputs.some((o) => o.severity === 'error')
            ? 'error'
            : status === 'warn' || outputs.some((o) => o.severity === 'warning')
              ? 'warn'
              : 'none';
    return {
        pipeline,
        relay,
        input: { status, issues, message },
        outputs,
        renditions,
        tally: tallyStatuses(outputs.map((o) => o.status)),
        severity,
        hasProblem: isProblem(status) || outputs.some((o) => o.severity !== null),
    };
}

// A pipeline group's dot: the worst input among its pipelines, and the outputs of all of
// them as one tally.
export function groupProblems(members: readonly PipelineProblems[]): {
    input: InputStatus;
    outputs: StatusTally;
    output: OutStatus;
} {
    let input: InputStatus = 'off';
    for (const m of members) input = worstStatus(input, m.input.status);
    const outputs = tallyStatuses(members.flatMap((m) => m.outputs.map((o) => o.status)));
    return { input, outputs, output: worstOfTally(outputs) };
}
