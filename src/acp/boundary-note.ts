/**
 * 钉住期间那行「压到哪为止」的提示（纯逻辑，不 import pi、不碰文件系统，便于单测）。
 *
 * ## 只有提示，没有闸门
 * 早先这里是**闸门**：`compress` 的 `endId` 越过正文就 `block` 掉整个调用。代价很实在：
 * 摘要已经写好、钱已经花了，才在入口撞墙；连「我在做任务 A、顺手压掉与技能无关的旧历史」这种
 * 完全合理的调用也一并被挡。现在只报号码——压到它为止正文留着，压过去就折成摘要。选择权
 * 在模型手里，扩展只负责把数字算准。
 *
 * 正文还没定位到的条目（刚读完、下一轮才发号）不报：那时既没有数字可给，也不拦任何调用。
 * 它们也就一轮，下一轮定位到就补上；一直定位不到就只是留在登记表里，等下次重读自愈。
 *
 * ## 为什么只报 stop，不报「正文在第几号」
 * `read` 的结果消息经常自己**没有** ref（ACP 把标签挂在别的形状上），这时边界只能取它前面
 * 最后一条有号的消息（见 `index.ts` 的定位循环）。于是「正文自己的编号」并不总是已知，而
 * `stop` 永远是对的。报一个可能是猜的号，比少报一个真号坏得多。
 *
 * ## 只在「真要压缩」的那一轮发
 * 这行的唯一用途是决定这次 `compress` 压到哪；没有压缩意图的回合，它只是「我还记着」的墙纸。
 * 所以现在不每轮发，而是跟着 ACP 的压缩提醒走：有留存提醒（tier / 紧急）的那一轮才贴到那条
 * 提醒的末尾；日常语音已被丢掉，所以不从 45% 起每轮都有。号码仍然现算现发——编号随折叠与
 * 新增消息变化，存下来的号很快就是错的。
 *
 * 代价：模型自己主动压缩、而那一轮 ACP 没有提醒时，正文会被静默折走；兜底是事后那条带全路径
 * 的告知（`foldedBodyNote`），重读一次即可恢复。失败在会话里看得见，所以判错也不至于太久。
 *
 * ## 规矩为什么不写在 `<rules>` 里
 * 释放工具撤掉之后，「压过这行就只剩摘要」这句话再没有别的地方说。它写在每轮这行的行头里，
 * 只在钉住期间计费；放进 `<rules>` 则整个会话每轮都付。
 */
import type { LatchedSkill } from "../lib/latch.ts";
import { formatRef } from "./ref-scan.ts";

/**
 * 拼出提示行；没有已定位的技能就返回空串（调用方据此不注入）。
 *
 * 行头带上后果「过去就只剩摘要」：释放工具已撤，这句话没有第二个出口。
 */
export function boundaryNotice(latched: readonly LatchedSkill[]): string {
	const lines: string[] = [];
	for (const entry of latched) {
		if (entry.boundary === null) continue;
		lines.push(`- ${entry.name}: ${formatRef(entry.boundary)}`);
	}
	if (lines.length === 0) return "";
	return ["SKILL LATCH — compress up to (body folds to a summary past it):", ...lines].join("\n");
}
