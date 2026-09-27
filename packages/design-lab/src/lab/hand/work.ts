/**
 * The source she just wrote. HMR remounts the whole screen; the smallest
 * mutation box is often an input. The pin is the tag. The chip is the
 * sentence of that write — a component name is a nameplate (sample 9).
 */

export type WorkAt = {
	file: string;
	line: number;
	column: number;
	label: string;
};

let work: WorkAt | null = null;
const listeners = new Set<() => void>();

export function currentWork(): WorkAt | null {
	return work;
}

export function subscribeWork(fn: () => void): () => void {
	listeners.add(fn);
	return () => {
		listeners.delete(fn);
	};
}

export function noteWork(next: WorkAt | null): void {
	work = next;
	for (const fn of listeners) fn();
}

export function workKey(at: WorkAt): string {
	return `${at.file}:${at.line}:${at.column}`;
}

function field(body: Record<string, unknown>, key: string): string | null {
	const raw = body[key];
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function clip(text: string, max = 28): string {
	const one = text.replace(/\s+/g, " ").trim();
	if (one.length <= max) return one;
	return `${one.slice(0, max - 1)}…`;
}

function shownValue(value: unknown): string | null {
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return clip(String(value));
	}
	if (!value || typeof value !== "object") return null;
	const box = value as { as?: unknown; value?: unknown };
	if (box.as === "remove") return "off";
	const inner = box.value;
	if (typeof inner === "string" || typeof inner === "number" || typeof inner === "boolean") {
		return clip(String(inner));
	}
	return null;
}

/**
 * One line he could disagree with. Naming the component is a nameplate.
 * A knob, a class token, or a line of copy is the comment on the node.
 */
export function sayWork(body: Record<string, unknown>): string {
	const prop = field(body, "prop");
	const value = shownValue(body.value);
	if (prop && value !== null) return `${prop} → ${value}`;
	const remove = field(body, "remove");
	if (remove) return `拿掉 ${clip(remove)}`;
	const add = field(body, "add");
	if (add) return `加上 ${clip(add)}`;
	const text = field(body, "text");
	if (text) return `「${clip(text)}」`;
	return field(body, "tag") ?? "writing";
}

/** Pull a work pin out of a source-edit body (`file`/`line`/`column` + payload). */
export function workAtFromBody(body: Record<string, unknown>): WorkAt | null {
	const file = body.file;
	const line = body.line;
	const column = body.column;
	if (typeof file !== "string" || file.length === 0) return null;
	if (typeof line !== "number" || !Number.isFinite(line)) return null;
	if (typeof column !== "number" || !Number.isFinite(column)) return null;
	return { file, line, column, label: sayWork(body) };
}

export function noteWorkFromBody(
	body: Record<string, unknown>,
	label?: string,
): void {
	const at = workAtFromBody(body);
	if (!at) return;
	noteWork(label ? { ...at, label } : at);
}
