import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
    legHealthColor,
    legHealthLabel,
    relayHealth,
    relayIssueList,
} from '../public/ts/core/relay-status';
import type {
    PipelineAlert,
    PipelineView,
    SrtBondingInputStatus,
    SrtBondingLeg,
    SrtBondingStatus,
} from '../public/ts/types';

const NOW = 1_000_000;
const FRESH = NOW - 1000;
const STALE = NOW - 16_000;

// The fakes below carry only the fields relay-status reads, so each factory holds the one
// cast to the real type. A leg's `state` is a plain string here because one test checks that
// a state nobody knows reads as WARN.
type LegOverride = Omit<Partial<SrtBondingLeg>, 'state'> & { state?: string };

const leg = (over: LegOverride = {}) =>
    ({
        ip: '203.0.113.10',
        state: 'running',
        health: 'ok',
        healthReason: null,
        ...over,
    }) as SrtBondingLeg;

// A healthy, plain (not bonded) relay input forwarding into SRS.
const pipeline = (
    over: Partial<SrtBondingStatus> = {},
    input: Partial<SrtBondingInputStatus> = {},
): PipelineView =>
    ({
        alerts: [],
        srtBonding: {
            inputActive: true,
            outputConnected: true,
            acceptedBySrs: true,
            publishConflict: false,
            localSrtPublisherConflict: false,
            retryFailures: 0,
            forwardedPackets: 500,
            lastPacketAt: FRESH,
            lastInputPacketAt: FRESH,
            lastError: null,
            input: { bonded: false, expectedLegs: 1, legs: [leg()], ...input },
            ...over,
        },
    }) as unknown as PipelineView;

const health = (p: PipelineView, running = true) => relayHealth(p, running, NOW);
const messages = (h: ReturnType<typeof health>, side: string) =>
    h.issues.filter((i) => i.side === side).map((i) => i.issue.message);

describe('relayHealth', () => {
    test('a plain input that is flowing is good on both sides, with no issues', () => {
        assert.deepEqual(health(pipeline()), { input: 'good', output: 'good', issues: [] });
    });

    test('is off on both sides while the relay is down or the input is not active', () => {
        assert.deepEqual(health(pipeline(), false), { input: 'off', output: 'off', issues: [] });
        const idle = health(pipeline({ inputActive: false }));
        assert.equal(idle.input, 'off');
        assert.equal(idle.output, 'off');
        assert.deepEqual(idle.issues, []);
    });

    test('takes the time it is asked at: the same packets are flowing, then stale', () => {
        const p = pipeline();
        assert.equal(relayHealth(p, true, NOW).input, 'good');
        const later = relayHealth(p, true, NOW + 20_000);
        assert.equal(later.input, 'warn');
        assert.equal(later.output, 'warn');
        assert.deepEqual(messages(later, 'input'), ['No input packets received recently']);
        assert.deepEqual(messages(later, 'output'), ['Media forwarding to SRS has stalled']);
    });

    test('says nothing was forwarded yet when the output never carried a packet', () => {
        const h = health(pipeline({ lastPacketAt: null, forwardedPackets: 0 }));
        assert.equal(h.output, 'warn');
        assert.deepEqual(messages(h, 'output'), ['No media has been forwarded to SRS yet']);
    });

    describe('input side', () => {
        test('a leg in error makes it an error and names the leg and the reason', () => {
            const h = health(
                pipeline({}, { legs: [leg({ health: 'error', healthReason: 'link flapping' })] }),
            );
            assert.equal(h.input, 'error');
            assert.deepEqual(messages(h, 'input'), ['Input 203.0.113.10: link flapping']);
            assert.equal(h.issues[0].issue.severity, 'error');
            assert.equal(h.issues[0].prefix, 'Input: ');
        });

        test('a bonded group with no legs left is an error, not reduced redundancy', () => {
            const h = health(pipeline({}, { bonded: true, expectedLegs: 2, legs: [] }));
            assert.equal(h.input, 'error');
            assert.deepEqual(messages(h, 'input'), ['No bonded legs reporting']);
        });

        test('a bonded group that lost a leg warns, and says how many are down', () => {
            const h = health(
                pipeline({}, { bonded: true, expectedLegs: 2, legs: [leg({ ip: '10.0.0.1' })] }),
            );
            assert.equal(h.input, 'warn');
            assert.deepEqual(messages(h, 'input'), ['1 of 2 bonded legs down']);
        });

        test('a bonded group with one leg and one expected has no redundancy', () => {
            const h = health(pipeline({}, { bonded: true, expectedLegs: 1, legs: [leg()] }));
            assert.equal(h.input, 'warn');
            assert.deepEqual(messages(h, 'input'), ['Only 1 leg connected — no redundancy']);
        });

        test('a bonded group with all its legs is good', () => {
            const h = health(
                pipeline(
                    {},
                    { bonded: true, expectedLegs: 2, legs: [leg(), leg({ ip: '10.0.0.2' })] },
                ),
            );
            assert.equal(h.input, 'good');
        });

        test('a bonded group with no legs says so once, not also that no packets arrive', () => {
            const h = health(
                pipeline({ lastInputPacketAt: STALE }, { bonded: true, expectedLegs: 2, legs: [] }),
            );
            assert.equal(h.input, 'error');
            assert.deepEqual(messages(h, 'input'), ['No bonded legs reporting']);
            // A plain input still says it.
            assert.deepEqual(messages(health(pipeline({ lastInputPacketAt: STALE })), 'input'), [
                'No input packets received recently',
            ]);
        });

        test('a leg outage and a stalled feed are both listed', () => {
            const h = health(
                pipeline(
                    { lastInputPacketAt: STALE },
                    {
                        bonded: true,
                        expectedLegs: 3,
                        legs: [
                            leg({ health: 'warn', healthReason: 'high loss' }),
                            leg({ ip: '10.0.0.2' }),
                        ],
                    },
                ),
            );
            assert.equal(h.input, 'warn');
            assert.deepEqual(messages(h, 'input'), [
                'Leg 203.0.113.10: high loss',
                '1 of 3 bonded legs down',
                'No input packets received recently',
            ]);
        });
    });

    describe('output side', () => {
        test('the forwarding alert replaces the stalled-forwarding reason: it is said once', () => {
            const alert = {
                severity: 'warning',
                code: 'relay-forwarding-stalled',
                message: 'Relay is receiving SRT packets but forwarding no packets to SRS.',
                sinceMs: NOW - 5000,
            } as PipelineAlert;
            const stalled = pipeline({ lastPacketAt: STALE });
            stalled.alerts = [alert];
            const h = health(stalled);
            assert.equal(h.output, 'warn');
            assert.deepEqual(messages(h, 'output'), [alert.message]);
            // Without the alert (the 30 s hold is over) the stale flow still says it.
            assert.deepEqual(messages(health(pipeline({ lastPacketAt: STALE })), 'output'), [
                'Media forwarding to SRS has stalled',
            ]);
        });

        test('a publish conflict is an error, told apart by who holds the key', () => {
            const other = health(pipeline({ publishConflict: true }));
            assert.equal(other.output, 'error');
            assert.deepEqual(messages(other, 'output'), [
                'SRS is already using another publisher for this stream key',
            ]);
            const local = health(
                pipeline({ publishConflict: true, localSrtPublisherConflict: true }),
            );
            assert.deepEqual(messages(local, 'output'), [
                'A local pipeline output is already publishing to this stream key in SRS',
            ]);
        });

        test('an output that is not connected is an error, with the relay error or the retries', () => {
            const withError = health(
                pipeline({ outputConnected: false, lastError: 'Connection setup failure' }),
            );
            assert.equal(withError.output, 'error');
            assert.deepEqual(messages(withError, 'output'), [
                'Relay output reconnecting: Connection setup failure',
            ]);
            const retrying = health(pipeline({ outputConnected: false, retryFailures: 3 }));
            assert.deepEqual(messages(retrying, 'output'), [
                'Relay output reconnecting (3 retries)',
            ]);
            const bare = health(pipeline({ outputConnected: false }));
            assert.deepEqual(messages(bare, 'output'), ['Relay output reconnecting']);
        });

        test('a connected output SRS has not accepted warns', () => {
            const h = health(pipeline({ acceptedBySrs: false }));
            assert.equal(h.output, 'warn');
            assert.deepEqual(messages(h, 'output'), [
                'SRS has not reported this as the active pipeline input',
            ]);
        });
    });

    describe('server alerts', () => {
        const alert = (code: string, over: Partial<PipelineAlert> = {}): PipelineAlert => ({
            code,
            severity: 'warning',
            message: `${code} happened`,
            sinceMs: 5,
            ...over,
        });

        test('are listed even while the relay is down, on the side they belong to', () => {
            const p = pipeline();
            p.alerts = [alert('relay-forwarding-stalled'), alert('srt-link-unstable')];
            const h = health(p, false);
            assert.deepEqual(messages(h, 'output'), ['relay-forwarding-stalled happened']);
            assert.deepEqual(messages(h, 'input'), ['srt-link-unstable happened']);
            assert.equal(h.issues[0].issue.sinceMs, 5);
        });

        test('leave out per-leg alerts, which the leg reasons already say', () => {
            const p = pipeline();
            p.alerts = [alert('bonded-leg-no-flow'), alert('bonded-leg-quality')];
            assert.deepEqual(health(p).issues, []);
        });
    });
});

describe('relayIssueList', () => {
    test('tags each reason with its side and leaves server alerts as they are', () => {
        const p = pipeline({ lastPacketAt: STALE, lastInputPacketAt: STALE }, {});
        // No sinceMs on purpose: the list passes a server alert through as it came.
        p.alerts = [
            {
                code: 'srt-link-unstable',
                severity: 'warning',
                message: 'unstable',
            } as PipelineAlert,
        ];
        const list = relayIssueList(health(p));
        assert.deepEqual(
            list.map((i) => i.message),
            [
                'unstable',
                'Input: No input packets received recently',
                'Output: Media forwarding to SRS has stalled',
            ],
        );
    });
});

describe('leg health', () => {
    test('colours and labels a leg by its reported health', () => {
        assert.equal(legHealthLabel(leg({ health: 'warn' })), 'WARN');
        assert.equal(legHealthLabel(leg({ health: undefined, state: 'running' })), 'OK');
        assert.equal(legHealthLabel(leg({ health: undefined, state: 'broken' })), 'WARN');
        assert.notEqual(legHealthColor(leg({ health: 'error' })), legHealthColor(leg()));
        assert.notEqual(legHealthColor(leg({ health: 'warn' })), legHealthColor(leg()));
    });
});

describe('relayHealth with interval alerts', () => {
    const withAlerts = (alerts: Partial<PipelineAlert>[], over: Partial<SrtBondingStatus> = {}) => {
        const p = pipeline(over);
        p.alerts = alerts.map((a) => ({
            severity: 'warning',
            code: 'srt-packet-loss',
            message: 'loss',
            sinceMs: NOW,
            ...a,
        }));
        return p;
    };

    test('a warning alert turns the input half to a warning, an error alert to an error', () => {
        assert.equal(health(withAlerts([{}])).input, 'warn');
        assert.equal(health(withAlerts([{ severity: 'error' }])).input, 'error');
        assert.equal(health(withAlerts([{}])).output, 'good', 'the output half is not about loss');
    });

    test('an alert never lowers a status, and the reasons stay the state own', () => {
        const stale = withAlerts([{}], { lastInputPacketAt: STALE });
        const h = health(stale);
        assert.equal(h.input, 'warn');
        assert.deepEqual(messages(h, 'input'), ['loss', 'No input packets received recently']);
        const worse = health(withAlerts([{}], { lastInputPacketAt: STALE, inputActive: true }));
        assert.equal(worse.input, 'warn');
    });

    test('a forwarding alert raises the output half', () => {
        const h = health(withAlerts([{ code: 'relay-forwarding-stalled', severity: 'error' }]));
        assert.equal(h.output, 'error');
        assert.equal(h.input, 'good');
    });

    test('an input that is off stays off', () => {
        assert.equal(health(withAlerts([{}], { inputActive: false })).input, 'off');
        assert.equal(relayHealth(withAlerts([{}]), false, NOW).input, 'off');
    });

    test('a leg-down alert is the one report of the legs down, with no second reason', () => {
        const p = withAlerts(
            [{ code: 'bonded-leg-down', message: '1 of 2 bonded legs is down.' }],
            {},
        );
        p.srtBonding.input = {
            ...p.srtBonding.input,
            bonded: true,
            expectedLegs: 2,
            legs: [leg()],
        };
        const h = health(p);
        assert.deepEqual(
            messages(h, 'input').filter((m) => /legs/.test(m)),
            ['1 of 2 bonded legs is down.'],
        );
        p.alerts = [];
        assert.ok(messages(health(p), 'input').some((m) => /1 of 2 bonded legs down/.test(m)));
    });
});
