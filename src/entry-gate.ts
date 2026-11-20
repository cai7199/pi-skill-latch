/**
 * entry-gate.ts — 同一台机器上同时存在「本机特化版」与本包时，谁真正接线（纯逻辑，便于单测）。
 *
 * ## 为什么需要
 * 两份实现都注册 `search_skills`、都往请求里注入 `<skill-hint>`、都在 `before_agent_start`
 * 里清原生清单。同时跑就是重复注册 + 双份注入 + 清两遍，症状还是静默的那种。所以加载期先分
 * 胜负，只有一个继续注册钩子。
 *
 * ## 判据顺序
 * 1. 配置 `settings.entry` 显式点名（`"local"` / `"generic"`）→ 按配置，另一方直接让位；
 * 2. `"auto"`（缺省）→ **先加载者占位**。所以 settings 里 `packages` 的顺序就是优先级：
 *    特化版排在前面，于是缺省仍跑特化版。
 *
 * ## 为什么用 globalThis
 * pi 给每个扩展一份独立的模块图（loader 的 `moduleCache: false`），模块级变量不共享；而
 * globalThis 是进程级的（`lib/prompt-guidelines.ts` 用同一招）。两边用同一个 `Symbol.for` 键，
 * 于是这两个包在互不知道对方存在的前提下也能分胜负。
 *
 * ## 单独成文件的理由
 * 与 `lib/` 其余模块同约定：不 import pi、不读盘、不读 env，判定全是入参，单测直接喂。
 * 特化版（本机那份）里有一份**镜像**：两份包必须能各自独立安装，共享不了代码。
 * 改这里的判据要同时改那边，两侧各有测试钉住同样的用例。
 */

/** 哪一份实现。`local` = 本机特化版，`generic` = 本包。 */
export type EntryKind = "local" | "generic";

/** 配置里的选择：`auto` 表示「先加载者占位」。 */
export type EntryPreference = "auto" | EntryKind;

const CLAIM = Symbol.for("pi.skill-latch.entry");

interface ClaimHolder {
	[CLAIM]?: EntryKind;
}

export interface EntryDecision {
	/** 本份实现是否继续接线。 */
	run: boolean;
	/**
	 * 调用方应当写回的占位值；`undefined` 表示「不要动」。
	 * 显式点名时也要占位，好让后加载的另一方看到「位置已被合法占用」。
	 */
	claim?: EntryKind;
	/** 让位的原因（调用方据此决定要不要打一行日志）。 */
	reason?: "preference" | "claimed-by-other";
}

/**
 * 纯判定：给「我是谁 / 用户选了什么 / 现在谁占着位」返回「跑不跑 / 要不要占位」。
 *
 * 显式点名优先于占位，所以配置能推翻加载顺序；`auto` 时占位者赢，后来者让位。
 * 两份实现看到的是同一份配置，因此不会出现「双方都让位」或「双方都跑」。
 */
export function decideEntry(input: {
	self: EntryKind;
	preference: EntryPreference;
	claimed: EntryKind | undefined;
}): EntryDecision {
	const { self, preference, claimed } = input;
	if (preference !== "auto") {
		if (preference === self) return { run: true, claim: self };
		return { run: false, reason: "preference" };
	}
	if (claimed === undefined) return { run: true, claim: self };
	if (claimed === self) return { run: true, claim: self };
	return { run: false, reason: "claimed-by-other" };
}

/** 读当前占位者（进程级）。 */
export function currentEntry(): EntryKind | undefined {
	return (globalThis as unknown as ClaimHolder)[CLAIM];
}

/**
 * 判定并在需要时占位。**必须在任何 `await` 之前调用**：两份实现都是 `async` 函数，占位晚一步
 * 就可能被对方插进来，加载顺序就失效了。
 */
export function claimEntry(self: EntryKind, preference: EntryPreference): EntryDecision {
	const decision = decideEntry({ self, preference, claimed: currentEntry() });
	if (decision.claim !== undefined) (globalThis as unknown as ClaimHolder)[CLAIM] = decision.claim;
	return decision;
}

/** 清掉占位。只给测试用——生产里占位就该跟着进程活到底。 */
export function resetEntryClaim(): void {
	delete (globalThis as unknown as ClaimHolder)[CLAIM];
}
