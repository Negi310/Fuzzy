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

function isWakayamaMoodlePage(targetUrl) {
  try {
    const parsed = new URL(targetUrl || "");
    return /moodle(?:\d{4})?\.wakayama-u\.ac\.jp$/i.test(parsed.hostname);
  } catch (_error) {
    return false;
  }
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
      pathname === "/2026" ||
      pathname === "/2026/" ||
      pathname.endsWith("/my/") ||
      pathname.endsWith("/my/index.php") ||
      pathname.endsWith("/course/index.php") ||
      normalizedTitle === "dashboard" ||
      normalizedTitle === "home" ||
      normalizedTitle === "my courses" ||
      normalizedTitle === "ダッシュボード" ||
      normalizedTitle === "ホーム" ||
      normalizedTitle === "マイコース"
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
  safeSendToHost("page-context", {
    url: location.href,
    title: document.title,
    courseName: deriveCourseName(),
    courseId: extractCourseId(location.href),
  });
}

function deriveTimelineItems() {
  if (isGenericMoodlePage(location.href, document.title)) {
    safeSendToHost("timeline-data", {
      url: location.href,
      title: document.title,
      items: [],
      refreshedAt: new Date().toISOString(),
    });
    return;
  }

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

  safeSendToHost("timeline-data", {
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
  const target = event.target instanceof Element ? event.target : null;
  const anchor = target?.closest("a[href]");
  if (!anchor || !isDownloadLikeUrl(anchor.href)) {
    return;
  }

  const fileName = decodeURIComponent(anchor.href.split("/").at(-1)?.split("?")[0] || anchor.textContent?.trim() || "download");
  safeSendToHost("download-context", {
    url: anchor.href,
    fileName,
    label: (anchor.textContent || "").trim(),
    courseName: deriveCourseName(),
    courseId: extractCourseId(location.href),
    title: document.title,
  });
}

function interceptDownloadClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  const anchor = target?.closest("a[href]");
  if (!anchor || !isDownloadLikeUrl(anchor.href)) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation?.();
  emitDownloadContext(event);
}

const emitAll = debounce(() => {
  try {
    readCourseContext();
    deriveTimelineItems();
  } catch (_error) {
    // Avoid breaking Moodle pages when selectors or DOM states differ.
  }
}, 250);

window.addEventListener("DOMContentLoaded", emitAll);
window.addEventListener("load", emitAll);
window.addEventListener("focus", emitAll);
window.addEventListener("click", interceptDownloadClick, true);

const observer = new MutationObserver(emitAll);
window.addEventListener("DOMContentLoaded", () => {
  if (isGenericMoodlePage(location.href, document.title)) {
    return;
  }
  if (!document.documentElement) {
    return;
  }

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
});
