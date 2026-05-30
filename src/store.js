const fs = require("node:fs");
const path = require("node:path");

class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      return JSON.parse(raw);
    } catch (_error) {
      return {
        rootDir: "",
        mappings: [],
        downloadHistory: [],
        preferences: {
          dashboardAutoload: false,
        },
      };
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), "utf8");
  }

  getState() {
    this.state.preferences ??= {
      dashboardAutoload: false,
    };
    return structuredClone(this.state);
  }

  setRootDir(rootDir) {
    this.state.rootDir = rootDir;
    this.save();
  }

  upsertMapping(mapping) {
    const index = this.state.mappings.findIndex((entry) => entry.courseName === mapping.courseName);
    const next = {
      courseName: mapping.courseName,
      folderPath: mapping.folderPath,
      courseUrl: mapping.courseUrl ?? "",
      matchType: mapping.matchType ?? "manual",
      updatedAt: new Date().toISOString(),
    };

    if (index >= 0) {
      this.state.mappings[index] = next;
    } else {
      this.state.mappings.push(next);
    }

    this.save();
    return next;
  }

  findMappingByCourse(courseName) {
    return this.state.mappings.find((entry) => entry.courseName === courseName) ?? null;
  }

  findMappingByFolder(folderPath) {
    return this.state.mappings.find((entry) => entry.folderPath === folderPath) ?? null;
  }

  addDownloadHistory(entry) {
    this.state.downloadHistory.unshift({
      ...entry,
      timestamp: new Date().toISOString(),
    });
    this.state.downloadHistory = this.state.downloadHistory.slice(0, 100);
    this.save();
  }

  setPreference(key, value) {
    this.state.preferences ??= {};
    this.state.preferences[key] = value;
    this.save();
  }
}

module.exports = {
  Store,
};
