/**
 * 「正文被折走了 / 马上要被折走，回去重读」的那两句。
 *
 * 两个触发点共用这里的措辞：旧版 ACP 报上下文告急时在它末尾追加一句（`atRiskFoldNote`），
 * 以及下一轮发现正文已经不在了（`foldedBodyNote`）。分散写两份的话，改一处漏一处。
 * 新版 `billion-context` 在代理层注入提醒，这个追加够不到；常驻边界行本身已经说了越界后果。
 *
 * ## 为什么必须带全路径
 * 正文一被折，模型手里只剩技能名，而 `read` 要的是路径。原先这里写的是
 * `re-read its SKILL.md`，指望着上面几行的 `<location>`——可那条 `<skill-hint>`
 * 本身也在这轮压缩的范围里，折完就没了。于是模型知道该读什么，却找不到在哪。
 *
 * ## 为什么都只陈述、不下命令
 * 「Re-read it」这类句子对本来就打算重读的模型是噪音，对不打算重读的模型也拦不住。
 * 真正无论下一步做什么都用得上的只有一件事：**剩下的那段是摘要，不是正文**。
 */

export interface RereadTarget {
	name: string;
	/** SKILL.md 的绝对路径。缺了只能退回名字——旧登记或测试构造的条目会这样。 */
	path?: string;
}

/** `paper: E:\...\paper\SKILL.md`；没有路径就只报名字。 */
export function formatRereadTarget(target: RereadTarget): string {
	return target.path ? `${target.name}: ${target.path}` : target.name;
}

/** 单个只给路径（句子已经报了名字），多个才需要 `名字: 路径` 对齐。 */
function formatList(targets: readonly RereadTarget[]): string {
	return targets.map((target) => `- ${formatRereadTarget(target)}`).join("\n");
}

/**
 * 已经折走了。触发点：`context_with_system` 里发现某条已定位的正文这轮不在了。
 *
 * 只陈述「剩下的是摘要」，不催回读：那句话对已经打算重读的模型是噪音，对不打算
 * 重读的也拦不住。路径照给——正文没了，模型手里只剩名字。
 *
 * 这条**只出现一次**——调用它在折走那一轮，登记表随后就清掉了。
 */
export function foldedBodyNote(targets: readonly RereadTarget[]): string {
	if (targets.length === 0) return "";
	const names = targets.map((target) => target.name).join(", ");
	if (targets.length === 1) {
		const where = targets[0].path ?? names;
		return `SKILL LATCH: this compression folded the body of ${names}. What remains is a summary, not the skill itself: ${where}`;
	}
	return `SKILL LATCH: this compression folded the bodies of ${names}. What remains are summaries, not the skills themselves:\n${formatList(targets)}`;
}

/**
 * 「如果折了会怎样」那句。`lead` 是时间落点：`this compression`（ACP 在催，动作就在眼前）。
 */
function foldWarning(targets: readonly RereadTarget[], lead: string): string {
	if (targets.length === 0) return "";
	const names = targets.map((target) => target.name).join(", ");
	if (targets.length === 1) {
		const where = targets[0].path ?? names;
		return `SKILL LATCH: if ${lead} folds ${names}, what remains is a summary, not the skill itself: ${where}.`;
	}
	return `SKILL LATCH: if ${lead} folds ${names}, what remains are summaries, not the skills themselves:\n${formatList(targets)}`;
}
/**
 * 还没折，但旧版 ACP 已经在催压缩。触发点：旧版紧急提醒的末尾。
 *
 * 新版 ACP 在代理层注入，这条追加够不到；常驻边界行（`acp/boundary-note.ts`）已经每轮说了
 * 越界后果。不写「钉点已放」，也不催「compress now」：扩展不再放开任何东西，压到哪由边界行
 * 说了算。这句只负责在旧版紧急提醒里说清代价。
 */
export function atRiskFoldNote(targets: readonly RereadTarget[]): string {
	return foldWarning(targets, "this compression");
}
