function levenshtein(a, b) {
  const left = a.toLowerCase();
  const right = b.toLowerCase();

  if (left === right) {
    return 0;
  }

  if (!left.length) {
    return right.length;
  }

  if (!right.length) {
    return left.length;
  }

  const matrix = Array.from({ length: left.length + 1 }, () => new Array(right.length + 1).fill(0));

  for (let i = 0; i <= left.length; i += 1) {
    matrix[i][0] = i;
  }

  for (let j = 0; j <= right.length; j += 1) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }

  return matrix[left.length][right.length];
}

function ngrams(text, size = 2) {
  const normalized = text.toLowerCase().replace(/\s+/g, "");
  if (normalized.length <= size) {
    return [normalized];
  }

  const grams = [];
  for (let i = 0; i <= normalized.length - size; i += 1) {
    grams.push(normalized.slice(i, i + size));
  }
  return grams;
}

function diceCoefficient(a, b) {
  const left = ngrams(a);
  const right = ngrams(b);
  const counts = new Map();

  for (const gram of left) {
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }

  let overlap = 0;
  for (const gram of right) {
    const count = counts.get(gram) ?? 0;
    if (count > 0) {
      overlap += 1;
      counts.set(gram, count - 1);
    }
  }

  return (2 * overlap) / (left.length + right.length || 1);
}

function normalizeCourseName(name) {
  return name
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/\([^)]+\)/g, " ")
    .replace(/[【】]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function similarityScore(a, b) {
  const left = normalizeCourseName(a);
  const right = normalizeCourseName(b);
  if (!left || !right) {
    return 0;
  }

  const maxLen = Math.max(left.length, right.length);
  const normalizedLevenshtein = 1 - (levenshtein(left, right) / Math.max(maxLen, 1));
  const dice = diceCoefficient(left, right);
  return Number(((normalizedLevenshtein * 0.55) + (dice * 0.45)).toFixed(4));
}

function rankCandidates(courseName, folderNames) {
  return folderNames
    .map((folderName) => ({
      folderName,
      score: similarityScore(courseName, folderName),
    }))
    .sort((a, b) => b.score - a.score);
}

module.exports = {
  levenshtein,
  normalizeCourseName,
  rankCandidates,
  similarityScore,
};
