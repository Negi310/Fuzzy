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
  tabs: [],
  activeTabId: null,
  activePanelTab: "explorer",
  panelVisible: true,
  dashboardLoaded: false,
  dashboardAutoload: false,
  pendingMappingCourse: null,
  mappingPromptedCourses: new Set(),
  downloadDraft: null,
  contextMenu: null,
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
  openSubmissionFolderButton: document.querySelector("#open-submission-folder-button"),
  downloadDialog: document.querySelector("#download-dialog"),
  downloadFolderLabel: document.querySelector("#download-folder-label"),
  downloadFileNameInput: document.querySelector("#download-file-name"),
  downloadChooseFolderButton: document.querySelector("#download-choose-folder-button"),
  downloadSaveButton: document.querySelector("#download-save-button"),
  contextMenuBackdrop: document.querySelector("#context-menu-backdrop"),
  contextMenu: document.querySelector("#context-menu"),
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

function hideContextMenu() {
  state.contextMenu = null;
  elements.contextMenuBackdrop.classList.add("hidden");
  elements.contextMenuBackdrop.setAttribute("aria-hidden", "true");
  elements.contextMenu.classList.add("hidden");
  elements.contextMenu.setAttribute("aria-hidden", "true");
  elements.contextMenu.innerHTML = "";
}

function renderContextMenuItems(items, level = 0) {
  for (const item of items) {
    if (item.children?.length) {
      const row = document.createElement("div");
      row.className = `context-menu-row ${item.tone || ""}`.trim();
      row.style.paddingLeft = `${12 + level * 16}px`;

      const actionButton = document.createElement("button");
      actionButton.type = "button";
      actionButton.className = "context-menu-item context-menu-main";
      actionButton.textContent = item.label;
      actionButton.addEventListener("click", async () => {
        hideContextMenu();
        await item.action();
      });

      const toggleButton = document.createElement("button");
      toggleButton.type = "button";
      toggleButton.className = "context-menu-toggle";
      toggleButton.textContent = item.expanded ? "V" : ">";
      toggleButton.addEventListener("click", (event) => {
        event.stopPropagation();
        item.expanded = !item.expanded;
        elements.contextMenu.innerHTML = "";
        renderContextMenuItems(state.contextMenu.items);
      });

      row.appendChild(actionButton);
      row.appendChild(toggleButton);
      elements.contextMenu.appendChild(row);
    } else {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `context-menu-item ${item.tone || ""}`.trim();
      if (level > 0) {
        button.classList.add("context-menu-subitem");
      }
      button.textContent = item.label;
      button.style.paddingLeft = `${12 + level * 16}px`;
      button.addEventListener("click", async () => {
        hideContextMenu();
        await item.action();
      });
      elements.contextMenu.appendChild(button);
    }

    if (item.children?.length && item.expanded) {
      renderContextMenuItems(item.children, level + 1);
    }
  }
}

function showContextMenu(items, x, y) {
  state.contextMenu = { items };
  elements.contextMenu.innerHTML = "";
  renderContextMenuItems(items);

  elements.contextMenuBackdrop.classList.remove("hidden");
  elements.contextMenuBackdrop.setAttribute("aria-hidden", "false");
  elements.contextMenu.classList.remove("hidden");
  elements.contextMenu.setAttribute("aria-hidden", "false");

  const menuWidth = 240;
  const menuHeight = Math.min(window.innerHeight - 24, elements.contextMenu.scrollHeight + 16);
  const left = Math.min(x, window.innerWidth - menuWidth - 12);
  const top = Math.min(y, window.innerHeight - menuHeight - 12);
  elements.contextMenu.style.left = `${Math.max(left, 12)}px`;
  elements.contextMenu.style.top = `${Math.max(top, 12)}px`;
}

function closestFromEventTarget(target, selector) {
  return target instanceof Element ? target.closest(selector) : null;
}

function isWakayamaMoodleUrl(targetUrl) {
  try {
    const parsed = new URL(targetUrl || "");
    return /moodle(?:\d{4})?\.wakayama-u\.ac\.jp$/i.test(parsed.hostname);
  } catch (_error) {
    return false;
  }
}

function classifyMoodlePage(context) {
  try {
    const parsed = new URL(context?.url || "");
    if (!/moodle(?:\d{4})?\.wakayama-u\.ac\.jp$/i.test(parsed.hostname)) {
      return "outside";
    }

    const pathname = parsed.pathname.toLowerCase();
    const title = normalizeCourseTitle(context?.title || "").toLowerCase();
    if (pathname === "/2026" || pathname === "/2026/") {
      return "home";
    }
    if (
      pathname.endsWith("/my/") ||
      pathname.endsWith("/my/index.php") ||
      pathname.endsWith("/course/index.php") ||
      title === "dashboard" ||
      title === "home" ||
      title === "my courses" ||
      title === "ダッシュボード" ||
      title === "ホーム" ||
      title === "マイコース"
    ) {
      return "generic";
    }
    if (pathname.endsWith("/course/view.php") && parsed.searchParams.get("id")) {
      return "course";
    }
    return "other";
  } catch (_error) {
    return "outside";
  }
}

function shouldPromptForCourseMapping(tab) {
  return classifyMoodlePage({
    url: tab?.courseUrl || tab?.url || "",
    title: tab?.title || "",
  }) === "course";
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
  if (kind === "remote-file") {
    return "remote-pdf";
  }
  if (kind === "local-pdf") {
    return "local-pdf";
  }
  if (kind === "local-file") {
    return "local-pdf";
  }
  return "browser";
}

function encodeFileUrl(targetPath) {
  return encodeURI(`file:///${String(targetPath || "").replace(/\\/g, "/")}`);
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

function splitPathSegments(targetPath) {
  const resolved = String(targetPath || "").replace(/\//g, "\\");
  if (!resolved) {
    return [];
  }

  const match = resolved.match(/^([A-Za-z]:)(\\.*)?$/);
  if (!match) {
    return [{ label: resolved, path: resolved }];
  }

  const drive = match[1];
  const rest = match[2] || "";
  const names = rest.split("\\").filter(Boolean);
  const segments = [{ label: drive, path: `${drive}\\` }];
  let currentPath = `${drive}\\`;
  for (const name of names) {
    currentPath = currentPath.endsWith("\\") ? `${currentPath}${name}` : `${currentPath}\\${name}`;
    segments.push({
      label: name,
      path: currentPath,
    });
  }
  return segments;
}

function renderCurrentPath(targetPath) {
  elements.currentDirLabel.innerHTML = "";
  const segments = splitPathSegments(targetPath);
  if (!segments.length) {
    elements.currentDirLabel.textContent = UI_TEXT.rootUnset;
    return;
  }

  for (const [index, segment] of segments.entries()) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `path-segment ${index === segments.length - 1 ? "current" : ""}`.trim();
    button.textContent = segment.label;
    button.title = segment.path;
    button.addEventListener("click", async () => {
      await loadDirectory(segment.path, { syncBrowserFromDirectory: false });
    });
    elements.currentDirLabel.appendChild(button);

    if (index < segments.length - 1) {
      const separator = document.createElement("span");
      separator.className = "path-separator";
      separator.textContent = "›";
      elements.currentDirLabel.appendChild(separator);
    }
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

function shouldHideTimelineEntry(entry) {
  const title = String(entry?.title || "").trim();
  return (
    !title ||
    title === "すべて" ||
    title.includes("日付で並び替える") ||
    title.includes("コースで並び替える") ||
    title.includes("提出をアップロード・入力する")
  );
}

function compareTimelineEntries(left, right) {
  const leftMeta = classifyTimelineEntry(left);
  const rightMeta = classifyTimelineEntry(right);
  const leftTime = leftMeta.dueDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
  const rightTime = rightMeta.dueDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  const courseOrder = String(left.courseName || "").localeCompare(String(right.courseName || ""), "ja");
  if (courseOrder !== 0) {
    return courseOrder;
  }

  return String(left.title || "").localeCompare(String(right.title || ""), "ja");
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

function createRemoteFileTab(fileUrl, title, sourceTab) {
  const tab = {
    id: createId("file-remote"),
    kind: "remote-file",
    title,
    url: fileUrl,
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

  try {
    tab.webviewEl?.stop?.();
    if (tab.webviewEl) {
      tab.webviewEl.src = "about:blank";
    }
  } catch (_error) {
    // Ignore teardown failures while closing tabs.
  }

  tab.webviewEl?.remove();
  tab.webviewEl = null;
  tab.contentEl?.remove();
  tab.contentEl = null;
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
        (async () => {
          const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          const timelineSelectors = [
            "[data-region*='timeline']",
            ".block_timeline",
            ".timeline"
          ];

          const collect = () => {
            const primaryAnchors = [
              ...document.querySelectorAll("h6.event-name.mb-0.pb-1.text-truncate a[href]")
            ];
            const fallbackAnchors = [
              ...document.querySelectorAll(".event-name a[href]")
            ];
            const anchors = [...primaryAnchors, ...fallbackAnchors];
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
              readyState: document.readyState,
              viewport: {
                innerWidth: window.innerWidth,
                innerHeight: window.innerHeight,
                clientWidth: document.documentElement?.clientWidth || 0,
                clientHeight: document.documentElement?.clientHeight || 0,
              },
              scroll: {
                x: window.scrollX,
                y: window.scrollY,
              },
              hasLoginForm: Boolean(document.querySelector("form[action*='login'], input[type='password']")),
              eventContainerCount: document.querySelectorAll(".event-name-container").length,
              eventNameCount: document.querySelectorAll(".event-name").length,
              timelineRegionCount: document.querySelectorAll("[data-region*='timeline'], .timeline, .block_timeline, [data-block='timeline']").length,
              primaryAnchorCount: primaryAnchors.length,
              fallbackAnchorCount: fallbackAnchors.length,
              primaryAnchorPreview: primaryAnchors.slice(0, 3).map((anchor) => anchor.outerHTML.slice(0, 280)),
              fallbackAnchorPreview: fallbackAnchors.slice(0, 3).map((anchor) => anchor.outerHTML.slice(0, 280)),
              items
            };
          };

          let snapshot = collect();
          for (let attempt = 0; attempt < 12; attempt += 1) {
            if (snapshot.primaryAnchorCount || snapshot.fallbackAnchorCount) {
              break;
            }
            const timelineRegion = timelineSelectors
              .map((selector) => document.querySelector(selector))
              .find(Boolean);
            timelineRegion?.scrollIntoView?.({ block: "center" });
            window.scrollTo(0, Math.max(0, document.body.scrollHeight));
            await delay(250);
            snapshot = collect();
          }

          return snapshot;
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
        : {
          state: "empty",
          message: [
            `No timeline items found on: ${result?.title || "unknown page"}`,
            `URL: ${result?.url || "-"}`,
            `readyState: ${result?.readyState || "-"}`,
            `viewport: ${result?.viewport?.innerWidth ?? 0}x${result?.viewport?.innerHeight ?? 0}`,
            `doc: ${result?.viewport?.clientWidth ?? 0}x${result?.viewport?.clientHeight ?? 0}`,
            `containers: ${result?.eventContainerCount ?? 0}`,
            `eventNames: ${result?.eventNameCount ?? 0}`,
            `timelineRegions: ${result?.timelineRegionCount ?? 0}`,
            `primary: ${result?.primaryAnchorCount ?? 0}`,
            `fallback: ${result?.fallbackAnchorCount ?? 0}`,
            `scroll: ${result?.scroll?.x ?? 0},${result?.scroll?.y ?? 0}`,
            `sample: ${(result?.primaryAnchorPreview?.[0] || result?.fallbackAnchorPreview?.[0] || "-").replace(/\\s+/g, " ")}`,
          ].join(" | "),
        };
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
  const normalized = normalizeCourseTitle(courseName);
  return state.mappings.find((entry) => {
    const entryNormalized = normalizeCourseTitle(entry.courseName);
    return entry.courseName === courseName || entryNormalized === normalized;
  }) || null;
}

function findMappingForTab(tab) {
  if (!tab) {
    return null;
  }
  const courseId = tab.courseId || extractCourseIdFromUrl(tab.courseUrl || tab.url || "");
  return state.mappings.find((entry) => {
    const entryCourseId = entry.courseId || extractCourseIdFromUrl(entry.courseUrl);
    return (
      (courseId && entryCourseId === courseId) ||
      (tab.courseUrl && entry.courseUrl === tab.courseUrl) ||
      (tab.courseName && normalizeCourseTitle(entry.courseName) === normalizeCourseTitle(tab.courseName))
    );
  }) || null;
}

function findMappingForPath(targetPath) {
  const matches = state.mappings.filter((entry) => {
    const normalizedPath = targetPath.toLowerCase();
    const candidatePaths = [entry.folderPath, entry.submissionFolderPath]
      .filter(Boolean)
      .map((value) => value.toLowerCase());
    return candidatePaths.some((mappingPath) => (
      normalizedPath === mappingPath || normalizedPath.startsWith(`${mappingPath}\\`)
    ));
  });

  if (!matches.length) {
    return null;
  }

  return matches.sort((left, right) => right.folderPath.length - left.folderPath.length)[0];
}

async function ensureCourseMapping(tab) {
  if (
    !tab?.courseName ||
    !shouldPromptForCourseMapping(tab) ||
    findMappingForCourse(tab.courseName) ||
    state.mappingPromptedCourses.has(tab.courseName)
  ) {
    return;
  }

  state.mappingPromptedCourses.add(tab.courseName);
  state.pendingMappingCourse = {
    courseName: tab.courseName,
    courseId: tab.courseId || extractCourseIdFromUrl(tab.courseUrl || tab.url || ""),
    courseUrl: tab.courseUrl || tab.url || "",
  };

  const prepared = await window.fuzzyApi.prepareMapping({
    courseName: tab.courseName,
    courseId: tab.courseId || extractCourseIdFromUrl(tab.courseUrl || tab.url || ""),
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

  webview.addEventListener("ipc-message", (event) => {
    const [payload] = event.args;
    if (!payload) {
      return;
    }

    if (event.channel === "download-context") {
      void (async () => {
        try {
          await window.fuzzyApi.openRemoteFileTab({
            tabId: tab.id,
            url: payload.url,
            fileName: payload.fileName || payload.label || "download",
          });
        } catch (error) {
          toast(error.message, "error");
        }
      })();
      return;
    }

    if (event.channel === "download-menu") {
      openMoodleFileMenu(payload, tab);
      return;
    }

    if (event.channel === "hide-context-menu") {
      hideContextMenu();
      return;
    }

    if (event.channel !== "page-context") {
      return;
    }

    const pageType = classifyMoodlePage(payload);
    tab.url = payload.url || tab.url;
    tab.courseUrl = payload.url || tab.courseUrl || tab.url;
    tab.courseId = payload.courseId || extractCourseIdFromUrl(tab.url);
    tab.courseName = pageType === "course" ? payload.courseName || "" : "";
    tab.title = tab.courseName || payload.title || tab.title;

    window.fuzzyApi.updateTabContext({
      tabId: tab.id,
      context: {
        url: tab.url,
        title: payload.title || tab.title,
        courseName: tab.courseName,
        courseId: tab.courseId,
      },
    });

    if (tab.id === state.activeTabId) {
      void updateCurrentCourse(tab);
      syncAddressBar();
    }

    renderBrowserTabs();
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
  if (tab.kind !== "browser" && tab.kind !== "remote-pdf") {
    return;
  }

  tab.url = tab.webviewEl.getURL();
  const htmlTitle = tab.webviewEl.getTitle() || tab.title;
  const pageType = classifyMoodlePage({ url: tab.url, title: htmlTitle });
  const courseName = pageType === "course" ? deriveCourseNameFromTitle(htmlTitle) : "";
  tab.courseName = courseName;
  tab.courseId = extractCourseIdFromUrl(tab.url);
  tab.courseUrl = tab.url;
  tab.title = courseName || htmlTitle || tab.title;

  window.fuzzyApi.updateTabContext({
    tabId: tab.id,
    context: {
      url: tab.url,
      title: htmlTitle,
      courseName: tab.courseName,
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

  if (tab.courseName && shouldPromptForCourseMapping(tab)) {
    void ensureCourseMapping(tab);
  }
}

function mountLocalPdfTab(tab) {
  const contentEl = document.createElement("div");
  contentEl.className = "browser-surface";
  const frame = document.createElement("iframe");
  frame.className = "pdf-frame";
  frame.src = encodeFileUrl(tab.path);
  contentEl.appendChild(frame);
  tab.contentEl = contentEl;
  elements.browserContent.appendChild(contentEl);
}

function mountFileFrameTab(tab, src) {
  const contentEl = document.createElement("div");
  contentEl.className = "browser-surface";
  const frame = document.createElement("iframe");
  frame.className = "pdf-frame";
  frame.src = src;
  contentEl.appendChild(frame);
  tab.contentEl = contentEl;
  elements.browserContent.appendChild(contentEl);
}

function createLocalFileTab(filePath, title) {
  const tab = {
    id: createId("file-local"),
    kind: "local-file",
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

function openLocalFileInTab(filePath, title) {
  try {
    if (title.toLowerCase().endsWith(".pdf")) {
      createLocalPdfTab(filePath, title);
      return;
    }
    createLocalFileTab(filePath, title);
  } catch (_error) {
    toast("このファイルは別タブ表示できません", "warn");
  }
}

async function duplicateExplorerEntry(entry) {
  await window.fuzzyApi.duplicateExplorerEntry(entry.path);
  await loadDirectory(state.currentDir || state.rootDir, { syncBrowserFromDirectory: false });
  toast(`${entry.name} をコピーしました`, "success");
}

async function renameExplorerEntry(entry) {
  const nextName = window.prompt("新しい名前を入力してください", entry.name);
  if (!nextName || nextName === entry.name) {
    return;
  }
  await window.fuzzyApi.renameExplorerEntry({
    targetPath: entry.path,
    nextName,
  });
  await loadDirectory(state.currentDir || state.rootDir, { syncBrowserFromDirectory: false });
  toast(`${entry.name} の名前を変更しました`, "success");
}

async function deleteExplorerEntry(entry) {
  const confirmed = window.confirm(`${entry.name} を削除しますか？`);
  if (!confirmed) {
    return;
  }
  await window.fuzzyApi.deleteExplorerEntry(entry.path);
  await loadDirectory(state.currentDir || state.rootDir, { syncBrowserFromDirectory: false });
  toast(`${entry.name} を削除しました`, "success");
}

function openExplorerEntryMenu(entry, x, y) {
  const items = [];
  if (entry.isDirectory) {
    items.push({
      label: "開く",
      action: () => loadDirectory(entry.path, { syncBrowserFromDirectory: true }),
    });
  } else {
    items.push({
      label: "別タブで開く",
      action: async () => openLocalFileInTab(entry.path, entry.name),
    });
  }
  if (entry.withinRoot !== false) {
    items.push({
      label: "Copy",
      action: async () => duplicateExplorerEntry(entry),
    });
    items.push({
      label: "Rename",
      action: async () => renameExplorerEntry(entry),
    });
    items.push({
      label: "削除",
      tone: "danger",
      action: async () => deleteExplorerEntry(entry),
    });
  }
  showContextMenu(items, x, y);
}

function openMoodleFileMenu(payload, tab) {
  const x = payload.x || Math.round(window.innerWidth / 2);
  const y = payload.y || Math.round(window.innerHeight / 2);
  const getDefaultFolder = () => {
    const activeMapping = findMappingForTab(tab) || findMappingForCourse(tab.courseName || payload.courseName || "");
    return activeMapping?.folderPath || getMappedFolderForContext(payload.courseName || tab.courseName);
  };

  const saveToCourseFolder = async (customFileName = "") => {
    await saveRemoteFile(payload, tab, {
      folderPath: getDefaultFolder(),
      fileName: customFileName || payload.fileName || payload.label || "download",
    });
  };

  const saveToLesson = async (lessonNumber, customFileName = "") => {
    const activeMapping = findMappingForTab(tab) || findMappingForCourse(tab.courseName || payload.courseName || "");
    if (!activeMapping) {
      toast("先にコースフォルダを紐づけてください", "warn");
      return;
    }
    await saveRemoteFile(payload, tab, {
      folderPath: activeMapping.folderPath,
      fileName: customFileName || payload.fileName || payload.label || "download",
      lessonFolder: `第${lessonNumber}回`,
    });
  };

  showContextMenu([
    {
      label: "保存",
      expanded: false,
      children: [
        ...Array.from({ length: 14 }, (_, index) => ({
          label: `第${index + 1}回に保存`,
          action: async () => saveToLesson(index + 1),
        })),
      ],
      action: async () => saveToCourseFolder(),
    },
    {
      label: "名前を付けて保存",
      expanded: false,
      children: [
        ...Array.from({ length: 14 }, (_, index) => ({
          label: `第${index + 1}回に保存`,
          action: async () => {
            const activeMapping = findMappingForTab(tab) || findMappingForCourse(tab.courseName || payload.courseName || "");
            if (!activeMapping) {
              toast("先にコースフォルダを紐づけてください", "warn");
              return;
            }
            await showDownloadDialog(payload, tab, {
              folderPath: activeMapping.folderPath,
              lessonFolder: `第${index + 1}回`,
              fileName: payload.fileName || payload.label || "download",
            });
          },
        })),
      ],
      action: async () => {
        await showDownloadDialog(payload, tab, {
          folderPath: getDefaultFolder(),
          fileName: payload.fileName || payload.label || "download",
        });
      },
    },
  ], x, y);
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
  if (tab.kind === "remote-file") {
    mountFileFrameTab(tab, tab.url);
    return;
  }
  if (tab.kind === "local-pdf") {
    mountLocalPdfTab(tab);
    return;
  }
  if (tab.kind === "local-file") {
    mountFileFrameTab(tab, encodeFileUrl(tab.path));
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
  const courseName = shouldPromptForCourseMapping(tab) ? tab?.courseName || UI_TEXT.noCourse : UI_TEXT.noCourse;
  elements.activeCourseLabel.textContent = courseName;

  if (tab?.courseName && shouldPromptForCourseMapping(tab)) {
    const mapping = findMappingForTab(tab) || findMappingForCourse(tab.courseName);
    if (mapping) {
      await loadDirectory(mapping.folderPath, { syncBrowserFromDirectory: false });
    } else {
      await ensureCourseMapping(tab);
    }
  }

  renderSubmissionFolderButton();
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
    row.draggable = true;
    row.title = entry.name;
    row.innerHTML = `
      <span class="file-name-cell">
        <span class="file-icon">${entry.isDirectory ? "📁" : entry.name.toLowerCase().endsWith(".pdf") ? "📄" : "🗎"}</span>
        <span class="file-name-text" title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</span>
      </span>
      <span class="file-meta-text">${formatTimestamp(entry.modifiedAt)}</span>
      <span class="file-meta-text">${entry.isDirectory ? "-" : formatFileSize(entry.size)}</span>
    `;

    row.addEventListener("click", async (event) => {
      if (entry.isDirectory) {
        await loadDirectory(entry.path, { syncBrowserFromDirectory: true });
        return;
      }
      event.preventDefault();
      openExplorerEntryMenu(entry, event.clientX, event.clientY);
    });

    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openExplorerEntryMenu(entry, event.clientX, event.clientY);
    });

    row.addEventListener("dragstart", (event) => {
      event.dataTransfer.effectAllowed = "copy";
      event.dataTransfer.setData("text/plain", entry.path);
      window.fuzzyApi.startExplorerDrag(entry.path);
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
    item.title = `${mapping.courseName}\n${mapping.folderPath}`;
    item.innerHTML = `
      <strong title="${escapeHtml(mapping.courseName)}">${escapeHtml(mapping.courseName)}</strong>
      <small title="${escapeHtml(mapping.folderPath)}">${escapeHtml(mapping.folderPath)}</small>
    `;
    elements.mappingList.appendChild(item);
  }
}

function renderTimeline() {
  elements.timelineList.innerHTML = "";
  const activeTab = getActiveTab();
  const entries = state.timelineEntries
    .filter((entry) => !shouldHideTimelineEntry(entry))
    .sort(compareTimelineEntries);

  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = state.timelineStatus.message || UI_TEXT.emptyTimeline;
    elements.timelineList.appendChild(empty);
    return;
  }

  for (const entry of entries) {
    const meta = classifyTimelineEntry(entry);
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
    elements.timelineList.appendChild(card);
  }
}

async function loadDirectory(targetPath, options = {}) {
  const { syncBrowserFromDirectory = false } = options;
  const result = await window.fuzzyApi.listDirectory(targetPath);
  state.rootDir = result.rootDir;
  state.currentDir = result.currentDir;
  elements.rootDirLabel.textContent = state.rootDir || UI_TEXT.rootUnset;
  renderCurrentPath(state.currentDir);
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

  renderSubmissionFolderButton();
}

async function saveMapping(courseName, folderPath, matchType, courseUrl) {
  const mapping = await window.fuzzyApi.saveMapping({
    courseName,
    courseId: extractCourseIdFromUrl(courseUrl),
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

function isWithinPath(targetPath, parentPath) {
  const normalizedTarget = String(targetPath || "").toLowerCase();
  const normalizedParent = String(parentPath || "").toLowerCase();
  if (!normalizedTarget || !normalizedParent) {
    return false;
  }
  return normalizedTarget === normalizedParent || normalizedTarget.startsWith(`${normalizedParent}\\`);
}

function getActiveCourseMapping() {
  return findMappingForTab(getActiveTab()) || findMappingForPath(state.currentDir) || null;
}

function isViewingSubmissionFolder(mapping = getActiveCourseMapping()) {
  return Boolean(mapping?.submissionFolderPath && isWithinPath(state.currentDir, mapping.submissionFolderPath));
}

function renderSubmissionFolderButton() {
  const mapping = getActiveCourseMapping();
  const viewingSubmission = isViewingSubmissionFolder(mapping);
  elements.openSubmissionFolderButton.textContent = viewingSubmission ? "コースフォルダを開く" : "提出フォルダを開く";
  elements.openSubmissionFolderButton.disabled = false;
}

async function saveRemoteFile(payload, tab, overrides = {}) {
  const resolved = await window.fuzzyApi.resolveDownload({
    url: payload.url,
    fileName: overrides.fileName || payload.fileName,
    label: payload.label,
  });
  const baseFolder = overrides.folderPath || getMappedFolderForContext(payload.courseName || tab.courseName);
  if (!baseFolder) {
    toast("先に保存ルートを設定してください", "warn");
    return;
  }

  await window.fuzzyApi.startCustomDownload({
    tabId: tab.id,
    url: resolved?.resolvedUrl || payload.url,
    folderPath: baseFolder,
    fileName: sanitizeFileName(overrides.fileName || resolved?.fileName || payload.fileName || payload.label || "download"),
    lessonFolder: overrides.lessonFolder || "",
  });
}

async function configureSubmissionFolder(mapping, onComplete = null) {
  if (!mapping) {
    toast("先にコースフォルダを紐づけてください", "warn");
    return;
  }
  const x = Math.round(window.innerWidth / 2);
  const y = Math.round(window.innerHeight / 2);
  showContextMenu([
    {
      label: "新しく提出フォルダを作成",
      action: async () => {
        const submissionFolderPath = `${mapping.folderPath}\\提出フォルダ`;
        const next = await window.fuzzyApi.setSubmissionFolder({
          courseName: mapping.courseName,
          courseId: mapping.courseId,
          courseUrl: mapping.courseUrl,
          submissionFolderPath,
        });
        const index = state.mappings.findIndex((entry) => entry.courseName === next.courseName);
        if (index >= 0) {
          state.mappings[index] = next;
        }
        renderMappings();
        renderSubmissionFolderButton();
        await loadDirectory(next.submissionFolderPath, { syncBrowserFromDirectory: false });
        if (onComplete) {
          await onComplete(next);
        }
        toast("提出フォルダを作成しました", "success");
      },
    },
    {
      label: "提出フォルダのパスを指定",
      action: async () => {
        const submissionFolderPath = await window.fuzzyApi.chooseFolderForMapping();
        if (!submissionFolderPath) {
          return;
        }
        const next = await window.fuzzyApi.setSubmissionFolder({
          courseName: mapping.courseName,
          courseId: mapping.courseId,
          courseUrl: mapping.courseUrl,
          submissionFolderPath,
        });
        const index = state.mappings.findIndex((entry) => entry.courseName === next.courseName);
        if (index >= 0) {
          state.mappings[index] = next;
        }
        renderMappings();
        renderSubmissionFolderButton();
        await loadDirectory(next.submissionFolderPath, { syncBrowserFromDirectory: false });
        if (onComplete) {
          await onComplete(next);
        }
        toast("提出フォルダを設定しました", "success");
      },
    },
  ], x, y);
}

async function showDownloadDialog(payload, tab, options = {}) {
  const baseFolder = options.folderPath || getMappedFolderForContext(payload.courseName || tab.courseName);
  if (!baseFolder) {
    toast("先に保存ルートを設定してください", "warn");
    return;
  }

  const resolved = await window.fuzzyApi.resolveDownload({
    url: payload.url,
    fileName: payload.fileName,
    label: payload.label,
  });

  state.downloadDraft = {
    tabId: tab.id,
    sourceUrl: payload.url,
    url: resolved?.resolvedUrl || payload.url,
    fileName: sanitizeFileName(options.fileName || resolved?.fileName || payload.fileName || payload.label || "download"),
    folderPath: baseFolder,
    lessonFolder: options.lessonFolder || "",
    courseName: payload.courseName || tab.courseName || "",
    canPreview: Boolean(resolved?.canPreview),
  };

  elements.downloadFolderLabel.textContent = state.downloadDraft.folderPath;
  elements.downloadFileNameInput.value = state.downloadDraft.fileName;
  elements.downloadDialog.showModal();
}

function setupDashboardWebview() {
  elements.dashboardWebview.addEventListener("did-finish-load", scheduleDashboardTimelinePull);
  elements.dashboardWebview.addEventListener("did-navigate", scheduleDashboardTimelinePull);
  elements.dashboardWebview.addEventListener("did-navigate-in-page", scheduleDashboardTimelinePull);
}

function wireEvents() {
  elements.contextMenuBackdrop.addEventListener("mousedown", hideContextMenu);
  elements.contextMenuBackdrop.addEventListener("click", hideContextMenu);
  document.addEventListener("click", (event) => {
    if (!closestFromEventTarget(event.target, "#context-menu")) {
      hideContextMenu();
    }
  });
  document.addEventListener("mousedown", (event) => {
    if (!closestFromEventTarget(event.target, "#context-menu")) {
      hideContextMenu();
    }
  });
  document.addEventListener("contextmenu", (event) => {
    if (!closestFromEventTarget(event.target, ".file-row") && !closestFromEventTarget(event.target, "#context-menu")) {
      hideContextMenu();
    }
  });
  window.addEventListener("blur", hideContextMenu);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideContextMenu();
    }
  });

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
    renderCurrentPath(next.directory.currentDir);
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
    const mapping = findMappingForPath(state.currentDir);
    if (!mapping?.courseUrl) {
      toast("このタブに対応する 選択した ページがありません", "warn");
      return;
    }
    navigateCurrentBrowserTab(mapping.courseUrl, mapping.courseName || UI_TEXT.defaultBrowserTitle);
  });

  elements.openSubmissionFolderButton.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    let mapping = getActiveCourseMapping();
    if (!mapping) {
      const activeTab = getActiveTab();
      if (activeTab?.courseName && shouldPromptForCourseMapping(activeTab)) {
        await ensureCourseMapping(activeTab);
        mapping = getActiveCourseMapping();
      }
    }
    if (!mapping) {
      toast("先にコースフォルダを紐づけてください", "warn");
      return;
    }
    if (isViewingSubmissionFolder(mapping)) {
      await loadDirectory(mapping.folderPath, { syncBrowserFromDirectory: false });
      return;
    }
    if (!mapping.submissionFolderPath) {
      await configureSubmissionFolder(mapping);
      return;
    }
    await loadDirectory(mapping.submissionFolderPath, { syncBrowserFromDirectory: false });
  });

  document.querySelector("#timeline-refresh-button").addEventListener("click", () => {
    ensureDashboardLoaded();
    scheduleDashboardRefresh();
  });

  elements.downloadDialog.addEventListener("click", (event) => {
    if (event.target === elements.downloadDialog) {
      elements.downloadDialog.close();
    }
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

  elements.downloadSaveButton.addEventListener("click", async () => {
    if (!state.downloadDraft) {
      return;
    }
    await window.fuzzyApi.startCustomDownload({
      tabId: state.downloadDraft.tabId,
      url: state.downloadDraft.url,
      folderPath: state.downloadDraft.folderPath,
      fileName: sanitizeFileName(elements.downloadFileNameInput.value),
      lessonFolder: state.downloadDraft.lessonFolder || "",
    });
    elements.downloadDialog.close();
  });

  window.addEventListener("resize", positionDockToggle);
  window.addEventListener("resize", hideContextMenu);
}

async function initialize() {
  const defaults = await window.fuzzyApi.getDefaults();
  state.moodleHome = defaults.moodleHome;
  state.dashboardUrl = new URL("./my/", state.moodleHome).toString();
  state.dashboardAutoload = Boolean(defaults.dashboardAutoload);

  const initial = await window.fuzzyApi.getState();
  state.rootDir = initial.rootDir;
  state.currentDir = initial.directory.currentDir;
  state.mappings = initial.mappings;

  elements.rootDirLabel.textContent = initial.rootDir || UI_TEXT.rootUnset;
  renderCurrentPath(initial.directory.currentDir);

  renderDirectory(initial.directory.entries);
  renderMappings();
  renderSidePanelVisibility();
  renderPanelTabs();
  renderSubmissionFolderButton();
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

window.fuzzyApi.onOpenPreviewFile((payload) => {
  openLocalFileInTab(payload.localPath, payload.fileName || "download");
});

window.fuzzyApi.onDownloadPrompt(async (payload) => {
  const tab = findTab(payload.tabId) || getActiveTab();
  if (!tab) {
    return;
  }
  openMoodleFileMenu(payload, tab);
});

initialize();
