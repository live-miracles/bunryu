---
name: record-bunryu-demo
description: Record the README's "how it works" GIF (or fresh dashboard stills) of Bunryu with real, running outputs, on any machine that has Docker, including Windows and macOS where the Linux test stack cannot run. Use when asked to record, re-record or update the walkthrough GIF or the README screenshots after a UI change. For a Linux test stack with simulated outputs and fault scenarios use run-bunryu instead.
---

# Record a Bunryu demo

Drives the real dashboard through a scripted storyboard (create a pipeline, publish a film
to it, preview it, add three destinations, start them), records frames with a fake cursor
and step captions, and renders a GIF plus stills. The stack is the project's own Docker
image, so it works where `scripts/test-stack.sh` does not (that one needs Linux, `objs/`
binaries and Chrome). The outputs are **real FFmpeg processes**: they publish to a local
SRS receiver container whose Docker-network aliases stand in for the platforms, so no real
destination or key is involved.

It builds on the personal `app-demo` skill (`~/.claude/skills/app-demo/`): its
`scripts/record.mjs` drives Electron and `scripts/render.py` renders frames. Read that
skill first for the helper API (`d.click`, `d.type`, `d.shot`, `d.record`); this one adds
the Bunryu scenario and everything that went wrong the first time.

Paths are relative to the repo root. Work in the scratchpad; only the finished GIF goes in
`.github/assets/`.

## Prerequisites

- Docker running (Docker Desktop on Windows/macOS), `ffmpeg` and `python` on PATH.
- Electron, installed outside the repo: in an empty scratchpad folder
  `npm init -y && npm install electron@33.4.0` (about 100 MB; ask the user before
  downloading). The binary is `node_modules/electron/dist/electron.exe`. `npx electron`
  swallows output.
- A demo film. Blender's Sintel trailer is CC BY 3.0 and what the README uses
  (`https://download.blender.org/durian/trailer/sintel_trailer-720p.mp4`, 7.6 MB; ask
  before downloading, and credit it in the README caption). Cut a clip of bright scenes
  **as constant bitrate**:

  ```sh
  ffmpeg -ss 25 -i sintel_trailer-720p.mp4 -t 15 \
    -vf "crop=1280:544:0:88,scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,fps=30" \
    -c:v libx264 -preset medium -b:v 2500k -minrate 2500k -maxrate 2500k -bufsize 2500k \
    -x264-params "nal-hrd=cbr:force-cfr=1" -g 60 -keyint_min 60 -sc_threshold 0 -pix_fmt yuv420p \
    -c:a aac -b:a 128k -ar 48000 -ac 2 demo-feed.mp4
  ```

  Why these choices: the trailer opens with a black title card and ends on a logo, so take
  the middle; crop the letterbox first; a clip that restarts on a dark scene makes a black
  preview in the final still; and a **variable-rate** clip made every output's bitrate
  chip amber (the dashboard flags an output whose bitrate is off the input's measured
  one), while a CBR clip gives matching numbers and no chips.

## Run

1. **Start a fresh stack for every take** (the scenario refuses a non-empty server, and a
   leftover pipeline's key is not the one it publishes to):

   ```sh
   export BUNRYU_DASHBOARD_PASSWORD=<any throwaway value>
   docker compose -p bunryu-demo -f compose.yaml -f skills/record-bunryu-demo/compose.demo.yaml down -v
   docker compose -p bunryu-demo -f compose.yaml -f skills/record-bunryu-demo/compose.demo.yaml up -d --build
   ```

   The dashboard is `http://localhost:8080` (RTMP in on 21935). The first build takes a
   few minutes; use a separate `-p` project so other containers are untouched.

2. **Record** (the Electron window opens on the screen and must stay visible):

   ```sh
   export DEMO_FEED=<demo-feed.mp4> DEMO_FFMPEG=<real ffmpeg binary> DEMO_URL=http://localhost:8080
   <electron> ~/.claude/skills/app-demo/scripts/record.mjs --app skills/record-bunryu-demo/open-url.mjs \
     --scenario skills/record-bunryu-demo/scenario.mjs --out <scratch>/rec --size 1280x800 --timeout 200
   ```

   `<scratch>/rec/log.txt` ends with `done: N frames`, or an `ERROR` and its stack. It
   also holds the publish URL (key redacted), the saved config and the outputs list, which
   prove the demo's actions took effect. The log is not for the repo.

3. **Cut dead time, render, review**:

   ```sh
   python skills/record-bunryu-demo/cap_gaps.py <scratch>/rec --speed 1.3
   python ~/.claude/skills/app-demo/scripts/render.py <scratch>/rec --gif how-it-works.gif --sheet sheet.png --width 960 --end-hold 2.5
   ```

   Read `sheet.png` and every still in `<scratch>/rec/shots/` (`pipeline-created`,
   `input-live`, `preview`, `outputs-added`, `outputs-running`; the stills have no
   caption). Done when each step's payoff is visible, the last frame shows three running
   outputs with no warning, there is no banner, error toast or black preview, and the GIF
   is under 5 MB at 960 px (about 50 s and 3 MB at speed 1.3). Three or four takes are
   normal.

4. **Clean up**: `docker compose -p bunryu-demo -f compose.yaml -f skills/record-bunryu-demo/compose.demo.yaml down -v`
   and make sure no `ffmpeg` publisher is left (below).

## What is on screen

Everything on screen gets published, so keep it neutral and fake: pipeline "Main Stage",
outputs "YouTube", "Partner CDN", "Archive", stream keys like `demo-1234-abcd-5678`, the
public host `live.example.test` (the scenario sets it, or the dashboard shows a yellow
"Public Host is not set" banner), and the `.test` receiver hostnames. The stream key is
masked in the Publish card. The source address shown is the Docker gateway. Never show a
real destination URL or key, and never commit `log.txt` (it has the unredacted key).

## Gotchas

- **`--url` crashes Electron on Windows** when combined with the other recorder flags
  (exit -1, no output, no `log.txt`; each flag alone works). `open-url.mjs` passed as
  `--app` does the same job.
- **`d.waitFor` treats every string as a CSS selector.** A JS condition passed to it throws
  "Script failed to execute". The scenario has `until(expr)` for conditions.
- **Open modals hide the fake cursor and the caption** (the `<dialog>` is in the top
  layer). The scenario moves both into the open dialog every 50 ms.
- **Dead time**: pausing the recorder with `skip()` leaves a time gap that `render.py`
  would replay as a long hold; `cap_gaps.py` collapses it into a jump cut.
- **"Add pipeline" creates a pipeline at once** (no form); the pencil renames it. The
  output form is **prefilled from the last output**, so the scenario clears each field
  before typing. "Start all" opens a confirmation modal.
- **The publisher must be ended by process tree.** `child.kill()` left ffmpeg publishing
  on Windows, and Chocolatey's `ffmpeg` is a shim that a kill does not reach through, so
  pass the real `ffmpeg.exe` as `DEMO_FFMPEG`; the scenario ends it with `taskkill /T /F`.
  Check afterwards for a stray one by its command line (`demo-feed`) and stop that PID.
  Never kill by image name: it ends other people's ffmpeg too.
- **Do not drive the dashboard in the built-in browser pane for this.** A hidden pane
  throttles timers, so the Start-all confirmation never ran there. The recorder's own
  visible window is the reliable one.
- Frames come at about 5 fps, so a GIF is smooth enough for UI but not for fast motion.

## Stills for docs

The same run writes the five stills. To take one on its own, start the stack as above
and use the recorder with a short scenario, or use `scripts/test-stack.sh shot` on Linux
([run-bunryu](../run-bunryu/SKILL.md)).
