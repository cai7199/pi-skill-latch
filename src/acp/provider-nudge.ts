/**
 * ACP 压缩提醒的「日常语音」在 `billion-context` 0.1.216+ 由**本地代理层**在请求出站前
 * 追加成一条 trailing user 消息（`renderNudgeText` 的产物）：Pi 的 `context` 与
 * `context_with_system` 阶段都还没有它（见 `nudge-filter.ts` 的文件头），所以按消息对象过滤
 * 那一套在新版上是空转。要动它，只能挂 `before_provider_request` —— 那一刻 payload 已经
 * 被代理改写完，提醒就在里面。
 *
 * ## 顺序：本处理器必须排在 ACP 后面
 * `before_provider_request` 按**扩展装载顺序**链式执行（pi 1.7.0 `emitBeforeProviderRequest`：
 * 后一个处理器拿到的是前一个的返回值）。ACP 在请求出站前才注入，所以本包也得排在
 * `billion-context` **之后** —— `profiles/local/settings.json` 里 `packages` 的顺序是唯一
 * 依据，`tests/skill-latch-provider-nudge.test.mjs` 有顺序断言盯着它。排到前面不会报错，
 * 只会静默失效（payload 里那时还没有提醒）。
 *
 * ## 只丢日常语音
 * 温和的 "This is an efficiency nudge"（`minContextLimitPct` 起每轮都来）丢掉；紧急
 * （`Context limit reached` / `[EMERGENCY`）与 tier（`[TIER `）提醒保留 —— 它们带的是
 * 「真该压了」的信号与蒸馏指引。判据与 `dropRoutineNudges` 共用 `nudge-filter.ts` 的同一套
 * 文本锚点。
 *
 * ## 不按角色认，也不只认 `messages`
 * ACP 不给这条消息打标记，`role: "user"` 与真人输入同形，所以认文本；用户自己把提醒原文
 * 贴进来的情况由调用方的 `isUserAuthored` 兜住。承载消息数组的字段随协议变：Anthropic /
 * OpenAI 是 `messages`，Responses 是 `input`，Gemini 是 `contents`（`parts` 里放 `text`），
 * 这里统一处理，找不到就原样返回。
 */

import { isRoutineNudgeText } from "./nudge-filter.ts";

/** 承载消息数组的字段：Anthropic/OpenAI、Responses、Gemini。 */
const CARRIERS = ["messages", "input", "contents"] as const;

/** 丢掉了哪一条（给调用方打日志用）。 */
export interface ProviderNudgeDrop {
	/** `messages` / `input` / `contents`。 */
	carrier: string;
	/** 被丢的那条在数组里的下标（负数 = 从末尾数）。 */
	index: number;
	/** 被丢正文的字符数。 */
	chars: number;
}

function partText(part: unknown): string {
	if (typeof part !== "object" || part === null) return "";
	const { type, text } = part as { type?: unknown; text?: unknown };
	if (typeof text !== "string") return "";
	// 只认文本块：`text` / `input_text` / `output_text`（Responses）；`image_url` 之类没有 text。
	return type === undefined || type === "text" || type === "input_text" || type === "output_text" ? text : "";
}

function blocksText(blocks: unknown): string {
	if (typeof blocks === "string") return blocks;
	if (!Array.isArray(blocks)) return "";
	return blocks.map(partText).join("");
}

/** 这条 payload 项是不是「用户说的话」，是就返回它的正文；不是返回 `null`。 */
function userTextOf(item: unknown): string | null {
	if (typeof item !== "object" || item === null) return null;
	const { role, content, parts } = item as { role?: unknown; content?: unknown; parts?: unknown };
	if (role !== "user") return null;
	const text = blocksText(content) || blocksText(parts);
	return text || null;
}

/**
 * 从 provider payload 里丢掉日常压缩提醒，返回新 payload；没有可丢的返回 `null`
 * （调用方保持「未改动」语义：返回 `undefined`，Pi 沿用原来的 payload）。
 *
 * `isUserAuthored` 用来排除「用户自己贴了提醒原文」：命中就放过，不动。
 */
export function dropRoutineProviderNudge(
	payload: unknown,
	isUserAuthored: (text: string) => boolean,
): { payload: Record<string, unknown>; dropped: ProviderNudgeDrop } | null {
	if (typeof payload !== "object" || payload === null) return null;
	const record = payload as Record<string, unknown>;

	for (const carrier of CARRIERS) {
		const list = record[carrier];
		if (!Array.isArray(list)) continue;
		// 只可能有一条：ACP 把它追加在末尾，前面是真实对话。
		for (let offset = list.length - 1; offset >= 0; offset -= 1) {
			const text = userTextOf(list[offset]);
			if (!text) continue;
			if (!isRoutineNudgeText(text) || isUserAuthored(text)) return null;
			return {
				payload: { ...record, [carrier]: list.filter((_, index) => index !== offset) },
				dropped: { carrier, index: offset - list.length, chars: text.length },
			};
		}
	}
	return null;
}
