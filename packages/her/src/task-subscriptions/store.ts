import { createHash, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { type BgTaskRecord, isTerminal, loadBgTask, taskMdPath } from "../her-core/bg-task-record.ts";
import { frontmatter, parseFrontmatter, readText, writeText } from "../her-core/store.ts";
import { storeLock } from "../her-core/store-lock.ts";

export type SubscriptionState = "active" | "paused" | "cancelled" | "completed" | "expired";
export type SubscriptionEvent = {
	id: string;
	taskId: string;
	status: string;
	occurredAt: string;
	evidence: string;
	objective: string;
	exitCode?: number;
	failureReason?: string;
};
export type TaskSubscription = {
	id: string;
	taskId: string;
	ownerSessionId: string;
	instruction: string;
	createdAt: string;
	state: SubscriptionState;
	expiresAt?: string;
	event?: SubscriptionEvent;
	delivery: {
		state: "pending" | "processing" | "completed" | "blocked";
		attempts: number;
		token?: string;
		leaseUntil?: string;
		reason?: string;
		result?: { summary: string; evidence: string[]; at: string };
		notifiedAt?: string;
		notifyLeaseUntil?: string;
	};
};
export const SUBSCRIPTION_LEASE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;

function safeId(id: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Invalid subscription/task/session id");
	return id;
}
export function subscriptionId(taskId: string): string {
	return `watch-${createHash("sha256").update(safeId(taskId)).digest("hex").slice(0, 24)}`;
}
function subscriptionPath(root: string, id: string): string {
	return join(root, "subscriptions", "tasks", `${safeId(id)}.md`);
}
function checkText(text: string, label: string, max = 8000): void {
	if (typeof text !== "string" || !text.trim() || text.length > max) throw new Error(`Invalid ${label}`);
}
function validate(s: TaskSubscription): TaskSubscription {
	if (!s || typeof s !== "object" || s.id !== subscriptionId(s.taskId))
		throw new Error("Corrupt task subscription identity");
	safeId(s.ownerSessionId);
	checkText(s.instruction, "instruction");
	if (
		!["active", "paused", "cancelled", "completed", "expired"].includes(s.state) ||
		!Number.isFinite(Date.parse(s.createdAt))
	)
		throw new Error("Corrupt subscription state");
	if (s.expiresAt !== undefined && !Number.isFinite(Date.parse(s.expiresAt)))
		throw new Error("Corrupt subscription expiry");
	if (
		!s.delivery ||
		!["pending", "processing", "completed", "blocked"].includes(s.delivery.state) ||
		!Number.isSafeInteger(s.delivery.attempts) ||
		s.delivery.attempts < 0
	)
		throw new Error("Corrupt subscription delivery");
	if (
		s.event &&
		(s.event.taskId !== s.taskId ||
			!["completed", "failed", "cancelled", "blocked-failed"].includes(s.event.status) ||
			!s.event.id ||
			!Number.isFinite(Date.parse(s.event.occurredAt)))
	)
		throw new Error("Corrupt subscription event");
	if (
		s.delivery.state === "processing" &&
		(!s.delivery.token || !Number.isFinite(Date.parse(s.delivery.leaseUntil ?? "")))
	)
		throw new Error("Corrupt subscription lease");
	if (s.delivery.state === "completed" && (!s.delivery.result?.summary || !Array.isArray(s.delivery.result.evidence)))
		throw new Error("Corrupt subscription receipt");
	return s;
}
async function readSubscription(root: string, id: string): Promise<TaskSubscription | null> {
	const text = await readText(subscriptionPath(root, id));
	if (text === undefined) return null;
	return validate(parseFrontmatter(text).data.subscription as TaskSubscription);
}
async function save(root: string, row: TaskSubscription): Promise<void> {
	validate(row);
	await writeText(
		subscriptionPath(root, row.id),
		`${frontmatter({ subscription: row })}# Task subscription\n\n${row.instruction}\n`,
	);
}
async function requireOwned(root: string, id: string, owner: string): Promise<TaskSubscription> {
	const row = await readSubscription(root, id);
	if (!row) throw new Error("Task subscription not found");
	if (row.ownerSessionId !== owner) throw new Error("Task subscription owner mismatch");
	return row;
}
function effectiveState(row: TaskSubscription, now: Date): SubscriptionState {
	if (
		(row.state === "active" || row.state === "paused") &&
		row.expiresAt &&
		Date.parse(row.expiresAt) <= now.getTime()
	)
		return "expired";
	return row.state;
}
export async function listTaskSubscriptions(root: string, owner?: string): Promise<TaskSubscription[]> {
	let files: string[];
	try {
		files = await readdir(join(root, "subscriptions", "tasks"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const rows: TaskSubscription[] = [];
	for (const file of files.sort()) {
		if (!/^watch-[a-f0-9]{24}\.md$/.test(file)) continue;
		const row = await readSubscription(root, file.slice(0, -3));
		if (row && (!owner || row.ownerSessionId === owner)) rows.push(row);
	}
	return rows;
}
export async function createTaskSubscription(
	root: string,
	input: { taskId: string; ownerSessionId: string; instruction: string; expiresAt?: string },
	now = new Date(),
): Promise<TaskSubscription> {
	safeId(input.taskId);
	safeId(input.ownerSessionId);
	checkText(input.instruction, "instruction");
	if (
		input.expiresAt &&
		(!Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= now.getTime())
	)
		throw new Error("Expiry must be in the future");
	return storeLock(root, async () => {
		const id = subscriptionId(input.taskId);
		const existing = await readSubscription(root, id);
		if (existing) {
			if (
				existing.ownerSessionId !== input.ownerSessionId ||
				existing.instruction !== input.instruction ||
				existing.expiresAt !== input.expiresAt
			)
				throw new Error("Subscription already exists with another owner or request");
			return existing;
		}
		const task = await loadBgTask(root, input.taskId);
		if (!task) throw new Error("Task not found");
		if (task.record.ownerSessionId && task.record.ownerSessionId !== input.ownerSessionId)
			throw new Error("Task owner mismatch");
		if (isTerminal(task.record.status)) throw new Error("Task already terminal; read its output directly");
		const row: TaskSubscription = {
			...input,
			id,
			createdAt: now.toISOString(),
			state: "active",
			delivery: { state: "pending", attempts: 0 },
		};
		await save(root, row);
		return row;
	});
}
export async function updateTaskSubscription(
	root: string,
	id: string,
	owner: string,
	action: "pause" | "resume" | "cancel",
	now = new Date(),
): Promise<TaskSubscription> {
	return storeLock(root, async () => {
		const row = await requireOwned(root, id, owner);
		const state = effectiveState(row, now);
		if (["completed", "cancelled", "expired"].includes(state)) throw new Error(`Subscription is ${state}`);
		if (!["pause", "resume", "cancel"].includes(action)) throw new Error("Invalid subscription action");
		row.state = action === "pause" ? "paused" : action === "resume" ? "active" : "cancelled";
		row.delivery = { state: "pending", attempts: action === "resume" ? 0 : row.delivery.attempts, reason: action };
		await save(root, row);
		return row;
	});
}
/** A durable handoff before legacy reconcile stamps notifiedAt; all terminal bookkeeping still runs. */
export async function captureSubscribedTask(root: string, task: BgTaskRecord): Promise<boolean> {
	if (!isTerminal(task.status)) return false;
	return storeLock(root, async () => {
		const row = await readSubscription(root, subscriptionId(task.id));
		if (!row) return false;
		if (!row.event && (row.state === "active" || row.state === "paused")) {
			const identity = `${task.id}\n${task.created}\n${task.status}`;
			row.event = {
				id: createHash("sha256").update(identity).digest("hex"),
				taskId: task.id,
				status: task.status,
				occurredAt: task.endedAt ?? task.updated,
				objective: task.objective,
				evidence: taskMdPath(root, task.id),
				...(task.exitCode !== undefined ? { exitCode: task.exitCode } : {}),
				...(task.failureReason ? { failureReason: task.failureReason } : {}),
			};
			await save(root, row);
		}
		return true;
	});
}
export async function scanTaskSubscriptions(root: string): Promise<void> {
	for (const row of await listTaskSubscriptions(root)) {
		if (row.event || !["active", "paused"].includes(row.state)) continue;
		const task = await loadBgTask(root, row.taskId);
		if (task) await captureSubscribedTask(root, task.record);
	}
}
export async function claimTaskSubscription(
	root: string,
	owner: string,
	now = new Date(),
	leaseMs = SUBSCRIPTION_LEASE_MS,
): Promise<TaskSubscription | null> {
	if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("Invalid lease duration");
	return storeLock(root, async () => {
		for (const row of await listTaskSubscriptions(root, owner)) {
			const state = effectiveState(row, now);
			if (state !== row.state) {
				row.state = state;
				await save(root, row);
			}
			if (state !== "active" || !row.event || ["completed", "blocked"].includes(row.delivery.state)) continue;
			if (row.delivery.state === "processing" && Date.parse(row.delivery.leaseUntil ?? "") > now.getTime()) continue;
			if (row.delivery.attempts >= MAX_ATTEMPTS) {
				row.delivery.state = "blocked";
				row.delivery.reason = "attempt_limit";
				await save(root, row);
				continue;
			}
			row.delivery = {
				state: "processing",
				attempts: row.delivery.attempts + 1,
				token: randomUUID(),
				leaseUntil: new Date(now.getTime() + leaseMs).toISOString(),
			};
			await save(root, row);
			return row;
		}
		return null;
	});
}
async function requireLease(
	root: string,
	id: string,
	owner: string,
	token: string,
	now: Date,
): Promise<TaskSubscription> {
	const row = await requireOwned(root, id, owner);
	if (
		effectiveState(row, now) !== "active" ||
		row.delivery.state !== "processing" ||
		row.delivery.token !== token ||
		Date.parse(row.delivery.leaseUntil ?? "") <= now.getTime()
	)
		throw new Error("Subscription is not active or lease is stale");
	return row;
}
export async function renewTaskSubscription(
	root: string,
	id: string,
	owner: string,
	token: string,
	now = new Date(),
): Promise<void> {
	await storeLock(root, async () => {
		const row = await requireLease(root, id, owner, token, now);
		row.delivery.leaseUntil = new Date(now.getTime() + SUBSCRIPTION_LEASE_MS).toISOString();
		await save(root, row);
	});
}
export async function completeTaskSubscription(
	root: string,
	id: string,
	owner: string,
	token: string,
	summary: string,
	evidence: string[],
	now = new Date(),
): Promise<TaskSubscription> {
	checkText(summary, "summary");
	if (!Array.isArray(evidence) || evidence.length === 0 || evidence.length > 20)
		throw new Error("Result evidence is required");
	for (const item of evidence) checkText(item, "evidence", 2000);
	return storeLock(root, async () => {
		const row = await requireLease(root, id, owner, token, now);
		row.state = "completed";
		row.delivery = {
			state: "completed",
			attempts: row.delivery.attempts,
			result: { summary, evidence, at: now.toISOString() },
		};
		await save(root, row);
		return row;
	});
}
export async function releaseTaskSubscription(
	root: string,
	id: string,
	owner: string,
	token: string,
	reason: string,
	now = new Date(),
): Promise<void> {
	await storeLock(root, async () => {
		const row = await requireOwned(root, id, owner);
		if (row.delivery.state !== "processing" || row.delivery.token !== token) return;
		row.delivery = {
			state: row.delivery.attempts >= MAX_ATTEMPTS ? "blocked" : "pending",
			attempts: row.delivery.attempts,
			reason,
		};
		row.state = effectiveState(row, now);
		await save(root, row);
	});
}
export async function markSubscriptionNotified(
	root: string,
	id: string,
	owner: string,
	now = new Date(),
): Promise<void> {
	await storeLock(root, async () => {
		const row = await requireOwned(root, id, owner);
		if (!row.delivery.result || row.delivery.state !== "completed")
			throw new Error("No subscription result to notify");
		row.delivery.notifiedAt = now.toISOString();
		await save(root, row);
	});
}
/** Reserve notification delivery; receipt observation, not enqueueing, marks it delivered. */
export async function claimSubscriptionNotification(
	root: string,
	id: string,
	owner: string,
	now = new Date(),
): Promise<boolean> {
	return storeLock(root, async () => {
		const row = await requireOwned(root, id, owner);
		if (
			!row.delivery.result ||
			row.delivery.notifiedAt ||
			Date.parse(row.delivery.notifyLeaseUntil ?? "") > now.getTime()
		)
			return false;
		row.delivery.notifyLeaseUntil = new Date(now.getTime() + SUBSCRIPTION_LEASE_MS).toISOString();
		await save(root, row);
		return true;
	});
}
export async function recordSubscriptionGate(root: string, owner: string, reason: string): Promise<void> {
	await storeLock(root, async () => {
		for (const row of await listTaskSubscriptions(root, owner)) {
			if (row.state !== "active" || !row.event || row.delivery.state !== "pending" || row.delivery.reason === reason)
				continue;
			row.delivery.reason = reason;
			await save(root, row);
		}
	});
}
