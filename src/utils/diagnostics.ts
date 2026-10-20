import fs from 'fs';
import path from 'path';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024 * 1024;
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Bytes queued in memory before events are dropped (and counted) rather than
// buffered without bound while the disk is slow.
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
// After a write error the logger drops (and counts) events for this long, then
// reopens the file.
const REOPEN_DELAY_MS = 60 * 1000;

export interface DiagnosticsLogger {
    event(event: string, fields?: Record<string, unknown>): void;
    // Resolves once everything written so far is flushed to disk.
    close(): Promise<void>;
}

// Overridable only so tests can exercise rotation/retention without writing
// gigabytes of data or waiting days; production always uses the defaults.
export interface DiagnosticsLoggerOptions {
    maxFileBytes?: number;
    maxTotalBytes?: number;
    retentionMs?: number;
    cleanupIntervalMs?: number;
    reopenDelayMs?: number;
}

interface FileState {
    date: string;
    sequence: number;
    bytes: number;
    stream: fs.WriteStream;
}

function localDate(): string {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function fileName(date: string, sequence: number): string {
    return `diagnostics-${date}${sequence > 0 ? `.${sequence}` : ''}.jsonl`;
}

export function createDiagnosticsLogger(
    directory: string,
    options: DiagnosticsLoggerOptions = {},
): DiagnosticsLogger {
    const maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
    const maxTotalBytes = options.maxTotalBytes ?? MAX_TOTAL_BYTES;
    const retentionMs = options.retentionMs ?? RETENTION_MS;
    const cleanupIntervalMs = options.cleanupIntervalMs ?? CLEANUP_INTERVAL_MS;
    const reopenDelayMs = options.reopenDelayMs ?? REOPEN_DELAY_MS;
    let state: FileState | null = null;
    let cleanupTimer: NodeJS.Timeout | null = null;
    // The diagnostics trail is best effort: a full disk or an unwritable
    // directory must never take the control plane (and every output) down.
    // While failed, events are dropped and counted, and the count is written
    // as the first record once the file reopens.
    let failure: { error: string; atMs: number } | null = null;
    let dropped = 0;

    const fail = (err: unknown): void => {
        const error = err instanceof Error ? err.message : String(err);
        if (!failure) {
            console.error(`[diagnostics] write failed, dropping events until reopen: ${error}`);
        }
        failure = { error, atMs: Date.now() };
        state?.stream.destroy();
        state = null;
    };

    const cleanup = (): void => {
        const cutoff = Date.now() - retentionMs;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(directory, { withFileTypes: true });
        } catch {
            return;
        }
        const files: Array<{ target: string; mtimeMs: number; size: number }> = [];
        for (const entry of entries) {
            if (
                !entry.isFile() ||
                !/^diagnostics-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.jsonl$/.test(entry.name)
            ) {
                continue;
            }
            const target = path.join(directory, entry.name);
            try {
                const stat = fs.statSync(target);
                if (stat.mtimeMs < cutoff) {
                    fs.unlinkSync(target);
                } else {
                    files.push({ target, mtimeMs: stat.mtimeMs, size: stat.size });
                }
            } catch {
                // A concurrently rotated file can disappear between stat/unlink.
            }
        }
        let totalBytes = files.reduce((total, file) => total + file.size, 0);
        const activeTarget = state
            ? path.join(directory, fileName(state.date, state.sequence))
            : null;
        for (const file of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
            if (totalBytes <= maxTotalBytes || file.target === activeTarget) continue;
            try {
                fs.unlinkSync(file.target);
                totalBytes -= file.size;
            } catch {
                // A concurrent cleanup or rotation may have removed it already.
            }
        }
    };

    const openFile = (date: string, sequence: number): FileState => {
        const target = path.join(directory, fileName(date, sequence));
        let bytes = 0;
        try {
            bytes = fs.statSync(target).size;
        } catch {
            // New file.
        }
        const stream = fs.createWriteStream(target, { flags: 'a', mode: 0o640 });
        stream.on('error', (err) => {
            if (state?.stream === stream) fail(err);
            else console.error(`[diagnostics] error on a rotated-out file: ${err.message}`);
        });
        return { date, sequence, bytes, stream };
    };

    const rotate = (date: string): void => {
        state?.stream.end();
        let sequence = state?.date === date ? state.sequence + 1 : 0;
        fs.mkdirSync(directory, { recursive: true, mode: 0o750 });
        state = openFile(date, sequence);
        while (state.bytes >= maxFileBytes) {
            state.stream.end();
            state = openFile(date, ++sequence);
        }
        cleanup();
    };

    const append = (line: string): void => {
        if (!state) return;
        state.bytes += Buffer.byteLength(line);
        state.stream.write(line, (err) => {
            if (err) dropped += 1;
        });
    };

    const write = (record: Record<string, unknown>): void => {
        if (failure && Date.now() - failure.atMs < reopenDelayMs) {
            dropped += 1;
            return;
        }
        const line = `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`;
        const date = localDate();
        try {
            if (
                !state ||
                state.date !== date ||
                state.bytes + Buffer.byteLength(line) > maxFileBytes
            ) {
                rotate(date);
            }
        } catch (err) {
            fail(err);
            dropped += 1;
            return;
        }
        if (!state) return;
        // The stream queues writes in memory while the disk catches up; past
        // the cap, drop and count rather than grow without bound.
        if (state.stream.writableLength > MAX_BUFFERED_BYTES) {
            dropped += 1;
            return;
        }
        if (dropped > 0) {
            append(
                `${JSON.stringify({
                    ts: new Date().toISOString(),
                    event: 'diagnostics-events-dropped',
                    dropped,
                    error: failure?.error ?? 'write buffer full',
                })}\n`,
            );
            dropped = 0;
        }
        failure = null;
        append(line);
    };

    cleanup();
    cleanupTimer = setInterval(cleanup, cleanupIntervalMs);
    cleanupTimer.unref?.();

    return {
        event(event, fields = {}): void {
            write({ event, ...fields });
        },
        close(): Promise<void> {
            if (cleanupTimer) clearInterval(cleanupTimer);
            cleanupTimer = null;
            const stream = state?.stream;
            state = null;
            if (!stream || stream.destroyed) return Promise.resolve();
            return new Promise((resolve) => {
                stream.once('error', () => resolve());
                stream.end(() => resolve());
            });
        },
    };
}

// For a periodic loop whose tick can throw: records the first failure and any
// change of error as `<name>-failed`, and `<name>-recovered` with the count
// once a tick succeeds again, so a persistently failing loop logs once instead
// of every tick.
export function createLoopFailureReporter(
    name: string,
    diagnostics?: DiagnosticsLogger,
): { failed(err: unknown): void; succeeded(): void } {
    let failures = 0;
    let lastError = '';
    return {
        failed(err: unknown): void {
            const error = err instanceof Error ? (err.stack ?? err.message) : String(err);
            failures += 1;
            if (failures === 1 || error !== lastError) {
                console.error(`[${name}] tick failed (loop keeps running): ${error}`);
                diagnostics?.event(`${name}-failed`, { error, consecutiveFailures: failures });
            }
            lastError = error;
        },
        succeeded(): void {
            if (failures === 0) return;
            console.log(`[${name}] recovered after ${failures} failed ticks`);
            diagnostics?.event(`${name}-recovered`, { failures, lastError });
            failures = 0;
            lastError = '';
        },
    };
}
