import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const herRoot = join(process.cwd(), "packages", "her");
const projectAgentsRoot = join(process.cwd(), ".pi", "agents");
const projectPromptsRoot = join(process.cwd(), ".pi", "prompts");
const subagentPin = "git:github.com/nicobailon/pi-subagents@efa7120047eaf76a32620eed0ec7d038b6cfa44e";

const parseSimpleFrontmatter = (text: string): { frontmatter: Record<string, string>; body: string } => {
	const normalized = text.replace(/\r\n/g, "\n");
	const endIndex = normalized.indexOf("\n---", 3);
	assert.ok(normalized.startsWith("---") && endIndex !== -1, "agent markdown must start with frontmatter");
	const frontmatter: Record<string, string> = {};
	for (const line of normalized.slice(4, endIndex).split("\n")) {
		const match = line.match(/^([\w-]+):\s*(.*)$/);
		if (match) frontmatter[match[1]] = match[2].trim();
	}
	return { frontmatter, body: normalized.slice(endIndex + 4).trim() };
};

test("her-intake skill encodes the universal inbox contract", async () => {
	const skill = await readFile(join(herRoot, "pi-package", "skills", "her-intake", "SKILL.md"), "utf8");

	for (const required of [
		"pi-web-access",
		"pi-agent-browser-native",
		"her_world_note",
		"her_remember",
		"her_judgment",
		"contentHash",
		"memoryStatus",
		"Coverage",
		"Spec §16 Checklist",
		"No secret, cookie, token, or private browser credential",
	]) {
		assert.match(skill, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	}

	for (let item = 1; item <= 16; item++) {
		assert.match(skill, new RegExp(`^${item}\\.`, "m"));
	}
});

test("Samantha prompt advertises durable memory tools", async () => {
	const prompt = await readFile(join(herRoot, "pi-package", "prompts", "her.md"), "utf8");
	assert.match(prompt, /CONTEXT\.md, FACTS\.md, SAMANTHA\.md, and CHOICE-MODEL\.md are injected/);
	assert.match(prompt, /her_recall/);
	assert.match(prompt, /her_world_note/);
	assert.match(prompt, /Never fabricate intake coverage/);
});

test("/her-intake prompt encodes the minimal source-to-memory chain", async () => {
	const packagePrompt = await readFile(join(herRoot, "pi-package", "prompts", "her-intake.md"), "utf8");
	const projectPrompt = await readFile(join(projectPromptsRoot, "her-intake.md"), "utf8");
	assert.equal(projectPrompt, packagePrompt);

	const { frontmatter, body } = parseSimpleFrontmatter(packagePrompt);
	assert.match(frontmatter.description, /Her memory/);
	assert.equal(frontmatter["argument-hint"], "<url-or-path>");

	for (const required of [
		"$ARGUMENTS",
		"her-intake",
		"fetch_content",
		"get_search_content",
		"her_recall",
		"her_intake_source",
		"her_world_note",
		"her_remember",
		"contentHash",
		"memoryStatus",
		"recall verification",
	]) {
		assert.match(body, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	}
});

test("her-intake encodes quarantine rules for untrusted source text", async () => {
	const skill = await readFile(join(herRoot, "pi-package", "skills", "her-intake", "SKILL.md"), "utf8");
	const prompt = await readFile(join(herRoot, "pi-package", "prompts", "her-intake.md"), "utf8");

	for (const text of [skill, prompt]) {
		for (const required of [
			"untrusted",
			"prompt injection",
			"do not execute instructions",
			"reader/extractor",
			"trusted memory writer",
			"no write-memory tools",
		]) {
			assert.match(text, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
		}
	}
});

test("Pi powerline promotes Her memory sync status", async () => {
	const settings = JSON.parse(await readFile(join(process.cwd(), ".pi", "settings.json"), "utf8")) as {
		powerline?: { customItems?: Array<Record<string, unknown>> };
	};
	const item = settings.powerline?.customItems?.find((entry) => entry.id === "her-sync");
	assert.ok(item);
	assert.equal(item.statusKey, "her-sync");
	assert.equal(item.position, "right");
	assert.equal(item.prefix, "Her");
});

test("Her subagents are project-discoverable and inherit memory context", async () => {
	const packageAgentsRoot = join(herRoot, "pi-package", "agents");
	const packageAgents = (await readdir(packageAgentsRoot)).filter((file) => file.endsWith(".md")).sort();
	const projectAgents = (await readdir(projectAgentsRoot)).filter((file) => file.endsWith(".md")).sort();
	assert.deepEqual(projectAgents, packageAgents);

	for (const file of packageAgents) {
		const packageText = await readFile(join(packageAgentsRoot, file), "utf8");
		const projectText = await readFile(join(projectAgentsRoot, file), "utf8");
		assert.equal(projectText, packageText);
		assert.match(packageText, /^systemPromptMode: append$/m);
		assert.match(packageText, /^inheritProjectContext: true$/m);
		assert.match(packageText, /^defaultContext: fork$/m);
		assert.match(packageText, /CONTEXT\/FACTS plus SAMANTHA\/CHOICE-MODEL/);
	}

	const ideaEngine = await readFile(join(projectAgentsRoot, "idea-engine.md"), "utf8");
	assert.match(ideaEngine, /her_recall/);
	assert.match(ideaEngine, /her_idea/);
});

test("Her Seam-2 subagents carry recall and durable writeback instructions", async () => {
	const settings = JSON.parse(await readFile(join(process.cwd(), ".pi", "settings.json"), "utf8")) as {
		packages?: string[];
	};
	assert.ok(settings.packages?.includes(subagentPin), "pi-subagents must stay pinned for project subagent runtime");

	for (const agentName of ["coder", "explorer", "reviewer"]) {
		const projectText = await readFile(join(projectAgentsRoot, `${agentName}.md`), "utf8");
		const packageText = await readFile(join(herRoot, "pi-package", "agents", `${agentName}.md`), "utf8");
		assert.equal(projectText, packageText);

		const { frontmatter, body } = parseSimpleFrontmatter(projectText);
		assert.equal(frontmatter.name, agentName);
		assert.equal(frontmatter.systemPromptMode, "append");
		assert.equal(frontmatter.inheritProjectContext, "true");
		assert.equal(frontmatter.defaultContext, "fork");
		assert.equal(frontmatter.tools, undefined, `${agentName} must not restrict away Her memory tools`);

		assert.match(body, /CONTEXT\/FACTS plus SAMANTHA\/CHOICE-MODEL/);
		assert.match(body, /her_recall/);
		assert.match(body, /her_(?:remember|world_note|judgment|idea)/);
		assert.match(body, /child transcript/);
	}
});
