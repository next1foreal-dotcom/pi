import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import test from "node:test";
import { runHerCli } from "../src/cli.ts";
import { initStore } from "../src/her-core/index.ts";

interface CliResult {
	code: number;
	stderr: string;
	stdout: string;
}

interface ManifestFile {
	path: string;
	sha256: string;
	size: number;
}

interface ManifestExternal {
	missing?: boolean;
	name?: string;
	sha256?: string;
	size?: number;
	snapshotPath: string;
	source: string;
}

interface Manifest {
	excluded: string[];
	external: ManifestExternal[];
	files: ManifestFile[];
	herMemoryGitHead: string | null;
	skippedReparse: Array<{ kind: string; path: string }>;
	totalBytes: number;
	ts: string;
}

async function runSnap(args: string[], env: NodeJS.ProcessEnv, cwd = process.cwd()): Promise<CliResult> {
	let stdout = "";
	let stderr = "";
	const io = {
		stderr: {
			write(chunk: string) {
				stderr += chunk;
				return true;
			},
		},
		stdout: {
			write(chunk: string) {
				stdout += chunk;
				return true;
			},
		},
	};
	const code = await runHerCli(args, env, cwd, io as never);
	return { code, stderr, stdout };
}

function envFor(memoryDir: string, snaps: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, HER_MEMORY_DIR: memoryDir, HER_SNAPSHOT_DIR: snaps, ...extra };
	if (!("FEI_RESTORE_CONFIRM" in extra)) delete env.FEI_RESTORE_CONFIRM;
	return env;
}

function winAbs(p: string): string {
	const abs = resolve(p);
	if (process.platform !== "win32") return abs;
	if (abs.startsWith("\\\\?\\")) return abs;
	if (abs.startsWith("\\\\")) return `\\\\?\\UNC\\${abs.slice(2)}`;
	return `\\\\?\\${abs}`;
}

async function makeSource(): Promise<{ live: string; snaps: string; source: string }> {
	const source = await mkdtemp(join(tmpdir(), "her-g271-src-"));
	const snaps = await mkdtemp(join(tmpdir(), "her-g271-snap-"));
	const live = await mkdtemp(join(tmpdir(), "her-g271-live-"));
	await initStore(source);
	await mkdir(join(source, "episodic", "raw"), { recursive: true });
	await writeFile(join(source, "episodic", "raw", "note.txt"), "hello-note\n");
	await mkdir(join(source, "taste-media"), { recursive: true });
	await writeFile(join(source, "taste-media", "big.bin"), "MEDIA-BYTES");
	await writeFile(join(source, ".her", "lock"), "LOCK\n");
	await mkdir(join(source, ".git", "refs", "heads"), { recursive: true });
	await writeFile(join(source, ".git", "HEAD"), "ref: refs/heads/main\n");
	await writeFile(join(source, ".git", "refs", "heads", "main"), `${"a".repeat(40)}\n`);
	await mkdir(join(live, ".her"), { recursive: true });
	return { live, snaps, source };
}

function snapshotPath(stdout: string): string {
	const match = stdout.match(/^snapshot: (.+)$/m);
	assert.ok(match, `expected snapshot path in stdout, got: ${stdout}`);
	return match[1].trim();
}

async function createSnap(source: string, snaps: string, extra: NodeJS.ProcessEnv = {}): Promise<string> {
	const created = await runSnap(["snapshot-create", "--same-volume-ok"], envFor(source, snaps, extra));
	assert.equal(created.code, 0, created.stderr);
	return snapshotPath(created.stdout);
}

async function readManifest(snap: string): Promise<Manifest> {
	return JSON.parse(await readFile(join(snap, "manifest.json"), "utf8")) as Manifest;
}

async function sha256File(path: string): Promise<string> {
	return createHash("sha256")
		.update(await readFile(winAbs(path)))
		.digest("hex");
}

async function treeHas(root: string, rel: string): Promise<boolean> {
	try {
		await stat(winAbs(join(root, rel)));
		return true;
	} catch {
		return false;
	}
}

test("GIVEN fake tree WHEN create THEN tree+manifest hashes match and exclusions are absent", async () => {
	const { source, snaps } = await makeSource();
	const snap = await createSnap(source, snaps);
	const manifest = await readManifest(snap);
	assert.equal(typeof manifest.ts, "string");
	assert.equal(manifest.herMemoryGitHead, "a".repeat(40));
	assert.equal(await treeHas(join(snap, "tree"), "taste-media/big.bin"), false);
	assert.equal(await treeHas(join(snap, "tree"), ".her/lock"), false);
	assert.equal(
		manifest.files.some((file) => file.path === "taste-media/big.bin"),
		false,
	);
	assert.equal(
		manifest.files.some((file) => file.path === ".her/lock"),
		false,
	);
	assert.equal(
		manifest.excluded.some((item) => item.includes("taste-media")),
		true,
	);
	assert.equal(
		manifest.excluded.some((item) => item.includes(".her/lock")),
		true,
	);
	assert.equal(await treeHas(join(snap, "tree"), "episodic/raw/note.txt"), true);
	assert.equal(await treeHas(join(snap, "tree"), ".git/HEAD"), true);
	for (const file of manifest.files) {
		const actual = await sha256File(join(snap, "tree", file.path.split("/").join(sep)));
		assert.equal(actual, file.sha256, file.path);
		const st = await stat(winAbs(join(snap, "tree", file.path.split("/").join(sep))));
		assert.equal(st.size, file.size);
	}
	assert.equal(
		manifest.totalBytes,
		manifest.files.reduce((sum, file) => sum + file.size, 0),
	);
});

test("GIVEN snapshot then three corruptions WHEN verify THEN nonzero and each diff is listed", async () => {
	const { source, snaps } = await makeSource();
	const snap = await createSnap(source, snaps);
	const tree = join(snap, "tree");
	await rm(join(tree, "episodic", "raw", "note.txt"));
	await writeFile(join(tree, "narrative", "SOUL.md"), "tampered-soul\n");
	await writeFile(join(tree, "extra-added.txt"), "new-file\n");
	const verified = await runSnap(["snapshot-verify", snap], envFor(source, snaps));
	assert.notEqual(verified.code, 0);
	const out = `${verified.stdout}\n${verified.stderr}`;
	assert.match(out, /missing:.*episodic\/raw\/note\.txt/);
	assert.match(out, /changed:.*narrative\/SOUL\.md/);
	assert.match(out, /extra:.*extra-added\.txt/);
});

test("GIVEN corrupted source WHEN restore THEN bytes match snapshot and extras are deleted", async () => {
	const { source, snaps, live } = await makeSource();
	const snap = await createSnap(source, snaps);
	const originalSoul = await readFile(join(source, "narrative", "SOUL.md"));
	await rm(join(source, "episodic", "raw", "note.txt"));
	await writeFile(join(source, "narrative", "SOUL.md"), "tampered-soul\n");
	await writeFile(join(source, "extra-added.txt"), "new-file\n");
	const restored = await runSnap(["snapshot-restore", snap, source], envFor(live, snaps));
	assert.equal(restored.code, 0, restored.stderr);
	assert.equal(await readFile(join(source, "episodic", "raw", "note.txt"), "utf8"), "hello-note\n");
	assert.deepEqual(await readFile(join(source, "narrative", "SOUL.md")), originalSoul);
	assert.equal(await treeHas(source, "extra-added.txt"), false);
	const verified = await runSnap(["snapshot-verify", snap], envFor(live, snaps));
	assert.equal(verified.code, 0, verified.stderr);
});

test("GIVEN missing external WHEN create THEN ok and restore default leaves external alone", async () => {
	const { source, snaps, live } = await makeSource();
	const extDir = await mkdtemp(join(tmpdir(), "her-g271-ext-"));
	const present = join(extDir, "present.json");
	const missing = join(extDir, "missing.json");
	const original = '{"ok":true}';
	await writeFile(present, original);
	const extra = {
		HER_SNAPSHOT_EXTERNAL: JSON.stringify([
			{ name: "present.json", source: present },
			{ name: "missing.json", source: missing },
		]),
	};
	const snap = await createSnap(source, snaps, extra);
	const manifest = await readManifest(snap);
	assert.equal(manifest.external.find((row) => row.source === missing)?.missing, true);
	assert.equal(manifest.external.find((row) => row.source === present)?.missing ?? false, false);
	await writeFile(present, '{"ok":false}');
	const restored = await runSnap(["snapshot-restore", snap, source], envFor(live, snaps, extra));
	assert.equal(restored.code, 0, restored.stderr);
	assert.equal(await readFile(present, "utf8"), '{"ok":false}');
	const withExt = await runSnap(
		["snapshot-restore", snap, source, "--external"],
		envFor(live, snaps, { ...extra, FEI_RESTORE_CONFIRM: "1" }),
	);
	assert.equal(withExt.code, 0, withExt.stderr);
	assert.equal(await readFile(present, "utf8"), original);
	assert.equal(await treeHas(extDir, "missing.json"), false);
});

test("GIVEN .her/lock WHEN create/restore THEN lock is not snapshotted or restored", async () => {
	const { source, snaps, live } = await makeSource();
	const snap = await createSnap(source, snaps);
	assert.equal(await treeHas(join(snap, "tree"), ".her/lock"), false);
	const target = await mkdtemp(join(tmpdir(), "her-g271-tgt-"));
	await mkdir(join(target, ".her"), { recursive: true });
	await writeFile(join(target, ".her", "lock"), "TARGET-LOCK\n");
	const restored = await runSnap(["snapshot-restore", snap, target], envFor(live, snaps));
	assert.equal(restored.code, 0, restored.stderr);
	assert.equal(await readFile(join(target, ".her", "lock"), "utf8"), "TARGET-LOCK\n");
});

test("GIVEN junction to outside dir WHEN create THEN skipped and outside bytes stay out", async () => {
	const { source, snaps } = await makeSource();
	const outside = await mkdtemp(join(tmpdir(), "her-g271-out-"));
	await writeFile(join(outside, "secret.txt"), "OUTSIDE-SECRET");
	await symlink(outside, join(source, "escape"), "junction");
	const snap = await createSnap(source, snaps);
	const manifest = await readManifest(snap);
	assert.equal(
		manifest.skippedReparse.some((row) => row.path === "escape"),
		true,
	);
	assert.equal(await treeHas(join(snap, "tree"), "escape/secret.txt"), false);
	assert.equal(
		manifest.files.some((file) => file.path.includes("secret.txt")),
		false,
	);
	const treeFiles = await readdir(join(snap, "tree"), { recursive: true });
	const joined = treeFiles.join("\n");
	assert.equal(joined.includes("OUTSIDE-SECRET"), false);
	assert.equal(joined.includes("secret.txt"), false);
});

test("GIVEN HER_SNAPSHOT_DIR on same volume WHEN create without flag THEN refuse with zero writes", async () => {
	const { source, snaps } = await makeSource();
	const before = await readdir(snaps);
	const created = await runSnap(["snapshot-create"], envFor(source, snaps));
	assert.notEqual(created.code, 0);
	assert.match(`${created.stdout}\n${created.stderr}`, /same volume/i);
	assert.deepEqual(await readdir(snaps), before);
});

test("GIVEN --external without FEI_RESTORE_CONFIRM WHEN restore THEN refuse zero writes", async () => {
	const { source, snaps, live } = await makeSource();
	const extDir = await mkdtemp(join(tmpdir(), "her-g271-ext2-"));
	const present = join(extDir, "present.json");
	await writeFile(present, '{"ok":true}');
	const extra = { HER_SNAPSHOT_EXTERNAL: JSON.stringify([{ name: "present.json", source: present }]) };
	const snap = await createSnap(source, snaps, extra);
	await writeFile(present, '{"ok":false}');
	const marker = join(source, "untouched.txt");
	await writeFile(marker, "stay\n");
	const restored = await runSnap(["snapshot-restore", snap, source, "--external"], envFor(live, snaps, extra));
	assert.notEqual(restored.code, 0);
	assert.equal(await readFile(present, "utf8"), '{"ok":false}');
	assert.equal(await readFile(marker, "utf8"), "stay\n");
});

test("GIVEN target is live HER_MEMORY_DIR without confirm WHEN restore THEN refuse zero writes", async () => {
	const { source, snaps } = await makeSource();
	const snap = await createSnap(source, snaps);
	await writeFile(join(source, "episodic", "raw", "note.txt"), "mutated\n");
	const restored = await runSnap(["snapshot-restore", snap, source], envFor(source, snaps));
	assert.notEqual(restored.code, 0);
	assert.match(`${createdOr(restored)}`, /FEI_RESTORE_CONFIRM/);
	assert.equal(await readFile(join(source, "episodic", "raw", "note.txt"), "utf8"), "mutated\n");
});

function createdOr(result: CliResult): string {
	return `${result.stdout}\n${result.stderr}`;
}

test("GIVEN nonempty target without .her WHEN restore THEN refuse", async () => {
	const { source, snaps, live } = await makeSource();
	const snap = await createSnap(source, snaps);
	const target = await mkdtemp(join(tmpdir(), "her-g271-notmem-"));
	await writeFile(join(target, "readme.txt"), "not-her-memory\n");
	const restored = await runSnap(["snapshot-restore", snap, target], envFor(live, snaps));
	assert.notEqual(restored.code, 0);
	assert.equal(await readFile(join(target, "readme.txt"), "utf8"), "not-her-memory\n");
	const names = await readdir(target);
	assert.deepEqual(names, ["readme.txt"]);
});

test("GIVEN path longer than 260 WHEN create/verify/restore THEN full chain works", async () => {
	const { source, snaps, live } = await makeSource();
	const segs = [1, 2, 3, 4, 5, 6].map((n) => `seg${n}-${"x".repeat(36)}`);
	const rel = join(...segs, "deep.txt");
	const abs = join(source, rel);
	await mkdir(winAbs(dirname(abs)), { recursive: true });
	await writeFile(winAbs(abs), "long-path-ok\n");
	assert.ok(abs.length > 260);
	const snap = await createSnap(source, snaps);
	const verified = await runSnap(["snapshot-verify", snap], envFor(source, snaps));
	assert.equal(verified.code, 0, verified.stderr);
	const target = await mkdtemp(join(tmpdir(), "her-g271-long-"));
	await mkdir(join(target, ".her"), { recursive: true });
	const restored = await runSnap(["snapshot-restore", snap, target], envFor(live, snaps));
	assert.equal(restored.code, 0, restored.stderr);
	assert.equal(await readFile(winAbs(join(target, rel)), "utf8"), "long-path-ok\n");
});
