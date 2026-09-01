/**
 * G-375 first slice — her-design skill shape (knowledge home).
 *
 * Run from repo root:
 *   node --import tsx --test packages/her/test/her-design-skill.test.ts
 */

import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { SELFMOD_OWNED_SKILLS } from "../src/her-core/selfmod-types.ts";

const herRoot = join(process.cwd(), "packages", "her");
const skillRoot = join(herRoot, "pi-package", "skills", "her-design");
const herMdPath = join(herRoot, "pi-package", "prompts", "her.md");

// Task 搬运清单 (explicit paths; the package text said "26", the list is 29)
// + 2 authored at landing: process/steps.md (W2 first piece), process/to-code.md (W4, intake #9).
const HER_DESIGN_REFERENCE_FILES = [
	"design/foundations.md",
	"design/colors.md",
	"design/typography.md",
	"design/details.md",
	"design/composition.md",
	"design/blocks/actions.md",
	"design/blocks/layout.md",
	"process/direction-first.md",
	"process/variants.md",
	"process/tokens-first.md",
	"process/flows.md",
	"process/visual-review.md",
	"process/references.md",
	"process/filing.md",
	"process/steps.md",
	"process/brief.md",
	"process/research.md",
	"process/wireframe.md",
	"research/positive-samples.md",
	"design/arrangement.md",
	"process/to-code.md",
	"review/rubric.md",
	"review/refine-order.md",
	"review/anti-generic.md",
	"review/no-vision-verify.md",
	"review/rendered-page-verify.md",
	"charts/bar-charts.md",
	"charts/line-charts.md",
	"charts/tables.md",
	"charts/sparklines.md",
	"effects/gradients.md",
	"effects/shadows.md",
	"effects/svg-filters.md",
	"effects/dark-mode.md",
	"recreation/from-image.md",
	"recreation/from-description.md",
] as const;

async function mustBeFile(path: string): Promise<void> {
	const info = await stat(path);
	assert.equal(info.isFile(), true, `${path} must be a file`);
}

test("her-design skill exists with frontmatter name, 36 references, and her.md owned-skills entry", async () => {
	const skillPath = join(skillRoot, "SKILL.md");
	const skill = await readFile(skillPath, "utf8");
	const normalized = skill.replace(/\r\n/g, "\n");
	assert.ok(normalized.startsWith("---\n"), "SKILL.md must start with YAML frontmatter");
	const endIndex = normalized.indexOf("\n---", 3);
	assert.ok(endIndex !== -1, "SKILL.md frontmatter must close");
	const frontmatter = normalized.slice(4, endIndex);
	assert.match(frontmatter, /^name:\s*her-design\s*$/m);

	for (const rel of HER_DESIGN_REFERENCE_FILES) {
		await mustBeFile(join(skillRoot, "references", ...rel.split("/")));
	}

	const prompt = await readFile(herMdPath, "utf8");
	assert.match(
		prompt,
		/You can change your own skills[^\n]*`her-design`/,
		"her.md owned-skills list must include her-design",
	);
});

test("her-design is machine-owned, not just claimed: SELFMOD_OWNED_SKILLS includes it", () => {
	// SKILL.md tells her "this skill is yours" — the selfmod fence must agree,
	// or every her-design proposal dies at isOwnedSkillPath.
	assert.ok(SELFMOD_OWNED_SKILLS.includes("her-design"));
});
