import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	advanceConsolidateCursor,
	type ParsedConsolidateCursor,
	parseConsolidateCursor,
	shouldUseRawEpisode,
} from "../src/her-core/memory-cursor.ts";
import { safeStem } from "../src/her-core/memory-utils.ts";
import { parseFrontmatter } from "../src/her-core/store.ts";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "contracts", "shared-data");
const RAW_REQUIRED = ["id", "timestamp", "project", "session_id"] as const;

type FilterProbe = { ts: string; id: string; included: boolean };
type ParseExpect =
	| { ok: true; value: null | { ts: string; done_ids: string[]; legacy: boolean } }
	| { ok: false; error: string };
type DoctorExpect = {
	shape?: "pass" | "fail";
	timestamp?: "pass" | "fail";
	later_than_newest?: boolean;
	newest_episode_ts?: string;
};
type Fixture = {
	surface: string;
	case: string;
	valid: boolean;
	filename?: string;
	input?: unknown;
	input_file?: string;
	expect: {
		parse?: ParseExpect;
		doctor?: DoctorExpect;
		filter?: FilterProbe[];
		data?: Record<string, unknown>;
		body?: string;
		schema_missing?: string[];
		ts?: string;
		done_ids?: string[];
		filename?: string;
		required_keys?: string[];
		cursor?: unknown;
		last_consolidate?: unknown;
		last_synthesize?: unknown;
		last_synthesize_format?: string;
	};
};

function loadFixture(name: string): Fixture {
	const parsed = JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")) as Fixture;
	assert.equal(typeof parsed.surface, "string", `${name}: surface`);
	assert.equal(typeof parsed.case, "string", `${name}: case`);
	return parsed;
}

function resolveInput(fixture: Fixture): unknown {
	if (fixture.input_file) {
		// Goldens are LF. Normalize so a CRLF checkout does not become the contract.
		return readFileSync(join(FIXTURE_DIR, fixture.input_file), "utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	}
	return fixture.input;
}

function parsedCursorValue(parsed: ParsedConsolidateCursor | null): null | {
	ts: string;
	done_ids: string[];
	legacy: boolean;
} {
	if (parsed === null) return null;
	return { ts: parsed.ts, done_ids: [...parsed.doneIds].sort(), legacy: parsed.legacy };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Mirrors doctor.ts parseTimestamp (DR-02). */
function doctorTimestampOk(raw: string): boolean {
	const text = raw.trim().replace(/_/g, ":");
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) return false;
	const ms = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(text) ? text : `${text}Z`);
	return Number.isFinite(ms);
}

/** Mirrors doctor.ts checkCursor shape rules (DR-02). */
function doctorShape(cursor: unknown): "pass" | "fail" {
	if (cursor === null || cursor === undefined) return "pass";
	if (typeof cursor === "string") return "pass";
	if (
		isRecord(cursor) &&
		!Array.isArray(cursor) &&
		typeof cursor.ts === "string" &&
		Array.isArray(cursor.done_ids) &&
		cursor.done_ids.every((item) => typeof item === "string")
	) {
		return "pass";
	}
	return "fail";
}

function schemaMissing(data: Record<string, unknown>): string[] {
	return RAW_REQUIRED.filter((key) => data[key] === undefined);
}

function assertDoctor(fixtureName: string, cursor: unknown, doctor: DoctorExpect): void {
	if (doctor.shape) {
		assert.equal(doctorShape(cursor), doctor.shape, `${fixtureName}: doctor.shape`);
	}
	if (doctor.timestamp) {
		const raw =
			typeof cursor === "string"
				? cursor
				: isRecord(cursor) && typeof cursor.ts === "string"
					? cursor.ts
					: undefined;
		assert.equal(typeof raw, "string", `${fixtureName}: doctor.timestamp needs a string ts`);
		assert.equal(doctorTimestampOk(raw as string), doctor.timestamp === "pass", `${fixtureName}: doctor.timestamp`);
	}
	if (doctor.later_than_newest) {
		assert.equal(typeof cursor, "string", `${fixtureName}: future cursor is a string`);
		assert.equal(typeof doctor.newest_episode_ts, "string", `${fixtureName}: newest_episode_ts`);
		const cursorMs = Date.parse(`${String(cursor).replace(/_/g, ":")}Z`);
		const newestMs = Date.parse(`${doctor.newest_episode_ts!.replace(/_/g, ":")}Z`);
		assert.ok(cursorMs > newestMs, `${fixtureName}: cursor must be later than newest episode`);
	}
}

function assertCursorParse(fixtureName: string, input: unknown, expected: ParseExpect): ParsedConsolidateCursor | null {
	if (!expected.ok) {
		assert.throws(
			() => parseConsolidateCursor(input),
			(error: unknown) => {
				assert.ok(error instanceof Error, `${fixtureName}: parse error type`);
				assert.equal(error.message, expected.error, `${fixtureName}: parse error`);
				return true;
			},
		);
		return null;
	}
	const parsed = parseConsolidateCursor(input);
	assert.deepEqual(parsedCursorValue(parsed), expected.value, `${fixtureName}: parse value`);
	return parsed;
}

function assertFilters(fixtureName: string, parsed: ParsedConsolidateCursor | null, probes: FilterProbe[]): void {
	for (const probe of probes) {
		assert.equal(
			shouldUseRawEpisode(probe.ts, probe.id, parsed),
			probe.included,
			`${fixtureName}: filter ${probe.id} ts=${probe.ts}`,
		);
	}
}

const files = readdirSync(FIXTURE_DIR)
	.filter((name) => name.endsWith(".json"))
	.sort();
assert.ok(files.length > 0, `no JSON fixtures in ${FIXTURE_DIR}`);

for (const name of files) {
	const fixture = loadFixture(name);
	test(`shared-data ${fixture.surface}/${fixture.case}`, () => {
		const input = resolveInput(fixture);
		switch (fixture.surface) {
			case "consolidate-cursor": {
				assert.ok(fixture.expect.parse, `${name}: parse expect`);
				const parsed = assertCursorParse(name, input, fixture.expect.parse);
				if (fixture.expect.doctor) assertDoctor(name, input, fixture.expect.doctor);
				if (fixture.expect.filter && fixture.expect.parse.ok) {
					assertFilters(name, parsed, fixture.expect.filter);
				}
				return;
			}
			case "consolidate-cursor-advance": {
				assert.ok(isRecord(input), `${name}: advance input object`);
				const cursor = parseConsolidateCursor(input.cursor);
				const episodes = input.episodes as { ts: string; cursorId: string }[];
				const advanced = advanceConsolidateCursor(cursor, episodes);
				assert.equal(advanced.ts, fixture.expect.ts, `${name}: advanced.ts`);
				assert.deepEqual(advanced.done_ids, fixture.expect.done_ids, `${name}: advanced.done_ids`);
				return;
			}
			case "raw-episode-frontmatter": {
				assert.equal(typeof input, "string", `${name}: markdown input`);
				const parsed = parseFrontmatter(input as string);
				if (fixture.expect.data) {
					assert.deepEqual(parsed.data, fixture.expect.data, `${name}: frontmatter data`);
				}
				if (fixture.expect.body !== undefined) {
					assert.equal(parsed.body, fixture.expect.body, `${name}: frontmatter body`);
				}
				if (fixture.expect.schema_missing) {
					assert.deepEqual(schemaMissing(parsed.data), fixture.expect.schema_missing, `${name}: schema_missing`);
				}
				if (
					fixture.filename &&
					typeof parsed.data.timestamp === "string" &&
					typeof parsed.data.session_id === "string"
				) {
					assert.equal(
						`${safeStem(parsed.data.timestamp)}--${safeStem(parsed.data.session_id)}.md`,
						fixture.filename,
						`${name}: filename from frontmatter`,
					);
				}
				return;
			}
			case "raw-filename": {
				assert.ok(isRecord(input), `${name}: filename input`);
				const timestamp = input.timestamp;
				const sessionId = input.session_id;
				assert.equal(typeof timestamp, "string", `${name}: timestamp`);
				assert.equal(typeof sessionId, "string", `${name}: session_id`);
				assert.equal(
					`${safeStem(timestamp as string)}--${safeStem(sessionId as string)}.md`,
					fixture.expect.filename,
					`${name}: filename`,
				);
				return;
			}
			case "state-json": {
				assert.ok(isRecord(input), `${name}: state object`);
				for (const key of fixture.expect.required_keys ?? []) {
					assert.ok(key in input, `${name}: missing key ${key}`);
				}
				if ("cursor" in fixture.expect) assert.equal(input.cursor, fixture.expect.cursor, `${name}: cursor`);
				if ("last_consolidate" in fixture.expect) {
					assert.equal(input.last_consolidate, fixture.expect.last_consolidate, `${name}: last_consolidate`);
				}
				if ("last_synthesize" in fixture.expect) {
					assert.equal(input.last_synthesize, fixture.expect.last_synthesize, `${name}: last_synthesize`);
				}
				if (fixture.expect.last_synthesize_format) {
					assert.equal(typeof input.last_synthesize, "string", `${name}: last_synthesize type`);
					assert.match(
						input.last_synthesize as string,
						new RegExp(fixture.expect.last_synthesize_format),
						`${name}: last_synthesize format`,
					);
				}
				return;
			}
			default:
				assert.fail(`${name}: unknown surface ${fixture.surface}`);
		}
	});
}
