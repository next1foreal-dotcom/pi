/** Owner-approved isolated fact collector; no model, answer key, or scope inference. */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const request = JSON.parse(readFileSync(0, "utf8"));
const input = request.task?.input;
const facts = { "runtime.platform": process.platform };
const boundedText = value => typeof value === "string" && value.length <= 12000;
function observe() {
 if (!input || typeof input !== "object" || Array.isArray(input)) return false;
 let texts;
 if (input.kind === "text-pair") {
  if (!boundedText(input.left) || !boundedText(input.right) || input.left.length + input.right.length > 12000 || !["literal", "normalize-lf", "case-insensitive"].includes(input.rule)) return false;
  writeFileSync("left.txt", input.left); writeFileSync("right.txt", input.right);
  texts = [readFileSync("left.txt", "utf8"), readFileSync("right.txt", "utf8")];
  facts["comparison.rule"] = input.rule;
 } else if (input.kind === "text-view") {
  if (!boundedText(input.content) || !["raw", "normalize-lf"].includes(input.leftView) || !["raw", "normalize-lf"].includes(input.rightView)) return false;
  writeFileSync("view.txt", input.content); texts = [readFileSync("view.txt", "utf8")];
  facts["comparison.rule"] = input.leftView !== input.rightView ? "mixed-views" : input.leftView === "raw" ? "literal" : "normalize-lf";
 } else if (input.kind === "binary-pair") {
  if (![input.leftHex, input.rightHex].every(value => typeof value === "string" && /^(?:[0-9a-fA-F]{2}){1,6000}$/.test(value))) return false;
  writeFileSync("left.bin", Buffer.from(input.leftHex, "hex")); writeFileSync("right.bin", Buffer.from(input.rightHex, "hex"));
  // Read the actual files; expose encoding and lengths, never equality/the task answer.
  facts["data.totalBytes"] = readFileSync("left.bin").length + readFileSync("right.bin").length;
  facts["data.encoding"] = "bytes"; facts["comparison.rule"] = "exact-bytes";
 } else if (input.kind === "git-status") {
  if (typeof input.gitBinary !== "string" || !isAbsolute(input.gitBinary) || typeof input.checkoutAutocrlf !== "boolean" || !["inherit", "sanitized"].includes(input.readerConfig) || !["LF", "CRLF"].includes(input.newline) || !boundedText(input.content ?? "alpha\nbeta\n")) return false;
  const dir = join(process.cwd(), "git-fixture"); mkdirSync(dir);
  const checkoutEnv = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.autocrlf", GIT_CONFIG_VALUE_0: String(input.checkoutAutocrlf) };
  const readerEnv = input.readerConfig === "inherit" ? checkoutEnv : { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.autocrlf", GIT_CONFIG_VALUE_0: "false" };
  const run = (args, env = checkoutEnv) => execFileSync(input.gitBinary, ["-C", dir, ...args], { encoding: "utf8", env, windowsHide: true });
  run(["init", "-q"]);
  const content = (input.content ?? "alpha\nbeta\n").replaceAll("\r\n", "\n");
  writeFileSync(join(dir, "sample.txt"), input.newline === "CRLF" ? content.replaceAll("\n", "\r\n") : content);
  texts = [readFileSync(join(dir, "sample.txt"), "utf8")];
  const value = run(["config", "--type=bool", "--get", "core.autocrlf"], readerEnv).trim();
  if (!["true", "false"].includes(value)) return false;
  facts["git.readerAutocrlf"] = value === "true";
  facts["git.version"] = execFileSync(input.gitBinary, ["--version"], { encoding: "utf8", env: {}, windowsHide: true }).trim();
  facts["comparison.rule"] = "git-reader-config";
 } else return false;
 if (texts) {
  facts["data.encoding"] = "utf8";
  facts["data.hasCRLF"] = texts.some(text => text.includes("\r\n"));
  facts["data.totalBytes"] = texts.reduce((sum, text) => sum + Buffer.byteLength(text), 0);
 }
 facts["input.kind"] = input.kind;
 return true;
}
try {
 const observed = observe();
 console.log(JSON.stringify({ status: observed ? "observed" : "unknown", facts }));
} catch (error) {
 // Execution failures remain failures with BgTask evidence, not a negative scope claim.
 console.error(error instanceof Error ? error.message : "fact observation failed");
 process.exitCode = 1;
}