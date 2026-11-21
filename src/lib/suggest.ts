/**
 * 关键词建议的纯逻辑（不 import pi、不读盘，便于单测）。
 *
 * ## 为什么不从 description 自动抽词
 * `description` 是给模型做选择题的散句，不是词表：抽出来必然是一堆 `use` / `when` / `file`
 * 这种每个技能都有的词，指路能力为零。中文提问还彻底撞不上——用户写「跑个仿真」，描述里写
 * `Run ... simulations`，同义词不是同一个字符串。所以触发词由人写：想精就精，一个词只挂一个技能。
 *
 * ## 一次误报的代价
 * 模型读一遍 SKILL.md（几 KB），并且 `compress` 从那一刻起被钉住（见 `compress-gate.ts`）。
 * 不算致命，但会让 `<skill-hint>` 变成墙纸——模型学会无视它，这个功能就白做了。宁可漏报。
 *
 * ## 两种匹配
 * ASCII 词按**词边界**匹配（`latch` 命中 `skill-latch`，但不命中 `latest`）；非 ASCII 词按
 * **子串**匹配（中文没有词边界，`仿真` 出现在哪算哪）。
 *
 * 不用正则：配置里写的是人话词表，正则元字符（`.` `(` `+`）会把「一个词」变成「一段没写测试
 * 的语法」——一个词只用 `indexOf` 加两侧词字符检查就够，且用户改配置不会意外拿到匹配引擎的
 * 全部权力。唯一的正则在本文件里只用来判断「这个字符算不算词字符」（`isWordChar`）。
 */

import { formatSkillsBlock, type SkillEntry } from "./skill-format.ts";

/**
 * 提醒的包裹标签。原生 `<available_skills>` 已从系统提示里摘掉（见 `index.ts` 的
 * `before_agent_start`），所以这一份得自己带齐 `name` / `description` / `location`——
 * 只给名字等于指了个空：模型知道有这么个东西，却不知道去哪读。
 */
export const HINT_TAG = "skill-hint";
/**
 * 标签下的行动指令：读哪些文件；旧历史里已不再相关的先压掉再读。
 *
 * ## 各半句归谁计费
 * - 读法（全读、同轮并行、this turn）收进 `READ_IN_FULL`，与 `search_skills` 的 lead 共用：
 *   两个「加载时」通道各写一份必然漂移，只留一个常量。复数 + 同轮并行是「只读第一个」的
 *   防复发措施：实测模型读了 `office-docx`，把内容侧的 `paper` 留给「下一轮」，而下一轮
 *   的提醒早就不在了（寿命只到第一个 turn 结束）；复合任务（写 Word 论文 = 版式 + 内容）
 *   恰恰要求同一次读两个，所以这一句要明确「每一条都属于这次任务就都读」。
 * - 「按 `<description>` 逐个判断」已上提 L0 的 `HINT_CANDIDATE_GUIDELINE`（每轮计费），
 *   lead 不再重复：同一句话写在两层，双计费且改一处漏一处。
 * - 后半句「同一任务的两个侧面各读一个不算重复」放在 `latchedNote`：那句只在**手上有技能**
 *   时出现，而那正是模型开始掂量「是不是重复了」的时刻。两个地方各写一份就会在同一块里
 *   重复一遍（两块常同块计费），所以 lead 只留事实，反例归钉住句。
 * - 压缩是条件句（"if"）：按不按由模型看当前上下文肥不肥，上下文已经薄就不必动手——
 *   压不动手也白付一轮。压的边界（什么不能折）归 `compress` 自己的描述与闸门管，
 *   这里不越权重复：一句话在两层各写一份，改一处漏一处。
 *
 * 这里**不**提 `search_skills`：提醒之所以出现，就是因为已经点出了名字，再顺带广而告之
 * “还有个全表可查”属于自相矛盾——没命中时根本不出现提醒，命中时却发现有个全表，
 * 模型学到的就是「以后先扫全表」。检索通道的存在感交给 `search_skills` 自己的 L1，那是有成本、
 * 但只在「任务看着专门却没等到提醒」这个真需要的时刻才值得计费的位置。
 */
/**
 * 两个「加载时」通道（hint 与 `search_skills`）共用的半句，各自一份文案改一处漏
 * 一处，所以都收成常量，两边只管拼接。
 */
export const COMPRESS_BEFORE_READ =
	"If older history is no longer relevant, compress it before reading.";
/** 读法半句：覆盖的都读、全读（指纹定位靠全文）、同轮并行——`HINT_LEAD` 与全表 lead 共用。 */
export const READ_IN_FULL = "Read each covering SKILL.md in full, in parallel, this turn";
export const HINT_LEAD = `${READ_IN_FULL}. ${COMPRESS_BEFORE_READ}`;
/**
 * 提醒 lead 的追加句「谁还钉着」：仅在已有钉住技能时拼上（见 `buildHintText`）。
 *
 * 三半分工，互不重复：
 * - 事实（谁钉着）：没有代码告知模型这件事，不写它就得自己回忆读过谁；
 * - 代价结构（加钉不释旧）：读新技能的默认直觉是「旧的那个可以放了」，机制上两者共存到
 *   正文被折走，不点明会猜错；
 * - 判据换成「覆盖任务的另一半才读」：早先这里写的是 `Read it only if this task needs it`，
 *   方向反了——它是一道刹车，而且恰好踩在**最该读第二个**的那一刻（复合任务里第二个技能
 *   几乎总是「额外需要」）。实测后果就是论文任务只读版式技能。
 *
 * ## 怎么写的
 * - **主语是协同，不是记账**：`adds a pin instead of replacing` 是我们内部的机制（钉住表），
 *   模型关心的不是计数，而是「这两个技能能不能一起用」。所以句子换成
 *   `The skills below work alongside the latched ones rather than replacing them`——
 *   同一个事实（不会顶掉旧的），但读它的人看到的是协作，不是账本。
 * - **不用悬空代词**：前半句只点了钉住的名字（常常只有一个），再写 `one of these` / `it`
 *   就把读者往错的方向指——指代对象其实在句子**后面**（下面那些条目）。所以统一用名词：
 *   `The skills below` / `the latched ones` / `any covering…`。
 * - **不提 `redundant`**：早先那句里明写着「不是重复」，而这个词本就是这句话第一次引入。
 *   模型本来只是想「下轮再读」，一引进来反而开始掂量重复与否。换成正面表述
 *   （`some tasks need several skills`）。
 * - **不写数量**：早先草稿写过 `one task can need two`——数字会过期（将来三个技能协同时
 *   那句话就成了一种保证）。`several` 只说「不止一个」，与 `MAX_SUGGESTIONS` 怎么变无关。
 * - **不重复的两处**：「正文被钉住、压过去就成摘要」在每轮的提示行里说（只在钉住期计费，
 *   见 `boundary-note.ts`）；「折走会怎样」在 `atRiskFoldNote` / `foldedBodyNote` 里说。
 *   两句抄到这里只会双计费并漂移。
 *
 * 不进 L0：只在「钉住且命中」时出现，按次计费，时隐时现不伤规则前缀。
 */
export function latchedNote(names: readonly string[]): string {
	if (names.length === 0) return "";
	return `Still latched: ${names.join(", ")}. The skills below work alongside the latched ones rather than replacing them — some tasks need several skills, so read any covering another part of this task.`;
}
/**
 * 提醒 lead 的追加句「上一轮点名、到现在还没读」。
 *
 * ## 为什么需要它
 * `<skill-hint>` 的寿命只到本条消息的第一个 turn：`pendingText` 在 `turn_end` 就清空，而原生
 * `<available_skills>` 已被摘掉。于是「这一轮先读版式技能，论文技能下一轮再说」这句在模型
 * 看来完全合理——下一轮它连 `paper` 这个名字都不存在了，不是它懒，是它没法知道。
 *
 * 补法就是这一句：把上轮点名而没读的条目在下一次请求里再并进同一块，给出名字与路径。
 *
 * ## 为什么只提一次
 * 重复提到模型不读的技能，代价是每轮的 token 和一次「墙纸化」——学会无视之后连真命中
 * 也一起被忽略（同 `suggest.ts` 开头的误报代价）。一次足够把事实交到模型手上，剩下的决定
 * 归它。`mixed` 为真时说明这块里还有本轮的新命中，那就不必冒充「最后通牒」。
 *
 * 结尾只陈述「不会重复」：早先写的是「读它，或者认下它不适用、永远别再想」——那是修辞，
 * 模型能做的只有现在读或不读。事实它推不出来（发出即消费），修辞它无法执行。
 */
export function carryNote(names: readonly string[], mixed: boolean): string {
	if (names.length === 0) return "";
	const list = names.join(", ");
	if (mixed) return `Previously named, not yet read: ${list}.`;
	return `Previously named, final reminder: ${list}.`;
}
/**
 * 把「上轮点名没读」的条目并进这一轮的建议：已钉住的（模型已经读过了）与这一轮又命中过的
 * （已经在新建议里）都去掉，顺序与去重都以先出现的为准。
 *
 * 单独成函数而不是写死在 `index.ts` 的钩子里：入口文件按约定不当库 import，逻辑落在这里
 * 才测得到。
 *
 * 结转条目投影成 `SkillRef` 再进 `out`，剥掉残留的 `matched`：它是上轮命中的旧计数，这一轮
 * 没重新匹配过，带着它 `buildHintText` 会报一个本轮不成立的 `<matched-keywords>`（与
 * `HintEntry`「结转条目缺省 matched」的纪律一致；对照同伴条目 `appendCompanions` 也 `matched: []`）。
 */
export function carriedSuggestions(input: {
	suggestions: readonly SkillRef[];
	carried: readonly SkillRef[];
	latched: readonly string[];
}): SkillRef[] {
	const taken = new Set<string>([
		...input.suggestions.map((entry) => entry.name.toLowerCase()),
		...input.latched.map((name) => name.trim().toLowerCase()),
	]);
	const out: SkillRef[] = [];
	for (const entry of input.carried) {
		const key = entry.name.trim().toLowerCase();
		if (!key || taken.has(key)) continue;
		taken.add(key);
		out.push({ name: entry.name, description: entry.description, filePath: entry.filePath });
	}
	return out;
}
/**
 * L0 规矩（进 `<rules>`）：由 `index.ts` 经 `registerPromptGuidelines` 注册，常驻。
 *
 * 关键词匹配天然有误报（用户消息含触发词 ≠ 任务属于该技能），而 `HINT_LEAD` 的祈使句会诱导模型
 * 把「被点名」读成「必须照做」。这条把命中的性质说死：候选，不是判定——场景不匹配就放下照常干。
 *
 * 按 prompt-guidelines 的约定写成状态中立句：没出现 hint 的轮次它是一句无人违反的话。
 *
 * L0 只说「性质 + 判据」：逐个按 `<description>` 取舍，判据是「覆盖任务中未被覆盖的部分」
 * 而非「可与已有技能协作」——协作零门槛，拿它做筛选等于没有筛选。读法（全读、同轮并行）
 * 下沉 L1 的 `READ_IN_FULL`（hint lead 与 `search_skills` lead 共用）：L0 每轮计费，读法
 * 只在被点名的时刻有用，归 L1；「一次读完」是用户定稿的默认行为，下沉后行为不变，只不在
 * 没命中的轮次白白计费。不要求为放掉的命中给理由（误报时代价要低），也不写死具体轮次
 * （这是静态文本，说的是「一个 turn 内」）。
 *
 * 与 `HINT_LEAD` 的分工：L0 说「命中意味着什么、按什么判断」，L1 说「去读哪些具体文件、
 * 先压什么、还有谁钉着」。各管一半，不互抄。
 */
export const HINT_CANDIDATE_GUIDELINE =
	"A `<skill-hint>` match is a candidate, not a verdict: judge each named skill by its `<description>`.";
/**
 * 名字兜底的最短长度。`todo`、`ls` 这类短名撞日常用词的概率太高，宁可让它们哑火等人来配；
 * `spectre`、`virtuoso`、`netlist` 这种标识符形名字几乎不撞车，配都不用配。
 */
export const MIN_FALLBACK_NAME_LENGTH = 5;
/** 一次最多点名几个技能。 */
export const MAX_SUGGESTIONS = 5;

/**
 * 伴随能额外占的条数。与命中名额**分开管**：命中名额限的是随机命中的噪音面，伴随是配置里
 * 写死的协同关系，被前者截掉等于让复合任务退回单技能（见 `appendCompanions`）。
 */
export const MAX_COMPANION_SLOTS = 3;

/**
 * 整块 `<skill-hint>` 的硬顶 = 命中 5 + 伴随 3。
 *
 * 为什么要天花板：`MAX_SUGGESTIONS` 只封住命中的一半，伴随若也不设限，配置一长一块提醒就能
 * 拉到十几条——每轮计费，且 `<skill-hint>` 迟早变成墙纸（同「一次误报的代价」，见文件头）。
 * 3 条对应「一个任务大致能用上几个技能」的量级，不是从 token 预算倒推出来的整数。
 *
 * 截断顺序 = 源技能命中强度序：`found` 已按命中数降序，同伴就是按这个序遍历着追加的，
 * 所以尾部天然是「最弱命中带出来的同伴」。不按配置表的字面顺序——那等于「丢谁看这一轮
 * 随机命中了什么」，同一份配置在不同轮次会丢不同的边，调试时无法复现。
 */
export const MAX_HINT_ENTRIES = MAX_SUGGESTIONS + MAX_COMPANION_SLOTS;

/** 技能名 → 触发词。空数组是**静音**开关：显式配了空表就不再走名字兜底。 */
export type TriggerMap = Record<string, string[]>;

/**
 * 词表片段：一个名字 → 一组词。词表与伴随条件都用 `@名字` 引用，展开在解析期一次完成。
 *
 * 为什么需要：`writing` 的 17 个「文档产出类」词同时在它自己的词表和 `office-docx` 的
 * `only` 里。加词时忘了同步 `only`，那条词命中就静默地带不出同伴——没有运行时症状。
 * 抽成片段后只维护一份，两处引用同一个名字。
 */
export type PresetMap = Record<string, readonly string[]>;

/** 片段引用的前缀。触发词不会以它开头，`@` 只在这个位置有含义。 */
export const PRESET_PREFIX = "@";

/**
 * 一条伴随边：源技能被点名时，并进同一块 `<skill-hint>` 的同伴。
 *
 * `only` 是**按词点名**的开关：只有源技能这一轮命中的词里出现了其中至少一个，才带出同伴。
 * 缺省 = 无条件（源技能命中任何词都带）。
 *
 * 为什么需要它：`writing` 挂着 47 个词，而「要交付一个 Word 文件」只占其中一半——`润色`、
 * `随笔`、`去AI味` 跟版式毫无关系，无条件带等于每次改稿都塞一张 Word 技能的名片。
 *
 * 为什么不按「命中几个词」设闸门（≥2 才展开）：判据得是「这个场景要不要这个同伴」，与措辞里
 * 出现几个词无关。「帮我写篇论文」只命中一个词，而它恰恰是这条边存在的理由——按命中数设闸门
 * 会把唯一那条边关掉。
 *
 * `only` 里的词与词表**逐字相同**（大小写不敏感）：命中的词就是词表里的原词，所以条件写的是
 * 词表里那一串，不是它的变体。写错了这条边就永不触发，由 `findCompanionProblems` 事前报出来。
 */
export interface CompanionEdge {
	name: string;
	only?: readonly string[];
}

/** 伴随表：源技能名 → 该技能的伴随边。 */
export type CompanionMap = Record<string, CompanionEdge[]>;

/** 技能清单的最小字段集；`description` 可缺，缺了提醒里就没有那一行。 */
export type SkillRef = SkillEntry;

/** 一条建议。`matched` 用于排序，数量进 `<matched-keywords>`；词本身不进提醒正文。 */
export interface Suggestion extends SkillEntry {
	matched: string[];
}

/**
 * `buildHintText` 的入参：`matched` 可缺。跨轮结转的条目这一轮根本没命中任何词，
 * 给它编一个计数等于让模型以为「这轮它自己命中过」，所以宁可让 `<matched-keywords>` 缺省。
 */
export type HintEntry = SkillEntry & { matched?: readonly string[] };

function isWordChar(char: string): boolean {
	return char !== "" && /[a-z0-9_]/.test(char.toLowerCase());
}

/**
 * 收窄一串人写的词：只收非空字符串、去首尾空格、按原样去重（大小写留到比对时统一）。
 *
 * 词表与伴随条件共用这一条：两处对「什么算一个词」若各写一份，早晚漂移。
 */
function normalizeWords(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const words: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") continue;
		const word = entry.trim();
		if (word && !words.includes(word)) words.push(word);
	}
	return words;
}

/**
 * 把 `@片段` 摊平成片段里的词。**只展开一层**：片段自己写的 `@other` 当字面词，不再递归——
 * 传递会把配置图变成闭包计算，`@x` 实际包含谁要靠心算，与伴随「只跟一跳」同一条纪律。
 *
 * 未定义的引用直接丢掉，不在这里报错：与 `normalizeTriggers`「坏一条不该毁整表」一致；
 * 想知道哪里写错了，`findPresetProblems` 事前报。
 */
function expandRefs(words: readonly string[], presets: PresetMap): string[] {
	const out: string[] = [];
	for (const word of words) {
		if (!word.startsWith(PRESET_PREFIX)) {
			out.push(word);
			continue;
		}
		const group = presets[word.slice(PRESET_PREFIX.length).trim().toLowerCase()];
		if (group) out.push(...group);
	}
	return [...new Set(out)];
}

/**
 * 从词表文件的保留键 `presets` 里取出片段表。
 *
 * 与 `companion` / `noname` 同一套共存办法：值是对象，`normalizeTriggers` 只认数组值、
 * 见对象即丢，三个 loader 各读各的。空片段**保留**（不丢）：引用它的词表会展开成空表，
 * 正好落进「空表静音」那条既有语义。
 */
export function normalizePresets(raw: unknown): PresetMap {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
	const section = (raw as Record<string, unknown>).presets;
	if (typeof section !== "object" || section === null || Array.isArray(section)) return {};
	const map: PresetMap = {};
	for (const [key, value] of Object.entries(section as Record<string, unknown>)) {
		const name = key.trim().toLowerCase();
		if (!name) continue;
		map[name] = normalizeWords(value);
	}
	return map;
}

/**
 * 收窄配置表：键统一小写（技能名大小写不该决定配不配得上），非数组条目直接丢掉——
 * 坏一条不该毁整表，更不能让 `"paper": "论文"` 这种笔误变成「多余的兜底」。
 * 值里的 `@片段` 在这里一次展开完（见 `expandRefs`），运行时只看摊平的词。
 *
 * 片段表从**同一份 raw** 里自己取，不收参数：拿词表的调用方不必记得再传一份，
 * 也就不存在「传漏了 → `@片段` 静默变成空词」这种失败方式。
 */
export function normalizeTriggers(raw: unknown): TriggerMap {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
	const presets = normalizePresets(raw);
	const map: TriggerMap = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		const name = key.trim().toLowerCase();
		if (!name || !Array.isArray(value)) continue;
		map[name] = expandRefs(normalizeWords(value), presets);
	}
	return map;
}

/**
 * 从词表文件的保留键 `companion` 里取出伴随表。
 *
 * 为什么放在 `skill-suggest.json` 里而不开新文件：两个表是同一份人写的判断（哪个技能该和哪个
 * 技能一起被点名），拆成两个文件就是同一处知识改一处漏一处。保留键在根表里的值是**对象**，
 * `normalizeTriggers` 只认数组值、见对象即丢，两个 loader 各取各的，互不干扰。
 *
 * 两种写法都收（见 `CompanionEdge`）：
 * - 数组 `"paper": ["office-docx"]`——无条件，源技能命中任何词都带；
 * - 对象 `"writing": { "office-docx": ["论文"] }`——按词点名，说到其中某个词才带；
 *   值里同样可以写 `@片段`，解析期展开（见 `normalizeTriggers`）。
 *
 * 收窄规则与 `normalizeTriggers` 同一套：键去空格小写、坏一条丢掉不让一个笔误毁整表。
 * 空边的源不写进结果：伴随表没有「名字兜底」可静音，空和不配没有行为差别。
 */
export function normalizeCompanion(raw: unknown): CompanionMap {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
	const presets = normalizePresets(raw);
	const section = (raw as Record<string, unknown>).companion;
	if (typeof section !== "object" || section === null || Array.isArray(section)) return {};
	const map: CompanionMap = {};
	for (const [key, value] of Object.entries(section as Record<string, unknown>)) {
		const name = key.trim().toLowerCase();
		if (!name) continue;
		const edges = normalizeEdges(value, presets);
		if (edges.length > 0) map[name] = edges;
	}
	return map;
}

/**
 * 一个源技能的伴随边，认两种值形状（见 `normalizeCompanion`）。
 *
 * 对象形状里空数组是**永不**，不是无条件：写 `{ x: [] }` 的人意图是「关掉这条边」，若被读成
 * 「全都带」就与字面意思正相反。丢整条边而不是留一条永不触发的边——与 `normalizeTriggers`
 * 的 `[]` 静音不同，那里 `[]` 有明确行为（关掉名字兜底），这里没有可关的东西。
 *
 * 数组形状的值是**技能名**，不认 `@片段`（片段只装词）；只有对象形状的 only 值会展开。
 */
function normalizeEdges(value: unknown, presets: PresetMap): CompanionEdge[] {
	if (Array.isArray(value)) return normalizeWords(value).map((name) => ({ name }));
	if (typeof value !== "object" || value === null) return [];
	const edges: CompanionEdge[] = [];
	for (const [rawName, rawWords] of Object.entries(value as Record<string, unknown>)) {
		const name = rawName.trim();
		if (!name) continue;
		const only = expandRefs(normalizeWords(rawWords), presets);
		if (only.length === 0) continue;
		edges.push({ name, only });
	}
	return edges;
}

/**
 * 从词表文件的保留键 `noname` 里取出「不许用名字触发」的技能集合。
 *
 * ## 为什么需要它
 * 并集让每个技能的名字都成了触发词，而 `writing` 这种既是技能名、又是英文常用词的，一进并集
 * 就等于每段英文都有机会点亮它——误报的代价是模型白读一遍 SKILL.md，再让 `<skill-hint>` 慢慢
 * 变成墙纸。`[]` 静音是整条关掉，太重；`noname` 只关名字那一半，词表照常。
 *
 * 与 `companion` 同一套共存办法：值写成对象 `{ "writing": true }`，`normalizeTriggers` 只认
 * 数组值、见对象即丢，两个 loader 各取各的。`false` 等价于不写，方便临时开关。
 * 与技能名/目录名的比对一律小写去空格。
 */
export function normalizeNoName(raw: unknown): ReadonlySet<string> {
	const names = new Set<string>();
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return names;
	const section = (raw as Record<string, unknown>).noname;
	if (typeof section !== "object" || section === null || Array.isArray(section)) return names;
	for (const [key, value] of Object.entries(section as Record<string, unknown>)) {
		const name = key.trim().toLowerCase();
		if (name && value !== false && value !== null) names.add(name);
	}
	return names;
}

/** `.../skills/spectre/SKILL.md` → `spectre`；与 `skillNameFromPath` 同源，对任意形状都稳。 */
export function skillDirName(filePath: string): string {
	const parts = filePath.split(/[\\/]+/).filter(Boolean);
	return parts.length >= 2 ? parts[parts.length - 2] : "";
}

/**
 * 一个触发词是否命中文本。ASCII 词要落在词边界上：`latch` 命中 `skill-latch`（`-` 不是词字符），
 * 但不命中 `latest`、`latched` 这种只是前缀相同的写法。
 *
 * 词尾 `*` 放宽右边界（`guideline*` 命中 `guidelines`）：英文复数不值得为一个 s 单列一条，
 * 而取消所有词边界会让 `ppt` 匹上 `pptx`、`word` 匹上 `wordpress`——只有星号显式写出来才放宽。
 * 左边界不受影响：`*` 只回答「后面能不能接字母」，不回答「前面能不能接」。
 */
export function matchesTrigger(text: string, trigger: string): boolean {
	const raw = trigger.trim().toLowerCase();
	if (!raw || !text) return false;
	const allowRight = raw.endsWith("*");
	const needle = allowRight ? raw.slice(0, -1) : raw;
	if (!needle) return false;
	const haystack = text.toLowerCase();
	if (needle.length > haystack.length) return false;
	const needLeft = isWordChar(needle[0]);
	const needRight = !allowRight && isWordChar(needle[needle.length - 1]);
	for (let from = 0; from <= haystack.length - needle.length; ) {
		const at = haystack.indexOf(needle, from);
		if (at < 0) return false;
		const leftOk = !needLeft || !isWordChar(at === 0 ? "" : haystack[at - 1]);
		const rightOk = !needRight || !isWordChar(haystack[at + needle.length] ?? "");
		if (leftOk && rightOk) return true;
		from = at + 1;
	}
	return false;
}

/**
 * 该技能用哪张词表：显式配置（含空表静音）优先；非空时与名字**共同命中**（并集，去重）。
 *
 * ## 为什么名字不再让位
 * 早先是「配了词表就顶掉名字兜底」。词表是人手挑的同义词，天生只覆盖想得到的说法；技能名则是
 * 用户和模型最容易复述的那个词，两条命中面不同源。并集不额外制造误报：`matched` 会去重，
 * 排序仍按命中词数（同一技能命中两个词说明信号更强，排前是对的）。
 * 空表仍然整条静音：静音表达的是「别建议这个技能」，不该被并集救活。
 *
 * 名字这一半仍过 `MIN_FALLBACK_NAME_LENGTH`：并集省不掉「短名撞日常用词」的问题；
 * 长度闸拦不住「够长但常见」的词（`writing`），那类走配置的 `noname`，见 `normalizeNoName`。
 */
export function triggersForSkill(
	skill: SkillRef,
	triggers: TriggerMap,
	noName?: ReadonlySet<string>,
): string[] {
	const dirName = skillDirName(skill.filePath);
	const fallback = dirName || skill.name;
	const muted =
		Boolean(noName?.has(fallback.trim().toLowerCase())) ||
		Boolean(skill.name && noName?.has(skill.name.trim().toLowerCase()));
	const nameWord = !muted && fallback.length >= MIN_FALLBACK_NAME_LENGTH ? [fallback] : [];
	for (const key of [skill.name, dirName]) {
		const configured = key ? triggers[key.trim().toLowerCase()] : undefined;
		if (!configured) continue;
		if (configured.length === 0) return [];
		return [...new Set([...configured, ...nameWord])];
	}
	return nameWord;
}

/**
 * 从用户文本里挑出值得提醒的技能。命中的词多的排前面（截断时先丢匹配最弱的），
 * 已钉住的技能直接跳过——模型读过了就不该再被指一次路。
 *
 * `matched` 留在这里只用来排序和调试，不写进提醒正文——模型要的是"去看哪个"，不是"我为什么被点名"。
 *
 * 传入 `companion` 时，块内命中技能的同伴并进同一块（见 `appendCompanions`）：词表管
 * 「词 → 技能」，管不了「技能 → 技能」的协同，协同关系由人写进伴随表。
 *
 * `onOverflow` 只在整块撞上 `MAX_HINT_ENTRIES` 时被调一次，带上被丢掉的条目（只可能是伴随）。
 * 本函数不写日志也不读 env：回调交给入口，纯逻辑留在这里（同 `lib/` 的约定）。
 */
export function suggestSkills(input: {
	text: string;
	skills: readonly SkillRef[];
	triggers: TriggerMap;
	companion?: CompanionMap;
	latched?: readonly string[];
	noName?: ReadonlySet<string>;
	onOverflow?: (dropped: readonly SkillRef[]) => void;
}): Suggestion[] {
	if (!input.text || input.text.trim() === "") return [];
	const latched = new Set(input.latched?.map((name) => name.trim().toLowerCase()) ?? []);
	const found: Suggestion[] = [];
	const seen = new Set<string>();

	for (const skill of input.skills) {
		const dirName = skillDirName(skill.filePath);
		const name = skill.name || dirName;
		if (!name) continue;
		if (latched.has(name.toLowerCase()) || latched.has(dirName.toLowerCase())) continue;

		const matched: string[] = [];
		for (const trigger of triggersForSkill(skill, input.triggers, input.noName)) {
			const word = trigger.trim();
			if (!word) continue;
			if (matched.some((hit) => hit.toLowerCase() === word.toLowerCase())) continue;
			if (matchesTrigger(input.text, word)) matched.push(word);
		}
		if (matched.length === 0) continue;

		const key = name.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		found.push({ name, description: skill.description, filePath: skill.filePath, matched });
	}

	// 按命中数降序；稳定排序保证同分时仍是发现顺序（结果可复现，单测才写得死）。
	const capped = found.sort((a, b) => b.matched.length - a.matched.length).slice(0, MAX_SUGGESTIONS);
	appendCompanions(capped, input.skills, input.companion ?? {}, latched);
	// 整块硬顶（见 `MAX_HINT_ENTRIES`）：超出的只可能是伴随——命中已在上一步截到 5，而伴随按
	// 源强弱序追加，尾部正是「最弱命中带出来的同伴」，丢它代价最小。先取快照再截，回调才拿得到名单。
	if (capped.length > MAX_HINT_ENTRIES) {
		input.onOverflow?.(capped.slice(MAX_HINT_ENTRIES));
		capped.length = MAX_HINT_ENTRIES;
	}
	return capped;
}

/**
 * 把命中技能的伴随并进同一块。追加在命中条目之后、不再重排：命中条目已按强弱排好，
 * 同伴统一垫在后面，顺序可预期、单测写得死。
 *
 * ## 为什么需要
 * 复合任务（写 Word 论文 = 内容 + 版式）要求同一次读两个技能，而跨轮结转（`carryNote`）
 * 只在「上轮点名过」时才救场——「模型只读了 `paper`、`office-docx` 的名字从头到尾没出现过」
 * 这种缺口它堵不住。伴随边把协同关系写死在配置里：命中 `paper` 时 `office-docx` 并进同一块，
 * 模型一次读齐；真用不上时按 `HINT_CANDIDATE_GUIDELINE` 看 description 丢弃，代价是读一行
 * 描述，不是读一遍 SKILL.md。
 *
 * ## 规则
 * - 只跟**本块里的命中条目**走（`matched` 非空）：没命中或被 `MAX_SUGGESTIONS` 截掉的技能不
 *   带动同伴；已钉住的源技能本来就不进块，它写死的协同关系跟着缺席——模型读过正文，
 *   正文里自己写着怎么配对。
 * - 同伴条目 `matched: []`：它自己没命中任何词，伪造命中计数等于骗模型「它这轮自己命中过」
 *   （与跨轮结转条目同一条纪律，见 `HintEntry`）。
 * - 不占 `MAX_SUGGESTIONS`：命中名额管的是随机命中的噪音面，伴随是人写死的协同关系，截掉它
 *   等于让复合任务退回到旧缺口。但伴随另有自己的天花板：整块最多 `MAX_HINT_ENTRIES` 条，
 *   否则「伴随」就成了第二张无上限的词表（见常量处）。
 * - 只跟一跳：同伴的同伴不再扩散——扩散了就把「写死的协同」变成图遍历，词表的可预测性没了。
 * - 边上的 `only` 没被命中就不带：判据是「这个场景要不要这个同伴」，不是「命中几个词」
 *   （见 `CompanionEdge`）。
 * - `only` 与命中的词**逐字**比对（大小写不敏感）：`matched` 里存的就是词表原词，再拿
 *   `matchesTrigger` 去「用词匹配词」是语义错位；写错的词由 `findCompanionProblems` 事前报出来。
 * - 同伴名字必须在 `skills` 里查到（按技能名或目录名，大小写不敏感）：配表笔误静默丢掉，
 *   不能让提醒指空气（与 `normalizeTriggers` 的「坏一条不该毁整表」同一条纪律）。
 */
function appendCompanions(found: Suggestion[], skills: readonly SkillRef[], companion: CompanionMap, latched: Set<string>): void {
	if (Object.keys(companion).length === 0) return;
	// 两个键都能查到：配置里写的是人话名字，大小写与「名字还是目录名」不该决定查不查得到。
	const refs = new Map<string, SkillRef>();
	for (const skill of skills) {
		for (const key of [(skill.name ?? "").trim().toLowerCase(), skillDirName(skill.filePath).toLowerCase()]) {
			if (key && !refs.has(key)) refs.set(key, skill);
		}
	}
	const taken = new Set(found.map((entry) => entry.name.trim().toLowerCase()));
	for (const entry of found) {
		if (entry.matched.length === 0) continue; // 只跟一跳：同伴条目自己不再带动同伴（见函数头）
		const edges: CompanionEdge[] = [];
		for (const source of [entry.name.trim().toLowerCase(), skillDirName(entry.filePath).toLowerCase()]) {
			edges.push(...(companion[source] ?? []));
		}
		const hits = new Set(entry.matched.map((word) => word.trim().toLowerCase()));
		for (const edge of edges) {
			if (edge.only && !edge.only.some((word) => hits.has(word.trim().toLowerCase()))) continue;
			const key = edge.name.trim().toLowerCase();
			if (!key || taken.has(key) || latched.has(key)) continue;
			const ref = refs.get(key);
			if (!ref) continue;
			taken.add(key);
			found.push({ name: ref.name || key, description: ref.description, filePath: ref.filePath, matched: [] });
		}
	}
}

/**
 * 拼提醒正文：按命中强弱排好序的整块（`name` / `description` / `location` / `matched-keywords`）。
 *
 * 为什么带路径而不是只带名字：原生技能块不在系统提示里了，名字本身不构成行动——模型得知道
 * 去 `read` 哪个文件。为什么不报命中了哪些词、只报数量：词是「我为什么被点名」，本扩展的推理
 * 过程不外露；数量是强弱信号，截断丢的就是命中数最弱的，模型拿它掂量先读哪个。
 * 0 不报：命中 0 个的词表技能根本进不了建议，报了 0 反而教模型「0 也值得看」。
 *
 * 三句 lead 各管一段，缺省就不付钱：`HINT_LEAD` 常驻（这一块怎么用）、`latchedNote` 只在
 * 有钉住时（共存与判断边界）、`carryNote` 只在有结转时（上轮点名没读的）。
 * `carriedNames` 必须是 `entries` 里真实存在的子集；`entries.length > carriedNames.length`
 * 就说明这块同时还有本轮的新命中，`carryNote` 据此决定要不要说成「最后通牒」。
 */
export function buildHintText(
	entries: readonly HintEntry[],
	latchedNames: readonly string[] = [],
	carriedNames: readonly string[] = [],
): string {
	const rendered = entries.map(({ name, description, filePath, matched }) => ({
		name,
		description,
		filePath,
		matches: matched?.length || undefined,
	}));
	const lead = [HINT_LEAD, latchedNote(latchedNames), carryNote(carriedNames, entries.length > carriedNames.length)]
		.filter(Boolean)
		.join(" ");
	return formatSkillsBlock(HINT_TAG, rendered, lead);
}

/** 这条消息是不是本扩展注进去的提醒（供测试与将来可能的去重使用）。 */
export function isSkillHintText(text: string): boolean {
	return text.includes(`<${HINT_TAG}>`);
}
