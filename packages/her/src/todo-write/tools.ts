import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TodoStatus = StringEnum(["pending", "in_progress", "completed", "cancelled"] as const);

const TodoItem = Type.Object({
	id: Type.Optional(Type.String()),
	content: Type.String({ description: "The task the agent must do." }),
	status: Type.Optional(TodoStatus),
	activeForm: Type.Optional(Type.String()),
});

function lineFor(item: { content: string; status?: string }, index: number): string {
	const mark =
		item.status === "completed" ? "x" : item.status === "cancelled" ? "-" : item.status === "in_progress" ? "~" : " ";
	return `${index + 1}. [${mark}] ${item.content}`;
}

export function registerTodoWriteTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "todo_write",
		label: "Todo",
		description:
			"Replace the session plan checklist. Pass the full list every call (last write wins). " +
			"Statuses: pending, in_progress, completed, cancelled. Use this to show Fei the live plan in chat — " +
			"not her_task_* (those are verified work tasks / background runs).",
		parameters: Type.Object({
			todos: Type.Array(TodoItem, { minItems: 1 }),
		}),
		async execute(_toolCallId, params) {
			const todos = params.todos.map((item) => ({
				id: item.id,
				content: item.content.trim(),
				status: item.status ?? "pending",
				...(item.activeForm ? { activeForm: item.activeForm } : {}),
			}));
			if (todos.some((item) => !item.content)) {
				return {
					content: [{ type: "text" as const, text: "todo_write rejected: every item needs non-empty content." }],
					details: { ok: false, todos: [] },
				};
			}
			const completed = todos.filter((item) => item.status === "completed").length;
			const text = `To-dos ${completed}/${todos.length}\n${todos.map(lineFor).join("\n")}`;
			return {
				content: [{ type: "text" as const, text }],
				details: { ok: true, todos },
			};
		},
	});
}
