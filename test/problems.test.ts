import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
    affectedOutputCount,
    groupProblems,
    isOffline,
    isProblem,
    outputProblem,
    pipelineProblems,
    problemContext,
    tallyStatuses,
    worstOfTally,
    worstStatus,
} from '../public/ts/core/problems';
import { buildStatusCards } from '../public/ts/core/status-grid';
import { buildOverviewModel } from '../public/ts/core/overview-model';
import type { InputStatus, OutStatus } from '../public/ts/core/status';
import type {
    AudioTrackInfo,
    InputHealth,
    OutputView,
    PipelineView,
    SrtBondingStatus,
} from '../public/ts/types';
import { withVerdict, withVerdicts } from './helpers/verdicts';

type Status = OutStatus | InputStatus;
type OverviewInput = Parameters<typeof buildOverviewModel>[0];

// The fixtures below set only the fields a test checks and the rules read nothing else,
// so they meet the real view types at these two casts.
const asOutputView = (view: object) => view as unknown as OutputView;
const asPipelineView = (pipeline: object) => pipeline as unknown as PipelineView;

const NOW = 1_000_000;

const rtmpInput = (over: Partial<InputHealth> = {}): Partial<InputHealth> => ({
    connected: true,
    live: true,
    isSrt: false,
    mediaOk: true,
    mediaProbeStartedAt: null,
    mediaCheckedAt: null,
    mediaError: null,
    keyframes: null,
    recvBitrateKbps: 4000,
    sendBitrateKbps: null,
    readers: 0,
    uptimeMs: 120_000,
    publisherIp: null,
    publisherType: null,
    video: null,
    audio: null,
    audioTracks: [{} as AudioTrackInfo],
    ...over,
});
const offInput = () => rtmpInput({ connected: false, live: false, mediaOk: null });

const output = (id: string, over: Partial<OutputView> = {}): Partial<OutputView> => ({
    id,
    pipelineId: '1',
    seq: 1,
    name: `Out ${id}`,
    desiredState: 'running',
    status: 'running',
    pid: 1,
    bitrateKbps: 5000,
    startedAtMs: 1,
    failures: 0,
    nextRetryAtMs: null,
    warningReason: null,
    warningSinceMs: null,
    lastError: null,
    hasErrorHistory: false,
    lastErrorAt: null,
    sharedEncode: null,
    renditionId: null,
    videoEncoding: 'copy',
    audioEncoding: 'copy',
    url: `rtmp://a.example/live/${id}`,
    ...over,
});
const stopped: Partial<OutputView> = { desiredState: 'stopped', status: 'stopped', pid: null };

// A relay input: legs as given, SRS accepting it and the relay forwarding, unless overridden.
interface Leg {
    ip: string;
    state: string;
    health: string;
    healthReason: string | null;
}
const okLeg = (ip: string): Leg => ({ ip, state: 'running', health: 'ok', healthReason: null });
const relayBonding = (legs: Leg[], over: Record<string, unknown> = {}) =>
    ({
        inputActive: true,
        outputConnected: true,
        acceptedBySrs: true,
        publishConflict: false,
        localSrtPublisherConflict: false,
        retryFailures: 0,
        forwardedPackets: 500,
        lastPacketAt: NOW - 1000,
        lastInputPacketAt: NOW - 1000,
        lastError: null,
        input: { bonded: true, expectedLegs: legs.length, legs },
        ...over,
    }) as unknown as SrtBondingStatus;

const pipeline = (
    id: number,
    input: Partial<InputHealth>,
    outs: Partial<OutputView>[],
    extra: Record<string, unknown> = {},
): PipelineView =>
    asPipelineView(
        withVerdicts({
            id: String(id),
            name: `Pipeline ${id}`,
            groupId: null,
            alerts: [],
            srtBonding: { acceptedBySrs: false, input: { bonded: false } },
            input,
            outs,
            renditions: [],
            streamKey: `key0${id}_x`,
            rtmpPublishUrl: '',
            srtPublishUrl: '',
            ...extra,
        }),
    );

const RELAY_UP = { relayProcessRunning: true, nowMs: NOW };
const problemsOf = (p: PipelineView, relay = RELAY_UP) =>
    pipelineProblems(p, problemContext([p], relay.relayProcessRunning, relay.nowMs));

describe('status helpers', () => {
    test('counts each status on its own', () => {
        assert.deepEqual(tallyStatuses(['good', 'good', 'warn', 'error', 'off', 'off']), {
            good: 2,
            warn: 1,
            error: 1,
            off: 2,
        });
        assert.deepEqual(tallyStatuses([]), { good: 0, warn: 0, error: 0, off: 0 });
    });

    test('the worst status wins: error, then warning, then good, then off', () => {
        assert.equal(worstOfTally(tallyStatuses(['good', 'warn', 'error'])), 'error');
        assert.equal(worstOfTally(tallyStatuses(['good', 'warn', 'off'])), 'warn');
        assert.equal(worstOfTally(tallyStatuses(['good', 'off'])), 'good');
        assert.equal(worstOfTally(tallyStatuses(['off', 'off'])), 'off');
        assert.equal(worstOfTally(tallyStatuses([])), 'off');
        assert.equal(worstStatus('warn', 'error'), 'error');
        assert.equal(worstStatus('good', 'off'), 'good');
        assert.equal(worstStatus('off', 'off'), 'off');
    });

    test('only a warning or an error is a problem, only off is offline', () => {
        assert.deepEqual((['good', 'warn', 'error', 'off'] as Status[]).map(isProblem), [
            false,
            true,
            true,
            false,
        ]);
        assert.deepEqual((['good', 'warn', 'error', 'off'] as Status[]).map(isOffline), [
            false,
            false,
            false,
            true,
        ]);
    });

    test('an offline input counts the outputs that are in trouble because of it', () => {
        assert.equal(affectedOutputCount('off', ['warn', 'warn', 'error', 'off', 'good']), 3);
        assert.equal(affectedOutputCount('off', ['off', 'off']), 0);
        assert.equal(affectedOutputCount('good', ['warn', 'error']), 0);
        assert.equal(affectedOutputCount('warn', ['warn']), 0);
    });
});

describe('outputProblem', () => {
    const problem = (over: Partial<OutputView>, mistakes: string[] = []) =>
        outputProblem(asOutputView(withVerdict(output('a', over), rtmpInput())), mistakes);

    test('a healthy output is not a problem', () => {
        const p = problem({});
        assert.equal(p.severity, null);
        assert.equal(p.status, 'good');
        assert.equal(p.message, '');
    });

    test('an error status or a current error line is an error', () => {
        assert.equal(problem({ status: 'failed' }).severity, 'error');
        assert.equal(problem({ ...stopped, lastError: 'boom', lastErrorAt: 1 }).severity, 'error');
    });

    test('stopped after repeated failures: status off, still an error with its error as message', () => {
        const p = problem({ ...stopped, lastError: 'Connection refused', lastErrorAt: 1 });
        assert.equal(p.status, 'off');
        assert.equal(p.severity, 'error');
        assert.equal(p.message, 'Connection refused');
    });

    test('an old error that is no longer current is not a problem', () => {
        assert.equal(problem({ ...stopped, lastError: 'boom', lastErrorAt: null }).severity, null);
    });

    test('a warning status, a warning reason or a mistake is a warning, even when stopped', () => {
        assert.equal(problem({ bitrateKbps: 100 }).severity, 'warning');
        assert.equal(problem({ warningReason: 'timestamps' }).severity, 'warning');
        assert.equal(problem({ ...stopped }, ['Same destination as X']).severity, 'warning');
    });

    test('a mistake does not change the status, and is the message when nothing else is wrong', () => {
        const p = problem({}, ['Same destination as X']);
        assert.equal(p.status, 'good');
        assert.equal(p.message, 'Same destination as X');
    });

    test('an error outranks a warning, and the verdict is the first message', () => {
        const p = problem({ warningReason: 'x', lastError: 'boom', lastErrorAt: 1 }, ['m']);
        assert.equal(p.severity, 'error');
        assert.equal(p.message, 'x');
    });
});

describe('pipelineProblems: the input half', () => {
    const legs = [okLeg('a'), okLeg('b')];
    const relayed = (
        input: Partial<InputHealth>,
        bonding: Record<string, unknown>,
        outs: Partial<OutputView>[] = [output('a')],
    ) => pipeline(1, input, outs, { srtBonding: relayBonding(legs, bonding) });

    test('without a relay the input half is the verdict', () => {
        assert.equal(problemsOf(pipeline(1, rtmpInput(), [])).input.status, 'good');
        assert.equal(problemsOf(pipeline(1, offInput(), [])).input.status, 'off');
        const bad = pipeline(1, rtmpInput({ mediaOk: false, mediaError: 'No video' }), []);
        assert.equal(problemsOf(bad).input.status, 'error');
        assert.equal(problemsOf(bad).input.message, 'No video');
    });

    test('a relay warning or error raises a good input', () => {
        const unstable = [
            okLeg('a'),
            { ip: 'b', state: 'running', health: 'warn', healthReason: 'Leg is unstable' },
        ];
        const p = pipeline(1, rtmpInput({ isSrt: true }), [], {
            srtBonding: relayBonding(unstable),
        });
        assert.equal(problemsOf(p).input.status, 'warn');
        assert.match(problemsOf(p).input.message, /Leg b: Leg is unstable/);
        const lost = relayed(rtmpInput({ isSrt: true }), { outputConnected: false });
        assert.equal(problemsOf(lost).input.status, 'error');
    });

    test('a relay error beats a warning verdict, and the message explains the status', () => {
        const slow = rtmpInput({ isSrt: true, recvBitrateKbps: 50 });
        const p = relayed(slow, { outputConnected: false, lastError: 'refused' });
        assert.equal(problemsOf(p).input.status, 'error');
        assert.match(problemsOf(p).input.message, /Relay output reconnecting: refused/);
    });

    test('a relay problem shows even while the input is off', () => {
        const noSrs = relayed(offInput(), { outputConnected: false, acceptedBySrs: false });
        assert.equal(problemsOf(noSrs).input.status, 'error');
        const unreported = relayed(offInput(), { acceptedBySrs: false });
        assert.equal(problemsOf(unreported).input.status, 'warn');
    });

    test('a healthy relay never turns an off input good, and a stopped relay is ignored', () => {
        assert.equal(problemsOf(relayed(offInput(), {})).input.status, 'off');
        const stoppedRelay = { relayProcessRunning: false, nowMs: NOW };
        const lostLeg = relayed(rtmpInput(), {
            input: { bonded: true, expectedLegs: 2, legs: [okLeg('a')] },
        });
        assert.equal(problemsOf(lostLeg, stoppedRelay).input.status, 'good');
        assert.equal(problemsOf(lostLeg).input.status, 'warn');
    });
});

describe('pipelineProblems: the outputs', () => {
    test('status counts and Problems are kept apart', () => {
        const dup = [output('a', { url: 'rtmp://same/x' }), output('b', { url: 'rtmp://same/x' })];
        const p = problemsOf(pipeline(1, rtmpInput(), [...dup, output('c', { ...stopped })]));
        assert.deepEqual(p.tally, { good: 2, warn: 0, error: 0, off: 1 });
        assert.equal(p.mistakes, 2);
        assert.equal(p.severity, 'warn');
        assert.equal(p.hasProblem, true);
        assert.deepEqual(
            p.outputs.map((o) => o.severity),
            ['warning', 'warning', null],
        );
    });

    test('an output stopped after repeated failures makes the pipeline a problem, with status off', () => {
        const failedStop = output('a', { ...stopped, lastError: 'refused', lastErrorAt: 5 });
        const p = problemsOf(pipeline(1, rtmpInput(), [failedStop]));
        assert.equal(p.tally.off, 1);
        assert.equal(p.severity, 'error');
        assert.equal(p.hasProblem, true);
    });

    test('a stopped output and a healthy one are no problem', () => {
        const p = problemsOf(pipeline(1, rtmpInput(), [output('a'), output('b', { ...stopped })]));
        assert.equal(p.hasProblem, false);
        assert.equal(p.severity, 'none');
    });

    test('an offline input is a problem through its outputs, which warn that it is not live', () => {
        const p = problemsOf(pipeline(1, offInput(), [output('a')]));
        assert.equal(p.input.status, 'off');
        assert.equal(p.hasProblem, true);
    });

    test('shared encodes are judged apart and are not counted among the outputs', () => {
        const encode = output('r', { status: 'failed', lastError: 'x', lastErrorAt: 1 });
        const p = problemsOf(pipeline(1, rtmpInput(), [output('a')], { renditions: [encode] }));
        assert.equal(p.renditions[0].severity, 'error');
        assert.deepEqual(p.tally, { good: 1, warn: 0, error: 0, off: 0 });
        assert.equal(p.hasProblem, false);
    });
});

describe('groupProblems', () => {
    test('the worst input and every output as one tally', () => {
        const a = problemsOf(pipeline(1, rtmpInput(), [output('a'), output('b')]));
        const b = problemsOf(pipeline(2, offInput(), [output('c', { ...stopped })]));
        const group = groupProblems([a, b]);
        assert.equal(group.input, 'good');
        assert.deepEqual(group.outputs, { good: 2, warn: 0, error: 0, off: 1 });
        assert.equal(group.output, 'good');
        assert.deepEqual(groupProblems([]), {
            input: 'off',
            outputs: { good: 0, warn: 0, error: 0, off: 0 },
            output: 'off',
        });
    });

    test('a relay fault on one member reaches the group dot', () => {
        const unstable = pipeline(1, rtmpInput({ isSrt: true }), [], {
            srtBonding: relayBonding([
                okLeg('a'),
                { ip: 'b', state: 'running', health: 'error', healthReason: 'Leg is down' },
            ]),
        });
        const fine = pipeline(2, rtmpInput(), [output('a')]);
        const ctx = problemContext([unstable, fine], true, NOW);
        const group = groupProblems([unstable, fine].map((p) => pipelineProblems(p, ctx)));
        assert.equal(group.input, 'error');
    });
});

describe('one answer for every view', () => {
    // A verdict of warn with a relay error: the sidebar used to show warn and the Status
    // view error. Every view reads pipelineProblems, so they now agree.
    const slowRelay = pipeline(1, rtmpInput({ isSrt: true, recvBitrateKbps: 50 }), [output('a')], {
        srtBonding: relayBonding([okLeg('a'), okLeg('b')], { outputConnected: false }),
    });
    const view: OverviewInput = {
        pipelines: [slowRelay],
        metrics: {},
        filter: 'problems',
        inputSearch: '',
        outputSearch: '',
        relayProcessRunning: true,
        nowMs: NOW,
    };

    test('the sidebar dot, the Status view and the Issues view agree', () => {
        assert.equal(slowRelay.input.verdict.status, 'warn');
        const rolled = problemsOf(slowRelay);
        const [card] = buildStatusCards([slowRelay], RELAY_UP);
        assert.equal(rolled.input.status, 'error');
        assert.equal(card.inputStatus, rolled.input.status);
        assert.equal(card.severity, rolled.severity);
        assert.equal(card.hasIssue, rolled.hasProblem);
        const model = buildOverviewModel(view);
        assert.equal(model.relay.rows.length, 1, 'the Issues view lists the relay fault');
        assert.equal(model.relay.rows[0].relay.output, 'error');
    });
});
