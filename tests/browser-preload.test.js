const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadBrowserPreload() {
  const documentListeners = new Map();
  const windowListeners = new Map();
  const ipcListeners = new Map();
  const sent = [];
  const document = {
    addEventListener: (type, handler) => documentListeners.set(type, handler),
    querySelectorAll: () => [],
    title: "Example",
  };
  const ipcRenderer = {
    on: (channel, handler) => ipcListeners.set(channel, handler),
    sendToHost: (channel, payload) => sent.push({ channel, payload }),
  };
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "browser-preload.js"), "utf8");
  vm.runInNewContext(source, {
    require: (id) => id === "electron" ? { ipcRenderer } : [],
    document,
    window: { addEventListener: (type, handler) => windowListeners.set(type, handler) },
    setTimeout,
    clearTimeout,
    URL,
    location: { href: "https://example.com" },
    HTMLInputElement: class {},
    HTMLTextAreaElement: class {},
    Element: class {},
  });
  windowListeners.get("DOMContentLoaded")();
  return { documentListeners, ipcListeners, sent };
}

test("side mouse shortcut prevents only the exact assigned binding", () => {
  const preload = loadBrowserPreload();
  preload.ipcListeners.get("shortcut-bindings")({}, ["Ctrl+MouseBack"]);
  const handler = preload.documentListeners.get("mousedown");
  let prevented = 0;
  const createEvent = (ctrlKey) => ({
    button: 3,
    ctrlKey,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    target: {},
    preventDefault: () => { prevented += 1; },
    stopPropagation() {},
    stopImmediatePropagation() {},
  });

  handler(createEvent(false));
  assert.equal(prevented, 0);
  handler(createEvent(true));
  assert.equal(prevented, 1);
  assert.equal(preload.sent.filter((entry) => entry.channel === "shortcut-input").length, 2);
});
