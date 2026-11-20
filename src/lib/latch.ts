/**
 * 技能钉住的纯逻辑（不 import pi、不碰文件系统，便于单测）。
 *
 * 判据只有一条：`read` 的路径形状 `.../skills/<name>/SKILL.md` 认出技能名，记进登记表。
 *
 * ## 边界是什么
 * 每个技能记一条**边界**：压到这条消息为止正文还在上下文里，压过它就被折成摘要。边界只是
 * 一个数字，不再是一道闸门——它由 `lib/boundary-note.ts` 每轮报给模型，压到哪由模型自己决定。
 *
 * 边界算不出来时（`null`）调用方按「什么都不能压」处理：没有数字可报，也无法证明这次压缩
 * 不碰正文。这种条目通常只活一轮，下一轮定位到就补上。
 *
 * ## 边界为什么要等一轮
 * `tool_call` 触发时，那条工具结果消息还不存在，ACP 也还没给它发 ref（ref 由 pipeline 的
 * 末节点 `createRenderRefsNode` 在渲染时分配，写进消息文本的 `<acp ...>m00100</acp>` 前缀）。
 * 所以登记时边界是 `null`，下一轮 `context_with_system` 里拿正文指纹在消息中定位，再补编号。
 *
 * ## 为什么用指纹定位
 * ACP 不把 ref 挂在消息对象上，只写进文本；而结果消息本身不含文件路径，只能靠正文认人。
 * 指纹只在本进程里比对，**不交给 ACP**——早先那套「把指纹经 `isToolProtected` 交给 ACP」
 * 的方案会让 ACP 把受保护消息的 ref 写成 `BLOCKED`，标记写下就收不回，那个技能正文永远压不掉。
 * 现在 ACP 根本不知道有这回事。
 *
 * 多个技能同时钉住时各报各的边界；但一次压缩只有一个终点，所以实际能压到哪取决于最小值。
 *
 * ## 没有 release，也就没有撤销接口
 * 释放工具撤掉之后，登记表只剩两个出口：正文被折走（`forget`）或进程退出。不需要
 * `release`/`releaseAll`——模型想折正文就直接压，本扩展会在那一轮报「已折成摘要」。
 */

/** 指纹长度：够长到不像撞车，够短到不受 ACP 重新渲染时的换行差异影响。 */
export const FINGERPRINT_CHARS = 160;

/** 折叠空白后取开头一段。正文被 ACP 重新拼过也不影响匹配。 */
export function fingerprintOf(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, FINGERPRINT_CHARS);
}

/**
 * `.../skills/<name>/SKILL.md` → `<name>`；不是技能文件返回 null。
 *
 * 要求路径里出现过 `skills` 段且**不在名字位上**：仓里别处也可能有叫 SKILL.md 的文件（文档、模板），
 * 而 `skills/SKILL.md` 这种直接摆在技能根下的也不算某个技能。
 */
export function skillNameFromPath(filePath: string): string | null {
	if (!filePath) return null;
	const parts = filePath.split(/[\\/]+/).filter(Boolean);
	const last = parts.length - 1;
	if (last < 1 || parts[last] !== "SKILL.md") return null;
	const nameIndex = last - 1;
	if (!parts.slice(0, nameIndex).includes("skills")) return null;
	const name = parts[nameIndex];
	return name ? name : null;
}

/** 登记表里的一条。 */
export interface LatchedSkill {
	name: string;
	/**
	 * SKILL.md 的绝对路径。
	 *
	 * 正文被折走之后，模型手里只剩技能名，而 `read` 要的是路径——重读提示靠这个字段指路。
	 * 早先这里没有路径，提示只能写「re-read its SKILL.md」，指望上面那条 `<skill-hint>`
	 * 的 `<location>`；可 hint 本身也在这轮压缩的范围里，折完就没了。
	 *
	 * 可选是因为它不是判定的一部分：旧登记、手工构造的条目可以没有，那时提示退回名字。
	 */
	path?: string;
	/** 正文那条消息的 ref 编号减一；`null` = 还没在上下文里定位到。 */
	boundary: number | null;
	/** 正文开头的规范化片段，用来在上下文里认出这条结果。 */
	fingerprint: string;
	/** 读这条技能的那次工具调用 id。定位时优先用它：结构字段不会因重新渲染、折叠而变样。 */
	toolCallId?: string;
}

/** 登记表：技能名 → 边界。 */
export class SkillLatch {
	private entries = new Map<string, LatchedSkill>();

	/**
	 * 记下一个技能。正文为空就等于没内容可保护，不钉。
	 * 返回 true 表示这次是新钉住的（重读已钉住的技能不改变边界）。
	 *
	 * `path` 只用于提示文案（折走后告诉模型去哪里重读），不参与任何判定。
	 */
	latch(name: string, text: string, toolCallId?: string, path = ""): boolean {
		if (!name) return false;
		const fingerprint = fingerprintOf(text);
		if (!fingerprint) return false;

		const existing = this.entries.get(name);
		if (existing) {
			// 重读：指纹可能换了（文件改过），但边界保留——旧正文也许还在上下文里，
			// 放宽边界等于给压缩开口子。等下一轮定位到更早的那份自然会取更小的值。
			existing.fingerprint = fingerprint;
			// 路径跟着最新那次读走：文件被挪了位置，提示也该指新地方。
			if (path) existing.path = path;
			// 新的调用 id 指向最新那份结果，定位时优先用它。
			if (toolCallId) existing.toolCallId = toolCallId;
			return false;
		}

		this.entries.set(name, { name, path, fingerprint, toolCallId, boundary: null });
		return true;
	}

	/** 在上下文里定位到正文后补边界。已有更早的边界时保持不变（保守取小）。 */
	setBoundary(name: string, boundary: number): void {
		const entry = this.entries.get(name);
		if (!entry) return;
		if (!Number.isInteger(boundary) || boundary < 0) return;
		entry.boundary = entry.boundary === null ? boundary : Math.min(entry.boundary, boundary);
	}

	/**
	 * 这一轮在上下文里找不到的条目里，哪些是**曾经定位过**的。
	 *
	 * 两种情况必须分开：曾经定位过而现在没了 → 正文确实被折走，可以通知模型重读；
	 * 从没定位到 → 只是没认出来（读的是片段、文件改过、消息形状变了），不能断定正文没了。
	 * 混在一起就会把「没认出来」报成「已被折走」，重读提示一旦开始啸叫就没人看了。
	 */
	folded(names: Iterable<string>): LatchedSkill[] {
		const out: LatchedSkill[] = [];
		for (const name of names) {
			const entry = this.entries.get(name);
			if (entry && entry.boundary !== null) out.push({ ...entry });
		}
		return out;
	}

	/**
	 * 正文已经不在上下文里了（被折成摘要）。钉住失去对象，就地撤销。
	 *
	 * 只在**曾经定位过**时才调用：从没定位到的情况多半是指纹没匹配上（读的是片段、
	 * 文件改过），那时撤销等于把保护拆了，宁可继续冻结。
	 */
	forget(name: string): boolean {
		const entry = this.entries.get(name);
		if (!entry || entry.boundary === null) return false;
		this.entries.delete(name);
		return true;
	}

	/** 还钉着、但边界没算出来的技能。只供诊断：没号码可报，也不拦任何调用。 */
	unresolved(): string[] {
		const names: string[] = [];
		for (const entry of this.entries.values()) {
			if (entry.boundary === null) names.push(entry.name);
		}
		return names;
	}

	/** 快照，按边界升序（最早的在前，未定位的排最后）。 */
	list(): LatchedSkill[] {
		return [...this.entries.values()]
			.map((entry) => ({ ...entry }))
			.sort((a, b) => {
				if (a.boundary === null) return b.boundary === null ? 0 : 1;
				if (b.boundary === null) return -1;
				return a.boundary - b.boundary;
			});
	}

	names(): string[] {
		return [...this.entries.keys()];
	}

	size(): number {
		return this.entries.size;
	}
}
