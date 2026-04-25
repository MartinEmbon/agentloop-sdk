// After the CJS tsc run, rename all .js outputs to .cjs and rewrite the
// require() strings inside them so cross-file imports still resolve.
//
// Why: package.json has "type": "module", so Node treats .js as ESM by
// default. Renaming CJS output to .cjs forces CommonJS semantics at the
// file level, regardless of the parent package.json's type.

import { readdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath handles platform differences correctly. Using .pathname
// directly on a file:// URL gives "/C:/Users/..." on Windows, which
// becomes "C:\C:\Users\..." when Node resolves it — a doubled drive
// letter. fileURLToPath strips the leading slash on Windows.
const CJS_DIR = fileURLToPath(new URL("../dist/cjs/", import.meta.url));

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (e.name.endsWith(".js")) {
      files.push(full);
    }
  }
  return files;
}

const jsFiles = await walk(CJS_DIR);

// First pass: rewrite require("./foo.js") → require("./foo.cjs") in each
// file. The TS source writes `from "./foo.js"` and tsc preserves the .js
// extension in both ESM and CJS output; we need to flip it for CJS so
// Node finds the renamed files.
for (const file of jsFiles) {
  let content = await readFile(file, "utf8");
  content = content.replace(/require\("(\.\/[^"]+?)\.js"\)/g, 'require("$1.cjs")');
  await writeFile(file, content, "utf8");
}

// Second pass: rename the files themselves.
for (const file of jsFiles) {
  const target = file.replace(/\.js$/, ".cjs");
  await rename(file, target);
}

// Third pass: drop a package.json in dist/cjs/ telling Node "this folder
// contains CommonJS." Belt-and-suspenders alongside the .cjs extension —
// protects against any future tsc emit-format regression.
await writeFile(
  join(CJS_DIR, "package.json"),
  JSON.stringify({ type: "commonjs" }, null, 2),
  "utf8",
);

console.log(`Renamed ${jsFiles.length} .js → .cjs in dist/cjs/`);
