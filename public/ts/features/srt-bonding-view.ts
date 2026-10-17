import { escapeHtml } from '../core/utils.js';
import type { SrtBondingLeg, SrtBondingStatus } from '../types.js';

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
        }>,
        className?: string,
    ) => string;
};

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
    const items = [
        ...(hasSessionStats
            ? [
                  {
                      label: 'Rx',
                      labelTitle:
                          'Unique data packets received from the upstream bonded SRT input, with a fallback to total received packets when needed.',
                      value: deps.formatCompactCount(rxPkts),
                  },
                  {
                      label: 'Latency',
                      labelTitle:
                          'Negotiated SRT buffering latency for the input. For a bonded group this is the max latency negotiated across legs.',
                      value: deps.fmtMs(status.input.latencyMs),
                  },
                  inputStatsAreDropOnly
                      ? {
                            label: 'L / R / D',
                            labelTitle:
                                'Deduplicated packet drops on the bonded group input. Loss and receive retransmission are unavailable for the bonded aggregate.',
                            value: deps.fmtLossRexmitDrop(null, null, status.input.recvDropTotal),
                        }
                      : {
                            label: 'L / R / D',
                            labelTitle: 'Loss / Rexmit / Drop on the input connection.',
                            value: deps.fmtLossRexmitDrop(
                                status.input.recvLossTotal,
                                status.input.retransTotal,
                                status.input.recvDropTotal,
                            ),
                        },
              ]
            : []),
        ...(hasOutputStats
            ? [
                  {
                      label: 'Out L / R / D',
                      labelTitle: 'Loss / Rexmit / Drop on the downstream output connection.',
                      value: deps.fmtLossRexmitDrop(
                          status.output.sendLossTotal,
                          status.output.retransTotal,
                          status.output.sendDropTotal,
                      ),
                  },
              ]
            : []),
    ];
    return items.length > 0 ? deps.renderCompactMetaRow(items, 'input-meta-row-sm') : '';
}

export function renderBondedLegs(input: SrtBondingStatus['input'], deps: BondingViewDeps): string {
    const legs = input.legs;
    if (legs.length === 0) return '';
    const heading = input.bonded ? `Bonded legs (${legs.length})` : 'SRT input via relay';
    return `<div class="text-xs font-semibold opacity-60 mb-1">${heading}</div>
                   <div class="overflow-x-auto">
                   <table class="table table-xs">
                       <thead><tr>
                           <th>State</th><th>${input.bonded ? 'Leg IP' : 'Source IP'}</th><th>RTT</th>
                           <th>Rate</th><th>Buffer</th>
                           <th><span title="Loss / Rexmit / Drop">L / R / D</span></th>
                       </tr></thead>
                       <tbody>${legs
                           .map((leg) => {
                               const color = deps.legHealthColor(leg);
                               const health = deps.legHealthLabel(leg);
                               const title = leg.healthReason ?? `Transport state: ${leg.state}`;
                               return `<tr>
                                   <td title="${escapeHtml(title)}"><span class="inline-flex items-center gap-1"><span class="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style="background:${color}"></span>${health}<span class="opacity-60">(${escapeHtml(leg.state)})</span></span></td>
                                   <td class="font-mono text-xs">${escapeHtml(leg.ip)}</td>
                                   <td class="font-mono text-xs">${deps.fmtMs(leg.rttMs)}</td>
                                   <td class="font-mono text-xs">${deps.fmtMbpsValue(leg.recvRateMbps)}</td>
                                   <td class="font-mono text-xs">${deps.fmtMs(leg.rcvBufMs)}</td>
                                   <td class="font-mono text-xs" title="Loss / Rexmit / Drop">${deps.fmtLossRexmitDrop(leg.recvLossTotal, leg.retransTotal, leg.recvDropTotal)}</td>
                               </tr>`;
                           })
                           .join('')}</tbody>
                   </table>
                   </div>`;
}
