import fs from 'fs';
import path from 'path';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024 * 1024;
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface DiagnosticsLogger {
    event(event: string, fields?: Record<string, unknown>): void;
    close(): void;
}

// Overridable only so tests can exercise rotation/retention without writing
// gigabytes of data or waiting days; production always uses the defaults.
export interface DiagnosticsLoggerOptions {
    maxFileBytes?: number;
    maxTotalBytes?: number;
    retentionMs?: number;
    cleanupIntervalMs?: number;
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
    fs.mkdirSync(directory, { recursive: true, mode: 0o750 });
    let state: FileState | null = null;
    let cleanupTimer: NodeJS.Timeout | null = null;

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
        return {
            date,
            sequence,
            bytes,
            stream: fs.createWriteStream(target, { flags: 'a', mode: 0o640 }),
        };
    };

    const rotate = (date: string): void => {
        state?.stream.end();
        let sequence = state?.date === date ? state.sequence + 1 : 0;
        state = openFile(date, sequence);
        while (state.bytes >= maxFileBytes) {
            state.stream.end();
            state = openFile(date, ++sequence);
        }
        cleanup();
    };

    const write = (record: Record<string, unknown>): void => {
        const line = `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`;
        const date = localDate();
        if (!state || state.date !== date || state.bytes + Buffer.byteLength(line) > maxFileBytes) {
            rotate(date);
        }
        if (!state) return;
        state.bytes += Buffer.byteLength(line);
        if (!state.stream.write(line)) {
            // Backpressure is handled by the stream; dropping diagnostics would
            // defeat the purpose of keeping an incident trail.
            state.stream.once('drain', () => undefined);
        }
    };

    cleanup();
    cleanupTimer = setInterval(cleanup, cleanupIntervalMs);
    cleanupTimer.unref?.();

    return {
        event(event, fields = {}): void {
            write({ event, ...fields });
        },
        close(): void {
            if (cleanupTimer) clearInterval(cleanupTimer);
            cleanupTimer = null;
            state?.stream.end();
            state = null;
        },
    };
}
