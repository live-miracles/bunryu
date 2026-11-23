import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
    anyCounterReset,
    counterDelta,
    legQualityHealth,
    linkGrowth,
    percentOfReceived,
    srtIntervalAlerts,
    type LegHealth,
    type PipelineAlert,
    type RelayInputSample,
} from '../src/utils/srtLinkAlerts';

type LegWindow = Parameters<typeof legQualityHealth>[0];

const sample = (over: Partial<RelayInputSample> = {}): RelayInputSample => ({
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
const interval = (
    current: Partial<RelayInputSample> = {},
    previous: Partial<RelayInputSample> = {},
) =>
    srtIntervalAlerts(
        sample(previous),
        sample({
            recvUniquePacketsTotal: 11_000,
            forwardedPackets: 11_000,
            ...current,
        }),
        5000,
    );
const codes = (alerts: PipelineAlert[]) => alerts.map((a) => a.code);

describe('counterDelta', () => {
    test('grows normally, restarts from zero with the relay stream, and needs both ends', () => {
        assert.equal(counterDelta(15, 10), 5);
        assert.equal(counterDelta(3, 10), 3, 'the counter was reset');
        assert.equal(counterDelta(null, 10), null);
        assert.equal(counterDelta(10, null), null);
        assert.equal(counterDelta(10, undefined), null);
    });
});

describe('linkGrowth', () => {
    const counters = (over = {}) => ({
        received: 1000,
        loss: 10,
        drop: 0,
        retrans: 20,
        belated: 5,
        ...over,
    });

    test('is the growth of each counter since the previous poll', () => {
        const growth = linkGrowth(
            counters({ received: 2000, loss: 25, drop: 3, retrans: 50, belated: 5 }),
            counters(),
        );
        assert.deepEqual(growth, { received: 1000, loss: 15, drop: 3, retrans: 30, belated: 0 });
    });

    test('has nothing to say without a previous poll', () => {
        const growth = linkGrowth(counters(), undefined);
        assert.deepEqual(growth, {
            received: null,
            loss: null,
            drop: null,
            retrans: null,
            belated: null,
        });
    });

    test('takes the new value of a counter that restarted, and leaves the others alone', () => {
        const growth = linkGrowth(counters({ received: 300, loss: 12 }), counters());
        assert.equal(growth.received, 300, 'the stream restarted: all of it is new');
        assert.equal(growth.loss, 2, 'but this counter only grew');
    });

    test('keeps a counter the relay does not report as unknown', () => {
        const growth = linkGrowth(counters({ loss: null }), counters());
        assert.equal(growth.loss, null);
        assert.equal(growth.received, 0);
    });
});

describe('percentOfReceived', () => {
    test('is the share of the received packets, or unknown', () => {
        assert.equal(percentOfReceived(5, 1000), 0.5);
        assert.equal(percentOfReceived(0, 1000), 0);
        assert.equal(percentOfReceived(5, 0), null, 'nothing received');
        assert.equal(percentOfReceived(5, null), null);
        assert.equal(percentOfReceived(null, 1000), null);
    });
});

describe('anyCounterReset', () => {
    test('is true when any counter went down, ignoring ones that are null', () => {
        assert.equal(anyCounterReset([10, 5, null], [12, 5, 3]), false);
        assert.equal(anyCounterReset([10, 5, null], [12, 4, 3]), true);
        assert.equal(anyCounterReset([10, null], [2, null]), true);
        assert.equal(anyCounterReset([10, 5], [10, null]), false);
    });
});

describe('srtIntervalAlerts', () => {
    test('a steady link has no alerts', () => {
        assert.deepEqual(interval(), []);
    });

    test('dropped packets are reported with the count, and outrank loss', () => {
        const one = interval({ recvDropTotal: 1, recvLossTotal: 500 });
        assert.deepEqual(codes(one), ['srt-packets-dropped']);
        assert.equal(
            one[0].message,
            'SRT input packet drops are 0.1% (1 packet) in the last health interval.',
        );
        assert.match(interval({ recvDropTotal: 7 })[0].message, /drops are 0\.7% \(7 packets\)/);
        // A share too small for one decimal keeps its first digit; with nothing received there
        // is no share, so the count stands alone.
        assert.match(
            interval({ recvDropTotal: 1, recvUniquePacketsTotal: 110_000 })[0].message,
            /drops are 0\.001% \(1 packet\)/,
        );
        assert.equal(
            interval({ recvDropTotal: 1, recvUniquePacketsTotal: 10_000 })[0].message,
            'SRT input dropped 1 packet in the last health interval.',
        );
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

    test('belated packets are reported from 3% of those received (and 10), with both counters', () => {
        // The interval received 1000 packets.
        assert.deepEqual(interval({ belatedTotal: 29 }), []);
        const alerts = interval({ belatedTotal: 30 });
        assert.deepEqual(codes(alerts), ['srt-belated-packets']);
        assert.equal(
            alerts[0].message,
            'SRT belated packets are 3.0% (30 packets) in the last health interval.',
        );
        assert.deepEqual(interval({ belatedTotal: 5000 }, { belatedTotal: null }), []);
        // Ten packets at least: 5% of a 100-packet interval is five packets.
        assert.deepEqual(interval({ belatedTotal: 5, recvUniquePacketsTotal: 100 }), []);
    });

    test('latency: only the negotiated value at 5 s or more, never a change from the last sample', () => {
        const high = interval({ latencyMs: 5000 });
        assert.deepEqual(codes(high), ['srt-high-latency']);
        assert.equal(high[0].message, 'SRT latency is 5000 ms, above 5000 ms.');
        assert.deepEqual(interval({ latencyMs: 4999 }, { latencyMs: 4999 }), []);
        // A long or lossy link negotiates 2 s or more on purpose, and a reconnect with another
        // setting is a new value, not a spike.
        assert.deepEqual(interval({ latencyMs: 2000 }, { latencyMs: 200 }), []);
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
        assert.match(alerts[0].message, /drops are 0\.8% \(4 packets\)/);
    });

    test('every alert carries the time it was raised', () => {
        for (const alert of interval({ recvDropTotal: 3, retransTotal: 100 })) {
            assert.equal(alert.sinceMs, 5000);
            assert.equal(alert.severity, 'warning');
        }
    });
});

describe('srtIntervalAlerts after the relay stream restarted', () => {
    test('counts what the new stream received instead of skipping the interval', () => {
        // 10 000 packets before, 1 000 after the restart, of which 20 were lost (2%).
        const alerts = srtIntervalAlerts(
            sample(),
            sample({ recvUniquePacketsTotal: 1_000, forwardedPackets: 1_000, recvLossTotal: 20 }),
            5000,
        );
        assert.deepEqual(codes(alerts), ['srt-packet-loss']);
    });

    test('does not read the restart as a relay that forwards nothing', () => {
        const alerts = srtIntervalAlerts(
            sample(),
            sample({ recvUniquePacketsTotal: 1_000, forwardedPackets: 1_000 }),
            5000,
        );
        assert.deepEqual(alerts, []);
    });

    test('still reports a relay that receives after the restart but forwards nothing', () => {
        const alerts = srtIntervalAlerts(
            sample({ forwardedPackets: 500 }),
            sample({ recvUniquePacketsTotal: 1_000, forwardedPackets: 500 }),
            5000,
        );
        assert.deepEqual(codes(alerts), ['relay-forwarding-stalled']);
    });

    test('does not read the restart as a belated-packet burst', () => {
        const alerts = srtIntervalAlerts(
            sample({ belatedTotal: 5000 }),
            sample({
                belatedTotal: 3,
                recvUniquePacketsTotal: 1_000,
                forwardedPackets: 1_000,
            }),
            5000,
        );
        assert.deepEqual(alerts, []);
    });
});

describe('legQualityHealth', () => {
    const OK: LegHealth = { health: 'ok', reason: null };
    const window = (over: Partial<LegWindow> = {}): LegWindow => ({
        receivedPackets: 1000,
        lossPackets: 0,
        dropPackets: 0,
        retransmittedPackets: 0,
        ...over,
    });
    const verdict = (
        over: Partial<LegWindow>,
        latencyMs: number | null = 200,
        state: LegHealth = OK,
        noun = 'Leg',
    ) => legQualityHealth(window(over), latencyMs, noun, state);

    test('a clean minute leaves the state as it was', () => {
        assert.deepEqual(verdict({}), OK);
        const waiting: LegHealth = { health: 'warn', reason: 'Leg is pending.' };
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

    test('latency at 5 s or more is a warning that replaces the reason', () => {
        assert.equal(verdict({}, 4999).health, 'ok');
        assert.equal(verdict({}, 2000).health, 'ok');
        const v = verdict({ lossPackets: 20 }, 5700);
        assert.equal(v.health, 'warn');
        assert.equal(v.reason, 'Leg latency is 5700 ms, above 5000 ms.');
        assert.equal(verdict({}, null).health, 'ok');
    });

    test('an error is never downgraded to a warning', () => {
        const down: LegHealth = { health: 'error', reason: 'Leg state is unknown.' };
        assert.equal(verdict({ lossPackets: 20 }, 200, down).health, 'error');
        assert.equal(verdict({}, 2000, down).health, 'error');
    });
});

describe('srtIntervalAlerts severity', () => {
    const severityOf = (alerts: PipelineAlert[], code: string) =>
        alerts.find((a) => a.code === code)?.severity;

    test('dropped packets are an error from 5% of the interval or 1000 packets, else a warning', () => {
        assert.equal(severityOf(interval({ recvDropTotal: 49 }), 'srt-packets-dropped'), 'warning');
        assert.equal(severityOf(interval({ recvDropTotal: 50 }), 'srt-packets-dropped'), 'error');
        const big = interval(
            { recvDropTotal: 1000, recvUniquePacketsTotal: 1_000_000 },
            { recvUniquePacketsTotal: 0 },
        );
        assert.equal(severityOf(big, 'srt-packets-dropped'), 'error');
    });

    test('loss is an error from 10% of the interval, a warning from 1%', () => {
        assert.equal(severityOf(interval({ recvLossTotal: 99 }), 'srt-packet-loss'), 'warning');
        assert.equal(severityOf(interval({ recvLossTotal: 100 }), 'srt-packet-loss'), 'error');
    });

    test('a bitrate collapse is an error from a fifth of the previous rate or less', () => {
        assert.equal(
            severityOf(interval({ recvBitrateKbps: 3000 }), 'input-bitrate-collapse'),
            'warning',
        );
        assert.equal(
            severityOf(interval({ recvBitrateKbps: 1200 }), 'input-bitrate-collapse'),
            'error',
        );
    });

    test('the other interval alerts stay warnings', () => {
        const alerts = interval({
            retransTotal: 100,
            belatedTotal: 500,
            latencyMs: 4000,
            forwardedPackets: 10_000,
        });
        assert.deepEqual(
            alerts.map((a) => a.severity),
            alerts.map(() => 'warning'),
        );
        assert.ok(alerts.length >= 3);
    });
});
