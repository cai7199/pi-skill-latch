// acp/nudge-filter.ts 对 ACP 文案的锚点防回归。
//
// 背景：nudge-filter 靠文本锚点（"HOW TO COMPRESS"、"[TIER " 等）识别 ACP 合成的压缩提醒，
// 因为 ACP 不给这类消息打标记。ACP 哪天改文案，滤网会**静默失灵**——日常提醒每轮复活
// （墙纸回归），或 tier 被误判。本测试把已安装 bundle 里的锚点逐一钉死：文案一改，先崩这里。
//
// 只有找得到 ACP 的 bundle 时才跑第一条（`PI_ACP_BUNDLE` 指向 dist/index.js，或本包所在目录
// 的 node_modules 里有它）；第二条不依赖 ACP，任何环境都会跑。
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

const ACP_NAME = "billion-context-pi";

/** 找 ACP 的 bundle：显式路径优先，再看工作目录与包目录下的 node_modules。 */
function locateBundle(): { bundle: string } | { reason: string } {
	const explicit = process.env.PI_ACP_BUNDLE;
	const candidates = [
		...(explicit ? [resolve(explicit)] : []),
		resolve(process.cwd(), "node_modules", ACP_NAME, "dist", "index.js"),
		resolve(import.meta.dirname ?? ".", "..", "node_modules", ACP_NAME, "dist", "index.js"),
		join(process.cwd(), "node_modules", ACP_NAME, "dist", "index.js"),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return { bundle: candidate };
	}
	return { reason: `未找到 ${ACP_NAME} 的 dist/index.js（可设 PI_ACP_BUNDLE 指定）` };
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
	{ text: "Compressed blocks: ", why: "提醒里已折块清单的固定措辞" },
];

test("nudge-filter 用到的锚点都在已装 ACP bundle 里", (t) => {
	const located = locateBundle();
	if ("reason" in located) {
		t.skip(located.reason);
		return;
	}
	const source = readFileSync(located.bundle, "utf8");
	for (const { text: anchor, why } of ANCHORS) {
		assert.ok(
			source.includes(anchor),
			`锚点 ${JSON.stringify(anchor)} 不在 ${ACP_NAME} 的 dist/index.js 里——${why}。` +
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
