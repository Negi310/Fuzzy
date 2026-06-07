const fs = require("node:fs");
const { execFileSync, spawn } = require("node:child_process");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { app, BrowserWindow, dialog, ipcMain, nativeImage, session, shell, webContents } = require("electron");
const { autoUpdater } = require("electron-updater");

const { rankCandidates } = require("./similarity");
const { Store } = require("./store");

const APP_NAME = "Fuzitter";
const WAKAYAMA_MOODLE_HOME = "https://moodle2026.wakayama-u.ac.jp/2026/";
const FUZITTER_PARTITION = "persist:fuzitter";
const LEGACY_ROOT_DIR_NAME = "Fuzzy";
const ROOT_DIR_NAME = "Fuzitter";
const BUILD_OUTPUT_DIR_NAME = "Fuzitter-win32-x64";
const LEGACY_STORE_FILE_NAME = "fuzzy-store.json";
const STORE_FILE_NAME = "fuzitter-store.json";
const ALLOWED_HOST_PATTERNS = [
  /^moodle(?:\d{4})?\.wakayama-u\.ac\.jp$/i,
  /^wakayama-u\.ac\.jp$/i,
  /^www\.wakayama-u\.ac\.jp$/i,
  /^gemini\.google\.com$/i,
  /^notebooklm\.google\.com$/i,
  /^accounts\.google\.com$/i,
  /^login\.microsoftonline\.com$/i,
  /^sts\.windows\.net$/i,
  /^aadcdn\.msauth\.net$/i,
  /^aadcdn\.msftauth\.net$/i,
  /^account\.activedirectory\.windowsazure\.com$/i,
];

let mainWindow = null;
let store = null;
let fuzzySession = null;
let isQuittingAfterSessionFlush = false;
const tabRegistry = new Map();
const webContentsToTab = new Map();
const customDownloadQueues = new Map();
const updateState = {
  enabled: false,
  checking: false,
  downloaded: false,
  available: false,
  currentVersion: app.getVersion(),
  message: "",
  releaseName: "",
};
const STARTUP_UPDATE_DOWNLOAD_TIMEOUT_MS = 3 * 60 * 1000;
const updateLogFilePath = () => path.join(app.getPath("userData"), "updater.log");
let isStartupUpdateGateRunning = false;

function writeUpdateLog(message, details = null) {
  try {
    const timestamp = new Date().toISOString();
    const serializedDetails = details == null
      ? ""
      : ` ${typeof details === "string" ? details : JSON.stringify(details)}`;
    fs.appendFileSync(updateLogFilePath(), `[${timestamp}] ${message}${serializedDetails}\n`, "utf8");
  } catch (_error) {
    // Ignore logging failures so update flow remains unaffected.
  }
}

process.on("uncaughtException", (error) => {
  if (error?.code === "EPIPE") {
    return;
  }
  throw error;
});

function getAutoUpdateStatus() {
  return {
    enabled: updateState.enabled,
    checking: updateState.checking,
    downloaded: updateState.downloaded,
    available: updateState.available,
    currentVersion: updateState.currentVersion,
    message: updateState.message,
    releaseName: updateState.releaseName,
  };
}

function emitAutoUpdateEvent(payload = {}) {
  sendToRenderer("app:update:event", {
    ...getAutoUpdateStatus(),
    ...payload,
  });
}

function canUseAutoUpdater() {
  if (process.platform !== "win32" || !app.isPackaged) {
    return false;
  }

  const normalizedExecPath = path.resolve(process.execPath);
  return !(
    normalizedExecPath.includes(`${path.sep}local-dist${path.sep}`) ||
    normalizedExecPath.includes(`${path.sep}dist${path.sep}`)
  );
}

async function triggerAutoUpdateCheck(source = "startup") {
  writeUpdateLog("triggerAutoUpdateCheck called", {
    source,
    enabled: updateState.enabled,
    checking: updateState.checking,
    currentVersion: updateState.currentVersion,
  });

  if (!updateState.enabled) {
    updateState.message = "自動更新はインストール版でのみ利用できます。";
    emitAutoUpdateEvent({
      type: "disabled",
      source,
      message: updateState.message,
    });
    return getAutoUpdateStatus();
  }

  if (updateState.checking) {
    return getAutoUpdateStatus();
  }

  updateState.checking = true;
  updateState.message = "更新を確認しています...";
  emitAutoUpdateEvent({
    type: "checking-for-update",
    source,
    message: updateState.message,
  });

  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    writeUpdateLog("checkForUpdates failed", error?.stack || error?.message || String(error));
    updateState.checking = false;
    updateState.message = error.message || "更新の確認に失敗しました。";
    emitAutoUpdateEvent({
      type: "error",
      source,
      message: updateState.message,
    });
  }

  return getAutoUpdateStatus();
}

function withTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timerId = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    Promise.resolve(promise)
      .then((value) => {
        clearTimeout(timerId);
        resolve({ timedOut: false, value });
      })
      .catch((error) => {
        clearTimeout(timerId);
        reject(error);
      });
  });
}

function installDownloadedUpdate(reason = "manual") {
  writeUpdateLog("quitAndInstall requested", { reason });
  setImmediate(() => {
    // Use silent NSIS install so startup updates can finish before the first
    // window appears, then relaunch the app once the new version is installed.
    autoUpdater.quitAndInstall(true, true);
  });
}

async function runStartupUpdateGate() {
  isStartupUpdateGateRunning = true;
  if (!updateState.enabled) {
    writeUpdateLog("startup update gate skipped", "updater disabled");
    isStartupUpdateGateRunning = false;
    return true;
  }

  writeUpdateLog("startup update gate begin", {
    version: updateState.currentVersion,
  });

  try {
    const result = await autoUpdater.checkForUpdates();
    const downloadPromise = result?.downloadPromise;
    const hasDownloadPromise = downloadPromise && typeof downloadPromise.then === "function";

    if (!hasDownloadPromise) {
      writeUpdateLog("startup update gate outcome", { outcome: "no-update" });
      return true;
    }

    writeUpdateLog("startup update gate waiting for download", {
      version: result?.updateInfo?.version || "",
      releaseName: result?.updateInfo?.releaseName || "",
    });

    const downloadResult = await withTimeout(downloadPromise, STARTUP_UPDATE_DOWNLOAD_TIMEOUT_MS);
    if (downloadResult.timedOut) {
      writeUpdateLog("startup update gate outcome", { outcome: "timeout" });
      return true;
    }

    updateState.downloaded = true;
    updateState.message = "更新を適用するため再起動します。";
    writeUpdateLog("startup update gate outcome", {
      outcome: "downloaded",
      version: result?.updateInfo?.version || "",
      releaseName: result?.updateInfo?.releaseName || "",
    });
    installDownloadedUpdate("startup-gate");
    return false;
  } catch (error) {
    writeUpdateLog("startup update gate outcome", {
      outcome: "error",
      message: error?.message || String(error),
    });
    updateState.checking = false;
    updateState.message = error?.message || "更新の確認に失敗しました。";
    return true;
  } finally {
    isStartupUpdateGateRunning = false;
  }
}

function setupAutoUpdater() {
  updateState.enabled = canUseAutoUpdater();
  updateState.currentVersion = app.getVersion();
  writeUpdateLog("setupAutoUpdater", {
    enabled: updateState.enabled,
    version: updateState.currentVersion,
    execPath: process.execPath,
  });

  if (!updateState.enabled) {
    updateState.message = "自動更新はインストール版でのみ利用できます。";
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // Prefer Atom feed resolution over /releases/latest because the latter has
  // been intermittently timing out for public GitHub releases in production.
  autoUpdater.allowPrerelease = true;

  autoUpdater.on("checking-for-update", () => {
    writeUpdateLog("autoUpdater event", "checking-for-update");
    updateState.checking = true;
    updateState.message = "更新を確認しています...";
    emitAutoUpdateEvent({
      type: "checking-for-update",
      message: updateState.message,
    });
  });

  autoUpdater.on("update-available", (info) => {
    writeUpdateLog("autoUpdater event", {
      type: "update-available",
      version: info?.version,
      releaseName: info?.releaseName,
    });
    updateState.checking = false;
    updateState.available = true;
    updateState.downloaded = false;
    updateState.releaseName = info?.version || info?.releaseName || "";
    updateState.message = `新しい更新 ${updateState.releaseName || ""} をダウンロードしています...`.trim();
    emitAutoUpdateEvent({
      type: "update-available",
      message: updateState.message,
      releaseName: updateState.releaseName,
    });
  });

  autoUpdater.on("update-not-available", () => {
    writeUpdateLog("autoUpdater event", "update-not-available");
    updateState.checking = false;
    updateState.available = false;
    updateState.downloaded = false;
    updateState.releaseName = "";
    updateState.message = `現在のバージョン ${app.getVersion()} は最新です。`;
    emitAutoUpdateEvent({
      type: "update-not-available",
      message: updateState.message,
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    writeUpdateLog("autoUpdater event", {
      type: "download-progress",
      percent: progress.percent || 0,
      transferred: progress.transferred || 0,
      total: progress.total || 0,
    });
    updateState.available = true;
    updateState.checking = false;
    updateState.message = `更新をダウンロード中: ${Math.round(progress.percent || 0)}%`;
    emitAutoUpdateEvent({
      type: "download-progress",
      message: updateState.message,
      progress: progress.percent || 0,
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    writeUpdateLog("autoUpdater event", {
      type: "update-downloaded",
      version: info?.version,
      releaseName: info?.releaseName,
    });
    updateState.checking = false;
    updateState.available = true;
    updateState.downloaded = true;
    updateState.releaseName = info?.version || info?.releaseName || updateState.releaseName;
    updateState.message = "更新のダウンロードが完了しました。再起動で適用できます。";
    emitAutoUpdateEvent({
      type: "update-downloaded",
      message: updateState.message,
      releaseName: updateState.releaseName,
    });
  });

  autoUpdater.on("error", (error) => {
    writeUpdateLog("autoUpdater event", {
      type: "error",
      message: error?.message || "",
      stack: error?.stack || "",
    });
    updateState.checking = false;
    updateState.message = error?.message || "更新中にエラーが発生しました。";
    emitAutoUpdateEvent({
      type: "error",
      message: updateState.message,
    });
  });
}

function isAllowedUrl(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    if (!["https:", "http:"].includes(parsed.protocol)) {
      return false;
    }
    return ALLOWED_HOST_PATTERNS.some((pattern) => pattern.test(parsed.hostname));
  } catch (_error) {
    return false;
  }
}

function isPdfUrl(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    return parsed.pathname.toLowerCase().endsWith(".pdf");
  } catch (_error) {
    return false;
  }
}

function isDownloadLikeUrl(targetUrl) {
  return (
    /\.(pdf|docx?|pptx?|xlsx?|zip)(\?|$)/i.test(targetUrl) ||
    /mod\/resource\/view\.php/i.test(targetUrl) ||
    /pluginfile\.php/i.test(targetUrl)
  );
}

function inferFileNameFromUrl(targetUrl) {
  try {
    const parsed = new URL(targetUrl || "");
    const fileName = decodeURIComponent(parsed.pathname.split("/").at(-1) || "");
    return fileName || "";
  } catch (_error) {
    return "";
  }
}

function extensionFromMimeType(mimeType) {
  const normalized = String(mimeType || "").split(";")[0].trim().toLowerCase();
  const extensionMap = {
    "application/pdf": ".pdf",
    "application/zip": ".zip",
    "application/msword": ".doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.ms-powerpoint": ".ppt",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
    "application/vnd.ms-excel": ".xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "text/plain": ".txt",
  };
  return extensionMap[normalized] || "";
}

function shouldReplacePlaceholderFileName(fileName) {
  const normalized = String(fileName || "").trim().toLowerCase();
  return !normalized || ["download", "view.php", "view.htm", "view.html"].includes(normalized);
}

function parseContentDispositionFileName(headerValue) {
  const value = String(headerValue || "");
  const utf8Match = value.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (utf8Match) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch (_error) {
      return utf8Match[1];
    }
  }

  const simpleMatch = value.match(/filename\s*=\s*"([^"]+)"/i) || value.match(/filename\s*=\s*([^;]+)/i);
  if (!simpleMatch) {
    return "";
  }

  const rawValue = simpleMatch[1].trim();
  try {
    const latin1AsUtf8 = Buffer.from(rawValue, "latin1").toString("utf8");
    if (!latin1AsUtf8.includes("\uFFFD")) {
      return latin1AsUtf8;
    }
  } catch (_error) {
    // Fall back to the raw header value.
  }
  return rawValue;
}

function extractEmbeddedDownloadUrl(html, baseUrl) {
  const patterns = [
    /https?:\/\/[^"'\\\s>]+pluginfile\.php[^"'\\\s>]*/i,
    /\/2026\/pluginfile\.php[^"'\\\s>]*/i,
    /content\s*=\s*["'][^"']*url=([^"']+)["']/i,
    /location\.href\s*=\s*["']([^"']+)["']/i,
    /window\.location\s*=\s*["']([^"']+)["']/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (!match) {
      continue;
    }
    const candidate = match[1] || match[0];
    try {
      return new URL(candidate, baseUrl).toString();
    } catch (_error) {
      continue;
    }
  }

  return "";
}

function canPreviewRemoteFile(targetUrl, mimeType = "") {
  return (
    /\.pdf(\?|$)/i.test(targetUrl) ||
    /^application\/pdf\b/i.test(mimeType) ||
    /^text\//i.test(mimeType) ||
    /^image\//i.test(mimeType)
  );
}

function buildPreviewDir() {
  const previewDir = path.join(app.getPath("userData"), "preview-cache");
  ensureDirectory(previewDir);
  return previewDir;
}

function isPreviewCachePath(targetPath) {
  const previewDir = buildPreviewDir();
  const resolvedTargetPath = path.resolve(String(targetPath || ""));
  return isSubPath(previewDir, resolvedTargetPath);
}

function normalizeResolvedFileName(fileName, sourceUrl = "", mimeType = "") {
  const fallbackName = sanitizeFileName(fileName || inferFileNameFromUrl(sourceUrl) || "download");
  const parsed = path.parse(fallbackName);
  if (parsed.ext) {
    return fallbackName;
  }

  const inferredExtension = extensionFromMimeType(mimeType);
  if (!inferredExtension) {
    return fallbackName;
  }

  return sanitizeFileName(`${fallbackName}${inferredExtension}`);
}

async function resolveRemoteFileDetails(targetUrl, depth = 0) {
  const fallback = {
    resolvedUrl: targetUrl,
    fileName: normalizeResolvedFileName(inferFileNameFromUrl(targetUrl) || "download", targetUrl, ""),
    mimeType: "",
    canPreview: isDownloadLikeUrl(targetUrl),
    sourceKind: "url-only",
  };

  if (!fuzzySession || !targetUrl || depth > 2) {
    return fallback;
  }

  try {
    const cookies = await fuzzySession.cookies.get({ url: targetUrl });
    const cookieHeader = cookies
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
    const requestUrl = new URL(targetUrl);
    const transport = requestUrl.protocol === "http:" ? http : https;

    const response = await new Promise((resolve, reject) => {
      const request = transport.request({
        protocol: requestUrl.protocol,
        hostname: requestUrl.hostname,
        port: requestUrl.port || undefined,
        path: `${requestUrl.pathname}${requestUrl.search}`,
        method: "GET",
        headers: cookieHeader ? { Cookie: cookieHeader } : {},
      }, (incoming) => {
        resolve(incoming);
      });

      request.on("error", reject);
      request.end();
    });

    const statusCode = response.statusCode || 0;
    const locationHeader = Array.isArray(response.headers.location)
      ? response.headers.location[0]
      : response.headers.location || "";
    if (statusCode >= 300 && statusCode < 400 && locationHeader) {
      const redirectUrl = new URL(locationHeader, targetUrl).toString();
      response.resume();
      return resolveRemoteFileDetails(redirectUrl, depth + 1);
    }

    const resolvedUrl = targetUrl;
    const mimeType = Array.isArray(response.headers["content-type"])
      ? response.headers["content-type"][0]
      : response.headers["content-type"] || "";
    const disposition = Array.isArray(response.headers["content-disposition"])
      ? response.headers["content-disposition"][0]
      : response.headers["content-disposition"] || "";

    let html = "";
    if (/^text\/html\b/i.test(mimeType)) {
      html = await new Promise((resolve, reject) => {
        const chunks = [];
        let totalLength = 0;

        response.on("data", (chunk) => {
          totalLength += chunk.length;
          if (totalLength <= 1024 * 1024) {
            chunks.push(chunk);
          }
        });
        response.on("end", () => {
          resolve(Buffer.concat(chunks).toString("utf8"));
        });
        response.on("error", reject);
      });
      const embeddedUrl = extractEmbeddedDownloadUrl(html, resolvedUrl);
      if (embeddedUrl && embeddedUrl !== targetUrl) {
        return resolveRemoteFileDetails(embeddedUrl, depth + 1);
      }
    } else {
      response.resume();
    }

    const headerFileName = parseContentDispositionFileName(disposition);
    const fileName = normalizeResolvedFileName(
      headerFileName || inferFileNameFromUrl(resolvedUrl) || inferFileNameFromUrl(targetUrl) || "download",
      resolvedUrl,
      mimeType,
    );

    return {
      resolvedUrl,
      fileName,
      mimeType,
      canPreview: canPreviewRemoteFile(resolvedUrl, mimeType),
      sourceKind: headerFileName ? "content-disposition" : /^text\/html\b/i.test(mimeType) ? "html-redirect" : "direct-response",
    };
  } catch (_error) {
    return fallback;
  }
}

function sanitizeFolderName(name) {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "Unsorted";
}

function normalizeCourseFolderName(name) {
  return String(name || "")
    .replace(/^\s*コース\s*[:：]\s*/iu, "")
    .replace(/\s*[|｜]\s*【\s*和歌山大学\s*】\s*$/u, "")
    .replace(/\s+/g, " ")
    .replace(/\s*[|:-]\s*Wakayama.*Moodle.*$/i, "")
    .replace(/\s*[|｜:-]\s*和歌山大学.*Moodle.*$/u, "")
    .replace(/\s*Moodle\d*\s*$/i, "")
    .trim();
}

function normalizeCourseFolderName(name) {
  return String(name || "")
    .replace(/^\s*\u30b3\u30fc\u30b9\s*[:\uFF1A]\s*/u, "")
    .replace(/\s*(?:(?:\||\uFF5C)\s*)?\u3010\u548c\u6b4c\u5c71\u5927\u5b66\u3011\s*$/u, "")
    .replace(/\s+/g, " ")
    .replace(/\s*[|:-]\s*Wakayama.*Moodle.*$/i, "")
    .replace(/\s*[|\uFF5C:\-]\s*\u548c\u6b4c\u5c71\u5927\u5b66.*Moodle.*$/u, "")
    .replace(/\s*Moodle\d*\s*$/i, "")
    .trim();
}

function sanitizeFileName(name) {
  const parsed = path.parse(name || "download");
  const base = `${parsed.name || "download"}${parsed.ext || ""}`
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return base || "download";
}

function isSubPath(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function uniqueFilePath(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return targetPath;
  }

  const parsed = path.parse(targetPath);
  let index = 1;
  while (true) {
    const candidate = path.join(parsed.dir, `${parsed.name} (${index})${parsed.ext}`);
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
    index += 1;
  }
}

function buildDuplicatePath(targetPath) {
  const parsed = path.parse(targetPath);
  let index = 1;
  while (true) {
    const suffix = index === 1 ? " - Copy" : ` - Copy (${index})`;
    const candidate = path.join(parsed.dir, `${parsed.name}${suffix}${parsed.ext}`);
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
    index += 1;
  }
}

function getDefaultRootDir() {
  return path.join(app.getPath("downloads"), ROOT_DIR_NAME);
}

function getStoreFilePath() {
  return path.join(app.getPath("userData"), STORE_FILE_NAME);
}

function cloneStoreState(state = {}) {
  return {
    rootDir: state.rootDir || "",
    mappings: Array.isArray(state.mappings) ? state.mappings.map((entry) => ({ ...entry })) : [],
    downloadHistory: Array.isArray(state.downloadHistory) ? state.downloadHistory.map((entry) => ({ ...entry })) : [],
    preferences: state.preferences && typeof state.preferences === "object"
      ? { ...state.preferences }
      : { dashboardAutoload: false },
  };
}

function scoreStoreState(state = {}) {
  return (
    (Array.isArray(state.mappings) ? state.mappings.length : 0) * 100 +
    (Array.isArray(state.downloadHistory) ? state.downloadHistory.length : 0) * 2 +
    (state.rootDir ? 20 : 0)
  );
}

function replacePathPrefix(targetPath, fromPrefix, toPrefix) {
  if (!targetPath || !fromPrefix || !toPrefix) {
    return targetPath || "";
  }
  const normalizedTarget = path.resolve(targetPath);
  const normalizedFrom = path.resolve(fromPrefix);
  if (!isSubPath(normalizedFrom, normalizedTarget)) {
    return targetPath;
  }
  const relativePath = path.relative(normalizedFrom, normalizedTarget);
  return path.join(toPrefix, relativePath);
}

function normalizeMoodleHomeUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) {
    return WAKAYAMA_MOODLE_HOME;
  }

  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const parsed = new URL(candidate);
  if (!/^moodle(?:\d{4})?\.wakayama-u\.ac\.jp$/i.test(parsed.hostname)) {
    throw new Error("Moodle URL must use a wakayama-u.ac.jp Moodle host.");
  }

  parsed.hash = "";
  if (!parsed.pathname.endsWith("/")) {
    parsed.pathname = `${parsed.pathname}/`;
  }
  return parsed.toString();
}

function getWorkspaceRoots() {
  return [process.cwd(), app.getAppPath()]
    .map((root) => path.resolve(root || ""))
    .filter((root, index, array) => root && array.indexOf(root) === index);
}

function resolveLocalBuildMirrorPath(targetPath) {
  const resolvedTargetPath = path.resolve(String(targetPath || ""));
  for (const workspaceRoot of getWorkspaceRoots()) {
    const distRoot = path.join(workspaceRoot, "dist", BUILD_OUTPUT_DIR_NAME);
    const localDistRoot = path.join(workspaceRoot, "local-dist", BUILD_OUTPUT_DIR_NAME);
    if (!fs.existsSync(localDistRoot) || !isSubPath(distRoot, resolvedTargetPath)) {
      continue;
    }

    const relativePath = path.relative(distRoot, resolvedTargetPath);
    const mirroredPath = path.join(localDistRoot, relativePath);
    if (fs.existsSync(mirroredPath)) {
      return mirroredPath;
    }
  }

  return resolvedTargetPath;
}

function isBuildOutputPath(targetPath) {
  const resolvedTargetPath = path.resolve(String(targetPath || ""));
  return getWorkspaceRoots().some((workspaceRoot) => {
    const distRoot = path.join(workspaceRoot, "dist", BUILD_OUTPUT_DIR_NAME);
    const localDistRoot = path.join(workspaceRoot, "local-dist", BUILD_OUTPUT_DIR_NAME);
    return isSubPath(distRoot, resolvedTargetPath) || isSubPath(localDistRoot, resolvedTargetPath);
  });
}

function isAllowedExplorerTargetPath(targetPath) {
  const resolvedTargetPath = path.resolve(String(targetPath || ""));
  return isSubPath(getRootDir(), resolvedTargetPath) || isBuildOutputPath(resolvedTargetPath);
}

function updateStorePaths(state, fromRootDir, toRootDir) {
  const nextState = cloneStoreState(state);
  if (nextState.rootDir) {
    nextState.rootDir = replacePathPrefix(nextState.rootDir, fromRootDir, toRootDir);
  }
  nextState.mappings = nextState.mappings.map((entry) => ({
    ...entry,
    folderPath: replacePathPrefix(entry.folderPath, fromRootDir, toRootDir),
    submissionFolderPath: replacePathPrefix(entry.submissionFolderPath, fromRootDir, toRootDir),
  }));
  nextState.downloadHistory = nextState.downloadHistory.map((entry) => ({
    ...entry,
    filePath: replacePathPrefix(entry.filePath, fromRootDir, toRootDir),
  }));
  return nextState;
}

function getLegacyUserDataDirs() {
  return [
    path.join(app.getPath("appData"), "fuzzy"),
    path.join(app.getPath("appData"), LEGACY_ROOT_DIR_NAME),
  ].filter((value, index, array) => array.indexOf(value) === index);
}

function getStoreCandidatePaths() {
  const preferredUserDataDir = app.getPath("userData");
  const preferredStorePath = path.join(preferredUserDataDir, STORE_FILE_NAME);
  const legacyPaths = [
    path.join(preferredUserDataDir, LEGACY_STORE_FILE_NAME),
    ...getLegacyUserDataDirs().flatMap((dirPath) => [
      path.join(dirPath, STORE_FILE_NAME),
      path.join(dirPath, LEGACY_STORE_FILE_NAME),
    ]),
  ];
  return [preferredStorePath, ...legacyPaths]
    .filter((value, index, array) => array.indexOf(value) === index);
}

function loadStoreSnapshot(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      filePath,
      state: cloneStoreState(parsed),
    };
  } catch (_error) {
    return null;
  }
}

function selectBestStoreSnapshot(snapshots = []) {
  const available = snapshots.filter(Boolean);
  if (!available.length) {
    return null;
  }

  return available.sort((left, right) => (
    scoreStoreState(right.state) - scoreStoreState(left.state)
  ))[0];
}

function migrateLegacyStateToFuzitter() {
  const preferredRootDir = path.join(app.getPath("downloads"), ROOT_DIR_NAME);
  const legacyRootDir = path.join(app.getPath("downloads"), LEGACY_ROOT_DIR_NAME);
  let activeRootDir = preferredRootDir;
  let migratedLegacyRoot = false;

  if (!fs.existsSync(preferredRootDir) && fs.existsSync(legacyRootDir)) {
    try {
      fs.renameSync(legacyRootDir, preferredRootDir);
      migratedLegacyRoot = true;
    } catch (_error) {
      // Keep using the legacy downloads folder when Windows blocks the rename.
      activeRootDir = legacyRootDir;
    }
  } else if (fs.existsSync(legacyRootDir) && !fs.existsSync(preferredRootDir)) {
    activeRootDir = legacyRootDir;
  }

  const preferredStorePath = getStoreFilePath();
  const snapshots = getStoreCandidatePaths()
    .map((candidatePath) => loadStoreSnapshot(candidatePath));
  const bestSnapshot = selectBestStoreSnapshot(snapshots);

  const nextState = bestSnapshot
    ? migratedLegacyRoot
      ? updateStorePaths(bestSnapshot.state, legacyRootDir, preferredRootDir)
      : cloneStoreState(bestSnapshot.state)
    : cloneStoreState();

  if (!nextState.rootDir) {
    nextState.rootDir = activeRootDir;
  } else {
    nextState.rootDir = migratedLegacyRoot
      ? replacePathPrefix(nextState.rootDir, legacyRootDir, preferredRootDir)
      : replacePathPrefix(nextState.rootDir, preferredRootDir, activeRootDir);
  }

  ensureDirectory(path.dirname(preferredStorePath));
  fs.writeFileSync(preferredStorePath, JSON.stringify(nextState, null, 2), "utf8");

  const currentLegacyStorePath = path.join(app.getPath("userData"), LEGACY_STORE_FILE_NAME);
  if (currentLegacyStorePath !== preferredStorePath && fs.existsSync(currentLegacyStorePath)) {
    fs.rmSync(currentLegacyStorePath, { force: true });
  }
}

function buildUniqueNamedPath(parentPath, baseName, extension = "") {
  const safeBaseName = sanitizeFileName(baseName).replace(/\.[^.]+$/, "") || "New File";
  const safeExtension = extension || "";
  let index = 0;
  while (true) {
    const suffix = index === 0 ? "" : ` (${index})`;
    const candidate = path.join(parentPath, `${safeBaseName}${suffix}${safeExtension}`);
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
    index += 1;
  }
}

function quoteForPowerShell(value) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

function fileExists(targetPath) {
  return Boolean(targetPath && fs.existsSync(targetPath));
}

function resolveProgramPath(programKey) {
  const localAppData = process.env.LOCALAPPDATA || "";
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const commonCandidates = {
    word: [
      path.join(programFiles, "Microsoft Office", "Root", "Office16", "WINWORD.EXE"),
      path.join(programFilesX86, "Microsoft Office", "Root", "Office16", "WINWORD.EXE"),
    ],
    excel: [
      path.join(programFiles, "Microsoft Office", "Root", "Office16", "EXCEL.EXE"),
      path.join(programFilesX86, "Microsoft Office", "Root", "Office16", "EXCEL.EXE"),
    ],
    powerpoint: [
      path.join(programFiles, "Microsoft Office", "Root", "Office16", "POWERPNT.EXE"),
      path.join(programFilesX86, "Microsoft Office", "Root", "Office16", "POWERPNT.EXE"),
    ],
    vscode: [
      path.join(localAppData, "Programs", "Microsoft VS Code", "Code.exe"),
      path.join(programFiles, "Microsoft VS Code", "Code.exe"),
      path.join(programFilesX86, "Microsoft VS Code", "Code.exe"),
    ],
  };

  return commonCandidates[programKey]?.find(fileExists) || "";
}

function launchProgram(programPath, args) {
  const child = spawn(programPath, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

function createOfficeDocumentWithPowerShell(targetPath, officeType) {
  const quotedPath = quoteForPowerShell(targetPath);
  const scripts = {
    word: `
$ErrorActionPreference = 'Stop'
$path = ${quotedPath}
$word = $null
$document = $null
try {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $document = $word.Documents.Add()
  $document.SaveAs([ref]$path, [ref]16)
} finally {
  if ($document) { $document.Close() }
  if ($word) { $word.Quit() }
}
`,
    excel: `
$ErrorActionPreference = 'Stop'
$path = ${quotedPath}
$excel = $null
$workbook = $null
try {
  $excel = New-Object -ComObject Excel.Application
  $excel.Visible = $false
  $workbook = $excel.Workbooks.Add()
  $workbook.SaveAs($path, 51)
} finally {
  if ($workbook) { $workbook.Close($false) }
  if ($excel) { $excel.Quit() }
}
`,
    powerpoint: `
$ErrorActionPreference = 'Stop'
$path = ${quotedPath}
$powerpoint = $null
$presentation = $null
try {
  $powerpoint = New-Object -ComObject PowerPoint.Application
  $presentation = $powerpoint.Presentations.Add()
  $presentation.SaveAs($path, 24)
} finally {
  if ($presentation) { $presentation.Close() }
  if ($powerpoint) { $powerpoint.Quit() }
}
`,
  };

  const script = scripts[officeType];
  if (!script) {
    throw new Error("Unsupported Office document type.");
  }

  execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
  });
}

function createExplorerEntry(parentPath, entryKind) {
  const rootDir = getRootDir();
  if (!parentPath || !isSubPath(rootDir, parentPath) || !fs.existsSync(parentPath) || !fs.statSync(parentPath).isDirectory()) {
    throw new Error("Target folder is not available.");
  }

  const kind = String(entryKind || "").toLowerCase();
  if (kind === "folder") {
    const targetPath = buildUniqueNamedPath(parentPath, "New Folder");
    fs.mkdirSync(targetPath);
    return { path: targetPath, name: path.basename(targetPath), kind };
  }

  if (kind === "text") {
    const targetPath = buildUniqueNamedPath(parentPath, "New Text Document", ".txt");
    fs.writeFileSync(targetPath, "", "utf8");
    return { path: targetPath, name: path.basename(targetPath), kind };
  }

  const officeKinds = {
    word: { extension: ".docx" },
    excel: { extension: ".xlsx" },
    powerpoint: { extension: ".pptx" },
  };
  const officeEntry = officeKinds[kind];
  if (!officeEntry) {
    throw new Error("Unsupported explorer item type.");
  }

  if (!resolveProgramPath(kind)) {
    throw new Error(`${kind} is not installed on this PC.`);
  }

  const targetPath = buildUniqueNamedPath(parentPath, `New ${kind[0].toUpperCase()}${kind.slice(1)} Document`, officeEntry.extension);
  createOfficeDocumentWithPowerShell(targetPath, kind);
  return { path: targetPath, name: path.basename(targetPath), kind };
}

function openExplorerEntryWithProgram(targetPath, programKey) {
  const resolvedTargetPath = resolveLocalBuildMirrorPath(targetPath);
  if (!resolvedTargetPath || !isAllowedExplorerTargetPath(resolvedTargetPath) || !fs.existsSync(resolvedTargetPath)) {
    throw new Error("Target file is not available.");
  }

  const programPath = resolveProgramPath(programKey);
  if (!programPath) {
    throw new Error(`${programKey} is not installed on this PC.`);
  }

  launchProgram(programPath, [resolvedTargetPath]);
  return { ok: true, programPath };
}

function openExplorerExecutable(targetPath) {
  const resolvedTargetPath = resolveLocalBuildMirrorPath(targetPath);
  if (!resolvedTargetPath || !isAllowedExplorerTargetPath(resolvedTargetPath) || !fs.existsSync(resolvedTargetPath)) {
    throw new Error("Target executable is not available.");
  }

  launchProgram(resolvedTargetPath, []);
  return { ok: true, path: resolvedTargetPath };
}

function getRootDir() {
  const state = store.getState();
  return state.rootDir || getDefaultRootDir();
}

function getFolderCandidates() {
  const rootDir = getRootDir();
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  return fs.readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      folderName: entry.name,
      folderPath: path.join(rootDir, entry.name),
    }));
}

function isUsableMapping(mapping) {
  return Boolean(
    mapping?.folderPath &&
    fs.existsSync(mapping.folderPath) &&
    fs.statSync(mapping.folderPath).isDirectory()
  );
}

function prepareMapping(courseName) {
  const existing = store.findMapping({
    courseName,
  });
  if (isUsableMapping(existing)) {
    return {
      existing,
      suggestions: [],
      suggestedFolderPath: existing.folderPath,
    };
  }

  const candidates = getFolderCandidates();
  const suggestions = rankCandidates(courseName, candidates.map((entry) => entry.folderName))
    .slice(0, 5)
    .map((entry) => ({
      ...entry,
      folderPath: candidates.find((candidate) => candidate.folderName === entry.folderName)?.folderPath || "",
    }));

  return {
    existing: null,
    suggestions,
    suggestedFolderPath: path.join(getRootDir(), sanitizeFolderName(normalizeCourseFolderName(courseName))),
  };
}

function resolveMapping(courseName, courseUrl = "") {
  const existing = store.findMapping({
    courseName,
    courseUrl,
  });
  if (isUsableMapping(existing)) {
    return { folderPath: existing.folderPath, matchType: existing.matchType || "manual", suggestions: [] };
  }

  const prepared = prepareMapping(courseName);
  if (isUsableMapping(prepared.existing)) {
    return { folderPath: prepared.existing.folderPath, matchType: prepared.existing.matchType || "manual", suggestions: [] };
  }

  if (prepared.suggestions[0] && prepared.suggestions[0].score >= 0.88) {
    const auto = prepared.suggestions[0];
    store.upsertMapping({
      courseName,
      folderPath: auto.folderPath,
      courseUrl,
      matchType: "similarity",
    });
    return {
      folderPath: auto.folderPath,
      matchType: "similarity",
      suggestions: prepared.suggestions,
    };
  }

  return {
    folderPath: prepared.suggestedFolderPath,
    matchType: "new-folder",
    suggestions: prepared.suggestions,
  };
}

function listDirectory(targetPath) {
  const rootDir = getRootDir();
  ensureDirectory(rootDir);
  const requestedPath = path.resolve(targetPath || rootDir);
  const mirroredPath = resolveLocalBuildMirrorPath(requestedPath);
  const safeTarget = fs.existsSync(mirroredPath) && fs.statSync(mirroredPath).isDirectory()
    ? mirroredPath
    : fs.existsSync(requestedPath) && fs.statSync(requestedPath).isDirectory()
    ? requestedPath
    : rootDir;
  const entries = fs.readdirSync(safeTarget, { withFileTypes: true })
    .map((entry) => {
      const entryPath = path.join(safeTarget, entry.name);
      const stats = fs.statSync(entryPath);
      return {
        name: entry.name,
        path: entryPath,
        isDirectory: entry.isDirectory(),
        withinRoot: isSubPath(rootDir, entryPath),
        modifiedAt: stats.mtime.toISOString(),
        size: entry.isDirectory() ? null : stats.size,
      };
    })
    .sort((left, right) => Number(right.isDirectory) - Number(left.isDirectory) || left.name.localeCompare(right.name, "ja"));

  return {
    rootDir,
    currentDir: safeTarget,
    entries,
  };
}

async function buildDragIcon(targetPath) {
  try {
    const icon = await app.getFileIcon(targetPath, { size: "normal" });
    if (!icon.isEmpty()) {
      return icon;
    }
  } catch (_error) {
    // Fall back to a tiny generated icon when the shell icon is unavailable.
  }

  return nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAQAAAAAYLlVAAAA8ElEQVR4Ae3XsQ2DQBBF0Q+NQY4M4QLM4Bys4AnM4AjOwN1QHyvDOMkMt2rt7Nmzu13R5pTKty+O+kO5RAAAAAAAAAAAAICR9wMyoVo9hw3rroWAt4EvsC0BpvyEukgqS0bkkCm1cW0BpGbkADVYAKjwxKF1uHmIiiaTZGi4ZTSdKCbFf8gDuwZQhQAEjrISFRCGDpa2BkLomqKgJo0aoArkC5AOIDMDEwZ0AqSdzdrIW6DCQE4kYvNysGEKMluSleqrs9jwELyhlHLLJoPLD114F8nGMD4HzyBbs6k8ZZrguSu2Ce279b9Ec/WWavOXJeAAAAAAAAAAAAAACA74B/A9vywgq6Z9YAAAAASUVORK5CYII="
  );
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send(channel, payload);
    } catch (_error) {
      // Ignore transient renderer communication failures during teardown.
    }
  }
}

function sendBlockedNavigationMessage(message) {
  sendToRenderer("download:event", {
    type: "blocked",
    message,
  });
  shell.beep();
}

function emitRemotePdfOpen(sourceContentsId, pdfUrl) {
  const sourceTabId = webContentsToTab.get(sourceContentsId);
  const context = tabRegistry.get(sourceTabId) ?? {};
  const fileName = decodeURIComponent(pdfUrl.split("/").at(-1)?.split("?")[0] || "document.pdf");

  sendToRenderer("pdf:open-remote", {
    sourceTabId,
    pdfUrl,
    fileName,
    courseName: context.courseName || "",
  });
}

function emitRemoteFileOpen(sourceContentsId, fileUrl, fileName = "") {
  const sourceTabId = webContentsToTab.get(sourceContentsId);
  const context = tabRegistry.get(sourceTabId) ?? {};

  sendToRenderer("file:open-remote", {
    sourceTabId,
    fileUrl,
    fileName: fileName || inferFileNameFromUrl(fileUrl) || "download",
    courseName: context.courseName || "",
  });
}

function emitPreviewFileOpen(sourceContentsId, localPath, fileName = "") {
  const sourceTabId = webContentsToTab.get(sourceContentsId);
  const context = tabRegistry.get(sourceTabId) ?? {};

  sendToRenderer("file:open-preview", {
    sourceTabId,
    localPath,
    fileName: fileName || path.basename(localPath) || "download",
    courseName: context.courseName || "",
    cleanupOnClose: true,
  });
}

function buildPreviewPath(fileName) {
  const previewDir = buildPreviewDir();
  return uniqueFilePath(path.join(previewDir, sanitizeFileName(fileName || "download")));
}

function finalizeSavedFile(sourcePath, folderPath, requestedFileName = "", lessonFolder = "") {
  let targetFolder = folderPath;
  if (lessonFolder) {
    targetFolder = path.join(targetFolder, lessonFolder);
  }
  ensureDirectory(targetFolder);

  const actualFileName = path.basename(sourcePath);
  const targetFileName = shouldReplacePlaceholderFileName(requestedFileName)
    ? actualFileName
    : sanitizeFileName(requestedFileName);
  const finalPath = uniqueFilePath(path.join(targetFolder, targetFileName));
  fs.copyFileSync(sourcePath, finalPath);
  return finalPath;
}

function buildInitialState() {
  const state = store.getState();
  ensureDirectory(getRootDir());
  return {
    rootDir: state.rootDir,
    mappings: state.mappings,
    downloadHistory: state.downloadHistory,
    directory: listDirectory(state.rootDir || getRootDir()),
  };
}

async function flushPersistentSession() {
  if (!fuzzySession) {
    return;
  }

  await Promise.allSettled([
    fuzzySession.cookies.flushStore(),
    fuzzySession.flushStorageData(),
  ]);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1540,
    height: 960,
    minWidth: 1280,
    minHeight: 760,
    title: "Fuzitter",
    backgroundColor: "#0b1020",
    icon: path.join(__dirname, "..", "assets", "fuzitter.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.webContents.once("did-finish-load", () => {
    emitAutoUpdateEvent({
      type: "status",
      message: updateState.message,
    });
  });
}

function findWebContentsForTab(tabId) {
  const targetEntry = [...webContentsToTab.entries()].find(([, value]) => value === tabId);
  if (!targetEntry) {
    return null;
  }
  return webContents.fromId(targetEntry[0]) || null;
}

function queueCustomDownload(tabId, config) {
  const queue = customDownloadQueues.get(tabId) || [];
  queue.push(config);
  customDownloadQueues.set(tabId, queue);
}

function shiftCustomDownload(tabId) {
  const queue = customDownloadQueues.get(tabId) || [];
  const next = queue.shift() || null;
  if (queue.length) {
    customDownloadQueues.set(tabId, queue);
  } else {
    customDownloadQueues.delete(tabId);
  }
  return next;
}

app.whenReady().then(() => {
  app.setName(APP_NAME);
  if (typeof app.setAppUserModelId === "function") {
    app.setAppUserModelId("Fuzitter");
  }
  migrateLegacyStateToFuzitter();
  store = new Store(getStoreFilePath());
  fuzzySession = session.fromPartition(FUZITTER_PARTITION);
  setupAutoUpdater();

  app.on("web-contents-created", (_appEvent, contents) => {
    if (contents.getType() !== "webview") {
      return;
    }

    contents.once("destroyed", () => {
      const tabId = webContentsToTab.get(contents.id);
      webContentsToTab.delete(contents.id);
      if (tabId) {
        tabRegistry.delete(tabId);
      }
    });

    contents.on("context-menu", (event, params) => {
      if (!params.linkURL) {
        return;
      }
      event.preventDefault();
      const tabId = webContentsToTab.get(contents.id);
      if (!tabId) {
        return;
      }
      if (isDownloadLikeUrl(params.linkURL)) {
        const fileName = decodeURIComponent(
          params.linkURL.split("/").at(-1)?.split("?")[0] ||
          params.linkText ||
          "download"
        );
        sendToRenderer("download:prompt", {
          tabId,
          url: params.linkURL,
          fileName,
          label: params.linkText || "",
          pageUrl: params.pageURL || "",
          x: params.x ?? 0,
          y: params.y ?? 0,
        });
        return;
      }
      if (isAllowedUrl(params.linkURL)) {
        sendToRenderer("link:menu", {
          tabId,
          url: params.linkURL,
          label: params.linkText || "",
          x: params.x ?? 0,
          y: params.y ?? 0,
        });
      }
    });

    contents.on("will-navigate", (event, targetUrl) => {
      if (isDownloadLikeUrl(targetUrl)) {
        event.preventDefault();
        const tabId = webContentsToTab.get(contents.id);
        if (tabId) {
          queueCustomDownload(tabId, {
            mode: "preview",
            fileName: inferFileNameFromUrl(targetUrl) || "download",
          });
          contents.downloadURL(targetUrl);
        }
        return;
      }

      if (!isAllowedUrl(targetUrl)) {
        event.preventDefault();
        sendBlockedNavigationMessage("和歌山大学 Moodle と認証ページ以外への移動は制限されています。");
      }
    });

    contents.setWindowOpenHandler(({ url }) => {
      if (isDownloadLikeUrl(url)) {
        const tabId = webContentsToTab.get(contents.id);
        if (tabId) {
          queueCustomDownload(tabId, {
            mode: "preview",
            fileName: inferFileNameFromUrl(url) || "download",
          });
          contents.downloadURL(url);
        }
        return { action: "deny" };
      }

      if (isAllowedUrl(url)) {
        sendToRenderer("course:open-tab", {
          courseUrl: url,
          courseName: "Moodle",
        });
      } else {
        sendBlockedNavigationMessage("和歌山大学 Moodle 関連以外の新規ウィンドウは開けません。");
      }

      return { action: "deny" };
    });
  });

  fuzzySession.on("will-download", (_event, item, contents) => {
    try {
      const tabId = webContentsToTab.get(contents.id);
      const context = tabRegistry.get(tabId) ?? {};
      const courseName = context.courseName || context.title || "Unsorted";
      const customRequest = tabId ? shiftCustomDownload(tabId) : null;
      const resolved = customRequest?.mode === "save" ? resolveMapping(courseName, context.url || "") : null;

      let finalPath = "";
      let targetFolder = "";

      if (customRequest?.mode === "preview") {
        finalPath = buildPreviewPath(customRequest.fileName || item.getFilename() || inferFileNameFromUrl(item.getURL()) || "download");
        item.setSavePath(finalPath);
        item.once("done", (_doneEvent, state) => {
          if (state === "completed") {
            customRequest.resolve?.({
              localPath: finalPath,
              fileName: path.basename(finalPath),
            });
            if (!customRequest.suppressOpen) {
              emitPreviewFileOpen(contents.id, finalPath, path.basename(finalPath));
            }
            return;
          }
          customRequest.reject?.(new Error("ファイルのプレビュー準備に失敗しました。"));
          sendToRenderer("download:event", {
            type: "blocked",
            message: "ファイルのプレビュー準備に失敗しました。",
          });
        });
        return;
      }

      if (customRequest?.mode === "save") {
        const actualFileName = item.getFilename() || inferFileNameFromUrl(item.getURL()) || "download";
        const targetFileName = shouldReplacePlaceholderFileName(customRequest.fileName)
          ? actualFileName
          : customRequest.fileName;
        targetFolder = customRequest.folderPath;
        if (customRequest.lessonFolder) {
          targetFolder = path.join(targetFolder, customRequest.lessonFolder);
        }
        ensureDirectory(targetFolder);
        finalPath = uniqueFilePath(path.join(targetFolder, sanitizeFileName(targetFileName)));
      } else {
        const autoPreviewPath = buildPreviewPath(item.getFilename() || inferFileNameFromUrl(item.getURL()) || "download");
        item.setSavePath(autoPreviewPath);
        item.once("done", (_doneEvent, state) => {
          if (state === "completed") {
            emitPreviewFileOpen(contents.id, autoPreviewPath, path.basename(autoPreviewPath));
            return;
          }
          sendToRenderer("download:event", {
            type: "blocked",
            message: "ファイルのプレビュー準備に失敗しました。",
          });
        });
        return;
      }

      if (!targetFolder) {
        targetFolder = resolved.folderPath;
        ensureDirectory(targetFolder);
        finalPath = uniqueFilePath(path.join(targetFolder, item.getFilename()));
      }

      item.setSavePath(finalPath);

      store.addDownloadHistory({
        courseName,
        sourceUrl: context.url || item.getURL(),
        targetPath: finalPath,
        status: "started",
      });

      sendToRenderer("download:event", {
        type: "started",
        courseName,
        fileName: path.basename(finalPath),
        savePath: finalPath,
        tabId,
        folderPath: targetFolder,
        suggestions: resolved?.suggestions || [],
        requiresReview: !customRequest && resolved?.matchType === "new-folder",
      });

      item.once("done", (_doneEvent, state) => {
        store.addDownloadHistory({
          courseName,
          sourceUrl: context.url || item.getURL(),
          targetPath: finalPath,
          status: state,
        });

        sendToRenderer("download:event", {
          type: state,
          courseName,
          fileName: path.basename(finalPath),
          savePath: finalPath,
          tabId,
        });
      });
    } catch (_error) {
      try {
        item.cancel();
      } catch (_cancelError) {
        // Ignore cancellation failures during error recovery.
      }
    }
  });

  app.on("activate", () => {
    if (isStartupUpdateGateRunning) {
      return;
    }
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  void (async () => {
    const shouldLaunchWindow = await runStartupUpdateGate();
    if (shouldLaunchWindow) {
      createWindow();
    }
  })();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  if (isQuittingAfterSessionFlush) {
    return;
  }

  event.preventDefault();
  isQuittingAfterSessionFlush = true;
  flushPersistentSession()
    .catch(() => {
      // Ignore flush failures and continue shutdown.
    })
    .finally(() => {
      app.quit();
    });
});

ipcMain.handle("app:defaults", () => ({
  moodleHome: normalizeMoodleHomeUrl(store.getState().preferences?.moodleHome || WAKAYAMA_MOODLE_HOME),
  dashboardAutoload: Boolean(store.getState().preferences?.dashboardAutoload),
  appVersion: app.getVersion(),
  autoUpdate: getAutoUpdateStatus(),
}));

ipcMain.handle("app:preferences:update", (_event, payload) => {
  if (typeof payload.dashboardAutoload === "boolean") {
    store.setPreference("dashboardAutoload", payload.dashboardAutoload);
  }
  if (typeof payload.moodleHome === "string") {
    store.setPreference("moodleHome", normalizeMoodleHomeUrl(payload.moodleHome));
  }
  return {
    moodleHome: normalizeMoodleHomeUrl(store.getState().preferences?.moodleHome || WAKAYAMA_MOODLE_HOME),
    dashboardAutoload: Boolean(store.getState().preferences?.dashboardAutoload),
    appVersion: app.getVersion(),
    autoUpdate: getAutoUpdateStatus(),
  };
});

ipcMain.handle("app:update:check", async () => {
  return triggerAutoUpdateCheck("manual");
});

ipcMain.handle("app:update:install", () => {
  if (!updateState.enabled || !updateState.downloaded) {
    return {
      ok: false,
      ...getAutoUpdateStatus(),
    };
  }

  installDownloadedUpdate("manual-install");

  return {
    ok: true,
    ...getAutoUpdateStatus(),
  };
});

ipcMain.handle("state:get", () => buildInitialState());

ipcMain.handle("root:choose", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory", "createDirectory"],
  });

  if (result.canceled || !result.filePaths[0]) {
    return buildInitialState();
  }

  store.setRootDir(result.filePaths[0]);
  ensureDirectory(result.filePaths[0]);
  return buildInitialState();
});

ipcMain.handle("directory:list", (_event, targetPath) => listDirectory(targetPath));

ipcMain.handle("mapping:prepare", (_event, payload) => {
  const existing = store.findMapping({
    courseName: payload.courseName || "",
    courseUrl: payload.courseUrl || "",
    courseId: payload.courseId || "",
  });
  if (isUsableMapping(existing)) {
    return {
      existing,
      suggestions: [],
      suggestedFolderPath: existing.folderPath,
    };
  }
  return prepareMapping(payload.courseName || "");
});

ipcMain.handle("mapping:suggestions", (_event, courseName) => {
  return prepareMapping(courseName || "").suggestions;
});

ipcMain.handle("mapping:choose-folder", async () => {
  const rootDir = getRootDir();
  ensureDirectory(rootDir);
  const result = await dialog.showOpenDialog(mainWindow, {
    defaultPath: rootDir,
    properties: ["openDirectory", "createDirectory"],
  });

  if (result.canceled || !result.filePaths[0]) {
    return null;
  }

  if (!isSubPath(rootDir, result.filePaths[0])) {
    throw new Error("保存先はルートフォルダ配下から選択してください。");
  }

  return result.filePaths[0];
});

ipcMain.handle("mapping:save", (_event, payload) => {
  const rootDir = getRootDir();
  if (!payload.folderPath || !isSubPath(rootDir, payload.folderPath)) {
    throw new Error("保存先はルートフォルダ配下である必要があります。");
  }

  ensureDirectory(payload.folderPath);
  return store.upsertMapping({
    ...payload,
    courseId: payload.courseId || extractCourseIdFromUrl(payload.courseUrl),
  });
});

ipcMain.handle("mapping:create-default-folder", (_event, payload) => {
  const rootDir = getRootDir();
  const folderPath = path.join(rootDir, sanitizeFolderName(normalizeCourseFolderName(payload.courseName || "")));
  ensureDirectory(folderPath);
  return store.upsertMapping({
    courseName: payload.courseName,
    courseId: payload.courseId || extractCourseIdFromUrl(payload.courseUrl),
    courseUrl: payload.courseUrl || "",
    folderPath,
    matchType: "new-folder",
  });
});

ipcMain.handle("mapping:set-submission-folder", (_event, payload) => {
  const rootDir = getRootDir();
  if (!payload?.submissionFolderPath || !isSubPath(rootDir, payload.submissionFolderPath)) {
    throw new Error("提出フォルダはルートフォルダ配下である必要があります。");
  }
  ensureDirectory(payload.submissionFolderPath);
  const mapping = store.setSubmissionFolder({
    courseName: payload.courseName || "",
    courseId: payload.courseId || extractCourseIdFromUrl(payload.courseUrl),
    courseUrl: payload.courseUrl || "",
  }, payload.submissionFolderPath);
  if (!mapping) {
    throw new Error("先にコースフォルダを紐づけてください。");
  }
  return mapping;
});

ipcMain.handle("course:open-for-folder", (_event, folderPath) => {
  const mapping = store.findMappingByPath(folderPath) || store.findMappingByFolder(folderPath);
  if (!mapping?.courseUrl) {
    return { ok: false };
  }

  sendToRenderer("course:open-tab", {
    courseUrl: mapping.courseUrl,
    courseName: mapping.courseName,
  });

  return { ok: true };
});

ipcMain.handle("download:start-custom", async (_event, payload) => {
  const targetContents = findWebContentsForTab(payload.tabId);
  if (!targetContents) {
    throw new Error("対象のタブが見つかりません。");
  }

  const rootDir = getRootDir();
  if (!payload.folderPath || !isSubPath(rootDir, payload.folderPath)) {
    throw new Error("保存先はルートフォルダ配下から選択してください。");
  }

  const resolved = await resolveRemoteFileDetails(payload.url);
  return await new Promise((resolve, reject) => {
    queueCustomDownload(payload.tabId, {
      mode: "preview",
      suppressOpen: true,
      fileName: sanitizeFileName(
        payload.fileName && !shouldReplacePlaceholderFileName(payload.fileName)
          ? payload.fileName
          : resolved.fileName || inferFileNameFromUrl(payload.url) || "download"
      ),
      resolve: (preview) => {
        try {
          const finalPath = finalizeSavedFile(
            preview.localPath,
            payload.folderPath,
            payload.fileName && !shouldReplacePlaceholderFileName(payload.fileName)
              ? payload.fileName
              : resolved.fileName || "",
            payload.lessonFolder || "",
          );

          const context = tabRegistry.get(payload.tabId) ?? {};
          const courseName = context.courseName || context.title || "Unsorted";
          sendToRenderer("download:event", {
            type: "started",
            courseName,
            fileName: path.basename(finalPath),
            savePath: finalPath,
            tabId: payload.tabId,
            folderPath: path.dirname(finalPath),
            suggestions: [],
            requiresReview: false,
          });

          store.addDownloadHistory({
            courseName,
            sourceUrl: context.url || payload.url,
            targetPath: finalPath,
            status: "started",
          });
          store.addDownloadHistory({
            courseName,
            sourceUrl: context.url || payload.url,
            targetPath: finalPath,
            status: "completed",
          });

          sendToRenderer("download:event", {
            type: "completed",
            courseName,
            fileName: path.basename(finalPath),
            savePath: finalPath,
            tabId: payload.tabId,
          });
          resolve({ ok: true, savePath: finalPath });
        } catch (error) {
          reject(error);
        }
      },
      reject,
    });

    try {
      targetContents.downloadURL(resolved.resolvedUrl || payload.url);
    } catch (error) {
      shiftCustomDownload(payload.tabId);
      reject(error);
    }
  });
});

ipcMain.handle("explorer:duplicate", async (_event, targetPath) => {
  const rootDir = getRootDir();
  if (!targetPath || !isSubPath(rootDir, targetPath) || !fs.existsSync(targetPath)) {
    throw new Error("対象ファイルが見つかりません。");
  }

  const duplicatePath = buildDuplicatePath(targetPath);
  const stats = fs.statSync(targetPath);
  if (stats.isDirectory()) {
    fs.cpSync(targetPath, duplicatePath, { recursive: true });
  } else {
    fs.copyFileSync(targetPath, duplicatePath);
  }
  return { path: duplicatePath };
});

ipcMain.handle("explorer:create", async (_event, payload) => {
  return createExplorerEntry(payload?.parentPath, payload?.kind);
});

ipcMain.handle("explorer:open-with", async (_event, payload) => {
  return openExplorerEntryWithProgram(payload?.targetPath, String(payload?.program || "").toLowerCase());
});

ipcMain.handle("explorer:open-executable", async (_event, targetPath) => {
  return openExplorerExecutable(targetPath);
});

ipcMain.handle("explorer:rename", async (_event, payload) => {
  const rootDir = getRootDir();
  if (!payload?.targetPath || !isSubPath(rootDir, payload.targetPath) || !fs.existsSync(payload.targetPath)) {
    throw new Error("対象ファイルが見つかりません。");
  }

  const targetStats = fs.statSync(payload.targetPath);

  const nextName = String(payload.nextName || "").trim();
  if (!nextName) {
    throw new Error("新しい名前を入力してください。");
  }

  const nextPath = path.join(path.dirname(payload.targetPath), nextName);
  if (!isSubPath(rootDir, nextPath)) {
    throw new Error("保存先はルートフォルダ配下である必要があります。");
  }
  if (fs.existsSync(nextPath)) {
    throw new Error("同じ名前のファイルがすでに存在します。");
  }

  fs.renameSync(payload.targetPath, nextPath);
  const renameResult = targetStats.isDirectory()
    ? store.updateMappingPathsForRename(payload.targetPath, nextPath)
    : { changed: false, mappings: null };

  return {
    path: nextPath,
    mappings: renameResult.changed ? renameResult.mappings : null,
  };
});

ipcMain.handle("explorer:delete", async (_event, targetPath) => {
  const rootDir = getRootDir();
  if (!targetPath || !isSubPath(rootDir, targetPath) || !fs.existsSync(targetPath)) {
    throw new Error("対象ファイルが見つかりません。");
  }

  await shell.trashItem(targetPath);
  return { ok: true };
});

ipcMain.handle("explorer:delete-many", async (_event, targetPaths) => {
  const rootDir = getRootDir();
  const paths = Array.isArray(targetPaths)
    ? [...new Set(targetPaths.map((entry) => path.resolve(String(entry || ""))).filter(Boolean))]
    : [];
  if (!paths.length) {
    throw new Error("削除対象が見つかりません。");
  }

  for (const targetPath of paths) {
    if (!isSubPath(rootDir, targetPath) || !fs.existsSync(targetPath)) {
      throw new Error("対象ファイルが見つかりません。");
    }
  }

  for (const targetPath of paths) {
    await shell.trashItem(targetPath);
  }

  return { ok: true };
});

ipcMain.handle("explorer:move", async (_event, payload) => {
  const rootDir = getRootDir();
  const destinationDirPath = path.resolve(String(payload?.destinationDirPath || ""));
  const sourcePaths = Array.isArray(payload?.sourcePaths)
    ? [...new Set(payload.sourcePaths.map((entry) => path.resolve(String(entry || ""))).filter(Boolean))]
    : [];

  if (!sourcePaths.length) {
    throw new Error("移動対象が見つかりません。");
  }
  if (!destinationDirPath || !isSubPath(rootDir, destinationDirPath) || !fs.existsSync(destinationDirPath)) {
    throw new Error("移動先フォルダが見つかりません。");
  }
  if (!fs.statSync(destinationDirPath).isDirectory()) {
    throw new Error("移動先にはフォルダを指定してください。");
  }

  const plannedMoves = [];
  for (const sourcePath of sourcePaths) {
    if (!isSubPath(rootDir, sourcePath) || !fs.existsSync(sourcePath)) {
      throw new Error("移動対象が見つかりません。");
    }

    const nextPath = path.join(destinationDirPath, path.basename(sourcePath));
    if (path.resolve(nextPath) === sourcePath) {
      continue;
    }
    if (isSubPath(sourcePath, destinationDirPath)) {
      throw new Error("フォルダをその中へ移動することはできません。");
    }
    if (fs.existsSync(nextPath)) {
      throw new Error(`${path.basename(nextPath)} は移動先にすでに存在します。`);
    }

    plannedMoves.push({
      sourcePath,
      nextPath,
      isDirectory: fs.statSync(sourcePath).isDirectory(),
    });
  }

  for (const move of plannedMoves) {
    fs.renameSync(move.sourcePath, move.nextPath);
    if (move.isDirectory) {
      store.updateMappingPathsForRename(move.sourcePath, move.nextPath);
    }
  }

  return {
    ok: true,
    movedCount: plannedMoves.length,
    mappings: store.getState().mappings,
  };
});

ipcMain.on("explorer:start-drag", async (event, targetPath) => {
  const resolvedPath = path.resolve(targetPath || "");
  if (!fs.existsSync(resolvedPath)) {
    return;
  }

  const icon = await buildDragIcon(resolvedPath);
  event.sender.startDrag({
    file: resolvedPath,
    icon,
  });
});

ipcMain.handle("download:resolve", async (_event, payload) => {
  const resolved = await resolveRemoteFileDetails(payload.url);
  return {
    ...resolved,
    fileName: sanitizeFileName(
      payload.fileName && !shouldReplacePlaceholderFileName(payload.fileName)
        ? payload.fileName
        : resolved.fileName || payload.label || inferFileNameFromUrl(payload.url) || "download"
    ),
  };
});

ipcMain.handle("file:open-remote", async (_event, payload) => {
  const targetContents = findWebContentsForTab(payload.tabId);
  if (!targetContents) {
    throw new Error("対象のタブが見つかりません。");
  }
 
  const resolved = await resolveRemoteFileDetails(payload.url);
  return await new Promise((resolve, reject) => {
    queueCustomDownload(payload.tabId, {
      mode: "preview",
      fileName: sanitizeFileName(
        payload.fileName && !shouldReplacePlaceholderFileName(payload.fileName)
          ? payload.fileName
          : resolved.fileName || payload.label || inferFileNameFromUrl(payload.url) || "download"
      ),
      resolve,
      reject,
    });
    try {
      targetContents.downloadURL(resolved.resolvedUrl || payload.url);
    } catch (error) {
      shiftCustomDownload(payload.tabId);
      reject(error);
    }
  });
});

ipcMain.handle("preview:cleanup", async (_event, targetPath) => {
  if (!isPreviewCachePath(targetPath)) {
    return { ok: false };
  }

  if (fs.existsSync(targetPath)) {
    fs.rmSync(targetPath, { force: true });
  }
  return { ok: true };
});

ipcMain.on("webview:register", (_event, payload) => {
  webContentsToTab.set(payload.webContentsId, payload.tabId);
});

ipcMain.on("webview:unregister", (_event, payload) => {
  webContentsToTab.delete(payload.webContentsId);
  tabRegistry.delete(payload.tabId);
});

ipcMain.on("tab-context:update", (_event, payload) => {
  tabRegistry.set(payload.tabId, payload.context);
});

ipcMain.handle("download:batch", async (_event, tabId) => {
  const targetContents = findWebContentsForTab(tabId);
  if (!targetContents) {
    return { queued: 0 };
  }

  const links = await targetContents.executeJavaScript(`
    [...document.querySelectorAll('a[href]')]
      .map((anchor) => ({ href: anchor.href, text: anchor.innerText || anchor.textContent || "" }))
      .filter((entry) =>
        /\\.(pdf|docx?|pptx?|xlsx?|zip)(\\?|$)/i.test(entry.href) ||
        /mod\\/resource\\/view\\.php/i.test(entry.href) ||
        /pluginfile\\.php/i.test(entry.href)
      )
      .slice(0, 40);
  `, true);

  for (const link of links) {
    targetContents.downloadURL(link.href);
  }

  return { queued: links.length };
});
