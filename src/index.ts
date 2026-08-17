#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { PaperlessClient } from './client.ts';
import {
    ConfigError,
    loadConfig,
    loadTransportConfig,
    type PaperlessConfig,
    type TransportConfig,
} from './config.ts';
import { startHttpServer } from './http.ts';
import { NAMED_ENDPOINTS, NameCache } from './names.ts';
import { registerDocumentTools } from './tools/documents.ts';
import { registerObjectTools } from './tools/objects.ts';
import { registerSystemTools } from './tools/system.ts';

const VERSION = '0.1.0';

function createServer(config: PaperlessConfig): McpServer {
    const client = new PaperlessClient(config);
    const names = new NameCache(client);
    const deps = { client, names, config };

    const server = new McpServer(
        { name: 'paperless-ngx', version: VERSION },
        {
            capabilities: { tools: {}, resources: {} },
            instructions:
                'Tools for a paperless-ngx document archive. Documents are referenced by numeric id, and tags, ' +
                'correspondents, document types and storage paths are referenced by their own ids — call ' +
                '`paperless_list_objects` (or read the `paperless://taxonomy` resource) to turn a name into an id ' +
                'before filtering or filing. Search with `paperless_search_documents`, then read a specific document ' +
                'with `paperless_get_document`. Destructive operations require an explicit `confirm: true`.' +
                (config.readOnly ? ' This server is in read-only mode; all mutating tools will refuse to run.' : ''),
        },
    );

    registerDocumentTools(server, deps);
    registerObjectTools(server, deps);
    registerSystemTools(server, deps);

    server.registerResource(
        'taxonomy',
        'paperless://taxonomy',
        {
            title: 'Paperless taxonomy',
            description: 'Every tag, correspondent, document type, storage path and custom field with its id.',
            mimeType: 'application/json',
        },
        async (uri) => {
            const entries = await Promise.all(
                NAMED_ENDPOINTS.map(async (endpoint) => {
                    const map = await names.names(endpoint);
                    return [endpoint, [...map].map(([id, name]) => ({ id, name }))] as const;
                }),
            );
            return {
                contents: [
                    {
                        uri: uri.href,
                        mimeType: 'application/json',
                        text: JSON.stringify(Object.fromEntries(entries), null, 2),
                    },
                ],
            };
        },
    );

    server.registerResource(
        'statistics',
        'paperless://statistics',
        {
            title: 'Paperless statistics',
            description: 'Document counts, inbox size and file-type breakdown for the library.',
            mimeType: 'application/json',
        },
        async (uri) => ({
            contents: [
                {
                    uri: uri.href,
                    mimeType: 'application/json',
                    text: JSON.stringify(await client.get('statistics'), null, 2),
                },
            ],
        }),
    );

    return server;
}

/** stdout belongs to the stdio transport, so all logging goes to stderr. */
function log(message: string): void {
    process.stderr.write(`${message}\n`);
}

function isLoopback(host: string): boolean {
    return ['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1'].includes(host);
}

async function main(): Promise<void> {
    let config: PaperlessConfig;
    let transport: TransportConfig;
    try {
        config = loadConfig();
        transport = loadTransportConfig();
    } catch (error) {
        if (error instanceof ConfigError) {
            log(`paperless-ngx MCP server: ${error.message}`);
            process.exit(1);
        }
        throw error;
    }

    log(`paperless-ngx MCP server ${VERSION} → ${config.baseUrl}${config.readOnly ? ' (read-only)' : ''}`);

    if (transport.kind === 'stdio') {
        // One factory instance serves the connection; the SDK pins it per protocol era.
        serveStdio(() => createServer(config));
        return;
    }

    const handle = await startHttpServer(() => createServer(config), transport, log);
    log(`listening on http://${transport.host}:${handle.port}${transport.path} (health: /healthz)`);

    if (!transport.authToken && !isLoopback(transport.host)) {
        log(
            `WARNING: bound to ${transport.host} with no MCP_AUTH_TOKEN set. Anyone who can reach this port can ` +
                'read and modify your document archive. Set MCP_AUTH_TOKEN, or publish the port to loopback only.',
        );
    }

    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.once(signal, () => {
            log(`received ${signal}, shutting down`);
            void handle.close().then(
                () => process.exit(0),
                () => process.exit(1),
            );
        });
    }
}

await main();
