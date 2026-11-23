import type { InputHealth, OutputView, PipelineView } from '../types.js';
import { lastErrorLine } from './status.js';

// Advice about how an output or pipeline is configured, as opposed to what is happening to
// it: a destination another output also uses, a stream key two pipelines share, audio
// settings that do not suit the input. It is worked out here, in the browser, because only
// the dashboard shows it and its wording is the dashboard's to change; what is happening
// (the verdict) is the server's. None of it changes a status dot, and Key Vault never sees it.
//
// It is one yellow line on the output's card. The Status view and the Overview mark the
// output with a yellow outline round its dot and list the lines in its tooltip and Issues
// cell. It does not tint the card, colour the dot, or count in the pipeline list, the Status
// view, the Overview or the Problems filter. An operator may do these on purpose (a backup
// pipeline with the same destination as the primary), so they must not turn amber.

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

// The names of the other pipelines that use this pipeline's stream key: they cannot both
// publish. Empty when the key is its own.
export function otherPipelinesOnKey(
    pipelines: readonly PipelineView[],
    pipeline: PipelineView,
): string[] {
    return pipelines
        .filter((p) => p.id !== pipeline.id && p.streamKeyId === pipeline.streamKeyId)
        .map((p) => p.name);
}

// Audio settings that do not suit the input and the output's protocol.
function encodingAdvice(output: OutputView, input: InputHealth): string[] {
    if (!output.url || !input.connected) return [];
    const advice: string[] = [];
    const outIsSrt = output.url.startsWith('srt://');

    if (!input.isSrt && output.audioEncoding !== 'copy' && output.audioEncoding !== '0') {
        advice.push(
            'RTMP input only has one audio track — use copy or Track 1, not a different track selection.',
        );
    }
    if (!input.isSrt && !outIsSrt && output.audioEncoding === '0') {
        advice.push(
            'Track 1 re-encodes the audio, which costs extra CPU — use copy unless the audio must be re-encoded.',
        );
    }
    if (input.isSrt && !outIsSrt && output.audioEncoding === 'copy') {
        advice.push(
            'SRT-to-RTMP output should not use copy audio — it can cause audio jitter; select a track instead.',
        );
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
            advice.push(
                `Output selects track ${trackLabel}, but the input only has ${count} audio track${count === 1 ? '' : 's'}.`,
            );
        }
    }
    return advice;
}

// An output the server stopped after repeated failed attempts keeps its last error (the
// card's red-less line says what it was); this says what to do about it. The count is in the
// server's message ("Stopped after 5 failed attempts. Last error: ..."). A stopped output
// has no error line otherwise, so a plain stop gets none.
function stoppedAdvice(output: OutputView): string[] {
    if (output.desiredState !== 'stopped' || output.lastErrorAt === null) return [];
    const line = lastErrorLine(output);
    if (!line) return [];
    const attempts = /^Stopped after (\d+) failed attempts/.exec(line)?.[1];
    return [
        `Stopped after ${attempts ? `${attempts} attempts` : 'repeated failures'}: check the link and stream key, update the output, then start it again.`,
    ];
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
// duplicateDestinations), what to do about a stop after repeated failures, then the audio
// settings.
export function outputAdvice(
    output: OutputView,
    input: InputHealth,
    dupUrls: Map<string, DupRef[]>,
    loops: ReadonlyMap<string, string> = new Map(),
): string[] {
    const others = (output.url ? (dupUrls.get(output.url) ?? []) : []).filter(
        (ref) => ref.outputId !== output.id,
    );
    const loop = loops.get(output.id);
    return [
        ...(loop ? [loop] : []),
        ...(others.length > 0 ? [`Same destination as ${others.map(refLabel).join(', ')}`] : []),
        ...stoppedAdvice(output),
        ...encodingAdvice(output, input),
    ];
}

// Output id → its advice lines, for the outputs that have any: what the Status view and the
// Overview mark with a yellow outline and list in their tooltip and Issues cell.
export function adviceByOutput(pipelines: readonly PipelineView[]): Map<string, string[]> {
    const dupUrls = duplicateDestinations(pipelines);
    const loops = restreamLoops(pipelines);
    const byOutput = new Map<string, string[]>();
    for (const p of pipelines) {
        for (const o of p.outs) {
            const lines = outputAdvice(o, p.input, dupUrls, loops);
            if (lines.length > 0) byOutput.set(o.id, lines);
        }
    }
    return byOutput;
}
