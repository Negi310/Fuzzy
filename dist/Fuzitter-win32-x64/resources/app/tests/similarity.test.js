const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeCourseName, rankCandidates, similarityScore } = require("../src/similarity");

test("normalizeCourseName removes bracket decorations", () => {
  assert.equal(normalizeCourseName("[2026] 情報科学概論 (Aクラス)"), "情報科学概論");
});

test("normalizeCourseName removes course prefix and university suffix", () => {
  assert.equal(normalizeCourseName("コース: 情報科学概論 ｜【和歌山大学】"), "情報科学概論");
});

test("similarityScore prefers close folder names", () => {
  const high = similarityScore("情報科学概論", "情報科学概論_講義資料");
  const low = similarityScore("情報科学概論", "統計学");
  assert.ok(high > low);
});

test("rankCandidates sorts best match first", () => {
  const ranked = rankCandidates("アルゴリズム", ["統計学", "アルゴリズム演習", "英語"]);
  assert.equal(ranked[0].folderName, "アルゴリズム演習");
});
