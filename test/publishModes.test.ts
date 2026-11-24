import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
    MASK,
    liveDotMode,
    livePublishMode,
    maskKey,
    maskSecrets,
    publishRows,
    type PublishRow,
} from '../public/ts/core/publish-modes';

const ctx = {
    rtmpUrl: 'rtmp://live.example.org:1935/live/key01_abcdef',
    streamKey: 'key01_abcdef',
    passphrase: 'pass phrase+1',
    relayPort: 10081,
    relayUrl:
        'srt://live.example.org:10081?mode=caller&streamid=#!::r=live/key01_abcdef,m=publish&passphrase=pass%20phrase%2B1&pbkeylen=16',
    relayBondedUrl:
        'srt://live.example.org:10081?mode=caller&grouptype=broadcast&streamid=#!::r=live/key01_abcdef,m=publish&passphrase=pass%20phrase%2B1&pbkeylen=16',
};

// The row with this label; a missing one fails the test where it is looked up.
function row(rows: PublishRow[], label: string): PublishRow {
    const found = rows.find((r) => r.label === label);
    assert.ok(found, `no "${label}" row`);
    return found;
}

const pipeline = (connected: boolean, isSrt: boolean, relayActive = false) => ({
    input: { connected, isSrt },
    srtBonding: { inputActive: relayActive },
});

describe('livePublishMode', () => {
    test('follows the protocol of the connected input; SRT sent straight to SRS opens the SRT tab without a dot', () => {
        assert.equal(livePublishMode(pipeline(false, false)), null);
        assert.equal(livePublishMode(pipeline(true, false)), 'rtmp');
        assert.equal(livePublishMode(pipeline(true, true)), 'srt');
        assert.equal(liveDotMode(pipeline(true, false)), 'rtmp');
        assert.equal(liveDotMode(pipeline(true, true)), null);
    });

    test('an input arriving through the relay is the SRT mode, even before SRS accepts it', () => {
        assert.equal(livePublishMode(pipeline(false, false, true)), 'srt');
        assert.equal(livePublishMode(pipeline(true, true, true)), 'srt');
        assert.equal(liveDotMode(pipeline(true, true, true)), 'srt');
    });
});

describe('maskSecrets', () => {
    test('masks a secret in plain and URL-encoded form and ignores an empty one', () => {
        const secrets = [
            { value: 'key01_abcdef', masked: maskKey('key01_abcdef') },
            { value: '', masked: MASK },
            { value: 'pass phrase+1', masked: MASK },
        ];
        assert.equal(maskSecrets('a/key01_abcdef/b', secrets), `a/key01_${MASK}/b`);
        assert.equal(maskSecrets('x=pass%20phrase%2B1', secrets), `x=${MASK}`);
    });

    test('a stream key keeps its keyNN_ prefix; one without a short prefix is masked whole', () => {
        assert.equal(maskKey('key01_abcdef'), `key01_${MASK}`);
        assert.equal(maskKey('abcdefghijkl'), MASK);
        assert.equal(maskKey('averylongprefix_abc'), MASK);
    });
});

describe('publishRows', () => {
    test('RTMP: server URL, masked key and full URL; copy gives the real values', () => {
        const rows = publishRows('rtmp', ctx);
        assert.deepEqual(
            rows.map((r) => [r.label, r.shown, r.secret]),
            [
                ['Server URL', 'rtmp://live.example.org:1935/live', false],
                ['Stream key', `key01_${MASK}`, true],
                ['Full URL', `rtmp://live.example.org:1935/live/key01_${MASK}`, false],
            ],
        );
        assert.equal(rows[1].value, 'key01_abcdef');
        assert.equal(rows[2].value, ctx.rtmpUrl);
        assert.equal(rows[2].primary, true);
    });

    test('SRT uses the relay port and has a single-link and a bonded URL, in that order', () => {
        const rows = publishRows('srt', ctx);
        assert.deepEqual(
            rows.map((r) => [r.label, r.value]),
            [
                ['Host', 'live.example.org'],
                ['Port', '10081'],
                ['Stream ID', '#!::r=live/key01_abcdef,m=publish'],
                ['Passphrase', 'pass phrase+1'],
                ['Single-link URL', ctx.relayUrl],
                ['Bonded URL', ctx.relayBondedUrl],
            ],
        );
        assert.equal(rows[2].shown, `#!::r=live/key01_${MASK},m=publish`);
        assert.equal(rows[3].shown, MASK);
        const shown = rows.map((r) => r.shown).join('\n');
        assert.ok(!shown.includes('key01_abcdef'));
        assert.ok(!shown.includes('phrase+1') && !shown.includes('phrase%2B1'));
        assert.ok(row(rows, 'Bonded URL').value.includes('grouptype=broadcast'));
        assert.ok(!row(rows, 'Single-link URL').value.includes('grouptype'));
        const bare = publishRows('srt', { ...ctx, passphrase: '' });
        assert.ok(!bare.some((r) => r.label === 'Passphrase'));
    });
});
