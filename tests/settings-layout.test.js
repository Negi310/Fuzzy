const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const indexHtml = fs.readFileSync(path.join(__dirname, "..", "src", "index.html"), "utf8");

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

