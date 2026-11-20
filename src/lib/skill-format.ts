/**
 * 技能块的 XML 渲染：`<skill-hint>` 与 `search_skills` 共用一套形状。
 *
 * ## 为什么照抄 Pi 原生 `<available_skills>` 的内层结构
 * `name` / `description` / `location` 这三个字段，模型已经形成了读法：「描述对上了就去 read
 * 这个 location」。换个字段名等于让它重新学一遍，而提醒只在命中的轮次出现，学习成本摊不平。
 * 外层标签换掉，是因为这一份是「针对这次请求挑出来的」，不是「全部技能」——两者的信任级别不同。
 *
 * ## 为什么自己写而不用 SDK 的 `formatSkillsForPrompt`
 * 那个函数只认 `Skill`（带着 `baseDir` / `sourceInfo` / `disableModelInvocation`），并且写死了
 * 外层标签与文件读取工具的措辞。这里要自己决定标签、要能吃 `SkillRef` 这种精简结构，还要能
 * 在 `search_skills` 的全表分支里原样复用，所以只借形状，不借实现。
 */

/** 渲染技能块所需的最小字段集。`description` 可缺——缺了就整行不写，不留空标签。
 * `matches` 也缺省：它只在「挑出来的那一份」里报（`<skill-hint>` 与 `search_skills` 命中结果），
 * 全表分支不该出现——那里没有词，报了也是无锚定的裸数字。 */
export interface SkillEntry {
	name: string;
	description?: string;
	filePath: string;
	matches?: number;
}

/** 与 Pi 的 `escapeXml` 保持一致的五个实体。description 里出现 `<` `&` 时不能把块撑破。 */
export function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/**
 * 渲染成 `<tag>` 包住的技能块；空表返回空串（调用方据此决定「不注入」而不是注入一个空标签）。
 * `lead` 是标签下的一行说明，用来说明「这一份该拿来干什么」。
 */
export function formatSkillsBlock(tag: string, entries: readonly SkillEntry[], lead?: string): string {
	if (entries.length === 0) return "";
	const lines = [`<${tag}>`];
	if (lead) lines.push(lead);
	for (const entry of entries) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(entry.name)}</name>`);
		const description = entry.description?.trim();
		if (description) lines.push(`    <description>${escapeXml(description)}</description>`);
		lines.push(`    <location>${escapeXml(entry.filePath)}</location>`);
		// 命中词数量只在「挑出来的那一份」里报（hint 与 search_skills 命中结果；全表没有它）：模型据此掂量强弱；命中的是哪些词不报——
		// 那是本扩展的推理过程，不是行动指令。标签用 `matched-keywords` 而非 `matches`：
		// 裸数字 `matches` 实测被读成「命中了几个 skill」（11-17 新会话报告），字段名本身必须自解释。
		if (typeof entry.matches === "number") lines.push(`    <matched-keywords>${entry.matches}</matched-keywords>`);
		lines.push("  </skill>");
	}
	lines.push(`</${tag}>`);
	return lines.join("\n");
}
