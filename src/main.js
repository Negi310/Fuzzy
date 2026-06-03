const fs = require("node:fs");
const { execFileSync, spawn } = require("node:child_process");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { app, BrowserWindow, dialog, ipcMain, nativeImage, session, shell, webContents } = require("electron");

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
  const rootDir = getRootDir();
  if (!targetPath || !isSubPath(rootDir, targetPath) || !fs.existsSync(targetPath)) {
    throw new Error("Target file is not available.");
  }

  const programPath = resolveProgramPath(programKey);
  if (!programPath) {
    throw new Error(`${programKey} is not installed on this PC.`);
  }

  launchProgram(programPath, [targetPath]);
  return { ok: true, programPath };
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
  const existing = store.findMapping({
    courseName,
  });
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
  const existing = store.findMapping({
    courseName,
    courseUrl,
  });
  if (existing) {
    return { folderPath: existing.folderPath, matchType: existing.matchType || "manual", suggestions: [] };
  }

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
  const requestedPath = path.resolve(targetPath || rootDir);
  const safeTarget = fs.existsSync(requestedPath) && fs.statSync(requestedPath).isDirectory()
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

    contents.once("destroyed", () => {
      const tabId = webContentsToTab.get(contents.id);
      webContentsToTab.delete(contents.id);
      if (tabId) {
        tabRegistry.delete(tabId);
      }
    });

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
        x: params.x ?? 0,
        y: params.y ?? 0,
      });
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
          emitPreviewFileOpen(contents.id, finalPath, path.basename(finalPath));
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
      targetFolder = customRequest.folderPath || resolved?.folderPath || "";
      if (!targetFolder) {
        customRequest.reject?.(new Error("保存先フォルダが見つかりませんでした。"));
        sendToRenderer("download:event", {
          type: "blocked",
          message: "保存先フォルダが見つかりませんでした。",
        });
        return;
      }
      if (customRequest.lessonFolder) {
        targetFolder = path.join(targetFolder, customRequest.lessonFolder);
      }
      if (!targetFolder) {
        customRequest.reject?.(new Error("保存先フォルダが無効です。"));
        sendToRenderer("download:event", {
          type: "blocked",
          message: "保存先フォルダが無効です。",
        });
        return;
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
  const existing = store.findMapping({
    courseName: payload.courseName || "",
    courseUrl: payload.courseUrl || "",
    courseId: payload.courseId || "",
  });
  if (existing) {
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
  const folderPath = path.join(rootDir, sanitizeFolderName(payload.courseName || ""));
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

ipcMain.handle("explorer:rename", async (_event, payload) => {
  const rootDir = getRootDir();
  if (!payload?.targetPath || !isSubPath(rootDir, payload.targetPath) || !fs.existsSync(payload.targetPath)) {
    throw new Error("対象ファイルが見つかりません。");
  }

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
  return { path: nextPath };
});

ipcMain.handle("explorer:delete", async (_event, targetPath) => {
  const rootDir = getRootDir();
  if (!targetPath || !isSubPath(rootDir, targetPath) || !fs.existsSync(targetPath)) {
    throw new Error("対象ファイルが見つかりません。");
  }

  await shell.trashItem(targetPath);
  return { ok: true };
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
