/**
 * json-config.ts — JSON 配置文件的统一读取与失败回落（本包内部，不依赖宿主或其他包）。
 *
 * 骨架只有一句：读文件 → JSON.parse → normalize 收窄 → 任何一步失败都回落到 defaults 的
 * 展开副本。各配置项的 env 变量名、默认路径与 normalize 规则仍留在调用方。
 * 与 lib 其余模块同约定：不在顶层读盘，路径由调用方作参数传入（单测注入也靠它）。
 */
import { readFileSync } from "node:fs";

/**
 * 读取并解析 JSON 配置：成功时把原始值交 `normalize` 收窄（不传则原样回落，等价于只认 defaults）；
 * 任何失败（缺文件 / 坏 JSON / normalize 抛错）都返回 `defaults` 的展开副本——
 * 副本而非 defaults 本身，调用方改动返回值不会污染模块级默认值。
 */
export function loadJsonConfig<T extends object>(file: string, defaults: T, normalize?: (raw: unknown) => T): T {
	try {
		const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
		return normalize ? normalize(raw) : { ...defaults };
	} catch {
		return { ...defaults };
	}
}
