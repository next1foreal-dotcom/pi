import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { textResult } from "../tools/shared.ts";
import { recordResolvedDecision } from "./decisions.ts";
import { type CanvasEvent, newId, type Thread } from "./feed.ts";
import { allThreads, appendEvent, readCanvas } from "./store.ts";

export { withCanvasNag } from "./nag.ts";

/** Anything she writes is stamped as hers. She cannot post as Fei. */
const HER = "samantha" as const;

export interface DesignCanvasDeps {
	repoRoot?: string;
	now?: () => string;
	makeId?: (prefix: "n" | "r") => string;
}

function line(t: Thread): string {
	const where = t.screenId ? `on ${t.screenId}` : "on the canvas";
	const head = `${t.id} ${where} — ${t.text.trim() || "(empty note)"}`;
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
