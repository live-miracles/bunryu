'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { describeReportFailure } = require('../src/utils/keyVaultStatus');

describe('Key Vault failure wording', () => {
    test('a refused secret says to check the secret', () => {
        for (const status of [401, 403]) {
            assert.match(describeReportFailure(status, `HTTP ${status}`), /refused the secret/);
        }
    });

    test('a missing function says to check the link', () => {
        assert.match(describeReportFailure(404, 'HTTP 404'), /Check the link/);
    });

    test('a server error says it will be tried again, and other answers name the status', () => {
        assert.match(describeReportFailure(500, 'HTTP 500'), /had an error \(HTTP 500\)/);
        assert.match(describeReportFailure(503, 'HTTP 503'), /continue every minute/);
        assert.match(describeReportFailure(400, 'HTTP 400'), /refused the report \(HTTP 400\)/);
    });

    test('a failure to get an answer is told by its cause', () => {
        assert.match(
            describeReportFailure(null, 'fetch failed (getaddrinfo ENOTFOUND x.example)'),
            /host in the link was not found/,
        );
        assert.match(describeReportFailure(null, 'timed out after 10000 ms'), /did not answer/);
        assert.match(
            describeReportFailure(null, 'fetch failed (connect ECONNREFUSED 127.0.0.1:9)'),
            /Could not reach Key Vault \(.*ECONNREFUSED/,
        );
    });
});
