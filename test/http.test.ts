import assert from 'node:assert/strict';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import http from 'node:http';
import test, { after, before, describe } from 'node:test';
import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));

/** Enough of the paperless API for the HTTP transport tests. */
async function startStubPaperless(): Promise<{ url: string; stop: () => Promise<void> }> {
    const server = http.createServer((request, response) => {
        request.resume();
        const route = new URL(request.url ?? '/', 'http://stub').pathname;
        const body =
            route === '/api/statistics/'
                ? { documents_total: 7, documents_inbox: 2 }
                : { count: 0, next: null, previous: null, results: [] };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (typeof address === 'string' || address === null) throw new Error('stub has no port');

    return {
        url: `http://127.0.0.1:${address.port}`,
        stop: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
    };
}

interface Started {
    child: ChildProcessWithoutNullStreams;
    baseUrl: string;
    stderr: () => string;
}

/** Boots the server in HTTP mode and waits for the line that reports its port. */
async function startServer(env: Record<string, string>): Promise<Started> {
    const child = spawn(process.execPath, [ENTRY], {
        env: { ...process.env, MCP_TRANSPORT: 'http', MCP_HTTP_PORT: '0', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.setEncoding('utf8');

    const baseUrl = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`server did not report a port. stderr:\n${stderr}`)), 15_000);
        child.stderr.on('data', (chunk: string) => {
            stderr += chunk;
            const match = /listening on (http:\/\/\S+?)(\/\S*)?\s/.exec(stderr);
            if (match) {
                clearTimeout(timer);
                resolve(match[1]);
            }
        });
        child.once('exit', (code) => {
            clearTimeout(timer);
            reject(new Error(`server exited with ${code}. stderr:\n${stderr}`));
        });
    });

    return { child, baseUrl, stderr: () => stderr };
}

/** Streamable HTTP replies as SSE, so pull the JSON-RPC payload out of the event stream. */
function parseRpc(body: string): any {
    const trimmed = body.trim();
    if (trimmed.startsWith('{')) return JSON.parse(trimmed);

    const line = trimmed
        .split('\n')
        .find((entry) => entry.startsWith('data:'));
    if (!line) throw new Error(`no JSON-RPC payload in response: ${body}`);
    return JSON.parse(line.slice('data:'.length).trim());
}

async function rpc(
    baseUrl: string,
    body: unknown,
    headers: Record<string, string> = {},
): Promise<{ status: number; payload: any }> {
    const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...headers,
        },
        body: JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, payload: response.ok ? parseRpc(text) : text };
}

const INITIALIZE = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'http-test', version: '0' } },
};

describe('HTTP transport', () => {
    let stub: Awaited<ReturnType<typeof startStubPaperless>>;
    let server: Started;

    before(async () => {
        stub = await startStubPaperless();
        server = await startServer({ PAPERLESS_URL: stub.url, PAPERLESS_TOKEN: 'test-token' });
    });

    after(async () => {
        server.child.kill();
        await stub.stop();
    });

    test('health check answers without a token and does not touch paperless', async () => {
        const response = await fetch(`${server.baseUrl}/healthz`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { status: 'ok', transport: 'http' });
    });

    test('the MCP endpoint completes a handshake', async () => {
        const { status, payload } = await rpc(server.baseUrl, INITIALIZE);
        assert.equal(status, 200);
        assert.equal(payload.result.serverInfo.name, 'paperless-ngx');
    });

    test('tools are listed over HTTP, matching the stdio surface', async () => {
        await rpc(server.baseUrl, INITIALIZE);
        const { payload } = await rpc(server.baseUrl, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
        assert.equal(payload.result.tools.length, 16);
    });

    test('a tool call reaches paperless and returns its data', async () => {
        await rpc(server.baseUrl, INITIALIZE);
        const { payload } = await rpc(server.baseUrl, {
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: 'paperless_get_statistics', arguments: {} },
        });

        assert.equal(payload.result.isError, undefined);
        assert.deepEqual(JSON.parse(payload.result.content[0].text), { documents_total: 7, documents_inbox: 2 });
    });

    test('an unknown path is refused with a pointer to the right one', async () => {
        const response = await fetch(`${server.baseUrl}/`);
        assert.equal(response.status, 404);
        assert.match((await response.json()).error, /POST to \/mcp/);
    });

    test('a foreign Host header is rejected, blocking DNS rebinding', async () => {
        const response = await fetch(`${server.baseUrl}/mcp`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
                host: 'evil.example.com',
            },
            body: JSON.stringify(INITIALIZE),
        });
        assert.equal(response.status, 421);
    });
});

describe('HTTP transport with a bearer token', () => {
    let stub: Awaited<ReturnType<typeof startStubPaperless>>;
    let server: Started;

    before(async () => {
        stub = await startStubPaperless();
        server = await startServer({
            PAPERLESS_URL: stub.url,
            PAPERLESS_TOKEN: 'test-token',
            MCP_AUTH_TOKEN: 's3cret-mcp-token',
        });
    });

    after(async () => {
        server.child.kill();
        await stub.stop();
    });

    test('requests without a token are rejected', async () => {
        const { status } = await rpc(server.baseUrl, INITIALIZE);
        assert.equal(status, 401);
    });

    test('requests with the wrong token are rejected', async () => {
        const { status } = await rpc(server.baseUrl, INITIALIZE, { authorization: 'Bearer wrong-token' });
        assert.equal(status, 401);
    });

    test('a token of a different length is rejected rather than crashing the comparison', async () => {
        const { status } = await rpc(server.baseUrl, INITIALIZE, { authorization: 'Bearer x' });
        assert.equal(status, 401);
    });

    test('the correct token is accepted', async () => {
        const { status, payload } = await rpc(server.baseUrl, INITIALIZE, {
            authorization: 'Bearer s3cret-mcp-token',
        });
        assert.equal(status, 200);
        assert.equal(payload.result.serverInfo.name, 'paperless-ngx');
    });

    test('the health check stays open so container probes keep working', async () => {
        assert.equal((await fetch(`${server.baseUrl}/healthz`)).status, 200);
    });
});

describe('HTTP transport warnings and validation', () => {
    test('binding to a non-loopback address without a token warns loudly', async () => {
        const stub = await startStubPaperless();
        const server = await startServer({
            PAPERLESS_URL: stub.url,
            PAPERLESS_TOKEN: 'test-token',
            MCP_HTTP_HOST: '0.0.0.0',
        });

        // The warning is written right after the listening line.
        await new Promise((resolve) => setTimeout(resolve, 250));
        assert.match(server.stderr(), /WARNING: bound to 0\.0\.0\.0 with no MCP_AUTH_TOKEN/);

        server.child.kill();
        await stub.stop();
    });

    test('an unknown transport name exits with a clear message', async () => {
        const child = spawn(process.execPath, [ENTRY], {
            env: { ...process.env, PAPERLESS_URL: 'https://example.com', PAPERLESS_TOKEN: 'x', MCP_TRANSPORT: 'grpc' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stderr = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
            stderr += chunk;
        });

        const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
        assert.equal(code, 1);
        assert.match(stderr, /MCP_TRANSPORT must be "stdio" or "http"/);
    });
});
