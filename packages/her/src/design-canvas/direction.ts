import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { SAMANTHA_REPO_ROOT } from "../her-core/channel-probe-gate.ts";

export interface DesignDirection {
	/** 短名字,人一眼能记住,例如 "brutalist concrete"。不是 "方案A"。 */
	name: string;
	/** 一两句话:字体感、色彩态度、动效性格。 */
	character: string;
	/** 谁定的:只有 "fei" 才算真定了。 */
	chosenBy: "fei";
	chosenAt: string;
}

export type ProposedDirection = { name: string; character: string };

function rootOf(repoRoot?: string): string {
	return repoRoot ?? SAMANTHA_REPO_ROOT;
}

export function directionPath(repoRoot?: string): string {
	return join(rootOf(repoRoot), "design", "direction.json");
}

function asDirection(value: unknown): DesignDirection | undefined {
	if (!value || typeof value !== "object") return undefined;
	const rec = value as Record<string, unknown>;
	if (rec.chosenBy !== "fei") return undefined;
	if (typeof rec.name !== "string" || rec.name.trim() === "") return undefined;
	if (typeof rec.character !== "string" || rec.character.trim() === "") return undefined;
	if (typeof rec.chosenAt !== "string" || rec.chosenAt.trim() === "") return undefined;
	return {
		name: rec.name,
		character: rec.character,
		chosenBy: "fei",
		chosenAt: rec.chosenAt,
	};
}

function asProposed(value: unknown): ProposedDirection | undefined {
	if (!value || typeof value !== "object") return undefined;
	const rec = value as Record<string, unknown>;
	if (typeof rec.name !== "string" || rec.name.trim() === "") return undefined;
	if (typeof rec.character !== "string" || rec.character.trim() === "") return undefined;
	return { name: rec.name.trim(), character: rec.character.trim() };
}

function readEnvelope(repoRoot?: string): { pending: ProposedDirection[]; chosen?: DesignDirection } {
	try {
		const path = directionPath(repoRoot);
		if (!existsSync(path) || !statSync(path).isFile()) return { pending: [] };
		const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
		const top = asDirection(raw);
		if (top) return { pending: [], chosen: top };
		if (!raw || typeof raw !== "object") return { pending: [] };
		const rec = raw as Record<string, unknown>;
		const pending = Array.isArray(rec.pending)
			? rec.pending.map(asProposed).filter((item): item is ProposedDirection => item !== undefined)
			: [];
		return { pending, chosen: asDirection(rec.chosen) };
	} catch {
		return { pending: [] };
	}
}

function writeEnvelope(data: { pending: ProposedDirection[]; chosen?: DesignDirection }, repoRoot?: string): void {
	const path = directionPath(repoRoot);
	const body: Record<string, unknown> = {};
	if (data.pending.length > 0) body.pending = data.pending;
	if (data.chosen) body.chosen = data.chosen;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(body, null, "\t")}\n`, "utf8");
}

export function currentDirection(repoRoot?: string): DesignDirection | undefined {
	return readEnvelope(repoRoot).chosen;
}

export function setDirection(d: Omit<DesignDirection, "chosenAt">, repoRoot?: string): DesignDirection {
	const chosen: DesignDirection = {
		name: d.name,
		character: d.character,
		chosenBy: "fei",
		chosenAt: new Date().toISOString(),
	};
	const pending = readEnvelope(repoRoot).pending;
	writeEnvelope({ pending, chosen }, repoRoot);
	return chosen;
}

export function pendingDirections(repoRoot?: string): ProposedDirection[] {
	return readEnvelope(repoRoot).pending;
}

export function proposeDirections(items: ProposedDirection[], repoRoot?: string): ProposedDirection[] {
	const chosen = currentDirection(repoRoot);
	writeEnvelope({ pending: items, chosen }, repoRoot);
	return items;
}

export function chooseDirection(name: string, repoRoot?: string): DesignDirection | undefined {
	const wanted = name.trim();
	if (!wanted) return undefined;
	const pending = pendingDirections(repoRoot);
	const match = [...pending].reverse().find((item) => item.name === wanted);
	if (!match) return undefined;
	return setDirection({ name: match.name, character: match.character, chosenBy: "fei" }, repoRoot);
}

export function hasUsableDesignSystem(repoRoot?: string): boolean {
	try {
		const systemDir = join(rootOf(repoRoot), "design", "system");
		if (!existsSync(systemDir) || !statSync(systemDir).isDirectory()) return false;
		for (const name of readdirSync(systemDir)) {
			try {
				const dir = join(systemDir, name);
				if (!statSync(dir).isDirectory()) continue;
				const receiptPath = join(dir, "receipt.json");
				const cssPath = join(dir, "tokens.css");
				if (!existsSync(receiptPath) || !statSync(receiptPath).isFile()) continue;
				if (!existsSync(cssPath) || !statSync(cssPath).isFile()) continue;
				return true;
			} catch {}
		}
		return false;
	} catch {
		return false;
	}
}

export function needsFirstFrame(repoRoot?: string): boolean {
	return !hasUsableDesignSystem(repoRoot) && currentDirection(repoRoot) === undefined;
}
