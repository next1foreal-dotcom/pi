// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
	findBySourceLocation,
	type SourceLocation,
	type SourceTarget,
} from "../inspect/source-location";
import { PROBE_VALUE } from "./knobs";
import {
	liveRefindDeps,
	Properties,
	type RefindDeps,
} from "./plugin";

/**
 * A declared enum is a row of tokens, not a dropdown.
 *
 * The panel already knows which props are levers (`@editor enum`). The next
 * cut is how those levers look: sample 8 speaks in Regular / Medium / Semi,
 * None / SM / MD — chips you press, not a `<select>` you open. Inference still
 * builds nothing. An undeclared union is still not a control.
 */

const SCREEN = "packages/design-lab/src/screens/playground/screen.tsx";
const TILE = "packages/design-lab/src/screens/playground/components/Tile.tsx";
const spot: SourceTarget = { file: TILE, line: 69, column: 6 };

describe("a declared enum is chips, not a select", () => {
	let host: HTMLElement;
	let posted: { prop: string; value: unknown }[];
	let tone: string;

	function locate(el: Element): SourceLocation {
		if (el.getAttribute("data-src") === "tick") {
			return { ...spot, component: "Tile", problem: null };
		}
		return { file: null, line: null, column: null, component: null, problem: "no-react-fiber" };
	}

	function selectionFor(el: Element) {
		const loc = locate(el);
		return {
			screenId: "playground",
			file: loc.file,
			line: loc.line,
			column: loc.column,
			component: loc.component,
			tag: el.tagName.toLowerCase(),
			className: el.getAttribute("class") ?? "",
			text: "",
			attached: el.isConnected,
			problem: loc.problem,
		};
	}

	const index = {
		screens: [{ id: "playground", file: SCREEN }],
		problems: [],
		components: [
			{
				name: "Tile",
				file: TILE,
				exported: "default" as const,
				aliases: ["Tile"],
				reach: { kind: "screen" as const, path: ["playground", "PlaygroundScreen"] },
				screens: ["playground"],
				instances: [{ screenId: "playground", file: SCREEN, line: 49, column: 11, tag: "Tile" }],
				props: [
					{
						name: "tone",
						type: '"quiet" | "loud" | "warning"',
						optional: true,
						literalValues: ["quiet", "loud", "warning"],
						editor: { kind: "enum" as const, section: "Look" },
					},
					{ name: "children", type: "ReactNode", optional: true },
				],
			},
		],
	};

	function build(): Properties {
		document.body.innerHTML = "";
		const group = document.createElement("div");
		group.setAttribute("data-screen-id", "playground");
		const scroll = document.createElement("div");
		scroll.setAttribute("data-screen-scroll", "playground");
		const span = document.createElement("span");
		span.setAttribute("data-src", "tick");
		scroll.appendChild(span);
		group.appendChild(scroll);
		host = document.createElement("div");
		document.body.append(group, host);

		tone = "quiet";
		posted = [];
		const inspect = {
			selection: () => selectionFor(span),
			selectAt: () => null,
			selectElement: (el: Element) => selectionFor(el),
		};
		(window as unknown as { lab: unknown }).lab = {
			plugin: (id: string) => (id === "inspect" ? inspect : undefined),
		};

		const deps: RefindDeps = {
			root: liveRefindDeps.root,
			prime: () => Promise.resolve(),
			find: (root, want, accept) => findBySourceLocation(root, want, { accept, locate }),
			wait: () => Promise.resolve(),
		};

		const probe = JSON.stringify(PROBE_VALUE);
		return new Properties(host, {
			refind: { attempts: 4, intervalMs: 0 },
			deps,
			knobs: {
				loadIndex: () => Promise.resolve(index),
				componentAt: () => Promise.resolve("Tile"),
				fiberOf: () => ({ type: function Tile() {}, memoizedProps: { tone } }),
				post: (body) => {
					posted.push({ prop: body.prop, value: body.value });
					if (JSON.stringify(body.value) === probe) {
						return Promise.resolve({ status: 409, body: { problem: "unsafe-value" } });
					}
					tone = String(body.value.value);
					return Promise.resolve({ status: 200, body: { ok: true, changed: true } });
				},
			},
		});
	}

	async function idle(): Promise<void> {
		for (let i = 0; i < 16; i += 1) await Promise.resolve();
	}

	afterEach(() => {
		(window as unknown as { lab: unknown }).lab = undefined;
		document.body.innerHTML = "";
	});

	it("paints one chip per declared option, and no select", async () => {
		const panel = build();
		panel.sync();
		await idle();

		expect(panel.knobState().rows.map((r) => r.name)).toEqual(["tone"]);
		expect(host.querySelectorAll("select").length).toBe(0);
		const chips = Array.from(host.querySelectorAll('.pk-chip[data-prop="tone"]'));
		expect(chips.map((el) => el.getAttribute("data-chip"))).toEqual([
			"quiet",
			"loud",
			"warning",
		]);
		expect(host.querySelector('.pk-chip[data-chip="quiet"]')?.hasAttribute("data-on")).toBe(
			true,
		);
		expect(host.querySelector('.pk-chip[data-chip="loud"]')?.hasAttribute("data-on")).toBe(
			false,
		);
		expect(host.querySelectorAll('.pk-chip[data-prop="children"]').length).toBe(0);
	});

	it("pressing another chip writes that token through the same prop editor", async () => {
		const panel = build();
		panel.sync();
		await idle();

		const loud = host.querySelector('.pk-chip[data-chip="loud"]') as HTMLButtonElement;
		loud.click();
		await idle();
		await idle();

		expect(posted[posted.length - 1]).toEqual({
			prop: "tone",
			value: { as: "string", value: "loud" },
		});
		expect(panel.knobState().rows[0]?.value).toBe("loud");
	});
});
