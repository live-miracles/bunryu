'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const publicDir = path.join(__dirname, '..', 'public');
const manifest = JSON.parse(fs.readFileSync(path.join(publicDir, 'manifest.webmanifest'), 'utf8'));

function pngSize(file) {
    const buf = fs.readFileSync(file);
    assert.equal(buf.subarray(1, 4).toString('ascii'), 'PNG', `${file} is not a PNG`);
    return `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
}

describe('installable app manifest', () => {
    test('has what Chrome needs to offer install', () => {
        assert.ok(manifest.name);
        assert.equal(manifest.start_url, '/');
        assert.equal(manifest.display, 'standalone');
        const sizes = manifest.icons.map((i) => i.sizes);
        assert.ok(sizes.includes('192x192') && sizes.includes('512x512'));
        assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'));
    });

    test('every icon exists, is a PNG and has its declared size', () => {
        for (const icon of manifest.icons) {
            assert.equal(pngSize(path.join(publicDir, icon.src)), icon.sizes, icon.src);
        }
    });

    for (const page of ['index.html', 'login.html']) {
        test(`${page} links the manifest with credentials`, () => {
            const html = fs.readFileSync(path.join(publicDir, page), 'utf8');
            assert.match(
                html,
                /<link rel="manifest" href="manifest\.webmanifest" crossorigin="use-credentials" \/>/,
            );
            assert.ok(html.includes(`content="${manifest.theme_color}"`));
        });
    }
});
