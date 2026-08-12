const HTML_ENTITIES: Record<string, string> = {
	amp: "&",
	apos: "'",
	gt: ">",
	lt: "<",
	nbsp: " ",
	quot: '"',
};

function decodeEntity(_match: string, value: string): string {
	const numeric = value.startsWith("#x") || value.startsWith("#X") ? value.slice(2) : value.slice(1);
	if (value.startsWith("#")) {
		const codePoint = Number.parseInt(numeric, value.startsWith("#x") || value.startsWith("#X") ? 16 : 10);
		try {
			return Number.isNaN(codePoint) ? _match : String.fromCodePoint(codePoint);
		} catch {
			return _match;
		}
	}
	return HTML_ENTITIES[value.toLowerCase()] ?? _match;
}

export function decodeHtmlEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, decodeEntity);
}

export function stripHtml(html: string): string {
	const withoutComments = html.replace(/<!--[\s\S]*?-->/g, " ");
	const withoutBlocks = withoutComments.replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
	const withoutTags = withoutBlocks.replace(/<[^>]*>/g, " ");
	return decodeHtmlEntities(withoutTags).replace(/\s+/g, " ").trim();
}

function cleanCueText(lines: string[]): string {
	return decodeHtmlEntities(lines.join(" "))
		.replace(/<[^>]*>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function cleanVtt(vtt: string): string {
	const lines = vtt
		.replace(/^\uFEFF/, "")
		.replace(/\r\n?/g, "\n")
		.split("\n");
	const output: string[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const timestamp = lines[index]?.match(/^\s*((?:(?:\d{2}:)?\d{2}:\d{2}|\d{2}:\d{2})(?:[.,]\d{3})?)\s+-->/);
		if (!timestamp) continue;
		const cueLines: string[] = [];
		for (index += 1; index < lines.length; index += 1) {
			const line = lines[index] ?? "";
			if (!line.trim() || /^\s*(?:(?:\d{2}:)?\d{2}:\d{2}|\d{2}:\d{2})(?:[.,]\d{3})?\s+-->/.test(line)) {
				index -= 1;
				break;
			}
			cueLines.push(line);
		}
		const text = cleanCueText(cueLines);
		if (text) output.push(`[${timestamp[1]}] ${text}`);
	}
	return output.join("\n");
}

export function countWords(text: string): number {
	const trimmed = text.trim();
	return trimmed ? trimmed.split(/\s+/u).length : 0;
}
