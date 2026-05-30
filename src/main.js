const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, dialog, ipcMain, session, shell, webContents } = require("electron");

const { rankCandidates } = require("./similarity");
const { Store } = require("./store");

const WAKAYAMA_MOODLE_HOME = "https://moodle2026.wakayama-u.ac.jp/2026/";
const FUZZY_PARTITION = "persist:fuzzy";
const ALLOWED_HOST_PATTERNS = [
  /^moodle(?:\d{4})?\.wakayama-u\.ac\.jp$/i,
  /^wakayama-u\.ac\.jp$/i,
  /^www\.wakayama-u\.ac\.jp$/i,
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

function sanitizeFolderName(name) {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "Unsorted";
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

function getRootDir() {
  const state = store.getState();
  return state.rootDir || path.join(app.getPath("downloads"), "Fuzzy");
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

function prepareMapping(courseName) {
  const existing = store.findMappingByCourse(courseName);
  if (existing) {
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
    suggestedFolderPath: path.join(getRootDir(), sanitizeFolderName(courseName)),
  };
}

function resolveMapping(courseName, courseUrl = "") {
  const prepared = prepareMapping(courseName);
  if (prepared.existing) {
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
  const safeTarget = targetPath && isSubPath(rootDir, targetPath) ? targetPath : rootDir;
  const entries = fs.readdirSync(safeTarget, { withFileTypes: true })
    .map((entry) => {
      const entryPath = path.join(safeTarget, entry.name);
      const stats = fs.statSync(entryPath);
      return {
        name: entry.name,
        path: entryPath,
        isDirectory: entry.isDirectory(),
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

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
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
    backgroundColor: "#0b1020",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
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
  store = new Store(path.join(app.getPath("userData"), "fuzzy-store.json"));
  fuzzySession = session.fromPartition(FUZZY_PARTITION);
  createWindow();

  app.on("web-contents-created", (_appEvent, contents) => {
    if (contents.getType() !== "webview") {
      return;
    }

    contents.on("context-menu", (event, params) => {
      if (!params.linkURL || !isDownloadLikeUrl(params.linkURL)) {
        return;
      }
      event.preventDefault();
      const tabId = webContentsToTab.get(contents.id);
      if (!tabId) {
        return;
      }
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
      });
    });

    contents.on("will-navigate", (event, targetUrl) => {
      if (isPdfUrl(targetUrl)) {
        event.preventDefault();
        emitRemotePdfOpen(contents.id, targetUrl);
        return;
      }

      if (!isAllowedUrl(targetUrl)) {
        event.preventDefault();
        sendBlockedNavigationMessage("和歌山大学 Moodle と認証ページ以外への移動は制限されています。");
      }
    });

    contents.setWindowOpenHandler(({ url }) => {
      if (isPdfUrl(url)) {
        emitRemotePdfOpen(contents.id, url);
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
    const tabId = webContentsToTab.get(contents.id);
    const context = tabRegistry.get(tabId) ?? {};
    const courseName = context.courseName || context.title || "Unsorted";
    const customRequest = tabId ? shiftCustomDownload(tabId) : null;
    const resolved = customRequest ? null : resolveMapping(courseName, context.url || "");

    let finalPath = "";
    let targetFolder = "";

    if (customRequest) {
      targetFolder = customRequest.folderPath;
      if (customRequest.lessonFolder) {
        targetFolder = path.join(targetFolder, customRequest.lessonFolder);
      }
      ensureDirectory(targetFolder);
      finalPath = uniqueFilePath(path.join(targetFolder, sanitizeFileName(customRequest.fileName)));
    } else {
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
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
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
  moodleHome: WAKAYAMA_MOODLE_HOME,
  dashboardAutoload: Boolean(store.getState().preferences?.dashboardAutoload),
}));

ipcMain.handle("app:preferences:update", (_event, payload) => {
  if (typeof payload.dashboardAutoload === "boolean") {
    store.setPreference("dashboardAutoload", payload.dashboardAutoload);
  }
  return {
    dashboardAutoload: Boolean(store.getState().preferences?.dashboardAutoload),
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
  return store.upsertMapping(payload);
});

ipcMain.handle("mapping:create-default-folder", (_event, payload) => {
  const rootDir = getRootDir();
  const folderPath = path.join(rootDir, sanitizeFolderName(payload.courseName || ""));
  ensureDirectory(folderPath);
  return store.upsertMapping({
    courseName: payload.courseName,
    courseUrl: payload.courseUrl || "",
    folderPath,
    matchType: "new-folder",
  });
});

ipcMain.handle("course:open-for-folder", (_event, folderPath) => {
  const mapping = store.findMappingByFolder(folderPath);
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

  queueCustomDownload(payload.tabId, {
    folderPath: payload.folderPath,
    lessonFolder: payload.lessonFolder || "",
    fileName: payload.fileName || "download",
  });

  targetContents.downloadURL(payload.url);
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
