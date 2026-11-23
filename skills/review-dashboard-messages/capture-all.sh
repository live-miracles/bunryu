#!/bin/bash
# Retakes every screenshot of the catalogue that is not in the manifest yet, resuming after each
# silent exit of capture.mts (it can stop quietly part way: see SKILL.md). Run it from anywhere:
#   REVIEW_DIR=/tmp/bunryu-message-review WORK=/tmp/bunryu-ui skills/review-dashboard-messages/capture-all.sh
# Needs the test stack, Chrome and the proxy up (SKILL.md, steps 1-3). To retake entries, delete them
# from $REVIEW_DIR/manifest.json first.
here="$(cd "$(dirname "$0")" && pwd)"
export REVIEW_DIR="${REVIEW_DIR:-/tmp/bunryu-message-review}"
mkdir -p "$REVIEW_DIR"
[ -f "$REVIEW_DIR/manifest.json" ] || echo '{}' > "$REVIEW_DIR/manifest.json"
cd "$here" || exit 1
npx tsx dump.mts
for pass in $(seq 1 25); do
    missing=$(python3 -c "
import json, os
d = os.environ['REVIEW_DIR']
m = json.load(open(d + '/manifest.json'))
c = [e['id'] for e in json.load(open(d + '/catalog.json')) if not e['id'].startswith('real-')]
print(' '.join(i for i in c if i not in m))")
    [ -z "$missing" ] && {
        echo "all entries captured after $pass pass(es)"
        exit 0
    }
    echo "pass $pass: $(echo $missing | wc -w) entries missing"
    timeout 900 npx tsx capture.mts 2>&1 | tail -n 100
done
echo "gave up: some entries are still missing" >&2
exit 1
