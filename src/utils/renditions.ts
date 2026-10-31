import type { Output } from '../types.js';
import { isKnownEncoding } from './ffmpeg.js';
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

// A pipeline's rows apart: the operator's own outputs, and the shared encodes (rows the
// server keeps for them). Callers that treat the two differently take each half by name
// instead of filtering the same list both ways.
export function splitOutputs<T extends Pick<Output, 'url'>>(
    rows: readonly T[],
): { outputs: T[]; sharedEncodes: T[] } {
    const outputs: T[] = [];
    const sharedEncodes: T[] = [];
    for (const row of rows) (isRenditionOutput(row) ? sharedEncodes : outputs).push(row);
    return { outputs, sharedEncodes };
}

function makeRecipe(videoEncoding: string, audioEncoding: string): Recipe {
    return { videoEncoding, audioEncoding, key: `${videoEncoding}_a${audioEncoding}` };
}

// The recipe an output needs an encode for, or null when it never goes through
// one: plain copy, multi-track selections
// (RTMP/FLV carries one audio track, so they cannot go through an internal RTMP
// stream), and the rendition rows themselves.
export function encodeRecipe(output: RecipeFields & Pick<Output, 'url'>): Recipe | null {
    if (isRenditionOutput(output)) return null;
    const { videoEncoding, audioEncoding } = output;
    // An unknown preset is built as copy by buildFfmpegArgs, so it is not an encode.
    if (!isKnownEncoding(videoEncoding)) return null;
    if (audioEncoding !== 'copy' && !/^\d+$/.test(audioEncoding)) return null;
    if (videoEncoding === 'copy' && audioEncoding === 'copy') return null;
    return makeRecipe(videoEncoding, audioEncoding);
}

// The recipe an output shares with the others of its pipeline, or null when it
// stays a direct pull of the input. Sharing only pays off when at least two
// outputs are configured with the same recipe (desired state does not matter, so
// the answer depends only on the saved configuration): a single output would just
// get one more process, a few seconds of start-up and an extra hop. `pipelineOutputs`
// is every output of the output's own pipeline, the output itself included.
export function sharedRecipe(
    output: RecipeFields & Pick<Output, 'url'>,
    pipelineOutputs: readonly (RecipeFields & Pick<Output, 'url'>)[],
): Recipe | null {
    const recipe = encodeRecipe(output);
    if (!recipe) return null;
    let configured = 0;
    for (const o of pipelineOutputs) if (encodeRecipe(o)?.key === recipe.key) configured++;
    return configured >= 2 ? recipe : null;
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

// Short, like the dashboard's output cards: only what is encoded. Video is left out
// when it is copied, audio is T<n> (T1 = track 0, as on the cards) and left out when
// it is the source audio. A recipe always has at least one of the two.
export function renditionName(recipe: Recipe): string {
    const parts: string[] = [];
    if (recipe.videoEncoding !== 'copy') parts.push(recipe.videoEncoding);
    if (recipe.audioEncoding !== 'copy') parts.push(`T${Number(recipe.audioEncoding) + 1}`);
    return `Shared encode ${parts.join(' · ')}`;
}
