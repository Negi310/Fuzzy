(function initializeDownloadProgressApi() {
  const TERMINAL_STATES = new Set(["completed", "cancelled", "interrupted"]);

  function toNonNegativeNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, number) : 0;
  }

  function calculateDownloadPercent(receivedBytes, totalBytes) {
    const received = toNonNegativeNumber(receivedBytes);
    const total = toNonNegativeNumber(totalBytes);
    if (total <= 0) {
      return null;
    }
    return Math.min(100, Math.max(0, (received / total) * 100));
  }

  function isTerminalDownloadState(type) {
    return TERMINAL_STATES.has(String(type || ""));
  }

  function readItemBytes(item, methodName) {
    return toNonNegativeNumber(item?.[methodName]?.());
  }

  function createDownloadProgressTracker(item, metadata = {}, options = {}) {
    const downloadId = String(options.downloadId || "");
    if (!downloadId) {
      throw new Error("downloadId is required");
    }
    if (typeof options.emit !== "function") {
      throw new Error("download event emitter is required");
    }

    let finished = false;
    let previousSignature = "";
    const emit = (type, extra = {}, force = false) => {
      const receivedBytes = readItemBytes(item, "getReceivedBytes");
      const totalBytes = readItemBytes(item, "getTotalBytes");
      const paused = Boolean(item?.isPaused?.());
      const status = String(extra.status || "");
      const signature = `${type}:${status}:${receivedBytes}:${totalBytes}:${paused}`;
      if (!force && signature === previousSignature) {
        return;
      }
      previousSignature = signature;
      options.emit({
        ...metadata,
        ...extra,
        type,
        downloadId,
        receivedBytes,
        totalBytes,
        percent: calculateDownloadPercent(receivedBytes, totalBytes),
        paused,
      });
    };

    const onUpdated = (_event, downloadState) => {
      emit("progress", { status: downloadState });
    };

    item.on("updated", onUpdated);
    emit("started", {}, true);

    return {
      downloadId,
      finish(type, extra = {}) {
        if (finished) {
          return;
        }
        finished = true;
        item.removeListener("updated", onUpdated);
        emit(type, extra, true);
      },
    };
  }

  function normalizeDownloadEvent(payload = {}) {
    const type = String(payload.type || "progress");
    const receivedBytes = toNonNegativeNumber(payload.receivedBytes);
    const totalBytes = toNonNegativeNumber(payload.totalBytes);
    return {
      ...payload,
      type,
      status: String(payload.status || ""),
      downloadId: String(payload.downloadId || ""),
      fileName: payload.fileName == null ? "" : String(payload.fileName),
      receivedBytes,
      totalBytes,
      percent: calculateDownloadPercent(receivedBytes, totalBytes),
      indeterminate: totalBytes <= 0 && !isTerminalDownloadState(type),
      paused: Boolean(payload.paused),
    };
  }

  function applyDownloadEvent(downloads, payload) {
    const next = new Map(downloads || []);
    const normalized = normalizeDownloadEvent(payload);
    if (!normalized.downloadId) {
      return next;
    }
    const previous = next.get(normalized.downloadId) || {};
    next.set(normalized.downloadId, {
      ...previous,
      ...normalized,
      fileName: normalized.fileName || previous.fileName || "download",
    });
    return next;
  }

  function selectVisibleDownloads(downloads, limit = 5) {
    const entries = Array.from(downloads?.values?.() || downloads || []);
    const safeLimit = Math.max(1, Math.floor(Number(limit) || 1));
    return {
      visible: entries.slice(0, safeLimit),
      hiddenCount: Math.max(0, entries.length - safeLimit),
    };
  }

  function formatBytes(bytes) {
    const value = toNonNegativeNumber(bytes);
    if (value < 1024) {
      return `${Math.round(value)} B`;
    }
    const units = ["KB", "MB", "GB", "TB"];
    let size = value / 1024;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex += 1;
    }
    const digits = size >= 100 ? 0 : size >= 10 ? 1 : 2;
    return `${size.toFixed(digits)} ${units[unitIndex]}`;
  }

  const downloadProgressApi = {
    applyDownloadEvent,
    calculateDownloadPercent,
    createDownloadProgressTracker,
    formatBytes,
    isTerminalDownloadState,
    normalizeDownloadEvent,
    selectVisibleDownloads,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = downloadProgressApi;
  }

  if (typeof window !== "undefined") {
    window.FuzitterDownloadProgress = downloadProgressApi;
  }
})();

