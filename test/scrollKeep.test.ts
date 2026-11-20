import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setHtmlKeepScroll } from '../public/ts/core/utils';

interface Scroller {
    scrollLeft: number;
}

// The parts of an element setHtmlKeepScroll touches.
interface FakeContainer {
    children: Scroller[];
    html?: string;
    querySelectorAll(selector: string): Scroller[];
    innerHTML: string;
}

// A container whose innerHTML setter replaces its scrollable children with
// fresh ones at scrollLeft 0, like a browser re-render does.
function fakeContainer(count: number): FakeContainer {
    const make = (n: number): Scroller[] => Array.from({ length: n }, () => ({ scrollLeft: 0 }));
    const el: FakeContainer = {
        children: make(count),
        querySelectorAll(selector: string) {
            assert.equal(selector, '.overflow-x-auto');
            return this.children;
        },
        set innerHTML(html: string) {
            el.html = html;
            el.children = make(Number(html.split(':')[1]));
        },
    };
    return el;
}

// The one place the fake is passed off as the element it stands in for.
const asElement = (el: FakeContainer) => el as unknown as HTMLElement;

describe('setHtmlKeepScroll', () => {
    test('restores each scroller position after the re-render', () => {
        const el = fakeContainer(3);
        el.children[0].scrollLeft = 40;
        el.children[2].scrollLeft = 120;
        setHtmlKeepScroll(asElement(el), 'tables:3');
        assert.deepEqual(
            el.children.map((c) => c.scrollLeft),
            [40, 0, 120],
        );
    });

    test('skips the restore when the number of scrollers changed', () => {
        const el = fakeContainer(2);
        el.children[0].scrollLeft = 40;
        setHtmlKeepScroll(asElement(el), 'tables:3');
        assert.deepEqual(
            el.children.map((c) => c.scrollLeft),
            [0, 0, 0],
        );
    });
});
