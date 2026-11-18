import {
    buildDestinationUrl,
    detectServer,
    sanitizedDestinationFor,
    type DestinationChoice,
    type RestreamTarget,
    type ServerId,
} from './destination.js';
import { srtUrlFromForm, type SrtFormField, type SrtFormValues } from './srt.js';

// The output form's rules without the DOM: what it shows when it opens (an empty form
// prefilled from the pipeline's last output, or a saved output), whether a saved output can
// be edited, and what Save sends or which fields are wrong. `features/editor.ts` reads the
// fields into `OutputFormValues`, applies what comes back and does the requests.

// The part of a saved output the form reads.
export interface FormOutput {
    name: string;
    videoEncoding: string;
    url: string;
    audioEncoding: string;
    desiredState?: 'running' | 'stopped';
}

// A running output keeps the destination and encoding its ffmpeg was started with, so only
// its name can change (the server enforces the same rule).
export function outputLocked(saved: Pick<FormOutput, 'desiredState'> | undefined): boolean {
    return saved?.desiredState === 'running';
}

export interface OutputFormInit {
    mode: 'add' | 'edit';
    name: string;
    videoEncoding: string;
    destination: DestinationChoice;
    audioEncoding: string;
    locked: boolean;
    // Only a saved output can be copied.
    canCopy: boolean;
}

// A new output starts from the pipeline's most recently added one, so repeat destinations
// (same server and encoding) are not entered from scratch each time. The per-stream
// identifier (RTMP stream key, SRT stream ID, Restream target) is left blank, since it is
// almost never meant to be reused.
export function addOutputForm(
    pipelineOutputs: readonly FormOutput[],
    targets: RestreamTarget[],
): OutputFormInit {
    const previous = pipelineOutputs.at(-1) ?? null;
    return {
        mode: 'add',
        name: `Output ${pipelineOutputs.length + 1}`,
        videoEncoding: previous?.videoEncoding ?? 'copy',
        destination: previous
            ? sanitizedDestinationFor(previous.url, targets)
            : { server: 'custom-rtmp', key: '' },
        audioEncoding: previous?.audioEncoding ?? 'copy',
        locked: false,
        canCopy: false,
    };
}

export function editOutputForm(saved: FormOutput, targets: RestreamTarget[]): OutputFormInit {
    return {
        mode: 'edit',
        name: saved.name,
        videoEncoding: saved.videoEncoding,
        destination: destinationOf(saved.url, targets),
        audioEncoding: saved.audioEncoding,
        locked: outputLocked(saved),
        canCopy: true,
    };
}

// The preset and value the destination fields show for a URL (an empty one is a blank
// Custom RTMP).
export function destinationOf(url: string | null | undefined, targets: RestreamTarget[]) {
    return url ? detectServer(url, targets) : { server: 'custom-rtmp' as const, key: '' };
}

// What the form holds when Save is pressed: the raw text of each field.
export interface OutputFormValues {
    name: string;
    videoEncoding: string;
    audioEncoding: string;
    server: ServerId;
    // The destination row; null when the form has none. `srt` holds the Custom SRT fields
    // (null when they are missing from the row).
    destination: { key: string; srt: SrtFormValues | null } | null;
}

// The fields to mark as wrong. `key` is the preset's value field (a key, a URL or the
// Restream pipeline), `srt` the Custom SRT fields.
export interface OutputFormInvalid {
    name: boolean;
    key: boolean;
    srt: SrtFormField[];
}

export type OutputSubmission =
    | {
          ok: true;
          body:
              | { name: string }
              | { name: string; videoEncoding: string; url: string; audioEncoding: string };
      }
    | { ok: false; invalid: OutputFormInvalid };

// `saved` is the output being edited, undefined for a new one.
export function submitOutputForm(
    values: OutputFormValues,
    saved: Pick<FormOutput, 'desiredState'> | undefined,
    targets: RestreamTarget[],
): OutputSubmission {
    const name = values.name.trim();
    const invalid: OutputFormInvalid = { name: !name, key: false, srt: [] };

    // The settings of a running output are locked in the form: only the name is sent.
    if (outputLocked(saved)) {
        return name ? { ok: true, body: { name } } : { ok: false, invalid };
    }

    const row = values.destination;
    let url: string | null = null;
    if (row) {
        if (values.server === 'custom-srt') {
            if (row.srt) {
                const built = srtUrlFromForm(row.srt);
                if ('url' in built) url = built.url;
                else invalid.srt = built.invalid;
            }
        } else {
            const built = buildDestinationUrl(values.server, row.key.trim(), targets);
            if ('url' in built) url = built.url;
            else invalid.key = true;
        }
    }

    if (!name || url === null) return { ok: false, invalid };
    return {
        ok: true,
        body: {
            name,
            videoEncoding: values.videoEncoding,
            url,
            audioEncoding: values.audioEncoding,
        },
    };
}
