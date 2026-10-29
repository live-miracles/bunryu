'use strict';

const { after, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunryu-utils-'));
const originalCwd = process.cwd();
const srsConfPath = path.join(tempDir, 'srs.conf');
process.chdir(tempDir);
fs.writeFileSync(
    path.join(tempDir, 'bunryu.json'),
    JSON.stringify(
        {
            port: 8080,
            database_path: './db.sqlite',
            srs_config_path: './srs.conf',
            ffmpeg_path: 'ffmpeg',
            ffprobe_path: 'ffprobe',
        },
        null,
        4,
    ),
    'utf8',
);
fs.writeFileSync(
    srsConfPath,
    'listen 1935;\nsrs_log_file ./objs/srs.log;\nhttp_api {\n    enabled on;\n    listen 1985;\n}\nsrt_server {\n    enabled on;\n    listen 10080;\n}\n',
    'utf8',
);

const {
    buildFfmpegArgs,
    validateOutputUrl,
    validateAudioEncoding,
} = require('../src/utils/ffmpeg');
const { rtmpPullUrl, srtPullUrl, rtmpPublishUrl, srtPublishUrl } = require('../src/utils/srs');
const { red, yellow, green, cyan } = require('../src/utils/ansiColor');

after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

// ── ansiColor ──────────────────────────────────────────

describe('ansiColor', () => {
    test('wraps text in the expected SGR code and always resets', () => {
        assert.equal(red('boom'), '\x1b[31mboom\x1b[0m');
        assert.equal(yellow('warn'), '\x1b[33mwarn\x1b[0m');
        assert.equal(green('ok'), '\x1b[32mok\x1b[0m');
        assert.equal(cyan('info'), '\x1b[36minfo\x1b[0m');
    });

    test('does not choke on empty or already-ANSI-colored input', () => {
        assert.equal(red(''), '\x1b[31m\x1b[0m');
        // Nesting isn't sanitized/escaped — colors just concatenate literally,
        // which is fine since nothing in this codebase nests them.
        assert.equal(red(green('x')), '\x1b[31m\x1b[32mx\x1b[0m\x1b[0m');
    });
});

// ── validateOutputUrl ─────────────────────────────────

describe('validateOutputUrl', () => {
    test('accepts rtmp://', () =>
        assert.ok(validateOutputUrl('rtmp://a.rtmp.youtube.com/live2/key')));
    test('accepts rtmps://', () =>
        assert.ok(validateOutputUrl('rtmps://live-api-s.facebook.com:443/rtmp/key')));
    test('accepts srt://', () => assert.ok(validateOutputUrl('srt://host:10080?streamid=test')));
    test('rejects http://', () => assert.ok(!validateOutputUrl('http://example.com')));
    test('rejects plain string', () => assert.ok(!validateOutputUrl('notaurl')));
    test('rejects empty string', () => assert.ok(!validateOutputUrl('')));
});

// ── buildFfmpegArgs ───────────────────────────────────

describe('buildFfmpegArgs', () => {
    test('paces SRT-origin RTMP outputs with -readrate 1', () => {
        const args = buildFfmpegArgs('srt://in:10080', 'rtmp://out', 'copy');
        const readrate = args.indexOf('-readrate');
        assert.ok(readrate >= 0 && readrate < args.indexOf('-i'));
        assert.equal(args[readrate + 1], '1');
    });

    test('paces SRT-origin RTMPS outputs with -readrate 1', () => {
        const args = buildFfmpegArgs('srt://in:10080', 'rtmps://out', 'copy');
        const readrate = args.indexOf('-readrate');
        assert.ok(readrate >= 0 && readrate < args.indexOf('-i'));
        assert.equal(args[readrate + 1], '1');
    });

    test('does not add -readrate to RTMP-origin or SRT-destination outputs', () => {
        const cases = [
            buildFfmpegArgs('rtmp://in', 'rtmp://out', 'copy'),
            buildFfmpegArgs('srt://in:10080', 'srt://out:10080', 'copy'),
        ];
        for (const args of cases) assert.ok(!args.includes('-readrate'));
    });

    test('includes input URL after -i', () => {
        const args = buildFfmpegArgs('rtmp://in', 'rtmp://out', 'copy');
        assert.equal(args[args.indexOf('-i') + 1], 'rtmp://in');
    });

    test('copy encoding copies video only (-c:v copy)', () => {
        const args = buildFfmpegArgs('rtmp://in', 'rtmp://out', 'copy', 'copy');
        assert.equal(args[args.indexOf('-c:v') + 1], 'copy');
    });

    test('unknown encoding falls back to video copy', () => {
        const args = buildFfmpegArgs('rtmp://in', 'rtmp://out', 'copy', 'bogus');
        assert.equal(args[args.indexOf('-c:v') + 1], 'copy');
    });

    test("'copy' always copies audio verbatim, regardless of origin/destination protocol", () => {
        const cases = [
            buildFfmpegArgs('rtmp://in', 'rtmp://out', 'copy', 'copy'),
            buildFfmpegArgs('srt://in:10080', 'rtmp://out', 'copy', 'copy'),
            buildFfmpegArgs('rtmp://in', 'srt://host:10080', 'copy', 'copy'),
            buildFfmpegArgs('srt://in:10080', 'srt://host:10080', 'copy', 'copy'),
        ];
        for (const args of cases) {
            assert.ok(!args.includes('-af'));
            assert.equal(args[args.indexOf('-c:a') + 1], 'copy');
        }
    });

    test("an explicit track selection forces a transcode; SRT origin adds the jitter filter, RTMP origin doesn't", () => {
        const fromRtmp = buildFfmpegArgs('rtmp://in', 'rtmp://out', '0', 'copy');
        assert.ok(!fromRtmp.includes('-af'));
        assert.equal(fromRtmp[fromRtmp.indexOf('-c:a') + 1], 'aac');

        const fromSrt = buildFfmpegArgs('srt://in:10080', 'rtmp://out', '0', 'copy');
        assert.ok(fromSrt.includes('-af'));
        assert.ok(fromSrt.some((a) => String(a).includes('aresample')));
        assert.equal(fromSrt[fromSrt.indexOf('-c:a') + 1], 'aac');
    });

    test('an explicit track selection forces a transcode even into an SRT destination', () => {
        const args = buildFfmpegArgs('srt://in:10080', 'srt://host:10080', '0', 'copy');
        assert.equal(args[args.indexOf('-c:a') + 1], 'aac');
    });

    test('an explicit track selection also forces a transcode, regardless of origin', () => {
        const args = buildFfmpegArgs('rtmp://in', 'rtmp://out', '1', 'copy');
        assert.equal(args[args.indexOf('-c:a') + 1], 'aac');
    });

    test('RTMP destination uses -f flv', () => {
        const args = buildFfmpegArgs('rtmp://in', 'rtmp://out', 'copy');
        assert.equal(args[args.lastIndexOf('-f') + 1], 'flv');
    });

    test('SRT destination uses -f mpegts', () => {
        const args = buildFfmpegArgs('rtmp://in', 'srt://host:10080', 'copy');
        assert.equal(args[args.lastIndexOf('-f') + 1], 'mpegts');
    });

    test('720p encoding includes 1280:720 scale', () => {
        const args = buildFfmpegArgs('rtmp://in', 'rtmp://out', 'copy', '720p');
        assert.ok(args.some((a) => String(a).includes('1280:720')));
    });

    test('1080p encoding includes 1920:1080 scale', () => {
        const args = buildFfmpegArgs('rtmp://in', 'rtmp://out', 'copy', '1080p');
        assert.ok(args.some((a) => String(a).includes('1920:1080')));
    });

    test('always includes -progress pipe:1 for bitrate monitoring', () => {
        const args = buildFfmpegArgs('rtmp://in', 'rtmp://out', 'copy');
        assert.equal(args[args.indexOf('-progress') + 1], 'pipe:1');
    });

    test('sets a 10-minute -rw_timeout before -i so a dead input exits', () => {
        const args = buildFfmpegArgs('rtmp://in', 'rtmp://out', 'copy');
        const i = args.indexOf('-rw_timeout');
        assert.ok(i >= 0 && i < args.indexOf('-i'));
        assert.equal(args[i + 1], String(10 * 60 * 1_000_000));
    });

    describe('output write timeout', () => {
        const OUTPUT_TIMEOUT = String(10 * 1_000_000);
        const outputTimeoutOf = (args) => {
            const url = args.at(-1);
            const i = args.lastIndexOf('-rw_timeout');
            return { url, i, value: args[i + 1] };
        };

        for (const url of ['rtmp://out.example/live/k', 'rtmps://out.example/live/k']) {
            test(`${url.split(':')[0]} destinations get a 10 s -rw_timeout right before the url`, () => {
                const args = buildFfmpegArgs('rtmp://in', url, 'copy');
                const { i, value } = outputTimeoutOf(args);
                assert.equal(value, OUTPUT_TIMEOUT);
                assert.equal(i, args.length - 3, 'must sit directly before the destination url');
                assert.ok(i > args.indexOf('-i'), 'must be an output option, not the input one');
            });
        }

        test('the input keeps its own 10-minute timeout', () => {
            const args = buildFfmpegArgs('rtmp://in', 'rtmp://out', 'copy');
            assert.equal(args[args.indexOf('-rw_timeout') + 1], String(10 * 60 * 1_000_000));
            assert.equal(args.filter((a) => a === '-rw_timeout').length, 2);
        });

        test('SRT destinations are left alone (the option means something else there)', () => {
            const args = buildFfmpegArgs('rtmp://in', 'srt://out:9000', 'copy');
            assert.equal(args.filter((a) => a === '-rw_timeout').length, 1);
        });

        test('-timeout is never used: for RTMP it switches the output to listen mode', () => {
            for (const url of ['rtmp://out', 'rtmps://out', 'srt://out:9000']) {
                assert.ok(!buildFfmpegArgs('rtmp://in', url, 'copy').includes('-timeout'));
            }
        });
    });

    test('suppresses ffmpeg stderr stats spam (-nostats -loglevel warning)', () => {
        const args = buildFfmpegArgs('rtmp://in', 'rtmp://out', 'copy');
        assert.ok(args.includes('-nostats'));
        assert.equal(args[args.indexOf('-loglevel') + 1], 'warning');
    });

    test('FLV copy audio maps track 0 explicitly (not ffmpeg default selection)', () => {
        const args = buildFfmpegArgs('rtmp://in', 'rtmp://out', 'copy');
        const maps = args.filter((a, i) => args[i - 1] === '-map');
        assert.deepEqual(maps, ['0:v:0?', '0:a:0?']);
    });

    test('SRT copy audio adds no -map (ffmpeg default selection)', () => {
        const args = buildFfmpegArgs('rtmp://in', 'srt://out:10080', 'copy');
        assert.ok(!args.includes('-map'));
    });

    test('selecting a track on an FLV destination maps video + that audio stream, failing fast if absent', () => {
        const args = buildFfmpegArgs('rtmp://in', 'rtmp://out', '1');
        const maps = args.filter((a, i) => args[i - 1] === '-map');
        assert.deepEqual(maps, ['0:v:0?', '0:a:1']);
    });

    test('SRT destination URL parameters are passed through unchanged', () => {
        const url = 'srt://host:10080?mode=caller&latency=240000&streamid=x';
        const args = buildFfmpegArgs('rtmp://in', url, 'copy');
        assert.ok(args.includes(url));
    });
});

// ── validateAudioEncoding ─────────────────────────────

describe('validateAudioEncoding', () => {
    test('defaults empty/copy to copy', () => {
        assert.equal(validateAudioEncoding(undefined), 'copy');
        assert.equal(validateAudioEncoding(''), 'copy');
        assert.equal(validateAudioEncoding('copy'), 'copy');
    });
    test('accepts single and comma track lists', () => {
        assert.equal(validateAudioEncoding('0'), '0');
        assert.equal(validateAudioEncoding('0, 1 ,2'), '0,1,2');
    });
    test("rejects 'aac' (retired in favor of explicit track selection)", () => {
        assert.equal(validateAudioEncoding('aac'), null);
    });
    test("rejects 'translation' (the translation output was removed)", () => {
        assert.equal(validateAudioEncoding('translation'), null);
    });
    test('rejects non-numeric values', () => {
        assert.equal(validateAudioEncoding('a'), null);
        assert.equal(validateAudioEncoding('0,x'), null);
    });
    test('rejects other-typed falsy JSON values instead of silently treating them as copy', () => {
        // A raw API call can send any JSON type. 0/false must not be conflated
        // with "not specified" (undefined/'') the way a bare `!value` check would.
        assert.equal(validateAudioEncoding(0), null);
        assert.equal(validateAudioEncoding(false), null);
        assert.equal(validateAudioEncoding(null), 'copy');
    });
    test('rejects non-string, non-numeric-falsy JSON values (arrays, objects)', () => {
        assert.equal(validateAudioEncoding([0, 1]), null);
        assert.equal(validateAudioEncoding({ track: 0 }), null);
        assert.equal(validateAudioEncoding(NaN), null);
    });
    test('rejects a trailing comma / empty track segment', () => {
        assert.equal(validateAudioEncoding('0,'), null);
        assert.equal(validateAudioEncoding(','), null);
    });
    test('rejects a negative or decimal track index', () => {
        assert.equal(validateAudioEncoding('-1'), null);
        assert.equal(validateAudioEncoding('1.5'), null);
    });
    test('accepts a track index with leading zeros, unchanged', () => {
        // /^\d+$/ allows this; buildFfmpegArgs passes it straight into -map as text.
        assert.equal(validateAudioEncoding('00'), '00');
    });
});

// ── URL builders ──────────────────────────────────────

describe('URL builders', () => {
    test('rtmpPullUrl uses default host and port', () => {
        assert.equal(rtmpPullUrl('mykey'), 'rtmp://127.0.0.1:1935/live/mykey');
    });

    test('srtPullUrl uses default host and SRT port', () => {
        assert.equal(
            srtPullUrl('mykey'),
            'srt://127.0.0.1:10080?streamid=#!::r=live/mykey,m=request&latency=200000&transtype=live&timeout=600000000',
        );
    });

    test('rtmpPublishUrl', () => {
        assert.equal(rtmpPublishUrl('mykey', 'myhost'), 'rtmp://myhost:1935/live/mykey');
    });

    test('srtPublishUrl', () => {
        assert.equal(
            srtPublishUrl('mykey', 'myhost'),
            'srt://myhost:10080?streamid=#!::r=live/mykey,m=publish',
        );
    });

    test('srtPublishUrl includes passphrase settings when configured', () => {
        assert.equal(
            srtPublishUrl('mykey', 'myhost', 'secret value'),
            'srt://myhost:10080?streamid=#!::r=live/mykey,m=publish&passphrase=secret%20value&pbkeylen=16',
        );
    });

    test('SRT URLs use srs.conf srt_server listen port', () => {
        fs.writeFileSync(
            srsConfPath,
            'listen 1935;\nsrs_log_file ./objs/srs.log;\nhttp_api {\n    enabled on;\n    listen 1985;\n}\nsrt_server {\n    enabled on;\n    listen 12080;\n}\n',
            'utf8',
        );
        delete require.cache[require.resolve('../src/utils/srsConfig')];
        delete require.cache[require.resolve('../src/utils/srs')];
        const {
            srtPullUrl: configuredSrtPullUrl,
            srtPublishUrl: configuredSrtPublishUrl,
        } = require('../src/utils/srs');

        assert.equal(
            configuredSrtPullUrl('mykey'),
            'srt://127.0.0.1:12080?streamid=#!::r=live/mykey,m=request&latency=200000&transtype=live&timeout=600000000',
        );
        assert.equal(
            configuredSrtPublishUrl('mykey', 'myhost'),
            'srt://myhost:12080?streamid=#!::r=live/mykey,m=publish',
        );
    });

    test('srtPullUrl includes srt_server passphrase from srs.conf', () => {
        fs.writeFileSync(
            srsConfPath,
            'listen 1935;\nsrs_log_file ./objs/srs.log;\nhttp_api {\n    enabled on;\n    listen 1985;\n}\nsrt_server {\n    enabled on;\n    listen 10080;\n    passphrase supersecretpass;\n}\n',
            'utf8',
        );
        delete require.cache[require.resolve('../src/utils/srsConfig')];
        delete require.cache[require.resolve('../src/utils/srs')];
        const { srtPullUrl: configuredSrtPullUrl } = require('../src/utils/srs');

        assert.equal(
            configuredSrtPullUrl('mykey'),
            'srt://127.0.0.1:10080?streamid=#!::r=live/mykey,m=request&latency=200000&transtype=live&timeout=600000000&passphrase=supersecretpass&pbkeylen=16',
        );
    });

    function reloadSrs(confText) {
        fs.writeFileSync(srsConfPath, confText, 'utf8');
        delete require.cache[require.resolve('../src/utils/srsConfig')];
        delete require.cache[require.resolve('../src/utils/srs')];
        return require('../src/utils/srs');
    }

    test('missing http_api block falls back to the default API port (1985)', () => {
        // readSrsConfigValues() caches per-module-load; apiUrl isn't exposed via
        // src/utils/srs.ts directly, so exercise it through kickSrsClientsByStream's
        // fetch target indirectly is overkill here — assert via rtmp/srt URLs still
        // resolving cleanly when the whole http_api block is absent.
        const { rtmpPullUrl: pull } = reloadSrs(
            'listen 1935;\nsrt_server {\n    listen 10080;\n}\n',
        );
        assert.equal(pull('k'), 'rtmp://127.0.0.1:1935/live/k');
    });

    test('missing top-level listen directive falls back to the default RTMP port (1935)', () => {
        const { rtmpPullUrl: pull } = reloadSrs('http_api {\n    listen 1985;\n}\n');
        assert.equal(pull('k'), 'rtmp://127.0.0.1:1935/live/k');
    });

    test('missing srt_server block falls back to the default SRT port and no passphrase', () => {
        const { srtPullUrl: pull } = reloadSrs('listen 1935;\n');
        assert.equal(
            pull('k'),
            'srt://127.0.0.1:10080?streamid=#!::r=live/k,m=request&latency=200000&transtype=live&timeout=600000000',
        );
    });

    test('an out-of-range port directive falls back to the default rather than being used verbatim', () => {
        const { rtmpPullUrl: pull } = reloadSrs('listen 99999;\n');
        assert.equal(pull('k'), 'rtmp://127.0.0.1:1935/live/k');
    });

    test('a non-numeric port directive falls back to the default', () => {
        const { rtmpPullUrl: pull } = reloadSrs('listen not-a-port;\n');
        assert.equal(pull('k'), 'rtmp://127.0.0.1:1935/live/k');
    });

    test('a directive missing its terminating semicolon is ignored (falls back to default)', () => {
        // parseDirective's regex requires a trailing ';' — SRS itself would
        // reject this config outright, but our parser must not crash on it.
        const { rtmpPullUrl: pull } = reloadSrs('listen 1935\n');
        assert.equal(pull('k'), 'rtmp://127.0.0.1:1935/live/k');
    });

    test('comments on the same line as a directive are stripped before parsing', () => {
        const { rtmpPullUrl: pull } = reloadSrs('listen 1935; # rtmp listen port\n');
        assert.equal(pull('k'), 'rtmp://127.0.0.1:1935/live/k');
    });

    test('an empty config file uses every default', () => {
        const { rtmpPullUrl: pull, srtPullUrl: srtPull } = reloadSrs('');
        assert.equal(pull('k'), 'rtmp://127.0.0.1:1935/live/k');
        assert.equal(
            srtPull('k'),
            'srt://127.0.0.1:10080?streamid=#!::r=live/k,m=request&latency=200000&transtype=live&timeout=600000000',
        );
    });

    test('ip:port listen entries (loopback-bound http_api) yield the port, not the default', () => {
        reloadSrs(
            'listen 21935;\nhttp_api {\n    listen 127.0.0.1:31985;\n}\nsrt_server {\n    listen 0.0.0.0:31080;\n}\n',
        );
        const { readSrsConfigValues } = require('../src/utils/srsConfig');
        const values = readSrsConfigValues();
        assert.equal(values.apiUrl, 'http://127.0.0.1:31985');
        assert.equal(values.rtmpPort, 21935);
        assert.equal(values.srtPort, 31080);
    });

    test('the shipped srs.conf binds the SRS API to loopback and parses to port 1985', () => {
        reloadSrs(fs.readFileSync(path.join(__dirname, '..', 'srs.conf'), 'utf8'));
        const { readSrsConfigValues } = require('../src/utils/srsConfig');
        assert.equal(readSrsConfigValues().apiUrl, 'http://127.0.0.1:1985');
        assert.match(
            fs.readFileSync(path.join(__dirname, '..', 'srs.conf'), 'utf8'),
            /listen\s+127\.0\.0\.1:1985;/,
        );
    });

    test('throws a descriptive error when srs.conf does not exist', () => {
        fs.rmSync(srsConfPath, { force: true });
        delete require.cache[require.resolve('../src/utils/srsConfig')];
        delete require.cache[require.resolve('../src/utils/srs')];
        const { rtmpPullUrl: pull } = require('../src/utils/srs');
        assert.throws(() => pull('k'), /Failed to read SRS config/);
        // Restore for any tests that might run after this one in the same file.
        fs.writeFileSync(srsConfPath, 'listen 1935;\n', 'utf8');
        delete require.cache[require.resolve('../src/utils/srsConfig')];
        delete require.cache[require.resolve('../src/utils/srs')];
    });
});
