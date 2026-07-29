(function initTimelineMatching(root, factory) {
  const similarity = typeof module !== "undefined" && module.exports
    ? require("./similarity")
    : root.FuzitterSimilarity;
  const api = factory(similarity);
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.FuzitterTimelineMatching = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, (similarity) => {
  const { normalizeCourseName, similarityScore } = similarity;

  function extractCourseId(url) {
    try {
      return new URL(String(url || "")).searchParams.get("id") || "";
    } catch (_error) {
      return "";
    }
  }

  function extractCourseNameFromMetadata(metadataText) {
    const parts = String(metadataText || "")
      .replace(/\s+/g, " ")
      .split(/\s*[·•]\s*/)
      .map((part) => part.trim())
      .filter(Boolean);
    return parts.length > 1 ? parts.at(-1) : "";
  }

  function isAssignmentEntry(entry) {
    try {
      return /\/mod\/assign\/view\.php$/i.test(new URL(String(entry?.href || "")).pathname);
    } catch (_error) {
      return false;
    }
  }

  function isCoursePageUrl(targetUrl) {
    try {
      const parsed = new URL(String(targetUrl || ""));
      return parsed.pathname.toLowerCase().endsWith("/course/view.php")
        && Boolean(parsed.searchParams.get("id"));
    } catch (_error) {
      return false;
    }
  }

  function isCourseSectionPageUrl(targetUrl) {
    try {
      const parsed = new URL(String(targetUrl || ""));
      return parsed.pathname.toLowerCase().endsWith("/course/section.php")
        && Boolean(parsed.searchParams.get("id"));
    } catch (_error) {
      return false;
    }
  }

  function isSubmissionPageUrl(targetUrl) {
    try {
      const pathname = new URL(String(targetUrl || "")).pathname.toLowerCase();
      return /\/mod\/assign(?:\/view\.php)?\/?$/.test(pathname);
    } catch (_error) {
      return false;
    }
  }

  function mergeCourseContext(previous = {}, next = {}) {
    const pageUrl = String(next.url || previous.url || "");
    const pageKind = next.pageKind
      || (
        isSubmissionPageUrl(pageUrl)
          ? "submission"
          : (isCourseSectionPageUrl(pageUrl) ? "section" : (isCoursePageUrl(pageUrl) ? "course" : ""))
      );
    const nextCourseUrlCandidate = String(
      next.courseUrl || (pageKind === "course" ? pageUrl : "")
    );
    const nextCourseUrl = isCoursePageUrl(nextCourseUrlCandidate) ? nextCourseUrlCandidate : "";
    const previousCourseUrl = isCoursePageUrl(previous.courseUrl) ? String(previous.courseUrl) : "";
    const preservesCourseContext = pageKind === "submission" || pageKind === "section";
    const courseUrl = nextCourseUrl || (preservesCourseContext ? previousCourseUrl : "");
    const nextCourseId = nextCourseUrl
      ? String(next.courseId || extractCourseId(nextCourseUrl))
      : "";
    const courseId = nextCourseId || (
      preservesCourseContext
        ? String(previous.courseId || extractCourseId(previousCourseUrl))
        : ""
    );
    const nextCourseName = String(next.courseName || "").trim();
    const courseName = nextCourseName || (
      preservesCourseContext ? String(previous.courseName || "").trim() : ""
    );

    return { pageKind, courseName, courseId, courseUrl };
  }

  function findCourseMapping(mappings, context = {}) {
    const courseUrl = isCoursePageUrl(context.courseUrl) ? String(context.courseUrl) : "";
    const courseId = courseUrl ? String(context.courseId || extractCourseId(courseUrl)) : "";
    const courseName = normalizeCourseName(context.courseName || "");
    return (Array.isArray(mappings) ? mappings : []).find((mapping) => {
      const mappingCourseId = String(mapping.courseId || extractCourseId(mapping.courseUrl));
      return (
        (courseId && mappingCourseId === courseId)
        || (courseUrl && mapping.courseUrl === courseUrl)
        || (courseName && normalizeCourseName(mapping.courseName) === courseName)
      );
    }) || null;
  }

  function getEntryCourseName(entry) {
    return entry?.matchingCourseName || entry?.courseName || "";
  }

  function findTimelineSubmissionEntry(entries, mapping, options = {}) {
    if (!mapping) {
      return null;
    }
    const compareEntries = options.compareEntries || (() => 0);
    const visibleEntries = (Array.isArray(entries) ? entries : [])
      .filter((entry) => !options.shouldHideEntry?.(entry))
      .filter(isAssignmentEntry);
    if (!visibleEntries.length) {
      return null;
    }

    const mappingCourseId = String(mapping.courseId || extractCourseId(mapping.courseUrl));
    const idMatches = mappingCourseId
      ? visibleEntries.filter((entry) => String(entry.courseId || "") === mappingCourseId)
      : [];
    if (idMatches.length) {
      return [...idMatches].sort(compareEntries)[0] || null;
    }

    const mappingCourseName = normalizeCourseName(mapping.courseName || "");
    if (!mappingCourseName) {
      return null;
    }
    const namedEntries = visibleEntries.filter((entry) => (
      (!mappingCourseId || !entry.courseId) && normalizeCourseName(getEntryCourseName(entry))
    ));
    const exactMatches = namedEntries.filter(
      (entry) => normalizeCourseName(getEntryCourseName(entry)) === mappingCourseName
    );
    if (exactMatches.length) {
      return [...exactMatches].sort(compareEntries)[0] || null;
    }

    const entriesByCourse = new Map();
    for (const entry of namedEntries) {
      const normalizedName = normalizeCourseName(getEntryCourseName(entry));
      if (!entriesByCourse.has(normalizedName)) {
        entriesByCourse.set(normalizedName, []);
      }
      entriesByCourse.get(normalizedName).push(entry);
    }
    const rankedCourses = [...entriesByCourse.entries()]
      .map(([courseName, courseEntries]) => ({
        courseName,
        courseEntries,
        score: similarityScore(mappingCourseName, courseName),
      }))
      .sort((left, right) => right.score - left.score);
    const best = rankedCourses[0];
    const second = rankedCourses[1];
    const threshold = Number(options.similarityThreshold ?? 0.72);
    const uniquenessMargin = Number(options.uniquenessMargin ?? 0.04);
    if (!best || !second || best.score < threshold || best.score - second.score < uniquenessMargin) {
      return null;
    }
    return [...best.courseEntries].sort(compareEntries)[0] || null;
  }

  function resolveTimelineSubmissionTarget(entries, mapping, options = {}) {
    const entry = findTimelineSubmissionEntry(entries, mapping, options);
    if (!entry?.href) {
      return null;
    }
    return {
      href: entry.href,
      title: entry.title || mapping?.courseName || "",
      entry,
    };
  }

  return {
    extractCourseNameFromMetadata,
    findCourseMapping,
    findTimelineSubmissionEntry,
    isAssignmentEntry,
    isCoursePageUrl,
    isCourseSectionPageUrl,
    isSubmissionPageUrl,
    mergeCourseContext,
    resolveTimelineSubmissionTarget,
  };
});
