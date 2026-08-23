#!/usr/bin/env node

import fs from "node:fs";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, "..");
const policyName = "FILESYSTEM_TEXT_INPUT_PROPS";

const expectedInputs = new Map([
  ["src/App.tsx", ["assetEditorName", "assetEditorPath"]],
  ["src/SessionTerminal.tsx", []],
  ["src/components/CodeEditorPanel.tsx", []],
  ["src/components/FileExplorerPanel.tsx", ["renameValue", "newFileName", "newFolderName"]],
  ["src/components/WorkspaceFileSearch.tsx", ["query"]],
  ["src/components/modals/NewSessionModal.tsx", ["cwd"]],
  ["src/components/modals/PathPickerModal.tsx", ["input", "selectionName"]],
  ["src/components/modals/ProjectModal.tsx", ["basePath", "sshRemotePath"]],
]);

const requiredPolicy = new Map([
  ["type", '"text"'],
  ["autoComplete", '"off"'],
  ["autoCapitalize", '"none"'],
  ["autoCorrect", '"off"'],
  ["spellCheck", "false"],
  ["writingsuggestions", '"false"'],
]);

const exactFilesystemValueIdentifiers = new Map([
  ["src/App.tsx", ["assetEditorPath", "data.basePath", "data.sshRemotePath", "data.cwd", "project.sshRemotePath", "request.path", "session.cwd"]],
  ["src/SessionTerminal.tsx", ["cwd"]],
  ["src/components/CodeEditorPanel.tsx", ["input.path", "fsEvent.from", "fsEvent.to", "fsEvent.path"]],
  ["src/components/FileExplorerPanel.tsx", ["renameValue", "newFileName", "newFolderName"]],
  ["src/components/WorkspaceFileSearch.tsx", ["rootDir"]],
  ["src/components/modals/NewSessionModal.tsx", ["cwd"]],
  ["src/components/modals/PathPickerModal.tsx", ["input", "selectionName"]],
  ["src/components/modals/ProjectModal.tsx", ["basePath", "sshRemotePath"]],
]);

const exactFilesystemTrimReceivers = new Map([
  ["src/App.tsx", ["cwd", "active.cwd", "request.path", "session.cwd"]],
  ["src/SessionTerminal.tsx", ["cwd"]],
  ["src/components/CodeEditorPanel.tsx", ["path", "input.path ?? \"\"", "input?.tabId ?? input?.path ?? \"\"", "fsEvent.from", "fsEvent.to", "fsEvent.path"]],
]);

const requiredHelperCallCounts = new Map([
  ["src/App.tsx", new Map([["isShortcutAllowedWhileEditing", 1]])],
  ["src/components/FileExplorerPanel.tsx", new Map([
    ["isInvalidPosixBasename", 3],
    ["isUnsupportedFilenameEncodingError", 2],
  ])],
  ["src/components/WorkspaceFileSearch.tsx", new Map([["isUnsupportedFilenameEncodingError", 2]])],
  ["src/components/modals/PathPickerModal.tsx", new Map([["isInvalidPosixBasename", 2]])],
]);

const failures = [];
const whitespaceTrimmingMethods = new Set(["trim", "trimStart", "trimEnd"]);
for (const [relativeFile, expectedValues] of expectedInputs) {
  const absoluteFile = path.join(repositoryRoot, relativeFile);
  const source = fs.readFileSync(absoluteFile, "utf8");
  const parsed = ts.createSourceFile(absoluteFile, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = new Set();
  const exactIdentifiers = exactFilesystemValueIdentifiers.get(relativeFile) ?? [];
  const exactTrimReceivers = exactFilesystemTrimReceivers.get(relativeFile) ?? [];
  const helperCalls = new Map();

  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const helper = node.expression.getText(parsed);
      helperCalls.set(helper, (helperCalls.get(helper) ?? 0) + 1);
    }
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(parsed) === "input") {
      const valueAttribute = node.attributes.properties.find(
        (property) => ts.isJsxAttribute(property) && property.name.getText(parsed) === "value",
      );
      const valueExpression =
        valueAttribute &&
        ts.isJsxAttribute(valueAttribute) &&
        valueAttribute.initializer &&
        ts.isJsxExpression(valueAttribute.initializer)
          ? valueAttribute.initializer.expression?.getText(parsed)
          : undefined;
      if (valueExpression && expectedValues.includes(valueExpression)) {
        found.add(valueExpression);
        const attributes = node.attributes.properties;
        const policyIndexes = attributes
          .map((property, index) =>
            ts.isJsxSpreadAttribute(property) && property.expression.getText(parsed) === policyName ? index : -1,
          )
          .filter((index) => index >= 0);
        if (policyIndexes.length === 0) {
          failures.push(`${relativeFile}: input value={${valueExpression}} is missing ...${policyName}`);
          return;
        }
        if (policyIndexes.length > 1) {
          failures.push(`${relativeFile}: input value={${valueExpression}} spreads ...${policyName} more than once`);
        }

        const policyIndex = policyIndexes[policyIndexes.length - 1];
        for (const property of attributes.slice(policyIndex + 1)) {
          if (ts.isJsxSpreadAttribute(property)) {
            failures.push(
              `${relativeFile}: input value={${valueExpression}} has a later spread that can override ...${policyName}`,
            );
            continue;
          }
          const attributeName = property.name.getText(parsed);
          const expected = requiredPolicy.get(attributeName);
          if (expected === undefined) continue;
          const actual = property.initializer?.getText(parsed) ?? "true";
          if (actual !== expected) {
            failures.push(
              `${relativeFile}: input value={${valueExpression}} overrides ${attributeName} after ...${policyName} with ${actual}`,
            );
          }
        }

        const hasAccessibleName = attributes.some(
          (property) =>
            ts.isJsxAttribute(property) &&
            ["aria-label", "aria-labelledby"].includes(property.name.getText(parsed)) &&
            Boolean(property.initializer),
        );
        if (!hasAccessibleName) {
          failures.push(`${relativeFile}: input value={${valueExpression}} needs aria-label or aria-labelledby`);
        }
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      whitespaceTrimmingMethods.has(node.expression.name.getText(parsed))
    ) {
      const receiver = node.expression.expression.getText(parsed);
      const method = node.expression.name.getText(parsed);
      if (exactTrimReceivers.includes(receiver)) {
        failures.push(
          `${relativeFile}: filesystem value ${receiver} must not be changed with .${method}() (${receiver}.${method}())`,
        );
      }
      for (const identifier of exactIdentifiers) {
        if (receiver.includes(identifier)) {
          failures.push(
            `${relativeFile}: filesystem value ${identifier} must not be changed with .${method}() (${receiver}.${method}())`,
          );
        }
      }
    }
    if (
      relativeFile === "src/components/FileExplorerPanel.tsx" &&
      ts.isFunctionDeclaration(node) &&
      node.name?.getText(parsed) === "normalizePath" &&
      /\.trim(?:Start|End)?\s*\(/.test(node.getText(parsed))
    ) {
      failures.push(`${relativeFile}: normalizePath must preserve leading and trailing filename whitespace`);
    }
    if (
      relativeFile === "src/components/FileExplorerPanel.tsx" &&
      ts.isFunctionDeclaration(node) &&
      node.name?.getText(parsed) === "basename" &&
      node.getText(parsed).includes("replace(/\\\\/g")
    ) {
      failures.push(`${relativeFile}: basename must preserve POSIX backslashes as literal filename characters`);
    }
    if (
      relativeFile === "src/App.tsx" &&
      ts.isFunctionDeclaration(node) &&
      node.name?.getText(parsed) === "basenamePath"
    ) {
      const implementation = node.getText(parsed);
      if (/\.trim(?:Start|End)?\s*\(/.test(implementation)) {
        failures.push(`${relativeFile}: basenamePath must preserve filename edge whitespace`);
      }
      if (implementation.includes("normalized.replace(/\\\\/g")) {
        failures.push(`${relativeFile}: basenamePath must preserve POSIX backslashes as literal filename characters`);
      }
    }
    if (
      relativeFile === "src/App.tsx" &&
      ts.isFunctionDeclaration(node) &&
      node.name?.getText(parsed) === "joinPathDisplay" &&
      /\[\\\\\/\]/.test(node.getText(parsed))
    ) {
      failures.push(`${relativeFile}: joinPathDisplay must preserve POSIX backslashes as literal filename characters`);
    }
    ts.forEachChild(node, visit);
  }

  visit(parsed);
  for (const expectedValue of expectedValues) {
    if (!found.has(expectedValue)) failures.push(`${relativeFile}: expected filesystem input value={${expectedValue}} was not found`);
  }
  for (const [helper, minimum] of requiredHelperCallCounts.get(relativeFile) ?? []) {
    const actual = helperCalls.get(helper) ?? 0;
    if (actual < minimum) {
      failures.push(`${relativeFile}: expected at least ${minimum} call(s) to ${helper}, found ${actual}`);
    }
  }
}

const policyFile = path.join(repositoryRoot, "src/components/filesystemInput.ts");
const policySource = fs.readFileSync(policyFile, "utf8");
const policyParsed = ts.createSourceFile(policyFile, policySource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
let policyFound = false;

function visitPolicy(node) {
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(policyParsed) === policyName &&
    node.initializer &&
    ts.isSatisfiesExpression(node.initializer) &&
    ts.isObjectLiteralExpression(node.initializer.expression)
  ) {
    policyFound = true;
    const actual = new Map(
      node.initializer.expression.properties
        .filter(ts.isPropertyAssignment)
        .map((property) => [property.name.getText(policyParsed), property.initializer.getText(policyParsed)]),
    );
    for (const [property, expected] of requiredPolicy) {
      if (actual.get(property) !== expected) {
        failures.push(`src/components/filesystemInput.ts: ${policyName}.${property} must be ${expected}`);
      }
    }
  }
  ts.forEachChild(node, visitPolicy);
}

visitPolicy(policyParsed);
if (!policyFound) failures.push(`src/components/filesystemInput.ts: ${policyName} policy object was not found`);

if (failures.length === 0) {
  const transpiled = ts.transpileModule(policySource, {
    fileName: policyFile,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const diagnostics = (transpiled.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  assert.equal(diagnostics.length, 0, "filesystem input helper must transpile without errors");
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString("base64")}`;
  const {
    armImeSubmitSuppression,
    classifyImeEnter,
    consumeImeSubmitSuppression,
    isInvalidPosixBasename,
    isImeCompositionKey,
    isShortcutAllowedWhileEditing,
    isUnsupportedFilenameEncodingError,
  } = await import(moduleUrl);

  assert.equal(isInvalidPosixBasename("report "), false, "trailing whitespace is a valid basename");
  assert.equal(isInvalidPosixBasename("folder\\report"), false, "backslash is valid on POSIX/macOS");
  assert.equal(isInvalidPosixBasename("folder/report"), true, "slash is a POSIX path separator");
  assert.equal(isInvalidPosixBasename("name\0suffix"), true, "NUL is never valid in a filename");
  assert.equal(isInvalidPosixBasename(".."), true, "parent traversal is not a basename");
  assert.equal(isUnsupportedFilenameEncodingError("name is not valid UTF-8"), true);
  assert.equal(isUnsupportedFilenameEncodingError("permission denied"), false);
  assert.equal(isShortcutAllowedWhileEditing("palette.open", false), true);
  assert.equal(isShortcutAllowedWhileEditing("files.search", false), true);
  assert.equal(isShortcutAllowedWhileEditing("shortcuts.show", false), true);
  assert.equal(isShortcutAllowedWhileEditing("session.new", false), false);
  assert.equal(isShortcutAllowedWhileEditing("terminal.search", false), false);
  assert.equal(isShortcutAllowedWhileEditing("terminal.search", true), true);
  assert.equal(isShortcutAllowedWhileEditing("shortcuts.show", true), false, "Monaco must retain Cmd+/ comments");

  assert.equal(
    classifyImeEnter({ key: "Enter", isComposing: true, keyCode: 229 }, true),
    "active-composition",
    "active keyCode-229 composition must keep the IME default action",
  );
  assert.equal(
    classifyImeEnter({ key: "Enter", isComposing: false, keyCode: 229 }, false),
    "trailing-enter",
    "a non-composing WebKit keyCode-229 Enter must be classified as trailing",
  );
  assert.equal(
    classifyImeEnter({ key: "Enter", isComposing: false, keyCode: 13 }, false),
    "none",
  );
  assert.equal(isImeCompositionKey({ isComposing: true, keyCode: 13 }), true);
  assert.equal(isImeCompositionKey({ isComposing: false, keyCode: 229 }), true);

  const previousWindow = globalThis.window;
  globalThis.window = { setTimeout };
  try {
    const suppression = { current: 0 };
    armImeSubmitSuppression(suppression);
    assert.equal(consumeImeSubmitSuppression(suppression), true);
    assert.equal(consumeImeSubmitSuppression(suppression), false);
    armImeSubmitSuppression(suppression);
    await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(consumeImeSubmitSuppression(suppression), false, "suppression must not eat a later Enter");
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
}

if (failures.length > 0) {
  console.error("Filesystem input policy check failed:");
  for (const failure of failures) console.error(`  ${failure}`);
  process.exitCode = 1;
}
