import type { Output } from '../types.js';
import { ENCODINGS } from './ffmpeg.js';
import { readSrsConfigValues } from './srsConfig.js';

// Shared renditions: outputs of one pipeline that need the same encode (the same
// video preset plus the same single audio track) share one upstream FFmpeg, the
// rendition. A rendition is an ordinary output row recognised by its URL (an RTMP
// stream in SRS's reserved "internal" app on loopback); the sharing outputs pull
// that stream in copy mode.

export const RENDITION_APP = 'internal';

export interface Recipe {
    videoEncoding: string;
    audioEncoding: string;
    key: string;
}

type RecipeFields = Pick<Output, 'videoEncoding' | 'audioEncoding'>;

// Keep in step with RENDITION_URL_RE in public/ts/core/renditions.ts.
const RENDITION_STREAM_RE = /^r\d+_[a-z0-9_]+_a[a-z0-9]+$/;
const RENDITION_URL_RE = /^rtmp:\/\/127\.0\.0\.1:\d+\/internal\/r\d+_[a-z0-9_]+_a[a-z0-9]+$/;

export function isRenditionUrl(url: string): boolean {
    return RENDITION_URL_RE.test(url);
}

export function isRenditionOutput(output: Pick<Output, 'url'>): boolean {
    return isRenditionUrl(output.url);
}

function makeRecipe(videoEncoding: string, audioEncoding: string): Recipe {
    return { videoEncoding, audioEncoding, key: `${videoEncoding}_a${audioEncoding}` };
}

// The recipe a user output shares with its siblings, or null when it stays a
// direct pull of the input: plain copy, translation (owned by the mixer),
// multi-track selections (RTMP/FLV carries one audio track, so they cannot go
// through an internal RTMP stream), and the rendition rows themselves.
export function sharedRecipe(output: RecipeFields & Pick<Output, 'url'>): Recipe | null {
    if (isRenditionOutput(output)) return null;
    const { videoEncoding, audioEncoding } = output;
    // An unknown preset is built as copy by buildFfmpegArgs, so it is not an encode.
    if (!Object.hasOwn(ENCODINGS, videoEncoding)) return null;
    if (audioEncoding !== 'copy' && !/^\d+$/.test(audioEncoding)) return null;
    if (videoEncoding === 'copy' && audioEncoding === 'copy') return null;
    return makeRecipe(videoEncoding, audioEncoding);
}

export function recipeOfRendition(output: RecipeFields): Recipe {
    return makeRecipe(output.videoEncoding, output.audioEncoding);
}

export function renditionStreamName(pipelineId: number, recipe: Recipe): string {
    const name = `r${pipelineId}_${recipe.key}`;
    if (!RENDITION_STREAM_RE.test(name)) throw new Error(`Invalid rendition stream name: ${name}`);
    return name;
}

// Used both as the rendition's publish URL and as the sharing outputs' pull URL.
export function renditionUrl(pipelineId: number, recipe: Recipe): string {
    const { rtmpHost, rtmpPort } = readSrsConfigValues();
    return `rtmp://${rtmpHost}:${rtmpPort}/${RENDITION_APP}/${renditionStreamName(pipelineId, recipe)}`;
}

export function renditionName(recipe: Recipe): string {
    const video =
        recipe.videoEncoding === 'copy' ? 'copy video' : recipe.videoEncoding.replaceAll('_', ' ');
    const audio =
        recipe.audioEncoding === 'copy' ? 'source audio' : `track ${recipe.audioEncoding}`;
    return `Shared encode ${video} · ${audio}`;
}
