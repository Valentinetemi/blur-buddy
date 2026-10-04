const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PHONE_PATTERN = /(?:\+?\d[\d\s().-]{6,}\d)/;
const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
const URL_PATTERN = /(?:https?:\/\/|www\.)\S+/i;
const SECRET_PATTERN = /\b(?:api[\s_-]?key|access[\s_-]?token|auth(?:orization)?|bearer|password|passwd|secret|private[\s_-]?key)\b/i;
const TOKEN_PATTERN = /\b(?:sk|pk|ghp|xox[baprs]|AIza)[-_A-Za-z0-9]{8,}\b/;

export function normalizeTerms(value) {
  return value
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

export function isSensitiveText(text, customTerms = []) {
  const value = String(text || "").trim();
  if (!value) return false;

  const containsCustomTerm = customTerms.some((term) => value.toLowerCase().includes(term));
  const hasLongNumber = PHONE_PATTERN.test(value) && value.replace(/\D/g, "").length >= 7;

  return (
    EMAIL_PATTERN.test(value) ||
    hasLongNumber ||
    IPV4_PATTERN.test(value) ||
    URL_PATTERN.test(value) ||
    SECRET_PATTERN.test(value) ||
    TOKEN_PATTERN.test(value) ||
    containsCustomTerm
  );
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
