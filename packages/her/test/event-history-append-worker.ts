import { appendEvent } from "../src/her-core/event-history.ts";

const count = Number(process.argv[2] ?? "0");
const actor = process.argv[3] ?? "heartbeat";
if (!Number.isInteger(count) || count < 0) {
	throw new Error(`invalid count: ${process.argv[2]}`);
}
for (let i = 0; i < count; i++) {
	await appendEvent("host.run.start", actor, { runId: `${process.pid}-${i}` });
}
