import type { MetricSample } from '../types.js';

export const CHART_WINDOW_MS = 15 * 60 * 1000;
export const CHART_SCROLL_STEP_MS = 10 * 60 * 1000;

function roundUpNice(v: number): number {
    if (v <= 0) return 1;
    const exp = Math.pow(10, Math.floor(Math.log10(v)));
    const f = v / exp;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * exp;
}

function formatChartTimeTick(ts: number): string {
    const d = new Date(ts);
    const minutes = d.getMinutes();
    const mm = minutes.toString().padStart(2, '0');
    if (minutes % 10 !== 0) return mm;
    return `${d.getHours().toString().padStart(2, '0')}:${mm}`;
}

export function drawChart(
    id: string,
    samples: MetricSample[],
    extract: (s: MetricSample) => number,
    maxHint: number,
    color: string,
    fmtY: (v: number, peak: number) => string,
): void {
    const canvas = document.getElementById(id) as HTMLCanvasElement | null;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const displayW = canvas.clientWidth || 500;
    const displayH = canvas.clientHeight || 160;
    canvas.width = displayW * dpr;
    canvas.height = displayH * dpr;
    ctx.scale(dpr, dpr);

    const W = displayW;
    const H = displayH;
    const mL = 50;
    const mR = 8;
    const mT = 6;
    const mB = 22;
    const cW = W - mL - mR;
    const cH = H - mT - mB;

    ctx.clearRect(0, 0, W, H);

    // Theme-aware colours derived from the canvas's computed text colour
    const base = getComputedStyle(canvas).color;
    const toRgba = (c: string, a: number) =>
        c.startsWith('rgb(')
            ? c.replace('rgb(', 'rgba(').replace(')', `, ${a})`)
            : `rgba(128,128,128,${a})`;
    const gridColor = toRgba(base, 0.35);
    const labelColor = toRgba(base, 0.9);

    ctx.font = '10px ui-monospace, monospace';

    const values = samples.length >= 2 ? samples.map(extract) : [];
    const rawMax = values.length ? Math.max(maxHint, ...values, 0.001) : maxHint || 1;
    const peak = roundUpNice(rawMax);

    const cx = (i: number) => mL + (i / Math.max(samples.length - 1, 1)) * cW;
    const cy = (v: number) => mT + cH - (v / peak) * cH;

    // Y axis — 4 equal ticks
    for (let i = 0; i <= 4; i++) {
        const v = (peak / 4) * i;
        const y = cy(v);
        ctx.beginPath();
        ctx.setLineDash([3, 4]);
        ctx.moveTo(mL, y);
        ctx.lineTo(W - mR, y);
        ctx.strokeStyle = gridColor;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = labelColor;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(fmtY(v, peak), mL - 5, y);
    }

    if (values.length < 2) return;

    // X axis — grid at round-minute boundaries, labels every 5 minutes
    const firstTs = samples[0].ts;
    const lastTs = samples[samples.length - 1].ts;
    const spanMs = lastTs - firstTs;
    const spanMin = spanMs / 60_000;
    const stepMin = spanMin <= 30 ? 1 : 5;
    const stepMs = stepMin * 60_000;
    const firstLabel = Math.ceil(firstTs / stepMs) * stepMs;

    for (let ts = firstLabel; ts <= lastTs + 1; ts += stepMs) {
        const frac = (ts - firstTs) / spanMs;
        if (frac < 0 || frac > 1) continue;
        const x = mL + frac * cW;
        ctx.beginPath();
        ctx.setLineDash([3, 4]);
        ctx.moveTo(x, mT);
        ctx.lineTo(x, H - mB);
        ctx.strokeStyle = gridColor;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);
        // The grid stays at every step; only every 5th minute gets a label.
        if (new Date(ts).getMinutes() % 5 !== 0) continue;
        ctx.fillStyle = labelColor;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(formatChartTimeTick(ts), x, H - mB + 5);
    }

    // Fill under curve
    ctx.beginPath();
    ctx.moveTo(cx(0), cy(values[0]));
    for (let i = 1; i < values.length; i++) ctx.lineTo(cx(i), cy(values[i]));
    ctx.lineTo(cx(values.length - 1), H - mB);
    ctx.lineTo(cx(0), H - mB);
    ctx.closePath();
    ctx.fillStyle = color + '28';
    ctx.fill();

    // Line
    ctx.beginPath();
    ctx.moveTo(cx(0), cy(values[0]));
    for (let i = 1; i < values.length; i++) ctx.lineTo(cx(i), cy(values[i]));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke();
}

export function chartCard(id: string, label: string, currentVal: string): string {
    return `<div class="bg-base-300 rounded-xl p-3">
        <div class="mb-2 flex items-center justify-between">
            <span class="text-xs font-semibold opacity-60">${label}</span>
            <span class="font-mono text-xs">${currentVal}</span>
        </div>
        <canvas id="${id}" style="width:100%;height:160px;display:block"></canvas>
    </div>`;
}

export function drawProbeChart(
    id: string,
    samples: Array<{ ts: number; ok: boolean; latencyMs: number | null }>,
    windowStart: number,
    windowEnd: number,
    intervalMs: number,
): void {
    const canvas = document.getElementById(id) as HTMLCanvasElement | null;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const displayW = canvas.clientWidth || 480;
    const displayH = canvas.clientHeight || 110;
    canvas.width = displayW * dpr;
    canvas.height = displayH * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, displayW, displayH);
    const base = getComputedStyle(canvas).color;
    const toRgba = (c: string, a: number): string => {
        if (c.startsWith('rgb(')) return c.replace('rgb(', 'rgba(').replace(')', `, ${a})`);
        if (c.startsWith('#')) {
            const hex =
                c.length === 4 ? c.replace(/[0-9a-f]/gi, (ch) => ch + ch).slice(1) : c.slice(1);
            const num = parseInt(hex, 16);
            return `rgba(${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}, ${a})`;
        }
        return `rgba(128,128,128,${a})`;
    };
    const gridColor = toRgba(base, 0.18);
    const labelColor = toRgba(base, 0.65);
    const okColor = '#22c55e';
    const failColor = '#dc2626';

    ctx.font = '10px ui-monospace, monospace';

    const latencies = samples
        .map((sample) => sample.latencyMs)
        .filter((latency): latency is number => latency != null);
    const peak = roundUpNice(Math.max(50, ...latencies, 0));
    const yTickValues = [0, peak / 2, peak];
    const maxYLabelWidth = Math.max(
        ...yTickValues.map((value) => ctx.measureText(`${Math.round(value)} ms`).width),
    );
    const m = {
        left: Math.max(28, Math.ceil(maxYLabelWidth) + 8),
        right: 8,
        top: 8,
        bottom: 18,
    };
    const cW = displayW - m.left - m.right;
    const cH = displayH - m.top - m.bottom;
    const span = Math.max(1, windowEnd - windowStart);
    const xFor = (ts: number) => m.left + ((ts - windowStart) / span) * cW;
    const yFor = (latencyMs: number) => m.top + cH - (latencyMs / peak) * cH;

    ctx.fillStyle = labelColor;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    for (const value of yTickValues) {
        const y = yFor(value);
        ctx.beginPath();
        ctx.moveTo(m.left, y);
        ctx.lineTo(displayW - m.right, y);
        ctx.strokeStyle = gridColor;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillText(`${Math.round(value)} ms`, m.left - 4, y);
    }

    const stepMs = 60 * 1000;
    const firstLabel = Math.ceil(windowStart / stepMs) * stepMs;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let ts = firstLabel; ts <= windowEnd + 1; ts += stepMs) {
        const x = xFor(ts);
        ctx.beginPath();
        ctx.moveTo(x, m.top);
        ctx.lineTo(x, displayH - m.bottom);
        ctx.strokeStyle = toRgba(base, 0.1);
        ctx.lineWidth = 1;
        ctx.stroke();
        const d = new Date(ts);
        ctx.fillText(
            `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`,
            x,
            displayH - 14,
        );
    }

    const okSamples = samples.filter((sample) => sample.ok && sample.latencyMs != null) as Array<{
        ts: number;
        ok: true;
        latencyMs: number;
    }>;
    if (okSamples.length > 0) {
        ctx.beginPath();
        ctx.moveTo(xFor(okSamples[0].ts), yFor(okSamples[0].latencyMs));
        for (let i = 1; i < okSamples.length; i++) {
            ctx.lineTo(xFor(okSamples[i].ts), yFor(okSamples[i].latencyMs));
        }
        ctx.strokeStyle = okColor;
        ctx.lineWidth = 1.5;
        ctx.stroke();
    }

    const halfInterval = Math.max(1, intervalMs) / 2;
    ctx.fillStyle = toRgba(failColor, 0.35);
    for (const sample of samples) {
        if (sample.ok) continue;
        const xStart = xFor(sample.ts - halfInterval);
        const xEnd = xFor(sample.ts + halfInterval);
        ctx.fillRect(xStart, m.top, Math.max(1, xEnd - xStart), cH);
    }
}
