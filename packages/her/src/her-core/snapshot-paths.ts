import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, parse, resolve } from "node:path";
import { SNAPSHOT_LOCK_REL, SnapshotError } from "./snapshot-types.ts";

export function toWinAbs(p: string): string {
	const abs = resolve(p);
	if (process.platform !== "win32") return abs;
	if (abs.startsWith("\\\\?\\")) return abs;
	if (abs.startsWith("\\\\")) return `\\\\?\\UNC\\${abs.slice(2)}`;
	return `\\\\?\\${abs}`;
}

export function stripLong(p: string): string {
	if (p.startsWith("\\\\?\\UNC\\")) return `\\\\${p.slice("\\\\?\\UNC\\".length)}`;
	if (p.startsWith("\\\\?\\")) return p.slice("\\\\?\\".length);
	return p;
}

export function absFromRel(root: string, rel: string): string {
	return join(root, ...rel.split("/"));
}

export function snapshotLockPath(root: string): string {
	return join(root, ...SNAPSHOT_LOCK_REL.split("/"));
}

export async function existingAncestor(p: string): Promise<string> {
	let cur = resolve(p);
	for (;;) {
		try {
			await stat(toWinAbs(cur));
			return cur;
		} catch (error) {
			if (!isEnoent(error)) throw error;
			const next = dirname(cur);
			if (next === cur) throw new SnapshotError(`no existing ancestor for ${p}`);
			cur = next;
		}
	}
}

export async function volumeId(p: string): Promise<string> {
	const real = stripLong(await realpath(toWinAbs(await existingAncestor(p))));
	return parse(real).root.toUpperCase();
}

export async function sameVolume(a: string, b: string): Promise<boolean> {
	return (await volumeId(a)) === (await volumeId(b));
}

export function normalizeCanon(p: string): string {
	const stripped = stripLong(resolve(p));
	if (process.platform !== "win32") return stripped;
	return stripped.replace(/\//g, "\\").toLowerCase();
}

export async function resolveCanon(p: string): Promise<string> {
	const abs = resolve(p);
	const existing = await existingAncestor(abs);
	const real = stripLong(await realpath(toWinAbs(existing)));
	const rest = abs.slice(existing.length).replace(/^[\\/]/, "");
	return normalizeCanon(rest ? join(real, rest) : real);
}

export async function isLiveTarget(target: string, liveRoot: string): Promise<boolean> {
	let liveCanon: string;
	try {
		liveCanon = await resolveCanon(liveRoot);
	} catch {
		return false;
	}
	const targetCanon = await resolveCanon(target);
	if (targetCanon === liveCanon) return true;
	const sepChar = process.platform === "win32" ? "\\" : "/";
	const prefix = liveCanon.endsWith(sepChar) ? liveCanon : `${liveCanon}${sepChar}`;
	return targetCanon.startsWith(prefix);
}

export function isEnoent(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

export async function pathExists(p: string): Promise<boolean> {
	try {
		await lstat(toWinAbs(p));
		return true;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

export function utcStamp(now = new Date()): string {
	return now
		.toISOString()
		.replace(/\.\d{3}Z$/, "Z")
		.replace(/:/g, "-");
}

export function safeExternalName(name: string): string {
	const base = basename(name);
	if (!base || base === "." || base === "..") throw new SnapshotError(`invalid external name: ${name}`);
	return base;
}
