const { ipcRenderer } = require("electron");
const selectors = require("./course-selectors.json");

function debounce(callback, wait) {
  let timeoutId = null;
  return () => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(callback, wait);
  };
}

function extractCourseId(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    return parsed.searchParams.get("id") || "";
  } catch (_error) {
    return "";
  }
}

function normalizeTitle(title) {
  return String(title || "")
    .replace(/^\s*\u30b3\u30fc\u30b9\s*[:\uFF1A]\s*/u, "")
    .replace(/\s*(?:(?:\||\uFF5C)\s*)?\u3010\u548c\u6b4c\u5c71\u5927\u5b66\u3011\s*$/u, "")
    .replace(/\s+/g, " ")
    .replace(/\s*[|:-]\s*Wakayama.*Moodle.*$/i, "")
    .replace(/\s*[|\uFF5C:\-]\s*\u548c\u6b4c\u5c71\u5927\u5b66.*Moodle.*$/u, "")
    .replace(/\s*Moodle\d*\s*$/i, "")
    .trim();
}

function isWakayamaMoodlePage(targetUrl) {
  try {
    const parsed = new URL(targetUrl || "");
    return /moodle(?:\d{4})?\.wakayama-u\.ac\.jp$/i.test(parsed.hostname);
  } catch (_error) {
    return false;
  }
}

function isMoodleHomePath(pathname) {
  return pathname === "/" || /^\/\d{4}\/?$/i.test(pathname);
}

function isGenericMoodlePage(targetUrl, title = "") {
  if (!isWakayamaMoodlePage(targetUrl)) {
    return false;
  }

  try {
    const parsed = new URL(targetUrl || "");
    const pathname = parsed.pathname.toLowerCase();
    const normalizedTitle = normalizeTitle(title).toLowerCase();
    return (
      isMoodleHomePath(pathname) ||
      pathname.endsWith("/my/") ||
      pathname.endsWith("/my/index.php") ||
      pathname.endsWith("/course/index.php") ||
      normalizedTitle === "dashboard" ||
      normalizedTitle === "home" ||
      normalizedTitle === "my courses"
    );
  } catch (_error) {
    return false;
  }
}

function isCoursePage(targetUrl) {
  if (!isWakayamaMoodlePage(targetUrl)) {
    return false;
  }

  try {
    const parsed = new URL(targetUrl || "");
    return parsed.pathname.toLowerCase().endsWith("/course/view.php") && Boolean(parsed.searchParams.get("id"));
  } catch (_error) {
    return false;
  }
}

function safeSendToHost(channel, payload) {
  try {
    ipcRenderer.sendToHost(channel, payload);
  } catch (_error) {
    // Ignore transient host communication failures during navigation.
  }
}

function fallbackCourseNameFromDom() {
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    const value = normalizeTitle(element?.textContent?.trim() || "");
    if (value) {
      return value;
    }
  }
  return "";
}

function deriveCourseName() {
  if (!isCoursePage(location.href) || isGenericMoodlePage(location.href, document.title)) {
    return "";
  }

  const titleCandidate = normalizeTitle(document.title);
  const genericTitles = new Set(["", "Dashboard", "Home", "Timeline", "My courses"]);
  if (!genericTitles.has(titleCandidate)) {
    return titleCandidate;
  }

  return fallbackCourseNameFromDom();
}

function readCourseContext() {
  safeSendToHost("page-context", {
    url: location.href,
    title: document.title,
    courseName: deriveCourseName(),
    courseId: extractCourseId(location.href),
  });
}

function isDownloadLikeUrl(href) {
  return (
    /\.(pdf|docx?|pptx?|xlsx?|zip)(\?|$)/i.test(href) ||
    /mod\/resource\/view\.php/i.test(href) ||
    /pluginfile\.php/i.test(href)
  );
}

function handleLinkContextMenu(event) {
  const target = event.target instanceof Element ? event.target : null;
  const anchor = target?.closest("a[href]");
  if (!anchor) {
    safeSendToHost("hide-context-menu", {});
    return;
  }
  if (isDownloadLikeUrl(anchor.href)) {
    safeSendToHost("hide-context-menu", {});
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation?.();
  safeSendToHost("link-menu", {
    url: anchor.href,
    label: (anchor.textContent || "").trim(),
    x: event.clientX,
    y: event.clientY,
  });
}

function handleLinkAuxClick(event) {
  if (event.button !== 1) {
    return;
  }
  const target = event.target instanceof Element ? event.target : null;
  const anchor = target?.closest("a[href]");
  if (!anchor || isDownloadLikeUrl(anchor.href)) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation?.();
  safeSendToHost("open-link-tab", {
    url: anchor.href,
    label: (anchor.textContent || "").trim(),
  });
}

function summarizeDropTarget(target) {
  const element = target instanceof Element ? target.closest(".dndupload-message, .filemanager, .filemanager-container, .filepicker, form, body") : null;
  if (!element) {
    return { tag: "", classes: "", text: "" };
  }
  return {
    tag: element.tagName.toLowerCase(),
    classes: element.className || "",
    text: String(element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120),
  };
}

function emitDragDebug(phase, event) {
  const dataTransfer = event.dataTransfer || null;
  const types = dataTransfer?.types ? [...dataTransfer.types] : [];
  const files = dataTransfer?.files ? Array.from(dataTransfer.files).map((file) => file.name) : [];
  safeSendToHost("dnd-debug", {
    phase,
    url: location.href,
    fileCount: files.length,
    files,
    types,
    target: summarizeDropTarget(event.target),
  });
}

const scheduleCourseContextUpdate = debounce(readCourseContext, 200);

window.addEventListener("DOMContentLoaded", () => {
  readCourseContext();

  const observer = new MutationObserver(scheduleCourseContextUpdate);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  document.addEventListener("click", () => {
    setTimeout(readCourseContext, 80);
  }, true);
  document.addEventListener("contextmenu", handleLinkContextMenu, true);
  document.addEventListener("auxclick", handleLinkAuxClick, true);
  document.addEventListener("dragenter", (event) => {
    emitDragDebug("dragenter", event);
  }, true);
  document.addEventListener("dragover", (event) => {
    emitDragDebug("dragover", event);
  }, true);
  document.addEventListener("drop", (event) => {
    emitDragDebug("drop", event);
  }, true);
});

window.addEventListener("load", readCourseContext);
window.addEventListener("hashchange", readCourseContext);
window.addEventListener("popstate", readCourseContext);
