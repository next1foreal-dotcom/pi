import { Type } from "typebox";

export const HER_STATUS_NAME_MAX = 24;
export const HER_STATUS_HEADLINE_MAX = 60;
export const HER_STATUS_WAITING_QUESTION_MAX = 120;
export const HER_STATUS_WAITING_OPTIONS_MAX = 6;
export const HER_STATUS_WAITING_OPTION_MAX = 40;

export const herStatusParameters = Type.Object({
	name: Type.Optional(
		Type.String({
			description:
				"这条会话的名字，最多 24 字，中文优先，像给一件事起标题。第一轮必须给；之后可省略，省略则沿用之前的名字。",
		}),
	),
	headline: Type.String({
		description: "此刻在干什么，或刚干完什么。一句中文，最多 60 字。不要英文、不要术语堆砌、不要句号结尾的套话。",
	}),
	waiting: Type.Optional(
		Type.Object({
			question: Type.String({
				description: "要问 Fei 的那一句，最多 120 字。只有真的需要他才给 waiting。",
			}),
			options: Type.Optional(
				Type.Array(Type.String({ description: "可选答案，每条最多 40 字" }), {
					description: "最多 6 条",
				}),
			),
		}),
	),
});

export type HerStatusWaiting = {
	question: string;
	options?: string[];
};

export type HerStatusInput = {
	name?: string;
	headline: string;
	waiting?: HerStatusWaiting;
};

export type HerStatusDetails = {
	name?: string;
	headline: string;
	waiting?: HerStatusWaiting;
	truncated: string[];
};

export type HerStatusResult = {
	text: string;
	details: HerStatusDetails;
};

function clip(value: string, max: number): { value: string; clipped: boolean } {
	if (value.length <= max) return { value, clipped: false };
	return { value: value.slice(0, max), clipped: true };
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function applyHerStatus(input: HerStatusInput): HerStatusResult {
	const truncated: string[] = [];
	const details: HerStatusDetails = { headline: "", truncated };

	const rawName = asString(input.name);
	if (rawName !== undefined) {
		const name = clip(rawName, HER_STATUS_NAME_MAX);
		details.name = name.value;
		if (name.clipped) truncated.push("name");
	}

	const headline = clip(asString(input.headline) ?? "", HER_STATUS_HEADLINE_MAX);
	details.headline = headline.value;
	if (headline.clipped) truncated.push("headline");

	const rawWaiting = input.waiting;
	if (rawWaiting && typeof rawWaiting === "object") {
		const question = clip(asString(rawWaiting.question) ?? "", HER_STATUS_WAITING_QUESTION_MAX);
		if (question.clipped) truncated.push("waiting.question");
		const waiting: HerStatusWaiting = { question: question.value };
		if (Array.isArray(rawWaiting.options)) {
			const overflow = rawWaiting.options.length > HER_STATUS_WAITING_OPTIONS_MAX;
			let optionClipped = overflow;
			waiting.options = rawWaiting.options.slice(0, HER_STATUS_WAITING_OPTIONS_MAX).map((item) => {
				const option = clip(typeof item === "string" ? item : String(item), HER_STATUS_WAITING_OPTION_MAX);
				if (option.clipped) optionClipped = true;
				return option.value;
			});
			if (optionClipped) truncated.push("waiting.options");
		}
		details.waiting = waiting;
	}

	const parts = ["已记下"];
	if (details.name) parts.push(`会话名「${details.name}」`);
	if (details.headline) parts.push(details.headline);
	if (details.waiting) parts.push(`在等 Fei：${details.waiting.question}`);
	let text = parts.join("。");
	if (truncated.length > 0) text += `。已截断：${truncated.join("、")}`;
	return { text, details };
}
