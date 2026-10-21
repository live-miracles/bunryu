'use strict';

// Seeded random-mutation tests for the code that parses text or JSON from outside
// the process: `ss` output, destination URLs and names from the API, the relay's
// config file and its /status JSON. They assert only that the code never throws,
// never hangs and returns well-formed values; a failure prints the seed and input
// so it can be turned into a regression test. No new dependency: the mutator is
// a small deterministic PRNG, so `npm test` stays stable.

const { after, before, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunryu-malformed-'));
const originalCwd = process.cwd();
process.chdir(tempDir);
fs.writeFileSync(
    path.join(tempDir, 'bunryu.json'),
    JSON.stringify({ port: 8080, database_path: './db.sqlite', srs_config_path: './srs.conf' }),
);
fs.writeFileSync(path.join(tempDir, 'srs.conf'), 'listen 1935;\n');

const { parseTcpSocketSnapshot } = require('../src/services/outputSockets');
const { classifyAddress } = require('../src/utils/destination');
const { parseName, isCleanUrlText } = require('../src/utils/inputLimits');
const { validateOutputUrl } = require('../src/utils/ffmpeg');
const { normalizeRelayConfig } = require('../src/utils/relayConfig');
const { createSrtRelayService } = require('../src/services/srtRelay');

const SEED = 0x5eed1234;
const ITERATIONS = 3000;
const TIME_BUDGET_MS = 50;

after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

// mulberry32: tiny seeded PRNG.
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const TOKENS = [
    '',
    ' ',
    '\n',
    '\r\n',
    '\t',
    '\0',
    '\x1b[31m',
    ':',
    '::',
    '[',
    ']',
    '[::1]:',
    '0.0.0.0',
    'pid=',
    'pid=0',
    'pid=99999999999999999999',
    'users:((',
    '))',
    '-1',
    '999999999999',
    'NaN',
    'rtmp://',
    'srt://',
    '@',
    '%',
    '<script>',
    '"',
    '‮',
    '\ud800',
    'a'.repeat(5000),
];

function mutateString(rand, seedText) {
    let s = seedText;
    const ops = 1 + Math.floor(rand() * 6);
    for (let i = 0; i < ops; i++) {
        const at = Math.floor(rand() * (s.length + 1));
        const token = TOKENS[Math.floor(rand() * TOKENS.length)];
        switch (Math.floor(rand() * 4)) {
            case 0:
                s = s.slice(0, at) + token + s.slice(at);
                break;
            case 1:
                s = s.slice(0, at) + s.slice(at + 1 + Math.floor(rand() * 8));
                break;
            case 2:
                s = s.slice(0, at) + s.slice(Math.floor(rand() * (s.length + 1)));
                break;
            default:
                s = s + s.slice(at, at + Math.floor(rand() * 200));
        }
    }
    return s;
}

const ODD_VALUES = [
    null,
    undefined,
    true,
    0,
    -1,
    1.5,
    1e308,
    -1e308,
    Number.MAX_SAFE_INTEGER,
    '',
    'x',
    'running',
    '\n',
    [],
    [null],
    {},
    { a: 1 },
];

// Randomly replaces, deletes or adds fields anywhere in a JSON-like value.
function mutateJson(rand, value, depth = 0) {
    if (Array.isArray(value)) {
        const out = value.map((v) => (rand() < 0.3 ? mutateJson(rand, v, depth + 1) : v));
        if (rand() < 0.15) out.push(ODD_VALUES[Math.floor(rand() * ODD_VALUES.length)]);
        if (rand() < 0.1) out.length = 0;
        return out;
    }
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            const roll = rand();
            if (roll < 0.1) continue;
            if (roll < 0.3) out[k] = ODD_VALUES[Math.floor(rand() * ODD_VALUES.length)];
            else if (roll < 0.6 && depth < 6) out[k] = mutateJson(rand, v, depth + 1);
            else out[k] = v;
        }
        if (rand() < 0.1) out.extra = ODD_VALUES[Math.floor(rand() * ODD_VALUES.length)];
        return out;
    }
    return rand() < 0.3 ? ODD_VALUES[Math.floor(rand() * ODD_VALUES.length)] : value;
}

// Runs fn over generated inputs; any throw or slow call fails with the input.
function fuzz(name, gen, check) {
    const rand = rng(SEED);
    for (let i = 0; i < ITERATIONS; i++) {
        const input = gen(rand);
        const started = performance.now();
        try {
            check(input);
        } catch (err) {
            assert.fail(
                `${name} failed (seed ${SEED}, iteration ${i}): ${err.message}\ninput: ${JSON.stringify(input)?.slice(0, 500)}`,
            );
        }
        const took = performance.now() - started;
        assert.ok(
            took < TIME_BUDGET_MS,
            `${name} took ${took.toFixed(1)} ms (seed ${SEED}, iteration ${i}) for input: ${JSON.stringify(input)?.slice(0, 500)}`,
        );
    }
}

const SS_SAMPLE = [
    'ESTAB 0 0 10.0.0.5:48210 203.0.113.7:1935 users:(("ffmpeg",pid=4242,fd=7))',
    'ESTAB 0 1048576 10.0.0.5:48212 [2001:db8::1]:443 users:(("ffmpeg",pid=4243,fd=9),("ffmpeg",pid=4244,fd=9))',
    'CLOSE-WAIT 1 0 127.0.0.1:1935 127.0.0.1:50112 users:(("srs",pid=17,fd=22))',
].join('\n');

describe('malformed input', () => {
    test('parseTcpSocketSnapshot copes with mutated ss output', () => {
        fuzz(
            'parseTcpSocketSnapshot',
            (rand) => mutateString(rand, SS_SAMPLE),
            (text) => {
                const result = parseTcpSocketSnapshot(text);
                assert.ok(result instanceof Map);
                for (const [pid, sockets] of result) {
                    assert.ok(Number.isFinite(pid));
                    for (const s of sockets) {
                        assert.equal(typeof s.state, 'string');
                        assert.equal(typeof s.peerAddress, 'string');
                        assert.ok(Number.isFinite(s.peerPort));
                    }
                }
            },
        );
    });

    test('classifyAddress gives a class for every IP the resolver can return', () => {
        const hex = (rand) => Math.floor(rand() * 65536).toString(16);
        fuzz(
            'classifyAddress',
            (rand) => {
                switch (Math.floor(rand() * 4)) {
                    case 0:
                        return [0, 0, 0, 0].map(() => Math.floor(rand() * 256)).join('.');
                    case 1:
                        return Array.from({ length: 8 }, () => hex(rand)).join(':');
                    case 2:
                        return `::ffff:${[0, 0, 0, 0].map(() => Math.floor(rand() * 256)).join('.')}`;
                    default:
                        return `${hex(rand)}::${hex(rand)}`;
                }
            },
            (address) => {
                assert.ok(['blocked', 'loopback', 'other'].includes(classifyAddress(address)));
            },
        );
    });

    test('parseName returns a bounded clean name or an error for any value', () => {
        fuzz(
            'parseName',
            (rand) =>
                rand() < 0.5
                    ? mutateString(rand, 'Main stage')
                    : ODD_VALUES[Math.floor(rand() * ODD_VALUES.length)],
            (value) => {
                const result = parseName(value);
                if ('error' in result) return assert.equal(typeof result.error, 'string');
                assert.ok(result.name.length > 0 && result.name.length <= 80);
                // eslint-disable-next-line no-control-regex
                assert.ok(!/[\u0000-\u001f\u007f]/.test(result.name));
            },
        );
    });

    test('validateOutputUrl accepts only one-line rtmp/rtmps/srt URL text', () => {
        fuzz(
            'validateOutputUrl',
            (rand) => mutateString(rand, 'rtmp://a.rtmp.youtube.com/live2/abcd-1234'),
            (url) => {
                const ok = validateOutputUrl(url);
                assert.equal(typeof ok, 'boolean');
                if (!ok) return;
                assert.ok(isCleanUrlText(url));
                assert.ok(/^(rtmps?|srt):\/\//.test(url));
                assert.ok(!/[\s<>"]/.test(url) && url.length <= 2048);
            },
        );
    });

    test('normalizeRelayConfig always returns a complete config', () => {
        const sample = { input_port: 10081, output_host: '127.0.0.1', passphrase: 'x' };
        fuzz(
            'normalizeRelayConfig',
            (rand) => mutateJson(rand, sample),
            (raw) => {
                const config = normalizeRelayConfig(raw);
                for (const key of ['input_port', 'output_port', 'status_port']) {
                    assert.ok(
                        Number.isInteger(config[key]) && config[key] > 0 && config[key] <= 65535,
                    );
                }
                for (const key of ['input_host', 'output_host', 'passphrase']) {
                    assert.equal(typeof config[key], 'string');
                }
            },
        );
    });
});

const LEG = {
    ip: '203.0.113.10',
    port: 10081,
    state: 'running',
    rttMs: 4.1,
    latencyMs: 240,
    recvPacketsTotal: 60,
    recvUniquePacketsTotal: 59,
    recvLossTotal: 1,
    recvDropTotal: 0,
    retransTotal: 1,
    bandwidthMbps: 12.3,
    recvRateMbps: 0.47,
    belatedTotal: 0,
    belatedAvgMs: 0,
    undecryptTotal: 0,
    reorderDistance: 0,
    rcvBufMs: 221,
};

const STATUS = {
    pid: 12345,
    startedAtMs: 1,
    lastError: null,
    streamStates: [
        {
            streamId: '#!::r=live/key01,m=publish',
            inputActive: true,
            outputConnected: true,
            retryFailures: 0,
            forwardedPackets: 42,
            forwardedBytes: 65536,
            lastPacketAt: 2,
            lastInputPacketAt: 2,
            input: {
                bonded: true,
                peer: { ip: '203.0.113.10', port: 4000 },
                recvPacketsTotal: 120,
                latencyMs: 240,
                legs: [LEG, LEG],
            },
            output: { sentPacketsTotal: 40, sendLossTotal: 1, rttMs: 5.1, sndBufMs: 1 },
            lastError: null,
        },
    ],
};

describe('malformed relay status', () => {
    const originalFetch = global.fetch;
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);

    before(() => process.on('unhandledRejection', onUnhandled));
    after(() => {
        process.off('unhandledRejection', onUnhandled);
        global.fetch = originalFetch;
    });

    test('a mutated /status body never throws out of the poller or corrupts a stream status', async () => {
        const rand = rng(SEED);
        const seen = { running: 0, stopped: 0 };
        for (let i = 0; i < 400; i++) {
            const body =
                rand() < 0.1
                    ? mutateString(rand, JSON.stringify(STATUS))
                    : JSON.stringify(mutateJson(rand, STATUS));
            global.fetch = async () => new Response(body, { status: 200 });
            const service = createSrtRelayService();
            try {
                service.start();
                await new Promise((resolve) => setTimeout(resolve, 2));
                const stats = service.getStats();
                assert.ok(['running', 'stopped'].includes(stats.status), `status ${stats.status}`);
                seen[stats.status]++;
                // A rejected body must leave a reason, not a silent stop.
                if (stats.status !== 'running') assert.equal(typeof stats.lastError, 'string');
                const status = service.getStreamStatus('#!::r=live/key01,m=publish');
                assert.equal(typeof status.inputActive, 'boolean', `body: ${body.slice(0, 500)}`);
                assert.equal(typeof status.outputConnected, 'boolean');
                assert.ok(Array.isArray(status.input.legs));
            } finally {
                service.shutdown();
            }
        }
        // Guard against a vacuous run: the 2 ms wait must let the poll finish, and the
        // mutations must produce both bodies the poller accepts and ones it rejects.
        assert.ok(seen.running > 50 && seen.stopped > 5, JSON.stringify(seen));
        assert.deepEqual(unhandled, []);
    });
});
