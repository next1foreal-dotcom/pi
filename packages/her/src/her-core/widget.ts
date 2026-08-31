export const WIDGET_TITLE_MAX = 64;
export const WIDGET_CODE_MAX = 200_000;
export const WIDGET_LOADING_MIN = 1;
export const WIDGET_LOADING_MAX = 4;
export const WIDGET_LOADING_ITEM_MAX = 60;
export const WIDGET_TITLE_PATTERN = /^[a-z][a-z0-9_]*$/;
export const WIDGET_SECURITY_HINT = "用 sendPrompt 回话桥,别用内联脚本";

export type WidgetMode = "svg" | "html";

export type WidgetInput = {
	title: string;
	widget_code: string;
	loading_messages?: readonly string[];
};

export type WidgetDetails = {
	kind: "her-widget";
	title: string;
	mode: WidgetMode;
	widget_code: string;
	loading_messages?: string[];
};

export type WidgetMessage = {
	content: string;
	details: WidgetDetails;
};

function requireTitle(value: string | undefined): string {
	const trimmed = (value ?? "").trim();
	if (!trimmed || trimmed.length > WIDGET_TITLE_MAX) {
		throw new Error(
			`title is required and must be at most ${WIDGET_TITLE_MAX} characters, snake_case matching ^[a-z][a-z0-9_]*$`,
		);
	}
	if (!WIDGET_TITLE_PATTERN.test(trimmed)) {
		throw new Error(`title must be snake_case matching ^[a-z][a-z0-9_]*$`);
	}
	return trimmed;
}

function rejectUnsafe(widget_code: string, mode: WidgetMode): void {
	if (/<script/i.test(widget_code) || /on\w+\s*=/i.test(widget_code) || /javascript:/i.test(widget_code)) {
		throw new Error(WIDGET_SECURITY_HINT);
	}
	if (mode === "svg" && /<foreignObject/i.test(widget_code)) {
		throw new Error(WIDGET_SECURITY_HINT);
	}
}

export function buildWidgetMessage(input: WidgetInput): WidgetMessage {
	const title = requireTitle(input.title);
	const widget_code = input.widget_code ?? "";
	if (!widget_code) {
		throw new Error("widget_code is required");
	}
	if (widget_code.length > WIDGET_CODE_MAX) {
		throw new Error(`widget_code must be at most ${WIDGET_CODE_MAX} characters`);
	}
	const mode: WidgetMode = widget_code.trim().startsWith("<svg") ? "svg" : "html";
	rejectUnsafe(widget_code, mode);

	const raw = input.loading_messages;
	let loading_messages: string[] | undefined;
	if (raw !== undefined) {
		if (!Array.isArray(raw) || raw.length < WIDGET_LOADING_MIN || raw.length > WIDGET_LOADING_MAX) {
			throw new Error(`loading_messages must be ${WIDGET_LOADING_MIN} to ${WIDGET_LOADING_MAX} items`);
		}
		loading_messages = [];
		for (const item of raw) {
			if (typeof item !== "string" || item.length > WIDGET_LOADING_ITEM_MAX) {
				throw new Error(`loading_messages item must be at most ${WIDGET_LOADING_ITEM_MAX} characters`);
			}
			loading_messages.push(item);
		}
	}

	const details: WidgetDetails = { kind: "her-widget", title, mode, widget_code };
	if (loading_messages) details.loading_messages = loading_messages;

	return {
		content: `[图:${title}] (${mode}, ${widget_code.length} 字符) — 在 Studio 里查看`,
		details,
	};
}
