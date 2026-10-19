'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { setHtmlKeepScroll } = require('../public/ts/core/utils');

// A container whose innerHTML setter replaces its scrollable children with
// fresh ones at scrollLeft 0, like a browser re-render does.
function fakeContainer(count) {
    const make = (n) => Array.from({ length: n }, () => ({ scrollLeft: 0 }));
    const el = {
        children: make(count),
        querySelectorAll(selector) {
            assert.equal(selector, '.overflow-x-auto');
            return this.children;
        },
        set innerHTML(html) {
            el.html = html;
            el.children = make(Number(html.split(':')[1]));
        },
    };
    return el;
}

describe('setHtmlKeepScroll', () => {
    test('restores each scroller position after the re-render', () => {
        const el = fakeContainer(3);
        el.children[0].scrollLeft = 40;
        el.children[2].scrollLeft = 120;
        setHtmlKeepScroll(el, 'tables:3');
        assert.deepEqual(
            el.children.map((c) => c.scrollLeft),
            [40, 0, 120],
        );
    });

    test('skips the restore when the number of scrollers changed', () => {
        const el = fakeContainer(2);
        el.children[0].scrollLeft = 40;
        setHtmlKeepScroll(el, 'tables:3');
        assert.deepEqual(
            el.children.map((c) => c.scrollLeft),
            [0, 0, 0],
        );
    });
});
