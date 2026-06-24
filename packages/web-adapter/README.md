# @bugsee/web-adapter

Shared plumbing for the Bugsee web framework adapters (`@bugsee/react` / `vue` / `svelte` / `angular` /
`solid`): resolve the launched client (carrier by default), report an error via `logException`, and refine
the active navigation transaction via the performance naming seam (F5/D5). Each framework adapter layers its
framework-specific error context + route-pattern extraction on top. Tier 4 (shared). See
`docs/design/frontend-adapters.md` §7 (the depth pass).
