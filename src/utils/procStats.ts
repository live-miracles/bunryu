import fs from 'fs';

const CLK_TCK = 100; // USER_HZ; the near-universal Linux default (no portable sysconf() from Node)

// procfs reads of small single files; cheap enough for a 5-10s poll per process
// (page-cache hit, no real disk I/O).
export function readProcRssBytes(pid: number): number | null {
    try {
        const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
        const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
        return match ? parseInt(match[1], 10) * 1024 : null;
    } catch {
        return null;
    }
}

export interface HostMemory {
    totalBytes: number;
    // MemAvailable is the kernel's estimate of what can be allocated without
    // swapping (free + reclaimable cache); "free" alone is misleadingly low on
    // a healthy box because the page cache fills whatever is left over.
    availableBytes: number;
    swapUsedBytes: number;
}

export function readHostMemory(): HostMemory | null {
    try {
        const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
        const kb = (name: string): number | null => {
            const match = new RegExp(`^${name}:\\s+(\\d+)\\s+kB$`, 'm').exec(meminfo);
            return match ? parseInt(match[1], 10) * 1024 : null;
        };
        const totalBytes = kb('MemTotal');
        const availableBytes = kb('MemAvailable');
        if (totalBytes == null || availableBytes == null) return null;
        const swapTotal = kb('SwapTotal') ?? 0;
        const swapFree = kb('SwapFree') ?? 0;
        return { totalBytes, availableBytes, swapUsedBytes: Math.max(0, swapTotal - swapFree) };
    } catch {
        return null;
    }
}

export interface UdpBufferCeilings {
    // The kernel silently caps a socket's requested buffer at these (see the
    // UDP buffer ceiling section of the configuration docs); null if unreadable.
    rmemMaxBytes: number | null;
    wmemMaxBytes: number | null;
}

export function readUdpBufferCeilings(): UdpBufferCeilings {
    const read = (name: string): number | null => {
        try {
            const value = parseInt(fs.readFileSync(`/proc/sys/net/core/${name}`, 'utf8'), 10);
            return Number.isFinite(value) ? value : null;
        } catch {
            return null;
        }
    };
    return { rmemMaxBytes: read('rmem_max'), wmemMaxBytes: read('wmem_max') };
}

export interface CpuPressure {
    // Percent of the last 10 s / 60 s in which at least one runnable task waited for
    // a CPU (PSI "some"). Reads near zero on a healthy host and rises when
    // something such as an encode starves the others, which steal time alone misses.
    some10: number;
    some60: number;
}

// null when the kernel has no PSI (older kernels, some containers).
export function readCpuPressure(): CpuPressure | null {
    try {
        const line = fs
            .readFileSync('/proc/pressure/cpu', 'utf8')
            .split('\n')
            .find((l) => l.startsWith('some '));
        const avg10 = /\bavg10=([\d.]+)/.exec(line ?? '');
        const avg60 = /\bavg60=([\d.]+)/.exec(line ?? '');
        if (!avg10 || !avg60) return null;
        return { some10: Number(avg10[1]), some60: Number(avg60[1]) };
    } catch {
        return null;
    }
}

export interface UdpSocketStats {
    port: number;
    // Bytes waiting in the socket's kernel receive queue and datagrams the kernel
    // dropped because it was full (cumulative since the socket was created).
    rxQueueBytes: number;
    drops: number;
}

export interface UdpStats {
    // Host-wide datagrams dropped for a full receive buffer (cumulative); null if
    // /proc/net/snmp is unreadable.
    rcvbufErrors: number | null;
    sockets: UdpSocketStats[];
}

// The kernel's UDP counters, for the listed local ports (the SRT ingest sockets).
// Each of /proc/net/udp and /proc/net/udp6 has one line per socket:
//   sl local_address rem_address st tx_queue:rx_queue tr:tm->when retrnsmt uid
//   timeout inode ref pointer drops
export function readUdpStats(ports: number[]): UdpStats {
    let rcvbufErrors: number | null = null;
    try {
        const lines = fs.readFileSync('/proc/net/snmp', 'utf8').split('\n');
        const header = lines.findIndex((l) => l.startsWith('Udp:'));
        const names = lines[header]?.split(/\s+/);
        const values = lines[header + 1]?.split(/\s+/);
        const at = names?.indexOf('RcvbufErrors') ?? -1;
        if (at > 0 && values?.[0] === 'Udp:' && Number.isFinite(Number(values[at]))) {
            rcvbufErrors = Number(values[at]);
        }
    } catch {
        /* leave null */
    }
    const wanted = new Set(ports);
    const sockets: UdpSocketStats[] = [];
    for (const file of ['/proc/net/udp', '/proc/net/udp6']) {
        let text: string;
        try {
            text = fs.readFileSync(file, 'utf8');
        } catch {
            continue;
        }
        for (const line of text.split('\n').slice(1)) {
            const f = line.trim().split(/\s+/);
            if (f.length < 13) continue;
            const port = parseInt(f[1].slice(f[1].lastIndexOf(':') + 1), 16);
            const rxQueue = parseInt(f[4].split(':')[1] ?? '', 16);
            const drops = parseInt(f[12], 10);
            if (!wanted.has(port) || !Number.isFinite(rxQueue) || !Number.isFinite(drops)) continue;
            sockets.push({ port, rxQueueBytes: rxQueue, drops });
        }
    }
    return { rcvbufErrors, sockets };
}

export interface ProcessRss {
    pid: number;
    name: string;
    rssBytes: number;
}

// Largest processes by RSS, for post-incident evidence when host memory runs
// low. Scans all of /proc, so only call it on a transition, not on a poll.
export function topProcessesByRss(limit: number): ProcessRss[] {
    let entries: string[];
    try {
        entries = fs.readdirSync('/proc');
    } catch {
        return [];
    }
    const found: ProcessRss[] = [];
    for (const entry of entries) {
        if (!/^\d+$/.test(entry)) continue;
        try {
            const status = fs.readFileSync(`/proc/${entry}/status`, 'utf8');
            const name = /^Name:\s+(.+)$/m.exec(status)?.[1];
            const rss = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
            if (name && rss) {
                found.push({ pid: Number(entry), name, rssBytes: parseInt(rss[1], 10) * 1024 });
            }
        } catch {
            continue; // process exited mid-scan
        }
    }
    return found.sort((a, b) => b.rssBytes - a.rssBytes).slice(0, limit);
}

function readProcCpuTicks(pid: number): number | null {
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        // comm (2nd field) can contain spaces/parens, so split after its closing
        // ')' rather than trusting fixed whitespace-separated offsets from the start.
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const utime = parseInt(fields[11], 10); // utime is the 14th field overall
        const stime = parseInt(fields[12], 10); // stime is the 15th field overall
        return Number.isFinite(utime) && Number.isFinite(stime) ? utime + stime : null;
    } catch {
        return null;
    }
}

// Scans /proc for running processes whose argv[0] is exactly execPath. Used at
// startup to find ffmpeg children orphaned by a previous instance of this
// process (killed by 'tsx watch', a crash, OOM, ...) — the '-progress pipe:1'
// SIGPIPE self-exit ffmpeg is meant to trigger once our stdout pipe closes
// isn't reliable enough to depend on alone.
export function findPidsByExecutable(
    execPath: string,
    matchesArgs: (args: string[]) => boolean = () => true,
): number[] {
    let entries: string[];
    try {
        entries = fs.readdirSync('/proc');
    } catch {
        return []; // no /proc (non-Linux dev machine)
    }
    const pids: number[] = [];
    for (const entry of entries) {
        if (!/^\d+$/.test(entry)) continue;
        let cmdline: string;
        try {
            cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8');
        } catch {
            continue; // process exited mid-scan
        }
        const args = cmdline.split('\0').filter(Boolean);
        if (args[0] === execPath && matchesArgs(args.slice(1))) pids.push(Number(entry));
    }
    return pids;
}

export interface ProcCpuTracker {
    // %CPU relative to a single core (ps/top convention), not normalized by core
    // count, rounded to one decimal. Returns null on the first sample for a key, and again on the first
    // sample after its pid changes (process restart reusing the same key), since
    // there's no prior tick count yet to diff against.
    sample(key: string | number, pid: number): number | null;
    delete(key: string | number): void;
}

export function createProcCpuTracker(): ProcCpuTracker {
    const prev = new Map<string | number, { pid: number; ts: number; ticks: number }>();
    return {
        sample(key, pid) {
            const ticks = readProcCpuTicks(pid);
            if (ticks == null) {
                prev.delete(key);
                return null;
            }
            const now = Date.now();
            const last = prev.get(key);
            prev.set(key, { pid, ts: now, ticks });
            if (!last || last.pid !== pid || ticks < last.ticks) return null;
            const dtSeconds = (now - last.ts) / 1000;
            return dtSeconds > 0
                ? Math.round(((ticks - last.ticks) / CLK_TCK / dtSeconds) * 1000) / 10
                : null;
        },
        delete(key) {
            prev.delete(key);
        },
    };
}
