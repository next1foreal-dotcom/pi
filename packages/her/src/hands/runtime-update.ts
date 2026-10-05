import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { EnvHttpProxyAgent, fetch as proxyFetch } from "undici";
import { record } from "./result.ts";
import { inspectRuntime, runtimeContractHash } from "./runtime-contract.ts";
import {
	candidateBinary,
	type RuntimeCandidate,
	readRuntimeState,
	saveRuntimeState,
	selectRuntime,
	sha256,
	withRuntimeLock,
} from "./runtime-state.ts";

const execute = promisify(execFile);
const dispatcher = new EnvHttpProxyAgent();
const repository = "https://api.github.com/repos/trycua/cua";
export async function checkRuntimeUpdate(
	root: string,
	binary: string,
	force = false,
): Promise<Record<string, unknown>> {
	const state = readRuntimeState(root);
	const age = Date.now() - Date.parse(state.checkedAt ?? "");
	if (!force && age >= 0 && age < 24 * 60 * 60 * 1000 && state.update && state.checkedBinary === binary)
		return state.update;
	return withRuntimeLock(root, async () => {
		const home = join(root, "update-home");
		await mkdir(home, { recursive: true });
		const { stdout } = await execute(binary, ["check-update", "--json", "--no-cache"], {
			windowsHide: true,
			timeout: 30000,
			maxBuffer: 1024 * 1024,
			env: { ...process.env, HOME: home, USERPROFILE: home, CUA_DRIVER_RS_HOME: home },
		});
		const update = record(JSON.parse(stdout));
		if (
			update.error ||
			update.selected_channel !== "stable" ||
			!/^\d+\.\d+\.\d+$/.test(String(update.latest_version))
		)
			throw new Error(`Stable update check failed: ${String(update.error ?? "invalid upstream response")}`);
		saveRuntimeState(root, {
			...readRuntimeState(root),
			checkedAt: new Date().toISOString(),
			checkedBinary: binary,
			update,
		});
		return update;
	});
}
async function fetchChecked(url: string) {
	const response = await proxyFetch(url, {
		dispatcher,
		signal: AbortSignal.timeout(120000),
		headers: { Accept: "application/vnd.github+json" },
	});
	if (!response.ok) throw new Error(`CUA download failed: HTTP ${response.status}`);
	return response;
}
/** Stage only an official stable release; never run the global installer or alter PATH. */
export async function stageRuntime(
	root: string,
	version: string,
): Promise<{ candidate: RuntimeCandidate; changedTools: string[] }> {
	if (!isAbsolute(root)) throw new Error("CUA managed root must be absolute");
	if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch))
		throw new Error("Managed CUA installation currently supports Windows x64/arm64");
	if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("An exact stable version is required");
	return withRuntimeLock(root, async () => {
		const tag = `cua-driver-rs-v${version}`;
		const release = record(await (await fetchChecked(`${repository}/releases/tags/${tag}`)).json());
		if (release.tag_name !== tag || release.draft !== false) throw new Error("Invalid official stable release");
		const assetName = `cua-driver-rs-${version}-windows-${process.arch === "x64" ? "x86_64" : "arm64"}-binary.zip`;
		const asset = (Array.isArray(release.assets) ? release.assets.map(record) : []).find((a) => a.name === assetName);
		const url = `https://github.com/trycua/cua/releases/download/${tag}/${assetName}`;
		if (asset?.browser_download_url !== url || !/^sha256:[a-f0-9]{64}$/.test(String(asset.digest)))
			throw new Error("Official asset or SHA-256 digest unavailable; refusing installation");
		const archive = Buffer.from(await (await fetchChecked(url)).arrayBuffer());
		const archiveSha256 = sha256(archive);
		if (`sha256:${archiveSha256}` !== asset.digest) throw new Error("CUA archive hash mismatch");
		const id = `${version}-${randomUUID()}`;
		const directory = join(root, "versions", id);
		await mkdir(directory, { recursive: true });
		const archivePath = join(directory, "driver.zip");
		const binary = join(directory, "cua-driver.exe");
		await writeFile(archivePath, archive, { flag: "wx" });
		// Extract the single executable to a fixed path; no archive-supplied paths are written.
		await execute(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				"$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[IO.Compression.ZipFile]::OpenRead($env:HER_CUA_ARCHIVE); try { $entries=@($zip.Entries | Where-Object Name -eq 'cua-driver.exe'); if($entries.Count -ne 1){throw 'Expected one cua-driver.exe'}; $inputStream=$entries[0].Open(); $outputStream=[IO.File]::Open($env:HER_CUA_BINARY,[IO.FileMode]::CreateNew); try {$inputStream.CopyTo($outputStream)} finally {$inputStream.Dispose(); $outputStream.Dispose()} } finally {$zip.Dispose()}",
			],
			{
				windowsHide: true,
				timeout: 30000,
				env: { ...process.env, HER_CUA_ARCHIVE: archivePath, HER_CUA_BINARY: binary },
			},
		);
		const inspected = await inspectRuntime(binary);
		if (inspected.version !== version) throw new Error("Downloaded binary version does not match the release");
		const candidate: RuntimeCandidate = {
			id,
			version,
			archiveSha256,
			binarySha256: sha256(await readFile(binary)),
			contractHash: inspected.changedTools.length ? "" : runtimeContractHash,
			verifiedAt: "",
			smoke: false,
		};
		const state = readRuntimeState(root);
		saveRuntimeState(root, { ...state, candidates: [...state.candidates, candidate] });
		return { candidate, changedTools: inspected.changedTools };
	});
}
export async function verifyRuntime(
	root: string,
	id: string,
	smoke: (binary: string, evidence: string) => Promise<void>,
): Promise<RuntimeCandidate> {
	return withRuntimeLock(root, async () => {
		let state = readRuntimeState(root);
		const original = state.candidates.find((c) => c.id === id);
		if (!original) throw new Error("Unknown CUA candidate");
		// Invalidate old evidence before retry: a failed rerun must never preserve a green result.
		const candidate = { ...original, smoke: false, verifiedAt: "" };
		state = { ...state, candidates: state.candidates.map((c) => (c.id === id ? candidate : c)) };
		saveRuntimeState(root, state);
		const binary = candidateBinary(root, candidate);
		const inspected = await inspectRuntime(binary);
		if (inspected.version !== candidate.version || inspected.changedTools.length)
			throw new Error(`CUA adapter changes required: ${inspected.changedTools.join(", ") || "version mismatch"}`);
		await smoke(binary, join(root, "versions", id, "evidence"));
		candidateBinary(root, candidate);
		const verified = {
			...candidate,
			contractHash: runtimeContractHash,
			smoke: true,
			verifiedAt: new Date().toISOString(),
		};
		saveRuntimeState(root, { ...state, candidates: state.candidates.map((c) => (c.id === id ? verified : c)) });
		return verified;
	});
}
export async function activateRuntime(root: string, id?: string): Promise<string> {
	return withRuntimeLock(root, async () => {
		const state = readRuntimeState(root);
		const target = id ?? state.previous;
		if (!target) throw new Error("No previous CUA runtime to roll back to");
		const next = selectRuntime(state, target, runtimeContractHash);
		candidateBinary(root, next.candidates.find((c) => c.id === target)!);
		saveRuntimeState(root, next);
		return `Selected ${target}. Effective on the next Her host start; running sessions retain their current binary.`;
	});
}
