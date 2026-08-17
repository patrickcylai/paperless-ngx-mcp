import { PaperlessError, ReadOnlyError } from './client.ts';

/**
 * Declared as a type alias rather than an interface so it picks up the implicit
 * index signature the SDK's `CallToolResult` expects.
 */
export type ToolResult = {
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
};

export function text(value: string): ToolResult {
    return { content: [{ type: 'text', text: value }] };
}

export function json(value: unknown): ToolResult {
    return text(JSON.stringify(value, null, 2));
}

export function errorResult(message: string): ToolResult {
    return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Tool handlers surface failures as `isError` results rather than transport
 * errors, so the model sees an actionable message instead of a stack trace.
 */
export async function handle(operation: string, run: () => Promise<ToolResult>): Promise<ToolResult> {
    try {
        return await run();
    } catch (error) {
        if (error instanceof ReadOnlyError || error instanceof PaperlessError) {
            return errorResult(error.message);
        }
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(`${operation} failed: ${message}`);
    }
}

/** A `maxChars` of 0 means "omit this entirely" rather than "no limit". */
export function truncate(value: string | null | undefined, maxChars: number): string | null {
    if (value === null || value === undefined) return null;
    if (maxChars <= 0) return null;
    if (value.length <= maxChars) return value;
    return `${value.slice(0, maxChars)}\n… [truncated: showing ${maxChars} of ${value.length} characters]`;
}

/** Search highlights arrive as HTML (`<span class="match">…</span>`); keep the emphasis, drop the markup. */
export function plainHighlights(html: string | null | undefined): string | null {
    if (!html) return null;
    return html
        .replace(/<span class="match">(.*?)<\/span>/gs, '**$1**')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Drops keys whose value is null/undefined/empty-array, so tool output stays readable. */
export function compact<T extends Record<string, unknown>>(object: T): Partial<T> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(object)) {
        if (value === null || value === undefined) continue;
        if (Array.isArray(value) && value.length === 0) continue;
        result[key] = value;
    }
    return result as Partial<T>;
}

export function pageInfo(count: number, page: number, pageSize: number) {
    return {
        count,
        page,
        page_size: pageSize,
        total_pages: pageSize > 0 ? Math.max(1, Math.ceil(count / pageSize)) : 1,
    };
}
