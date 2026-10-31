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

// Canvas drawing cannot take var() or light-dark(), so a CSS colour is resolved by
// letting the browser compute it on a throwaway element (an `rgb()` or `rgba()` string).
function resolveColor(value: string): string {
    const probe = document.createElement('span');
    probe.style.color = value;
    document.body.appendChild(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved;
}

function withAlpha(rgb: string, alpha: number): string {
    return rgb.startsWith('rgb(')
        ? rgb.replace('rgb(', 'rgba(').replace(')', `, ${alpha})`)
        : rgb.replace(/[\d.]+\)$/, `${alpha})`);
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

    const gridColor = resolveColor('var(--chart-grid)');
    const labelColor = resolveColor('var(--muted)');
    const lineColor = resolveColor(color);

    ctx.font = `10px ${getComputedStyle(canvas).fontFamily}`;

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
    ctx.fillStyle = withAlpha(lineColor, 0.14);
    ctx.fill();

    // Line
    ctx.beginPath();
    ctx.moveTo(cx(0), cy(values[0]));
    for (let i = 1; i < values.length; i++) ctx.lineTo(cx(i), cy(values[i]));
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke();
}

export function chartCard(id: string, label: string, currentVal: string): string {
    return `<div class="border-base-content/10 bg-base-100/50 rounded-lg border p-2.5">
        <div class="mb-2 flex items-center justify-between">
            <span class="text-xs font-semibold text-muted">${label}</span>
            <span class="text-xs font-semibold tabular-nums">${currentVal}</span>
        </div>
        <canvas id="${id}" style="width:100%;height:160px;display:block"></canvas>
    </div>`;
}
