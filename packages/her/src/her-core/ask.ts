export const ASK_QUESTION_MAX = 500;
export const ASK_LABEL_MAX = 60;
export const ASK_DESCRIPTION_MAX = 200;
export const ASK_OPTIONS_MIN = 2;
export const ASK_OPTIONS_MAX = 6;
export const ASK_REPLY_HINT = `(回复"选:<label>";可多选用顿号;其他答案直接打字)`;

export type AskOption = {
	label: string;
	description?: string;
};

export type AskInput = {
	question: string;
	options: readonly AskOption[];
	multi?: boolean;
};

export type AskDetails = {
	kind: "her-ask";
	multi: boolean;
	options: AskOption[];
	question: string;
};

export type AskMessage = {
	content: string;
	details: AskDetails;
};

function requireBound(name: string, value: string | undefined, max: number): string {
	const trimmed = (value ?? "").trim();
	if (!trimmed || trimmed.length > max) {
		throw new Error(`${name} is required and must be at most ${max} characters`);
	}
	return trimmed;
}

export function buildAskMessage(input: AskInput): AskMessage {
	const question = requireBound("question", input.question, ASK_QUESTION_MAX);
	const raw = input.options;
	if (!Array.isArray(raw) || raw.length < ASK_OPTIONS_MIN || raw.length > ASK_OPTIONS_MAX) {
		throw new Error(`options must be ${ASK_OPTIONS_MIN} to ${ASK_OPTIONS_MAX} items`);
	}
	const seen = new Set<string>();
	const options: AskOption[] = [];
	for (const item of raw) {
		const label = requireBound("option label", item?.label, ASK_LABEL_MAX);
		if (seen.has(label)) throw new Error("option labels must be unique");
		seen.add(label);
		const trimmedDescription = item?.description?.trim() ?? "";
		if (trimmedDescription.length > ASK_DESCRIPTION_MAX) {
			throw new Error(`option description must be at most ${ASK_DESCRIPTION_MAX} characters`);
		}
		options.push(trimmedDescription ? { label, description: trimmedDescription } : { label });
	}
	const multi = input.multi === true;
	const lines = [
		question,
		...options.map((option, index) =>
			option.description ? `${index + 1}. ${option.label} — ${option.description}` : `${index + 1}. ${option.label}`,
		),
		ASK_REPLY_HINT,
	];
	return {
		content: lines.join("\n"),
		details: { kind: "her-ask", question, options, multi },
	};
}
