/**
 * presence.ts — ACP 在场探测（纯逻辑，便于单测）。
 *
 * ## 为什么需要探测
 * 本包的「压到哪为止」提示只在 ACP 那种带 `mNNNNN` 编号的压缩下才有信息量：边界就是 ACP 的
 * 消息编号，折没折走靠「编号还在不在」判断。没有 ACP 时这套逻辑只会**空转**——`tool_call`
 * 里钉住的条目永远拿不到编号（`boundary: null`），既报不出号码，也永远等不到撤销，
 * 登记表只增不减。于是先问「ACP 在不在」，再决定钉不钉。
 *
 * ## 判据为什么是「上下文里出现过 ref 标签」
 * 按包名、按工具名、按 env 都能猜，但都是间接证据；而本功能消费的正是那个标签本身。
 * 时点也不成问题：`context_with_system` 在每次 LLM 调用前触发，refs 由渲染期分配，所以
 * 第一个 `tool_call` 发生之前探测结论必然已知——不需要「先钉后撤」的补偿逻辑。
 *
 * ## 三种模式（见 `LatchSettings.acp`）
 * - `"auto"`（缺省）：见过 ref 才启用；
 * - `true`：强制启用；
 * - `false`：强制关闭，本包退化为纯「按需技能通道」。
 */
import { acpRefOf } from "./ref-scan.ts";

export class AcpPresence {
	private confirmed = false;

	/** 这一轮的消息里有没有 ACP 的 ref 标签；一旦见过就永久记住（refs 不会中途消失）。 */
	observe(messages: readonly unknown[]): boolean {
		if (this.confirmed) return true;
		// 从末尾往前扫：refs 挂在每条消息上，通常第一条就命中。只在未确认期间付这个成本。
		for (let index = messages.length - 1; index >= 0; index--) {
			if (acpRefOf(messages[index]) !== null) {
				this.confirmed = true;
				break;
			}
		}
		return this.confirmed;
	}

	get seen(): boolean {
		return this.confirmed;
	}

	/** 按配置决定边界提示要不要跑。`"auto"` 等于 `seen`。 */
	enabledFor(mode: "auto" | boolean): boolean {
		if (mode === true) return true;
		if (mode === false) return false;
		return this.confirmed;
	}
}
