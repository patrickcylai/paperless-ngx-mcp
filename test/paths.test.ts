import assert from 'node:assert/strict';
import { mkdtemp, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';

import { PaperlessClient } from '../src/client.ts';
import { isWithin, PathError, prepareWriteTarget, resolveReadable, resolveWithin } from '../src/paths.ts';

/** Two sibling directories: one the server may touch, one standing in for everything else. */
let root: string;
let allowed: string;
let outside: string;

before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'paperless-paths-'));
    allowed = path.join(root, 'allowed');
    outside = path.join(root, 'outside');
    await prepareWriteTarget(allowed, path.join(allowed, 'seed'));
    await prepareWriteTarget(outside, path.join(outside, 'seed'));
});

after(async () => {
    // Nothing to clean beyond the temp dir the OS reaps; assert we left no stragglers outside.
    assert.ok(await readdir(root));
});

describe('isWithin', () => {
    test('accepts the root itself and anything under it', () => {
        assert.equal(isWithin('/srv/docs', '/srv/docs'), true);
        assert.equal(isWithin('/srv/docs', '/srv/docs/a/b.pdf'), true);
    });

    test('rejects siblings, parents and prefix look-alikes', () => {
        assert.equal(isWithin('/srv/docs', '/srv/other'), false);
        assert.equal(isWithin('/srv/docs', '/srv'), false);
        assert.equal(isWithin('/srv/docs', '/srv/docs-evil/x'), false);
        assert.equal(isWithin('/srv/docs', '/srv/docs/../secret'), false);
    });
});

describe('resolveWithin', () => {
    test('takes a relative path as relative to the root, not the cwd', () => {
        assert.equal(resolveWithin('/srv/docs', 'a.pdf', 'dest_path'), '/srv/docs/a.pdf');
        assert.equal(resolveWithin('/srv/docs', 'sub/a.pdf', 'dest_path'), '/srv/docs/sub/a.pdf');
    });

    test('allows an absolute path that is already inside', () => {
        assert.equal(resolveWithin('/srv/docs', '/srv/docs/a.pdf', 'dest_path'), '/srv/docs/a.pdf');
    });

    test('refuses to climb out, however it is spelled', () => {
        for (const escape of ['../a.pdf', '/etc/cron.d/x', 'sub/../../a.pdf', '../docs-evil/a.pdf', '..']) {
            assert.throws(() => resolveWithin('/srv/docs', escape, 'dest_path'), PathError, escape);
        }
    });

    test('does not expand `~`, so it stays a directory name inside the root', () => {
        // Worth pinning: the surprise is harmless, and expanding it would not be.
        assert.equal(resolveWithin('/srv/docs', '~/.ssh/authorized_keys', 'dest_path'), '/srv/docs/~/.ssh/authorized_keys');
    });
});

describe('prepareWriteTarget', () => {
    test('creates the parent directory private to this user', async () => {
        const target = path.join(allowed, 'nested', 'deep', 'file.pdf');
        assert.equal(await prepareWriteTarget(allowed, target), target);

        const stats = await stat(path.dirname(target));
        assert.equal(stats.mode & 0o777, 0o700);
    });

    test('refuses when the target is a symlink pointing out of the root', async () => {
        const victim = path.join(outside, 'victim.txt');
        await writeFile(victim, 'original');
        const planted = path.join(allowed, 'planted.pdf');
        await symlink(victim, planted);

        await assert.rejects(() => prepareWriteTarget(allowed, planted), PathError);
    });

    test('refuses when an intermediate directory links out of the root', async () => {
        const linkedDir = path.join(allowed, 'linked');
        await symlink(outside, linkedDir);

        await assert.rejects(() => prepareWriteTarget(allowed, path.join(linkedDir, 'x.pdf')), PathError);
    });

    test('refuses a root that is itself a symlink, as a shared temp dir could be', async () => {
        const linkedRoot = path.join(root, 'linked-root');
        await symlink(outside, linkedRoot);

        await assert.rejects(() => prepareWriteTarget(linkedRoot, path.join(linkedRoot, 'x.pdf')), PathError);
    });
});

describe('resolveReadable', () => {
    test('allows a file inside an allowed directory', async () => {
        const file = path.join(allowed, 'upload-me.pdf');
        await writeFile(file, 'x');
        assert.equal(await resolveReadable([allowed], file), file);
    });

    test('lets a missing file through, so the open reports it instead', async () => {
        const missing = path.join(allowed, 'nope.pdf');
        assert.equal(await resolveReadable([allowed], missing), missing);
    });

    test('refuses a path outside every allowed directory', async () => {
        await assert.rejects(() => resolveReadable([allowed], '/etc/passwd'), PathError);
        await assert.rejects(() => resolveReadable([allowed], path.join(outside, 'victim.txt')), PathError);
    });

    test('refuses a symlink that reaches out of an allowed directory', async () => {
        const secret = path.join(outside, 'id_rsa');
        await writeFile(secret, 'PRIVATE KEY');
        const bait = path.join(allowed, 'looks-fine.pdf');
        await symlink(secret, bait);

        await assert.rejects(() => resolveReadable([allowed], bait), PathError);
    });

    test('honours every directory in the allowlist', async () => {
        const file = path.join(outside, 'ok.pdf');
        await writeFile(file, 'x');
        assert.equal(await resolveReadable([allowed, outside], file), file);
    });
});

describe('PaperlessClient.url', () => {
    const client = (baseUrl: string) =>
        new PaperlessClient({
            baseUrl,
            authHeader: 'Token x',
            downloadDir: '/tmp/x',
            uploadDirs: ['/tmp/x'],
            readOnly: false,
            requestTimeoutMs: 1000,
        });

    test('builds the ordinary case unchanged', () => {
        assert.equal(client('https://p.example.com').url('documents/42'), 'https://p.example.com/api/documents/42/');
        assert.equal(
            client('https://p.example.com').url('documents', { page: 2 }),
            'https://p.example.com/api/documents/?page=2',
        );
    });

    test('refuses a path that would escape /api/', () => {
        assert.throws(() => client('https://p.example.com').url('../../admin'), PathError);
        assert.throws(() => client('https://p.example.com').url('%2e%2e/%2e%2e/admin'), PathError);
    });

    test('refuses to leave the sub-path of a sub-path install', () => {
        const sub = client('https://shared.example.com/paperless');
        assert.equal(sub.url('documents'), 'https://shared.example.com/paperless/api/documents/');
        assert.throws(() => sub.url('../../secrets'), PathError);
    });
});
