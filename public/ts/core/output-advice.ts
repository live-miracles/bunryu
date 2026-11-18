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

// The advice for one output, one line each: the other outputs with the same destination
// (`dupUrls` is duplicateDestinations), then the audio settings.
export function outputAdvice(
    output: OutputView,
    input: InputHealth,
    dupUrls: Map<string, DupRef[]>,
): Advice[] {
    const others = (output.url ? (dupUrls.get(output.url) ?? []) : []).filter(
        (ref) => ref.outputId !== output.id,
    );
    return [
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
): string[] {
    return outputAdvice(output, input, dupUrls)
        .filter((a) => a.level === 'mistake')
        .map((a) => a.message);
}
