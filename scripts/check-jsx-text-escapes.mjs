#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(scriptDir, "../src");
const unicodeEscape = /\\u(?:[0-9a-fA-F]{4}|\{[0-9a-fA-F]+\})/;

function tsxFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return tsxFiles(absolute);
    return entry.isFile() && entry.name.endsWith(".tsx") ? [absolute] : [];
  });
}

const failures = [];
for (const file of tsxFiles(sourceRoot)) {
  const source = fs.readFileSync(file, "utf8");
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  function visit(node) {
    if (ts.isJsxText(node) && unicodeEscape.test(node.text)) {
      const location = parsed.getLineAndCharacterOfPosition(node.getStart(parsed));
      failures.push(`${path.relative(path.resolve(scriptDir, ".."), file)}:${location.line + 1}`);
    }
    ts.forEachChild(node, visit);
  }

  visit(parsed);
}

if (failures.length > 0) {
  console.error("Raw Unicode escape found in JSX text; use a JavaScript expression or an Icon:");
  for (const failure of failures) console.error(`  ${failure}`);
  process.exitCode = 1;
}
