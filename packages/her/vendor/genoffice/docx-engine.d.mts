// Hand-written minimal declarations for docx-engine.mjs (the bundle exports the
// full upstream surface; only what Her's tools consume is typed here).
// Upstream: https://github.com/genspark-ai/genoffice @ dc4d7e5, Apache-2.0.

export interface DocxRun {
	text: string;
	bold?: boolean;
	italic?: boolean;
	[key: string]: unknown;
}

export interface DocxTableCell {
	paras: string[];
	[key: string]: unknown;
}

export interface DocxBlock {
	type: string;
	docxIndex?: number;
	hidden?: boolean;
	level?: number;
	runs?: DocxRun[];
	originalXml?: string;
	table?: { rows: DocxTableCell[][]; [key: string]: unknown };
	previewText?: string;
	[key: string]: unknown;
}

/** Opaque parse product; pass the same object back into saveDocx. */
export interface ParsedDocx {
	blocks: DocxBlock[];
	[key: string]: unknown;
}

export type SaveBlock =
	| { kind: "original"; docxIndex: number }
	| { kind: "generated"; block: { type: "paragraph"; runs: DocxRun[] } }
	| { kind: "xml"; xml: string; docxIndex?: number };

export function parseDocx(bytes: Uint8Array): Promise<ParsedDocx>;

/**
 * Byte-preserving save: blocks passed as kind "original" keep their exact
 * original XML slice; every zip entry other than word/document.xml is copied
 * byte-for-byte; zero edits return the original file object unchanged.
 */
export function saveDocx(
	parsed: ParsedDocx,
	finalBlocks: SaveBlock[],
	options?: Record<string, unknown>,
): Promise<Uint8Array>;

/**
 * Surgical text patch on an XML slice containing w:p paragraphs: unchanged
 * paragraphs keep their bytes, changed ones get minimal w:t rewrites so inline
 * formatting/hyperlinks/fields survive. Returns null when it cannot patch
 * safely (caller must fall back or refuse); self-checks its own output.
 */
export function patchParagraphTexts(
	entryXml: string,
	newText: string,
	opts?: { stripFirstParaLeadingSpace?: boolean },
): string | null;

/** Minimal valid .docx: one empty paragraph, A4 portrait, standard styles. */
export function buildBlankDocx(options?: { eastAsiaFont?: string }): Promise<Uint8Array>;
