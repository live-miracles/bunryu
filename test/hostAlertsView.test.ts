import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
    hostAlertBanners,
    hostAlertKindsToBeep,
    hostAlertSeverity,
} from '../public/ts/core/host-alerts';
import type { HostAlert } from '../public/ts/types';

const alert = (kind: HostAlert['kind'], severity: HostAlert['severity']): HostAlert => ({
    kind,
    severity,
    message: `${kind} ${severity}`,
    sinceMs: 0,
});

describe('host alerts in the dashboard', () => {
    test('the top bar colour of a resource is the severity of its alert, or none', () => {
        const alerts = [alert('cpu', 'warning'), alert('disk', 'error')];
        assert.equal(hostAlertSeverity(alerts, 'cpu'), 'warning');
        assert.equal(hostAlertSeverity(alerts, 'disk'), 'error');
        assert.equal(hostAlertSeverity(alerts, 'memory'), null);
    });

    test('banners list errors first', () => {
        const banners = hostAlertBanners([alert('cpu', 'warning'), alert('disk', 'error')]);
        assert.deepEqual(
            banners.map((b) => b.kind),
            ['disk', 'cpu'],
        );
    });

    test('only an error beeps', () => {
        assert.deepEqual(
            hostAlertKindsToBeep([alert('cpu', 'warning'), alert('memory', 'error')]),
            ['memory'],
        );
    });
});
