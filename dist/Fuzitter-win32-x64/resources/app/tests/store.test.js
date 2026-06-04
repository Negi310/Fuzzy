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
