import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateDetections,
  boxesOverlap,
  buildDetections,
  canvasBoxToCss,
  clampBox,
  createManualRedaction,
  createTourStops,
  detectSensitiveCategories,
  describeStrength,
  isSensitiveText,
  mergeBoxes,
  normalizeTerms,
  pixelSampleDimensions,
} from "../security.js";
import { TourSession } from "../tour.js";

test("detects common private values", () => {
  assert.equal(isSensitiveText("friend@example.com"), true);
  assert.equal(isSensitiveText("Call +234 801 234 5678"), true);
  assert.equal(isSensitiveText("Source IP 192.168.1.44"), true);
  assert.equal(isSensitiveText("API key: sk-demo-secret-value"), true);
  assert.equal(isSensitiveText("This paragraph is safe to share"), false);
});

test("classifies existing sensitive-information patterns", () => {
  assert.deepEqual(detectSensitiveCategories("friend@example.com"), ["email"]);
  assert.deepEqual(detectSensitiveCategories("Call +234 801 234 5678"), ["phone"]);
  assert.deepEqual(detectSensitiveCategories("Source IP 192.168.1.44"), ["private-ip"]);
  assert.deepEqual(detectSensitiveCategories("API key: sk-demo-secret-value"), [
    "possible-credential",
  ]);
  assert.deepEqual(detectSensitiveCategories("https://example.com/reset"), ["web-address"]);
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

test("aggregates safe category counts without retaining detected values", () => {
  const receipt = aggregateDetections(
    [
      { category: "email", text: "first@example.com" },
      { category: "email", text: "second@example.com" },
      { category: "private-ip", text: "192.168.0.5" },
    ],
    1,
  );
  assert.deepEqual(receipt, {
    total: 4,
    categories: { email: 2, "private-ip": 1 },
    manualCount: 1,
  });
  assert.equal(JSON.stringify(receipt).includes("example.com"), false);
  assert.equal(JSON.stringify(receipt).includes("192.168"), false);
});

test("converts internal canvas boxes with independent display scale factors", () => {
  const converted = canvasBoxToCss(
    { x0: 100, y0: 50, x1: 300, y1: 150 },
    { left: 20, top: 40, width: 500, height: 400 },
    1000,
    500,
  );
  assert.deepEqual(converted, {
    left: 70,
    top: 80,
    width: 100,
    height: 80,
    scaleX: 0.5,
    scaleY: 0.8,
  });
});

test("uses actual OCR bounding boxes as privacy-tour stops", () => {
  const ocrBox = { x0: 34, y0: 51, x1: 244, y1: 83 };
  const data = {
    blocks: [
      {
        paragraphs: [
          {
            lines: [
              {
                text: "Reporter: friend@example.com",
                confidence: 91.5,
                bbox: ocrBox,
                words: [],
              },
            ],
          },
        ],
      },
    ],
  };
  const detections = buildDetections(data, [], 800, 500);
  assert.equal(detections[0].category, "email");
  assert.equal(detections[0].confidence, 91.5);
  assert.equal(detections[0].text, "Reporter: friend@example.com");
  assert.deepEqual(detections[0].boundingBox, {
    x0: 27,
    y0: 44,
    x1: 251,
    y1: 90,
    source: "auto",
  });
  assert.deepEqual(createTourStops(detections)[0].boundingBox, detections[0].boundingBox);
});

test("keeps pixelation and manual-redaction geometry stable", () => {
  const box = createManualRedaction({ x: 90, y: 70 }, { x: 20, y: 10 }, 100, 80);
  assert.deepEqual(box, { x0: 20, y0: 10, x1: 90, y1: 70, source: "manual" });
  assert.deepEqual(pixelSampleDimensions(box, 10), { width: 6, height: 5 });
});

test("cancels active tours on reset and safely ignores reset after completion", () => {
  const sessions = new TourSession();
  const active = sessions.start();
  assert.equal(active.isCurrent(), true);
  sessions.cancel();
  assert.equal(active.signal.aborted, true);
  assert.equal(active.isCurrent(), false);

  const finished = sessions.start();
  assert.equal(sessions.complete(finished), true);
  sessions.cancel();
  assert.equal(finished.isCurrent(), false);
});
