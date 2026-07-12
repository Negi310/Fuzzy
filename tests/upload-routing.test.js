const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { getExplorerDragMode, hasNewAttachmentEvidence } = require("../src/upload-routing");

test("ChatGPT always uses the managed upload bridge", () => {
  assert.equal(getExplorerDragMode({ supportKind: "chatgpt", selectedCount: 1 }), "managed");
  assert.equal(getExplorerDragMode({ supportKind: "chatgpt", selectedCount: 3 }), "managed");
});

test("Moodle keeps native single-file drag and managed multi-file drag", () => {
  assert.equal(getExplorerDragMode({ supportKind: "moodle", selectedCount: 1 }), "native");
  assert.equal(getExplorerDragMode({ supportKind: "moodle", selectedCount: 2 }), "managed");
});

test("split view uses managed drag when any visible destination is ChatGPT", () => {
  assert.equal(getExplorerDragMode({
    supportKind: "moodle",
    supportKinds: ["moodle", "chatgpt"],
    selectedCount: 1,
  }), "managed");
});

test("non-upload pages keep native single-file drag only", () => {
  assert.equal(getExplorerDragMode({ selectedCount: 1 }), "native");
  assert.equal(getExplorerDragMode({ selectedCount: 2 }), "none");
  assert.equal(getExplorerDragMode({ selectedCount: 1, isDirectory: true }), "none");
});

test("attachment evidence requires a new file name or chip", () => {
  const baseline = { composerText: "report.pdf", chipCount: 1 };
  assert.equal(hasNewAttachmentEvidence(
    baseline,
    { composerText: "report.pdf", chipCount: 1 },
    ["report.pdf"]
  ), false);
  assert.equal(hasNewAttachmentEvidence(
    baseline,
    { composerText: "report.pdf notes.docx", chipCount: 1 },
    ["notes.docx"]
  ), true);
  assert.equal(hasNewAttachmentEvidence(
    baseline,
    { composerText: "report.pdf", chipCount: 2 },
    ["report.pdf"]
  ), true);
});

test("upload routing loads in the renderer without CommonJS globals", () => {
  const context = vm.createContext({});
  context.window = context;
  context.globalThis = context;
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "upload-routing.js"), "utf8"), context);
  assert.equal(typeof context.FuzitterUploadRouting.getExplorerDragMode, "function");
});
