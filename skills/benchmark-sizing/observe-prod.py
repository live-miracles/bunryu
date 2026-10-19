#!/usr/bin/env python3
"""Summarise what outputs cost on the production server, from its own diagnostics.

Read-only: reads the per-minute `health-snapshot` events and opens the database
with mode=ro. Prints aggregates only (no names, URLs or keys). Run it on the VM:

  gcloud compute ssh <vm> --command 'sudo python3 -I - 2026-10-18 2026-10-19' < observe-prod.py

Arguments are diagnostics file dates (YYYY-MM-DD, the host's local date; default:
every file). Output classes need the output to still exist in the database; copy
means video copy, aac means any audio track selected.
"""
import collections, glob, json, sqlite3, statistics as st, sys

DIAG = '/var/lib/bunryu/diagnostics/diagnostics-%s.jsonl*'
DB = 'file:/var/lib/bunryu/db.sqlite?mode=ro'


def bucket(mbps):
    return '<4' if mbps < 4 else '4-7' if mbps < 7 else '7-10' if mbps < 10 else '10+'


def snapshots(days):
    for day in days or ['*']:
        for path in sorted(glob.glob(DIAG % day)):
            for line in open(path):
                if '"event":"health-snapshot"' in line:
                    try:
                        yield json.loads(line)
                    except ValueError:
                        pass


def main():
    db = sqlite3.connect(DB, uri=True)
    meta = {r[0]: r[1:] for r in db.execute(
        'select id, encoding, audio_encoding, substr(url, 1, 6) from outputs')}
    per_output = collections.defaultdict(list)  # class -> (vCPU, MB, Mbps)
    busy = []  # snapshots with many outputs: totals
    for d in snapshots(sys.argv[1:]):
        n = out_cpu = out_rss = ingest = 0.0
        for p in d['pipelines'].values():
            i = p['input']
            if i.get('live'):
                ingest += (i.get('recvBitrateKbps') or 0) / 1000
            for oid, o in p['outputs'].items():
                if oid not in meta or o.get('status') != 'running':
                    continue
                video, audio, proto = meta[oid]
                if o.get('cpuPercent') is None or not o.get('bitrateKbps') or video != 'copy':
                    continue
                mbps = o['bitrateKbps'] / 1000
                key = ('aac' if audio != 'copy' else 'copy', 'srt-in' if i.get('isSrt') else 'rtmp-in',
                       proto.rstrip(':/'), bucket(mbps))
                per_output[key].append((o['cpuPercent'] / 100, o['memoryUsageBytes'] / 1e6, mbps))
                n += 1
                out_cpu += o['cpuPercent'] / 100
                out_rss += o['memoryUsageBytes'] / 1e6
        if n:
            pr = d['processes']
            cpu = lambda k: ((pr.get(k) or {}).get('cpuPercent') or 0) / 100
            busy.append((n, ingest, out_cpu, out_rss, cpu('srs'), cpu('relay'), cpu('node'),
                         (d['host']['totalBytes'] - d['host']['availableBytes']) / 1e6))

    print('audio | input | destination | output Mbps | samples | vCPU/output | vCPU per Mbps | MB/output')
    for k, v in sorted(per_output.items()):
        if len(v) >= 20:
            cpu, mbps = st.mean(x[0] for x in v), st.mean(x[2] for x in v)
            print(*k, len(v), '%.3f' % cpu, '%.4f' % (cpu / mbps), '%.0f' % st.mean(x[1] for x in v), sep=' | ')

    print('\noutputs bucket | snapshots | ingest Mbps | output vCPU | SRS | relay | node | total vCPU avg (max) | host RAM MB avg (max)')
    groups = collections.defaultdict(list)
    for r in busy:
        groups[int(r[0]) // 5 * 5].append(r)
    for lo, rows in sorted(groups.items()):
        if len(rows) < 5:
            continue
        m = lambda i: st.mean(r[i] for r in rows)
        total = [r[2] + r[4] + r[5] + r[6] for r in rows]
        print('%d-%d' % (lo, lo + 4), len(rows), '%.1f' % m(1), '%.2f' % m(2), '%.2f' % m(4), '%.2f' % m(5),
              '%.3f' % m(6), '%.2f (%.2f)' % (st.mean(total), max(total)),
              '%.0f (%.0f)' % (m(7), max(r[7] for r in rows)), sep=' | ')


if __name__ == '__main__':
    main()
