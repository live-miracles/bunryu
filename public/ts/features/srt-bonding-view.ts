import { escapeHtml } from '../core/utils.js';
import type { SrtBondingLeg, SrtBondingStatus, SrtRecent } from '../types.js';

type BondingViewDeps = {
    formatCompactCount: (value: number) => string;
    fmtMs: (value: number | null | undefined) => string;
    fmtMbpsValue: (value: number | null | undefined) => string;
    fmtLossRexmitDrop: (
        loss: number | null | undefined,
        retransmit: number | null | undefined,
        drop: number | null | undefined,
    ) => string;
    inputAggregateStatsAreDropOnly: (input: SrtBondingStatus['input']) => boolean;
    legHealthColor: (leg: SrtBondingLeg) => string;
    legHealthLabel: (leg: SrtBondingLeg) => string;
    renderCompactMetaRow: (
        items: Array<{
            label: string;
            labelTitle?: string;
            value: string | number | null | undefined;
            valueClass?: string;
            valueTitle?: string;
        }>,
        className?: string,
    ) => string;
};

// Loss / Rexmit / Drop figures show what happened over the last few minutes,
// not since the stream connected: on a long event the totals only ever grow and
// say nothing about the link now. The totals are in the Detailed stats dialog.
type Counts = {
    loss: number | null | undefined;
    retrans: number | null | undefined;
    drop: number | null | undefined;
};

// The relay keeps a stream's last error across reconnects, so it can be days old.
// Like an output's, it is shown as a problem only while it is unresolved: the stream
// is up and has not forwarded a packet since the error. After that it is history,
// still open from the history button.
export function hasCurrentRelayError(
    status: Pick<
        SrtBondingStatus,
        'lastError' | 'lastErrorAt' | 'inputActive' | 'outputConnected' | 'lastPacketAt'
    >,
): boolean {
    if (!status.lastError || !(status.inputActive || status.outputConnected)) return false;
    const { lastErrorAt, lastPacketAt } = status;
    return !(lastErrorAt !== null && lastPacketAt !== null && lastPacketAt > lastErrorAt);
}

export function recentSpanLabel(spanMs: number): string {
    return spanMs >= 90_000
        ? `${Math.round(spanMs / 60_000)} min`
        : `${Math.round(spanMs / 1000)} s`;
}

function countList(values: Counts, units: { loss: string; retrans: string; drop: string }): string {
    const parts = [
        values.loss != null ? `${values.loss.toLocaleString()} ${units.loss}` : null,
        values.retrans != null ? `${values.retrans.toLocaleString()} ${units.retrans}` : null,
        values.drop != null ? `${values.drop.toLocaleString()} ${units.drop}` : null,
    ].filter((part) => part !== null);
    return parts.join(', ');
}

export interface RecentFigure {
    text: string;
    title: string;
    // Nothing lost, resent or dropped lately: shown dimmed so a burst stands out.
    quiet: boolean;
    // Packets dropped lately. For the whole stream (not one leg) these are
    // missing from what is delivered, so the cell is marked.
    dropped: boolean;
}

// `dropOnly`: a bonded group reports only the packets still missing after the
// legs back each other up, so only the Drop is filled in and the rest show a dash.
export function recentFigure(
    recent: SrtRecent | null | undefined,
    dropOnly: boolean,
    deps: Pick<BondingViewDeps, 'formatCompactCount' | 'fmtLossRexmitDrop'>,
): RecentFigure {
    const units = { loss: 'lost', retrans: 'rexmit', drop: 'dropped' };
    if (!recent) {
        return {
            text: '—',
            title: 'Collecting…',
            quiet: true,
            dropped: false,
        };
    }
    const shown = dropOnly ? { loss: null, retrans: null, drop: recent.drop } : recent;
    return {
        text: dropOnly
            ? deps.fmtLossRexmitDrop(null, null, recent.drop)
            : deps.fmtLossRexmitDrop(recent.loss, recent.retrans, recent.drop),
        title: `Last ${recentSpanLabel(recent.spanMs)}: ${countList(shown, units)}`,
        quiet: !recent.loss && !recent.retrans && !recent.drop,
        dropped: (recent.drop ?? 0) > 0,
    };
}

const INPUT_MEANING = 'Loss / Rexmit / Drop on the input connection.';
const BONDED_MEANING = 'Packets still missing after the bonded legs backed each other up.';
const OUTPUT_MEANING = 'Loss / Rexmit / Drop on the output connection.';
const LEG_MEANING =
    'Loss / Rexmit / Drop on this link. Another leg may have delivered a dropped packet.';

function figureClass(figure: RecentFigure, markDrops: boolean): string {
    if (markDrops && figure.dropped) return 'text-warning font-semibold';
    return figure.quiet ? 'opacity-50' : '';
}

export function renderBondingStats(
    status: SrtBondingStatus,
    relayProcessRunning: boolean,
    deps: BondingViewDeps,
): string {
    const inputStatsAreDropOnly = deps.inputAggregateStatsAreDropOnly(status.input);
    const rxPkts = status.input.recvUniquePacketsTotal || status.input.recvPacketsTotal || 0;
    const hasSessionStats =
        relayProcessRunning &&
        (status.inputActive || rxPkts > 0 || (status.input.retransTotal ?? 0) > 0);
    const hasOutputStats =
        relayProcessRunning && (status.outputConnected || status.output.sentPacketsTotal > 0);
    const inputFigure = recentFigure(status.input.recent, inputStatsAreDropOnly, deps);
    const outputFigure = recentFigure(status.output.recent, false, deps);
    const labelFor = (base: string, recent: SrtRecent | null): string =>
        recent ? `${base} ${recentSpanLabel(recent.spanMs)}` : base;
    const inputItem = {
        label: labelFor('In L / R / D', status.input.recent),
        labelTitle: inputStatsAreDropOnly ? BONDED_MEANING : INPUT_MEANING,
        value: inputFigure.text,
        valueTitle: inputFigure.title,
        valueClass: figureClass(inputFigure, true),
    };
    const outputItem = {
        label: labelFor('Out L / R / D', status.output.recent),
        labelTitle: OUTPUT_MEANING,
        value: outputFigure.text,
        valueTitle: outputFigure.title,
        valueClass: figureClass(outputFigure, true),
    };
    const latencyItem = {
        label: 'Latency',
        labelTitle:
            'Negotiated SRT buffering latency for the input. For a bonded group this is the max latency negotiated across legs.',
        value: deps.fmtMs(status.input.latencyMs),
    };
    const items = [
        ...(hasSessionStats ? [inputItem] : []),
        ...(hasOutputStats ? [outputItem] : []),
        ...(hasSessionStats ? [latencyItem] : []),
    ];
    return items.length > 0 ? deps.renderCompactMetaRow(items, 'input-meta-row-sm') : '';
}

export function renderBondedLegs(input: SrtBondingStatus['input'], deps: BondingViewDeps): string {
    const legs = input.legs;
    if (legs.length === 0) return '';
    const expected = Math.max(input.expectedLegs, legs.length);
    const legSpanMs = Math.max(0, ...legs.map((leg) => leg.recent?.spanMs ?? 0));
    const heading = input.bonded
        ? `Bonded legs (${legs.length}${expected > legs.length ? ` of ${expected}` : ''})`
        : 'SRT input via relay';
    return `<div class="text-xs font-semibold text-muted mb-1">${heading}</div>
                   <div class="overflow-x-auto">
                   <table class="table table-xs">
                       <thead><tr>
                           <th>State</th><th>${input.bonded ? 'Leg IP' : 'Source IP'}</th>
                           <th><span title="${escapeHtml(LEG_MEANING)}">L / R / D</span>${legSpanMs > 0 ? ` <span class="font-normal text-muted">${recentSpanLabel(legSpanMs)}</span>` : ''}</th>
                           <th>RTT</th><th>Rate</th><th>Buffer</th>
                       </tr></thead>
                       <tbody>${legs
                           .map((leg) => {
                               const color = deps.legHealthColor(leg);
                               const health = deps.legHealthLabel(leg);
                               const title = leg.healthReason ?? `Transport state: ${leg.state}`;
                               const figure = recentFigure(leg.recent, false, deps);
                               return `<tr>
                                   <td title="${escapeHtml(title)}"><span class="inline-flex items-center gap-1"><span class="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style="background:${color}"></span>${health}${leg.state === 'running' ? '' : `<span class="text-muted">(${escapeHtml(leg.state)})</span>`}</span></td>
                                   <td class="font-mono text-xs">${escapeHtml(leg.ip)}</td>
                                   <td class="font-mono text-xs whitespace-nowrap ${figureClass(figure, false)}" title="${escapeHtml(figure.title)}">${figure.text}</td>
                                   <td class="font-mono text-xs whitespace-nowrap">${deps.fmtMs(leg.rttMs)}</td>
                                   <td class="font-mono text-xs whitespace-nowrap">${deps.fmtMbpsValue(leg.recvRateMbps)}</td>
                                   <td class="font-mono text-xs whitespace-nowrap">${deps.fmtMs(leg.rcvBufMs)}</td>
                               </tr>`;
                           })
                           .join('')}</tbody>
                   </table>
                   </div>`;
}
