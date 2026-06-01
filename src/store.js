const fs = require("node:fs");
const path = require("node:path");

function normalizeCourseName(name) {
  return String(name || "")
    .replace(/\s+/g, " ")
    .replace(/\s*[|:-]\s*Wakayama.*Moodle.*$/i, "")
    .replace(/\s*[|:-]\s*和歌山大学.*Moodle.*$/i, "")
    .replace(/\s*Moodle\d*\s*$/i, "")
    .trim();
}

function extractCourseIdFromUrl(targetUrl) {
  try {
    const parsed = new URL(targetUrl || "");
    return parsed.searchParams.get("id") || "";
  } catch (_error) {
    return "";
  }
}

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
    this.state.mappings = this.state.mappings.map((entry) => ({
      ...entry,
      courseId: entry.courseId || extractCourseIdFromUrl(entry.courseUrl),
    }));
    return structuredClone(this.state);
  }

  setRootDir(rootDir) {
    this.state.rootDir = rootDir;
    this.save();
  }

  upsertMapping(mapping) {
    const courseId = mapping.courseId || extractCourseIdFromUrl(mapping.courseUrl);
    const normalizedName = normalizeCourseName(mapping.courseName);
    const index = this.state.mappings.findIndex((entry) => (
      (courseId && (entry.courseId || extractCourseIdFromUrl(entry.courseUrl)) === courseId) ||
      (mapping.courseUrl && entry.courseUrl === mapping.courseUrl) ||
      normalizeCourseName(entry.courseName) === normalizedName
    ));
    const next = {
      courseName: mapping.courseName,
      courseId,
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
    const normalizedName = normalizeCourseName(courseName);
    return this.state.mappings.find((entry) => normalizeCourseName(entry.courseName) === normalizedName) ?? null;
  }

  findMapping(criteria = {}) {
    const courseId = criteria.courseId || extractCourseIdFromUrl(criteria.courseUrl);
    const normalizedName = normalizeCourseName(criteria.courseName);
    return this.state.mappings.find((entry) => (
      (courseId && (entry.courseId || extractCourseIdFromUrl(entry.courseUrl)) === courseId) ||
      (criteria.courseUrl && entry.courseUrl === criteria.courseUrl) ||
      (normalizedName && normalizeCourseName(entry.courseName) === normalizedName)
    )) ?? null;
  }

  findMappingByFolder(folderPath) {
    return this.state.mappings.find((entry) => entry.folderPath === folderPath) ?? null;
  }

  findMappingByPath(targetPath) {
    const normalizedTargetPath = String(targetPath || "").toLowerCase();
    const matches = this.state.mappings.filter((entry) => {
      const mappingPath = String(entry.folderPath || "").toLowerCase();
      return normalizedTargetPath === mappingPath || normalizedTargetPath.startsWith(`${mappingPath}\\`);
    });

    if (!matches.length) {
      return null;
    }

    return matches.sort((left, right) => right.folderPath.length - left.folderPath.length)[0];
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
