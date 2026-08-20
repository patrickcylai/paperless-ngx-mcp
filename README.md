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

## Two ways to run it

MCP has two transports, and which one you want depends on how the client reaches the server:

- **stdio** (default) — the client spawns the server as a subprocess and talks over stdin/stdout.
  This is what Claude Code and Claude Desktop do, and what you want in almost all cases.
- **http** — one long-lived server listening on a port, which several clients can connect to.

Set `MCP_TRANSPORT=stdio` or `MCP_TRANSPORT=http`.

## Setup

First get an API token from the paperless web UI: user menu → **My Profile** → the circular arrow
next to *API Token*.

Nothing to clone or build — `npx` fetches the package on demand.

### Claude Code, as a plugin (recommended)

```bash
claude plugin marketplace add patrickcylai/paperless-ngx-mcp
claude plugin install paperless-ngx@patrickcylai-plugins
```

Claude Code then prompts for your URL and token, and for the two directories described under
[what it can touch on your disk](#what-it-can-touch-on-your-disk). The token is masked on entry and
kept in your OS keychain rather than written to a settings file, which is the main reason to prefer
this over the command below — that one leaves the token in your shell history.

To set everything up front instead of answering prompts:

```bash
claude plugin install paperless-ngx@patrickcylai-plugins \
  --config url=https://paperless.example.com \
  --config token=your-token \
  --config read_only=true
```

Change any of it later with `/plugin configure paperless-ngx@patrickcylai-plugins`. Leave
`download_dir` and `upload_dirs` empty to accept the defaults. The plugin authenticates with a token
only; for username/password use one of the forms below.

### Claude Code, as a plain MCP server

```bash
claude mcp add paperless -e PAPERLESS_URL=https://paperless.example.com -e PAPERLESS_TOKEN=your-token -- npx -y @patrickcylai/paperless-ngx-mcp
```

Note that this writes the token into your shell history.

### Claude Desktop / other MCP clients

Add to the client's MCP config (`claude_desktop_config.json` for Claude Desktop):

```json
{
    "mcpServers": {
        "paperless": {
            "command": "npx",
            "args": ["-y", "@patrickcylai/paperless-ngx-mcp"],
            "env": {
                "PAPERLESS_URL": "https://paperless.example.com",
                "PAPERLESS_TOKEN": "your-token"
            }
        }
    }
}
```

### From source

```bash
npm install
npm run build
```

Then point the client at `node /absolute/path/to/paperless-ngx-mcp/dist/index.js` instead of the
`npx` command above.

## Running as an HTTP service

Only needed if you want one long-lived server rather than a per-client subprocess:

```bash
MCP_TRANSPORT=http PAPERLESS_URL=https://paperless.example.com PAPERLESS_TOKEN=your-token npx -y @patrickcylai/paperless-ngx-mcp
```

It listens on `127.0.0.1:8765`, with the MCP endpoint at `/mcp` and a liveness probe at `/healthz`:

```bash
curl -s http://127.0.0.1:8765/healthz
```

Point an HTTP-capable client at it:

```bash
claude mcp add --transport http paperless http://127.0.0.1:8765/mcp
```

### If you expose the port

It binds loopback only by default. Before binding anything wider, set a bearer token — otherwise
anyone who can reach the port can read and modify your archive. The server warns on stderr when it
binds a non-loopback address without one.

```bash
openssl rand -hex 32
```

Set that as `MCP_AUTH_TOKEN`, and add `MCP_ALLOWED_HOSTS` for the hostname you'll use — `Host` and
`Origin` are checked against a localhost-only allowlist by default, which blocks DNS rebinding.
Clients then need to send `Authorization: Bearer <token>`. `/healthz` stays unauthenticated.

## Configuration

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `PAPERLESS_URL` | yes | — | Base URL of the install. A trailing `/api` is stripped, so either form works. |
| `PAPERLESS_TOKEN` | yes\* | — | API token. Takes precedence over username/password. |
| `PAPERLESS_USERNAME` / `PAPERLESS_PASSWORD` | yes\* | — | Basic-auth alternative to a token. |
| `PAPERLESS_READ_ONLY` | no | `false` | When set, every tool that would modify the archive refuses to run — no request is even sent. |
| `PAPERLESS_DOWNLOAD_DIR` | no | `$TMPDIR/paperless-mcp` | The only directory `paperless_download_document` may write into. Created `0700`. |
| `PAPERLESS_UPLOAD_DIRS` | no | `$PAPERLESS_DOWNLOAD_DIR` | Comma-separated list of directories `paperless_upload_document` may read from. |
| `PAPERLESS_API_VERSION` | no | server default | Pin the API version (`Accept: …; version=N`). Leave unset unless you have a reason. |
| `PAPERLESS_TIMEOUT_MS` | no | `30000` | Per-request timeout. |

\* One of the two credential forms is required.

Transport settings (the HTTP ones are ignored under stdio):

| Variable | Default | Meaning |
| --- | --- | --- |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http`. |
| `MCP_HTTP_HOST` | `127.0.0.1` | Interface to bind. Set a bearer token before widening this. |
| `MCP_HTTP_PORT` | `8765` | Port to listen on. |
| `MCP_HTTP_PATH` | `/mcp` | Path the MCP endpoint is mounted at. |
| `MCP_AUTH_TOKEN` | — | When set, requests must send `Authorization: Bearer <token>`. `/healthz` stays open. |
| `MCP_ALLOWED_HOSTS` | localhost | Comma-separated `Host` allowlist (DNS-rebinding protection). `*` disables the check. |
| `MCP_ALLOWED_ORIGINS` | localhost | Comma-separated `Origin` allowlist. `*` disables the check. |

Start with `PAPERLESS_READ_ONLY=1` if you want to let an assistant explore the archive before giving
it permission to change anything. It governs the archive, not the local filesystem — downloads still
write files, within the boundary described next.

### What it can touch on your disk

Two tools reach the local filesystem, and both are confined:

- `paperless_download_document` writes **only** inside `PAPERLESS_DOWNLOAD_DIR`. A `dest_path` is
  taken as relative to that directory; an absolute one has to be under it. Anything else is refused.
- `paperless_upload_document` reads **only** from the directories in `PAPERLESS_UPLOAD_DIRS`, which
  defaults to just the download directory. Point it at your scans folder to upload from there:

  ```bash
  PAPERLESS_UPLOAD_DIRS=/home/me/Documents/scans,/home/me/Downloads
  ```

Both checks resolve symlinks, so a link inside an allowed directory cannot lead out of it, and the
download directory is created `0700` and rejected outright if it is itself a symlink.

This matters because document text is untrusted input. An archive fed by a scanner or a mail rule
contains whatever a sender put in it, that text reaches the model, and a model can be talked into
calling a tool. The confinement is what keeps "read my documents" from becoming "write to my
`~/.ssh/authorized_keys`" — so widen these two settings deliberately, not by reflex.

If your instance uses a self-signed certificate, run the server with
`NODE_TLS_REJECT_UNAUTHORIZED=0` — bearing in mind that this disables certificate checking for the
whole process.

## Tools

**Documents**

| Tool | Does |
| --- | --- |
| `paperless_search_documents` | Full-text search plus structured filters, paginated, with highlights. |
| `paperless_get_document` | One document: metadata, extracted text, notes, custom field values. |
| `paperless_download_document` | Write the original / archived PDF / thumbnail into `PAPERLESS_DOWNLOAD_DIR`. |
| `paperless_upload_document` | Upload a file from `PAPERLESS_UPLOAD_DIRS` for consumption, optionally waiting for the result. |
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
server over both transports with raw JSON-RPC, so it covers the wire protocol, query translation,
multipart uploads, error handling, read-only enforcement, bearer auth, the DNS-rebinding checks and
the filesystem confinement.

Anything not covered by a dedicated tool is reachable through `paperless_api_request`. Your own
instance publishes its full, version-matched schema at `<paperless-url>/api/schema/view/`.

The Claude Code plugin lives in [`plugin/`](plugin), and [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json)
makes this repository its own marketplace. The plugin is a thin wrapper: two manifests that declare
the settings and run the published npm package, so it carries no copy of the server to keep in step.
Test changes to it with `claude plugin validate ./plugin` and `claude --plugin-dir ./plugin`.

## License

MIT
