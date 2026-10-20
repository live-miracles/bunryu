'use strict';

// Every route the server registers must appear in docs/4-reference/1-api.md,
// and every route documented there must exist, so the reference cannot drift.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function sourceFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return sourceFiles(full);
        return entry.name.endsWith('.ts') ? [full] : [];
    });
}

// Path parameter names differ between code and docs (:pipelineId vs :id).
const normalize = (method, route) => `${method.toUpperCase()} ${route.replace(/:\w+/g, ':p')}`;

function registeredRoutes() {
    const routes = new Set();
    const pattern = /\bapp\.(get|post|put|delete)\(\s*'(\/api\/[^']*)'/g;
    for (const file of sourceFiles(path.join(ROOT, 'src'))) {
        for (const [, method, route] of fs.readFileSync(file, 'utf8').matchAll(pattern)) {
            routes.add(normalize(method, route));
        }
    }
    return routes;
}

function documentedRoutes() {
    const doc = fs.readFileSync(path.join(ROOT, 'docs/4-reference/1-api.md'), 'utf8');
    const routes = new Set();
    for (const [, method, route] of doc.matchAll(/^\| (GET|POST|PUT|DELETE) \| `([^`]+)` \|/gm)) {
        routes.add(normalize(method, route));
    }
    return routes;
}

test('the API reference lists exactly the registered routes', () => {
    const registered = registeredRoutes();
    const documented = documentedRoutes();
    assert.ok(registered.size > 30, 'route scan found too few routes');
    assert.deepEqual(
        [...registered].filter((r) => !documented.has(r)).sort(),
        [],
        'routes missing from docs/4-reference/1-api.md',
    );
    assert.deepEqual(
        [...documented].filter((r) => !registered.has(r)).sort(),
        [],
        'documented routes that no longer exist',
    );
});
