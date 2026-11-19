import { isDestinationUrl } from './destination.js';

// What the Copy / Paste buttons put on the clipboard and read back: a JSON array of outputs
// for a whole pipeline, or one object (or a bare destination URL) for the open output form.
// Each parser returns the outputs or the message to show the operator.

export interface OutputPayloadFields {
    name: string;
    videoEncoding: string;
    url: string;
    audioEncoding: string;
}

// A single output pasted into the open form can omit name/videoEncoding/audioEncoding and
// leave those fields untouched; only the destination url is meaningless to default.
export interface OutputPastePayload {
    name?: string;
    videoEncoding?: string;
    url: string;
    audioEncoding?: string;
}

function parseOutputItem(item: unknown): OutputPayloadFields | { error: string } {
    if (!item || typeof item !== 'object') return { error: 'Invalid output format in clipboard.' };
    const { name, videoEncoding, url, audioEncoding } = item as Record<string, unknown>;
    if (typeof name !== 'string' || !name.trim()) {
        return { error: 'Each output must have a non-empty name.' };
    }
    if (typeof videoEncoding !== 'string') {
        return { error: 'Each output must have a videoEncoding.' };
    }
    if (typeof url !== 'string' || !url.trim()) {
        return { error: 'Each output must have a non-empty url.' };
    }
    if (typeof audioEncoding !== 'string') {
        return { error: 'Each output must have an audioEncoding.' };
    }
    return { name: name.trim(), videoEncoding, url, audioEncoding };
}

// The bulk paste-all-outputs flow: every output being created needs an explicit
// name and encoding.
export function parseOutputsPayload(
    text: string,
): { outputs: OutputPayloadFields[] } | { error: string } {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return { error: 'Clipboard content is not valid JSON.' };
    }
    if (!Array.isArray(parsed)) return { error: 'Expected a JSON array of outputs.' };
    const outputs: OutputPayloadFields[] = [];
    for (const item of parsed) {
        const output = parseOutputItem(item);
        if ('error' in output) return output;
        outputs.push(output);
    }
    if (outputs.length === 0) return { error: 'No outputs found in clipboard.' };
    return { outputs };
}

// Pasting appends to the pipeline's outputs. An output whose destination one of them already
// has is left out, and so is a later pasted output with the same destination as an earlier
// one, so a paste never creates a duplicate.
export function splitNewOutputs(
    existingUrls: Iterable<string>,
    pasted: OutputPayloadFields[],
): { fresh: OutputPayloadFields[]; skipped: OutputPayloadFields[] } {
    const seen = new Set([...existingUrls].map((url) => url.trim()));
    const fresh: OutputPayloadFields[] = [];
    const skipped: OutputPayloadFields[] = [];
    for (const output of pasted) {
        const url = output.url.trim();
        if (seen.has(url)) {
            skipped.push(output);
        } else {
            seen.add(url);
            fresh.push(output);
        }
    }
    return { fresh, skipped };
}

// What the operator is told once a paste is done.
export function pasteResultMessage(added: number, skipped: number): string {
    const outputs = (n: number) => `${n} output${n === 1 ? '' : 's'}`;
    if (added === 0) {
        return skipped === 1
            ? 'Nothing pasted: the output has a destination this pipeline already uses.'
            : `Nothing pasted: all ${skipped} outputs have a destination this pipeline already uses.`;
    }
    return skipped === 0
        ? `Pasted ${outputs(added)}.`
        : `Pasted ${outputs(added)}, skipped ${skipped} with a destination this pipeline already uses.`;
}

// A bare RTMP/RTMPS/SRT URL on the clipboard is shorthand for {"url": "..."}.
export function parseSingleOutputPayload(
    text: string,
): { output: OutputPastePayload } | { error: string } {
    const trimmed = text.trim();
    let parsed: unknown;
    if (isDestinationUrl(trimmed)) {
        parsed = { url: trimmed };
    } else {
        try {
            parsed = JSON.parse(text);
        } catch {
            return { error: 'Clipboard content is not valid JSON.' };
        }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { error: 'Expected a single output object, not a list.' };
    }
    const { name, videoEncoding, url, audioEncoding } = parsed as Record<string, unknown>;
    if (typeof url !== 'string' || !url.trim()) {
        return { error: 'Clipboard JSON must include a non-empty url.' };
    }
    return {
        output: {
            name: typeof name === 'string' && name.trim() ? name.trim() : undefined,
            videoEncoding:
                typeof videoEncoding === 'string' && videoEncoding ? videoEncoding : undefined,
            url,
            audioEncoding:
                typeof audioEncoding === 'string' && audioEncoding ? audioEncoding : undefined,
        },
    };
}
