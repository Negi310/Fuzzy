const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const srcDir = path.join(__dirname, "..", "src");
const rendererSource = fs.readFileSync(path.join(srcDir, "renderer.js"), "utf8");
const stylesSource = fs.readFileSync(path.join(srcDir, "styles.css"), "utf8");
const preloadSource = fs.readFileSync(path.join(srcDir, "preload.js"), "utf8");
const mainSource = fs.readFileSync(path.join(srcDir, "main.js"), "utf8");

test("tutorial opens the submitted PDF from docs", () => {
  assert.ok(rendererSource.includes("\\\\docs\\\\Fuzitter_Tutorial.pdf"));
  assert.ok(fs.existsSync(path.join(srcDir, "..", "docs", "Fuzitter_Tutorial.pdf")));
});

test("browser tabs keep their maximum width and expose full titles", () => {
  assert.match(rendererSource, /tabItem\.title = tabTitle/);
  assert.match(rendererSource, /className = "browser-tab browser-tab-add"/);
  assert.match(rendererSource, /activeTabItem\.scrollIntoView/);
  assert.match(stylesSource, /\.browser-tab \{[\s\S]*?min-width: 160px;[\s\S]*?flex: 0 0 160px;/);
  assert.match(stylesSource, /\.browser-tab-add \{[\s\S]*?width: 34px;[\s\S]*?flex-basis: 34px;/);
  assert.match(stylesSource, /\.tab-close > span \{[\s\S]*?translateY\(-2px\)/);
  assert.match(stylesSource, /\.browser-tab-strip \{[\s\S]*?overflow-x: auto;[\s\S]*?overflow-y: hidden;/);
});

test("explorer menus are Japanese and background creation stays inside the root", () => {
  for (const englishLabel of ["New", "Paste", "Copy", "Cut", "Delete", "Open", "Open in New Tab", "Rename"]) {
    assert.doesNotMatch(rendererSource, new RegExp(`label: ["']${englishLabel}["']`));
  }
  assert.match(rendererSource, /label: "新規作成"/);
  assert.match(rendererSource, /if \(isWithinPath\(targetDir, state\.rootDir\)\)/);
  assert.match(stylesSource, /\.file-list \{[\s\S]*?padding-bottom: max\(120px, 22vh\)/);
});

test("course folder naming and settings reset use creation-specific UI", () => {
  assert.match(rendererSource, /dialogTitle: "コースフォルダを新規作成"/);
  assert.match(rendererSource, /mode === "create" \? "新規作成する" : "変更する"/);
  assert.match(preloadSource, /resetAppSettings: \(\) => ipcRenderer\.invoke\("app:settings:reset"\)/);
  assert.match(mainSource, /ipcMain\.handle\("app:settings:reset"/);
});
