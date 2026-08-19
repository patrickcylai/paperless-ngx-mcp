import { createWriteStream, openAsBlob } from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { PaperlessConfig } from './config.ts';
import { PathError, prepareWriteTarget, resolveReadable, resolveWithin } from './paths.ts';

export type QueryValue = string | number | boolean | null | undefined | Array<string | number>;
export type Query = Record<string, QueryValue>;

export interface PaginatedResponse<T> {
    count: number;
    next: string | null;
    previous: string | null;
    results: T[];
}

export class PaperlessError extends Error {
    readonly status: number;
    readonly method: string;
    readonly url: string;
    readonly body: string;

    constructor(status: number, method: string, url: string, body: string) {
        super(PaperlessError.describe(status, method, url, body));
        this.name = 'PaperlessError';
        this.status = status;
        this.method = method;
        this.url = url;
        this.body = body;
    }

    private static describe(status: number, method: string, url: string, body: string): string {
        const detail = body.trim().slice(0, 1200);
        const hint =
            status === 401 || status === 403
                ? ' — check PAPERLESS_TOKEN and that the user has permission for this object'
                : status === 404
                  ? ' — the object or endpoint does not exist on this server'
                  : status === 406
                    ? ' — the server rejected the requested API version; unset PAPERLESS_API_VERSION'
                    : '';
        return `paperless-ngx returned ${status} for ${method} ${url}${hint}${detail ? `\n${detail}` : ''}`;
    }
}

export class ReadOnlyError extends Error {
    constructor(operation: string) {
        super(
            `Refusing to ${operation}: this server is running with PAPERLESS_READ_ONLY enabled. ` +
                'Unset PAPERLESS_READ_ONLY to allow writes.',
        );
        this.name = 'ReadOnlyError';
    }
}

export function buildQuery(query: Query | undefined): string {
    if (!query) return '';
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') continue;
        if (Array.isArray(value)) {
            // Paperless takes multi-value id filters as a comma-separated list.
            if (value.length === 0) continue;
            params.set(key, value.join(','));
        } else {
            params.set(key, String(value));
        }
    }
    const encoded = params.toString();
    return encoded ? `?${encoded}` : '';
}

/**
 * Every paperless API route wants a trailing slash; `path` must not carry a
 * query string.
 *
 * A `..` segment would climb out of `/api/` once the URL is normalised — and on
 * a sub-path install, out of the base URL entirely — putting the credentials on
 * requests to endpoints the caller never named. `PaperlessClient.url` re-checks
 * the assembled URL; this is here to fail early with a message that says why.
 */
export function apiPath(rawPath: string): string {
    const trimmed = rawPath.trim().replace(/^\/+/, '').replace(/\/+$/, '');
    const rejection = traversalRejection(trimmed);
    if (rejection) throw new PathError(`${rejection}: ${rawPath}`);

    const withApi = /^api(\/|$)/i.test(trimmed) ? trimmed : `api/${trimmed}`;
    return `/${withApi}/`;
}

/**
 * Looks past percent-encoding, since the URL parser decodes before it resolves.
 * Returns why the path is unacceptable, or undefined when it is fine.
 */
function traversalRejection(rawPath: string): string | undefined {
    let current = rawPath;
    for (let round = 0; round < 3; round += 1) {
        if (current.split(/[/\\]/).includes('..')) return 'Path may not contain a ".." segment';

        let decoded: string;
        try {
            decoded = decodeURIComponent(current);
        } catch {
            return 'Path is not valid percent-encoding';
        }
        if (decoded === current) return undefined;
        current = decoded;
    }
    return 'Path is encoded too many times to check safely';
}

/** `.` and `..` are legal basenames but useless as targets, so treat them as no name at all. */
function safeName(candidate: string): string | undefined {
    const name = path.basename(candidate);
    return name === '' || name === '.' || name === '..' ? undefined : name;
}

export function filenameFromDisposition(disposition: string | null): string | undefined {
    if (!disposition) return undefined;
    const extended = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(disposition);
    if (extended) {
        try {
            return safeName(decodeURIComponent(extended[1].trim().replace(/^"|"$/g, '')));
        } catch {
            // Fall through to the plain form below.
        }
    }
    const plain = /filename="?([^";]+)"?/i.exec(disposition);
    return plain ? safeName(plain[1].trim()) : undefined;
}

interface RequestOptions {
    query?: Query;
    /** JSON request body. */
    body?: unknown;
    /** Multipart body; takes precedence over `body`. */
    form?: FormData;
    accept?: string;
}

export class PaperlessClient {
    private readonly config: PaperlessConfig;

    constructor(config: PaperlessConfig) {
        this.config = config;
    }

    get readOnly(): boolean {
        return this.config.readOnly;
    }

    assertWritable(operation: string): void {
        if (this.config.readOnly) throw new ReadOnlyError(operation);
    }

    /**
     * Assembles the request URL and confirms it is still under `<base>/api/`
     * after the URL parser has normalised it. `apiPath` already rejects `..`,
     * but checking the parsed result is what actually holds the boundary: it
     * cannot be talked around by an encoding the parser understands and a
     * string check does not.
     */
    url(rawPath: string, query?: Query): string {
        const root = new URL(`${this.config.baseUrl}/api/`);
        const built = new URL(`${this.config.baseUrl}${apiPath(rawPath)}${buildQuery(query)}`);
        if (built.origin !== root.origin || !built.pathname.startsWith(root.pathname)) {
            throw new PathError(`Refusing to request ${built.href}: it falls outside ${root.href}.`);
        }
        return built.toString();
    }

    private headers(options: RequestOptions): Headers {
        const accept = options.accept ?? 'application/json';
        const headers = new Headers({
            Authorization: this.config.authHeader,
            Accept: this.config.apiVersion ? `${accept}; version=${this.config.apiVersion}` : accept,
        });
        if (options.form === undefined && options.body !== undefined) {
            headers.set('Content-Type', 'application/json');
        }
        return headers;
    }

    private async fetchRaw(method: string, rawPath: string, options: RequestOptions = {}): Promise<Response> {
        const url = this.url(rawPath, options.query);
        let response: Response;
        try {
            response = await fetch(url, {
                method,
                headers: this.headers(options),
                body: options.form ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
                signal: AbortSignal.timeout(this.config.requestTimeoutMs),
                redirect: 'follow',
            });
        } catch (cause) {
            const reason = cause instanceof Error ? cause.message : String(cause);
            throw new Error(`Could not reach paperless-ngx at ${url}: ${reason}`, { cause });
        }

        if (!response.ok) {
            throw new PaperlessError(response.status, method, url, await response.text().catch(() => ''));
        }
        return response;
    }

    async request<T = unknown>(method: string, rawPath: string, options: RequestOptions = {}): Promise<T> {
        const response = await this.fetchRaw(method, rawPath, options);
        if (response.status === 204) return null as T;

        const text = await response.text();
        if (!text) return null as T;

        const contentType = response.headers.get('content-type') ?? '';
        if (!contentType.includes('json')) return text as T;
        try {
            return JSON.parse(text) as T;
        } catch {
            return text as T;
        }
    }

    get<T = unknown>(rawPath: string, query?: Query): Promise<T> {
        return this.request<T>('GET', rawPath, { query });
    }

    post<T = unknown>(rawPath: string, body?: unknown, query?: Query): Promise<T> {
        return this.request<T>('POST', rawPath, { body, query });
    }

    patch<T = unknown>(rawPath: string, body?: unknown, query?: Query): Promise<T> {
        return this.request<T>('PATCH', rawPath, { body, query });
    }

    delete<T = unknown>(rawPath: string, query?: Query): Promise<T> {
        return this.request<T>('DELETE', rawPath, { query });
    }

    /** Walks `next` links, stopping at `maxItems` so a huge library cannot flood the context. */
    async listAll<T>(rawPath: string, query: Query = {}, maxItems = 1000): Promise<T[]> {
        const items: T[] = [];
        let page = 1;
        while (items.length < maxItems) {
            const response = await this.get<PaginatedResponse<T> | T[]>(rawPath, {
                ...query,
                page,
                page_size: Math.min(250, maxItems - items.length),
            });
            const batch = Array.isArray(response) ? response : (response?.results ?? []);
            items.push(...batch);
            const hasNext = !Array.isArray(response) && Boolean(response?.next);
            if (!hasNext || batch.length === 0) break;
            page += 1;
        }
        return items.slice(0, maxItems);
    }

    /**
     * Streams a binary endpoint (download/preview/thumb) to disk without
     * buffering it in memory.
     *
     * Writes never leave the download directory. The bytes come from the
     * archive, which is fed by scanners and mail rules, so both the content and
     * the filename the server suggests are attacker-reachable — an unconfined
     * destination would turn "fetch this document" into "write this file".
     */
    async downloadToFile(
        rawPath: string,
        query: Query | undefined,
        destination: { dir?: string; filePath?: string; fallbackName: string },
    ): Promise<{ path: string; bytes: number; contentType: string }> {
        const root = path.resolve(destination.dir ?? this.config.downloadDir);
        // Check the caller's destination before spending a request on it.
        const requested =
            destination.filePath === undefined ? undefined : resolveWithin(root, destination.filePath, 'dest_path');

        const response = await this.fetchRaw('GET', rawPath, { query, accept: '*/*' });

        const serverName = filenameFromDisposition(response.headers.get('content-disposition'));
        const targetPath = await prepareWriteTarget(
            root,
            requested ?? path.join(root, serverName ?? destination.fallbackName),
        );

        if (!response.body) throw new Error(`paperless-ngx returned an empty body for ${this.url(rawPath, query)}`);

        // Count inside the pipeline rather than via a `data` listener, which would
        // put the stream into flowing mode before the destination is attached.
        let bytes = 0;
        const count = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
                bytes += chunk.length;
                callback(null, chunk);
            },
        });

        await pipeline(
            Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
            count,
            createWriteStream(targetPath),
        );

        return {
            path: targetPath,
            bytes,
            contentType: response.headers.get('content-type') ?? 'application/octet-stream',
        };
    }

    /**
     * Builds the multipart body for `/api/documents/post_document/`.
     *
     * The file has to come from one of the configured upload directories:
     * whatever is read here leaves the machine, so an unconstrained path is an
     * exfiltration primitive for anything the process can open.
     */
    async fileField(filePath: string): Promise<{ form: FormData; filename: string }> {
        const resolved = await resolveReadable(this.config.uploadDirs, filePath);
        const filename = path.basename(resolved);
        let blob: Blob;
        try {
            blob = await openAsBlob(resolved);
        } catch (cause) {
            const reason = cause instanceof Error ? cause.message : String(cause);
            throw new Error(`Cannot read file to upload (${resolved}): ${reason}`, { cause });
        }
        const form = new FormData();
        form.append('document', blob, filename);
        return { form, filename };
    }

    /** Reads the API/server version headers that paperless attaches to every authenticated response. */
    async serverVersions(): Promise<{ apiVersion: string | null; version: string | null }> {
        const response = await this.fetchRaw('GET', 'ui_settings');
        await response.text().catch(() => '');
        return {
            apiVersion: response.headers.get('x-api-version'),
            version: response.headers.get('x-version'),
        };
    }
}
