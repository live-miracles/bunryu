'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
    hasCurrentRelayError,
    recentFigure,
    recentSpanLabel,
    renderBondedLegs,
    renderBondingStats,
} = require('../public/ts/features/srt-bonding-view');

const MIN = 60_000;
const recent = (over = {}) => ({
    spanMs: 10 * MIN,
    packets: 520_000,
    loss: 0,
    retrans: 0,
    drop: 0,
    ...over,
});

describe('recentSpanLabel', () => {
    test('says minutes for a window and seconds right after connecting', () => {
        assert.equal(recentSpanLabel(10 * MIN + 4000), '10 min');
        assert.equal(recentSpanLabel(3 * MIN), '3 min');
        assert.equal(recentSpanLabel(40_000), '40 s');
    });
});

describe('recentFigure', () => {
    test('names the units and the window in the tooltip and dims a quiet link', () => {
        const figure = recentFigure(recent(), false);
        assert.equal(figure.text, '0 / 0 / 0');
        assert.equal(figure.quiet, true);
        assert.equal(figure.dropped, false);
        assert.match(figure.title, /^Last 10 min: 0 lost, 0 rexmit, 0 dropped$/);
    });

    test('a burst shows up and is not quiet', () => {
        const figure = recentFigure(recent({ loss: 114, retrans: 116, drop: 39 }), false);
        assert.equal(figure.text, '114 / 116 / 39');
        assert.equal(figure.quiet, false);
        assert.equal(figure.dropped, true);
    });

    test('a bonded group shows only the packets still missing', () => {
        const figure = recentFigure(recent({ drop: 3 }), true);
        assert.equal(figure.text, '— / — / 3');
        assert.match(figure.title, /^Last 10 min: 3 dropped$/);
        assert.doesNotMatch(figure.title, /lost|rexmit/);
    });

    test('has no figure until the window has two polls', () => {
        const figure = recentFigure(null, false);
        assert.equal(figure.text, '—');
        assert.match(figure.title, /^Collecting…$/);
    });
});

function leg(over = {}) {
    return {
        ip: '203.0.113.10',
        port: 40000,
        state: 'running',
        rttMs: 40,
        recvRateMbps: 9.4,
        rcvBufMs: 200,
        recvLossTotal: 10_140,
        retransTotal: 10_215,
        recvDropTotal: 3_070,
        recent: recent({ loss: 2, retrans: 3, drop: 0 }),
        ...over,
    };
}

describe('bonded legs table', () => {
    const input = (legs) => ({ bonded: true, expectedLegs: legs.length, legs });

    test('shows the last ten minutes of each leg, with the window in the header', () => {
        const html = renderBondedLegs(input([leg(), leg({ ip: '203.0.113.11' })]));
        assert.match(
            html,
            /L \/ R \/ D<\/span> <span class="font-normal text-muted">10 min<\/span>/,
        );
        assert.match(html, />2 \/ 3 \/ 0<\/td>/);
        assert.doesNotMatch(html, /10\.1k/, 'the totals are not in the cell');
        assert.match(html, /title="Last 10 min: 2 lost, 3 rexmit, 0 dropped"/);
    });

    test('puts L / R / D right after the IP column', () => {
        const html = renderBondedLegs(input([leg()]));
        const heads = [...html.matchAll(/<th>(?:<span[^>]*>)?([^<]+)/g)].map((m) => m[1]);
        assert.deepEqual(heads, ['State', 'Leg IP', 'L / R / D', 'RTT', 'Rate', 'Buffer']);
        assert.match(html, /203\.0\.113\.10<\/td>\s*<td[^>]*>2 \/ 3 \/ 0<\/td>/);
    });

    test('dims a leg with nothing lately and marks none as an error', () => {
        const html = renderBondedLegs(
            input([leg({ recent: recent({ drop: 40 }) }), leg({ recent: recent() })]),
        );
        const cells = html.match(
            /<td class="font-mono text-xs[^"]*" title="[^"]*">[^<]*\/[^<]*<\/td>/g,
        );
        assert.equal(cells.length, 2);
        assert.doesNotMatch(cells[0], /opacity-50|text-warning/, 'a leg that dropped is plain');
        assert.match(cells[1], /opacity-50/);
    });

    test('shows a dash while the first window is collected', () => {
        const html = renderBondedLegs(input([leg({ recent: null })]));
        assert.match(html, />—<\/td>/);
        assert.doesNotMatch(html, /min<\/span><\/th>/);
    });
});

describe('relay stats row', () => {
    const status = (inputOver = {}) => ({
        inputActive: true,
        outputConnected: true,
        input: {
            recvUniquePacketsTotal: 31_691_658,
            recvPacketsTotal: null,
            recvLossTotal: null,
            retransTotal: null,
            recvDropTotal: 286,
            latencyMs: 240,
            recent: recent({ loss: null, retrans: null, drop: 0 }),
            legs: [],
            ...inputOver,
        },
        output: {
            sentPacketsTotal: 1,
            sendLossTotal: 5,
            retransTotal: 6,
            sendDropTotal: 7,
            recent: recent({ loss: 0, retrans: 1, drop: 0 }),
        },
    });

    test('labels the window and shows only drops for a bonded group', () => {
        const html = renderBondingStats(status(), true);
        assert.match(html, />In L \/ R \/ D 10 min</);
        assert.match(html, />Out L \/ R \/ D 10 min</);
        assert.match(html, /input-meta-value[^>]*title="Last 10 min: 0 dropped"/);
        assert.doesNotMatch(html, />286</, 'the session total is not on the card');
    });

    test('has no Rx figure and ends with the latency', () => {
        const html = renderBondingStats(status(), true);
        assert.doesNotMatch(html, />Rx</);
        const labels = [...html.matchAll(/input-meta-label[^>]*>([^<]+)</g)].map((m) => m[1]);
        assert.deepEqual(labels, ['In L / R / D 10 min', 'Out L / R / D 10 min', 'Latency']);
    });

    test('marks packets missing from the delivered stream', () => {
        const html = renderBondingStats(
            status({ recent: recent({ loss: null, retrans: null, drop: 3 }) }),
            true,
        );
        assert.match(
            html,
            /input-meta-value text-warning font-semibold" title="[^"]*">— \/ — \/ 3</,
        );
    });
});

describe('relay error history', () => {
    const T = 1_000_000;
    const status = (over = {}) => ({
        lastError: 'srt_connect target=127.0.0.1:10080: Connection setup failure',
        lastErrorAt: T,
        inputActive: true,
        outputConnected: false,
        lastPacketAt: null,
        ...over,
    });

    test('is current while the stream is up and nothing was forwarded since the error', () => {
        assert.equal(hasCurrentRelayError(status()), true);
        assert.equal(hasCurrentRelayError(status({ lastPacketAt: T - 5000 })), true);
    });

    test('is resolved once packets were forwarded after the error', () => {
        assert.equal(hasCurrentRelayError(status({ lastPacketAt: T + 1000 })), false);
    });

    test('is history, not a problem, when the stream is idle or there was never an error', () => {
        assert.equal(hasCurrentRelayError(status({ inputActive: false })), false);
        assert.equal(hasCurrentRelayError(status({ lastError: null, lastErrorAt: null })), false);
    });

    test('an error without a time is current while the stream is up', () => {
        assert.equal(hasCurrentRelayError(status({ lastErrorAt: null, lastPacketAt: T })), true);
    });
});
