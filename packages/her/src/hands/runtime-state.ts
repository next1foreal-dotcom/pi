import { createHash, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export interface RuntimeCandidate {
	id: string;
	version: string;
	binarySha256: string;
	archiveSha256: string;
	contractHash: string;
	verifiedAt: string;
	smoke: boolean;
}
export interface RuntimeState {
	candidates: RuntimeCandidate[];
	active?: string;
	previous?: string;
	checkedAt?: string;
	checkedBinary?: string;
	update?: Record<string, unknown>;
}
export function sha256(data: string | Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}
export function managedRoot(binary: string): string | undefined {
	if (!binary.startsWith("managed:")) return undefined;
	const root = binary.slice(8);
	if (!isAbsolute(root)) throw new Error("CUA managed root must be absolute");
	return root;
}
export function readRuntimeState(root: string): RuntimeState {
	let raw: string;
	try {
		raw = readFileSync(join(root, "state.json"), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { candidates: [] };
		throw error;
	}
	const state = JSON.parse(raw) as RuntimeState;
	if (!Array.isArray(state.candidates)) throw new Error("Invalid CUA runtime state");
	for (const c of state.candidates) {
		if (
			!c ||
			!/^[0-9]+\.[0-9]+\.[0-9]+-[a-zA-Z0-9-]+$/.test(c.id) ||
			!/^\d+\.\d+\.\d+$/.test(c.version) ||
			!/^[a-f0-9]{64}$/.test(c.binarySha256) ||
			!/^[a-f0-9]{64}$/.test(c.archiveSha256) ||
			typeof c.contractHash !== "string" ||
			typeof c.smoke !== "boolean"
		)
			throw new Error("Invalid CUA candidate");
	}
	for (const id of [state.active, state.previous]) {
		if (id !== undefined && !state.candidates.some((c) => c.id === id))
			throw new Error("Unknown CUA runtime pointer");
	}
	return state;
}
export function saveRuntimeState(root: string, state: RuntimeState): void {
	mkdirSync(root, { recursive: true });
	const temporary = join(root, `state-${randomUUID()}.tmp`);
	writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx" });
	renameSync(temporary, join(root, "state.json"));
}
export async function withRuntimeLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
	mkdirSync(root, { recursive: true });
	const lock = join(root, "update.lock");
	const fd = openSync(lock, "wx");
	try {
		writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
		return await operation();
	} finally {
		closeSync(fd);
		unlinkSync(lock);
	}
}
export function selectRuntime(state: RuntimeState, id: string, contractHash: string): RuntimeState {
	const candidate = state.candidates.find((c) => c.id === id);
	if (!candidate?.smoke) throw new Error("Candidate requires a successful browser/window/action smoke test");
	if (candidate.contractHash !== contractHash) throw new Error("Adapter contract changed; verify the candidate again");
	if (state.active === id) return state;
	return { ...state, active: id, previous: state.active };
}
export function candidateBinary(root: string, candidate: RuntimeCandidate): string {
	const binary = join(root, "versions", candidate.id, "cua-driver.exe");
	if (sha256(readFileSync(binary)) !== candidate.binarySha256) throw new Error("CUA binary hash mismatch");
	return binary;
}
/** Resolve once per host lifetime. A pointer update never changes a running host. */
export function resolveManagedRuntime(configured: string, contractHash: string): string {
	const root = managedRoot(configured);
	if (!root) return configured;
	const state = readRuntimeState(root);
	if (!state.active) throw new Error("No active managed CUA runtime; stage, verify and activate first");
	selectRuntime(state, state.active, contractHash);
	return candidateBinary(root, state.candidates.find((c) => c.id === state.active)!);
}
