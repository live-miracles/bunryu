# An output is retired in one call before its row is deleted

Status: accepted, 2026-10-30

Stopping an output that is about to be deleted has an order that is easy to get wrong. When a process exits, its close handler restarts it, or schedules a retry, if the output's desired state is still `running`. So the desired state must be set to stopped before the process is killed, the exit awaited, and any retry or prompt restart the exit left behind dropped afterwards. The sequence was written out by hand in five places (deleting an output, clearing a pipeline's outputs, deleting a pipeline, and removing a shared encode, twice) before it became `OutputService.retire()`, which is now the only way to do it. `clearRetryState` is no longer exposed, so a caller cannot rebuild the sequence from parts and leave one out.

The one place that stops without retiring is a stream-key change. It keeps the shared-encode rows, which the reconciler starts again on the new key, so it stops them (desired state first, then `stopAndWait`) and deletes nothing.

Considered: forgetting the per-output bookkeeping (run counters, last exit stderr, burst history) in `retire()` too. It would save a few bytes per output id ever created, and it would reuse run ids such as `out#1`, which breaks the one-grep-per-run guarantee in the diagnostics. So the maps are kept on purpose.
