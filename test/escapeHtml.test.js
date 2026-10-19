'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
    escapeHtml,
    fmtMs,
    fmtUnder10,
    formatBitrate,
    formatBytes,
    formatCpuPercent,
} = require('../public/ts/core/utils');

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

describe('fmtUnder10 and the formatters built on it', () => {
    test('one decimal under 10, whole from 10, and 9.96 does not print 10.0', () => {
        assert.equal(fmtUnder10(5.25), '5.3');
        assert.equal(fmtUnder10(9.96), '10');
        assert.equal(fmtUnder10(10.4), '10');
        assert.equal(fmtUnder10(523.4), '523');
    });

    test('bitrate keeps the unit switch and applies the rule per unit', () => {
        assert.equal(formatBitrate(null), '—');
        assert.equal(formatBitrate(5.24), '5.2 kbps');
        assert.equal(formatBitrate(523.4), '523 kbps');
        assert.equal(formatBitrate(999.7), '1.0 Mbps');
        assert.equal(formatBitrate(4500), '4.5 Mbps');
        assert.equal(formatBitrate(12_300), '12 Mbps');
        assert.equal(formatBitrate(2_500_000), '2.5 Gbps');
    });

    test('memory applies the rule to KB, MB and GB', () => {
        assert.equal(formatBytes(512 * 1024), '512 KB');
        assert.equal(formatBytes(4.5 * 1024 ** 2), '4.5 MB');
        assert.equal(formatBytes(48 * 1024 ** 2), '48 MB');
        assert.equal(formatBytes(1.5 * 1024 ** 3), '1.5 GB');
        assert.equal(formatBytes(12 * 1024 ** 3), '12 GB');
    });

    test('milliseconds', () => {
        assert.equal(fmtMs(null), '—');
        assert.equal(fmtMs(3.24), '3.2 ms');
        assert.equal(fmtMs(42.4), '42 ms');
    });
});
