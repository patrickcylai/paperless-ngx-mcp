import * as z from 'zod';

import type { PaginatedResponse, Query } from '../client.ts';
import { compact, handle, json, pageInfo, text } from '../format.ts';
import type { Deps, McpServer } from './types.ts';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function registerSystemTools(server: McpServer, deps: Deps): void {
    const { client, config } = deps;

    server.registerTool(
        'paperless_get_statistics',
        {
            title: 'Library statistics',
            description:
                'Totals for the whole library: document count, documents in the inbox, characters indexed, counts of ' +
                'tags/correspondents/document types, and a breakdown by file type. A good first call to see how big the ' +
                'library is before searching it.',
            annotations: { readOnlyHint: true, openWorldHint: true },
            inputSchema: z.object({}),
        },
        async () => handle('Get statistics', async () => json(await client.get('statistics'))),
    );

    server.registerTool(
        'paperless_get_system_status',
        {
            title: 'System status',
            description:
                'Health of the paperless-ngx install: version, database and index status, Redis/Celery connectivity, ' +
                'plus the API version this server is talking to. Use this to check connectivity and diagnose failures.',
            annotations: { readOnlyHint: true, openWorldHint: true },
            inputSchema: z.object({}),
        },
        async () =>
            handle('Get system status', async () => {
                const [status, versions] = await Promise.all([
                    client.get<Record<string, unknown>>('status').catch((error: unknown) => ({
                        error: error instanceof Error ? error.message : String(error),
                    })),
                    client.serverVersions().catch(() => ({ apiVersion: null, version: null })),
                ]);

                return json(
                    compact({
                        connected_to: config.baseUrl,
                        server_version: versions.version,
                        api_version: versions.apiVersion,
                        requested_api_version: config.apiVersion ?? '(server default)',
                        read_only_mode: config.readOnly,
                        download_dir: config.downloadDir,
                        status,
                    }),
                );
            }),
    );

    server.registerTool(
        'paperless_list_tasks',
        {
            title: 'List background tasks',
            description:
                'Inspect paperless’ background tasks — document consumption, index rebuilds, and so on. Use this to ' +
                'follow up on an upload: pass the `task_id` returned by `paperless_upload_document` to see whether ' +
                'consumption succeeded and which document it produced.',
            annotations: { readOnlyHint: true, openWorldHint: true },
            inputSchema: z.object({
                task_id: z.string().optional().describe('Look up one task by its UUID.'),
                status: z
                    .enum(['PENDING', 'STARTED', 'SUCCESS', 'FAILURE', 'RETRY', 'REVOKED'])
                    .optional()
                    .describe('Only tasks in this state.'),
                acknowledged: z.boolean().optional().describe('Filter on whether the task has been acknowledged in the UI.'),
                page: z.number().int().min(1).default(1),
                page_size: z.number().int().min(1).max(100).default(25),
            }),
        },
        async (args) =>
            handle('List tasks', async () => {
                const query: Query = {
                    task_id: args.task_id,
                    status: args.status,
                    acknowledged: args.acknowledged,
                    page: args.page,
                    page_size: args.page_size,
                };

                const response = await client.get<PaginatedResponse<Record<string, unknown>> | Record<string, unknown>[]>(
                    'tasks',
                    query,
                );

                const slim = (task: Record<string, unknown>) =>
                    compact({
                        id: task.id,
                        task_id: task.task_id,
                        // `task_type` on API v10, `task_name` on v9.
                        type: task.task_type ?? task.task_name,
                        status: task.status,
                        file_name: task.task_file_name,
                        created: task.date_created,
                        done: task.date_done,
                        related_document: task.related_document,
                        result: task.result,
                    });

                // API v9 serves this endpoint unpaginated; v10 paginates it.
                if (Array.isArray(response)) {
                    return json({ count: response.length, results: response.map(slim) });
                }
                return json({
                    ...pageInfo(response.count ?? 0, args.page, args.page_size),
                    results: (response.results ?? []).map(slim),
                });
            }),
    );

    server.registerTool(
        'paperless_api_request',
        {
            title: 'Raw API request',
            description:
                'Escape hatch for any paperless-ngx REST endpoint the other tools do not cover — workflows, share links, ' +
                'mail rules, trash, document merge/rotate/edit_pdf, permissions, and so on. `path` is relative to `/api/`, ' +
                'e.g. `documents/12/history`, `trash`, `share_links`. Trailing slashes are added automatically. ' +
                'Browse the full schema for your server at `<paperless-url>/api/schema/view/`. ' +
                'Prefer the purpose-built tools when one fits; they return smaller, name-resolved output.',
            annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
            inputSchema: z.object({
                method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']).default('GET'),
                path: z.string().min(1).describe('Endpoint path relative to `/api/`, without a query string.'),
                query: z
                    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
                    .optional()
                    .describe('Query parameters.'),
                body: z.unknown().optional().describe('JSON request body, for POST/PATCH/PUT.'),
                max_chars: z
                    .number()
                    .int()
                    .min(500)
                    .max(200_000)
                    .default(20_000)
                    .describe('Truncate the response body at this many characters.'),
            }),
        },
        async (args) =>
            handle('API request', async () => {
                if (WRITE_METHODS.has(args.method)) {
                    client.assertWritable(`send a ${args.method} to ${args.path}`);
                }
                if (args.path.includes('?')) {
                    return text('Put query parameters in `query`, not in `path`.');
                }

                const result = await client.request<unknown>(args.method, args.path, {
                    query: args.query,
                    body: args.body,
                });

                const rendered = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
                const body = rendered ?? 'null';
                return text(
                    body.length > args.max_chars
                        ? `${body.slice(0, args.max_chars)}\n… [truncated: ${body.length} characters total]`
                        : body,
                );
            }),
    );
}
