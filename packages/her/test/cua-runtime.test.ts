import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CuaMcpDriver } from "../src/hands/mcp-driver.ts";
import { canonicalSchema, runtimeContractHash } from "../src/hands/runtime-contract.ts";
import { registerCuaManagement } from "../src/hands/runtime-management.ts";
import {
	type RuntimeCandidate,
	readRuntimeState,
	resolveManagedRuntime,
	saveRuntimeState,
	selectRuntime,
	sha256,
	withRuntimeLock,
} from "../src/hands/runtime-state.ts";
import { checkRuntimeUpdate } from "../src/hands/runtime-update.ts";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "her-cua-update-"));
	const candidate: RuntimeCandidate = {
		id: "0.33.3-test",
		version: "0.33.3",
		binarySha256: "a".repeat(64),
		archiveSha256: "b".repeat(64),
		contractHash: "contract",
		verifiedAt: "2026-10-05T00:00:00Z",
		smoke: false,
	};
	return { root, candidate };
}
test("unverified candidates cannot become active", () => {
	const { candidate } = fixture();
	assert.throws(() => selectRuntime({ candidates: [candidate] }, candidate.id, "contract"), /smoke/);
});
test("contract changes invalidate earlier verification", () => {
	const { candidate } = fixture();
	candidate.smoke = true;
	assert.throws(() => selectRuntime({ candidates: [candidate] }, candidate.id, "changed"), /contract/);
});
test("activation retains previous runtime and rollback selects it", () => {
	const { candidate } = fixture();
	candidate.smoke = true;
	const other = { ...candidate, id: "0.33.4-test", version: "0.33.4" };
	let state = selectRuntime({ candidates: [candidate, other] }, candidate.id, "contract");
	state = selectRuntime(state, other.id, "contract");
	assert.equal(state.previous, candidate.id);
	state = selectRuntime(state, state.previous!, "contract");
	assert.equal(state.active, candidate.id);
	assert.equal(state.previous, other.id);
});
test("missing state is distinct from corrupt state", () => {
	const { root } = fixture();
	assert.deepEqual(readRuntimeState(root), { candidates: [] });
	writeFileSync(join(root, "state.json"), "broken");
	assert.throws(() => readRuntimeState(root));
});
test("atomic state roundtrip and binary integrity fail closed", () => {
	const { root, candidate } = fixture();
	candidate.smoke = true;
	saveRuntimeState(root, { candidates: [candidate], active: candidate.id });
	assert.equal(readRuntimeState(root).active, candidate.id);
	mkdirSync(join(root, "versions", candidate.id), { recursive: true });
	writeFileSync(join(root, "versions", candidate.id, "cua-driver.exe"), "tampered");
	assert.throws(() => resolveManagedRuntime(`managed:${root}`, "contract"), /hash/);
});
test("managed roots and candidate IDs cannot escape owned storage", () => {
	assert.throws(() => resolveManagedRuntime("managed:relative", "contract"), /absolute/);
	const { root, candidate } = fixture();
	candidate.id = "../escape";
	writeFileSync(join(root, "state.json"), JSON.stringify({ candidates: [candidate], active: candidate.id }));
	assert.throws(() => readRuntimeState(root), /candidate/);
});

test("update lock rejects concurrent mutation and releases after failure", async () => {
	const { root } = fixture();
	await assert.rejects(
		() =>
			withRuntimeLock(root, async () => {
				await assert.rejects(() => withRuntimeLock(root, async () => "bad"), /EEXIST/);
				throw new Error("owned failure");
			}),
		/owned failure/,
	);
	assert.equal(await withRuntimeLock(root, async () => "released"), "released");
});
test("managed hosts pin their startup version and new hosts see the selected version", async () => {
	const { root, candidate } = fixture();
	candidate.smoke = true;
	candidate.contractHash = runtimeContractHash;
	const payload = "mock executable";
	candidate.binarySha256 = sha256(payload);
	const next = { ...candidate, id: "0.33.4-next", version: "0.33.4" };
	for (const c of [candidate, next]) {
		mkdirSync(join(root, "versions", c.id), { recursive: true });
		writeFileSync(join(root, "versions", c.id, "cua-driver.exe"), payload);
	}
	saveRuntimeState(root, { candidates: [candidate, next], active: candidate.id });
	const connected: string[] = [];
	const connect = async (options: { binary: string; direct?: boolean }) => {
		assert.equal(options.direct, true);
		connected.push(options.binary);
		return { call: async () => ({ structuredContent: { windows: [] } }), close: async () => {} };
	};
	const running = new CuaMcpDriver({ binary: `managed:${root}`, defaultTimeoutMs: 1000 }, connect);
	saveRuntimeState(root, selectRuntime(readRuntimeState(root), next.id, runtimeContractHash));
	const fresh = new CuaMcpDriver({ binary: `managed:${root}`, defaultTimeoutMs: 1000 }, connect);
	await running.run(["call", "list_windows", '{"session":"old"}']);
	await fresh.run(["call", "list_windows", '{"session":"new"}']);
	assert.ok(connected[0].includes(candidate.id));
	assert.ok(connected[1].includes(next.id));
	await assert.rejects(() => running.run(["call", "list_windows", "{}", "--socket", "shared"]), /external daemon/);
});
test("schema comparison ignores prose but preserves validation and property names", () => {
	assert.equal(
		canonicalSchema({ type: "object", description: "old" }),
		canonicalSchema({ description: "new", type: "object" }),
	);
	assert.notEqual(
		canonicalSchema({ properties: { description: { type: "string" } } }),
		canonicalSchema({ properties: {} }),
	);
	assert.notEqual(canonicalSchema({ required: ["pid"] }), canonicalSchema({ required: ["pid", "window_id"] }));
});

test("update cache is scoped to the checked binary and failures retain old evidence", async () => {
	const { root } = fixture();
	const state = {
		candidates: [],
		checkedAt: new Date().toISOString(),
		checkedBinary: "missing-first",
		update: { latest_version: "0.33.4" },
	};
	saveRuntimeState(root, state);
	assert.deepEqual(await checkRuntimeUpdate(root, "missing-first"), state.update);
	await assert.rejects(() => checkRuntimeUpdate(root, "missing-next"), /ENOENT/);
	assert.deepEqual(readRuntimeState(root), state);
});
test("managed update command is human-only and fixture verification requires live consent", async () => {
	const { root, candidate } = fixture();
	const payload = "mock executable";
	candidate.smoke = true;
	candidate.contractHash = runtimeContractHash;
	candidate.binarySha256 = sha256(payload);
	mkdirSync(join(root, "versions", candidate.id), { recursive: true });
	writeFileSync(join(root, "versions", candidate.id, "cua-driver.exe"), payload);
	saveRuntimeState(root, { candidates: [candidate], active: candidate.id });
	let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
	const notifications: string[] = [];
	let confirmed = 0;
	const pi = {
		registerCommand: (name: string, spec: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
			assert.equal(name, "cua");
			command = spec;
		},
		on: () => {},
		registerTool: () => {
			throw new Error("Update must not be an agent tool");
		},
	} as unknown as ExtensionAPI;
	const driver = new CuaMcpDriver({ binary: `managed:${root}`, defaultTimeoutMs: 1000 });
	registerCuaManagement(pi, driver);
	assert.ok(command);
	const ctx = {
		hasUI: false,
		isIdle: () => true,
		ui: {
			confirm: async () => {
				confirmed++;
				return false;
			},
			notify: (message: string) => notifications.push(message),
		},
	} as unknown as ExtensionCommandContext;
	await command.handler("verify candidate", ctx);
	assert.equal(confirmed, 0);
	assert.match(notifications[0], /idle interactive/);
	await command.handler("verify candidate", { ...ctx, hasUI: true });
	assert.equal(confirmed, 1);
	assert.equal(notifications.length, 1);
	await command.handler("status", ctx);
	assert.match(notifications[1], /runningBinary/);
});
