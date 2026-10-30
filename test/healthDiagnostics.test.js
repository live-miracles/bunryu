'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { pipelineDiagnosticsOf } = require('../src/services/healthDiagnostics');

const output = (status, over = {}) => ({
    status,
    pid: status === 'running' ? 77 : null,
    bitrateKbps: null,
    lastOutTimeUs: null,
    lastTotalSizeBytes: null,
    progressAgeMs: null,
    outputProgressAgeMs: null,
    startedAtMs: null,
    failures: 0,
    warningReason: null,
    memoryUsageBytes: null,
    memoryLimitBytes: null,
    cpuPercent: null,
    speed: null,
    role: 'output',
    renditionId: null,
    ready: null,
    readers: null,
    lastError: 'not in the diagnostics',
    ...over,
});

const pipeline = (outputs) => ({
    input: {
        connected: true,
        live: true,
        isSrt: false,
        mediaOk: true,
        recvBitrateKbps: 4000,
        sendBitrateKbps: 8000,
        publisherIp: '203.0.113.9',
    },
    srtBonding: {
        inputActive: true,
        outputConnected: true,
        retryFailures: 0,
        forwardedPackets: 10,
        forwardedBytes: 1000,
        lastPacketAt: 1,
        lastInputPacketAt: 2,
        input: {
            recvPacketsTotal: 5,
            recvUniquePacketsTotal: 5,
            recvLossTotal: 0,
            recvDropTotal: 0,
            retransTotal: 0,
            recvRateMbps: 5,
            latencyMs: 120,
            expectedLegs: 1,
            legs: [
                {
                    ip: '198.51.100.4',
                    port: 4000,
                    state: 'running',
                    health: 'ok',
                    healthReason: null,
                    recvPacketsTotal: 5,
                    recvUniquePacketsTotal: 5,
                    recvLossTotal: 0,
                    recvDropTotal: 0,
                    retransTotal: 0,
                    recvRateMbps: 5,
                    rttMs: 20,
                    latencyMs: 120,
                    bandwidthMbps: 99,
                },
            ],
        },
    },
    outputs,
    alerts: [{ code: 'input-flapping' }],
});

describe('pipelineDiagnosticsOf', () => {
    test('keeps each pipeline under its id, with the input, bonding and alert fields', () => {
        const result = pipelineDiagnosticsOf({
            1: pipeline({ a: output('running', { bitrateKbps: 3000 }) }),
            2: pipeline({}),
        });
        assert.deepEqual(Object.keys(result), ['1', '2']);
        const first = result['1'];
        assert.deepEqual(first.input, {
            connected: true,
            live: true,
            isSrt: false,
            mediaOk: true,
            recvBitrateKbps: 4000,
            sendBitrateKbps: 8000,
        });
        assert.equal(first.bonding.input.legs[0].ip, '198.51.100.4');
        assert.equal(first.bonding.input.legs[0].rttMs, 20);
        assert.deepEqual(first.alerts, [{ code: 'input-flapping' }]);
    });

    test('leaves out fields the diagnostics do not keep', () => {
        const { input, bonding, outputs } = pipelineDiagnosticsOf({
            1: pipeline({ a: output('running') }),
        })['1'];
        assert.equal('publisherIp' in input, false);
        assert.equal('bandwidthMbps' in bonding.input.legs[0], false);
        assert.equal('lastError' in outputs.a, false);
    });

    test('a stopped output is left out, every other status is kept', () => {
        const { outputs } = pipelineDiagnosticsOf({
            1: pipeline({
                stopped: output('stopped'),
                running: output('running', { bitrateKbps: 3000, warningReason: 'slow' }),
                failed: output('failed', { failures: 3 }),
            }),
        })['1'];
        assert.deepEqual(Object.keys(outputs), ['running', 'failed']);
        assert.equal(outputs.running.bitrateKbps, 3000);
        assert.equal(outputs.running.warningReason, 'slow');
        assert.equal(outputs.failed.failures, 3);
    });
});
