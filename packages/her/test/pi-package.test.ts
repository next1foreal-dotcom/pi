import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const herRoot = join(process.cwd(), "packages", "her");
const projectAgentsRoot = join(process.cwd(), ".pi", "agents");

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
	assert.match(prompt, /CONTEXT\.md and FACTS\.md are injected/);
	assert.match(prompt, /her_recall/);
	assert.match(prompt, /her_world_note/);
	assert.match(prompt, /Never fabricate intake coverage/);
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
		assert.match(packageText, /CONTEXT\/FACTS/);
	}

	const ideaEngine = await readFile(join(projectAgentsRoot, "idea-engine.md"), "utf8");
	assert.match(ideaEngine, /her_recall/);
	assert.match(ideaEngine, /her_idea/);
});
