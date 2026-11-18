import type { Output, Pipeline } from '../types.js';
import {
    buildOutputViews,
    outputHealth,
    outputsByPipeline,
    type OutStatus,
    type OutputHealthEntry,
} from './outputStatus.js';
import {
    inputHealth,
    toInputStatusEntry,
    type InputStatus,
    type InputStatusEntry,
} from './inputStatus.js';
import { isRenditionUrl } from './renditions.js';
import type { PipelineAlert } from './srtLinkAlerts.js';

// The verdict on every input and output: its status and the problems behind it, worked
// out here, once, for everything that shows or reports it (the dashboard through
// /api/health, the Key Vault report). The rules are in outputStatus.ts and inputStatus.ts.

export interface VerdictIssue {
    severity: 'warning' | 'error';
    message: string;
    // An input alert's code and start, so the dashboard can add its hint and age.
    code?: string;
    sinceMs?: number;
}

export interface Verdict<S extends string> {
    status: S;
    issues: VerdictIssue[];
}

export type InputVerdict = Verdict<InputStatus>;

// A shared encode's row also has `withoutInput`: its own state without "the input is not
// live", which its two-half status dot shows on the input's side. Other outputs have none.
export type OutputVerdict = Verdict<OutStatus> & { withoutInput?: Verdict<OutStatus> };

export interface HealthVerdicts {
    // By pipeline id.
    inputs: Record<string, InputVerdict>;
    // By output id, shared-encode rows included.
    outputs: Record<string, OutputVerdict>;
}

// The part of a health snapshot's per-pipeline entry that decides the verdicts.
export type PipelineStatusHealth = {
    input: Partial<InputStatusEntry> & { live: boolean };
    outputs: Record<string, OutputHealthEntry>;
    alerts?: readonly PipelineAlert[];
};

export interface VerdictSource {
    pipelines: readonly Pipeline[];
    outputs: readonly Output[];
    // By pipeline id. A pipeline, or one of its outputs, that the last poll has not seen
    // yet is not in it; it gets the verdict of something not connected or not running.
    health: Record<string, PipelineStatusHealth | undefined>;
}

// What a verdict is when it could not be worked out: neither fine nor failed, and it
// says so, instead of taking the poll or the page down with it.
export const UNKNOWN_VERDICT: Readonly<Verdict<'warn'>> = {
    status: 'warn',
    issues: [{ severity: 'warning', message: 'The status could not be worked out.' }],
};

const unknown = (): Verdict<'warn'> => ({ status: 'warn', issues: [...UNKNOWN_VERDICT.issues] });

// A verdict for every pipeline and every output in `source`. One that cannot be worked
// out (malformed data) gets UNKNOWN_VERDICT and is passed to `onError`; the others are
// not affected.
export function buildHealthVerdicts(
    source: VerdictSource,
    onError: (what: 'input' | 'output', id: string, err: unknown) => void = () => {},
): HealthVerdicts {
    const outputsOf = outputsByPipeline(source.outputs);
    const verdicts: HealthVerdicts = { inputs: {}, outputs: {} };

    for (const pipeline of source.pipelines) {
        const health = source.health[String(pipeline.id)];
        const outputs = outputsOf.get(pipeline.id) ?? [];
        const input = { live: health?.input.live ?? false };

        try {
            verdicts.inputs[pipeline.id] = inputHealth(
                toInputStatusEntry(health?.input),
                health?.alerts ?? [],
            );
        } catch (err) {
            onError('input', String(pipeline.id), err);
            verdicts.inputs[pipeline.id] = unknown();
        }

        let views;
        try {
            views = buildOutputViews(outputs, health?.outputs);
        } catch (err) {
            // The pipeline's outputs could not even be read: each is unknown.
            for (const output of outputs) {
                onError('output', output.id, err);
                verdicts.outputs[output.id] = unknown();
            }
            continue;
        }
        for (const view of views) {
            try {
                const verdict: OutputVerdict = outputHealth(view, input);
                if (isRenditionUrl(view.url))
                    verdict.withoutInput = outputHealth(view, input, false);
                verdicts.outputs[view.id] = verdict;
            } catch (err) {
                onError('output', view.id, err);
                verdicts.outputs[view.id] = unknown();
            }
        }
    }
    return verdicts;
}
