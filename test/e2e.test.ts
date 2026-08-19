import assert from 'node:assert/strict';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';
import { fileURLToPath } from 'node:url';

import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';

const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));

const TAGS = [
    { id: 1, name: 'unpaid', color: '#a6cee3', document_count: 2, is_inbox_tag: false },
    { id: 2, name: 'inbox', color: '#ff0000', document_count: 5, is_inbox_tag: true },
];
const CORRESPONDENTS = [{ id: 7, name: 'ACME Corp', document_count: 3 }];
const DOCUMENT_TYPES = [{ id: 4, name: 'Invoice', document_count: 3 }];

const DOCUMENT = {
    id: 42,
    title: 'ACME Invoice 2024-08',
    content: 'Invoice total 129.50 EUR due on 2024-09-01. Thank you for your business.',
    correspondent: 7,
    document_type: 4,
    storage_path: null,
    tags: [1],
    created: '2024-08-14',
    added: '2024-08-15T09:12:00Z',
    modified: '2024-08-15T09:12:00Z',
    archive_serial_number: 118,
    original_file_name: 'acme-invoice.pdf',
    page_count: 2,
    notes: [{ id: 3, note: 'Chase this one', created: '2024-08-16T10:00:00Z' }],
    custom_fields: [{ field: 9, value: 'ACME-1234' }],
};

interface RecordedRequest {
    method: string;
    path: string;
    body: string;
    authorization: string | undefined;
}

/** A stub standing in for paperless-ngx, so the tests exercise real HTTP and real framing. */
class StubPaperless {
    readonly requests: RecordedRequest[] = [];
    private server!: http.Server;
    private port!: number;

    get url(): string {
        return `http://127.0.0.1:${this.port}`;
    }

    async start(): Promise<void> {
        this.server = http.createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on('data', (chunk: Buffer) => chunks.push(chunk));
            request.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                const url = new URL(request.url ?? '/', this.url);
                this.requests.push({
                    method: request.method ?? 'GET',
                    path: `${url.pathname}${url.search}`,
                    body,
                    authorization: request.headers.authorization,
                });
                this.route(request.method ?? 'GET', url, response);
            });
        });

        await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
        const address = this.server.address();
        if (typeof address === 'string' || address === null) throw new Error('stub server has no port');
        this.port = address.port;
    }

    async stop(): Promise<void> {
        await new Promise<void>((resolve, reject) =>
            this.server.close((error) => (error ? reject(error) : resolve())),
        );
    }

    private route(method: string, url: URL, response: http.ServerResponse): void {
        const json = (payload: unknown, status = 200) => {
            const text = JSON.stringify(payload);
            response.writeHead(status, {
                'content-type': 'application/json',
                'x-api-version': '10',
                'x-version': '2.18.4',
            });
            response.end(text);
        };
        const page = <T>(results: T[]) => json({ count: results.length, next: null, previous: null, results });

        const route = url.pathname;

        if (route === '/api/tags/') return page(TAGS);
        if (route === '/api/correspondents/') return page(CORRESPONDENTS);
        if (route === '/api/document_types/') return page(DOCUMENT_TYPES);
        if (route === '/api/storage_paths/') return page([]);
        if (route === '/api/custom_fields/') return page([{ id: 9, name: 'Contract Number', data_type: 'string' }]);
        if (route === '/api/ui_settings/') return json({ settings: {} });
        if (route === '/api/statistics/') return json({ documents_total: 3, documents_inbox: 1, character_count: 1234 });
        if (route === '/api/status/') return json({ pngx_version: '2.18.4', tasks: { redis_status: 'OK' } });

        if (route === '/api/documents/' && method === 'GET') {
            return json({
                count: 1,
                next: null,
                previous: null,
                results: [{ ...DOCUMENT, __search_hit__: { score: 0.87, rank: 0, highlights: 'total <span class="match">129.50</span> EUR' } }],
            });
        }
        if (route === '/api/documents/42/' && method === 'GET') return json(DOCUMENT);
        if (route === '/api/documents/42/' && method === 'PATCH') return json({ ...DOCUMENT, title: 'Renamed' });

        if (route === '/api/documents/42/download/') {
            response.writeHead(200, {
                'content-type': 'application/pdf',
                'content-disposition': 'attachment; filename="acme-invoice.pdf"',
            });
            response.end(Buffer.from('%PDF-1.7 stub payload'));
            return;
        }

        if (route === '/api/documents/42/suggestions/') {
            return json({ correspondents: [7], tags: [1, 2], document_types: [4], storage_paths: [], dates: ['2024-08-14'] });
        }

        if (route === '/api/documents/post_document/' && method === 'POST') {
            return json('c2a1f0de-0000-4000-8000-000000000001');
        }
        if (route === '/api/tasks/' && method === 'GET') {
            return page([
                {
                    id: 11,
                    task_id: 'c2a1f0de-0000-4000-8000-000000000001',
                    task_type: 'file',
                    status: 'SUCCESS',
                    task_file_name: 'receipt.pdf',
                    related_document: 99,
                    result: 'Success. New document id 99 created',
                },
            ]);
        }

        if (route === '/api/documents/bulk_edit/' && method === 'POST') return json('OK');
        if (route === '/api/documents/42/notes/' && method === 'POST') return json([{ id: 4, note: 'added' }]);

        if (route === '/api/documents/1234/' && method === 'GET') {
            return json({ detail: 'Not found.' }, 404);
        }

        json({ detail: `stub has no route for ${method} ${route}` }, 404);
    }
}

/** Minimal newline-delimited JSON-RPC client, so the test checks the wire format too. */
class StdioClient {
    private child: ChildProcessWithoutNullStreams;
    private buffer = '';
    private nextId = 1;
    private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    readonly stderr: string[] = [];

    constructor(env: Record<string, string>) {
        this.child = spawn(process.execPath, [ENTRY], {
            env: { ...process.env, ...env },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.child.stdout.setEncoding('utf8');
        this.child.stdout.on('data', (chunk: string) => this.consume(chunk));
        this.child.stderr.setEncoding('utf8');
        this.child.stderr.on('data', (chunk: string) => this.stderr.push(chunk));
    }

    private consume(chunk: string): void {
        this.buffer += chunk;
        let newline = this.buffer.indexOf('\n');
        while (newline !== -1) {
            const line = this.buffer.slice(0, newline).trim();
            this.buffer = this.buffer.slice(newline + 1);
            if (line) {
                const message = JSON.parse(line);
                const waiter = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
                if (waiter) {
                    this.pending.delete(message.id);
                    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
                    else waiter.resolve(message.result);
                }
            }
            newline = this.buffer.indexOf('\n');
        }
    }

    request(method: string, params?: unknown): Promise<any> {
        const id = this.nextId++;
        const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.child.stdin.write(payload);
            setTimeout(() => {
                if (this.pending.delete(id)) {
                    reject(new Error(`timed out waiting for ${method}; stderr: ${this.stderr.join('')}`));
                }
            }, 15_000).unref();
        });
    }

    notify(method: string, params?: unknown): void {
        this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    }

    async initialize(): Promise<any> {
        const result = await this.request('initialize', {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'e2e-test', version: '0.0.0' },
        });
        this.notify('notifications/initialized');
        return result;
    }

    async callTool(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
        const result = await this.request('tools/call', { name, arguments: args });
        return {
            text: (result.content ?? []).map((block: { text?: string }) => block.text ?? '').join('\n'),
            isError: Boolean(result.isError),
        };
    }

    close(): void {
        this.child.stdin.end();
        this.child.kill();
    }
}

describe('paperless-ngx MCP server over stdio', () => {
    const stub = new StubPaperless();
    let client: StdioClient;
    let downloadDir: string;

    before(async () => {
        await stub.start();
        downloadDir = await mkdtemp(path.join(os.tmpdir(), 'paperless-mcp-test-'));
        client = new StdioClient({
            PAPERLESS_URL: stub.url,
            PAPERLESS_TOKEN: 'test-token',
            PAPERLESS_DOWNLOAD_DIR: downloadDir,
            PAPERLESS_READ_ONLY: '',
        });
        await client.initialize();
    });

    after(async () => {
        client.close();
        await stub.stop();
    });

    test('handshake reports the server identity', async () => {
        const fresh = new StdioClient({ PAPERLESS_URL: stub.url, PAPERLESS_TOKEN: 'test-token' });
        const result = await fresh.initialize();
        assert.equal(result.serverInfo.name, 'paperless-ngx');
        assert.ok(result.capabilities.tools, 'advertises tool support');
        fresh.close();
    });

    test('lists every tool with a description and a schema', async () => {
        const { tools } = await client.request('tools/list');
        const names = tools.map((tool: { name: string }) => tool.name).sort();

        assert.deepEqual(names, [
            'paperless_api_request',
            'paperless_bulk_edit_documents',
            'paperless_create_object',
            'paperless_delete_objects',
            'paperless_document_notes',
            'paperless_download_document',
            'paperless_get_document',
            'paperless_get_document_suggestions',
            'paperless_get_statistics',
            'paperless_get_system_status',
            'paperless_list_objects',
            'paperless_list_tasks',
            'paperless_search_documents',
            'paperless_update_document',
            'paperless_update_object',
            'paperless_upload_document',
        ]);

        for (const tool of tools) {
            assert.ok(tool.description && tool.description.length > 40, `${tool.name} needs a real description`);
            assert.equal(tool.inputSchema.type, 'object', `${tool.name} must expose an object schema`);
        }
    });

    test('exposes both resources', async () => {
        const { resources } = await client.request('resources/list');
        assert.deepEqual(
            resources.map((resource: { uri: string }) => resource.uri).sort(),
            ['paperless://statistics', 'paperless://taxonomy'],
        );

        const read = await client.request('resources/read', { uri: 'paperless://taxonomy' });
        const taxonomy = JSON.parse(read.contents[0].text);
        assert.deepEqual(taxonomy.tags, [
            { id: 1, name: 'unpaid' },
            { id: 2, name: 'inbox' },
        ]);
    });

    test('search resolves ids to names and surfaces highlights', async () => {
        const { text, isError } = await client.callTool('paperless_search_documents', { query: 'acme invoice' });
        assert.equal(isError, false);

        const payload = JSON.parse(text);
        assert.equal(payload.count, 1);
        assert.equal(payload.page, 1);
        assert.deepEqual(payload.results[0], {
            id: 42,
            title: 'ACME Invoice 2024-08',
            created: '2024-08-14',
            added: '2024-08-15T09:12:00Z',
            correspondent: 'ACME Corp',
            document_type: 'Invoice',
            tags: ['unpaid'],
            archive_serial_number: 118,
            page_count: 2,
            notes: 1,
            score: 0.87,
            highlights: 'total **129.50** EUR',
        });
    });

    test('search translates friendly filters into paperless query parameters', async () => {
        await client.callTool('paperless_search_documents', {
            tags_all: [1, 2],
            tags_none: [3],
            correspondent_ids: [7],
            created_after: '2024-01-01',
            created_before: '2024-12-31',
            added_after: '2024-06-01',
            title_contains: 'invoice',
            is_in_inbox: true,
            custom_field_query: '["due","exists",true]',
            extra_filters: { checksum__iexact: 'deadbeef' },
            ordering: '-created',
            page_size: 10,
        });

        const search = stub.requests.filter((request) => request.path.startsWith('/api/documents/?')).at(-1);
        assert.ok(search, 'the stub saw a document list request');
        const params = new URLSearchParams(search.path.split('?')[1]);

        assert.equal(params.get('tags__id__all'), '1,2');
        assert.equal(params.get('tags__id__none'), '3');
        assert.equal(params.get('correspondent__id__in'), '7');
        assert.equal(params.get('created__gte'), '2024-01-01');
        assert.equal(params.get('created__lte'), '2024-12-31');
        assert.equal(params.get('added__date__gte'), '2024-06-01');
        assert.equal(params.get('title__icontains'), 'invoice');
        assert.equal(params.get('is_in_inbox'), 'true');
        assert.equal(params.get('custom_field_query'), '["due","exists",true]');
        assert.equal(params.get('checksum__iexact'), 'deadbeef');
        assert.equal(params.get('ordering'), '-created');
        assert.equal(params.get('page_size'), '10');
        assert.equal(search.authorization, 'Token test-token');
    });

    test('get_document returns content, notes and named custom fields', async () => {
        const { text } = await client.callTool('paperless_get_document', { id: 42 });
        const payload = JSON.parse(text);

        assert.equal(payload.correspondent, 'ACME Corp');
        assert.equal(payload.correspondent_id, 7);
        assert.deepEqual(payload.tags, ['unpaid']);
        assert.deepEqual(payload.custom_fields, [{ field: 9, name: 'Contract Number', value: 'ACME-1234' }]);
        assert.deepEqual(payload.notes, [{ id: 3, note: 'Chase this one', created: '2024-08-16T10:00:00Z' }]);
        assert.match(payload.content, /Invoice total 129\.50 EUR/);
    });

    test('get_document truncates long content on request', async () => {
        const { text } = await client.callTool('paperless_get_document', { id: 42, content_max_chars: 12 });
        const payload = JSON.parse(text);
        assert.match(payload.content, /^Invoice tota\n… \[truncated: showing 12 of \d+ characters\]$/);
    });

    test('get_document can omit content entirely', async () => {
        const zeroChars = await client.callTool('paperless_get_document', { id: 42, content_max_chars: 0 });
        assert.equal(JSON.parse(zeroChars.text).content, undefined);

        const excluded = await client.callTool('paperless_get_document', { id: 42, include_content: false });
        assert.equal(JSON.parse(excluded.text).content, undefined);
    });

    test('update_document echoes the changed fields without dumping the document text', async () => {
        const { text, isError } = await client.callTool('paperless_update_document', {
            id: 42,
            title: 'Renamed',
            add_tag_ids: [2],
        });
        assert.equal(isError, false);

        const payload = JSON.parse(text);
        assert.deepEqual(payload.updated.sort(), ['tags', 'title']);
        assert.equal(payload.document.snippet, undefined, 'the summary must not carry the full document text');

        const patch = stub.requests.filter((request) => request.method === 'PATCH').at(-1);
        // Relative tag edits merge with the tags already on the document.
        assert.deepEqual(JSON.parse(patch!.body), { title: 'Renamed', tags: [1, 2] });
    });

    test('suggestions come back with names attached', async () => {
        const { text } = await client.callTool('paperless_get_document_suggestions', { id: 42 });
        const payload = JSON.parse(text);
        assert.deepEqual(payload.tags, [
            { id: 1, name: 'unpaid' },
            { id: 2, name: 'inbox' },
        ]);
        assert.deepEqual(payload.correspondents, [{ id: 7, name: 'ACME Corp' }]);
    });

    test('download writes the file and honours the server filename', async () => {
        const { text } = await client.callTool('paperless_download_document', { id: 42 });
        const payload = JSON.parse(text);

        assert.equal(payload.path, path.join(downloadDir, 'acme-invoice.pdf'));
        assert.equal(payload.contentType, 'application/pdf');
        assert.equal(payload.bytes, 21);
        assert.equal(await readFile(payload.path, 'utf8'), '%PDF-1.7 stub payload');
    });

    test('download refuses a destination outside the download directory', async () => {
        for (const destination of ['/tmp/paperless-escape.pdf', '../escaped.pdf', path.join(downloadDir, '..', 'x.pdf')]) {
            const { text, isError } = await client.callTool('paperless_download_document', {
                id: 42,
                dest_path: destination,
            });
            assert.equal(isError, true, `${destination} should have been refused`);
            assert.match(text, /must stay inside/);
        }
    });

    test('download takes a relative dest_path as relative to the download directory', async () => {
        const { text, isError } = await client.callTool('paperless_download_document', {
            id: 42,
            dest_path: 'sub/dir/renamed.pdf',
        });
        assert.equal(isError, false);
        assert.equal(JSON.parse(text).path, path.join(downloadDir, 'sub', 'dir', 'renamed.pdf'));
    });

    test('upload posts a multipart body and returns the queued task', async () => {
        const filePath = path.join(downloadDir, 'receipt.pdf');
        await writeFile(filePath, '%PDF-1.7 receipt');

        const { text, isError } = await client.callTool('paperless_upload_document', {
            file_path: filePath,
            title: 'Corner shop receipt',
            created: '2024-08-17',
            correspondent_id: 7,
            tag_ids: [1, 2],
            custom_fields: { '9': 'ACME-1234' },
        });
        assert.equal(isError, false);

        const payload = JSON.parse(text);
        assert.equal(payload.task_id, 'c2a1f0de-0000-4000-8000-000000000001');
        assert.equal(payload.status, 'queued');

        const upload = stub.requests.filter((request) => request.path === '/api/documents/post_document/').at(-1);
        assert.ok(upload, 'the stub received the upload');
        assert.equal(upload.authorization, 'Token test-token');
        // Each tag is repeated as its own form field rather than sent as a list.
        assert.equal(upload.body.match(/name="tags"/g)?.length, 2);
        assert.match(upload.body, /name="title"\r?\n\r?\nCorner shop receipt/);
        assert.match(upload.body, /name="correspondent"\r?\n\r?\n7/);
        assert.match(upload.body, /name="custom_fields"\r?\n\r?\n\{"9":"ACME-1234"\}/);
        assert.match(upload.body, /filename="receipt\.pdf"/);
        assert.match(upload.body, /%PDF-1\.7 receipt/);
    });

    test('upload can wait for consumption and report the created document', async () => {
        const filePath = path.join(downloadDir, 'receipt2.pdf');
        await writeFile(filePath, '%PDF-1.7 receipt two');

        const { text } = await client.callTool('paperless_upload_document', {
            file_path: filePath,
            wait_seconds: 10,
        });

        const payload = JSON.parse(text);
        assert.equal(payload.status, 'SUCCESS');
        assert.equal(payload.document_id, 99);
        assert.match(payload.result, /New document id 99/);
    });

    test('upload refuses a file outside the allowed directories', async () => {
        const outside = path.join(os.tmpdir(), `paperless-outside-${process.pid}.pdf`);
        await writeFile(outside, 'secret');

        const { text, isError } = await client.callTool('paperless_upload_document', { file_path: outside });
        assert.equal(isError, true);
        assert.match(text, /may only read from/);

        const posts = stub.requests.filter((request) => request.path === '/api/documents/post_document/');
        assert.ok(
            posts.every((request) => !request.body.includes('secret')),
            'the refused file must never reach paperless',
        );
    });

    test('the raw API tool cannot climb out of /api/', async () => {
        const { text, isError } = await client.callTool('paperless_api_request', { path: '../../admin' });
        assert.equal(isError, true);
        assert.match(text, /may not contain a "\.\." segment/);

        assert.ok(
            stub.requests.every((request) => request.path.startsWith('/api/')),
            'no request may have left the /api/ prefix',
        );
    });

    test('upload reports a readable error for a missing file', async () => {
        const { text, isError } = await client.callTool('paperless_upload_document', {
            file_path: path.join(downloadDir, 'does-not-exist.pdf'),
        });
        assert.equal(isError, true);
        assert.match(text, /Cannot read file to upload/);
    });

    test('listing objects returns ids alongside names', async () => {
        const { text } = await client.callTool('paperless_list_objects', { type: 'tags' });
        const payload = JSON.parse(text);
        assert.equal(payload.type, 'tags');
        assert.deepEqual(payload.results[1], {
            id: 2,
            name: 'inbox',
            colour: '#ff0000',
            is_inbox_tag: true,
            document_count: 5,
        });
    });

    test('bulk edit forwards the right method and parameters', async () => {
        const { isError } = await client.callTool('paperless_bulk_edit_documents', {
            document_ids: [42],
            method: 'modify_tags',
            add_tag_ids: [2],
            remove_tag_ids: [1],
        });
        assert.equal(isError, false);

        const call = stub.requests.filter((request) => request.path === '/api/documents/bulk_edit/').at(-1);
        assert.deepEqual(JSON.parse(call!.body), {
            documents: [42],
            method: 'modify_tags',
            parameters: { add_tags: [2], remove_tags: [1] },
        });
    });

    test('deleting documents needs explicit confirmation', async () => {
        const { text } = await client.callTool('paperless_bulk_edit_documents', {
            document_ids: [42],
            method: 'delete',
        });
        assert.match(text, /Refusing to delete 1 document/);

        const attempted = stub.requests.some(
            (request) => request.path === '/api/documents/bulk_edit/' && request.body.includes('"delete"'),
        );
        assert.equal(attempted, false, 'no request should reach the server without confirmation');
    });

    test('a missing document produces a readable error, not a crash', async () => {
        const { text, isError } = await client.callTool('paperless_get_document', { id: 1234 });
        assert.equal(isError, true);
        assert.match(text, /404/);
        assert.match(text, /does not exist on this server/);
    });

    test('invalid arguments are rejected by the schema before any HTTP call', async () => {
        const before = stub.requests.length;

        const wrongType = await client.callTool('paperless_get_document', { id: 'forty-two' });
        assert.equal(wrongType.isError, true);
        assert.match(wrongType.text, /id: Invalid input: expected number/);

        const missing = await client.callTool('paperless_get_document', {});
        assert.equal(missing.isError, true);
        assert.match(missing.text, /id: Invalid input/);

        assert.equal(stub.requests.length, before, 'validation should short-circuit before reaching paperless');
    });

    test('system status reports what it is connected to', async () => {
        const { text } = await client.callTool('paperless_get_system_status');
        const payload = JSON.parse(text);
        assert.equal(payload.connected_to, stub.url);
        assert.equal(payload.server_version, '2.18.4');
        assert.equal(payload.api_version, '10');
        assert.equal(payload.read_only_mode, false);
    });

    test('the raw request escape hatch reaches uncovered endpoints', async () => {
        const { text } = await client.callTool('paperless_api_request', {
            method: 'GET',
            path: 'documents/42/suggestions',
        });
        assert.match(text, /"correspondents"/);
    });

    test('the escape hatch refuses a query string smuggled into the path', async () => {
        const { text } = await client.callTool('paperless_api_request', { path: 'documents/?page=2' });
        assert.match(text, /Put query parameters in `query`/);
    });
});

describe('read-only mode', () => {
    const stub = new StubPaperless();
    let client: StdioClient;

    before(async () => {
        await stub.start();
        client = new StdioClient({
            PAPERLESS_URL: stub.url,
            PAPERLESS_TOKEN: 'test-token',
            PAPERLESS_READ_ONLY: '1',
        });
        await client.initialize();
    });

    after(async () => {
        client.close();
        await stub.stop();
    });

    test('reads still work', async () => {
        const { isError } = await client.callTool('paperless_get_statistics');
        assert.equal(isError, false);
    });

    test('writes are refused before any request is sent', async () => {
        const { text, isError } = await client.callTool('paperless_update_document', { id: 42, title: 'nope' });
        assert.equal(isError, true);
        assert.match(text, /PAPERLESS_READ_ONLY/);
        assert.equal(
            stub.requests.some((request) => request.method === 'PATCH'),
            false,
        );
    });

    test('confirmed destructive calls are still refused', async () => {
        const { text, isError } = await client.callTool('paperless_bulk_edit_documents', {
            document_ids: [42],
            method: 'delete',
            confirm: true,
        });
        assert.equal(isError, true);
        assert.match(text, /PAPERLESS_READ_ONLY/);
    });
});

describe('startup failures', () => {
    test('a missing URL exits with a message on stderr', async () => {
        const child = spawn(process.execPath, [ENTRY], {
            env: { ...process.env, PAPERLESS_URL: '', PAPERLESS_TOKEN: 'x' },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stderr = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
            stderr += chunk;
        });

        const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
        assert.equal(code, 1);
        assert.match(stderr, /PAPERLESS_URL is not set/);
    });

    test('missing credentials exit with a message naming the token', async () => {
        const child = spawn(process.execPath, [ENTRY], {
            env: { ...process.env, PAPERLESS_URL: 'https://example.com', PAPERLESS_TOKEN: '', PAPERLESS_USERNAME: '' },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stderr = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
            stderr += chunk;
        });

        const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
        assert.equal(code, 1);
        assert.match(stderr, /PAPERLESS_TOKEN/);
    });
});
