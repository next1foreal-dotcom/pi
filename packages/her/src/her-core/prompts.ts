export function summaryPrompt(raw: string): string {
	return [
		"Summarize this work session for a personal memory system. Output Markdown bullets with exactly these fields:",
		"- what: what was worked on",
		"- decisions: key decisions made",
		"- signals: facts or patterns revealed about the user",
		"",
		`SESSION:\n${raw}`,
	].join("\n");
}

export function consolidatePrompt(episodes: string, existingKeys: string[]): string {
	const keys = existingKeys.join(", ") || "(none yet)";
	return [
		"Return ONLY JSON (no prose, no code fence). From these session episodes, extract durable knowledge as TYPED units and any 'becoming moments' (turning points in who the person is becoming).",
		"Each unit's `type` is one of: question | concept | opinion | case | solution.",
		"Each relation's `rel` is one of: responds | explains | proves | conflicts | relates (use `conflicts` for a tension/contradiction worth examining - those are valuable).",
		`Existing note keys (reuse a key to update it; relations may point to them): ${keys}`,
		'JSON shape: {"notes":[{"key":"slug","type":"opinion","title":"...","content":"prose","relations":[{"to":"other-key","rel":"proves"}],"sources":["episode-id"]}],"moments":[{"trigger":"what happened","shift":"what changed in the person"}]}',
		"",
		`EPISODES:\n${episodes}`,
	].join("\n");
}

export function synthesizePrompt(current: string, notes: string, moments: string, facts = ""): string {
	const factsBlock = facts.trim()
		? [
				"GROUND-TRUTH FACTS - authoritative, never contradict these (e.g. use the stated name and pronouns exactly; do not infer others):",
				facts,
			].join("\n")
		: "";
	return [
		"You maintain a living narrative (prose, not bullets) of who Fei is becoming, covering knowledge, values, work style, goals, emotions, relationships, aesthetics, intuitions, language, growth, and contradictions.",
		"Produce an UPDATED full narrative in Markdown: keep what still holds, integrate what's new, name the shifts.",
		factsBlock,
		`CURRENT NARRATIVE:\n${current}`,
		`SEMANTIC NOTES:\n${notes}`,
		`BECOMING MOMENTS:\n${moments}`,
	]
		.filter((part) => part.trim())
		.join("\n\n");
}

export function surfacePrompt(recent: string, existing: string): string {
	return [
		"You reflect patterns back to Fei (the Mirror Effect). Surface ONE non-obvious observation about him, grounded in the material, in your own voice, 1-3 sentences.",
		"Do NOT repeat anything already surfaced. If nothing new is worth surfacing, reply with exactly: NONE",
		"",
		`ALREADY SURFACED:\n${existing}`,
		"",
		`RECENT:\n${recent}`,
	].join("\n");
}

export function ingestPrompt(text: string, existingKeys: string[]): string {
	const keys = existingKeys.join(", ") || "(none yet)";
	return [
		"Return ONLY JSON (no prose, no code fence). Read this source and write a wiki page for a personal knowledge base.",
		`Existing note keys you may link to (use the exact key): ${keys}`,
		'JSON shape: {"title":"...","summary":"one paragraph","claims":["..."],"tags":["..."],"links":["existing-key-or-new-slug"]}',
		"",
		`SOURCE:\n${text.slice(0, 8000)}`,
	].join("\n");
}

export function topicMapPrompt(unitLines: string): string {
	return [
		"Return ONLY JSON (no prose, no code fence). Group these knowledge units into coherent themes ('topic maps').",
		"Each theme aggregates related units into a surface that can be expanded into new thinking later. Prefer themes that connect units ACROSS different types, and note tensions/contradictions.",
		'JSON shape: {"maps":[{"theme":"...","summary":"one line","members":["unit-key"]}]}',
		"",
		`UNITS (key (type): title):\n${unitLines}`,
	].join("\n");
}

export function ideaEnginePrompt(units: string, topics: string, existing: string): string {
	return [
		"You are the Idea Engine. Find NON-OBVIOUS, GENERATIVE connections across these knowledge units and topic maps - the kind that spark genuinely new thinking.",
		"RULES:",
		"- Do NOT report mere similarity or 'both are about X'. Surface links that SURPRISE.",
		"- Prefer: the SAME underlying principle appearing in DISTANT domains; a CONTRADICTION/tension worth examining; a pattern no single unit named; a link between HOW the person thinks (self) and WHAT they consumed (world).",
		"- For each idea: name the units it connects, state the non-obvious link in ONE sharp sentence, and pose the new question or idea it opens.",
		"- Quality over quantity. Return ONLY genuinely generative ideas (returning none is fine). Skip the obvious. Do not repeat anything in ALREADY-SURFACED.",
		'Return ONLY JSON: {"ideas":[{"title":"...","connects":["unit-key"],"insight":"the non-obvious link","spark":"the new question/idea it opens","kind":"cross-domain|contradiction|unnamed-pattern|self-x-world"}]}',
		"",
		`UNITS (key (kind/type): title):\n${units}`,
		"",
		`TOPIC MAPS:\n${topics}`,
		"",
		`ALREADY SURFACED:\n${existing}`,
	].join("\n");
}
