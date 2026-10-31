// Twins of the helpers in src/utils/renditions.ts (the dashboard cannot import
// backend code). test/renditions.test.js runs both on the same inputs and asserts
// they agree, so change them together.
const RENDITION_URL_RE = /^rtmp:\/\/127\.0\.0\.1:\d+\/internal\/r\d+_[a-z0-9_]+_a[a-z0-9]+$/;

export function isRenditionUrl(url: string): boolean {
    return RENDITION_URL_RE.test(url);
}

// The recipe key of a rendition row, or of a user output that shares one
// (sharedRecipe in the backend): `<video>_a<audio>`. `encodings` is the server's
// list of video presets (ConfigData.encodings); an unknown preset is built as
// copy, so it is not an encode.
export function sharedRecipeKey(
    output: { url: string; videoEncoding: string; audioEncoding: string },
    encodings: readonly string[],
): string | null {
    if (isRenditionUrl(output.url)) return null;
    const { videoEncoding, audioEncoding } = output;
    if (!encodings.includes(videoEncoding)) return null;
    if (audioEncoding !== 'copy' && !/^\d+$/.test(audioEncoding)) return null;
    if (videoEncoding === 'copy' && audioEncoding === 'copy') return null;
    return `${videoEncoding}_a${audioEncoding}`;
}

export function renditionKey(rendition: { videoEncoding: string; audioEncoding: string }): string {
    return `${rendition.videoEncoding}_a${rendition.audioEncoding}`;
}

// The dashboard's own, with no backend twin: the encode as the Overview names it,
// "720p · T2", the video unless it is copy and the audio track as T<n> (T1 is track 0).
export function sharedEncodeLabel(rendition: {
    videoEncoding: string;
    audioEncoding: string;
}): string {
    const parts: string[] = [];
    if (rendition.videoEncoding !== 'copy') parts.push(rendition.videoEncoding);
    if (rendition.audioEncoding !== 'copy') parts.push(`T${parseInt(rendition.audioEncoding) + 1}`);
    return parts.join(' · ');
}
