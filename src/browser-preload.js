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
  return (title || "")
    .replace(/\s+/g, " ")
    .replace(/\s*[|:-]\s*Wakayama.*Moodle.*$/i, "")
    .replace(/\s*[|:-]\s*和歌山大学.*Moodle.*$/i, "")
    .replace(/\s*Moodle\d*\s*$/i, "")
    .trim();
}

function fallbackCourseNameFromDom() {
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    if (element?.textContent?.trim()) {
      return element.textContent.trim();
    }
  }
  return "";
}

function deriveCourseName() {
  const titleCandidate = normalizeTitle(document.title);
  const genericTitles = new Set([
    "",
    "Dashboard",
    "Home",
    "Timeline",
    "My courses",
    "ダッシュボード",
    "ホーム",
    "タイムライン",
    "マイコース",
  ]);

  if (!genericTitles.has(titleCandidate)) {
    return titleCandidate;
  }

  return fallbackCourseNameFromDom();
}

function readCourseContext() {
  ipcRenderer.sendToHost("page-context", {
    url: location.href,
    title: document.title,
    courseName: deriveCourseName(),
    courseId: extractCourseId(location.href),
  });
}

function deriveTimelineItems() {
  const anchors = [
    ...document.querySelectorAll("[data-region*='timeline'] a[href]"),
    ...document.querySelectorAll(".block_timeline a[href]"),
    ...document.querySelectorAll(".timeline a[href]"),
    ...document.querySelectorAll("[data-block='timeline'] a[href]"),
  ];

  const seen = new Set();
  const items = [];

  for (const anchor of anchors) {
    const href = anchor.href;
    const label = (anchor.textContent || "").trim().replace(/\s+/g, " ");
    if (!href || !label || seen.has(href)) {
      continue;
    }

    const container = anchor.closest("li, article, .event, .list-group-item, .activity-item, tr, .timeline-event");
    const nearbyText = (container?.textContent || "").replace(/\s+/g, " ").trim();
    const courseName = nearbyText.replace(label, "").trim().slice(0, 120);

    items.push({
      id: `${href}::${label}`,
      href,
      title: label,
      courseName,
      courseId: extractCourseId(href),
      rawText: nearbyText,
    });
    seen.add(href);
  }

  ipcRenderer.sendToHost("timeline-data", {
    url: location.href,
    title: document.title,
    items,
    refreshedAt: new Date().toISOString(),
  });
}

function isDownloadLikeUrl(href) {
  return (
    /\.(pdf|docx?|pptx?|xlsx?|zip)(\?|$)/i.test(href) ||
    /mod\/resource\/view\.php/i.test(href) ||
    /pluginfile\.php/i.test(href)
  );
}

function emitDownloadContext(event) {
  const anchor = event.target.closest("a[href]");
  if (!anchor || !isDownloadLikeUrl(anchor.href)) {
    return;
  }

  const fileName = decodeURIComponent(anchor.href.split("/").at(-1)?.split("?")[0] || anchor.textContent?.trim() || "download");
  ipcRenderer.sendToHost("download-context", {
    url: anchor.href,
    fileName,
    label: (anchor.textContent || "").trim(),
    courseName: deriveCourseName(),
    courseId: extractCourseId(location.href),
    title: document.title,
  });
}

const emitAll = debounce(() => {
  readCourseContext();
  deriveTimelineItems();
}, 250);

window.addEventListener("DOMContentLoaded", emitAll);
window.addEventListener("load", emitAll);
window.addEventListener("focus", emitAll);
window.addEventListener("contextmenu", emitDownloadContext, true);

const observer = new MutationObserver(emitAll);
window.addEventListener("DOMContentLoaded", () => {
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
});
