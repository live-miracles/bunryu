# `inputState` stays separate from the health poll

Status: accepted, 2026-10-30. Nothing was changed; this records why not.

`inputState.ts` (which inputs are live, their protocol and resolution, whether SRS is reachable) and the input lifecycle inside the health poll both track whether a pipeline's input is up, and an architecture review proposed merging them. The overlap is real but mild: the poll keeps its own "connected" map, and writes it together with `inputState`'s live flag in the same step, only while SRS is reachable.

`inputState` is a small passive store that the output service, the previews and the SRS publish hooks read, and the poll is its only writer. Merging it into the poll (or into the probe scheduler) would couple all of those readers to the largest file in the service layer, and would put at risk the guards that rest on this split: start gating on readiness, the restart when a new publisher's probed format differs, the cooldown that bounds it, and refusing a cross-protocol publish to a live pipeline. The gain would be one map fewer.

Revisit if the two ever disagree about whether an input is live. One gap between them was closed instead of merging: the poll pruned its own per-pipeline state when a pipeline was deleted but left that pipeline's `inputState` entry behind, so it now calls `inputState.keepOnly` with the pipelines that still exist.
