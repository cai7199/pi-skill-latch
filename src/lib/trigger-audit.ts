/**
 * 「按需通道会不会失明」的纯逻辑（不 import pi、不读盘，便于单测）。
 *
 * 摘掉原生 `<available_skills>` 之后，一个技能能不能被 `<skill-hint>` 自动点名，取决于它的
 * **有效触发集**（`triggersForSkill` 的返回）：配的词 ∪ 名字兜底。名字兜底只对名字≥5字且不在
 * `noname` 的技能成立。于是「没配词」有两种截然不同的命运：
 *   - 名字够长 → 还有名字兜底，用户打出内部名才命中（弱，但够得着）；
 *   - 名字太短或在 `noname` 里 → 有效集为空，hint 通道彻底够不着，只剩 `search_skills` 一条路。
 *
 * 所以判据是**有效触发集**，不是「词表里有没有这一条」——直接按「没配词就报警」会把所有靠
 * 长名字兜底的技能误报一遍。本模块把每个技能分成四档，外加一个反向检查（词表里配了、但没有
 * 对应已装技能的孤儿 key）。
 *
 * 判据全部经 `triggersForSkill` / `skillDirName` / `MIN_FALLBACK_NAME_LENGTH` 走同一套，不另写一套：
 * 两处若各写一份，「什么算命中」会漂移。
 */

import {
	MIN_FALLBACK_NAME_LENGTH,
	PRESET_PREFIX,
	skillDirName,
	triggersForSkill,
	type CompanionMap,
	type SkillRef,
	type TriggerMap,
} from "./suggest.ts";

/**
 * 每个技能的一档归类：
 * - `ok`     有≥1个手写词（curated）——正常。
 * - `warn`   没有手写词，但名字兜底还活着（名字≥5 且不在 noname）——用户得打出内部名才命中。
 * - `error`  有效触发集为空（名字<5 或在 noname，且没配词）——hint 通道够不着，只剩 search。
 * - `muted`  词表里显式配了空表 `[]`——你故意关掉它，不算漏。
 */
export type TriggerTier = "ok" | "warn" | "error" | "muted";

export interface SkillAudit {
	/** 展示名（技能名，缺了退回目录名）。 */
	display: string;
	/** `.../skills/<name>/SKILL.md` 里紧邻 SKILL.md 的目录名。 */
	dirName: string;
	filePath: string;
	tier: TriggerTier;
	/** hint 通道实际用的触发集（`triggersForSkill` 的返回）。 */
	effective: readonly string[];
	/** 只含手写的词（curated）——名字兜底不算在内。 */
	configuredWords: readonly string[];
	/** 名字兜底是否活着（有效集里含 fallback 名）。 */
	hasNameFallback: boolean;
	/** 词表里显式配了空表。 */
	muted: boolean;
	/** fallback 名是否 < MIN_FALLBACK_NAME_LENGTH。 */
	nameTooShort: boolean;
	/** fallback / 技能名是否落在 noname 里。 */
	inNoName: boolean;
}

/** 一个技能在词表里可能的两个键（技能名 / 目录名，小写去空格）。 */
function keySetFor(skill: SkillRef): string[] {
	const dirName = skillDirName(skill.filePath);
	const keys = new Set<string>();
	for (const k of [(skill.name ?? "").trim().toLowerCase(), dirName.trim().toLowerCase()]) {
		if (k) keys.add(k);
	}
	return [...keys];
}

export function auditSkill(
	skill: SkillRef,
	triggers: TriggerMap,
	noName?: ReadonlySet<string>,
): SkillAudit {
	const dirName = skillDirName(skill.filePath);
	const display = skill.name || dirName;
	const fallback = dirName || skill.name || "";

	const keys = keySetFor(skill);
	// 关键：区分「压根没配」与「配了空表」。muted 只认后者——词表里确有这条键、但值是 []。
	const presentInMap = keys.some((key) => triggers[key] !== undefined);
	const configuredWords = keys.flatMap((key) => triggers[key] ?? []).filter(
		(word, i, arr) => arr.indexOf(word) === i,
	);
	const hasCurated = configuredWords.length > 0;
	const muted = presentInMap && !hasCurated;

	const effective = triggersForSkill(skill, triggers, noName);
	const hasNameFallback = fallback !== "" && effective.includes(fallback);
	const nameTooShort = fallback.length < MIN_FALLBACK_NAME_LENGTH;
	const inNoName =
		Boolean(fallback && noName?.has(fallback.trim().toLowerCase())) ||
		Boolean(skill.name && noName?.has(skill.name.trim().toLowerCase()));

	let tier: TriggerTier;
	if (muted) tier = "muted";
	else if (hasCurated) tier = "ok";
	else if (hasNameFallback) tier = "warn";
	else tier = "error";

	return {
		display,
		dirName,
		filePath: skill.filePath,
		tier,
		effective,
		configuredWords,
		hasNameFallback,
		muted,
		nameTooShort,
		inNoName,
	};
}

export function auditSkills(input: {
	skills: readonly SkillRef[];
	triggers: TriggerMap;
	noName?: ReadonlySet<string>;
}): SkillAudit[] {
	return input.skills.map((skill) => auditSkill(skill, input.triggers, input.noName));
}

/**
 * 反向检查：词表里配了、但没有任何已装技能对得上的 key（改名 / 笔误 / 技能删了词没删）。
 * 与 `appendCompanions` 的「配表笔误静默丢掉」是同一件事，只是挪到事前报出来。
 * `companion` / `noname` 是保留键、值不是数组，`normalizeTriggers` 根本不收它们，不会混进来。
 */
export function findOrphanTriggerKeys(input: {
	skills: readonly SkillRef[];
	triggers: TriggerMap;
}): string[] {
	const installed = new Set<string>();
	for (const skill of input.skills) {
		for (const key of keySetFor(skill)) installed.add(key);
	}
	return Object.keys(input.triggers)
		.filter((key) => !installed.has(key))
		.sort();
}

/** 一条「写了但永远不会生效」的伴随边。 */
export interface CompanionProblem {
	kind: "source" | "target" | "word";
	source: string;
	target?: string;
	word?: string;
}

/**
 * 伴随表的反向检查：三种「配了但永不生效」。
 *
 * 伴随边是手写的协同关系，失效时**没有任何运行时症状**——`appendCompanions` 一律静默丢掉
 * （纪律见 `lib/suggest.ts`：「配表笔误不能让提醒指空气」）。于是「配了但没生效」只能靠事前
 * 检查，与 `findOrphanTriggerKeys` 同一件事，只是搬到了伴随表上：
 * - `source`：源技能没装（改名 / 删了 / 笔误）——整条边永不触发；
 * - `target`：同伴技能没装——就算触发也查不到，被丢掉；
 * - `word`：`only` 里点名的词不在源技能的**有效触发集**里——那个词永远不会成为「命中词」，
 *   这条边永远不会被它放行（最容易犯：词表里改了一个词，伴随条件忘了跟着改）。
 *
 * 源没装时不再报 `word`：没有词能命中源，再报词只是把同一条错重复几遍。
 */
export function findCompanionProblems(input: {
	skills: readonly SkillRef[];
	triggers: TriggerMap;
	companion: CompanionMap;
	noName?: ReadonlySet<string>;
}): CompanionProblem[] {
	const byKey = new Map<string, SkillRef>();
	for (const skill of input.skills) {
		for (const key of keySetFor(skill)) if (!byKey.has(key)) byKey.set(key, skill);
	}
	const problems: CompanionProblem[] = [];
	for (const [source, edges] of Object.entries(input.companion)) {
		const skill = byKey.get(source);
		if (!skill) problems.push({ kind: "source", source });
		const effective = skill
			? new Set(triggersForSkill(skill, input.triggers, input.noName).map((word) => word.trim().toLowerCase()))
			: null;
		for (const edge of edges) {
			if (!byKey.has(edge.name.trim().toLowerCase())) problems.push({ kind: "target", source, target: edge.name });
			if (!effective) continue;
			for (const word of edge.only ?? []) {
				if (!effective.has(word.trim().toLowerCase())) problems.push({ kind: "word", source, target: edge.name, word });
			}
		}
	}
	return problems;
}

/** 片段表的一处配置问题。`unknown` 引用在运行时被静默丢掉，只有这里能看见。 */
export interface PresetProblem {
	kind: "unknown" | "empty" | "nested" | "unused";
	preset?: string;
	/** 引用出现的位置：词表键名，或 `companion.<源>.<同伴>`。 */
	where: string;
	/** 原始写法（含 `@`），`unknown` 用。 */
	ref?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/**
 * 片段表的反向检查：四种「写错或白写」。
 *
 * 片段的价值是「一处维护、两处生效」，失效却全程静默：`expandRefs` 丢掉未知引用、
 * 空片段展开成空表。于是只能事前检查，与 `findOrphanTriggerKeys` 同一件事：
 * - `unknown`：引用了不存在的片段名（改名 / 笔误）；
 * - `empty`：片段定义为空，引用它等于没加词；
 * - `nested`：片段里又写 `@其他`，**不会**被展开（只展开一层），那串字面词永远匹配不上；
 * - `unused`：定义了却没人引用，死配置。
 *
 * 吃的是原始 JSON（不是 normalize 后的表）：展开后引用已经变成词，看不出是谁引的谁。
 */
export function findPresetProblems(raw: unknown): PresetProblem[] {
	const root = asRecord(raw);
	const presets = asRecord(root.presets);
	const defined = new Set(Object.keys(presets).map((key) => key.trim().toLowerCase()));
	const used = new Set<string>();
	const problems: PresetProblem[] = [];

	const checkRefs = (words: unknown, where: string): void => {
		if (!Array.isArray(words)) return;
		for (const word of words) {
			if (typeof word !== "string" || !word.startsWith(PRESET_PREFIX)) continue;
			const name = word.slice(PRESET_PREFIX.length).trim().toLowerCase();
			if (!name || !defined.has(name)) {
				problems.push({ kind: "unknown", where, ref: word });
				continue;
			}
			used.add(name);
		}
	};

	for (const [key, value] of Object.entries(root)) {
		const name = key.trim().toLowerCase();
		if (name === "presets") continue;
		if (Array.isArray(value)) {
			checkRefs(value, key);
			continue;
		}
		if (name !== "companion") continue;
		// 数组写法是技能名列表，不认 `@`；只有对象写法的值是词。
		for (const [source, edges] of Object.entries(asRecord(value))) {
			for (const [target, words] of Object.entries(asRecord(edges))) {
				checkRefs(words, `companion.${source}.${target}`);
			}
		}
	}

	for (const [key, value] of Object.entries(presets)) {
		const name = key.trim().toLowerCase();
		const words = Array.isArray(value) ? value : [];
		if (words.length === 0) problems.push({ kind: "empty", preset: name, where: "presets" });
		else if (words.some((word) => typeof word === "string" && word.startsWith(PRESET_PREFIX)))
			problems.push({ kind: "nested", preset: name, where: "presets" });
	}
	for (const name of defined) {
		if (!used.has(name)) problems.push({ kind: "unused", preset: name, where: "presets" });
	}
	return problems;
}
