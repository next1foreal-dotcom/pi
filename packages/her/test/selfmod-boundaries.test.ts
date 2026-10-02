import assert from "node:assert/strict";
import test from "node:test";
import {
	classifyDiffPaths,
	disallowedTargetPaths,
	isSelfmodAllowedPath,
	isUnsafeSelfmodTarget,
} from "../src/her-core/selfmod-paths.ts";
import { isAllowedSelfModPath, isAnchorPath } from "../src/rsi/anchors.ts";

const valid = "packages/her/pi-package/skills/her-intake/SKILL.md";
const unsafe = [
	"packages/her/pi-package/skills/her-intake/../../../src/rsi/anchors.ts",
	"packages\\her\\pi-package\\skills\\her-intake\\..\\..\\..\\src\\rsi\\anchors.ts",
	"packages/her/pi-package/skills/her-intake/../her-design/SKILL.md",
	`${valid}:stream`,
	`${valid}\u0000`,
	`${valid}\n`,
	"packages/her/pi-package/skills/her-intake/.. /escape.md",
	"packages/her/pi-package/skills/her-intake/NUL.md",
	"/packages/her/pi-package/skills/her-intake/SKILL.md",
	"C:\\packages\\her\\pi-package\\skills\\her-intake\\SKILL.md",
	"\\\\server\\packages\\her\\pi-package\\skills\\her-intake\\SKILL.md",
];

for (const path of unsafe) {
	test(`all selfmod boundaries refuse ${JSON.stringify(path)}`, () => {
		assert.equal(isUnsafeSelfmodTarget(path), true);
		assert.equal(isAllowedSelfModPath(path), false);
		assert.equal(isSelfmodAllowedPath(path), false);
		assert.deepEqual(disallowedTargetPaths([path]), [path]);
		assert.deepEqual(classifyDiffPaths([path]).allowlistViolations, [path]);
	});
}

for (const path of [valid, valid.replaceAll("/", "\\"), `./${valid}`, valid.toUpperCase()]) {
	test(`owned skill remains permitted: ${path}`, () => {
		assert.equal(isUnsafeSelfmodTarget(path), false);
		assert.equal(isAllowedSelfModPath(path), true);
		assert.equal(isSelfmodAllowedPath(path), true);
		assert.deepEqual(disallowedTargetPaths([path]), []);
		assert.deepEqual(classifyDiffPaths([path]).allowlistViolations, []);
	});
}

test("unowned skill is still rejected by the ownership gate", () => {
	const path = "packages/her/pi-package/skills/not-her/SKILL.md";
	assert.deepEqual(disallowedTargetPaths([path]), [path]);
	assert.deepEqual(classifyDiffPaths([path]).allowlistViolations, [path]);
});

test("allowlist does not accept a lookalike directory", () => {
	const path = "packages/her/pi-package/skills-evil/her-intake/SKILL.md";
	assert.equal(isAllowedSelfModPath(path), false);
	assert.equal(isSelfmodAllowedPath(path), false);
});

test("runtime anchor itself remains protected at both entrypoints", () => {
	const path = "packages/her/src/rsi/anchors.ts";
	assert.equal(isAnchorPath(path), true);
	assert.deepEqual(classifyDiffPaths([path]).anchorHits, [path]);
});

test("package-relative policy directory remains protected", () => {
	const path = "packages/her/pi-package/policies/allow.cedar";
	assert.equal(isAnchorPath(path), true);
	assert.deepEqual(classifyDiffPaths([path]).anchorHits, [path]);
});

test("owned skill accepts an ordinary Unicode filename without expanding scope", () => {
	const path = "packages/her/pi-package/skills/her-intake/例子.md";
	assert.deepEqual(disallowedTargetPaths([path]), []);
});

test("ownership names require an exact match, not a prefix", () => {
	const path = valid.replace("her-intake", "her-intake-evil");
	assert.deepEqual(disallowedTargetPaths([path]), [path]);
	assert.deepEqual(classifyDiffPaths([path]).allowlistViolations, [path]);
});
