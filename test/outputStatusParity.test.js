'use strict';

// The dashboard (public/ts/core/status.ts) and the server (src/utils/outputStatus.ts)
// each have their own copy of the output status rules, because neither can import
// the other's code. This runs both on the same outputs and asserts they agree.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { parsePipelines } = require('../public/ts/core/pipeline');
const dashboard = require('../public/ts/core/status');
const { outputSeverity } = require('../public/ts/features/output-card');
const server = require('../src/utils/outputStatus');

const ENCODINGS = ['copy', '720p', '1080p', 'vertical_rotate'];
const T = 1_700_000_000_000;
const RENDITION_URL = 'rtmp://127.0.0.1:21935/internal/r1_720p_acopy';

const row = (id, overrides = {}) => ({
    id,
    pipelineId: '1',
    seq: Number(id.split('-')[1]),
    name: `out ${id}`,
    desiredState: 'running',
    videoEncoding: 'copy',
    url: `rtmp://dest.example/live/${id}`,
    audioEncoding: 'copy',
    translation: null,
    lastError: null,
    hasErrorHistory: false,
    ...overrides,
});

const entry = (overrides = {}) => ({
    status: 'running',
    pid: 1,
    bitrateKbps: 4000,
    startedAtMs: T,
    failures: 0,
    nextRetryAtMs: null,
    warningReason: null,
    warningSinceMs: null,
    lastError: null,
    hasErrorHistory: false,
    memoryUsageBytes: null,
    memoryLimitBytes: null,
    cpuPercent: null,
    speed: null,
    translation: null,
    role: 'output',
    renditionId: null,
    ready: null,
    readers: null,
    ...overrides,
});

// Runs one pipeline through both implementations: `rows` are the config rows, `entries`
// the health entries by output id.
function both(rows, entries, live) {
    const input = { connected: true, live, alerts: [] };
    const config = {
        pipelines: [{ id: '1', name: 'Hindi', streamKey: 'k', streamKeyId: 1 }],
        outputs: rows,
        encodings: ENCODINGS,
    };
    const health = { pipelines: { 1: { input, outputs: entries, alerts: [] } } };
    const [pipeline] = parsePipelines(config, health);
    const dashboardViews = [...pipeline.outs, ...pipeline.renditions];
    const serverViews = server.buildOutputViews(
        rows.map((r) => ({ ...r, pipelineId: 1 })),
        entries,
    );
    return rows.map((r) => ({
        id: r.id,
        d: dashboardViews.find((v) => v.id === r.id),
        s: serverViews.find((v) => v.id === r.id),
        pipeline,
        input,
    }));
}

// What the dashboard says about an output, in the reporter's words: its Problems rule
// (outputSeverity) without the advisory warnings, which these outputs do not trigger.
function dashboardReported(d, pipeline) {
    const severity = outputSeverity(d, pipeline.input, new Map());
    if (d.desiredState === 'stopped') return severity === 'error' ? 'error' : 'stopped';
    return severity === 'error' ? 'error' : severity === 'warning' ? 'warning' : 'running';
}

function assertSame(label, { d, s, pipeline, input }) {
    const expected = dashboard.outputHealth(d, pipeline.input);
    const actual = server.outputHealth(s, input);
    assert.equal(actual.status, expected.status, `${label}: status`);
    assert.deepEqual(
        actual.issues.map((i) => [i.severity, i.message]),
        expected.issues.map((i) => [i.severity, i.message]),
        `${label}: issues`,
    );
    assert.equal(
        server.currentErrorLine(s),
        // What the output card shows as the current error (features/output-card.ts).
        d.lastErrorAt === null ? '' : dashboard.lastErrorLine(d),
        `${label}: current error line`,
    );
    assert.equal(
        server.reportedState(s, input).status,
        dashboardReported(d, pipeline),
        `${label}: reported status`,
    );
}

function* combinations() {
    for (const desiredState of ['running', 'stopped'])
        for (const status of ['running', 'stopped', 'failed'])
            for (const bitrateKbps of [null, 100, 4000])
                for (const warningReason of [null, 'Timestamps are jumping'])
                    for (const startedAtMs of [null, T])
                        for (const lastError of [
                            null,
                            `${T - 5000}\nold crash`,
                            `${T + 5000}\nfresh crash\nConnection refused`,
                            `${T}\n`,
                        ])
                            for (const failures of [0, 2])
                                for (const live of [true, false])
                                    yield {
                                        desiredState,
                                        entry: entry({
                                            status,
                                            bitrateKbps,
                                            warningReason,
                                            warningSinceMs: warningReason ? T : null,
                                            startedAtMs,
                                            lastError,
                                            failures,
                                        }),
                                        live,
                                    };
}

describe('output status: dashboard and server agree', () => {
    test('a plain output over every combination of state', () => {
        let n = 0;
        for (const c of combinations()) {
            const [result] = both(
                [row('1-1', { desiredState: c.desiredState })],
                { '1-1': c.entry },
                c.live,
            );
            assertSame(JSON.stringify([c.desiredState, c.entry, c.live]), result);
            n++;
        }
        assert.ok(n > 800);
    });

    test('an output with no health entry yet', () => {
        const [result] = both([row('1-1')], {}, true);
        assertSame('no entry', result);
        assert.equal(server.reportedState(result.s, { live: true }).status, 'warning');
    });

    test('an output behind a shared encode, over the encode and the output states', () => {
        const encodeStates = [
            { desc: 'ready', rendition: { ready: true, status: 'running' } },
            { desc: 'not ready', rendition: { ready: false, status: 'running', startedAtMs: T } },
            {
                desc: 'failed',
                rendition: { ready: false, status: 'failed', lastError: `${T}\nboom` },
            },
            {
                desc: 'retrying',
                rendition: {
                    ready: false,
                    status: 'stopped',
                    startedAtMs: null,
                    failures: 1,
                    lastError: `${T}\nboom`,
                },
            },
            {
                desc: 'stale error',
                rendition: {
                    ready: false,
                    status: 'stopped',
                    startedAtMs: null,
                    failures: 0,
                    lastError: `${T}\nold`,
                },
            },
        ];
        const outputStates = [
            { status: 'stopped', startedAtMs: null },
            { status: 'running', startedAtMs: T, renditionId: '1-9' },
            { status: 'running', startedAtMs: T, renditionId: null },
            { status: 'failed', startedAtMs: T, lastError: `${T}\nexit` },
        ];
        let linked = 0;
        for (const { desc, rendition } of encodeStates) {
            for (const [i, out] of outputStates.entries()) {
                const rows = [
                    row('1-1', { videoEncoding: '720p', audioEncoding: 'copy' }),
                    row('1-2', { videoEncoding: '720p', audioEncoding: 'copy' }),
                    row('1-9', {
                        videoEncoding: '720p',
                        audioEncoding: 'copy',
                        url: RENDITION_URL,
                        name: 'Shared encode 720p',
                    }),
                ];
                const entries = {
                    '1-1': entry(out),
                    '1-2': entry({ status: 'stopped', startedAtMs: null }),
                    '1-9': entry({ role: 'rendition', ...rendition }),
                };
                for (const r of both(rows, entries, true)) {
                    if (r.id === '1-9') continue;
                    assert.equal(!!r.s.sharedEncode, !!r.d.sharedEncode, 'same link');
                    if (r.s.sharedEncode) linked++;
                    assertSame(`${desc} / output ${i} / ${r.id}`, r);
                }
            }
        }
        assert.ok(linked > 0);
    });

    test('summarizeOutputError cuts a long last line the same way', () => {
        const long = `first\n${'x'.repeat(300)}  \n`;
        assert.equal(
            server.summarizeOutputError(long, 'f'),
            dashboard.summarizeOutputError(long, 'f'),
        );
        assert.equal(
            server.summarizeOutputError(null, 'f'),
            dashboard.summarizeOutputError(null, 'f'),
        );
    });
});
