const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const {
  extractCourseNameFromMetadata,
  findTimelineSubmissionEntry,
} = require("../src/timeline-matching");

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
  assert.equal(typeof context.FuzitterTimelineMatching.findTimelineSubmissionEntry, "function");
});
