// Duplicate every .d.ts file as .d.cts so the exports map's "require"
// branch has a matching types file. Modern tsconfig resolution
// (moduleResolution: "node16" / "bundler" in consumers) looks for .d.cts
// when the import path resolves to a CJS file, and .d.ts when it resolves
// to ESM. Same contents, different extension.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// See rename-cjs.mjs for the rationale behind fileURLToPath.
const TYPES_DIR = fileURLToPath(new URL("../dist/types/", import.meta.url));

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (e.name.endsWith(".d.ts")) {
      files.push(full);
    }
  }
  return files;
}

const dtsFiles = await walk(TYPES_DIR);

for (const file of dtsFiles) {
  const content = await readFile(file, "utf8");
  const cjsPath = file.replace(/\.d\.ts$/, ".d.cts");
  await writeFile(cjsPath, content, "utf8");
}

console.log(`Duplicated ${dtsFiles.length} .d.ts → .d.cts in dist/types/`);
