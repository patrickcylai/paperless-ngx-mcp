import * as z from 'zod';

import type { PaginatedResponse, Query } from '../client.ts';
import { compact, handle, json, pageInfo, text } from '../format.ts';
import { NAMED_ENDPOINTS, type NamedEndpoint } from '../names.ts';
import type { Deps, McpServer } from './types.ts';

/** Endpoints exposed through the generic object tools. */
const LISTABLE = [
    'tags',
    'correspondents',
    'document_types',
    'storage_paths',
    'custom_fields',
    'saved_views',
    'users',
    'groups',
    'mail_accounts',
    'mail_rules',
    'workflows',
    'share_links',
] as const;
type Listable = (typeof LISTABLE)[number];

/** Subset that supports create/update/delete through these tools. */
const EDITABLE = ['tags', 'correspondents', 'document_types', 'storage_paths', 'custom_fields'] as const;

const MATCHING_ALGORITHMS =
    'Matching algorithm: 0 none, 1 any word, 2 all words, 3 exact, 4 regex, 5 fuzzy, 6 auto (trained classifier).';

function isNamed(endpoint: string): endpoint is NamedEndpoint {
    return (NAMED_ENDPOINTS as readonly string[]).includes(endpoint);
}

/** Trims the verbose fields the API returns so listings stay cheap to read. */
function slim(endpoint: Listable, object: Record<string, unknown>): Record<string, unknown> {
    if (endpoint === 'custom_fields') {
        return compact({
            id: object.id,
            name: object.name,
            data_type: object.data_type,
            extra_data: object.extra_data,
            document_count: object.document_count,
        });
    }
    if (endpoint === 'users') {
        return compact({
            id: object.id,
            username: object.username,
            first_name: object.first_name,
            last_name: object.last_name,
            is_superuser: object.is_superuser,
            is_active: object.is_active,
        });
    }
    if (endpoint === 'saved_views') {
        return compact({
            id: object.id,
            name: object.name,
            sort_field: object.sort_field,
            sort_reverse: object.sort_reverse,
            filter_rules: object.filter_rules,
        });
    }
    return compact({
        id: object.id,
        name: object.name,
        slug: object.slug,
        colour: object.color ?? object.colour,
        match: object.match,
        matching_algorithm: object.matching_algorithm,
        is_insensitive: object.is_insensitive,
        is_inbox_tag: object.is_inbox_tag,
        path: object.path,
        document_count: object.document_count,
        owner: object.owner,
    });
}

export function registerObjectTools(server: McpServer, deps: Deps): void {
    const { client, names } = deps;

    server.registerTool(
        'paperless_list_objects',
        {
            title: 'List tags, correspondents and other objects',
            description:
                'List the objects documents are filed under, with their ids and document counts. Call this first when ' +
                'you need an id for a tag, correspondent, document type, storage path or custom field — the document ' +
                'tools take ids, not names. Also reaches saved views, users, groups, mail accounts, mail rules, ' +
                'workflows and share links.',
            annotations: { readOnlyHint: true, openWorldHint: true },
            inputSchema: z.object({
                type: z.enum(LISTABLE).describe('Which collection to list.'),
                name_contains: z
                    .string()
                    .optional()
                    .describe('Case-insensitive substring filter on the name (username, for `users`).'),
                ordering: z
                    .string()
                    .optional()
                    .describe('Sort field, `-` prefix for descending, e.g. `name`, `-document_count`.'),
                page: z.number().int().min(1).default(1),
                page_size: z.number().int().min(1).max(250).default(100),
                all_pages: z
                    .boolean()
                    .default(false)
                    .describe('Fetch every page (capped at 1000 objects) instead of a single page.'),
            }),
        },
        async (args) =>
            handle('List objects', async () => {
                const query: Query = {
                    // Users are named by `username`; everything else here has a `name`.
                    [args.type === 'users' ? 'username__icontains' : 'name__icontains']: args.name_contains,
                    ordering: args.ordering,
                };

                if (args.all_pages) {
                    const objects = await client.listAll<Record<string, unknown>>(args.type, query, 1000);
                    return json({ type: args.type, count: objects.length, results: objects.map((o) => slim(args.type, o)) });
                }

                const response = await client.get<PaginatedResponse<Record<string, unknown>> | Record<string, unknown>[]>(
                    args.type,
                    { ...query, page: args.page, page_size: args.page_size },
                );

                // A few endpoints are unpaginated on older API versions.
                if (Array.isArray(response)) {
                    return json({ type: args.type, count: response.length, results: response.map((o) => slim(args.type, o)) });
                }

                return json({
                    type: args.type,
                    ...pageInfo(response.count ?? 0, args.page, args.page_size),
                    results: (response.results ?? []).map((o) => slim(args.type, o)),
                });
            }),
    );

    server.registerTool(
        'paperless_create_object',
        {
            title: 'Create a tag, correspondent or type',
            description:
                'Create a tag, correspondent, document type, storage path or custom field. ' +
                `${MATCHING_ALGORITHMS} ` +
                'Storage paths need a `path` template such as `{{ created_year }}/{{ correspondent }}/{{ title }}`. ' +
                'Custom fields need a `data_type` (string, url, date, boolean, integer, float, monetary, documentlink, select).',
            annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
            inputSchema: z.object({
                type: z.enum(EDITABLE).describe('What to create.'),
                name: z.string().min(1).describe('Name of the new object.'),
                colour: z.string().optional().describe('Tags only: hex colour such as `#a6cee3`.'),
                is_inbox_tag: z.boolean().optional().describe('Tags only: mark newly consumed documents with this tag.'),
                match: z.string().optional().describe('Match text or pattern used for automatic assignment.'),
                matching_algorithm: z.number().int().min(0).max(6).optional().describe(MATCHING_ALGORITHMS),
                is_insensitive: z.boolean().optional().describe('Case-insensitive matching. Defaults to true server-side.'),
                path: z.string().optional().describe('Storage paths only: the filename template.'),
                data_type: z
                    .enum([
                        'string',
                        'url',
                        'date',
                        'boolean',
                        'integer',
                        'float',
                        'monetary',
                        'documentlink',
                        'select',
                    ])
                    .optional()
                    .describe('Custom fields only: the value type.'),
                extra_data: z
                    .record(z.string(), z.unknown())
                    .optional()
                    .describe('Custom fields only, e.g. `{"select_options":[{"label":"Cat"},{"label":"Dog"}]}`.'),
            }),
        },
        async (args) =>
            handle('Create object', async () => {
                client.assertWritable(`create a ${args.type} entry`);

                if (args.type === 'storage_paths' && !args.path) {
                    return text('Creating a storage path requires `path`, e.g. `{{ created_year }}/{{ title }}`.');
                }
                if (args.type === 'custom_fields' && !args.data_type) {
                    return text('Creating a custom field requires `data_type`.');
                }

                const body = compact({
                    name: args.name,
                    color: args.type === 'tags' ? args.colour : undefined,
                    is_inbox_tag: args.type === 'tags' ? args.is_inbox_tag : undefined,
                    match: args.match,
                    matching_algorithm: args.matching_algorithm,
                    is_insensitive: args.is_insensitive,
                    path: args.type === 'storage_paths' ? args.path : undefined,
                    data_type: args.type === 'custom_fields' ? args.data_type : undefined,
                    extra_data: args.type === 'custom_fields' ? args.extra_data : undefined,
                });

                const created = await client.post<Record<string, unknown>>(args.type, body);
                if (isNamed(args.type)) names.invalidate(args.type);
                return json({ created: args.type, object: slim(args.type, created) });
            }),
    );

    server.registerTool(
        'paperless_update_object',
        {
            title: 'Update a tag, correspondent or type',
            description:
                'Rename or reconfigure an existing tag, correspondent, document type, storage path or custom field. ' +
                'Only the fields you pass are changed.',
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
            inputSchema: z.object({
                type: z.enum(EDITABLE).describe('What to update.'),
                id: z.number().int().describe('Id of the object.'),
                name: z.string().optional(),
                colour: z.string().optional().describe('Tags only: hex colour.'),
                is_inbox_tag: z.boolean().optional().describe('Tags only.'),
                match: z.string().optional(),
                matching_algorithm: z.number().int().min(0).max(6).optional().describe(MATCHING_ALGORITHMS),
                is_insensitive: z.boolean().optional(),
                path: z.string().optional().describe('Storage paths only.'),
                extra_data: z.record(z.string(), z.unknown()).optional().describe('Custom fields only.'),
                owner_id: z.number().int().nullable().optional(),
            }),
        },
        async (args) =>
            handle('Update object', async () => {
                client.assertWritable(`update a ${args.type} entry`);

                const body: Record<string, unknown> = compact({
                    name: args.name,
                    color: args.type === 'tags' ? args.colour : undefined,
                    is_inbox_tag: args.type === 'tags' ? args.is_inbox_tag : undefined,
                    match: args.match,
                    matching_algorithm: args.matching_algorithm,
                    is_insensitive: args.is_insensitive,
                    path: args.type === 'storage_paths' ? args.path : undefined,
                    extra_data: args.type === 'custom_fields' ? args.extra_data : undefined,
                });
                if (args.owner_id !== undefined) body.owner = args.owner_id;

                if (Object.keys(body).length === 0) {
                    return text('Nothing to update: no fields were provided.');
                }

                const updated = await client.patch<Record<string, unknown>>(`${args.type}/${args.id}`, body);
                if (isNamed(args.type)) names.invalidate(args.type);
                return json({ updated: Object.keys(body), object: slim(args.type, updated) });
            }),
    );

    server.registerTool(
        'paperless_delete_objects',
        {
            title: 'Delete tags, correspondents or types',
            description:
                'Permanently delete tags, correspondents, document types or storage paths. Documents themselves are not ' +
                'deleted, but they lose the association. Requires `confirm: true`.',
            annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
            inputSchema: z.object({
                type: z.enum(['tags', 'correspondents', 'document_types', 'storage_paths']).describe('What to delete.'),
                ids: z.array(z.number().int()).min(1).describe('Ids to delete.'),
                confirm: z.boolean().default(false).describe('Must be true; this cannot be undone.'),
            }),
        },
        async (args) =>
            handle('Delete objects', async () => {
                client.assertWritable(`delete ${args.type} entries`);

                if (!args.confirm) {
                    const labels = isNamed(args.type) ? await names.resolveMany(args.type, args.ids) : args.ids.map(String);
                    return text(
                        `Refusing to delete ${args.ids.length} ${args.type} entry/entries without confirmation: ` +
                            `${labels.join(', ')}. Re-run with confirm: true if this is intended.`,
                    );
                }

                const result = await client.post('bulk_edit_objects', {
                    objects: args.ids,
                    object_type: args.type,
                    operation: 'delete',
                });

                if (isNamed(args.type)) names.invalidate(args.type);
                return json({ deleted: args.type, ids: args.ids, result });
            }),
    );
}
