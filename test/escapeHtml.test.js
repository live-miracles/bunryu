'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { escapeHtml, formatCpuPercent } = require('../public/ts/core/utils');

describe('escapeHtml', () => {
    test('escapes markup, both quote styles and ampersands', () => {
        assert.equal(
            escapeHtml(`<img src=x onerror="a()" onload='b()'>&`),
            '&lt;img src=x onerror=&quot;a()&quot; onload=&#39;b()&#39;&gt;&amp;',
        );
    });

    test('a value interpolated into a single-quoted attribute cannot break out', () => {
        const html = `<input value='${escapeHtml("x' autofocus onfocus='alert(1)")}'>`;
        assert.ok(!/'\s*autofocus/.test(html));
    });
});

describe('formatCpuPercent', () => {
    test('shows one decimal under 10% and whole numbers from 10%', () => {
        assert.equal(formatCpuPercent(0), '0.0%');
        assert.equal(formatCpuPercent(0.5), '0.5%');
        assert.equal(formatCpuPercent(1.4), '1.4%');
        assert.equal(formatCpuPercent(9.9), '9.9%');
        assert.equal(formatCpuPercent(10), '10%');
        assert.equal(formatCpuPercent(41.6), '42%');
        assert.equal(formatCpuPercent(150), '150%');
    });
});
