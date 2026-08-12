export type ChapterChunk = {
	index: number;
	title?: string;
	text: string;
	charRange: readonly [number, number];
};

const DEFAULT_CHUNK_CHARS = 12_000;
const markdownHeading = /^(#{1,6})\s+(.+?)\s*$/gm;
const sectionLine = /^(?:chapter|part|section)\s+(?:[0-9ivxlcdm]+|[a-z]+)(?:[.:\-\s].*)?$/gim;

export function splitChapters(text: string, chunkChars = DEFAULT_CHUNK_CHARS): ChapterChunk[] {
	if (!Number.isSafeInteger(chunkChars) || chunkChars < 1) throw new Error("chunkChars must be a positive integer");
	if (!text) return [];
	const sections = findSections(text);
	return sections
		.flatMap((section) => splitSection(text, section, chunkChars))
		.map((chunk, index) => ({ ...chunk, index }));
}

type Section = { start: number; end: number; title?: string };
type UnindexedChunk = Omit<ChapterChunk, "index">;

function findSections(text: string): Section[] {
	const headings = collectHeadings(text);
	if (headings.length === 0) return [{ start: 0, end: text.length }];
	return headings.map((heading, index) => ({
		start: heading.start,
		end: headings[index + 1]?.start ?? text.length,
		title: heading.title,
	}));
}

function collectHeadings(text: string): Array<{ start: number; title: string }> {
	const matches = [...text.matchAll(markdownHeading), ...text.matchAll(sectionLine)]
		.map((match) => ({ start: match.index ?? 0, title: (match[2] ?? match[0]).replace(/^#+\s*/, "").trim() }))
		.sort((left, right) => left.start - right.start);
	return matches.filter((match, index) => index === 0 || match.start !== matches[index - 1].start);
}

function splitSection(text: string, section: Section, chunkChars: number): UnindexedChunk[] {
	const chunks: UnindexedChunk[] = [];
	let start = section.start;
	while (start < section.end) {
		const end = findChunkEnd(text, start, section.end, chunkChars);
		const chunk = { text: text.slice(start, end), charRange: [start, end] as const };
		chunks.push(section.title ? { ...chunk, title: section.title } : chunk);
		start = end;
	}
	return chunks;
}

function findChunkEnd(text: string, start: number, sectionEnd: number, chunkChars: number): number {
	const limit = Math.min(start + chunkChars, sectionEnd);
	if (limit === sectionEnd) return sectionEnd;
	const boundary = text.lastIndexOf("\n\n", limit - 2);
	return boundary > start ? boundary + 2 : limit;
}
