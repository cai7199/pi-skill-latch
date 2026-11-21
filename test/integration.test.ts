// 入口的接线冒烟：用桩 ExtensionAPI 驱动真实的钩子序列。
//
// 纯逻辑各有单测，但「配置怎么读、钩子按什么顺序、没有 ACP 时哪几块不跑」只有把入口跑起来
// 才看得见。pi 的扩展入口就是一个函数，桩掉 `on` / `registerTool` 就能在测试里复现：
//   before_agent_start → input → context_with_system → tool_call → context_with_system …
// 钩子之间按 pi 的约定接力（`context_with_system` 的返回值是下一位的入参），见 run()。
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import skillLatch from "../src/index.ts";
import { claimEntry, resetEntryClaim } from "../src/entry-gate.ts";

const BODY = "# demo-skill\n\nRun the simulation.\n";

type Handler = (event: any) => unknown;

class StubPi {
	handlers = new Map<string, Handler[]>();
	tools: any[] = [];

	on(event: string, handler: Handler): () => void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
		return () => {};
	}

	registerTool(spec: any): () => void {
		this.tools.push(spec);
		return () => {};
	}

	/** 按 pi 的接力语义跑一条钩子链：返回 `{messages}` 的处理器把消息列表交给下一位。 */
	async run(event: string, payload: any): Promise<any> {
		let current = payload;
		for (const handler of this.handlers.get(event) ?? []) {
			const result = await handler(current);
			if (result !== undefined && typeof result === "object" && result !== null && "messages" in result) {
				current = { ...current, messages: (result as { messages: unknown[] }).messages };
			}
		}
		return current;
	}
}

interface Fixture {
	pi: StubPi;
	skillPath: string;
	ownConfig: (raw: unknown) => Promise<void>;
}

async function fixture(rawConfig: unknown): Promise<Fixture> {
	const dir = await mkdtemp(join(tmpdir(), "skill-latch-"));
	const skillDir = join(dir, "skills", "demo-skill");
	await mkdir(skillDir, { recursive: true });
	const skillPath = join(skillDir, "SKILL.md");
	await writeFile(skillPath, BODY, "utf8");
	const configPath = join(dir, "skill-latch.json");
	await writeFile(configPath, JSON.stringify(rawConfig), "utf8");
	process.env.SKILL_LATCH_CONFIG = configPath;
	delete process.env.SKILL_LATCH_NATIVE_SKILL_LIST;
	delete process.env.SKILL_LATCH_DEBUG;
	const pi = new StubPi();
	await skillLatch(pi as any);
	return { pi, skillPath, ownConfig: async (raw) => writeFile(configPath, JSON.stringify(raw), "utf8") };
}

const systemOptions = (skillPath: string) => ({
	skills: [{ name: "demo-skill", description: "Simulate circuits.", filePath: skillPath, baseDir: "" }],
	promptGuidelines: [] as string[],
});

const text = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part: any) => (part?.type === "text" ? part.text : "")).join("");
};

const hints = (messages: any[]): any[] => messages.filter((m) => text(m.content).includes("<skill-hint>"));

// ── 没有 ACP：纯按需技能通道 ────────────────────────────────────────────────

test("无 ACP：摘掉原生清单、按词表点名，且不钉住任何技能", async () => {
	const { pi, skillPath } = await fixture({ "demo-skill": ["仿真"] });

	const start = await pi.run("before_agent_start", { systemPromptOptions: systemOptions(skillPath) });
	assert.deepEqual(start.systemPromptOptions.skills, [], "原生清单被清空");

	await pi.run("input", { text: "帮我跑个仿真", source: "interactive" });
	const request = await pi.run("context_with_system", { messages: [{ role: "system", content: "prompt" }] });
	const injected = hints(request.messages);
	assert.equal(injected.length, 1, "命中词表 → 注入一条 <skill-hint>");
	assert.match(text(injected[0].content), /demo-skill/);
	assert.ok(text(injected[0].content).includes(skillPath), "提醒里要带路径：模型得知道去 read 哪个文件");

	// 读技能正文：没有 ACP 就不该钉住。钉住的唯一后果是「压过正文就只剩摘要」那类提示，
	// 所以用「紧急提醒末尾有没有被追加说明」来观察。
	await pi.run("tool_call", { toolName: "read", input: { path: skillPath }, toolCallId: "c1" });
	const emergency = { role: "user", content: "⚠️ Context limit reached — compress now.\n\nHOW TO COMPRESS\n…" };
	const after = await pi.run("context_with_system", {
		messages: [{ role: "system", content: "prompt" }, { role: "user", content: "hi" }, emergency],
	});
	const kept = after.messages.find((m: any) => text(m.content).includes("Context limit reached"));
	assert.equal(text(kept.content), text(emergency.content), "没有 ACP：不该往提醒里贴边界提示");
});

test("提醒的寿命只到第一个 turn：失败的 turn 不清，成功的结转一次后彻底安静", async () => {
	const { pi, skillPath } = await fixture({ "demo-skill": ["仿真"] });
	await pi.run("before_agent_start", { systemPromptOptions: systemOptions(skillPath) });
	await pi.run("input", { text: "帮我跑个仿真", source: "interactive" });

	const system = { role: "system", content: "prompt" };
	const first = await pi.run("context_with_system", { messages: [system] });
	assert.equal(hints(first.messages).length, 1, "第一个 turn：全量提醒");

	// 未完成的 turn（限流失败也算）不清白板：那时技能还没被读到，重试必须还能见到名字。
	await pi.run("turn_end", { type: "turn_end", outcome: "error", turnIndex: 0 });
	const retry = await pi.run("context_with_system", { messages: [system] });
	assert.match(text(hints(retry.messages)[0].content), /demo-skill/, "失败的 turn 不清白板");

	// 成功的 turn 结算：点名没读的条目转成最后一次提醒，不再是全量重播。
	await pi.run("turn_end", { type: "turn_end", outcome: "completed", turnIndex: 1 });
	const carried = hints((await pi.run("context_with_system", { messages: [system] })).messages);
	assert.equal(carried.length, 1, "点名没读的条目结转一次");
	assert.match(text(carried[0].content), /Previously named, final reminder: demo-skill/, "第二次是最后提醒");

	// 发出即消费：第三次起彻底安静，否则就成了每条消息计费的墙纸。
	const quiet = await pi.run("context_with_system", { messages: [system] });
	assert.equal(hints(quiet.messages).length, 0, "结转发出即消费：第三次起彻底安静");
});

test("无 ACP：日常压缩提醒不碰（那是 ACP 的东西），search_skills 两条分支都在", async () => {
	const { pi, skillPath } = await fixture({ "demo-skill": ["仿真"] });
	await pi.run("before_agent_start", { systemPromptOptions: systemOptions(skillPath) });

	const gentle = { role: "user", content: "This is an efficiency nudge to compress early.\n\nHOW TO COMPRESS\n…" };
	const request = await pi.run("context_with_system", { messages: [gentle] });
	assert.equal(request.messages.length, 1, "没有 ACP 时不该删别人的消息");

	const tool = pi.tools.find((t) => t.name === "search_skills");
	assert.ok(tool, "search_skills 已注册");
	const byWord = await tool.execute("t1", { query: "仿真" });
	assert.match(byWord.content[0].text, /<matching_skills>/);
	assert.match(byWord.content[0].text, /demo-skill/);

	const all = await tool.execute("t2", {});
	assert.match(all.content[0].text, /<available_skills>/, "省略 query = 全表");
	assert.equal(all.details.count, 1);

	const nonsense = await tool.execute("t3", { query: "完全无关zzz" });
	assert.match(nonsense.content[0].text, /no skills match/, "0 命中要给自救指引");
});

// ── 有 ACP：边界提示与提醒筛选 ──────────────────────────────────────────────

const ACP_REF = '<acp tokens="12" type="user">m00001</acp>';
const acpUser = (text_: string, ref: number) => ({
	role: "user",
	content: [{ type: "text", text: `${text_}\n<acp tokens="12" type="user">m0000${ref}</acp>` }],
});

test("有 ACP：钉住后报边界号，紧急提醒末尾追加「折了就只剩摘要」", async () => {
	const { pi, skillPath } = await fixture({ "demo-skill": ["仿真"] });

	// 第一次请求里出现 ref → 探测确认（auto 模式从此启用边界提示）
	await pi.run("context_with_system", { messages: [acpUser("开始", 1)] });
	assert.ok(skillPath);

	await pi.run("tool_call", { toolName: "read", input: { path: skillPath }, toolCallId: "c1" });

	// 正文结果自己不带 ref（ACP 只给正文消息发号）→ 边界取它前面最后一条带号的消息
	const transcript = [
		{ role: "system", content: "prompt" },
		acpUser("开始", 1),
		{ role: "assistant", content: "先读技能" },
		{ role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: BODY }] },
	];
	const emergency = { role: "user", content: "⚠️ Context limit reached — compress now.\n\nHOW TO COMPRESS\n…" };
	const request = await pi.run("context_with_system", { messages: [...transcript, emergency] });
	const last = request.messages.at(-1);
	const note = text(last.content);
	assert.match(note, /m00001/, "边界号要报出来（正文前最后一条带号的消息）");
	assert.match(note, /summary, not the skill itself/, "提醒里要说明压过去只剩摘要");
	assert.ok(note.includes(skillPath), "折走后模型手里只剩名字，必须给全路径");
});

test("有 ACP：日常提醒被丢掉，tier 提醒留着", async () => {
	const { pi, skillPath } = await fixture({});
	await pi.run("context_with_system", { messages: [acpUser("开始", 1)] });

	const gentle = { role: "user", content: "This is an efficiency nudge.\n\nHOW TO COMPRESS\n…" };
	const tier = { role: "user", content: "[TIER 2 DISTILLATION TRIGGER]\n\nHOW TO COMPRESS\n…" };
	const real = { role: "user", content: "帮我看看上下文" };
	const out = await pi.run("context_with_system", { messages: [real, gentle, tier] });
	const texts = out.messages.map((m: any) => text(m.content));
	assert.deepEqual(texts, [text(real.content), text(tier.content)], "只丢日常那条");
	assert.ok(skillPath);
});

test("有 ACP：正文被折走 → 告知一次，随后登记表清空", async () => {
	const { pi, skillPath } = await fixture({});
	await pi.run("context_with_system", { messages: [acpUser("开始", 1)] });
	await pi.run("tool_call", { toolName: "read", input: { path: skillPath }, toolCallId: "c1" });
	await pi.run("context_with_system", {
		messages: [acpUser("开始", 1), { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: BODY }] }],
	});

	// 压缩之后：正文那条结果不在了（摘要里也没有原文指纹）
	const folded = [{ role: "system", content: "prompt" }, acpUser("开始", 1), { role: "user", content: "（这一轮上下文里只剩摘要）" }];
	const first = await pi.run("context_with_system", { messages: folded });
	const note = text(first.messages.at(-1).content);
	assert.match(note, /folded the body of demo-skill/);
	assert.ok(note.includes(skillPath));

	const second = await pi.run("context_with_system", { messages: folded });
	assert.equal(second.messages.length, folded.length, "只念一次：登记表已撤销");
});

// ── 顺序自检与逃生口 ───────────────────────────────────────────────────────

test("顺序自检：系统提示里还有原生清单就报警一次", async () => {
	const { pi, skillPath } = await fixture({});
	await pi.run("before_agent_start", { systemPromptOptions: systemOptions(skillPath) });

	const warnings: string[] = [];
	const original = console.warn;
	console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
	try {
		const stale = { messages: [{ role: "system", content: "<available_skills>\n  <skill>…" }] };
		await pi.run("context_with_system", stale);
		await pi.run("context_with_system", stale);
	} finally {
		console.warn = original;
	}
	assert.equal(warnings.length, 1, "只报一次，不刷屏");
	assert.match(warnings[0], /<available_skills>.*still in the system prompt/);
});

test("逃生口：nativeSkillList 保留原生清单，且不自检报警", async () => {
	const { pi, skillPath } = await fixture({ settings: { nativeSkillList: true } });
	const start = await pi.run("before_agent_start", { systemPromptOptions: systemOptions(skillPath) });
	assert.equal(start.systemPromptOptions.skills.length, 1, "用户要求保留时不该清空");

	const warnings: string[] = [];
	const original = console.warn;
	console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
	try {
		await pi.run("context_with_system", { messages: [{ role: "system", content: "<available_skills>…" }] });
	} finally {
		console.warn = original;
	}
	assert.deepEqual(warnings, [], "有意保留的时候不报警");
});

test("开关：searchTool / hints 关掉之后，对应通道完全不注册", async () => {
	const { pi, skillPath } = await fixture({ settings: { searchTool: false, hints: false }, "demo-skill": ["仿真"] });
	await pi.run("before_agent_start", { systemPromptOptions: systemOptions(skillPath) });
	await pi.run("input", { text: "帮我跑个仿真", source: "interactive" });
	const out = await pi.run("context_with_system", { messages: [{ role: "system", content: "prompt" }] });
	assert.equal(hints(out.messages).length, 0, "hints=false：不注入");
	assert.equal(pi.tools.length, 0, "searchTool=false：不注册工具");
});

// ── 互斥闸：同一台机器上还装着本机特化实现时 ──────────────────────────────
// 这两个用例放最后：占位是进程级的，其他用例需要它是「未占用」或已被 generic 占用。

test("互斥闸：settings.entry = local 时通用包完全不接线", async () => {
	resetEntryClaim();
	const { pi } = await fixture({ settings: { entry: "local" } });
	assert.equal(pi.handlers.size, 0, "一个钩子都不该注册");
	assert.equal(pi.tools.length, 0, "search_skills 也不该注册");
	resetEntryClaim();
});

test("互斥闸：特化版已占位时（auto）通用包让位", async () => {
	resetEntryClaim();
	assert.equal(claimEntry("local", "auto").run, true);
	const { pi } = await fixture({});
	assert.equal(pi.handlers.size, 0);
	assert.equal(pi.tools.length, 0);
	resetEntryClaim();
});
