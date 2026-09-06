import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { SAMANTHA_REPO_ROOT } from "../her-core/channel-probe-gate.ts";
import {
	DEFAULT_TARGET,
	patchMediaSelectorBlock,
	patchSelectorBlock,
	TARGETS,
	type TargetName,
	tokensFor,
	tokensForMedia,
} from "./design-system.ts";

const SCRATCH_REL = ["design", "token-overrides.json"];

interface ScratchChange {
	name: string;
	light?: string;
	dark?: string;
	media?: string;
}

interface ScratchSet {
	target: string;
	note?: string;
	updatedAt?: string;
	changes: ScratchChange[];
}

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

export interface TokenScratchDeps {
	repoRoot?: string;
	now?: () => string;
	readSource?: (absPath: string) => Promise<string>;
	writeSource?: (absPath: string, content: string) => Promise<void>;
}

export function registerTokenScratchTools(pi: ExtensionAPI, deps: TokenScratchDeps = {}): void {
	const repoRoot = deps.repoRoot ?? SAMANTHA_REPO_ROOT;
	const now = deps.now ?? (() => new Date().toISOString());
	const readSource = deps.readSource ?? (async (p: string) => readFile(p, "utf8"));
	const writeSource = deps.writeSource ?? (async (p: string, c: string) => writeFile(p, c));

	const scratchPath = join(repoRoot, ...SCRATCH_REL);

	async function readScratch(): Promise<ScratchSet | null> {
		try {
			const raw = await readFile(scratchPath, "utf8");
			return JSON.parse(raw) as ScratchSet;
		} catch {
			return null;
		}
	}

	async function writeScratch(set: ScratchSet): Promise<void> {
		await mkdir(dirname(scratchPath), { recursive: true });
		await writeFile(scratchPath, `${JSON.stringify(set, null, 2)}\n`);
	}

	async function clearScratch(): Promise<void> {
		try {
			await rm(scratchPath);
		} catch {
			// Already gone — fine.
		}
	}

	/**
	 * Validate that every token name in `changes` exists in the product CSS
	 * for the given target. Returns the list of unknown entries, or an empty
	 * array if everything is valid.
	 */
	async function validateTokenNames(
		changes: ScratchChange[],
		target: string,
	): Promise<{ unknowns: string[]; css: string } | { error: string }> {
		const spec = TARGETS[target as TargetName];
		if (!spec) {
			return { error: `Unknown target "${target}". Known targets: ${Object.keys(TARGETS).join(", ")}.` };
		}

		const absCss = join(repoRoot, ...spec.cssPath);
		let css: string;
		try {
			css = await readSource(absCss);
		} catch {
			return { error: `Cannot read ${absCss}. The file may not exist.` };
		}

		const knownLight = tokensFor(css, spec.light);
		const knownDark = tokensFor(css, spec.dark);
		const knownMediaLight = tokensForMedia(css, spec.light);
		const knownMediaDark = tokensForMedia(css, spec.dark);

		const unknowns: string[] = [];
		for (const change of changes) {
			const mediaKey = typeof change.media === "string" ? change.media.trim() : "";
			if (mediaKey) {
				if (change.light !== undefined) {
					const mediaMap = knownMediaLight.get(mediaKey);
					if (!mediaMap || !mediaMap.has(change.name)) {
						const label = `${change.name} @media ${mediaKey} (light)`;
						if (!unknowns.includes(label)) unknowns.push(label);
					}
				}
				if (change.dark !== undefined) {
					const mediaMap = knownMediaDark.get(mediaKey);
					if (!mediaMap || !mediaMap.has(change.name)) {
						const label = `${change.name} @media ${mediaKey} (dark)`;
						if (!unknowns.includes(label)) unknowns.push(label);
					}
				}
			} else {
				if (change.light !== undefined && !knownLight.has(change.name)) {
					if (!unknowns.includes(change.name)) unknowns.push(change.name);
				}
				if (change.dark !== undefined && !knownDark.has(change.name)) {
					if (!unknowns.includes(change.name)) unknowns.push(change.name);
				}
			}
		}

		return { unknowns, css };
	}

	// ── design_tokens_try ──────────────────────────────────────────────────
	pi.registerTool({
		name: "design_tokens_try",
		label: "Design Tokens Try",
		description:
			"Set or merge token overrides into the scratch set. " +
			"This writes to design/token-overrides.json — never the product. " +
			"Safe to call freely: nothing changes the product until you run design_tokens_commit. " +
			"Unknown token names reject the entire call.",
		parameters: Type.Object({
			target: Type.Optional(Type.String({ description: 'target project; default "samantha-ui"' })),
			note: Type.Optional(Type.String({ description: "why you are trying these values" })),
			changes: Type.Array(
				Type.Object({
					name: Type.String({ description: "CSS custom property name, e.g. --background" }),
					light: Type.Optional(Type.String({ description: "light-mode value" })),
					dark: Type.Optional(Type.String({ description: "dark-mode value" })),
					media: Type.Optional(
						Type.String({
							description:
								"media condition to target, e.g. '(min-width: 768px)'. Omit for the base (non-media) block.",
						}),
					),
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const raw = typeof params.target === "string" ? params.target.trim() : "";
			const target = raw || DEFAULT_TARGET;

			const changes = params.changes as ScratchChange[];
			if (!changes || changes.length === 0) {
				return textResult("No changes provided.", { ok: false });
			}

			const validation = await validateTokenNames(changes, target);
			if ("error" in validation) {
				return textResult(validation.error, { ok: false });
			}
			if (validation.unknowns.length > 0) {
				return textResult(
					`Refused: these tokens do not exist in ${target} globals.css:\n` +
						validation.unknowns.map((n) => `  • ${n}`).join("\n") +
						"\n\nAdding a new token is a product decision. Add it to globals.css by hand first.",
					{ ok: false, unknowns: validation.unknowns },
				);
			}

			// Merge into existing scratch set
			const existing = await readScratch();
			const merged = mergeChanges(existing?.changes ?? [], changes);

			const set: ScratchSet = {
				target,
				note: typeof params.note === "string" ? params.note : existing?.note,
				updatedAt: now(),
				changes: merged,
			};
			await writeScratch(set);

			return textResult(
				`Scratch set updated: ${merged.length} override(s) for ${target}.\n` +
					"Nothing changed in the product. Use design_tokens_commit when ready.",
				{ ok: true, count: merged.length },
			);
		},
	});

	// ── design_tokens_scratch ──────────────────────────────────────────────
	pi.registerTool({
		name: "design_tokens_scratch",
		label: "Design Tokens Scratch",
		description:
			"Read the current scratch set and show what each override is changing: " +
			"the current real value next to the scratch value, per mode, per media.",
		parameters: Type.Object({
			target: Type.Optional(Type.String({ description: 'target project; default "samantha-ui"' })),
		}),
		async execute(_toolCallId, params) {
			const existing = await readScratch();
			if (!existing || existing.changes.length === 0) {
				return textResult("No scratch overrides.", { ok: true, count: 0 });
			}

			const raw = typeof params.target === "string" ? params.target.trim() : "";
			const target = raw || DEFAULT_TARGET;
			const spec = TARGETS[target as TargetName];
			if (!spec) {
				return textResult(`Unknown target "${target}".`, { ok: false });
			}

			const absCss = join(repoRoot, ...spec.cssPath);
			let css: string;
			try {
				css = await readSource(absCss);
			} catch {
				return textResult(`Cannot read ${absCss}.`, { ok: false });
			}

			const realLight = tokensFor(css, spec.light);
			const realDark = tokensFor(css, spec.dark);
			const realMediaLight = tokensForMedia(css, spec.light);
			const realMediaDark = tokensForMedia(css, spec.dark);

			const lines: string[] = [];
			if (existing.note) lines.push(`Note: ${existing.note}`);
			lines.push(`${existing.changes.length} override(s) for ${target}:\n`);

			for (const c of existing.changes) {
				const mediaKey = typeof c.media === "string" ? c.media.trim() : "";
				const prefix = mediaKey ? `@media ${mediaKey} ` : "";
				if (c.light !== undefined) {
					const real = mediaKey
						? (realMediaLight.get(mediaKey)?.get(c.name) ?? "(not set)")
						: (realLight.get(c.name) ?? "(not set)");
					lines.push(`${prefix}${c.name} (light): ${real} → ${c.light}`);
				}
				if (c.dark !== undefined) {
					const real = mediaKey
						? (realMediaDark.get(mediaKey)?.get(c.name) ?? "(not set)")
						: (realDark.get(c.name) ?? "(not set)");
					lines.push(`${prefix}${c.name} (dark): ${real} → ${c.dark}`);
				}
			}

			return textResult(lines.join("\n"), { ok: true, count: existing.changes.length });
		},
	});

	// ── design_tokens_discard ──────────────────────────────────────────────
	pi.registerTool({
		name: "design_tokens_discard",
		label: "Design Tokens Discard",
		description: "Drop the scratch set — all of it, or named tokens only. " + "Nothing is written to the product.",
		parameters: Type.Object({
			names: Type.Optional(
				Type.Array(Type.String(), {
					description: "Token names to discard. Omit to discard everything.",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const existing = await readScratch();
			if (!existing || existing.changes.length === 0) {
				return textResult("Nothing to discard — scratch set is already empty.", { ok: true });
			}

			const names = params.names as string[] | undefined;
			if (!names || names.length === 0) {
				await clearScratch();
				return textResult("Scratch set discarded.", { ok: true });
			}

			const nameSet = new Set(names);
			const remaining = existing.changes.filter((c) => !nameSet.has(c.name));
			if (remaining.length === 0) {
				await clearScratch();
				return textResult("Scratch set discarded (all named tokens removed).", { ok: true });
			}

			existing.changes = remaining;
			existing.updatedAt = now();
			await writeScratch(existing);
			return textResult(`Removed ${names.length} token(s); ${remaining.length} override(s) remain.`, {
				ok: true,
				remaining: remaining.length,
			});
		},
	});

	// ── design_tokens_commit ──────────────────────────────────────────────
	pi.registerTool({
		name: "design_tokens_commit",
		label: "Design Tokens Commit",
		description:
			"Take the scratch set and write it into the product's globals.css, " +
			"then clear the scratch set. This modifies the product source code.",
		parameters: Type.Object({
			target: Type.Optional(Type.String({ description: 'target project; default "samantha-ui"' })),
		}),
		async execute(_toolCallId, params) {
			const existing = await readScratch();
			if (!existing || existing.changes.length === 0) {
				return textResult("Nothing to commit — scratch set is empty.", { ok: false });
			}

			const raw = typeof params.target === "string" ? params.target.trim() : "";
			const target = raw || DEFAULT_TARGET;
			const spec = TARGETS[target as TargetName];
			if (!spec) {
				return textResult(`Unknown target "${target}".`, { ok: false });
			}

			const absCss = join(repoRoot, ...spec.cssPath);
			let css: string;
			try {
				css = await readSource(absCss);
			} catch {
				return textResult(`Cannot read ${absCss}.`, { ok: false });
			}

			// Apply each change through the same splice path as design_system_apply
			let modified = css;
			const allApplied: Array<{ name: string; side: string; before: string; after: string }> = [];

			const baseLightPatches = new Map<string, string>();
			const baseDarkPatches = new Map<string, string>();
			const mediaLightPatches = new Map<string, Map<string, string>>();
			const mediaDarkPatches = new Map<string, Map<string, string>>();

			for (const change of existing.changes) {
				const mediaKey = typeof change.media === "string" ? change.media.trim() : "";
				if (mediaKey) {
					if (change.light !== undefined) {
						if (!mediaLightPatches.has(mediaKey)) mediaLightPatches.set(mediaKey, new Map());
						mediaLightPatches.get(mediaKey)!.set(change.name, change.light);
					}
					if (change.dark !== undefined) {
						if (!mediaDarkPatches.has(mediaKey)) mediaDarkPatches.set(mediaKey, new Map());
						mediaDarkPatches.get(mediaKey)!.set(change.name, change.dark);
					}
				} else {
					if (change.light !== undefined) baseLightPatches.set(change.name, change.light);
					if (change.dark !== undefined) baseDarkPatches.set(change.name, change.dark);
				}
			}

			if (baseLightPatches.size > 0) {
				const result = patchSelectorBlock(modified, spec.light, baseLightPatches);
				if (typeof result === "string") return textResult(result, { ok: false });
				modified = result.css;
				for (const a of result.applied) allApplied.push({ ...a, side: "light" });
			}

			if (baseDarkPatches.size > 0) {
				const result = patchSelectorBlock(modified, spec.dark, baseDarkPatches);
				if (typeof result === "string") return textResult(result, { ok: false });
				modified = result.css;
				for (const a of result.applied) allApplied.push({ ...a, side: "dark" });
			}

			for (const [mediaKey, patches] of mediaLightPatches) {
				const result = patchMediaSelectorBlock(modified, mediaKey, spec.light, patches);
				if (typeof result === "string") return textResult(result, { ok: false });
				modified = result.css;
				for (const a of result.applied) allApplied.push({ ...a, side: `light @media ${mediaKey}` });
			}

			for (const [mediaKey, patches] of mediaDarkPatches) {
				const result = patchMediaSelectorBlock(modified, mediaKey, spec.dark, patches);
				if (typeof result === "string") return textResult(result, { ok: false });
				modified = result.css;
				for (const a of result.applied) allApplied.push({ ...a, side: `dark @media ${mediaKey}` });
			}

			try {
				await writeSource(absCss, modified);
			} catch (e) {
				return textResult(`Failed to write ${absCss}: ${e instanceof Error ? e.message : String(e)}`, {
					ok: false,
				});
			}

			// Clear the scratch set
			await clearScratch();

			const lines = [`Committed ${allApplied.length} change(s) to ${target} globals.css.\n`];
			for (const a of allApplied) {
				lines.push(`${a.name}: ${a.before} → ${a.after} (${a.side})`);
			}
			lines.push("", "⚠️ This modified the product source code. The scratch set is now empty.");

			return textResult(lines.join("\n"), { ok: true, applied: allApplied });
		},
	});
}

/**
 * Merge incoming changes into an existing set. If a change targets the same
 * token name + media key, the new value wins.
 */
function mergeChanges(existing: ScratchChange[], incoming: ScratchChange[]): ScratchChange[] {
	const key = (c: ScratchChange) => `${c.name}|${c.media ?? ""}`;
	const map = new Map<string, ScratchChange>();
	for (const c of existing) map.set(key(c), { ...c });
	for (const c of incoming) {
		const k = key(c);
		const prev = map.get(k);
		if (prev) {
			if (c.light !== undefined) prev.light = c.light;
			if (c.dark !== undefined) prev.dark = c.dark;
			map.set(k, prev);
		} else {
			map.set(k, { ...c });
		}
	}
	return [...map.values()];
}
