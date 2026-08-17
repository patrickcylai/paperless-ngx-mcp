import type { PaperlessClient } from './client.ts';

/** Endpoints whose objects are referenced by id from documents, so their names are worth caching. */
export const NAMED_ENDPOINTS = ['tags', 'correspondents', 'document_types', 'storage_paths', 'custom_fields'] as const;
export type NamedEndpoint = (typeof NAMED_ENDPOINTS)[number];

interface NamedObject {
    id: number;
    name?: string;
    username?: string;
}

const TTL_MS = 60_000;

/**
 * Documents come back from the API with bare ids for tags, correspondents and
 * types. Resolving those to names in tool output saves the caller a round trip
 * per lookup, so the small taxonomy lists are fetched once and cached briefly.
 */
export class NameCache {
    private readonly entries = new Map<NamedEndpoint, { fetchedAt: number; names: Map<number, string> }>();
    private readonly client: PaperlessClient;

    constructor(client: PaperlessClient) {
        this.client = client;
    }

    invalidate(endpoint?: NamedEndpoint): void {
        if (endpoint) this.entries.delete(endpoint);
        else this.entries.clear();
    }

    async names(endpoint: NamedEndpoint): Promise<Map<number, string>> {
        const cached = this.entries.get(endpoint);
        if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.names;

        const names = new Map<number, string>();
        try {
            for (const object of await this.client.listAll<NamedObject>(endpoint, {}, 2000)) {
                const name = object.name ?? object.username;
                if (typeof object.id === 'number' && name) names.set(object.id, name);
            }
        } catch {
            // A caller lacking permission on, say, storage paths should still get
            // its documents back — just with unresolved ids. Cache the empty result
            // so one bad endpoint does not add a failed request to every search.
            this.entries.set(endpoint, { fetchedAt: Date.now(), names });
            return cached?.names ?? names;
        }

        this.entries.set(endpoint, { fetchedAt: Date.now(), names });
        return names;
    }

    async resolve(endpoint: NamedEndpoint, id: number | null | undefined): Promise<string | null> {
        if (id === null || id === undefined) return null;
        return (await this.names(endpoint)).get(id) ?? `#${id}`;
    }

    async resolveMany(endpoint: NamedEndpoint, ids: number[] | null | undefined): Promise<string[]> {
        if (!ids?.length) return [];
        const names = await this.names(endpoint);
        return ids.map((id) => names.get(id) ?? `#${id}`);
    }

    /** Case-insensitive name -> id lookup, for tools that accept names instead of ids. */
    async findByName(endpoint: NamedEndpoint, name: string): Promise<number[]> {
        const needle = name.trim().toLowerCase();
        const matches: number[] = [];
        for (const [id, value] of await this.names(endpoint)) {
            if (value.toLowerCase() === needle) matches.push(id);
        }
        return matches;
    }
}
