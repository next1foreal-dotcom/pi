import { CuaCliDriver } from "./driver.ts";
import { runtimeBaseline } from "./runtime-baseline.ts";
import { sha256 } from "./runtime-state.ts";

/** Ignore prose, retain every validation constraint and property name. */
export function canonicalSchema(value: unknown, mode: "schema" | "map" | "data" = "schema"): string {
	if (Array.isArray(value)) return `[${value.map((item) => canonicalSchema(item, mode)).join(",")}]`;
	if (value && typeof value === "object") {
		const schemaMaps = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];
		const schemaValues = [
			"items",
			"prefixItems",
			"additionalProperties",
			"unevaluatedProperties",
			"contains",
			"propertyNames",
			"allOf",
			"anyOf",
			"oneOf",
			"not",
			"if",
			"then",
			"else",
		];
		return `{${Object.entries(value)
			.filter(([key]) => mode !== "schema" || !["description", "title", "$comment"].includes(key))
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, item]) => {
				const childMode =
					mode === "map"
						? "schema"
						: mode === "data"
							? "data"
							: schemaMaps.includes(key)
								? "map"
								: schemaValues.includes(key)
									? "schema"
									: "data";
				return `${JSON.stringify(key)}:${canonicalSchema(item, childMode)}`;
			})
			.join(",")}}`;
	}
	return JSON.stringify(value);
}
export const runtimeContractHash = sha256(canonicalSchema(runtimeBaseline));
export async function inspectRuntime(binary: string): Promise<{ version: string; changedTools: string[] }> {
	const driver = new CuaCliDriver({ binary, defaultTimeoutMs: 15000 });
	const manifest = await driver.run(["manifest"]);
	if (!manifest.ok) throw new Error(`CUA manifest failed: ${manifest.stderr}`);
	const version = JSON.parse(manifest.stdout).binary_version;
	if (typeof version !== "string") throw new Error("CUA manifest has no version");
	const changedTools: string[] = [];
	for (const [tool, expected] of Object.entries(runtimeBaseline)) {
		const result = await driver.run(["describe", tool]);
		const marker = "input_schema:";
		const offset = result.stdout.indexOf(marker);
		if (!result.ok || offset < 0) {
			changedTools.push(tool);
			continue;
		}
		const schema = JSON.parse(result.stdout.slice(offset + marker.length));
		if (sha256(canonicalSchema(schema)) !== expected) changedTools.push(tool);
	}
	return { version, changedTools };
}
