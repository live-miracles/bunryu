import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
    buildActivityFeed,
    parseEventsLimit,
    DEFAULT_EVENTS_LIMIT,
    MAX_EVENTS_LIMIT,
    type OutputHistory,
} from '../src/utils/activityFeed';

const pipelines = [
    { id: 1, name: 'Main' },
    { id: 2, name: 'Hall' },
];

const feed = (overrides = {}) =>
    buildActivityFeed({
        pipelines,
        pipelineLogs: [],
        outputHistories: [],
        serverEvents: [],
        limit: 50,
        ...overrides,
    });

describe('parseEventsLimit', () => {
    test('a whole number is used', () => {
        assert.equal(parseEventsLimit('20'), 20);
    });

    test('it is capped', () => {
        assert.equal(parseEventsLimit('100000'), MAX_EVENTS_LIMIT);
    });

    test('anything else gives the default', () => {
        for (const raw of [undefined, '', '0', '-5', '1.5', 'abc', ['1', '2'], '10; DROP']) {
            assert.equal(parseEventsLimit(raw), DEFAULT_EVENTS_LIMIT, String(raw));
        }
    });
});

describe('buildActivityFeed', () => {
    test('is empty with nothing recorded', () => {
        assert.deepEqual(feed(), []);
    });

    test('merges the three sources newest first', () => {
        const events = feed({
            pipelineLogs: [
                { id: 1, pipelineId: 1, ts: 2000, event: 'offline', message: 'Input disconnected' },
            ],
            outputHistories: [
                {
                    id: 'o1',
                    pipelineId: 2,
                    name: 'YouTube',
                    history: [{ ts: 3000, kind: 'crash', message: 'Connection refused' }],
                },
            ],
            serverEvents: [
                { ts: 1000, source: 'srs', type: 'problem', message: 'SRS unreachable' },
            ],
        });
        assert.deepEqual(
            events.map((e) => [e.ts, e.source, e.pipelineName, e.outputName, e.label]),
            [
                [3000, 'output', 'Hall', 'YouTube', 'crash'],
                [2000, 'input', 'Main', null, 'offline'],
                [1000, 'server', null, null, 'SRS'],
            ],
        );
    });

    test('keeps only the newest `limit` events', () => {
        const serverEvents = Array.from({ length: 10 }, (_, i) => ({
            ts: i,
            source: 'host',
            type: 'problem',
            message: `m${i}`,
        }));
        const events = feed({ serverEvents, limit: 3 });
        assert.deepEqual(
            events.map((e) => e.ts),
            [9, 8, 7],
        );
    });

    test('skips lines of a pipeline that no longer exists', () => {
        const events = feed({
            pipelineLogs: [{ id: 1, pipelineId: 99, ts: 1, event: 'online', message: 'x' }],
            outputHistories: [
                {
                    id: 'o',
                    pipelineId: 99,
                    name: 'Gone',
                    history: [{ ts: 1, kind: 'crash', message: 'x' }],
                },
            ],
        });
        assert.deepEqual(events, []);
    });

    describe('severity', () => {
        const pipelineSeverity = (event: string) =>
            feed({ pipelineLogs: [{ id: 1, pipelineId: 1, ts: 1, event, message: '' }] })[0]
                .severity;

        test('pipeline log events', () => {
            assert.equal(pipelineSeverity('online'), 'ok');
            assert.equal(pipelineSeverity('probe_recovered'), 'ok');
            assert.equal(pipelineSeverity('offline'), 'warning');
            assert.equal(pipelineSeverity('keyframe_interval'), 'warning');
            assert.equal(pipelineSeverity('probe_failed'), 'error');
            assert.equal(pipelineSeverity('relay_error'), 'error');
        });

        test('bonded leg health events', () => {
            assert.equal(pipelineSeverity('leg_degraded'), 'warning');
            assert.equal(pipelineSeverity('leg_failed'), 'error');
            assert.equal(pipelineSeverity('leg_recovered'), 'ok');
            assert.equal(pipelineSeverity('leg_health'), 'info');
        });

        test('a pipeline log event nobody classified is plain information', () => {
            assert.equal(pipelineSeverity('legs'), 'info');
            assert.equal(pipelineSeverity('something_new'), 'info');
        });

        test('Server events', () => {
            const sev = (type: string) =>
                feed({ serverEvents: [{ ts: 1, source: 'relay', type, message: '' }] })[0];
            assert.equal(sev('problem').severity, 'error');
            assert.equal(sev('recovered').severity, 'ok');
            assert.equal(sev('problem').label, 'Goryu');
        });
    });

    describe('output History', () => {
        const outputEvents = (history: OutputHistory['history']) =>
            feed({ outputHistories: [{ id: 'o', pipelineId: 1, name: 'Out', history }] });

        test('a repeated crash is one event at its latest time, with how many', () => {
            const [e] = outputEvents([
                { ts: 1000, lastTs: 5000, count: 4, kind: 'crash', message: 'Broken pipe' },
            ]);
            assert.equal(e.ts, 5000);
            assert.equal(e.severity, 'error');
            assert.equal(e.message, 'Broken pipe (4 times)');
        });

        test('a crash that is only an exit status gets its cause from the stderr below it', () => {
            const crash = (message: string) =>
                outputEvents([{ ts: 1, kind: 'crash', message }])[0].message;
            const stderr = [
                'No room to store incoming packet',
                '[in#0/mpegts @ 0x1] Error during demuxing: Input/output error',
                '[flv @ 0x2] Failed to update header with correct filesize.',
            ].join('\n');
            assert.equal(
                crash(`exit=0\n${stderr}`).split('\n')[0],
                'exit=0: [in#0/mpegts @ 0x1] Error during demuxing: Input/output error',
            );
            assert.equal(
                crash(`Shared encode T1 failed: exit=224\n${stderr}`).split('\n')[0],
                'Shared encode T1 failed: exit=224: [in#0/mpegts @ 0x1] Error during demuxing: Input/output error',
            );
            // The key in the destination URL is not shown.
            assert.equal(
                crash(
                    'exit=251\nError opening output rtmp://live.example.com/app/secretkey: Input/output error',
                ).split('\n')[0],
                'exit=251: Error opening output rtmp://live.example.com/...: Input/output error',
            );
            // Nothing to add: only the shutdown trailer, or a message that already says why.
            const bare = 'exit=0\n[flv @ 0x2] Failed to update header with correct duration.';
            assert.equal(crash(bare), bare);
            assert.equal(
                crash('watchdog: output progress stalled\nError x'),
                'watchdog: output progress stalled\nError x',
            );
        });

        test('a recovered crash adds a recovery event', () => {
            const events = outputEvents([
                { ts: 1000, kind: 'crash', message: 'Broken pipe', recoveredTs: 9000 },
            ]);
            assert.deepEqual(
                events.map((e) => [e.ts, e.label, e.severity]),
                [
                    [9000, 'recovered', 'ok'],
                    [1000, 'crash', 'error'],
                ],
            );
        });

        test('a stop is information, unless the output kept failing', () => {
            const [plain] = outputEvents([{ ts: 1, kind: 'stopped', message: '' }]);
            assert.equal(plain.severity, 'info');
            assert.equal(plain.label, 'stopped');
            const [failing] = outputEvents([
                {
                    ts: 1,
                    kind: 'stopped',
                    message: 'Stopped after 5 failed attempts',
                    failedAttempts: 5,
                },
            ]);
            assert.equal(failing.severity, 'error');
        });

        test('warnings and starts', () => {
            const events = outputEvents([
                { ts: 2, kind: 'warning', message: 'Timestamp discontinuities' },
                { ts: 1, kind: 'started', message: '' },
            ]);
            assert.deepEqual(
                events.map((e) => [e.label, e.severity]),
                [
                    ['warning', 'warning'],
                    ['started', 'info'],
                ],
            );
        });
    });
});
