const STATIC_SITE_TARGETS = Object.freeze({
  chatgpt: Object.freeze({
    label: "ChatGPT",
    origins: Object.freeze(["https://chatgpt.com"]),
    cookieHosts: Object.freeze(["chatgpt.com"]),
  }),
  gemini: Object.freeze({
    label: "Gemini",
    origins: Object.freeze(["https://gemini.google.com"]),
    cookieHosts: Object.freeze(["gemini.google.com"]),
  }),
  notebooklm: Object.freeze({
    label: "NotebookLM",
    origins: Object.freeze(["https://notebooklm.google.com"]),
    cookieHosts: Object.freeze(["notebooklm.google.com"]),
  }),
});

function normalizeHostname(value) {
  return String(value || "").trim().replace(/^\./, "").toLowerCase();
}

function buildMoodleTarget(moodleHome) {
  const parsed = new URL(String(moodleHome || ""));
  if (!/^moodle(?:\d{4})?\.wakayama-u\.ac\.jp$/i.test(parsed.hostname)) {
    throw new Error("Configured Moodle URL is not allowed.");
  }
  return {
    key: "moodle",
    label: "Moodle",
    origins: [parsed.origin],
    cookieHosts: [parsed.hostname.toLowerCase()],
  };
}

function getSiteDataTarget(siteKey, options = {}) {
  const normalizedKey = String(siteKey || "").trim().toLowerCase();
  if (normalizedKey === "moodle") {
    return buildMoodleTarget(options.moodleHome);
  }
  const target = STATIC_SITE_TARGETS[normalizedKey];
  if (!target) {
    throw new Error("Unknown site data target.");
  }
  return {
    key: normalizedKey,
    label: target.label,
    origins: [...target.origins],
    cookieHosts: [...target.cookieHosts],
  };
}

function cookieDomainMatchesTarget(cookieDomain, target) {
  const domain = normalizeHostname(cookieDomain);
  if (!domain || !Array.isArray(target?.cookieHosts)) {
    return false;
  }
  return target.cookieHosts.some((candidate) => {
    const hostname = normalizeHostname(candidate);
    return domain === hostname || domain.endsWith(`.${hostname}`);
  });
}

const SITE_STORAGE_TYPES = Object.freeze([
  "filesystem",
  "indexdb",
  "localstorage",
  "serviceworkers",
  "cachestorage",
]);

function buildCookieRemovalUrl(cookie) {
  const domain = normalizeHostname(cookie?.domain);
  const cookiePath = String(cookie?.path || "/");
  const normalizedPath = cookiePath.startsWith("/") ? cookiePath : `/${cookiePath}`;
  return `${cookie?.secure ? "https" : "http"}://${domain}${normalizedPath}`;
}

async function clearSiteData(targetSession, target) {
  if (!targetSession?.cookies || !target) {
    throw new Error("Site data session is unavailable.");
  }
  const cookies = await targetSession.cookies.get({});
  const targetCookies = cookies.filter((cookie) => cookieDomainMatchesTarget(cookie?.domain, target));
  const cookieResults = await Promise.allSettled(targetCookies.map((cookie) =>
    targetSession.cookies.remove(buildCookieRemovalUrl(cookie), cookie.name)
  ));
  const storageResults = await Promise.allSettled(target.origins.map((origin) =>
    targetSession.clearStorageData({ origin, storages: [...SITE_STORAGE_TYPES] })
  ));
  const flushResults = await Promise.allSettled([
    targetSession.flushStorageData(),
    targetSession.cookies.flushStore(),
  ]);

  const failedCookies = cookieResults.filter((result) => result.status === "rejected").length;
  const failedOrigins = storageResults.filter((result) => result.status === "rejected").length;
  const failedFlushes = flushResults.filter((result) => result.status === "rejected").length;
  const failedOperations = failedCookies + failedOrigins + failedFlushes;
  return {
    ok: failedOperations === 0,
    clearedCookies: targetCookies.length - failedCookies,
    clearedOrigins: target.origins.length - failedOrigins,
    failedOperations,
  };
}

module.exports = {
  clearSiteData,
  cookieDomainMatchesTarget,
  getSiteDataTarget,
};
