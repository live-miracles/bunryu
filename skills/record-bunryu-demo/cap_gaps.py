"""Turn the gaps left by an unrecorded wait into short jump cuts, and optionally speed up.

record.mjs stamps every frame with its capture time and render.py shows a frame until
the next one's stamp, so pausing the recorder (d.record.stop() ... d.record.start())
would replay as a long hold. This rewrites <rec>/frames/times.txt so a gap longer than
--max-gap seconds lasts --collapse-to seconds. The original is kept as times.orig.txt,
and running it again starts from that original.

  python cap_gaps.py <rec dir> [--max-gap 0.8] [--collapse-to 0.25] [--speed 1.3]

--speed plays the whole recording faster (1.3 turns a 65 s walkthrough into 50 s): typing
and cursor glides read fine a little quicker, and a long GIF is the first thing people skip.
"""

import argparse
import os
import shutil

p = argparse.ArgumentParser()
p.add_argument("rec")
p.add_argument("--max-gap", type=float, default=0.8)
p.add_argument("--collapse-to", type=float, default=0.25)
p.add_argument("--speed", type=float, default=1.0)
a = p.parse_args()

path = os.path.join(a.rec, "frames", "times.txt")
orig = os.path.join(a.rec, "frames", "times.orig.txt")
if not os.path.exists(orig):
    shutil.copy(path, orig)
rows = [l.split() for l in open(orig) if l.strip()]

out, shift, cut = [], 0, 0.0
prev = None
for name, t in rows:
    t = int(t)
    if prev is not None and (t - prev) / 1000 > a.max_gap:
        shift += t - prev - int(a.collapse_to * 1000)
        cut += (t - prev) / 1000 - a.collapse_to
    out.append((name, t - shift))
    prev = t
t0 = out[0][1]
lines = [f"{n} {int(t0 + (t - t0) / a.speed)}" for n, t in out]
open(path, "w").write("\n".join(lines) + "\n")
print(f"{len(rows)} frames, removed {cut:.1f}s of dead time, speed x{a.speed}")
