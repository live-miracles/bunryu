// Dashboard fixtures with the server's verdict on them, as /api/health would carry it:
// the dashboard shows verdicts and works out nothing, so a view in a test needs one.
// It comes from the real rules (src/utils/outputStatus.ts, inputStatus.ts), so a test
// that checks what the dashboard shows for, say, a failed output still checks the rule.

import { outputHealth } from '../../src/utils/outputStatus';
import type { OutputStatusView } from '../../src/utils/outputStatus';
import { inputHealth } from '../../src/utils/inputStatus';
import type { InputStatusEntry } from '../../src/utils/inputStatus';
import type { OutputVerdict } from '../../src/utils/healthVerdicts';
import { isRenditionUrl } from '../../src/utils/renditions';
import { toStatusVerdict, toOutputStatusVerdict } from '../../public/ts/core/status';
import type { OutputStatusVerdict, PipelineAlert, StatusVerdict } from '../../public/ts/types';

// The fixtures are partial on purpose (a test sets only what it checks), so the
// parameters take any object whose fields the rules read, with the right types.
type InputFixture = Partial<InputStatusEntry> & { alerts?: readonly PipelineAlert[] };
type OutputFixture = Partial<OutputStatusView>;

// An input (the dashboard's InputHealth, alerts already the input's own) with its verdict.
export function withInputVerdict<T extends InputFixture>(input: T): T & { verdict: StatusVerdict } {
    return {
        ...input,
        verdict: toStatusVerdict(inputHealth(input as InputStatusEntry, input.alerts ?? [])),
    };
}

// An output view with its verdict, for the input it is shown with. A shared encode's row
// also gets the verdict without the input, as the server sends it.
export function withVerdict<T extends OutputFixture>(
    view: T,
    input: { live?: boolean },
): T & { verdict: OutputStatusVerdict } {
    const rulesView = view as OutputStatusView;
    const rulesInput = input as { live: boolean };
    const verdict: OutputVerdict = outputHealth(rulesView, rulesInput);
    if (view.url && isRenditionUrl(view.url)) {
        verdict.withoutInput = outputHealth(rulesView, rulesInput, false);
    }
    return { ...view, verdict: toOutputStatusVerdict(verdict) };
}

// A pipeline view with the verdicts of its input, outputs and shared encodes.
export function withVerdicts<
    T extends {
        input: InputFixture & { live?: boolean };
        outs: OutputFixture[];
        renditions?: OutputFixture[];
    },
>(
    pipeline: T,
): Omit<T, 'input' | 'outs' | 'renditions'> & {
    input: T['input'] & { verdict: StatusVerdict };
    outs: Array<T['outs'][number] & { verdict: OutputStatusVerdict }>;
    renditions: Array<NonNullable<T['renditions']>[number] & { verdict: OutputStatusVerdict }>;
} {
    const input = pipeline.input;
    return {
        ...pipeline,
        input: withInputVerdict(input),
        outs: pipeline.outs.map((o) => withVerdict(o, input)),
        renditions: (pipeline.renditions ?? []).map((r) => withVerdict(r, input)),
    } as ReturnType<typeof withVerdicts<T>>;
}
