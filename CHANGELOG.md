# Changelog

## [0.2.0]

Requires `pi` 1.6.0 or newer. The hint now expires at the end of a *turn* rather than at the end of a
user message, which becomes observable through `turn_end`'s `outcome`.

- **The skill hint now lives for one turn, not one user message.** A turn is one LLM request plus the
  tool calls it makes; by its end the model has either read the named `SKILL.md` or moved on. The old
  boundary was `agent_settled`, which fires only after the whole message settles — so a message with N
  requests re-read the same hint N times, a cost paid per request, which is exactly what this package
  exists to avoid. `turn_end` also carries `outcome`, so a failed turn (rate limit, abort) leaves the
  slate alone and the retry still sees the names.
- **Carry-over is now at most two hints per user message:** the full hint in the first turn, one
  `Previously named, final reminder:` line in the second, then silence. Reading the skill at any point
  drops it from the carried list.
- `peerDependencies` now requires `@earendil-works/pi-coding-agent >=1.6.0` instead of `*`.
- README now leads with install: prerequisites, the one-line `pi install git:…`, a variants table,
  and an **"If you are an agent reading this"** block, so an agent can install without guessing.
- `fresh-check --source <spec>` verifies an already-published source (`git:…`, `npm:…`, a path)
  instead of packing the working tree; run it with `--auth` for the real-turn check too.

## [0.1.0]

First public version. Extracted from a local Pi extension and generalised for sharing:

- `<skill-hint>`: keyword hits in the user's own words name the matching skills, with paths.
- `search_skills`: keyword search over names, descriptions and your trigger words; no query lists
  all skills.
- The native `<available_skills>` list is cleared from the system prompt unless
  `settings.nativeSkillList` keeps it. A first-request self-check reports when another package
  snapshotted the prompt before the list was cleared.
- Word list, `presets`, `companion` edges and `noname` all live in one user-owned config at
  `<agentDir>/skill-latch.json`; the package ships an empty example instead of a personal list.
- ACP integration is now optional and detected from the transcript: compression boundary notes,
  folded-body notices and daily-nudge filtering only activate when ACP's message refs appear. The
  package degrades to the on-demand skill channels on stock Pi.
- `settings.entry` arbitrates between this package and a local variant installed on the same machine:
  explicit `"local"` / `"generic"`, or `"auto"` where the copy loaded first wins. Both can stay
  registered; only one wires up, so neither double-registers `search_skills` nor double-injects hints.
- `npm run pack-check` verifies the *packed* artifact: pack, install into an empty project, load that
  copy through pi's jiti loader, assert hooks, tool, hint and query. Catches what a dev tree hides
  (missing `files` entries, `node_modules/` type-stripping limits, a peer dependency that never
  resolves).
- `npm run fresh-check` builds a throwaway agent dir whose only package is this one, so Pi's own
  discovery has to find it; with `--auth <file>` it also runs one real turn and asserts
  `search_skills` answers. Credentials are copied, never read.
- `bin/audit-triggers.ts` reports skills no hint can reach, orphaned trigger keys, dead companion
  edges and unused presets. Defaults follow Pi's standard skill locations instead of a local
  checkout layout.
