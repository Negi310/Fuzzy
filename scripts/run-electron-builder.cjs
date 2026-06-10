const { existsSync } = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const rootDir = path.resolve(__dirname, "..");
const cliPath = path.join(rootDir, "node_modules", "electron-builder", "cli.js");
const args = process.argv.slice(2);

if (!existsSync(cliPath)) {
  console.error(`Unable to find electron-builder CLI at ${cliPath}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, [cliPath, ...args], {
  cwd: rootDir,
  stdio: "inherit",
  shell: false,
});

if (result.error) {
  console.error(result.error.message);
  process.exit(result.status ?? 1);
}

process.exit(result.status ?? 0);
