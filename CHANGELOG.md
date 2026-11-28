# Changelog

## [Unreleased]

## [0.4.0] - 2026-11-28

**New — the routine ACP nudge is now dropped at the provider layer.** `billion-context` 0.1.216+
appends its "you should compress" reminder in the local proxy, after every Pi hook has run, so the
message-level filter (`acp/nudge-filter.ts`) never saw it: the gentle reminder came back on every turn
from `minContextLimitPct` (45%) onward. The new `acp/provider-nudge.ts` inspects the outgoing provider
payload (`messages` for Anthropic/OpenAI, `input` for Responses, `contents` for Gemini) and removes the
trailing *routine* reminder only; emergency (`Context limit reached`, `[EMERGENCY`) and tier (`[TIER `)
reminders stay, and text the user actually typed is never dropped. The handler is registered *before*
the entry gate on purpose — this is the one job the inactive copy still performs when a local variant
runs the skill features.

The filter only sees the reminder if this package loads **after** `billion-context` in `packages`
(`before_provider_request` handlers run in registration order); `tests/skill-latch-provider-nudge.test.mjs`
asserts that order against `profiles/local/settings.json`.

## [0.3.0] - 2026-11-28

**Behavior change — the boundary note is now every turn.** While a skill is latched, the note is
emitted on every request, not only on turns that already carry an ACP nudge. The wording is a rule
(`endId must not exceed …`) rather than a hint; multiple skills share one line, sorted by boundary,
with `To keep all` naming the smallest limit. It still never blocks compression, and if a body does
fold the next turn reports it once with the full path to re-read. A folded skill is removed from the
same turn's boundary line before that line is built, so the two notices cannot contradict each other.
This makes the note work when the model compresses on its own, and under `billion-context` 0.1.216+,
whose nudges are injected at the local proxy after every Pi hook.

- Adapted to the upstream rename `billion-context-pi` → `billion-context`; the anchor test now finds
  `dist/agent/pi-native.js`. The old nudge filter remains only as a compatibility path for ACP
  versions that still append reminders in `context`.
- `peerDependencies` relaxed: `@earendil-works/pi-coding-agent >=1.6.0` → `>=1.5.0`. 1.5.0 already has
  the actionable `turn_end` boundary with `outcome` (`"completed" | "aborted" | "error"`), and the
  extension only uses the 1.5.0+ event surface.
- README ACP section and `settings.hints` documentation updated; `settings.hints = false` disables
  the keyword hint but leaves compression boundary notes running.

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
