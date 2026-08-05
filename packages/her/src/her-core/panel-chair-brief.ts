export type PanelChairBriefParams = {
	objective?: string;
	task?: string;
	brief?: string;
	memberBrief?: string;
	members?: readonly string[];
};

const EXECUTOR_RULE = "ROLE: EXECUTOR \u2014 do the work yourself; do not spawn subagents.";
const EXECUTOR_RULE_PATTERN = /ROLE: EXECUTOR \u2014 do the work yourself; do not spawn subagents\./g;

/** Build the read-only panel brief with exactly one nested executor handoff. */
export function buildPanelChairBrief(params: PanelChairBriefParams = {}): string {
	const objective = params.objective?.trim() || params.task?.trim() || "Review the dispatched task.";
	const memberBrief = (params.memberBrief?.trim() || params.brief?.trim() || objective)
		.replace(EXECUTOR_RULE_PATTERN, "")
		.trim();
	const members = params.members?.map((member) => member.trim()).filter(Boolean) ?? [];
	const memberLine = members.length > 0 ? `Members: ${members.join(", ")}` : "Members: delegate one review member.";

	return [
		"ROLE: PANEL CHAIR",
		"Open a read-only review panel. Do not write code, modify files, or spawn another panel.",
		`OBJECTIVE: ${objective}`,
		memberLine,
		"Member handoff (nested depth 1; pass this brief once):",
		EXECUTOR_RULE,
		memberBrief,
		"Use builtin delegate (which inherits the main brain) or an explicitly reachable provider for the member.",
		"If a member cannot complete the review, report PANEL_FAIL: <the exact reason>. Never answer for a member and never read files to fill in a missing member result.",
		"Every conclusion must include evidence(file+lines) and a member session citation (session id or event-stream location).",
		"The chair must call her_review_verify itself for every conclusion before reporting it.",
		"VERIFICATION: evidence verified=<n> failed=<n>",
		"Machine evidence contract: stdout (or the designated report file) must contain one fenced JSON evidence block:",
		"```json evidence",
		'[{"file":"relative/path","lines":"12-14","claim":"what the cited lines prove"}]',
		"```",
		"Evidence must be machine-checkable item by item; if there is no evidence, say so truthfully.",
	].join("\n");
}
