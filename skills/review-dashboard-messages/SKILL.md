---
name: review-dashboard-messages
description: Scan every error, warning and tip the Bunryu Overview and Status pages can show, take a screenshot of each, and publish a review report (what it looks like, when it shows, when it clears, with Keep / Change / Question controls) for the operator to confirm. Use when asked to audit, list or screenshot the dashboard's alerts, errors, warnings or tips, or to refresh that report after a UI or rule change.
---

# Review the dashboard's messages

Produces one page with a card per message: the screenshot(s), the text as drawn, when it shows,
when it clears, and Keep as is / Change / Question buttons with a note. "Copy my notes" gives the
operator text to paste back, one line per decision (`- A3 [Change] title :: note`). Then you make
the changes they confirmed and refresh the page (step 7).

Paths are relative to the repo root; the tools are in this folder. Nothing here changes the app.

## How it works

Most states cannot happen on the isolated test stack (`run-bunryu`): relay legs, SRT alerts,
banners, host load. So `proxy.mts` sits between the browser and the stack (18090 to 18080),
reads the scenario name from `$WORK/scenario.txt` on every request, edits the real
`/api/health`, `/api/config`, `/api/metrics/system`, `/api/events` and
`/api/rejected-publishes` payloads for it, and **recomputes the verdicts with the server's own
rules** (`src/utils/healthVerdicts.ts`). The dashboard then draws what a real server would send.
Host alerts are server output too (`hostAlerts` in the health payload), so a scenario sets them
as data.

- `scenarios.mts` is the catalogue: one entry per message (`id`, `section`, `title`, `when`,
  `clears`, the `shots` to take, and `apply`, which edits the payloads). Shot kinds: `banner`,
  `topbar`, `ov-inputs|outputs|relay|shared` (Overview tables), `status-dot` (hover on the input
  dot or an output's dot), `status-card`, `status-top`, `sidebar-dot`, `out-card`, `out-hint`,
  `status-problems`, `sidebar-rejected`.
- `capture.mts` drives headless Chrome over CDP (9333): per entry it sets the scenario, loads the
  page, hovers where needed and writes clipped PNGs to `$REVIEW_DIR/shots/` and the text it saw to
  `$REVIEW_DIR/manifest.json`.
- `build_report.py` merges catalogue and manifest into `$REVIEW_DIR/report/index.html` (codes
  per section: B, I, IA, R, RA, O, W, SE, S, P, A; section codes must stay unique, because the
  browser stores marks by code) from `report_template.html`.

A few states are captured on the **real** stack with no proxy (`real-*` entries, text in
`build_report.py`): a timestamp flood (`scripts/test-stack.sh flood on`) and a shared encode
waiting and failing (kill the encode by pid, see `run-bunryu`). Retake them by hand with
`APP_PORT=18080 npx tsx capture.mts real-flood` and so on; they are not part of `capture-all.sh`.

## Steps

```bash
export WORK=/tmp/bunryu-ui REVIEW_DIR=/tmp/bunryu-message-review
H=scripts/test-stack.sh
```

1. `$H start` (the stack, see `run-bunryu`), then `$H shot $WORK/warm.png "0" 500` once: it starts
   the Chrome that `capture.mts` attaches to (port 9333).
2. Start the proxy in the background (the Bash tool's `run_in_background`, not `nohup … &`: a
   detached process is killed when the call ends):
   `npx tsx skills/review-dashboard-messages/proxy.mts`
3. Check it answers: `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18090/login.html`.
4. Capture everything: `skills/review-dashboard-messages/capture-all.sh` (background again). It
   resumes after each silent exit and finishes with "all entries captured". Retake one entry by
   deleting its key from `$REVIEW_DIR/manifest.json`, or run
   `npx tsx skills/review-dashboard-messages/capture.mts <id> …` in the foreground.
5. **Look at the PNGs** (a few per section at least): a clipped or empty shot, a toast over a
   banner, or a page that did not load is easy to miss in the log.
6. Build and publish:
   `python3 skills/review-dashboard-messages/build_report.py`, then publish
   `$REVIEW_DIR/report/index-inline.html` with the Artifact tool (the images are inlined: a
   publish of the page alone does not upload `shots/`, and the page would keep showing the old
   ones). It is private until the operator shares it. Give them the link and the "worth a look"
   points.
7. After the operator pastes their notes: make the confirmed changes (AGENTS.md: docs, tests,
   format, lint; do not push), then **refresh the report**: update the catalogue's `when` and
   `clears` texts and scenarios for the new behaviour, add entries for new messages, retake the
   shots (delete the manifest keys), and optionally write `$REVIEW_DIR/changes.json`, a list of
   `{code, title, decision, status: "Done"|"Kept", text, refs: [catalogue ids]}`, which the
   builder shows first as "What changed since your review". Bump the `KEY` in
   `report_template.html` when codes or meaning change, so old browser marks do not attach to new
   cards.

## Adding or changing a message

A new message in the dashboard or the status rules needs an entry here, or the report goes stale.
Find the rule first (`src/utils/outputStatus.ts`, `inputStatus.ts`, `healthVerdicts.ts`,
`hostMonitor.ts`, `srtLinkAlerts.ts`; the relay half and Problems in `public/ts/core/`), then
write the entry: `apply` makes the smallest payload edit that provokes it (helpers `inp`, `out`,
`cfgOut`, `alert`, `hostAlert`, `relay`, `leg`), and `when` states the real rule and its
thresholds. Check every threshold against the code; never copy it from memory. Say in the text
what is a fixture and what is real wording.

## Gotchas

- **Never `pkill -f` with a broad pattern** (it matches its own shell); kill by pid from
  `ps -eo pid,args | grep`.
- `capture.mts` can exit with status 0 and no output part way through (a pending top-level
  await when Chrome closes the socket). `capture-all.sh` exists for that; a shot missing from
  the manifest means it never ran.
- The `down` scenarios (`banner-server`) make the proxy destroy the socket so the dashboard shows
  its "Cannot reach server" banner; a plain 502 shows an "HTTP 502" toast instead.
- Shots clip to an element's box plus padding; a page taller than the 1500x2200 viewport is cut.
- Some states are transient on the real stack (a shared encode restarts in seconds), so the
  Overview and Status shots of one entry can be a moment apart; say so in the entry.
- The proxy's `neutralise()` first clears the developer machine's own host alerts and metrics,
  so nothing of the host leaks into a shot. Keep it when adding scenarios.
- The catalogue ages with the dashboard. When the rules or the wording change, the `when` text
  of the affected entries must change in the same pass.
