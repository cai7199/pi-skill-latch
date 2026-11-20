/**
 * `search_skills` 的工具定义：把「按需拿技能清单」从整表倾倒改成关键词检索。
 *
 * ## 为什么需要它
 * 原生 `<available_skills>` 是 O(技能数) 的常驻开销，已被摘掉（见 `index.ts` 的
 * `before_agent_start`）。取代它的 `list_skills` 把整表一次性倒进上下文——十几个技能约 1K
 * token，而模型来问的时刻几乎总是手上有一个具体任务：它要的是「跟这个任务相关的两三条」，
 * 不是全表。搜索把这次调用的成本从「全表」压到「命中条目」，全表降级为显式逃生口
 * （省略关键词时才给）。
 *
 * ## 匹配语义：与 `<skill-hint>` 同一套规则
 * 命中面 = 技能名 + description + 词表触发词，拼成一个 haystack；query 按空白切词、
 * 大小写归一、去重，逐词用 `matchesTrigger` 匹配——ASCII 词落在词边界上（`spec` 不命中
 * `spectre`），中文按子串。词表触发词进命中面，是因为 description 是英文而查询常是中文：
 * 「仿真」搜的不是描述文本，是词表里人写好的中文触发词。复用同一套规则而不是另写一套：
 * 两处若漂移，同一个词在「用户说出来」（hint）与「模型搜出来」（本工具）两条路上会给出
 * 不同答案。
 *
 * ## 为什么 0 命中要给自救指引
 * 一次空手而归的代价不是 token，是模型据此得出「没有相关技能」的错误结论。指引只有一句：
 * 换词再搜，或不带关键词拿全表——后者是唯一不会漏的兜底（教人自救一次，好过它再也不来问）。
 *
 * ## 为什么省略 query 仍给全表
 * 「把所有技能过一遍」这类盘点任务确实要全表；搜索失败后的兜底也要它。外层标签沿用
 * 原生 `<available_skills>`，形状一致，模型不必重新学怎么读——这一点继承自 `list_skills`。
 *
 * ## 为什么「all / 全部」这类枚举词也当全表（引擎侧兜底）
 * 全表意图最常见的误发是拿关键词当接口用（query 填 "all"、"所有技能"）。这类词单独出现时
 * 本来就匹配不出有意义的结果，与其让它吃一次 0 命中再学一遍「省略 query」，不如在引擎侧
 * 容忍归一（强度阶梯的 tolerant normalization 一档）：整条 query 都是枚举意图词就按全表办。
 * 词表收得很紧，混进任何真关键词（"all spectre"）则照常搜索——宁可漏掉生僻写法让 0 命中文案
 * 现场去教，也不把正常搜索误归成全表。
 *
 * ## 为什么 L1 要写明「什么时候来问」与「省略 = 全表」
 * 摘掉清单的代价是模型不再被动知道「装了哪些技能」，描述只说「搜索技能」就永远不会被调用。
 * 所以说清三件事：什么时候该问（任务看着像专门的活，而这一轮没有 `<skill-hint>`）、
 * 拿到什么（只回命中条目）、以及省略关键词就是全表。不另加 `<rules>`：这些只在工具被选中
 * 之前有用，是 L1 的位置，不是 L0 的。
 *
 * ## 审查后刻意不写的（按 prompt-schema-contract 减脂）
 * 排序（strongest first）不进 L1：强弱在结果里当场可见（`<matched-keywords>` 加顺序），
 * 调用前无需知道；「省略 = 全表」不在 L3 再复述一遍：schema 的 `Optional` 已允许省略，
 * 语义 L1 说过，双写是同一句房租交两份——剪掉后想拿全表却填了枚举词的误发由上面的引擎兜底接住。
 */
import { Type } from "typebox";

import { formatSkillsBlock } from "./skill-format.ts";
import { isEnumerationQuery, searchSkills, tokenizeQuery } from "./search-match.ts";
import { COMPRESS_BEFORE_READ, READ_IN_FULL, type SkillRef, type TriggerMap } from "./suggest.ts";

/** 工具名。提醒文案与测试都引它，改名只改这里。 */
export const SEARCH_TOOL_NAME = "search_skills";

/** 关键词命中结果的外层标签：与全表（`available_skills`）、提醒（`skill-hint`）区分——这一份
 *  是「按这个查询挑出来的」，信任级别不同；内层结构三者一致，模型只学一套读法。 */
export const SEARCH_TAG = "matching_skills";

/** 全表的外层标签用 Pi 原生那一个：形状一致，模型不必重新学怎么读。 */
export const LIST_TAG = "available_skills";

/** 一次搜索最多回几条。上限管的是过泛关键词（一个单字中文词能点亮半张表）把搜索变成变相
 *  全表；截断时 lead 里报「8 之几」，模型自然收紧词。 */
export const MAX_SEARCH_RESULTS = 8;

/**
 * L1 描述：什么时候来问、命中面（名字/描述/作者触发词，含中文）、边界（省略 query = 全表）。
 * 不写「只回命中」：结果形状一眼可见，调用前推不出代价这件事在这里不成立（工具轻、必然返回）。
 * 不写排序：强弱在结果里当场可见（见头部「审查后刻意不写的」）。
 * 压缩史：213 → 204 → 154 字符，删的都是「删掉不改变调用」的句子。
 */
export const SEARCH_TOOL_DESCRIPTION =
	"Use when a specialized task gets no `<skill-hint>`. Keywords OR'd over names, descriptions and author triggers (Chinese works); no query lists all skills.";

/** 两个分支共用的 lead：读法与压缩半句拼的是 `suggest.ts` 里同一对常量——「加载时」通道的
 *  读法只留一份源，改一处不漏两处。 */
const MATCHING_LEAD = `${READ_IN_FULL} when its <description> matches the task. ${COMPRESS_BEFORE_READ}`;

/** 0 命中的自救指引。工具名走常量，改名时这里跟着走。 */
function noMatchText(query: string): string {
	return `no skills match '${query}'. Try other keywords, or call ${SEARCH_TOOL_NAME} with no query to list every skill.`;
}

export interface SearchToolResult {
	content: { type: "text"; text: string }[];
	details: { count: number };
}

/** 纯匹配逻辑已拆到 `search-match.ts`（不依赖 typebox，可单测）；本文件只管工具定义与渲染。 */

/**
 * `getSkills` / `getTriggers` 用 getter 而不是快照：清单每轮由 `before_agent_start` 刷新，
 * 工具在加载期注册，拿值会永远停在注册那一刻的空数组上；词表虽只在启动读一次，取同一形状
 * 免得将来加热重载时踩同一个坑。
 *
 * `details.count`：全表分支 = 清单长度（模型能看见的）；查询分支 = 命中总数（截断前）——
 * 截断与否模型从 lead 那句读，count 留给测试与渲染钉行为。
 */
export function searchToolSpec(getSkills: () => readonly SkillRef[], getTriggers: () => TriggerMap) {
	return {
		name: SEARCH_TOOL_NAME,
		label: "Search skills",
		description: SEARCH_TOOL_DESCRIPTION,
		parameters: Type.Object({
			query: Type.Optional(
				Type.String({ description: "Keywords separated by spaces." }),
			),
		}),
		async execute(_toolCallId: string, params?: { query?: string }): Promise<SearchToolResult> {
			const skills = getSkills();
			if (skills.length === 0) {
				return { content: [{ type: "text", text: "no skills are loaded." }], details: { count: 0 } };
			}
			const query = typeof params?.query === "string" ? params.query.trim() : "";
			// 全表意图两道门：省略/空 query（盘点任务与兜底走这里），以及整条 query 都是枚举词
			// （all / 全部……引擎侧容忍归一，见头部「为什么枚举词也当全表」）。外层标签沿用原生形状。
			const tokens = tokenizeQuery(query);
			if (tokens.length === 0 || isEnumerationQuery(tokens)) {
				const text = formatSkillsBlock(LIST_TAG, skills, MATCHING_LEAD) || "no skills are loaded.";
				return { content: [{ type: "text", text }], details: { count: skills.length } };
			}
			const matched = searchSkills({ query, skills, triggers: getTriggers() });
			if (matched.length === 0) {
				return { content: [{ type: "text", text: noMatchText(query) }], details: { count: 0 } };
			}
			const hits = matched.slice(0, MAX_SEARCH_RESULTS);
			const lead =
				matched.length > hits.length
					? `${MATCHING_LEAD} Showing ${hits.length} of ${matched.length} matching skills.`
					: MATCHING_LEAD;
			const entries = hits.map(({ name, description, filePath, matched: words }) => ({
				name,
				description,
				filePath,
				matches: words.length,
			}));
			const text = formatSkillsBlock(SEARCH_TAG, entries, lead);
			return { content: [{ type: "text", text }], details: { count: matched.length } };
		},
	};
}
