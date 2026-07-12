const test = require("node:test");
const assert = require("node:assert/strict");

const { clearSiteData, cookieDomainMatchesTarget, getSiteDataTarget } = require("../src/site-data");

test("site data target rejects unknown site keys", () => {
  assert.throws(() => getSiteDataTarget("example"), /Unknown site data target/);
});

test("Moodle target is derived only from an allowed configured host", () => {
  const target = getSiteDataTarget("moodle", {
    moodleHome: "https://moodle2026.wakayama-u.ac.jp/2026/",
  });
  assert.deepEqual(target.origins, ["https://moodle2026.wakayama-u.ac.jp"]);
  assert.equal(cookieDomainMatchesTarget(".moodle2026.wakayama-u.ac.jp", target), true);
  assert.throws(
    () => getSiteDataTarget("moodle", { moodleHome: "https://example.com/" }),
    /not allowed/
  );
});

test("Gemini and NotebookLM do not match shared Google cookies", () => {
  const gemini = getSiteDataTarget("gemini");
  const notebooklm = getSiteDataTarget("notebooklm");
  assert.equal(cookieDomainMatchesTarget(".google.com", gemini), false);
  assert.equal(cookieDomainMatchesTarget(".notebooklm.google.com", gemini), false);
  assert.equal(cookieDomainMatchesTarget(".gemini.google.com", gemini), true);
  assert.equal(cookieDomainMatchesTarget(".google.com", notebooklm), false);
  assert.equal(cookieDomainMatchesTarget(".notebooklm.google.com", notebooklm), true);
});

test("ChatGPT target does not include shared OpenAI service data", () => {
  const target = getSiteDataTarget("chatgpt");
  assert.deepEqual(target.origins, ["https://chatgpt.com"]);
  assert.equal(cookieDomainMatchesTarget(".chatgpt.com", target), true);
  assert.equal(cookieDomainMatchesTarget("auth.openai.com", target), false);
  assert.equal(cookieDomainMatchesTarget("gemini.google.com", target), false);
});

function createSessionMock({ cookies = [], removeError = null } = {}) {
  const calls = {
    clearStorageData: [],
    remove: [],
    flushStorageData: 0,
    flushStore: 0,
  };
  return {
    calls,
    session: {
      cookies: {
        get: async () => cookies,
        remove: async (url, name) => {
          calls.remove.push({ url, name });
          if (removeError) throw removeError;
        },
        flushStore: async () => { calls.flushStore += 1; },
      },
      clearStorageData: async (options) => { calls.clearStorageData.push(options); },
      flushStorageData: async () => { calls.flushStorageData += 1; },
    },
  };
}

test("clearSiteData clears only matching cookies and singular target origins", async () => {
  const target = getSiteDataTarget("gemini");
  const mock = createSessionMock({
    cookies: [
      { domain: ".gemini.google.com", name: "gemini", path: "/", secure: true },
      { domain: ".google.com", name: "shared", path: "/", secure: true },
      { domain: ".notebooklm.google.com", name: "notebook", path: "/", secure: true },
    ],
  });

  const result = await clearSiteData(mock.session, target);
  assert.deepEqual(result, { clearedCookies: 1, clearedOrigins: 1 });
  assert.deepEqual(mock.calls.remove, [{
    url: "https://gemini.google.com/",
    name: "gemini",
  }]);
  assert.equal(mock.calls.clearStorageData.length, 1);
  assert.equal(mock.calls.clearStorageData[0].origin, "https://gemini.google.com");
  assert.equal("origins" in mock.calls.clearStorageData[0], false);
  assert.equal(mock.calls.clearStorageData[0].storages.includes("cookies"), false);
  assert.equal(mock.calls.clearStorageData[0].storages.includes("cachestorage"), true);
  assert.equal(mock.calls.flushStorageData, 1);
  assert.equal(mock.calls.flushStore, 1);
});

test("clearSiteData reports cookie removal failures after flushing storage", async () => {
  const target = getSiteDataTarget("chatgpt");
  const mock = createSessionMock({
    cookies: [{ domain: ".chatgpt.com", name: "session", path: "/", secure: true }],
    removeError: new Error("locked"),
  });

  await assert.rejects(() => clearSiteData(mock.session, target), /Failed to clear 1 site cookies/);
  assert.equal(mock.calls.clearStorageData.length, 1);
  assert.equal(mock.calls.flushStore, 1);
});

test("clearSiteData propagates storage clearing failures", async () => {
  const target = getSiteDataTarget("notebooklm");
  const mock = createSessionMock();
  mock.session.clearStorageData = async () => { throw new Error("storage failure"); };
  await assert.rejects(() => clearSiteData(mock.session, target), /storage failure/);
});
