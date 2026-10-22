import {
    ALERT_VOLUME_DEFAULT,
    clampAlertVolume,
    newAttention,
    type AttentionSnapshot,
    type AttentionState,
} from '../core/alert-sound.js';

// The navbar's alert sound control and the beeps it plays. Works like a video
// player's volume control: the bell mutes and unmutes, the slider beside it sets
// the level, and sliding to 0 mutes; muting keeps the last volume. Ported from
// live-gallery's alert beeps so both tools sound the same.

const BEEP_FOR_MS = 5000;
const BEEP_EVERY_MS = 1000;
const BEEP_HZ = 880;
const BEEP_BASE_GAIN = 0.27;
// Per browser only; a missing or unreadable value means sound on at 100%.
const STORAGE_KEY = 'bunryu.alertSound';

const BELL =
    '<path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" /><path d="M18 8a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />';
const BELL_OFF =
    '<path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" /><path d="M17 17H3c0-2 3-2 3-9a6 6 0 0 1 .4-2.2" /><path d="M11 3.1A6 6 0 0 1 18 8c0 1.7.2 3 .5 4" /><path d="M2 2l20 20" />';

let enabled = true;
let volume = ALERT_VOLUME_DEFAULT;
let attention: AttentionState | null = null;
let beepUntilMs = 0;
let beepTimer: ReturnType<typeof setInterval> | null = null;
let audioContext: AudioContext | null = null;

function audible(): boolean {
    return enabled && volume > 0;
}

// Browsers play no sound until the page has been clicked or typed into.
function soundAllowed(): boolean {
    return navigator.userActivation?.hasBeenActive ?? true;
}

function load(): void {
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as {
            enabled?: unknown;
            volume?: unknown;
        } | null;
        if (saved) {
            enabled = saved.enabled !== false;
            volume = clampAlertVolume(Number(saved.volume ?? ALERT_VOLUME_DEFAULT));
        }
    } catch {
        // Storage blocked or a corrupt value: keep the defaults.
    }
}

function save(): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled, volume }));
    } catch {
        // Storage blocked: the setting lasts until the page is reloaded.
    }
}

function syncControl(): void {
    const button = document.getElementById('alert-sound-btn');
    const slider = document.getElementById('alert-volume') as HTMLInputElement | null;
    if (!button || !slider) return;
    const on = audible();
    const blocked = on && !soundAllowed();
    button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${on ? BELL : BELL_OFF}</svg>`;
    button.classList.toggle('text-warning', blocked);
    button.classList.toggle('opacity-70', !blocked);
    const label = blocked
        ? 'Alert beeps are on but the browser blocks sound until you click anywhere on the page'
        : on
          ? `Alert beeps at ${volume}% (click to mute)`
          : 'Alert beeps muted (click to unmute)';
    button.title = label;
    button.setAttribute('aria-label', label);
    slider.value = String(enabled ? volume : 0);
    slider.title = `Alert volume ${enabled ? volume : 0}%`;
}

function beep(): void {
    try {
        audioContext ??= new AudioContext();
        if (audioContext.state === 'suspended') void audioContext.resume();
        const ctx = audioContext;
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        const peak = Math.max(0.0001, BEEP_BASE_GAIN * (volume / 100));
        oscillator.type = 'sine';
        oscillator.frequency.value = BEEP_HZ;
        gain.gain.setValueAtTime(0.0001, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(peak, ctx.currentTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.24);
        oscillator.connect(gain);
        gain.connect(ctx.destination);
        oscillator.start();
        oscillator.stop(ctx.currentTime + 0.25);
    } catch (err) {
        console.warn('[alerts] could not play the alert beep:', err);
    }
}

function stopBeeping(): void {
    if (beepTimer) clearInterval(beepTimer);
    beepTimer = null;
}

// One beep a second for BEEP_FOR_MS; a new problem meanwhile extends it.
function startBeeping(): void {
    if (!audible()) return;
    beepUntilMs = Date.now() + BEEP_FOR_MS;
    if (beepTimer) return;
    beep();
    beepTimer = setInterval(() => {
        if (!audible() || Date.now() >= beepUntilMs) {
            stopBeeping();
            return;
        }
        beep();
    }, BEEP_EVERY_MS);
}

// Called after every dashboard poll. The first call only records the baseline,
// so opening or reloading the dashboard does not beep for problems already shown.
export function noteDashboardSnapshot(snapshot: AttentionSnapshot): void {
    const result = newAttention(attention, snapshot);
    attention = result.state;
    if (result.fresh.length === 0) return;
    console.warn(`[alerts] ${result.fresh.join(', ')}`);
    startBeeping();
}

export function initSoundAlerts(): void {
    load();
    syncControl();
    document.getElementById('alert-sound-btn')?.addEventListener('click', () => {
        const wasAudible = audible();
        enabled = !wasAudible;
        if (enabled && volume === 0) volume = ALERT_VOLUME_DEFAULT;
        if (!enabled) stopBeeping();
        save();
        syncControl();
        // A short beep on unmute confirms the level and that sound is allowed.
        if (enabled) beep();
    });
    const slider = document.getElementById('alert-volume') as HTMLInputElement | null;
    slider?.addEventListener('input', () => {
        volume = clampAlertVolume(Number(slider.value));
        enabled = volume > 0;
        if (!enabled) stopBeeping();
        syncControl();
    });
    slider?.addEventListener('change', () => {
        save();
        if (audible()) beep();
    });
    // The first click or key press anywhere lets the browser play sound; the
    // timeout reads the activation after the browser has recorded it.
    const unlock = (): void => {
        setTimeout(() => {
            syncControl();
            if (!soundAllowed()) return;
            if (audioContext?.state === 'suspended') void audioContext.resume();
            document.removeEventListener('pointerdown', unlock, true);
            document.removeEventListener('keydown', unlock, true);
        }, 0);
    };
    document.addEventListener('pointerdown', unlock, true);
    document.addEventListener('keydown', unlock, true);
}
