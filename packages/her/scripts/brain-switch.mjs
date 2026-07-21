#!/usr/bin/env node
// brain-switch — point Samantha's brain at a Her-controlled provider (a "lane")
// instead of the borrowed claude-bridge, or restore claude-bridge.
//
// WHY: Samantha's default brain is claude-bridge (keyless, borrows Fei's Claude
// subscription). When that access goes away, her brain goes dark. This script
// flips the project-level .pi/settings.json (which OVERRIDES the global
// ~/.pi/agent/settings.json) to a lane defined in brain-lanes.json. Lanes are
// the single source of truth; the concrete provider/model can change there
// without touching this script.
//
// The project .pi/settings.json is live config (gitignored). This script is the
// only thing that edits it, and only when you explicitly run --to / --restore.
// It always backs up first (.pi/settings.json.bak) and writes atomically.
//
// Usage:
//   node brain-switch.mjs --status                 show current brain + matching lane
//   node brain-switch.mjs --to brain-main          switch to a lane (backs up first)
//   node brain-switch.mjs --to brain-kimi --dry-run show the diff without writing
//   node brain-switch.mjs --restore                remove the override (back to global claude-bridge)
//   node brain-switch.mjs --list                   list lanes
// Options:
//   --settings <path>   override settings.json path (default: <repo>/samantha/.pi/settings.json)
//   --lanes <path>      override brain-lanes.json path (default: ../brain-lanes.json)

import { readFileSync, writeFileSync, copyFileSync, existsSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { dirname, resolve, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// pi honors a project-level .pi/settings.json defaultProvider ONLY for trusted
// projects (see coding-agent settings-manager: scope==="project" && !trusted →
// project settings ignored). samantha is not in the trust store, so the GLOBAL
// ~/.pi/agent/settings.json defaultProvider is what actually drives Samantha's
// brain — and global is unconditional (no trust gate). So the brain switch
// targets GLOBAL by default; --project is available for trusted-project scoping.
function globalSettingsPath() {
  return resolve(homedir(), ".pi", "agent", "settings.json");
}
function projectSettingsPath() {
  return resolve(__dirname, "..", "..", "..", ".pi", "settings.json");
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--status") args.status = true;
    else if (a === "--list") args.list = true;
    else if (a === "--restore") args.restore = true;
    else if (a === "--global") args.global = true;
    else if (a === "--project") args.project = true;
    else if (a === "--to") args.to = argv[++i];
    else if (a === "--settings") args.settings = argv[++i];
    else if (a === "--lanes") args.lanes = argv[++i];
    else args._.push(a);
  }
  return args;
}

function fail(msg) {
  console.error(`brain-switch: ${msg}`);
  process.exit(1);
}

function loadLanes(lanesPath) {
  if (!existsSync(lanesPath)) fail(`lanes config not found: ${lanesPath}`);
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(lanesPath, "utf8"));
  } catch (e) {
    fail(`lanes config is not valid JSON (${lanesPath}): ${e.message}`);
  }
  if (!cfg || typeof cfg.lanes !== "object") fail(`lanes config missing "lanes" object: ${lanesPath}`);
  return cfg;
}

function readSettings(settingsPath) {
  if (!existsSync(settingsPath)) fail(`settings not found: ${settingsPath}`);
  try {
    return JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch (e) {
    fail(`settings is not valid JSON (${settingsPath}): ${e.message}`);
  }
}

// Detect the file's indentation so we write it back the same way (surgical).
function detectIndent(raw) {
  const m = raw.match(/^([ \t]+)"/m);
  return m ? m[1] : "\t";
}

function matchLane(lanes, provider, model) {
  for (const [name, lane] of Object.entries(lanes)) {
    if (lane.provider === provider && lane.model === model) return name;
  }
  return null;
}

function writeAtomic(path, content) {
  const tmp = `${path}.tmp-brain-switch`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const lanesPath = args.lanes ? resolve(args.lanes) : resolve(__dirname, "..", "brain-lanes.json");
  // Brain switch targets GLOBAL settings by default (unconditional; project-level
  // is trust-gated and ignored for untrusted projects like samantha). --project
  // forces the project scope; --settings <path> overrides entirely.
  const scope = args.project ? "project" : "global";
  const settingsPath = args.settings
    ? resolve(args.settings)
    : scope === "project"
      ? projectSettingsPath()
      : globalSettingsPath();

  const cfg = loadLanes(lanesPath);
  const lanes = cfg.lanes;

  if (args.list) {
    console.log(`Lanes (from ${lanesPath}):`);
    for (const [name, lane] of Object.entries(lanes)) {
      const flag = name === cfg.default ? " [default]" : name === cfg.fallback ? " [fallback]" : "";
      console.log(`  ${name}${flag}: ${lane.provider}/${lane.model}  (env ${lane.envKey})`);
      if (lane.note) console.log(`      ${lane.note}`);
    }
    return;
  }

  if (args.status) {
    const s = readSettings(settingsPath);
    const provider = s.defaultProvider ?? "(inherits global)";
    const model = s.defaultModel ?? "(inherits global)";
    const lane = s.defaultProvider && s.defaultModel ? matchLane(lanes, s.defaultProvider, s.defaultModel) : null;
    console.log(`scope: ${scope} (${settingsPath})`);
    console.log(`brain: provider=${provider} model=${model}`);
    if (s.defaultProvider) {
      console.log(`lane: ${lane ?? "(no matching lane — custom override)"}`);
    } else {
      console.log(`lane: (none set — Samantha inherits global ~/.pi/agent/settings.json, i.e. claude-bridge)`);
    }
    return;
  }

  if (args.restore) {
    const s = readSettings(settingsPath);
    const had = "defaultProvider" in s || "defaultModel" in s;
    const next = { ...s };
    delete next.defaultProvider;
    delete next.defaultModel;
    const raw = readFileSync(settingsPath, "utf8");
    const indent = detectIndent(raw);
    const content = JSON.stringify(next, null, indent) + "\n";
    if (args.dryRun) {
      console.log(`[dry-run] would remove defaultProvider/defaultModel from ${settingsPath}`);
      console.log(`[dry-run] Samantha would fall back to global (claude-bridge). had override: ${had}`);
      return;
    }
    copyFileSync(settingsPath, `${settingsPath}.bak`);
    writeAtomic(settingsPath, content);
    console.log(`restored: removed override; Samantha now inherits global brain (claude-bridge).`);
    console.log(`backup: ${settingsPath}.bak`);
    return;
  }

  if (args.to) {
    const lane = lanes[args.to];
    if (!lane) fail(`unknown lane "${args.to}". Run --list to see lanes.`);
    if (!lane.provider || !lane.model) fail(`lane "${args.to}" missing provider/model`);
    // Warn (not fail) if the lane's key isn't in the environment — env may be set
    // in the shell that actually launches Samantha, not this one.
    const keyPresent = lane.envKey ? Boolean(process.env[lane.envKey]) : true;
    const s = readSettings(settingsPath);
    const next = { ...s, defaultProvider: lane.provider, defaultModel: lane.model };
    const raw = readFileSync(settingsPath, "utf8");
    const indent = detectIndent(raw);
    const content = JSON.stringify(next, null, indent) + "\n";
    if (args.dryRun) {
      console.log(`[dry-run] would set brain -> ${lane.provider}/${lane.model} (lane ${args.to})`);
      console.log(`[dry-run] settings: ${settingsPath}`);
      console.log(`[dry-run] env ${lane.envKey}: ${keyPresent ? "present" : "MISSING (set it before launching Samantha)"}`);
      return;
    }
    copyFileSync(settingsPath, `${settingsPath}.bak`);
    writeAtomic(settingsPath, content);
    console.log(`switched: brain -> ${lane.provider}/${lane.model} (lane ${args.to})`);
    if (!keyPresent) {
      console.log(`WARNING: env ${lane.envKey} is not set in this shell — make sure it's present where Samantha launches, or she'll fail to authenticate.`);
    }
    console.log(`backup: ${settingsPath}.bak`);
    return;
  }

  console.error("brain-switch: nothing to do. Use --status | --list | --to <lane> | --restore (add --dry-run to preview).");
  process.exit(1);
}

main();
