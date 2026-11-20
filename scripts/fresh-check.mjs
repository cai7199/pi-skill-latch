// 陌生用户视角自检：一个新装的 Pi，只把本包写进 settings.json，能不能真的用起来。
//
// 与 pack-check 的分工：
//   pack-check  —— 打包产物能不能被加载器吃下去（jiti + 桩 API，不需要凭据）
//   fresh-check —— 换成**空的 agent 目录**后的完整启动：pi 自己发现包、自己加载、词表生效、
//                  真模型调得动 search_skills（这一档必须真起一次 pi，因此可选地要一份凭据）
//
// 用法：
//   node scripts/fresh-check.mjs                 # 不碰凭据，只验证“空 profile 里装得起来”
//   node scripts/fresh-check.mjs --auth <path>   # 追加一轮真对话（凭据会被**复制**到临时目录）
//   node scripts/fresh-check.mjs --pi <cli.js>   # 指定 pi 的 cli.js（默认用临时安装里那份）
//   node scripts/fresh-check.mjs --keep          # 保留临时目录
//
// 凭据为什么不读内容：只做 copyFile，脚本从不解析、不打印、不落日志；临时目录用完即删。
// 这也是为什么它不接 `--api-key`：命令行参数会进 shell 历史。
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const flag = (name) => {
	const index = argv.indexOf(name);
	return index >= 0 ? argv[index + 1] : undefined;
};
const keep = argv.includes("--keep");
const authPath = flag("--auth");
const piCliArg = flag("--pi");
const model = flag("--model") ?? "agnes-3.0-flash";
const provider = flag("--provider") ?? "agnes";

const step = (text) => console.log(`• ${text}`);
const fail = (message) => {
	throw new Error(message);
};

function npm(args, cwd) {
	const runtime = dirname(process.execPath);
	const portable = join(runtime, "node_modules", "npm", "bin", "npm-cli.js");
	const [exe, argv] = existsSync(portable) ? [process.execPath, [portable, ...args]] : ["npm", args];
	const result = spawnSync(exe, argv, { cwd, encoding: "utf8" });
	if (result.status !== 0) fail(`npm ${args.join(" ")} 失败（exit ${result.status}）\n${result.stderr ?? ""}`);
	return result.stdout ?? "";
}

const tmp = mkdtempSync(join(tmpdir(), "pi-skill-latch-fresh-"));
try {
	step(`打包 → ${tmp}`);
	const meta = JSON.parse(npm(["pack", "--pack-destination", tmp, "--json"], packageDir))[0];

	step("装进一个假项目（模拟 npm 安装后的 node_modules）");
	const project = join(tmp, "project");
	mkdirSync(project, { recursive: true });
	npm(["install", "--no-save", "--no-audit", "--no-fund", join(tmp, meta.filename)], project);
	const installed = join(project, "node_modules", "pi-skill-latch");

	const piCli = piCliArg ?? join(project, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
	if (!existsSync(piCli)) fail(`找不到 pi 的 cli.js：${piCli}（用 --pi 指定）`);

	// 空的 agent 目录：没有旧配置、没有本地版、没有 ACP。只有本包 + 一份词表 + 一个技能。
	const agentDir = join(tmp, "agent");
	mkdirSync(join(agentDir, "skills", "demo-skill"), { recursive: true });
	writeFileSync(
		join(agentDir, "skills", "demo-skill", "SKILL.md"),
		'---\nname: demo-skill\ndescription: "Simulate circuits for the fresh-install check."\n---\n\nRun the simulation.\n',
		"utf8",
	);
	writeFileSync(join(agentDir, "skill-latch.json"), JSON.stringify({ settings: {}, "demo-skill": ["仿真"] }), "utf8");
	const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
	const run = (args) => spawnSync(process.execPath, [piCli, ...args], { cwd: project, env, encoding: "utf8" });

	// 直接用 cli.js + PI_CODING_AGENT_DIR：绕开便携版包装器（它会把自己的 profile 钉死）。
	step("用户会敲的那条命令：pi install <目录>");
	const settingsPath = join(agentDir, "settings.json");
	const install = run(["install", installed]);
	if (install.status !== 0) fail(`pi install 失败（exit ${install.status}）\n${install.stdout ?? ""}${install.stderr ?? ""}`);
	if (!existsSync(settingsPath)) fail("pi install 没写出 settings.json");
	const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
	// 注意：pi 存的是相对 agentDir 的路径，不能按字符串比
	const sameDir = (a) => resolve(agentDir, String(a)).toLowerCase();
	if (!(settings.packages ?? []).some((p) => sameDir(p) === sameDir(installed))) {
		fail(`settings.json 里没有刚装的包：${JSON.stringify(settings.packages)}`);
	}
	console.log(`  settings.json packages: ${JSON.stringify(settings.packages)}`);
	settings.defaultProvider = provider;
	settings.defaultModel = model;
	settings.defaultProjectTrust = "always";
	writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");

	step("pi 在自己的发现流程里认得这个包吗");
	const listed = run(["list"]);
	const listOut = `${listed.stdout ?? ""}${listed.stderr ?? ""}`;
	if (!listOut.includes(installed)) fail(`pi list 里没有 ${installed}\n${listOut}`);
	console.log("  pi list: 命中");

	step("空 profile 里启动一次（不带工具，不花模型调用）");
	const version = run(["--version"]);
	if (version.status !== 0) fail(`pi --version 失败：${version.stderr ?? ""}`);
	console.log(`  pi --version: ${(version.stdout ?? "").trim()}`);

	if (!authPath) {
		console.log("FRESH CHECK OK（未验证真对话：加 --auth <凭据文件> 可补那一轮）");
	} else {
		if (!existsSync(authPath)) fail(`凭据文件不存在：${authPath}`);
		copyFileSync(authPath, join(agentDir, "auth.json")); // 只复制，不读内容
		step("真对话：让模型调 search_skills");
		const turn = run([
			"--no-context-files",
			"--no-session",
			"--mode",
			"json",
			"-p",
			'Call the search_skills tool with query "仿真", then quote its raw output verbatim.',
		]);
		const out = `${turn.stdout ?? ""}${turn.stderr ?? ""}`;
		if (/Failed to load extension/i.test(out)) fail(`有扩展加载失败：\n${out.slice(0, 2000)}`);
		if (!/"name"\s*:\s*"search_skills"/.test(out)) fail(`模型这一轮没调到 search_skills：\n${out.slice(0, 2000)}`);
		if (!out.includes("demo-skill")) fail(`search_skills 没返回刚声明的技能：\n${out.slice(0, 2000)}`);
		console.log("  search_skills 调用 + 命中 demo-skill");
		console.log("FRESH CHECK OK（含真对话）");
	}
} catch (error) {
	console.error(`FRESH CHECK FAILED — ${error.message}`);
	console.error(`临时目录保留在 ${tmp}（失败排查用，确认后可删；--keep 让成功时也保留）`);
	process.exitCode = 1;
} finally {
	if (!keep && process.exitCode !== 1) {
		spawnSync(process.execPath, ["-e", `require("node:fs").rmSync(${JSON.stringify(tmp)},{recursive:true,force:true,maxRetries:3})`]);
	} else if (keep) {
		console.log(`临时目录：${tmp}`);
	}
}
