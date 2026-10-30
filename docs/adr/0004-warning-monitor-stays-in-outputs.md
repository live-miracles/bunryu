# The FFmpeg warning and progress monitor stays inside `outputs.ts`

Status: accepted, 2026-10-30. The monitor was not extracted; only the two pure parsers moved out of the closure (same file) and the gaps below were tested.

An architecture review proposed moving the per-run monitoring in `src/services/outputs.ts` (timestamp-warning bursts, warning episodes, progress and speed parsing, the card warning) into its own module. About 330 lines would move, which looks like an easy win for testability.

It is not separable, because the monitor does not own its state. The per-output progress record is also what the stall watchdog, the error builders and the shared-encode readiness check read, and the teardown that ends warning episodes runs inside the status change and the process close handler, in an order that matters. A full extraction would have to take over exactly the code that decides whether an output is started twice, never started, or shown stopped while running ([ADR 0001](0001-robustness-before-performance-in-output-management.md)).

Only the pure part separates cleanly: the constants, the line patterns, the bitrate and progress parsers and, at most, the burst counter as a function of a line and the time. That is about 120 to 150 lines and gains little. The behaviour is already tested through the real service with a fake `spawn`.

Revisit when a change has to touch the monitor independently of the lifecycle. The pieces that were untested are now covered through the service: bitrate parsing, `total_size` never going backwards, the 15 s stall reason, and which warning the card shows when several apply (socket, then memory, then timing, then falling behind).
