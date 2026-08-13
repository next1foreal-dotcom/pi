// Hand-written declarations for fixtures.mjs (upstream test fixture builders;
// used only by Her's own tests, never by production code).
// Upstream: https://github.com/genspark-ai/genoffice @ dc4d7e5, Apache-2.0.

/** Minimal valid docx: "Annual Report" heading + paragraph + list item + 2x2 table. */
export function buildDocxFixture(): Promise<Uint8Array>;

/** Minimal valid pptx with several slides of known text. */
export function buildPptxFixture(): Promise<Uint8Array>;

/** Minimal valid xlsx with known cell values. */
export function buildXlsxFixture(): Promise<Uint8Array>;
