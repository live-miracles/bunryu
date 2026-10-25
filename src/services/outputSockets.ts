import type { Output } from '../types.js';

const TCP_HEALTHY_STATES = new Set(['ESTAB', 'ESTABLISHED']);
const TCP_BAD_STATES = new Set([
    'CLOSE-WAIT',
    'CLOSING',
    'FIN-WAIT-1',
    'FIN-WAIT-2',
    'LAST-ACK',
    'TIME-WAIT',
]);

export interface TcpSocket {
    state: string;
    peerAddress: string;
    peerPort: number;
}

function parseEndpoint(endpoint: string): { address: string; port: number } | null {
    const bracket = endpoint.match(/^\[([^\]]+)\]:(\d+)$/);
    if (bracket) return { address: bracket[1], port: Number(bracket[2]) };
    const idx = endpoint.lastIndexOf(':');
    if (idx === -1) return null;
    const port = Number(endpoint.slice(idx + 1));
    return Number.isFinite(port) ? { address: endpoint.slice(0, idx), port } : null;
}

function isLocalAddress(address: string): boolean {
    const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
    return (
        normalized === '::1' ||
        normalized === 'localhost' ||
        normalized.startsWith('127.') ||
        normalized === '::ffff:7f00:1' ||
        normalized.startsWith('::ffff:127.')
    );
}

export function parseTcpSocketSnapshot(stdout: string): Map<number, TcpSocket[]> {
    const byPid = new Map<number, TcpSocket[]>();
    for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parts = trimmed.split(/\s+/);
        if (parts.length < 5) continue;
        const state = parts[0];
        const peer = parseEndpoint(parts[4]);
        if (peer == null) continue;

        const pidMatches = [...trimmed.matchAll(/pid=(\d+)/g)];
        for (const match of pidMatches) {
            const pid = Number(match[1]);
            if (!Number.isFinite(pid)) continue;
            const sockets = byPid.get(pid) ?? [];
            sockets.push({ state, peerAddress: peer.address, peerPort: peer.port });
            byPid.set(pid, sockets);
        }
    }
    return byPid;
}

function requiredRtmpSocket(output: Output): { port: number; local: boolean } | null {
    const url = output.url;
    if (!url.startsWith('rtmp://') && !url.startsWith('rtmps://')) return null;
    let port: number;
    let local: boolean;
    try {
        const parsed = new URL(url);
        port = parsed.port ? Number(parsed.port) : parsed.protocol === 'rtmps:' ? 443 : 1935;
        local = isLocalAddress(parsed.hostname);
    } catch {
        port = url.startsWith('rtmps://') ? 443 : 1935;
        local = false;
    }
    // Local RTMP sockets are ambiguous: the ffmpeg input pull and output push
    // both connect to local SRS, so leave local relays to the progress watchdog.
    if (local) return null;
    return { port, local };
}

function socketMatchesRequirement(
    socket: TcpSocket,
    requirement: { port: number; local: boolean },
): boolean {
    return (
        socket.peerPort === requirement.port &&
        isLocalAddress(socket.peerAddress) === requirement.local
    );
}

// Starts the warning of an output that is waiting for input data, not for its
// destination.
const NO_INPUT_DATA = 'No input data:';

export function isNoInputDataWarning(warning: string): boolean {
    return warning.startsWith(NO_INPUT_DATA);
}

// `wroteData` is whether this ffmpeg run has written anything yet. An output that
// has not, and never connected to its destination, is not a destination problem:
// ffmpeg opens the destination only after it has read enough of the input, so it
// is still waiting for the input (see the 2026-10-25 incident in the design
// decisions).
export function destinationSocketWarning(
    output: Output,
    pid: number | null,
    tcpSocketsByPid: Map<number, TcpSocket[]>,
    tcpSocketSnapshotUsable: boolean,
    wroteData = true,
): string | null {
    if (!tcpSocketSnapshotUsable || pid == null) return null;
    const requirement = requiredRtmpSocket(output);
    if (requirement == null) return null;

    const sockets = tcpSocketsByPid.get(pid) ?? [];
    const bad = sockets.find(
        (s) => socketMatchesRequirement(s, requirement) && TCP_BAD_STATES.has(s.state),
    );
    if (bad) return `RTMP socket ${bad.state} on destination port ${requirement.port}`;

    const healthy = sockets.some(
        (s) => socketMatchesRequirement(s, requirement) && TCP_HEALTHY_STATES.has(s.state),
    );
    if (!healthy) {
        return wroteData
            ? `RTMP socket missing (destination port ${requirement.port} not established)`
            : `${NO_INPUT_DATA} ffmpeg has written nothing and never connected to the destination (RTMP socket missing, port ${requirement.port})`;
    }

    return null;
}
