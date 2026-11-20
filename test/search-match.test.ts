// lib/search-match.ts：切词、枚举意图归一、关键词检索的排序与命中面。
import assert from "node:assert/strict";
import { test } from "node:test";

import { isEnumerationQuery, searchSkills, tokenizeQuery } from "../src/lib/search-match.ts";
import type { SkillRef } from "../src/lib/suggest.ts";

const skill = (name: string, description?: string): SkillRef => ({
	name,
	description,
	filePath: `C:\\skills\\${name}\\SKILL.md`,
});

const SKILLS: SkillRef[] = [
	skill("spectre", "Run SPICE simulations and sweeps for analog circuits."),
	skill("office-docx", "Create Word documents with proper styles and three-line tables."),
	skill("netlist", "Inspect and rewrite netlists."),
];

test("tokenizeQuery：按空白切、小写、去重", () => {
	assert.deepEqual(tokenizeQuery("  Word   word  DOCX "), ["word", "docx"]);
	assert.deepEqual(tokenizeQuery(""), []);
});

test("isEnumerationQuery：整条 query 都是枚举词才算，混进真词就照常搜", () => {
	assert.equal(isEnumerationQuery(tokenizeQuery("all")), true);
	assert.equal(isEnumerationQuery(tokenizeQuery("全部 技能")), true);
	assert.equal(isEnumerationQuery(tokenizeQuery("all spectre")), false);
	assert.equal(isEnumerationQuery([]), false, "空 query 不是枚举意图（调用方自己分支）");
});

test("检索命中面：名字、description、以及词表触发词", () => {
	const triggers = { spectre: ["仿真"] };
	const byName = searchSkills({ query: "netlist", skills: SKILLS, triggers });
	assert.equal(byName.length, 1);
	assert.equal(byName[0].name, "netlist");

	const byDescription = searchSkills({ query: "spice", skills: SKILLS, triggers });
	assert.equal(byDescription.length, 1);
	assert.equal(byDescription[0].name, "spectre");

	const byTrigger = searchSkills({ query: "仿真", skills: SKILLS, triggers });
	assert.equal(byTrigger.length, 1);
	assert.equal(byTrigger[0].name, "spectre", "中文查询靠词表触发词，description 是英文");
});

test("检索：命中词多的排前面，且同分保持清单原序（结果可复现）", () => {
	const hits = searchSkills({ query: "word netlist", skills: SKILLS, triggers: {} });
	assert.deepEqual(hits.map((h) => h.name), ["office-docx", "netlist"]);

	// 同分时按清单顺序，不按命中词
	const tie = searchSkills({ query: "netlist office", skills: SKILLS, triggers: {} });
	assert.deepEqual(tie.map((h) => h.name), ["office-docx", "netlist"]);
});

test("检索：ASCII 词落在词边界上（spec 不命中 spectre）", () => {
	assert.deepEqual(searchSkills({ query: "spec", skills: SKILLS, triggers: {} }), []);
	assert.equal(searchSkills({ query: "spectre", skills: SKILLS, triggers: {} }).length, 1);
});

test("检索：空 query 返回空（全表意图归调用方处理）", () => {
	assert.deepEqual(searchSkills({ query: "   ", skills: SKILLS, triggers: {} }), []);
});

test("检索：`noname` 关掉的技能照样搜得到（那个开关只管自动提醒）", () => {
	// searchSkills 根本不收 noName——这条测试钉住「不要为了统一而把它传进去」这个决定
	const hits = searchSkills({ query: "spectre", skills: SKILLS, triggers: {} });
	assert.equal(hits[0].name, "spectre");
	assert.equal(hits[0].matched.length, 1);
});
