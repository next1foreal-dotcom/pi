import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * G-467 — her_mark_chapter: Samantha marks where the session's story turns.
 * The mark lives in the tool call's own arguments (title/summary), which the
 * assistant message persists — Studio reads them back for the transcript
 * divider and the left-rail tick. No side effects beyond the returned result.
 */

/** Divider + rail show the title whole; keep it a short noun phrase. */
const MAX_TITLE_CODE_POINTS = 40;

export function registerChapterTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "her_mark_chapter",
		label: "Mark Chapter",
		description:
			"Mark a new chapter in this session's transcript for Fei — a quiet divider he can jump back to. " +
			"Call it when the work moves into a meaningfully different phase (exploring → implementing → verifying), " +
			"or when he pivots the task. Spend them: roughly 3-8 per session is plenty, and never on the first message. " +
			"title is a short noun phrase, 40 characters or fewer; summary is an optional one-liner shown on hover.",
		parameters: Type.Object({
			title: Type.String({
				description: "Short noun phrase naming the new phase; 40 characters or fewer.",
			}),
			summary: Type.Optional(
				Type.String({ description: "Optional one-line summary; shown as the divider's tooltip." }),
			),
		}),
		async execute(
			_toolCallId,
			params,
		): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }> {
			const title = params.title.trim();
			if (!title) {
				return {
					content: [{ type: "text" as const, text: "her_mark_chapter rejected: title is empty." }],
					details: { ok: false, reason: "empty_title" },
				};
			}
			// Count code points, not UTF-16 units — CJK and emoji must not double-pay.
			const length = [...title].length;
			if (length > MAX_TITLE_CODE_POINTS) {
				return {
					content: [
						{
							type: "text" as const,
							text: `her_mark_chapter rejected: title is ${length} characters; shorten it to ${MAX_TITLE_CODE_POINTS} or fewer.`,
						},
					],
					details: { ok: false, reason: "title_too_long", length },
				};
			}
			const summary = typeof params.summary === "string" ? params.summary.trim() : "";
			return {
				content: [{ type: "text" as const, text: `Chapter marked: ${title}` }],
				details: { ok: true, title, ...(summary ? { summary } : {}) },
			};
		},
	});
}
