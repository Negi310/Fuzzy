const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const timelineMatching = require("../src/timeline-matching");

function loadBrowserPreload({ url, bodyClass = "", courseAnchors = [] }) {
  const sentMessages = [];
  const document = {
    title: "Assignment submission",
    body: {
      className: bodyClass,
      dataset: {},
      getAttribute: () => null,
    },
    documentElement: {
      dataset: {},
      getAttribute: () => null,
    },
    addEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: (selector) => (
      selector.includes("/course/view.php?id=") ? courseAnchors : []
    ),
  };
  const context = vm.createContext({
    URL,
    clearTimeout,
    console,
    document,
    location: { href: url },
    setTimeout,
    window: { addEventListener: () => {} },
    require: (request) => {
      if (request === "electron") {
        return {
          ipcRenderer: {
            sendToHost: (channel, payload) => sentMessages.push({ channel, payload }),
          },
        };
      }
      if (request === "./course-selectors.json") {
        return [".page-header-headings h1"];
      }
      if (request === "./timeline-matching") {
        return timelineMatching;
      }
      throw new Error(`Unexpected require: ${request}`);
    },
  });

  const source = fs.readFileSync(path.join(__dirname, "..", "src", "browser-preload.js"), "utf8");
  vm.runInContext(source, context);
  return { context, sentMessages };
}

test("assignment page derives its course id from Moodle body metadata", () => {
  const { context, sentMessages } = loadBrowserPreload({
    url: "https://moodle2026.wakayama-u.ac.jp/2026/mod/assign/view.php?id=999",
    bodyClass: "path-mod-assign course-404 cmid-999",
  });

  context.readCourseContext();

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].channel, "page-context");
  assert.equal(sentMessages[0].payload.pageKind, "submission");
  assert.equal(sentMessages[0].payload.courseId, "404");
  assert.equal(
    sentMessages[0].payload.courseUrl,
    "https://moodle2026.wakayama-u.ac.jp/2026/course/view.php?id=404"
  );
});

test("assignment page prefers the breadcrumb course context", () => {
  const courseAnchor = {
    href: "https://moodle2026.wakayama-u.ac.jp/2026/course/view.php?id=404",
    textContent: "Artificial Intelligence",
  };
  const { context, sentMessages } = loadBrowserPreload({
    url: "https://moodle2026.wakayama-u.ac.jp/2026/mod/assign",
    courseAnchors: [courseAnchor],
  });

  context.readCourseContext();

  assert.equal(sentMessages[0].payload.pageKind, "submission");
  assert.equal(sentMessages[0].payload.courseName, "Artificial Intelligence");
  assert.equal(sentMessages[0].payload.courseId, "404");
});

test("course section page derives its course context and is not treated as a submission", () => {
  const { context, sentMessages } = loadBrowserPreload({
    url: "https://moodle2026.wakayama-u.ac.jp/2026/course/section.php?id=88",
    bodyClass: "path-course-view course-404",
  });

  context.readCourseContext();

  assert.equal(sentMessages[0].payload.pageKind, "section");
  assert.equal(sentMessages[0].payload.courseId, "404");
  assert.equal(
    sentMessages[0].payload.courseUrl,
    "https://moodle2026.wakayama-u.ac.jp/2026/course/view.php?id=404"
  );
});
