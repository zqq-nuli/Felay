/**
 * Patches Module._resolveFilename and process.dlopen so that when running
 * inside a pkg-compiled binary, native .node files (used by node-pty) are
 * loaded from the real filesystem next to the executable, rather than from
 * pkg's virtual snapshot filesystem.
 *
 * This file is injected by esbuild into the CLI bundle BEFORE any other code.
 */
import path from "node:path";
import fs from "node:fs";
import Module from "node:module";

if ((process as any).pkg) {
  const execDir = path.dirname(process.execPath);
  const prebuildsDir = path.join(
    execDir,
    "prebuilds",
    `${process.platform}-${process.arch}`
  );

  // Patch 1: Module._resolveFilename — intercept require() for .node files
  // This runs BEFORE Node tries to find the file, so we can redirect .node
  // resolution to the real prebuilds directory.
  const origResolve = (Module as any)._resolveFilename;
  (Module as any)._resolveFilename = function (
    request: string,
    parent: any,
    ...args: any[]
  ) {
    if (request.endsWith(".node")) {
      const basename = path.basename(request);
      const realPath = path.join(prebuildsDir, basename);
      if (fs.existsSync(realPath)) return realPath;
    }
    return origResolve.call(this, request, parent, ...args);
  };

  // Patch 2: process.dlopen — fallback for any direct dlopen calls
  const originalDlopen = (process as any).dlopen.bind(process);
  (process as any).dlopen = function (
    module: any,
    filename: string,
    ...args: any[]
  ) {
    if (filename.endsWith(".node")) {
      const basename = path.basename(filename);
      const realPath = path.join(prebuildsDir, basename);
      if (fs.existsSync(realPath)) {
        return originalDlopen(module, realPath, ...args);
      }
    }
    return originalDlopen(module, filename, ...args);
  };
}
