const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { Store } = require("../src/store");

function createTempStore(initialState) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fuzzy-store-test-"));
  const filePath = path.join(tempDir, "store.json");
  fs.writeFileSync(filePath, JSON.stringify(initialState, null, 2), "utf8");
  return {
    store: new Store(filePath),
    cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }),
  };
}

test("findMappingByPath returns the deepest matching mapped folder", () => {
  const { store, cleanup } = createTempStore({
    rootDir: "C:\\Downloads\\Fuzzy",
    mappings: [
      {
        courseName: "Parent Course",
        folderPath: "C:\\Downloads\\Fuzzy\\Parent Course",
        courseUrl: "https://example.com/course/view.php?id=100",
      },
      {
        courseName: "Nested Course",
        folderPath: "C:\\Downloads\\Fuzzy\\Parent Course\\Week 1",
        courseUrl: "https://example.com/course/view.php?id=200",
      },
    ],
    downloadHistory: [],
    preferences: {
      dashboardAutoload: false,
    },
  });

  try {
    const mapping = store.findMappingByPath("C:\\Downloads\\Fuzzy\\Parent Course\\Week 1\\Slides");
    assert.equal(mapping?.courseName, "Nested Course");
  } finally {
    cleanup();
  }
});

test("findMappingByPath returns null when no mapped folder matches", () => {
  const { store, cleanup } = createTempStore({
    rootDir: "C:\\Downloads\\Fuzzy",
    mappings: [
      {
        courseName: "Mapped Course",
        folderPath: "C:\\Downloads\\Fuzzy\\Mapped Course",
        courseUrl: "https://example.com/course/view.php?id=300",
      },
    ],
    downloadHistory: [],
    preferences: {
      dashboardAutoload: false,
    },
  });

  try {
    assert.equal(store.findMappingByPath("C:\\Downloads\\Fuzzy\\Other Course"), null);
  } finally {
    cleanup();
  }
});

test("findMappingByPath ranks a matching submission folder by its actual path", () => {
  const { store, cleanup } = createTempStore({
    rootDir: "C:\\Downloads\\Fuzzy",
    mappings: [
      {
        courseName: "Long course folder",
        folderPath: "C:\\Downloads\\Fuzzy\\A-very-long-course-folder-name",
        submissionFolderPath: "C:\\Downloads\\Fuzzy\\Shared",
      },
      {
        courseName: "Specific submission folder",
        folderPath: "C:\\Downloads\\Fuzzy\\B",
        submissionFolderPath: "C:\\Downloads\\Fuzzy\\Shared\\Assignments",
      },
    ],
    downloadHistory: [],
    preferences: {},
  });

  try {
    const mapping = store.findMappingByPath("C:\\Downloads\\Fuzzy\\Shared\\Assignments\\Week 1");
    assert.equal(mapping?.courseName, "Specific submission folder");
  } finally {
    cleanup();
  }
});

test("store initializes startup auto launch preference when missing", () => {
  const { store, cleanup } = createTempStore({
    rootDir: "C:\\Downloads\\Fuzzy",
    mappings: [],
    downloadHistory: [],
    preferences: {
      dashboardAutoload: false,
      onboardingCompleted: true,
    },
  });

  try {
    const state = store.getState();
    assert.equal(state.preferences.startupAutoLaunchRegistered, false);
  } finally {
    cleanup();
  }
});

test("resetSettings restores configurable settings and requires onboarding again", () => {
  const { store, cleanup } = createTempStore({
    rootDir: "D:\\Custom\\Fuzitter",
    mappings: [
      {
        courseName: "Course",
        folderPath: "D:\\Custom\\Fuzitter\\Course",
      },
    ],
    downloadHistory: [{ fileName: "notes.pdf" }],
    preferences: {
      dashboardAutoload: true,
      onboardingCompleted: true,
      startupAutoLaunchRegistered: true,
      moodleHome: "https://example.com/moodle/",
      keyBindings: { reload: "Ctrl+R" },
    },
  });

  try {
    const state = store.resetSettings({ rootDir: "C:\\Downloads\\Fuzitter" });
    assert.equal(state.rootDir, "C:\\Downloads\\Fuzitter");
    assert.deepEqual(state.mappings, []);
    assert.deepEqual(state.downloadHistory, [{ fileName: "notes.pdf" }]);
    assert.equal(state.preferences.dashboardAutoload, false);
    assert.deepEqual(state.preferences.keyBindings, {});
    assert.equal(state.preferences.moodleHome, undefined);
    assert.equal(state.preferences.onboardingCompleted, false);
    assert.equal(state.preferences.startupAutoLaunchRegistered, true);
  } finally {
    cleanup();
  }
});
