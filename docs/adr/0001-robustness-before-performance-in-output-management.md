# Output FFmpeg management favours robustness over performance

Status: accepted, 2026-10-30

The code that starts, stops and restarts output FFmpeg processes (`src/services/outputs.ts`) is the part where a bug is an outage in front of a live audience: an output started twice, never started, or shown as stopped while its process still runs. So it is kept simple and plain, and speed, duplication and extra checks are accepted before cleverness. A faster or more elegant design needs a very good reason, written down in [Design decisions](../4-reference/3-design-decisions.md).

Consequences: a refactor of that file is judged on whether the start, stop, restart and `retire()` paths come out simpler and still ordered the same way (see [ADR 0002](0002-retire-an-output-in-one-call.md)), not on how much code it moves ([ADR 0004](0004-warning-monitor-stays-in-outputs.md) is an example). The dashboard is held to ordinary refactoring judgment, since a UI bug costs less than a wrong output state.
