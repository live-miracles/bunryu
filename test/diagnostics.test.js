'use strict';

const { after, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDiagnosticsLogger, runLogged } = require('../src/utils/diagnostics');

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// createDiagnosticsLogger's write stream opens the file asynchronously (an
// fs.open under the hood), so a bare synchronous close() does not guarantee
// the file is on disk yet — every test settles this before asserting.
async function closeAndSettle(logger) {
    logger.close();
    await sleep(30);
}

function mkTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'bunryu-diagnostics-'));
}

const roots = [];
after(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function tempDiagnosticsDir() {
    const root = mkTempDir();
    roots.push(root);
    return path.join(root, 'diagnostics');
}

function readLines(file) {
    return fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));
}

function listDiagnosticsFiles(dir) {
    return fs
        .readdirSync(dir)
        .filter((name) => /^diagnostics-.*\.jsonl$/.test(name))
        .sort();
}

// Mirrors the private localDate() format in src/utils/diagnostics.ts so tests
// can pre-place a file the logger will recognize as "today's" active file.
function todayFileName(sequence = 0) {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    return `diagnostics-${date}${sequence > 0 ? `.${sequence}` : ''}.jsonl`;
}

describe('diagnostics logger basics', () => {
    test('creates the directory and writes a JSONL event with a timestamp', async () => {
        const dir = tempDiagnosticsDir();
        const logger = createDiagnosticsLogger(dir);
        logger.event('srs-transition', { from: 'up', to: 'down' });
        await closeAndSettle(logger);

        const files = listDiagnosticsFiles(dir);
        assert.equal(files.length, 1);
        const [record] = readLines(path.join(dir, files[0]));
        assert.equal(record.event, 'srs-transition');
        assert.equal(record.from, 'up');
        assert.equal(record.to, 'down');
        assert.match(record.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    test('appends multiple events to the same file in order', async () => {
        const dir = tempDiagnosticsDir();
        const logger = createDiagnosticsLogger(dir);
        logger.event('first', { n: 1 });
        logger.event('second', { n: 2 });
        logger.event('third', { n: 3 });
        await closeAndSettle(logger);

        const files = listDiagnosticsFiles(dir);
        assert.equal(files.length, 1);
        const records = readLines(path.join(dir, files[0]));
        assert.deepEqual(
            records.map((r) => r.event),
            ['first', 'second', 'third'],
        );
    });

    test('event() with no fields still writes a valid record', async () => {
        const dir = tempDiagnosticsDir();
        const logger = createDiagnosticsLogger(dir);
        logger.event('bare-event');
        await closeAndSettle(logger);

        const files = listDiagnosticsFiles(dir);
        const [record] = readLines(path.join(dir, files[0]));
        assert.equal(record.event, 'bare-event');
    });

    test('directory and files are created with restrictive permissions', async () => {
        const dir = tempDiagnosticsDir();
        const logger = createDiagnosticsLogger(dir);
        logger.event('perm-check');
        await closeAndSettle(logger);

        assert.equal(fs.statSync(dir).mode & 0o777, 0o750);
        const files = listDiagnosticsFiles(dir);
        assert.equal(fs.statSync(path.join(dir, files[0])).mode & 0o777, 0o640);
    });

    test('a second logger instance the same day resumes appending to the existing file', async () => {
        const dir = tempDiagnosticsDir();
        const first = createDiagnosticsLogger(dir);
        first.event('before-restart');
        await closeAndSettle(first);

        const second = createDiagnosticsLogger(dir);
        second.event('after-restart');
        await closeAndSettle(second);

        const files = listDiagnosticsFiles(dir);
        assert.equal(files.length, 1, 'a same-day restart must not create a second file');
        const records = readLines(path.join(dir, files[0]));
        assert.deepEqual(
            records.map((r) => r.event),
            ['before-restart', 'after-restart'],
        );
    });
});

describe('diagnostics logger size rotation', () => {
    test('rotates to a new sequence file once the active file would exceed maxFileBytes', async () => {
        const dir = tempDiagnosticsDir();
        const logger = createDiagnosticsLogger(dir, { maxFileBytes: 200 });
        for (let i = 0; i < 20; i += 1) {
            logger.event('padded', { i, padding: 'x'.repeat(30) });
        }
        await closeAndSettle(logger);

        const files = listDiagnosticsFiles(dir);
        assert.ok(files.length > 1, 'expected at least one rotation past the 200-byte cap');
        for (const file of files) {
            const bytes = fs.statSync(path.join(dir, file)).size;
            assert.ok(bytes <= 200, `${file} is ${bytes} bytes, over the 200-byte cap`);
        }
        // Every written event must still be present, split across the rotated files.
        const allEvents = files.flatMap((file) => readLines(path.join(dir, file)));
        assert.equal(allEvents.length, 20);
    });

    test('resuming after a crash skips past a sequence file that is already at the size cap', async () => {
        const dir = tempDiagnosticsDir();
        fs.mkdirSync(dir, { recursive: true });
        const staleFile = path.join(dir, todayFileName(0));
        fs.writeFileSync(staleFile, `${'x'.repeat(150)}\n`);

        const logger = createDiagnosticsLogger(dir, { maxFileBytes: 100 });
        logger.event('after-crash');
        await closeAndSettle(logger);

        // The oversized sequence-0 file must be left untouched...
        assert.equal(fs.readFileSync(staleFile, 'utf8'), `${'x'.repeat(150)}\n`);
        // ...and the new event must land in sequence 1 instead.
        const nextFile = path.join(dir, todayFileName(1));
        assert.ok(fs.existsSync(nextFile), 'expected rotation to sequence 1 on resume');
        const [record] = readLines(nextFile);
        assert.equal(record.event, 'after-crash');
    });
});

describe('diagnostics logger day rotation', () => {
    test('rolls over to a new file with sequence reset when the date changes', async (t) => {
        const dir = tempDiagnosticsDir();
        t.mock.timers.enable({ apis: ['Date'], now: Date.now() });

        const logger = createDiagnosticsLogger(dir);
        logger.event('day-one');
        t.mock.timers.tick(25 * 60 * 60 * 1000);
        logger.event('day-two');
        await closeAndSettle(logger);

        const files = listDiagnosticsFiles(dir);
        assert.equal(files.length, 2, 'expected one file per calendar day');
        assert.ok(
            files.every((name) => !/\.\d+\.jsonl$/.test(name)),
            "a fresh day must start at sequence 0, not continue the previous day's sequence",
        );
        const eventsByFile = files.map((file) => readLines(path.join(dir, file))[0].event);
        assert.deepEqual(eventsByFile.sort(), ['day-one', 'day-two']);
    });
});

describe('diagnostics logger retention', () => {
    test('deletes files older than the retention window and keeps recent ones', async () => {
        const dir = tempDiagnosticsDir();
        fs.mkdirSync(dir, { recursive: true });
        const oldFile = path.join(dir, 'diagnostics-2020-01-01.jsonl');
        const recentFile = path.join(dir, 'diagnostics-2020-01-05.jsonl');
        fs.writeFileSync(oldFile, '{"event":"old"}\n');
        fs.writeFileSync(recentFile, '{"event":"recent"}\n');

        const now = Date.now();
        const tenSecondsAgo = (now - 10_000) / 1000;
        const twoSecondsAgo = (now - 2_000) / 1000;
        fs.utimesSync(oldFile, tenSecondsAgo, tenSecondsAgo);
        fs.utimesSync(recentFile, twoSecondsAgo, twoSecondsAgo);

        // Construction alone runs an initial cleanup pass.
        const logger = createDiagnosticsLogger(dir, { retentionMs: 5_000 });
        await closeAndSettle(logger);

        assert.equal(
            fs.existsSync(oldFile),
            false,
            'file past the retention window must be removed',
        );
        assert.equal(
            fs.existsSync(recentFile),
            true,
            'file within the retention window must survive',
        );
    });

    test('the documented seven-day default retention removes only files older than seven days', async () => {
        const dir = tempDiagnosticsDir();
        fs.mkdirSync(dir, { recursive: true });
        const eightDaysOld = path.join(dir, 'diagnostics-2020-02-01.jsonl');
        const sixDaysOld = path.join(dir, 'diagnostics-2020-02-08.jsonl');
        fs.writeFileSync(eightDaysOld, '{"event":"old"}\n');
        fs.writeFileSync(sixDaysOld, '{"event":"recent"}\n');

        const now = Date.now() / 1000;
        const day = 24 * 60 * 60;
        fs.utimesSync(eightDaysOld, now - 8 * day, now - 8 * day);
        fs.utimesSync(sixDaysOld, now - 6 * day, now - 6 * day);

        const logger = createDiagnosticsLogger(dir);
        await closeAndSettle(logger);

        assert.equal(fs.existsSync(eightDaysOld), false);
        assert.equal(fs.existsSync(sixDaysOld), true);
    });

    test('ignores files that do not match the diagnostics naming pattern', async () => {
        const dir = tempDiagnosticsDir();
        fs.mkdirSync(dir, { recursive: true });
        const unrelated = path.join(dir, 'notes.txt');
        const wrongExt = path.join(dir, 'diagnostics-2020-01-01.txt');
        fs.writeFileSync(unrelated, 'hello');
        fs.writeFileSync(wrongExt, 'hello');
        const veryOld = 1;
        fs.utimesSync(unrelated, veryOld, veryOld);
        fs.utimesSync(wrongExt, veryOld, veryOld);

        const logger = createDiagnosticsLogger(dir, { retentionMs: 1000 });
        await closeAndSettle(logger);

        assert.ok(fs.existsSync(unrelated));
        assert.ok(fs.existsSync(wrongExt));
    });
});

describe('diagnostics logger total size cap', () => {
    test('evicts the oldest rotated files first once the total cap is exceeded', async () => {
        const dir = tempDiagnosticsDir();
        fs.mkdirSync(dir, { recursive: true });
        const oldest = path.join(dir, 'diagnostics-2020-01-01.jsonl');
        const middle = path.join(dir, 'diagnostics-2020-01-02.jsonl');
        const newest = path.join(dir, 'diagnostics-2020-01-03.jsonl');
        fs.writeFileSync(oldest, 'x'.repeat(100));
        fs.writeFileSync(middle, 'x'.repeat(100));
        fs.writeFileSync(newest, 'x'.repeat(100));
        const now = Date.now() / 1000;
        fs.utimesSync(oldest, now - 30, now - 30);
        fs.utimesSync(middle, now - 20, now - 20);
        fs.utimesSync(newest, now - 10, now - 10);

        // Total is 300 bytes; cap forces eviction down to at most 150.
        const logger = createDiagnosticsLogger(dir, { maxTotalBytes: 150 });
        await closeAndSettle(logger);

        assert.equal(fs.existsSync(oldest), false, 'oldest file must be evicted first');
        assert.equal(fs.existsSync(middle), false, 'still over cap after only the oldest is gone');
        assert.equal(fs.existsSync(newest), true, 'newest file must survive');
    });

    test('never deletes the actively-written file to satisfy the total size cap', async () => {
        const dir = tempDiagnosticsDir();
        const logger = createDiagnosticsLogger(dir, {
            maxTotalBytes: 200,
            cleanupIntervalMs: 30,
        });
        logger.event('keep-me', { padding: 'x'.repeat(20) });
        await sleep(30);
        const activeFile = path.join(dir, listDiagnosticsFiles(dir)[0]);

        // Drop in an old-format rotated file that alone pushes the total over
        // the cap, with a *newer* mtime than the active file so a naive
        // oldest-first sort would try to delete the active file first.
        const junk = path.join(dir, 'diagnostics-2020-06-15.jsonl');
        fs.writeFileSync(junk, 'x'.repeat(300));
        const future = Date.now() / 1000 + 10;
        fs.utimesSync(junk, future, future);

        await sleep(150);
        await closeAndSettle(logger);

        assert.equal(
            fs.existsSync(junk),
            false,
            'the oversized junk file should have been evicted',
        );
        assert.equal(fs.existsSync(activeFile), true, 'the active file must never be evicted');
        assert.equal(readLines(activeFile)[0].event, 'keep-me');
    });
});

describe('diagnostics logger close()', () => {
    test('events written before close() are flushed and readable immediately after', async () => {
        const dir = tempDiagnosticsDir();
        const logger = createDiagnosticsLogger(dir);
        logger.event('final');
        await closeAndSettle(logger);

        const files = listDiagnosticsFiles(dir);
        assert.equal(readLines(path.join(dir, files[0]))[0].event, 'final');
    });

    test('close() is safe to call more than once', async () => {
        const dir = tempDiagnosticsDir();
        const logger = createDiagnosticsLogger(dir);
        logger.event('once');
        assert.doesNotThrow(() => {
            logger.close();
            logger.close();
        });
        await sleep(30);
    });
});

describe('diagnostics logger failures', () => {
    test('a write stream error does not crash the process and drops are counted on recovery', async () => {
        const dir = tempDiagnosticsDir();
        fs.mkdirSync(dir, { recursive: true });
        // A directory where the active file should be makes the open fail
        // asynchronously with EISDIR, like a disk-full or read-only error would.
        fs.mkdirSync(path.join(dir, todayFileName(0)));
        const logger = createDiagnosticsLogger(dir, { reopenDelayMs: 50 });
        logger.event('lost-1');
        await sleep(20);
        logger.event('lost-2');
        fs.rmdirSync(path.join(dir, todayFileName(0)));
        await sleep(80);
        logger.event('after-recovery');
        await logger.close();

        const records = readLines(path.join(dir, todayFileName(0)));
        assert.equal(records[0].event, 'diagnostics-events-dropped');
        assert.equal(records[0].dropped, 2);
        assert.match(records[0].error, /EISDIR/);
        assert.equal(records[1].event, 'after-recovery');
    });

    test('an unwritable directory does not throw from construction or event()', async () => {
        const root = mkTempDir();
        roots.push(root);
        const blocker = path.join(root, 'not-a-dir');
        fs.writeFileSync(blocker, '');
        let logger;
        assert.doesNotThrow(() => {
            logger = createDiagnosticsLogger(path.join(blocker, 'diagnostics'));
            logger.event('nowhere');
        });
        await logger.close();
    });

    test('close() resolves after buffered events are on disk', async () => {
        const dir = tempDiagnosticsDir();
        const logger = createDiagnosticsLogger(dir);
        for (let i = 0; i < 500; i += 1) logger.event('burst', { i });
        await logger.close();
        const records = readLines(path.join(dir, listDiagnosticsFiles(dir)[0]));
        assert.equal(records.length, 500);
    });
});

describe('runLogged', () => {
    test('returns the result of a step that succeeds', () => {
        assert.equal(
            runLogged('ok', () => 7),
            7,
        );
    });

    test('contains a throwing step and records it', () => {
        const events = [];
        const diagnostics = { event: (name, fields) => events.push({ name, fields }) };
        const originalError = console.error;
        console.error = () => {};
        try {
            assert.equal(
                runLogged(
                    'boom',
                    () => {
                        throw new Error('nope');
                    },
                    diagnostics,
                ),
                undefined,
            );
        } finally {
            console.error = originalError;
        }
        assert.equal(events.length, 1);
        assert.equal(events[0].name, 'step-failed');
        assert.equal(events[0].fields.step, 'boom');
        assert.match(events[0].fields.error, /nope/);
    });
});
