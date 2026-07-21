const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  applyDownloadEvent,
  calculateDownloadPercent,
  createDownloadProgressTracker,
  formatBytes,
  isTerminalDownloadState,
  normalizeDownloadEvent,
  selectVisibleDownloads,
} = require("../src/download-progress");

test("download percent handles known, unknown, and out-of-range byte counts", () => {
  assert.equal(calculateDownloadPercent(25, 100), 25);
  assert.equal(calculateDownloadPercent(150, 100), 100);
  assert.equal(calculateDownloadPercent(-10, 100), 0);
  assert.equal(calculateDownloadPercent(20, 0), null);
});

test("download events normalize indeterminate and paused states", () => {
  assert.deepEqual(normalizeDownloadEvent({
    type: "progress",
    downloadId: "one",
    fileName: "report.pdf",
    receivedBytes: 128,
    totalBytes: 0,
    paused: true,
  }), {
    type: "progress",
    downloadId: "one",
    fileName: "report.pdf",
    receivedBytes: 128,
    totalBytes: 0,
    paused: true,
    percent: null,
    indeterminate: true,
  });
});

test("parallel downloads remain isolated by download id", () => {
  let downloads = applyDownloadEvent(new Map(), {
    type: "started",
    downloadId: "first",
    fileName: "first.zip",
    totalBytes: 100,
  });
  downloads = applyDownloadEvent(downloads, {
    type: "started",
    downloadId: "second",
    fileName: "second.zip",
    totalBytes: 200,
  });
  downloads = applyDownloadEvent(downloads, {
    type: "progress",
    downloadId: "first",
    receivedBytes: 50,
    totalBytes: 100,
  });

  assert.equal(downloads.size, 2);
  assert.equal(downloads.get("first").percent, 50);
  assert.equal(downloads.get("first").fileName, "first.zip");
  assert.equal(downloads.get("second").percent, 0);
  assert.equal(downloads.get("second").fileName, "second.zip");
});

test("terminal download states are recognized and no longer indeterminate", () => {
  for (const state of ["completed", "cancelled", "interrupted"]) {
    assert.equal(isTerminalDownloadState(state), true);
    assert.equal(normalizeDownloadEvent({ type: state, downloadId: state }).indeterminate, false);
  }
  assert.equal(isTerminalDownloadState("progress"), false);
});

test("download byte formatting stays compact", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1024), "1.00 KB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.00 MB");
});

test("download tracker emits state changes, detaches, and finishes only once", () => {
  class MockDownloadItem extends EventEmitter {
    constructor() {
      super();
      this.receivedBytes = 0;
      this.totalBytes = 100;
      this.paused = false;
    }

    getReceivedBytes() { return this.receivedBytes; }
    getTotalBytes() { return this.totalBytes; }
    isPaused() { return this.paused; }
  }

  const item = new MockDownloadItem();
  const events = [];
  const tracker = createDownloadProgressTracker(item, { fileName: "notes.pdf" }, {
    downloadId: "tracker-one",
    emit: (payload) => events.push(payload),
  });

  item.receivedBytes = 40;
  item.emit("updated", {}, "progressing");
  item.emit("updated", {}, "interrupted");
  tracker.finish("interrupted", { message: "network error" });
  tracker.finish("completed");
  item.receivedBytes = 80;
  item.emit("updated", {}, "progressing");

  assert.deepEqual(events.map((event) => [event.type, event.status || ""]), [
    ["started", ""],
    ["progress", "progressing"],
    ["progress", "interrupted"],
    ["interrupted", ""],
  ]);
  assert.equal(events.at(-1).message, "network error");
  assert.equal(item.listenerCount("updated"), 0);
});

test("download list caps visible cards and reports hidden work", () => {
  const downloads = new Map();
  for (let index = 0; index < 40; index += 1) {
    downloads.set(`download-${index}`, { downloadId: `download-${index}` });
  }
  const selection = selectVisibleDownloads(downloads, 5);
  assert.equal(selection.visible.length, 5);
  assert.equal(selection.hiddenCount, 35);
  assert.equal(selection.visible[0].downloadId, "download-0");
});

