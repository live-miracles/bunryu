'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { counterDelta, legQualityHealth, srtIntervalAlerts } = require('../src/utils/srtLinkAlerts');

const sample = (over = {}) => ({
    recvLossTotal: 0,
    recvDropTotal: 0,
    recvUniquePacketsTotal: 10_000,
    retransTotal: 0,
    belatedTotal: 0,
    latencyMs: 200,
    recvBitrateKbps: 6000,
    forwardedPackets: 10_000,
    ...over,
});
// One interval: 1000 packets received and forwarded, unless the test says otherwise.
const interval = (current = {}, previous = {}) =>
    srtIntervalAlerts(
        sample(previous),
        sample({
            recvUniquePacketsTotal: 11_000,
            forwardedPackets: 11_000,
            ...current,
        }),
        5000,
    );
const codes = (alerts) => alerts.map((a) => a.code);

describe('counterDelta', () => {
    test('grows normally, restarts from zero with the relay stream, and needs both ends', () => {
        assert.equal(counterDelta(15, 10), 5);
        assert.equal(counterDelta(3, 10), 3, 'the counter was reset');
        assert.equal(counterDelta(null, 10), null);
        assert.equal(counterDelta(10, null), null);
        assert.equal(counterDelta(10, undefined), null);
    });
});

describe('srtIntervalAlerts', () => {
    test('a steady link has no alerts', () => {
        assert.deepEqual(interval(), []);
    });

    test('dropped packets are reported with the count, and outrank loss', () => {
        const one = interval({ recvDropTotal: 1, recvLossTotal: 500 });
        assert.deepEqual(codes(one), ['srt-packets-dropped']);
        assert.equal(one[0].message, 'SRT input dropped 1 packet in the last health interval.');
        assert.match(interval({ recvDropTotal: 7 })[0].message, /dropped 7 packets/);
    });

    test('loss is reported from 1% of the interval, not below', () => {
        assert.deepEqual(interval({ recvLossTotal: 9 }), []);
        const alerts = interval({ recvLossTotal: 10 });
        assert.deepEqual(codes(alerts), ['srt-packet-loss']);
        assert.match(alerts[0].message, /1\.0%/);
    });

    test('retransmissions are reported from 5% of the packets received', () => {
        assert.deepEqual(interval({ retransTotal: 49 }), []);
        assert.deepEqual(codes(interval({ retransTotal: 50 })), ['srt-retransmissions']);
    });

    test('belated packets are reported above 100 in the interval, and need both counters', () => {
        assert.deepEqual(interval({ belatedTotal: 100 }), []);
        assert.deepEqual(codes(interval({ belatedTotal: 101 })), ['srt-belated-packets']);
        assert.deepEqual(interval({ belatedTotal: 5000 }, { belatedTotal: null }), []);
    });

    test('latency: at the 1.5 s target, or 1.5x the last sample plus 100 ms', () => {
        assert.deepEqual(codes(interval({ latencyMs: 1500 })), ['srt-latency-spike']);
        assert.deepEqual(interval({ latencyMs: 1499 }, { latencyMs: 1499 }), []);
        assert.deepEqual(interval({ latencyMs: 399 }, { latencyMs: 200 }), []);
        assert.deepEqual(codes(interval({ latencyMs: 400 }, { latencyMs: 200 })), [
            'srt-latency-spike',
        ]);
        assert.deepEqual(interval({ latencyMs: null }), []);
    });

    test('a bitrate collapse needs a real bitrate before it and 60% or less after', () => {
        const alerts = interval({ recvBitrateKbps: 3600 });
        assert.deepEqual(codes(alerts), ['input-bitrate-collapse']);
        assert.equal(alerts[0].message, 'Input bitrate dropped from 6 Mb/s to 3.6 Mb/s.');
        assert.deepEqual(interval({ recvBitrateKbps: 3601 }), []);
        assert.deepEqual(interval({ recvBitrateKbps: 100 }, { recvBitrateKbps: 400 }), []);
        assert.deepEqual(interval({ recvBitrateKbps: null }), []);
    });

    test('a relay that receives but forwards nothing is stalled', () => {
        const alerts = interval({ forwardedPackets: 10_000 });
        assert.deepEqual(codes(alerts), ['relay-forwarding-stalled']);
        // Nothing received either: the input is just quiet, not a stalled relay.
        assert.deepEqual(
            interval({ recvUniquePacketsTotal: 10_000, forwardedPackets: 10_000 }),
            [],
        );
    });

    test('counters that restarted are read as growth from zero, not a negative interval', () => {
        const alerts = interval(
            { recvDropTotal: 4, recvUniquePacketsTotal: 500 },
            { recvDropTotal: 90 },
        );
        assert.deepEqual(codes(alerts), ['srt-packets-dropped']);
        assert.match(alerts[0].message, /dropped 4 packets/);
    });

    test('every alert carries the time it was raised', () => {
        for (const alert of interval({ recvDropTotal: 3, retransTotal: 100 })) {
            assert.equal(alert.sinceMs, 5000);
            assert.equal(alert.severity, 'warning');
        }
    });
});

describe('legQualityHealth', () => {
    const OK = { health: 'ok', reason: null };
    const window = (over = {}) => ({
        receivedPackets: 1000,
        lossPackets: 0,
        dropPackets: 0,
        retransmittedPackets: 0,
        ...over,
    });
    const verdict = (over, latencyMs = 200, state = OK, noun = 'Leg') =>
        legQualityHealth(window(over), latencyMs, noun, state);

    test('a clean minute leaves the state as it was', () => {
        assert.deepEqual(verdict({}), OK);
        const waiting = { health: 'warn', reason: 'Leg is pending.' };
        assert.deepEqual(verdict({}, 200, waiting), waiting);
    });

    test('fewer than 100 packets prove nothing', () => {
        assert.deepEqual(verdict({ receivedPackets: 99, dropPackets: 99, lossPackets: 99 }), OK);
    });

    test('drops from 5%, or 1000 packets, are an error', () => {
        const heavy = verdict({ dropPackets: 50 });
        assert.equal(heavy.health, 'error');
        assert.equal(heavy.reason, 'Leg packet drops are 5.0% over the last minute (50 packets).');
        assert.equal(verdict({ receivedPackets: 100_000, dropPackets: 1000 }).health, 'error');
        assert.equal(verdict({ receivedPackets: 100_000, dropPackets: 999 }).health, 'warn');
    });

    test('drops or loss from 1%, or 100 packets, are a warning', () => {
        const degraded = verdict({ lossPackets: 10 });
        assert.equal(degraded.health, 'warn');
        assert.equal(
            degraded.reason,
            'Leg packet quality is degraded over the last minute (1.0% loss, 0.0% drop).',
        );
        assert.equal(verdict({ dropPackets: 10 }).health, 'warn');
        assert.equal(verdict({ receivedPackets: 100_000, lossPackets: 100 }).health, 'warn');
        assert.equal(verdict({ lossPackets: 9 }).health, 'ok');
    });

    test('retransmissions from 5% are a warning', () => {
        assert.equal(verdict({ retransmittedPackets: 49 }).health, 'ok');
        const v = verdict({ retransmittedPackets: 50 }, 200, OK, 'Connection');
        assert.equal(v.health, 'warn');
        assert.equal(v.reason, 'Connection retransmissions are 5.0% over the last minute.');
    });

    test('latency at 1.5 s or more is a warning that replaces the reason', () => {
        assert.equal(verdict({}, 1499).health, 'ok');
        const v = verdict({ lossPackets: 20 }, 1700);
        assert.equal(v.health, 'warn');
        assert.equal(v.reason, 'Leg latency is high (1700 ms).');
        assert.equal(verdict({}, null).health, 'ok');
    });

    test('an error is never downgraded to a warning', () => {
        const down = { health: 'error', reason: 'Leg state is unknown.' };
        assert.equal(verdict({ lossPackets: 20 }, 200, down).health, 'error');
        assert.equal(verdict({}, 2000, down).health, 'error');
    });
});
