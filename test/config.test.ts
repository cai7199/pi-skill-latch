// config.ts 的纯逻辑：路径解析、开关收窄、env 覆盖、保留键与词表共存。
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	DEFAULT_SETTINGS,
	agentDir,
	configFile,
	debugLogPath,
	loadConfig,
	normalizeSettings,
	parseConfig,
} from "../src/config.ts";

const AGENT = "C:\\agent";

test("agentDir：env 优先，空串按缺省", () => {
	assert.equal(agentDir({ PI_CODING_AGENT_DIR: AGENT }), AGENT);
	assert.match(agentDir({ PI_CODING_AGENT_DIR: "" }), /\.pi[\\/]agent$/);
	assert.match(agentDir({}), /\.pi[\\/]agent$/);
});

test("configFile：SKILL_LATCH_CONFIG 与旧名 SKILL_LATCH_SUGGEST_CONFIG 都认，缺省在 agent 目录", () => {
	assert.equal(configFile({ PI_CODING_AGENT_DIR: AGENT, SKILL_LATCH_CONFIG: "C:\\a.json" }), "C:\\a.json");
	assert.equal(configFile({ PI_CODING_AGENT_DIR: AGENT, SKILL_LATCH_SUGGEST_CONFIG: "C:\\b.json" }), "C:\\b.json");
	assert.equal(configFile({ PI_CODING_AGENT_DIR: AGENT }), "C:\\agent\\skill-latch.json");
});

test("debugLogPath 跟着 agent 目录走，不落在包内", () => {
	assert.equal(debugLogPath({ PI_CODING_AGENT_DIR: AGENT }), "C:\\agent\\skill-latch-debug.log");
});

test("normalizeSettings：缺省就是 DEFAULT_SETTINGS", () => {
	assert.deepEqual(normalizeSettings({}, {}), DEFAULT_SETTINGS);
	assert.deepEqual(normalizeSettings(undefined, {}), DEFAULT_SETTINGS);
	assert.deepEqual(normalizeSettings([], {}), DEFAULT_SETTINGS);
});

test("normalizeSettings：settings 保留键里的开关生效，坏值回落缺省", () => {
	const s = normalizeSettings(
		{ settings: { acp: false, nativeSkillList: true, searchTool: false, hints: false, debug: true } },
		{},
	);
	assert.deepEqual(s, { entry: "auto", acp: false, nativeSkillList: true, searchTool: false, hints: false, debug: true });

	// 字符串 "true"、数字 1 这类都不算——只认布尔，免得 "false" 被读成真
	const bad = normalizeSettings({ settings: { nativeSkillList: "true", searchTool: 1, hints: null } }, {});
	assert.equal(bad.nativeSkillList, false);
	assert.equal(bad.searchTool, true);
	assert.equal(bad.hints, true);
});

test('normalizeSettings：acp 只认 "auto" | true | false', () => {
	assert.equal(normalizeSettings({ settings: { acp: "auto" } }, {}).acp, "auto");
	assert.equal(normalizeSettings({ settings: { acp: true } }, {}).acp, true);
	assert.equal(normalizeSettings({ settings: { acp: false } }, {}).acp, false);
	assert.equal(normalizeSettings({ settings: { acp: "yes" } }, {}).acp, "auto");
});

test("normalizeSettings：env 覆盖高于文件，且只能往「开」的方向盖", () => {
	const file = { settings: { nativeSkillList: false, debug: false } };
	assert.equal(normalizeSettings(file, { SKILL_LATCH_NATIVE_SKILL_LIST: "1" }).nativeSkillList, true);
	assert.equal(normalizeSettings(file, { SKILL_LATCH_NATIVE_SKILL_LIST: "0" }).nativeSkillList, false);
	assert.equal(normalizeSettings(file, { SKILL_LATCH_DEBUG: "1" }).debug, true);
	assert.equal(normalizeSettings(file, {}).debug, false);
});

test("parseConfig：根表是词表，保留键各归各的", () => {
	const cfg = parseConfig({
		settings: { hints: false },
		presets: { docs: ["论文"] },
		"my-skill": ["@docs", "simulation"],
		companion: { "my-skill": { "other-skill": ["论文"] } },
		noname: { writing: true, other: false },
	});
	assert.deepEqual(cfg.triggers["my-skill"], ["论文", "simulation"], "@片段 在解析期展开");
	assert.equal(cfg.triggers.settings, undefined, "settings 是对象，不该混进词表");
	assert.equal(cfg.triggers.presets, undefined);
	assert.deepEqual(cfg.companion["my-skill"], [{ name: "other-skill", only: ["论文"] }]);
	assert.deepEqual([...cfg.noName], ["writing"]);
	assert.equal(cfg.settings.hints, false);
});

test("loadConfig：缺文件回落空表 + 缺省开关，不抛错", () => {
	const cfg = loadConfig("C:\\definitely\\missing\\skill-latch.json", {});
	assert.deepEqual(cfg.triggers, {});
	assert.deepEqual(cfg.companion, {});
	assert.equal(cfg.noName.size, 0);
	assert.deepEqual(cfg.settings, DEFAULT_SETTINGS);
});
