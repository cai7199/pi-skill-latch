/**
 * skill-latch — 让技能按需占上下文：命中时点名，没命中时由 `search_skills` 检索；
 * 装了 ACP 的话，再让读进来的技能正文不被压缩静默吃掉。
 *
 * ## 为什么需要它
 * pi 原生的 `<available_skills>` 是 O(技能数) 的常驻开销（每条 name + description + 文件路径），
 * 而绝大多数轮次一个技能也用不上。本包把它换成两条**按需**通道：
 * - 用户原文命中词表 → `<skill-hint>` 直接点名并给出路径（`lib/suggest.ts`）；
 * - 没命中 → 模型自己调 `search_skills` 按关键词检索（`lib/search-tool.ts`）。
 * 常驻成本从「每轮 N 个技能」降到「一次调用」。
 *
 * 代价要说清：模型不再被动知道「装了哪些技能」，它得先想到问。所以提醒文案里带了行动指令
 * （先看命中那份），`search_skills` 的描述里写明什么时候来问——两处都不进 `<rules>`，按次计费。
 *
 * 逃生口：`settings.nativeSkillList = true`（或 `SKILL_LATCH_NATIVE_SKILL_LIST=1`）保留原生清单。
 * 怀疑「技能没被用上」时先看这里。
 *
 * ## 顺序依赖：本包要排在「会在 before_agent_start 里拍 systemPrompt 快照」的包之前
 * 清空发生在 `before_agent_start`，而有的包在同一个钩子里返回 `systemPrompt`——pi 核心把它当
 * 全文快照钉在每个请求头（`_installAgentForcedPromptProjection`），且快照不受 transcript
 * sections 影响。处理器按装载顺序跑：本包排前则清空先执行，快照才不带 `<available_skills>`；
 * 顺序反过来则清空太晚、快照已冻好——**不报错**，常驻清单悄悄复活。
 *
 * 靠文档祈祷不可靠，所以在第一次拿得到清单的请求里自检：系统消息里还有 `<available_skills>`
 * 就报警，并说明改 `packages` 顺序或开逃生口。失败至少是响的。
 *
 * ## ACP 的压缩边界：可选增强，不在就整块不跑
 * 技能正文（SKILL.md）一旦被折成摘要，模型就处于两种坏状态之一：重读一遍（白花 token），
 * 或者在「以为自己还记得」的情况下继续干（更糟）。装了 ACP（`billion-context-pi`）时，本包在
 * 钉住期间每轮报一行「压到哪为止」；压过去就折成摘要，下一轮再告知一次。细节在
 * `acp/boundary-note.ts` 与 `acp/reread-note.ts`。
 *
 * 这套东西**只对 ACP 有意义**：边界就是 ACP 的消息编号（`<acp …>m00100</acp>`），折没折走靠
 * 「编号还在不在」判断。没有 ACP 时钉住只会空转（拿不到编号、永远等不到撤销、登记表只增不减），
 * 所以先探测（`acp/presence.ts`），不在就整块不跑——本包退化为纯按需技能通道，仍是一份完整的
 * 功能。这也是它敢单独发出去的前提：不假设同机装了别的包。
 *
 * ## 不拦压缩，只报号码
 * 早先 `compress` 越过正文会被拦下。拦得住的代价是：摘要已经写好才撞墙，连与技能无关的旧历史
 * 也一并压不了。现在只报号码——压到那号为止正文就留着，压过去就折成摘要，选择权在模型手里。
 *
 * ## 关键词建议：在用户文本里认出「可能有用的技能」
 * 用户说「跑个仿真」，模型未必想起还有 `spectre` 这个技能——它得自己在清单里做选择题。本包按
 * 配置的**手写词表**（技能名 → 触发词）在用户输入里扫一遍，命中就往请求里塞一行 `<skill-hint>`。
 * 为什么手写而不用 description 自动抽词，见 `lib/suggest.ts`。
 *
 * 词表管「词 → 技能」，管不了「技能 → 技能」的协同：写 Word 论文要一次读齐内容侧的 `paper`
 * 与版式侧的 `office-docx`，而「论文」这个词只挂在一个技能名下（词表纪律：一个词只挂一个技能）。
 * 协同关系由同一份配置的保留键 `companion` 写死，命中时同伴并进同一块——还能按词收窄（`only`）。
 * 规则与代价分析在 `lib/suggest.ts` 的 `appendCompanions`。
 *
 * 提醒的寿命只到**第一个 turn 结束**（`pendingText` 在 `turn_end` 清空），而原生清单又被摘掉了。
 * 于是「先读版式技能，论文技能下一轮再说」在模型看来完全合理——下一轮它连名字都不存在了，
 * 那是设计缺口，不是模型懒。补法：点名而没读的条目结转到下一次请求再提**一次**
 * （`unread` 在 `turn_end` 结算，`context_with_system` 里并进同一块）。只提一次，
 * 多了就成了每次请求计费的墙纸（同一个道理见 `<skill-hint>` 误报的代价）。
 *
 * ### 为什么挂在 `turn_end` 而不是 `agent_settled`
 * 一个 turn = 一次 LLM 请求 + 它发起的工具执行，到这个点模型已经用行为表态：要么读了
 * SKILL.md，要么干了别的。再往下念就是无内容重复——而 `HINT_LEAD` 写的本来就是 `this turn`，
 * 挂 `agent_settled` 等于实现比文案更啰嗦：一条用户消息里 N 次请求就念 N 次。
 * `agent_end` 更差：一次用户消息通常只对应一个 low-level run，它几乎落在最后一个 turn 之后，
 * 省不掉任何重复；反倒是重试/压缩重试/排队消息会提前抹掉白板，复现 `lib/pending-text.ts`
 * 记过的「标记被一次看不见的重试抹掉」。
 * 未完成的 turn（`outcome !== "completed"`，例如限流失败）不清：那时白板还得留给重试。
 * `agent_settled` 留作兜底，被中断或没有 turn 的路径仍在那里收尾。
 *
 * ## ACP 的压缩提醒：日常那条丢，紧急与 tier 留着
 * ACP 的提醒注入在**它的** `context` 处理器里，本包挂在 `context_with_system`（按定义跑在所有
 * `context` 之后）才看得到（见 `acp/nudge-filter.ts`）。日常语音（"efficiency nudge"）**丢掉**：
 * 它从 45% 占用起每轮都来，而压不压此刻由那行提示自己说，提醒只是在重复模型已经知道的东西——
 * 用户实测「触发太频繁」，一直屏蔽。
 *
 * 紧急语音（"Context limit reached — compress now"）留着，末尾追加一句「压过正文就只剩摘要」——
 * 此刻正文最容易被顺手折掉；tier 提醒（蒸馏/冷凝）也留着，它带的是另一套具体指引。
 *
 * ## 注入成合成 user 消息，而不是 system 消息
 * Pi 对不支持「对话中途改 system」的模型会把整段 prompt 重放，等于提醒每次出现/消失都整前缀
 * 重算——而提醒是每轮都要来的。合成 user 消息所有 provider 都当普通对话内容，且追加在末尾，
 * 前缀不动（ACP 的压缩提醒也是这么干的）。钉住期间的「压到哪为止」提示行同理：编号每轮都变，
 * 进 system 就等于每轮重算整个前缀。
 *
 * `emitContext` 的返回值只是本次请求的局部变量，不写回 transcript，所以每次请求恰好注入一份，
 * 不会越堆越多。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { boundaryNotice } from "./acp/boundary-note.ts";
import { appendNudgeNote, dropRoutineNudges, isAcpEmergencyMessage, isAcpNudgeMessage } from "./acp/nudge-filter.ts";
import { AcpPresence } from "./acp/presence.ts";
import { acpRefOf, messageTextOf } from "./acp/ref-scan.ts";
import { atRiskFoldNote, foldedBodyNote } from "./acp/reread-note.ts";
import { configFile, debugLogPath, loadConfig } from "./config.ts";
import { claimEntry } from "./entry-gate.ts";
import { SkillLatch, skillNameFromPath, type LatchedSkill } from "./lib/latch.ts";
import { nextPendingText } from "./lib/pending-text.ts";
import { registerPromptGuidelines } from "./lib/prompt-guidelines.ts";
import { searchToolSpec } from "./lib/search-tool.ts";
import {
	buildHintText,
	carriedSuggestions,
	HINT_CANDIDATE_GUIDELINE,
	MAX_HINT_ENTRIES,
	suggestSkills,
	type SkillRef,
} from "./lib/suggest.ts";

/**
 * 边界定位的诊断开关（`settings.debug` 或 `SKILL_LATCH_DEBUG=1`）：每轮把定位现场写到
 * `<agentDir>/skill-latch-debug.log`。
 *
 * 为什么要留它：ACP 的消息标签位置（末尾）、哪些工具结果拿不到号（`read`）都不是从文档能读
 * 出来的，实测踩过一次。再怀疑定位时可以把它打开看现场。默认关，不写盘。日志写 agent 目录而
 * 不是包目录——包可能只读，升级时也会被替换。
 */
function debugDump(path: string, messages: readonly unknown[], entries: readonly LatchedSkill[]): void {
	const lines = [
		`entries: ${JSON.stringify(entries.map((entry) => ({ name: entry.name, boundary: entry.boundary, call: entry.toolCallId ?? null })))}`,
	];
	messages.slice(-60).forEach((message, offset) => {
		const index = Math.max(0, messages.length - 60) + offset;
		const text = messageTextOf(message);
		const ref = acpRefOf(message);
		const role = String((message as { role?: unknown }).role);
		const callId = (message as { toolCallId?: unknown }).toolCallId;
		const head = text.replace(/\s+/g, " ").slice(0, 90);
		lines.push(`#${index} role=${role} ref=${ref ?? "-"} chars=${text.length} call=${String(callId ?? "-")} :: ${head}`);
	});
	lines.push(`total=${messages.length}`);
	try {
		writeFileSync(path, lines.join("\n"), "utf8");
	} catch {
		// 诊断写不出去不该影响正常流程。
	}
}

export default async function skillLatch(pi: ExtensionAPI): Promise<void> {
	const config = loadConfig(configFile());
	const { settings, triggers, companion, noName } = config;

	// 互斥闸（见 src/entry-gate.ts）：同一台机器上可能还装着一份本机特化实现，两边不能同时接线
	// （重复注册 search_skills、双份注入提醒）。必须在任何 await 之前占位，否则加载顺序就失效了。
	const gate = claimEntry("generic", settings.entry);
	if (!gate.run) {
		const why =
			gate.reason === "preference"
				? "settings.entry selects the local implementation"
				: "the local implementation was loaded first";
		console.log(`[skill-latch] generic entry not active — ${why}.`);
		return;
	}

	const latch = new SkillLatch();
	const presence = new AcpPresence();
	const debugPath = settings.debug ? debugLogPath() : null;

	// 本轮要扫的用户原文。由 `input` 写入（那时 `/skill:` 还没展开，拿到的是用户真敲的字），
	// `context_with_system` 每轮现读——模型中途读了某个技能，下一次请求就不该再提它。
	// 寿命是**第一个 turn**：`turn_end` 一清，本条消息余下的请求不再重新匹配（见文件头）。
	let pendingText = "";
	// 本轮点名过、模型还没读的技能：`turn_end` 结算，下一次请求再提一次（见文件头）。
	// 类型取 `SkillRef` 而不是 `Suggestion`：结转条目的 `matched` 已经过期，不该再带进提醒。
	let offered: SkillRef[] = [];
	let unread: SkillRef[] = [];
	// 整块撞上硬顶只报一次（见下面 `onOverflow`）：一行足够说明「伴随表该收了」，
	// 每轮报就成新的墙纸——那正是本包一直在避免的东西。
	let overflowReported = false;
	// 顺序自检只做一次（见文件头）：第一次拿得到技能清单的请求里比对系统消息。
	let orderChecked = false;
	// 技能清单只在 `before_agent_start` 给得到（`context_with_system` 的 event 里没有）。
	// 同一份数据供给两条通道：`<skill-hint>` 的候选与 `search_skills` 的检索，不两边各存一份。
	let skills: SkillRef[] = [];

	// ── ACP 在场探测 ───────────────────────────────────────────────────────────
	// 必须在别的处理器之前完成：`tool_call` 里要用探测结论决定钉不钉。`context_with_system`
	// 在每次 LLM 调用前触发，因此第一个 `tool_call` 之前结论必然已知（见 acp/presence.ts）。
	pi.on("context_with_system", (event) => {
		presence.observe(event.messages);
	});

	// ── 技能正文钉住（ACP 可选增强的输入端）──────────────────────────────────
	pi.on("tool_call", async (event) => {
		if (!presence.enabledFor(settings.acp)) return;
		const { toolName, input, toolCallId } = event as {
			toolName?: string;
			input?: { path?: string; filePath?: string };
			toolCallId?: string;
		};

		// 不拦任何调用：压到哪由那行提示说（见 acp/boundary-note.ts）。
		// 认出"读技能正文"：路径形状够了。文件不存在就不钉——拼错的路径会让提示行永远挂着。
		if (toolName !== "read") return;
		const target = input?.path ?? input?.filePath;
		if (!target) return;
		const name = skillNameFromPath(target);
		if (!name || !existsSync(target)) return;
		// 正文开头留一份指纹，下一轮靠它在上下文里认出这条结果消息（见 lib/latch.ts）。
		// 读不到就不钉：钉一个定位不到的技能等于永久冻结压缩。
		let body = "";
		try {
			body = readFileSync(target, "utf8");
		} catch {
			return;
		}
		latch.latch(name, body, toolCallId, target);
	});

	// 正文落地后补边界（见 lib/latch.ts）：ACP 在渲染时才给消息发 ref，`tool_call` 那一刻还
	// 没有号可记，只能等下一轮用正文指纹把结果消息认出来。
	//
	// 顺带是唯一能发现「正文已被折走」的地方——没有闸门之后，ACP 自己的自动折叠不经过本包。
	pi.on("context_with_system", (event) => {
		if (latch.size() === 0) return;
		const entries = latch.list();
		if (debugPath) debugDump(debugPath, event.messages, entries);
		const missing = new Set(entries.map((entry) => entry.name));
		// ref 标签在消息末尾，没有标签的消息（比如 read 的结果）拿不到号。
		const refs = event.messages.map((message) => acpRefOf(message));

		const findIndex = (entry: LatchedSkill): number => {
			let index = -1;
			if (entry.toolCallId) {
				index = event.messages.findIndex((message) => {
					const { role, toolCallId } = message as { role?: unknown; toolCallId?: unknown };
					return role === "toolResult" && toolCallId === entry.toolCallId;
				});
			}
			if (index >= 0) return index;
			// 兜底：结果消息丢了 toolCallId（或被重写成别的形状）时，靠正文指纹认人。
			if (!entry.fingerprint) return -1;
			return event.messages.findIndex((message) => messageTextOf(message).includes(entry.fingerprint));
		};

		for (const entry of entries) {
			const index = findIndex(entry);
			if (index < 0) continue;
			// 结果消息自己有号（别的工具类型）→ 压到它前一条为止。
			if (refs[index] !== null) {
				latch.setBoundary(entry.name, refs[index] - 1);
				missing.delete(entry.name);
				continue;
			}
			// 自己没有号（read 结果就是这样）→ 取它**前面**最后一条有号的消息。
			// 压缩到那里为止一定碰不到正文；取后面那条会反过来把正文包进去。
			for (let i = index - 1; i >= 0; i--) {
				const ref = refs[i];
				if (ref === null || ref === undefined) continue;
				latch.setBoundary(entry.name, ref);
				missing.delete(entry.name);
				break;
			}
		}
		// 两种「这轮找不到」要分开：曾经定位过而现在没了 → 正文确实被折走；
		// 从没定位到 → 只是没认出来（读的是片段、文件改过），不能断定正文没了。
		// `forget` 内部对 boundary === null 的不动手，所以两种都调是安全的——后者被它拒掉。
		const folded = latch.folded(missing);
		for (const name of missing) latch.forget(name);
		if (folded.length === 0) return;
		// 只在这一轮出现：`forget` 已经把它们从登记表里拿掉，下一轮 list() 里没有了。
		// 模型真去重读，会重新钉住；不读的话也不该每轮再念一次，那是按轮计费的墙纸。
		return {
			messages: [
				...event.messages,
				{
					role: "user" as const,
					content: [
						{ type: "text" as const, text: foldedBodyNote(folded.map((entry) => ({ name: entry.name, path: entry.path }))) },
					],
					timestamp: Date.now(),
				},
			],
		};
	});

	// ACP 的压缩提醒（见文件头）：挂 `context_with_system` 是因为它按定义排在所有 `context`
	// 处理器之后，ACP 本轮的提醒此时必已在列表里。日常语音丢掉（每轮都来，成了墙纸）；紧急与
	// tier 语音留着，并在末尾追加说明。
	//
	// 技能提示行也贴在这里：它只在「正要压缩」时有信息量，而留存的提醒就是那一刻的信号。
	// 没有提醒的回合一个字都不注入——这才是真的省（取舍见 acp/boundary-note.ts）。
	pi.on("context_with_system", (event) => {
		if (!presence.enabledFor(settings.acp)) return;
		const kept = dropRoutineNudges(event.messages);
		const base = kept ?? event.messages;
		const entries = latch.list();
		const notes: string[] = [];
		if (entries.length > 0 && base.some((message) => isAcpEmergencyMessage(message))) {
			notes.push(atRiskFoldNote(entries.map((entry) => ({ name: entry.name, path: entry.path }))));
		}
		// 日常提醒已经在上面被丢掉，所以这里活下来的是 tier 与紧急两类。
		const boundary = boundaryNotice(entries);
		if (boundary && base.some((message) => isAcpNudgeMessage(message))) notes.push(boundary);
		if (notes.length === 0) return kept ? { messages: kept } : undefined;
		// 贴到这一轮第一条提醒的末尾，而不是新起一条 user 消息：注入点越少越不容易成墙纸。
		const text = notes.join("\n\n");
		const target = base.findIndex((message) => isAcpNudgeMessage(message));
		if (target < 0) return kept ? { messages: kept } : undefined;
		return {
			messages: base.map((message, index) => (index === target ? appendNudgeNote(message, text) : message)),
		};
	});

	// 顺序自检（见文件头）：清空原生清单之后，系统消息里还有 `<available_skills>` 就说明本包
	// 排在「拍快照」的包后面——只报一次，不刷屏。
	pi.on("context_with_system", (event) => {
		if (orderChecked || settings.nativeSkillList || skills.length === 0) return;
		orderChecked = true;
		if (!messageTextOf(event.messages[0]).includes("<available_skills>")) return;
		console.warn(
			"[skill-latch] <available_skills> is still in the system prompt — another package captured it before this one cleared it. " +
				"List this package before that one, or set settings.nativeSkillList = true to keep the native list on purpose.",
		);
	});

	// 白板只收「人开口」的话：斜杠命令 / `!` 命令不是任务描述，别的扩展替人写的话不许盖掉人类原话
	// （两条判据与理由都在 lib/pending-text.ts，那里可单测）。
	pi.on("input", (event) => {
		const text = typeof event.text === "string" ? event.text : "";
		pendingText = nextPendingText(pendingText, { text, source: event.source });
		return { action: "continue" };
	});

	pi.on("before_agent_start", (event) => {
		const all = event.systemPromptOptions?.skills ?? [];
		// `disableModelInvocation` 的技能不写进 `<available_skills>`：模型看不见它，提醒就等于指空气。
		skills = all
			.filter((skill) => !skill.disableModelInvocation)
			.map(({ name, description, filePath }) => ({ name, description, filePath }));
		// 摘掉原生清单（见文件头）：一个技能都没装时摘不摘都是空表，但也不该去动别人的字段。
		if (event.systemPromptOptions && !settings.nativeSkillList) event.systemPromptOptions.skills = [];
	});

	pi.on("context_with_system", (event) => {
		if (!settings.hints || skills.length === 0) return;
		const latchedNames = latch.names();
		const suggestions =
			pendingText === ""
				? []
				: suggestSkills({
						text: pendingText,
						skills,
						triggers,
						companion,
						latched: latchedNames,
						noName,
						onOverflow: (dropped) => {
							if (overflowReported) return;
							overflowReported = true;
							const names = dropped.map((entry) => entry.name).join(", ");
							console.log(`[skill-latch] <skill-hint> capped at ${MAX_HINT_ENTRIES}; dropped ${names} (trim the companion table)`);
						},
					});
		// 上一轮点名、到现在还没读的：去掉已钉住的（模型读了）与这一轮又命中过的（已在建议里）。
		const carried = carriedSuggestions({ suggestions, carried: unread, latched: latchedNames });
		// 没有新命中也没有结转的，这一轮就不注入：空的 `<skill-hint>` 比没有更吵。
		if (suggestions.length === 0 && carried.length === 0) {
			unread = [];
			return;
		}
		// 发出去就消费掉：结转只给一次（见 `carryNote`），重复提到会变成墙纸。
		unread = [];
		offered = suggestions;
		const text = buildHintText([...suggestions, ...carried], latchedNames, carried.map((entry) => entry.name));
		if (!text) return;
		const hint = { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() };
		return { messages: [...event.messages, hint] };
	});

	// 结算：把「点名过但没读」的留给下一次请求一次，其余清空。
	//
	// 判据在结算时再取一次 `latch.names()`：结算前刚读过、而 `offered` 拍得早的那些，不该被当成没读。
	// `pendingText` 照旧丢掉，免得下一次请求拿这一轮的话去扫。
	const settleRound = () => {
		const latchedNow = new Set(latch.names().map((name) => name.toLowerCase()));
		unread = offered.filter((entry) => !latchedNow.has(entry.name.toLowerCase()));
		offered = [];
		pendingText = "";
	};

	// turn 边界结算（见文件头）：一次回复 + 它的工具已经落定，模型要不要读已用行为表态。
	// 未完成的 turn 不清——限流失败也会触发本事件，那时白板还得留给重试。
	pi.on("turn_end", (event) => {
		if (event.outcome !== "completed") return;
		settleRound();
	});

	// 兜底：被中断（没有 turn）、或结算前异常退出的路径，仍在这里收尾。
	pi.on("agent_settled", () => settleRound());

	// 常驻规矩：不在钉住期间才出现——规则面在请求前缀里，时隐时现会让前缀缓存整体失效。
	// 「compress 与正文」只剩那行提示在说，不再需要一条常驻规矩。
	if (settings.hints) registerPromptGuidelines(pi, "skill-latch", [HINT_CANDIDATE_GUIDELINE]);

	if (settings.searchTool) pi.registerTool(searchToolSpec(() => skills, () => triggers));
}
