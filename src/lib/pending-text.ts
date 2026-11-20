/**
 * 「这次请求拿谁的原话去查词表」的纯逻辑（不 import pi、不读盘，便于单测）。
 *
 * ## 为什么必须区分来源
 * `input` 事件带 `source`（`interactive` / `rpc` / `extension`，见 pi 的 `InputSource`）。
 * 前两种是人开口：TUI 敲的、SDK 或 RPC 喂进来的。`extension` 是**别的扩展替人写的话**，
 * 最典型的是 ACP 的限流重试踢一脚（`billion-context-pi/dist/index.js:24455`
 * `pi.sendUserMessage(THROTTLE_KICK_TEXT)`，`source` 由 `agent-session.js:2038` 盖成 `extension`）。
 *
 * ## 不区分的后果
 * 白板只有一个格子，后写的盖掉先写的。用户说了「跑个仿真」，中途限流重试把白板换成那段英文，
 * 之后每个请求都拿英文查词表——`skill-suggest.json` 里一个词都不命中，`<skill-hint>` 在本轮
 * 余下时间里**静默消失**：不是「只提醒一次」，是那个标记被一次看不见的重试抹掉了。
 *
 * ## 为什么只挡「板非空」的扩展写入
 * 纯扩展驱动的 run（自动化、远程桥接）开口时白板本来就是空的，这时扩展的话是唯一线索，
 * 放它进来才不至于让 hint 在无人值守的 run 里彻底失效。真正要挡的窗口很窄：**人已经开口、
 * 这一轮还没结束**。
 *
 * ## 斜杠命令与 `!` 命令
 * `/skill:name`、斜杠命令、`!` shell 命令都不是「用户在描述任务」：展开后是整段技能正文，
 * 扫它必然命中一堆触发词，等于自我实现的噪声。所以这类输入把白板**清空**（而不是保留上句，
 * 免得下一轮又拿旧话去推荐）。
 */
export function nextPendingText(current: string, input: { text: string; source: string }): string {
	// 扩展替人写的话不许盖掉人类原话；板空着时照收（纯自动 run 靠它驱动 hint）
	if (input.source === "extension" && current !== "") return current;
	const trimmed = input.text.trimStart();
	return trimmed.startsWith("/") || trimmed.startsWith("!") ? "" : input.text;
}
