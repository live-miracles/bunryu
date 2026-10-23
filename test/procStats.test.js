'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const {
    readProcRssBytes,
    readHostMemory,
    readDiskUsage,
    readUdpBufferCeilings,
    readCpuPressure,
    readUdpStats,
    topProcessesByRss,
    findPidsByExecutable,
    createProcCpuTracker,
} = require('../src/utils/procStats');

// Builds a minimal /proc/<pid>/stat line. `comm` may contain spaces/parens to
// exercise the lastIndexOf(')') split. utime/stime land at the 14th/15th
// overall fields (fields[11]/fields[12] after slicing past the comm).
function fakeStatLine(pid, comm, utime, stime) {
    const fields = ['S', '1', '1', '1', '0', '-1', '0', '0', '0', '0', '0', utime, stime];
    return `${pid} (${comm}) ${fields.join(' ')}`;
}

describe('readProcRssBytes', () => {
    test('parses VmRSS in kB into bytes', (t) => {
        t.mock.method(fs, 'readFileSync', () => 'VmRSS:\t  12345 kB\n');
        assert.equal(readProcRssBytes(1), 12345 * 1024);
    });

    test('returns null when the file cannot be read (process gone)', (t) => {
        t.mock.method(fs, 'readFileSync', () => {
            throw new Error('ENOENT');
        });
        assert.equal(readProcRssBytes(99999), null);
    });

    test('returns null when VmRSS is missing from the status file', (t) => {
        t.mock.method(
            fs,
            'readFileSync',
            () => 'Name:\tffmpeg\nState:\tR (running)\nVmSize:\t  50000 kB\n',
        );
        assert.equal(readProcRssBytes(1), null);
    });

    test('returns null on a malformed VmRSS line (missing unit)', (t) => {
        t.mock.method(fs, 'readFileSync', () => 'VmRSS:\t  12345\n');
        assert.equal(readProcRssBytes(1), null);
    });

    test('handles VmRSS: 0 kB (freshly exec()d process)', (t) => {
        t.mock.method(fs, 'readFileSync', () => 'VmRSS:\t       0 kB\n');
        assert.equal(readProcRssBytes(1), 0);
    });

    test('matches only at line start (anchored), ignoring a substring on another line', (t) => {
        t.mock.method(fs, 'readFileSync', () => 'VmHWM:\t  99999 kB\nVmRSS:\t  500 kB\n');
        assert.equal(readProcRssBytes(1), 500 * 1024);
    });
});

describe('findPidsByExecutable', () => {
    test('returns an empty array when /proc does not exist (non-Linux dev machine)', (t) => {
        t.mock.method(fs, 'readdirSync', () => {
            throw new Error('ENOENT: no /proc');
        });
        assert.deepEqual(findPidsByExecutable('/usr/bin/ffmpeg'), []);
    });

    test('ignores non-numeric /proc entries', (t) => {
        t.mock.method(fs, 'readdirSync', () => ['self', 'cpuinfo', '42']);
        t.mock.method(fs, 'readFileSync', (p) => {
            if (String(p) === '/proc/42/cmdline') return '/usr/bin/ffmpeg\0-i\0in\0';
            throw new Error('should not read this path: ' + p);
        });
        assert.deepEqual(findPidsByExecutable('/usr/bin/ffmpeg'), [42]);
    });

    test('requires an exact argv[0] match, not a prefix/suffix match', (t) => {
        t.mock.method(fs, 'readdirSync', () => ['1', '2']);
        t.mock.method(fs, 'readFileSync', (p) => {
            if (String(p) === '/proc/1/cmdline') return '/usr/bin/ffmpeg-old\0';
            if (String(p) === '/proc/2/cmdline') return '/usr/bin/ffmpeg\0';
            throw new Error('unexpected path');
        });
        assert.deepEqual(findPidsByExecutable('/usr/bin/ffmpeg'), [2]);
    });

    test('skips a pid whose cmdline disappears mid-scan without throwing', (t) => {
        t.mock.method(fs, 'readdirSync', () => ['1', '2']);
        t.mock.method(fs, 'readFileSync', (p) => {
            if (String(p) === '/proc/1/cmdline') throw new Error('ENOENT: exited mid-scan');
            if (String(p) === '/proc/2/cmdline') return '/usr/bin/ffmpeg\0';
            throw new Error('unexpected path');
        });
        assert.deepEqual(findPidsByExecutable('/usr/bin/ffmpeg'), [2]);
    });

    test('passes only the arguments (not argv[0]) to matchesArgs', (t) => {
        t.mock.method(fs, 'readdirSync', () => ['7']);
        t.mock.method(fs, 'readFileSync', () => '/usr/bin/ffmpeg\0-progress\0pipe:1\0');
        let received;
        findPidsByExecutable('/usr/bin/ffmpeg', (args) => {
            received = args;
            return true;
        });
        assert.deepEqual(received, ['-progress', 'pipe:1']);
    });

    test('excludes a match when matchesArgs returns false', (t) => {
        t.mock.method(fs, 'readdirSync', () => ['7']);
        t.mock.method(fs, 'readFileSync', () => '/usr/bin/ffmpeg\0-progress\0pipe:1\0');
        assert.deepEqual(
            findPidsByExecutable('/usr/bin/ffmpeg', () => false),
            [],
        );
    });

    test('an empty cmdline (zombie/kernel thread edge case) does not match and does not throw', (t) => {
        t.mock.method(fs, 'readdirSync', () => ['7']);
        t.mock.method(fs, 'readFileSync', () => '');
        assert.deepEqual(findPidsByExecutable('/usr/bin/ffmpeg'), []);
    });

    test('returns every matching pid, in /proc listing order', (t) => {
        t.mock.method(fs, 'readdirSync', () => ['10', '20', '30']);
        t.mock.method(fs, 'readFileSync', (p) => {
            const pid = String(p).split('/')[2];
            return pid === '20' ? '/other/bin\0' : '/usr/bin/ffmpeg\0';
        });
        assert.deepEqual(findPidsByExecutable('/usr/bin/ffmpeg'), [10, 30]);
    });
});

describe('createProcCpuTracker', () => {
    test('the first sample for a key returns null (no baseline yet)', (t) => {
        t.mock.method(fs, 'readFileSync', () => fakeStatLine(1, 'ffmpeg', 100, 50));
        const tracker = createProcCpuTracker();
        assert.equal(tracker.sample('out1', 1), null);
    });

    test('computes %CPU from the tick delta over the elapsed wall-clock time', (t) => {
        t.mock.method(fs, 'readFileSync', () => fakeStatLine(1, 'ffmpeg', 100, 50));
        let now = 1_000_000;
        t.mock.method(Date, 'now', () => now);
        const tracker = createProcCpuTracker();

        assert.equal(tracker.sample('out1', 1), null);

        now += 1000; // +1s
        t.mock.method(fs, 'readFileSync', () => fakeStatLine(1, 'ffmpeg', 200, 100)); // +150 ticks
        // 150 ticks / 100 CLK_TCK / 1s * 100 = 150% CPU
        assert.equal(tracker.sample('out1', 1), 150);
    });

    test('rounds %CPU to one decimal', (t) => {
        let now = 1_000_000;
        t.mock.method(Date, 'now', () => now);
        t.mock.method(fs, 'readFileSync', () => fakeStatLine(1, 'ffmpeg', 100, 50));
        const tracker = createProcCpuTracker();
        tracker.sample('out1', 1);

        now += 10_000; // +10s
        t.mock.method(fs, 'readFileSync', () => fakeStatLine(1, 'ffmpeg', 104, 50)); // +4 ticks
        // 4 ticks / 100 CLK_TCK / 10s * 100 = 0.4% CPU
        assert.equal(tracker.sample('out1', 1), 0.4);

        now += 10_000;
        t.mock.method(fs, 'readFileSync', () => fakeStatLine(1, 'ffmpeg', 119, 50)); // +15 ticks
        assert.equal(tracker.sample('out1', 1), 1.5);
    });

    test('returns null and rebaselines when ticks go backward (counter reset)', (t) => {
        let now = 1_000_000;
        t.mock.method(Date, 'now', () => now);
        t.mock.method(fs, 'readFileSync', () => fakeStatLine(1, 'ffmpeg', 500, 200));
        const tracker = createProcCpuTracker();
        tracker.sample('out1', 1); // baseline: 700 ticks

        now += 1000;
        t.mock.method(fs, 'readFileSync', () => fakeStatLine(1, 'ffmpeg', 10, 5)); // ticks went backward
        assert.equal(tracker.sample('out1', 1), null);

        // The next sample should compute against the new (lower) baseline, not
        // the stale higher one — otherwise the delta would be permanently
        // negative/nonsensical after any counter irregularity.
        now += 1000;
        t.mock.method(fs, 'readFileSync', () => fakeStatLine(1, 'ffmpeg', 110, 5)); // +100 ticks over 1s
        assert.equal(tracker.sample('out1', 1), 100);
    });

    test('returns null when the pid for a key changes (process restarted)', (t) => {
        let now = 1_000_000;
        t.mock.method(Date, 'now', () => now);
        t.mock.method(fs, 'readFileSync', () => fakeStatLine(1, 'ffmpeg', 500, 200));
        const tracker = createProcCpuTracker();
        tracker.sample('out1', 1);

        now += 1000;
        t.mock.method(fs, 'readFileSync', () => fakeStatLine(2, 'ffmpeg', 0, 0));
        // Same key, new pid (2, not 1) — must not diff against the old pid's ticks.
        assert.equal(tracker.sample('out1', 2), null);
    });

    test('returns null when the process disappears, and forgets it (next reappearance is a fresh baseline)', (t) => {
        let readImpl = () => fakeStatLine(1, 'ffmpeg', 100, 50);
        t.mock.method(fs, 'readFileSync', (...args) => readImpl(...args));
        const tracker = createProcCpuTracker();
        tracker.sample('out1', 1);

        readImpl = () => {
            throw new Error('ENOENT');
        };
        assert.equal(tracker.sample('out1', 1), null);

        readImpl = () => fakeStatLine(1, 'ffmpeg', 999, 999);
        assert.equal(tracker.sample('out1', 1), null, 'must be treated as a fresh first sample');
    });

    test('returns null (not Infinity/negative) when two samples land in the same millisecond', (t) => {
        const now = 1_000_000;
        t.mock.method(Date, 'now', () => now);
        t.mock.method(fs, 'readFileSync', () => fakeStatLine(1, 'ffmpeg', 100, 50));
        const tracker = createProcCpuTracker();
        tracker.sample('out1', 1);

        t.mock.method(fs, 'readFileSync', () => fakeStatLine(1, 'ffmpeg', 200, 100));
        assert.equal(tracker.sample('out1', 1), null);
    });

    test('tracks multiple keys independently', (t) => {
        let now = 1_000_000;
        t.mock.method(Date, 'now', () => now);
        t.mock.method(fs, 'readFileSync', (p) =>
            String(p).includes('/1/') ? fakeStatLine(1, 'a', 100, 0) : fakeStatLine(2, 'b', 500, 0),
        );
        const tracker = createProcCpuTracker();
        tracker.sample('a', 1);
        tracker.sample('b', 2);

        now += 1000;
        t.mock.method(fs, 'readFileSync', (p) =>
            String(p).includes('/1/') ? fakeStatLine(1, 'a', 200, 0) : fakeStatLine(2, 'b', 600, 0),
        );
        assert.equal(tracker.sample('a', 1), 100);
        assert.equal(tracker.sample('b', 2), 100);
    });

    test('delete() forgets the key so the next sample is treated as a fresh first sample', (t) => {
        let now = 1_000_000;
        t.mock.method(Date, 'now', () => now);
        t.mock.method(fs, 'readFileSync', () => fakeStatLine(1, 'ffmpeg', 100, 50));
        const tracker = createProcCpuTracker();
        tracker.sample('out1', 1);

        tracker.delete('out1');

        now += 1000;
        t.mock.method(fs, 'readFileSync', () => fakeStatLine(1, 'ffmpeg', 200, 100));
        assert.equal(tracker.sample('out1', 1), null);
    });

    test('delete() on a key that was never sampled is a no-op', () => {
        const tracker = createProcCpuTracker();
        assert.doesNotThrow(() => tracker.delete('never-seen'));
    });

    test('a malformed /proc/pid/stat (unparseable utime/stime) yields null', (t) => {
        t.mock.method(fs, 'readFileSync', () => '1 (ffmpeg) S 1 1 1 0 -1 0 0 0 0 0 x y');
        const tracker = createProcCpuTracker();
        assert.equal(tracker.sample('out1', 1), null);
    });
});

describe('readUdpBufferCeilings', () => {
    test('reads rmem_max and wmem_max', (t) => {
        t.mock.method(fs, 'readFileSync', (file) =>
            String(file).endsWith('/rmem_max') ? '16777216\n' : '212992\n',
        );
        assert.deepEqual(readUdpBufferCeilings(), {
            rmemMaxBytes: 16777216,
            wmemMaxBytes: 212992,
        });
    });

    test('reports null for a value that is unreadable or not a number', (t) => {
        t.mock.method(fs, 'readFileSync', (file) => {
            if (String(file).endsWith('/rmem_max')) throw new Error('ENOENT');
            return 'garbage\n';
        });
        assert.deepEqual(readUdpBufferCeilings(), { rmemMaxBytes: null, wmemMaxBytes: null });
    });
});

describe('readCpuPressure', () => {
    test('reads the some line of /proc/pressure/cpu', (t) => {
        t.mock.method(
            fs,
            'readFileSync',
            () =>
                'some avg10=0.88 avg60=0.38 avg300=0.22 total=2203264628\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n',
        );
        assert.deepEqual(readCpuPressure(), { some10: 0.88, some60: 0.38 });
    });

    test('returns null without PSI or on an unexpected format', (t) => {
        t.mock.method(fs, 'readFileSync', () => {
            throw new Error('ENOENT');
        });
        assert.equal(readCpuPressure(), null);
        t.mock.restoreAll();
        t.mock.method(fs, 'readFileSync', () => 'full avg10=0.00 avg60=0.00\n');
        assert.equal(readCpuPressure(), null);
    });
});

describe('readUdpStats', () => {
    const header =
        '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops\n';
    const files =
        (overrides = {}) =>
        (file) => {
            const content = {
                '/proc/net/snmp':
                    'Ip: Forwarding\nIp: 1\n' +
                    'Udp: InDatagrams NoPorts InErrors OutDatagrams RcvbufErrors SndbufErrors InCsumErrors\n' +
                    'Udp: 487216052 2936784 17093 209838627 17093 0 0\n',
                '/proc/net/udp':
                    header +
                    '  12: 00000000:2760 00000000:0000 07 00000000:0000A000 00:00000000 00000000  1000 0 1 2 0000000000000000 7\n' +
                    '  13: 0100007F:1388 00000000:0000 07 00000000:00000000 00:00000000 00000000  1000 0 2 2 0000000000000000 9\n',
                '/proc/net/udp6':
                    header +
                    '  14: 00000000000000000000000000000000:2761 00000000000000000000000000000000:0000 07 00000000:00000010 00:00000000 00000000  1000 0 3 2 0000000000000000 2\n',
                ...overrides,
            }[file];
            if (content === undefined) throw new Error(`ENOENT ${file}`);
            return content;
        };

    test('reads the host-wide drop counter and the queue and drops of the listed ports on IPv4 and IPv6', (t) => {
        t.mock.method(fs, 'readFileSync', files());
        assert.deepEqual(readUdpStats([10080, 10081]), {
            rcvbufErrors: 17093,
            sockets: [
                { port: 10080, rxQueueBytes: 40960, drops: 7 },
                { port: 10081, rxQueueBytes: 16, drops: 2 },
            ],
        });
    });

    test('ignores sockets on other ports and survives unreadable files', (t) => {
        t.mock.method(fs, 'readFileSync', files({ '/proc/net/snmp': undefined }));
        assert.deepEqual(readUdpStats([5000]), {
            rcvbufErrors: null,
            sockets: [{ port: 5000, rxQueueBytes: 0, drops: 9 }],
        });
        t.mock.restoreAll();
        t.mock.method(fs, 'readFileSync', () => {
            throw new Error('EACCES');
        });
        assert.deepEqual(readUdpStats([10080]), { rcvbufErrors: null, sockets: [] });
    });
});

describe('readHostMemory', () => {
    test('parses MemTotal/MemAvailable and derives swap in use', (t) => {
        t.mock.method(
            fs,
            'readFileSync',
            () =>
                'MemTotal:         981000 kB\nMemFree:  100000 kB\nMemAvailable:     240000 kB\nSwapTotal: 2048 kB\nSwapFree: 1024 kB\n',
        );
        assert.deepEqual(readHostMemory(), {
            totalBytes: 981000 * 1024,
            availableBytes: 240000 * 1024,
            swapUsedBytes: 1024 * 1024,
        });
    });

    test('treats a box with no swap as zero swap used', (t) => {
        t.mock.method(fs, 'readFileSync', () => 'MemTotal: 1000 kB\nMemAvailable: 500 kB\n');
        assert.equal(readHostMemory().swapUsedBytes, 0);
    });

    test('returns null when MemAvailable is missing or /proc is unreadable', (t) => {
        t.mock.method(fs, 'readFileSync', () => 'MemTotal: 1000 kB\n');
        assert.equal(readHostMemory(), null);
        t.mock.method(fs, 'readFileSync', () => {
            throw new Error('ENOENT');
        });
        assert.equal(readHostMemory(), null);
    });
});

describe('readDiskUsage', () => {
    test('reports total and available bytes of the filesystem holding the path', (t) => {
        t.mock.method(fs, 'statfsSync', () => ({ bsize: 4096, blocks: 1000, bavail: 250 }));
        t.mock.method(fs, 'statSync', () => ({ dev: 42 }));
        assert.deepEqual(readDiskUsage('/var/lib/bunryu'), {
            device: 42,
            totalBytes: 4096 * 1000,
            availableBytes: 4096 * 250,
        });
    });

    test('returns null for a missing path or a filesystem with no blocks', (t) => {
        t.mock.method(fs, 'statfsSync', () => {
            throw new Error('ENOENT');
        });
        assert.equal(readDiskUsage('/nope'), null);
        t.mock.method(fs, 'statfsSync', () => ({ bsize: 4096, blocks: 0, bavail: 0 }));
        assert.equal(readDiskUsage('/proc'), null);
    });
});

describe('topProcessesByRss', () => {
    test('returns the largest processes first, skipping ones that vanish mid-scan', (t) => {
        t.mock.method(fs, 'readdirSync', () => ['1', '20', '30', '40', 'self', 'cpuinfo']);
        t.mock.method(fs, 'readFileSync', (file) => {
            if (file === '/proc/1/status') return 'Name:\tsystemd\nVmRSS:\t 10000 kB\n';
            if (file === '/proc/20/status') return 'Name:\tnode\nVmRSS:\t 140000 kB\n';
            if (file === '/proc/30/status') return 'Name:\tkthreadd\nState:\tS\n'; // no VmRSS
            throw new Error('ENOENT'); // pid 40 exited
        });
        assert.deepEqual(topProcessesByRss(5), [
            { pid: 20, name: 'node', rssBytes: 140000 * 1024 },
            { pid: 1, name: 'systemd', rssBytes: 10000 * 1024 },
        ]);
        assert.equal(topProcessesByRss(1).length, 1);
    });

    test('returns an empty list when /proc is missing', (t) => {
        t.mock.method(fs, 'readdirSync', () => {
            throw new Error('ENOENT');
        });
        assert.deepEqual(topProcessesByRss(5), []);
    });
});
