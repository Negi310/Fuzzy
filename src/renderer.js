const PRELOAD_PATH = (() => {
  const url = new URL("./browser-preload.js", window.location.href);
  let pathname = decodeURIComponent(url.pathname);
  if (/^\/[A-Za-z]:/.test(pathname)) {
    pathname = pathname.slice(1);
  }
  return pathname;
})();

const WEBVIEW_PARTITION = "persist:fuzitter";

const UI_TEXT = {
  defaultBrowserTitle: "Moodle",
  noCourse: "未選択",
  emptyFiles: "ファイルがありません",
  emptyMappings: "まだ紐づけはありません",
  emptyTimeline: "タイムラインはまだ読み込まれていません",
  localOnly: "PDF 以外のローカル表示にはまだ対応していません",
  rootUnset: "未設定",
};

const FAVORITE_LINKS = [
  { label: "Moodle", url: () => state.moodleHome, title: UI_TEXT.defaultBrowserTitle, explorerLinked: true },
  { label: "Gemini", url: "https://gemini.google.com/app", title: "Gemini", explorerLinked: false },
  { label: "NotebookLM", url: "https://notebooklm.google.com", title: "NotebookLM", explorerLinked: false },
];

const state = {
  moodleHome: "https://moodle2026.wakayama-u.ac.jp/2026/",
  dashboardUrl: "https://moodle2026.wakayama-u.ac.jp/2026/my/",
  rootDir: "",
  currentDir: "",
  explorerEntries: [],
  mappings: [],
  timelineEntries: [],
  tabs: [],
  activeTabId: null,
  draggedTabId: null,
  tabSlideDrag: null,
  tabClickSuppressUntil: 0,
  splitView: {
    enabled: false,
    editing: false,
    primaryTabId: null,
    secondaryTabId: null,
    ratio: 0.5,
  },
  activePanelTab: "explorer",
  panelVisible: true,
  dashboardLoaded: false,
  dashboardAutoload: false,
  pendingMappingCourse: null,
  mappingPromptedCourses: new Set(),
  selectedExplorerPaths: new Set(),
  explorerSelectionAnchorPath: "",
  draggedExplorerPaths: [],
  explorerDropTargetPath: "",
  downloadDraft: null,
  renameDraft: null,
  contextMenu: null,
  timelineStatus: {
    state: "idle",
    message: "Timeline loading...",
  },
  autoUpdate: {
    enabled: false,
    downloaded: false,
    currentVersion: "",
    message: "",
  },
  dialogFocusLock: false,
};

const elements = {
  browserTabStrip: document.querySelector("#browser-tab-strip"),
  browserContent: document.querySelector("#browser-content"),
  browserSplitter: document.querySelector("#browser-splitter"),
  addressInput: document.querySelector("#address-input"),
  openSettingsButton: document.querySelector("#open-settings-button"),
  sidePanelTabActions: document.querySelector(".side-panel-tab-actions"),
  hideSidePanelButton: document.querySelector("#hide-side-panel-button"),
  activeCourseLabel: document.querySelector("#active-course-label"),
  currentDirLabel: document.querySelector("#current-dir-label"),
  goRootFolderButton: document.querySelector("#go-root-folder-button"),
  rootDirLabel: document.querySelector("#root-dir-label"),
  moodleHomeInput: document.querySelector("#moodle-home-input"),
  saveMoodleHomeButton: document.querySelector("#save-moodle-home-button"),
  updateStatusLabel: document.querySelector("#update-status-label"),
  checkUpdatesButton: document.querySelector("#check-updates-button"),
  installUpdateButton: document.querySelector("#install-update-button"),
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
  downloadForm: document.querySelector("#download-form"),
  downloadFolderLabel: document.querySelector("#download-folder-label"),
  downloadFileNameInput: document.querySelector("#download-file-name"),
  downloadFileNameHelp: document.querySelector("#download-file-name-help"),
  downloadChooseFolderButton: document.querySelector("#download-choose-folder-button"),
  downloadCancelButton: document.querySelector("#download-cancel-button"),
  downloadSaveButton: document.querySelector("#download-save-button"),
  renameDialog: document.querySelector("#rename-dialog"),
  renameForm: document.querySelector("#rename-form"),
  renameCurrentName: document.querySelector("#rename-current-name"),
  renameFileNameInput: document.querySelector("#rename-file-name"),
  renameCancelButton: document.querySelector("#rename-cancel-button"),
  renameSaveButton: document.querySelector("#rename-save-button"),
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

function setMoodleHome(nextUrl) {
  state.moodleHome = nextUrl;
  state.dashboardUrl = new URL("./my/", nextUrl).toString();
  if (elements.moodleHomeInput) {
    elements.moodleHomeInput.value = nextUrl;
  }
}

function renderAutoUpdateStatus() {
  if (!elements.updateStatusLabel) {
    return;
  }

  const baseMessage = state.autoUpdate.message || (
    state.autoUpdate.enabled
      ? `現在のバージョン: ${state.autoUpdate.currentVersion || "-"}`
      : "自動更新はインストール版でのみ利用できます。"
  );

  elements.updateStatusLabel.textContent = baseMessage;
  if (elements.checkUpdatesButton) {
    elements.checkUpdatesButton.disabled = Boolean(state.autoUpdate.checking);
  }
  if (elements.installUpdateButton) {
    elements.installUpdateButton.disabled = !state.autoUpdate.downloaded;
  }
}

function applyAutoUpdateStatus(payload = {}) {
  state.autoUpdate = {
    ...state.autoUpdate,
    ...payload,
  };
  renderAutoUpdateStatus();
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
    .replace(/^\s*コース\s*[:：]\s*/iu, "")
    .replace(/\s*[|｜]\s*【\s*和歌山大学\s*】\s*$/u, "")
    .replace(/\s+/g, " ")
    .replace(/\s*[|:-]\s*Wakayama.*Moodle.*$/i, "")
    .replace(/\s*[|｜:-]\s*和歌山大学.*Moodle.*$/u, "")
    .replace(/\s*Moodle\d*\s*$/i, "")
    .trim();
  return String(title || "")
    .replace(/^\s*コース\s*[:：]\s*/i, "")
    .replace(/\s*[|｜]\s*【?\s*和歌山大学\s*】?\s*$/i, "")
    .replace(/\s+/g, " ")
    .replace(/\s*[|:-]\s*Wakayama.*Moodle.*$/i, "")
    .replace(/\s*[|:-]\s*和歌山大学.*Moodle.*$/i, "")
    .replace(/\s*Moodle\d*\s*$/i, "")
    .trim();
}

function normalizeCourseTitle(title) {
  return String(title || "")
    .replace(/^\s*\u30b3\u30fc\u30b9\s*[:\uFF1A]\s*/u, "")
    .replace(/\s*(?:(?:\||\uFF5C)\s*)?\u3010\u548c\u6b4c\u5c71\u5927\u5b66\u3011\s*$/u, "")
    .replace(/\s+/g, " ")
    .replace(/\s*[|:-]\s*Wakayama.*Moodle.*$/i, "")
    .replace(/\s*[|\uFF5C:\-]\s*\u548c\u6b4c\u5c71\u5927\u5b66.*Moodle.*$/u, "")
    .replace(/\s*Moodle\d*\s*$/i, "")
    .trim();
}

function getDisplayCourseName(courseName) {
  return normalizeCourseTitle(courseName) || UI_TEXT.noCourse;
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

function renderContextMenuItems(items, level = 0, container = elements.contextMenu) {
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
      toggleButton.setAttribute("aria-label", item.expanded ? "サブメニューを閉じる" : "サブメニューを開く");
      toggleButton.setAttribute("aria-expanded", item.expanded ? "true" : "false");
      toggleButton.addEventListener("click", (event) => {
        event.stopPropagation();
        item.expanded = !item.expanded;
        elements.contextMenu.innerHTML = "";
        renderContextMenuItems(state.contextMenu.items);
        positionContextMenu(state.contextMenu.x, state.contextMenu.y);
      });

      row.appendChild(actionButton);
      row.appendChild(toggleButton);
      container.appendChild(row);

      if (item.expanded) {
        const childrenContainer = document.createElement("div");
        childrenContainer.className = "context-menu-children";
        childrenContainer.style.marginLeft = `${12 + level * 16}px`;
        container.appendChild(childrenContainer);
        renderContextMenuItems(item.children, level + 1, childrenContainer);
      }
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
      container.appendChild(button);
    }
  }
}

function positionContextMenu(x, y) {
  const menuWidth = 240;
  const availableHeight = Math.max(window.innerHeight - 24, 120);
  elements.contextMenu.style.maxHeight = `${availableHeight}px`;
  const menuHeight = Math.min(availableHeight, elements.contextMenu.scrollHeight);
  const left = Math.min(x, window.innerWidth - menuWidth - 12);
  const top = Math.min(y, window.innerHeight - menuHeight - 12);
  elements.contextMenu.style.left = `${Math.max(left, 12)}px`;
  elements.contextMenu.style.top = `${Math.max(top, 12)}px`;
}

function showContextMenu(items, x, y) {
  state.contextMenu = { items, x, y };
  elements.contextMenu.innerHTML = "";
  renderContextMenuItems(items);

  elements.contextMenuBackdrop.classList.remove("hidden");
  elements.contextMenuBackdrop.setAttribute("aria-hidden", "false");
  elements.contextMenu.classList.remove("hidden");
  elements.contextMenu.setAttribute("aria-hidden", "false");
  positionContextMenu(x, y);
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

function isMoodleHomePath(pathname) {
  return pathname === "/" || /^\/\d{4}\/?$/i.test(pathname);
}

function classifyMoodlePage(context) {
  try {
    const parsed = new URL(context?.url || "");
    if (!/moodle(?:\d{4})?\.wakayama-u\.ac\.jp$/i.test(parsed.hostname)) {
      return "outside";
    }

    const pathname = parsed.pathname.toLowerCase();
    const title = normalizeCourseTitle(context?.title || "").toLowerCase();
    if (isMoodleHomePath(pathname)) {
      return "home";
    }
    if (
      pathname.endsWith("/my/") ||
      pathname.endsWith("/my/index.php") ||
      pathname.endsWith("/course/index.php") ||
      title === "dashboard" ||
      title === "home" ||
      title === "my courses"
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

function getTabById(tabId) {
  return state.tabs.find((tab) => tab.id === tabId) ?? null;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function disableSplitView() {
  state.splitView.enabled = false;
  state.splitView.editing = false;
  state.splitView.primaryTabId = null;
  state.splitView.secondaryTabId = null;
  renderBrowserLayout();
}

function openSplitViewWithTab(tabId) {
  const targetTab = getTabById(tabId);
  const primaryTab = getActiveTab();
  if (!targetTab || !primaryTab || targetTab.id === primaryTab.id) {
    return;
  }
  state.splitView.enabled = true;
  state.splitView.primaryTabId = primaryTab.id;
  state.splitView.secondaryTabId = targetTab.id;
  state.splitView.ratio = clamp(state.splitView.ratio || 0.5, 0.25, 0.75);
  renderBrowserLayout();
}

function normalizeSplitView() {
  if (!state.splitView.enabled) {
    return;
  }

  let primaryTab = getTabById(state.splitView.primaryTabId || state.activeTabId);
  let secondaryTab = getTabById(state.splitView.secondaryTabId);

  if (!primaryTab && secondaryTab) {
    primaryTab = secondaryTab;
    secondaryTab = null;
  }

  if (!primaryTab) {
    disableSplitView();
    return;
  }

  const candidates = state.tabs.filter((tab) => tab.id !== primaryTab.id);
  if ((!secondaryTab || secondaryTab.id === primaryTab.id) && candidates.length) {
    secondaryTab = getTabById(state.activeTabId);
    if (!secondaryTab || secondaryTab.id === primaryTab.id) {
      secondaryTab = candidates.at(-1) || null;
    }
  }

  if (!secondaryTab || secondaryTab.id === primaryTab.id) {
    disableSplitView();
    state.activeTabId = primaryTab.id;
    return;
  }

  state.splitView.primaryTabId = primaryTab.id;
  state.splitView.secondaryTabId = secondaryTab.id;
}

function attachNewTabToSplit(tabId) {
  if (!state.splitView.enabled) {
    return false;
  }
  const primaryTab = getTabById(state.splitView.primaryTabId || state.activeTabId);
  if (!primaryTab || primaryTab.id === tabId) {
    return false;
  }
  state.splitView.primaryTabId = primaryTab.id;
  state.splitView.secondaryTabId = tabId;
  return true;
}

function toggleSplitEditMode() {
  state.splitView.editing = !state.splitView.editing;
  renderBrowserTabs();
  toast(state.splitView.editing ? "画面分割の編集モード" : "画面分割の編集モードを終了", "info");
}

function reorderTabs(sourceTabId, targetTabId, insertAfter = false) {
  if (!sourceTabId || !targetTabId || sourceTabId === targetTabId) {
    return;
  }
  const tabs = [...state.tabs];
  const sourceIndex = tabs.findIndex((tab) => tab.id === sourceTabId);
  const targetIndex = tabs.findIndex((tab) => tab.id === targetTabId);
  if (sourceIndex < 0 || targetIndex < 0) {
    return;
  }
  const [moved] = tabs.splice(sourceIndex, 1);
  const adjustedTargetIndex = tabs.findIndex((tab) => tab.id === targetTabId);
  tabs.splice(adjustedTargetIndex + (insertAfter ? 1 : 0), 0, moved);
  state.tabs = tabs;
  renderBrowserTabs();
}

function moveTabToIndex(sourceTabId, targetIndex) {
  if (!sourceTabId) {
    return;
  }

  const tabs = [...state.tabs];
  const sourceIndex = tabs.findIndex((tab) => tab.id === sourceTabId);
  if (sourceIndex < 0) {
    return;
  }

  const [moved] = tabs.splice(sourceIndex, 1);
  const boundedTargetIndex = clamp(targetIndex, 0, tabs.length);
  tabs.splice(boundedTargetIndex, 0, moved);
  state.tabs = tabs;
  renderBrowserTabs();
}

function clearTabSlideDragStyles() {
  const tabButtons = elements.browserTabStrip.querySelectorAll(".browser-tab[data-tab-id]");
  for (const button of tabButtons) {
    button.classList.remove("dragging", "reorder-shift");
    button.style.transform = "";
  }
}

function applyTabSlideDragStyles() {
  const drag = state.tabSlideDrag;
  const tabButtons = [...elements.browserTabStrip.querySelectorAll(".browser-tab[data-tab-id]")];
  clearTabSlideDragStyles();

  if (!drag?.started) {
    return;
  }

  const sourceIndex = tabButtons.findIndex((button) => button.dataset.tabId === drag.tabId);
  if (sourceIndex < 0) {
    return;
  }

  const draggedButton = tabButtons[sourceIndex];
  const draggedRect = draggedButton.getBoundingClientRect();
  const gap = Number.parseFloat(getComputedStyle(elements.browserTabStrip).gap || "0") || 0;
  const dragDistance = drag.currentX - drag.startX;
  const shiftDistance = draggedRect.width + gap;

  draggedButton.classList.add("dragging");
  draggedButton.style.transform = `translateX(${dragDistance}px)`;

  for (const [index, button] of tabButtons.entries()) {
    if (index === sourceIndex) {
      continue;
    }

    let shift = 0;
    if (sourceIndex < drag.targetIndex && index > sourceIndex && index <= drag.targetIndex) {
      shift = -shiftDistance;
    } else if (sourceIndex > drag.targetIndex && index >= drag.targetIndex && index < sourceIndex) {
      shift = shiftDistance;
    }

    if (shift !== 0) {
      button.classList.add("reorder-shift");
      button.style.transform = `translateX(${shift}px)`;
    }
  }
}

function beginTabSlideDrag(tabId, pointerId, clientX) {
  const originIndex = state.tabs.findIndex((tab) => tab.id === tabId);
  if (originIndex < 0) {
    return;
  }

  state.tabSlideDrag = {
    tabId,
    pointerId,
    startX: clientX,
    currentX: clientX,
    originIndex,
    targetIndex: originIndex,
    started: false,
  };
}

function updateTabSlideDrag(clientX) {
  const drag = state.tabSlideDrag;
  if (!drag) {
    return;
  }

  drag.currentX = clientX;
  const tabButtons = [...elements.browserTabStrip.querySelectorAll(".browser-tab[data-tab-id]")];
  const sourceIndex = tabButtons.findIndex((button) => button.dataset.tabId === drag.tabId);
  if (sourceIndex < 0) {
    return;
  }

  const distance = clientX - drag.startX;
  if (!drag.started && Math.abs(distance) < 8) {
    return;
  }
  drag.started = true;

  const draggedButton = tabButtons[sourceIndex];
  const draggedRect = draggedButton.getBoundingClientRect();
  const draggedCenter = draggedRect.left + draggedRect.width / 2 + distance;
  const otherButtons = tabButtons.filter((button) => button.dataset.tabId !== drag.tabId);

  let targetIndex = 0;
  for (const button of otherButtons) {
    const rect = button.getBoundingClientRect();
    const midpoint = rect.left + rect.width / 2;
    if (draggedCenter > midpoint) {
      targetIndex += 1;
    }
  }

  drag.targetIndex = clamp(targetIndex, 0, tabButtons.length - 1);
  applyTabSlideDragStyles();
}

function finishTabSlideDrag(pointerId = null) {
  const drag = state.tabSlideDrag;
  if (!drag || (pointerId !== null && drag.pointerId !== pointerId)) {
    return;
  }

  const shouldReorder = drag.started && drag.targetIndex !== drag.originIndex;
  clearTabSlideDragStyles();
  state.tabSlideDrag = null;

  if (drag.started) {
    state.tabClickSuppressUntil = Date.now() + 220;
  }

  if (shouldReorder) {
    moveTabToIndex(drag.tabId, drag.targetIndex);
  }
}

function renderBrowserLayout() {
  const splitter = elements.browserSplitter;
  const primaryTab = getTabById(state.splitView.primaryTabId || state.activeTabId);
  const secondaryTab = getTabById(state.splitView.secondaryTabId);
  const canSplit = Boolean(
    state.splitView.enabled &&
    primaryTab &&
    secondaryTab &&
    primaryTab.id !== secondaryTab.id
  );

  if (!canSplit) {
    splitter.classList.add("hidden");
    splitter.setAttribute("aria-hidden", "true");
    for (const tab of state.tabs) {
      if (!tab.contentEl) {
        continue;
      }
      const isVisible = tab.id === state.activeTabId;
      tab.contentEl.classList.toggle("visible", isVisible);
      tab.contentEl.style.left = "";
      tab.contentEl.style.top = "";
      tab.contentEl.style.width = "";
      tab.contentEl.style.height = "";
    }
    return;
  }

  const bounds = elements.browserContent.getBoundingClientRect();
  const splitterWidth = 8;
  const ratio = clamp(state.splitView.ratio || 0.5, 0.25, 0.75);
  const primaryWidth = Math.round((bounds.width - splitterWidth) * ratio);
  const secondaryLeft = primaryWidth + splitterWidth;
  const secondaryWidth = Math.max(bounds.width - secondaryLeft, 0);

  for (const tab of state.tabs) {
    if (!tab.contentEl) {
      continue;
    }
    const isPrimary = tab.id === primaryTab.id;
    const isSecondary = tab.id === secondaryTab.id;
    tab.contentEl.classList.toggle("visible", isPrimary || isSecondary);
    if (isPrimary) {
      tab.contentEl.style.left = "0px";
      tab.contentEl.style.top = "0px";
      tab.contentEl.style.width = `${primaryWidth}px`;
      tab.contentEl.style.height = "100%";
    } else if (isSecondary) {
      tab.contentEl.style.left = `${secondaryLeft}px`;
      tab.contentEl.style.top = "0px";
      tab.contentEl.style.width = `${secondaryWidth}px`;
      tab.contentEl.style.height = "100%";
    } else {
      tab.contentEl.style.left = "";
      tab.contentEl.style.top = "";
      tab.contentEl.style.width = "";
      tab.contentEl.style.height = "";
    }
  }

  splitter.classList.remove("hidden");
  splitter.setAttribute("aria-hidden", "false");
  splitter.style.left = `${primaryWidth}px`;
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

function getExplorerFileIcon(entry) {
  if (entry.isDirectory) {
    return { label: "📁", classNames: ["folder", "emoji"] };
  }

  const extension = String(entry.name || "").toLowerCase().split(".").at(-1) || "";
  if (extension === "pdf") {
    return { label: "PDF", classNames: ["pdf"] };
  }
  if (["doc", "docx"].includes(extension)) {
    return { label: "W", classNames: ["word"] };
  }
  if (["xls", "xlsx", "csv"].includes(extension)) {
    return { label: "X", classNames: ["excel"] };
  }
  if (["ppt", "pptx"].includes(extension)) {
    return { label: "P", classNames: ["powerpoint"] };
  }
  if (["zip", "rar", "7z"].includes(extension)) {
    return { label: "ZIP", classNames: ["archive"] };
  }
  if (["jpg", "jpeg", "png", "gif", "webp", "svg"].includes(extension)) {
    return { label: "IMG", classNames: ["image"] };
  }
  if (["txt", "md"].includes(extension)) {
    return { label: "TXT", classNames: ["text"] };
  }
  return { label: "FILE", classNames: ["file"] };
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
  const match = haystack.match(
    /(?:(\d{4})\s*[\/.\-年]\s*)?(\d{1,2})\s*[\/.\-月]\s*(\d{1,2})(?:\s*[日]?)?(?:\s+|.*?)(\d{1,2}):(\d{2})/
  );
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

function splitTimelineEntryText(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return { title: "", detail: "" };
  }

  const match = normalized.match(/^(.*?)(活動は.*)$/);
  if (!match) {
    return { title: normalized.replace(/\s*の\s*/g, "の"), detail: "" };
  }

  return {
    title: match[1].replace(/\s*の\s*/g, "の").trim(),
    detail: match[2].trim(),
  };
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
  elements.sidePanelTabActions?.classList.toggle("is-hidden", !state.panelVisible);
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

function focusBrowserSurface(tab) {
  if (state.dialogFocusLock) {
    return;
  }
  if (!tab?.webviewEl || tab.kind !== "browser") {
    return;
  }
  setTimeout(() => {
    try {
      tab.webviewEl.focus();
    } catch (_error) {
      // Ignore transient focus failures while the webview is still mounting.
    }
  }, 0);
}

function isExplorerLinkedTab(tab) {
  return tab?.explorerLinked !== false;
}

function activateExistingTab(tabId) {
  if (!tabId) {
    return false;
  }
  const preserveSplitRoles = attachNewTabToSplit(tabId);
  activateTab(tabId, { preserveSplitRoles });
  return true;
}

function findExistingDocumentTab({ path = "", url = "", kind = "" } = {}) {
  const normalizedPath = String(path || "").toLowerCase();
  const normalizedUrl = String(url || "").trim() ? normalizeUrl(url) : "";
  return state.tabs.find((tab) => {
    if (kind && tab.kind !== kind) {
      return false;
    }
    if (normalizedPath && String(tab.path || "").toLowerCase() === normalizedPath) {
      return true;
    }
    if (normalizedUrl && String(tab.url || "").trim() && normalizeUrl(tab.url) === normalizedUrl) {
      return true;
    }
    return false;
  }) || null;
}

function createBrowserTab(url, title = UI_TEXT.defaultBrowserTitle, options = {}) {
  const tab = {
    id: createId("browser"),
    kind: "browser",
    title,
    url: normalizeUrl(url),
    explorerLinked: options.explorerLinked !== false,
    courseName: "",
    courseId: "",
    courseUrl: "",
    contentEl: null,
    webviewEl: null,
    webContentsId: null,
  };
  state.tabs.push(tab);
  mountTab(tab);
  const preserveSplitRoles = attachNewTabToSplit(tab.id);
  activateTab(tab.id, { preserveSplitRoles });
}

function createLocalPdfTab(filePath, title, options = {}) {
  const existingTab = findExistingDocumentTab({ path: filePath, kind: "local-pdf" });
  if (existingTab) {
    activateExistingTab(existingTab.id);
    return existingTab;
  }
  const tab = {
    id: createId("pdf-local"),
    kind: "local-pdf",
    title,
    path: filePath,
    cleanupOnClose: Boolean(options.cleanupOnClose),
    courseName: getActiveTab()?.courseName || "",
    courseUrl: getActiveTab()?.courseUrl || "",
    contentEl: null,
  };
  state.tabs.push(tab);
  mountTab(tab);
  const preserveSplitRoles = attachNewTabToSplit(tab.id);
  activateTab(tab.id, { preserveSplitRoles });
  return tab;
}

function createRemotePdfTab(pdfUrl, title, sourceTab) {
  const existingTab = findExistingDocumentTab({ url: pdfUrl, kind: "remote-pdf" });
  if (existingTab) {
    activateExistingTab(existingTab.id);
    return existingTab;
  }
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
  const preserveSplitRoles = attachNewTabToSplit(tab.id);
  activateTab(tab.id, { preserveSplitRoles });
  return tab;
}

function createRemoteFileTab(fileUrl, title, sourceTab) {
  const existingTab = findExistingDocumentTab({ url: fileUrl, kind: "remote-file" });
  if (existingTab) {
    activateExistingTab(existingTab.id);
    return existingTab;
  }
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
  const preserveSplitRoles = attachNewTabToSplit(tab.id);
  activateTab(tab.id, { preserveSplitRoles });
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

  if (tab.cleanupOnClose && tab.path) {
    void window.fuzzyApi.cleanupPreviewFile(tab.path).catch(() => {});
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

  normalizeSplitView();
  activateTab(state.activeTabId, { preserveSplitRoles: true });
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

function isLoggedInMoodleHome(context) {
  try {
    const parsed = new URL(context.url || "");
    if (!/moodle(?:\d{4})?\.wakayama-u\.ac\.jp$/i.test(parsed.hostname)) {
      return false;
    }

    const pathname = parsed.pathname.toLowerCase();
    const title = normalizeCourseTitle(context.title || "").toLowerCase();
    return (
      isMoodleHomePath(pathname) ||
      pathname.endsWith("/my/") ||
      pathname.endsWith("/my/index.php") ||
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
            const eventNames = [
              ...document.querySelectorAll("h6.event-name.mb-0.pb-1.text-truncate")
            ];
            const seen = new Set();
            const items = eventNames.flatMap((eventName) => {
              const anchor = eventName.querySelector("a[href]");
              const href = anchor?.href || "";
              const ariaSource = eventName.matches("[aria-label]")
                ? eventName
                : eventName.querySelector("[aria-label]");
              const label = (
                ariaSource?.getAttribute("aria-label")
                || eventName.textContent
                || ""
              ).trim().replace(/\\s+/g, " ");
              if (!href || !label || seen.has(href)) {
                return [];
              }
              seen.add(href);
              const container = eventName.closest("li, article, .event, .list-group-item, .activity-item, tr, .timeline-event");
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
              eventHeadingCount: eventNames.length,
              eventHeadingPreview: eventNames.slice(0, 3).map((item) => item.outerHTML.slice(0, 280)),
              items
            };
          };

          let snapshot = collect();
          for (let attempt = 0; attempt < 12; attempt += 1) {
            if (snapshot.eventHeadingCount) {
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

function findExplorerEntryByPath(targetPath) {
  return state.explorerEntries.find((entry) => entry.path === targetPath) || null;
}

function getSelectedExplorerEntries() {
  return state.explorerEntries.filter((entry) => state.selectedExplorerPaths.has(entry.path));
}

function syncExplorerSelection() {
  const validPaths = new Set(state.explorerEntries.map((entry) => entry.path));
  state.selectedExplorerPaths = new Set(
    [...state.selectedExplorerPaths].filter((entryPath) => validPaths.has(entryPath))
  );
  if (state.explorerSelectionAnchorPath && !validPaths.has(state.explorerSelectionAnchorPath)) {
    state.explorerSelectionAnchorPath = "";
  }
  if (state.explorerDropTargetPath && !validPaths.has(state.explorerDropTargetPath)) {
    state.explorerDropTargetPath = "";
  }
}

function setExplorerSelection(paths, anchorPath = "") {
  state.selectedExplorerPaths = new Set(paths.filter(Boolean));
  state.explorerSelectionAnchorPath = anchorPath || paths.at(-1) || "";
}

function renderExplorerSelectionState() {
  elements.fileList.querySelectorAll(".file-row").forEach((row) => {
    const entryPath = row.dataset.entryPath || "";
    row.classList.toggle("selected", state.selectedExplorerPaths.has(entryPath));
  });
}

function renderExplorerDropTargetState() {
  elements.fileList.querySelectorAll(".file-row").forEach((row) => {
    const entryPath = row.dataset.entryPath || "";
    row.classList.toggle("drop-target", state.explorerDropTargetPath === entryPath);
  });
}

function toggleExplorerSelection(pathValue) {
  const nextSelection = new Set(state.selectedExplorerPaths);
  if (nextSelection.has(pathValue)) {
    nextSelection.delete(pathValue);
  } else {
    nextSelection.add(pathValue);
  }
  state.selectedExplorerPaths = nextSelection;
  state.explorerSelectionAnchorPath = pathValue;
}

function buildExplorerRangeSelection(targetPath, preserveExisting = false) {
  const paths = state.explorerEntries.map((entry) => entry.path);
  const anchorPath = state.explorerSelectionAnchorPath || targetPath;
  const startIndex = paths.indexOf(anchorPath);
  const endIndex = paths.indexOf(targetPath);
  if (startIndex < 0 || endIndex < 0) {
    return [targetPath];
  }

  const [fromIndex, toIndex] = startIndex < endIndex
    ? [startIndex, endIndex]
    : [endIndex, startIndex];
  const rangePaths = paths.slice(fromIndex, toIndex + 1);
  if (!preserveExisting) {
    return rangePaths;
  }
  return [...new Set([...state.selectedExplorerPaths, ...rangePaths])];
}

function handleExplorerSelection(entry, event = {}) {
  if (event.shiftKey) {
    const preserveExisting = Boolean(event.ctrlKey || event.metaKey);
    setExplorerSelection(buildExplorerRangeSelection(entry.path, preserveExisting), state.explorerSelectionAnchorPath || entry.path);
    return;
  }
  if (event.ctrlKey || event.metaKey) {
    toggleExplorerSelection(entry.path);
    return;
  }
  setExplorerSelection([entry.path], entry.path);
}

async function deleteExplorerEntries(entries) {
  const uniqueEntries = [...new Map(entries.map((entry) => [entry.path, entry])).values()];
  if (!uniqueEntries.length) {
    return;
  }

  const confirmed = window.confirm(
    uniqueEntries.length === 1
      ? `${uniqueEntries[0].name} を削除しますか？`
      : `${uniqueEntries.length} 件の項目を削除しますか？`
  );
  if (!confirmed) {
    return;
  }

  if (uniqueEntries.length === 1) {
    await window.fuzzyApi.deleteExplorerEntry(uniqueEntries[0].path);
  } else {
    await window.fuzzyApi.deleteExplorerEntries(uniqueEntries.map((entry) => entry.path));
  }

  setExplorerSelection([], "");
  await loadDirectory(state.currentDir || state.rootDir, { syncBrowserFromDirectory: false });
  toast(
    uniqueEntries.length === 1
      ? `${uniqueEntries[0].name} を削除しました`
      : `${uniqueEntries.length} 件を削除しました`,
    "success"
  );
}

async function ensureCourseMapping(tab) {
  if (
    !tab?.courseName ||
    !shouldPromptForCourseMapping(tab) ||
    state.mappingPromptedCourses.has(tab.courseName)
  ) {
    return null;
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
    return prepared.existing;
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
  return { needsPrompt: true };
}

function mountBrowserLikeTab(tab, usePreload = true) {
  const contentEl = document.createElement("div");
  contentEl.className = "browser-surface";

  const webview = document.createElement("webview");
  webview.className = "browser-view";
  webview.src = tab.url;
  webview.partition = WEBVIEW_PARTITION;
  if (usePreload) {
    webview.preload = PRELOAD_PATH;
  }
  webview.setAttribute("allowpopups", "true");
  webview.addEventListener("mousedown", () => {
    focusBrowserSurface(tab);
  });
  webview.addEventListener("click", () => {
    focusBrowserSurface(tab);
  });

  webview.addEventListener("did-finish-load", () => {
    syncTabFromWebview(tab);
    if (tab.id === state.activeTabId) {
      focusBrowserSurface(tab);
    }
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
    if (tab.id === state.activeTabId) {
      focusBrowserSurface(tab);
    }
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

    if (event.channel === "link-menu") {
      openWebLinkMenu(payload);
      return;
    }

    if (event.channel === "open-link-tab") {
      createBrowserTab(payload.url, payload.label || UI_TEXT.defaultBrowserTitle);
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
    if (isExplorerLinkedTab(tab)) {
      tab.courseUrl = payload.url || tab.courseUrl || tab.url;
      tab.courseId = payload.courseId || extractCourseIdFromUrl(tab.url);
      tab.courseName = pageType === "course" ? normalizeCourseTitle(payload.courseName || "") : "";
      tab.title = tab.courseName || payload.title || tab.title;
    } else {
      tab.courseUrl = "";
      tab.courseId = "";
      tab.courseName = "";
      tab.title = payload.title || tab.title;
    }

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
  renderBrowserLayout();
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
  if (isExplorerLinkedTab(tab)) {
    const courseName = pageType === "course" ? normalizeCourseTitle(deriveCourseNameFromTitle(htmlTitle)) : "";
    tab.courseName = courseName;
    tab.courseId = extractCourseIdFromUrl(tab.url);
    tab.courseUrl = tab.url;
    tab.title = courseName || htmlTitle || tab.title;
  } else {
    tab.courseName = "";
    tab.courseId = "";
    tab.courseUrl = "";
    tab.title = htmlTitle || tab.title;
  }

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
  renderBrowserLayout();
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
  renderBrowserLayout();
}

function createLocalFileTab(filePath, title, options = {}) {
  const existingTab = findExistingDocumentTab({ path: filePath, kind: "local-file" });
  if (existingTab) {
    activateExistingTab(existingTab.id);
    return existingTab;
  }
  const tab = {
    id: createId("file-local"),
    kind: "local-file",
    title,
    path: filePath,
    cleanupOnClose: Boolean(options.cleanupOnClose),
    courseName: getActiveTab()?.courseName || "",
    courseUrl: getActiveTab()?.courseUrl || "",
    contentEl: null,
  };
  state.tabs.push(tab);
  mountTab(tab);
  const preserveSplitRoles = attachNewTabToSplit(tab.id);
  activateTab(tab.id, { preserveSplitRoles });
  return tab;
}

function openLocalFileInTab(filePath, title, options = {}) {
  try {
    if (title.toLowerCase().endsWith(".pdf")) {
      createLocalPdfTab(filePath, title, options);
      return;
    }
    createLocalFileTab(filePath, title, options);
  } catch (_error) {
    toast("このファイルは別タブ表示できません", "warn");
  }
}

async function createExplorerEntry(parentPath, kind) {
  const created = await window.fuzzyApi.createExplorerEntry({
    parentPath,
    kind,
  });
  if ((state.currentDir || state.rootDir) === parentPath) {
    await loadDirectory(parentPath, { syncBrowserFromDirectory: false });
  }
  toast(`${created.name} created`, "success");
}

async function openExplorerEntryWith(entry, program) {
  await window.fuzzyApi.openExplorerEntryWith({
    targetPath: entry.path,
    program,
  });
  toast(`${entry.name} opened in ${program}`, "success");
}

async function openExplorerExecutable(entry) {
  await window.fuzzyApi.openExplorerExecutable(entry.path);
  toast(`${entry.name} opened`, "success");
}

async function openExplorerEntrySmart(entry) {
  const ext = entry.name.split('.').pop().toLowerCase();
  if (ext === "exe") {
    return openExplorerExecutable(entry);
  }
  if (["docx", "doc"].includes(ext)) {
    return openExplorerEntryWith(entry, "word");
  }
  if (["xlsx", "xls"].includes(ext)) {
    return openExplorerEntryWith(entry, "excel");
  }
  if (["pptx", "ppt"].includes(ext)) {
    return openExplorerEntryWith(entry, "powerpoint");
  }
  if (["pdf"].includes(ext)) {
    return openLocalFileInTab(entry.path, entry.name);
  }
  if (["txt", "md", "js", "json", "html", "css", "py", "java", "c", "cpp"].includes(ext)) {
    return openExplorerEntryWith(entry, "vscode");
  }
  return openLocalFileInTab(entry.path, entry.name);
}

function buildExplorerCreateMenu(parentPath) {
  return {
    label: "New",
    expanded: false,
    children: [
      {
        label: "Word document",
        action: async () => createExplorerEntry(parentPath, "word"),
      },
      {
        label: "Excel workbook",
        action: async () => createExplorerEntry(parentPath, "excel"),
      },
      {
        label: "PowerPoint presentation",
        action: async () => createExplorerEntry(parentPath, "powerpoint"),
      },
      {
        label: "Text document",
        action: async () => createExplorerEntry(parentPath, "text"),
      },
      {
        label: "Folder",
        action: async () => createExplorerEntry(parentPath, "folder"),
      },
    ],
    action: async () => createExplorerEntry(parentPath, "folder"),
  };
}

function buildExplorerOpenWithMenu(entry) {
  return {
    label: "別タブで開く",
    expanded: false,
    children: [
      {
        label: "Word",
        action: async () => openExplorerEntryWith(entry, "word"),
      },
      {
        label: "Excel",
        action: async () => openExplorerEntryWith(entry, "excel"),
      },
      {
        label: "PowerPoint",
        action: async () => openExplorerEntryWith(entry, "powerpoint"),
      },
      {
        label: "VS Code",
        action: async () => openExplorerEntryWith(entry, "vscode"),
      },
    ],
    action: async () => openExplorerEntrySmart(entry),
  };
}

function isPlaceholderDownloadName(fileName) {
  const normalized = String(fileName || "").trim().toLowerCase();
  return !normalized || ["download", "view.php", "view.htm", "view.html"].includes(normalized);
}

function getFileNameSelectionEnd(value) {
  const normalized = String(value ?? "");
  const lastDotIndex = normalized.lastIndexOf(".");
  if (lastDotIndex <= 0) {
    return normalized.length;
  }
  return lastDotIndex;
}

function focusDialogInput(input, { select = false, selectFileStem = false } = {}) {
  if (!input) {
    return;
  }
  const tryFocus = () => {
    input.focus({ preventScroll: true });
    if (select) {
      if (selectFileStem) {
        input.setSelectionRange(0, getFileNameSelectionEnd(input.value));
      } else {
        input.select();
      }
    }
  };
  requestAnimationFrame(tryFocus);
  setTimeout(tryFocus, 60);
  setTimeout(tryFocus, 180);
}

function setDialogFocusLock(locked) {
  state.dialogFocusLock = Boolean(locked);
}

function isImeComposing(event) {
  return Boolean(event?.isComposing || event?.keyCode === 229 || event?.currentTarget?.dataset?.imeComposing === "true");
}

function registerDialogTextInput(input, onSubmit) {
  if (!input) {
    return;
  }
  input.addEventListener("compositionstart", () => {
    input.dataset.imeComposing = "true";
  });
  input.addEventListener("compositionend", () => {
    input.dataset.imeComposing = "false";
  });
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key !== "Enter" || isImeComposing(event)) {
      return;
    }
    event.preventDefault();
    onSubmit();
  });
}

async function duplicateExplorerEntry(entry) {
  await window.fuzzyApi.duplicateExplorerEntry(entry.path);
  await loadDirectory(state.currentDir || state.rootDir, { syncBrowserFromDirectory: false });
  toast(`${entry.name} をコピーしました`, "success");
}

function showRenameDialog(entry) {
  state.renameDraft = entry;
  setDialogFocusLock(true);
  elements.renameFileNameInput.value = entry.name;
  elements.renameCurrentName.textContent = `現在の名前: ${entry.name}`;
  elements.renameDialog.showModal();
  focusDialogInput(elements.renameFileNameInput, { select: true, selectFileStem: true });
}

async function deleteExplorerEntry(entry) {
  await deleteExplorerEntries([entry]);
}

function openExplorerBackgroundMenu(x, y) {
  const targetDir = state.currentDir || state.rootDir;
  if (!targetDir) {
    return;
  }
  showContextMenu([buildExplorerCreateMenu(targetDir)], x, y);
}

function openExplorerEntryMenu(entry, x, y) {
  if (state.selectedExplorerPaths.size > 1 && state.selectedExplorerPaths.has(entry.path)) {
    showContextMenu([
      {
        label: "削除",
        tone: "danger",
        action: async () => deleteExplorerEntries(getSelectedExplorerEntries()),
      },
    ], x, y);
    return;
  }

  const items = [];
  if (entry.isDirectory) {
    items.push({
      label: "開く",
      action: () => loadDirectory(entry.path, { syncBrowserFromDirectory: true }),
    });
  }
  if (entry.withinRoot !== false) {
    items.push({
      label: "Copy",
      action: async () => duplicateExplorerEntry(entry),
    });
    items.push({
      label: "Rename",
      action: async () => showRenameDialog(entry),
    });
    items.push({
      label: "削除",
      tone: "danger",
      action: async () => deleteExplorerEntry(entry),
    });
  }
  if (!entry.isDirectory) {
    items.push(buildExplorerOpenWithMenu(entry));
  }
  if (entry.withinRoot !== false) {
    items.unshift(buildExplorerCreateMenu(entry.isDirectory ? entry.path : (state.currentDir || state.rootDir)));
    if (entry.isDirectory) {
      items.push({
        label: "VS Code",
        action: async () => openExplorerEntryWith(entry, "vscode"),
      });
    }
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
      fileName: customFileName || payload.fileName || "",
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
      fileName: customFileName || payload.fileName || "",
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
            });
          },
        })),
      ],
      action: async () => {
        await showDownloadDialog(payload, tab, {
          folderPath: getDefaultFolder(),
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
    button.addEventListener("pointerdown", (event) => {
      const closeTarget = closestFromEventTarget(event.target, "[data-close-tab]");
      if (event.button !== 0 || closeTarget) {
        return;
      }
      button.setPointerCapture(event.pointerId);
      beginTabSlideDrag(tab.id, event.pointerId, event.clientX);
    });
    button.addEventListener("auxclick", (event) => {
      if (event.button !== 1) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      toggleSplitEditMode();
    });
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const items = [
        ...(tab.id !== state.activeTabId ? [{
          label: "右に分割表示",
          action: async () => {
            openSplitViewWithTab(tab.id);
          },
        }] : []),
        ...(state.splitView.enabled && (state.splitView.secondaryTabId === tab.id || state.splitView.primaryTabId === tab.id) ? [{
          label: "分割を閉じる",
          action: async () => {
            disableSplitView();
          },
        }] : []),
      ];
      if (!items.length) {
        return;
      }
      showContextMenu(items, event.clientX, event.clientY);
    });
    elements.browserTabStrip.appendChild(button);
  }

  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.className = "browser-tab";
  addButton.dataset.addTab = "true";
  addButton.innerHTML = `<span class="tab-title">＋</span>`;
  elements.browserTabStrip.appendChild(addButton);
  applyTabSlideDragStyles();
}

function activateTab(tabId, options = {}) {
  if (state.splitView.enabled && !options.preserveSplitRoles) {
    if (state.splitView.secondaryTabId === tabId) {
      const previousPrimary = state.splitView.primaryTabId || state.activeTabId;
      state.splitView.primaryTabId = tabId;
      state.splitView.secondaryTabId = previousPrimary && previousPrimary !== tabId ? previousPrimary : state.splitView.secondaryTabId;
    } else {
      state.splitView.primaryTabId = tabId;
    }
  }
  state.activeTabId = tabId;
  renderBrowserTabs();
  renderBrowserLayout();
  syncAddressBar();
  focusBrowserSurface(getActiveTab());
  void updateCurrentCourse(getActiveTab());
}

function openWebLinkMenu(payload) {
  const x = payload.x || Math.round(window.innerWidth / 2);
  const y = payload.y || Math.round(window.innerHeight / 2);
  showContextMenu([
    {
      label: "別のタブで開く",
      action: async () => {
        createBrowserTab(payload.url, payload.label || UI_TEXT.defaultBrowserTitle);
      },
    },
  ], x, y);
}

async function updateCurrentCourse(tab) {
  const courseName = isExplorerLinkedTab(tab) && shouldPromptForCourseMapping(tab)
    ? getDisplayCourseName(tab?.courseName)
    : UI_TEXT.noCourse;
  elements.activeCourseLabel.textContent = courseName;

  if (isExplorerLinkedTab(tab) && tab?.courseName && shouldPromptForCourseMapping(tab)) {
    const ensuredMapping = await ensureCourseMapping(tab);
    if (ensuredMapping?.needsPrompt) {
      renderSubmissionFolderButton();
      renderTimeline();
      return;
    }
    const mapping = ensuredMapping || findMappingForTab(tab) || findMappingForCourse(tab.courseName);
    if (mapping) {
      await loadDirectory(mapping.folderPath, { syncBrowserFromDirectory: false });
    }
  }

  renderSubmissionFolderButton();
  renderTimeline();
}

function renderDirectory(entries) {
  state.explorerEntries = Array.isArray(entries) ? entries : [];
  syncExplorerSelection();
  elements.fileList.innerHTML = "";
  if (!state.explorerEntries.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = UI_TEXT.emptyFiles;
    elements.fileList.appendChild(empty);
    return;
  }

  for (const entry of state.explorerEntries) {
    const icon = getExplorerFileIcon(entry);
    const row = document.createElement("button");
    row.type = "button";
    const isSelected = state.selectedExplorerPaths.has(entry.path);
    const isDropTarget = state.explorerDropTargetPath === entry.path;
    row.className = `file-row ${isSelected ? "selected" : ""} ${isDropTarget ? "drop-target" : ""}`.trim();
    row.draggable = true;
    row.title = entry.name;
    row.dataset.entryPath = entry.path;
    row.innerHTML = `
      <span class="file-name-cell">
        <span class="file-icon">${entry.isDirectory ? "📁" : entry.name.toLowerCase().endsWith(".pdf") ? "📄" : "🗎"}</span>
        <span class="file-name-text" title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</span>
      </span>
      <span class="file-meta-text">${formatTimestamp(entry.modifiedAt)}</span>
      <span class="file-meta-text">${entry.isDirectory ? "-" : formatFileSize(entry.size)}</span>
    `;

    const iconEl = row.querySelector(".file-icon");
    if (iconEl) {
      iconEl.textContent = icon.label;
      iconEl.classList.add(...icon.classNames);
    }

    row.addEventListener("click", (event) => {
      event.preventDefault();
      handleExplorerSelection(entry, event);
      renderExplorerSelectionState();
    });

    row.addEventListener("dblclick", async (event) => {
      event.preventDefault();
      setExplorerSelection([entry.path], entry.path);
      renderExplorerSelectionState();
      if (entry.isDirectory) {
        await loadDirectory(entry.path, { syncBrowserFromDirectory: true });
        return;
      }
      openExplorerEntrySmart(entry);
    });

    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      if (!state.selectedExplorerPaths.has(entry.path)) {
        setExplorerSelection([entry.path], entry.path);
        renderExplorerSelectionState();
      }
      openExplorerEntryMenu(entry, event.clientX, event.clientY);
    });

    row.addEventListener("dragstart", (event) => {
      if (!state.selectedExplorerPaths.has(entry.path)) {
        setExplorerSelection([entry.path], entry.path);
        renderExplorerSelectionState();
      }
      state.draggedExplorerPaths = state.selectedExplorerPaths.has(entry.path)
        ? [...state.selectedExplorerPaths]
        : [entry.path];
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", state.draggedExplorerPaths.join("\n"));
    });

    row.addEventListener("dragend", () => {
      state.draggedExplorerPaths = [];
      state.explorerDropTargetPath = "";
      renderDirectory(state.explorerEntries);
    });

    row.addEventListener("dragover", (event) => {
      if (!entry.isDirectory || !state.draggedExplorerPaths.length) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      if (state.explorerDropTargetPath !== entry.path) {
        state.explorerDropTargetPath = entry.path;
        renderExplorerDropTargetState();
      }
    });

    row.addEventListener("dragleave", () => {
      if (state.explorerDropTargetPath === entry.path) {
        state.explorerDropTargetPath = "";
        renderExplorerDropTargetState();
      }
    });

    row.addEventListener("drop", async (event) => {
      if (!entry.isDirectory || !state.draggedExplorerPaths.length) {
        return;
      }
      event.preventDefault();
      const draggedPaths = [...state.draggedExplorerPaths];
      state.draggedExplorerPaths = [];
      state.explorerDropTargetPath = "";
      renderExplorerDropTargetState();
      try {
        const result = await window.fuzzyApi.moveExplorerEntries({
          sourcePaths: draggedPaths,
          destinationDirPath: entry.path,
        });
        if (Array.isArray(result?.mappings)) {
          state.mappings = result.mappings;
          renderMappings();
          renderSubmissionFolderButton();
        }
        setExplorerSelection([], "");
        await loadDirectory(state.currentDir || state.rootDir, { syncBrowserFromDirectory: false });
        toast(`${result?.movedCount || draggedPaths.length} 件を移動しました`, "success");
      } catch (error) {
        toast(error.message, "error");
      }
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
    const textParts = splitTimelineEntryText(entry.title);
    const card = document.createElement("button");
    card.type = "button";
    const isActive = Boolean(activeTab?.courseId && entry.courseId && activeTab.courseId === entry.courseId);
    card.className = `timeline-card ${isActive ? "active-course" : ""}`;
    const detailHtml = textParts.detail
      ? `<div class="timeline-card-detail">${escapeHtml(textParts.detail)}</div>`
      : "";
    card.innerHTML = `
      <div class="timeline-card-top">
        <span class="timeline-badge ${meta.badgeTone}">${escapeHtml(meta.badge)}</span>
        <span class="timeline-card-meta">${meta.dueDate ? formatTimestamp(meta.dueDate.toISOString()) : ""}</span>
      </div>
      <div class="timeline-card-title">${escapeHtml(textParts.title || entry.title)}</div>
      ${detailHtml}
    `;
    card.addEventListener("click", () => {
      navigateCurrentBrowserTab(entry.href, entry.title || UI_TEXT.defaultBrowserTitle);
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
      if (mapping.courseUrl && activeTab?.kind === "browser" && isExplorerLinkedTab(activeTab) && activeTab.courseUrl !== mapping.courseUrl) {
        navigateCurrentBrowserTab(mapping.courseUrl, mapping.courseName || UI_TEXT.defaultBrowserTitle);
      }
      if (isExplorerLinkedTab(activeTab)) {
        elements.activeCourseLabel.textContent = getDisplayCourseName(mapping.courseName);
      }
    }
  }

  renderSubmissionFolderButton();
}

async function saveMapping(courseName, folderPath, matchType, courseUrl) {
  const mapping = await window.fuzzyApi.saveMapping({
    courseName: normalizeCourseTitle(courseName),
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

async function configureSubmissionFolder(mapping, onComplete = null, menuPosition = null) {
  if (!mapping) {
    toast("先にコースフォルダを紐づけてください", "warn");
    return;
  }
  const x = Math.round(menuPosition?.x ?? window.innerWidth / 2);
  const y = Math.round(menuPosition?.y ?? window.innerHeight / 2);
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
    fileName: sanitizeFileName(
      !isPlaceholderDownloadName(options.fileName)
        ? options.fileName
        : resolved?.fileName || payload.label || "download"
    ),
    folderPath: baseFolder,
    lessonFolder: options.lessonFolder || "",
    courseName: payload.courseName || tab.courseName || "",
    canPreview: Boolean(resolved?.canPreview),
  };

  elements.downloadFolderLabel.textContent = state.downloadDraft.folderPath;
  elements.downloadFileNameInput.value = state.downloadDraft.fileName;
  elements.downloadFileNameHelp.textContent = state.downloadDraft.fileName;
  setDialogFocusLock(true);
  elements.downloadDialog.showModal();
  focusDialogInput(elements.downloadFileNameInput, { select: true, selectFileStem: true });
}

function setupDashboardWebview() {
  elements.dashboardWebview.addEventListener("did-finish-load", scheduleDashboardTimelinePull);
  elements.dashboardWebview.addEventListener("did-navigate", scheduleDashboardTimelinePull);
  elements.dashboardWebview.addEventListener("did-navigate-in-page", scheduleDashboardTimelinePull);
}

function absorbWheelEvent(event) {
  event.stopPropagation();
}

function wireEvents() {
  elements.browserSplitter.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    elements.browserSplitter.setPointerCapture(event.pointerId);
    const onMove = (moveEvent) => {
      const bounds = elements.browserContent.getBoundingClientRect();
      const nextRatio = (moveEvent.clientX - bounds.left) / Math.max(bounds.width, 1);
      state.splitView.ratio = clamp(nextRatio, 0.25, 0.75);
      renderBrowserLayout();
    };
    const onUp = () => {
      elements.browserSplitter.removeEventListener("pointermove", onMove);
      elements.browserSplitter.removeEventListener("pointerup", onUp);
      elements.browserSplitter.removeEventListener("pointercancel", onUp);
    };
    elements.browserSplitter.addEventListener("pointermove", onMove);
    elements.browserSplitter.addEventListener("pointerup", onUp);
    elements.browserSplitter.addEventListener("pointercancel", onUp);
  });

  document.addEventListener("pointermove", (event) => {
    if (state.tabSlideDrag?.pointerId === event.pointerId) {
      updateTabSlideDrag(event.clientX);
    }
  });
  document.addEventListener("pointerup", (event) => {
    finishTabSlideDrag(event.pointerId);
  });
  document.addEventListener("pointercancel", (event) => {
    finishTabSlideDrag(event.pointerId);
  });

  elements.contextMenuBackdrop.addEventListener("mousedown", hideContextMenu);
  elements.contextMenuBackdrop.addEventListener("click", hideContextMenu);
  elements.sidePanel.addEventListener("wheel", absorbWheelEvent, { passive: true });
  elements.fileList.addEventListener("wheel", absorbWheelEvent, { passive: true });
  elements.timelineList.addEventListener("wheel", absorbWheelEvent, { passive: true });
  elements.fileList.addEventListener("contextmenu", (event) => {
    if (closestFromEventTarget(event.target, ".file-row")) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (state.selectedExplorerPaths.size > 0) {
      showContextMenu([
        {
          label: "削除",
          tone: "danger",
          action: async () => deleteExplorerEntries(getSelectedExplorerEntries()),
        },
      ], event.clientX, event.clientY);
      return;
    }
    openExplorerBackgroundMenu(event.clientX, event.clientY);
  });
  elements.fileList.addEventListener("click", (event) => {
    if (closestFromEventTarget(event.target, ".file-row")) {
      return;
    }
    if (state.selectedExplorerPaths.size > 0) {
      setExplorerSelection([], "");
      renderExplorerSelectionState();
    }
  });
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
    if (
      !closestFromEventTarget(event.target, ".file-row") &&
      !closestFromEventTarget(event.target, ".browser-tab") &&
      !closestFromEventTarget(event.target, "#context-menu") &&
      !closestFromEventTarget(event.target, "#file-list")
    ) {
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

  document.querySelector('[data-action="favorite"]')?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    showContextMenu(
      FAVORITE_LINKS.map((entry) => ({
        label: entry.label,
        action: async () => {
          const url = typeof entry.url === "function" ? entry.url() : entry.url;
          createBrowserTab(url, entry.title, { explorerLinked: entry.explorerLinked });
        },
      })),
      rect.left,
      rect.bottom + 8,
    );
  });

  elements.addressInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") {
      return;
    }
    navigateCurrentBrowserTab(event.currentTarget.value, UI_TEXT.defaultBrowserTitle);
  });

  elements.browserTabStrip.addEventListener("click", (event) => {
    if (Date.now() < state.tabClickSuppressUntil) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
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
      if (state.splitView.editing) {
        const selectedTabId = tabTarget.dataset.tabId;
        const primaryTabId = state.splitView.enabled
          ? (state.splitView.primaryTabId || state.activeTabId)
          : state.activeTabId;
        if (selectedTabId !== primaryTabId) {
          state.splitView.enabled = true;
          state.splitView.primaryTabId = primaryTabId;
          state.splitView.secondaryTabId = selectedTabId;
          state.activeTabId = selectedTabId;
          renderBrowserTabs();
          renderBrowserLayout();
          syncAddressBar();
          focusBrowserSurface(getActiveTab());
          void updateCurrentCourse(getActiveTab());
        }
        return;
      }
      activateTab(tabTarget.dataset.tabId);
    }
  });

  document.querySelector("#new-tab-button")?.addEventListener("click", () => {
    createBrowserTab(state.moodleHome, UI_TEXT.defaultBrowserTitle);
  });

  document.querySelector("#batch-download-button")?.addEventListener("click", async () => {
    const currentTab = getActiveTab();
    if (!currentTab || currentTab.kind !== "browser") {
      toast("一括ダウンロードは Moodle タブで使ってください", "warn");
      return;
    }
    const result = await window.fuzzyApi.requestBatchDownload(currentTab.id);
    toast(`${result.queued} 件のダウンロードを開始しました`, "success");
  });

  document.querySelector("#panel-refresh-button").addEventListener("click", async () => {
    if (state.activePanelTab === "timeline") {
      ensureDashboardLoaded();
      scheduleDashboardRefresh();
      return;
    }
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

  document.querySelector("#choose-root-button")?.addEventListener("click", chooseRootDirectory);
  document.querySelector("#dialog-choose-root-button").addEventListener("click", chooseRootDirectory);
  elements.goRootFolderButton?.addEventListener("click", async () => {
    if (!state.rootDir) {
      toast("保存ルートがまだ設定されていません", "warn");
      return;
    }
    await loadDirectory(state.rootDir, { syncBrowserFromDirectory: false });
  });

  elements.openSettingsButton?.addEventListener("click", () => {
    elements.settingsDialog.showModal();
  });

  elements.saveMoodleHomeButton?.addEventListener("click", async () => {
    try {
      const preferences = await window.fuzzyApi.updatePreferences({
        moodleHome: elements.moodleHomeInput.value,
      });
      setMoodleHome(preferences.moodleHome);
      toast("Moodle URL を保存しました", "success");
    } catch (error) {
      toast(error.message, "error");
    }
  });

  elements.checkUpdatesButton?.addEventListener("click", async () => {
    try {
      const status = await window.fuzzyApi.checkForUpdates();
      applyAutoUpdateStatus(status);
      if (!status.enabled) {
        toast("自動更新はインストール版でのみ利用できます", "warn");
      }
    } catch (error) {
      toast(error.message, "error");
    }
  });

  elements.installUpdateButton?.addEventListener("click", async () => {
    try {
      const result = await window.fuzzyApi.installDownloadedUpdate();
      if (!result.ok) {
        toast("まだ適用できる更新がありません", "warn");
        return;
      }
      toast("更新を適用するため再起動します", "info");
    } catch (error) {
      toast(error.message, "error");
    }
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

  elements.mappingDialog.addEventListener("close", () => {
    const pendingCourseName = state.pendingMappingCourse?.courseName;
    if (pendingCourseName) {
      state.mappingPromptedCourses.delete(pendingCourseName);
    }
    state.pendingMappingCourse = null;
  });

  elements.explorerTabButton.addEventListener("click", () => setPanelTab("explorer"));
  elements.timelineTabButton.addEventListener("click", () => setPanelTab("timeline"));
  elements.dockToggleButton.addEventListener("click", () => {
    state.panelVisible = !state.panelVisible;
    renderSidePanelVisibility();
  });
  elements.hideSidePanelButton?.addEventListener("click", () => {
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
      await configureSubmissionFolder(mapping, null, {
        x: event.clientX,
        y: event.clientY,
      });
      return;
    }
    await loadDirectory(mapping.submissionFolderPath, { syncBrowserFromDirectory: false });
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
    const fileName = sanitizeFileName(elements.downloadFileNameInput.value);
    if (!fileName) {
      toast("保存するファイル名を入力してください", "warn");
      focusDialogInput(elements.downloadFileNameInput, { select: true, selectFileStem: true });
      return;
    }
    await window.fuzzyApi.startCustomDownload({
      tabId: state.downloadDraft.tabId,
      url: state.downloadDraft.url,
      folderPath: state.downloadDraft.folderPath,
      fileName,
      lessonFolder: state.downloadDraft.lessonFolder || "",
    });
    elements.downloadDialog.close();
  });
  elements.downloadForm.addEventListener("submit", (event) => {
    event.preventDefault();
  });
  elements.downloadCancelButton.addEventListener("click", () => {
    elements.downloadDialog.close();
  });
  elements.downloadFileNameInput.addEventListener("input", () => {
    const nextValue = elements.downloadFileNameInput.value;
    if (state.downloadDraft) {
      state.downloadDraft.fileName = nextValue;
    }
    elements.downloadFileNameHelp.textContent = nextValue.trim() || "ファイル名を入力してください";
  });
  elements.downloadDialog.addEventListener("close", () => {
    setDialogFocusLock(false);
    state.downloadDraft = null;
    elements.downloadFileNameInput.value = "";
    elements.downloadFileNameHelp.textContent = "";
  });
  elements.renameSaveButton.addEventListener("click", async () => {
    if (!state.renameDraft) {
      return;
    }

    const nextName = elements.renameFileNameInput.value.trim();
    if (!nextName) {
      toast("新しい名前を入力してください", "warn");
      focusDialogInput(elements.renameFileNameInput, { select: true, selectFileStem: true });
      return;
    }
    if (nextName === state.renameDraft.name) {
      elements.renameDialog.close();
      return;
    }

    const previousName = state.renameDraft.name;
    const renameResult = await window.fuzzyApi.renameExplorerEntry({
      targetPath: state.renameDraft.path,
      nextName,
    });
    if (Array.isArray(renameResult?.mappings)) {
      state.mappings = renameResult.mappings;
      renderMappings();
      renderSubmissionFolderButton();
    }
    elements.renameDialog.close();
    await loadDirectory(state.currentDir || state.rootDir, { syncBrowserFromDirectory: false });
    toast(`${previousName} の名前を変更しました`, "success");
  });
  elements.renameForm.addEventListener("submit", (event) => {
    event.preventDefault();
  });
  elements.renameCancelButton.addEventListener("click", () => {
    elements.renameDialog.close();
  });
  elements.renameDialog.addEventListener("close", () => {
    setDialogFocusLock(false);
    state.renameDraft = null;
    elements.renameCurrentName.textContent = "";
    elements.renameFileNameInput.value = "";
  });
  elements.renameDialog.addEventListener("click", (event) => {
    if (event.target === elements.renameDialog) {
      elements.renameDialog.close();
    }
  });
  registerDialogTextInput(elements.downloadFileNameInput, () => elements.downloadSaveButton.click());
  registerDialogTextInput(elements.renameFileNameInput, () => elements.renameSaveButton.click());

  window.addEventListener("resize", positionDockToggle);
  window.addEventListener("resize", hideContextMenu);
  window.addEventListener("resize", renderBrowserLayout);
}

async function initialize() {
  const defaults = await window.fuzzyApi.getDefaults();
  setMoodleHome(defaults.moodleHome);
  state.dashboardAutoload = Boolean(defaults.dashboardAutoload);
  applyAutoUpdateStatus({
    currentVersion: defaults.appVersion || "",
    ...(defaults.autoUpdate || {}),
  });

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

window.fuzzyApi.onAppUpdateEvent((payload) => {
  applyAutoUpdateStatus(payload);
  if (payload.type === "update-available") {
    toast("新しい更新のダウンロードを開始しました", "info");
  } else if (payload.type === "update-downloaded") {
    toast("更新の準備ができました。設定から再起動して適用できます", "success");
  } else if (payload.type === "error") {
    toast(payload.message || "更新中にエラーが発生しました", "error");
  }
});

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
  openLocalFileInTab(payload.localPath, payload.fileName || "download", {
    cleanupOnClose: Boolean(payload.cleanupOnClose),
  });
});

window.fuzzyApi.onDownloadPrompt(async (payload) => {
  const tab = findTab(payload.tabId) || getActiveTab();
  if (!tab) {
    return;
  }
  openMoodleFileMenu(payload, tab);
});

window.fuzzyApi.onLinkMenu((payload) => {
  openWebLinkMenu(payload);
});

initialize();
