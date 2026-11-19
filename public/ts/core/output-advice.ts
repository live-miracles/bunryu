import type { InputHealth, OutputView, PipelineView } from '../types.js';

// Advice about how an output or pipeline is configured, as opposed to what is happening to
// it: a destination another output also uses, a stream key two pipelines share, audio
// settings that do not suit the input. It is worked out here, in the browser, because only
// the dashboard shows it and its wording is the dashboard's to change; what is happening
// (the verdict) is the server's. None of it changes a status dot, and Key Vault never sees it.
//
// Each line is a mistake or a tip. A mistake is a configuration that will not do what the
// operator means (so it counts as a warning in every list, filter and count of problems); a
// tip is a better way to do something that works (so it is shown on the output's card and
// counts nowhere, or amber would stop meaning anything).

export type AdviceLevel = 'mistake' | 'tip';

export interface Advice {
    level: AdviceLevel;
    message: string;
}

// outputId lets an output leave itself out of its own duplicate list.
export type DupRef = { pipelineName: string; outputName?: string; outputId?: string };

// "Pipeline → Output", or just the pipeline's name when there is no output to name.
export function refLabel(ref: DupRef): string {
    return ref.outputName ? `${ref.pipelineName} → ${ref.outputName}` : ref.pipelineName;
}

// Destination URL → every output that pushes to it, for the URLs more than one output
// uses, across all pipelines (shared encodes are not listed: their rows are the server's).
export function duplicateDestinations(pipelines: readonly PipelineView[]): Map<string, DupRef[]> {
    const byUrl = new Map<string, DupRef[]>();
    for (const p of pipelines) {
        for (const o of p.outs) {
            if (!o.url) continue;
            const list = byUrl.get(o.url) ?? [];
            list.push({ pipelineName: p.name, outputName: o.name, outputId: o.id });
            byUrl.set(o.url, list);
        }
    }
    for (const [url, refs] of byUrl) if (refs.length < 2) byUrl.delete(url);
    return byUrl;
}

// Stream key id → the pipelines that use it, for the keys more than one pipeline uses:
// they cannot both publish.
export function sharedStreamKeys(pipelines: readonly PipelineView[]): Map<number, DupRef[]> {
    const byKey = new Map<number, DupRef[]>();
    for (const p of pipelines) {
        const list = byKey.get(p.streamKeyId) ?? [];
        list.push({ pipelineName: p.name });
        byKey.set(p.streamKeyId, list);
    }
    for (const [id, refs] of byKey) if (refs.length < 2) byKey.delete(id);
    return byKey;
}

// Audio settings that do not suit the input and the output's protocol.
function encodingAdvice(output: OutputView, input: InputHealth): Advice[] {
    if (!output.url || !input.connected) return [];
    const advice: Advice[] = [];
    const outIsSrt = output.url.startsWith('srt://');

    if (!input.isSrt && output.audioEncoding !== 'copy' && output.audioEncoding !== '0') {
        advice.push({
            level: 'mistake',
            message:
                'RTMP input only has one audio track — use copy or Track 1, not a different track selection.',
        });
    }
    if (!input.isSrt && !outIsSrt && output.audioEncoding === '0') {
        advice.push({
            level: 'tip',
            message:
                'Track 1 re-encodes the audio, which costs extra CPU — use copy unless the audio must be re-encoded.',
        });
    }
    if (input.isSrt && !outIsSrt && output.audioEncoding === 'copy') {
        advice.push({
            level: 'tip',
            message:
                'SRT-to-RTMP output should not use copy audio — it can cause audio jitter; select a track instead.',
        });
    }
    if (input.isSrt && input.audioTracks.length > 0) {
        const outOfRange = output.audioEncoding
            .split(',')
            .map((value) => value.trim())
            .filter((value) => /^\d+$/.test(value))
            .map(Number)
            .filter((index) => index >= input.audioTracks.length);
        if (outOfRange.length > 0) {
            const trackLabel = outOfRange.map((index) => index + 1).join(', ');
            const count = input.audioTracks.length;
            advice.push({
                level: 'mistake',
                message: `Output selects track ${trackLabel}, but the input only has ${count} audio track${count === 1 ? '' : 's'}.`,
            });
        }
    }
    return advice;
}

// The protocol, host, port and stream key of a destination that publishes to a pipeline
// key on `live/` (RTMP `.../live/<key>`, SRT `streamid=#!::r=live/<key>,m=publish`).
const RTMP_INGEST = /^rtmps?:\/\/([^/:?#]+)(?::(\d+))?\/live\/([^/?#]+)/;
const SRT_INGEST = /^srt:\/\/([^/:?#]+)(?::(\d+))?[^]*?r=live\/([^,&#]+)[^]*?m=publish/;

function ingestParts(
    url: string,
): { proto: 'rtmp' | 'srt'; host: string; port: string; key: string } | null {
    const rtmp = RTMP_INGEST.exec(url);
    if (rtmp) return { proto: 'rtmp', host: rtmp[1], port: rtmp[2] ?? '1935', key: rtmp[3] };
    const srt = SRT_INGEST.exec(url);
    if (srt) return { proto: 'srt', host: srt[1], port: srt[2] ?? '', key: srt[3] };
    return null;
}

// Output id → the advice line for each output that publishes into this server's own
// ingest and so back into its own pipeline's input, directly or through other pipelines'
// outputs. The server refuses nothing here and is the one that resolves any spelling of the
// address (a decimal IP, a name of this machine); this reads the destination as the form and
// a copied output write it: this server's RTMP or SRT host and port as the pipelines' publish
// URLs show them (the public host or the loopback one, `localhost` and `127.0.0.1` alike) and
// a pipeline's stream key. Keys decide it, as on the server, because pipelines may share a key.
export function restreamLoops(pipelines: readonly PipelineView[]): Map<string, string> {
    const loopback = new Set(['localhost', '127.0.0.1']);
    const endpoints = new Set<string>();
    const keys = new Set(pipelines.map((p) => p.streamKey));
    for (const p of pipelines) {
        for (const url of [
            p.rtmpPublishUrl,
            p.srtPublishUrl,
            p.rtmpPublishUrlLocal,
            p.srtPublishUrlLocal,
        ]) {
            const parts = url ? ingestParts(url) : null;
            if (!parts) continue;
            for (const host of [parts.host, ...loopback]) {
                endpoints.add(`${parts.proto}:${host}:${parts.port}`);
            }
        }
    }
    // The key of the pipeline a destination publishes into, or undefined.
    const targetKey = (url: string): string | undefined => {
        const parts = ingestParts(url);
        if (!parts || !keys.has(parts.key)) return undefined;
        return endpoints.has(`${parts.proto}:${parts.host}:${parts.port}`) ? parts.key : undefined;
    };
    // The outputs of each pipeline, by the key that pipeline reads.
    const byKey = new Map<string, { pipelineId: string; pipelineName: string; url: string }[]>();
    for (const p of pipelines) {
        for (const o of p.outs) {
            const list = byKey.get(p.streamKey) ?? [];
            list.push({ pipelineId: p.id, pipelineName: p.name, url: o.url });
            byKey.set(p.streamKey, list);
        }
    }

    const loops = new Map<string, string>();
    for (const p of pipelines) {
        for (const o of p.outs) {
            const first = targetKey(o.url);
            if (first === undefined) continue;
            if (first === p.streamKey) {
                loops.set(o.id, "Loops back into this pipeline's own input, so it cannot work");
                continue;
            }
            // This pipeline's own outputs never need following: reaching its key is the loop.
            const seen = new Set([first]);
            const queue = [first];
            for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
                for (const next of byKey.get(key) ?? []) {
                    if (next.pipelineId === p.id) continue;
                    const nextKey = targetKey(next.url);
                    if (nextKey === undefined) continue;
                    if (nextKey === p.streamKey) {
                        loops.set(
                            o.id,
                            `Loops back into this pipeline's input through "${next.pipelineName}", so it cannot work`,
                        );
                        queue.length = 0;
                        break;
                    }
                    if (!seen.has(nextKey)) {
                        seen.add(nextKey);
                        queue.push(nextKey);
                    }
                }
            }
        }
    }
    return loops;
}

// The advice for one output, one line each: a loop back into its own pipeline (`loops` is
// restreamLoops), the other outputs with the same destination (`dupUrls` is
// duplicateDestinations), then the audio settings.
export function outputAdvice(
    output: OutputView,
    input: InputHealth,
    dupUrls: Map<string, DupRef[]>,
    loops: ReadonlyMap<string, string> = new Map(),
): Advice[] {
    const others = (output.url ? (dupUrls.get(output.url) ?? []) : []).filter(
        (ref) => ref.outputId !== output.id,
    );
    const loop = loops.get(output.id);
    return [
        ...(loop ? [{ level: 'mistake' as const, message: loop }] : []),
        ...(others.length > 0
            ? [
                  {
                      level: 'mistake' as const,
                      message: `Same destination as ${others.map(refLabel).join(', ')}`,
                  },
              ]
            : []),
        ...encodingAdvice(output, input),
    ];
}

// Only the mistakes, as text: what counts as a problem next to the output's status.
export function outputMistakes(
    output: OutputView,
    input: InputHealth,
    dupUrls: Map<string, DupRef[]>,
    loops: ReadonlyMap<string, string> = new Map(),
): string[] {
    return outputAdvice(output, input, dupUrls, loops)
        .filter((a) => a.level === 'mistake')
        .map((a) => a.message);
}
