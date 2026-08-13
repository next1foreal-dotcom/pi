// Hand-written declarations for extract.mjs (text extraction without the pdf
// path; PDFs stay with her_pdf / her_ocr).
// Upstream: https://github.com/genspark-ai/genoffice @ dc4d7e5, Apache-2.0.

/** Flatten a .docx into readable text (# headings, - list items, "a | b" table rows). */
export function docxToText(bytes: Uint8Array): Promise<string>;

/** One "## Slide N" section per slide, numerically ordered. */
export function pptxToText(bytes: Uint8Array): Promise<string>;

/** Sheet-by-sheet cell text. */
export function xlsxToText(bytes: Uint8Array): Promise<string>;
