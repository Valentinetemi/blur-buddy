import test from "node:test";
import assert from "node:assert/strict";
import {
  boxesOverlap,
  clampBox,
  describeStrength,
  isSensitiveText,
  mergeBoxes,
  normalizeTerms,
} from "../security.js";

test("detects common private values", () => {
  assert.equal(isSensitiveText("friend@example.com"), true);
  assert.equal(isSensitiveText("Call +234 801 234 5678"), true);
  assert.equal(isSensitiveText("Source IP 192.168.1.44"), true);
  assert.equal(isSensitiveText("API key: sk-demo-secret-value"), true);
  assert.equal(isSensitiveText("This paragraph is safe to share"), false);
});

test("supports comma-separated custom terms", () => {
  const terms = normalizeTerms("Temiloluwa, Project Moon,  ");
  assert.deepEqual(terms, ["temiloluwa", "project moon"]);
  assert.equal(isSensitiveText("Owner: Temiloluwa", terms), true);
});

test("describes pixelation strength in friendly terms", () => {
  assert.equal(describeStrength(6), "6 · soft");
  assert.equal(describeStrength("16"), "16 · balanced");
  assert.equal(describeStrength(28), "28 · chunky");
});

test("clamps OCR boxes to the image", () => {
  assert.deepEqual(clampBox({ x0: 2, y0: 4, x1: 110, y1: 80 }, 100, 70), {
    x0: 0,
    y0: 0,
    x1: 100,
    y1: 70,
    source: "auto",
  });
});

test("merges overlapping redaction boxes", () => {
  const first = { x0: 0, y0: 0, x1: 20, y1: 20 };
  const second = { x0: 18, y0: 10, x1: 35, y1: 30 };
  assert.equal(boxesOverlap(first, second), true);
  assert.deepEqual(mergeBoxes([first, second]), [{ x0: 0, y0: 0, x1: 35, y1: 30 }]);
});
