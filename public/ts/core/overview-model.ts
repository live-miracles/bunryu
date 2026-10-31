import type {
    OutputView,
    PipelineView,
    ProcUsage,
    SrtBondingLeg,
    SystemMetrics,
} from '../types.js';
import { inputHealth, outputHealth, type InputStatus, type OutStatus } from './status.js';
import { relayHealth, type RelayHealth } from './relay-status.js';
import { affectedOutputCount, isOffline, isProblem, matchesName } from './overview-filter.js';
import { sharedEncodeLabel } from './renditions.js';
import type { OverviewFilter } from './state.js';

// Everything the Overview draws that is a decision and not markup: which rows each
// table shows under the All / Active / Issues filter and the search boxes, how many
// there are in each count, the sentence an empty table shows, and the System usage
// sums. `render.ts` turns the result into HTML. Pure, so a test needs no DOM.

export interface OverviewTable<Row> {
    // The rows to draw: the filter and the search applied.
    rows: Row[];
    // Counts that ignore the filter and the search, so a chip or heading keeps its figure
    // while rows are hidden.
    total: number;
    problems: number;
    active: number;
    // The sentence for a table with no rows to draw, or null when the table is left out
    // (relay and shared encodes with none at all) or has rows.
    empty: string | null;
}

export interface RelayRow {
    pipeline: PipelineView;
    relay: RelayHealth;
}

export interface InputRow {
    pipeline: PipelineView;
    status: InputStatus;
    // Outputs in trouble because this input is offline; the input is then an issue itself.
    affectedOutputs: number;
}

export interface OutputRow {
    pipeline: PipelineView;
    output: OutputView;
    status: OutStatus;
}

// One System usage figure per column. null is "not reported", drawn as a dash.
export interface UsageRow {
    node: number | null;
    srs: number | null;
    relay: number | null;
    outs: number | null;
    // The sum of the Bunryu processes above that reported.
    app: number | null;
    system: number | null;
}

export interface OverviewModel {
    relay: OverviewTable<RelayRow> & { legIpHeader: string };
    inputs: OverviewTable<InputRow>;
    outputs: OverviewTable<OutputRow>;
    sharedEncodes: OverviewTable<OutputRow>;
    // The All / Active / Issues chips.
    totals: { all: number; active: number; problems: number };
    usage: {
        uptimeSeconds: number | null;
        // Single-core relative: 100 is one full core, so the sums can pass 100.
        cpuPercent: UsageRow;
        ramBytes: UsageRow;
        downlinkKbps: UsageRow;
        uplinkKbps: UsageRow;
    };
}

export interface OverviewModelInput {
    pipelines: PipelineView[];
    metrics: Partial<SystemMetrics>;
    relayProcessRunning: boolean;
    nowMs: number;
    filter: OverviewFilter;
    inputSearch: string;
    // Filters the Outputs table and the Shared encodes table.
    outputSearch: string;
}

interface Candidate<Row> {
    row: Row;
    problem: boolean;
    offline: boolean;
    matches: boolean;
}

interface TableWords {
    noun: string;
    noProblems: string;
    noActive: string;
    // Shown when there is nothing to list at all; null leaves the table out.
    none: string | null;
}

function buildTable<Row>(
    candidates: Candidate<Row>[],
    filter: OverviewFilter,
    search: string,
    words: TableWords,
): OverviewTable<Row> {
    const rows = candidates
        .filter(
            (c) =>
                (filter !== 'problems' || c.problem) &&
                (filter !== 'active' || !c.offline) &&
                c.matches,
        )
        .map((c) => c.row);
    let empty: string | null = null;
    if (candidates.length === 0) {
        empty = words.none;
    } else if (rows.length === 0) {
        empty =
            search.trim() !== ''
                ? `No ${words.noun} match “${search.trim()}”.`
                : filter === 'problems'
                  ? words.noProblems
                  : words.noActive;
    }
    return {
        rows,
        total: candidates.length,
        problems: candidates.filter((c) => c.problem).length,
        active: candidates.filter((c) => !c.offline).length,
        empty,
    };
}

// A relay pipeline is listed once the relay has seen anything of it.
function isRelayActive(p: PipelineView): boolean {
    const b = p.srtBonding;
    return (
        b.inputActive ||
        b.outputConnected ||
        b.forwardedPackets > 0 ||
        (b.input.recvPacketsTotal ?? 0) > 0 ||
        b.input.recvUniquePacketsTotal > 0 ||
        (b.input.retransTotal ?? 0) > 0 ||
        (b.input.recvLossTotal ?? 0) > 0 ||
        (b.input.recvDropTotal ?? 0) > 0
    );
}

// The Detailed stats table's wording: a bonded input's links are legs.
function legIpHeader(relayPipelines: PipelineView[]): string {
    const bonded = relayPipelines.map((p) => p.srtBonding.input.bonded);
    return !bonded.includes(true)
        ? 'Source IP'
        : bonded.includes(false)
          ? 'Leg / Source IP'
          : 'Leg IP';
}

function sumKnown(values: Array<number | null | undefined>): number | null {
    let sum = 0;
    let known = false;
    for (const v of values) {
        if (v != null) {
            sum += v;
            known = true;
        }
    }
    return known ? sum : null;
}

// Fed locally by the relay or by a chained pipeline's output, not by the network.
const isLoopbackHost = (host: string | null | undefined): boolean =>
    host === 'localhost' || host === '127.0.0.1';

function hostOf(url: string): string | null {
    try {
        return new URL(url).hostname;
    } catch {
        return null;
    }
}

const legRateKbps = (leg: SrtBondingLeg): number | null =>
    leg.recvRateMbps == null ? null : leg.recvRateMbps * 1000;

export function buildOverviewModel(input: OverviewModelInput): OverviewModel {
    const { pipelines, metrics: m, filter } = input;

    const relayPipelines = pipelines.filter(isRelayActive);
    const relay = buildTable(
        relayPipelines.map((pipeline): Candidate<RelayRow> => {
            const health = relayHealth(pipeline, input.relayProcessRunning, input.nowMs);
            return {
                row: { pipeline, relay: health },
                problem: isProblem(health.input) || isProblem(health.output),
                offline: isOffline(health.input) && isOffline(health.output),
                matches: true,
            };
        }),
        filter,
        '',
        {
            noun: 'relay sessions',
            noProblems: 'No relay issues.',
            noActive: 'No active relay sessions.',
            none: null,
        },
    );

    // An input nobody publishes to is "off". With outputs in trouble because of it, it is
    // also an issue, so the Issues view lists the cause beside its affected outputs.
    const inputs = buildTable(
        pipelines.map((pipeline): Candidate<InputRow> => {
            const status = inputHealth(pipeline.input).status;
            const affectedOutputs = affectedOutputCount(
                status,
                pipeline.outs.map((o) => outputHealth(o, pipeline.input).status),
            );
            return {
                row: { pipeline, status, affectedOutputs },
                problem: isProblem(status) || affectedOutputs > 0,
                offline: isOffline(status),
                matches: matchesName(
                    input.inputSearch,
                    pipeline.name,
                    pipeline.streamKey,
                    pipeline.rtmpPublishUrl,
                    pipeline.srtPublishUrl,
                ),
            };
        }),
        filter,
        input.inputSearch,
        {
            noun: 'inputs',
            noProblems: 'No input issues.',
            noActive: 'No active inputs.',
            none: 'No pipelines yet.',
        },
    );

    // `names` are what the Outputs search box matches besides the pipeline's name.
    const outputCandidate = (
        pipeline: PipelineView,
        output: OutputView,
        names: string[],
    ): Candidate<OutputRow> => {
        const status = outputHealth(output, pipeline.input).status;
        return {
            row: { pipeline, output, status },
            problem: isProblem(status),
            offline: isOffline(status),
            matches: matchesName(input.outputSearch, pipeline.name, ...names),
        };
    };
    const outputs = buildTable(
        pipelines.flatMap((p) => p.outs.map((o) => outputCandidate(p, o, [o.name, o.url ?? '']))),
        filter,
        input.outputSearch,
        {
            noun: 'outputs',
            noProblems: 'No output issues.',
            noActive: 'No active outputs.',
            none: 'No outputs yet.',
        },
    );

    // Server-managed FFmpeg processes that several outputs of a pipeline read; they are
    // not outputs (not counted among them) but cost CPU and RAM like one.
    const sharedEncodes = buildTable(
        pipelines.flatMap((p) =>
            p.renditions.map((r) => outputCandidate(p, r, [sharedEncodeLabel(r)])),
        ),
        filter,
        input.outputSearch,
        {
            noun: 'shared encodes',
            noProblems: 'No shared encode issues.',
            noActive: 'No active shared encodes.',
            none: null,
        },
    );

    const tables = [relay, inputs, outputs, sharedEncodes];
    const sum = (pick: (t: OverviewTable<unknown>) => number): number =>
        tables.reduce((s, t) => s + pick(t), 0);

    // Every tracked process's own %CPU and RSS: node, SRS, relay and every output and
    // shared encode. Whole-system usage, so the filter does not touch it.
    const everyOutput = pipelines.flatMap((p) => [...p.outs, ...p.renditions]);
    const outsCpu = sumKnown(everyOutput.map((o) => o.cpuPercent));
    const outsRam = sumKnown(everyOutput.map((o) => o.memoryUsageBytes));
    const perProcess = (pick: (usage: ProcUsage) => number | null) =>
        [m.node, m.srs, m.relay].map((u) => (u ? pick(u) : null));
    const [nodeCpu, srsCpu, relayCpu] = perProcess((u) => u.cpuPercent);
    const [nodeRam, srsRam, relayRam] = perProcess((u) => u.ramBytes);

    // Downlink is what SRS receives directly from publishers (loopback ones are fed by the
    // relay or a chained pipeline's output) plus what the relay pulls in across its legs.
    // Uplink is what the outputs push out, less those chained into another pipeline.
    const srsDown = sumKnown(
        pipelines
            .filter((p) => !isLoopbackHost(p.input.publisherIp))
            .map((p) => p.input.recvBitrateKbps),
    );
    const relayDown = sumKnown(
        relayPipelines.flatMap((p) => p.srtBonding.input.legs.map(legRateKbps)),
    );
    const outsUp = sumKnown(
        everyOutput
            .filter((o) => o.url && !isLoopbackHost(hostOf(o.url)))
            .map((o) => o.bitrateKbps),
    );

    return {
        relay: { ...relay, legIpHeader: legIpHeader(relayPipelines) },
        inputs,
        outputs,
        sharedEncodes,
        totals: {
            all: sum((t) => t.total),
            active: sum((t) => t.active),
            problems: sum((t) => t.problems),
        },
        usage: {
            uptimeSeconds: m.uptimeSeconds ?? null,
            cpuPercent: {
                node: nodeCpu,
                srs: srsCpu,
                relay: relayCpu,
                outs: outsCpu,
                app: sumKnown([nodeCpu, srsCpu, relayCpu, outsCpu]),
                // The machine's percent is across all cores; scale it to one core's basis.
                system: m.cpu ? m.cpu.percent * m.cpu.cores : null,
            },
            ramBytes: {
                node: nodeRam,
                srs: srsRam,
                relay: relayRam,
                outs: outsRam,
                app: sumKnown([nodeRam, srsRam, relayRam, outsRam]),
                system: m.ram?.usedBytes ?? null,
            },
            downlinkKbps: {
                node: null,
                srs: srsDown,
                relay: relayDown,
                outs: null,
                app: sumKnown([srsDown, relayDown]),
                system: m.net ? (m.net.rxBytesPerSec * 8) / 1000 : null,
            },
            uplinkKbps: {
                node: null,
                srs: null,
                relay: null,
                outs: outsUp,
                app: outsUp,
                system: m.net ? (m.net.txBytesPerSec * 8) / 1000 : null,
            },
        },
    };
}
