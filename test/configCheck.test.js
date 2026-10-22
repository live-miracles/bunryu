'use strict';

const { describe, test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunryu-configcheck-'));
const originalCwd = process.cwd();
const file = (name) => path.join(tempDir, name);

process.chdir(tempDir);
after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

// The three readers cache their first successful read at module scope, so every
// test re-requires them against its own fixture files.
function load() {
    for (const mod of ['appConfig', 'srsConfig', 'relayConfig', 'configCheck']) {
        delete require.cache[require.resolve(`../src/utils/${mod}`)];
    }
    return require('../src/utils/configCheck');
}

function writeValidFiles() {
    for (const name of ['bunryu.json', 'srs.conf', 'goryu.json']) {
        fs.rmSync(file(name), { recursive: true, force: true });
    }
    fs.writeFileSync(file('bunryu.json'), JSON.stringify({ srs_config_path: './srs.conf' }));
    fs.writeFileSync(file('srs.conf'), 'listen 1935;\n');
    fs.writeFileSync(file('goryu.json'), '{}');
}

function replaceWithDirectory(name) {
    fs.rmSync(file(name), { force: true });
    fs.mkdirSync(file(name));
}

describe('isPermanentConfigError', () => {
    const { isPermanentConfigError } = load();
    const withCode = (code) => Object.assign(new Error('read failed'), { code });

    test('a missing file or invalid JSON is permanent, also as the cause of a wrapper', () => {
        assert.equal(isPermanentConfigError(withCode('ENOENT')), true);
        assert.equal(isPermanentConfigError(new SyntaxError('bad json')), true);
        assert.equal(
            isPermanentConfigError(new Error('Failed to read', { cause: withCode('ENOENT') })),
            true,
        );
    });

    test('other errors may pass on the next start', () => {
        assert.equal(isPermanentConfigError(withCode('EIO')), false);
        assert.equal(isPermanentConfigError(withCode('EMFILE')), false);
        assert.equal(isPermanentConfigError(new Error('plain')), false);
        assert.equal(isPermanentConfigError('not an error'), false);
    });
});

describe('startup config check', () => {
    beforeEach(writeValidFiles);

    test('passes when all three files are readable', () => {
        assert.doesNotThrow(() => load().checkConfigFiles());
    });

    for (const [name, label] of [
        ['bunryu.json', 'app config'],
        ['srs.conf', 'SRS config'],
        ['goryu.json', 'relay config'],
    ]) {
        test(`${name}: missing is permanent and names the file`, () => {
            fs.rmSync(file(name));
            const { checkConfigFiles, isPermanentConfigError } = load();
            assert.throws(
                () => checkConfigFiles(),
                (err) => {
                    assert.match(err.message, new RegExp(`Failed to read ${label} .*${name}`));
                    return isPermanentConfigError(err);
                },
            );
        });

        test(`${name}: an unreadable file that is present is not permanent`, () => {
            replaceWithDirectory(name);
            const { checkConfigFiles, isPermanentConfigError } = load();
            assert.throws(
                () => checkConfigFiles(),
                (err) => !isPermanentConfigError(err),
            );
        });
    }

    for (const name of ['bunryu.json', 'goryu.json']) {
        test(`${name}: invalid JSON is permanent`, () => {
            fs.writeFileSync(file(name), '{ not json');
            const { checkConfigFiles, isPermanentConfigError } = load();
            assert.throws(
                () => checkConfigFiles(),
                (err) => isPermanentConfigError(err),
            );
        });
    }
});

describe('exitIfConfigUnusable', () => {
    beforeEach(writeValidFiles);

    test('does nothing when the files are fine', (t) => {
        const exit = t.mock.method(process, 'exit', () => {});
        load().exitIfConfigUnusable();
        assert.equal(exit.mock.callCount(), 0);
    });

    test('exits 78 with the file named when one is missing', (t) => {
        const exit = t.mock.method(process, 'exit', () => {});
        const error = t.mock.method(console, 'error', () => {});
        fs.rmSync(file('goryu.json'));
        load().exitIfConfigUnusable();
        assert.deepEqual(exit.mock.calls[0].arguments, [78]);
        assert.match(String(error.mock.calls[0].arguments[0]), /goryu\.json/);
    });

    test('rethrows a failure that may pass on a retry, so the process crashes and restarts', (t) => {
        const exit = t.mock.method(process, 'exit', () => {});
        replaceWithDirectory('srs.conf');
        assert.throws(() => load().exitIfConfigUnusable(), /Failed to read SRS config/);
        assert.equal(exit.mock.callCount(), 0);
    });
});
