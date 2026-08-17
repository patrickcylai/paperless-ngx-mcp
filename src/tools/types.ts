import type { McpServer } from '@modelcontextprotocol/server';

import type { PaperlessClient } from '../client.ts';
import type { PaperlessConfig } from '../config.ts';
import type { NameCache } from '../names.ts';

/** Everything the tool modules need from the server process. */
export interface Deps {
    client: PaperlessClient;
    names: NameCache;
    config: PaperlessConfig;
}

export type { McpServer };
