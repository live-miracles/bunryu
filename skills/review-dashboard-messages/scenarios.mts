/* eslint-disable @typescript-eslint/no-explicit-any -- the payloads edited here are the dashboard's untyped JSON */
// The catalogue: one entry per message the dashboard can show, the data that provokes it, and
// which screenshots to take. `apply` edits the real health/config payloads in the proxy.
export interface Ctx {
    health: any;
    config: any;
    metrics: any;
    events: any;
    rejected: { rejected: any[]; omitted: number };
}

export type Shot =
    | { kind: 'banner' }
    | { kind: 'ov-inputs' | 'ov-outputs' | 'ov-relay' | 'ov-shared' }
    | { kind: 'status-dot'; dot: 'input' | number }
    | { kind: 'status-card' }
    | { kind: 'status-top' }
    | { kind: 'sidebar-dot' }
    | { kind: 'pipeline-input' }
    | { kind: 'out-card'; out?: number }
    | { kind: 'out-hint'; out: number }
    | { kind: 'status-problems' }
    | { kind: 'topbar' }
    | { kind: 'sidebar-rejected' };

export interface Entry {
    id: string;
    section: string;
    title: string;
    // The text the user sees, as the dashboard draws it (filled in from the capture when possible).
    when: string; // when it shows
    clears?: string; // when it goes away
    shots: Shot[];
    // Load the page under the baseline, then switch to this scenario (needed for a failing server).
    post?: boolean;
    down?: boolean;
    pipelineView?: boolean; // shots are taken on the pipeline page (/?p=1)
    apply?: (c: Ctx) => void;
}

const now = () => Date.now();
const P = (c: Ctx) => c.health.pipelines['1'];
const inp = (c: Ctx, patch: Record<string, unknown>) => Object.assign(P(c).input, patch);
const out = (c: Ctx, id: string, patch: Record<string, unknown>) =>
    Object.assign(P(c).outputs[id], patch);
const cfgOut = (c: Ctx, id: string, patch: Record<string, unknown>) =>
    Object.assign(
        c.config.outputs.find((o: any) => o.id === id),
        patch,
    );
const stored = (msg: string, agoMs = 4000) => `${now() - agoMs}\n${msg}`;
const alert = (
    c: Ctx,
    code: string,
    message: string,
    sinceAgoMs = 30_000,
    severity: 'warning' | 'error' = 'warning',
) => P(c).alerts.push({ severity, code, message, sinceMs: now() - sinceAgoMs });
// A host alert as /api/health now carries it (the server's rule: warning from 70 %, error from 90 %).
const hostAlert = (
    c: Ctx,
    kind: 'cpu' | 'memory' | 'disk',
    severity: 'warning' | 'error',
    message: string,
    sinceAgoMs = 120_000,
) => c.health.hostAlerts.push({ kind, severity, message, sinceMs: now() - sinceAgoMs });

function srtInput(c: Ctx): void {
    inp(c, { isSrt: true, publisherType: 'srt-publish', publisherIp: '203.0.113.7' });
}
const leg = (ip: string, over: Record<string, unknown> = {}) => ({
    ip,
    port: 20000 + Number(ip.split('.')[3]),
    state: 'running',
    rttMs: 41,
    latencyMs: 120,
    recvPacketsTotal: 90000,
    recvUniquePacketsTotal: 90000,
    recvLossTotal: 12,
    recvDropTotal: 0,
    retransTotal: 30,
    bandwidthMbps: 20,
    recvRateMbps: 4.1,
    belatedTotal: 0,
    belatedAvgMs: 0,
    undecryptTotal: 0,
    reorderDistance: 0,
    rcvBufMs: 118,
    health: 'ok',
    healthReason: null,
    recent: { spanMs: 600000, packets: 90000, loss: 12, retrans: 30, drop: 0 },
    ...over,
});
// A healthy bonded SRT input through the relay; the scenario then breaks one thing.
function relay(
    c: Ctx,
    over: Record<string, any> = {},
    legs: any[] | null = null,
    expected = 2,
): void {
    srtInput(c);
    // The stack's outputs are RTMP with copy audio, which the dashboard advises against on an
    // SRT input ("should not use copy audio": a yellow outline round the dot). Give them a track,
    // as a real SRT pipeline's would, so a relay shot shows only what its scenario provokes.
    for (const o of c.config.outputs) if (o.audioEncoding === 'copy') o.audioEncoding = '0';
    const l = legs ?? [leg('198.51.100.11'), leg('198.51.100.12')];
    Object.assign(P(c).srtBonding, {
        inputActive: true,
        outputConnected: true,
        acceptedBySrs: true,
        publishConflict: false,
        localSrtPublisherConflict: false,
        retryFailures: 0,
        forwardedPackets: 250000,
        forwardedBytes: 300_000_000,
        lastPacketAt: now() - 400,
        lastInputPacketAt: now() - 400,
        lastError: null,
        ...over,
    });
    Object.assign(P(c).srtBonding.input, {
        bonded: true,
        legs: l,
        expectedLegs: expected,
        recvUniquePacketsTotal: 180000,
        recent: { spanMs: 600000, packets: 180000, loss: 24, retrans: 60, drop: 0 },
    });
}

const cloneOutputs = (c: Ctx, n: number): void => {
    const base = c.config.outputs[0];
    const hb = P(c).outputs['1-1'];
    for (let i = 5; i < 5 + n; i++) {
        c.config.outputs.push({
            ...base,
            id: `1-${i}`,
            seq: i,
            name: `Extra_${i - 4}`,
            url: `rtmp://192.0.2.${10 + i}/live/test`,
        });
        P(c).outputs[`1-${i}`] = { ...hb, pid: hb.pid + i };
    }
};

export const catalog: Entry[] = [
    // ───────────────────────── Banners and top bar ─────────────────────────
    {
        id: 'banner-server',
        section: 'Banners and top bar',
        title: 'Cannot reach server — retrying…',
        when: 'The dashboard’s own poll of the control plane fails (network error, server restarting or down). It replaces the SRS banner, so only one is shown.',
        clears: 'The next poll that succeeds.',
        shots: [{ kind: 'banner' }],
        down: true,
        post: true,
    },
    {
        id: 'banner-srs',
        section: 'Banners and top bar',
        title: 'SRS media server is unreachable — streaming unavailable',
        when: '/api/health says srsReachable is false (the control plane cannot talk to SRS’s HTTP API) while the server itself is reachable.',
        clears: 'The next health poll where SRS answers.',
        shots: [{ kind: 'banner' }],
        apply: (c) => {
            c.health.srsReachable = false;
        },
    },
    {
        id: 'banner-relay-stopped',
        section: 'Banners and top bar',
        title: 'SRT relay is not running',
        when: 'The Goryu relay’s status is anything but “running” and it has no last error (stopped, stopping).',
        clears: 'The relay reports running again.',
        shots: [{ kind: 'banner' }],
        apply: (c) => {
            c.health.srtRelay = {
                status: 'stopped',
                pid: null,
                startedAtMs: null,
                lastError: null,
                port: 10081,
            };
        },
    },
    {
        id: 'banner-relay-failed',
        section: 'Banners and top bar',
        title: 'SRT relay is not responding (<last error>)',
        when: 'The relay is not “running” and has a last error (it was reached once, then failed). The error text from the relay is appended.',
        clears: 'The relay reports running again.',
        shots: [{ kind: 'banner' }],
        apply: (c) => {
            c.health.srtRelay = {
                status: 'failed',
                pid: null,
                startedAtMs: now() - 600000,
                lastError: 'connect ECONNREFUSED 127.0.0.1:10081',
                port: 10081,
            };
        },
    },
    {
        id: 'banner-passphrase',
        section: 'Banners and top bar',
        title: 'SRT passphrase was reset — reboot the server to apply it',
        when: 'Settings → Reset SRT passphrase was used and the new passphrase is written but not yet loaded (srtPassphrasePending).',
        clears: 'After the server (or container) restarts.',
        shots: [{ kind: 'banner' }],
        apply: (c) => {
            c.config.srtPassphrasePending = true;
        },
    },
    {
        id: 'banner-publichost',
        section: 'Banners and top bar',
        title: 'Public Host is not set — publish URLs show localhost',
        when: 'The Public Host setting is empty. The banner links to Settings.',
        clears: 'Once a Public Host is saved.',
        shots: [{ kind: 'banner' }],
        apply: (c) => {
            c.config.publicHost = '';
        },
    },
    {
        id: 'topbar-warn',
        section: 'Banners and top bar',
        title: 'Host alert: CPU / RAM / Disk at 70 % or more (warning)',
        when: 'The server raises a host alert when the host’s CPU is 70 % busy for 30 s, memory is 70 % used, or the fullest watched disk is 70 % full. The dashboard shows one yellow banner per alert, and the number in the top bar turns yellow and bold. The colour comes from the same alert, so the bar, the banner and the Server events always agree. Not a Problem and it does not beep.',
        clears: 'CPU: under 65 % for 60 s. Memory and disk: under 65 %.',
        shots: [{ kind: 'banner' }, { kind: 'topbar' }],
        apply: (c) => {
            c.metrics.cpu.percent = 74;
            c.metrics.ram.usedBytes = Math.round(c.metrics.ram.totalBytes * 0.78);
            c.metrics.disk.usedBytes = Math.round(c.metrics.disk.totalBytes * 0.72);
            hostAlert(c, 'cpu', 'warning', 'CPU is at 74% (warning from 70%).');
            hostAlert(c, 'memory', 'warning', 'Memory is at 78% (warning from 70%).');
            hostAlert(c, 'disk', 'warning', 'Disk /var/lib/bunryu is 72% full (warning from 70%).');
        },
    },
    {
        id: 'topbar-error',
        section: 'Banners and top bar',
        title: 'Host alert: CPU / RAM / Disk at 90 % or more (error)',
        when: 'The same alerts at 90 %: a red banner and a red, bold number in the top bar. A memory or disk error also beeps once when it opens (a warning and CPU do not). CPU also has a second error: CPU pressure of 50 % or more for 30 s means work is already being starved, even if the busy figure is lower (“CPU is saturated: tasks waited N% of the last 10 s for a CPU.”).',
        clears: 'An error ends under 85 %; a warning then stays until under 65 %. CPU pressure ends under 30 % for 60 s.',
        shots: [{ kind: 'banner' }, { kind: 'topbar' }],
        apply: (c) => {
            c.metrics.cpu.percent = 93;
            c.metrics.ram.usedBytes = Math.round(c.metrics.ram.totalBytes * 0.94);
            c.metrics.disk.usedBytes = Math.round(c.metrics.disk.totalBytes * 0.95);
            hostAlert(c, 'cpu', 'error', 'CPU is at 93% (critical from 90%).');
            hostAlert(c, 'memory', 'error', 'Memory is at 94% (critical from 90%).');
            hostAlert(c, 'disk', 'error', 'Disk /var/lib/bunryu is 95% full (critical from 90%).');
        },
    },
    {
        id: 'topbar-pressure',
        section: 'Banners and top bar',
        title: 'Host alert: CPU saturated (pressure)',
        when: 'CPU pressure (the share of the last 10 s in which a runnable task waited for a CPU) is 50 % or more for 30 s. An error banner even when the busy figure is below 90 %, because it means encodes and SRS are already competing for CPU. The top bar’s CPU number turns red.',
        clears: 'Pressure under 30 % for 60 s.',
        shots: [{ kind: 'banner' }, { kind: 'topbar' }],
        apply: (c) => {
            c.metrics.cpu.percent = 82;
            hostAlert(
                c,
                'cpu',
                'error',
                'CPU is saturated: tasks waited 58% of the last 10 s for a CPU.',
            );
        },
    },

    // ───────────────────────── Input ─────────────────────────
    {
        id: 'in-ok',
        section: 'Input status',
        title: 'Healthy input (reference)',
        when: 'Publisher connected, ffprobe validated it, bitrate at least 200 kb/s, an audio track present and no input alerts. Status OK, Issues empty.',
        shots: [{ kind: 'ov-inputs' }, { kind: 'status-dot', dot: 'input' }],
    },
    {
        id: 'in-off',
        section: 'Input status',
        title: 'No publisher is connected; N outputs affected',
        when: 'Nobody is publishing to the pipeline’s key. On its own an offline input is just “offline” (grey, no issue). It becomes a Problem in the Issues view only when outputs that should be running are in trouble, because this row is their cause. The sentence shows only on the Overview Inputs table; the Status card’s dot says “Input: offline”.',
        clears: 'When a publisher connects (or the affected outputs are stopped).',
        shots: [
            { kind: 'ov-inputs' },
            { kind: 'status-dot', dot: 'input' },
            { kind: 'status-dot', dot: 0 },
        ],
        apply: (c) => {
            Object.assign(P(c).input, {
                connected: false,
                live: false,
                mediaOk: null,
                mediaError: null,
                recvBitrateKbps: null,
                uptimeMs: null,
                readers: 0,
                publisherIp: null,
                publisherType: null,
                video: null,
                audio: null,
                audioTracks: [],
                keyframes: null,
            });
            for (const id of Object.keys(P(c).outputs)) {
                out(c, id, {
                    status: 'stopped',
                    pid: null,
                    bitrateKbps: null,
                    startedAtMs: null,
                    failures: 0,
                    nextRetryAtMs: now() + 8000,
                });
            }
        },
    },
    {
        id: 'in-off-idle',
        section: 'Input status',
        title: 'Offline input, nothing should run (not a problem)',
        when: 'No publisher and every output is stopped by the operator. Grey status, no Issues text, not counted in the Issues view.',
        shots: [{ kind: 'ov-inputs' }, { kind: 'status-card' }],
        apply: (c) => {
            Object.assign(P(c).input, {
                connected: false,
                live: false,
                mediaOk: null,
                recvBitrateKbps: null,
                uptimeMs: null,
                publisherIp: null,
                video: null,
                audio: null,
                audioTracks: [],
                keyframes: null,
            });
            for (const o of c.config.outputs) o.desiredState = 'stopped';
            for (const id of Object.keys(P(c).outputs)) {
                out(c, id, {
                    status: 'stopped',
                    pid: null,
                    bitrateKbps: null,
                    startedAtMs: null,
                    failures: 0,
                    nextRetryAtMs: null,
                });
            }
        },
    },
    {
        id: 'in-probe-pending',
        section: 'Input status',
        title: 'Waiting for ffprobe to finish and return the input encoding.',
        when: 'The publisher is connected but ffprobe has not returned yet (first seconds of a new publisher, or a probe retry). Warning, not an error.',
        clears: 'When ffprobe returns usable media (or fails: next entry).',
        shots: [{ kind: 'ov-inputs' }, { kind: 'status-dot', dot: 'input' }],
        apply: (c) => {
            inp(c, { mediaOk: null, mediaError: null, video: null, audio: null, audioTracks: [] });
        },
    },
    {
        id: 'in-probe-error',
        section: 'Input status',
        title: 'ffprobe did not detect a video stream (probe error)',
        when: 'ffprobe finished but found no usable video (no stream, no codec, or no dimensions). Error status. The text is ffprobe’s result; how long it has been failing is shown after it (“since 5 min ago”) in the viewer’s own time, like the other relative times. A failed probe wins over the “waiting” state.',
        clears: 'When a later probe succeeds.',
        shots: [{ kind: 'ov-inputs' }, { kind: 'status-dot', dot: 'input' }],
        apply: (c) => {
            inp(c, {
                mediaOk: false,
                mediaError: 'ffprobe did not detect a video stream',
                mediaFailingSince: now() - 5 * 60_000,
                video: null,
            });
        },
    },
    {
        id: 'in-not-live',
        section: 'Input status',
        title: 'Input connected, waiting for valid media.',
        when: 'SRS lists a publisher and ffprobe succeeded, but SRS does not (yet) report the stream as live.',
        clears: 'When the stream becomes live.',
        shots: [{ kind: 'ov-inputs' }, { kind: 'status-dot', dot: 'input' }],
        apply: (c) => {
            inp(c, { live: false });
        },
    },
    {
        id: 'in-low-bitrate',
        section: 'Input status',
        title: 'Input bitrate is below 200 kb/s.',
        when: 'The publisher has been live for 30 s or more (SRS reports 0 until its statistics warm up) and SRS’s receive bitrate is under 200 kb/s.',
        clears: 'When the bitrate is 200 kb/s or more.',
        shots: [{ kind: 'ov-inputs' }, { kind: 'status-dot', dot: 'input' }],
        apply: (c) => {
            inp(c, { recvBitrateKbps: 90, uptimeMs: 120_000 });
        },
    },
    {
        id: 'in-no-audio',
        section: 'Input status',
        title: 'No audio track detected in input.',
        when: "ffprobe found no audio track at all (neither a track list nor a single audio stream). It is a warning with a hint (alert code input-no-audio): platforms usually reject or mute a stream without audio, so check that the encoder's audio is on and its source connected.",
        clears: 'When the encoder sends audio.',
        shots: [{ kind: 'ov-inputs' }, { kind: 'status-dot', dot: 'input' }],
        apply: (c) => {
            inp(c, { audio: null, audioTracks: [] });
        },
    },
    {
        id: 'in-low-fps',
        section: 'Input alerts',
        title: 'Input is delivering X fps; ffprobe reports Y fps. (low)',
        when: 'The frame rate measured from SRS’s frame counter is more than 10 % below the nominal rate ffprobe read, i.e. the encoder drops frames. Alert code input-low-framerate, with a hint.',
        clears: 'When the measured rate is back within 10 % of the nominal rate.',
        shots: [{ kind: 'ov-inputs' }, { kind: 'status-dot', dot: 'input' }],
        apply: (c) =>
            alert(
                c,
                'input-low-framerate',
                'Input is delivering 21.3 fps; ffprobe reports 25 fps.',
            ),
    },
    {
        id: 'in-high-fps',
        section: 'Input alerts',
        title: 'Input is delivering X fps; ffprobe reports Y fps. (high)',
        when: 'The measured rate is more than 10 % above the nominal rate (encoder clock or frame-rate setting wrong). Alert code input-high-framerate.',
        clears: 'When the measured rate is back within 10 % of the nominal rate.',
        shots: [{ kind: 'ov-inputs' }],
        apply: (c) =>
            alert(
                c,
                'input-high-framerate',
                'Input is delivering 31.4 fps; ffprobe reports 25 fps.',
            ),
    },
    {
        id: 'in-keyframe',
        section: 'Input alerts',
        title: 'Input keyframes are too far apart',
        when: 'Once per publisher, ffprobe reads 12 s of video packets (it needs at least 10 s of span to judge); the alert shows when the longest gap between keyframes is above 4.25 s (or there is no/one keyframe). The warning states only the measurement; the hint under it says what to do (2 s, never more than 4 s) and why, so the two do not repeat. Alert code input-keyframe-interval; also written to the pipeline log.',
        clears: 'When a new publisher with a good keyframe interval connects (the check runs once per publisher).',
        shots: [{ kind: 'ov-inputs' }, { kind: 'status-dot', dot: 'input' }],
        apply: (c) =>
            alert(
                c,
                'input-keyframe-interval',
                'Input keyframes are too far apart: the longest gap in 12 s of video is 9.8 s.',
            ),
    },
    {
        id: 'in-interlaced',
        section: 'Input alerts',
        title: 'Input is interlaced (1080i50tff)',
        when: 'ffprobe reports a field order other than progressive. YouTube does not support interlaced video; a 1080i input also once left copy outputs sending only audio. Alert code input-interlaced.',
        clears: 'When the publisher sends progressive video.',
        shots: [{ kind: 'ov-inputs' }, { kind: 'status-dot', dot: 'input' }],
        apply: (c) =>
            alert(
                c,
                'input-interlaced',
                'Input is interlaced (1080i50tff). YouTube does not support interlaced video and warns of artifacts.',
            ),
    },
    {
        id: 'in-flapping',
        section: 'Input alerts',
        title: 'Input disconnected N times in the last 5 minutes.',
        when: 'The publisher disconnected 3 or more times within 5 minutes. Alert code input-flapping.',
        clears: 'When the disconnects age out of the 5-minute window.',
        shots: [{ kind: 'ov-inputs' }, { kind: 'status-dot', dot: 'input' }],
        apply: (c) =>
            alert(
                c,
                'input-flapping',
                'Input disconnected 4 times in the last 5 minutes.',
                200_000,
            ),
    },
    {
        id: 'in-multiple',
        section: 'Input alerts',
        title: 'Several input issues at once',
        when: 'Issues stack: each of the above that applies is listed (here low bitrate, no audio and interlaced). The status is the worst of them; all are warnings.',
        shots: [{ kind: 'ov-inputs' }, { kind: 'status-dot', dot: 'input' }],
        apply: (c) => {
            inp(c, { recvBitrateKbps: 90, uptimeMs: 120_000, audio: null, audioTracks: [] });
            alert(
                c,
                'input-interlaced',
                'Input is interlaced (1080i50tff). YouTube does not support interlaced video and warns of artifacts.',
            );
        },
    },

    // ───────────────────────── SRT relay ─────────────────────────
    {
        id: 'relay-ok',
        section: 'SRT relay',
        title: 'Healthy bonded input (reference)',
        when: 'Relay running, the group has all expected legs (two or more), packets flow, SRS accepted the relay’s stream. Both halves OK, no issues.',
        shots: [{ kind: 'ov-relay' }, { kind: 'status-dot', dot: 'input' }],
        apply: (c) => relay(c),
    },
    {
        id: 'relay-leg-down',
        section: 'SRT relay',
        title: 'N of M bonded legs down',
        when: 'The group once had M legs and now reports fewer (a failed leg drops out of the relay’s list). Listed once: the alert “N of M bonded legs is down.”, with how long it has lasted (the same fact is no longer repeated as the half’s own reason). Input half = warning.',
        clears: 'When the missing leg returns. (The expected size grows when a bigger group is stable for a while.)',
        shots: [{ kind: 'ov-relay' }, { kind: 'status-dot', dot: 'input' }],
        apply: (c) => {
            relay(c, {}, [leg('198.51.100.11')], 2);
            alert(c, 'bonded-leg-down', '1 of 2 bonded legs is down.', 60_000);
        },
    },
    {
        id: 'relay-one-leg',
        section: 'SRT relay',
        title: 'Only 1 leg connected — no redundancy',
        when: 'A bonded group with a single leg and no leg missing (the group was only ever one leg). Input half = warning, because a bonded group is meant to have two or more.',
        shots: [{ kind: 'ov-relay' }, { kind: 'status-dot', dot: 'input' }],
        apply: (c) => relay(c, {}, [leg('198.51.100.11')], 1),
    },
    {
        id: 'relay-no-legs',
        section: 'SRT relay',
        title: 'No bonded legs reporting',
        when: 'A bonded group that had legs now has none. Total input failure: Input half = error (worse than reduced redundancy).',
        shots: [{ kind: 'ov-relay' }, { kind: 'status-dot', dot: 'input' }],
        apply: (c) => {
            relay(c, { lastInputPacketAt: now() - 60_000 }, [], 2);
        },
    },
    {
        id: 'relay-leg-noflow',
        section: 'SRT relay',
        title: 'Leg … is connected but has stopped delivering packets.',
        when: 'A leg whose state is running delivered no new packets for 10 s. Leg health = warn; the Relay table shows the leg’s reason with its IP (the bonded-leg-no-flow alert itself is hidden to avoid a duplicate).',
        shots: [{ kind: 'ov-relay' }, { kind: 'status-dot', dot: 'input' }],
        apply: (c) => {
            relay(c, {}, [
                leg('198.51.100.11'),
                leg('198.51.100.12', {
                    health: 'warn',
                    healthReason: 'Leg is connected but has stopped delivering packets.',
                }),
            ]);
            alert(
                c,
                'bonded-leg-no-flow',
                'Bonded leg 198.51.100.12:20012 is connected but has stopped delivering packets.',
                40_000,
            );
        },
    },
    {
        id: 'relay-leg-pending',
        section: 'SRT relay',
        title: 'Leg is pending / idle / state is unknown',
        when: 'A leg is pending or idle (no standby leg exists to explain idle) → warn: “Leg is pending.”; a leg whose state is unknown → error. The idle standby of a main/backup group is normal and not flagged.',
        shots: [{ kind: 'ov-relay' }, { kind: 'status-dot', dot: 'input' }],
        apply: (c) => {
            relay(c, {}, [
                leg('198.51.100.11'),
                leg('198.51.100.12', {
                    state: 'pending',
                    health: 'warn',
                    healthReason: 'Leg is pending.',
                }),
            ]);
        },
    },
    {
        id: 'relay-leg-quality-warn',
        section: 'SRT relay',
        title: 'Leg packet quality is degraded / retransmissions / latency is high (warning)',
        when: 'Over the last minute with at least 100 packets: loss or drop of 1 % or more (or 100+ packets), or retransmissions of 5 % or more → warn. Latency at or above 1500 ms → warn. For a plain (non-bonded) SRT input the word is “Connection” instead of “Leg”.',
        shots: [{ kind: 'ov-relay' }, { kind: 'status-dot', dot: 'input' }],
        apply: (c) => {
            relay(c, {}, [
                leg('198.51.100.11'),
                leg('198.51.100.12', {
                    health: 'warn',
                    healthReason:
                        'Leg packet quality is degraded over the last minute (2.3% loss, 1.1% drop).',
                    recent: {
                        spanMs: 600000,
                        packets: 90000,
                        loss: 2070,
                        retrans: 5100,
                        drop: 990,
                    },
                }),
            ]);
        },
    },
    {
        id: 'relay-leg-quality-error',
        section: 'SRT relay',
        title: 'Leg packet drops are N% over the last minute',
        when: 'Over the last minute with at least 100 packets: drops of 5 % or more, or 1000+ dropped packets → error (it is never downgraded by a later rule).',
        shots: [{ kind: 'ov-relay' }, { kind: 'status-dot', dot: 'input' }],
        apply: (c) => {
            relay(c, {}, [
                leg('198.51.100.11'),
                leg('198.51.100.12', {
                    health: 'error',
                    healthReason: 'Leg packet drops are 7.4% over the last minute (4512 packets).',
                    recent: {
                        spanMs: 600000,
                        packets: 90000,
                        loss: 6000,
                        retrans: 9000,
                        drop: 6660,
                    },
                }),
            ]);
        },
    },
    {
        id: 'relay-no-input-packets',
        section: 'SRT relay',
        title: 'No input packets received recently',
        when: 'The relay has received no packet from the encoder for more than 15 s while the input is still active. Input half = warning.',
        shots: [{ kind: 'ov-relay' }, { kind: 'status-dot', dot: 'input' }],
        apply: (c) => relay(c, { lastInputPacketAt: now() - 45_000 }),
    },
    {
        id: 'relay-conflict-srs',
        section: 'SRT relay',
        title: 'SRS is already using another publisher for this stream key',
        when: 'The relay tries to publish the bonded stream into SRS under the pipeline’s key, but SRS already has another publisher on that key (for example an encoder that also pushes RTMP to the same key). Output half = error. On the Status page this is listed on the input dot under its own “Relay to SRS” heading, not under “Input”.',
        clears: 'When the other publisher goes away.',
        shots: [{ kind: 'ov-relay' }, { kind: 'status-dot', dot: 'input' }],
        apply: (c) => relay(c, { publishConflict: true }),
    },
    {
        id: 'relay-conflict-local',
        section: 'SRT relay',
        title: 'A local pipeline output is already publishing to this stream key in SRS',
        when: 'Same conflict, but the other publisher is one of this server’s own pipeline outputs (a restream into this key). Output half = error.',
        shots: [{ kind: 'ov-relay' }, { kind: 'status-dot', dot: 'input' }],
        apply: (c) => relay(c, { publishConflict: true, localSrtPublisherConflict: true }),
    },
    {
        id: 'relay-reconnecting',
        section: 'SRT relay',
        title: 'Relay output reconnecting: <error> / (N retries)',
        when: 'The relay’s forward into SRS is not connected: it shows the relay’s last error, or the retry count when there is no error text. Output half = error (on the Status page, under the “Relay to SRS” heading of the input dot).',
        clears: 'When the relay reconnects to SRS.',
        shots: [{ kind: 'ov-relay' }, { kind: 'status-dot', dot: 'input' }],
        apply: (c) =>
            relay(c, {
                outputConnected: false,
                retryFailures: 3,
                lastError:
                    'srt_connect target=127.0.0.1:10080: Connection setup failure: connection timed out',
                lastPacketAt: now() - 90_000,
            }),
    },
    {
        id: 'relay-not-accepted',
        section: 'SRT relay',
        title: 'SRS has not reported this as the active pipeline input',
        when: 'The relay is connected to SRS, but SRS’s stream list does not (yet) show the relay as the pipeline’s publisher. Output half = warning (normally a few seconds after connecting).',
        shots: [{ kind: 'ov-relay' }, { kind: 'status-dot', dot: 'input' }],
        apply: (c) => relay(c, { acceptedBySrs: false }),
    },
    {
        id: 'relay-forward-stalled',
        section: 'SRT relay',
        title: 'Media forwarding to SRS has stalled / No media has been forwarded to SRS yet',
        when: 'The relay is connected but no packet was forwarded to SRS for more than 15 s: “stalled” if it had forwarded before, “No media has been forwarded yet” if never. Output half = warning. The interval alert relay-forwarding-stalled (“Relay is receiving SRT packets but forwarding no packets to SRS.”) usually accompanies it.',
        shots: [{ kind: 'ov-relay' }, { kind: 'status-dot', dot: 'input' }],
        apply: (c) => {
            relay(c, { lastPacketAt: now() - 40_000 });
            alert(
                c,
                'relay-forwarding-stalled',
                'Relay is receiving SRT packets but forwarding no packets to SRS.',
            );
        },
    },
    {
        id: 'relay-alert-dropped',
        section: 'SRT relay alerts',
        title: 'SRT input dropped N packets in the last health interval.',
        when: 'Any packets were dropped on the SRT input between two 5 s health polls (packets that arrived too late, or never, even after retransmission). Takes precedence over the loss alert. Warning; an error from 5 % of the interval’s packets or 1000 packets. It raises the relay’s Input half to the same severity, so it counts in Issues and colours the dots.',
        clears: 'It stays for 30 s after the last interval that raised it, so the status does not blink.',
        shots: [{ kind: 'ov-relay' }, { kind: 'status-dot', dot: 'input' }],
        apply: (c) => {
            relay(c);
            alert(
                c,
                'srt-packets-dropped',
                'SRT input dropped 37 packets in the last health interval.',
                5000,
            );
        },
    },
    {
        id: 'relay-alert-dropped-error',
        section: 'SRT relay alerts',
        title: 'SRT input dropped N packets (error: 5 % or 1000 packets)',
        when: 'The same alert when the drops are heavy: 5 % of the interval’s packets or 1000 packets or more. Error: the relay’s Input half is red, the pipeline dot is red and the Issues view counts it.',
        clears: '30 s after the last interval that raised it.',
        shots: [
            { kind: 'ov-relay' },
            { kind: 'status-dot', dot: 'input' },
            { kind: 'status-card' },
        ],
        apply: (c) => {
            relay(c);
            alert(
                c,
                'srt-packets-dropped',
                'SRT input dropped 1450 packets in the last health interval.',
                5000,
                'error',
            );
        },
    },
    {
        id: 'relay-alert-loss-error',
        section: 'SRT relay alerts',
        title: 'SRT input packet loss is N% (error: 10 % or more)',
        when: 'Loss of 10 % or more of the interval’s packets. Error.',
        clears: '30 s after the last interval that raised it.',
        shots: [{ kind: 'ov-relay' }],
        apply: (c) => {
            relay(c);
            alert(
                c,
                'srt-packet-loss',
                'SRT input packet loss is 14.2% in the last health interval.',
                5000,
                'error',
            );
        },
    },
    {
        id: 'relay-alert-bitrate-error',
        section: 'SRT relay alerts',
        title: 'Input bitrate dropped (error: to 20 % or less)',
        when: 'The input bitrate fell to a fifth of its previous value or less. Error.',
        clears: '30 s after the last interval that raised it.',
        shots: [{ kind: 'ov-relay' }],
        apply: (c) => {
            relay(c);
            alert(
                c,
                'input-bitrate-collapse',
                'Input bitrate dropped from 8.2 Mb/s to 0.4 Mb/s.',
                5000,
                'error',
            );
        },
    },
    {
        id: 'relay-alert-loss',
        section: 'SRT relay alerts',
        title: 'SRT input packet loss is N% in the last health interval.',
        when: 'Loss of 1 % or more of received packets in the interval (and no drops). Warning; an error from 10 %. Raises the relay’s Input half.',
        clears: '30 s after the last interval that raised it.',
        shots: [{ kind: 'ov-relay' }],
        apply: (c) => {
            relay(c);
            alert(
                c,
                'srt-packet-loss',
                'SRT input packet loss is 2.4% in the last health interval.',
                5000,
            );
        },
    },
    {
        id: 'relay-alert-retrans',
        section: 'SRT relay alerts',
        title: 'SRT retransmissions reached N% in the last health interval.',
        when: 'Retransmitted packets are 5 % or more of those received in the interval. Warning. Raises the relay’s Input half.',
        clears: '30 s after the last interval that raised it.',
        shots: [{ kind: 'ov-relay' }],
        apply: (c) => {
            relay(c);
            alert(
                c,
                'srt-retransmissions',
                'SRT retransmissions reached 8.1% in the last health interval.',
                5000,
            );
        },
    },
    {
        id: 'relay-alert-belated',
        section: 'SRT relay alerts',
        title: 'SRT received N belated packets in the last health interval.',
        when: 'More than 100 packets arrived after their latency window in the interval. Warning. Raises the relay’s Input half.',
        clears: '30 s after the last interval that raised it.',
        shots: [{ kind: 'ov-relay' }],
        apply: (c) => {
            relay(c);
            alert(
                c,
                'srt-belated-packets',
                'SRT received 240 belated packets in the last health interval.',
                5000,
            );
        },
    },
    {
        id: 'relay-alert-latency',
        section: 'SRT relay alerts',
        title: 'SRT latency is high (N ms).',
        when: 'The negotiated latency is 1500 ms or more, or it rose by more than 1.5× + 100 ms since the previous poll. Warning. Raises the relay’s Input half.',
        clears: '30 s after the last interval that raised it.',
        shots: [{ kind: 'ov-relay' }],
        apply: (c) => {
            relay(c);
            alert(c, 'srt-latency-spike', 'SRT latency is high (1820 ms).', 5000);
        },
    },
    {
        id: 'relay-alert-bitrate',
        section: 'SRT relay alerts',
        title: 'Input bitrate dropped from X to Y.',
        when: 'Between two polls the input bitrate fell to 60 % or less of the previous value, and the previous value was at least 500 kb/s. Warning; an error when it fell to 20 % or less. Raises the relay’s Input half.',
        clears: '30 s after the last interval that raised it.',
        shots: [{ kind: 'ov-relay' }],
        apply: (c) => {
            relay(c);
            alert(
                c,
                'input-bitrate-collapse',
                'Input bitrate dropped from 8.2 Mb/s to 2.1 Mb/s.',
                5000,
            );
        },
    },
    {
        id: 'relay-alert-reconnected',
        section: 'SRT relay alerts',
        title: 'SRT publisher reconnected; input timing may be recovering.',
        when: 'A new SRT publisher took over the key within the last 30 s. Warning; it clears itself after 30 s. Raises the relay’s Input half.',
        shots: [{ kind: 'ov-relay' }],
        apply: (c) => {
            relay(c);
            alert(
                c,
                'publisher-reconnected',
                'SRT publisher reconnected; input timing may be recovering.',
                60_000,
            );
        },
    },

    // ───────────────────────── Outputs ─────────────────────────
    {
        id: 'out-ok',
        section: 'Output status',
        title: 'Healthy output (reference) and a stopped output',
        when: 'Running, bitrate at least 200 kb/s, no warning, input live → green. A stopped output (desired state “stopped”) is grey with no issue.',
        shots: [{ kind: 'ov-outputs' }, { kind: 'status-card' }],
        apply: (c) => {
            cfgOut(c, '1-4', { desiredState: 'stopped' });
            out(c, '1-4', { status: 'stopped', pid: null, bitrateKbps: null, startedAtMs: null });
        },
    },
    {
        id: 'out-failed',
        section: 'Output status',
        title: 'Error: the output’s last error (N errors since last start.)',
        when: 'FFmpeg exited and the output is marked failed, or it is waiting for its retry with a current error. Red. The text is the last line of FFmpeg’s error, prefixed with how many errors there have been since the last start; known errors get a “Hint:” line.',
        clears: 'When a retry connects and runs.',
        shots: [{ kind: 'ov-outputs' }, { kind: 'status-dot', dot: 0 }],
        apply: (c) => {
            out(c, '1-1', {
                status: 'stopped',
                pid: null,
                bitrateKbps: null,
                failures: 3,
                nextRetryAtMs: now() + 8000,
                startedAtMs: now() - 60_000,
                lastError: stored('Connection to tcp://192.0.2.10:1935 failed: Connection refused'),
            });
        },
    },
    {
        id: 'out-waiting',
        section: 'Output status',
        title: 'Output is waiting to start or retry.',
        when: 'The output should be running but its process is not (between retries, or waiting for the input) and it has no current error.',
        clears: 'When the process starts.',
        shots: [{ kind: 'ov-outputs' }, { kind: 'status-dot', dot: 0 }],
        apply: (c) => {
            out(c, '1-1', {
                status: 'stopped',
                pid: null,
                bitrateKbps: null,
                failures: 0,
                nextRetryAtMs: null,
                startedAtMs: null,
            });
        },
    },
    {
        id: 'out-input-not-live',
        section: 'Output status',
        title: 'Output is running but input is not live.',
        when: 'The output process runs while the pipeline’s input is not live (the input just dropped; the output has not been stopped yet). Warning.',
        shots: [{ kind: 'ov-outputs' }, { kind: 'status-dot', dot: 0 }],
        apply: (c) => inp(c, { live: false }),
    },
    {
        id: 'out-no-bitrate',
        section: 'Output status',
        title: 'Output is running but no bitrate is reported yet.',
        when: 'Process running, but FFmpeg has not yet reported a bitrate (first seconds after start). Warning.',
        shots: [{ kind: 'ov-outputs' }, { kind: 'status-dot', dot: 0 }],
        apply: (c) => out(c, '1-1', { bitrateKbps: null }),
    },
    {
        id: 'out-low-bitrate',
        section: 'Output status',
        title: 'Output bitrate is below 200 kb/s.',
        when: 'Running with a reported bitrate under 200 kb/s. Hint: if the input’s bitrate is fine, FFmpeg may be dropping video (for example interlaced input).',
        shots: [{ kind: 'ov-outputs' }, { kind: 'status-dot', dot: 0 }],
        apply: (c) => out(c, '1-1', { bitrateKbps: 58 }),
    },
    {
        id: 'out-no-bitrate-error',
        section: 'Output status',
        title: 'Running with no bitrate after an error',
        when: 'Process running, no bitrate, and the most recent error is newer than the start (a crash that was just retried and has not recovered). Red, with the error text.',
        shots: [{ kind: 'ov-outputs' }, { kind: 'status-dot', dot: 0 }],
        apply: (c) =>
            out(c, '1-1', {
                bitrateKbps: null,
                failures: 1,
                lastError: stored('rtmp://192.0.2.10/live/test: Input/output error'),
            }),
    },
    {
        id: 'out-warn-timestamps',
        section: 'Output warnings',
        title: 'FFmpeg reported: … Timestamp discontinuity / non-monotonous DTS / invalid DTS',
        when: 'FFmpeg printed a timing warning for this output within the last 30 s. Warning text is “FFmpeg reported: ” plus the line. Repeats are counted, not repeated; it clears 30 s after the last warning. If it hits several outputs it is a symptom of the input’s timestamps.',
        clears: '30 s after the last such line.',
        shots: [{ kind: 'ov-outputs' }, { kind: 'status-dot', dot: 0 }],
        apply: (c) =>
            out(c, '1-1', {
                warningReason:
                    'FFmpeg reported: [flv @ 0x5598a1c0] Timestamp discontinuity detected on stream 0, ts 5321 -> 128 (corrected)',
                warningSinceMs: now() - 25_000,
            }),
    },
    {
        id: 'out-warn-decode',
        section: 'Output warnings',
        title: 'FFmpeg reported: … non-existing PPS / decode_slice_header error / corrupt input',
        when: 'Decode errors that persist for more than 10 s (shorter bursts are normal while an output joins mid-GOP and are never shown).',
        shots: [{ kind: 'ov-outputs' }],
        apply: (c) =>
            out(c, '1-1', {
                warningReason: 'FFmpeg reported: [h264 @ 0x55d1] non-existing PPS 0 referenced',
                warningSinceMs: now() - 40_000,
            }),
    },
    {
        id: 'out-warn-clock',
        section: 'Output warnings',
        title: 'FFmpeg media clock is running fast (N.NNx realtime).',
        when: 'For copy outputs, FFmpeg’s media position advanced faster than 1.1× wall clock for 10 s or more.',
        shots: [{ kind: 'ov-outputs' }],
        apply: (c) =>
            out(c, '1-1', {
                warningReason: 'FFmpeg media clock is running fast (1.38x realtime).',
                warningSinceMs: now() - 20_000,
            }),
    },
    {
        id: 'out-warn-stalled',
        section: 'Output warnings',
        title: 'FFmpeg media progress has stalled for Ns.',
        when: 'FFmpeg’s output position has not moved for 15 s or more. The stall watchdog restarts the output later if it persists.',
        shots: [{ kind: 'ov-outputs' }],
        apply: (c) =>
            out(c, '1-1', {
                warningReason: 'FFmpeg media progress has stalled for 21s.',
                warningSinceMs: now() - 21_000,
            }),
    },
    {
        id: 'out-warn-behind',
        section: 'Output warnings',
        title: 'Output is running at N.NNx realtime and falling behind live',
        when: 'FFmpeg’s speed is under 0.9× realtime in two consecutive 30 s windows (slow encode or destination, or the input is slow). Hint: check the destination, the network and CPU headroom.',
        shots: [{ kind: 'ov-outputs' }, { kind: 'status-dot', dot: 0 }],
        apply: (c) =>
            out(c, '1-1', {
                warningReason:
                    'Output is running at 0.82x realtime and falling behind live (slow encode or destination, or the input is delivering slowly).',
                warningSinceMs: now() - 50_000,
            }),
    },
    {
        id: 'out-warn-memory',
        section: 'Output warnings',
        title: 'High memory usage: X / Y',
        when: 'The output’s FFmpeg uses 70 % or more of its memory limit; at 100 % the watchdog restarts it. An early warning of a leak.',
        shots: [{ kind: 'ov-outputs' }],
        apply: (c) =>
            out(c, '1-1', {
                memoryUsageBytes: 160 * 1048576,
                warningReason: 'High memory usage: 160 MB / 200 MB (80% of limit)',
                warningSinceMs: now() - 120_000,
            }),
    },
    {
        id: 'out-warn-socket',
        section: 'Output warnings',
        title: 'Destination socket unhealthy: RTMP socket … / missing',
        when: 'The socket watchdog (RTMP/RTMPS only) finds the output’s TCP connection to the destination in a bad state (CLOSE_WAIT, FIN_WAIT …) or missing after data was written. If the state persists past the grace period the output is restarted. Added after YouTube half-dead connections.',
        shots: [{ kind: 'ov-outputs' }, { kind: 'status-dot', dot: 0 }],
        apply: (c) =>
            out(c, '1-1', {
                warningReason:
                    'Destination socket unhealthy: RTMP socket CLOSE_WAIT on destination port 1935',
                warningSinceMs: now() - 30_000,
            }),
    },
    {
        id: 'out-warn-noinput',
        section: 'Output warnings',
        title: 'No input data: ffmpeg has written nothing and never connected to the destination',
        when: 'A new output that has written nothing and has no connection to the destination yet: it is still waiting for input data (FFmpeg opens the destination only after reading enough input), so it is not blamed on the destination.',
        shots: [{ kind: 'ov-outputs' }],
        apply: (c) =>
            out(c, '1-1', {
                warningReason:
                    'No input data: ffmpeg has written nothing and never connected to the destination (RTMP socket missing, port 1935)',
                warningSinceMs: now() - 20_000,
            }),
    },
    {
        id: 'out-many',
        section: 'Status page',
        title: 'Pipelines with many outputs: summary badges',
        when: 'A card with more than 6 outputs wraps the dots under the name and shows “N outputs” plus “N failed” and “N warn” badges.',
        shots: [{ kind: 'status-card' }],
        apply: (c) => {
            cloneOutputs(c, 6);
            out(c, '1-2', {
                status: 'stopped',
                pid: null,
                bitrateKbps: null,
                failures: 2,
                startedAtMs: now() - 60_000,
                lastError: stored('Connection refused'),
            });
            out(c, '1-6', {
                warningReason: 'FFmpeg media progress has stalled for 21s.',
                warningSinceMs: now() - 21_000,
            });
            out(c, '1-7', { bitrateKbps: 58 });
            cfgOut(c, '1-8', { desiredState: 'stopped' });
            out(c, '1-8', { status: 'stopped', pid: null, bitrateKbps: null, startedAtMs: null });
        },
    },
    {
        id: 'status-rejected',
        section: 'Status page',
        title: 'Rejected publishers (red card)',
        when: 'SRS refused a publish or play in the last 5 minutes (wrong or unassigned key, a play request, an unrecognised stream name). One red card with the count; click opens the Overview list. On the Overview page the same list is in the sidebar under the pipelines.',
        clears: '5 minutes after the last refused attempt.',
        shots: [{ kind: 'status-top' }, { kind: 'sidebar-rejected' }],
        apply: (c) => {
            c.rejected = {
                omitted: 0,
                rejected: [
                    {
                        label: 'key07_a1b2…',
                        kind: 'publish',
                        reason: 'unknown',
                        protocol: 'rtmp',
                        ip: '203.0.113.20',
                        attempts: 14,
                        lastAttemptAgoMs: 8000,
                        streams: 1,
                        streamsCapped: false,
                    },
                    {
                        label: 'key05_…',
                        kind: 'publish',
                        reason: 'unassigned',
                        protocol: 'srt',
                        ip: '203.0.113.31',
                        attempts: 3,
                        lastAttemptAgoMs: 95_000,
                        streams: 1,
                        streamsCapped: false,
                    },
                    {
                        label: 'unrecognized',
                        kind: 'publish',
                        reason: 'unrecognized',
                        protocol: 'rtmp',
                        ip: '198.51.100.9',
                        attempts: 6,
                        lastAttemptAgoMs: 20_000,
                        streams: 2,
                        streamsCapped: false,
                    },
                    {
                        label: 'key01_…',
                        kind: 'play',
                        reason: 'assigned',
                        protocol: 'srt',
                        ip: '203.0.113.44',
                        attempts: 2,
                        lastAttemptAgoMs: 40_000,
                        streams: 1,
                        streamsCapped: false,
                    },
                ],
            };
        },
    },
    {
        id: 'status-problems',
        section: 'Status page',
        title: 'Recent problems list',
        when: 'The Status page lists the last 30 warnings and errors from the Events feed (oldest first): pipeline-log events (offline, probe failed, keyframe interval, leg degraded/failed, relay error), output History (crash, warning, stop after repeated failures) and Server events (SRS, Goryu, Host memory/CPU/disk). Refreshed every 15 s.',
        shots: [{ kind: 'status-problems' }],
        apply: (c) => {
            const t = now();
            const ev = (
                ago: number,
                source: string,
                severity: string,
                label: string,
                message: string,
                extra: any = {},
            ) => ({
                ts: t - ago,
                source,
                severity,
                pipelineId: null,
                pipelineName: null,
                outputName: null,
                label,
                message,
                ...extra,
            });
            c.events = [
                ev(
                    40_000,
                    'output',
                    'warning',
                    'warning',
                    'FFmpeg reported: Timestamp discontinuity detected (12 more in the last 30 s)',
                    { pipelineId: 1, pipelineName: 'Test_Live', outputName: 'A_YT' },
                ),
                ev(
                    120_000,
                    'output',
                    'error',
                    'crash',
                    'Connection to tcp://192.0.2.10:1935 failed: Connection refused (3 times)',
                    { pipelineId: 1, pipelineName: 'Test_Live', outputName: 'B_FB' },
                ),
                ev(
                    300_000,
                    'input',
                    'warning',
                    'keyframe_interval',
                    'Input keyframes are too far apart: the longest gap in 12 s of video is 9.8 s',
                    { pipelineId: 1, pipelineName: 'Test_Live' },
                ),
                ev(420_000, 'input', 'warning', 'offline', 'Input went offline after 1h 12m', {
                    pipelineId: 1,
                    pipelineName: 'Test_Live',
                }),
                ev(
                    900_000,
                    'server',
                    'error',
                    'Host',
                    'CPU high: 76% busy for 30s; top: ffmpeg=310% srs=45%',
                ),
                ev(
                    1_800_000,
                    'server',
                    'error',
                    'Host',
                    'Memory high: 74% used (3.9 GB of 15.0 GB available); top: node(2301)=410 MB ffmpeg(4412)=380 MB',
                ),
                ev(
                    2_400_000,
                    'server',
                    'error',
                    'Goryu',
                    'Relay process exited (code 1); restarting',
                ),
                ev(3_000_000, 'server', 'error', 'SRS', 'SRS API unreachable'),
            ].sort((a, b) => b.ts - a.ts);
        },
    },

    {
        id: 'side-mixed',
        section: 'Pipeline list (sidebar)',
        title: 'Sidebar dot: input and outputs together',
        when: 'The pipeline list’s two-half dot (left = input incl. relay, right = outputs) lists every issue of both halves on hover, with hints for alerts. The Status page’s dots now list every issue too, with the same hints.',
        shots: [{ kind: 'sidebar-dot' }, { kind: 'status-card' }],
        apply: (c) => {
            inp(c, { recvBitrateKbps: 90, uptimeMs: 120_000, audio: null, audioTracks: [] });
            alert(
                c,
                'input-keyframe-interval',
                'Input keyframes are too far apart: the longest gap in 12 s of video is 9.8 s.',
            );
            out(c, '1-1', {
                status: 'stopped',
                pid: null,
                bitrateKbps: null,
                failures: 3,
                nextRetryAtMs: now() + 8000,
                startedAtMs: now() - 60_000,
                lastError: stored('Connection to tcp://192.0.2.10:1935 failed: Connection refused'),
            });
            out(c, '1-2', {
                warningReason: 'FFmpeg media progress has stalled for 21s.',
                warningSinceMs: now() - 21_000,
            });
        },
    },

    // ───────────────────────── Tips / advice on output cards ─────────────────────────
    {
        id: 'adv-dup',
        section: 'Output advice',
        title: 'Same destination as <pipeline → output>',
        when: 'Another output (any pipeline) pushes to exactly the same URL. A yellow line on the output card, and a yellow outline round the output’s dot on the Status page and its status on the Overview, with the line in the dot’s hover text and the Overview’s Issues column. It changes no colour and no count, because it can be deliberate (a backup pipeline with the same destination).',
        shots: [
            { kind: 'out-card', out: 0 },
            { kind: 'status-dot', dot: 0 },
            { kind: 'ov-outputs' },
        ],
        pipelineView: true,
        apply: (c) =>
            cfgOut(c, '1-2', { url: c.config.outputs.find((o: any) => o.id === '1-1').url }),
    },
    {
        id: 'adv-loop',
        section: 'Output advice',
        title: 'Loops back into this pipeline’s own input, so it cannot work',
        when: 'The output’s destination is this server’s own ingest and the stream key belongs to the same pipeline (directly, or through other pipelines’ outputs: “… through "Name", so it cannot work”). The server does not refuse it; the card says it cannot work.',
        shots: [
            { kind: 'out-card', out: 0 },
            { kind: 'status-dot', dot: 0 },
            { kind: 'ov-outputs' },
        ],
        pipelineView: true,
        apply: (c) => cfgOut(c, '1-1', { url: c.config.pipelines[0].rtmpPublishUrl }),
    },
    {
        id: 'adv-rtmp-track',
        section: 'Output advice',
        title: 'RTMP input only has one audio track — use copy or Track 1',
        when: 'The input is RTMP and the output’s audio is set to a track selection other than copy or Track 1.',
        shots: [
            { kind: 'out-card', out: 0 },
            { kind: 'status-dot', dot: 0 },
            { kind: 'ov-outputs' },
        ],
        pipelineView: true,
        apply: (c) => cfgOut(c, '1-1', { audioEncoding: '1' }),
    },
    {
        id: 'adv-rtmp-track1',
        section: 'Output advice',
        title: 'Track 1 re-encodes the audio, which costs extra CPU — use copy',
        when: 'RTMP input, RTMP output, audio set to Track 1 (“0”) instead of copy.',
        shots: [
            { kind: 'out-card', out: 0 },
            { kind: 'status-dot', dot: 0 },
            { kind: 'ov-outputs' },
        ],
        pipelineView: true,
        apply: (c) => cfgOut(c, '1-1', { audioEncoding: '0' }),
    },
    {
        id: 'adv-srt-copy',
        section: 'Output advice',
        title: 'SRT-to-RTMP output should not use copy audio',
        when: 'The input is SRT and the output is RTMP with audio copy: copying the SRT audio can cause jitter in RTMP; select a track instead.',
        shots: [
            { kind: 'out-card', out: 0 },
            { kind: 'status-dot', dot: 0 },
            { kind: 'ov-outputs' },
        ],
        pipelineView: true,
        apply: (c) => {
            srtInput(c);
            inp(c, {
                audioTracks: [
                    {
                        index: 0,
                        codec: 'aac',
                        sampleRate: 48000,
                        channels: 2,
                        profile: 'LC',
                        language: null,
                        title: null,
                        pid: 256,
                    },
                ],
            });
        },
    },
    {
        id: 'adv-track-range',
        section: 'Output advice',
        title: 'Output selects track N, but the input only has M audio tracks',
        when: 'The input is SRT with known audio tracks and the output selects a track number beyond them.',
        shots: [
            { kind: 'out-card', out: 0 },
            { kind: 'status-dot', dot: 0 },
            { kind: 'ov-outputs' },
        ],
        pipelineView: true,
        apply: (c) => {
            srtInput(c);
            inp(c, {
                audioTracks: [
                    {
                        index: 0,
                        codec: 'aac',
                        sampleRate: 48000,
                        channels: 2,
                        profile: 'LC',
                        language: null,
                        title: null,
                        pid: 256,
                    },
                ],
            });
            cfgOut(c, '1-1', { audioEncoding: '2' });
        },
    },
    {
        id: 'adv-stopped',
        section: 'Output advice',
        title: 'Stopped after N attempts: check the link and stream key…',
        when: 'The server stopped the output after repeated failed attempts. The card keeps the last error (yellow, not red) plus this advice. It is deliberately not a Problem: a few outputs are always broken, and that must not turn a pipeline red. The Status page shows the output as a grey dot with a yellow outline, and the Overview as a grey dot with a yellow outline in the Status column, with the advice in its Issues column.',
        shots: [
            { kind: 'out-card', out: 0 },
            { kind: 'status-dot', dot: 0 },
            { kind: 'ov-outputs' },
        ],
        pipelineView: true,
        apply: (c) => {
            const msg = stored(
                'Stopped after 5 failed attempts. Last error: Connection to tcp://192.0.2.10:1935 failed: Connection refused',
                60_000,
            );
            cfgOut(c, '1-1', { desiredState: 'stopped', lastError: msg, hasErrorHistory: true });
            out(c, '1-1', {
                status: 'stopped',
                pid: null,
                bitrateKbps: null,
                startedAtMs: null,
                failures: 0,
                lastError: msg,
                hasErrorHistory: true,
            });
        },
    },

    {
        id: 'card-hints',
        section: 'Output advice',
        title: 'Error and warning “Hint:” lines on the output card',
        when: 'Known FFmpeg errors and warnings get a one-line “Hint:” on the output card (connection refused, timed out, DNS, login rejected, SRT passphrase, closed while sending, codec not supported in RTMP, low output bitrate, falling behind, destination stopped accepting data). The Overview and Status pages show the same error text without the hint.',
        shots: [
            { kind: 'out-hint', out: 0 },
            { kind: 'out-hint', out: 1 },
        ],
        pipelineView: true,
        apply: (c) => {
            out(c, '1-1', {
                status: 'stopped',
                pid: null,
                bitrateKbps: null,
                failures: 3,
                nextRetryAtMs: now() + 8000,
                startedAtMs: now() - 60_000,
                lastError: stored('Connection to tcp://192.0.2.10:1935 failed: Connection refused'),
            });
            out(c, '1-2', { bitrateKbps: 58 });
        },
    },

    // Real stack (APP_PORT=18080), no proxy involved.
    {
        id: 'real-flood',
        section: 'Real',
        title: 'real timestamp flood',
        when: '',
        shots: [
            { kind: 'ov-outputs' },
            { kind: 'status-dot', dot: 0 },
            { kind: 'out-card', out: 0 },
        ],
    },
    {
        id: 'real-shared',
        section: 'Real',
        title: 'real shared encode',
        when: '',
        shots: [{ kind: 'ov-shared' }, { kind: 'ov-outputs' }, { kind: 'status-card' }],
    },
    {
        id: 'real-shared-failed',
        section: 'Real',
        title: 'real shared encode failure',
        when: '',
        shots: [
            { kind: 'ov-shared' },
            { kind: 'ov-outputs' },
            { kind: 'status-dot', dot: 4 },
            { kind: 'status-dot', dot: 5 },
        ],
    },
];

// Every input, relay and output entry also shows the pipeline list (the sidebar's dot and its
// hover text) and the pipeline page: the input's stats for an input or relay message, the first
// output's card for an output message. An entry that lists its own shot of one keeps it.
const SIDEBAR_SECTIONS = new Set([
    'Input status',
    'Input alerts',
    'SRT relay',
    'SRT relay alerts',
    'Output status',
    'Output warnings',
    'Output advice',
]);
const INPUT_SECTIONS = new Set(['Input status', 'Input alerts', 'SRT relay', 'SRT relay alerts']);
const OUTPUT_SECTIONS = new Set(['Output status', 'Output warnings']);
for (const e of catalog) {
    if (e.id === 'card-hints' || !SIDEBAR_SECTIONS.has(e.section)) continue;
    const has = (kind: Shot['kind']) => e.shots.some((s) => s.kind === kind);
    if (!has('sidebar-dot')) e.shots.push({ kind: 'sidebar-dot' });
    if (INPUT_SECTIONS.has(e.section) && !has('pipeline-input'))
        e.shots.push({ kind: 'pipeline-input' });
    if (OUTPUT_SECTIONS.has(e.section) && !has('out-card'))
        e.shots.push({ kind: 'out-card', out: 0 });
}

export const scenarios: Record<string, { down?: boolean; apply?: (c: Ctx) => void }> = {
    baseline: {},
};
for (const e of catalog) scenarios[e.id] = { down: e.down, apply: e.apply };
