import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);

test.runIf(process.platform === "win32")(
	"starts and reaches the experimental server over a Windows named pipe",
	async () => {
		const resolver = new URL("../src/experimental/source-resolver.ts", import.meta.url);
		const entry = new URL("fixtures/experimental-windows-server.mts", import.meta.url);
		const { stdout } = await execFileAsync(process.execPath, ["--import", resolver.href, fileURLToPath(entry)], {
			timeout: 20_000,
			windowsHide: true,
		});
		expect(stdout).toMatch(/^socket=\\\\\.\\pipe\\pi-[0-9a-f]{16}-/m);
		expect(stdout).toContain(
			'result={"kind":"list","sessions":[{"serverId":"00000000-0000-4000-8000-000000000001","sessionId":"demo-1"}]}',
		);
	},
);
