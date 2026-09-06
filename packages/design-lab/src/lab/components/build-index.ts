/**
 * Build the component index from source, with the TypeScript compiler.
 *
 * Why the compiler and not a regex: the single fact that makes this index
 * worth having is that `variant?: "ghost" | "solid" | "outline"` comes back
 * with those three strings. A regex can find the characters when the union is
 * written inline; it cannot follow `variant?: Variant` to the alias, cannot
 * tell a JSX tag from a generic argument (`useRef<HTMLElement>` looks exactly
 * like `<HTMLElement>` to a scanner), and cannot tell `<Browse/>` the local
 * component from `<Fragment/>` the import from react. All three of those are
 * in this repo already.
 *
 * Two seams keep it testable with neither a dev server nor a browser:
 *
 *   - `files` is an in-memory overlay, so a test can hand it source text.
 *   - `packageRoot` is a parameter, so the paths it prints are computed, not
 *     read off the machine it happens to run on.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * LAB_PACKAGE_DIR is declared here rather than imported from the inspect
 * plugin, which owns it. That is not a preference. This module is imported by
 * `vite-plugin-lab-fs.ts`, which is compiled by `tsconfig.node.json` with
 * `"lib": ["ES2023"]` and no DOM; `source-location.ts` mentions `Element` in
 * two signatures, so importing it there fails with
 * `TS2304: Cannot find name 'Element'` (measured, not assumed). Neither that
 * file nor that tsconfig is editable in this package's scope. So the constant
 * is duplicated and a test asserts the two are equal — a gate, rather than a
 * hope that the next person changes both.
 */

import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript";
import type {
  ComponentEntry,
  ComponentIndex,
  ComponentReach,
  ExportKind,
  PropInfo,
  ScreenRef,
} from "./types.ts";

/** This package's path from the repo root. Mirrors the inspect plugin's copy. */
export const LAB_PACKAGE_DIR = "packages/design-lab";

export type BuildOptions = {
  /** Absolute path of `packages/design-lab`. */
  packageRoot: string;
  /**
   * Screen entry files, absolute. Defaults to `<packageRoot>/src/screens/(any)/
   * screen.tsx`, the same glob `src/lab/screens.ts` uses to build the canvas.
   */
  screenFiles?: string[];
  /**
   * Overlay of path -> source text. Anything not in here is read from disk, so
   * a test can supply four fake screens and still get real lib.d.ts.
   */
  files?: Record<string, string>;
};

/** Forward slashes, no trailing dot segments. Windows stacks mix separators. */
function norm(p: string): string {
  return path.resolve(p).replace(/\\/g, "/");
}

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  noEmit: true,
  skipLibCheck: true,
  allowImportingTsExtensions: true,
  // Deliberately NOT strict. With strictNullChecks on, every optional prop's
  // type arrives as `T | undefined`, and there is no way to print the declared
  // half back without losing the alias (`ReactNode` would decompose into its
  // seven-way union). Off, `optional` still comes from the `?` in the syntax
  // and the printed type is the one that was written. It also matches this
  // package's own tsconfig, which is not strict either.
  strict: false,
  // The program is for reading types, never for reporting errors, so pulling
  // @types/node in would cost seconds and change nothing.
  types: [],
  lib: ["lib.es2023.d.ts", "lib.dom.d.ts"],
};

function scriptKindOf(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (file.endsWith(".js")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function createHost(
  options: ts.CompilerOptions,
  overlay: Map<string, string>,
): ts.CompilerHost {
  const base = ts.createCompilerHost(options, true);
  // Module resolution probes directories before files, so an overlay that only
  // answers readFile resolves nothing: `./Button` would never be tried as
  // `./Button.tsx` because the folder "does not exist". Both have to lie.
  const hasDir = (dir: string): boolean => {
    const prefix = `${norm(dir)}/`;
    for (const key of overlay.keys()) if (key.startsWith(prefix)) return true;
    return false;
  };
  return {
    ...base,
    fileExists: (f) => overlay.has(norm(f)) || base.fileExists(f),
    readFile: (f) => overlay.get(norm(f)) ?? base.readFile(f),
    directoryExists: (d) => hasDir(d) || (base.directoryExists?.(d) ?? false),
    realpath: (f) => (overlay.has(norm(f)) ? f : (base.realpath?.(f) ?? f)),
    getSourceFile: (f, langVersion, onError, shouldCreate) => {
      const text = overlay.get(norm(f));
      if (text === undefined) {
        return base.getSourceFile(f, langVersion, onError, shouldCreate);
      }
      return ts.createSourceFile(f, text, langVersion, true, scriptKindOf(f));
    },
  };
}

// ───────────────────────────── screens ─────────────────────────────

/** `export const <name> = <string literal>` at the top level, or null. */
function exportedString(sf: ts.SourceFile, name: string): string | null {
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || d.name.text !== name) continue;
      if (d.initializer && ts.isStringLiteralLike(d.initializer)) {
        return d.initializer.text;
      }
    }
  }
  return null;
}

/** `export const position = { x: <number>, … }`, so the index reads in canvas order. */
function exportedPositionX(sf: ts.SourceFile): number {
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || d.name.text !== "position") continue;
      if (!d.initializer || !ts.isObjectLiteralExpression(d.initializer)) continue;
      for (const p of d.initializer.properties) {
        if (!ts.isPropertyAssignment(p)) continue;
        if (p.name.getText() !== "x") continue;
        const v = p.initializer;
        if (ts.isNumericLiteral(v)) return Number(v.text);
        if (
          ts.isPrefixUnaryExpression(v) &&
          v.operator === ts.SyntaxKind.MinusToken &&
          ts.isNumericLiteral(v.operand)
        ) {
          return -Number(v.operand.text);
        }
      }
    }
  }
  return 0;
}

function defaultScreenFiles(packageRoot: string): string[] {
  const dir = path.resolve(packageRoot, "src/screens");
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const f = path.join(dir, e.name, "screen.tsx");
    if (fs.existsSync(f)) out.push(f);
  }
  return out;
}

// ─────────────────────────── declarations ───────────────────────────

type Decl = ts.FunctionDeclaration | ts.VariableDeclaration | ts.ClassDeclaration;

function isDecl(node: ts.Node): node is Decl {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isVariableDeclaration(node) ||
    ts.isClassDeclaration(node)
  );
}

function declName(decl: Decl): string | null {
  if (ts.isVariableDeclaration(decl)) {
    return ts.isIdentifier(decl.name) ? decl.name.text : null;
  }
  return decl.name?.text ?? null;
}

/** The function this component is, when it is one. */
function functionOf(decl: Decl): ts.SignatureDeclaration | null {
  if (ts.isFunctionDeclaration(decl)) return decl;
  if (ts.isVariableDeclaration(decl)) {
    const init = decl.initializer;
    if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
      return init;
    }
  }
  return null;
}

function exportKindOf(decl: Decl, checker: ts.TypeChecker): ExportKind {
  const node: ts.Node = ts.isVariableDeclaration(decl)
    ? decl.parent.parent
    : decl;
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  if (mods?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) return "default";
  if (mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return "named";

  // `export { Foo }` / `export default Foo` written apart from the declaration.
  const moduleSymbol = checker.getSymbolAtLocation(decl.getSourceFile());
  const name = declName(decl);
  if (moduleSymbol && name) {
    for (const ex of checker.getExportsOfModule(moduleSymbol)) {
      const target = ex.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(ex) : ex;
      const hit = target.declarations?.some((d) => d === decl);
      if (hit) return ex.getName() === "default" ? "default" : "named";
    }
  }
  return "local";
}

/** A declaration's identity across the walk. Position is stable per program. */
function keyOf(decl: Decl): string {
  return `${norm(decl.getSourceFile().fileName)}#${decl.getStart()}`;
}

// ────────────────────────────── props ──────────────────────────────

/** `{ variant = "solid", size: s = 2 }` -> prop name -> the default's text. */
function destructuringDefaults(decl: Decl): Map<string, string> {
  const out = new Map<string, string>();
  const fn = functionOf(decl);
  const p0 = fn?.parameters[0];
  if (!p0 || !ts.isObjectBindingPattern(p0.name)) return out;
  for (const el of p0.name.elements) {
    if (!el.initializer) continue;
    const key = el.propertyName ?? el.name;
    if (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) {
      out.set(key.text, el.initializer.getText());
    }
  }
  return out;
}

/** Every constituent of a union, or the type itself. */
function constituents(type: ts.Type): ts.Type[] {
  return type.isUnion() ? type.types : [type];
}

function propsOf(
  decl: Decl,
  checker: ts.TypeChecker,
): { props: PropInfo[]; problem?: string } {
  const type = checker.getTypeAtLocation(decl);
  const signatures = type.getCallSignatures();
  if (signatures.length === 0) {
    // A class component, a `forwardRef`, something else entirely. Say so
    // rather than reporting an empty prop list, which reads as "takes none".
    return { props: [], problem: "no call signature; props not read" };
  }
  const params = signatures[0].getParameters();
  if (params.length === 0) return { props: [] };

  const propsType = checker.getTypeOfSymbolAtLocation(params[0], decl);
  const defaults = destructuringDefaults(decl);
  const props: PropInfo[] = [];
  for (const p of checker.getPropertiesOfType(propsType)) {
    const at = p.valueDeclaration ?? p.declarations?.[0] ?? decl;
    const t = checker.getTypeOfSymbolAtLocation(p, at);
    const parts = constituents(t);
    const literals = parts.filter((x) => x.isStringLiteral());
    const info: PropInfo = {
      name: p.getName(),
      type: checker.typeToString(t, decl, ts.TypeFormatFlags.NoTruncation),
      optional: (p.getFlags() & ts.SymbolFlags.Optional) !== 0,
    };
    // All of them, or none: a partly-known set of values would let a control
    // be built that forbids values the component actually accepts.
    if (literals.length > 0 && literals.length === parts.length) {
      info.literalValues = literals.map((x) => x.value);
    }
    const dflt = defaults.get(info.name);
    if (dflt !== undefined) info.defaultValue = dflt;
    props.push(info);
  }
  return { props };
}

// ──────────────────────────── the walk ────────────────────────────

type Site = {
  tagName: ts.JsxTagNameExpression;
  /** The `<` of the opening tag. */
  start: number;
  text: string;
};

/** Every JSX tag inside a declaration, including nested closures. */
function jsxSitesIn(root: ts.Node): Site[] {
  const out: Site[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      out.push({
        tagName: node.tagName,
        start: node.getStart(),
        text: node.tagName.getText(),
      });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(root, visit);
  return out;
}

/** The declaration a JSX tag names, when it is a component of ours. */
function resolveTag(
  site: Site,
  checker: ts.TypeChecker,
  inPackage: (file: string) => boolean,
): Decl | null {
  const tag = site.tagName;
  // The language's own rule, not a heuristic: a lowercase identifier tag is a
  // host element (`<div>`), never a component.
  if (ts.isIdentifier(tag) && /^[a-z]/.test(tag.text)) return null;
  let sym = checker.getSymbolAtLocation(tag);
  if (!sym) return null;
  if (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
  const decl = sym.valueDeclaration ?? sym.declarations?.[0];
  if (!decl || !isDecl(decl)) return null;
  const file = norm(decl.getSourceFile().fileName);
  // react's Fragment, motion's div: real declarations, not ours.
  if (file.includes("/node_modules/") || file.endsWith(".d.ts")) return null;
  if (!inPackage(file)) return null;
  return decl;
}

/** The default export of a screen file: the component the lab renders. */
function defaultExportDecl(sf: ts.SourceFile, checker: ts.TypeChecker): Decl | null {
  const moduleSymbol = checker.getSymbolAtLocation(sf);
  if (!moduleSymbol) return null;
  for (const ex of checker.getExportsOfModule(moduleSymbol)) {
    if (ex.getName() !== "default") continue;
    const target = ex.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(ex) : ex;
    const decl = target.valueDeclaration ?? target.declarations?.[0];
    if (decl && isDecl(decl)) return decl;
  }
  return null;
}

// ──────────────────────────── the build ────────────────────────────

export function buildComponentIndex(opts: BuildOptions): ComponentIndex {
  const packageRoot = norm(opts.packageRoot);
  const overlay = new Map<string, string>();
  for (const [f, text] of Object.entries(opts.files ?? {})) overlay.set(norm(f), text);

  const screenFiles = (opts.screenFiles ?? defaultScreenFiles(packageRoot)).map(norm);
  const problems: string[] = [];

  const relative = (abs: string): string | null => {
    const rel = path.relative(packageRoot, abs).replace(/\\/g, "/");
    if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return `${LAB_PACKAGE_DIR}/${rel}`;
  };
  const inPackage = (abs: string): boolean => relative(abs) !== null;

  if (screenFiles.length === 0) {
    return { screens: [], components: [], problems: ["no screens found"] };
  }

  const host = createHost(COMPILER_OPTIONS, overlay);
  const program = ts.createProgram(screenFiles, COMPILER_OPTIONS, host);
  const checker = program.getTypeChecker();

  // Screen ids mirror src/lab/screens.ts: `export const id` when there is one,
  // otherwise the folder name. Ordered by `position.x`, the canvas's own
  // left-to-right order, so the printed index reads the way the canvas looks.
  const screens: (ScreenRef & { x: number })[] = [];
  for (const file of screenFiles) {
    const sf = program.getSourceFile(file);
    if (!sf) {
      problems.push(`screen not loaded: ${file}`);
      continue;
    }
    const dir = path.basename(path.dirname(file));
    const rel = relative(file);
    if (!rel) {
      problems.push(`screen outside the package: ${file}`);
      continue;
    }
    screens.push({
      id: exportedString(sf, "id") || dir,
      file: rel,
      x: exportedPositionX(sf),
    });
  }
  screens.sort((a, b) => a.x - b.x || a.id.localeCompare(b.id));

  const entries = new Map<string, ComponentEntry>();
  const order: string[] = [];

  const ensure = (
    decl: Decl,
    fallbackName: string,
    reach: ComponentReach,
    screenId: string,
  ): ComponentEntry => {
    const key = keyOf(decl);
    let entry = entries.get(key);
    if (!entry) {
      const rel = relative(norm(decl.getSourceFile().fileName));
      const read = propsOf(decl, checker);
      entry = {
        name: declName(decl) ?? fallbackName,
        file: rel ?? norm(decl.getSourceFile().fileName),
        exported: exportKindOf(decl, checker),
        aliases: [],
        props: read.props,
        reach,
        screens: [],
        instances: [],
      };
      if (read.problem) entry.problem = read.problem;
      entries.set(key, entry);
      order.push(key);
    }
    if (!entry.screens.includes(screenId)) entry.screens.push(screenId);
    return entry;
  };

  for (const screen of screens) {
    const abs = screenFiles.find((f) => relative(f) === screen.file);
    const sf = abs ? program.getSourceFile(abs) : undefined;
    if (!sf) continue;
    const root = defaultExportDecl(sf, checker);
    if (!root) {
      problems.push(`screen "${screen.id}" has no default-exported component`);
      continue;
    }

    type Task = { decl: Decl; name: string; path: string[]; isRoot: boolean };
    const rootName = declName(root) ?? screen.id;
    ensure(root, rootName, { kind: "screen-root", path: [screen.id] }, screen.id);

    // Breadth-first, so the first path that reaches a component is a shortest
    // one. Visited is per screen: the same component reached from two screens
    // is two instances of it, one under each, which is what the canvas shows.
    const visited = new Set<string>([keyOf(root)]);
    const queue: Task[] = [
      { decl: root, name: rootName, path: [screen.id], isRoot: true },
    ];
    while (queue.length > 0) {
      const task = queue.shift();
      if (!task) break;
      for (const site of jsxSitesIn(task.decl)) {
        const target = resolveTag(site, checker, inPackage);
        if (!target) continue;
        const targetFile = norm(target.getSourceFile().fileName);
        const rel = relative(targetFile);
        if (!rel) continue;
        const via = [...task.path, task.name];
        const entry = ensure(
          target,
          site.text,
          { kind: task.isRoot ? "screen" : "component", path: via },
          screen.id,
        );
        if (!entry.aliases.includes(site.text)) entry.aliases.push(site.text);

        const owner = task.decl.getSourceFile();
        const at = owner.getLineAndCharacterOfPosition(site.start);
        const ownerRel = relative(norm(owner.fileName));
        if (ownerRel) {
          entry.instances.push({
            screenId: screen.id,
            file: ownerRel,
            line: at.line + 1,
            column: at.character + 1,
            tag: site.text,
          });
        }

        const key = keyOf(target);
        if (!visited.has(key)) {
          visited.add(key);
          queue.push({
            decl: target,
            name: declName(target) ?? site.text,
            path: via,
            isRoot: false,
          });
        }
      }
    }
  }

  const components = order
    .map((k) => entries.get(k))
    .filter((e): e is ComponentEntry => e !== undefined);

  return {
    screens: screens.map(({ id, file }) => ({ id, file })),
    components,
    problems,
  };
}
