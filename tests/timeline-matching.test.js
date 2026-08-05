const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const {
  extractCourseNameFromMetadata,
  findCourseMapping,
  findTimelineSubmissionEntry,
  isCoursePageUrl,
  isCourseSectionPageUrl,
  isSubmissionPageUrl,
  mergeCourseContext,
  resolveTimelineSubmissionTarget,
} = require("../src/timeline-matching");

test("recognizes Moodle assignment pages without treating other module pages as submissions", () => {
  assert.equal(isSubmissionPageUrl("https://moodle.example/2026/mod/assign"), true);
  assert.equal(isSubmissionPageUrl("https://moodle.example/2026/mod/assign/"), true);
  assert.equal(isSubmissionPageUrl("https://moodle.example/2026/mod/assign/view.php?id=999"), true);
  assert.equal(isSubmissionPageUrl("https://moodle.example/2026/mod/assign/index.php"), false);
  assert.equal(isSubmissionPageUrl("https://moodle.example/2026/mod/quiz/view.php?id=999"), false);
});

test("recognizes only course URLs with a course id", () => {
  assert.equal(isCoursePageUrl("https://moodle.example/2026/course/view.php?id=404"), true);
  assert.equal(isCoursePageUrl("https://moodle.example/2026/course/view.php"), false);
  assert.equal(isCoursePageUrl("https://moodle.example/2026/mod/assign/view.php?id=404"), false);
});

test("recognizes Moodle course section pages separately from course and submission pages", () => {
  assert.equal(isCourseSectionPageUrl("https://moodle.example/2026/course/section.php?id=88"), true);
  assert.equal(isCourseSectionPageUrl("https://moodle.example/2026/course/section.php"), false);
  assert.equal(isCourseSectionPageUrl("https://moodle.example/2026/course/view.php?id=404"), false);
  assert.equal(isSubmissionPageUrl("https://moodle.example/2026/course/section.php?id=88"), false);
});

test("section navigation preserves the mapped course context", () => {
  const previous = {
    courseName: "人工知能",
    courseId: "404",
    courseUrl: "https://moodle.example/2026/course/view.php?id=404",
  };
  const merged = mergeCourseContext(previous, {
    url: "https://moodle.example/2026/course/section.php?id=88",
    pageKind: "section",
  });

  assert.equal(merged.pageKind, "section");
  assert.equal(merged.courseId, "404");
  assert.equal(merged.courseName, "人工知能");
  assert.equal(merged.courseUrl, "https://moodle.example/2026/course/view.php?id=404");
});

test("submission navigation preserves course context and ignores the assignment id", () => {
  const previous = {
    courseName: "人工知能",
    courseId: "404",
    courseUrl: "https://moodle.example/2026/course/view.php?id=404",
  };
  const merged = mergeCourseContext(previous, {
    url: "https://moodle.example/2026/mod/assign/view.php?id=999",
    pageKind: "submission",
    courseId: "999",
    courseUrl: "https://moodle.example/2026/mod/assign/view.php?id=999",
  });

  assert.equal(merged.courseId, "404");
  assert.equal(merged.courseName, "人工知能");
  assert.equal(merged.courseUrl, "https://moodle.example/2026/course/view.php?id=404");
});

test("valid course context from an assignment page replaces stale course context", () => {
  const merged = mergeCourseContext({
    courseName: "別のコース",
    courseId: "100",
    courseUrl: "https://moodle.example/2026/course/view.php?id=100",
  }, {
    url: "https://moodle.example/2026/mod/assign/view.php?id=999",
    pageKind: "submission",
    courseName: "人工知能",
    courseId: "404",
    courseUrl: "https://moodle.example/2026/course/view.php?id=404",
  });

  assert.equal(merged.courseId, "404");
  assert.equal(merged.courseName, "人工知能");
});

test("course mapping never uses an assignment activity id as a course id", () => {
  const mappings = [{
    courseName: "人工知能",
    courseId: "404",
    courseUrl: "https://moodle.example/2026/course/view.php?id=404",
  }];
  assert.equal(findCourseMapping(mappings, {
    url: "https://moodle.example/2026/mod/assign/view.php?id=404",
  }), null);
  assert.equal(findCourseMapping(mappings, {
    courseId: "404",
    courseUrl: "https://moodle.example/2026/course/view.php?id=404",
  })?.courseName, "人工知能");
});

test("extracts a Moodle course name from standard timeline metadata", () => {
  assert.equal(
    extractCourseNameFromMetadata("課題の提出期限です · 情報科学概論"),
    "情報科学概論"
  );
  assert.equal(extractCourseNameFromMetadata("提出期限"), "");
});

test("timeline submission matching prioritizes course id", () => {
  const entries = [
    { href: "https://moodle.example/mod/assign/view.php?id=1", courseId: "20", title: "B" },
    { href: "https://moodle.example/mod/assign/view.php?id=2", courseId: "10", title: "A" },
  ];
  assert.equal(
    findTimelineSubmissionEntry(entries, { courseId: "10", courseName: "別名" })?.title,
    "A"
  );
});

test("timeline submission matching ignores non-assignment events", () => {
  const entries = [
    { href: "https://moodle.example/mod/quiz/view.php?id=1", courseName: "情報科学概論" },
  ];
  assert.equal(findTimelineSubmissionEntry(entries, { courseName: "情報科学概論" }), null);
});

test("timeline submission matching never name-matches an explicit different course id", () => {
  const entries = [
    {
      href: "https://moodle.example/mod/assign/view.php?id=1",
      courseId: "20",
      courseName: "情報科学概論",
    },
  ];
  assert.equal(findTimelineSubmissionEntry(entries, {
    courseId: "10",
    courseName: "情報科学概論",
  }), null);
});

test("timeline submission matching accepts a unique high-confidence course name", () => {
  const entries = [
    { href: "https://moodle.example/mod/assign/view.php?id=1", courseName: "情報科字概論" },
    { href: "https://moodle.example/mod/assign/view.php?id=2", courseName: "統計学" },
  ];
  const match = findTimelineSubmissionEntry(entries, { courseName: "情報科学概論" });
  assert.equal(match?.courseName, "情報科字概論");
});

test("timeline submission matching keeps display and matching course names separate", () => {
  const entries = [
    {
      href: "https://moodle.example/mod/assign/view.php?id=1",
      courseName: "課題の提出期限です",
      matchingCourseName: "情報科学概論",
      title: "レポート課題",
    },
  ];
  const match = findTimelineSubmissionEntry(entries, { courseName: "情報科学概論" });
  assert.equal(match?.title, "レポート課題");
  assert.equal(match?.courseName, "課題の提出期限です");
});

test("timeline navigation has no course-page fallback when no submission exists", () => {
  const mapping = {
    courseName: "人工知能",
    courseId: "404",
    courseUrl: "https://moodle.example/2026/course/view.php?id=404",
  };
  assert.equal(resolveTimelineSubmissionTarget([], mapping), null);
  assert.equal(resolveTimelineSubmissionTarget([
    {
      href: "https://moodle.example/2026/mod/quiz/view.php?id=1",
      courseId: "404",
      courseName: "人工知能",
    },
  ], mapping), null);
});

test("timeline submission matching rejects ambiguous similar courses", () => {
  const entries = [
    { href: "https://moodle.example/mod/assign/view.php?id=1", courseName: "情報科学概論A" },
    { href: "https://moodle.example/mod/assign/view.php?id=2", courseName: "情報科学概論B" },
  ];
  assert.equal(findTimelineSubmissionEntry(entries, { courseName: "情報科学概論" }, {
    similarityThreshold: 0.7,
  }), null);
});

test("timeline submission matching does not infer similarity from one course candidate", () => {
  const entries = [
    { href: "https://moodle.example/mod/assign/view.php?id=1", courseName: "プログラミング演習" },
  ];
  assert.equal(findTimelineSubmissionEntry(entries, { courseName: "プログラミング" }), null);
});

test("timeline helpers load in the renderer without CommonJS globals", () => {
  const context = vm.createContext({ URL });
  context.window = context;
  context.globalThis = context;
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "similarity.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "timeline-matching.js"), "utf8"), context);
  assert.equal(typeof context.FuzitterSimilarity.similarityScore, "function");
  assert.equal(typeof context.FuzitterTimelineMatching.isSubmissionPageUrl, "function");
  assert.equal(typeof context.FuzitterTimelineMatching.mergeCourseContext, "function");
  assert.equal(typeof context.FuzitterTimelineMatching.findTimelineSubmissionEntry, "function");
});

test("dashboard timeline scraper remains valid after template interpolation", () => {
  const rendererSource = fs.readFileSync(path.join(__dirname, "..", "src", "renderer.js"), "utf8");
  const marker = "const result = await dashboardWebview.executeJavaScript(`";
  const scriptStart = rendererSource.indexOf(marker);
  assert.notEqual(scriptStart, -1);

  const templateStart = scriptStart + marker.length;
  const templateEnd = rendererSource.indexOf("`, true);", templateStart);
  assert.notEqual(templateEnd, -1);

  const templateBody = rendererSource.slice(templateStart, templateEnd);
  const guestScript = vm.runInNewContext("`" + templateBody + "`");
  assert.doesNotThrow(() => new vm.Script(guestScript));
});
