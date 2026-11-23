import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createAlertHold, SRT_ALERT_HOLD_POLLS } from '../src/utils/alertHold';
import type { PipelineAlert } from '../src/utils/srtLinkAlerts';

const alert = (over: Partial<PipelineAlert> = {}): PipelineAlert => ({
    severity: 'warning',
    code: 'srt-packet-loss',
    message: 'loss 2%',
    sinceMs: 0,
    ...over,
});

describe('alert hold', () => {
    test('keeps an alert for six polls after it was last raised, then lets it go', () => {
        const hold = createAlertHold();
        assert.equal(hold.apply([alert()]).length, 1);
        for (let i = 0; i < SRT_ALERT_HOLD_POLLS; i++) {
            assert.equal(hold.apply([]).length, 1, `still held on quiet poll ${i + 1}`);
        }
        assert.equal(hold.apply([]).length, 0, 'gone after them');
    });

    test('raising it again restarts the hold, with the latest wording and severity', () => {
        const hold = createAlertHold();
        hold.apply([alert()]);
        hold.apply([]);
        const [held] = hold.apply([alert({ severity: 'error', message: 'loss 12%' })]);
        assert.equal(held.severity, 'error');
        assert.equal(held.message, 'loss 12%');
        for (let i = 0; i < SRT_ALERT_HOLD_POLLS; i++) assert.equal(hold.apply([]).length, 1);
        assert.equal(hold.apply([]).length, 0);
    });

    test('the episode keeps the time it began', () => {
        const hold = createAlertHold();
        hold.apply([alert({ sinceMs: 111 })]);
        const [held] = hold.apply([alert({ sinceMs: 999 })]);
        assert.equal(held.sinceMs, 111);
    });

    test('alerts with different codes are held separately, and clear() forgets them all', () => {
        const hold = createAlertHold();
        hold.apply([alert(), alert({ code: 'srt-packets-dropped' })]);
        for (let i = 0; i < SRT_ALERT_HOLD_POLLS; i++) hold.apply([alert()]);
        assert.equal(hold.apply([alert()]).length, 1, 'only the one raised again');
        hold.clear();
        assert.deepEqual(hold.apply([]), []);
    });
});
