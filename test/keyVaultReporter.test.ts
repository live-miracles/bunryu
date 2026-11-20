import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createKeyVaultReporter } from '../src/services/keyVaultReporter';
import { hashDestination } from '../src/utils/keyVaultPayload';

const CONFIG = {
    url: 'https://kv.example.invalid/functions/v1/ingest?project=fake',
    token: 'fake-ingest-token-0123456789',
    hashSecret: 'fake-hash-secret-0123456789',
};
const DESTINATION = 'rtmp://a.rtmp.youtube.com/live2/fake-0000-0000-0000-0000';

// Short timings: a heartbeat every 400 ms stands for a minute.
const FAST = {
    heartbeatMs: 400,
    minChangeIntervalMs: 120,
    timeoutMs: 100,
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(condition, ms = 3000) {
    const end = Date.now() + ms;
    while (!condition()) {
        if (Date.now() > end) assert.fail('timed out waiting for the condition');
        await wait(5);
    }
}

const reporters = [];
afterEach(() => {
    for (const reporter of reporters.splice(0)) reporter.shutdown();
});

function entry(over = {}) {
    return {
        status: 'running',
        bitrateKbps: 4000,
        startedAtMs: Date.now() - 60_000,
        failures: 0,
        warningReason: null,
        warningSinceMs: null,
        lastError: null,
        renditionId: null,
        ready: null,
        ...over,
    };
}

// A reporter wired to fake health and database objects. `world.output` is the one
// configured output; change `world.health` and call `emit()` for a new health poll.
function setup({ fetchFn, options = FAST, config = CONFIG, db } = {}) {
    const listeners = [];
    const world = {
        health: entry(),
        live: true,
        // The server name from Settings.
        instance: 'test',
        throwOnList: false,
        // What Settings holds now; a test changes it and calls reporter.reconfigure().
        config,
    };
    const snapshot = () => ({
        pipelines: {
            1: {
                input: {
                    connected: world.live,
                    live: world.live,
                    mediaOk: true,
                    mediaError: null,
                    recvBitrateKbps: 4000,
                    uptimeMs: 120_000,
                    audioTracks: [{}],
                    audio: null,
                },
                outputs: { '1-1': world.health },
                alerts: [],
            },
        },
    });
    const events = [];
    const diagnostics = {
        event: (event, fields = {}) => events.push({ event, ...fields }),
        close: async () => {},
    };
    const fakeDb = db ?? {
        listPipelines: () => {
            if (world.throwOnList) throw new Error('database is locked');
            return [{ id: 1, name: 'Hindi', streamKey: 'k', streamKeyId: 1, groupId: null }];
        },
        listOutputs: () => [
            {
                id: '1-1',
                pipelineId: 1,
                seq: 1,
                name: 'YouTube main',
                desiredState: 'running',
                videoEncoding: 'copy',
                url: DESTINATION,
                audioEncoding: 'copy',
                translation: null,
                lastError: null,
                hasErrorHistory: false,
            },
        ],
        getOutputErrorHistory: () => [],
    };
    const reporter = createKeyVaultReporter({
        getConfig: () => {
            if (world.config instanceof Error) throw world.config;
            return world.config;
        },
        getInstance: () => world.instance,
        db: fakeDb,
        health: {
            onSnapshot: (listener) => listeners.push(listener),
            getSnapshot: snapshot,
        },
        diagnostics,
        options,
        fetchFn,
    });
    reporters.push(reporter);
    return {
        reporter,
        world,
        events,
        listeners,
        emit: () => listeners.forEach((listener) => listener(snapshot())),
    };
}

const ok = () => Promise.resolve(new Response(null, { status: 200 }));

// A fetch that records the requests and answers with whatever `respond` returns.
function recordingFetch(respond = ok) {
    const calls = [];
    const fetchFn = (url, init) => {
        calls.push({ url, init, at: Date.now(), body: JSON.parse(init.body) });
        return respond(calls.length, init);
    };
    return { calls, fetchFn };
}

describe('Key Vault reporter', () => {
    test('is off without saved settings: nothing sent, nothing logged', async () => {
        const { calls, fetchFn } = recordingFetch();
        const h = setup({ fetchFn, config: null });
        h.reporter.start();
        h.emit();
        await wait(FAST.heartbeatMs * 1.5);
        assert.equal(calls.length, 0);
        assert.deepEqual(h.events, []);
    });

    test('settings saved while running start the reports at once, without a restart', async () => {
        const { calls, fetchFn } = recordingFetch();
        const h = setup({ fetchFn, config: null });
        h.reporter.start();
        h.emit();
        await wait(50);
        assert.equal(calls.length, 0);

        h.world.config = CONFIG;
        h.reporter.reconfigure();
        await waitFor(() => calls.length === 1);
        assert.equal(calls[0].url, CONFIG.url);
        assert.equal(calls[0].init.headers.Authorization, `Bearer ${CONFIG.token}`);
        assert.ok(h.events.some((e) => e.event === 'key-vault-settings-changed' && e.enabled));
        // And the heartbeat runs from then on.
        await waitFor(() => calls.length === 2);
    });

    test('a changed token, secret and link apply to the next report; the old ones are not used again', async () => {
        const { calls, fetchFn } = recordingFetch();
        const h = setup({ fetchFn });
        h.reporter.start();
        h.emit();
        await waitFor(() => calls.length === 1);
        const oldHash = calls[0].body.outputs[0].hash;

        h.world.config = {
            ...CONFIG,
            url: 'https://other.example.invalid/ingest',
            token: 'another-token-0123456789',
            hashSecret: 'another-secret-0123456789',
        };
        h.reporter.reconfigure();
        await waitFor(() => calls.length === 2);
        assert.equal(calls[1].url, 'https://other.example.invalid/ingest');
        assert.equal(calls[1].init.headers.Authorization, 'Bearer another-token-0123456789');
        assert.notEqual(calls[1].body.outputs[0].hash, oldHash, 'hashed with the new secret');
        await wait(FAST.heartbeatMs * 0.5);
        assert.ok(calls.slice(1).every((c) => c.url === 'https://other.example.invalid/ingest'));
    });

    test('reports under the server name, and a rename shows in the next report', async () => {
        const { calls, fetchFn } = recordingFetch();
        const h = setup({ fetchFn });
        h.reporter.start();
        h.emit();
        await waitFor(() => calls.length === 1);
        assert.equal(calls[0].body.instance, 'test');

        h.world.instance = 'Studio B';
        await waitFor(() => calls.length === 2, 3000);
        assert.equal(calls[1].body.instance, 'Studio B', 'the heartbeat reads the name again');
    });

    test('settings changed while a report is on its way cancel it and send the new one', async () => {
        const hung = [];
        const { calls, fetchFn } = recordingFetch((n, init) =>
            n === 1
                ? new Promise((_resolve, reject) => {
                      hung.push(init);
                      init.signal.addEventListener('abort', () => reject(init.signal.reason));
                  })
                : ok(),
        );
        const h = setup({ fetchFn, options: { ...FAST, timeoutMs: 5000 } });
        h.reporter.start();
        h.emit();
        await waitFor(() => calls.length === 1);

        h.world.config = { ...CONFIG, token: 'replacement-token-0123456789' };
        h.reporter.reconfigure();
        await waitFor(() => calls.length === 2);
        assert.equal(hung[0].signal.aborted, true, 'the old report was abandoned');
        assert.equal(calls[1].init.headers.Authorization, 'Bearer replacement-token-0123456789');
        assert.ok(
            !h.events.some((e) => e.event === 'key-vault-report-failed'),
            'a report cancelled by a settings change is not a failure',
        );
    });

    test('removing the settings stops the reports and the heartbeat', async () => {
        const { calls, fetchFn } = recordingFetch();
        const h = setup({ fetchFn });
        h.reporter.start();
        h.emit();
        await waitFor(() => calls.length === 1);

        h.world.config = null;
        h.reporter.reconfigure();
        h.world.health = entry({ status: 'failed', lastError: `${Date.now()}\nboom` });
        h.emit();
        await wait(FAST.heartbeatMs * 1.5);
        assert.equal(calls.length, 1);
    });

    test('unchanged settings are not a change: nothing is sent early', async () => {
        const { calls, fetchFn } = recordingFetch();
        const h = setup({ fetchFn });
        h.reporter.start();
        h.emit();
        await waitFor(() => calls.length === 1);
        h.reporter.reconfigure();
        await wait(30);
        assert.equal(calls.length, 1);
    });

    test('saved settings that cannot be used leave the reporter off and say so once', async () => {
        const { calls, fetchFn } = recordingFetch();
        const h = setup({ fetchFn, config: new Error('url is not a valid URL') });
        h.reporter.start();
        h.emit();
        await wait(FAST.heartbeatMs * 1.5);
        assert.equal(calls.length, 0);
        const invalid = h.events.filter((e) => e.event === 'key-vault-settings-invalid');
        assert.equal(invalid.length, 1);
        assert.match(invalid[0].error, /not a valid URL/);
    });

    test('sends nothing before the first health poll, then a report right after it', async () => {
        const { calls, fetchFn } = recordingFetch();
        const h = setup({ fetchFn });
        h.reporter.start();
        await wait(FAST.heartbeatMs * 1.5);
        assert.equal(calls.length, 0, 'a heartbeat before the first poll has nothing true to say');
        h.emit();
        await waitFor(() => calls.length === 1);
        assert.equal(calls[0].body.outputs[0].status, 'running');
    });

    test('posts the payload with the bearer token, as JSON, without following redirects', async () => {
        const { calls, fetchFn } = recordingFetch();
        const h = setup({ fetchFn });
        h.reporter.start();
        h.emit();
        await waitFor(() => calls.length === 1);
        const [{ url, init, body }] = calls;
        assert.equal(url, CONFIG.url);
        assert.equal(init.method, 'POST');
        assert.equal(init.headers.Authorization, `Bearer ${CONFIG.token}`);
        assert.equal(init.headers['Content-Type'], 'application/json');
        assert.equal(init.redirect, 'error');
        assert.equal(body.version, 1);
        assert.equal(body.instance, 'test');
        assert.match(body.sentAt, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
        assert.equal(body.outputs.length, 1);
        assert.equal(body.outputs[0].hash, hashDestination(CONFIG.hashSecret, DESTINATION));
        assert.equal(body.outputs[0].pipeline, 'Hindi');
        assert.equal(body.outputs[0].output, 'YouTube main');
        assert.doesNotMatch(init.body, /youtube\.com|fake-0000/);
        assert.doesNotMatch(init.body, new RegExp(CONFIG.token));
        assert.doesNotMatch(init.body, new RegExp(CONFIG.hashSecret));
    });

    test('the report carries the input of every pipeline, and an input change is sent early', async () => {
        const { calls, fetchFn } = recordingFetch();
        const h = setup({ fetchFn, options: { ...FAST, minChangeIntervalMs: 50 } });
        h.reporter.start();
        h.emit();
        await waitFor(() => calls.length === 1);
        assert.deepEqual(
            calls[0].body.inputs.map(({ pipeline, status, message }) => ({
                pipeline,
                status,
                message,
            })),
            [{ pipeline: 'Hindi', status: 'running', message: '' }],
        );

        // The encoder disconnects while the output is still set to run: the input's status
        // changes, which is enough to send before the next heartbeat. (Wait until the first
        // report is done: a poll while one is on its way is checked at the next poll.)
        await wait(20);
        h.world.live = false;
        h.emit();
        await waitFor(() => calls.length === 2);
        assert.ok(calls[1].at - calls[0].at < FAST.heartbeatMs, 'sent before the next heartbeat');
        assert.deepEqual(
            calls[1].body.inputs.map(({ pipeline, status, message }) => ({
                pipeline,
                status,
                message,
            })),
            [{ pipeline: 'Hindi', status: 'error', message: 'No signal is arriving.' }],
        );
    });

    test('repeats the report every heartbeat when nothing changes', async () => {
        const { calls, fetchFn } = recordingFetch();
        const h = setup({ fetchFn });
        h.reporter.start();
        h.emit();
        await waitFor(() => calls.length === 1);
        for (let i = 0; i < 4; i++) {
            await wait(FAST.heartbeatMs / 8);
            h.emit(); // a poll with the same statuses is not a change
        }
        assert.equal(calls.length, 1);
        await waitFor(() => calls.length === 2);
        assert.ok(calls[1].at - calls[0].at >= FAST.heartbeatMs * 0.8);
    });

    test('sends a status change at once, but not more often than the minimum interval', async () => {
        const { calls, fetchFn } = recordingFetch();
        const h = setup({ fetchFn, options: { ...FAST, minChangeIntervalMs: 200 } });
        h.reporter.start();
        h.emit();
        await waitFor(() => calls.length === 1);

        h.world.health = entry({ warningReason: 'Timestamps are jumping' });
        h.emit();
        assert.equal(calls.length, 1, 'inside the interval: waits');
        h.world.health = entry({ status: 'failed', failures: 1, lastError: `${Date.now()}\nboom` });
        h.emit();
        await waitFor(() => calls.length === 2);
        assert.ok(calls[1].at - calls[0].at >= 190, 'at most one report per interval');
        assert.equal(calls[1].body.outputs[0].status, 'error', 'the latest status is sent');
        await wait(250);
        assert.equal(calls.length, 2, 'one report for the two changes');
    });

    test('a change after a quiet spell is sent immediately', async () => {
        const { calls, fetchFn } = recordingFetch();
        const h = setup({ fetchFn });
        h.reporter.start();
        h.emit();
        await waitFor(() => calls.length === 1);
        await wait(FAST.minChangeIntervalMs + 20);
        h.world.live = false; // the running output now warns: input not live
        h.emit();
        await waitFor(() => calls.length === 2);
        assert.equal(calls[1].body.outputs[0].status, 'warning');
        assert.ok(calls[1].at - calls[0].at < FAST.heartbeatMs);
    });

    test('a failing receiver is not retried and is logged once per episode', async () => {
        const { calls, fetchFn } = recordingFetch(() =>
            Promise.reject(
                new TypeError('fetch failed', {
                    cause: new Error('connect ECONNREFUSED 127.0.0.1:9'),
                }),
            ),
        );
        const h = setup({ fetchFn });
        h.reporter.start();
        h.emit();
        await waitFor(() => h.events.some((e) => e.event === 'key-vault-report-failed'));
        assert.equal(calls.length, 1, 'the next try is the next heartbeat');

        // Three more heartbeats fail the same way: no more log lines.
        await waitFor(() => calls.length >= 4, 5000);
        const failed = h.events.filter((e) => e.event === 'key-vault-report-failed');
        assert.equal(failed.length, 1);
        assert.match(failed[0].error, /ECONNREFUSED/);
        assert.equal(failed[0].instance, 'test');
        assert.equal(failed[0].endpoint, 'https://kv.example.invalid/functions/v1/ingest');
        assert.equal(h.events.filter((e) => e.event === 'key-vault-report-recovered').length, 0);
    });

    test('logs one recovery when a report goes through again, and a new episode after that', async () => {
        let failing = true;
        const { calls, fetchFn } = recordingFetch(() =>
            failing ? Promise.resolve(new Response(null, { status: 503 })) : ok(),
        );
        const h = setup({ fetchFn });
        h.reporter.start();
        h.emit();
        await waitFor(() => calls.length >= 2); // two failed reports
        failing = false;
        await waitFor(() => h.events.some((e) => e.event === 'key-vault-report-recovered'));
        const recovered = h.events.find((e) => e.event === 'key-vault-report-recovered');
        assert.ok(recovered.failedReports >= 2);
        assert.ok(recovered.downMs > 0);

        // Good reports after the recovery log nothing.
        const logged = h.events.length;
        const sent = calls.length;
        await waitFor(() => calls.length >= sent + 2);
        assert.equal(h.events.length, logged);

        failing = true;
        await waitFor(
            () => h.events.filter((e) => e.event === 'key-vault-report-failed').length === 2,
        );
    });

    test('a client error such as a wrong token is logged with its status', async () => {
        const { calls, fetchFn } = recordingFetch(() =>
            Promise.resolve(new Response('no', { status: 401 })),
        );
        const h = setup({ fetchFn });
        h.reporter.start();
        h.emit();
        await waitFor(() => h.events.some((e) => e.event === 'key-vault-report-failed'));
        assert.equal(calls.length, 1);
        const failed = h.events.find((e) => e.event === 'key-vault-report-failed');
        assert.equal(failed.status, 401);
    });

    test('a receiver that never answers times out and does not block anything else', async () => {
        const { calls, fetchFn } = recordingFetch(
            (_n, init) =>
                new Promise((_resolve, reject) => {
                    init.signal.addEventListener('abort', () => reject(init.signal.reason));
                }),
        );
        const h = setup({ fetchFn });
        h.reporter.start();
        const startedAt = Date.now();
        h.emit(); // returns at once: the poll that triggered the report is not held up
        assert.ok(Date.now() - startedAt < 50);
        await waitFor(() => h.events.some((e) => e.event === 'key-vault-report-failed'));
        assert.equal(calls.length, 1);
        assert.match(h.events[1].error, /timed out after 100 ms/);
    });

    test('only one report is on its way at a time', async () => {
        let release = () => {};
        const { calls, fetchFn } = recordingFetch(
            () =>
                new Promise(
                    (resolve) => (release = () => resolve(new Response(null, { status: 200 }))),
                ),
        );
        const h = setup({
            fetchFn,
            options: { ...FAST, timeoutMs: 5000, minChangeIntervalMs: 10 },
        });
        h.reporter.start();
        h.emit();
        await waitFor(() => calls.length === 1);
        h.world.live = false;
        h.emit();
        h.emit();
        await wait(60);
        assert.equal(calls.length, 1, 'no second request while the first is open');
        release();
        await waitFor(() => calls.length === 2);
        assert.equal(calls[1].body.outputs[0].status, 'warning', 'the change is sent afterwards');
    });

    test('a failure to build the report is contained, logged once and recovers', async () => {
        const { calls, fetchFn } = recordingFetch();
        const h = setup({ fetchFn });
        h.world.throwOnList = true;
        h.reporter.start();
        h.emit(); // does not throw out of the health poll
        h.emit();
        await wait(FAST.heartbeatMs * 2.5);
        assert.equal(calls.length, 0);
        const failures = h.events.filter((e) => e.event === 'key-vault-report-build-failed');
        assert.equal(failures.length, 1);
        assert.match(failures[0].error, /database is locked/);

        h.world.throwOnList = false;
        await waitFor(() => calls.length >= 1);
        assert.ok(h.events.some((e) => e.event === 'key-vault-report-build-recovered'));
    });

    test('keeps tokens, secrets and destinations out of the log', async () => {
        const { fetchFn } = recordingFetch(() => Promise.reject(new Error('boom')));
        const h = setup({ fetchFn });
        h.reporter.start();
        h.emit();
        await waitFor(() => h.events.some((e) => e.event === 'key-vault-report-failed'));
        const log = JSON.stringify(h.events);
        for (const secret of [CONFIG.token, CONFIG.hashSecret, 'fake-0000', 'project=fake']) {
            assert.ok(!log.includes(secret), `${secret} must not be logged`);
        }
        assert.ok(h.events.some((e) => e.event === 'key-vault-reporter-started'));
    });

    test('a shutdown stops the timers and abandons the report on its way', async () => {
        const { calls, fetchFn } = recordingFetch(
            (_n, init) =>
                new Promise((_resolve, reject) => {
                    init.signal.addEventListener('abort', () => reject(init.signal.reason));
                }),
        );
        const h = setup({ fetchFn, options: { ...FAST, timeoutMs: 10_000 } });
        h.reporter.start();
        h.emit();
        await waitFor(() => calls.length === 1);
        h.reporter.shutdown();
        await wait(FAST.heartbeatMs * 1.5);
        h.emit();
        assert.equal(calls.length, 1);
        assert.equal(h.events.filter((e) => e.event === 'key-vault-report-failed').length, 0);
    });
});

describe('Key Vault reporter status', () => {
    const reply = (status, body) => () => Promise.resolve(new Response(body ?? null, { status }));

    test('is null while the reports are off', () => {
        const h = setup({ fetchFn: recordingFetch().fetchFn, config: null });
        h.reporter.start();
        assert.equal(h.reporter.status(), null);
    });

    test('waits for the first answer, then is ok with the time of the last report', async () => {
        const { calls, fetchFn } = recordingFetch();
        const h = setup({ fetchFn });
        h.reporter.start();
        assert.deepEqual(h.reporter.status(), {
            state: 'waiting',
            lastReportAtMs: null,
            problem: null,
            failingSinceMs: null,
            skipped: null,
        });
        h.emit();
        await waitFor(() => calls.length === 1);
        await waitFor(() => h.reporter.status().state === 'ok');
        const status = h.reporter.status();
        assert.ok(Math.abs(status.lastReportAtMs - Date.now()) < 2000);
        assert.equal(status.problem, null);
        assert.equal(status.skipped, null, 'an answer that does not say leaves it unknown');
    });

    test('says what Key Vault left out, from the answer it gives', async () => {
        const { fetchFn } = recordingFetch(reply(200, '{"ok":true,"stored":1,"skipped":2}'));
        const h = setup({ fetchFn });
        h.reporter.start();
        h.emit();
        await waitFor(() => h.reporter.status().state === 'ok');
        assert.equal(h.reporter.status().skipped, 2);
    });

    test('an answer that is not what was expected still counts as a report that went through', async () => {
        for (const body of ['not json', '{"skipped":"many"}', '{"skipped":-1}', '[]']) {
            const { fetchFn } = recordingFetch(reply(200, body));
            const h = setup({ fetchFn });
            h.reporter.start();
            h.emit();
            await waitFor(() => h.reporter.status().state === 'ok');
            assert.equal(h.reporter.status().skipped, null, body);
        }
    });

    test('a huge answer is cut off and does not stop the report from counting', async () => {
        const { fetchFn } = recordingFetch(reply(200, 'x'.repeat(1_000_000)));
        const h = setup({ fetchFn });
        h.reporter.start();
        h.emit();
        await waitFor(() => h.reporter.status().state === 'ok');
        assert.equal(h.reporter.status().skipped, null);
    });

    test('names the problem and when it began, and keeps the last good report', async () => {
        let answer = 200;
        const { calls, fetchFn } = recordingFetch(() =>
            Promise.resolve(new Response(null, { status: answer })),
        );
        const h = setup({ fetchFn });
        h.reporter.start();
        h.emit();
        await waitFor(() => h.reporter.status().state === 'ok');
        const good = h.reporter.status().lastReportAtMs;

        answer = 401;
        await waitFor(() => h.reporter.status().state === 'failing', 5000);
        const failing = h.reporter.status();
        assert.match(failing.problem, /refused the secret \(HTTP 401\)/);
        assert.equal(failing.lastReportAtMs, good);
        assert.ok(failing.failingSinceMs >= good);

        // Further failures keep when it began.
        const sent = calls.length;
        await waitFor(() => calls.length >= sent + 2, 5000);
        assert.equal(h.reporter.status().failingSinceMs, failing.failingSinceMs);

        answer = 200;
        await waitFor(() => h.reporter.status().state === 'ok', 5000);
        const recovered = h.reporter.status();
        assert.equal(recovered.problem, null);
        assert.equal(recovered.failingSinceMs, null);
        assert.ok(recovered.lastReportAtMs > good);
    });

    test('a link whose host does not exist is named as such', async () => {
        const { fetchFn } = recordingFetch(() =>
            Promise.reject(
                new TypeError('fetch failed', {
                    cause: new Error('getaddrinfo ENOTFOUND kv.example.invalid'),
                }),
            ),
        );
        const h = setup({ fetchFn });
        h.reporter.start();
        h.emit();
        await waitFor(() => h.reporter.status().state === 'failing');
        assert.match(h.reporter.status().problem, /host in the link was not found/);
        assert.equal(h.reporter.status().lastReportAtMs, null);
    });

    test('a failure to build the report shows as a problem too, and clears when it recovers', async () => {
        const { calls, fetchFn } = recordingFetch();
        const h = setup({ fetchFn });
        h.world.throwOnList = true;
        h.reporter.start();
        h.emit();
        await waitFor(() => h.reporter.status().state === 'failing');
        assert.match(h.reporter.status().problem, /could not build the report/);
        assert.equal(calls.length, 0);

        h.world.throwOnList = false;
        await waitFor(() => h.reporter.status().state === 'ok', 5000);
        assert.equal(h.reporter.status().problem, null);
    });

    test('saving new settings starts the status again', async () => {
        const { fetchFn } = recordingFetch(reply(503));
        const h = setup({ fetchFn });
        h.reporter.start();
        h.emit();
        await waitFor(() => h.reporter.status().state === 'failing');

        h.world.config = { ...CONFIG, url: 'https://other.example.invalid/ingest' };
        h.reporter.reconfigure();
        const status = h.reporter.status();
        assert.equal(status.problem, null);
        assert.equal(status.lastReportAtMs, null);
        assert.equal(status.state, 'waiting');

        h.world.config = null;
        h.reporter.reconfigure();
        assert.equal(h.reporter.status(), null);
    });
});

describe('Key Vault reporter against a local receiver', () => {
    let server;
    afterEach(async () => {
        if (server?.listening) await new Promise((resolve) => server.close(resolve));
        server?.closeAllConnections?.();
    });

    function listen(handler) {
        const requests = [];
        server = http.createServer((req, res) => {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                const record = { method: req.method, url: req.url, headers: req.headers, body };
                requests.push(record);
                handler(record, res, requests.length);
            });
        });
        return new Promise((resolve) =>
            server.listen(0, '127.0.0.1', () =>
                resolve({ requests, url: `http://127.0.0.1:${server.address().port}/ingest` }),
            ),
        );
    }

    test('delivers the heartbeat with the headers and body Key Vault expects', async () => {
        const { requests, url } = await listen((_req, res) => res.writeHead(204).end());
        const h = setup({ config: { ...CONFIG, url }, fetchFn: undefined });
        h.reporter.start();
        h.emit();
        await waitFor(() => requests.length === 1);
        const [request] = requests;
        assert.equal(request.method, 'POST');
        assert.equal(request.url, '/ingest');
        assert.equal(request.headers.authorization, `Bearer ${CONFIG.token}`);
        assert.equal(request.headers['content-type'], 'application/json');
        const payload = JSON.parse(request.body);
        assert.deepEqual(Object.keys(payload), [
            'version',
            'instance',
            'sentAt',
            'outputs',
            'inputs',
        ]);
        assert.deepEqual(Object.keys(payload.inputs[0]), [
            'pipeline',
            'status',
            'message',
            'sinceMs',
        ]);
        assert.deepEqual(Object.keys(payload.outputs[0]), [
            'hash',
            'pipeline',
            'output',
            'status',
            'message',
            'failures',
            'stoppedAfterFailures',
            'sinceMs',
        ]);
        assert.equal(payload.outputs[0].status, 'running');
        assert.equal(h.events.filter((e) => e.event.startsWith('key-vault-report-')).length, 0);
    });

    test('reads how many entries Key Vault left out from its real answer', async () => {
        const { requests, url } = await listen((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, stored: 1, skipped: 3 }));
        });
        const h = setup({ config: { ...CONFIG, url }, fetchFn: undefined });
        h.reporter.start();
        h.emit();
        await waitFor(() => requests.length === 1);
        await waitFor(() => h.reporter.status().state === 'ok');
        assert.equal(h.reporter.status().skipped, 3);
    });

    test('does not follow a redirect with the token', async () => {
        const otherRequests = [];
        const other = http.createServer((req, res) => {
            otherRequests.push(req.headers);
            res.writeHead(200).end();
        });
        await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
        try {
            const { url } = await listen((_req, res) =>
                res
                    .writeHead(307, { Location: `http://127.0.0.1:${other.address().port}/steal` })
                    .end(),
            );
            const h = setup({ config: { ...CONFIG, url } });
            h.reporter.start();
            h.emit();
            await waitFor(() => h.events.some((e) => e.event === 'key-vault-report-failed'));
            assert.equal(otherRequests.length, 0);
        } finally {
            await new Promise((resolve) => other.close(resolve));
        }
    });

    test('survives a receiver that errors, then picks up when it works', async () => {
        let broken = true;
        const { requests, url } = await listen((_req, res) =>
            res.writeHead(broken ? 500 : 200).end(),
        );
        const h = setup({ config: { ...CONFIG, url } });
        h.reporter.start();
        h.emit();
        await waitFor(() => h.events.some((e) => e.event === 'key-vault-report-failed'));
        broken = false;
        await waitFor(() => h.events.some((e) => e.event === 'key-vault-report-recovered'));
        assert.ok(requests.length >= 2);
    });

    test('survives a receiver that is gone', async () => {
        const { url } = await listen((_req, res) => res.end());
        await new Promise((resolve) => server.close(resolve));
        const h = setup({ config: { ...CONFIG, url } });
        h.reporter.start();
        h.emit();
        await waitFor(() => h.events.some((e) => e.event === 'key-vault-report-failed'));
        const failed = h.events.find((e) => e.event === 'key-vault-report-failed');
        assert.match(failed.error, /fetch failed|ECONNREFUSED/);
    });
});
