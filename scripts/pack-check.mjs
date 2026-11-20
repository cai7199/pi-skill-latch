// 发布前自检：把**打出来的 tgz**装进一个干净目录，再用 pi 同款加载器跑起来。
//
// 为什么要有这一步：开发树能跑不代表装到别人机器上能跑。发布物会经历三件开发树里没有的事——
//   1. 文件进 `node_modules/`：Node 22 的原生 type stripping 拒绝 `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`；
//   2. 只保证 `files` 白名单里的文件存在（源码、LICENSE、示例配置，少一个就缺块）；
//   3. 依赖靠 `peerDependencies` 解析（`typebox` 来自安装树，不是包内）。
// 所以这里不用 `--extension ./src/index.ts`，而是 `npm pack` → `npm install <tgz>` → 从**装出来的那份**
// 加载，加载器用 pi 自己的 jiti（见 pi 的 `dist/core/extensions/loader.js:486`）——它转译 TS，
// 不受上面第 1 条限制，正是 pi 运行时的真实路径。
//
// 用法：node scripts/pack-check.mjs [--keep]
//   --keep  保留临时目录（排查时看装出来的文件）
// 退出码 0 = 打包产物可加载、可接线、工具可查；非 0 = 指向具体断点。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const keep = process.argv.includes("--keep");

/** 用当前这份 Node 自带的 npm，不走 PATH（便携安装里没有全局 npm）。 */
function npm(args, cwd) {
	const runtime = dirname(process.execPath);
	const portable = join(runtime, "node_modules", "npm", "bin", "npm-cli.js");
	const [exe, argv] = existsSync(portable) ? [process.execPath, [portable, ...args]] : ["npm", args];
	const result = spawnSync(exe, argv, { cwd, encoding: "utf8", shell: process.platform === "win32" && exe === "npm" });
	if (result.status !== 0) {
		process.stderr.write(result.stdout ?? "");
		process.stderr.write(result.stderr ?? "");
		throw new Error(`npm ${args.join(" ")} 失败（exit ${result.status}）`);
	}
	return result.stdout ?? "";
}

const tmp = mkdtempSync(join(tmpdir(), "pi-skill-latch-pack-"));
const step = (text) => console.log(`• ${text}`);

try {
	step(`打包到 ${tmp}`);
	const packed = npm(["pack", "--pack-destination", tmp, "--json"], packageDir);
	const meta = JSON.parse(packed)[0];
	console.log(`  ${meta.filename}  ${meta.entryCount} 文件  ${(meta.size / 1024).toFixed(1)} KB`);
	const required = ["LICENSE", "README.md", "CHANGELOG.md", "skill-suggest.example.json", "src/index.ts"];
	const missing = required.filter((path) => !meta.files.some((file) => file.path === path));
	if (missing.length > 0) throw new Error(`包里缺文件：${missing.join(", ")}`);

	step("装进干净目录（peer 依赖按 npm 默认解析）");
	npm(["install", "--no-save", "--no-audit", "--no-fund", join(tmp, meta.filename)], tmp);
	const installed = join(tmp, "node_modules", "pi-skill-latch");
	if (!existsSync(join(installed, "src", "index.ts"))) throw new Error(`装出来没有入口：${installed}`);
	if (!existsSync(join(tmp, "node_modules", "typebox"))) {
		console.log("  ! typebox 不在安装树里——真实用户那侧会在 import 时炸");
	}

	// 自检脚本写到临时目录里跑：它要 `import { createJiti } from "jiti"`，
	// 而 jiti 由安装树提供（pi 的依赖）；放在本仓 scripts/ 下解析不到。
	const harness = `import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const mod = await jiti.import(${JSON.stringify(join(installed, "src", "index.ts"))});
assert.equal(typeof mod.default, "function", "默认导出不是扩展函数");

const dir = mkdtempSync(join(tmpdir(), "sl-artifact-"));
const skillDir = join(dir, "skills", "demo-skill");
mkdirSync(skillDir, { recursive: true });
const skillPath = join(skillDir, "SKILL.md");
writeFileSync(skillPath, "# demo-skill\\n\\ndescription: \\"Simulate circuits.\\"\\n\\nRun the simulation.\\n", "utf8");
const configPath = join(dir, "skill-latch.json");
writeFileSync(configPath, JSON.stringify({ settings: {}, "demo-skill": ["仿真"] }), "utf8");
process.env.SKILL_LATCH_CONFIG = configPath;
delete process.env.SKILL_LATCH_NATIVE_SKILL_LIST;
delete process.env.SKILL_LATCH_DEBUG;

const handlers = new Map();
const tools = [];
await mod.default({
	on(event, handler) {
		const list = handlers.get(event) ?? [];
		list.push(handler);
		handlers.set(event, list);
		return () => {};
	},
	registerTool(spec) {
		tools.push(spec);
		return () => {};
	},
});

console.log("  hooks:", [...handlers.keys()].sort().join(","));
console.log("  tools:", tools.map((t) => t.name).join(","));
assert.ok(tools.some((t) => t.name === "search_skills"), "search_skills 没注册");
assert.ok(handlers.size >= 3, "钩子没接上");

let messages = [{ role: "system", content: "prompt" }];
const run = async (event, payload) => {
	let current = payload;
	for (const handler of handlers.get(event) ?? []) {
		const result = await handler(current);
		if (result && typeof result === "object" && "messages" in result) current = { ...current, messages: result.messages };
	}
	return current;
};
const start = await run("before_agent_start", {
	systemPromptOptions: {
		skills: [{ name: "demo-skill", description: "Simulate circuits.", filePath: skillPath, baseDir: "" }],
		promptGuidelines: [],
	},
});
assert.deepEqual(start.systemPromptOptions?.skills ?? [], [], "原生技能清单没被摘掉");
await run("input", { text: "帮我跑个仿真", source: "interactive" });
const out = await run("context_with_system", { messages });
const textOf = (content) =>
	typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => (p?.type === "text" ? p.text : "")).join("") : "";
const injected = (out.messages ?? []).map((m) => textOf(m.content)).join("\\n");
assert.ok(injected.includes("<skill-hint>"), "没有注入 <skill-hint>");
assert.ok(injected.includes("demo-skill"), "提醒里没有词表命中的技能");

const spec = tools.find((t) => t.name === "search_skills");
const resultText = textOf((await spec.execute("call-1", { query: "仿真" }))?.content);
assert.ok(resultText.includes("demo-skill"), "search_skills 查不到技能");

console.log("  hint ok / tool ok");
rmSync(dir, { recursive: true, force: true });
`;
	writeFileSync(join(tmp, "pack-check-harness.mjs"), harness, "utf8");
	step("用 jiti（pi 的加载器）加载装出来的这份");
	const runResult = spawnSync(process.execPath, [join(tmp, "pack-check-harness.mjs")], { cwd: tmp, encoding: "utf8" });
	process.stdout.write(runResult.stdout ?? "");
	process.stderr.write(runResult.stderr ?? "");
	if (runResult.status !== 0) throw new Error("加载冒烟失败（见上面的断言）");

	console.log(`PACK CHECK OK — ${meta.filename}`);
} catch (error) {
	console.error(`PACK CHECK FAILED — ${error.message}`);
	console.error(`临时目录保留在 ${tmp}（失败排查用，确认后可删；--keep 让成功时也保留）`);
	process.exitCode = 1;
} finally {
	if (!keep && process.exitCode !== 1) {
		spawnSync(process.execPath, ["-e", `require("node:fs").rmSync(${JSON.stringify(tmp)},{recursive:true,force:true,maxRetries:3})`], {
			encoding: "utf8",
		});
	} else if (keep) {
		console.log(`临时目录：${tmp}`);
	}
}
