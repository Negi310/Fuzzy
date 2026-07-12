(function initUploadRouting(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.FuzitterUploadRouting = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  function getExplorerDragMode({ supportKind = "", supportKinds = [], selectedCount = 0, isDirectory = false } = {}) {
    if (isDirectory || selectedCount < 1) {
      return "none";
    }
    const visibleSupportKinds = new Set([
      supportKind,
      ...(Array.isArray(supportKinds) ? supportKinds : []),
    ].filter(Boolean));
    if (visibleSupportKinds.has("chatgpt")) {
      return "managed";
    }
    if (visibleSupportKinds.has("moodle")) {
      return selectedCount > 1 ? "managed" : "native";
    }
    if (visibleSupportKinds.has("notebooklm") && selectedCount > 1) {
      return "managed";
    }
    return selectedCount === 1 ? "native" : "none";
  }

  function hasNewAttachmentEvidence(baseline = {}, current = {}, fileNames = []) {
    if (Number(current.chipCount || 0) > Number(baseline.chipCount || 0)) {
      return true;
    }
    const normalize = (value) => String(value || "").trim().toLowerCase();
    const baselineText = normalize(baseline.composerText);
    const currentText = normalize(current.composerText);
    return fileNames.some((name) => {
      const normalizedName = normalize(name);
      return normalizedName && currentText.includes(normalizedName) && !baselineText.includes(normalizedName);
    });
  }

  function shouldActivateUploadOverlay({
    armed = false,
    supportedVisible = false,
    preferred = false,
    needsTargeting = false,
    targeted = false,
  } = {}) {
    const baseActive = armed ? supportedVisible : preferred;
    return baseActive && (!needsTargeting || targeted);
  }

  return { getExplorerDragMode, hasNewAttachmentEvidence, shouldActivateUploadOverlay };
});
