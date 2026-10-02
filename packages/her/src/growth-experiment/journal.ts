import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, readProtectedFile, sha256 } from "../her-core/improvement-plan.ts";
import { appendText, readText, writeNewText } from "../her-core/store.ts";
import { storeLock } from "../her-core/store-lock.ts";
import type { GrowthState } from "./types.ts";

export interface GrowthReceipt {
	seq: number;
	at: string;
	kind: string;
	data: Record<string, unknown>;
	previous: string;
	digest: string;
}
export class GrowthJournal {
	readonly root: string;
	readonly id: string;
	readonly path: string;
	constructor(root: string, id: string) {
		if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(id)) throw new Error("unsafe inquiry id");
		this.root = root;
		this.id = id;
		this.path = join(root, "proposals", "growth", `${id}.md`);
	}
	// ponytail: rescan bounded 16 MiB journal; add an authenticated index if this becomes slow.
	async read(): Promise<GrowthReceipt[]> {
		if ((await readText(this.path)) === undefined) return [];
		const text = (await readProtectedFile(this.root, `proposals/growth/${this.id}.md`, 16 * 1024 * 1024)).toString(
			"utf8",
		);
		const prefix = `# Growth inquiry ${this.id}\n\n`;
		if (!text.startsWith(prefix)) throw new Error("invalid growth journal header");
		const tail = text.slice(prefix.length);
		const receipts: GrowthReceipt[] = [];
		let consumed = "";
		for (const match of tail.matchAll(/```json\n([^\n]+)\n```\n\n/g)) {
			const row = JSON.parse(match[1]) as GrowthReceipt;
			const { digest, ...payload } = row;
			if (
				row.seq !== receipts.length ||
				row.previous !== (receipts.at(-1)?.digest ?? "") ||
				digest !== sha256(canonicalJson(payload))
			)
				throw new Error("growth journal corrupt or reordered");
			receipts.push(row);
			consumed += match[0];
		}
		if (consumed !== tail) throw new Error("growth journal incomplete; reconcile before continuing");
		return receipts;
	}
	async append(kind: string, data: Record<string, unknown>): Promise<GrowthReceipt> {
		return storeLock(this.root, async () => {
			const records = await this.read();
			if (!records.length && (await readText(this.path)) === undefined)
				await writeNewText(this.path, `# Growth inquiry ${this.id}\n\n`);
			const payload = {
				seq: records.length,
				at: new Date().toISOString(),
				kind,
				data,
				previous: records.at(-1)?.digest ?? "",
			};
			const receipt = { ...payload, digest: sha256(canonicalJson(payload)) };
			await appendText(this.path, `\x60\x60\x60json\n${JSON.stringify(receipt)}\n\x60\x60\x60\n\n`);
			return receipt;
		});
	}
	async state(): Promise<GrowthState | undefined> {
		return (await this.read()).reverse().find((r) => r.kind === "state")?.data.state as GrowthState | undefined;
	}
	async save(next: Readonly<GrowthState>, expectedRevision: number): Promise<void> {
		await storeLock(this.root, async () => {
			const current = await this.state();
			if (
				next.id !== this.id ||
				(current?.revision ?? -1) !== expectedRevision ||
				next.revision !== expectedRevision + 1
			)
				throw new Error("stale growth revision");
			await this.append("state", { state: JSON.parse(JSON.stringify(next)) });
		});
	}
}
/** Fresh tasks recall only active reviewed versions; suspended versions remain in history. */
export async function recallGrowthMethods(root: string): Promise<GrowthState[]> {
	const dir = join(root, "proposals", "growth");
	const files = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return [];
		throw error;
	});
	const result: GrowthState[] = [];
	for (const file of files.filter((name) => name.endsWith(".md")).sort()) {
		const state = await new GrowthJournal(root, file.slice(0, -3)).state();
		if (state?.phase === "trial-ready" && state.method?.status === "trial-ready") result.push(state);
	}
	return result;
}
