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
vertical rotation, and configurable audio processing. Translation outputs can
mix audio from a separate translator pipeline with the source audio, including
speech detection, source ducking, delay, and configurable restore timing.

## Intended capacity

These are the supported operating ceilings described in
`docs/1-getting-started/1-introduction.md`,
not targets to exceed:

| Resource | Intended maximum |
|---|---:|
| Input pipelines | 50 |
| Output forwards | 500 total (enforced in the database layer; shared encodes are not counted) |
| Distinct concurrent custom/transcoding encodes | A few at a time |
| Concurrent dashboard clients | Approximately 10 |

Most outputs should use `copy` mode. Copy-mode outputs are comparatively cheap,
while custom video encoding takes 0.6–2.5 vCPUs per encode on a GCP `n2`, so one
`1080p` encode takes about two thirds of a 4-vCPU host (see
`docs/1-getting-started/4-sizing.md`). Outputs of one pipeline with the same
video encoding and single audio track share one encode.
Host CPU, memory, network capacity, and the number of FFmpeg processes are
expected to become limiting factors before the API or dashboard at the upper
end of the supported envelope.

Do not increase these limits or add resource-intensive defaults without
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
- A temporary translator or source failure should degrade gracefully when the
  design permits it—for example, translation output can continue with source
  audio when translator audio is unavailable.

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
`skills/run-bunryu/SKILL.md` documents it.

Prefer small, reversible changes.

**Documentation is part of every change.** When you add a feature or change
behavior, architecture, capacity, supported protocols or operational guarantees,
find every doc page that describes it and update it in the same change. Search
`docs/` and `README.md` for the feature's name, and check these places:

- **`docs/2-usage/`** for what users see and do: publishing, outputs, preview,
  translation.
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

## Code map

Navigation only; correct an entry when a change makes it stale, and add one
only for a new module.

- `src/index.ts` - app bootstrap: middleware, auth gate, route registration,
  service wiring, graceful shutdown.
- `src/services/outputs.ts` - one FFmpeg process per output: start/stop/retry,
  stall/socket/memory watchdogs, timestamp-warning bursts and warning episodes,
  output Error History writes; shared-encode readiness, dependents' restart on a
  rendition failure and `restart()`. `outputSockets.ts` parses `ss` for
  destination socket health.
- `src/services/renditions.ts` - the shared-encode reconciler (1 s tick): creates
  and removes the rendition output rows, starts them with their first running
  output and idle-stops them after 15 s. `src/utils/renditions.ts` has the recipe
  rules (`encodeRecipe`, and `sharedRecipe`, which also needs two outputs with the
  recipe), naming and URL recognition; the dashboard twins are in
  `public/ts/core/renditions.ts`.
- `src/services/health.ts` - the 5 s poll behind `/api/health`: SRS and relay
  state, input live/media state (schedules ffprobe via `mediaProbe.ts`),
  alerts, the per-minute diagnostics snapshot. `inputState.ts` holds per-input
  readiness/protocol and builds the pull URL outputs read.
- `src/services/srtRelay.ts` (relay status; a plain SRT input is presented as one link), `translationMixer.ts`
  (translation output mixer), `preview.ts` (HLS previews with a keepalive TTL),
  `rejectedPublishes.ts`, `hostProbes.ts`.
- `src/api/*` - REST routes. `srs.ts` has the SRS `on_publish`/`on_play` hooks
  and journal log tails; `auth.ts` login/sessions.
- `src/utils/ffmpeg.ts` builds FFmpeg arguments; `appConfig.ts` reads
  `bunryu.json` (watchdog defaults); `diagnostics.ts` is the rotated JSONL
  writer; `srs*.ts`/`relayConfig.ts` generate and read SRS and relay config.
- `src/db/` - SQLite schema and access (output Error History lives in
  `outputs.last_error` as JSON).
- `public/ts/` - dashboard TypeScript, compiled to untracked `public/js/`.
  `core/pipeline.ts` splits shared-encode rows out of `PipelineView.outs` into
  `renditions`; `features/shared-encodes.ts` renders the Shared encodes card.
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
- `investigate-prod` - read-only inspection of the production VM (logs,
  diagnostics, deployed version).
- `write-fail-report` - incident write-ups in `fail-reports/` and the redaction
  checklist for this public repository.
- `benchmark-sizing` - re-measure output CPU/RAM costs on a private loopback SRS
  pair to refresh `docs/1-getting-started/4-sizing.md`.

## Data model and compatibility

This project does not require database migrations or legacy schema support.
When the schema or persisted data model changes, prefer wiping the old SQLite
database and creating it fresh rather than adding migration machinery or
maintaining compatibility with obsolete formats. Preserve only the data that
is explicitly required by the current application and deployment workflow.

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

Test effort should be proportional to the change during implementation. Small,
low-risk changes—especially UI-only styling changes—may skip the full test
suite after targeted validation. Substantial changes should run the full test
suite during implementation as well. Regardless of change size, the full test
suite must always be run immediately before committing, and the results must
be checked to ensure existing behavior has not been broken.

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
