'use strict';

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const KEY = 'bunryu.collapsedGroups';

// state.ts reads localStorage when it is first loaded, so each test installs a
// fake storage and loads a fresh copy of the module.
function loadState(stored) {
    const store = new Map(stored === undefined ? [] : [[KEY, stored]]);
    global.localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, v),
    };
    delete require.cache[require.resolve('../public/ts/core/state')];
    return { ...require('../public/ts/core/state'), store };
}

describe('collapsed pipeline groups', () => {
    beforeEach(() => {
        delete global.localStorage;
    });

    test('start expanded when nothing is stored', () => {
        assert.equal(loadState().state.collapsedGroupIds.size, 0);
    });

    test('are restored after a reload', () => {
        const first = loadState();
        first.state.collapsedGroupIds.add(3);
        first.state.collapsedGroupIds.add(7);
        first.saveCollapsedGroups();

        const second = loadState(first.store.get(KEY));
        assert.deepEqual([...second.state.collapsedGroupIds], [3, 7]);
    });

    test('ignore a corrupt stored value', () => {
        assert.equal(loadState('{not json').state.collapsedGroupIds.size, 0);
        assert.equal(loadState('{"a":1}').state.collapsedGroupIds.size, 0);
        assert.deepEqual([...loadState('[1,"x",null,2.5,4]').state.collapsedGroupIds], [1, 4]);
    });

    test('survive blocked storage', () => {
        const { state, saveCollapsedGroups } = loadState();
        global.localStorage = {
            getItem: () => {
                throw new Error('blocked');
            },
            setItem: () => {
                throw new Error('blocked');
            },
        };
        state.collapsedGroupIds.add(1);
        assert.doesNotThrow(saveCollapsedGroups);
        delete require.cache[require.resolve('../public/ts/core/state')];
        assert.equal(require('../public/ts/core/state').state.collapsedGroupIds.size, 0);
    });
});
