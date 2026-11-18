'use strict';

// Dashboard fixtures with the server's verdict on them, as /api/health would carry it:
// the dashboard shows verdicts and works out nothing, so a view in a test needs one.
// It comes from the real rules (src/utils/outputStatus.ts, inputStatus.ts), so a test
// that checks what the dashboard shows for, say, a failed output still checks the rule.

const { outputHealth } = require('../../src/utils/outputStatus');
const { inputHealth } = require('../../src/utils/inputStatus');
const { isRenditionUrl } = require('../../src/utils/renditions');
const { toStatusVerdict, toOutputStatusVerdict } = require('../../public/ts/core/status');

// An input (the dashboard's InputHealth, alerts already the input's own) with its verdict.
function withInputVerdict(input) {
    return { ...input, verdict: toStatusVerdict(inputHealth(input, input.alerts ?? [])) };
}

// An output view with its verdict, for the input it is shown with. A shared encode's row
// also gets the verdict without the input, as the server sends it.
function withVerdict(view, input) {
    const verdict = outputHealth(view, input);
    if (view.url && isRenditionUrl(view.url)) {
        verdict.withoutInput = outputHealth(view, input, false);
    }
    return { ...view, verdict: toOutputStatusVerdict(verdict) };
}

// A pipeline view with the verdicts of its input, outputs and shared encodes.
function withVerdicts(pipeline) {
    const input = pipeline.input;
    return {
        ...pipeline,
        input: withInputVerdict(input),
        outs: pipeline.outs.map((o) => withVerdict(o, input)),
        renditions: (pipeline.renditions ?? []).map((r) => withVerdict(r, input)),
    };
}

module.exports = { withInputVerdict, withVerdict, withVerdicts };
