# Upstream patches

Fixes this kit needs but which live in `@eventmodelers/cli`, not here. The
CLI copies `shared/build-kit/*` into `.build-kit/` on install *before* this
kit's overlay, so this kit could override `lib/ralph.js` — but that would
fork the whole runner and stop upstream fixes reaching it. Send these
upstream instead.

| patch | against | what |
|---|---|---|
| `ralph-auto-block-comment.patch` | `@eventmodelers/cli` 1.0.75, `shared/build-kit/lib/ralph.js` | `blockStuckSlice` flips a stuck slice to `Blocked` on the board but writes the reason only to `progress.txt`. The patch also posts it as a comment on the slice (same `/nodes/:id/comments` endpoint and `x-token` headers `request-feedback` and `handle-comment` use), so the board says why. |

Apply in a CLI checkout: `git apply docs/upstream/<name>.patch`.

Related, also upstream: every built-in stack's `backend-prompt.md` tells the
agent to check `.build-kit/.eventmodelers/config.json`, but `init` writes
`.eventmodelers/config.json` at the project root. The agent finds nothing and
silently skips all board updates. Fixed in this kit's copy; the built-in
stacks (axon, blank, kurrent, node, opencqrs, supabase, supabase-react, umadb)
still have it.
