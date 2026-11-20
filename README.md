# pi-skill-latch

Pi package that makes skills cost nothing until they are needed: keyword hints plus a
`search_skills` tool instead of advertising every skill on every request.

## Install

Needs a working `pi` (Node >= 22.18). `pi install` clones the repo and runs
`npm install --omit=dev` inside it, so `git` and the npm registry must be reachable.

```bash
pi install git:github.com/cai7199/pi-skill-latch
```

Restart pi afterwards — extensions are not hot-reloaded. `pi list` should then show
`git:github.com/cai7199/pi-skill-latch` resolved to a directory under
`<agentDir>/git/github.com/cai7199/`.

| | |
|---|---|
| pin a version | `pi install git:github.com/cai7199/pi-skill-latch#v0.1.0` |
| try for one run | `pi install -e git:github.com/cai7199/pi-skill-latch` |
| from a checkout | `pi install ./path/to/pi-skill-latch` |
| uninstall | `pi remove git:github.com/cai7199/pi-skill-latch` |

Optional, but this is what makes the keyword hints fire: copy `skill-suggest.example.json` to
`<agentDir>/skill-latch.json` and put your own words there (`agentDir` is `PI_CODING_AGENT_DIR`, or
`~/.pi/agent`). Without it `<skill-hint>` stays quiet and `search_skills` still works.

### If you are an agent reading this

1. Run `pi install git:github.com/cai7199/pi-skill-latch`.
2. Ask the user to restart pi; the extension does not hot-reload.
3. Verify with `pi list` — the entry must resolve to a directory under `<agentDir>/git/github.com/cai7199/`.
4. Leave `<agentDir>/settings.json` alone; `pi install` already wrote it. Ask the user for their own
   trigger words instead of inventing keywords.

## How it works

Pi advertises every installed skill in the system prompt — name, description and path, for every
skill, on every request. Most turns use none of them. This package removes that standing list and
replaces it with two channels that only pay when they hit:

- **`<skill-hint>`** — the user's own words are matched against a word list you write, and hits are
  named in the request with their path. Costs one line, only on the turns that match.
- **`search_skills`** — when nothing matched, the model can search skills by keyword (name,
  description, your trigger words). Costs one tool call, only when called.

With [ACP](#acp-optional-compression-boundary-notes) (`billion-context-pi`) installed it also does
one more thing: it reports where compression may cut **without folding the skill body you just
read**, and tells the model when a body has already been folded into a summary.

## Verify an install (maintainers)

```bash
npm run pack-check      # artifact survives install + pi's loader (no credentials)
npm run fresh-check     # empty agent dir: pi discovers it, word list fires (no credentials)
npm run fresh-check -- --auth <path/to/auth.json>   # plus one real turn calling search_skills
npm run fresh-check -- --source git:github.com/cai7199/pi-skill-latch   # skip packing, pull what is published
```

`--source` swaps the tarball for a published spec (`git:…`, `npm:…`, a path), so the same check runs
against what users actually install — still in a throwaway agent dir, still cleaned up afterwards.

`pack-check` packs the tarball, installs it into an empty project, and loads **that copy** through
pi's own jiti loader — asserting the hooks wired, `search_skills` registered, `<skill-hint>` injected
and the tool answering. A working dev tree proves nothing about a published artifact: files move
into `node_modules/` (where Node's native type stripping refuses
`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), only `files`-whitelisted paths survive, and
`typebox` arrives through `peerDependencies`.

`fresh-check` goes one level up: it builds a throwaway agent dir whose only package is this one, so
Pi's own discovery has to find it, then (with `--auth`) runs a single real turn against a model to
prove `search_skills` answers. The credential file is only copied into the temp dir — never parsed,
never printed.

## Configure

Read once at startup from `<agentDir>/skill-latch.json` — `agentDir` is `PI_CODING_AGENT_DIR`, or
`~/.pi/agent` when unset. Override the path with `SKILL_LATCH_CONFIG` (the older
`SKILL_LATCH_SUGGEST_CONFIG` still works).

```bash
cp skill-suggest.example.json "<agentDir>/skill-latch.json"
```

The root of the file is a **word list**: skill name → trigger words. Three reserved keys carry the
rest (`settings`, `presets`, `companion`, `noname`); their values are objects, so they never collide
with a skill name.

```json
{
  "settings": {
    "acp": "auto",
    "nativeSkillList": false,
    "searchTool": true,
    "hints": true,
    "debug": false
  },
  "presets": {
    "doc-work": ["paper", "manuscript", "write a report"]
  },
  "spectre": ["simulation", "spice", "corner sweep"],
  "office-docx": ["docx", "word doc", "three-line table"],
  "companion": {
    "writing": { "office-docx": ["@doc-work"] }
  },
  "noname": { "writing": true }
}
```

| Key | Meaning |
|---|---|
| `settings.entry` | `"auto"` (default) lets the copy that loads first take the wheel; `"local"` / `"generic"` name the winner explicitly. Only matters when a local variant is installed alongside this package — see [coexistence](#coexisting-with-a-local-variant). |
| `settings.acp` | `"auto"` (default) enables the compression boundary notes only after ACP message refs show up in the transcript; `true` forces them on; `false` turns them off entirely. |
| `settings.nativeSkillList` | `true` keeps Pi's native `<available_skills>` list. Escape hatch when a skill stops being used. |
| `settings.searchTool` | `false` skips registering `search_skills`. |
| `settings.hints` | `false` disables `<skill-hint>` injection (and its one standing rule). |
| `settings.debug` | `true` writes `<agentDir>/skill-latch-debug.log` every turn: message index, ref, tool call id, text head. |
| `<skill-name>` | Trigger words for that skill. ASCII words match on word boundaries; a trailing `*` widens the right edge (`guideline*`). `[]` mutes the skill. |
| `presets` | Named word fragments; reference them as `"@name"` from a word list or a companion condition. Expanded once, one level deep. |
| `companion` | Skill → companion skills to name together when the source is named. Array form is unconditional; object form (`{ "office-docx": ["@doc-work"] }`) only fires when one of those words matched this turn. |
| `noname` | Skills whose own name must not act as a trigger word (`writing`, `review` — names that are also ordinary words). |

Environment overrides win over the file: `SKILL_LATCH_NATIVE_SKILL_LIST=1`, `SKILL_LATCH_DEBUG=1`,
`SKILL_LATCH_CONFIG=<path>`.

### Why a word list and not the description

A description is written for the model, not for lexical matching: it is long, it is often English
while the user types Chinese, and it repeats across skills. A hand-written list is one line per
skill you care about, and it is the only place that knows "跑个仿真" means `spectre`. Skills without
an entry still work: their name acts as the trigger word when it is at least 5 characters and not in
`noname`, and `search_skills` searches names and descriptions too.

### Check what is reachable

```bash
node bin/audit-triggers.ts            # scans <agentDir>/skills, .pi/skills, .agents/skills
node bin/audit-triggers.ts --root <dir>... --config <path> --strict
```

Exit code 1 on `ERROR` (a skill has no effective trigger at all — only reachable through
`search_skills`), or on `WARN` with `--strict` (only the bare name matches). It also reports trigger
keys that match no installed skill, companion edges that can never fire, and unused or broken
`@preset`s — all of which are silently dropped at runtime.

## ACP: optional compression boundary notes

Everything above works on stock Pi. If [ACP](https://www.npmjs.com/package/billion-context-pi) is
loaded, this package also watches which skill bodies were read and reports the last message they
safely fit under:

```
SKILL LATCH — compress up to (body folds to a summary past it):
- spectre: m00142
```

That line is only injected on turns that already carry an ACP nudge, so it costs nothing on ordinary
turns. It is a **hint, not a gate**: compression is never blocked, and if a body does get folded the
next turn says so, once, with the full path to re-read.

ACP is detected from the transcript itself — once a message carries an `<acp …>mNNNNN</acp>` ref,
the notes turn on; with `settings.acp = "auto"` and no ACP, the whole subsystem stays idle instead of
accumulating registrations it can never report.

**Load order matters.** If another package returns `systemPrompt` from `before_agent_start`, it
snapshots the prompt with the native skill list still in it, and clearing afterwards is too late.
List this package before that one in settings:

```json
{
  "packages": [
    "npm:pi-skill-latch",
    "npm:billion-context-pi"
  ]
}
```

If that did not work, the first request logs a warning naming the problem instead of failing
silently.

## Coexisting with a local variant

A machine can carry two implementations of the same idea: a local, machine-specific variant (its own
word list, its own hardening) and this package. They cannot both wire up — both would register
`search_skills`, inject `<skill-hint>`, and clear the native skill list.

So both load, and exactly one takes the wheel. The winner is decided at startup:

1. `settings.entry` names it (`"local"` or `"generic"`) — this beats load order;
2. with `"auto"`, whichever copy is loaded first claims the slot. **`packages` order is therefore
   precedence**, so listing the local variant first keeps it the default.

The other copy registers nothing and logs one line. Nothing is shared between them: the decision
lives in the same config file (`settings.entry`), and each copy carries a mirror of the rule.

```json
{
  "packages": ["./my-local-variant", "npm:pi-skill-latch", "npm:billion-context-pi"]
}
```

```json
{ "settings": { "entry": "local" } }
```

## Trade-offs, stated plainly

- The model no longer knows which skills exist. It has to be pointed at them, or ask. That is the
  whole saving; the hint lead and the `search_skills` description both carry it.
- A matched hint is a **candidate**, not an instruction. A standing rule says so, because keyword
  matching is lexical and will hand the model a skill the task does not need.
- Hints and carried reminders last one turn each. Repeating them every turn is how a useful nudge
  becomes wallpaper.
- `disable-model-invocation` skills are never hinted (the model cannot see them either).

## Requirements

- Pi with the `context_with_system` extension hook (1.5.x and later).
- No runtime dependencies beyond what Pi provides (`typebox` is a peer dependency, resolved by the
  host). Node ≥ 22.18 is only needed to run the bundled tests and CLI directly.

## Development

```bash
npm test                                   # node --test, type stripping
PI_ACP_BUNDLE=<path>/billion-context-pi/dist/index.js npm test   # also verify ACP anchors
```

`test/acp-anchors.test.ts` pins every text anchor that `src/acp/nudge-filter.ts` uses to recognise
ACP's own nudge messages. ACP does not tag those messages, so a wording change upstream would make
the filter fail silently; that test is the alarm.

## License

MIT.
