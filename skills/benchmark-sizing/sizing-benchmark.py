#!/usr/bin/env python3
"""Measure the CPU and RAM cost of Bunryu outputs on this machine.

Runs a private, loopback-only pair of SRS servers under --workdir (a hub that
outputs pull from and a sink they push to), feeds the hub a generated stream
(30 fps unless --fps) and runs FFmpeg commands built like src/utils/ffmpeg.ts buildFfmpegArgs().
Prints one `RESULT {json}` line per case and `DONE` at the end. Linux only.

  python3 -I sizing-benchmark.py --origin rtmp|srt [--cases a,b] [--list]
                                 [--warm 15] [--run 45] [--fps 30] [--workdir /tmp/bench]
                                 [--ffmpeg PATH] [--srs PATH] [--no-guard]

Safety guard (default on): aborts and kills everything if a production `ffmpeg`
process is running or the production SRS API (127.0.0.1:1985) shows a live
publisher, or cannot be read. Use --no-guard on a throwaway VM or a dev machine.
The benchmark's own binaries are copies named ffmpeg-bench and srs-bench and run
at `nice 19`, so they never match the guard or outrank production processes.
"""
import argparse, json, os, secrets, shutil, signal, subprocess, sys, time, urllib.request

HUB, SINK, SRT = 29350, 29351, 29352
CLK = os.sysconf('SC_CLK_TCK')
started = []
cfg = {}

# name, source, outputs, video profile, audio ('copy' or 'aac')
CASES = [
    ('copy_x1', 'hard1080', 1, 'copy', 'copy'),
    ('copy_x10', 'hard1080', 10, 'copy', 'copy'),
    ('copy_x30', 'hard1080', 30, 'copy', 'copy'),
    ('aac_x1', 'hard1080', 1, 'copy', 'aac'),
    ('aac_x10', 'hard1080', 10, 'copy', 'aac'),
    ('p720_x1', 'hard1080', 1, '720p', 'copy'),
    ('p1080_x1', 'hard1080', 1, '1080p', 'copy'),
    ('vertical_x1', 'hard1080', 1, 'vertical', 'copy'),
    ('p720_x4', 'hard1080', 4, '720p', 'copy'),
    ('p1080_x3', 'hard1080', 3, '1080p', 'copy'),
    ('p1080_x4', 'hard1080', 4, '1080p', 'copy'),
    ('p720_x1', 'easy1080', 1, '720p', 'copy'),
    ('p1080_x1', 'easy1080', 1, '1080p', 'copy'),
    ('vertical_x1', 'easy1080', 1, 'vertical', 'copy'),
    ('p720_x1', 'hard720', 1, '720p', 'copy'),
    ('copy_x1', 'hard720', 1, 'copy', 'copy'),
    # 4K input: memory matters here (the app doubles the RSS limit for 4K inputs)
    ('copy_x1', 'hard2160', 1, 'copy', 'copy'),
    ('aac_x1', 'hard2160', 1, 'copy', 'aac'),
    ('p720_x1', 'hard2160', 1, '720p', 'copy'),
    ('p1080_x1', 'hard2160', 1, '1080p', 'copy'),
    ('vertical_x1', 'hard2160', 1, 'vertical', 'copy'),
]
SOURCES = {  # name: (size, bitrate kbps, add noise, x264 preset used to generate it)
    'hard1080': ('1920x1080', 6000, True, 'medium'),
    'easy1080': ('1920x1080', 4000, False, 'medium'),
    'hard720': ('1280x720', 3500, True, 'medium'),
    'hard2160': ('3840x2160', 20000, True, 'veryfast'),  # veryfast: a 4K medium encode takes too long
}

# Keep in sync with ENCODINGS in src/utils/ffmpeg.ts.
V = {
    'copy': ['-c:v', 'copy'],
    '720p': ['-vf', 'scale=1280:720', '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '3000k'],
    '1080p': ['-vf', 'scale=1920:1080', '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '5000k'],
    'vertical': ['-vf', 'scale=720:-2:flags=fast_bilinear,transpose=1', '-c:v', 'libx264', '-preset', 'veryfast'],
}
A_COPY = ['-c:a', 'copy']
A_AAC = ['-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000']
A_AAC_SRT = ['-af', 'aresample=async=1:first_pts=0'] + A_AAC  # encodeAudioArgs(): filter on an SRT origin only


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


def kill_all():
    for p in started:
        try:
            p.kill()
        except Exception:
            pass
    for p in started:
        try:
            p.wait(timeout=5)
        except Exception:
            pass
    started.clear()


def prod_busy():
    r = subprocess.run(['pgrep', '-x', 'ffmpeg'], capture_output=True, text=True).stdout.split()
    if r:
        return 'production ffmpeg running: %s' % ','.join(r)
    try:
        with urllib.request.urlopen('http://127.0.0.1:1985/api/v1/streams', timeout=2) as f:
            streams = json.load(f).get('streams', [])
    except Exception as e:
        return 'cannot read the production SRS API: %s' % e
    if [s for s in streams if (s.get('publish') or {}).get('active')]:
        return 'production stream live'
    return None


def guard():
    if not cfg['guard']:
        return
    why = prod_busy()
    if why:
        log('ABORT:', why)
        kill_all()
        print('ABORTED ' + why, flush=True)
        sys.exit(3)


def spawn(args, out=None):
    p = subprocess.Popen(['nice', '-n', '19'] + args, stdout=open(out, 'w') if out else subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, cwd=cfg['dir'])
    started.append(p)
    return p


def ticks(pid):
    with open('/proc/%d/stat' % pid) as f:
        s = f.read().rsplit(')', 1)[1].split()
    return int(s[11]) + int(s[12])


def status_mb(pid, key):
    try:
        for line in open('/proc/%d/status' % pid):
            if line.startswith(key):
                return int(line.split()[1]) / 1024.0
    except Exception:
        pass
    return None


def host_busy():
    v = list(map(int, open('/proc/stat').readline().split()[1:]))
    return sum(v), v[3] + v[4]


def src_path(name):
    # sources are cached per frame rate; the 30 fps ones keep their original names
    suffix = '' if cfg['fps'] == 30 else '_%dfps' % cfg['fps']
    return '%s/%s%s.mp4' % (cfg['dir'], name, suffix)


def gen_source(name):
    size, rate_k, noise, preset = SOURCES[name]
    path = src_path(name)
    if os.path.exists(path):
        return
    vf = 'testsrc2=size=%s:rate=%d' % (size, cfg['fps'])
    if noise:
        vf += ',noise=alls=30:allf=t+u'
    log('generating source', name)
    subprocess.run(
        ['nice', '-n', '19', cfg['ffmpeg_src'], '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', vf,
         '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '60',
         '-c:v', 'libx264', '-preset', preset, '-b:v', '%dk' % rate_k, '-maxrate', '%dk' % rate_k,
         '-bufsize', '%dk' % (rate_k * 2), '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
         '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000', path],
        check=True)


def srs_conf(port):
    path = '%s/srs_%d.conf' % (cfg['dir'], port)
    hub_srt = port == HUB and cfg['origin'] == 'srt'
    with open(path, 'w') as f:
        f.write('listen 127.0.0.1:%d;\nmax_connections 2000;\ndaemon off;\nsrs_log_tank console;\n'
                'srs_log_level error;\npid ./objs/srs_%d.pid;\n' % (port, port))
        if hub_srt:
            f.write('srt_server {\n enabled on;\n listen %d;\n passphrase %s;\n}\n' % (SRT, cfg['pass']))
        f.write('vhost __defaultVhost__ {\n')
        if hub_srt:
            f.write(' srt {\n  enabled on;\n  srt_to_rtmp off;\n }\n')
        f.write('}\n')
    return path


def srt_url(mode):
    # same options as srtPullUrl()/srtPublishUrl() in src/utils/srs.ts
    base = 'srt://127.0.0.1:%d?streamid=#!::r=live/in,m=%s' % (SRT, mode)
    if mode == 'request':
        base += '&latency=200000&transtype=live&timeout=600000000'
    return '%s&passphrase=%s&pbkeylen=16' % (base, cfg['pass'])


pub = {'src': None, 'p': None}


def ensure_publisher(src):
    if pub['src'] == src and pub['p'].poll() is None:
        return
    if pub['p']:
        pub['p'].kill()
        pub['p'].wait()
        started.remove(pub['p'])
        time.sleep(3)
    sink = ['-f', 'flv', 'rtmp://127.0.0.1:%d/live/in' % HUB] if cfg['origin'] == 'rtmp' \
        else ['-f', 'mpegts', srt_url('publish')]
    pub['p'] = spawn([cfg['ffmpeg'], '-loglevel', 'error', '-re', '-stream_loop', '-1',
                      '-i', src_path(src), '-c', 'copy'] + sink)
    pub['src'] = src
    time.sleep(8)


def out_cmd(tag, i, vargs, aargs, audio_track):
    # mirrors buildFfmpegArgs() for an RTMP destination
    pull = ['-i', 'rtmp://127.0.0.1:%d/live/in' % HUB] if cfg['origin'] == 'rtmp' \
        else ['-readrate', '1', '-i', srt_url('request')]
    maps = ['-map', '0:v:0?', '-map', '0:a:0' if audio_track else '0:a:0?']
    return [cfg['ffmpeg'], '-nostats', '-loglevel', 'warning', '-stats_period', '3',
            '-fflags', '+discardcorrupt', '-err_detect', 'crccheck+bitstream', '-rw_timeout', '600000000',
            *pull, '-progress', 'pipe:1', *maps, *vargs, *aargs,
            '-f', 'flv', 'rtmp://127.0.0.1:%d/live/%s_%d' % (SINK, tag, i)]


def run_case(case, hub_pid, sink_pid):
    name, src, n, v, audio = case
    tag = '%s_%s' % (name, src)
    aargs = A_COPY if audio == 'copy' else (A_AAC_SRT if cfg['origin'] == 'srt' else A_AAC)
    guard()
    ensure_publisher(src)
    prog = ['%s/prog_%s_%d.txt' % (cfg['dir'], tag, i) for i in range(n)]
    procs = []
    for i in range(n):
        procs.append(spawn(out_cmd(tag, i, V[v], aargs, audio == 'aac'), prog[i]))
        if n > 5:
            time.sleep(0.3)
    warm, run = cfg['warm'], cfg['run']
    time.sleep(warm)
    guard()
    t0 = {p.pid: ticks(p.pid) for p in procs if p.poll() is None}
    h0, s0, hb0 = ticks(hub_pid), ticks(sink_pid), host_busy()
    time.sleep(run / 2)
    guard()
    time.sleep(run / 2)
    hb1 = host_busy()
    alive = [p for p in procs if p.poll() is None]
    cpu = [(ticks(p.pid) - t0[p.pid]) / CLK / run for p in alive if p.pid in t0]
    rss = [status_mb(p.pid, 'VmRSS') for p in alive]
    hwm = [status_mb(p.pid, 'VmHWM') for p in alive]
    speeds = []
    for f in prog:
        try:
            last = [line for line in open(f) if line.startswith('speed=')]
            if last:
                speeds.append(float(last[-1].strip().split('=')[1].rstrip('x') or 0))
        except Exception:
            pass
    dt, di = hb1[0] - hb0[0], hb1[1] - hb0[1]
    res = {
        'origin': cfg['origin'], 'case': name, 'src': src, 'n': n, 'alive': '%d/%d' % (len(alive), n),
        'cpu_per_proc_cores': round(sum(cpu) / max(len(cpu), 1), 3),
        'cpu_total_cores': round(sum(cpu), 3),
        'rss_mb_avg': round(sum(rss) / len(rss), 1) if rss else None,
        'hwm_mb_max': round(max(hwm), 1) if hwm else None,
        'hub_srs_cores': round((ticks(hub_pid) - h0) / CLK / run, 3),
        'sink_srs_cores': round((ticks(sink_pid) - s0) / CLK / run, 3),
        'host_util_pct': round(100.0 * (dt - di) / dt, 1),
        # null means no progress data arrived: do not trust that case
        'min_speed': min(speeds) if speeds else None,
    }
    for p in procs:
        p.kill()
    for p in procs:
        p.wait()
        started.remove(p)
    print('RESULT ' + json.dumps(res), flush=True)
    time.sleep(4)


def select_cases(spec):
    if not spec:
        return CASES
    want = {s.strip() for s in spec.split(',') if s.strip()}
    picked = [c for c in CASES if c[0] in want or '%s@%s' % (c[0], c[1]) in want]
    if not picked:
        sys.exit('no case matches %r; see --list' % spec)
    return picked


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--origin', choices=['rtmp', 'srt'], help='protocol outputs pull the input over')
    ap.add_argument('--cases', help='comma-separated case names or name@source (default: all)')
    ap.add_argument('--list', action='store_true', help='list the case ids and exit')
    ap.add_argument('--warm', type=int, default=15, help='seconds before measuring (default 15)')
    ap.add_argument('--run', type=int, default=45, help='seconds measured per case (default 45)')
    ap.add_argument('--fps', type=int, default=30,
                    help='frame rate of the generated sources (default 30; the production feeds are 50)')
    ap.add_argument('--workdir', default='/tmp/bench')
    ap.add_argument('--ffmpeg', default=shutil.which('ffmpeg'))
    ap.add_argument('--srs', default=shutil.which('srs'))
    ap.add_argument('--no-guard', action='store_true', help='skip the production-activity guard')
    a = ap.parse_args()
    if a.list:
        for c in CASES:
            print('%s@%s' % (c[0], c[1]))
        return
    if not a.origin:
        ap.error('--origin is required')
    if not a.ffmpeg or not a.srs:
        ap.error('ffmpeg and srs must be on PATH or given with --ffmpeg and --srs')
    cases = select_cases(a.cases)
    cfg.update(origin=a.origin, dir=a.workdir, fps=a.fps, warm=a.warm, run=a.run, guard=not a.no_guard,
               ffmpeg_src=a.ffmpeg, ffmpeg=a.workdir + '/ffmpeg-bench')
    cfg['pass'] = secrets.token_hex(8)  # throwaway SRT passphrase for the private hub
    os.makedirs(a.workdir + '/objs', exist_ok=True)
    guard()
    shutil.copy(a.ffmpeg, cfg['ffmpeg'])
    srs_bench = a.workdir + '/srs-bench'
    shutil.copy(a.srs, srs_bench)
    for s in sorted({c[1] for c in cases}):
        gen_source(s)
    hub = spawn([srs_bench, '-c', srs_conf(HUB)], '%s/srs_%d.log' % (a.workdir, HUB))
    sink = spawn([srs_bench, '-c', srs_conf(SINK)], '%s/srs_%d.log' % (a.workdir, SINK))
    time.sleep(3)
    for port, proc in ((HUB, hub), (SINK, sink)):
        if proc.poll() is not None:
            log('SRS on port %d exited at startup (is --srs the real binary, not a service wrapper?):' % port)
            with open('%s/srs_%d.log' % (a.workdir, port)) as f:
                print(''.join(f.readlines()[-8:]), flush=True)
            kill_all()
            sys.exit(2)
    try:
        for c in cases:
            log('case', c[0], c[1])
            run_case(c, hub.pid, sink.pid)
    finally:
        kill_all()
    print('DONE', flush=True)


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, lambda *args: (kill_all(), sys.exit(1)))
    main()
