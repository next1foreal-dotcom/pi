import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DISCLOSURE_TOOLS = ["her_capabilities", "her_tools_load"] as const;
const CORE_TOOLS = new Set(["read", "bash", "edit", "write", ...DISCLOSURE_TOOLS]);

type ToolInfo = ReturnType<ExtensionAPI["getAllTools"]>[number];

export type ToolCapability = {
	name: string;
	description: string;
	tools: string[];
};

export type ToolDisclosureState = {
	mode: "shadow" | "enforce";
	available: number;
	active: number;
	hidden: number;
	categories: number;
};

const CATEGORY_DESCRIPTIONS: Record<string, string> = {
	core: "Read, edit, write, and shell operations.",
	memory: "Recall, review, privacy, session, and durable-memory operations.",
	background: "Background task dispatch, inspection, continuation, and stopping.",
	browser: "Browser navigation, inspection, interaction, and preview operations.",
	design: "Design canvas, project, version, token, and asset operations.",
	documents: "Document, PDF, OCR, archive, and conversion operations.",
	integration: "MCP, provider relay, UI action, publishing, and external integrations.",
	other: "Other configured tools.",
};

export function capabilityCategory(name: string): string {
	if (["read", "bash", "edit", "write"].includes(name)) return "core";
	if (/^her_(?:task|bg_task)/.test(name)) return "background";
	if (/^(?:browser_|preview_)/.test(name)) return "browser";
	if (/^(?:design_|canvas_|asset_)/.test(name)) return "design";
	if (/^(?:doc_|pdf_|ocr_|archive_|convert_|imgmin_)/.test(name)) return "documents";
	if (/^(?:mcp_|provider_|relay_|ui_|show_widget|her_publish)/.test(name)) return "integration";
	if (name.startsWith("her_")) return "memory";
	return "other";
}

export function buildCapabilityCatalog(tools: readonly Pick<ToolInfo, "name">[]): ToolCapability[] {
	const grouped = new Map<string, string[]>();
	for (const tool of tools) {
		if (DISCLOSURE_TOOLS.includes(tool.name as (typeof DISCLOSURE_TOOLS)[number])) continue;
		const category = capabilityCategory(tool.name);
		grouped.set(category, [...(grouped.get(category) ?? []), tool.name]);
	}
	return [...grouped.entries()]
		.map(([name, names]) => ({
			name,
			description: CATEGORY_DESCRIPTIONS[name] ?? CATEGORY_DESCRIPTIONS.other,
			tools: names.sort(),
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
}

function renderCatalog(catalog: ToolCapability[]): string {
	return catalog.map((item) => `${item.name} (${item.tools.length}): ${item.description}`).join("\n");
}

export function registerToolDisclosure(pi: ExtensionAPI): {
	apply(mode: "shadow" | "enforce"): ToolDisclosureState;
} {
	let available = new Map<string, ToolInfo>();
	let catalog: ToolCapability[] = [];

	const refresh = () => {
		available = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
		catalog = buildCapabilityCatalog([...available.values()]);
	};

	pi.registerTool({
		name: "her_capabilities",
		label: "Her Capabilities",
		description: "List short tool capability groups without loading their full schemas.",
		parameters: Type.Object({}),
		async execute() {
			refresh();
			return {
				content: [{ type: "text", text: renderCatalog(catalog) || "(no deferred capabilities)" }],
				details: {
					categories: catalog.map(({ name, description, tools }) => ({ name, description, count: tools.length })),
				},
			};
		},
	});

	pi.registerTool({
		name: "her_tools_load",
		label: "Her Tool Loader",
		description: "Load full schemas for one capability group or explicit configured tool names.",
		parameters: Type.Object({
			capability: Type.Optional(Type.String()),
			names: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
		}),
		async execute(_toolCallId, params) {
			refresh();
			const requested = new Set(params.names ?? []);
			if (params.capability) {
				const match = catalog.find((item) => item.name === params.capability);
				if (!match) throw new Error(`unknown capability "${params.capability}"`);
				for (const name of match.tools) requested.add(name);
			}
			if (requested.size === 0) throw new Error("provide capability or names");
			const unknown = [...requested].filter((name) => !available.has(name));
			if (unknown.length > 0) throw new Error(`unknown or unavailable tool(s): ${unknown.join(", ")}`);
			const active = [...new Set([...pi.getActiveTools(), ...requested])];
			pi.setActiveTools(active);
			return {
				content: [{ type: "text", text: `Loaded ${[...requested].sort().join(", ")}.` }],
				details: { loaded: [...requested].sort(), activeCount: active.length },
			};
		},
	});

	return {
		apply(mode) {
			refresh();
			const before = pi.getActiveTools();
			const baseline = before.length > 0 ? before : [...available.keys()];
			const narrowed = [
				...baseline.filter((name) => CORE_TOOLS.has(name)),
				...DISCLOSURE_TOOLS.filter((name) => available.has(name) && !baseline.includes(name)),
			];
			if (mode === "enforce") pi.setActiveTools(narrowed);
			return {
				mode,
				available: available.size,
				active: mode === "enforce" ? narrowed.length : baseline.length,
				hidden: mode === "enforce" ? baseline.filter((name) => !narrowed.includes(name)).length : 0,
				categories: catalog.length,
			};
		},
	};
}
