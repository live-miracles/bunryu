import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { whilePending } from '../public/ts/core/pending-outputs';

describe("whilePending (an output's Start and Stop buttons)", () => {
    test('the output is pending while the operation runs and not after', async () => {
        const pending = new Set<string>();
        let seenDuring = null;
        await whilePending(
            pending,
            'out-1',
            async () => {
                seenDuring = pending.has('out-1');
            },
            () => {},
        );
        assert.equal(seenDuring, true);
        assert.equal(pending.has('out-1'), false);
    });

    test('a start the server refused does not leave the button disabled', async () => {
        // api.startOutput shows the error and resolves with null; nothing changes in the config.
        const pending = new Set<string>();
        await whilePending(
            pending,
            'out-1',
            async () => null,
            () => {},
        );
        assert.equal(pending.size, 0);
    });

    test('an operation that throws still clears it, and the error is not swallowed', async () => {
        const pending = new Set<string>();
        await assert.rejects(
            whilePending(
                pending,
                'out-1',
                async () => {
                    throw new Error('chunk failed to load');
                },
                () => {},
            ),
            /chunk failed to load/,
        );
        assert.equal(pending.size, 0);
    });

    test('the list is drawn again after the output stopped being pending', async () => {
        const pending = new Set<string>();
        const pendingWhenDrawn: boolean[] = [];
        await whilePending(
            pending,
            'out-1',
            async () => {},
            () => pendingWhenDrawn.push(pending.has('out-1')),
        );
        assert.deepEqual(pendingWhenDrawn, [false]);
    });

    test('other outputs are not touched', async () => {
        const pending = new Set(['out-2']);
        await whilePending(
            pending,
            'out-1',
            async () => null,
            () => {},
        );
        assert.deepEqual([...pending], ['out-2']);
    });
});
