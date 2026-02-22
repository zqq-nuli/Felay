#!/usr/bin/env node
/**
 * Build standalone CLI and Daemon executables for distribution.
 *
 * Pipeline: TypeScript → esbuild (single CJS) → pkg (standalone .exe)
 *
 * Usage: node scripts/build-binaries.mjs
 */
import { build } from "esbuild";
import { exec } from "@yao-pkg/pkg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const BUILD = path.join(ROOT, "build");

// ── Helpers ──────────────────────────────────────────────────────────────────

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) {
    throw new Error(`Source not found: ${src}`);
  }
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

function findNodePtyPrebuilds() {
  // Try direct node_modules first (hoisted), then pnpm store
  const candidates = [
    path.join(ROOT, "node_modules", "node-pty", "prebuilds"),
    ...fs
      .readdirSync(path.join(ROOT, "node_modules", ".pnpm"), {
        withFileTypes: true,
      })
      .filter((d) => d.isDirectory() && d.name.startsWith("node-pty@"))
      .map((d) =>
        path.join(
          ROOT,
          "node_modules",
          ".pnpm",
          d.name,
          "node_modules",
          "node-pty",
          "prebuilds"
        )
      ),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("Could not find node-pty prebuilds directory");
}

// esbuild plugin: resolve .node files as external (native addons can't be bundled)
const nativeModulesPlugin = {
  name: "native-modules",
  setup(build) {
    build.onResolve({ filter: /\.node$/ }, (args) => ({
      path: args.path,
      external: true,
    }));
  },
};

// esbuild plugin: handle node-pty's child_process.fork and Worker paths
// In pkg, __dirname points to the snapshot. We need to redirect these paths
// to the real filesystem. We do this by replacing __dirname refs in node-pty's
// agent/worker files at build time.
const nodePtyWorkerPlugin = {
  name: "node-pty-workers",
  setup(build) {
    // For conpty_console_list_agent.js and conoutSocketWorker.js,
    // these are spawned as separate processes/threads. In pkg, they need
    // to be available on the real filesystem. We'll copy them as assets.
    build.onLoad(
      { filter: /node-pty.*windowsPtyAgent\.(js|ts)$/ },
      async (args) => {
        let contents = await fs.promises.readFile(args.path, "utf-8");
        // Replace the fork() call to use the real filesystem path
        // Original: child_process.fork(path.join(__dirname, 'conpty_console_list_agent.js'))
        // Replace __dirname with process.pkg ? path.dirname(process.execPath) : __dirname
        contents = contents.replace(
          /path\.join\(__dirname,\s*(['"]conpty_console_list_agent\.js['"])\)/g,
          `path.join((process.pkg ? path.dirname(process.execPath) : __dirname), $1)`
        );
        return { contents, loader: "js" };
      }
    );
    build.onLoad(
      { filter: /node-pty.*windowsConoutConnection\.(js|ts)$/ },
      async (args) => {
        let contents = await fs.promises.readFile(args.path, "utf-8");
        // Replace the Worker() path similarly
        contents = contents.replace(
          /path\.join\(__dirname,\s*(['"]worker\/conoutSocketWorker\.js['"]|['"]worker[/\\]conoutSocketWorker\.js['"])\)/g,
          `path.join((process.pkg ? path.dirname(process.execPath) : __dirname), $1)`
        );
        return { contents, loader: "js" };
      }
    );
  },
};

// ── Main ─────────────────────────────────────────────────────────────────────

console.log("[build] Cleaning build directory...");
fs.rmSync(BUILD, { recursive: true, force: true });
fs.mkdirSync(BUILD, { recursive: true });

// Common esbuild options for ESM → CJS conversion
const commonOptions = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  // Handle import.meta.url → __filename for CJS
  banner: {
    js: `const __import_meta_url = require("url").pathToFileURL(__filename).href;`,
  },
  define: {
    "import.meta.url": "__import_meta_url",
  },
};

// Step 1: Bundle CLI with esbuild (ESM → single CJS)
// node-pty JS is bundled, only .node native addons are external
console.log("[build] Bundling CLI...");
await build({
  ...commonOptions,
  entryPoints: [path.join(ROOT, "packages/cli/src/index.ts")],
  outfile: path.join(BUILD, "cli-bundle.cjs"),
  external: [], // node-pty JS is bundled; .node files handled by plugin
  plugins: [nativeModulesPlugin, nodePtyWorkerPlugin],
  inject: [path.join(ROOT, "packages/cli/src/nodePtyPatch.ts")],
});

// Strip shebang lines from CLI bundle (pkg can't parse them)
const cliBundle = fs.readFileSync(path.join(BUILD, "cli-bundle.cjs"), "utf-8");
fs.writeFileSync(
  path.join(BUILD, "cli-bundle.cjs"),
  cliBundle.replace(/^#!.*\n/gm, "")
);

// Step 2: Bundle Daemon with esbuild (no native modules)
console.log("[build] Bundling Daemon...");
await build({
  ...commonOptions,
  entryPoints: [path.join(ROOT, "packages/daemon/src/index.ts")],
  outfile: path.join(BUILD, "daemon-bundle.cjs"),
  external: [],
});

// Step 3: Create CLI executable with pkg
console.log("[build] Creating CLI executable (pkg)...");
await exec([
  path.join(BUILD, "cli-bundle.cjs"),
  "--target",
  "node20-win-x64",
  "--output",
  path.join(BUILD, "felay.exe"),
]);

// Step 4: Create Daemon executable with pkg
console.log("[build] Creating Daemon executable (pkg)...");
await exec([
  path.join(BUILD, "daemon-bundle.cjs"),
  "--target",
  "node20-win-x64",
  "--output",
  path.join(BUILD, "felay-daemon.exe"),
]);

// Step 5: Copy node-pty prebuilt native modules
console.log("[build] Copying node-pty native modules...");
const prebuildsDir = findNodePtyPrebuilds();
const platform = "win32-x64";
const src = path.join(prebuildsDir, platform);
const dest = path.join(BUILD, "prebuilds", platform);

if (!fs.existsSync(src)) {
  console.error(
    `[build] Warning: prebuilds for ${platform} not found at ${src}`
  );
  console.error("[build] The CLI exe will not be able to spawn PTY sessions.");
} else {
  // Copy only the required files (skip .pdb debug symbols)
  const files = [
    "pty.node",
    "conpty.node",
    "conpty_console_list.node",
    "winpty.dll",
    "winpty-agent.exe",
  ];
  fs.mkdirSync(dest, { recursive: true });
  for (const f of files) {
    const fileSrc = path.join(src, f);
    if (fs.existsSync(fileSrc)) {
      fs.copyFileSync(fileSrc, path.join(dest, f));
    }
  }
  // Copy conpty subdirectory
  const conptySrc = path.join(src, "conpty");
  if (fs.existsSync(conptySrc)) {
    copyRecursive(conptySrc, path.join(dest, "conpty"));
  }
}

// Step 6: Copy node-pty worker/agent JS files for pkg runtime
// These are spawned as separate processes/threads and must exist on the real filesystem
console.log("[build] Copying node-pty worker files...");
const nodePtyBase = path.dirname(path.dirname(prebuildsDir)); // go up from prebuilds to node-pty root
const workerFiles = [
  "lib/conpty_console_list_agent.js",
  "lib/worker/conoutSocketWorker.js",
];
for (const wf of workerFiles) {
  const wfSrc = path.join(nodePtyBase, wf);
  if (fs.existsSync(wfSrc)) {
    const wfDest = path.join(BUILD, path.basename(wf));
    fs.mkdirSync(path.dirname(wfDest), { recursive: true });
    fs.copyFileSync(wfSrc, wfDest);
    console.log(`  Copied ${wf}`);
  }
}

// Summary
const cliSize = fs.statSync(path.join(BUILD, "felay.exe")).size;
const daemonSize = fs.statSync(path.join(BUILD, "felay-daemon.exe")).size;
console.log(`[build] Done!`);
console.log(`  felay.exe        ${(cliSize / 1024 / 1024).toFixed(1)} MB`);
console.log(`  felay-daemon.exe ${(daemonSize / 1024 / 1024).toFixed(1)} MB`);
