import { test } from "node:test";
import assert from "node:assert/strict";

import {
	auditSkill,
	auditSkills,
	findCompanionProblems,
	findOrphanTriggerKeys,
	findPresetProblems,
	type SkillAudit,
} from "../src/lib/trigger-audit.ts";
import { normalizeCompanion, normalizeNoName, normalizeTriggers, type SkillRef, type TriggerMap } from "../src/lib/suggest.ts";

/**
 * trigger-audit 契约回归：锁死「按需通道会不会失明」的四档归类，钉的是语义不是文案。
 *
 * 关键防回归点：
 * - 判据必须看**有效触发集**（配的词 ∪ 名字兜底），不是「词表里有没有这一条」；
 *   否则靠长名字兜底的技能（spectre / netlist）会被误报成漏配。
 * - 名字<5 或在 noname 里、又没配词 → 有效集为空 → ERROR（hint 通道够不着）。
 * - 词表里显式 `[]` 是**故意静音**，单独一档，不当漏。
 */

const p = (name: string): string => `C:\\skills\\${name}\\SKILL.md`;
/** 造一个技能。name 缺省取目录名（真实清单里两者一致）。 */
function skill(name: string, filePath = p(name)): SkillRef {
	return { name, filePath };
}

const TRIGGERS = normalizeTriggers({
	spectre: ["spectre", "spice", "仿真"],
	"office-docx": ["word"],
	writing: ["写文章", "论文"],
	ghost: ["幽灵技能"],
	"muted-skill": [],
	ls: [],
});
const NONAME = normalizeNoName({ noname: { writing: true } });

test("ERROR：名字太短（<5）且没配词 → 有效集为空，hint 通道够不着", () => {
	const a = auditSkill(skill("ls"), TRIGGERS, NONAME);
	// ls 在词表里配了 `[]`（空表），所以走静音档而不是 error；这里专门造一个「没配 + 短名」的。
	const fresh = auditSkill(skill("ab"), normalizeTriggers({}), NONAME);
	assert.equal(fresh.tier, "error", "短名无词 → error");
	assert.deepEqual(fresh.effective, [], "有效触发集为空");
	assert.equal(fresh.hasNameFallback, false, "名字兜底不活");
	assert.equal(a.tier, "muted", "同样短名但显式配了空表 → 静音，不当漏");
});

test("ERROR：名字在 noname 里且没配词 → 名字兜底被关，有效集为空", () => {
	// virtuoso 名字够长，但塞进 noname 关掉名字兜底，又不配词。
	const a = auditSkill(skill("virtuoso"), normalizeTriggers({}), normalizeNoName({ noname: { virtuoso: true } }));
	assert.equal(a.tier, "error", "noname 且无词 → error");
	assert.equal(a.inNoName, true);
	assert.deepEqual(a.effective, []);
});

test("WARN：名字够长、没配词，靠名字兜底活着", () => {
	const a = auditSkill(skill("spectre"), normalizeTriggers({}), NONAME);
	assert.equal(a.tier, "warn", "只有名字兜底");
	assert.deepEqual(a.effective, ["spectre"], "有效集就一个内部名");
	assert.equal(a.hasNameFallback, true);
	assert.deepEqual(a.configuredWords, [], "没有手写词");
});

test("OK：配了手写词（即便名字在 noname 里，curated 仍然活着）", () => {
	// writing 在 noname 里关掉了名字兜底，但词表配了词 → OK，名字兜底那半被关不影响 curated。
	const a = auditSkill(skill("writing"), TRIGGERS, NONAME);
	assert.equal(a.tier, "ok");
	assert.equal(a.hasNameFallback, false, "noname 关掉了名字兜底");
	assert.deepEqual(a.configuredWords, ["写文章", "论文"]);
});

test("OK：配了词 + 名字兜底并存（并集）", () => {
	const a = auditSkill(skill("spectre"), TRIGGERS, NONAME);
	assert.equal(a.tier, "ok");
	// effective = 配的词 ∪ 名字兜底，去重（spectre 既在词表里也作为名字兜底）。
	assert.deepEqual(a.effective, ["spectre", "spice", "仿真"]);
});

test("MUTED：词表里显式配了空表 [] → 单独一档，不当漏", () => {
	const a = auditSkill(skill("muted-skill"), TRIGGERS, NONAME);
	assert.equal(a.tier, "muted");
	assert.equal(a.muted, true);
	assert.deepEqual(a.effective, [], "空表让有效集也空了");
});

test("auditSkills：批量归类，按输入顺序返回", () => {
	const skills = [skill("spectre"), skill("writing"), skill("ab")];
	const tiers = auditSkills({ skills, triggers: TRIGGERS, noName: NONAME }).map((a) => a.tier);
	assert.deepEqual(tiers, ["ok", "ok", "error"]);
});

test("孤儿 key：词表配了、但没有对应已装技能", () => {
	// 用自包含的小词表，避免被共享 TRIGGERS 里的 muted-skill / ls 污染预期。
	const t = normalizeTriggers({ ghost: ["x"], spectre: ["spectre"] });
	assert.deepEqual(findOrphanTriggerKeys({ skills: [skill("spectre")], triggers: t }), ["ghost"], "ghost 在词表里但没这个技能");
	// 全部对得上就没有孤儿。
	assert.deepEqual(findOrphanTriggerKeys({ skills: [skill("ghost"), skill("spectre")], triggers: t }), [], "配得全就不报");
});

test("孤儿检查不认 companion / noname 保留键（它们不是数组，normalizeTriggers 早丢掉了）", () => {
	const t = normalizeTriggers({ paper: ["论文"], companion: { paper: ["office-docx"] }, noname: { writing: true } });
	assert.deepEqual(Object.keys(t), ["paper"], "只有数组值的键进词表");
});

// 类型占位：确保 SkillAudit 的字段稳定，字段名变了这条就挂。
test("SkillAudit 字段齐全", () => {
	const a: SkillAudit = auditSkill(skill("spectre"), TRIGGERS, NONAME);
	const fields = [
		"display",
		"dirName",
		"filePath",
		"tier",
		"effective",
		"configuredWords",
		"hasNameFallback",
		"muted",
		"nameTooShort",
		"inNoName",
	];
	assert.equal(Object.keys(a).length, fields.length, "不多不少");
	for (const f of fields) assert.ok(f in a, `field ${f} 缺失`);
});

test("伴随孤儿：源没装 / 同伴没装，各报一条", () => {
	// 伴随边失效时运行时没有任何症状（`appendCompanions` 一律静默丢掉），只能事前报。
	const skills = [skill("writing"), skill("office-docx")];
	const triggers = normalizeTriggers({ writing: ["论文"], "office-docx": ["word"] });
	const companion = normalizeCompanion({
		companion: {
			writing: { "office-docx": ["论文"], "ghost-skill": ["论文"] },
			"ghost-source": ["office-docx"],
		},
	});
	const got = findCompanionProblems({ skills, triggers, companion }).map(
		(p) => `${p.kind}:${p.source}${p.target ? `→${p.target}` : ""}`,
	);
	assert.deepEqual(got, ["target:writing→ghost-skill", "source:ghost-source"], "词都在有效集里，不报词");
});

test("伴随孤儿：条件词不在源技能的有效触发集里 → 这条边永远不会被它放行", () => {
	// 最常见的错法：词表里改了一个词，伴随条件忘了跟着改。运行时表现为「配了却不生效」。
	const skills = [skill("writing"), skill("office-docx")];
	const triggers = normalizeTriggers({ writing: ["论文"], "office-docx": ["word"] });
	const companion = normalizeCompanion({ companion: { writing: { "office-docx": ["作文"] } } });
	assert.deepEqual(findCompanionProblems({ skills, triggers, companion }), [
		{ kind: "word", source: "writing", target: "office-docx", word: "作文" },
	]);
});

test("伴随孤儿：判据是有效集，名字兜底也算——被 noname 关了就不算", () => {
	const skills = [skill("writing"), skill("office-docx")];
	const companion = normalizeCompanion({ companion: { writing: { "office-docx": ["writing"] } } });
	const noTriggers = normalizeTriggers({});
	assert.deepEqual(
		findCompanionProblems({ skills, triggers: noTriggers, companion }),
		[],
		"名字兜底活着 → `writing` 是有效词",
	);
	assert.deepEqual(
		findCompanionProblems({ skills, triggers: noTriggers, companion, noName: normalizeNoName({ noname: { writing: true } }) }),
		[{ kind: "word", source: "writing", target: "office-docx", word: "writing" }],
		"noname 关掉了名字 → 那个词不存在了，条件落在空气上",
	);
});

test("片段检查：未知引用 / 空片段 / 嵌套 / 没人用，各报一条", () => {
	// 片段失效全程静默（未知引用被丢、空片段展开成空表），只能事前报。
	const raw = {
		presets: {
			"doc-work": ["论文"],
			empty: [],
			loop: ["@doc-work"],
			dead: ["没人引用"],
		},
		writing: ["润色", "@doc-work", "@nope", "@empty", "@loop"],
		companion: { writing: { "office-docx": ["@doc-work", "@ghost"] } },
	};
	const got = findPresetProblems(raw)
		.map((p) => `${p.kind}:${p.preset ?? p.ref}`)
		.sort();
	assert.deepEqual(got, ["empty:empty", "nested:loop", "unknown:@ghost", "unknown:@nope", "unused:dead"]);
	// 数组写法的伴随值是技能名，`@` 不是引用：不报未知，也不把组算成「被用过」。
	assert.deepEqual(findPresetProblems({ companion: { a: ["@g"] } }), []);
});
