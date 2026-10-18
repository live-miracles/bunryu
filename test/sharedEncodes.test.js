'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { parsePipelines } = require('../public/ts/core/pipeline');
const {
    renderSharedEncodeRows,
    sharedEncodeIssue,
    SHARED_ENCODE_RESTART_LOCKOUT_MS,
} = require('../public/ts/features/shared-encodes');

const ENCODINGS = ['copy', '720p', '1080p', 'vertical_rotate'];
const R720 = 'rtmp://127.0.0.1:21935/internal/r1_720p_a1';
const R1080 = 'rtmp://127.0.0.1:21935/internal/r1_1080p_acopy';

const outputRow = (id, overrides = {}) => ({
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
const renditionRow = (id, url, video, audio, overrides = {}) =>
    outputRow(id, {
        name: `Shared encode ${video} · track ${audio}`,
        url,
        videoEncoding: video,
        audioEncoding: audio,
        ...overrides,
    });

const outputHealth = (overrides = {}) => ({
    status: 'running',
    pid: 1,
    bitrateKbps: 3000,
    startedAtMs: Date.now() - 65_000,
    failures: 0,
    warningReason: null,
    lastError: null,
    hasErrorHistory: false,
    memoryUsageBytes: null,
    memoryLimitBytes: null,
    cpuPercent: null,
    translation: null,
    role: 'output',
    renditionId: null,
    ready: null,
    readers: null,
    ...overrides,
});

function parse({ outputs, health = {}, layoutOrder = [] }) {
    return parsePipelines(
        {
            pipelines: [{ id: 1, name: 'P1', streamKey: 'key01', streamKeyId: 1, groupId: null }],
            outputs,
            layoutOrder,
            encodings: ENCODINGS,
        },
        { pipelines: { 1: { outputs: health } } },
    )[0];
}

const FLEET = () => [
    outputRow('1-1', { name: 'Plain', url: 'rtmp://plain.example/live/k' }),
    renditionRow('1-2', R720, '720p', '1', { name: 'Shared encode 720p · track 2' }),
    outputRow('1-3', { name: 'YouTube', videoEncoding: '720p', audioEncoding: '1' }),
    outputRow('1-4', { name: 'Twitch', videoEncoding: '720p', audioEncoding: '1' }),
    outputRow('1-5', {
        name: 'Multi',
        audioEncoding: '0,1',
        url: 'srt://dest.example:9000?mode=caller',
    }),
    outputRow('1-6', { name: 'Translated', audioEncoding: 'translation' }),
    outputRow('1-7', { name: 'No encode yet', videoEncoding: '1080p', audioEncoding: 'copy' }),
];

describe('parsePipelines: shared encodes', () => {
    test('rendition rows go to renditions; outs keeps only the user outputs, in order', () => {
        const p = parse({ outputs: FLEET() });

        assert.deepEqual(
            p.outs.map((o) => o.id),
            ['1-1', '1-3', '1-4', '1-5', '1-6', '1-7'],
        );
        assert.deepEqual(
            p.renditions.map((o) => o.id),
            ['1-2'],
        );
    });

    test('a pipeline with no shared encodes has an empty renditions list', () => {
        const p = parse({ outputs: [outputRow('1-1')] });
        assert.deepEqual(p.renditions, []);
        assert.equal(p.outs.length, 1);
    });

    test('outputs with a shared recipe point at their rendition; the rest do not', () => {
        const p = parse({ outputs: FLEET() });
        const byId = Object.fromEntries(p.outs.map((o) => [o.id, o]));

        assert.equal(byId['1-3'].sharedEncode.id, '1-2');
        assert.equal(byId['1-4'].sharedEncode.id, '1-2');
        assert.equal(byId['1-1'].sharedEncode, null, 'plain copy');
        assert.equal(byId['1-5'].sharedEncode, null, 'multi-track');
        assert.equal(byId['1-6'].sharedEncode, null, 'translation');
        assert.equal(byId['1-7'].sharedEncode, null, 'rendition not created yet');
    });

    test('a rendition lists its dependents', () => {
        const p = parse({ outputs: FLEET() });
        assert.deepEqual(
            p.renditions[0].dependents.map((d) => d.name),
            ['YouTube', 'Twitch'],
        );
    });

    test('health fills ready, readers and status on the rendition', () => {
        const p = parse({
            outputs: FLEET(),
            health: {
                '1-2': outputHealth({ role: 'rendition', ready: true, readers: 2 }),
            },
        });

        assert.equal(p.renditions[0].ready, true);
        assert.equal(p.renditions[0].readers, 2);
        assert.equal(p.renditions[0].status, 'running');
    });

    test('a stale layout order that mentions a rendition id changes nothing for outs', () => {
        const p = parse({
            outputs: FLEET(),
            layoutOrder: [{ id: 1, outs: ['1-4', '1-2', '1-3'] }],
        });

        assert.deepEqual(
            p.outs.map((o) => o.id),
            ['1-4', '1-3', '1-1', '1-5', '1-6', '1-7'],
        );
        assert.deepEqual(
            p.renditions.map((o) => o.id),
            ['1-2'],
        );
    });
});

describe('parsePipelines: outputs that started direct', () => {
    test('a running output that is not reading the encode is not linked to it, and is not its dependent', () => {
        const p = parse({
            outputs: FLEET(),
            health: {
                '1-2': outputHealth({ role: 'rendition', ready: true, readers: 1 }),
                // started while it was alone with its recipe: running, reading the input
                '1-3': outputHealth({ renditionId: null }),
                // started later: reads the encode
                '1-4': outputHealth({ renditionId: '1-2' }),
            },
        });
        const byId = Object.fromEntries(p.outs.map((o) => [o.id, o]));

        assert.equal(byId['1-3'].sharedEncode, null);
        assert.equal(byId['1-4'].sharedEncode.id, '1-2');
        assert.deepEqual(
            p.renditions[0].dependents.map((d) => d.id),
            ['1-4'],
        );
    });

    test('outputs that are not running yet are linked: they will read the encode when they start', () => {
        const p = parse({
            outputs: FLEET(),
            health: { '1-3': outputHealth({ status: 'stopped', startedAtMs: null }) },
        });
        assert.equal(p.outs.find((o) => o.id === '1-3').sharedEncode.id, '1-2');
        assert.deepEqual(
            p.renditions[0].dependents.map((d) => d.id),
            ['1-3', '1-4'],
        );
    });

    test('a running direct output gets no waiting warning, even while the encode is down', () => {
        const p = parse({
            outputs: FLEET(),
            health: {
                '1-2': outputHealth({ role: 'rendition', ready: false, status: 'failed' }),
                '1-3': outputHealth({ renditionId: null }),
            },
        });
        assert.equal(sharedEncodeIssue(p.outs.find((o) => o.id === '1-3')), null);
    });
});

describe('sharedEncodeIssue', () => {
    const view = (rendition = {}, output = {}) => {
        const p = parse({
            outputs: FLEET(),
            health: {
                '1-2': outputHealth({ role: 'rendition', ...rendition }),
                '1-3': outputHealth({ status: 'stopped', startedAtMs: null, ...output }),
            },
        });
        return p.outs.find((o) => o.id === '1-3');
    };

    test('waiting for a rendition that is not ready yet', () => {
        const issue = sharedEncodeIssue(view({ status: 'running', ready: false }));
        assert.equal(issue.severity, 'warning');
        assert.equal(issue.message, 'Waiting for Shared encode 720p · track 2');
    });

    test('a failed rendition is named with its last error line', () => {
        const issue = sharedEncodeIssue(
            view({
                status: 'failed',
                ready: false,
                lastError: `${Date.now()}\nexit=1\nConnection refused`,
                failures: 2,
            }),
        );
        assert.equal(issue.severity, 'warning');
        assert.equal(issue.message, 'Shared encode failed: Connection refused');
    });

    test('a rendition that is between retries with a current error counts as failed', () => {
        const issue = sharedEncodeIssue(
            view({
                status: 'stopped',
                startedAtMs: null,
                failures: 1,
                ready: false,
                lastError: `${Date.now()}\nexit=1\nBroken pipe`,
            }),
        );
        assert.equal(issue.message, 'Shared encode failed: Broken pipe');
    });

    test('also while the output itself is in the failed state after being restarted by the rendition', () => {
        const issue = sharedEncodeIssue(
            view({ status: 'running', ready: false }, { status: 'failed' }),
        );
        assert.match(issue.message, /^Waiting for Shared encode /);
    });

    test('nothing to say when the rendition is ready, the output runs, or it is stopped', () => {
        assert.equal(sharedEncodeIssue(view({ status: 'running', ready: true })), null);
        assert.equal(
            sharedEncodeIssue(view({ ready: false, status: 'running' }, { status: 'running' })),
            null,
        );
        const p = parse({
            outputs: FLEET().map((o) => (o.id === '1-3' ? { ...o, desiredState: 'stopped' } : o)),
        });
        assert.equal(sharedEncodeIssue(p.outs.find((o) => o.id === '1-3')), null);
    });

    test('an output without a shared encode has no issue', () => {
        const p = parse({ outputs: FLEET() });
        assert.equal(sharedEncodeIssue(p.outs.find((o) => o.id === '1-1')), null);
        assert.equal(sharedEncodeIssue(p.outs.find((o) => o.id === '1-7')), null);
    });

    test('a rendition whose desired state is stopped is idle, not an error', () => {
        const p = parse({
            outputs: FLEET().map((o) => (o.id === '1-2' ? { ...o, desiredState: 'stopped' } : o)),
            health: { '1-3': outputHealth({ status: 'stopped', startedAtMs: null }) },
        });
        const issue = sharedEncodeIssue(p.outs.find((o) => o.id === '1-3'));
        assert.match(issue.message, /^Waiting for Shared encode /);
    });
});

describe('Shared encodes card', () => {
    const deps = (overrides = {}) => ({
        outStatus: (o) =>
            o.status === 'failed' ? 'error' : o.desiredState === 'stopped' ? 'off' : 'good',
        formatUptime: () => '1m 5s',
        restartLocked: () => false,
        ...overrides,
    });
    const pipelineWith = (renditionHealth = {}, rows = FLEET()) =>
        parse({
            outputs: rows,
            health: {
                '1-2': outputHealth({
                    role: 'rendition',
                    ready: true,
                    readers: 2,
                    cpuPercent: 41,
                    memoryUsageBytes: 90 * 1024 * 1024,
                    memoryLimitBytes: 650 * 1024 * 1024,
                    ...renditionHealth,
                }),
            },
        });

    test('shows one row per rendition with name, counts, uptime and metrics', () => {
        const html = renderSharedEncodeRows(pipelineWith(), deps());

        assert.equal((html.match(/data-shared-encode=/g) ?? []).length, 1);
        assert.ok(
            !html.includes('Shared encode'),
            'the card title already says it; the row shows only the encoding',
        );
        assert.match(html, />720p</);
        assert.match(html, />T2</);
        assert.match(html, /2 outs · 2 reads/);
        assert.match(html, /1m 5s/);
        assert.match(html, /3\.0 mbps \| 41% \|/);
    });

    test('shows the encoding as badges like an output card: video if not copy, audio as T<n>', () => {
        const only = (video, audio) =>
            renderSharedEncodeRows(
                parse({
                    outputs: [
                        renditionRow(
                            '1-2',
                            `rtmp://127.0.0.1:21935/internal/r1_${video}_a${audio}`,
                            video,
                            audio,
                        ),
                    ],
                    health: { '1-2': outputHealth({ role: 'rendition', ready: true, readers: 0 }) },
                }),
                deps(),
            );
        const both = only('720p', '1');
        assert.match(
            both,
            /<span class="badge badge-sm badge-accent badge-soft whitespace-nowrap">720p<\/span>/,
        );
        assert.match(
            both,
            /<span class="badge badge-xs badge-accent badge-soft whitespace-nowrap">T2<\/span>/,
        );

        const audioOnly = only('copy', '0');
        assert.match(audioOnly, />T1</);
        assert.ok(!audioOnly.includes('>copy<'), 'copy video is not a badge');
        assert.ok(!audioOnly.includes('badge-sm badge-accent'));

        const videoOnly = only('1080p', 'copy');
        assert.match(videoOnly, />1080p</);
        assert.ok(!videoOnly.includes('badge-xs badge-accent'), 'source audio is not a badge');
    });

    test('uses singular forms and zero readers', () => {
        const p = pipelineWith(
            { readers: 0 },
            FLEET().filter((o) => o.id !== '1-4'),
        );
        assert.match(renderSharedEncodeRows(p, deps()), /1 out · 0 reads/);
        const p1 = pipelineWith({ readers: 1 });
        assert.match(renderSharedEncodeRows(p1, deps()), /2 outs · 1 read\b/);
    });

    test('renders nothing for a pipeline without renditions', () => {
        assert.equal(renderSharedEncodeRows(parse({ outputs: [outputRow('1-1')] }), deps()), '');
    });

    test('shows failures and the current last error with its time', () => {
        const ts = new Date(2026, 9, 17, 12, 34, 56).getTime();
        const html = renderSharedEncodeRows(
            pipelineWith({
                status: 'failed',
                startedAtMs: null,
                failures: 3,
                lastError: `${ts}\nexit=1\nServer returned 403`,
                hasErrorHistory: true,
            }),
            deps(),
        );

        assert.match(html, /Server returned 403/);
        assert.match(html, /12:34:56/);
        assert.match(html, />3</, 'failure count');
        assert.match(html, /data-action="error-info" data-out-id="1-2"/);
    });

    test('no error line while the rendition is stopped, no failure badge at zero', () => {
        const ts = Date.now();
        const stopped = renderSharedEncodeRows(
            pipelineWith({ lastError: `${ts}\nboom` }).renditions.length
                ? parse({
                      outputs: FLEET().map((o) =>
                          o.id === '1-2' ? { ...o, desiredState: 'stopped' } : o,
                      ),
                      health: {
                          '1-2': outputHealth({
                              status: 'stopped',
                              lastError: `${ts}\nboom`,
                              startedAtMs: null,
                          }),
                      },
                  })
                : null,
            deps(),
        );
        assert.ok(!stopped.includes('boom'));
        assert.ok(!renderSharedEncodeRows(pipelineWith(), deps()).includes('badge-error'));
    });

    test('History only when there is a history; Restart only enabled while running and not locked', () => {
        const none = renderSharedEncodeRows(pipelineWith(), deps());
        assert.ok(!none.includes('data-action="error-info"'));
        assert.match(none, /data-action="restart-shared" data-out-id="1-2"(?![^>]*disabled)/);

        const locked = renderSharedEncodeRows(pipelineWith(), deps({ restartLocked: () => true }));
        assert.match(locked, /data-action="restart-shared"[^>]*disabled/);

        const stopped = renderSharedEncodeRows(
            pipelineWith({ status: 'stopped', startedAtMs: null, ready: false }),
            deps(),
        );
        assert.match(stopped, /data-action="restart-shared"[^>]*disabled/);
        assert.equal(SHARED_ENCODE_RESTART_LOCKOUT_MS, 5000);
    });

    test('Restart is styled like Start/Stop and sits between the status dot and the encoding', () => {
        const html = renderSharedEncodeRows(pipelineWith(), deps());
        const dot = html.indexOf('aria-label="status"');
        const restart = html.indexOf('data-action="restart-shared"');
        const name = html.indexOf('>720p<');
        const history = html.indexOf('data-action="error-info"');

        assert.ok(
            dot >= 0 && dot < restart && restart < name,
            'dot, then Restart, then the encoding',
        );
        assert.match(
            html,
            /<button class="btn btn-xs btn-accent btn-outline"[^>]*data-action="restart-shared"/,
        );
        assert.ok(
            !/btn-ghost[^>]*data-action="restart-shared"/.test(html),
            'not the ghost icon button',
        );
        assert.equal(history, -1, 'no history yet in this fixture');
        const withHistory = renderSharedEncodeRows(pipelineWith({ hasErrorHistory: true }), deps());
        assert.ok(
            withHistory.indexOf('data-action="error-info"') > withHistory.indexOf('>720p<'),
            'History stays on the right',
        );
    });

    test('first line is dot, Restart, encoding badges and History at the end; stats go below', () => {
        const html = renderSharedEncodeRows(pipelineWith({ hasErrorHistory: true }), deps());
        const at = (needle) => html.indexOf(needle);
        const order = [
            at('aria-label="status"'),
            at('data-action="restart-shared"'),
            at('>720p<'),
            at('>T2<'),
            at('data-action="error-info"'),
            at('1m 5s'),
            at('2 outs · 2 reads'),
        ];

        assert.ok(
            order.every((i) => i >= 0),
            JSON.stringify(order),
        );
        assert.deepEqual(
            order,
            [...order].sort((a, b) => a - b),
            'dot, Restart, encoding badges, History, then stats',
        );
        // History sits in the right-aligned group of the first line, as on an output card.
        assert.match(html, /ml-auto[^"]*">\s*<button[^>]*data-action="error-info"/);
    });

    test('lists the dependent output names in the tooltip', () => {
        const html = renderSharedEncodeRows(pipelineWith(), deps());
        assert.match(html, /js-tooltip/);
        assert.match(html, /YouTube/);
        assert.match(html, /Twitch/);
        assert.ok(!html.includes('Plain'), 'only outputs that use it');
    });

    test('every string from names and errors is escaped', () => {
        const evil = '<img src=x onerror=alert(1)>';
        const rows = FLEET().map((o) =>
            o.id === '1-3' ? { ...o, name: evil } : o.id === '1-2' ? { ...o, name: evil } : o,
        );
        const html = renderSharedEncodeRows(
            parse({
                outputs: rows,
                health: {
                    '1-2': outputHealth({
                        role: 'rendition',
                        ready: false,
                        status: 'failed',
                        startedAtMs: null,
                        failures: 1,
                        lastError: `${Date.now()}\n${evil}`,
                    }),
                },
            }),
            deps(),
        );

        assert.ok(!html.includes('<img'), html);
        assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
    });
});
