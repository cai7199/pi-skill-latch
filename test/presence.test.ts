// acp/presence.ts：ACP 在场探测。整套压缩边界逻辑只在探测为真时才跑（见 index.ts）。
import assert from "node:assert/strict";
import { test } from "node:test";

import { AcpPresence } from "../src/acp/presence.ts";

const ref = (n: number) => ({ role: "user", content: [{ type: "text", text: `hello\n<acp tokens="10" type="user">m0000${n}</acp>` }] });

test("没有 ref 标签 → 未确认，auto 模式不启用", () => {
	const presence = new AcpPresence();
	assert.equal(presence.observe([{ role: "user", content: "帮我看看上下文" }]), false);
	assert.equal(presence.seen, false);
	assert.equal(presence.enabledFor("auto"), false);
	assert.equal(presence.enabledFor(false), false);
	assert.equal(presence.enabledFor(true), true, "强制启用不看探测结果");
});

test("见过一次 ref 就永久确认", () => {
	const presence = new AcpPresence();
	assert.equal(presence.observe([{ role: "user", content: "hi" }, ref(1)]), true);
	assert.equal(presence.seen, true);
	assert.equal(presence.enabledFor("auto"), true);
	// 后面几轮拿不到 ref（比如全是空消息）也不该退回未确认
	assert.equal(presence.observe([]), true);
	assert.equal(presence.enabledFor("auto"), true);
});

test("ref 只在文本末尾才算（正文里引用的裸编号不算）", () => {
	const presence = new AcpPresence();
	const inline = { role: "user", content: "文档里写的是 m00100，不是标签" };
	assert.equal(presence.observe([inline]), false);
});
