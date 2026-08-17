import { createWriteStream, openAsBlob } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { PaperlessConfig } from './config.ts';

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

/** Every paperless API route wants a trailing slash; `path` must not carry a query string. */
export function apiPath(rawPath: string): string {
    const trimmed = rawPath.trim().replace(/^\/+/, '').replace(/\/+$/, '');
    const withApi = /^api(\/|$)/i.test(trimmed) ? trimmed : `api/${trimmed}`;
    return `/${withApi}/`;
}

export function filenameFromDisposition(disposition: string | null): string | undefined {
    if (!disposition) return undefined;
    const extended = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(disposition);
    if (extended) {
        try {
            return path.basename(decodeURIComponent(extended[1].trim().replace(/^"|"$/g, '')));
        } catch {
            // Fall through to the plain form below.
        }
    }
    const plain = /filename="?([^";]+)"?/i.exec(disposition);
    return plain ? path.basename(plain[1].trim()) : undefined;
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

    url(rawPath: string, query?: Query): string {
        return `${this.config.baseUrl}${apiPath(rawPath)}${buildQuery(query)}`;
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

    /** Streams a binary endpoint (download/preview/thumb) to disk without buffering it in memory. */
    async downloadToFile(
        rawPath: string,
        query: Query | undefined,
        destination: { dir?: string; filePath?: string; fallbackName: string },
    ): Promise<{ path: string; bytes: number; contentType: string }> {
        const response = await this.fetchRaw('GET', rawPath, { query, accept: '*/*' });

        const serverName = filenameFromDisposition(response.headers.get('content-disposition'));
        const targetPath = destination.filePath
            ? path.resolve(destination.filePath)
            : path.join(path.resolve(destination.dir ?? this.config.downloadDir), serverName ?? destination.fallbackName);

        await mkdir(path.dirname(targetPath), { recursive: true });

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

    /** Builds the multipart body for `/api/documents/post_document/`. */
    async fileField(filePath: string): Promise<{ form: FormData; filename: string }> {
        const resolved = path.resolve(filePath);
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
