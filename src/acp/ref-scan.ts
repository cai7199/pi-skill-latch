/**
 * 在消息文本里找 ACP 的 ref 标签（纯逻辑，便于单测）。
 *
 * ACP 不把 ref 挂在消息对象上，它把 `<acp tokens="..." type="...">m00100</acp>` 拼进消息
 * 文本的开头（pipeline 末节点 `createRenderRefsNode` 渲染时分配）。所以想拿编号只能正则。
 *
 * 标签只出现在**文本**上：工具调用的 `input` 是结构化对象，没有前缀；一张文档里的 `<acp>`
 * 也不带合法编号。所以「能 grab 到编号」本身就证明这条消息是**正文消息**而不是模型引用
 * 文档的那一条——定位技能正文不用再想别的办法。
 */

/**
 * ACP 的 ref 标签挂在消息文本**末尾**：`<正文><acp tokens="…" type="…">m00100</acp>`。
 * 早先按行首前缀去匹配，实测一条都对不上（诊断日志里 read 结果全部取不到号）。
 *
 * 只认末尾：正文里引用格式的字符串（比如文档里写的例子）带不上 `\s*$`。
 */
export const ACP_REF_PATTERN = /<acp\s[^>]*>(m\d{5})<\/acp>\s*$/;

/** 编号 → `m00100`。跟 ACP 的补零位数一致，写进提示文案时不留猜的空间。 */
export function formatRef(ref: number): string {
	return `m${String(ref).padStart(5, "0")}`;
}

/** 把 `m00100` 读成 100；不是合法 ref 返回 null。写回提示文案前用它校验一遍。 */
export function parseRefNumber(value: unknown): number | null {
	if (typeof value !== "string") return null;
	const match = /^m(\d{1,5})$/i.exec(value.trim());
	if (!match) return null;
	const n = Number(match[1]);
	return Number.isInteger(n) && n > 0 ? n : null;
}

/** 消息的纯文本部分：字符串 content 直接用，数组 content 只收 text 块。 */
export function messageTextOf(message: unknown): string {
	if (typeof message !== "object" || message === null) return "";
	const { content } = message as { content?: unknown };
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (typeof part !== "object" || part === null) continue;
		const { type, text } = part as { type?: unknown; text?: unknown };
		if (type === "text" && typeof text === "string") parts.push(text);
	}
	return parts.join("");
}

/**
 * 消息末尾标签里的 ref 编号；没有标签返回 `null`。
 *
 * 只认末尾：正文里引用的 `m00100` 是裸编号，末尾也不该出现一个完整的标签。
 */
export function acpRefOf(message: unknown): number | null {
	const text = messageTextOf(message);
	if (!text) return null;
	const match = ACP_REF_PATTERN.exec(text);
	if (!match) return null;
	const n = Number(match[1].slice(1));
	return Number.isInteger(n) && n > 0 ? n : null;
}
