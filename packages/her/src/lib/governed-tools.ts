export type GovernedToolResolution = { destructive: boolean; registered: boolean };

export const governedTools: Record<string, { destructive: boolean }> = {
	bash: { destructive: true },
	edit: { destructive: true },
	write: { destructive: true },
	read: { destructive: false },
	grep: { destructive: false },
	find: { destructive: false },
	ls: { destructive: false },
	her_status: { destructive: false },
	list_her_events: { destructive: false },
	her_recall: { destructive: false },
	todo_write: { destructive: false },
	her_session_list: { destructive: false },
	her_session_read: { destructive: false },
	her_session_search: { destructive: false },
	// Writes into the memory store, can trigger a paid wake, and puts text into
	// another agent's system prompt — the same side-effect family as
	// her_task_continue, not the read-only family. Cedar is deny-by-default for
	// destructive tools, so this ships denied until Fei grants a named permit
	// (the her_task_spawn / _stop / _continue precedent in her-trust.cedar).
	her_session_send: { destructive: true },
	// G-375 option card. Custom transcript message only; Cedar :6 total permit covers
	// non-destructive tools, so this stays off named Cedar permits.
	her_ask: { destructive: false },
	// G-378 inline visualization. Custom transcript message only; Cedar :6 total
	// permit covers non-destructive tools, so this stays off named Cedar permits.
	her_widget: { destructive: false },
	// G-368 self-alarm. Writes wakeup rows and, when due, an urgent inbox
	// message — same side-effect family as her_session_send. Heartbeat forbids
	// destructive tools, so this stays out of unattended rounds.
	her_schedule_wakeup: { destructive: true },
	// G-403 shadow-git checkpoints. Listing is read-only (Cedar :6 covers it).
	// Rewind writes files, so it stays destructive until the named permit.
	her_checkpoints: { destructive: false },
	her_rewind: { destructive: true },
	her_feedback: { destructive: false },
	her_sync: { destructive: false },
	her_task_create: { destructive: false },
	her_task_update: { destructive: false },
	her_task_list: { destructive: false },
	her_task_spawn: { destructive: true },
	her_task_continue: { destructive: true },
	her_task_stop: { destructive: true },
	her_task_output: { destructive: false },
	her_task_ps: { destructive: false },
	her_bg_task_list: { destructive: false },
	her_publish: { destructive: true },
	her_privacy_audit: { destructive: false },
	her_privacy_check: { destructive: false },
	her_memory_retract: { destructive: false },
	her_cost_report: { destructive: false },
	her_telegram_queue: { destructive: false },
	her_proposal_record: { destructive: false },
	her_proposal_feedback: { destructive: false },
	her_proposal_stats: { destructive: false },
	her_proposal_list: { destructive: false },
	her_goal_start: { destructive: false },
	her_goal_next: { destructive: false },
	her_goal_checkpoint: { destructive: false },
	her_goal_complete: { destructive: false },
	her_goal_list: { destructive: false },
	her_synthesize_choice_model: { destructive: false },
	her_synthesize_self_narrative: { destructive: false },
	her_review_context: { destructive: false },
	her_review_verify: { destructive: false },
	her_keep: { destructive: false },
	her_revert: { destructive: false },
	her_remember: { destructive: false },
	her_world_note: { destructive: false },
	her_intake_source: { destructive: false },
	her_intake_path: { destructive: false },
	her_bootstrap_feed: { destructive: false },
	her_zone_note: { destructive: false },
	her_taste_judgment: { destructive: false },
	her_idea: { destructive: false },
	her_judgment: { destructive: false },
	her_memory_status: { destructive: false },
	her_hands_snapshot: { destructive: false },
	her_hands_act: { destructive: false },
	preview_open_review: { destructive: false },
	her_preview_still: { destructive: false },
	extract_design_md: { destructive: false },
	browser_navigate: { destructive: false },
	design_lab_open: { destructive: false },
	design_project_create: { destructive: false },
	design_project_get: { destructive: false },
	design_project_list: { destructive: false },
	design_project_set_stage: { destructive: false },
	design_project_gate: { destructive: false },
	design_project_audit: { destructive: false },
	browser_read_page: { destructive: false },
	browser_act: { destructive: false },
	artifact_publish: { destructive: true },
	her_show_widget: { destructive: false },
	her_ui_act: { destructive: false },
	her_act: { destructive: false },
	her_upsert_relay_provider: { destructive: false },
	her_convert: { destructive: false },
	her_ocr: { destructive: false },
	her_archive: { destructive: false },
	her_imgmin: { destructive: false },
	her_pdf: { destructive: false },
	her_doc_read: { destructive: false },
	// writes a fresh file next to the source and never overwrites anything,
	// same class as her_convert (registered non-destructive by that precedent)
	her_doc_edit: { destructive: false },
	her_mcp_list: { destructive: false },
	// MCP call is an unconstrained side-effect (arbitrary connector/tool).
	// Deny-by-default until Fei grants a named Cedar permit (her_session_send
	// precedent). her_mcp_list stays read-only.
	her_mcp_call: { destructive: true },
	// G-284 agent-made tool ladder. Both destructive on purpose, and it is not the
	// fail-safe default doing the work - it is a choice. Declaring alone has no side
	// effect (the registry is in-memory and dies with the process), so the read-only
	// family would have accepted her_tool_declare. Registering it destructive keeps
	// BOTH halves out of the unattended heartbeat profile, which permits only
	// destructive == false. A heartbeat round that can declare a wrapper it can never
	// call would be pure noise in the ledger.
	// Named Cedar permits exist as of 2026-08-19 (permit_her_tool_declare /
	// permit_her_tool_call). They grant zero new capability: she already holds bash on
	// every non-anchor path, and a wrapper can only narrow. See ADR-0005.
	her_tool_declare: { destructive: true },
	her_tool_call: { destructive: true },
};

export function resolveGovernedTool(name: string): GovernedToolResolution {
	const tool = governedTools[name];
	if (!tool) return { destructive: true, registered: false };
	return { destructive: tool.destructive, registered: true };
}
