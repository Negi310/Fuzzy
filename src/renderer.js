const PRELOAD_PATH = (() => {
  const url = new URL("./browser-preload.js", window.location.href);
  let pathname = decodeURIComponent(url.pathname);
  if (/^\/[A-Za-z]:/.test(pathname)) {
    pathname = pathname.slice(1);
  }
  return pathname;
})();

const UI_TEXT = {
  defaultBrowserTitle: "Moodle",
  noCourse: "未選択",
  emptyFiles: "ファイルがありません",
  emptyMappings: "まだ紐づけはありません",
  emptyTimeline: "タイムラインはまだ読み込まれていません",
  localOnly: "PDF 以外のローカル表示にはまだ対応していません",
  rootUnset: "未設定",
};

const state = {
  moodleHome: "https://moodle2026.wakayama-u.ac.jp/2026/",
  dashboardUrl: "https://moodle2026.wakayama-u.ac.jp/2026/my/",
  rootDir: "",
  currentDir: "",
  mappings: [],
  timelineEntries: [],
  timelineFilter: "all",
  tabs: [],
  activeTabId: null,
  activePanelTab: "explorer",
  panelVisible: true,
  dashboardLoaded: false,
  dashboardAutoload: false,
  pendingMappingCourse: null,
  mappingPromptedCourses: new Set(),
  downloadDraft: null,
  timelineStatus: {
    state: "idle",
    message: "Timeline loading...",
  },
};

const elements = {
  browserTabStrip: document.querySelector("#browser-tab-strip"),
  browserContent: document.querySelector("#browser-content"),
  addressInput: document.querySelector("#address-input"),
  activeCourseLabel: document.querySelector("#active-course-label"),
  currentDirLabel: document.querySelector("#current-dir-label"),
  rootDirLabel: document.querySelector("#root-dir-label"),
  fileList: document.querySelector("#file-list"),
  mappingList: document.querySelector("#mapping-list"),
  timelineList: document.querySelector("#timeline-list"),
  sidePanel: document.querySelector("#side-panel"),
  workspaceMain: document.querySelector(".workspace-main"),
  explorerPanel: document.querySelector("#explorer-panel"),
  timelinePanel: document.querySelector("#timeline-panel"),
  explorerTabButton: document.querySelector("#side-tab-explorer"),
  timelineTabButton: document.querySelector("#side-tab-timeline"),
  dockToggleButton: document.querySelector("#dock-toggle-button"),
  settingsDialog: document.querySelector("#settings-dialog"),
  mappingDialog: document.querySelector("#mapping-dialog"),
  mappingCourseLabel: document.querySelector("#mapping-course-label"),
  mappingSuggestions: document.querySelector("#mapping-suggestions"),
  dashboardWebview: document.querySelector("#dashboard-webview"),
  toastStack: document.querySelector("#toast-stack"),
  openCoursePageButton: document.querySelector("#open-course-page-button"),
  downloadDialog: document.querySelector("#download-dialog"),
  downloadFolderLabel: document.querySelector("#download-folder-label"),
  downloadFileNameInput: document.querySelector("#download-file-name"),
  downloadChooseFolderButton: document.querySelector("#download-choose-folder-button"),
  downloadUseLessonFolder: document.querySelector("#download-use-lesson-folder"),
  downloadLessonFolder: document.querySelector("#download-lesson-folder"),
  downloadOpenPdfButton: document.querySelector("#download-open-pdf-button"),
  downloadSaveButton: document.querySelector("#download-save-button"),
};

function createId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function toast(message, tone = "info") {
  const item = document.createElement("div");
  item.className = `toast toast-${tone}`;
  item.textContent = message;
  elements.toastStack.appendChild(item);
  setTimeout(() => item.remove(), 4200);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) {
    return state.moodleHome;
  }
  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }
  return `https://${raw}`;
}

function sanitizeFolderName(name) {
  return String(name || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "Unsorted";
}

function sanitizeFileName(name) {
  return String(name || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "download";
}

function normalizeCourseTitle(title) {
  return String(title || "")
    .replace(/\s+/g, " ")
    .replace(/\s*[|:-]\s*Wakayama.*Moodle.*$/i, "")
    .replace(/\s*[|:-]\s*和歌山大学.*Moodle.*$/i, "")
    .replace(/\s*Moodle\d*\s*$/i, "")
    .trim();
}

function deriveCourseNameFromTitle(title) {
  const normalized = normalizeCourseTitle(title);
  const genericTitles = new Set(["", "Dashboard", "Home", "Timeline", "My courses", "ダッシュボード", "ホーム", "タイムライン", "マイコース"]);
  return genericTitles.has(normalized) ? "" : normalized;
}

function extractCourseIdFromUrl(targetUrl) {
  try {
    const parsed = new URL(targetUrl || "");
    return parsed.searchParams.get("id") || "";
  } catch (_error) {
    return "";
  }
}

function getActiveTab() {
  return state.tabs.find((tab) => tab.id === state.activeTabId) ?? null;
}

function findTab(tabId) {
  return state.tabs.find((tab) => tab.id === tabId) || null;
}

function getTabColor(kind) {
  if (kind === "remote-pdf") {
    return "remote-pdf";
  }
  if (kind === "local-pdf") {
    return "local-pdf";
  }
  return "browser";
}

function formatTimestamp(isoString) {
  if (!isoString) {
    return "-";
  }
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return date.toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatFileSize(bytes) {
  if (bytes == null || Number.isNaN(Number(bytes))) {
    return "-";
  }
  const value = Number(bytes);
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function buildLessonOptions() {
  elements.downloadLessonFolder.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "第1回〜第15回を選択";
  elements.downloadLessonFolder.appendChild(placeholder);

  for (let index = 1; index <= 15; index += 1) {
    const option = document.createElement("option");
    option.value = `第${index}回`;
    option.textContent = `第${index}回のフォルダに保存`;
    elements.downloadLessonFolder.appendChild(option);
  }
}

function parseTimelineDate(entry) {
  const haystack = `${entry.title || ""} ${entry.courseName || ""} ${entry.rawText || ""}`;
  const match = haystack.match(/(?:(\d{4})[\/.-])?(\d{1,2})[\/.-](\d{1,2})(?:\s+|.*?)(\d{1,2}):(\d{2})/);
  if (!match) {
    return null;
  }

  const now = new Date();
  const year = Number(match[1] || now.getFullYear());
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const value = new Date(year, month, day, hour, minute);
  return Number.isNaN(value.getTime()) ? null : value;
}

function classifyTimelineEntry(entry) {
  const dueDate = parseTimelineDate(entry);
  if (!dueDate) {
    return { bucket: "other", label: "その他", dueDate: null, badge: "予定", badgeTone: "" };
  }

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(startOfToday);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const threeDays = new Date(startOfToday);
  threeDays.setDate(threeDays.getDate() + 3);
  const week = new Date(startOfToday);
  week.setDate(week.getDate() + 7);

  if (dueDate < now) {
    return { bucket: "expired", label: "期限切れ", dueDate, badge: "締切", badgeTone: "deadline" };
  }
  if (dueDate < tomorrow) {
    return { bucket: "today", label: "今日", dueDate, badge: "今日", badgeTone: "" };
  }
  if (dueDate < new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate() + 1)) {
    return { bucket: "tomorrow", label: "明日", dueDate, badge: "明日", badgeTone: "warn" };
  }
  if (dueDate < threeDays) {
    return { bucket: "3days", label: "3日以内", dueDate, badge: "近日", badgeTone: "warn" };
  }
  if (dueDate < week) {
    return { bucket: "week", label: "今週", dueDate, badge: "今週", badgeTone: "" };
  }

  return { bucket: "later", label: "今後", dueDate, badge: "予定", badgeTone: "" };
}

function matchTimelineFilter(entry) {
  if (state.timelineFilter === "all") {
    return true;
  }
  const meta = classifyTimelineEntry(entry);
  if (state.timelineFilter === "today") {
    return meta.bucket === "today";
  }
  if (state.timelineFilter === "3days") {
    return ["today", "tomorrow", "3days"].includes(meta.bucket);
  }
  if (state.timelineFilter === "week") {
    return ["today", "tomorrow", "3days", "week"].includes(meta.bucket);
  }
  if (state.timelineFilter === "expired") {
    return meta.bucket === "expired";
  }
  return true;
}

function renderSidePanelVisibility() {
  elements.sidePanel.classList.toggle("hidden", !state.panelVisible);
  elements.workspaceMain.classList.toggle("panel-hidden", !state.panelVisible);
  elements.dockToggleButton.classList.toggle("panel-open", state.panelVisible);
  elements.dockToggleButton.textContent = state.panelVisible ? "＞" : "＜";
  positionDockToggle();
}

function positionDockToggle() {
  const dock = elements.dockToggleButton.parentElement;
  if (!dock) {
    return;
  }
  const sidePanelWidth = state.panelVisible ? Math.max(elements.sidePanel.getBoundingClientRect().width, 0) : 0;
  const buttonWidth = elements.dockToggleButton.getBoundingClientRect().width || 42;
  dock.style.right = state.panelVisible ? `${Math.max(Math.round(sidePanelWidth - buttonWidth), 0)}px` : "0px";
}

function renderPanelTabs() {
  const explorerActive = state.activePanelTab === "explorer";
  elements.explorerTabButton.classList.toggle("active", explorerActive);
  elements.timelineTabButton.classList.toggle("active", !explorerActive);
  elements.explorerPanel.classList.toggle("active", explorerActive);
  elements.timelinePanel.classList.toggle("active", !explorerActive);
}

function setPanelTab(tabName) {
  state.activePanelTab = tabName;
  state.panelVisible = true;
  renderSidePanelVisibility();
  renderPanelTabs();
  if (tabName === "timeline") {
    ensureDashboardLoaded();
  }
}

function syncAddressBar() {
  const activeTab = getActiveTab();
  elements.addressInput.value = activeTab?.url || activeTab?.path || "";
}

function createBrowserTab(url, title = UI_TEXT.defaultBrowserTitle) {
  const tab = {
    id: createId("browser"),
    kind: "browser",
    title,
    url: normalizeUrl(url),
    courseName: "",
    courseId: "",
    courseUrl: "",
    contentEl: null,
    webviewEl: null,
    webContentsId: null,
  };
  state.tabs.push(tab);
  mountTab(tab);
  activateTab(tab.id);
}

function createLocalPdfTab(filePath, title) {
  const tab = {
    id: createId("pdf-local"),
    kind: "local-pdf",
    title,
    path: filePath,
    courseName: getActiveTab()?.courseName || "",
    courseUrl: getActiveTab()?.courseUrl || "",
    contentEl: null,
  };
  state.tabs.push(tab);
  mountTab(tab);
  activateTab(tab.id);
}

function createRemotePdfTab(pdfUrl, title, sourceTab) {
  const tab = {
    id: createId("pdf-remote"),
    kind: "remote-pdf",
    title,
    url: pdfUrl,
    courseName: sourceTab?.courseName || "",
    courseId: sourceTab?.courseId || "",
    courseUrl: sourceTab?.courseUrl || sourceTab?.url || "",
    contentEl: null,
    webviewEl: null,
    webContentsId: null,
  };
  state.tabs.push(tab);
  mountTab(tab);
  activateTab(tab.id);
}

function closeTab(tabId) {
  const tab = state.tabs.find((entry) => entry.id === tabId);
  if (!tab) {
    return;
  }

  if (tab.webContentsId) {
    window.fuzzyApi.unregisterWebview({
      tabId: tab.id,
      webContentsId: tab.webContentsId,
    });
  }

  tab.contentEl?.remove();
  state.tabs = state.tabs.filter((entry) => entry.id !== tabId);

  if (!state.tabs.length) {
    createBrowserTab(state.moodleHome, UI_TEXT.defaultBrowserTitle);
    return;
  }

  if (state.activeTabId === tabId) {
    state.activeTabId = state.tabs.at(-1).id;
  }

  activateTab(state.activeTabId);
}

function ensureDashboardLoaded() {
  if (state.dashboardLoaded) {
    return;
  }
  state.timelineStatus = {
    state: "loading",
    message: "Dashboard timeline loading...",
  };
  renderTimeline();
  elements.dashboardWebview.src = state.dashboardUrl;
  state.dashboardLoaded = true;
  scheduleDashboardTimelinePull();
}

function isLoggedInMoodleHome(context) {
  try {
    const parsed = new URL(context.url || "");
    if (!/moodle(?:\d{4})?\.wakayama-u\.ac\.jp$/i.test(parsed.hostname)) {
      return false;
    }

    const path = parsed.pathname.toLowerCase();
    const title = (context.title || "").toLowerCase();
    return (
      path === "/2026/" ||
      path.endsWith("/my/") ||
      path.endsWith("/my/index.php") ||
      title.includes("dashboard") ||
      title.includes("home")
    );
  } catch (_error) {
    return false;
  }
}

async function enableDashboardAutoload() {
  if (!state.dashboardAutoload) {
    state.dashboardAutoload = true;
    await window.fuzzyApi.updatePreferences({
      dashboardAutoload: true,
    });
  }
  if (!state.dashboardLoaded) {
    ensureDashboardLoaded();
    return;
  }

  state.timelineStatus = {
    state: "loading",
    message: "Refreshing dashboard session...",
  };
  renderTimeline();
  try {
    elements.dashboardWebview.loadURL(state.dashboardUrl);
    scheduleDashboardTimelinePull();
  } catch (_error) {
    // Ignore refresh failures; the next manual refresh can retry.
  }
}

function scheduleDashboardRefresh() {
  if (!state.dashboardLoaded) {
    return;
  }
  clearTimeout(scheduleDashboardRefresh.timer);
  scheduleDashboardRefresh.timer = setTimeout(() => {
    try {
      elements.dashboardWebview.loadURL(state.dashboardUrl);
      scheduleDashboardTimelinePull();
    } catch (_error) {
      // Ignore refresh failures.
    }
  }, 400);
}

function scheduleDashboardTimelinePull() {
  clearTimeout(scheduleDashboardTimelinePull.timer);
  scheduleDashboardTimelinePull.timer = setTimeout(async () => {
    try {
      const result = await elements.dashboardWebview.executeJavaScript(`
        (() => {
          const selectors = [
            "[data-region*='timeline'] a[href]",
            "[data-region='event-list-content'] a[href]",
            "[data-region='event-list-item'] a[href]",
            ".block_timeline a[href]",
            ".timeline a[href]",
            "[data-block='timeline'] a[href]",
            ".event-list-item a[href]",
            ".block_calendar_upcoming a[href]",
            ".activity-name a[href]"
          ];
          const anchors = selectors.flatMap((selector) => [...document.querySelectorAll(selector)]);
          const seen = new Set();
          const items = anchors.flatMap((anchor) => {
            const href = anchor.href;
            const label = (anchor.textContent || "").trim().replace(/\\s+/g, " ");
            if (!href || !label || seen.has(href)) {
              return [];
            }
            seen.add(href);
            const container = anchor.closest("li, article, .event, .list-group-item, .activity-item, tr, .timeline-event");
            const nearbyText = (container?.textContent || "").replace(/\\s+/g, " ").trim();
            const match = href.match(/[?&]id=(\\d+)/);
            return [{
              id: href + "::" + label,
              href,
              title: label,
              courseName: nearbyText.replace(label, "").trim().slice(0, 120),
              courseId: match ? match[1] : "",
              rawText: nearbyText
            }];
          });
          return {
            title: document.title,
            url: location.href,
            hasLoginForm: Boolean(document.querySelector("form[action*='login'], input[type='password']")),
            items
          };
        })();
      `, true);
      if (result?.hasLoginForm) {
        state.timelineEntries = [];
        state.timelineStatus = {
          state: "needs-login",
          message: "Background dashboard is showing the login page.",
        };
        renderTimeline();
        return;
      }

      state.timelineEntries = Array.isArray(result?.items) ? result.items : [];
      state.timelineStatus = state.timelineEntries.length
        ? { state: "ready", message: "" }
        : { state: "empty", message: `No timeline items found on: ${result?.title || "unknown page"}` };
      renderTimeline();
    } catch (_error) {
      state.timelineEntries = [];
      state.timelineStatus = {
        state: "error",
        message: "Timeline scrape failed.",
      };
      renderTimeline();
    }
  }, 900);
}

function navigateCurrentBrowserTab(url, title = UI_TEXT.defaultBrowserTitle) {
  const activeTab = getActiveTab();
  if (activeTab?.kind === "browser" && activeTab.webviewEl) {
    activeTab.title = title;
    activeTab.url = normalizeUrl(url);
    activeTab.webviewEl.loadURL(activeTab.url);
    renderBrowserTabs();
    return;
  }
  createBrowserTab(url, title);
}

function findMappingForCourse(courseName) {
  return state.mappings.find((entry) => entry.courseName === courseName) || null;
}

function findMappingForPath(targetPath) {
  const matches = state.mappings.filter((entry) => {
    const normalizedPath = targetPath.toLowerCase();
    const mappingPath = entry.folderPath.toLowerCase();
    return normalizedPath === mappingPath || normalizedPath.startsWith(`${mappingPath.toLowerCase()}\\`);
  });

  if (!matches.length) {
    return null;
  }

  return matches.sort((left, right) => right.folderPath.length - left.folderPath.length)[0];
}

async function ensureCourseMapping(tab) {
  if (!tab?.courseName || findMappingForCourse(tab.courseName) || state.mappingPromptedCourses.has(tab.courseName)) {
    return;
  }

  state.mappingPromptedCourses.add(tab.courseName);
  state.pendingMappingCourse = {
    courseName: tab.courseName,
    courseUrl: tab.courseUrl || tab.url || "",
  };

  const prepared = await window.fuzzyApi.prepareMapping({
    courseName: tab.courseName,
    courseUrl: tab.courseUrl || tab.url || "",
  });

  if (prepared.existing) {
    state.mappingPromptedCourses.delete(tab.courseName);
    return;
  }

  elements.mappingCourseLabel.textContent = `${tab.courseName} に対応するフォルダを選んでください。`;
  elements.mappingSuggestions.innerHTML = "";

  for (const suggestion of prepared.suggestions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "suggestion-item";
    button.innerHTML = `
      <strong>${escapeHtml(suggestion.folderName)}</strong>
      <small>一致度 ${Math.round(suggestion.score * 100)}%</small>
    `;
    button.addEventListener("click", async () => {
      await saveMapping(tab.courseName, suggestion.folderPath, "similarity", tab.courseUrl || tab.url || "");
      elements.mappingDialog.close();
    });
    elements.mappingSuggestions.appendChild(button);
  }

  elements.mappingDialog.dataset.suggestedFolderPath = prepared.suggestedFolderPath;
  elements.mappingDialog.showModal();
}

function mountBrowserLikeTab(tab, usePreload = true) {
  const contentEl = document.createElement("div");
  contentEl.className = "browser-surface";

  const webview = document.createElement("webview");
  webview.className = "browser-view";
  webview.src = tab.url;
  webview.partition = "persist:fuzzy";
  if (usePreload) {
    webview.preload = PRELOAD_PATH;
  }
  webview.setAttribute("allowpopups", "true");

  webview.addEventListener("did-finish-load", () => {
    syncTabFromWebview(tab);
  });

  webview.addEventListener("did-navigate", () => {
    syncTabFromWebview(tab);
  });

  webview.addEventListener("did-navigate-in-page", () => {
    syncTabFromWebview(tab);
  });

  webview.addEventListener("dom-ready", () => {
    const webContentsId = webview.getWebContentsId();
    tab.webContentsId = webContentsId;
    window.fuzzyApi.registerWebview({
      tabId: tab.id,
      webContentsId,
    });
  });

  tab.webviewEl = webview;
  tab.contentEl = contentEl;
  contentEl.appendChild(webview);
  elements.browserContent.appendChild(contentEl);
}

function syncTabFromWebview(tab) {
  if (!tab.webviewEl) {
    return;
  }

  tab.url = tab.webviewEl.getURL();
  const htmlTitle = tab.webviewEl.getTitle() || tab.title;
  const courseName = deriveCourseNameFromTitle(htmlTitle);
  tab.courseName = courseName;
  tab.courseId = extractCourseIdFromUrl(tab.url);
  tab.courseUrl = tab.url;
  tab.title = courseName || htmlTitle || tab.title;

  window.fuzzyApi.updateTabContext({
    tabId: tab.id,
    context: {
      url: tab.url,
      title: htmlTitle,
      courseName,
      courseId: tab.courseId,
    },
  });

  if (tab.id === state.activeTabId) {
    void updateCurrentCourse(tab);
    syncAddressBar();
  }

  renderBrowserTabs();

  if (isLoggedInMoodleHome({ url: tab.url, title: htmlTitle })) {
    void enableDashboardAutoload();
  }

  if (courseName) {
    void ensureCourseMapping(tab);
  }
}

function mountLocalPdfTab(tab) {
  const contentEl = document.createElement("div");
  contentEl.className = "browser-surface";
  const frame = document.createElement("iframe");
  frame.className = "pdf-frame";
  frame.src = `file:///${tab.path.replace(/\\/g, "/")}`;
  contentEl.appendChild(frame);
  tab.contentEl = contentEl;
  elements.browserContent.appendChild(contentEl);
}

function mountTab(tab) {
  if (tab.contentEl) {
    return;
  }
  if (tab.kind === "browser") {
    mountBrowserLikeTab(tab, true);
    return;
  }
  if (tab.kind === "remote-pdf") {
    mountBrowserLikeTab(tab, false);
    return;
  }
  if (tab.kind === "local-pdf") {
    mountLocalPdfTab(tab);
  }
}

function renderBrowserTabs() {
  elements.browserTabStrip.innerHTML = "";
  for (const tab of state.tabs) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `browser-tab ${tab.id === state.activeTabId ? "active" : ""}`;
    button.dataset.tabId = tab.id;
    button.innerHTML = `
      <span class="tab-dot ${getTabColor(tab.kind)}"></span>
      <span class="tab-title">${escapeHtml(tab.title || UI_TEXT.defaultBrowserTitle)}</span>
      <span class="tab-close" data-close-tab="${tab.id}">×</span>
    `;
    elements.browserTabStrip.appendChild(button);
  }

  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.className = "browser-tab";
  addButton.dataset.addTab = "true";
  addButton.innerHTML = `<span class="tab-title">＋</span>`;
  elements.browserTabStrip.appendChild(addButton);
}

function activateTab(tabId) {
  state.activeTabId = tabId;
  for (const tab of state.tabs) {
    tab.contentEl?.classList.toggle("active", tab.id === tabId);
  }
  renderBrowserTabs();
  syncAddressBar();
  void updateCurrentCourse(getActiveTab());
}

async function updateCurrentCourse(tab) {
  const courseName = tab?.courseName || UI_TEXT.noCourse;
  elements.activeCourseLabel.textContent = courseName;

  if (tab?.courseName) {
    const mapping = findMappingForCourse(tab.courseName);
    if (mapping) {
      await loadDirectory(mapping.folderPath, { syncBrowserFromDirectory: false });
    } else {
      await ensureCourseMapping(tab);
    }
  }

  renderTimeline();
}

function renderDirectory(entries) {
  elements.fileList.innerHTML = "";
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = UI_TEXT.emptyFiles;
    elements.fileList.appendChild(empty);
    return;
  }

  for (const entry of entries) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "file-row";
    row.innerHTML = `
      <span class="file-name-cell">
        <span class="file-icon">${entry.isDirectory ? "📁" : entry.name.toLowerCase().endsWith(".pdf") ? "📄" : "🗎"}</span>
        <span class="file-name-text">${escapeHtml(entry.name)}</span>
      </span>
      <span class="file-meta-text">${formatTimestamp(entry.modifiedAt)}</span>
      <span class="file-meta-text">${entry.isDirectory ? "-" : formatFileSize(entry.size)}</span>
    `;

    row.addEventListener("click", async () => {
      if (entry.isDirectory) {
        await loadDirectory(entry.path, { syncBrowserFromDirectory: true });
        return;
      }
      if (entry.name.toLowerCase().endsWith(".pdf")) {
        createLocalPdfTab(entry.path, entry.name);
        return;
      }
      toast(UI_TEXT.localOnly, "info");
    });

    elements.fileList.appendChild(row);
  }
}

function renderMappings() {
  elements.mappingList.innerHTML = "";
  if (!state.mappings.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = UI_TEXT.emptyMappings;
    elements.mappingList.appendChild(empty);
    return;
  }

  for (const mapping of state.mappings) {
    const item = document.createElement("div");
    item.className = "mapping-item";
    item.innerHTML = `
      <strong>${escapeHtml(mapping.courseName)}</strong>
      <small>${escapeHtml(mapping.folderPath)}</small>
    `;
    elements.mappingList.appendChild(item);
  }
}

function renderTimeline() {
  elements.timelineList.innerHTML = "";
  const activeTab = getActiveTab();
  const entries = state.timelineEntries.filter(matchTimelineFilter);

  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = state.timelineStatus.message || UI_TEXT.emptyTimeline;
    elements.timelineList.appendChild(empty);
    return;
  }

  const groups = new Map();
  for (const entry of entries) {
    const meta = classifyTimelineEntry(entry);
    const key = meta.label;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push({ entry, meta });
  }

  for (const [label, items] of groups) {
    const group = document.createElement("div");
    group.className = "timeline-group";

    const title = document.createElement("div");
    title.className = "timeline-group-title";
    title.textContent = label;
    group.appendChild(title);

    for (const { entry, meta } of items) {
      const card = document.createElement("button");
      card.type = "button";
      const isActive = Boolean(activeTab?.courseId && entry.courseId && activeTab.courseId === entry.courseId);
      card.className = `timeline-card ${isActive ? "active-course" : ""}`;
      card.innerHTML = `
        <div class="timeline-card-top">
          <span class="timeline-badge ${meta.badgeTone}">${escapeHtml(meta.badge)}</span>
          <span class="timeline-card-meta">${meta.dueDate ? formatTimestamp(meta.dueDate.toISOString()) : ""}</span>
        </div>
        <div class="timeline-card-title">${escapeHtml(entry.title)}</div>
        <div class="timeline-card-course">${escapeHtml(entry.courseName || UI_TEXT.noCourse)}</div>
      `;
      card.addEventListener("click", () => {
        navigateCurrentBrowserTab(entry.href, entry.courseName || entry.title || UI_TEXT.defaultBrowserTitle);
        setPanelTab("timeline");
      });
      group.appendChild(card);
    }

    elements.timelineList.appendChild(group);
  }
}

async function loadDirectory(targetPath, options = {}) {
  const { syncBrowserFromDirectory = false } = options;
  const result = await window.fuzzyApi.listDirectory(targetPath);
  state.rootDir = result.rootDir;
  state.currentDir = result.currentDir;
  elements.rootDirLabel.textContent = state.rootDir || UI_TEXT.rootUnset;
  elements.currentDirLabel.textContent = state.currentDir || UI_TEXT.rootUnset;
  renderDirectory(result.entries);

  if (syncBrowserFromDirectory) {
    const mapping = findMappingForPath(result.currentDir);
    if (mapping) {
      const activeTab = getActiveTab();
      if (mapping.courseUrl && activeTab?.courseUrl !== mapping.courseUrl) {
        navigateCurrentBrowserTab(mapping.courseUrl, mapping.courseName || UI_TEXT.defaultBrowserTitle);
      }
      elements.activeCourseLabel.textContent = mapping.courseName || UI_TEXT.noCourse;
    }
  }
}

async function saveMapping(courseName, folderPath, matchType, courseUrl) {
  const mapping = await window.fuzzyApi.saveMapping({
    courseName,
    folderPath,
    courseUrl,
    matchType,
  });

  const index = state.mappings.findIndex((entry) => entry.courseName === mapping.courseName);
  if (index >= 0) {
    state.mappings[index] = mapping;
  } else {
    state.mappings.push(mapping);
  }

  state.mappingPromptedCourses.delete(courseName);
  renderMappings();
  await loadDirectory(mapping.folderPath, { syncBrowserFromDirectory: false });
  toast("コース紐づけを保存しました", "success");
  return mapping;
}

function getMappedFolderForContext(courseName) {
  if (courseName) {
    const mapping = findMappingForCourse(courseName);
    if (mapping) {
      return mapping.folderPath;
    }
  }
  if (state.currentDir) {
    const mapping = findMappingForPath(state.currentDir);
    if (mapping) {
      return mapping.folderPath;
    }
  }
  return state.currentDir || state.rootDir;
}

function showDownloadDialog(payload, tab) {
  const baseFolder = getMappedFolderForContext(payload.courseName || tab.courseName);
  if (!baseFolder) {
    toast("先に保存ルートを設定してください", "warn");
    return;
  }

  state.downloadDraft = {
    tabId: tab.id,
    url: payload.url,
    fileName: sanitizeFileName(payload.fileName || payload.label || "download"),
    folderPath: baseFolder,
    courseName: payload.courseName || tab.courseName || "",
  };

  elements.downloadFolderLabel.textContent = state.downloadDraft.folderPath;
  elements.downloadFileNameInput.value = state.downloadDraft.fileName;
  elements.downloadUseLessonFolder.checked = false;
  elements.downloadLessonFolder.disabled = true;
  elements.downloadLessonFolder.value = "";
  elements.downloadOpenPdfButton.disabled = !/\.pdf(\?|$)/i.test(payload.url);
  elements.downloadDialog.showModal();
}

function setupDashboardWebview() {
  elements.dashboardWebview.addEventListener("did-finish-load", scheduleDashboardTimelinePull);
  elements.dashboardWebview.addEventListener("did-navigate", scheduleDashboardTimelinePull);
  elements.dashboardWebview.addEventListener("did-navigate-in-page", scheduleDashboardTimelinePull);
}

function wireEvents() {
  document.querySelector(".browser-toolbar").addEventListener("click", (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) {
      return;
    }

    const currentTab = getActiveTab();
    const action = target.dataset.action;
    if (!currentTab?.webviewEl) {
      return;
    }

    if (action === "back" && currentTab.webviewEl.canGoBack()) {
      currentTab.webviewEl.goBack();
      return;
    }
    if (action === "forward" && currentTab.webviewEl.canGoForward()) {
      currentTab.webviewEl.goForward();
      return;
    }
    if (action === "reload") {
      currentTab.webviewEl.reload();
      return;
    }
    if (action === "favorite") {
      toast("お気に入り機能はまだ未実装です", "info");
      return;
    }
    if (action === "menu") {
      elements.settingsDialog.showModal();
    }
  });

  elements.addressInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") {
      return;
    }
    navigateCurrentBrowserTab(event.currentTarget.value, UI_TEXT.defaultBrowserTitle);
  });

  elements.browserTabStrip.addEventListener("click", (event) => {
    const closeTarget = event.target.closest("[data-close-tab]");
    if (closeTarget) {
      closeTab(closeTarget.dataset.closeTab);
      return;
    }

    const addTarget = event.target.closest("[data-add-tab]");
    if (addTarget) {
      createBrowserTab(state.moodleHome, UI_TEXT.defaultBrowserTitle);
      return;
    }

    const tabTarget = event.target.closest("[data-tab-id]");
    if (tabTarget) {
      activateTab(tabTarget.dataset.tabId);
    }
  });

  document.querySelector("#new-tab-button").addEventListener("click", () => {
    createBrowserTab(state.moodleHome, UI_TEXT.defaultBrowserTitle);
  });

  document.querySelector("#batch-download-button").addEventListener("click", async () => {
    const currentTab = getActiveTab();
    if (!currentTab || currentTab.kind !== "browser") {
      toast("一括ダウンロードは Moodle タブで使ってください", "warn");
      return;
    }
    const result = await window.fuzzyApi.requestBatchDownload(currentTab.id);
    toast(`${result.queued} 件のダウンロードを開始しました`, "success");
  });

  document.querySelector("#refresh-directory-button").addEventListener("click", async () => {
    await loadDirectory(state.currentDir || state.rootDir, { syncBrowserFromDirectory: false });
  });

  async function chooseRootDirectory() {
    const next = await window.fuzzyApi.chooseRootDirectory();
    state.rootDir = next.rootDir;
    state.currentDir = next.directory.currentDir;
    state.mappings = next.mappings;
    elements.rootDirLabel.textContent = next.rootDir || UI_TEXT.rootUnset;
    elements.currentDirLabel.textContent = next.directory.currentDir || UI_TEXT.rootUnset;
    renderDirectory(next.directory.entries);
    renderMappings();
    toast("保存ルートを更新しました", "success");
  }

  document.querySelector("#choose-root-button").addEventListener("click", chooseRootDirectory);
  document.querySelector("#dialog-choose-root-button").addEventListener("click", chooseRootDirectory);

  document.querySelector("#open-settings-button").addEventListener("click", () => {
    elements.settingsDialog.showModal();
  });

  document.querySelector("#mapping-create-folder").addEventListener("click", async () => {
    if (!state.pendingMappingCourse) {
      return;
    }
    const mapping = await window.fuzzyApi.createDefaultFolderMapping(state.pendingMappingCourse);
    const index = state.mappings.findIndex((entry) => entry.courseName === mapping.courseName);
    if (index >= 0) {
      state.mappings[index] = mapping;
    } else {
      state.mappings.push(mapping);
    }
    state.mappingPromptedCourses.delete(mapping.courseName);
    renderMappings();
    await loadDirectory(mapping.folderPath, { syncBrowserFromDirectory: false });
    elements.mappingDialog.close();
    toast("コース用フォルダを作成しました", "success");
  });

  document.querySelector("#mapping-choose-folder").addEventListener("click", async () => {
    if (!state.pendingMappingCourse) {
      return;
    }
    try {
      const folderPath = await window.fuzzyApi.chooseFolderForMapping();
      if (!folderPath) {
        return;
      }
      await saveMapping(
        state.pendingMappingCourse.courseName,
        folderPath,
        "manual",
        state.pendingMappingCourse.courseUrl,
      );
      elements.mappingDialog.close();
    } catch (error) {
      toast(error.message, "error");
    }
  });

  elements.explorerTabButton.addEventListener("click", () => setPanelTab("explorer"));
  elements.timelineTabButton.addEventListener("click", () => setPanelTab("timeline"));
  elements.dockToggleButton.addEventListener("click", () => {
    state.panelVisible = !state.panelVisible;
    renderSidePanelVisibility();
  });
  document.querySelector("#hide-side-panel-button").addEventListener("click", () => {
    state.panelVisible = false;
    renderSidePanelVisibility();
  });

  elements.openCoursePageButton.addEventListener("click", () => {
    const activeTab = getActiveTab();
    if (!activeTab?.courseUrl) {
      toast("このタブに対応する LMS ページがありません", "warn");
      return;
    }
    navigateCurrentBrowserTab(activeTab.courseUrl, activeTab.courseName || UI_TEXT.defaultBrowserTitle);
  });

  document.querySelector("#timeline-refresh-button").addEventListener("click", () => {
    ensureDashboardLoaded();
    scheduleDashboardRefresh();
  });

  document.querySelector(".timeline-filters").addEventListener("click", (event) => {
    const button = event.target.closest("[data-filter]");
    if (!button) {
      return;
    }
    state.timelineFilter = button.dataset.filter;
    for (const chip of document.querySelectorAll(".filter-chip")) {
      chip.classList.toggle("active", chip.dataset.filter === state.timelineFilter);
    }
    renderTimeline();
  });

  elements.downloadUseLessonFolder.addEventListener("change", (event) => {
    elements.downloadLessonFolder.disabled = !event.currentTarget.checked;
  });

  elements.downloadChooseFolderButton.addEventListener("click", async () => {
    try {
      const folderPath = await window.fuzzyApi.chooseFolderForMapping();
      if (!folderPath || !state.downloadDraft) {
        return;
      }
      state.downloadDraft.folderPath = folderPath;
      elements.downloadFolderLabel.textContent = folderPath;
    } catch (error) {
      toast(error.message, "error");
    }
  });

  elements.downloadOpenPdfButton.addEventListener("click", () => {
    if (!state.downloadDraft) {
      return;
    }
    createRemotePdfTab(state.downloadDraft.url, state.downloadDraft.fileName, getActiveTab());
    elements.downloadDialog.close();
  });

  elements.downloadSaveButton.addEventListener("click", async () => {
    if (!state.downloadDraft) {
      return;
    }
    const lessonFolder = elements.downloadUseLessonFolder.checked ? elements.downloadLessonFolder.value : "";
    if (elements.downloadUseLessonFolder.checked && !lessonFolder) {
      toast("保存先の第○回フォルダを選んでください", "warn");
      return;
    }
    await window.fuzzyApi.startCustomDownload({
      tabId: state.downloadDraft.tabId,
      url: state.downloadDraft.url,
      folderPath: state.downloadDraft.folderPath,
      fileName: sanitizeFileName(elements.downloadFileNameInput.value),
      lessonFolder,
    });
    elements.downloadDialog.close();
  });

  window.addEventListener("resize", positionDockToggle);
}

async function initialize() {
  buildLessonOptions();

  const defaults = await window.fuzzyApi.getDefaults();
  state.moodleHome = defaults.moodleHome;
  state.dashboardUrl = new URL("./my/", state.moodleHome).toString();
  state.dashboardAutoload = Boolean(defaults.dashboardAutoload);

  const initial = await window.fuzzyApi.getState();
  state.rootDir = initial.rootDir;
  state.currentDir = initial.directory.currentDir;
  state.mappings = initial.mappings;

  elements.rootDirLabel.textContent = initial.rootDir || UI_TEXT.rootUnset;
  elements.currentDirLabel.textContent = initial.directory.currentDir || UI_TEXT.rootUnset;

  renderDirectory(initial.directory.entries);
  renderMappings();
  renderSidePanelVisibility();
  renderPanelTabs();
  setupDashboardWebview();
  wireEvents();

  if (state.dashboardAutoload) {
    ensureDashboardLoaded();
  }

  createBrowserTab(state.moodleHome, UI_TEXT.defaultBrowserTitle);
}

window.fuzzyApi.onDownloadEvent(async (payload) => {
  if (payload.type === "started") {
    toast(`${payload.fileName} を保存中です`, "info");
    if (payload.requiresReview && payload.courseName) {
      const activeTab = getActiveTab();
      if (activeTab?.courseName === payload.courseName) {
        await ensureCourseMapping(activeTab);
      }
    }
    return;
  }
  if (payload.type === "completed") {
    toast(`${payload.fileName} を保存しました`, "success");
    await loadDirectory(state.currentDir || state.rootDir, { syncBrowserFromDirectory: false });
    return;
  }
  if (payload.type === "blocked") {
    toast(payload.message, "warn");
    return;
  }
  if (payload.type === "interrupted") {
    toast(`${payload.fileName} の保存に失敗しました`, "error");
  }
});

window.fuzzyApi.onOpenCourseTab((payload) => {
  createBrowserTab(payload.courseUrl, payload.courseName || UI_TEXT.defaultBrowserTitle);
});

window.fuzzyApi.onOpenRemotePdf((payload) => {
  createRemotePdfTab(payload.pdfUrl, payload.fileName, getActiveTab());
});

window.fuzzyApi.onDownloadPrompt((payload) => {
  const tab = findTab(payload.tabId) || getActiveTab();
  if (!tab) {
    return;
  }
  showDownloadDialog({
    url: payload.url,
    fileName: payload.fileName,
    label: payload.label,
    courseName: tab.courseName,
  }, tab);
});

initialize();
