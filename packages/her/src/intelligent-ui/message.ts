export const INTELLIGENT_UI_CODE_MAX_BYTES = 200_000;
export const INTELLIGENT_UI_TITLE_MAX = 160;
export const INTELLIGENT_UI_ID_MAX = 256;

export interface IntelligentUiInput {
	title?: unknown;
	code?: unknown;
}

export interface IntelligentUiDetails {
	kind: "her-intelligent-ui";
	version: 1;
	uiId: string;
	title: string;
	code: string;
}

/** Build the final transcript payload; Studio handles the earlier tool-argument deltas. */
export function buildIntelligentUiMessage(
	uiId: string,
	input: IntelligentUiInput,
): { content: string; details: IntelligentUiDetails } {
	if (
		typeof uiId !== "string" ||
		!uiId.trim() ||
		uiId.length > INTELLIGENT_UI_ID_MAX ||
		/[\u0000-\u001f\u007f]/.test(uiId)
	) {
		throw new Error(
			`uiId must be a non-empty tool call id of at most ${INTELLIGENT_UI_ID_MAX} characters without controls`,
		);
	}
	const title = input.title === undefined ? "交互界面" : input.title;
	if (typeof title !== "string" || !title.trim() || title.trim().length > INTELLIGENT_UI_TITLE_MAX) {
		throw new Error(`title must be a non-empty string of at most ${INTELLIGENT_UI_TITLE_MAX} characters`);
	}
	const code = input.code;
	if (typeof code !== "string" || !code.trim()) throw new Error("render requires non-empty OpenUI code");
	if (Buffer.byteLength(code, "utf8") > INTELLIGENT_UI_CODE_MAX_BYTES) {
		throw new Error(`code must be at most ${INTELLIGENT_UI_CODE_MAX_BYTES} UTF-8 bytes`);
	}
	if (!/^root\s*=/.test(code.trimStart())) throw new Error("code must begin with the root assignment");
	return {
		content: `[交互界面：${title.trim()}] — 在 Studio 中查看和操作`,
		details: { kind: "her-intelligent-ui", version: 1, uiId, title: title.trim(), code },
	};
}
