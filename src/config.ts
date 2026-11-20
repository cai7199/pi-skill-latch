/**
 * config.ts — 配置文件在哪、有哪些开关、缺省怎么回落（不 import pi、不读盘到模块级，便于单测）。
 *
 * ## 为什么默认路径在 agent 目录，而不是包内
 * 包会被升级/替换：把词表放在包内，用户配的那份在升级时一起没了；装在 `node_modules` 时还
 * 常常只读。词表是用户的东西，必须和安装位置解耦。默认读 `<agentDir>/skill-latch.json`，
 * `agentDir` 的取法与 pi 一致（`PI_CODING_AGENT_DIR`，缺省 `~/.pi/agent`）。
 *
 * ## 开关为什么放在保留键 `settings` 里
 * 根表的键默认就是「技能名 → 触发词」，开关放在根上会和技能名抢键（一个叫 `acp` 的技能
 * 会被开关吃掉，或者反过来）。`settings` 的值是对象，而 `normalizeTriggers` 只认数组值、
 * 见对象即丢——两个 loader 各取各的，与 `presets` / `companion` / `noname` 同一套办法。
 *
 * ## env 覆盖为什么留着
 * 早先版本的三个环境变量继续有效，名字不改：`SKILL_LATCH_SUGGEST_CONFIG`（配置路径）、
 * `SKILL_LATCH_NATIVE_SKILL_LIST=1`（保留原生清单）、`SKILL_LATCH_DEBUG=1`（写定位日志）。
 * 旧配置与临时排查不该因为改名而失效。新名字 `SKILL_LATCH_CONFIG` 同时认。
 */
import { homedir } from "node:os";
import { join } from "node:path";

import { loadJsonConfig } from "./lib/json-config.ts";
import { normalizeCompanion, normalizeNoName, normalizeTriggers, type CompanionMap, type TriggerMap } from "./lib/suggest.ts";
import type { EntryPreference } from "./entry-gate.ts";

type Env = Record<string, string | undefined>;

/** 配置文件的开关面。改这里要同时改 README 的配置表与 `skill-suggest.example.json`。 */
export interface LatchSettings {
	/**
	 * 哪一份实现跑：`"auto"`（缺省，先加载者占位）/ `"local"` / `"generic"`。
	 * 只有同一台机器上同时装了两份实现（本机特化版 + 本包）时才有意义，见 `entry-gate.ts`。
	 */
	entry: EntryPreference;
	/**
	 * 边界提示（ACP 可选增强）：
	 * - `"auto"`（缺省）——上下文里真的出现过 ACP 的 ref 标签才启用；
	 * - `true`——强制启用；
	 * - `false`——强制关闭，本包退化为纯「按需技能通道」。
	 */
	acp: "auto" | boolean;
	/** true = 保留 pi 原生的常驻 `<available_skills>`（逃生口），缺省 false = 摘掉。 */
	nativeSkillList: boolean;
	/** false = 不注册 `search_skills` 工具。 */
	searchTool: boolean;
	/** false = 不注入 `<skill-hint>` 提醒（也不再注册那条常驻规则）。 */
	hints: boolean;
	/** true = 每轮把边界定位现场写到 `<agentDir>/skill-latch-debug.log`。 */
	debug: boolean;
}

export const DEFAULT_SETTINGS: LatchSettings = {
	entry: "auto",
	acp: "auto",
	nativeSkillList: false,
	searchTool: true,
	hints: true,
	debug: false,
};

/** pi 的 agent 目录：`PI_CODING_AGENT_DIR` 优先，空串按缺省处理。 */
export function agentDir(env: Env = process.env): string {
	const dir = env.PI_CODING_AGENT_DIR;
	return dir && dir.length > 0 ? dir : join(homedir(), ".pi", "agent");
}

/** 配置文件路径：env 覆盖优先，缺省 `<agentDir>/skill-latch.json`。 */
export function configFile(env: Env = process.env): string {
	const override = env.SKILL_LATCH_CONFIG || env.SKILL_LATCH_SUGGEST_CONFIG;
	return override && override.length > 0 ? override : join(agentDir(env), "skill-latch.json");
}

/** 诊断日志路径：跟着 agent 目录走，不写进包目录（包可能只读，升级时也会被替换）。 */
export function debugLogPath(env: Env = process.env): string {
	return join(agentDir(env), "skill-latch-debug.log");
}

/** 布尔来源收窄：JSON 里只认 true/false，env 里只认 `"1"`；其余一律回落 fallback。 */
function readBool(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function readAcp(value: unknown): "auto" | boolean {
	if (typeof value === "boolean") return value;
	return value === "auto" ? "auto" : DEFAULT_SETTINGS.acp;
}

function readEntry(value: unknown): EntryPreference {
	return value === "local" || value === "generic" ? value : "auto";
}

/**
 * 把配置根对象里的 `settings` 保留键收窄成开关面，再叠 env 覆盖。
 *
 * env 覆盖高于文件：排查问题时不该先改文件（改完忘了改回来是更常见的故障）。
 */
export function normalizeSettings(raw: unknown, env: Env = process.env): LatchSettings {
	const root = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
	const block =
		typeof root.settings === "object" && root.settings !== null && !Array.isArray(root.settings)
			? (root.settings as Record<string, unknown>)
			: {};
	return {
		entry: readEntry(block.entry),
		acp: readAcp(block.acp),
		nativeSkillList: env.SKILL_LATCH_NATIVE_SKILL_LIST === "1" || readBool(block.nativeSkillList, DEFAULT_SETTINGS.nativeSkillList),
		searchTool: readBool(block.searchTool, DEFAULT_SETTINGS.searchTool),
		hints: readBool(block.hints, DEFAULT_SETTINGS.hints),
		debug: env.SKILL_LATCH_DEBUG === "1" || readBool(block.debug, DEFAULT_SETTINGS.debug),
	};
}

/** 一份配置的全部内容：开关 + 三张表（词表 / 伴随 / 名字黑名单）。 */
export interface LatchConfig {
	settings: LatchSettings;
	triggers: TriggerMap;
	companion: CompanionMap;
	noName: ReadonlySet<string>;
}

/**
 * 从原始 JSON 收窄出一份配置。四份 loader 各读各的保留键，互不干扰；
 * 坏一条不毁整表（`normalizeTriggers` 等内部的纪律）。
 */
export function parseConfig(raw: unknown, env: Env = process.env): LatchConfig {
	return {
		settings: normalizeSettings(raw, env),
		triggers: normalizeTriggers(raw),
		companion: normalizeCompanion(raw),
		noName: normalizeNoName(raw),
	};
}

/**
 * 读配置：缺文件 / 坏 JSON 一律回落到空表 + 缺省开关。
 *
 * 空表是**安全**的：没有词表就没有 `<skill-hint>`，不会替用户造误报；`search_skills` 仍然
 * 按名字与 description 检索，所以「没配词」不等于「功能没了」。
 */
export function loadConfig(file: string = configFile(), env: Env = process.env): LatchConfig {
	return loadJsonConfig(file, parseConfig(undefined, env), (raw) => parseConfig(raw, env));
}
