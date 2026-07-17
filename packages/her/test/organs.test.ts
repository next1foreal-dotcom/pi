import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const repoRoot = process.cwd();

async function text(...parts: string[]): Promise<string> {
	return readFile(join(repoRoot, ...parts), "utf8");
}

async function json<T = Record<string, unknown>>(...parts: string[]): Promise<T> {
	return JSON.parse(await text(...parts)) as T;
}

test("Phase 6 organs are project-pinned and documented", async () => {
	const settings = await json<{ packages: string[]; extensions: string[] }>(".pi", "settings.json");
	// 7/16 package convergence: these organs are no longer pinned individually in
	// .pi/settings.json. They now ship transitively through the single local
	// "D:/@Her/fei-pi-preset" package (see that preset's package.json dependencies).
	// This list is still used below to confirm ORGANS.md documents each organ.
	const documented = [
		"git:github.com/nicobailon/pi-subagents@efa7120047eaf76a32620eed0ec7d038b6cfa44e",
		"git:github.com/Michaelliv/pi-dynamic-workflows@31b2aca0f1cb195aafbfc5e3ee2b8c83ad3f21a2",
		"git:github.com/fitchmultz/pi-codex-goal@e1fd927fc8df5b13c3b96e1a23788204b6173c5f",
		"git:github.com/fitchmultz/pi-agent-browser-native@6a1e387bcf4e7c11a0a0610a359f2d592a099532",
		"git:github.com/nicobailon/pi-web-access@076bf0db5e739b200286ca37486e4edd8d19123c",
		"git:github.com/nicobailon/pi-powerline-footer@e34dacc8a9b932e4990db949d473ac01abdb03e1",
		"npm:pi-oracle@0.7.5",
		"npm:agent-eval@0.0.1",
		"npm:@ff-labs/pi-fff@0.9.0",
		"npm:@howaboua/pi-semantic-grep@0.1.12",
	];

	assert.deepEqual(settings.extensions, ["./extensions/her/index.ts"]);
	assert.ok(
		settings.packages.includes("D:/@Her/fei-pi-preset"),
		"fei-pi-preset is pinned in .pi/settings.json after package convergence",
	);

	for (const spec of settings.packages) {
		if (spec.startsWith("git:")) assert.match(spec, /^git:github\.com\/[^@]+@[0-9a-f]{40}$/);
		if (spec.startsWith("npm:")) assert.match(spec, /^npm:(?:@[^/]+\/)?[^@]+@\d+\.\d+\.\d+$/);
	}

	const organs = await text("packages", "her", "ORGANS.md");
	for (const spec of documented) {
		const marker = spec
			.replace(/^git:github\.com\//, "")
			.replace(/^npm:/, "")
			.split("@")[0];
		assert.match(organs, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	}
	assert.match(organs, /no public disable flag/);
	assert.match(organs, /repo-local golden tests/);
});

test("Phase 6 external organs expose the expected additive entrypoints", async () => {
	const workflowPkg = await json<{ pi: { extensions: string[] } }>(
		".pi",
		"git",
		"github.com",
		"Michaelliv",
		"pi-dynamic-workflows",
		"package.json",
	);
	assert.deepEqual(workflowPkg.pi.extensions, ["extensions/workflow.ts"]);
	const workflowExt = await text(
		".pi",
		"git",
		"github.com",
		"Michaelliv",
		"pi-dynamic-workflows",
		"extensions",
		"workflow.ts",
	);
	assert.match(workflowExt, /registerTool\(workflowTool\)/);
	assert.match(workflowExt, /setActiveTools/);

	const goalReadme = await text(".pi", "git", "github.com", "fitchmultz", "pi-codex-goal", "README.md");
	assert.match(goalReadme, /get_goal/);
	assert.match(goalReadme, /create_goal/);
	assert.match(goalReadme, /update_goal/);
	assert.match(goalReadme, /sends hidden steering messages/);

	const oraclePkg = await json<{ pi: { extensions: string[] } }>(
		".pi",
		"npm",
		"node_modules",
		"pi-oracle",
		"package.json",
	);
	assert.deepEqual(oraclePkg.pi.extensions, ["./extensions/oracle/index.ts"]);
	const oracleTools = await text(".pi", "npm", "node_modules", "pi-oracle", "extensions", "oracle", "lib", "tools.ts");
	for (const tool of ["oracle_preflight", "oracle_auth", "oracle_submit", "oracle_read", "oracle_cancel"]) {
		assert.match(oracleTools, new RegExp(`name: "${tool}"`));
	}
});

test("W0 workflow capability decision is documented", async () => {
	const organs = await text("packages", "her", "ORGANS.md");
	assert.match(organs, /W0 workflow capability spike/);
	assert.match(organs, /adversarial validation/);
	assert.match(organs, /fresh in-memory Pi sessions/);
	assert.match(organs, /no persisted resume/);
	assert.match(organs, /isolation: "worktree" is prompt-only/);
	assert.match(organs, /quarantine/);
	assert.match(organs, /parent-only persistence/);
	assert.match(organs, /thin Her orchestrator/);
});

test("growth loop has a single TS her-core owner", async () => {
	const organs = await text("packages", "her", "ORGANS.md");
	const readme = await text("packages", "her", "README.md");
	for (const source of [organs, readme]) {
		assert.match(source, /owner = TS her-core|Growth-loop owner = TS/);
		assert.match(source, /capture-only/);
	}
	assert.match(organs, /must not run scheduled growth maintenance/);
	assert.match(readme, /FACTS\.md.*read-only/);
});

test("W0 minimal adversarial workflow runs with structured keep/drop result", async () => {
	const workflowModule = (await import(
		pathToFileURL(
			join(repoRoot, ".pi", "git", "github.com", "Michaelliv", "pi-dynamic-workflows", "src", "workflow.ts"),
		).href
	)) as {
		runWorkflow(script: string, options: Record<string, unknown>): Promise<{ result: unknown; agentCount: number }>;
	};
	const result = await workflowModule.runWorkflow(
		`
export const meta = {
  name: "her_context_candidate_check",
  description: "Synthesize one candidate and ask a skeptic to keep or drop it"
}

phase("Synthesize")
const candidate = await agent("Synthesize one CONTEXT candidate from source evidence.", {
  label: "candidate",
  schema: {
    type: "object",
    properties: { change: { type: "string" } },
    required: ["change"]
  }
})

phase("Verify")
const verdict = await agent("Skeptic: try to falsify this candidate before it reaches CONTEXT: " + JSON.stringify(candidate), {
  label: "skeptic",
  schema: {
    type: "object",
    properties: {
      verdict: { type: "string" },
      reason: { type: "string" }
    },
    required: ["verdict", "reason"]
  }
})

return { kept: verdict.verdict === "keep", candidate, verdict }
`,
		{
			agent: {
				async run(_prompt: string, options: { label?: string }) {
					if (options.label === "candidate") return { change: "Fei values evidence over reassurance." };
					return { verdict: "keep", reason: "The source evidence directly supports the candidate." };
				},
			},
		},
	);

	assert.equal(result.agentCount, 2);
	assert.deepEqual(JSON.parse(JSON.stringify(result.result)), {
		kept: true,
		candidate: { change: "Fei values evidence over reassurance." },
		verdict: { verdict: "keep", reason: "The source evidence directly supports the candidate." },
	});
});

test("Her batch intake routes workflow results back into Her memory", async () => {
	const skill = await text("packages", "her", "pi-package", "skills", "her-batch-intake", "SKILL.md");
	assert.match(skill, /workflow/);
	assert.match(skill, /parallel/);
	assert.match(skill, /claim ledger/);
	assert.match(skill, /claim-verifier/);
	assert.match(skill, /supported/);
	assert.match(skill, /insufficient_evidence/);
	assert.match(skill, /her_world_note/);
	assert.match(skill, /her_intake_source/);
	assert.match(skill, /her_judgment/);
	assert.match(skill, /coverage/);
	assert.match(skill, /Never persist secrets/);

	const config = await text("packages", "her", "pi-package", "samantha.config.md");
	assert.match(config, /her-batch-intake/);
	assert.match(config, /claim-ledger verification/);
	assert.match(config, /active `pi-codex-goal`/);
	assert.match(config, /repo-local node tests/);
});

test("agent-eval pin is present but treated as placeholder at this version", async () => {
	const pkg = await json<{ name: string; version: string }>(
		".pi",
		"npm",
		"node_modules",
		"agent-eval",
		"package.json",
	);
	const files = await readdir(join(repoRoot, ".pi", "npm", "node_modules", "agent-eval"));
	assert.equal(pkg.name, "agent-eval");
	assert.equal(pkg.version, "0.0.1");
	assert.deepEqual(files.sort(), ["LICENSE", "README.md", "package.json"]);
});

test("PATCHES only documents generic upstream seams", async () => {
	const patches = await text("packages", "her", "PATCHES.md");
	const entries = patches
		.split(/\n(?=## )/)
		.slice(1)
		.map((entry) => entry.trim())
		.filter(Boolean);

	for (const entry of entries) {
		assert.match(entry, /- Scope: generic extension seam\./);
		assert.match(entry, /packages\/coding-agent\/src\//);
		assert.doesNotMatch(entry, /packages\/her\//);
		assert.doesNotMatch(entry, /\.pi\//);
		assert.doesNotMatch(entry, /her-memory/);
	}
});
