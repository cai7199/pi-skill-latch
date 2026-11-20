/**
 * audit-triggers.ts — 独立 CLI：扫技能目录 + 读配置，报「按需通道会不会失明」。
 *
 * 摘掉原生 `<available_skills>` 后，一个技能能不能被 `<skill-hint>` 自动点名，取决于它有没有
 * 有效触发词。加新技能忘了配词 → 它静默隐形，只剩 `search_skills` 一条路。本脚本把这件事
 * 变成事前报警：ERROR（有效触发集为空）给非零退出码，可挂 CI；WARN（只剩名字兜底）默认只打印。
 *
 * 另外两张名单一起报：词表里对不上已装技能的 key（ORPHAN），以及 `companion` 里永远不会生效的
 * 伴随边（源 / 同伴没装、或 `only` 的词不在源技能的有效触发集里）——后两者在运行时都是静默丢掉，
 * 不报错，只能在这里看见。
 *
 * 判据全在 `../src/lib/trigger-audit.ts`（纯逻辑，不 import pi、不读盘，单测见
 * `test/trigger-audit.test.ts`）。本文件只负责「从哪拿技能清单、从哪拿配置」的胶水。
 *
 * 用法：
 *   node --experimental-strip-types bin/audit-triggers.ts [选项]
 *     --config <path>   配置文件路径（缺省 <agentDir>/skill-latch.json）
 *     --root <dir>...   技能根目录，扫 <dir>/<name>/SKILL.md；可多个
 *     --strict          WARN 也报非零退出码（默认只有 ERROR 阻断）
 *
 * 不给 `--root` 时扫 pi 的标准技能位置：`<agentDir>/skills`、`<cwd>/.pi/skills`、
 * `~/.agents/skills`、`<cwd>/.agents/skills`。包自带的技能（第三方包在 `package.json` 里声明的）
 * 不在默认范围，否则就要靠猜别人的目录结构；要查它们就把那个目录作为 `--root` 传进来。
 * 不硬编码任何盘符或安装布局——本脚本可以待在任何位置。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { agentDir, configFile } from "../src/config.ts";
import {
	MIN_FALLBACK_NAME_LENGTH,
	normalizeCompanion,
	normalizeNoName,
	normalizeTriggers,
	type CompanionMap,
	type SkillRef,
} from "../src/lib/suggest.ts";
import {
	auditSkills,
	findCompanionProblems,
	findOrphanTriggerKeys,
	findPresetProblems,
	type CompanionProblem,
	type PresetProblem,
	type SkillAudit,
} from "../src/lib/trigger-audit.ts";

interface CliArgs {
	config: string;
	roots: string[];
	strict: boolean;
}

function parseArgs(argv: string[], env: Record<string, string | undefined>, cwd: string): CliArgs {
	const args: CliArgs = { config: configFile(env), roots: [], strict: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--config") args.config = resolve(argv[++i]);
		else if (arg === "--root") {
			// 连取到下一个非 -- 开头的 token 为止，支持一次给多个根。
			while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) args.roots.push(resolve(argv[++i]));
		} else if (arg === "--strict") args.strict = true;
	}
	if (args.roots.length === 0) args.roots = defaultRoots(env, cwd);
	return args;
}

/** 扫 <root>/<name>/SKILL.md，收成 `SkillRef`。`name` 取目录名——词表就是按这个名字/目录名挂的。 */
function discoverSkills(roots: string[]): SkillRef[] {
	const found = new Map<string, SkillRef>();
	for (const root of roots) {
		if (!existsSync(root) || !statSync(root).isDirectory()) continue;
		for (const entry of readdirSync(root)) {
			const skillMd = join(root, entry, "SKILL.md");
			if (existsSync(skillMd) && statSync(skillMd).isFile()) {
				found.set(skillMd, { name: entry, filePath: skillMd });
			}
		}
	}
	return [...found.values()];
}

/** pi 的标准技能位置（与 pi 的 `loadSkills` 同一套缺省）：用户级 + 项目级 + Agent Skills 约定位置。 */
function defaultRoots(env: Record<string, string | undefined>, cwd: string): string[] {
	return [
		join(agentDir(env), "skills"),
		resolve(cwd, ".pi", "skills"),
		join(homedir(), ".agents", "skills"),
		resolve(cwd, ".agents", "skills"),
	].filter((root) => existsSync(root));
}

/** 打印一份报告；返回该让进程退出码是几。 */
function report(
	audits: SkillAudit[],
	orphans: string[],
	problems: CompanionProblem[],
	presetProblems: PresetProblem[],
	roots: string[],
	strict: boolean,
): number {
	const byTier: Record<SkillAudit["tier"], SkillAudit[]> = { ok: [], warn: [], error: [], muted: [] };
	for (const a of audits) byTier[a.tier].push(a);

	console.log(`skill-latch trigger audit\n  roots : ${roots.join(" ") || "(none)"}\n  skills: ${audits.length}`);

	if (byTier.error.length > 0) {
		console.log(`\nERROR — no effective trigger, unreachable from <skill-hint> (search_skills only):`);
		for (const a of byTier.error) {
			const why =
				a.inNoName ? "name in `noname`" : a.nameTooShort ? `name < ${MIN_FALLBACK_NAME_LENGTH} chars` : "no trigger configured";
			console.log(`  ${a.display.padEnd(24)} ${a.filePath}  (${why})`);
		}
	}
	if (byTier.warn.length > 0) {
		console.log(`\nWARN — only the bare skill name matches; add curated trigger words:`);
		for (const a of byTier.warn) {
			console.log(`  ${a.display.padEnd(24)} fallback name: ${a.effective.join(", ")}`);
		}
	}
	if (orphans.length > 0) {
		console.log(`\nORPHAN — configured in the word list but no installed skill matches:`);
		for (const key of orphans) console.log(`  ${key}`);
		console.log(`  (third-party packages ship their own skills; add --root <that-package>/skills to cover them)`);
	}
	if (problems.length > 0) {
		console.log(`\nORPHAN (companion) — edges that exist in the config but never fire:`);
		for (const p of problems) {
			const edge = p.target ? `${p.source} → ${p.target}` : p.source;
			const why =
				p.kind === "source"
					? "source skill not installed"
					: p.kind === "target"
						? "companion skill not installed"
						: `word not in source's trigger list: ${p.word}`;
			console.log(`  ${edge.padEnd(36)} (${why})`);
		}
	}
	if (presetProblems.length > 0) {
		console.log(`\nPRESET — fragments that never pull their weight:`);
		for (const p of presetProblems) {
			const why =
				p.kind === "unknown"
					? `no such fragment (referenced from ${p.where})`
					: p.kind === "empty"
						? "defined empty; referencing it adds no words"
						: p.kind === "nested"
							? "contains an @ref, which is not expanded (one level only)"
							: "defined but never referenced";
			console.log(`  ${(p.preset ?? p.ref ?? "?").padEnd(24)} (${why})`);
		}
	}
	if (byTier.muted.length > 0) {
		console.log(`\nMUTED — explicitly silenced with an empty [] in the config (intentional):`);
		for (const a of byTier.muted) console.log(`  ${a.display.padEnd(24)} ${a.filePath}`);
	}
	if (byTier.ok.length > 0) {
		console.log(`\nOK (${byTier.ok.length}): ${byTier.ok.map((a) => a.display).join(", ")}`);
	}

	const fail = byTier.error.length > 0 || (strict && byTier.warn.length > 0);
	if (fail) console.log(`\nFAIL (${strict ? "ERROR+WARN" : "ERROR"})`);
	else console.log(`\nPASS`);
	return fail ? 1 : 0;
}

function main(): void {
	const args = parseArgs(process.argv.slice(2), process.env, process.cwd());

	let triggers: ReturnType<typeof normalizeTriggers> = {};
	let noName: ReadonlySet<string> = new Set();
	let companion: CompanionMap = {};
	let presetProblems: PresetProblem[] = [];
	try {
		const raw: unknown = JSON.parse(readFileSync(args.config, "utf8"));
		triggers = normalizeTriggers(raw);
		// noname 不走 normalizeTriggers（它对值做展开会把 Set 摊成空对象），直接取保留键。
		noName = normalizeNoName(raw);
		companion = normalizeCompanion(raw);
		presetProblems = findPresetProblems(raw);
	} catch {
		console.log(`config not found or not valid JSON: ${args.config} (treating as empty trigger map)`);
	}

	const skills = discoverSkills(args.roots);
	const audits = auditSkills({ skills, triggers, noName });
	const orphans = findOrphanTriggerKeys({ skills, triggers });
	const problems = findCompanionProblems({ skills, triggers, companion, noName });
	process.exitCode = report(audits, orphans, problems, presetProblems, args.roots, args.strict);
}

main();
