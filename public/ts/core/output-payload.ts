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
