const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const indexHtml = fs.readFileSync(path.join(__dirname, "..", "src", "index.html"), "utf8");
const rendererSource = fs.readFileSync(path.join(__dirname, "..", "src", "renderer.js"), "utf8");
const stylesSource = fs.readFileSync(path.join(__dirname, "..", "src", "styles.css"), "utf8");

test("site data reset control exists exactly once inside the settings dialog", () => {
  const settingsStart = indexHtml.indexOf('<dialog id="settings-dialog"');
  const settingsEnd = indexHtml.indexOf("</dialog>", settingsStart);
  const resetControl = 'id="reset-site-data-button"';
  const resetMatches = indexHtml.match(new RegExp(resetControl, "g")) || [];

  assert.notEqual(settingsStart, -1, "settings dialog should exist");
  assert.notEqual(settingsEnd, -1, "settings dialog should be closed");
  assert.equal(resetMatches.length, 1, "reset button should not be duplicated");

  const settingsMarkup = indexHtml.slice(settingsStart, settingsEnd);
  assert.match(settingsMarkup, /id="site-data-reset-select"/);
  assert.match(settingsMarkup, /id="reset-site-data-button"/);
});

test("settings sections are collapsible and include an app settings reset", () => {
  const settingsStart = indexHtml.indexOf('<dialog id="settings-dialog"');
  const settingsEnd = indexHtml.indexOf("</dialog>", settingsStart);
  const settingsMarkup = indexHtml.slice(settingsStart, settingsEnd);
  const disclosureMatches = settingsMarkup.match(/<details class="settings-section settings-disclosure"/g) || [];

  assert.equal(disclosureMatches.length, 7);
  assert.match(settingsMarkup, /<summary class="settings-summary">保存ルート<\/summary>/);
  assert.match(settingsMarkup, /<summary class="settings-summary">キーコンフィグ<\/summary>/);
  assert.match(settingsMarkup, /id="reset-app-settings-button"/);
  assert.match(settingsMarkup, /保存済みファイルとサイトデータは削除しません/);
});

test("right panel display toggle remains available", () => {
  const matches = indexHtml.match(/id="dock-toggle-button"/g) || [];
  assert.equal(matches.length, 1);
  assert.match(indexHtml, /id="dock-toggle-button"[^>]+aria-controls="side-panel"/);
  assert.doesNotMatch(rendererSource, /dockToggleButton\.textContent/);
  assert.match(stylesSource, /\.dock-toggle-button::before/);
  assert.match(stylesSource, /@media \(max-width: 1120px\)[\s\S]*?\.dock-toggle-button,[\s\S]*?position: absolute;[\s\S]*?top: 0;[\s\S]*?left: 0;/);
  assert.match(stylesSource, /@media \(max-width: 1120px\)[\s\S]*?\.side-panel\.hidden \.dock-toggle-button[\s\S]*?bottom: 10px/);
});

test("settings scrolling is contained and keeps the path display stable", () => {
  assert.match(stylesSource, /\.settings-dialog \{[\s\S]*?overflow: hidden/);
  assert.match(stylesSource, /\.settings-form \{[\s\S]*?overflow-y: auto[\s\S]*?overscroll-behavior: contain/);
  assert.match(stylesSource, /\.settings-form > \.dialog-header \{[\s\S]*?position: sticky/);
  assert.match(stylesSource, /\.settings-form \.path-chip \{[\s\S]*?text-overflow: ellipsis[\s\S]*?white-space: nowrap/);
});
