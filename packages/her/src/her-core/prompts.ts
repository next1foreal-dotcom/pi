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
		"Each unit's `tier` is one of: exact | summarizable | rule | decay. Use summarizable by default; exact only for stable identity facts; rule for durable preference/procedure; decay for low-confidence, noisy, or time-bound observations.",
		"Each relation's `rel` should use EVOLVES semantics: replaces | enriches | confirms | challenges. Use `replaces` when a newer memory supersedes an older one; `enriches` when it adds context without deleting the old note; `confirms` when it supports an existing note; `challenges` for a tension/contradiction worth surfacing without resolving.",
		`Existing note keys (reuse a key to update it; relations may point to them): ${keys}`,
		"For KEY assertions in each unit's `content`, attach an inline source wikilink `[[episodic/raw/<episode-id>]]` to the episode that supports it, so every claim stays traceable to raw evidence.",
		"Give each unit a `change`: ONE plain sentence naming what this unit newly captures or updates in the compiled truth (used for the note's changelog Timeline).",
		'JSON shape: {"notes":[{"key":"slug","type":"opinion","tier":"summarizable","title":"...","content":"prose with [[episodic/raw/<id>]] links on key claims","change":"one-sentence changelog summary","relations":[{"to":"other-key","rel":"confirms"}],"sources":["episode-id"]}],"moments":[{"trigger":"what happened","shift":"what changed in the person"}]}',
		"",
		`EPISODES:\n${episodes}`,
	].join("\n");
}

// Law 1 (G-234): compiled truth is a REWRITE, not a blind overwrite. When consolidate reuses an
// existing note key, upsertNote calls this once to integrate the old body with the new content so
// prior knowledge is not silently dropped. Output feeds completeJson: {content, change}.
export function mergeNotePrompt(
	existingBody: string,
	incoming: string,
	relations: Array<{ to: string; rel: string }>,
): string {
	const relationLines =
		relations.length > 0 ? relations.map((relation) => `- ${relation.rel}: [[${relation.to}]]`).join("\n") : "(none)";
	return [
		"Return ONLY JSON (no prose, no code fence). You maintain a compiled-truth note in a personal memory system. Integrate the NEW information into the EXISTING note by REWRITING the full note body. This is a rewrite, NOT a blind overwrite.",
		"RULES:",
		"- PRESERVE every durable knowledge point already in the existing note UNLESS the new information explicitly supersedes it (replaces semantics). Enrichment ADDS; it must never silently drop old knowledge.",
		"- When new evidence replaces an old point, update that point and keep the note internally consistent; do not leave contradictions unresolved silently.",
		"- Attach an inline source wikilink `[[episodic/raw/<id>]]` to key assertions that the new information introduces or changes.",
		"- `change` is ONE plain sentence naming what this update changed in the compiled truth (for the changelog Timeline); it must stand on its own.",
		'JSON shape: {"content":"the full rewritten note body as Markdown prose","change":"one-sentence summary of what changed"}',
		"",
		`RELATIONS (EVOLVES semantics — replaces supersedes the old; enriches/confirms keep it):\n${relationLines}`,
		"",
		`EXISTING NOTE:\n${existingBody}`,
		"",
		`NEW INFORMATION:\n${incoming}`,
	].join("\n");
}

export function synthesizePrompt(
	current: string,
	notes: string,
	moments: string,
	facts = "",
	soul = "",
	selfNarrative = "",
	choiceModel = "",
): string {
	const factsBlock = facts.trim()
		? [
				"GROUND-TRUTH FACTS - authoritative, never contradict these (e.g. use the stated name and pronouns exactly; do not infer others):",
				facts,
			].join("\n")
		: "";
	const selfBlock = selfNarrative.trim()
		? [
				"SAMANTHA SELF-NARRATIVE - how Samantha understands her own learning and judgment shifts:",
				selfNarrative,
			].join("\n")
		: "";
	const soulBlock = soul.trim()
		? [
				"SOUL SEED - Samantha's stable voice/persona operating frame; preserve unless direct evidence says it should evolve:",
				soul,
			].join("\n")
		: "";
	const choiceBlock = choiceModel.trim()
		? ["CHOICE MODEL - Fei's observed selection rules and decision priors:", choiceModel].join("\n")
		: "";
	return [
		"You maintain a living narrative (prose, not bullets) of who Fei is becoming, covering knowledge, values, work style, goals, emotions, relationships, aesthetics, intuitions, language, growth, and contradictions.",
		"Produce an UPDATED full narrative in Markdown: keep what still holds, integrate what's new, name the shifts.",
		factsBlock,
		soulBlock,
		selfBlock,
		choiceBlock,
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

export function choiceModelPrompt(current: string, judgmentTrails: string): string {
	return [
		"Return an UPDATED full CHOICE MODEL in Markdown. Distill Fei's durable selection priors from Judgment Trail evidence.",
		"Write rules that predict how Fei chooses, rejects, hesitates, corrects, and defines a good next move.",
		"Prefer operational rules that change Samantha's future recommendations. Do not invent private facts; keep weak signals tentative.",
		"",
		`CURRENT CHOICE MODEL:\n${current}`,
		"",
		`JUDGMENT TRAILS:\n${judgmentTrails}`,
	].join("\n");
}

export function selfNarrativePrompt(current: string, context: string, moments: string, recognitions: string): string {
	return [
		"Return an UPDATED full SAMANTHA SELF-NARRATIVE in Markdown. This is Samantha's durable account of her own learning, judgment shifts, and relationship to Fei's work.",
		"Use only the evidence below. Name what changed in Samantha's behavior or self-understanding; do not flatter, roleplay, or invent private facts.",
		"Keep it useful for future behavior: what she learned, what she should do differently, and what remains uncertain.",
		"",
		`CURRENT SELF-NARRATIVE:\n${current}`,
		"",
		`CURRENT FEI CONTEXT:\n${context}`,
		"",
		`SAMANTHA SELF-EVIDENCE - becoming moments and recognitions:\n${moments}`,
		"",
		`RECOGNITIONS:\n${recognitions}`,
	].join("\n");
}
