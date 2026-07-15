const { ipcRenderer } = require("electron");
const selectors = require("./course-selectors.json");
const { isSubmissionPageUrl } = require("./timeline-matching");

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

function findCourseAnchor() {
  const selectors = [
    ".breadcrumb a[href*='/course/view.php?id=']",
    ".page-context-header a[href*='/course/view.php?id=']",
    "header a[href*='/course/view.php?id=']",
    "a[href*='/course/view.php?id=']",
  ];
  const anchors = selectors.flatMap((selector) => [...document.querySelectorAll(selector)]);
  return anchors.find((anchor) => {
    try {
      const parsed = new URL(anchor.href, location.href);
      return isWakayamaMoodlePage(parsed.toString()) && Boolean(parsed.searchParams.get("id"));
    } catch (_error) {
      return false;
    }
  }) || null;
}

function readCourseIdFromDom() {
  const roots = [document.body, document.documentElement].filter(Boolean);
  for (const root of roots) {
    const value = String(
      root.dataset?.courseId
      || root.dataset?.courseid
      || root.getAttribute?.("data-course-id")
      || root.getAttribute?.("data-courseid")
      || ""
    );
    if (/^\d+$/.test(value)) {
      return value;
    }
  }

  const bodyClass = String(document.body?.className || "");
  const classMatch = bodyClass.match(/(?:^|\s)course-(\d+)(?:\s|$)/i);
  if (classMatch) {
    return classMatch[1];
  }

  const courseElement = document.querySelector("[data-courseid], [data-course-id]");
  const elementValue = String(
    courseElement?.dataset?.courseId
    || courseElement?.dataset?.courseid
    || courseElement?.getAttribute?.("data-course-id")
    || courseElement?.getAttribute?.("data-courseid")
    || ""
  );
  return /^\d+$/.test(elementValue) ? elementValue : "";
}

function buildCourseUrl(courseId) {
  if (!/^\d+$/.test(String(courseId || ""))) {
    return "";
  }
  try {
    const parsed = new URL(location.href);
    const markerIndex = parsed.pathname.toLowerCase().lastIndexOf("/mod/");
    if (markerIndex < 0) {
      return "";
    }
    parsed.pathname = `${parsed.pathname.slice(0, markerIndex)}/course/view.php`;
    parsed.search = `?id=${encodeURIComponent(courseId)}`;
    parsed.hash = "";
    return parsed.toString();
  } catch (_error) {
    return "";
  }
}

function readCourseAnchorContext() {
  const courseAnchor = findCourseAnchor();
  const anchorCourseUrl = courseAnchor?.href || "";
  const courseId = extractCourseId(anchorCourseUrl) || readCourseIdFromDom();
  const courseUrl = anchorCourseUrl || buildCourseUrl(courseId);
  if (!courseId || !courseUrl) {
    return {
      courseName: "",
      courseId: "",
      courseUrl: "",
    };
  }

  return {
    courseName: normalizeTitle(courseAnchor?.textContent || ""),
    courseId,
    courseUrl,
  };
}

function getMoodlePageKind(targetUrl) {
  if (!isWakayamaMoodlePage(targetUrl)) {
    return "outside";
  }

  try {
    const parsed = new URL(targetUrl);
    const pathname = parsed.pathname.toLowerCase();
    if (pathname.endsWith("/course/view.php") && parsed.searchParams.get("id")) {
      return "course";
    }
    if (isSubmissionPageUrl(targetUrl)) {
      return "submission";
    }
    return "other";
  } catch (_error) {
    return "outside";
  }
}

function readCourseContext() {
  const pageKind = getMoodlePageKind(location.href);
  const pageCourseName = deriveCourseName();
  const fallbackContext = readCourseAnchorContext();
  const courseContext = pageKind === "course"
    ? {
      courseName: pageCourseName,
      courseId: extractCourseId(location.href),
      courseUrl: location.href,
    }
    : fallbackContext;

  safeSendToHost("page-context", {
    url: location.href,
    title: document.title,
    pageKind,
    courseName: courseContext.courseName,
    courseId: courseContext.courseId,
    courseUrl: courseContext.courseUrl,
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

function isEditableElement(target) {
  return target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target?.isContentEditable;
}

function handleShortcutKeydown(event) {
  safeSendToHost("shortcut-input", {
    kind: "keyboard",
    key: event.key,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    metaKey: event.metaKey,
    repeat: event.repeat,
    editable: isEditableElement(event.target),
  });
}

function handleShortcutMouse(event) {
  if (![1, 2, 3, 4].includes(event.button)) {
    return;
  }
  safeSendToHost("shortcut-input", {
    kind: "mouse",
    button: event.button,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    metaKey: event.metaKey,
    editable: isEditableElement(event.target),
  });
}

function reportShortcutFocus(target) {
  safeSendToHost("shortcut-focus", {
    editable: isEditableElement(target),
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
  document.addEventListener("focusin", (event) => {
    reportShortcutFocus(event.target);
  }, true);
  document.addEventListener("focusout", () => {
    setTimeout(() => reportShortcutFocus(document.activeElement), 0);
  }, true);
  document.addEventListener("keydown", handleShortcutKeydown, true);
  document.addEventListener("mousedown", handleShortcutMouse, true);
  document.addEventListener("contextmenu", handleLinkContextMenu, true);
  document.addEventListener("auxclick", handleLinkAuxClick, true);
});

window.addEventListener("load", readCourseContext);
window.addEventListener("hashchange", readCourseContext);
window.addEventListener("popstate", readCourseContext);
