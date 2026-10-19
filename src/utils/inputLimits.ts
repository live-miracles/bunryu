// Bounds on operator-supplied text and counts. The dashboard escapes everything it
// renders, but the API is the trust boundary: nothing downstream (database,
// diagnostics, FFmpeg argv, every connected dashboard's 5s poll) should have to
// cope with a megabyte-long name, markup in a destination, or a billion tracks.

export const MAX_NAME_LENGTH = 80;
export const MAX_URL_LENGTH = 2048;
export const MAX_PUBLIC_HOST_LENGTH = 253;
// Highest audio track index/count the dashboard offers (MAX_AUDIO_TRACKS there).
export const MAX_AUDIO_TRACKS = 50;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

// Returns the trimmed name, or an error message. Names are display labels:
// no control characters (they forge log lines), bounded length.
export function parseName(value: unknown, field = 'name'): { name: string } | { error: string } {
    if (typeof value !== 'string') return { error: `${field} is required` };
    const name = value.trim();
    if (!name) return { error: `${field} is required` };
    if (name.length > MAX_NAME_LENGTH) {
        return { error: `${field} must be at most ${MAX_NAME_LENGTH} characters` };
    }
    if (CONTROL_CHARS.test(name)) return { error: `${field} contains control characters` };
    return { name };
}

// A destination URL must be one line of plain URL text. Markup characters and
// whitespace are never valid in rtmp/srt URLs and are exactly what a stored
// injection needs, so they are refused outright (the dashboard also escapes).
export function isCleanUrlText(url: string): boolean {
    return url.length <= MAX_URL_LENGTH && !CONTROL_CHARS.test(url) && !/[\s<>"]/.test(url);
}

export function isValidPublicHost(host: string): boolean {
    return host.length <= MAX_PUBLIC_HOST_LENGTH && /^[A-Za-z0-9._:\-[\]]+$/.test(host);
}
