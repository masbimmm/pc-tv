#!/usr/bin/env node
// Installs the antislop-ai skill set into .hermes/skills and .claude/skills.
// Usage: node scripts/install-skills.mjs  [--force]

import { fileURLToPath, pathToFileURL } from "url";
import path from "path";
import fs from "fs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const force = process.argv.includes("--force");

let lib;
try {
  // Dynamic import of a path needs a file:// URL on Windows.
  lib = await import(
    pathToFileURL(path.join(ROOT, "nodejs", "node_modules", "antislop-ai", "lib", "install.mjs")).href
  );
} catch (e) {
  console.error("antislop-ai tidak ditemukan. Jalankan dulu:  cd nodejs && npm install");
  console.error(String(e.message || e).slice(0, 200));
  process.exit(1);
}

const { resolveTargets, installSkills, updatePointers, skillSourceDir } = lib;

const skills = [
  "antislop",
  "antislop-code",
  "antislop-ui",
  "antislop-copywriting",
  "antislop-human",
  "antislop-layoutmobile",
];

const targets = resolveTargets("project", ["hermes", "claude"]);

const results = installSkills({ skills, targets, overwrite: force || true });
for (const r of results) console.log(`  OK: ${r.skill} -> ${r.path}`);

updatePointers({ targets, skills });
console.log("Selesai. Skill aktif di .hermes/skills dan .claude/skills.");
