/**
 * 关键词检索的纯逻辑（不 import pi、不 import typebox、不读盘，便于单测）。
 *
 * 从 `search-tool.ts` 里拆出来的唯一理由：工具定义要 `import { Type } from "typebox"`，而
 * typebox 是宿主提供的 peer 依赖——单测和 CLI 里假设宿主不在，纯逻辑就必须能独立加载。
 * 工具定义（schema、描述、结果渲染）留在 `search-tool.ts`。
 *
 * ## 匹配语义：与 `<skill-hint>` 同一套规则
 * 命中面 = 技能名 + description + 词表触发词，拼成一个 haystack；query 按空白切词、
 * 大小写归一、去重，逐词用 `matchesTrigger` 匹配——ASCII 词落在词边界上（`spec` 不命中
 * `spectre`），中文按子串。词表触发词进命中面，是因为 description 常是英文而查询常是中文：
 * 「仿真」搜的不是描述文本，是词表里人写好的中文触发词。复用同一套规则而不是另写一套：
 * 两处若漂移，同一个词在「用户说出来」（hint）与「模型搜出来」（本模块）两条路上会给出
 * 不同答案。
 */
import { matchesTrigger, skillDirName, triggersForSkill, type SkillRef, type TriggerMap } from "./suggest.ts";

/** 搜出来的命中条目：`matched` 只用来排序与报数，词本身不进结果（hint 同一条纪律）。 */
export interface SearchHit extends SkillRef {
	matched: string[];
}

/** 切词：按空白拆、小写归一、去重。匹配与「全表意图」判定共用一份切法，两边永不漂移。 */
export function tokenizeQuery(query: string): string[] {
	return [...new Set(query.trim().toLowerCase().split(/\s+/).filter(Boolean))];
}

/** 枚举意图词：模型想要全表时最可能误发成的关键词写法。只列高频写法——生僻的交给 0 命中
 *  文案现场去教，词表越宽越容易把正常搜索误归成全表（宁可漏报）。 */
const ENUMERATION_WORDS = new Set([
	"all",
	"every",
	"everything",
	"list",
	"full",
	"skill",
	"skills",
	"全部",
	"所有",
	"全表",
	"清单",
	"技能",
	"所有技能",
	"全部技能",
	"技能清单",
]);

/** 整条 query 都是枚举意图词（且非空）→ 全表意图；混进任何一个真关键词则照常搜索。 */
export function isEnumerationQuery(tokens: readonly string[]): boolean {
	return tokens.length > 0 && tokens.every((token) => ENUMERATION_WORDS.has(token));
}

/**
 * query 经 `tokenizeQuery` 切词，逐技能扫「名字 + description + 触发词」拼成的 haystack；
 * 命中词数降序、稳定排序（同分时保持清单原序，结果可复现，单测才写得死）。不在内部截上限：
 * 截不截、截多少、截断怎么报，是展示策略，归调用方（工具定义）管；纯函数只回答
 * 「命中了谁、多强」。
 *
 * 没配词表的技能不报错——名字与描述两条命中面还在；`triggersForSkill` 的名字兜底也参与，
 * 所以「spectre」这类长名不配词也能被搜到。
 */
export function searchSkills(input: { query: string; skills: readonly SkillRef[]; triggers: TriggerMap }): SearchHit[] {
	const tokens = tokenizeQuery(input.query);
	if (tokens.length === 0) return [];
	const hits: SearchHit[] = [];
	for (const skill of input.skills) {
		const dirName = skillDirName(skill.filePath);
		const name = skill.name || dirName;
		if (!name) continue;
		// 不传 `noName`：搜索是模型主动轮询，名字被 `noname` 关掉的技能也该搜得到——那个开关只管
		// 自动提醒（用户原文里撞到常用词），管不到「我要找 X 那个技能」。
		const haystack = [name, skill.description ?? "", ...triggersForSkill(skill, input.triggers)].join(" ");
		const matched = tokens.filter((token) => matchesTrigger(haystack, token));
		if (matched.length === 0) continue;
		hits.push({ name, description: skill.description, filePath: skill.filePath, matched });
	}
	return hits.sort((a, b) => b.matched.length - a.matched.length);
}
