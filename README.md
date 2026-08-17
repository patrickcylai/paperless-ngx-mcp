# paperless-ngx MCP server

An [MCP](https://modelcontextprotocol.io) server that puts a [paperless-ngx](https://docs.paperless-ngx.com)
document archive in reach of an AI assistant: full-text search, reading documents, filing them, and
uploading new ones.

It talks to the paperless-ngx REST API over HTTP, so it works against any reachable instance — local,
LAN, or remote behind a reverse proxy.

## Why the tools look the way they do

The paperless API refers to tags, correspondents, document types and storage paths by numeric id, and
returns bare ids on every document. That is awkward for a model. So this server:

- **resolves ids to names** in all output, so a search result reads `"correspondent": "ACME Corp"`
  rather than `"correspondent": 7`;
- exposes a **`paperless_list_objects`** tool (and a `paperless://taxonomy` resource) for going the
  other way, name → id, in a single call;
- takes **friendly filter names** (`created_after`, `tags_all`, `title_contains`) and translates them
  into the API's `created__gte` / `tags__id__all` / `title__icontains` form;
- **truncates** document text and raw responses by default, so one call cannot swamp the context;
- requires an explicit **`confirm: true`** on anything destructive.

## Setup

```bash
npm install
npm run build
```

Get an API token from the paperless web UI: user menu → **My Profile** → the circular arrow next to
*API Token*.

### Claude Code

```bash
claude mcp add paperless -e PAPERLESS_URL=https://paperless.example.com -e PAPERLESS_TOKEN=your-token -- node /absolute/path/to/paperless-ngx_mcp/dist/src/index.js
```

### Claude Desktop / other MCP clients

Add to the client's MCP config (`claude_desktop_config.json` for Claude Desktop):

```json
{
    "mcpServers": {
        "paperless": {
            "command": "node",
            "args": ["/absolute/path/to/paperless-ngx_mcp/dist/src/index.js"],
            "env": {
                "PAPERLESS_URL": "https://paperless.example.com",
                "PAPERLESS_TOKEN": "your-token"
            }
        }
    }
}
```

## Configuration

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `PAPERLESS_URL` | yes | — | Base URL of the install. A trailing `/api` is stripped, so either form works. |
| `PAPERLESS_TOKEN` | yes\* | — | API token. Takes precedence over username/password. |
| `PAPERLESS_USERNAME` / `PAPERLESS_PASSWORD` | yes\* | — | Basic-auth alternative to a token. |
| `PAPERLESS_READ_ONLY` | no | `false` | When set, every mutating tool refuses to run — no request is even sent. |
| `PAPERLESS_DOWNLOAD_DIR` | no | `$TMPDIR/paperless-mcp` | Where `paperless_download_document` writes files. |
| `PAPERLESS_API_VERSION` | no | server default | Pin the API version (`Accept: …; version=N`). Leave unset unless you have a reason. |
| `PAPERLESS_TIMEOUT_MS` | no | `30000` | Per-request timeout. |

\* One of the two credential forms is required.

Start with `PAPERLESS_READ_ONLY=1` if you want to let an assistant explore the archive before giving
it permission to change anything.

If your instance uses a self-signed certificate, run the server with
`NODE_TLS_REJECT_UNAUTHORIZED=0` — bearing in mind that this disables certificate checking for the
whole process.

## Tools

**Documents**

| Tool | Does |
| --- | --- |
| `paperless_search_documents` | Full-text search plus structured filters, paginated, with highlights. |
| `paperless_get_document` | One document: metadata, extracted text, notes, custom field values. |
| `paperless_download_document` | Write the original / archived PDF / thumbnail to local disk. |
| `paperless_upload_document` | Upload a local file for consumption, optionally waiting for the result. |
| `paperless_update_document` | Change title, dates, correspondent, type, tags, custom fields. |
| `paperless_bulk_edit_documents` | One operation across many documents; `delete` needs confirmation. |
| `paperless_get_document_suggestions` | What paperless' own matching would file the document as. |
| `paperless_document_notes` | List, add or delete notes on a document. |

**Taxonomy**

| Tool | Does |
| --- | --- |
| `paperless_list_objects` | List tags, correspondents, document types, storage paths, custom fields, saved views, users, groups, mail accounts, mail rules, workflows, share links. |
| `paperless_create_object` | Create a tag, correspondent, document type, storage path or custom field. |
| `paperless_update_object` | Rename or reconfigure one of the above. |
| `paperless_delete_objects` | Delete them; requires confirmation. |

**System**

| Tool | Does |
| --- | --- |
| `paperless_get_statistics` | Document counts, inbox size, file-type breakdown. |
| `paperless_get_system_status` | Version, database/index/Redis health, what this server is connected to. |
| `paperless_list_tasks` | Background tasks — use it to follow up on an upload. |
| `paperless_api_request` | Escape hatch to any REST endpoint the tools above do not cover. |

**Resources**

- `paperless://taxonomy` — every tag, correspondent, type, storage path and custom field with its id.
- `paperless://statistics` — the same payload as the statistics tool.

## Search syntax

`paperless_search_documents`' `query` parameter goes to the full-text index and supports paperless'
advanced syntax:

```
shopname AND (product1 OR product2)
type:invoice tag:unpaid
correspondent:university certificate
created:[2005 to 2009]
added:yesterday
produ*name
custom_fields.name:"Contract Number" custom_fields.value:1312
notes.note:reminder
```

Date keywords: `today`, `yesterday`, `"previous week"`, `"this month"`, `"previous month"`,
`"this year"`, `"previous year"`, `"previous quarter"`. Matching is word-order-independent and
accent-insensitive, and separators are stripped at index time, so `1312` finds `A-1312/B`.

For plain substring matching use `title_contains` / `content_contains` instead, and to find documents
resembling one you already have, use `more_like_id`.

Custom fields have their own filter, passed through verbatim as `custom_field_query`:

```json
["due", "range", ["2024-08-01", "2024-09-01"]]
["customer", "exact", "bob"]
["OR", [["address", "isnull", true], ["address", "exact", ""]]]
```

## Development

```bash
npm run dev        # run straight from TypeScript source
npm test           # unit tests + end-to-end tests against a stub paperless API
npm run typecheck  # tsc --noEmit
npm run build      # emit dist/
```

The end-to-end suite starts a stub HTTP server that mimics the paperless API and drives the real
server over stdio with raw JSON-RPC, so it covers the wire protocol, query translation, multipart
uploads, error handling and read-only enforcement.

Anything not covered by a dedicated tool is reachable through `paperless_api_request`. Your own
instance publishes its full, version-matched schema at `<paperless-url>/api/schema/view/`.

## License

MIT
