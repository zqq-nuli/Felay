#!/usr/bin/env node
/**
 * Felay Release Builder
 *
 * One-command pipeline to produce a ready-to-distribute NSIS installer.
 *
 *   node scripts/release.mjs              # build installer only
 *   node scripts/release.mjs --publish   # build + create GitHub release (latest)
 *   node scripts/release.mjs --publish --prerelease  # build + create pre-release
 *
 * Pipeline:
 *   1. Kill running daemon (avoid file locks)
 *   2. pnpm run build          — compile TypeScript (shared → daemon → cli → gui)
 *   3. build-binaries.mjs      — esbuild + pkg → felay.exe, felay-daemon.exe
 *   4. cargo tauri build       — Vite frontend + Rust GUI + NSIS installer
 *   5. (optional) gh release   — upload to GitHub Releases
 *
 * Prerequisites:
 *   - pnpm, Node.js 20+, Rust toolchain (cargo), cargo-tauri
 *   - gh CLI (only for --publish)
 */
import { execSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TAURI_DIR = path.join(ROOT, "packages", "gui", "src-tauri");

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`\n\x1b[36m[release]\x1b[0m ${msg}`);
}

function run(cmd, opts = {}) {
  log(`> ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: ROOT, ...opts });
}

function readVersion() {
  const conf = JSON.parse(fs.readFileSync(path.join(TAURI_DIR, "tauri.conf.json"), "utf8"));
  return conf.version;         // e.g. "0.1.0"
}

function ensureCargo() {
  try {
    execFileSync("cargo", ["--version"], { stdio: "pipe" });
  } catch {
    // cargo not in PATH — try CARGO_HOME or default ~/.cargo/bin
    const cargoHome = process.env.CARGO_HOME
      ? path.join(process.env.CARGO_HOME, "bin")
      : path.join(os.homedir(), ".cargo", "bin");
    const cargoExe = path.join(cargoHome, process.platform === "win32" ? "cargo.exe" : "cargo");
    if (fs.existsSync(cargoExe)) {
      process.env.PATH = `${cargoHome}${path.delimiter}${process.env.PATH}`;
      log("Added cargo to PATH from CARGO_HOME");
    } else {
      console.error("\x1b[31m[release] cargo not found. Install Rust: https://rustup.rs\x1b[0m");
      process.exit(1);
    }
  }
}

function killDaemon() {
  const lockPath = path.join(os.homedir(), ".felay", "daemon.json");
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    process.kill(lock.pid);
    log(`Killed daemon (pid ${lock.pid})`);
  } catch {
    // no daemon running — fine
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const publish = args.includes("--publish");
const prerelease = args.includes("--prerelease");

const version = readVersion();
log(`Felay v${version} — full release build`);

// Step 0: Kill daemon to avoid file locks
log("Step 0/4 — Killing daemon...");
killDaemon();

// Step 1: Compile TypeScript
log("Step 1/4 — Compiling TypeScript...");
run("pnpm run build");

// Step 2: Build standalone binaries (esbuild + pkg)
log("Step 2/4 — Building standalone binaries...");
run("node scripts/build-binaries.mjs");

// Verify build artifacts exist
const requiredArtifacts = ["felay.exe", "felay-daemon.exe", "felay-notify.js", "felay-claude-hook.js"];
for (const f of requiredArtifacts) {
  const p = path.join(ROOT, "build", f);
  if (!fs.existsSync(p)) {
    console.error(`\x1b[31m[release] Missing build artifact: ${p}\x1b[0m`);
    process.exit(1);
  }
}
log("All build artifacts verified.");

// Step 3: Build NSIS installer via cargo tauri build
log("Step 3/4 — Building NSIS installer...");
ensureCargo();
run("cargo tauri build", { cwd: TAURI_DIR });

// Locate installer
const nsisDir = path.join(TAURI_DIR, "target", "release", "bundle", "nsis");
const installerName = `Felay_${version}_x64-setup.exe`;
const installerPath = path.join(nsisDir, installerName);

if (!fs.existsSync(installerPath)) {
  console.error(`\x1b[31m[release] Installer not found: ${installerPath}\x1b[0m`);
  process.exit(1);
}

const sizeMB = (fs.statSync(installerPath).size / 1024 / 1024).toFixed(1);

log("Build complete!");
console.log(`\n  Installer: ${installerPath}`);
console.log(`  Size:      ${sizeMB} MB`);
console.log(`  Version:   ${version}`);

// Step 4 (optional): Publish to GitHub
if (publish) {
  log("Step 4/4 — Publishing to GitHub Releases...");
  const tag = prerelease ? `v${version}-beta` : `v${version}`;
  try {
    execFileSync("gh", ["--version"], { stdio: "pipe" });
  } catch {
    console.error("\x1b[31m[release] gh CLI not found. Install: https://cli.github.com\x1b[0m");
    process.exit(1);
  }

  const body = [
    `## Felay ${tag}\n`,
    "### Install",
    `Download \`${installerName}\` and run.\n`,
    "### What's included",
    "- Felay GUI (Tauri desktop app)",
    "- Felay Daemon (background service)",
    "- Felay CLI (`felay run claude` / `felay run codex`)",
    "- Hook scripts (Codex notify + Claude Code Stop)",
    "- node-pty native modules\n",
    "### System requirements",
    "- Windows 10/11 x64",
  ].join("\n");

  const prereleaseFlag = prerelease ? " --prerelease" : " --latest";
  run(`gh release create ${tag} "${installerPath}#${installerName}" --title "${tag}"${prereleaseFlag} --notes "${body.replace(/"/g, '\\"')}"`);
  log(`Published ${tag}!`);
} else {
  console.log(`\n  To publish:  node scripts/release.mjs --publish`);
  console.log(`  Pre-release: node scripts/release.mjs --publish --prerelease`);
}
