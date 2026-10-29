# Agent Guide

## Project overview

Bunryu is a Linux streaming-forwarding server. It accepts live inputs
over RTMP and SRT, manages them as pipelines, and forwards each pipeline to
multiple RTMP and/or SRT destinations.

The system is built around:

- SRS for RTMP/SRT ingest and publish authorization hooks.
- `goryu` for bonded SRT ingress.
- A Node.js + TypeScript control plane with a REST API and dashboard.
- FFmpeg processes for output forwarding, previews, media probing, and
  optional audio/video processing.
- SQLite for persistent pipelines, outputs, stream keys, and settings.

The application also supports simple output encoding profiles, including
passthrough/copy mode, video transcoding profiles such as 720p and 1080p,
vertical rotation, and configurable audio processing. The video transcoding
profiles (`720p`, `1080p`, `vertical_rotate`) are low priority: they are kept just
in case and are rarely used, so don't spend effort extending or optimizing them or
use them in examples; copy mode and audio track selection are the common cases.
When they are used, `720p` down-converts a 1080p input, `1080p` down-converts a 4K
input and `vertical_rotate` is applied to a 1080p input, so measure and document
them with those inputs.

## Intended capacity

These are the recommended operating ceilings described in
`docs/1-getting-started/1-introduction.md`,
not targets to exceed. None is enforced in code: the operator sizes the host, and
only the stream key count (`stream_key_count` in `bunryu.json`, default 100) bounds
the number of inputs:

| Resource | Intended maximum |
|---|---:|
| Input pipelines | 50 |
| Output forwards | 500 total (shared encodes are not counted) |
| Distinct concurrent custom/transcoding encodes | A few at a time |
| Concurrent dashboard clients | Approximately 10 |

Most outputs should use `copy` mode. Copy-mode outputs are comparatively cheap,
while custom video encoding is expensive on a GCP `n2` with the 50 fps production
feeds: about 2 vCPUs for `720p` and 1.2 for `vertical_rotate` from a 1080p input,
and `1080p` from a 4K input needs about 6 and does not keep up on 4 (see
`docs/1-getting-started/4-sizing.md`). Outputs of one pipeline with the same
video encoding and single audio track share one encode.
Host CPU, memory, network capacity, and the number of FFmpeg processes are
expected to become limiting factors before the API or dashboard at the upper
end of the supported envelope.

Do not raise these figures or add resource-intensive defaults without
considering the effect on all active pipelines, copy outputs, the dashboard,
and the control plane.

## Highest priority: stability and reliability

Reliability is the primary product requirement. Changes should preserve a
server that can run continuously through long live events and should favor
safe degradation over a broad feature set.

In particular:

- The server and its managed processes must not crash because one input,
  output, FFmpeg process, malformed request, or external service misbehaves.
- A failed or stalled output should be isolated and recovered automatically
  where safe; it must not take down unrelated pipelines or outputs.
- Service restarts and machine reboots should recover into a usable state
  without manual intervention. Preserve persistent configuration and make
  startup ordering explicit.
- Readiness must be distinguished from liveness. Do not allow SRS to accept
  publishes before the control plane and its required hooks are ready.
- Watchdogs, retry loops, and automatic restarts must be bounded and
  observable. Avoid restart storms, tight polling loops, and unbounded process
  or memory growth.
- Output and input state should remain accurate across disconnects, crashes,
  restarts, and reconnects. Do not leave stale running state in the database
  or dashboard.

## Diagnostics and logging

Every failure or recovery path should leave enough evidence to explain what
happened after the incident. When adding or changing behavior:

- Emit structured, timestamped diagnostics for process starts, exits,
  restarts, input/output transitions, SRS and relay transitions, watchdog
  actions, and important media or timestamp warnings.
- Include useful context such as pipeline/output identifiers, exit status,
  reason, relevant configuration or threshold, and the final FFmpeg stderr
  tail when available. Logs are private, so they are not redacted: stream
  keys, destination URLs and passphrases may appear in them (see the
  pre-commit rule on never committing them).
- Bound the volume of any warning that can repeat per packet or per frame
  (FFmpeg timestamp warnings are grouped per output into first-of-kind events,
  periodic summaries and a recovery event; a pipeline alert covers faults
  shared by several outputs). Count every suppressed line so totals stay exact.
- Keep normal-operation logs useful and avoid treating known benign disconnect
  noise as an incident. Document unavoidable upstream noise and filter or
  classify it where appropriate.
- Preserve enough history for post-incident investigation. Production uses
  journald plus rotated diagnostics under
  `/var/lib/bunryu/diagnostics/`; respect retention and size caps.
- Do not silently swallow errors. If an error is intentionally tolerated,
  record the decision and the resulting degraded state.

## Operational boundaries

The production deployment uses three systemd services: SRS, the shared Goryu
relay, and the Node.js dashboard/API. The Docker image runs the same
three processes in one container for evaluation. Keep service boundaries and
loopback-only internal endpoints intact. Public ingest is provided through
RTMP/SRT ports; internal SRS and relay status APIs should not be exposed.

Changes to process supervision, startup, shutdown, watchdog behavior,
configuration, or diagnostics are high-risk and should be tested for:

- clean startup and readiness ordering;
- input disconnect and reconnect;
- output failure, stall, OOM, and restart;
- simultaneous pipelines and many copy-mode outputs;
- service restart and host reboot recovery; and
- useful logs and state after each failure.

`scripts/test-stack.sh` starts an isolated local stack (own SRS, control plane
and fresh database, with a fake output ffmpeg that can emit an FFmpeg
timestamp-discontinuity flood) that does not touch a developer's own
`npm run dev`; use it to exercise these paths and the dashboard end to end.
`scripts/test-faults.mjs` runs fault scenarios on it with real destinations (a frozen
one, one that never reads, one that refuses connections, output churn, a publisher
outage, an SRS crash, SRT destinations that fail, a CPU-saturated host, and a soak with 50 healthy outputs).
`skills/run-bunryu/SKILL.md` documents both.

Prefer small, reversible changes.

**Documentation is part of every change.** When you add a feature or change
behavior, architecture, capacity, supported protocols or operational guarantees,
find every doc page that describes it and update it in the same change. Search
`docs/` and `README.md` for the feature's name, and check these places:

- **`docs/2-usage/`** for what users see and do: publishing, outputs, preview.
- **`docs/3-operations/`**:
  - security, configuration (`bunryu.json` keys), reliability (watchdogs and
    recovery);
  - known issues: add workarounds, and remove entries that no longer apply.
- **`docs/4-reference/1-api.md`** for any added or changed route, request body or
  response.
- **`docs/4-reference/3-design-decisions.md`** when you choose or reject an
  approach, a component or an upstream feature. Record the decision, the reasons,
  the evidence (measurements, test results), and when to revisit it.
- **`docs/1-getting-started/`**:
  - the introduction for capacity limits or the architecture diagram, and
    `4-sizing.md` for measured CPU/RAM costs and example machine sizes;
  - install and Docker for install steps or pinned components.
- **`README.md`** only when the pitch, feature list or install steps change.
- **This guide's code map** when you add a module or a code map entry goes stale.

Remove or correct text that the change makes wrong; don't just append. A stale
statement is worse than a missing one.

**Keep the docs lean.** They have two audiences and nothing else:

- **Users** learning what the app does and how to use it. Say what a feature is
  and the steps to use it; leave out implementation detail.
- **Developers** learning why the system is the way it is. Record the real
  problem we hit and why a watchdog, parameter, threshold or alert exists, backed
  by data (an incident, a measurement, a test showing the case it catches and the
  failure it prevents). That goes in `docs/4-reference/3-design-decisions.md` and
  the reliability and sizing pages. A parameter or alert with no recorded reason
  gets removed or questioned later.

Don't add changelog-style narration, speculative options, repeated explanations
or text that restates the code. Say each thing once, in the page it belongs to,
and link to it from elsewhere.

CI fails on a broken relative link or anchor in `README.md` or `docs/`, and on a
docs page that `docs/README.md` does not link to. The checker is
`scripts/check-docs.js` in the org site repository (`live-miracles.github.io`);
with a sibling checkout, run `node ../live-miracles.github.io/scripts/check-docs.js .`
before committing doc changes.

## Code map

Navigation only; correct an entry when a change makes it stale, and add one
only for a new module.

- `src/index.ts` - app bootstrap: middleware, auth gate, route registration,
  service wiring, graceful shutdown.
- `src/services/outputs.ts` - one FFmpeg process per output: start/stop/retry,
  stall/socket/memory watchdogs (a socket or stall restart first reads the input's
  SRS stream into the History and event), timestamp-warning bursts and warning
  episodes, output History writes (including a manual Start); shared-encode readiness, dependents' restart on a
  rendition failure and `restart()`. `outputSockets.ts` parses `ss` for
  destination socket health.
- `src/services/renditions.ts` - the shared-encode reconciler (1 s tick): creates
  and removes the rendition output rows, starts them with their first running
  output and idle-stops them after 15 s. `src/utils/renditions.ts` has the recipe
  rules (`encodeRecipe`, and `sharedRecipe`, which also needs two outputs with the
  recipe), naming and URL recognition; the dashboard twins are in
  `public/ts/core/renditions.ts`.
- `src/services/health.ts` - the 5 s poll behind `/api/health`: SRS and relay
  state, input live/media state (`probeScheduler.ts` owns each publisher's ffprobe
  lifecycle: when to probe, the retries, the once-per-publisher keyframe check, and
  cancelling it all when the publisher changes, with `mediaProbe.ts` as the runner and
  parser; health restarts running outputs when a new publisher's probed format differs
  from the last one), alerts, the per-minute diagnostics snapshot. `inputState.ts` holds per-input
  readiness/protocol and builds the pull URL outputs read. `utils/srtRecent.ts` keeps
  the 10-minute rolling SRT loss/retransmit/drop counts behind `recent` in the health
  payload; `utils/relayErrorLog.ts` turns Goryu's per-stream `lastError` into merged
  pipeline-log lines.
- `src/services/srtRelay.ts` (relay status; a plain SRT input is presented as one link), `preview.ts`
  (HLS previews with a keepalive TTL),
  `rejectedPublishes.ts`.
- `src/api/*` - REST routes; `errors.ts` is the JSON error handler (also on the hook app). `srs.ts` has the SRS `on_publish`/`on_play` hooks
  and journal log tails; `auth.ts` login/sessions.
- `src/utils/ffmpeg.ts` builds FFmpeg arguments and the minimal environment every
  FFmpeg/ffprobe child gets (`ffmpegEnv`); `ffmpegCheck.ts` is the startup check of the
  build's protocols, encoders and filters; `appConfig.ts` reads
  `bunryu.json` (watchdog defaults; path overridden by `BUNRYU_CONFIG`, which the installed unit sets to `/etc/bunryu/bunryu.json`); `configCheck.ts` / `startupGate.ts` read
  the three config files first thing at startup and exit 78 if one is missing or invalid; `srtPassphrase.ts` generates a new SRT passphrase and writes it to `srs.conf` and `goryu.json` (Settings reset); `diagnostics.ts` is the rotated JSONL
  writer and the loop failure reporter; `srs*.ts`/`relayConfig.ts` generate and
  read SRS and relay config.
- `src/db/` - SQLite schema and access (output History lives in
  `outputs.last_error` as JSON).
- `public/ts/` - dashboard TypeScript, compiled to untracked `public/js/`.
  `core/pipeline.ts` splits shared-encode rows out of `PipelineView.outs` into
  `renditions` and decides which pipeline alerts belong to the input (`INPUT_ALERT_CODES`);
  `features/shared-encodes.ts` renders the Shared encodes card.
  `core/publish-modes.ts` has the Publish card's modes (which one the live input is on) and
  its rows, with the secrets masked.
  `core/media-spec.ts` formats the one-line video/audio descriptions the Overview
  and the pipeline panel's input stats share.
  `core/audio-meter.ts` has the preview meter's level maths (peak dBFS, release
  fall-off), ported from live-gallery.
  `core/outputs-filter.ts` has the Outputs list's filter, "Problems" test and summary
  counts (`outputSeverity` in `features/output-card.ts` says what counts as a problem);
  `core/alert-sound.ts` decides which changes between polls beep;
  `features/sound-alerts.ts` is the navbar bell and volume and plays the beeps.
  `features/status-tooltip.ts` is the hover text and gradient of every two-half
  status dot (pipeline list, relay card, shared encode row).
  `core/hints.ts` maps known FFmpeg errors, warnings and alert codes to the
  one-line "Hint:" advice under them.
- `test/*.test.js` unit tests and `test/integration/` API tests (`npm test`).
- `Dockerfile`, `compose.yaml`, `docker/entrypoint.sh` - single-container image
  for evaluation; the entrypoint supervises the app, SRS and the relay with the
  same readiness ordering as the systemd units. Media binary pins mirror
  `scripts/server-install.sh`; bump both together. `docker/README.dockerhub.md`
  is the Docker Hub description (synced by `.github/workflows/docker.yml`).
- `README.md` is a short pitch, feature list and quick start; everything else
  lives in `docs/` (numbered section folders of numbered pages, index in
  `docs/README.md`). Link between pages with relative `.md` links. The org
  site (`live-miracles.github.io`, `/projects/bunryu/`) renders the README
  and `docs/`; this repo publishes no Pages site of its own. `.github/assets/`
  holds the dashboard screenshots the README uses. `docs/superpowers/` and
  `docs/srs-runtime-forward-plan.md` are local, gitignored planning notes.

## Repo skills

Skills live in `skills/` and are shared with Claude Code and Codex through the
symlinks `.claude/skills` and `.agents/skills`; add new ones there, not in a
tool folder.

- `run-bunryu` - isolated local test stack and dashboard screenshots.
- `control-bunryu` - drive a running instance (local, test stack or production)
  through the REST API: login, read health, create/start/stop outputs.
- `investigate-prod` - read-only inspection of the production VM (logs,
  diagnostics, deployed version).
- `write-fail-report` - incident write-ups in `fail-reports/` and the redaction
  checklist for this public repository.
- `benchmark-sizing` - re-measure output CPU/RAM costs on a private loopback SRS
  pair to refresh `docs/1-getting-started/4-sizing.md`.

## Agent skills

### Issue tracker

Issues live in GitHub Issues (`live-miracles/bunryu`, via `gh`). See `agent-docs/issue-tracker.md`.

### Triage labels

Default five-label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `agent-docs/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` at the repo root. Design decisions are recorded in `docs/4-reference/3-design-decisions.md` rather than a separate `docs/adr/`. See `agent-docs/domain.md`.

## Data model and compatibility

This project does not require database migrations or legacy schema support.
When the schema or persisted data model changes, prefer wiping the old SQLite
database and creating it fresh rather than adding migration machinery or
maintaining compatibility with obsolete formats. Preserve only the data that
is explicitly required by the current application and deployment workflow.
When you change a table or column, bump `SCHEMA_VERSION` in `src/db/schema.ts`: a
database of another version is refused at startup (exit 78, which the systemd unit
does not restart) instead of failing later.

Keep the implementation straightforward: prefer simple code and clear
behavior over abstractions, compatibility layers, or speculative flexibility.

## Pre-commit checks

Before committing any change, review the complete diff carefully and
double-check the implementation for bugs, regressions, unsafe assumptions, and
unintended changes. Always run the applicable formatting and format-check
commands for every change, including documentation and UI changes, and
`npm run lint` for every code change.

Never run `git push` (or force-push, tag, or open/merge a PR) unless the user
explicitly asks for it in that request; committing stays local.

**This repository is public on GitHub.** Never commit real stream keys, SRT
passphrases, destination RTMP/SRT URLs (they can embed a third-party
platform's own stream key, e.g. YouTube), or customer/encoder IP addresses —
this applies to code and config as much as to prose, and especially to
fail-reports and other incident write-ups, which tend to paste real log
output verbatim. Redact these before committing (e.g. `key01_<redacted>`,
`<redacted-ip>`, `<redacted-srt-passphrase>` — keep the non-secret parts, like
a `keyNN_` prefix or a bare destination hostname, since they're still useful
for understanding an incident). If a real secret is committed and pushed
anyway, treat it as compromised: rotate it, and don't rely on a history
rewrite alone to undo the exposure.

Test effort should be proportional to the change. A change that only touches
documentation, comments or cosmetic styling skips the full test suite: run just
the checks that apply (the format check, the docs link checker for docs, lint
for code). Any other change must run the full test suite immediately before
committing, and the results must be checked to ensure existing behavior has not
been broken. Substantial changes should run it during implementation as well.

## Development expectations

The backend uses Node.js 22+ and TypeScript. Before completing a change,
run the narrowest relevant tests and type/build checks, then expand validation
for changes that affect process management, media handling, persistence, or
the API. New features should be covered by meaningful tests that exercise
their important behavior, failure cases, and relevant integration points. A
strict test-driven-development workflow is not required, but the test suite
should remain comprehensive enough to catch regressions and give confidence in
production behavior. For a bug fix, write a regression test first and
run it to confirm it fails for the intended reason before fixing the code.
Preserve existing behavior unless the change explicitly
requires a behavioral adjustment, and document any known limitation or
operational tradeoff.
