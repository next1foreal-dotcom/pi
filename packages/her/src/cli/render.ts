import { formatSessionRead, renderEvalTrendReport } from "../her-core/index.ts";
import type {
	CliApprovePayload,
	CliBackfillPayload,
	CliBootstrapFeedPayload,
	CliCapturePayload,
	CliChoiceModelPayload,
	CliConsolidatePayload,
	CliCostPayload,
	CliDecayPayload,
	CliDispatchPayload,
	CliEvalTrendPayload,
	CliGoalCompletePayload,
	CliGoalListPayload,
	CliGoalNextPayload,
	CliGoalPayload,
	CliGoldenEvalPayload,
	CliIntakePathPayload,
	CliIntakeSourcePayload,
	CliIntakeTastePayload,
	CliIntakeUrlPayload,
	CliJournalPayload,
	CliJudgmentPayload,
	CliLintPayload,
	CliMemoryStatusPayload,
	CliPriorPayload,
	CliPrivacyAuditPayload,
	CliPrivacyCheckPayload,
	CliRecallPayload,
	CliReflectPayload,
	CliReingestPayload,
	CliRestorePayload,
	CliReviewNarrativePayload,
	CliSelfNarrativePayload,
	CliSessionPayload,
	CliStatusPayload,
	CliSurfaceUpdateResult,
	CliSyncPayload,
	CliSynthesizeDuePayload,
	CliSynthesizePayload,
	CliTasteBoardApplyPayload,
	CliTastePayload,
	CliTasteWeeklyPayload,
	CliTelegramBridgePayload,
	CliTelegramConfirmationPayload,
	CliTelegramOutboxPayload,
	CliTelegramPollPayload,
	CliTriggerStatsPayload,
	CliVoiceTaskCompleteNotifyPayload,
	CliVoiceTaskEnqueuePayload,
} from "./types.ts";

export function renderPrior(payload: CliPriorPayload): string {
	return [`prior id: ${payload.result.priorId}`, `memory dir: ${payload.memoryDir}`, "", payload.result.text]
		.filter(Boolean)
		.join("\n");
}
export function renderSession(payload: CliSessionPayload): string {
	return formatSessionRead(payload.result);
}

export function renderStatus(payload: CliStatusPayload): string {
	return [
		`Her memory sync: ${payload.status.status}`,
		`memory dir: ${payload.memoryDir}`,
		`branch: ${payload.status.branch ?? "(unknown)"}`,
		`last successful push: ${payload.lastSyncedAt ?? "(unknown)"}`,
		`pending local memories: ${payload.status.pending}`,
		`dirty files: ${payload.status.dirtyFiles}`,
		`ahead commits: ${payload.status.aheadCommits}`,
		payload.lastSyncedAtError ? `last sync timestamp error: ${payload.lastSyncedAtError}` : undefined,
		payload.status.error ? `error: ${payload.status.error}` : undefined,
	]
		.filter(Boolean)
		.join("\n");
}

export function renderSync(payload: CliSyncPayload): string {
	const result =
		payload.result.status === "clean"
			? "Her memory is already synced."
			: payload.result.status === "fast-forwarded"
				? `Her memory fast-forwarded ${payload.result.behind ?? 0} commit(s) from origin.`
				: `Her memory pushed: ${payload.result.commit}`;
	return `${result}\n\n${renderStatus(payload)}`;
}

export function renderConsolidate(payload: CliConsolidatePayload): string {
	return [
		`Her memory consolidated ${payload.result.episodes} episode(s).`,
		`notes touched: ${payload.result.notesTouched}`,
		`becoming moments: ${payload.result.moments}`,
		"",
		renderStatus(payload),
	].join("\n");
}

export function renderBackfill(payload: CliBackfillPayload): string {
	const mode = payload.result.dryRun ? "planned" : "processed";
	const batches =
		payload.result.batches.length > 0
			? payload.result.batches
					.map(
						(batch) =>
							`batch ${batch.index}: ${batch.status} ${batch.episodes.length} episode(s), cursor ${batch.cursorBefore ?? "(start)"} -> ${batch.cursorAfter}`,
					)
					.join("\n")
			: "(no batches)";
	const budget =
		payload.result.budgetUsd === undefined
			? `spent: $${payload.result.budgetSpentUsd.toFixed(4)}`
			: `spent: $${payload.result.budgetSpentUsd.toFixed(4)} / $${payload.result.budgetUsd.toFixed(4)}`;
	const finalized = payload.result.finalize
		? `finalized: topics ${payload.result.finalize.topicMaps.length}, proposal ${payload.result.finalize.proposalId}`
		: undefined;
	return [
		`Her backfill ${mode}: ${payload.result.dryRun ? payload.result.plannedEpisodes : payload.result.processedEpisodes} episode(s).`,
		`batches: ${payload.result.batches.length}`,
		`cursor: ${payload.result.cursorBefore ?? "(start)"} -> ${payload.result.cursorAfter ?? "(unchanged)"}`,
		budget,
		`stop: ${payload.result.stoppedReason}`,
		finalized,
		batches,
		"",
		renderStatus(payload),
	]
		.filter(Boolean)
		.join("\n");
}

export function renderDecay(payload: CliDecayPayload): string {
	const archived = payload.result.archivedKeys.length > 0 ? payload.result.archivedKeys.join(", ") : "(none archived)";
	return [
		`Her memory decay sweep archived ${payload.result.archived} note(s).`,
		`archived keys: ${archived}`,
		`kept notes: ${payload.result.kept}`,
		"",
		renderStatus(payload),
	].join("\n");
}

export function renderCost(payload: CliCostPayload): string {
	const { result } = payload;
	const byDay = result.byDay.length
		? result.byDay.map((bucket) => `  ${bucket.date}  $${bucket.usd.toFixed(4)}  (${bucket.count})`).join("\n")
		: "  (none)";
	const byProvider = result.byProvider.length
		? result.byProvider
				.map((bucket) => `  ${bucket.provider}  $${bucket.usd.toFixed(4)}  (${bucket.count})`)
				.join("\n")
		: "  (none)";
	return [
		`Her cost ${result.month}: $${result.monthUsd.toFixed(4)} across ${result.entries} entr${result.entries === 1 ? "y" : "ies"}.`,
		`today (${result.today}): $${result.todayUsd.toFixed(4)}`,
		"",
		"By day:",
		byDay,
		"",
		"By provider:",
		byProvider,
		"",
		renderStatus(payload),
	].join("\n");
}

export function renderGoldenEval(payload: CliGoldenEvalPayload): string {
	const categories = payload.result.categories
		.map((category) => `- ${category.category}: ${category.score}/${category.maxScore}`)
		.join("\n");
	const alerts = payload.result.alerts.length
		? payload.result.alerts.map((alert) => `- ${alert.kind}: ${alert.message}`).join("\n")
		: "- none";
	return [
		`Her golden evals ${payload.result.status}: ${payload.result.score}/${payload.result.maxScore}`,
		categories,
		"",
		"Alerts:",
		alerts,
		"",
		renderStatus(payload),
	].join("\n");
}

export function renderEvalTrend(payload: CliEvalTrendPayload): string {
	const latest = payload.report.latest ? `${payload.report.latest.score}/${payload.report.latest.maxScore}` : "(none)";
	return [
		`Her eval trend ${payload.report.status}: ${payload.report.direction}, latest ${latest}.`,
		renderEvalTrendReport(payload.report).trimEnd(),
		"",
		renderStatus(payload),
	].join("\n");
}

export function renderTriggerStats(payload: CliTriggerStatsPayload): string {
	const sessions = Object.keys(payload.result.bySession).length;
	return [
		`Her trigger stats: ${payload.result.total} trigger(s).`,
		`surfaced: ${payload.result.byOutcome.surfaced}`,
		`cooldown: ${payload.result.byOutcome.cooldown}`,
		`empty: ${payload.result.byOutcome.empty}`,
		`engaged rate: ${(payload.result.engagedRate * 100).toFixed(1)}%`,
		`sessions: ${sessions}`,
		"",
		renderStatus(payload),
	].join("\n");
}
export function renderLint(payload: CliLintPayload): string {
	return [
		`Her memory lint ${payload.result.status}: ${payload.result.counts.brokenLinks} broken wikilink(s), ${payload.result.counts.orphans} orphan note(s), ${payload.result.counts.supersessionIssues} supersession issue(s).`,
		`report: ${payload.result.reportPath}`,
		"",
		renderStatus(payload),
	].join("\n");
}

export function renderReingest(payload: CliReingestPayload): string {
	const dryRun = payload.result.entries.some((entry) => entry.outcome === "dry-run");
	const lines = [
		dryRun
			? `Her reingest dry-run: ${payload.result.entries.length} of ${payload.result.scanned} segment(s) would be processed.`
			: `Her reingest: scanned ${payload.result.scanned}, ingested ${payload.result.ingested}, failed ${payload.result.failed}.`,
		`skipped: already-processed ${payload.result.skipped.alreadyProcessed}, duplicate-body ${payload.result.skipped.duplicateBody}`,
	];
	for (const entry of payload.result.entries) {
		lines.push(`${entry.outcome}\t${entry.id}\t${entry.chars}\t${entry.reason}`);
	}
	lines.push("", renderStatus(payload));
	return lines.join("\n");
}
export function renderRestore(payload: CliRestorePayload): string {
	return [`Her memory restored archived semantic note: ${payload.result.key}`, "", renderStatus(payload)].join("\n");
}

export function renderDispatch(payload: CliDispatchPayload): string {
	return [
		`Her dispatch ${payload.result.status}: ${payload.result.dispatchId}`,
		`executor: ${payload.result.executor}`,
		`handoff: ${payload.result.handoffPath}`,
		`commits: ${payload.result.commits}`,
		`files changed: ${payload.result.filesChanged}`,
		`duration_ms: ${payload.result.durationMs}`,
		payload.result.usd !== undefined ? `usd: ${payload.result.usd}` : undefined,
		payload.result.violations.length > 0 ? `violations: ${payload.result.violations.join(", ")}` : undefined,
		"",
		renderStatus(payload),
	]
		.filter((line) => line !== undefined)
		.join("\n");
}

export function renderGoal(payload: CliGoalPayload): string {
	return [
		`Her long task ${payload.result.status}: ${payload.result.id}`,
		`objective: ${payload.result.objective}`,
		`path: ${payload.result.path}`,
		`next: ${payload.result.nextContinuation ?? "(none)"}`,
		"",
		renderStatus(payload),
	].join("\n");
}

export function renderGoalComplete(payload: CliGoalCompletePayload): string {
	return [
		`Her long task completed: ${payload.result.task.id}`,
		`path: ${payload.result.task.path}`,
		`memory note: ${payload.result.memoryNoteId ?? "(not written)"}`,
		"",
		renderStatus(payload),
	].join("\n");
}

export function renderGoalList(payload: CliGoalListPayload): string {
	const lines = payload.result.map((task) => `${task.status}\t${task.id}\t${task.objective}`);
	return [
		`Her long tasks: ${payload.result.length}`,
		...(lines.length ? lines : ["(none)"]),
		"",
		renderStatus(payload),
	].join("\n");
}

export function renderGoalNext(payload: CliGoalNextPayload): string {
	if (!payload.result) return [`Her long task next: (none)`, "", renderStatus(payload)].join("\n");
	return [
		`Her long task claimed: ${payload.result.id}`,
		`objective: ${payload.result.objective}`,
		`next: ${payload.result.nextContinuation ?? "(none)"}`,
		`claimed by: ${payload.result.claimedBy ?? "(unknown)"}`,
		`lease until: ${payload.result.claimExpiresAt ?? "(unknown)"}`,
		`path: ${payload.result.path}`,
		"",
		renderStatus(payload),
	].join("\n");
}

export function renderTelegramPoll(payload: CliTelegramPollPayload): string {
	return [
		`Her Telegram poll received: ${payload.result.received}`,
		`queued: ${payload.result.queued.length}`,
		`ignored: ${payload.result.ignored.length}`,
		`rejected: ${payload.result.rejected.length}`,
		`next offset: ${payload.result.nextOffset ?? "(unchanged)"}`,
		"",
		renderStatus(payload),
	].join("\n");
}

export function renderTelegramOutbox(payload: CliTelegramOutboxPayload): string {
	const sent = payload.result.sent.length > 0 ? payload.result.sent.map((item) => item.path).join(", ") : "(none)";
	const skipped =
		payload.result.skipped.length > 0
			? payload.result.skipped.map((item) => `${item.path} (${item.reason})`).join(", ")
			: "(none)";
	return [
		`Her Telegram outbox sent: ${payload.result.sent.length}`,
		`sent paths: ${sent}`,
		`skipped: ${skipped}`,
		"",
		renderStatus(payload),
	].join("\n");
}

export function renderTelegramConfirmation(payload: CliTelegramConfirmationPayload): string {
	return [
		`Her Telegram confirmation created: ${payload.result.actionId}`,
		`code: ${payload.result.code}`,
		`expires: ${payload.result.expiresAt}`,
		`path: ${payload.result.path}`,
		"outbox queued: yes",
		"execution: not performed by Telegram",
		"",
		renderStatus(payload),
	].join("\n");
}

export function renderTelegramBridge(payload: CliTelegramBridgePayload): string {
	return [
		`Her Telegram bridge poll received: ${payload.result.poll.received}`,
		`queued: ${payload.result.poll.queued.length}`,
		`acknowledged: ${payload.result.acknowledgements.length}`,
		`confirmations: ${payload.result.confirmations.length}`,
		`replied: ${payload.result.replies.length}`,
		`outbox sent: ${payload.result.outbox.sent.length}`,
		`rejected: ${payload.result.poll.rejected.length}`,
		`next offset: ${payload.result.poll.nextOffset ?? "(unchanged)"}`,
		"",
		renderStatus(payload),
	].join("\n");
}

export function renderApprove(payload: CliApprovePayload): string {
	return [`Her proposal approved: ${payload.result.proposalId}`, "", renderStatus(payload)].join("\n");
}

export function renderCapture(payload: CliCapturePayload): string {
	return [`Her memory captured: ${payload.result.id}`, "", renderStatus(payload)].join("\n");
}

export function renderJudgment(payload: CliJudgmentPayload): string {
	return [`Her judgment recorded for world note: ${payload.result.noteId}`, "", renderStatus(payload)].join("\n");
}

export function renderJournal(payload: CliJournalPayload): string {
	return [`Her journal saved: ${payload.result.path}`, `kind: ${payload.result.kind}`, "", renderStatus(payload)].join(
		"\n",
	);
}

export function renderTaste(payload: CliTastePayload): string {
	return [`Her taste judgment saved: ${payload.result.path}`, "", renderStatus(payload)].join("\n");
}

export function renderMemoryStatus(payload: CliMemoryStatusPayload): string {
	return [
		`Her memory status set for world note: ${payload.result.noteId} -> ${payload.result.status}`,
		"",
		renderStatus(payload),
	].join("\n");
}

export function renderPrivacyAudit(payload: CliPrivacyAuditPayload): string {
	return [
		`Her privacy classification updated: ${payload.result.total} file(s).`,
		`frontmatter: ${payload.result.frontmatter}`,
		`sidecar inferred: ${payload.result.inferred}`,
		`ledger: ${payload.result.file}`,
		"",
		renderStatus(payload),
	].join("\n");
}

export function renderPrivacyCheck(payload: CliPrivacyCheckPayload): string {
	const result = payload.result.allowed
		? `Her privacy check passed: ${payload.result.checked.length} ref(s).`
		: `Her privacy check blocked ${payload.result.blocked.length} private/intimate and ${payload.result.unknown.length} unknown ref(s).`;
	return [result, "", renderStatus(payload)].join("\n");
}

export function renderRecall(payload: CliRecallPayload): string {
	const hits =
		payload.result.length > 0
			? payload.result
					.map((note, index) => {
						const excerpt = note.text.trim().replace(/\s+/g, " ").slice(0, 500);
						return `${index + 1}. ${note.id} (${note.kind}, score=${note.score.toFixed(4)})\n${excerpt}`;
					})
					.join("\n\n")
			: "(none)";
	return [`Her recall hits: ${payload.result.length}`, hits, "", renderStatus(payload)].join("\n");
}

export function renderReflect(payload: CliReflectPayload): string {
	const head = !payload.result.ran
		? "Her reflect skipped: not due."
		: payload.result.id
			? `Her reflect wrote recognition: ${payload.result.id}`
			: "Her reflect found nothing new to surface.";
	return [head, "", renderStatus(payload)].join("\n");
}

export function renderReviewNarrative(payload: CliReviewNarrativePayload): string {
	const action =
		payload.result.action === "list"
			? "Narrative updates pending review"
			: `Narrative update ${payload.result.action === "keep" ? "kept" : "reverted"}: ${payload.result.id}`;
	const updates = payload.result.updates;
	const list =
		updates.length === 0
			? "No unreviewed narrative updates."
			: updates
					.map((update, index) =>
						[
							`${index + 1}. ${update.id} · ${update.change} · ${update.timestamp}`,
							`   type: ${update.type}; status: ${update.status}; commit: ${update.commit ?? "(none)"}`,
							update.drivenBy.length > 0 ? `   driven by: ${update.drivenBy.join(", ")}` : undefined,
							update.diff ? `   diff:\n${update.diff}` : undefined,
						]
							.filter(Boolean)
							.join("\n"),
					)
					.join("\n\n");
	return [action, list, "", renderStatus(payload)].join("\n");
}

export function renderSynthesize(payload: CliSynthesizePayload): string {
	const result =
		payload.result.proposalId === null
			? "Her synthesize skipped: not due."
			: `Her narrative synthesized: ${payload.result.proposalId}`;
	return [result, "", renderStatus(payload)].join("\n");
}

export function renderSynthesizeDue(payload: CliSynthesizeDuePayload): string {
	const reason = payload.result.due ? ` (${payload.result.reason})` : "";
	return [`Her synthesize due: ${payload.result.due}${reason}`, "", renderStatus(payload)].join("\n");
}

export function renderSurface(
	payload: { result: { note: { id: string; text: string } | null } } & CliStatusPayload,
): string {
	const note = payload.result.note;
	const head = note ? `Surfaced from memory: ${note.id}` : "Nothing new to surface right now.";
	return [head, "", renderStatus(payload)].join("\n");
}

export function renderTopicMaps(payload: { result: string[] } & CliStatusPayload): string {
	const written = payload.result.length > 0 ? payload.result.join(", ") : "(none)";
	return [`Her topic maps written: ${written}`, "", renderStatus(payload)].join("\n");
}

export function renderIdeas(
	payload: { result: Array<{ id: string; title: string; kind: string }> } & CliStatusPayload,
): string {
	const written = payload.result.length > 0 ? payload.result.map((idea) => idea.title).join(", ") : "(none)";
	return [`Her ideas written: ${written}`, "", renderStatus(payload)].join("\n");
}

export function renderIntakeSource(payload: CliIntakeSourcePayload): string {
	return [
		`Her intake source saved: ${payload.result.noteId}`,
		`content hash: ${payload.result.contentHash}`,
		`recall hits: ${payload.result.recall.map((note) => note.id).join(", ") || "(none)"}`,
		renderSurfaceUpdate(payload.result.surfaces),
		"",
		renderStatus(payload),
	].join("\n");
}

export function renderIntakeUrl(payload: CliIntakeUrlPayload): string {
	return [
		`Her intake URL saved: ${payload.result.noteId}`,
		`title: ${payload.result.title}`,
		`source: ${payload.result.sourceUrl}`,
		`memory status: ${payload.result.memoryStatus}`,
		`bytes read: ${payload.result.bytesRead}${payload.result.truncated ? " (truncated)" : ""}`,
		`content hash: ${payload.result.contentHash}`,
		`recall hits: ${payload.result.recall.map((note) => note.id).join(", ") || "(none)"}`,
		renderSurfaceUpdate(payload.result.surfaces),
		"",
		renderStatus(payload),
	].join("\n");
}

export function renderIntakePath(payload: CliIntakePathPayload): string {
	return [
		`Her intake path saved: ${payload.result.noteId}`,
		`title: ${payload.result.title}`,
		`path: ${payload.result.path}`,
		`memory status: ${payload.result.memoryStatus}`,
		`bytes read: ${payload.result.bytesRead}${payload.result.truncated ? " (truncated)" : ""}`,
		`content hash: ${payload.result.contentHash}`,
		`recall hits: ${payload.result.recall.map((note) => note.id).join(", ") || "(none)"}`,
		renderSurfaceUpdate(payload.result.surfaces),
		"",
		renderStatus(payload),
	].join("\n");
}

export function renderIntakeTaste(payload: CliIntakeTastePayload): string {
	return [
		`Her taste card saved: ${payload.result.noteId}`,
		`boards: ${payload.result.boards.join(", ") || "(none)"}`,
		`fei: ${payload.result.fei || "(none)"}`,
		`snapshot: ${payload.result.snapshotText}`,
		`content hash: ${payload.result.contentHash}`,
		"",
		renderStatus(payload),
	].join("\n");
}

export function renderTasteWeekly(payload: CliTasteWeeklyPayload): string {
	return payload.result.reportMarkdown;
}

export function renderTasteBoardApply(payload: CliTasteBoardApplyPayload): string {
	const { board, items, summary } = payload.result;
	return [
		`Her taste-board-apply "${board}":`,
		...items.map((item) => `${item.cardId}: ${item.outcome}${item.reason ? ` (${item.reason})` : ""}`),
		"",
		`applied: ${summary.applied}, skipped: ${summary.skipped}, rejected: ${summary.rejected}, not-found: ${summary.notFound}`,
	].join("\n");
}

export function renderBootstrapFeed(payload: CliBootstrapFeedPayload): string {
	const files =
		payload.result.files.length > 0
			? payload.result.files
					.map(
						(file, index) =>
							`${index + 1}. ${file.noteId} - ${file.title} (${file.bytesRead} bytes${file.truncated ? ", truncated" : ""})`,
					)
					.join("\n")
			: "(none)";
	return [
		`Her bootstrap feed saved ${payload.result.files.length} file(s):`,
		files,
		renderSurfaceUpdate(payload.result.surfaces),
		"",
		renderStatus(payload),
	].join("\n");
}

function renderSurfaceUpdate(result: CliSurfaceUpdateResult): string {
	const topics = result.topicMaps.length > 0 ? result.topicMaps.join(", ") : "(none)";
	const ideas = result.ideas.length > 0 ? result.ideas.map((idea) => idea.title).join(", ") : "(none)";
	const detail = result.error ? `; error: ${result.error}` : result.reason ? `; ${result.reason}` : "";
	return `surface update: ${result.status}; topics: ${topics}; ideas: ${ideas}${detail}`;
}

export function renderChoiceModel(payload: CliChoiceModelPayload): string {
	return [`Her choice model synthesized: ${payload.result.commit}`, "", renderStatus(payload)].join("\n");
}

export function renderSelfNarrative(payload: CliSelfNarrativePayload): string {
	return [`Her self narrative synthesized: ${payload.result.commit}`, "", renderStatus(payload)].join("\n");
}

export function renderVoiceTaskCompleteNotify(payload: CliVoiceTaskCompleteNotifyPayload): string {
	return [
		`Her voice task completion queued: ${payload.result.path}`,
		`objective: ${payload.result.objective}`,
		`outcome: ${payload.result.outcome}`,
		payload.result.taskPath ? `task: ${payload.result.taskPath}` : undefined,
		"",
		renderStatus(payload),
	]
		.filter((line) => line !== undefined)
		.join("\n");
}
export function renderVoiceTaskEnqueue(payload: CliVoiceTaskEnqueuePayload): string {
	return [
		`Her voice task queued: ${payload.result.path}`,
		`objective: ${payload.result.objective}`,
		"",
		renderStatus(payload),
	].join("\n");
}
export function writePayload<T>(
	stream: NodeJS.WritableStream,
	payload: T,
	json: boolean,
	render: (payload: T) => string,
): void {
	writeLine(stream, json ? JSON.stringify(payload, null, 2) : render(payload));
}

export function writeLine(stream: NodeJS.WritableStream, text: string): void {
	stream.write(`${text}\n`);
}

export function usage(): string {
	return `Usage:
  her approve --proposal <id> [--json]
  her backfill [--batch-size <n>] [--max-batches <n>] [--budget-usd <usd>] [--dry-run] [--finalize] [--json]
  her bootstrap-feed --path <file-or-dir> [--path <file-or-dir>] [--max-bytes <n>] [--update-surfaces] [--json]
  her capture --text <text> [--project <name>] [--session <id>] [--timestamp <ISO>] [--source <tag>] [--type <kind>] [--capture-scope <scope>] [--json]
  her choice-model [--json]
  her consolidate [--limit <n>] [--json]
  her dream-scan [--limit <n>] [--dry-run] [--json]
  her dream-apply --proposal <id> [--dry-run] [--json]
  her dream-reject --proposal <id> [--dry-run] [--json]
  her cost [--now <ISO>] [--json]
  her decay [--older-than-days <days>] [--now <YYYY-MM-DD>] [--json]
  her dispatch <handoff.md> --executor pi:<model>|codex [--budget-usd <usd>] [--cwd <dir>] [--label <text>] [--timeout-min <n>] [--json]
  her drain-start --reason <text> [--ttl-minutes <n>] [--by <name>] [--notify] [--json]
  her drain-stop [--notify] [--json]
  her drain-status [--json]
  her drain-wait [--timeout-seconds <n>] [--json]
  her eval-golden [--write-baseline] [--now <ISO>] [--json]
  her eval-trend [--json]
  her events-verify
  her trigger-stats [--json]
  her goal-start --objective <text> [--source <text>] [--owner <text>] [--next <text>] [--json]
  her goal-checkpoint --id <id> --summary <text> [--status active|blocked] [--next <text>] [--evidence <ref>] [--json]
  her goal-complete --id <id> --outcome <text> [--remember <text>] [--json]
  her goal-list [--status active|blocked|completed|cancelled] [--json]
  her goal-next [--runner <id>] [--lease-minutes <n>] [--now <ISO>] [--json]
  her host-event run-start|run-end|restart-planned --runner <name> --run-id <id> [--ok true|false --exit-code N --detail <text>]
  her ideas [--json]
  her intake-source --title <title> --source-url <url> --source-type <kind> --extracted <text> --coverage <text> --read <text> --take <text> [--memory-status active|archive_only|needs_deep_read] [--memory-status-reason <text>] [--claim-json <json>] [--steal <text>] [--connection <id>] [--possible-move <text>] [--update-surfaces] [--json]
  her intake-path --path <file> [--source-type <kind>] [--max-bytes <n>] [--update-surfaces] [--json]
  her intake-taste <url|path|-> [--fei <text>] [--boards <a,b>] [--json]
  her intake-url --url <url> [--max-bytes <n>] [--update-surfaces] [--json]
  her judgment --note <id> [--choice <text>] [--correction <text>] [--reason <text>] [--attraction <text>] [--inferred-intent <text>] [--rejection <text>] [--hesitation <text>] [--outcome <text>] [--json]
  her journal --kind daily|weekly --text <text> [--title <text>] [--source <text>] [--timestamp <ISO>] [--run <memory-path>] [--json]
  her lint [--json]
  her memory-status --note <id> --status active|archive_only|needs_deep_read --reason <text> [--json]
  her privacy-audit [--json]
  her privacy-check --ref <memory-path> [--ref <memory-path>] [--json]
  her prior [--task <text>] [--off|--her-only] [--budget <tokens>] [--json]
  her recall --query <text> [--k <n>] [--archive] [--json]
  her reingest [--root <store>] [--limit <n>] [--dry-run] [--json]
  her reflect [--if-due] [--json]
  her review-narrative [--keep <id>|--revert <id>] [--json]
  her restore --semantic <key> [--now <YYYY-MM-DD>] [--json]
  her self-narrative [--json]
  her session <id> [--head <n> | --tail <n> | --slice <off,lim> | --grep <pat> [--context <n>]] [--json]
  her snapshot-create [--same-volume-ok]
  her snapshot-restore <snapshot> <target> [--external]
  her snapshot-verify <snapshot>
  her synthesize [--if-due] [--json]
  her synthesize-due [--json]
  her sync --status [--json]
  her sync [--message <message>] [--json]
  her status [--json]
  her taste --title <title> --judgment <text> --reason <text> [--differs-from-fei-rule <text>] [--source <text>] [--timestamp <ISO>] [--json]
  her taste-weekly [--since <ISO>] [--json]
  her taste-board-apply <board> <cardId|slug>... [--json]
  her telegram-bridge [--timeout <seconds>] [--interval <seconds>] [--limit <n>] [--reply|--reply-mode ack|pi] [--ack-text <text>] [--once] [--json]
  her telegram-confirm-request --action-id <id> --summary <text> [--tier <tier>] [--expires-at <ISO>] [--code <code>] [--json]
  her telegram-poll [--timeout <seconds>] [--limit <n>] [--offset <n>] [--json]
  her telegram-push-outbox [--limit <n>] [--dry-run] [--json]
  her topic-maps [--json]
  her voice-task-enqueue --objective <text> [--json]
  her voice-task-notify-complete --objective <text> --outcome <text> [--task-path <path>] [--json]

Memory root:
  HER_MEMORY_DIR, defaulting to ../her-memory from the current working directory.

Telegram:
  HER_TELEGRAM_BOT_TOKEN, HER_TELEGRAM_CHAT_ID, optional HER_TELEGRAM_BASE_URL for local tests.`;
}
