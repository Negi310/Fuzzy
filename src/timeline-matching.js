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
      (!mappingCourseId || !entry.courseId) && normalizeCourseName(entry.courseName || "")
    ));
    const exactMatches = namedEntries.filter(
      (entry) => normalizeCourseName(entry.courseName) === mappingCourseName
    );
    if (exactMatches.length) {
      return [...exactMatches].sort(compareEntries)[0] || null;
    }

    const entriesByCourse = new Map();
    for (const entry of namedEntries) {
      const normalizedName = normalizeCourseName(entry.courseName);
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

  return {
    extractCourseNameFromMetadata,
    findTimelineSubmissionEntry,
    isAssignmentEntry,
  };
});
