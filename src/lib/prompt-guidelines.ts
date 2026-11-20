/**
 * prompt-guidelines.ts — 全局提示词规则的注册。
 *
 * pi 的全局规则面是 `BuildSystemPromptOptions.promptGuidelines`（pi 的
 * `dist/core/system-prompt.d.ts`）。它的基础值恒为空：agent-session 构造基础选项时
 * 不传这个键，所以唯一的写入口是 `before_agent_start` 处理器里的
 * `event.systemPromptOptions.promptGuidelines`（可变 string[]）。
 *
 * 每个扩展各自调用 registerPromptGuidelines() 追加自己的规则，互不知道对方存在；追加是叠加
 * 语义，不会互相覆盖。**不要**改用替换语义——那会抹掉别人已经 push 的内容。
 *
 * 注册表挂在 globalThis 上，**不能**放模块作用域：pi 的扩展加载器
 * （`dist/core/extensions/loader.js` 的 `createJitiImpl(..., { moduleCache: false })`）给每个
 * 扩展一份独立的模块图，同一个文件在两个扩展里就是两个实例——模块级变量不共享，
 * 只有 globalThis 是进程级的。
 */

export type PromptGuidelineSource = {
	/** 注册方名字，用于汇总展示。 */
	source: string;
	/** 该方注册的规则原文，按注册顺序。 */
	lines: readonly string[];
};

type Registry = Map<string, readonly string[]>;

const REGISTRY_KEY = Symbol.for("pi.prompt-guidelines");
const holder = globalThis as unknown as Record<symbol, Registry | undefined>;

const registry: Registry = (holder[REGISTRY_KEY] ??= new Map());

/** 已注册的全局规则，按注册顺序。 */
export function registeredPromptGuidelines(): PromptGuidelineSource[] {
	return Array.from(registry, ([source, lines]) => ({ source, lines }));
}

/**
 * 注册一组全局规则：写进注册表，并挂一个 before_agent_start 处理器把它们追加到
 * 系统提示词的 rules 面。已存在的同一行不会重复追加。
 *
 * **规则必须常驻**：这里没有「只在某状态下才出现」的开关，也不要加。规则面在请求前缀里，
 * 一条时隐时现的规则每切换一次就让前缀缓存整体失效——省下的几十字符远不够赔一次 miss。
 * 规则只在特定状态下才**有意义**时，让它常驻并写成状态中立的句子（“命中的技能只是候选”
 * 在没命中的轮次是一句无人违反的话，不是噪音）。
 */
export function registerPromptGuidelines(
	// 方法写法（不是 `on: (…) => …` 的函数属性）是有意的：方法参数按双变比较，
	// pi 的 `on` 是一组窄事件名的重载，属性写法会因「string 不可赋给 "project_trust"」报 TS2345。
	pi: { on(event: string, handler: (event: any) => unknown): unknown },
	source: string,
	lines: readonly string[],
): void {
	registry.set(source, [...lines]);
	pi.on("before_agent_start", async (event: any) => {
		const target = event?.systemPromptOptions?.promptGuidelines;
		if (!Array.isArray(target)) return;
		for (const line of lines) {
			if (!target.includes(line)) target.push(line);
		}
	});
}
