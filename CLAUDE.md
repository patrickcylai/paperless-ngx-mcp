@AGENTS.md

## Claude Code

- Read `src/paths.ts` before changing anything that touches the filesystem or builds a request URL.
  The confinement there is load-bearing, and the reasoning behind it is in the AGENTS.md invariants
  rather than in the call sites.
- Verify against a stub rather than reasoning about it: `test/e2e.test.ts` shows the pattern, and
  the plugin can be installed from a local marketplace without publishing.
- Say plainly when a change weakens a security invariant or alters a documented default. Both have
  shipped here by accident before.
