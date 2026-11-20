import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { OutputService } from '../src/services/outputs';
import type { Db } from '../src/types';
import { wantRunning, wantStopped } from '../src/services/outputDesiredState';

// One log for both the database and the process, so a test reads the order they were called in.
// The fakes implement only the methods each function under test calls. The database fake
// returns nothing where the real method returns the row, so it is cast to its Pick<Db> once.
type DesiredState = 'running' | 'stopped';

function harness({
    startFails = false,
    dbFailsOn = null,
}: { startFails?: boolean; dbFailsOn?: DesiredState | null } = {}) {
    const log: string[] = [];
    const db = {
        setOutputDesiredState(id: string, state: DesiredState) {
            log.push(`db:${id}:${state}`);
            if (dbFailsOn === state) throw new Error('db down');
        },
    } as unknown as Pick<Db, 'setOutputDesiredState'>;
    const outputService: Pick<OutputService, 'start' | 'stop'> = {
        async start(id: string, options?: { byUser?: boolean }) {
            log.push(`start:${id}:${options?.byUser ? 'user' : 'auto'}`);
            if (startFails) throw new Error('Invalid output URL');
        },
        stop(id: string) {
            log.push(`stop:${id}`);
        },
    };
    return { log, db, outputService };
}

describe('wantRunning', () => {
    test('marks the output desired-running before it starts it', async () => {
        const h = harness();
        await wantRunning(h.db, h.outputService, 'o1', { byUser: true });
        assert.deepEqual(h.log, ['db:o1:running', 'start:o1:user']);
    });

    test('puts the output back to desired-stopped and rethrows when the start fails', async () => {
        const h = harness({ startFails: true });
        await assert.rejects(() => wantRunning(h.db, h.outputService, 'o1'), /Invalid output URL/);
        assert.deepEqual(h.log, ['db:o1:running', 'start:o1:auto', 'db:o1:stopped']);
    });

    test('reports the start error even when the rollback write also fails', async () => {
        const h = harness({ startFails: true, dbFailsOn: 'stopped' });
        await assert.rejects(() => wantRunning(h.db, h.outputService, 'o1'), /Invalid output URL/);
    });

    test('does not start an output it could not mark desired-running', async () => {
        const h = harness({ dbFailsOn: 'running' });
        await assert.rejects(() => wantRunning(h.db, h.outputService, 'o1'), /db down/);
        assert.deepEqual(h.log, ['db:o1:running']);
    });
});

describe('wantStopped', () => {
    test('marks the output desired-stopped before it stops the process', () => {
        const h = harness();
        wantStopped(h.db, h.outputService, 'o1');
        assert.deepEqual(h.log, ['db:o1:stopped', 'stop:o1']);
    });

    test('does not touch the process when the database write fails', () => {
        const h = harness({ dbFailsOn: 'stopped' });
        assert.throws(() => wantStopped(h.db, h.outputService, 'o1'), /db down/);
        assert.deepEqual(h.log, ['db:o1:stopped']);
    });
});
