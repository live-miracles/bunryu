# Development

Prerequisites: Node.js 22+ plus `curl`, `unzip`, `tar`, and `xz-utils`.

**1. Install dependencies and local media binaries:**
```bash
npm install
npm run dev-install   # downloads SRS and pinned FFmpeg into ./objs
```
Rerunning `npm run dev-install` also refreshes the sibling `../goryu`
repo when it has no local changes and rebuilds `./objs/goryu`.

To use a local SRS binary:
```bash
SRS_LOCAL_BIN=./build/srs npm run dev-install
```

The standalone relay now lives in the sibling `../goryu` repo during development and in `live-miracles/goryu` GitHub Releases for production installs.

**2. Start SRS** (terminal 1):
```bash
npm run srs           # runs ./objs/srs -c srs.conf in the foreground
```

**3. Start Goryu** (terminal 2):
```bash
npm run goryu          # runs the ./objs/goryu binary built by dev-install
npm run goryu:update   # pulls the latest ../goryu source and rebuilds ./objs/goryu
```

The relay also exposes a local HTTP status endpoint on the default
`status_port` (`127.0.0.1:8081`) in development. The dashboard backend polls
that endpoint to show the top-level relay health and the per-pipeline
bonded-input status.

**4. Start the app** (terminal 3):
```bash
npm run dev           # tsx watch + tsc watch + tailwind watch
```

## Tests

```bash
npm test              # unit and integration tests
npm run typecheck
npm run lint          # ESLint: unhandled promises, dead code
npm run format:check
```

`scripts/test-stack.sh` starts an isolated local stack (its own SRS, control
plane and fresh database, with a fake output FFmpeg) that does not touch a
developer's own `npm run dev`. It is documented in
[`skills/run-bunryu/SKILL.md`](../../skills/run-bunryu/SKILL.md).
