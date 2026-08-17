import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { apiPath, buildQuery, filenameFromDisposition, PaperlessError } from '../src/client.ts';
import { ConfigError, loadConfig, normalizeBaseUrl } from '../src/config.ts';
import { compact, plainHighlights, truncate } from '../src/format.ts';

describe('normalizeBaseUrl', () => {
    test('adds a scheme to a bare host', () => {
        assert.equal(normalizeBaseUrl('paperless.example.com'), 'https://paperless.example.com');
    });

    test('strips trailing slashes and a trailing /api', () => {
        assert.equal(normalizeBaseUrl('https://paperless.example.com/api/'), 'https://paperless.example.com');
        assert.equal(normalizeBaseUrl('https://paperless.example.com/api'), 'https://paperless.example.com');
        assert.equal(normalizeBaseUrl('https://paperless.example.com///'), 'https://paperless.example.com');
    });

    test('keeps a sub-path mount but drops its /api suffix', () => {
        assert.equal(normalizeBaseUrl('https://example.com/paperless/api'), 'https://example.com/paperless');
    });

    test('drops query strings and fragments', () => {
        assert.equal(normalizeBaseUrl('http://localhost:8000/?a=1#x'), 'http://localhost:8000');
    });

    test('rejects unusable input', () => {
        assert.throws(() => normalizeBaseUrl('   '), ConfigError);
        assert.throws(() => normalizeBaseUrl('http://'), ConfigError);
    });
});

describe('loadConfig', () => {
    test('builds a token auth header', () => {
        const config = loadConfig({ PAPERLESS_URL: 'https://p.example.com', PAPERLESS_TOKEN: 'abc123' });
        assert.equal(config.authHeader, 'Token abc123');
        assert.equal(config.readOnly, false);
        assert.equal(config.apiVersion, undefined);
    });

    test('builds a basic auth header from username and password', () => {
        const config = loadConfig({
            PAPERLESS_URL: 'https://p.example.com',
            PAPERLESS_USERNAME: 'alice',
            PAPERLESS_PASSWORD: 'hunter2',
        });
        assert.equal(config.authHeader, `Basic ${Buffer.from('alice:hunter2').toString('base64')}`);
    });

    test('prefers a token over basic credentials', () => {
        const config = loadConfig({
            PAPERLESS_URL: 'https://p.example.com',
            PAPERLESS_TOKEN: 'tok',
            PAPERLESS_USERNAME: 'alice',
            PAPERLESS_PASSWORD: 'hunter2',
        });
        assert.equal(config.authHeader, 'Token tok');
    });

    test('requires a URL and credentials', () => {
        assert.throws(() => loadConfig({ PAPERLESS_TOKEN: 'x' }), ConfigError);
        assert.throws(() => loadConfig({ PAPERLESS_URL: 'https://p.example.com' }), ConfigError);
    });

    test('reads the read-only flag and timeout', () => {
        const config = loadConfig({
            PAPERLESS_URL: 'https://p.example.com',
            PAPERLESS_TOKEN: 'x',
            PAPERLESS_READ_ONLY: 'yes',
            PAPERLESS_TIMEOUT_MS: '5000',
        });
        assert.equal(config.readOnly, true);
        assert.equal(config.requestTimeoutMs, 5000);
    });

    test('falls back to a sane timeout when the value is junk', () => {
        const config = loadConfig({
            PAPERLESS_URL: 'https://p.example.com',
            PAPERLESS_TOKEN: 'x',
            PAPERLESS_TIMEOUT_MS: 'soon',
        });
        assert.equal(config.requestTimeoutMs, 30_000);
    });
});

describe('apiPath', () => {
    test('adds the api prefix and a trailing slash', () => {
        assert.equal(apiPath('documents'), '/api/documents/');
        assert.equal(apiPath('/documents/'), '/api/documents/');
        assert.equal(apiPath('documents/5/download'), '/api/documents/5/download/');
    });

    test('does not double up an existing api prefix', () => {
        assert.equal(apiPath('api/tags'), '/api/tags/');
        assert.equal(apiPath('/api/tags/'), '/api/tags/');
    });
});

describe('buildQuery', () => {
    test('joins arrays with commas, as paperless expects for id filters', () => {
        assert.equal(buildQuery({ tags__id__all: [1, 2, 3] }), '?tags__id__all=1%2C2%2C3');
    });

    test('drops empty values and empty arrays', () => {
        assert.equal(buildQuery({ a: undefined, b: null, c: '', d: [], e: 1 }), '?e=1');
    });

    test('serialises booleans and returns an empty string for nothing', () => {
        assert.equal(buildQuery({ is_tagged: false }), '?is_tagged=false');
        assert.equal(buildQuery({}), '');
        assert.equal(buildQuery(undefined), '');
    });
});

describe('filenameFromDisposition', () => {
    test('reads the plain and extended forms', () => {
        assert.equal(filenameFromDisposition('attachment; filename="Invoice 2024.pdf"'), 'Invoice 2024.pdf');
        assert.equal(filenameFromDisposition("attachment; filename*=UTF-8''R%C3%A9sum%C3%A9.pdf"), 'Résumé.pdf');
    });

    test('strips any directory component so a server cannot steer the write path', () => {
        assert.equal(filenameFromDisposition('attachment; filename="../../etc/passwd"'), 'passwd');
    });

    test('returns undefined when there is no header', () => {
        assert.equal(filenameFromDisposition(null), undefined);
        assert.equal(filenameFromDisposition('attachment'), undefined);
    });
});

describe('PaperlessError', () => {
    test('adds an actionable hint for auth failures', () => {
        const error = new PaperlessError(403, 'GET', 'https://p/api/documents/', 'nope');
        assert.match(error.message, /PAPERLESS_TOKEN/);
        assert.equal(error.status, 403);
    });

    test('explains a version rejection', () => {
        const error = new PaperlessError(406, 'GET', 'https://p/api/documents/', '');
        assert.match(error.message, /PAPERLESS_API_VERSION/);
    });
});

describe('formatting helpers', () => {
    test('truncate reports how much it hid', () => {
        assert.equal(truncate('abcdef', 3), 'abc\n… [truncated: showing 3 of 6 characters]');
        assert.equal(truncate('abc', 10), 'abc');
        assert.equal(truncate(null, 10), null);
    });

    test('truncate treats a zero limit as "omit", not "unlimited"', () => {
        assert.equal(truncate('abcdef', 0), null);
        assert.equal(truncate('abcdef', -1), null);
    });

    test('plainHighlights keeps the matched words and drops the markup', () => {
        assert.equal(plainHighlights('text <span class="match">Test</span> text'), 'text **Test** text');
        assert.equal(plainHighlights(null), null);
    });

    test('compact removes nulls and empty arrays but keeps false and 0', () => {
        assert.deepEqual(compact({ a: null, b: undefined, c: [], d: false, e: 0, f: 'x' }), { d: false, e: 0, f: 'x' });
    });
});
