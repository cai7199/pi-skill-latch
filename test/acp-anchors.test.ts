// acp/nudge-filter.ts 对 ACP 文案的锚点防回归。
//
// 背景：nudge-filter 靠文本锚点（"HOW TO COMPRESS"、"[TIER " 等）识别 ACP 合成的压缩提醒，
// 因为 ACP 不给这类消息打标记。ACP 哪天改文案，滤网会**静默失灵**——日常提醒每轮复活
// （墙纸回归），或 tier 被误判。本测试把已安装 bundle 里的锚点逐一钉死：文案一改，先崩这里。
//
// 只有找得到 ACP 的 bundle 时才跑第一条（`PI_ACP_BUNDLE` 指向 bundle，或本包所在目录的
// node_modules 里有它）；第二条不依赖 ACP，任何环境都会跑。
//
// 上游从 `billion-context-pi`（dist/index.js）换成了 `billion-context`（dist/agent/pi-native.js）。
// 新包的 nudge 在本地代理层注入，Pi 的 `context_with_system` 看不到；这里的锚点测试仍保留，
// 一是旧版兼容，二是万一上游把 nudge 放回钩子时能第一时间发现文案漂移。
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
	dropRoutineNudges,
	isAcpEmergencyMessage,
	isAcpNudgeMessage,
	isAcpTierNudge,
} from "../src/acp/nudge-filter.ts";

const ACP_NAMES = ["billion-context", "billion-context-pi"] as const;
const BUNDLE_PATHS = [
	["dist", "agent", "pi-native.js"],
	["dist", "index.js"],
] as const;

/** 找 ACP 的 bundle：显式路径优先，再看工作目录与包目录下的 node_modules。 */
function locateBundle(): { bundle: string } | { reason: string } {
	const explicit = process.env.PI_ACP_BUNDLE;
	if (explicit) {
		const path = resolve(explicit);
		if (existsSync(path)) return { bundle: path };
	}
	const roots = [process.cwd(), resolve(import.meta.dirname ?? ".", "..")];
	for (const root of roots) {
		for (const name of ACP_NAMES) {
			for (const parts of BUNDLE_PATHS) {
				const candidate = join(root, "node_modules", name, ...parts);
				if (existsSync(candidate)) return { bundle: candidate };
			}
		}
	}
	return { reason: `未找到 billion-context 的 bundle（可设 PI_ACP_BUNDLE 指定）` };
}

/**
 * nudge-filter.ts 用到的全部锚点（与 `src/acp/nudge-filter.ts` 的常量一一对应；那边没有导出，
 * 所以镜像一份，改锚点要两边同改——这正是本测试要防的漂移面）。
 */
const ANCHORS = [
	{ text: "This is an efficiency nudge", why: "日常（温和）语音的唯一判据：丢了它，dropRoutineNudges 认不出日常提醒，45% 起每轮的墙纸复活" },
	{ text: "Context limit reached", why: "紧急语音判据（ACP 软上限 75% 起切换文案）" },
	{ text: "[EMERGENCY", why: "紧急 tier 变体的判据（[EMERGENCY — TIER n …]）" },
	{ text: "[TIER ", why: "非紧急 tier 提醒（蒸馏/冷凝）的判据：它带具体指引，必须留下" },
	{ text: "HOW TO COMPRESS", why: "三类提醒共用的规则块标题——认出「这是 ACP 提醒」的公共锚点" },
	{ text: "Compressed blocks: ", why: "旧版提醒里已折块清单的固定措辞", optional: true },
	{ text: "Active blocks (", why: "新版提醒里已折块清单的固定措辞", optional: true },
];

test("nudge-filter 的必需锚点都在已装 ACP bundle 里", (t) => {
	const located = locateBundle();
	if ("reason" in located) {
		t.skip(located.reason);
		return;
	}
	const source = readFileSync(located.bundle, "utf8");
	for (const { text: anchor, why, optional } of ANCHORS) {
		if (optional && !source.includes(anchor)) continue;
		assert.ok(
			source.includes(anchor),
			`锚点 ${JSON.stringify(anchor)} 不在 ${located.bundle} 里——${why}。` +
				`文案若已改，同步更新 src/acp/nudge-filter.ts 的常量、本表与 test/nudge-filter 里的手写样本。`,
		);
	}
});

test("三语分流在锚点拼出的样本上仍成立", () => {
	const mk = (value: string) => ({ role: "user", content: [{ type: "text", text: value }] });

	// 用与 bundle 验证过的锚点拼三类语音（不是手写样本）：锚点一变，上一条测试先崩。
	const gentle = mk("This is an efficiency nudge to compress early.\n\nHOW TO COMPRESS\n…");
	const tier = mk("[TIER 2 DISTILLATION TRIGGER]\n\nCompressed blocks: b1, b2\n\nHOW TO COMPRESS\n…");
	const emergency = mk("⚠️ Context limit reached — compress now.\n\nHOW TO COMPRESS\n…");
	const real = { role: "user", content: "帮我看看上下文" };

	assert.equal(isAcpNudgeMessage(gentle), true, "温和认得");
	assert.equal(isAcpNudgeMessage(tier), true);
	assert.equal(isAcpNudgeMessage(emergency), true);
	assert.equal(isAcpNudgeMessage(real), false, "真实消息不误伤");
	assert.equal(isAcpEmergencyMessage(gentle), false, "温和不是紧急");
	assert.equal(isAcpEmergencyMessage(emergency), true);
	assert.equal(isAcpEmergencyMessage(tier), false, "非紧急 tier 不带火警锚点");
	assert.equal(isAcpTierNudge(tier), true);

	const kept = dropRoutineNudges([real, gentle, tier, emergency]);
	assert.equal(kept?.length, 3, "只丢日常");
	assert.equal(kept?.[0], real);
	assert.equal(dropRoutineNudges([real, tier, emergency]), null, "没得丢返回 null（保住缓存前缀）");
});
