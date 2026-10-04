const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PHONE_PATTERN = /(?:\+?\d[\d\s().-]{6,}\d)/;
const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
const URL_PATTERN = /(?:https?:\/\/|www\.)\S+/i;
const SECRET_PATTERN = /\b(?:api[\s_-]?key|access[\s_-]?token|auth(?:orization)?|bearer|password|passwd|secret|private[\s_-]?key)\b/i;
const TOKEN_PATTERN = /\b(?:sk|pk|ghp|xox[baprs]|AIza)[-_A-Za-z0-9]{8,}\b/;

export const CATEGORY_LABELS = Object.freeze({
  email: ["email", "emails"],
  phone: ["phone number", "phone numbers"],
  "private-ip": ["private IP", "private IPs"],
  "ip-address": ["IP address", "IP addresses"],
  "web-address": ["web address", "web addresses"],
  "possible-credential": ["possible credential", "possible credentials"],
  "custom-word": ["custom detail", "custom details"],
});

export function normalizeTerms(value) {
  return String(value || "")
    .split(",")
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean);
}

export function describeStrength(value) {
  const strength = Number(value);
  if (strength <= 10) return `${strength} · soft`;
  if (strength <= 20) return `${strength} · balanced`;
  return `${strength} · chunky`;
}

function validIpv4(value) {
  const match = String(value).match(IPV4_PATTERN);
  if (!match) return null;
  const octets = match[0].split(".").map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

function isPrivateIpv4(octets) {
  if (!octets) return false;
  const [first, second] = octets;
  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

export function detectSensitiveCategories(text, customTerms = []) {
  const value = String(text || "").trim();
  if (!value) return [];

  const categories = [];
  const digitCount = value.replace(/\D/g, "").length;
  const ipOctets = validIpv4(value);

  if (SECRET_PATTERN.test(value) || TOKEN_PATTERN.test(value)) categories.push("possible-credential");
  if (EMAIL_PATTERN.test(value)) categories.push("email");
  if (ipOctets) categories.push(isPrivateIpv4(ipOctets) ? "private-ip" : "ip-address");
  if (PHONE_PATTERN.test(value) && digitCount >= 7 && !ipOctets) categories.push("phone");
  if (URL_PATTERN.test(value)) categories.push("web-address");
  if (customTerms.some((term) => value.toLowerCase().includes(term))) categories.push("custom-word");

  return categories;
}

export function isSensitiveText(text, customTerms = []) {
  return detectSensitiveCategories(text, customTerms).length > 0;
}

export function clampBox(box, width, height, padding = 7) {
  const x0 = Math.max(0, Math.floor(box.x0 - padding));
  const y0 = Math.max(0, Math.floor(box.y0 - padding));
  const x1 = Math.min(width, Math.ceil(box.x1 + padding));
  const y1 = Math.min(height, Math.ceil(box.y1 + padding));
  return { x0, y0, x1, y1, source: box.source || "auto" };
}

export function boxesOverlap(a, b) {
  return !(a.x1 < b.x0 || b.x1 < a.x0 || a.y1 < b.y0 || b.y1 < a.y0);
}

export function mergeBoxes(boxes) {
  const merged = [];
  for (const box of boxes) {
    const match = merged.find((candidate) => boxesOverlap(candidate, box));
    if (match) {
      match.x0 = Math.min(match.x0, box.x0);
      match.y0 = Math.min(match.y0, box.y0);
      match.x1 = Math.max(match.x1, box.x1);
      match.y1 = Math.max(match.y1, box.y1);
    } else {
      merged.push({ ...box });
    }
  }
  return merged;
}

function ocrLines(data) {
  if (Array.isArray(data?.lines) && data.lines.length) return data.lines;
  return (data?.blocks || []).flatMap((block) =>
    (block.paragraphs || []).flatMap((paragraph) => paragraph.lines || []),
  );
}

/**
 * Turn Tesseract output into local-only structured detections. Lines are preferred
 * so split phone numbers, credential labels, and multi-word custom terms stay intact.
 * Words are used when a line itself is not sensitive, which keeps boxes precise.
 */
export function buildDetections(data, customTerms, width, height) {
  const detections = [];

  for (const line of ocrLines(data)) {
    const lineCategories = detectSensitiveCategories(line.text, customTerms);
    const candidates = lineCategories.length ? [line] : line.words || [];

    for (const candidate of candidates) {
      const categories = detectSensitiveCategories(candidate.text, customTerms);
      if (!candidate.bbox || !categories.length) continue;
      const boundingBox = clampBox(candidate.bbox, width, height);
      if (boundingBox.x1 <= boundingBox.x0 || boundingBox.y1 <= boundingBox.y0) continue;

      detections.push({
        category: categories[0],
        boundingBox,
        confidence: Number.isFinite(candidate.confidence) ? candidate.confidence : null,
        text: String(candidate.text || ""),
      });
    }
  }

  return detections;
}

export function createTourStops(detections) {
  return detections.map((detection, index) => ({
    index,
    category: detection.category,
    boundingBox: { ...detection.boundingBox },
  }));
}

export function aggregateDetections(detections, manualCount = 0) {
  const categories = {};
  for (const detection of detections) {
    categories[detection.category] = (categories[detection.category] || 0) + 1;
  }
  return {
    total: detections.length + manualCount,
    categories,
    manualCount,
  };
}

export function formatCategoryCount(category, count) {
  const labels = CATEGORY_LABELS[category] || ["private detail", "private details"];
  return `${count} ${count === 1 ? labels[0] : labels[1]}`;
}

export function canvasBoxToCss(box, canvasRect, canvasWidth, canvasHeight) {
  const scaleX = canvasRect.width / canvasWidth;
  const scaleY = canvasRect.height / canvasHeight;
  return {
    left: canvasRect.left + box.x0 * scaleX,
    top: canvasRect.top + box.y0 * scaleY,
    width: (box.x1 - box.x0) * scaleX,
    height: (box.y1 - box.y0) * scaleY,
    scaleX,
    scaleY,
  };
}

export function createManualRedaction(start, end, width, height) {
  return clampBox(
    {
      x0: Math.min(start.x, end.x),
      y0: Math.min(start.y, end.y),
      x1: Math.max(start.x, end.x),
      y1: Math.max(start.y, end.y),
      source: "manual",
    },
    width,
    height,
    0,
  );
}

export function pixelSampleDimensions(box, strength) {
  const width = Math.max(1, box.x1 - box.x0);
  const height = Math.max(1, box.y1 - box.y0);
  const sampleWidth = Math.max(2, Math.round(Math.min(width, height) / strength));
  return {
    width: sampleWidth,
    height: Math.max(2, Math.round((height / width) * sampleWidth)),
  };
}
