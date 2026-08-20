# paperless-ngx MCP server

An MCP server exposing a paperless-ngx document archive to an AI assistant. It talks to the
paperless REST API over HTTP; there is no database and no local state beyond downloaded files.

## Commands

```bash
npm test         # 97 tests, runs .ts directly — no build step
npm run typecheck
npm run build    # emits dist/, which is what ships
npm run dev      # node src/index.ts
```

Node >= 22.6 is required: source runs as TypeScript via type stripping. Imports carry `.ts`
extensions deliberately (`verbatimModuleSyntax` + `nodenext`) — do not rewrite them to `.js`.

## Security invariants

These exist because the archive is fed by scanners and mail rules, so document text is
attacker-authored input that reaches the model's context. A tool argument may therefore be chosen
by whoever sent a document. Do not weaken any of the following without saying so explicitly.

1. **Every local write goes through `prepareWriteTarget`, every local read through
   `resolveReadable`** (`src/paths.ts`). Never `path.resolve` a caller-supplied path and hand it to
   `fs`. Writes are confined to `PAPERLESS_DOWNLOAD_DIR`, reads to `PAPERLESS_UPLOAD_DIRS`, and both
   resolve symlinks so a link inside an allowed directory cannot lead out.
2. **API paths are checked twice.** `apiPath` rejects `..` (seeing past percent-encoding), and
   `PaperlessClient.url` re-checks that the assembled URL still sits under `<baseUrl>/api/`. The
   second check is the one that holds the boundary — a string check alone can be walked around by an
   encoding the URL parser understands. Keep both.
3. **`PAPERLESS_READ_ONLY` gates archive mutations only**, not local file writes. Downloads still
   write to disk in read-only mode; that is intended, and the confinement above is what bounds it.
4. **Tool annotations must be honest.** `readOnlyHint: true` means no side effects anywhere,
   including the local filesystem — clients use it to skip the approval prompt. A tool that writes a
   file is not read-only.

## Testing

`node --test 'test/*.test.ts'`, no build required. The e2e suite drives the real server over stdio
against a stub paperless API, so it covers the wire format and not just the functions.

- Tests run from `src/`, but `dist/` is what ships. Smoke-test the built output before a release.
- A new path or URL boundary needs a case in `test/paths.test.ts`, including the symlink form.
- Prefer extending the stub in `test/e2e.test.ts` over mocking `fetch`.

## Plugin packaging

The Claude Code plugin lives in `plugin/`; `.claude-plugin/marketplace.json` makes the repository its
own marketplace.

- **The plugin source must stay a relative path.** `npm`, `archive` and `command` sources work only
  in the Claude Code CLI — Claude Desktop and the claude.ai sync path accept `github`, `url`,
  `git-subdir` or a relative path, and reject a marketplace using anything else.
- **Do not move `.mcp.json` to the repository root.** Claude Code reads a root `.mcp.json` as
  project MCP config, where `${CLAUDE_PLUGIN_ROOT}` is unset, and warns on every run.
- Validate both manifests: `claude plugin validate ./plugin` and `claude plugin validate .`.
- To exercise the plugin without publishing:
  `claude plugin marketplace add /path/to/paperless-ngx-mcp`.

## Releasing

The version appears in four files that must agree, plus the lockfile. Nothing enforces this yet, so
check by hand:

| File | Field |
| --- | --- |
| `package.json` | `version` |
| `src/index.ts` | `VERSION` |
| `plugin/.claude-plugin/plugin.json` | `version` |
| `.claude-plugin/marketplace.json` | `plugins[0].version` |

Then `npm install --package-lock-only`. `prepublishOnly` runs typecheck, tests and build. npm will
not let a published version be overwritten, so a bump is mandatory; treat a change to the confinement
defaults as breaking.

## Conventions

No formatter or linter is configured — match the surrounding code.

- Four-space indent, single quotes, semicolons, lines up to about 125 columns.
- Comments explain *why*, not *what*, and are omitted where the code is self-evident.
- Tool failures surface as `isError` results through `handle()` in `src/format.ts` rather than
  thrown exceptions, because the model reads them. An error type whose message should reach the user
  verbatim needs adding to the `instanceof` list there.
- Tool output is name-resolved and truncated by default; keep new output cheap to read.
