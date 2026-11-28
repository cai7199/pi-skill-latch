import { test } from "node:test";
import assert from "node:assert/strict";

import { boundaryNotice } from "../src/acp/boundary-note.ts";
import { FINGERPRINT_CHARS, SkillLatch, fingerprintOf, skillNameFromPath } from "../src/lib/latch.ts";
import { appendNudgeNote, dropRoutineNudges, isAcpEmergencyMessage, isAcpNudgeMessage, isAcpTierNudge } from "../src/acp/nudge-filter.ts";
import { nextPendingText } from "../src/lib/pending-text.ts";
import { atRiskFoldNote, foldedBodyNote } from "../src/acp/reread-note.ts";
import { acpRefOf, formatRef, parseRefNumber } from "../src/acp/ref-scan.ts";
import { buildHintText, carriedSuggestions, carryNote, HINT_LEAD, latchedNote, matchesTrigger, MAX_HINT_ENTRIES, normalizeCompanion, normalizePresets, normalizeTriggers, suggestSkills } from "../src/lib/suggest.ts";

/**
 * skill-latch 契约回归：锁死「边界号码 + 释放」这套语义，而不是具体的文案或实现细节。
 *
 * 为什么这些点值得钉住：
 * - 路径判据放宽一次，别处叫 SKILL.md 的文档就会被当技能钉住，提示行无故出现；
 * - 边界算错了方向，要么技能正文被压掉（提示形同虚设），要么怎么压都压不动；
 * - 释放结果要说清「谁还钉着、停在哪」——模型据此定下一次压缩的终点。
 */

/** 造一条假技能正文，长度足够走完指纹截断。 */
function body(tag: string, repeat = 40): string {
	return `# ${tag}\n\n${"正文 ".repeat(repeat)}`;
}

test("触发词：星号只放宽右边界，中文仍按出现算", () => {
	// 英文默认要整词——这是 `ppt` 不匹上 `pptx` 的原因。
	assert.equal(matchesTrigger("打开 ppt 看看", "ppt"), true);
	assert.equal(matchesTrigger("用 pptx 打开", "ppt"), false, "ppt 不该匹上 pptx");
	assert.equal(matchesTrigger("这些 guidelines", "guideline"), false, "默认不认复数");
	// 星号：只松开「后面能不能接字母」，前面照旧。
	assert.equal(matchesTrigger("这些 guidelines", "guideline*"), true, "星号认复数");
	assert.equal(matchesTrigger("xguideline", "guideline*"), false, "星号不该顺手放过左边界");
	assert.equal(matchesTrigger("wordpress", "word*"), true, "代价：星号不假装有右词边界");
	// 中文没有词边界，出现就算——多字触发词于是要求整段出现。
	assert.equal(matchesTrigger("标点符号的问题", "符号"), true, "中文子串命中");
	assert.equal(matchesTrigger("标点符号的问题", "符号编辑器"), false, "多字中文没整段出现就不算");
});

test("片段：`@名` 在词表与 only 里展开，只展开一层，未定义引用丢掉", () => {
	// 片段表从同一份 raw 里取，不做成第二个参数：传漏了会让 `@片段` 静默变空词。
	const raw = { presets: { "doc-work": ["论文", "写报告"], loop: ["@doc-work"], empty: [] } };
	assert.deepEqual(normalizePresets(raw), { "doc-work": ["论文", "写报告"], loop: ["@doc-work"], empty: [] });
	assert.deepEqual(
		normalizeTriggers({ ...raw, writing: ["润色", "@doc-work", "@nope"] }).writing,
		["润色", "论文", "写报告"],
		"词表里的引用摊平成词；未知引用丢掉；同词去重",
	);
	assert.deepEqual(
		normalizeCompanion({ ...raw, companion: { writing: { "office-docx": ["@doc-work"] } } }).writing,
		[{ name: "office-docx", only: ["论文", "写报告"] }],
		"only 走同一套展开",
	);
	assert.deepEqual(normalizeTriggers({ ...raw, a: ["@loop"] }).a, ["@doc-work"], "只展开一层：片段里的 @ 当字面词");
	assert.deepEqual(normalizeTriggers({ ...raw, quiet: ["@empty"] }).quiet, [], "空片段展开成空表——落进静音语义");
	assert.deepEqual(
		normalizeCompanion({ ...raw, companion: { writing: { "office-docx": ["@empty"] } } }),
		{},
		"only 展开成空 → 整条边被丢（与 `{ x: [] }` 同义）",
	);
});

test("路径判据：只认 .../skills/<name>/SKILL.md 这一个形状", () => {	assert.equal(skillNameFromPath("C:/skills/spectre/SKILL.md"), "spectre");
	assert.equal(skillNameFromPath("/home/u/.pi/skills/paper/SKILL.md"), "paper");
	assert.equal(skillNameFromPath("skills\\spectre\\SKILL.md"), "spectre", "反斜杠同样认");
	assert.equal(skillNameFromPath("E:/x/skills/a/b/SKILL.md"), "b", "取紧邻的目录名");
	// 防回归：仓里别处也有叫 SKILL.md 的文件，漏了 skills 段的判断会把它当技能钉住。
	assert.equal(skillNameFromPath("E:/x/SKILL.md"), null, "没有 skills 段不算");
	assert.equal(skillNameFromPath("E:/x/skills/SKILL.md"), null, "直接摆在技能根下不算某个技能");
	assert.equal(skillNameFromPath("E:/x/skills/spectre/README.md"), null, "文件名必须是 SKILL.md");
	assert.equal(skillNameFromPath(""), null);
});

test("指纹：折叠空白后取开头一段，够稳也够短", () => {
	const text = "# 仿真\n\n\n  用   spectre  跑  ";
	assert.equal(fingerprintOf(text), "# 仿真 用 spectre 跑", "连续空白折成一个空格");
	assert.equal(fingerprintOf("   \n\t "), "", "全空白折成空串");
	const long = "a".repeat(FINGERPRINT_CHARS + 50);
	assert.equal(fingerprintOf(long).length, FINGERPRINT_CHARS, "截到固定长度");
	// 防回归：指纹必须由正文内容决定，读到哪里不影响——ACP 重新拼装消息也不该让它失配。
	assert.equal(fingerprintOf("# 头\n\n中间\n\n尾"), fingerprintOf("# 头\n\n中间\n\n尾"));
});

test("登记表：钉住时边界未知，定位后取最早的那条", () => {
	const latch = new SkillLatch();
	assert.equal(latch.latch("spectre", body("spectre")), true, "首次钉住");
	assert.equal(latch.latch("spectre", body("spectre")), false, "重读不重复钉");
	assert.equal(latch.size(), 1);
	assert.equal(latch.list()[0].boundary, null, "还没定位 → 没有号码可报");
	assert.deepEqual(latch.unresolved(), ["spectre"], "未定位的要能报出来");

	latch.setBoundary("spectre", 99);
	assert.equal(latch.list()[0].boundary, 99);
	assert.deepEqual(latch.unresolved(), []);

	latch.latch("paper", body("paper"));
	latch.setBoundary("paper", 119);
	assert.deepEqual(
		latch.list().map((entry) => [entry.name, entry.boundary]),
		[
			["spectre", 99],
			["paper", 119],
		],
		"各报各的，快照按边界升序",
	);

	latch.setBoundary("spectre", 130);
	assert.equal(latch.list()[0].boundary, 99, "已有更早边界时不被推后（保守取小）");

	assert.equal(new SkillLatch().latch("empty", "   \n "), false, "空正文不钉：没内容可保护");
});

test("登记表记住工具调用 id：重读指向最新那份，边界仍不往后拖", () => {
	const latch = new SkillLatch();
	latch.latch("a", body("a"), "call-1");
	assert.equal(latch.list()[0].toolCallId, "call-1");
	latch.setBoundary("a", 42);

	// 重读：id 换成新的，但边界保留——旧正文可能还在上下文里，放宽等于开口子。
	latch.latch("a", body("a"), "call-2");
	assert.equal(latch.list()[0].toolCallId, "call-2");
	assert.equal(latch.list()[0].boundary, 42, "重读不重置已定位的边界");
});

test("撤销钉住：只对已定位过的生效，未定位的保留（宁可留着也别拆保护）", () => {
	const latch = new SkillLatch();
	latch.latch("located", body("located"));
	latch.setBoundary("located", 50);
	latch.latch("unlocated", body("unlocated"));

	assert.equal(latch.forget("located"), true, "正文已折走 → 撤销");
	assert.equal(latch.size(), 1);
	// 防回归：指纹没对上就撤销，等于读的是片段时把保护拆了——那种情况必须继续保留。
	assert.equal(latch.forget("unlocated"), false, "从没定位到的不撤销");
	assert.equal(latch.size(), 1);
});

test("ref 编号：读得进、拼得回", () => {
	assert.equal(parseRefNumber("m00099"), 99);
	assert.equal(parseRefNumber("m00100"), 100);
	assert.equal(parseRefNumber(" M00100 "), 100, "容忍空白与大小写");
	assert.equal(parseRefNumber("m0"), null, "0 不是合法 ref");
	assert.equal(parseRefNumber("100"), null);
	assert.equal(parseRefNumber("m123456"), null, "位数不对不认");
	assert.equal(parseRefNumber(100), null, "只认字符串");
	assert.equal(formatRef(99), "m00099");
	assert.equal(formatRef(1234), "m01234", "补零到五位");
});

test("提示行：各报各的号，不拦任何调用", () => {
	const mk = (name: string, boundary: number | null) => ({ name, boundary, fingerprint: fingerprintOf(body(name)) });

	assert.equal(boundaryNotice([]), "", "没钉住就不注入");

	const one = boundaryNotice([mk("paper", 99)]);
	assert.match(one, /^SKILL LATCH/, "行首要认得出是扩展说的话");
	assert.match(one, /endId must not exceed m00099/, "闸门口吻：规则不是建议");
	assert.match(one, /folds to a summary/, "越界后果要说清");
	assert.match(one, /Ceiling, not target/, "别把上限当指标");
	assert.doesNotMatch(one, /release_skills/, "不再提已撤的工具");

	const two = boundaryNotice([mk("paper", 99), mk("spectre", 59)]);
	assert.match(two, /spectre m00059/, "多技能各报各的，且按边界升序");
	assert.match(two, /paper m00099/);
	assert.match(two, /To keep all: m00059/, "一次压缩只有一个终点，全保住取最小");

	// 未定位的条目没有号码可报，也不编一个。
	assert.doesNotMatch(boundaryNotice([mk("paper", 99), mk("late", null)]), /late/);
});

test("ACP 标签：只认末尾，只认合法编号", () => {
	// 实测格式：正文在前，标签挂在末尾（诊断日志里 read 结果全部因此取不到号）。
	assert.equal(
		acpRefOf({ role: "toolResult", content: [{ type: "text", text: 'file.py\n<acp tokens="2.1K" type="bash">m00175</acp>' }] }),
		175,
	);
	assert.equal(acpRefOf({ role: "user", content: '早 <acp tokens="14">m00001</acp>' }), 1, "字符串 content 也认");
	assert.equal(
		acpRefOf({ role: "toolResult", content: [{ type: "text", text: 'x\n<acp tokens="1" type="read">m00042</acp>  ' }] }),
		42,
		"尾随空白不影响",
	);
	// 防回归：标签在中间（正文里举例、或后面还有内容）不能当成这条消息的号。
	assert.equal(
		acpRefOf({ role: "toolResult", content: [{ type: "text", text: '<acp tokens="2.1K" type="bash">m00175</acp>\nfile.py' }] }),
		null,
		"标签后面还有内容 → 不认",
	);
	assert.equal(acpRefOf({ role: "user", content: [{ type: "text", text: "引用了 m00100 但没有标签" }] }), null);
	assert.equal(acpRefOf({ role: "user", content: [{ type: "text", text: '正文 <acp tokens="1">BLOCKED</acp>' }] }), null, "BLOCKED 不是编号");
	assert.equal(acpRefOf({ role: "assistant", content: [{ type: "text", text: "无标签" }] }), null);
	assert.equal(acpRefOf(null), null);
});

test("释放文案：随工具一并撤掉", () => {
	// `describeRelease` / `releaseToolSpec` 已删（2026-11-19：没有闸门后，释放只省一行提示，
	// 而工具本身每轮常驻更贵）。这条占位提醒：重启后发现这个测试名又变回断言，就是有人把工具加回来了。
});

/** 造一条 ACP 提醒消息，形状与实测一致：`role: "user"` + 单段文本。 */
function nudge(text: string) {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

const GENTLE_NUDGE =
	"This is an efficiency nudge to compress early and keep context lean — not an overflow warning.\n\nHOW TO COMPRESS\n...";
const EMERGENCY_NUDGE =
	"⚠️ Context limit reached — compress now. Prioritize consumed tool outputs.\n\nHOW TO COMPRESS\n...";

test("提醒分流：日常丢掉，紧急与 tier 留着", () => {
	const real = { role: "user", content: "真实提问" };

	assert.equal(isAcpEmergencyMessage(nudge(GENTLE_NUDGE)), false, "温和不是紧急");
	assert.equal(isAcpEmergencyMessage(nudge(EMERGENCY_NUDGE)), true);
	assert.equal(isAcpNudgeMessage(nudge(GENTLE_NUDGE)), true, "温和照样认得");
	assert.equal(isAcpNudgeMessage(nudge(EMERGENCY_NUDGE)), true);
	assert.equal(isAcpNudgeMessage(real), false, "真实提问不是提醒");

	// tier 提醒带的是蒸馏/冷凝的具体指引，且自带 `efficiencyNote` 头——不能当日常提醒丢掉。
	const tier2 = nudge("[TIER 2 DISTILLATION TRIGGER]\n\nHOW TO COMPRESS\n...");
	assert.equal(isAcpTierNudge(tier2), true);
	assert.equal(isAcpEmergencyMessage(tier2), false, "非紧急的 tier 提醒不带火警锚点");

	const all = [real, nudge(GENTLE_NUDGE), nudge(EMERGENCY_NUDGE), tier2];
	const kept = dropRoutineNudges(all) ?? all;
	assert.equal(kept.length, 3, "只丢日常那一条");
	assert.equal(kept[0], real, "真实提问原样留着");
	assert.equal(isAcpEmergencyMessage(kept[1]), true, "紧急那条原样留着");
	assert.equal(kept[2], tier2, "tier 提醒原样留着");
	assert.equal(dropRoutineNudges([real]), null, "没得丢就返回 null（保住缓存前缀）");
	assert.equal(dropRoutineNudges([real, nudge(EMERGENCY_NUDGE)]), null);
});

test("紧急判定：认两种文案，不误伤通用规则块", () => {
	// ACP 的 tier 蒸馏提醒走另一套标题，但同样带 "Context limit reached"。
	assert.equal(
		isAcpEmergencyMessage(
			nudge("[EMERGENCY — TIER 2 DISTILLATION] Context limit reached — distill NOW into a denser summary."),
		),
		true,
	);
	// 防回归：只有通用规则块（真实对话里也可能被模型复述）不算紧急，否则会把噪音当火警。
	assert.equal(isAcpEmergencyMessage(nudge("引用了 HOW TO COMPRESS 但没有紧急锚点")), false);
	assert.equal(isAcpEmergencyMessage(nudge("This is an efficiency nudge")), false);
	// 只认 user 消息：助手正文里提到这句话不是提醒。
	assert.equal(isAcpEmergencyMessage({ role: "assistant", content: "Context limit reached" }), false);
	assert.equal(isAcpEmergencyMessage(null), false);
});

test("提醒末尾追加说明：字符串与分块 content 都要认", () => {
	const note = atRiskFoldNote([{ name: "spectre", path: "C:\\virtuoso\\skills\\spectre\\SKILL.md" }]);
	assert.match(note, /spectre/);
	assert.match(note, /summary, not the skill itself/, "必须说清「压过正文只剩摘要」");
	assert.match(note, /virtuoso\\skills\\spectre\\SKILL\.md/, "重读提示必须带全路径——否则模型只知道名字");
	// 防回归：扩展不再放开任何东西，别让文案暗示「钉点已放」或替模型下指令。
	assert.doesNotMatch(note, /latch released|Compress now/i);
	assert.equal(atRiskFoldNote([]), "", "没有目标就不产出文案");

	const blocky = appendNudgeNote(nudge(EMERGENCY_NUDGE), note) as { content: { text: string }[] };
	assert.equal(blocky.content.length, 2);
	assert.match(blocky.content[1].text, /spectre/);

	const plain = appendNudgeNote({ role: "user", content: EMERGENCY_NUDGE }, note) as { content: string };
	assert.match(plain.content, /summary, not the skill itself/);

	// 目标由调用方挑（不再有「非紧急就原样返回」的判断）：只对形状不认识的原样退回。
	const odd = { role: "user", content: 42 };
	assert.equal(appendNudgeNote(odd, note), odd);
});

test("重读提示：折走后一次、带全路径、说清摘要不是正文", () => {
	const one = foldedBodyNote([{ name: "paper", path: "C:\\skills\\paper\\SKILL.md" }]);
	assert.match(one, /paper/);
	assert.match(one, /summary, not the skill itself/, "要说清摘要不是正文，否则模型以为凭摘要还能继续");
	assert.match(one, /C:\\skills\\paper\\SKILL\.md/, "必须给全路径：正文折走后模型只剩名字");

	const many = foldedBodyNote([
		{ name: "paper", path: "E:\\a\\skills\\paper\\SKILL.md" },
		{ name: "spectre", path: "E:\\b\\skills\\spectre\\SKILL.md" },
	]);
	assert.match(many, /bodies of paper, spectre/);
	assert.match(many, /- paper: E:\\a\\skills\\paper\\SKILL\.md/);
	assert.match(many, /- spectre: E:\\b\\skills\\spectre\\SKILL\.md/);

	assert.equal(foldedBodyNote([]), "", "没有目标就不产出文案");
});

test("折走判定：只认曾经定位过的，没定位到的不算被折走", () => {
	const latch = new SkillLatch();
	latch.latch("resolved", "body a");
	latch.latch("unresolved", "body b");
	latch.setBoundary("resolved", 10);

	assert.deepEqual(
		latch.folded(["resolved", "unresolved"]).map((entry) => entry.name),
		["resolved"],
		"没定位到的只是没认出来，不能宣称正文已被折走"
	);
	assert.deepEqual(latch.folded([]), []);
	assert.deepEqual(latch.folded(["nobody"]), []);
});

test("登记表记住 SKILL.md 路径：折走后的提示靠它指路", () => {
	const latch = new SkillLatch();
	latch.latch("paper", "body text", "call-1", "C:\\skills\\paper\\SKILL.md");
	assert.equal(latch.list()[0].path, "C:\\skills\\paper\\SKILL.md");

	// 重读换了位置：提示要跟着最新那次读走
	latch.latch("paper", "body text", "call-2", "D:\\moved\\skills\\paper\\SKILL.md");
	assert.equal(latch.list()[0].path, "D:\\moved\\skills\\paper\\SKILL.md");

	// 没给路径时保留旧值，不被空串覆盖
	latch.latch("paper", "body text", "call-3");
	assert.equal(latch.list()[0].path, "D:\\moved\\skills\\paper\\SKILL.md");
});

/**
 * 白板（`pendingText`）收不收这一笔：只和「谁在说话」有关。
 *
 * 这几个用例钉住的是「扩展替人写的话不能盖掉人类原话」——真实触发者是 ACP 的限流重试
 * （`pi.sendUserMessage` → `source: "extension"`），它会把白板换成一段英文，于是本轮余下
 * 时间一个触发词都命不中，`<skill-hint>` 静默消失。同时守住两个不能反的方向：板空着时扩展
 * 仍能驱动 hint（纯自动 run），以及斜杠/`!` 输入照旧清空。
 */
test("白板：人开口的话盖掉上一个人的话（以最后一次为准）", () => {
	assert.equal(nextPendingText("跑个仿真", { text: "改一下网表", source: "interactive" }), "改一下网表");
	// rpc 也是人在另一端说话，同样算人类输入
	assert.equal(nextPendingText("跑个仿真", { text: "看下这份报告", source: "rpc" }), "看下这份报告");
});

test("白板：扩展替人写的话不许盖掉人类原话", () => {
	const human = "跑个仿真";
	const kick = "[ACP:provider-throttle] The previous assistant response was interrupted by a provider rate limit. Resume the task exactly where it left off.";
	assert.equal(nextPendingText(human, { text: kick, source: "extension" }), human, "限流重试不能抹掉用户原话");
	// 优先级：扩展写入被拒时，连斜杠/`!` 的清空规则都不参与（版面保持原样）
	assert.equal(nextPendingText(human, { text: "/skill:paper", source: "extension" }), human);
});

test("白板：板空着时扩展可以写进去（纯自动 run 靠它驱动 hint）", () => {
	assert.equal(nextPendingText("", { text: "跑个仿真", source: "extension" }), "跑个仿真");
});

test("白板：斜杠命令与 `!` 命令清空，不拿展开后的技能正文去扫", () => {
	assert.equal(nextPendingText("跑个仿真", { text: "/skill:spectre 跑 acl", source: "interactive" }), "");
	assert.equal(nextPendingText("跑个仿真", { text: "! git status", source: "interactive" }), "");
	assert.equal(nextPendingText("", { text: "  /skill:paper", source: "extension" }), "", "板空时扩展发的命令式文本也不参与匹配");
});

/**
 * 提醒的行动指令：一块里列了多个命中时，模型必须把「都读」当成默认，而不是「挑一个」。
 */
test("提醒 lead：清单是一道复数题，不是挑一个", () => {
	// 防回归：实测模型只读排第一的 office-docx，把内容侧的 paper 留给「下一轮」——
	// 而下一轮提醒已经没了（寿命只到第一个 turn 结束）。单数祈使句 + 一块清单就是那个诱因。
	assert.doesNotMatch(HINT_LEAD, /Read the SKILL\.md before acting/, "单数指令必须消失");
	assert.match(HINT_LEAD, /Read each covering SKILL\.md in full/, "全读——latch 的指纹定位靠全文");
	assert.match(HINT_LEAD, /in parallel, this turn/, "多命中默认一次读全：同 turn 并行堵死「读一个留其余」的缺口");
	// 跨层去重：「按 description 逐个判断」已上提 L0 的 HINT_CANDIDATE_GUIDELINE（每轮计费），lead 只留读法与压缩。
	assert.doesNotMatch(HINT_LEAD, /judge each named skill|Scan each/, "判断归 L0，lead 不重复");
	// 防跨段重复：协同那句只在钉住句里说一次。两处同写的话，有钉住的轮次就会在同一块里
	// 计费两次（契约里点名「没人会替你删」的那种）。
	assert.doesNotMatch(HINT_LEAD, /alongside|serve one|redundant/);
	// 压缩半句两边共用，不能因改 lead 把它弄丢。
	assert.match(HINT_LEAD, /compress it before reading/);
});

test("钉住句：只给判据，不给刹车", () => {
	const one = latchedNote(["office-docx"]);
	assert.match(one, /office-docx/, "点名谁还钉着");
	assert.match(one, /work alongside the latched ones rather than replacing them/, "共存事实：两者是协作，不是顶掉");
	// 防回归：早先的 `Read it only if this task needs it` 是一道刹车，而且恰好踩在
	// 最该读第二个的那一刻（复合任务里第二个技能几乎总是「额外需要」）。
	assert.doesNotMatch(one, /only if/);
	assert.match(one, /some tasks need several skills/, "用正面表述给出判据，而不是「你确定还需要吗」");
	// 防回归：不写死数量——「两个」一旦写进提醒，将来三个技能协同时它就成了一种保证。
	assert.doesNotMatch(one, /\btwo\b|can need two/);
	// 防回归：`redundant` 本是这句话第一次引入的词，一写进来模型就开始掂量重复与否；
	// `adds a pin` 则是内部记账口径，模型要的是「能不能一起用」。
	assert.doesNotMatch(one, /redundant|pin/);
	// 防跨段重复：「压过这行就成摘要」在每轮的提示行行头（只在钉住期计费），
	// 「折走会怎样」在 atRiskFoldNote / foldedBodyNote；两句抄到这里只会双计费。
	assert.doesNotMatch(one, /own task ends/);
	assert.doesNotMatch(one, /stay pinned/);
	assert.equal(latchedNote([]), "", "没钉住就不付这句话的钱");
});

test("跨轮结转：上轮点名没读的，只提一次", () => {
	const paper = { name: "paper", description: "写论文", filePath: "E:\\x\\skills\\paper\\SKILL.md" };
	const alone = carryNote(["paper"], false);
	assert.match(alone, /Previously named, final reminder: paper\./);
	assert.match(alone, /final reminder/, "单独一条要陈述「不会重复」这个推不出来的事实（现措辞：final reminder）");
	// 防回归：结尾不写「读它或永远别再想」那类无法执行的修辞。
	assert.doesNotMatch(alone, /for good/);
	// 并进新命中时不冒充最后通牒：这块里还有本轮真命中的条目。
	const mixed = carryNote(["paper"], true);
	assert.match(mixed, /Previously named, not yet read: paper\./);
	assert.doesNotMatch(mixed, /final reminder/);
	assert.equal(carryNote([], false), "", "没有结转就不付这句话的钱");

	const suggestions = [{ name: "office-docx", filePath: "E:\\x\\skills\\office-docx\\SKILL.md", matched: ["word"] }];
	// 三个方向要去掉：已钉住的（读过了）、这一轮又命中过的、以及重复的。
	assert.deepEqual(
		carriedSuggestions({
			suggestions,
			carried: [paper, { name: "office-docx", filePath: "x" }, paper],
			latched: [],
		}).map((entry) => entry.name),
		["paper"],
	);
	assert.deepEqual(
		carriedSuggestions({ suggestions: [], carried: [paper], latched: ["paper"] }).map((entry) => entry.name),
		[],
		"模型已经读了就不再念",
	);
});

test("跨轮结转：剥掉残留 matched，结转条目不报本轮不成立的计数", () => {
	// 上轮命中的 Suggestion 带着 matched 存进 unread；结转进本轮时，这个 stale 计数不该跟过去
	// （carriedSuggestions 投影成 SkillRef；对照同伴条目 appendCompanions 也 matched: []）。
	const stale = { name: "office-docx", description: "docx", filePath: "E:\\x\\skills\\office-docx\\SKILL.md", matched: ["word"] };
	const carried = carriedSuggestions({ suggestions: [], carried: [stale], latched: [] });
	assert.equal((buildHintText(carried, [], [stale.name]).match(/<matched-keywords>/g) ?? []).length, 0, "结转条目不冒充命中");
	// 对照：本轮真命中 + 结转同块，只报真命中那一条
	const fresh = { name: "paper", filePath: "E:\\x\\skills\\paper\\SKILL.md", matched: ["论文"] };
	const mixed = buildHintText([fresh, ...carried], [], [stale.name]);
	assert.equal((mixed.match(/<matched-keywords>/g) ?? []).length, 1, "只有真命中报计数");
});

test("提醒正文：结转条目带路径、不伪造命中计数", () => {
	const text = buildHintText(
		[
			{ name: "office-docx", description: "docx", filePath: "E:\\x\\skills\\office-docx\\SKILL.md", matched: ["word"] },
			{ name: "paper", description: "写论文", filePath: "E:\\x\\skills\\paper\\SKILL.md" },
		],
		[],
		["paper"],
	);
	assert.match(text, /<skill-hint>/);
	assert.match(text, /Previously named, not yet read: paper\./);
	// 防回归：这块里还有本轮真命中的条目，就不该冒充「最后通牒」——那是纯结转时的语气。
	assert.doesNotMatch(text, /final reminder/);
	assert.equal((text.match(/<matched-keywords>/g) ?? []).length, 1, "只有真命中的那条报计数，结转的不冒充");
	// 跨段去重：协同那句只在钉住句里，没有钉住时整块一次都不该有。
	assert.equal((text.match(/alongside/g) ?? []).length, 0, "没有钉住就不该出现这句");
	const latchedBlock = buildHintText(
		[{ name: "office-docx", filePath: "E:\\x\\skills\\office-docx\\SKILL.md", matched: ["word"] }],
		["office-docx"],
		[],
	);
	assert.equal((latchedBlock.match(/alongside/g) ?? []).length, 1, "有钉住时整块只许一次");
	// 正文被折走后模型手里只剩名字，所以路径必须有。
	assert.match(text, /<location>E:\\x\\skills\\paper\\SKILL\.md<\/location>/);

	// 只剩结转条目时才是最后通牒：这下模型必须当场决定读还是不读。
	const alone = buildHintText([{ name: "paper", filePath: "E:\\x\\skills\\paper\\SKILL.md" }], [], ["paper"]);
	assert.match(alone, /Previously named, final reminder: paper\./);
	assert.equal((alone.match(/<matched-keywords>/g) ?? []).length, 0, "结转条目一条计数都不该有");
	assert.equal(buildHintText([], []), "", "一条都没有就不注入空标签");
});

/**
 * 伴随表（「技能 → 技能」的协同边）：命中 `paper` 时把写死的同伴 `office-docx` 并进同一块
 * `<skill-hint>`，复合任务（写 Word 论文 = 内容 + 版式）一次读齐。
 */
const PAPER = { name: "paper", description: "写论文", filePath: "E:\\x\\skills\\paper\\SKILL.md" };
const DOCX = { name: "office-docx", description: "Office tools manual", filePath: "E:\\x\\skills\\office-docx\\SKILL.md" };
const SPECTRE = { name: "spectre", description: "仿真", filePath: "E:\\x\\skills\\spectre\\SKILL.md" };

test("伴随表：从保留键取，两种写法都收，坏条目不毁整表", () => {
	assert.deepEqual(
		normalizeCompanion({ paper: ["word"], companion: { Paper: [" office-docx ", 3], "": [], ghost: "x" } }),
		{ paper: [{ name: "office-docx" }] },
		"数组写法 = 无条件；键小写去空格、值只收非空字符串、空表与坏条目丢弃",
	);
	assert.deepEqual(
		normalizeCompanion({ companion: { Writing: { " office-docx ": [" 论文 ", 3, ""], ghost: [] } } }),
		{ writing: [{ name: "office-docx", only: ["论文"] }] },
		"对象写法 = 按词点名；条件里的坏词丢掉，条件空了的边整条丢掉",
	);
	assert.deepEqual(normalizeCompanion({}), {}, "没有 companion 键（旧格式文件）就是没有伴随");
	assert.deepEqual(normalizeCompanion(null), {});
	assert.deepEqual(normalizeCompanion({ companion: "paper" }), {}, "值不是对象丢弃");
	assert.deepEqual(normalizeCompanion({ companion: { a: ["b"], c: ["d"] } }), { a: [{ name: "b" }], c: [{ name: "d" }] });
});

test("伴随：命中时同伴并进同一块，不伪造命中计数", () => {
	const out = suggestSkills({
		text: "帮我写论文",
		skills: [PAPER, DOCX],
		triggers: { paper: ["论文"], "office-docx": ["word"] },
		companion: { paper: [{ name: "office-docx" }] },
		latched: [],
	});
	assert.deepEqual(out.map((s) => s.name), ["paper", "office-docx"], "命中在前，同伴垫后");
	assert.deepEqual(out[0].matched, ["论文"]);
	assert.deepEqual(out[1].matched, [], "同伴自己没命中任何词，不冒充");
	// 不传伴随表时行为不变（旧调用方）
	assert.deepEqual(
		suggestSkills({ text: "帮我写论文", skills: [PAPER, DOCX], triggers: { paper: ["论文"], "office-docx": ["word"] } }).map((s) => s.name),
		["paper"],
	);
});

test("伴随：已命中的、钉住的、没装上的，都不进块", () => {
	// 同伴同时命中自己的词表：命中条目已在块里，不重复
	const both = suggestSkills({
		text: "写论文，要 word 格式",
		skills: [PAPER, DOCX],
		triggers: { paper: ["论文"], "office-docx": ["word"] },
		companion: { paper: [{ name: "office-docx" }] },
		latched: [],
	});
	assert.deepEqual(both.map((s) => s.name), ["paper", "office-docx"], "同分按发现序，不重复");
	// 钉住的同伴跳过：模型读过了，不重复指路
	const latched = suggestSkills({
		text: "写论文",
		skills: [PAPER, DOCX],
		triggers: { paper: ["论文"] },
		companion: { paper: [{ name: "office-docx" }] },
		latched: ["office-docx"],
	});
	assert.deepEqual(latched.map((s) => s.name), ["paper"]);
	// 同伴名字查无此技能（配表笔误）：静默丢掉，不让提醒指空气
	const ghost = suggestSkills({
		text: "写论文",
		skills: [PAPER, SPECTRE],
		triggers: { paper: ["论文"] },
		companion: { paper: [{ name: "ghost-skill" }, { name: "spectre" }] },
		latched: [],
	});
	assert.deepEqual(ghost.map((s) => s.name), ["paper", "spectre"], "查得到的才进块");
});

test("伴随：不占命中上限，被截掉的命中不带动同伴", () => {
	const s = (name: string) => ({ name, filePath: `E:\\x\\skills\\${name}\\SKILL.md` });
	const skills = [s("a1"), s("a2"), s("a3"), s("a4"), s("a5"), SPECTRE, PAPER];
	const triggers: Record<string, string[]> = {
		a1: ["w1"],
		a2: ["w2"],
		a3: ["w3"],
		a4: ["w4"],
		a5: ["w5"],
		spectre: ["spectre"],
		paper: ["paper"],
	};
	// 六个命中，上限只进前五个（a1–a5，同分按发现序）：spectre 被截掉；
	// 它的同伴 paper 因此不进块——被截掉的命中不带动同伴，同伴的同伴也不再扩散。
	const out = suggestSkills({
		text: "w1 w2 w3 w4 w5 spectre",
		skills,
		triggers,
		companion: { a5: [{ name: "spectre" }], a4: [{ name: "spectre" }], spectre: [{ name: "paper" }] },
		latched: [],
	});
	assert.equal(out.length, 6, "五个命中占满上限，同伴不占名额");
	assert.deepEqual(out.slice(5).map((e) => e.name), ["spectre"], "同一同伴多源命中只进一次");
	assert.ok(!out.some((e) => e.name === "paper"), "被截掉的 spectre 不带动它的同伴");
});

test("伴随：按词点名——说到指定的词才带，其他词照旧只自己进块", () => {
	const triggers = { paper: ["论文", "润色"], "office-docx": ["三线表"] };
	const only = { paper: [{ name: "office-docx", only: ["论文"] }] };
	// 「论文」只有一个词，而它恰恰是这条边存在的理由：判据是场景，不是命中数。
	const thesis = suggestSkills({ text: "帮我写篇论文", skills: [PAPER, DOCX], triggers, companion: only, latched: [] });
	assert.deepEqual(thesis.map((s) => s.name), ["paper", "office-docx"], "说到「论文」→ 带");
	const polish = suggestSkills({ text: "帮我润色这段", skills: [PAPER, DOCX], triggers, companion: only, latched: [] });
	assert.deepEqual(polish.map((s) => s.name), ["paper"], "说到「润色」→ 不带");
});

test("硬顶：命中 5 + 伴随超额时按源强弱序丢尾部，回调报出被丢的条目", () => {
	const s = (name: string) => ({ name, filePath: `E:\\x\\skills\\${name}\\SKILL.md` });
	const skills = [s("a1"), s("a2"), s("a3"), s("a4"), s("a5"), s("c1"), s("c2"), s("c3"), s("c4")];
	const triggers = {
		a1: ["w1", "w1x"],
		a2: ["w2"],
		a3: ["w3"],
		a4: ["w4"],
		a5: ["w5"],
	};
	// a1 命中两个词（最强），其余同分按发现序；两个源各带两个同伴 → 5 + 4 = 9 > 8。
	const companion = {
		a1: [{ name: "c1" }, { name: "c2" }],
		a2: [{ name: "c3" }, { name: "c4" }],
	};
	const dropped: string[] = [];
	const out = suggestSkills({
		text: "w1 w1x w2 w3 w4 w5",
		skills,
		triggers,
		companion,
		latched: [],
		onOverflow: (entries) => dropped.push(...entries.map((e) => e.name)),
	});
	assert.equal(MAX_HINT_ENTRIES, 8, "5 命中 + 3 伴随额度");
	assert.equal(out.length, MAX_HINT_ENTRIES, "整块封顶");
	assert.deepEqual(out.map((e) => e.name), ["a1", "a2", "a3", "a4", "a5", "c1", "c2", "c3"]);
	assert.deepEqual(dropped, ["c4"], "丢的是尾部：最弱命中（a2）带出的第二个同伴");
});
