import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
    createMcpHandler,
    hostHeaderValidationResponse,
    localhostAllowedHostnames,
    localhostAllowedOrigins,
    type McpServer,
    originValidationResponse,
} from '@modelcontextprotocol/server';

import type { TransportConfig } from './config.ts';

/** Node's http server predates the Web `Request`, which is what the MCP handler speaks. */
async function toWebRequest(incoming: http.IncomingMessage, origin: string): Promise<Request> {
    const url = new URL(incoming.url ?? '/', origin);

    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        else headers.set(name, value);
    }

    const method = incoming.method ?? 'GET';
    if (method === 'GET' || method === 'HEAD') {
        return new Request(url, { method, headers });
    }

    // MCP request bodies are small JSON documents, so buffering keeps this
    // simple and sidesteps the half-duplex streaming dance.
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Buffer);

    return new Request(url, { method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
}

async function writeWebResponse(response: Response, outgoing: http.ServerResponse): Promise<void> {
    for (const [name, value] of response.headers) outgoing.setHeader(name, value);
    outgoing.writeHead(response.status);

    if (!response.body) {
        outgoing.end();
        return;
    }

    // Streams through, so an SSE response is delivered as it is produced.
    await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), outgoing);
}

function sendJson(outgoing: http.ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    outgoing.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    outgoing.end(body);
}

/** Constant-time bearer comparison, so a wrong token leaks nothing through timing. */
function bearerMatches(header: string | undefined, expected: string): boolean {
    const presented = /^Bearer (.+)$/i.exec(header ?? '')?.[1]?.trim();
    if (!presented) return false;

    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}

export interface HttpServerHandle {
    port: number;
    close(): Promise<void>;
}

export async function startHttpServer(
    factory: () => McpServer,
    transport: TransportConfig,
    log: (message: string) => void,
): Promise<HttpServerHandle> {
    const handler = createMcpHandler(factory, {
        onerror: (error) => log(`handler error: ${error.message}`),
    });

    const allowedHosts = transport.allowedHosts.length ? transport.allowedHosts : localhostAllowedHostnames();
    const allowedOrigins = transport.allowedOrigins.length ? transport.allowedOrigins : localhostAllowedOrigins();
    const anyHost = transport.allowedHosts.includes('*');
    const anyOrigin = transport.allowedOrigins.includes('*');

    const server = http.createServer((incoming, outgoing) => {
        void (async () => {
            try {
                const hostHeader = incoming.headers.host ?? `${transport.host}:${transport.port}`;
                const origin = `http://${hostHeader}`;
                const pathname = new URL(incoming.url ?? '/', origin).pathname;

                // Unauthenticated on purpose: container health checks must not need a token,
                // and it reports nothing beyond "this process is up".
                if (pathname === '/healthz') {
                    sendJson(outgoing, 200, { status: 'ok', transport: 'http' });
                    return;
                }

                if (pathname !== transport.path) {
                    sendJson(outgoing, 404, { error: `No MCP endpoint here. POST to ${transport.path}.` });
                    return;
                }

                if (transport.authToken && !bearerMatches(incoming.headers.authorization, transport.authToken)) {
                    outgoing.setHeader('WWW-Authenticate', 'Bearer realm="paperless-mcp"');
                    sendJson(outgoing, 401, { error: 'Missing or invalid bearer token.' });
                    return;
                }

                const request = await toWebRequest(incoming, origin);

                // DNS-rebinding and cross-origin protection for a local HTTP endpoint.
                const rejected =
                    (anyHost ? undefined : hostHeaderValidationResponse(request, allowedHosts)) ??
                    (anyOrigin ? undefined : originValidationResponse(request, allowedOrigins));
                if (rejected) {
                    await writeWebResponse(rejected, outgoing);
                    return;
                }

                await writeWebResponse(await handler.fetch(request), outgoing);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                log(`request failed: ${message}`);
                if (!outgoing.headersSent) sendJson(outgoing, 500, { error: message });
                else outgoing.end();
            }
        })();
    });

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(transport.port, transport.host, () => {
            server.removeListener('error', reject);
            resolve();
        });
    });

    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : transport.port;

    return {
        port,
        async close() {
            await handler.close();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}
