import dns from 'dns';
import net from 'net';
import os from 'os';
import { readSrsConfigValues } from './srsConfig.js';
import { extractStreamResource } from './srs.js';
import { RENDITION_APP } from './renditions.js';

// The server connects to whatever host an operator types into an output URL, so a
// stolen session (or a typo) could aim it at things only the server can reach. Private LAN ranges stay allowed — pushing to a venue
// encoder or a local media server is a real use — but the dangerous ones are
// not: link-local (cloud metadata at 169.254.169.254), the unspecified address
// (connects to this host), and loopback except for the app's own RTMP/SRT
// ports, which pipeline-to-pipeline restreams use.
//
// Hosts are resolved with dns.lookup, the same getaddrinfo call FFmpeg makes,
// so spellings that only the OS resolver understands ("2130706433", "0x7f.1",
// "127.1", "::ffff:127.0.0.1") are classified by what they really connect to.
// A name that fails to resolve is allowed (FFmpeg would fail the same way); DNS
// that changes between this check and FFmpeg's own lookup cannot be ruled out.

const blocked = new net.BlockList();
blocked.addSubnet('169.254.0.0', 16, 'ipv4');
blocked.addSubnet('0.0.0.0', 8, 'ipv4');
blocked.addAddress('100.100.100.200', 'ipv4'); // Alibaba Cloud metadata
blocked.addSubnet('fe80::', 10, 'ipv6');
blocked.addAddress('::', 'ipv6');
blocked.addAddress('fd00:ec2::254', 'ipv6'); // AWS IMDS over IPv6

const loopback = new net.BlockList();
loopback.addSubnet('127.0.0.0', 8, 'ipv4');
loopback.addAddress('::1', 'ipv6');

const LOOKUP_TIMEOUT_MS = 3000;

export type AddressClass = 'blocked' | 'loopback' | 'other';

export function classifyAddress(address: string): AddressClass {
    const family = net.isIP(address) === 6 ? 'ipv6' : 'ipv4';
    if (blocked.check(address, family)) return 'blocked';
    if (loopback.check(address, family)) return 'loopback';
    return 'other';
}

export async function resolveAddresses(host: string): Promise<string[]> {
    const bare = host.replace(/^\[|\]$/g, '');
    if (net.isIP(bare)) return [bare];
    try {
        const results = await Promise.race([
            dns.promises.lookup(bare, { all: true }),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('lookup timeout')), LOOKUP_TIMEOUT_MS).unref(),
            ),
        ]);
        return results.map((r) => r.address);
    } catch {
        return [];
    }
}

function parseDestination(url: string): { host: string; port: number | null } | null {
    const m = /^(rtmps?|srt):\/\/(?:[^@/?#]*@)?(\[[^\]]+\]|[^:/?#]+)(?::(\d+))?/i.exec(url);
    if (!m) return null;
    const scheme = m[1].toLowerCase();
    const port = m[3] ? Number(m[3]) : scheme === 'rtmp' ? 1935 : scheme === 'rtmps' ? 443 : null;
    return { host: m[2], port };
}

function isSrtListener(url: string): boolean {
    return /[?&]mode=listener(?:&|$)/i.test(url);
}

// Returns a human-readable reason when an output destination must not be used,
// or null when it is fine.
export async function checkOutputDestination(url: string): Promise<string | null> {
    // A listener output binds a local port instead of connecting out; that mode
    // is a supported feature and has no remote host to check.
    if (isSrtListener(url)) return null;
    const dest = parseDestination(url);
    if (!dest) return null;
    const own = readSrsConfigValues();
    const ownPorts = new Set([own.rtmpPort, own.srtPort]);
    for (const address of await resolveAddresses(dest.host)) {
        const kind = classifyAddress(address);
        if (kind === 'blocked') {
            return `destination host ${dest.host} resolves to ${address}, a link-local or unspecified address that is not allowed`;
        }
        if (kind === 'loopback' && !(dest.port !== null && ownPorts.has(dest.port))) {
            return `destination host ${dest.host} resolves to loopback (${address}); only this server's own RTMP/SRT ports are allowed there`;
        }
    }
    return null;
}

// True when an RTMP(S) destination points at this host's loopback and into the
// reserved "internal" app, where shared encodes (renditions) live. Judged by what
// the host resolves to, like checkOutputDestination, so "localhost", "127.1" or a
// numeric spelling cannot be used to publish into (or take over) a shared encode's
// stream. Deliberately separate from checkOutputDestination: that one also runs
// over existing rows at boot and must keep passing the renditions themselves.
export async function isInternalAppDestination(url: string): Promise<boolean> {
    const m = /^rtmps?:\/\/(?:[^@/?#]*@)?(\[[^\]]+\]|[^:/?#]+)(?::\d+)?(\/[^?#]*)?/i.exec(url);
    if (!m || !(m[2] ?? '').startsWith(`/${RENDITION_APP}/`)) return false;
    const addresses = await resolveAddresses(m[1]);
    return addresses.some((address) => classifyAddress(address) === 'loopback');
}

function isThisHost(address: string): boolean {
    if (classifyAddress(address) === 'loopback') return true;
    return Object.values(os.networkInterfaces()).some((list) =>
        list?.some((iface) => iface.address === address),
    );
}

// The stream key an output publishes into on this server's own ingest (`live/<key>` on
// its RTMP or SRT port, on loopback or one of this machine's own addresses), or null for
// any other destination. Restream loop detection compares it with pipelines' input keys.
// A public address that is NAT-ed to this machine and not on one of its interfaces looks
// like any remote host, so it is not recognised.
export async function ownIngestKey(url: string): Promise<string | null> {
    if (isSrtListener(url)) return null;
    const dest = parseDestination(url);
    if (!dest || dest.port === null) return null;
    const own = readSrsConfigValues();
    if (dest.port !== own.rtmpPort && dest.port !== own.srtPort) return null;

    let resource: string | null;
    if (/^srt:/i.test(url)) {
        resource = extractStreamResource(url);
    } else {
        resource = /^rtmps?:\/\/[^/?#]+(\/[^?#]*)/i.exec(url)?.[1]?.replace(/^\/+/, '') ?? null;
    }
    const m = /^live\/([^/?#,]+)/.exec(resource ?? '');
    if (!m) return null;

    const addresses = await resolveAddresses(dest.host);
    return addresses.some(isThisHost) ? m[1] : null;
}
