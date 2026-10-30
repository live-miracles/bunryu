import type { PipelineHealth } from './health.js';

// The per-pipeline part of the once-a-minute health-snapshot diagnostics event: a
// trimmed copy of each pipeline's health, small enough to keep at 500 outputs.
export function pipelineDiagnosticsOf(
    pipelines: Record<string, PipelineHealth>,
): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [pipelineId, pipelineHealth] of Object.entries(pipelines)) {
        result[pipelineId] = {
            input: {
                connected: pipelineHealth.input.connected,
                live: pipelineHealth.input.live,
                isSrt: pipelineHealth.input.isSrt,
                mediaOk: pipelineHealth.input.mediaOk,
                recvBitrateKbps: pipelineHealth.input.recvBitrateKbps,
                sendBitrateKbps: pipelineHealth.input.sendBitrateKbps,
            },
            bonding: {
                inputActive: pipelineHealth.srtBonding.inputActive,
                outputConnected: pipelineHealth.srtBonding.outputConnected,
                retryFailures: pipelineHealth.srtBonding.retryFailures,
                forwardedPackets: pipelineHealth.srtBonding.forwardedPackets,
                forwardedBytes: pipelineHealth.srtBonding.forwardedBytes,
                lastPacketAt: pipelineHealth.srtBonding.lastPacketAt,
                lastInputPacketAt: pipelineHealth.srtBonding.lastInputPacketAt,
                input: {
                    recvPacketsTotal: pipelineHealth.srtBonding.input.recvPacketsTotal,
                    recvUniquePacketsTotal: pipelineHealth.srtBonding.input.recvUniquePacketsTotal,
                    recvLossTotal: pipelineHealth.srtBonding.input.recvLossTotal,
                    recvDropTotal: pipelineHealth.srtBonding.input.recvDropTotal,
                    retransTotal: pipelineHealth.srtBonding.input.retransTotal,
                    recvRateMbps: pipelineHealth.srtBonding.input.recvRateMbps,
                    latencyMs: pipelineHealth.srtBonding.input.latencyMs,
                    expectedLegs: pipelineHealth.srtBonding.input.expectedLegs,
                    legs: pipelineHealth.srtBonding.input.legs.map((leg) => ({
                        ip: leg.ip,
                        port: leg.port,
                        state: leg.state,
                        health: leg.health,
                        healthReason: leg.healthReason,
                        recvPacketsTotal: leg.recvPacketsTotal,
                        recvUniquePacketsTotal: leg.recvUniquePacketsTotal,
                        recvLossTotal: leg.recvLossTotal,
                        recvDropTotal: leg.recvDropTotal,
                        retransTotal: leg.retransTotal,
                        recvRateMbps: leg.recvRateMbps,
                        rttMs: leg.rttMs,
                        latencyMs: leg.latencyMs,
                    })),
                },
            },
            // A stopped output's fields are all null; at 500 outputs they
            // would dominate the snapshot's size.
            outputs: Object.fromEntries(
                Object.entries(pipelineHealth.outputs)
                    .filter(([, output]) => output.status !== 'stopped')
                    .map(([outputId, output]) => [
                        outputId,
                        {
                            status: output.status,
                            pid: output.pid,
                            bitrateKbps: output.bitrateKbps,
                            lastOutTimeUs: output.lastOutTimeUs,
                            lastTotalSizeBytes: output.lastTotalSizeBytes,
                            progressAgeMs: output.progressAgeMs,
                            outputProgressAgeMs: output.outputProgressAgeMs,
                            startedAtMs: output.startedAtMs,
                            failures: output.failures,
                            warningReason: output.warningReason,
                            memoryUsageBytes: output.memoryUsageBytes,
                            memoryLimitBytes: output.memoryLimitBytes,
                            cpuPercent: output.cpuPercent,
                            speed: output.speed,
                            role: output.role,
                            renditionId: output.renditionId,
                            ready: output.ready,
                            readers: output.readers,
                        },
                    ]),
            ),
            alerts: pipelineHealth.alerts,
        };
    }
    return result;
}
