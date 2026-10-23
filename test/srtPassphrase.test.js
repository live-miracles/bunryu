'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunryu-srtpassphrase-'));
const originalCwd = process.cwd();
process.chdir(tempDir);
fs.writeFileSync(
    path.join(tempDir, 'bunryu.json'),
    JSON.stringify({
        port: 8080,
        database_path: './db.sqlite',
        srs_config_path: './srs.conf',
        ffmpeg_path: 'ffmpeg',
        ffprobe_path: 'ffprobe',
    }),
    'utf8',
);

after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

const {
    generateSrtPassphrase,
    replaceSrsPassphrase,
    replaceRelayPassphrase,
    writeSrtPassphrase,
} = require('../src/utils/srtPassphrase');

const SRS_CONF = `listen 1935;
srt_server {
    enabled on;
    listen          10080;
    # Must match "passphrase" in goryu.json; '#' starts a comment.
    passphrase      old-passphrase-value;
}
vhost __defaultVhost__ {
    srt { enabled on; }
}
`;
const RELAY_JSON = JSON.stringify(
    { input_port: 10081, passphrase: 'old-passphrase-value' },
    null,
    4,
);

function writeConfigs(srs = SRS_CONF, relay = RELAY_JSON) {
    fs.writeFileSync(path.join(tempDir, 'srs.conf'), srs);
    fs.writeFileSync(path.join(tempDir, 'goryu.json'), relay);
}

describe('generateSrtPassphrase', () => {
    test('is 32 alphanumeric characters and differs per call', () => {
        const a = generateSrtPassphrase();
        const b = generateSrtPassphrase();
        assert.match(a, /^[A-Za-z0-9]{32}$/);
        assert.notEqual(a, b);
    });
});

describe('replaceSrsPassphrase', () => {
    test('changes only the directive in the srt_server block', () => {
        const out = replaceSrsPassphrase(SRS_CONF, 'NewPassphrase1234');
        assert.equal(out, SRS_CONF.replace('old-passphrase-value;', 'NewPassphrase1234;'));
    });

    test('also sets an empty (disabled) passphrase', () => {
        const out = replaceSrsPassphrase(
            'srt_server {\n    passphrase ;\n}\n',
            'NewPassphrase1234',
        );
        assert.match(out, /passphrase {1}NewPassphrase1234;/);
    });

    test('keeps a $-pattern in the value literal', () => {
        const out = replaceSrsPassphrase(SRS_CONF, 'a$&b$1cdefghij');
        assert.ok(out.includes('passphrase      a$&b$1cdefghij;'));
    });

    test('throws without a srt_server block or a passphrase directive', () => {
        assert.throws(() => replaceSrsPassphrase('listen 1935;\n', 'x'), /no srt_server block/);
        assert.throws(
            () => replaceSrsPassphrase('srt_server {\n    listen 10080;\n}\n', 'x'),
            /no "passphrase" directive/,
        );
    });
});

describe('replaceRelayPassphrase', () => {
    test('sets the passphrase and keeps the other keys', () => {
        const out = JSON.parse(replaceRelayPassphrase(RELAY_JSON, 'NewPassphrase1234'));
        assert.deepEqual(out, { input_port: 10081, passphrase: 'NewPassphrase1234' });
    });

    test('throws for invalid JSON or a non-object', () => {
        assert.throws(() => replaceRelayPassphrase('{nope', 'x'), SyntaxError);
        assert.throws(() => replaceRelayPassphrase('[]', 'x'), /not a JSON object/);
    });
});

describe('writeSrtPassphrase', () => {
    test('writes both files, keeps their mode and leaves no temp file', () => {
        writeConfigs();
        fs.chmodSync(path.join(tempDir, 'srs.conf'), 0o640);
        writeSrtPassphrase('NewPassphrase1234');

        assert.match(fs.readFileSync(path.join(tempDir, 'srs.conf'), 'utf8'), /NewPassphrase1234;/);
        assert.equal(
            JSON.parse(fs.readFileSync(path.join(tempDir, 'goryu.json'), 'utf8')).passphrase,
            'NewPassphrase1234',
        );
        assert.equal(fs.statSync(path.join(tempDir, 'srs.conf')).mode & 0o777, 0o640);
        assert.deepEqual(
            fs.readdirSync(tempDir).filter((f) => f.endsWith('.tmp')),
            [],
        );
    });

    test('changes neither file when goryu.json cannot be parsed', () => {
        writeConfigs(SRS_CONF, '{broken');
        assert.throws(() => writeSrtPassphrase('NewPassphrase1234'));
        assert.equal(fs.readFileSync(path.join(tempDir, 'srs.conf'), 'utf8'), SRS_CONF);
        assert.equal(fs.readFileSync(path.join(tempDir, 'goryu.json'), 'utf8'), '{broken');
    });

    test('changes neither file when srs.conf has no passphrase directive', () => {
        writeConfigs('srt_server {\n    listen 10080;\n}\n');
        assert.throws(() => writeSrtPassphrase('NewPassphrase1234'), /no "passphrase" directive/);
        assert.equal(
            JSON.parse(fs.readFileSync(path.join(tempDir, 'goryu.json'), 'utf8')).passphrase,
            'old-passphrase-value',
        );
    });

    test('puts srs.conf back when the goryu.json write fails', () => {
        writeConfigs();
        const relayPath = path.join(tempDir, 'goryu.json');
        const realRename = fs.renameSync;
        fs.renameSync = (from, to) => {
            if (to === relayPath) throw new Error('disk full');
            return realRename(from, to);
        };
        try {
            assert.throws(() => writeSrtPassphrase('NewPassphrase1234'), /disk full/);
        } finally {
            fs.renameSync = realRename;
        }
        assert.equal(fs.readFileSync(path.join(tempDir, 'srs.conf'), 'utf8'), SRS_CONF);
        assert.equal(fs.readFileSync(relayPath, 'utf8'), RELAY_JSON);
        assert.deepEqual(
            fs.readdirSync(tempDir).filter((f) => f.endsWith('.tmp')),
            [],
        );
    });
});
