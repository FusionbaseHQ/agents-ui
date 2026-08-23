#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, "..");
const sourcePath = path.join(repositoryRoot, "src/pathDisplay.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const transpiled = ts.transpileModule(source, {
  fileName: sourcePath,
  reportDiagnostics: true,
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
});

const errors = (transpiled.diagnostics ?? []).filter(
  (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
);
if (errors.length > 0) {
  for (const diagnostic of errors) {
    console.error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
  }
  process.exit(1);
}

const moduleUrl = new URL(
  `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString("base64")}`,
  pathToFileURL(repositoryRoot),
);
const { localFileUrlForPath, shortenPathSmart } = await import(moduleUrl.href);

assert.equal(
  localFileUrlForPath("/tmp/report#1?.html"),
  "file:///tmp/report%231%3F.html",
  "literal URL delimiters in a filename must be path-encoded",
);
assert.equal(
  localFileUrlForPath("/tmp/颜色 space.html"),
  "file:///tmp/%E9%A2%9C%E8%89%B2%20space.html",
  "Unicode and spaces must retain encodeURI semantics",
);
assert.equal(
  localFileUrlForPath("/tmp/literal%23name.html"),
  "file:///tmp/literal%2523name.html",
  "a literal percent sequence must be encoded exactly once by encodeURI",
);

function assertNoUnpairedSurrogates(value, label) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      assert.ok(index + 1 < value.length, `${label}: dangling high surrogate`);
      const next = value.charCodeAt(index + 1);
      assert.ok(next >= 0xdc00 && next <= 0xdfff, `${label}: unpaired high surrogate`);
      index += 1;
    } else {
      assert.ok(unit < 0xdc00 || unit > 0xdfff, `${label}: unpaired low surrogate`);
    }
  }
}

const cases = [
  ["combining marks", "/prefix-e\u0301\u0323x", 3, "…x", "…"],
  ["variation selector", "/prefix-✈️x", 3, "…x", "…"],
  ["emoji modifier", "/prefix-👍🏽x", 4, "…x", "…"],
  ["ZWJ sequence", "/prefix-👩‍💻x", 4, "…x", "…"],
  ["modifier plus ZWJ", "/prefix-👩🏽‍💻x", 4, "…x", "…"],
  ["regional-indicator flag", "/prefix-🇩🇪x", 4, "…x", "…"],
  ["regional-indicator pairing", "/prefix-🇺🇸🇩🇪x", 6, "…🇩🇪x", "…"],
  ["conjoining Hangul jamo", "/abcdef\u1100\u1161", 2, "…", "…"],
  ["Indic virama conjunct", "/abcdef\u0915\u094d\u0937", 2, "…", "…"],
  ["GCB Prepend sequence", "/abcdef\u0d4e\u0d15", 2, "…", "…"],
  ["plain Unicode scalars", "/prefix-颜色x", 4, "…颜色x", "…"],
];

function runSuite(label, useFallbackExpectation) {
  for (const [caseLabel, input, maxChars, nativeExpected, fallbackExpected] of cases) {
    const expected = useFallbackExpectation ? fallbackExpected : nativeExpected;
    const actual = shortenPathSmart(input, maxChars);
    assert.equal(actual, expected, `${label}: ${caseLabel}`);
    assert.ok(actual.length <= maxChars, `${label}: ${caseLabel} exceeded its UTF-16 budget`);
    assertNoUnpairedSurrogates(actual, `${label}: ${caseLabel}`);
  }

  const exact = "/tmp/MiXeD-颜色-café-cafe\u0301-🚀";
  assert.equal(shortenPathSmart(exact, exact.length), exact, `${label}: exact Unicode path changed`);
  const edgeWhitespace = "  /tmp/edge whitespace  ";
  assert.equal(
    shortenPathSmart(edgeWhitespace, edgeWhitespace.length),
    edgeWhitespace,
    `${label}: exact path whitespace changed`,
  );
  const posixBackslash = "/tmp/folder\\report";
  assert.equal(
    shortenPathSmart(posixBackslash, posixBackslash.length),
    posixBackslash,
    `${label}: POSIX backslash was reinterpreted as a separator`,
  );
  assert.equal(
    shortenPathSmart("C:\\Users\\name", 13),
    "C:/Users/name",
    `${label}: unambiguous Windows separators were not normalized`,
  );
}

const segmenterDescriptor = Object.getOwnPropertyDescriptor(Intl, "Segmenter");
assert.equal(typeof Intl.Segmenter, "function", "test runtime must provide Intl.Segmenter for the native suite");
runSuite("Intl.Segmenter", false);

try {
  Object.defineProperty(Intl, "Segmenter", {
    configurable: true,
    writable: true,
    value: undefined,
  });
  runSuite("fallback", true);
} finally {
  if (segmenterDescriptor) Object.defineProperty(Intl, "Segmenter", segmenterDescriptor);
  else delete Intl.Segmenter;
}

console.log("Path display grapheme checks passed.");
