import os from 'node:os';
import path from 'node:path';

export interface PaperlessConfig {
    /** Origin (plus optional sub-path) of the paperless-ngx install, no trailing slash and no `/api`. */
    baseUrl: string;
    /** `Authorization` header value, pre-built from a token or from basic credentials. */
    authHeader: string;
    /** Value for the `version=` part of the Accept header. Undefined lets the server pick its default. */
    apiVersion?: string;
    /** The only directory `download_document` may write into. */
    downloadDir: string;
    /** Directories `upload_document` may read from. Defaults to just `downloadDir`. */
    uploadDirs: string[];
    /** When true, every mutating tool refuses to run. */
    readOnly: boolean;
    requestTimeoutMs: number;
}

export class ConfigError extends Error {}

/**
 * Accepts anything a user is likely to paste — bare host, trailing slash, a
 * copied `/api/` URL — and reduces it to the prefix every request is built on.
 */
export function normalizeBaseUrl(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) throw new ConfigError('PAPERLESS_URL is empty');

    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

    let url: URL;
    try {
        url = new URL(withScheme);
    } catch {
        throw new ConfigError(`PAPERLESS_URL is not a valid URL: ${raw}`);
    }

    url.search = '';
    url.hash = '';
    // Drop a trailing `/api` so callers can paste either form of the URL.
    url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/api$/i, '');

    return url.toString().replace(/\/+$/, '');
}

function buildAuthHeader(env: NodeJS.ProcessEnv): string {
    const token = env.PAPERLESS_TOKEN?.trim();
    if (token) return `Token ${token}`;

    const username = env.PAPERLESS_USERNAME?.trim();
    const password = env.PAPERLESS_PASSWORD;
    if (username && password) {
        return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    }

    throw new ConfigError(
        'No credentials. Set PAPERLESS_TOKEN (My Profile -> API token in the paperless web UI), ' +
            'or set both PAPERLESS_USERNAME and PAPERLESS_PASSWORD.',
    );
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
    if (value === undefined || value.trim() === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function parseIntOr(value: string | undefined, fallback: number): number {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export type TransportKind = 'stdio' | 'http';

export interface TransportConfig {
    kind: TransportKind;
    /** Interface to bind. Loopback by default; containers need 0.0.0.0. */
    host: string;
    port: number;
    /** Endpoint the MCP handler is mounted on. */
    path: string;
    /** When set, requests must carry `Authorization: Bearer <token>`. */
    authToken?: string;
    /** Empty means "localhost only". `['*']` disables the check. */
    allowedHosts: string[];
    allowedOrigins: string[];
}

function parseList(value: string | undefined): string[] {
    return (value ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
}

export function loadTransportConfig(env: NodeJS.ProcessEnv = process.env): TransportConfig {
    const requested = (env.MCP_TRANSPORT ?? 'stdio').trim().toLowerCase();
    if (requested !== 'stdio' && requested !== 'http') {
        throw new ConfigError(`MCP_TRANSPORT must be "stdio" or "http", got "${requested}".`);
    }

    const rawPath = env.MCP_HTTP_PATH?.trim() || '/mcp';

    return {
        kind: requested,
        host: env.MCP_HTTP_HOST?.trim() || '127.0.0.1',
        port: parseIntOr(env.MCP_HTTP_PORT, 8765),
        path: rawPath.startsWith('/') ? rawPath : `/${rawPath}`,
        authToken: env.MCP_AUTH_TOKEN?.trim() || undefined,
        allowedHosts: parseList(env.MCP_ALLOWED_HOSTS),
        allowedOrigins: parseList(env.MCP_ALLOWED_ORIGINS),
    };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PaperlessConfig {
    const rawUrl = env.PAPERLESS_URL ?? env.PAPERLESS_BASE_URL;
    if (!rawUrl?.trim()) {
        throw new ConfigError(
            'PAPERLESS_URL is not set. Point it at your paperless-ngx install, e.g. https://paperless.example.com',
        );
    }

    const downloadDir = path.resolve(env.PAPERLESS_DOWNLOAD_DIR?.trim() || path.join(os.tmpdir(), 'paperless-mcp'));
    // Uploads read from the local filesystem, so the reachable set is an explicit
    // allowlist rather than "anywhere the process can read".
    const uploadDirs = parseList(env.PAPERLESS_UPLOAD_DIRS).map((entry) => path.resolve(entry));

    return {
        baseUrl: normalizeBaseUrl(rawUrl),
        authHeader: buildAuthHeader(env),
        apiVersion: env.PAPERLESS_API_VERSION?.trim() || undefined,
        downloadDir,
        uploadDirs: uploadDirs.length ? uploadDirs : [downloadDir],
        readOnly: parseBool(env.PAPERLESS_READ_ONLY, false),
        requestTimeoutMs: parseIntOr(env.PAPERLESS_TIMEOUT_MS, 30_000),
    };
}
