import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { textResult } from "../tools/shared.ts";
import { recordResolvedDecision } from "./decisions.ts";
import { chooseDirection, currentDirection, proposeDirections } from "./direction.ts";
import { type CanvasEvent, formatRegion, formatSource, newId, type Thread } from "./feed.ts";
import { designMode, interceptDesignToolCall, interceptFirstFrameToolCall, setDesignMode } from "./mode.ts";
import { installCanvasNagHook } from "./nag.ts";
import { allThreads, appendEvent, readCanvas } from "./store.ts";

export { withCanvasNag } from "./nag.ts";

/** Anything she writes is stamped as hers. She cannot post as Fei. */
const HER = "samantha" as const;

export interface DesignCanvasDeps {
	repoRoot?: string;
	now?: () => string;
	makeId?: (prefix: "n" | "r") => string;
}

/**
 * One thread as she reads it.
 *
 * The head carries the location when the canvas resolved one, so "this gap is
 * too tight" arrives already naming the file and line that made the gap. Before
 * this she got a screen name and a pair of page coordinates and had to guess
 * which of the screen's elements he meant.
 */
function line(t: Thread): string {
	const screen = t.screenId ? `on ${t.screenId}` : "on the canvas";
	const at = formatSource(t.source);
	// No location: byte-for-byte what it read before, not an empty placeholder.
	const where = at ? `${screen} at ${at}` : screen;
	// He drew a box: say how big and where, in the units she aims with.
	const box = formatRegion(t.region);
	const framed = box ? `${where}, framing ${box}` : where;
	const head = `${t.id} ${framed} — ${t.text.trim() || "(empty note)"}`;
	const replies = t.replies.map((r) => `    ${r.author}: ${r.text}`);
	const state = t.resolved ? `    [resolved by ${t.resolvedBy}]` : "";
	return [head, ...replies, state].filter(Boolean).join("\n");
}

function render(fresh: Thread[], open: Thread[], cursor: string): string {
	const parts: string[] = [];
	if (fresh.length === 0 && open.length === 0) {
		parts.push("Nothing on the canvas. He has not written anything yet.");
	}
	if (fresh.length > 0) {
		parts.push(`New since you last looked (${fresh.length}):`);
		parts.push(fresh.map(line).join("\n"));
	}
	const stillOpen = open.filter((t) => !fresh.some((f) => f.id === t.id));
	if (stillOpen.length > 0) {
		parts.push(`Still open from before (${stillOpen.length}):`);
		parts.push(stillOpen.map(line).join("\n"));
	}
	if (fresh.length > 0 || open.length > 0) {
		parts.push(
			"Answer with design_lab_reply, and design_lab_resolve once it is actually done — " +
				"resolved is a claim that the design changed, not that you read the note.",
		);
	}
	parts.push(`cursor: ${cursor}`);
	return parts.join("\n\n");
}

export function registerDesignCanvasTools(pi: ExtensionAPI, deps: DesignCanvasDeps = {}): void {
	const repoRoot = deps.repoRoot;
	const now = deps.now ?? (() => new Date().toISOString());
	const makeId = deps.makeId ?? ((p: "n" | "r") => newId(p));

	const emit = (event: CanvasEvent) => appendEvent(event, repoRoot);

	// Without this the hitchhikes only ride on tools registered through
	// `withCanvasNag`, which in production is a single one. See the note on
	// installCanvasNagHook.
	installCanvasNagHook(pi, repoRoot);

	// Existing tests fake `pi` without `on`. Skip rather than throw — the real
	// extension always has it. Returning `{ block: false }` would short-circuit
	// other handlers; build mode must yield `undefined`.
	if (typeof pi.on === "function") {
		pi.on(
			"tool_call",
			(event) => interceptDesignToolCall(event.toolName) ?? interceptFirstFrameToolCall(event.toolName, repoRoot),
		);
	}

	pi.registerTool({
		name: "design_mode",
		label: "Design Mode",
		description:
			"Report or switch whether you have hands that change the product. " +
			"build (the default) is today's behaviour: edit, write, bash, and the product-writing design tools run. " +
			"discuss is not a reminder — it is a fact: those tools are blocked. You can still read, grep, look at the canvas, and call this. " +
			'Pass mode "discuss" or "build" to switch; omit mode to read the current value.',
		parameters: Type.Object({
			mode: Type.Optional(
				Type.Union([Type.Literal("discuss"), Type.Literal("build")], {
					description: "Switch to this mode. Omit to read the current mode.",
				}),
			),
		}),
		async execute(_toolCallId, params: { mode?: string }) {
			const requested = params.mode;
			if (requested === undefined) {
				const current = designMode();
				return textResult(`Design mode is ${current}.`, { mode: current });
			}
			if (requested !== "discuss" && requested !== "build") {
				return textResult(`Unknown mode "${requested}". Use "discuss" or "build".`, { ok: false });
			}
			setDesignMode(requested);
			if (requested === "discuss") {
				return textResult(
					'Design mode is now discuss. You do not have the hands that change the product. Call design_mode with mode "build" to get them back.',
					{ mode: requested },
				);
			}
			return textResult("Design mode is now build. You have the hands that change the product.", {
				mode: requested,
			});
		},
	});

	pi.registerTool({
		name: "design_direction",
		label: "Design Direction",
		description:
			"The first frame commits the aesthetic for every later frame in this project; you don't get to pick it silently. " +
			"Call with no arguments to report the current direction (or that there isn't one). " +
			'Pass propose with named directions — short memorable names like "brutalist concrete", each with type, colour attitude, and motion character — to put them in front of him. Propose does not commit. ' +
			"Pass choose with the name he picked to freeze it. " +
			"Even if he says to pick for him, summarise the direction you would take as a propose and wait for choose.",
		parameters: Type.Object({
			propose: Type.Optional(
				Type.Array(
					Type.Object({
						name: Type.String({
							description: 'Short memorable name, e.g. "brutalist concrete". Not "option A".',
						}),
						character: Type.String({
							description: "A sentence or two: type, colour attitude, and motion character.",
						}),
					}),
				),
			),
			choose: Type.Optional(
				Type.String({
					description: "The name of a proposed direction he picked. This is what commits it.",
				}),
			),
		}),
		async execute(_toolCallId, params: { propose?: Array<{ name: string; character: string }>; choose?: string }) {
			const choose = typeof params.choose === "string" ? params.choose.trim() : "";
			if (choose) {
				const chosen = chooseDirection(choose, repoRoot);
				if (!chosen) {
					return textResult(
						`No proposed direction named "${choose}". Call design_direction with propose first, then choose one of those names.`,
						{ ok: false },
					);
				}
				return textResult(`Design direction is ${chosen.name}. Frozen. The first-frame gate is lifted.`, {
					ok: true,
					direction: chosen,
				});
			}
			if (params.propose !== undefined) {
				const items = Array.isArray(params.propose)
					? params.propose
							.map((item) => ({
								name: typeof item?.name === "string" ? item.name.trim() : "",
								character: typeof item?.character === "string" ? item.character.trim() : "",
							}))
							.filter((item) => item.name && item.character)
					: [];
				if (items.length === 0) {
					return textResult(
						"propose needs at least one direction with a name and a character. No direction was stored, and none is chosen.",
						{ ok: false },
					);
				}
				proposeDirections(items, repoRoot);
				const lines = items.map((item) => `- ${item.name}: ${item.character}`);
				return textResult(
					`These directions are in front of him. They are not chosen. Wait for choose.\n${lines.join("\n")}`,
					{ ok: true, committed: false, pending: items },
				);
			}
			const current = currentDirection(repoRoot);
			if (!current) {
				return textResult("No design direction has been chosen yet.", { chosen: false });
			}
			return textResult(`Design direction is ${current.name}. ${current.character}`, {
				chosen: true,
				direction: current,
			});
		},
	});

	pi.registerTool({
		name: "design_lab_notes",
		label: "Design Lab Notes",
		description:
			"Read what Fei wrote on the design canvas — his sticky notes on your screens, and the threads " +
			"under them. This is him pointing at your work; a photograph (design_lab_still) shows you a " +
			"coloured rectangle, this tells you what it says and which screen it is on. Read it before you " +
			"call a design done, and read it again after you change something he objected to. " +
			"It returns what is new since you last looked AND every thread still open, so nothing he wrote " +
			"can go unanswered just because you missed a page.",
		parameters: Type.Object({
			screenId: Type.Optional(
				Type.String({ description: "Only threads on this screen. Omit for the whole canvas." }),
			),
			since: Type.Optional(
				Type.String({
					description:
						"A cursor from an earlier call. Omit to continue from where you left off, which is what you normally want.",
				}),
			),
		}),
		async execute(_toolCallId, params: { screenId?: string; since?: string }) {
			const reading = readCanvas({
				since: params.since,
				screenId: params.screenId,
				repoRoot,
			});
			return textResult(render(reading.fresh, reading.open, reading.cursor), {
				cursor: reading.cursor,
				fresh: reading.fresh.length,
				open: reading.open.length,
			});
		},
	});

	pi.registerTool({
		name: "design_lab_reply",
		label: "Design Lab Reply",
		description:
			"Answer one of Fei's canvas notes in its own thread, where he left it. Use it to say what you " +
			"changed, or to ask what he meant when the note is ambiguous — guessing at an ambiguous note " +
			"and shipping the guess is how a design goes two rounds instead of one.",
		parameters: Type.Object({
			noteId: Type.String({ description: "The thread id, e.g. n_3f2a91cc04de." }),
			text: Type.String({ description: "What you want to say to him." }),
		}),
		async execute(_toolCallId, params: { noteId: string; text: string }) {
			const thread = allThreads(repoRoot).find((t) => t.id === params.noteId);
			if (!thread) {
				return textResult(
					`No thread ${params.noteId} on the canvas. ` +
						"Call design_lab_notes to see the ids that exist — the note may have been deleted.",
					{ noteId: params.noteId, found: false },
				);
			}
			emit({
				t: "reply",
				id: makeId("r"),
				noteId: params.noteId,
				at: now(),
				author: HER,
				text: params.text,
			});
			return textResult(`Replied on ${params.noteId}. He sees it on the canvas.`, {
				noteId: params.noteId,
			});
		},
	});

	pi.registerTool({
		name: "design_lab_resolve",
		label: "Design Lab Resolve",
		description:
			"Mark one of his notes done, once the design actually changed. Resolving is a claim about the " +
			"work, not about your attention: if you have only read the note, reply instead. The note carries " +
			"what you did, and he can reopen it if he disagrees.",
		parameters: Type.Object({
			noteId: Type.String(),
			note: Type.Optional(Type.String({ description: "What you changed. He reads this instead of guessing." })),
		}),
		async execute(_toolCallId, params: { noteId: string; note?: string }) {
			const thread = allThreads(repoRoot).find((t) => t.id === params.noteId);
			if (!thread) {
				return textResult(`No thread ${params.noteId} on the canvas.`, {
					noteId: params.noteId,
					found: false,
				});
			}
			if (params.note) {
				emit({
					t: "reply",
					id: makeId("r"),
					noteId: params.noteId,
					at: now(),
					author: HER,
					text: params.note,
				});
			}
			emit({
				t: "resolve",
				noteId: params.noteId,
				at: now(),
				author: HER,
				...(params.note ? { note: params.note } : {}),
			});
			try {
				recordResolvedDecision(thread, params.note, { repoRoot, now });
			} catch {
				// a memory miss must not fail the resolve the canvas already recorded
			}
			return textResult(`Resolved ${params.noteId}.`, { noteId: params.noteId });
		},
	});
}
