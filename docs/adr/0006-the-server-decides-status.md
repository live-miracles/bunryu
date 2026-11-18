# The server decides the status of an input or output; the dashboard shows it

Status: accepted, 2026-11-18

The status of an input or output (its verdict: good, warn, error or off, and the problems behind it) was worked out in the dashboard, and again on the server for Key Vault, with tests that ran both copies over every combination of state. It is now worked out once, on the server (`src/utils/healthVerdicts.ts`), and sent in `/api/health` as `verdicts`; the dashboard reads it and has no rules of its own.

The server cannot import the dashboard's code (the two builds have different `rootDir`s and the dashboard's code touches the DOM), so "share one source file" needs a build change that moves the backend to `dist/src/index.js`, which the start script, the systemd unit and the Docker entrypoint all name. Sharing the verdict function would also have left the other twin: the dashboard and the server each assemble an output's view from the config and health data. Moving the verdict to the server removes both and costs the dashboard nothing, because the verdicts are worked out when `/api/health` is asked for.

Consequences: a change to a status rule is made in one place (`outputStatus.ts` or `inputStatus.ts`) and tested there, and the dashboard and Key Vault cannot disagree. A verdict that cannot be worked out is `warn` and logged, never a failed response. A dashboard tab left open across an upgrade shows each status as unknown until it is reloaded. The advisory warnings of the Problems filter and the relay path's verdict are still worked out in the browser; moving them is the next step if another client needs them.

Why and what was measured: [The server decides the status of an input or output](../4-reference/3-design-decisions.md#the-server-decides-the-status-of-an-input-or-output-the-dashboard-shows-it).
