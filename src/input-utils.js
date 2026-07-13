function isStandardCopyInput(input) {
  if (!input || input.type !== "keyDown") {
    return false;
  }
  const key = String(input.key || input.code || "").toLowerCase();
  const isCopyKey = key === "c" || key === "keyc";
  return isCopyKey && Boolean(input.control || input.meta) && !input.alt && !input.shift;
}

function handleStandardCopyInput(event, input, targetContents) {
  if (!isStandardCopyInput(input) || !targetContents?.copy) {
    return false;
  }
  event?.preventDefault?.();
  targetContents.copy();
  return true;
}

module.exports = { handleStandardCopyInput, isStandardCopyInput };
