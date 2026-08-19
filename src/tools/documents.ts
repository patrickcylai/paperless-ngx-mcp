import * as z from 'zod';

import type { PaginatedResponse, Query } from '../client.ts';
import { compact, handle, json, pageInfo, plainHighlights, text, truncate } from '../format.ts';
import type { Deps, McpServer } from './types.ts';

export interface PaperlessDocument {
    id: number;
    title: string;
    content?: string;
    correspondent: number | null;
    document_type: number | null;
    storage_path: number | null;
    tags: number[];
    created: string;
    added?: string;
    modified?: string;
    archive_serial_number: number | null;
    original_file_name?: string;
    archived_file_name?: string | null;
    owner?: number | null;
    page_count?: number | null;
    notes?: Array<{ id: number; note: string; created: string; user?: unknown }>;
    custom_fields?: Array<{ field: number; value: unknown }>;
    __search_hit__?: { score?: number; rank?: number; highlights?: string; note_highlights?: string };
}

interface TaskRecord {
    id?: number;
    task_id?: string;
    status?: string;
    result?: string | null;
    related_document?: string | number | null;
    task_file_name?: string | null;
}

const ORDERING_HINT =
    'Sort field, `-` prefix for descending. Common values: `created`, `-created`, `added`, `-added`, ' +
    '`modified`, `title`, `archive_serial_number`, `correspondent__name`, `document_type__name`, `num_notes`, `page_count`.';

/** Shared shape for the id/date/tag filters the document list endpoint accepts. */
const documentFilters = {
    tags_all: z.array(z.number().int()).optional().describe('Only documents carrying every one of these tag ids.'),
    tags_any: z.array(z.number().int()).optional().describe('Only documents carrying at least one of these tag ids.'),
    tags_none: z.array(z.number().int()).optional().describe('Exclude documents carrying any of these tag ids.'),
    correspondent_ids: z.array(z.number().int()).optional().describe('Restrict to these correspondent ids.'),
    document_type_ids: z.array(z.number().int()).optional().describe('Restrict to these document type ids.'),
    storage_path_ids: z.array(z.number().int()).optional().describe('Restrict to these storage path ids.'),
    title_contains: z.string().optional().describe('Case-insensitive substring match on the title.'),
    content_contains: z.string().optional().describe('Case-insensitive substring match on the extracted text.'),
    created_after: z.string().optional().describe('Inclusive lower bound on the document date, `YYYY-MM-DD`.'),
    created_before: z.string().optional().describe('Inclusive upper bound on the document date, `YYYY-MM-DD`.'),
    added_after: z.string().optional().describe('Inclusive lower bound on when it was added, `YYYY-MM-DD`.'),
    added_before: z.string().optional().describe('Inclusive upper bound on when it was added, `YYYY-MM-DD`.'),
    archive_serial_number: z.number().int().optional().describe('Exact archive serial number.'),
    is_tagged: z.boolean().optional().describe('true = only tagged documents, false = only untagged.'),
    is_in_inbox: z.boolean().optional().describe('true = only documents still carrying an inbox tag.'),
    mime_type: z.string().optional().describe('Substring match on mime type, e.g. `pdf`, `image/`.'),
    owner_ids: z.array(z.number().int()).optional().describe('Restrict to documents owned by these user ids.'),
    custom_field_query: z
        .string()
        .optional()
        .describe(
            'JSON custom-field query, passed through verbatim. Examples: `["due","range",["2024-08-01","2024-09-01"]]`, ' +
                '`["customer","exact","bob"]`, `["answered","exact",true]`, `["foo","exists",false]`. ' +
                'Operators: exact, in, isnull, exists (all types); icontains/istartswith/iendswith (text); ' +
                'gt/gte/lt/lte/range (number, date); contains (document link).',
        ),
    extra_filters: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe('Escape hatch for any other documented query parameter, e.g. `{"checksum__iexact":"…"}`.'),
};

type DocumentFilterArgs = {
    [K in keyof typeof documentFilters]?: z.infer<(typeof documentFilters)[K]>;
};

function toQuery(args: DocumentFilterArgs): Query {
    return {
        tags__id__all: args.tags_all,
        tags__id__in: args.tags_any,
        tags__id__none: args.tags_none,
        correspondent__id__in: args.correspondent_ids,
        document_type__id__in: args.document_type_ids,
        storage_path__id__in: args.storage_path_ids,
        owner__id__in: args.owner_ids,
        title__icontains: args.title_contains,
        content__icontains: args.content_contains,
        created__gte: args.created_after,
        created__lte: args.created_before,
        added__date__gte: args.added_after,
        added__date__lte: args.added_before,
        archive_serial_number: args.archive_serial_number,
        is_tagged: args.is_tagged,
        is_in_inbox: args.is_in_inbox,
        mime_type: args.mime_type,
        custom_field_query: args.custom_field_query,
        ...(args.extra_filters ?? {}),
    };
}

async function summarize(deps: Deps, document: PaperlessDocument, snippetChars = 300) {
    const [correspondent, documentType, storagePath, tags] = await Promise.all([
        deps.names.resolve('correspondents', document.correspondent),
        deps.names.resolve('document_types', document.document_type),
        deps.names.resolve('storage_paths', document.storage_path),
        deps.names.resolveMany('tags', document.tags),
    ]);

    const hit = document.__search_hit__;
    return compact({
        id: document.id,
        title: document.title,
        created: document.created,
        added: document.added,
        correspondent,
        document_type: documentType,
        storage_path: storagePath,
        tags,
        archive_serial_number: document.archive_serial_number,
        page_count: document.page_count,
        notes: document.notes?.length,
        score: hit?.score,
        highlights: plainHighlights(hit?.highlights),
        // Only fall back to a raw content snippet when the search gave us no highlight.
        snippet: hit?.highlights ? null : truncate(document.content?.replace(/\s+/g, ' ').trim() || null, snippetChars),
    });
}

async function expandCustomFields(deps: Deps, fields: PaperlessDocument['custom_fields']) {
    if (!fields?.length) return [];
    const names = await deps.names.names('custom_fields');
    return fields.map((entry) => ({
        field: entry.field,
        name: names.get(entry.field) ?? `#${entry.field}`,
        value: entry.value,
    }));
}

export function registerDocumentTools(server: McpServer, deps: Deps): void {
    const { client, names } = deps;

    server.registerTool(
        'paperless_search_documents',
        {
            title: 'Search documents',
            description:
                'Find documents in paperless-ngx. Combine full-text search with structured filters.\n' +
                '`query` uses the full-text index and supports the advanced syntax: `invoice AND (acme OR globex)`, ' +
                '`type:invoice tag:unpaid`, `correspondent:university`, `created:[2005 to 2009]`, `added:yesterday`, ' +
                '`produ*name`, `custom_fields.name:"Contract Number"`, `custom_fields.value:policy`, `notes.note:reminder`. ' +
                'Date keywords: today, yesterday, "previous week", "this month", "previous month", "this year", ' +
                '"previous year", "previous quarter". Matching is word-order-independent and accent-insensitive.\n' +
                'Use `title_contains`/`content_contains` instead for plain substring matching, or `more_like_id` to find ' +
                'documents similar to a known one. Tag/correspondent/type filters take ids — get them from ' +
                '`paperless_list_objects`. Returns names resolved, not raw ids.',
            annotations: { readOnlyHint: true, openWorldHint: true },
            inputSchema: z.object({
                query: z.string().optional().describe('Full-text query using the advanced search syntax described above.'),
                more_like_id: z
                    .number()
                    .int()
                    .optional()
                    .describe('Return documents similar to this document id. Cannot be combined with `query`.'),
                ...documentFilters,
                ordering: z.string().optional().describe(ORDERING_HINT),
                page: z.number().int().min(1).default(1).describe('1-based page number.'),
                page_size: z.number().int().min(1).max(100).default(25).describe('Results per page (max 100).'),
                snippet_chars: z
                    .number()
                    .int()
                    .min(0)
                    .max(2000)
                    .default(300)
                    .describe('Characters of document text to include per result when there is no search highlight.'),
            }),
        },
        async (args) =>
            handle('Document search', async () => {
                const query: Query = {
                    ...toQuery(args),
                    query: args.query,
                    more_like_id: args.more_like_id,
                    ordering: args.ordering,
                    page: args.page,
                    page_size: args.page_size,
                };

                const response = await client.get<PaginatedResponse<PaperlessDocument>>('documents', query);
                const results = await Promise.all(
                    (response.results ?? []).map((document) => summarize(deps, document, args.snippet_chars)),
                );

                return json({
                    ...pageInfo(response.count ?? results.length, args.page, args.page_size),
                    results,
                });
            }),
    );

    server.registerTool(
        'paperless_get_document',
        {
            title: 'Get document',
            description:
                'Fetch one document by id: metadata with names resolved, plus its extracted text, notes and custom ' +
                'field values. Use this after `paperless_search_documents` to read a document’s contents.',
            annotations: { readOnlyHint: true, openWorldHint: true },
            inputSchema: z.object({
                id: z.number().int().describe('Document id.'),
                include_content: z.boolean().default(true).describe('Include the extracted text.'),
                content_max_chars: z
                    .number()
                    .int()
                    .min(0)
                    .max(200_000)
                    .default(20_000)
                    .describe('Truncate the extracted text at this many characters.'),
                include_metadata: z
                    .boolean()
                    .default(false)
                    .describe('Also fetch file-level metadata (media filename, checksum, size, PDF fields).'),
                version: z.number().int().optional().describe('Resolve content against a specific document version id.'),
            }),
        },
        async (args) =>
            handle('Get document', async () => {
                const query: Query = { full_perms: true, version: args.version };
                const document = await client.get<PaperlessDocument>(`documents/${args.id}`, query);

                const [correspondent, documentType, storagePath, tags, customFields] = await Promise.all([
                    names.resolve('correspondents', document.correspondent),
                    names.resolve('document_types', document.document_type),
                    names.resolve('storage_paths', document.storage_path),
                    names.resolveMany('tags', document.tags),
                    expandCustomFields(deps, document.custom_fields),
                ]);

                const metadata = args.include_metadata
                    ? await client
                          .get<Record<string, unknown>>(`documents/${args.id}/metadata`, { version: args.version })
                          .catch(() => null)
                    : null;

                return json(
                    compact({
                        id: document.id,
                        title: document.title,
                        created: document.created,
                        added: document.added,
                        modified: document.modified,
                        correspondent,
                        correspondent_id: document.correspondent,
                        document_type: documentType,
                        document_type_id: document.document_type,
                        storage_path: storagePath,
                        storage_path_id: document.storage_path,
                        tags,
                        tag_ids: document.tags,
                        archive_serial_number: document.archive_serial_number,
                        original_file_name: document.original_file_name,
                        page_count: document.page_count,
                        owner: document.owner,
                        custom_fields: customFields,
                        notes: document.notes?.map((note) => ({ id: note.id, note: note.note, created: note.created })),
                        content: args.include_content ? truncate(document.content, args.content_max_chars) : undefined,
                        file_metadata: metadata,
                    }),
                );
            }),
    );

    server.registerTool(
        'paperless_download_document',
        {
            title: 'Download document file',
            description:
                'Save a document’s file to local disk and return the path. Use `kind: "original"` for the file as ' +
                'uploaded, `"archive"` for the OCR’d PDF paperless generated, `"thumbnail"` for a small preview image. ' +
                'Read the extracted text with `paperless_get_document` instead when you only need the words. ' +
                'Writes are confined to PAPERLESS_DOWNLOAD_DIR.',
            // Reads from paperless, but writes to the local filesystem — not read-only.
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
            inputSchema: z.object({
                id: z.number().int().describe('Document id.'),
                kind: z
                    .enum(['archive', 'original', 'preview', 'thumbnail'])
                    .default('archive')
                    .describe('Which rendition to fetch.'),
                dest_path: z
                    .string()
                    .optional()
                    .describe(
                        'Where to write, as a path inside PAPERLESS_DOWNLOAD_DIR — relative to it, or absolute and ' +
                            'under it. Anything outside is refused. Defaults to the server-supplied filename.',
                    ),
                version: z.number().int().optional().describe('Fetch a specific document version id.'),
            }),
        },
        async (args) =>
            handle('Download document', async () => {
                const endpoint =
                    args.kind === 'thumbnail' ? 'thumb' : args.kind === 'preview' ? 'preview' : 'download';
                const query: Query = {
                    version: args.version,
                    original: args.kind === 'original' ? true : undefined,
                };
                const extension = args.kind === 'thumbnail' ? 'webp' : 'pdf';

                const saved = await client.downloadToFile(`documents/${args.id}/${endpoint}`, query, {
                    filePath: args.dest_path,
                    fallbackName: `paperless-${args.id}-${args.kind}.${extension}`,
                });

                return json({ ...saved, document_id: args.id, kind: args.kind });
            }),
    );

    server.registerTool(
        'paperless_upload_document',
        {
            title: 'Upload document',
            description:
                'Upload a local file into paperless-ngx for consumption (OCR, tagging, filing). The file must live in ' +
                'one of the directories this server is allowed to read (PAPERLESS_UPLOAD_DIRS). Returns the consumption ' +
                'task id; consumption is asynchronous, so set `wait_seconds` to poll until it finishes and get back the ' +
                'created document id. Any field left unset is filled in by paperless’ own matching rules.',
            annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
            inputSchema: z.object({
                file_path: z
                    .string()
                    .describe(
                        'Path to the file on this machine. Must sit inside one of the PAPERLESS_UPLOAD_DIRS ' +
                            'directories, which defaults to PAPERLESS_DOWNLOAD_DIR.',
                    ),
                title: z.string().optional().describe('Title to use instead of one derived from the filename.'),
                created: z.string().optional().describe('Document date, e.g. `2016-04-19` or `2016-04-19 06:15:00+02:00`.'),
                correspondent_id: z.number().int().optional(),
                document_type_id: z.number().int().optional(),
                storage_path_id: z.number().int().optional(),
                tag_ids: z.array(z.number().int()).optional().describe('Tag ids to apply on consumption.'),
                archive_serial_number: z.number().int().optional(),
                custom_fields: z
                    .record(z.string(), z.unknown())
                    .optional()
                    .describe('Map of custom field id to value, e.g. `{"3":"ACME-1234"}`.'),
                wait_seconds: z
                    .number()
                    .int()
                    .min(0)
                    .max(300)
                    .default(0)
                    .describe('Poll the task endpoint for up to this many seconds and report the outcome.'),
            }),
        },
        async (args) =>
            handle('Upload document', async () => {
                client.assertWritable('upload a document');

                const { form, filename } = await client.fileField(args.file_path);
                const single: Array<[string, unknown]> = [
                    ['title', args.title],
                    ['created', args.created],
                    ['correspondent', args.correspondent_id],
                    ['document_type', args.document_type_id],
                    ['storage_path', args.storage_path_id],
                    ['archive_serial_number', args.archive_serial_number],
                ];
                for (const [key, value] of single) {
                    if (value !== undefined && value !== null) form.append(key, String(value));
                }
                // `tags` is repeated once per tag rather than sent as a list.
                for (const tagId of args.tag_ids ?? []) form.append('tags', String(tagId));
                if (args.custom_fields) form.append('custom_fields', JSON.stringify(args.custom_fields));

                const taskId = await client.request<string>('POST', 'documents/post_document', { form });
                const cleanTaskId = typeof taskId === 'string' ? taskId.replace(/^"|"$/g, '') : String(taskId);

                if (args.wait_seconds === 0) {
                    return json({
                        uploaded: filename,
                        task_id: cleanTaskId,
                        status: 'queued',
                        note: 'Consumption runs asynchronously. Poll with paperless_list_tasks using this task_id.',
                    });
                }

                const deadline = Date.now() + args.wait_seconds * 1000;
                let task: TaskRecord | undefined;
                while (Date.now() < deadline) {
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                    const response = await client.get<PaginatedResponse<TaskRecord> | TaskRecord[]>('tasks', {
                        task_id: cleanTaskId,
                    });
                    task = (Array.isArray(response) ? response : response?.results)?.[0];
                    if (task?.status && ['SUCCESS', 'FAILURE', 'REVOKED'].includes(task.status)) break;
                }

                return json(
                    compact({
                        uploaded: filename,
                        task_id: cleanTaskId,
                        status: task?.status ?? 'PENDING',
                        document_id: task?.related_document ?? null,
                        result: task?.result ?? null,
                        note: task?.status ? undefined : `Still running after ${args.wait_seconds}s; poll paperless_list_tasks.`,
                    }),
                );
            }),
    );

    server.registerTool(
        'paperless_update_document',
        {
            title: 'Update document',
            description:
                'Change one document’s metadata. Only the fields you pass are touched. `tag_ids` replaces the whole tag ' +
                'set, while `add_tag_ids`/`remove_tag_ids` adjust it relative to what is already there. Pass ' +
                '`clear_correspondent`/`clear_document_type`/`clear_storage_path` to unset a field.',
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
            inputSchema: z.object({
                id: z.number().int().describe('Document id.'),
                title: z.string().optional(),
                created: z.string().optional().describe('Document date, `YYYY-MM-DD`.'),
                correspondent_id: z.number().int().optional(),
                document_type_id: z.number().int().optional(),
                storage_path_id: z.number().int().optional(),
                clear_correspondent: z.boolean().optional(),
                clear_document_type: z.boolean().optional(),
                clear_storage_path: z.boolean().optional(),
                tag_ids: z.array(z.number().int()).optional().describe('Replace all tags with exactly these ids.'),
                add_tag_ids: z.array(z.number().int()).optional(),
                remove_tag_ids: z.array(z.number().int()).optional(),
                archive_serial_number: z.number().int().nullable().optional(),
                content: z.string().optional().describe('Overwrite the extracted text. Rarely what you want.'),
                custom_fields: z
                    .array(z.object({ field: z.number().int(), value: z.unknown() }))
                    .optional()
                    .describe('Replaces the document’s custom field values wholesale.'),
                owner_id: z.number().int().nullable().optional(),
            }),
        },
        async (args) =>
            handle('Update document', async () => {
                client.assertWritable('update a document');

                const body: Record<string, unknown> = {};
                if (args.title !== undefined) body.title = args.title;
                if (args.created !== undefined) body.created = args.created;
                if (args.content !== undefined) body.content = args.content;
                if (args.archive_serial_number !== undefined) body.archive_serial_number = args.archive_serial_number;
                if (args.custom_fields !== undefined) body.custom_fields = args.custom_fields;
                if (args.owner_id !== undefined) body.owner = args.owner_id;
                if (args.clear_correspondent) body.correspondent = null;
                else if (args.correspondent_id !== undefined) body.correspondent = args.correspondent_id;
                if (args.clear_document_type) body.document_type = null;
                else if (args.document_type_id !== undefined) body.document_type = args.document_type_id;
                if (args.clear_storage_path) body.storage_path = null;
                else if (args.storage_path_id !== undefined) body.storage_path = args.storage_path_id;

                if (args.tag_ids !== undefined) {
                    body.tags = args.tag_ids;
                } else if (args.add_tag_ids?.length || args.remove_tag_ids?.length) {
                    // Relative tag edits need the current set, since PATCH replaces it.
                    const current = await client.get<PaperlessDocument>(`documents/${args.id}`);
                    const next = new Set(current.tags ?? []);
                    for (const tagId of args.add_tag_ids ?? []) next.add(tagId);
                    for (const tagId of args.remove_tag_ids ?? []) next.delete(tagId);
                    body.tags = [...next];
                }

                if (Object.keys(body).length === 0) {
                    return text('Nothing to update: no fields were provided.');
                }

                const updated = await client.patch<PaperlessDocument>(`documents/${args.id}`, body);
                return json({ updated: Object.keys(body), document: await summarize(deps, updated, 0) });
            }),
    );

    server.registerTool(
        'paperless_bulk_edit_documents',
        {
            title: 'Bulk edit documents',
            description:
                'Apply one operation to many documents at once. Supply only the parameters the chosen `method` needs. ' +
                'Runs asynchronously on the server. `delete` moves documents to the trash and requires `confirm: true`.',
            annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
            inputSchema: z.object({
                document_ids: z.array(z.number().int()).min(1).describe('Documents to act on.'),
                method: z
                    .enum([
                        'add_tag',
                        'remove_tag',
                        'modify_tags',
                        'set_correspondent',
                        'set_document_type',
                        'set_storage_path',
                        'modify_custom_fields',
                        'reprocess',
                        'delete',
                    ])
                    .describe('Operation to perform.'),
                tag_id: z.number().int().optional().describe('For `add_tag` / `remove_tag`.'),
                add_tag_ids: z.array(z.number().int()).optional().describe('For `modify_tags`.'),
                remove_tag_ids: z.array(z.number().int()).optional().describe('For `modify_tags`.'),
                correspondent_id: z.number().int().nullable().optional().describe('For `set_correspondent`.'),
                document_type_id: z.number().int().nullable().optional().describe('For `set_document_type`.'),
                storage_path_id: z.number().int().nullable().optional().describe('For `set_storage_path`.'),
                add_custom_fields: z
                    .record(z.string(), z.unknown())
                    .optional()
                    .describe('For `modify_custom_fields`: map of custom field id to value.'),
                remove_custom_field_ids: z
                    .array(z.number().int())
                    .optional()
                    .describe('For `modify_custom_fields`: custom field ids to strip.'),
                confirm: z.boolean().default(false).describe('Required for `delete`.'),
            }),
        },
        async (args) =>
            handle('Bulk edit', async () => {
                client.assertWritable(`bulk ${args.method} documents`);

                if (args.method === 'delete' && !args.confirm) {
                    return text(
                        `Refusing to delete ${args.document_ids.length} document(s) without confirmation. ` +
                            'Re-run with confirm: true if this is intended.',
                    );
                }

                const parameters: Record<string, unknown> = {};
                switch (args.method) {
                    case 'add_tag':
                    case 'remove_tag':
                        if (args.tag_id === undefined) return text(`\`${args.method}\` requires \`tag_id\`.`);
                        parameters.tag = args.tag_id;
                        break;
                    case 'modify_tags':
                        if (!args.add_tag_ids?.length && !args.remove_tag_ids?.length) {
                            return text('`modify_tags` requires `add_tag_ids` and/or `remove_tag_ids`.');
                        }
                        parameters.add_tags = args.add_tag_ids ?? [];
                        parameters.remove_tags = args.remove_tag_ids ?? [];
                        break;
                    case 'set_correspondent':
                        parameters.correspondent = args.correspondent_id ?? null;
                        break;
                    case 'set_document_type':
                        parameters.document_type = args.document_type_id ?? null;
                        break;
                    case 'set_storage_path':
                        parameters.storage_path = args.storage_path_id ?? null;
                        break;
                    case 'modify_custom_fields':
                        if (!args.add_custom_fields && !args.remove_custom_field_ids?.length) {
                            return text('`modify_custom_fields` requires `add_custom_fields` and/or `remove_custom_field_ids`.');
                        }
                        parameters.add_custom_fields = args.add_custom_fields ?? {};
                        parameters.remove_custom_fields = args.remove_custom_field_ids ?? [];
                        break;
                    default:
                        break;
                }

                const result = await client.post('documents/bulk_edit', {
                    documents: args.document_ids,
                    method: args.method,
                    parameters,
                });

                return json({ method: args.method, affected: args.document_ids.length, result });
            }),
    );

    server.registerTool(
        'paperless_get_document_suggestions',
        {
            title: 'Get filing suggestions',
            description:
                'Ask paperless what it would file a document as, based on its trained matching. Returns suggested ' +
                'correspondents, tags, document types, storage paths and dates. Useful before `paperless_update_document`.',
            annotations: { readOnlyHint: true, openWorldHint: true },
            inputSchema: z.object({ id: z.number().int().describe('Document id.') }),
        },
        async (args) =>
            handle('Get suggestions', async () => {
                const suggestions = await client.get<{
                    correspondents?: number[];
                    tags?: number[];
                    document_types?: number[];
                    storage_paths?: number[];
                    dates?: string[];
                }>(`documents/${args.id}/suggestions`);

                const [correspondents, tags, documentTypes, storagePaths] = await Promise.all([
                    names.resolveMany('correspondents', suggestions.correspondents),
                    names.resolveMany('tags', suggestions.tags),
                    names.resolveMany('document_types', suggestions.document_types),
                    names.resolveMany('storage_paths', suggestions.storage_paths),
                ]);

                return json(
                    compact({
                        document_id: args.id,
                        correspondents: correspondents.map((name, index) => ({
                            id: suggestions.correspondents?.[index],
                            name,
                        })),
                        tags: tags.map((name, index) => ({ id: suggestions.tags?.[index], name })),
                        document_types: documentTypes.map((name, index) => ({
                            id: suggestions.document_types?.[index],
                            name,
                        })),
                        storage_paths: storagePaths.map((name, index) => ({
                            id: suggestions.storage_paths?.[index],
                            name,
                        })),
                        dates: suggestions.dates,
                    }),
                );
            }),
    );

    server.registerTool(
        'paperless_document_notes',
        {
            title: 'Document notes',
            description: 'List, add or delete the free-text notes attached to a document.',
            annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
            inputSchema: z.object({
                id: z.number().int().describe('Document id.'),
                action: z.enum(['list', 'add', 'delete']).default('list'),
                note: z.string().optional().describe('Note text. Required for `add`.'),
                note_id: z.number().int().optional().describe('Note id. Required for `delete`.'),
            }),
        },
        async (args) =>
            handle('Document notes', async () => {
                if (args.action === 'list') {
                    return json(await client.get(`documents/${args.id}/notes`));
                }

                client.assertWritable(`${args.action} a document note`);

                if (args.action === 'add') {
                    if (!args.note?.trim()) return text('`add` requires `note`.');
                    return json(await client.post(`documents/${args.id}/notes`, { note: args.note }));
                }

                if (args.note_id === undefined) return text('`delete` requires `note_id`.');
                return json(await client.delete(`documents/${args.id}/notes`, { id: args.note_id }));
            }),
    );
}
