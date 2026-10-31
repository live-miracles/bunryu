'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
    createLegHistory,
    LEG_HISTORY_WINDOW_MS: WINDOW,
    LEG_HISTORY_PAGE_STEP_MS: STEP,
} = require('../public/ts/core/leg-history');

const BASE = 100 * 60 * 60 * 1000;

const sample = (ts) => ({
    ts,
    state: 'running',
    health: 'ok',
    recvRateMbps: 1,
    rttMs: 10,
    latencyMs: 120,
    lossPct: 0,
    dropPct: 0,
    retransmissionPct: 0,
    belated: 0,
    lossTotal: 0,
    dropTotal: 0,
});

const series = (ip, timestamps, port = 5000) => ({ ip, port, samples: timestamps.map(sample) });

// What the server answers for a window: `oldestTs` is the oldest sample it holds at all.
const answer = (from, to, legs, oldestTs = from - 1) => ({
    pipelineId: 1,
    from,
    to,
    oldestTs,
    intervalMs: 5000,
    legs,
});

// A scripted fetch: every call waits until the test settles it, so the order in which
// responses arrive is the test's to choose.
function harness() {
    const calls = [];
    let clock = BASE;
    let hidden = false;
    const history = createLegHistory({
        fetch: (id, from, to, after) =>
            new Promise((resolve, reject) => calls.push({ id, from, to, after, resolve, reject })),
        now: () => clock,
        hidden: () => hidden,
    });
    return {
        history,
        calls,
        advance: (ms) => {
            clock += ms;
        },
        hide: () => {
            hidden = true;
        },
        // Settle the newest unsettled call with the window it asked for.
        reply(call, legs, oldestTs) {
            call.resolve(answer(call.from, call.to, legs, oldestTs));
        },
    };
}

const ok = async (load) => {
    const outcome = await load.outcome;
    assert.equal(outcome.status, 'ok', JSON.stringify(outcome));
    return outcome.view;
};

describe('the live window', () => {
    test('opening asks for the last 30 minutes and says it is loading', async () => {
        const h = harness();
        const load = h.history.load('1', 'open');
        assert.equal(load.waiting, true);
        assert.equal(h.calls.length, 1);
        assert.deepEqual(
            {
                id: h.calls[0].id,
                from: h.calls[0].from,
                to: h.calls[0].to,
                after: h.calls[0].after,
            },
            { id: '1', from: BASE - WINDOW, to: BASE, after: undefined },
        );
        h.reply(h.calls[0], [series('10.0.0.1', [BASE - 5000])], BASE - 99 * WINDOW);
        const view = await ok(load);
        assert.equal(view.live, true);
        assert.equal(view.hasNewer, false);
        assert.equal(view.hasOlder, true);
        assert.equal(view.data.legs[0].samples.length, 1);
    });

    test('has no older window when the server holds nothing before it', async () => {
        const h = harness();
        const load = h.history.load('1', 'open');
        h.reply(h.calls[0], [series('10.0.0.1', [BASE - 5000])], BASE - WINDOW);
        assert.equal((await ok(load)).hasOlder, false);
        // Nothing to fetch ahead either.
        assert.equal(h.calls.length, 1);
    });

    test('has no older window when the pipeline has no history at all', async () => {
        const h = harness();
        const load = h.history.load('1', 'open');
        h.calls[0].resolve({ ...answer(BASE - WINDOW, BASE, []), oldestTs: null });
        assert.equal((await ok(load)).hasOlder, false);
    });

    test('a poll asks only for what is new and adds it to what it has', async () => {
        const h = harness();
        const first = h.history.load('1', 'open');
        h.reply(h.calls[0], [series('10.0.0.1', [BASE - 10_000, BASE - 5000])], BASE - WINDOW);
        await ok(first);

        h.advance(5000);
        const poll = h.history.load('1', 'poll');
        assert.equal(h.calls[1].after, BASE - 5000);
        assert.equal(h.calls[1].to, BASE + 5000);
        h.reply(h.calls[1], [series('10.0.0.1', [BASE])], BASE - WINDOW);
        const view = await ok(poll);
        assert.deepEqual(
            view.data.legs[0].samples.map((s) => s.ts),
            [BASE - 10_000, BASE - 5000, BASE],
        );
    });

    test('drops samples that have slid out of the window', async () => {
        const h = harness();
        const first = h.history.load('1', 'open');
        h.reply(
            h.calls[0],
            [series('10.0.0.1', [BASE - WINDOW + 1000, BASE - 5000])],
            BASE - WINDOW,
        );
        await ok(first);

        h.advance(5000);
        const poll = h.history.load('1', 'poll');
        h.reply(h.calls[1], [series('10.0.0.1', [BASE])], BASE - WINDOW);
        const view = await ok(poll);
        // The first sample is now older than 30 minutes.
        assert.deepEqual(
            view.data.legs[0].samples.map((s) => s.ts),
            [BASE - 5000, BASE],
        );
    });

    test('keeps one series per source IP when the sender reconnects on another port', async () => {
        const h = harness();
        const first = h.history.load('1', 'open');
        h.reply(h.calls[0], [series('10.0.0.1', [BASE - 5000], 5000)], BASE - WINDOW);
        await ok(first);

        h.advance(5000);
        const poll = h.history.load('1', 'poll');
        h.reply(h.calls[1], [series('10.0.0.1', [BASE], 6000)], BASE - WINDOW);
        const view = await ok(poll);
        assert.equal(view.data.legs.length, 1);
        assert.equal(view.data.legs[0].port, 6000);
        assert.equal(view.data.legs[0].samples.length, 2);
    });

    test('a leg that appears later gets its own series, and one that went quiet keeps its history', async () => {
        const h = harness();
        const first = h.history.load('1', 'open');
        h.reply(h.calls[0], [series('10.0.0.1', [BASE - 5000])], BASE - WINDOW);
        await ok(first);

        h.advance(5000);
        const poll = h.history.load('1', 'poll');
        h.reply(h.calls[1], [series('10.0.0.2', [BASE])], BASE - WINDOW);
        const view = await ok(poll);
        assert.deepEqual(view.data.legs.map((l) => l.ip).sort(), ['10.0.0.1', '10.0.0.2']);
    });

    test('keeps each pipeline’s window apart', async () => {
        const h = harness();
        const a = h.history.load('1', 'open');
        const b = h.history.load('2', 'open');
        h.reply(h.calls[0], [series('10.0.0.1', [BASE - 5000])], BASE - WINDOW);
        h.reply(h.calls[1], [series('10.0.0.9', [BASE - 4000])], BASE - WINDOW);
        assert.equal((await ok(a)).data.legs[0].ip, '10.0.0.1');
        assert.equal((await ok(b)).data.legs[0].ip, '10.0.0.9');
        // The second pipeline's first fetch asked for everything, not an increment.
        assert.equal(h.calls[1].after, undefined);
    });
});

describe('requests that overlap', () => {
    test('a window already being fetched is not fetched twice', async () => {
        const h = harness();
        const first = h.history.load('1', 'open');
        assert.equal(h.history.load('1', 'poll'), null);
        assert.equal(h.history.load('1', 'open'), null);
        assert.equal(h.calls.length, 1);
        h.reply(h.calls[0], [], BASE - WINDOW);
        await ok(first);
        // Once it has settled the window can be loaded again.
        assert.ok(h.history.load('1', 'poll'));
        assert.equal(h.calls.length, 2);
    });

    test('a slow response that a newer request replaced is dropped', async () => {
        const h = harness();
        const live = h.history.load('1', 'open');
        const older = h.history.load('1', 'older');
        assert.equal(h.calls.length, 2);
        // The newer request answers first, then the slow live one limps in.
        h.reply(h.calls[1], [series('10.0.0.1', [BASE - STEP - 5000])], BASE - 99 * WINDOW);
        const olderOutcome = await older.outcome;
        assert.equal(olderOutcome.status, 'ok');
        assert.equal(olderOutcome.view.live, false);

        h.reply(h.calls[0], [series('10.0.0.1', [BASE - 5000])], BASE - 99 * WINDOW);
        assert.deepEqual(await live.outcome, { status: 'superseded' });
    });

    test('a superseded response is not remembered', async () => {
        const h = harness();
        h.history.load('1', 'older');
        const newer = h.history.load('1', 'newer');
        // The older window's reply arrives after the user went back to live.
        h.reply(h.calls[0], [series('10.0.0.1', [BASE - STEP - 5000])], BASE - 99 * WINDOW);
        h.reply(h.calls[1], [], BASE - 99 * WINDOW);
        await ok(newer);
        const calls = h.calls.length;
        // Asking for that older window again goes to the server instead of a cache.
        const again = h.history.load('1', 'older');
        assert.equal(again.waiting, true);
        assert.ok(h.calls.length > calls);
    });

    test('a failure of a replaced request is superseded too, not reported', async () => {
        const h = harness();
        const live = h.history.load('1', 'open');
        h.history.load('1', 'older');
        h.calls[0].reject(new Error('network'));
        assert.deepEqual(await live.outcome, { status: 'superseded' });
    });
});

describe('paging', () => {
    test('older moves the window by ten minutes and the pipeline remembers where it is', async () => {
        const h = harness();
        const older = h.history.load('1', 'older');
        assert.equal(h.calls[0].to, BASE - STEP);
        h.reply(h.calls[0], [], BASE - 99 * WINDOW);
        const view = await ok(older);
        assert.equal(view.live, false);
        assert.equal(view.hasNewer, true);

        // Opening again returns to the window it was on, not to live. That window was
        // just fetched, so nothing is waited for.
        const reopened = h.history.load('1', 'open');
        assert.equal(reopened.waiting, false);
        assert.equal((await ok(reopened)).live, false);
    });

    test('newer from the live window stays live', async () => {
        const h = harness();
        const load = h.history.load('1', 'newer');
        assert.equal(h.calls[0].to, BASE);
        h.reply(h.calls[0], [], BASE - WINDOW);
        assert.equal((await ok(load)).live, true);
    });

    test('paging back to live resumes the incremental window', async () => {
        const h = harness();
        const first = h.history.load('1', 'open');
        h.reply(h.calls[0], [series('10.0.0.1', [BASE - 5000])], BASE - 99 * WINDOW);
        await ok(first);
        const older = h.history.load('1', 'older');
        h.reply(h.calls[h.calls.length - 1], [], BASE - 99 * WINDOW);
        await ok(older);

        const back = h.history.load('1', 'newer');
        const resume = h.calls[h.calls.length - 1];
        assert.equal(resume.to, BASE);
        assert.equal(resume.after, BASE - 5000);
        h.reply(resume, [series('10.0.0.1', [BASE])], BASE - 99 * WINDOW);
        assert.equal((await ok(back)).data.legs[0].samples.length, 2);
    });

    test('a poll leaves a paged window alone', async () => {
        const h = harness();
        const older = h.history.load('1', 'older');
        h.reply(h.calls[0], [], BASE - 99 * WINDOW);
        await ok(older);
        const calls = h.calls.length;
        assert.equal(h.history.load('1', 'poll'), null);
        assert.equal(h.calls.length, calls);
    });

    test('the range label comes from the window the server answered', async () => {
        const h = harness();
        const older = h.history.load('1', 'older');
        h.reply(h.calls[0], [], BASE - 99 * WINDOW);
        const { data } = await ok(older);
        assert.equal(data.from, BASE - STEP - WINDOW);
        assert.equal(data.to, BASE - STEP);
    });
});

describe('fetching the next older window ahead', () => {
    // The first call answers; the prefetch is the call that follows.
    async function openAndPrefetch(h) {
        const load = h.history.load('1', 'open');
        h.reply(h.calls[0], [series('10.0.0.1', [BASE - 5000])], BASE - 99 * WINDOW);
        await ok(load);
        return h.calls[1];
    }

    test('asks for the window one step older once there is one', async () => {
        const h = harness();
        const prefetch = await openAndPrefetch(h);
        assert.equal(prefetch.to, BASE - STEP);
        assert.equal(prefetch.after, undefined);
    });

    test('lets the click that follows use it without waiting', async () => {
        const h = harness();
        const prefetch = await openAndPrefetch(h);
        h.reply(prefetch, [series('10.0.0.1', [BASE - STEP - 5000])], BASE - 99 * WINDOW);
        await Promise.resolve();
        await Promise.resolve();
        const before = h.calls.length;
        const older = h.history.load('1', 'older');
        assert.equal(older.waiting, false);
        // Only the window after it is fetched ahead, not the one it shows.
        assert.deepEqual(
            h.calls.slice(before).map((c) => c.to),
            [BASE - 2 * STEP],
        );
        const view = await ok(older);
        assert.equal(view.data.legs[0].samples.length, 1);
    });

    test('throws the prefetched window away after a minute', async () => {
        const h = harness();
        const prefetch = await openAndPrefetch(h);
        h.reply(prefetch, [], BASE - 99 * WINDOW);
        await Promise.resolve();
        await Promise.resolve();
        h.advance(61_000);
        const older = h.history.load('1', 'older');
        assert.equal(older.waiting, true);
    });

    test('is not done in a hidden tab', async () => {
        const h = harness();
        h.hide();
        const load = h.history.load('1', 'open');
        h.reply(h.calls[0], [series('10.0.0.1', [BASE - 5000])], BASE - 99 * WINDOW);
        await ok(load);
        assert.equal(h.calls.length, 1);
    });

    test('is not repeated while one is on its way', async () => {
        const h = harness();
        await openAndPrefetch(h);
        assert.equal(h.calls.length, 2);
        // A poll on the live window finishes while that prefetch is still pending.
        h.advance(5000);
        const poll = h.history.load('1', 'poll');
        h.reply(h.calls[2], [series('10.0.0.1', [BASE])], BASE - 99 * WINDOW);
        await ok(poll);
        assert.equal(h.calls.length, 3);
    });

    test('a failed one is tolerated, and the click fetches the window itself', async () => {
        const h = harness();
        const prefetch = await openAndPrefetch(h);
        prefetch.reject(new Error('network'));
        await Promise.resolve();
        await Promise.resolve();
        const older = h.history.load('1', 'older');
        assert.equal(older.waiting, true);
        const fetchCall = h.calls[h.calls.length - 1];
        assert.equal(fetchCall.to, BASE - STEP);
        h.reply(fetchCall, [series('10.0.0.1', [BASE - STEP - 5000])], BASE - 99 * WINDOW);
        assert.equal((await ok(older)).live, false);
    });
});

describe('failures', () => {
    test('an empty answer is reported as a failure and not remembered', async () => {
        const h = harness();
        const first = h.history.load('1', 'open');
        h.calls[0].resolve(null);
        assert.deepEqual(await first.outcome, { status: 'failed' });
        // The next load starts from scratch: no increment against a window it never got.
        const retry = h.history.load('1', 'open');
        assert.ok(retry);
        assert.equal(h.calls[1].after, undefined);
    });

    test('a fetch that throws is reported as a failure and the window can be tried again', async () => {
        const h = harness();
        const first = h.history.load('1', 'open');
        h.calls[0].reject(new Error('timeout'));
        assert.deepEqual(await first.outcome, { status: 'failed' });
        assert.ok(h.history.load('1', 'open'));
    });

    test('a failed older page is not cached', async () => {
        const h = harness();
        const older = h.history.load('1', 'older');
        h.calls[0].resolve(null);
        assert.deepEqual(await older.outcome, { status: 'failed' });
        const retry = h.history.load('1', 'open');
        assert.equal(retry.waiting, true);
    });
});
