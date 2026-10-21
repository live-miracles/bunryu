// Level maths for the preview's audio meter, ported from live-gallery's peak meter:
// sample peaks in dBFS (RMS read dense audio too hot), instant attack and a fixed
// release, like a broadcast peak meter.

// Each analyser read covers 8192 samples (~170 ms at 48 kHz), longer than the
// 100 ms between reads, so no peak falls between two reads.
export const LEVEL_FFT_SIZE = 8192;
export const LEVEL_INTERVAL_MS = 100;
// Redraws are capped at ~30 fps.
export const METER_FRAME_MS = 33;
export const METER_RELEASE_DB_PER_SECOND = 20;
// Bottom of the meter scale; the idle level.
export const METER_FLOOR_DB = -91;
// A peak at full scale lights the clip tile.
export const CLIP_DB = 0;

// Highest absolute sample in dBFS; digital silence reads about -200.
export function peakDb(samples: Float32Array): number {
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
        const sample = Math.abs(samples[i] ?? 0);
        if (sample > peak) peak = sample;
    }
    return 20 * Math.log10(peak + 1e-10);
}

// The level to show after `elapsedMs`: it falls from `shown` at the release rate
// but never below the latest reading. A stalled frame (a background tab) falls at
// most 250 ms worth.
export function releaseLevel(shown: number, latest: number, elapsedMs: number): number {
    const fall = (Math.min(elapsedMs, 250) / 1000) * METER_RELEASE_DB_PER_SECOND;
    return Math.max(latest, shown - fall);
}
