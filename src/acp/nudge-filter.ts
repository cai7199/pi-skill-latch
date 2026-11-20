/**
 * ACP 的「该压缩了」提醒（nudge）在上下文里是一条**合成的 user 消息**：正文由
 * `renderNudgeText` 拼出，必含 `HOW TO COMPRESS` 规则块。
 *
 * ## 日常、紧急、tier 三种提醒分开处理
 * ACP 按占用率换口吻：不到 `maxContextLimitPct`（默认 0.75）是温和的 "This is an efficiency
 * nudge"（`efficiencyNote`）；一过线就换成 "⚠️ Context limit reached — compress now"
 * （`isEmergency` = `overLimit || emergencyOverride`，默认 75% 就切）。
 *
 * 日常那条**丢掉**：它从 `minContextLimitPct`（默认 0.45）起每轮都来，内容就是占用明细与
 * 「该压了」——剩下的只是每轮计费。用户实测「触发太频繁」，所以闸门撒掉之后仍然屏蔽
 * （`dropRoutineNudges`）。技能提示行也因此**不跟它走**：只在有留存提醒的那一轮贴
 * （见 `boundary-note.ts`）。
 *
 * 另两条留着：
 * - 紧急：上下文真紧了的唯一信号，末尾追加一句「压过正文就只剩摘要」（见 `reread-note.ts`
 *   的 `atRiskFoldNote`），因为此刻正文最容易被顺手折掉。
 * - tier 提醒（非紧急的 `[TIER n …TRIGGER]`）：它携带蒸馏/冷凝的具体指引（`tier2DistillRules`
 *   等），与日常提醒不是一回事；而它也带 `efficiencyNote` 头，所以不能只靠语音区分。
 *
 * ## 为什么按文本认、不按角色认
 * ACP 没给这条消息打标记，`role: "user"` 和真实用户输入长得一样。规则块标题是唯一稳定、
 * 又不会出现在真实对话里的锚点；三种语音共用同一个规则块，所以还需要各自的专用锚点来
 * 分开（`HOW TO COMPRESS` 认人，`Context limit reached` / `[EMERGENCY` 分语音，`[TIER ` 分 tier）。
 *
 * 锚点全部来自 ACP 私有文案，改措辞时本文件会**静默失灵**（不报错，墙纸回归或 tier 误判）。
 * `test/acp-anchors.test.ts` 把本文件的每个锚点与已装 bundle 逐一比对：
 * ACP 升级后先跑它，红了就同步本文件常量、该测试与 `test/nudge-filter.test.ts` 的手写样本。
 */

/** 紧急语音：≥ `maxContextLimitPct` 之后 ACP 改用的文案。 */
const EMERGENCY_ANCHORS = ["Context limit reached", "[EMERGENCY"];

/** 温和语音：`minContextLimitPct`（默认 0.45）到软上限之间。 */
const GENTLE_ANCHORS = ["This is an efficiency nudge"];

/** 两类都带、用来认出「这是提醒」的锚点。 */
const NUDGE_ANCHORS = [...EMERGENCY_ANCHORS, ...GENTLE_ANCHORS, "HOW TO COMPRESS", "Compressed blocks: "];

function textOf(message: unknown): string {
	if (typeof message !== "object" || message === null) return "";
	const { role, content } = message as { role?: unknown; content?: unknown };
	if (role !== "user") return "";
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part: unknown) => {
			if (typeof part !== "object" || part === null) return "";
			const { type, text } = part as { type?: unknown; text?: unknown };
			return type === "text" && typeof text === "string" ? text : "";
		})
		.join("");
}

/** 这条消息是不是 ACP 的压缩提醒（温和或紧急）。 */
export function isAcpNudgeMessage(message: unknown): boolean {
	const text = textOf(message);
	if (!text) return false;
	return NUDGE_ANCHORS.some((anchor) => text.includes(anchor));
}

/**
 * 这条消息是不是 ACP 的**紧急**提醒。判据只有文本，因为 ACP 不给消息打标记。
 *
 * 注意 ACP 自己在 `overLimit`（软上限，默认 75%）时就切到紧急文案了；`emergencyThresholdPct`
 * （0.95）只影响 tier 选择与日志标签，T1 文案上分不出来。所以这里的「紧急」= ACP 认为该压了，
 * 不是严格的 95%。
 */
export function isAcpEmergencyMessage(message: unknown): boolean {
	if (!isAcpNudgeMessage(message)) return false;
	const text = textOf(message);
	return EMERGENCY_ANCHORS.some((anchor) => text.includes(anchor));
}

/**
 * 追加到紧急提醒末尾的「压过正文就只剩摘要」说明由 `reread-note.ts` 的 `atRiskFoldNote` 提供。
 *
 * 放那边的理由：同一个句式还有另一个触发点（发现正文已被折走的那一轮）。
 * 三处各写一份的话，改一处漏两处；而且旧版只写 `re-read its SKILL.md`，没带路径——
 * 正文一被折，模型手里就只剩名单里的名字，靠 `<location>` 回忆是不可能的（那张 hint 也已被折）。
 */

/**
 * 在一条 ACP 提醒末尾追加说明。目标由调用方挑（这一轮留下的提醒里第一条）：提示行对 tier
 * 同样适用，所以这里不能要求「必须是紧急语音」，只要求内容形状认得（字符串或分块）。
 *
 * 防回归：调用方只把它用在 `isAcpNudgeMessage` 为真的消息上（见 `index.ts` 的 ACP 提醒处理器）。
 */
export function appendNudgeNote<T>(message: T, note: string): T {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") {
		return { ...(message as object), content: `${content}\n\n${note}` } as T;
	}
	if (!Array.isArray(content)) return message;
	return {
		...(message as object),
		content: [...content, { type: "text", text: `\n\n${note}` }],
	} as T;
}

/** tier 提醒：非紧急的 `[TIER 2 DISTILLATION TRIGGER]`；紧急的已被 `EMERGENCY_ANCHORS` 认走。 */
const TIER_ANCHORS = ["[TIER "];

/** 这条是不是 ACP 的 tier 级提醒（蒸馏/冷凝）。它带具体指引，不能当日常提醒丢掉。 */
export function isAcpTierNudge(message: unknown): boolean {
	if (!isAcpNudgeMessage(message)) return false;
	const text = textOf(message);
	return TIER_ANCHORS.some((anchor) => text.includes(anchor));
}

/**
 * 丢掉日常提醒（温和的 "efficiency nudge"），保留紧急与 tier 提醒；`null` = 没有可丢的，
 * 调用方保持「未改动」语义（Pi 保留原列表，也就保住缓存前缀）。不改动原数组。
 */
export function dropRoutineNudges<T>(messages: T[]): T[] | null {
	const kept = messages.filter(
		(message) => !isAcpNudgeMessage(message) || isAcpEmergencyMessage(message) || isAcpTierNudge(message),
	);
	return kept.length === messages.length ? null : kept;
}
