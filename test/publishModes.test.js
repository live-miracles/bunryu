'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
    MASK,
    livePublishMode,
    maskKey,
    maskSecrets,
    publishRows,
} = require('../public/ts/core/publish-modes');

const ctx = {
    rtmpUrl: 'rtmp://live.example.org:1935/live/key01_abcdef',
    srtUrl: 'srt://live.example.org:10080?streamid=#!::r=live/key01_abcdef,m=publish&passphrase=pass%20phrase%2B1&pbkeylen=16',
    streamKey: 'key01_abcdef',
    passphrase: 'pass phrase+1',
    relayPort: 10081,
    relayUrl:
        'srt://live.example.org:10081?mode=caller&streamid=#!::r=live/key01_abcdef,m=publish&passphrase=pass%20phrase%2B1&pbkeylen=16',
    relayBondedUrl:
        'srt://live.example.org:10081?mode=caller&grouptype=broadcast&streamid=#!::r=live/key01_abcdef,m=publish&passphrase=pass%20phrase%2B1&pbkeylen=16',
};

const pipeline = (connected, isSrt, relayActive = false) => ({
    input: { connected, isSrt },
    srtBonding: { inputActive: relayActive },
});

describe('livePublishMode', () => {
    test('follows the protocol of the connected input', () => {
        assert.equal(livePublishMode(pipeline(false, false)), null);
        assert.equal(livePublishMode(pipeline(true, false)), 'rtmp');
        assert.equal(livePublishMode(pipeline(true, true)), 'srt');
    });

    test('an input arriving through the relay is the relay mode, even before SRS accepts it', () => {
        assert.equal(livePublishMode(pipeline(false, false, true)), 'relay');
        assert.equal(livePublishMode(pipeline(true, true, true)), 'relay');
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

    test('SRT: host, port, masked stream ID and passphrase, masked full URL', () => {
        const rows = publishRows('srt', ctx);
        assert.deepEqual(
            rows.map((r) => [r.label, r.value]),
            [
                ['Host', 'live.example.org'],
                ['Port', '10080'],
                ['Stream ID', '#!::r=live/key01_abcdef,m=publish'],
                ['Passphrase', 'pass phrase+1'],
                ['Full URL', ctx.srtUrl],
            ],
        );
        assert.equal(rows[2].shown, `#!::r=live/key01_${MASK},m=publish`);
        assert.equal(rows[3].shown, MASK);
        const shown = rows.map((r) => r.shown).join('\n');
        assert.ok(!shown.includes('key01_abcdef'));
        assert.ok(!shown.includes('phrase+1') && !shown.includes('phrase%2B1'));
        assert.match(
            rows[4].shown,
            /^srt:\/\/live\.example\.org:10080\?streamid=#!::r=live\/key01_••••••••,m=publish&passphrase=••••••••&pbkeylen=16$/,
        );
    });

    test('SRT Relay uses the relay port and has a bonded and a single-link URL', () => {
        const rows = publishRows('relay', ctx);
        assert.equal(rows.find((r) => r.label === 'Port').value, '10081');
        const bonded = rows.find((r) => r.label === 'Bonded URL');
        const single = rows.find((r) => r.label === 'Single-link URL');
        assert.equal(bonded.value, ctx.relayBondedUrl);
        assert.equal(single.value, ctx.relayUrl);
        assert.ok(bonded.value.includes('grouptype=broadcast'));
        assert.ok(!single.value.includes('grouptype'));
        assert.ok(!bonded.shown.includes('abcdef') && !single.shown.includes('abcdef'));
        assert.ok(!rows.some((r) => r.label === 'Full URL'));
        const bare = publishRows('relay', { ...ctx, passphrase: '' });
        assert.ok(!bare.some((r) => r.label === 'Passphrase'));
    });
});
