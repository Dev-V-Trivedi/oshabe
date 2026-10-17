import assert from "node:assert/strict";
import { poseForStep } from "./wizardPose";

const base = {
  practiceHasText: false,
  isDownloading: false,
  justFinished: false,
};

assert.equal(poseForStep("purpose", base), "presenting");
assert.equal(poseForStep("languages", base), "idle");
assert.equal(poseForStep("quality", base), "presenting");
assert.equal(poseForStep("quality", { ...base, isDownloading: true }), "busy");
assert.equal(poseForStep("practice", base), "listening");
assert.equal(
  poseForStep("practice", { ...base, practiceHasText: true }),
  "listening",
);
assert.equal(poseForStep("cleanup", base), "idle");
assert.equal(poseForStep("cleanup", { ...base, justFinished: true }), "happy");
assert.equal(poseForStep("advanced", base), "idle");

// Review Focus: isDownloading must not leak into other steps.
assert.equal(
  poseForStep("practice", { ...base, isDownloading: true }),
  "listening",
);
assert.equal(
  poseForStep("languages", { ...base, isDownloading: true }),
  "idle",
);

// Review Focus: justFinished must not leak into other steps.
assert.equal(
  poseForStep("purpose", { ...base, justFinished: true }),
  "presenting",
);
assert.equal(
  poseForStep("practice", { ...base, justFinished: true }),
  "listening",
);
