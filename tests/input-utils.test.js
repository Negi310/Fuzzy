const test = require("node:test");
const assert = require("node:assert/strict");

const { handleStandardCopyInput, isStandardCopyInput } = require("../src/input-utils");

test("standard copy input accepts Ctrl+C and Command+C keydown", () => {
  assert.equal(isStandardCopyInput({ type: "keyDown", key: "c", control: true }), true);
  assert.equal(isStandardCopyInput({ type: "keyDown", code: "KeyC", meta: true }), true);
});

test("standard copy input rejects modified and non-keydown inputs", () => {
  assert.equal(isStandardCopyInput({ type: "keyDown", key: "c", control: true, shift: true }), false);
  assert.equal(isStandardCopyInput({ type: "keyDown", key: "c", control: true, alt: true }), false);
  assert.equal(isStandardCopyInput({ type: "keyUp", key: "c", control: true }), false);
  assert.equal(isStandardCopyInput({ type: "keyDown", key: "x", control: true }), false);
});

test("copy handler prevents the guest key event and invokes its editing command", () => {
  let prevented = 0;
  let copied = 0;
  const handled = handleStandardCopyInput(
    { preventDefault: () => { prevented += 1; } },
    { type: "keyDown", key: "c", control: true },
    { copy: () => { copied += 1; } }
  );
  assert.equal(handled, true);
  assert.equal(prevented, 1);
  assert.equal(copied, 1);
});
