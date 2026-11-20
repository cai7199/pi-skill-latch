// entry-gate.ts：两份实现共存时谁接线的判定表，以及进程级占位。
import assert from "node:assert/strict";
import { test } from "node:test";

import { claimEntry, currentEntry, decideEntry, resetEntryClaim } from "../src/entry-gate.ts";

test("auto + 没人占位：先加载者占位并接线", () => {
	assert.deepEqual(decideEntry({ self: "generic", preference: "auto", claimed: undefined }), {
		run: true,
		claim: "generic",
	});
	resetEntryClaim();
	assert.deepEqual(claimEntry("generic", "auto"), { run: true, claim: "generic" });
	assert.equal(currentEntry(), "generic");
});

test("auto + 对方已占位：让位，不动占位", () => {
	assert.deepEqual(decideEntry({ self: "generic", preference: "auto", claimed: "local" }), {
		run: false,
		reason: "claimed-by-other",
	});
	assert.equal(decideEntry({ self: "generic", preference: "auto", claimed: "local" }).claim, undefined);
});

test("auto + 自己已占位：重复加载也照常跑（不出现双方都让位）", () => {
	assert.deepEqual(decideEntry({ self: "local", preference: "auto", claimed: "local" }), { run: true, claim: "local" });
});

test("显式点名优先于加载顺序：点谁谁跑，另一方让位", () => {
	assert.deepEqual(decideEntry({ self: "generic", preference: "generic", claimed: "local" }), {
		run: true,
		claim: "generic",
	});
	assert.deepEqual(decideEntry({ self: "generic", preference: "local", claimed: undefined }), {
		run: false,
		reason: "preference",
	});
	assert.deepEqual(decideEntry({ self: "local", preference: "generic", claimed: "local" }), {
		run: false,
		reason: "preference",
	});
});

test("显式点名时也占位：后加载的另一方看到的是合法状态", () => {
	resetEntryClaim();
	const first = claimEntry("local", "generic");
	assert.deepEqual(first, { run: false, reason: "preference" });
	assert.equal(currentEntry(), undefined, "让位的一方不该占位");

	const second = claimEntry("generic", "generic");
	assert.deepEqual(second, { run: true, claim: "generic" });
	assert.equal(currentEntry(), "generic");
	resetEntryClaim();
});

test("两种模式都不会出现「双方都跑」或「双方都让位」", () => {
	const modes = ["auto", "local", "generic"] as const;
	for (const preference of modes) {
		for (const order of [
			["local", "generic"],
			["generic", "local"],
		] as const) {
			resetEntryClaim();
			const runs = order.map((self) => claimEntry(self, preference).run);
			assert.equal(runs.filter(Boolean).length, 1, `${preference} / ${order.join("→")} 应当恰好一个跑，实际 ${runs}`);
		}
	}
	resetEntryClaim();
});
