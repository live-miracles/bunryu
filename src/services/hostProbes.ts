import dns from 'dns/promises';
import net from 'net';
import type { Express } from 'express';
import { checkProbeAddress } from '../utils/destination.js';
import { createLoopFailureReporter } from '../utils/diagnostics.js';
import type { Db, HostProbeSample, HostProbeSummary, HostProbeTarget } from '../types.js';

const PROBE_INTERVAL_MS = 5_000;
const PROBE_TIMEOUT_MS = 1_000;
const PROBE_CONCURRENCY = 4;
const HISTORY_RETENTION_MS = 6 * 60 * 60 * 1000;
const DEFAULT_HISTORY_HOURS = 6;
const MAX_HISTORY_HOURS = 6;

export interface HostProbeApiTarget extends HostProbeSummary {
    history: HostProbeSample[];
}

export interface HostProbeApiResponse {
    generatedAt: string;
    intervalMs: number;
    targets: HostProbeApiTarget[];
}

interface HostProbeHistoryState {
    signature: string;
    samples: HostProbeSample[];
}

function asPort(port: number): number {
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 1935;
}

async function probeTarget(target: HostProbeTarget): Promise<HostProbeSample> {
    let resolvedAddress: string | null = null;
    try {
        const lookup = await dns.lookup(target.host, { family: 0 });
        resolvedAddress = lookup.address;
        const notProbed = checkProbeAddress(lookup.address);
        if (notProbed) {
            return {
                ts: Date.now(),
                ok: false,
                latencyMs: null,
                error: notProbed,
                resolvedAddress: null,
            };
        }
    } catch (err) {
        return {
            ts: Date.now(),
            ok: false,
            latencyMs: null,
            error: err instanceof Error ? err.message : String(err),
            resolvedAddress: null,
        };
    }

    return await new Promise<HostProbeSample>((resolve) => {
        const startedAt = Date.now();
        const socket = net.createConnection({
            host: resolvedAddress,
            port: asPort(target.port),
        });

        let settled = false;
        const finish = (sample: HostProbeSample): void => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(sample);
        };

        socket.setTimeout(PROBE_TIMEOUT_MS);
        socket.once('connect', () => {
            finish({
                ts: Date.now(),
                ok: true,
                latencyMs: Date.now() - startedAt,
                error: null,
                resolvedAddress,
            });
        });
        socket.once('timeout', () => {
            finish({
                ts: Date.now(),
                ok: false,
                latencyMs: null,
                error: 'timeout',
                resolvedAddress,
            });
        });
        socket.once('error', (err) => {
            finish({
                ts: Date.now(),
                ok: false,
                latencyMs: null,
                error: err.message,
                resolvedAddress,
            });
        });
    });
}

async function mapWithConcurrency<T, U>(
    items: T[],
    concurrency: number,
    worker: (item: T) => Promise<U>,
): Promise<U[]> {
    const results: U[] = new Array(items.length);
    let nextIndex = 0;

    const runWorker = async (): Promise<void> => {
        while (true) {
            const index = nextIndex++;
            if (index >= items.length) return;
            results[index] = await worker(items[index]);
        }
    };

    await Promise.all(
        Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker()),
    );
    return results;
}

function buildResponse(
    targets: HostProbeTarget[],
    samples: Array<HostProbeSample & { slot: number }>,
): HostProbeApiResponse {
    const bySlot = new Map<number, HostProbeSample[]>();
    for (const sample of samples) {
        const list = bySlot.get(sample.slot) ?? [];
        list.push({
            ts: sample.ts,
            ok: sample.ok,
            latencyMs: sample.latencyMs,
            error: sample.error,
            resolvedAddress: sample.resolvedAddress,
        });
        bySlot.set(sample.slot, list);
    }

    const targetPayload = targets.map((target) => {
        const history = bySlot.get(target.slot) ?? [];
        const latestSample = history[history.length - 1] ?? null;
        const latencySamples = history.filter((sample) => sample.ok && sample.latencyMs != null);
        const averageLatencyMs =
            latencySamples.length > 0
                ? latencySamples.reduce((sum, sample) => sum + (sample.latencyMs ?? 0), 0) /
                  latencySamples.length
                : null;

        return {
            target,
            latestSample,
            historySampleCount: history.length,
            historyFailureCount: history.filter((sample) => !sample.ok).length,
            averageLatencyMs,
            history,
        };
    });

    return {
        generatedAt: new Date().toISOString(),
        intervalMs: PROBE_INTERVAL_MS,
        targets: targetPayload,
    };
}

function targetSignature(target: HostProbeTarget): string {
    return `${target.label}\n${target.host}\n${asPort(target.port)}`;
}

export function createHostProbeService(db: Db): {
    start: () => void;
    registerRoutes: (app: Express) => void;
} {
    let started = false;
    let tickInFlight = false;
    const historyBySlot = new Map<number, HostProbeHistoryState>();

    const reconcileTargets = (targets: HostProbeTarget[]): void => {
        const activeSlots = new Set<number>();
        for (const target of targets) {
            activeSlots.add(target.slot);
            const signature = targetSignature(target);
            const existing = historyBySlot.get(target.slot);
            if (!existing || existing.signature !== signature) {
                historyBySlot.set(target.slot, { signature, samples: [] });
            }
        }
        for (const slot of historyBySlot.keys()) {
            if (!activeSlots.has(slot)) historyBySlot.delete(slot);
        }
    };

    const appendSample = (slot: number, sample: HostProbeSample): void => {
        const state = historyBySlot.get(slot);
        if (!state) return;
        state.samples.push(sample);
    };

    const pruneSamples = (beforeTs: number): void => {
        for (const state of historyBySlot.values()) {
            state.samples = state.samples.filter((sample) => sample.ts >= beforeTs);
        }
    };

    const listSamplesSince = (sinceTs: number): Array<HostProbeSample & { slot: number }> => {
        const samples: Array<HostProbeSample & { slot: number }> = [];
        for (const [slot, state] of historyBySlot) {
            for (const sample of state.samples) {
                if (sample.ts >= sinceTs) samples.push({ slot, ...sample });
            }
        }
        samples.sort((a, b) => (a.slot === b.slot ? a.ts - b.ts : a.slot - b.slot));
        return samples;
    };

    const cycleFailures = createLoopFailureReporter('host-probes');

    const runCycle = async (): Promise<void> => {
        if (tickInFlight) return;
        tickInFlight = true;
        try {
            await probeCycle();
            cycleFailures.succeeded();
        } catch (err) {
            cycleFailures.failed(err);
        } finally {
            tickInFlight = false;
        }
    };

    const probeCycle = async (): Promise<void> => {
        const targets = db.listHostProbeTargets();
        reconcileTargets(targets);
        if (targets.length === 0) {
            pruneSamples(Date.now() - HISTORY_RETENTION_MS);
            return;
        }
        const samples = await mapWithConcurrency(targets, PROBE_CONCURRENCY, probeTarget);
        for (let i = 0; i < targets.length; i++) {
            appendSample(targets[i].slot, samples[i]);
        }
        pruneSamples(Date.now() - HISTORY_RETENTION_MS);
    };

    return {
        start(): void {
            if (started) return;
            started = true;
            void runCycle();
            setInterval(() => void runCycle(), PROBE_INTERVAL_MS).unref();
        },

        registerRoutes(app: Express): void {
            app.get('/api/host-probes', (req, res) => {
                const rawHours = Number(req.query.hours);
                const hours =
                    Number.isFinite(rawHours) && rawHours > 0
                        ? Math.min(MAX_HISTORY_HOURS, rawHours)
                        : DEFAULT_HISTORY_HOURS;
                const sinceTs = Date.now() - hours * 60 * 60 * 1000;
                const targets = db.listHostProbeTargets();
                reconcileTargets(targets);
                const samples = listSamplesSince(sinceTs);
                res.json(buildResponse(targets, samples));
            });
        },
    };
}
