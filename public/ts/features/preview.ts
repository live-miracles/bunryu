import {
    CLIP_DB,
    LEVEL_FFT_SIZE,
    LEVEL_INTERVAL_MS,
    METER_FLOOR_DB,
    METER_FRAME_MS,
    peakDb,
    releaseLevel,
} from '../core/audio-meter.js';
import { escapeHtml } from '../core/utils.js';
import type { PipelineView } from '../types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const Hls: any;

// ── State ─────────────────────────────────────────────

interface HlsLike {
    destroy(): void;
    startLoad(): void;
    recoverMediaError(): void;
    audioTrack: number;
    audioTracks: unknown[];
}

let previewPipelineId: string | null = null;
// The server is starting a preview: the button stays on "Starting…" through polls and a
// second click does nothing until it answers.
let previewStarting = false;
let previewHlsUrl: string | null = null;
let hlsInstance: HlsLike | null = null;

// ── Audio meter (peak meter ported from live-gallery) ─────────────────────────

const METER_BAR_PX = 5;
const CLIP_HOLD_MS = 2000;

const METER_RANGES = [
    { min: -91, max: -90, fraction: 0.07, color: '#008000' },
    { min: -90, max: -36, fraction: 0.28, color: '#008000' },
    { min: -36, max: -18, fraction: 0.25, color: '#00c000' },
    { min: -18, max: -6, fraction: 0.25, color: '#00ff00' },
    { min: -6, max: -1, fraction: 0.12, color: '#ffff00' },
    { min: -1, max: 0, fraction: 0.03, color: '#ff0000' },
] as const;

interface MeterState {
    splitter: ChannelSplitterNode;
    analysers: AnalyserNode[];
    /** Master volume gate — set to 0 (muted) or 1 (unmuted). */
    masterGain: GainNode;
    ro: ResizeObserver;
    /** Reused read buffers, one per channel. */
    buffers: Float32Array[];
    /** Peak of the latest read per channel, in dBFS. */
    latest: number[];
    /** What is drawn: jumps up with `latest`, falls at the release rate. */
    shown: number[];
    clipHoldUntil: number[];
    lastReadAt: number;
    lastFrameAt: number;
    dirty: boolean;
    rafId: number;
}

let meterState: MeterState | null = null;

// A MediaElementAudioSourceNode can only be created once per <video> element, and
// the element's audio is then permanently routed through Web Audio. So we create the
// context + source once for the (static) preview video and reuse them across every
// preview start/stop/reload — recreating would throw and silence the element.
interface AudioGraph {
    ctx: AudioContext;
    source: MediaElementAudioSourceNode;
    el: HTMLVideoElement;
}

let audioGraph: AudioGraph | null = null;

// Mute is a property of the player, not of any single preview, so it survives
// reattach. Muted by default (the video element autoplays muted).
let previewMuted = true;

function getAudioGraph(video: HTMLVideoElement): AudioGraph | null {
    if (audioGraph && audioGraph.el === video) return audioGraph;
    const Ctx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return null;
    try {
        const ctx = new Ctx();
        const source = ctx.createMediaElementSource(video);
        // Once tapped by Web Audio, the element's own muted/volume gates the signal
        // entering the graph — so unmute the element and gate playback via masterGain.
        video.muted = false;
        audioGraph = { ctx, source, el: video };
        return audioGraph;
    } catch {
        return null;
    }
}

function drawMeterChannel(
    ctx: CanvasRenderingContext2D,
    x: number,
    db: number,
    height: number,
): void {
    let filled = 0;
    for (const range of METER_RANGES) {
        if (db < range.min) continue;
        const rangeH = range.fraction * height;
        const fraction = (Math.min(db, range.max) - range.min) / (range.max - range.min);
        const fillH = fraction * rangeH;
        ctx.fillStyle = range.color;
        ctx.fillRect(x, height - filled - fillH, METER_BAR_PX, fillH);
        filled += rangeH;
    }
}

function meterLoop(now: number): void {
    const state = meterState;
    if (!state) return;
    state.rafId = requestAnimationFrame(meterLoop);
    const elapsed = now - state.lastFrameAt;
    if (elapsed < METER_FRAME_MS) return;
    state.lastFrameAt = now;

    const { analysers, buffers, latest, shown, clipHoldUntil } = state;
    if (now - state.lastReadAt >= LEVEL_INTERVAL_MS) {
        state.lastReadAt = now;
        for (let i = 0; i < analysers.length; i++) {
            analysers[i].getFloatTimeDomainData(buffers[i] as Float32Array<ArrayBuffer>);
            latest[i] = peakDb(buffers[i]);
            shown[i] = Math.max(shown[i], latest[i]);
            if (latest[i] >= CLIP_DB) clipHoldUntil[i] = now + CLIP_HOLD_MS;
        }
        state.dirty = true;
    }
    for (let i = 0; i < analysers.length; i++) {
        const next = releaseLevel(shown[i], latest[i], elapsed);
        if (next !== shown[i]) {
            shown[i] = next;
            state.dirty = true;
        }
    }
    // A clip tile that has just expired needs one more redraw to disappear.
    if (clipHoldUntil.some((until) => until > now - METER_FRAME_MS)) state.dirty = true;
    if (!state.dirty) return;
    state.dirty = false;

    const canvas = document.getElementById('preview-meter') as HTMLCanvasElement | null;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);
    const holdH = Math.max(2, Math.round(height * 0.03));
    for (let i = 0; i < analysers.length; i++) {
        const x = i * METER_BAR_PX;
        drawMeterChannel(ctx, x, shown[i], height);
        if (clipHoldUntil[i] > now) {
            ctx.fillStyle = '#ff0000';
            ctx.fillRect(x, 0, METER_BAR_PX, holdH);
        }
    }
}

function setupMeter(video: HTMLVideoElement, numAudioChannels: number): void {
    teardownMeter();

    const canvas = document.getElementById('preview-meter') as HTMLCanvasElement | null;
    if (!canvas) return;

    const graph = getAudioGraph(video);
    if (!graph) return;
    const { ctx, source } = graph;

    // Resize canvas to fit all channel bars.
    canvas.width = numAudioChannels * METER_BAR_PX;
    canvas.classList.remove('hidden');

    const splitter = ctx.createChannelSplitter(numAudioChannels);

    // Wire per-channel analysers for the VU meter.
    const analysers: AnalyserNode[] = [];
    for (let i = 0; i < numAudioChannels; i++) {
        const analyser = ctx.createAnalyser();
        analyser.fftSize = LEVEL_FFT_SIZE;
        splitter.connect(analyser, i);
        analysers.push(analyser);
    }

    // Master gain gates audio to the speakers; the analysers tap the full signal so
    // the meter keeps moving even while muted. Track selection is handled by hls.js.
    const masterGain = ctx.createGain();
    masterGain.gain.value = previewMuted ? 0 : 1;
    masterGain.connect(ctx.destination);

    // Source feeds both the analysers (via splitter) and the speakers (via master).
    source.connect(splitter);
    source.connect(masterGain);
    ctx.resume().catch(() => {});

    // Keep canvas height in sync with the video element.
    const ro = new ResizeObserver(() => {
        canvas.height = video.clientHeight || 180;
    });
    ro.observe(video);

    meterState = {
        splitter,
        analysers,
        masterGain,
        ro,
        buffers: analysers.map(() => new Float32Array(LEVEL_FFT_SIZE)),
        latest: new Array(numAudioChannels).fill(METER_FLOOR_DB),
        shown: new Array(numAudioChannels).fill(METER_FLOOR_DB),
        clipHoldUntil: new Array(numAudioChannels).fill(0),
        lastReadAt: 0,
        lastFrameAt: 0,
        dirty: true,
        rafId: requestAnimationFrame(meterLoop),
    };
}

function teardownMeter(): void {
    if (!meterState) return;
    cancelAnimationFrame(meterState.rafId);
    meterState.ro.disconnect();
    // Disconnect this preview's nodes but keep the context + source alive for reuse.
    if (audioGraph) audioGraph.source.disconnect();
    meterState.splitter.disconnect();
    meterState.masterGain.disconnect();
    meterState = null;

    const canvas = document.getElementById('preview-meter') as HTMLCanvasElement | null;
    if (canvas) {
        canvas.classList.add('hidden');
        const ctx = canvas.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
}

// ── HLS lifecycle ─────────────────────────────────────

// The server reaps a preview nobody is watching (no keepalive and no HLS fetch
// within ~20s), so a crashed tab cannot leave a preview ffmpeg running. Beat well
// inside that TTL; the player's own playlist refreshes count too.
const KEEPALIVE_INTERVAL_MS = 8_000;
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

function startKeepalive(pipelineId: string): void {
    stopKeepalive();
    keepaliveTimer = setInterval(() => {
        void import('../core/api.js').then(async ({ previewKeepalive }) => {
            const result = await previewKeepalive(pipelineId);
            // active=false means the server no longer has this preview
            // (reaped, crashed, or restarted) — tear the player down instead of
            // letting it stall on a dead playlist.
            if (result && !result.active && previewPipelineId === pipelineId) {
                failPreview('the server ended it');
            }
        });
    }, KEEPALIVE_INTERVAL_MS);
}

function stopKeepalive(): void {
    if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
    }
}

// ── Failure handling ──────────────────────────────────

// A source that stops raises no hls.js error: the playlist just stops growing and
// the video freezes while the server's keepalive still says the preview is active.
// So watch the buffered range. 30s clears a long-GOP source, whose copied video
// gives segments as long as its keyframe interval.
const STALL_MS = 30_000;
const STALL_CHECK_MS = 1_000;
// Fatal hls.js errors we try to recover from before giving up. Reset on every
// segment that loads, so only an unbroken run of failures stops the preview.
const MAX_RECOVERIES = 3;
let stallTimer: ReturnType<typeof setInterval> | null = null;
let recoveries = 0;

/** Stop the preview and tell the operator why, instead of closing it silently. */
function failPreview(reason: string): void {
    if (!previewPipelineId) return;
    stopCurrentPreview();
    void import('../core/api.js').then(({ showError }) => showError(`Preview stopped: ${reason}`));
}

function startStallWatch(video: HTMLVideoElement): void {
    stopStallWatch();
    let edge = 0;
    let grewAt = Date.now();
    stallTimer = setInterval(() => {
        const ranges = video.buffered;
        const end = ranges.length > 0 ? ranges.end(ranges.length - 1) : 0;
        // A paused video (not started yet, or a hidden tab) may stop loading once
        // its buffer is full, which is not a stall.
        if (end !== edge || video.paused) {
            edge = end;
            grewAt = Date.now();
        } else if (Date.now() - grewAt > STALL_MS) {
            failPreview('no new video arrived for 30 s; the source may have stopped');
        }
    }, STALL_CHECK_MS);
}

function stopStallWatch(): void {
    if (stallTimer) {
        clearInterval(stallTimer);
        stallTimer = null;
    }
}

function playOrFail(video: HTMLVideoElement, numAudioChannels: number): void {
    video
        .play()
        .then(() => setupMeter(video, numAudioChannels))
        .catch((err: unknown) => {
            // A reload or stop interrupts a pending play(); that is not a failure.
            if ((err as { name?: string } | null)?.name === 'AbortError') return;
            failPreview('the browser could not start playback');
        });
}

function teardownHls(): void {
    stopKeepalive();
    stopStallWatch();
    if (hlsInstance) {
        hlsInstance.destroy();
        hlsInstance = null;
    }
    teardownMeter();
    setPreviewMaximized(false);
    previewHlsUrl = null;

    const video = document.getElementById('preview-video') as HTMLVideoElement | null;
    if (video) {
        video.pause();
        video.removeAttribute('src');
        video.load();
    }
    document.getElementById('preview-stage-host')?.classList.add('hidden');
    document.getElementById('preview-player')?.classList.add('hidden');
    syncPreviewControls(false);
}

export function syncPreviewControls(playing: boolean): void {
    document.getElementById('preview-btn-play-icon')?.classList.toggle('hidden', playing);
    document.getElementById('preview-btn-stop-icon')?.classList.toggle('hidden', !playing);
    document.getElementById('preview-btn-spinner')?.classList.add('hidden');
    const btn = document.getElementById('preview-stop-btn') as HTMLButtonElement | null;
    if (btn) btn.disabled = false;
    const label = document.getElementById('preview-btn-label');
    if (label) label.textContent = playing ? 'Stop' : 'Preview';

    for (const id of ['preview-mute-btn', 'preview-reload-btn', 'preview-maximize-btn']) {
        const b = document.getElementById(id) as HTMLButtonElement | null;
        if (b) b.disabled = !playing;
    }
}

export function isPreviewStarting(): boolean {
    return previewStarting;
}

export function endPreviewStarting(): void {
    previewStarting = false;
}

export function setPreviewStarting(): void {
    previewStarting = true;
    document.getElementById('preview-btn-play-icon')?.classList.add('hidden');
    document.getElementById('preview-btn-stop-icon')?.classList.add('hidden');
    document.getElementById('preview-btn-spinner')?.classList.remove('hidden');
    const btn = document.getElementById('preview-stop-btn') as HTMLButtonElement | null;
    if (btn) btn.disabled = true;
    const label = document.getElementById('preview-btn-label');
    if (label) label.textContent = 'Starting…';
}

// A closed/reloaded/navigated tab stops its preview right away instead of
// waiting for the server's idle reaper. sendBeacon survives page teardown; if it
// is lost (crash, network), the reaper is the fallback.
if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => {
        if (previewPipelineId) {
            navigator.sendBeacon(`/api/pipelines/${previewPipelineId}/preview/stop`);
        }
    });
}

export function stopCurrentPreview(): void {
    const pid = previewPipelineId;
    if (!pid) return;
    previewPipelineId = null;
    teardownHls();
    void import('../core/api.js').then(({ stopPreview }) => stopPreview(pid));
}

export function attachHls(pipelineId: string, hlsUrl: string): void {
    // Never leave an earlier player polling the same video.
    hlsInstance?.destroy();
    hlsInstance = null;
    previewPipelineId = pipelineId;
    previewHlsUrl = hlsUrl;
    startKeepalive(pipelineId);

    const video = document.getElementById('preview-video') as HTMLVideoElement | null;
    if (!video) return;
    document.getElementById('preview-stage-host')?.classList.remove('hidden');
    document.getElementById('preview-player')?.classList.remove('hidden');
    syncPreviewControls(true);
    syncMuteIcon(previewMuted);
    startPlayback(video, hlsUrl);
}

/** (Re)build the hls.js pipeline on the preview video and start the meter. Safe to
 *  call repeatedly — the persistent audio source is reused, so a reload re-syncs to
 *  the live edge without losing sound or the meter. */
function startPlayback(video: HTMLVideoElement, hlsUrl: string): void {
    // The media element decodes one audio track at a time; whichever track is active
    // is always stereo, so the meter watches two channels.
    const numAudioChannels = 2;

    recoveries = 0;
    startStallWatch(video);
    if (typeof Hls !== 'undefined' && Hls.isSupported()) {
        const hls = new Hls({
            // Always start at the live edge — no DVR.
            startPosition: -1,
            // Allow a slightly deeper live buffer on deployed servers so short
            // manifest/segment fetch hiccups do not force a stop near the edge.
            liveSyncDurationCount: 5,
            liveMaxLatencyDurationCount: 12,
            maxBufferLength: 20,
            fragLoadingMaxRetry: 10,
            fragLoadingRetryDelay: 500,
            manifestLoadingMaxRetry: 6,
            manifestLoadingRetryDelay: 500,
        }) as HlsLike & {
            loadSource(u: string): void;
            attachMedia(v: HTMLVideoElement): void;
            on(e: string, cb: (...args: unknown[]) => void): void;
            Events: { MANIFEST_PARSED: string; FRAG_LOADED: string; ERROR: string };
        };
        hls.loadSource(hlsUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED as string, () => playOrFail(video, numAudioChannels));
        hls.on(Hls.Events.FRAG_LOADED as string, () => {
            recoveries = 0;
        });
        hls.on(Hls.Events.ERROR as string, (...args: unknown[]) => {
            const data = args[1] as { fatal?: boolean; type?: string; details?: string };
            if (!data?.fatal) return;
            // hls.js gives up after its own retries; these are its documented ways
            // back in, so a short outage or one bad segment does not end the preview.
            if (recoveries < MAX_RECOVERIES) {
                if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                    recoveries++;
                    hls.startLoad();
                    return;
                }
                if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                    recoveries++;
                    hls.recoverMediaError();
                    return;
                }
            }
            setTimeout(() => failPreview(data.details ?? 'player error'), 0);
        });
        hlsInstance = hls;
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = hlsUrl;
        playOrFail(video, numAudioChannels);
    } else {
        failPreview('this browser cannot play HLS');
    }
}

export function reloadPreview(): void {
    const video = document.getElementById('preview-video') as HTMLVideoElement | null;
    if (!previewPipelineId || !previewHlsUrl || !video) return;
    if (hlsInstance) {
        hlsInstance.destroy();
        hlsInstance = null;
    }
    teardownMeter(); // disconnects this preview's nodes but keeps the persistent source
    startPlayback(video, previewHlsUrl);
}

// ── Audio track selection (native hls.js rendition switch, no backend restart) ─

function setPreviewAudioTrack(trackIndex: number): void {
    if (!hlsInstance) return;
    // hls.js switches the active audio rendition in place; the meter follows the
    // newly decoded track automatically through the same media element.
    if (trackIndex >= 0 && trackIndex < hlsInstance.audioTracks.length) {
        hlsInstance.audioTrack = trackIndex;
    }
}

export function previewTrackChange(): void {
    if (!previewPipelineId) return;
    const sel = document.getElementById('preview-audio-select') as HTMLSelectElement | null;
    if (!sel) return;
    const trackIndex = sel.value === '' ? 0 : Math.max(0, parseInt(sel.value));
    setPreviewAudioTrack(trackIndex);
}

// ── Player controls ───────────────────────────────────

function syncMuteIcon(muted: boolean): void {
    document.getElementById('preview-icon-muted')?.classList.toggle('hidden', !muted);
    document.getElementById('preview-icon-unmuted')?.classList.toggle('hidden', muted);
    const btn = document.getElementById('preview-mute-btn');
    if (btn) {
        btn.title = muted ? 'Unmute' : 'Mute';
        btn.setAttribute('aria-label', btn.title);
    }
}

export function togglePreviewMute(): void {
    previewMuted = !previewMuted;
    if (meterState) {
        meterState.masterGain.gain.value = previewMuted ? 0 : 1;
    } else {
        // No Web Audio graph (unsupported) — fall back to the element's own mute.
        const video = document.getElementById('preview-video') as HTMLVideoElement | null;
        if (video) video.muted = previewMuted;
    }
    syncMuteIcon(previewMuted);
}

function setPreviewMaximized(on: boolean): void {
    const card = document.getElementById('preview-card');
    const stageHost = document.getElementById('preview-stage-host');
    const stage = document.getElementById('preview-stage');
    const player = document.getElementById('preview-player');
    if (!card) return;

    if (on) {
        card.classList.add('fixed', 'inset-0', 'z-50', 'flex', 'flex-col', 'rounded-none');
        // Swap the translucent docked background for an opaque one: when the card
        // covers the viewport the page header would otherwise show through and make
        // the player controls hard to read against it.
        card.classList.add('bg-base-100');
        card.classList.remove('rounded-lg', 'bg-base-100/50');
        stageHost?.classList.add('flex-1', 'min-h-0');
        stage?.classList.add('h-full');
        player?.classList.remove('aspect-video');
        player?.classList.add('flex-1', 'h-full');
    } else {
        card.classList.remove('fixed', 'inset-0', 'z-50', 'flex', 'flex-col', 'rounded-none');
        card.classList.add('rounded-lg', 'bg-base-100/50');
        card.classList.remove('bg-base-100');
        stageHost?.classList.remove('flex-1', 'min-h-0');
        stage?.classList.remove('h-full');
        player?.classList.remove('flex-1', 'h-full');
        player?.classList.add('aspect-video');
    }

    document.getElementById('preview-icon-expand')?.classList.toggle('hidden', on);
    document.getElementById('preview-icon-compress')?.classList.toggle('hidden', !on);
    const btn = document.getElementById('preview-maximize-btn');
    if (btn) {
        btn.title = on ? 'Restore' : 'Maximize';
        btn.setAttribute('aria-label', btn.title);
    }
}

export function togglePreviewMaximize(): void {
    setPreviewMaximized(!document.getElementById('preview-card')?.classList.contains('fixed'));
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('preview-card')?.classList.contains('fixed'))
        setPreviewMaximized(false);
});

export function getPreviewPipelineId(): string | null {
    return previewPipelineId;
}

export function populatePreviewTrackSelect(pipeline: PipelineView): void {
    const sel = document.getElementById('preview-audio-select') as HTMLSelectElement | null;
    if (!sel) return;
    const tracks = pipeline.input.audioTracks;
    if (tracks.length <= 1) {
        sel.classList.add('hidden');
        sel.innerHTML = '';
        return;
    }
    const prev = sel.value;
    const opts: string[] = [];
    for (const t of tracks) {
        const label = escapeHtml([t.language, t.title].filter(Boolean).join(' '));
        opts.push(
            `<option value="${t.index}">Track ${t.index + 1}${label ? ` (${label})` : ''}</option>`,
        );
    }
    sel.innerHTML = opts.join('');
    if (prev && tracks.some((t) => String(t.index) === prev)) sel.value = prev;
    sel.classList.remove('hidden');
}
