import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CuaMcpDriver } from "./mcp-driver.ts";
import { parseDriverResult, record } from "./result.ts";

/** Explicit local acceptance only: isolated browser, loopback fixture, no account or model. */
export async function smokeRuntime(binary: string, evidence: string): Promise<void> {
	await mkdir(evidence, { recursive: true });
	const downloads = join(evidence, `downloads-${randomUUID()}`);
	await mkdir(downloads);
	const upload = join(evidence, "upload.txt");
	await writeFile(upload, "Her CUA upload fixture");
	let saved = "";
	const html = `<!doctype html><title>Her CUA update fixture</title><h1>Her CUA update verification</h1><label>Fixture value<input aria-label="Fixture value" id="value"></label><button onclick="fetch('/save?value='+encodeURIComponent(document.querySelector('#value').value)).then(()=>document.querySelector('#status').textContent='Saved '+document.querySelector('#value').value)">Save fixture</button><p id="status">Waiting</p><label>Upload fixture<input type="file" aria-label="Upload fixture" onchange="document.querySelector('#upload').textContent=this.files[0].name"></label><p id="upload"></p><a href="/download" download="fixture.txt">Download fixture</a>`;
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (url.pathname === "/save") {
			saved = url.searchParams.get("value") ?? "";
			res.end("ok");
		} else if (url.pathname === "/download") {
			res.writeHead(200, {
				"Content-Type": "text/plain",
				"Content-Disposition": "attachment; filename=fixture.txt",
			});
			res.end("Her CUA download fixture");
		} else {
			res.writeHead(200, { "Content-Type": "text/html" });
			res.end(html);
		}
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const session = `her-update-${randomUUID()}`;
	const driver = new CuaMcpDriver({ binary, defaultTimeoutMs: 45000, direct: true });
	const checks: string[] = [];
	const call = async (name: string, input: Record<string, unknown>) => {
		console.log(`[CUA verify] ${name}`);
		const result = parseDriverResult(await driver.run(["call", name, JSON.stringify({ ...input, session })]));
		checks.push(name);
		return result;
	};
	const ref = (page: Record<string, unknown>, label: string): string => {
		const refs = Array.isArray(page.refs)
			? page.refs.map(record)
			: Object.entries(record(page.refs)).map(([key, value]) => ({ ...record(value), ref: key }));
		const found = refs.find((item) => JSON.stringify(item).includes(label));
		assert.equal(typeof found?.ref, "string", `Missing fixture ref: ${label}`);
		return String(found?.ref);
	};
	try {
		const prepared = await call("browser_prepare", { allow_launch: true, profile: { mode: "isolated_new" } });
		assert.equal(typeof prepared.prepared_pid, "number");
		const windows = await call("list_windows", { pid: prepared.prepared_pid });
		const matches = (Array.isArray(windows.windows) ? windows.windows.map(record) : []).filter(
			(w) => w.pid === prepared.prepared_pid,
		);
		assert.equal(matches.length, 1, "Isolated fixture window must be unambiguous");
		const exact = { pid: prepared.prepared_pid, window_id: matches[0].window_id };
		const window = await call("get_window_state", { ...exact, include_screenshot: true });
		assert.equal(typeof window.screenshot_png_b64, "string");
		const verified = await call("verify_state", {
			...exact,
			expect: [{ window: { exists: true } }],
			stable_samples: 2,
			timeout_ms: 5000,
		});
		assert.equal(verified.status, "satisfied");
		assert.equal(verified.stable, true);
		const bound = await call("get_browser_state", exact);
		assert.ok(Array.isArray(bound.tabs) && bound.tabs.length > 0);
		const target = { target_id: bound.target_id, tab_id: record(bound.tabs[0]).tab_id };
		const observe = () =>
			call("get_browser_state", { ...target, snapshot_format: "semantic_v2", include_screenshot: false });
		const observeUntil = async (expected: string) => {
			const deadline = Date.now() + 5000;
			while (true) {
				const page = await observe();
				if (JSON.stringify(page).includes(expected)) return page;
				if (Date.now() >= deadline) throw new Error(`Fixture state did not settle: ${expected}`);
				await delay(100);
			}
		};
		await call("browser_navigate", { ...target, url: `http://127.0.0.1:${address.port}/` });
		let page = await observe();
		await writeFile(
			join(evidence, "fixture-state.json"),
			JSON.stringify(page, (key, value) => (key === "screenshot_png_b64" ? "[image omitted]" : value)),
		);
		await call("browser_dialog", { ...target, action: "inspect" });
		await call("browser_type", {
			...target,
			ref: ref(page, "Fixture value"),
			text: "Her update verified",
			replace: true,
		});
		page = await observe();
		await call("browser_click", { ...target, ref: ref(page, "Save fixture") });
		page = await observeUntil("Saved Her update verified");
		assert.equal(saved, "Her update verified");
		assert.ok(JSON.stringify(page).includes("Saved Her update verified"));
		await call("browser_pointer", { ...target, action: "hover", ref: ref(page, "Save fixture") });
		page = await observe();
		await call("browser_set_input_files", { ...target, ref: ref(page, "Upload fixture"), files: [upload] });
		page = await observe();
		assert.ok(JSON.stringify(page).includes("upload.txt"));
		await call("browser_download", {
			...target,
			ref: ref(page, "Download fixture"),
			destination_root: downloads,
		});
		// Inspect only this run's fresh destination, never a path supplied in the driver response.
		const files = await readdir(downloads, { recursive: true, withFileTypes: true });
		const payloads = await Promise.all(
			files.filter((f) => f.isFile()).map((f) => readFile(join(f.parentPath, f.name), "utf8")),
		);
		assert.ok(payloads.includes("Her CUA download fixture"));
		const final = await call("get_browser_state", { ...target, include_screenshot: true });
		if (typeof final.screenshot_png_b64 === "string")
			await writeFile(join(evidence, "browser.png"), Buffer.from(final.screenshot_png_b64, "base64"));
		await writeFile(
			join(evidence, "checks.json"),
			JSON.stringify({ checks, result: "passed", saved, checkedAt: new Date().toISOString() }, null, 2),
		);
	} finally {
		try {
			await call("end_session", {});
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	}
}
