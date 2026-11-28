/**
 * 钉住期间那行「压到哪为止」的提示（纯逻辑，不 import pi、不碰文件系统，便于单测）。
 *
 * ## 文案是闸门，执行仍是提示
 * 早先这里是**硬闸门**：`compress` 的 `endId` 越过正文就 `block` 掉整个调用。代价很实在：
 * 摘要已经写好、钱已经花了，才在入口撞墙；连「我在做任务 A、顺手压掉与技能无关的旧历史」这种
 * 完全合理的调用也一并被挡。现在不拦调用；但文案用 `endId must not exceed` 的闸门口吻，
 * 把边界说成规则而不是建议。这不是保证：ref 会随折叠/新增变化，号码每轮重算；越界时正文
 * 仍会被折成摘要，下一轮由 `foldedBodyNote` 告知（带全路径），重读即可恢复。
 *
 * ## 每轮都发，跟着 `<skill-hint>` 走
 * 这行只在钉住期间计费：有 `<skill-hint>` 的轮次并进同一条消息，没有 hint 的轮次单发一条
 * 合成 user 消息。代价是每轮几十 token；换来的是模型主动压缩、而 ACP 没有提醒时也不会
 * 静默折走。号码仍然现算现发——编号随折叠与新增消息变化，存下来的号很快就是错的。
 *
 * 正文还没定位到的条目（刚读完、下一轮才发号）不报：那时没有数字可给，也不误报。它们也就
 * 一轮，下一轮定位到就补上；一直定位不到就只是留在登记表里，等下次重读自愈。
 *
 * ## 为什么只报 stop，不报「正文在第几号」
 * `read` 的结果消息经常自己**没有** ref（ACP 把标签挂在别的形状上），这时边界只能取它前面
 * 最后一条有号的消息（见 `index.ts` 的定位循环）。于是「正文自己的编号」并不总是已知，而
 * `stop` 永远是对的。报一个可能是猜的号，比少报一个真号坏得多。
 *
 * ## 规矩为什么不写在 `<rules>` 里
 * 释放工具撤掉之后，「压过这行就只剩摘要」这句话再没有别的地方说。它写在每轮这行的行头里，
 * 只在钉住期间计费；放进 `<rules>` 则整个会话每轮都付，还会因为条件性出现毁掉前缀缓存。
 */
import type { LatchedSkill } from "../lib/latch.ts";
import { formatRef } from "./ref-scan.ts";

/**
 * 拼出提示行；没有已定位的技能就返回空串（调用方据此不注入）。
 *
 * 多技能按边界升序报，`To keep all` 报最小值：一次压缩只有一个 `endId`，要全保住就得取最小。
 */
export function boundaryNotice(latched: readonly LatchedSkill[]): string {
	const located: Array<{ name: string; boundary: number }> = [];
	for (const entry of latched) {
		if (entry.boundary !== null) located.push({ name: entry.name, boundary: entry.boundary });
	}
	if (located.length === 0) return "";
	located.sort((a, b) => a.boundary - b.boundary);
	if (located.length === 1) {
		const [{ name, boundary }] = located;
		return `SKILL LATCH — ${name} (if still needed): endId must not exceed ${formatRef(boundary)}. `
			+ `Past it the body folds to a summary (you'll be told). Ceiling, not target.`;
	}
	const limits = located.map(({ name, boundary }) => `${name} ${formatRef(boundary)}`).join(", ");
	const min = formatRef(located[0].boundary);
	return `SKILL LATCH — if still needed, endId must not exceed these limits: ${limits}. `
		+ `To keep all: ${min}. Past a limit the body folds to a summary (you'll be told). Ceiling, not target.`;
}
