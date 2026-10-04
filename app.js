import {
  clampBox,
  describeStrength,
  isSensitiveText,
  mergeBoxes,
  normalizeTerms,
} from "./security.js";

const elements = {
  fileInput: document.querySelector("#fileInput"),
  dropZone: document.querySelector("#dropZone"),
  dropHelp: document.querySelector(".drop-zone-copy span"),
  editor: document.querySelector("#editor"),
  workspace: document.querySelector("#workspace"),
  workspaceTitle: document.querySelector("#workspace-title"),
  canvas: document.querySelector("#imageCanvas"),
  sampleButton: document.querySelector("#sampleButton"),
  scanButton: document.querySelector("#scanButton"),
  scanButtonLabel: document.querySelector("#scanButtonLabel"),
  downloadButton: document.querySelector("#downloadButton"),
  resetButton: document.querySelector("#resetButton"),
  customTerms: document.querySelector("#customTerms"),
  blurStrength: document.querySelector("#blurStrength"),
  strengthValue: document.querySelector("#strengthValue"),
  statusCard: document.querySelector("#statusCard"),
  statusTitle: document.querySelector("#statusTitle"),
  statusText: document.querySelector("#statusText"),
  drawingHint: document.querySelector("#drawingHint"),
  blooDock: document.querySelector("#blooDock"),
  blooButton: document.querySelector("#blooButton"),
  blooNote: document.querySelector("#blooNote"),
};

const context = elements.canvas.getContext("2d", { willReadFrequently: true });
const defaultDropHelp = elements.dropHelp.textContent;
let originalImage = null;
let redactionBoxes = [];
let dragStart = null;
let isScanning = false;
let ocrWorker = null;
let greetingTimer = null;
let lastProgress = -1;

function setStatus(title, text, tone = "ready") {
  elements.statusTitle.textContent = title;
  elements.statusText.textContent = text;
  elements.statusCard.dataset.tone = tone;
}

function setBlooMood(mood, message) {
  if (elements.blooDock.dataset.mood === mood && (mood === "success" || mood === "concerned")) {
    elements.blooDock.dataset.mood = "idle";
    void elements.blooDock.offsetWidth;
  }
  elements.blooDock.dataset.mood = mood;
  elements.blooNote.textContent = message;
  elements.blooButton.setAttribute("aria-label", `${message} Say hello to Bloo.`);
}

function setDropFeedback(message = defaultDropHelp, isError = false) {
  elements.dropHelp.textContent = message;
  elements.dropZone.classList.toggle("has-error", isError);
}

function setScanLoading(loading) {
  elements.scanButton.disabled = loading;
  elements.scanButton.setAttribute("aria-busy", String(loading));
  elements.scanButtonLabel.textContent = loading ? "Reading your screenshot…" : "Scan this screenshot again";
}

function openFilePicker() {
  elements.fileInput.click();
}

function fitCanvasToImage(image) {
  const maxDimension = 1800;
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  elements.canvas.width = Math.round(width * scale);
  elements.canvas.height = Math.round(height * scale);
}

function showImage(image) {
  originalImage = image;
  redactionBoxes = [];
  fitCanvasToImage(image);
  elements.dropZone.hidden = true;
  elements.editor.hidden = false;
  elements.workspace.dataset.state = "editing";
  elements.workspaceTitle.textContent = "Make it safe to share";
  elements.downloadButton.disabled = true;
  elements.scanButtonLabel.textContent = "Find & cover private details";
  elements.scanButton.setAttribute("aria-busy", "false");
  elements.drawingHint.hidden = true;
  setDropFeedback();
  setStatus(
    "Ready when you are",
    "Bloo can check the text, then you can cover any extras by hand.",
    "ready",
  );
  setBlooMood("idle", "Looks good. Tap the blue button when you want me to check the text.");
  renderCanvas();
  window.requestAnimationFrame(updateBlooAvoidance);
}

function loadImageSource(source) {
  const image = new Image();
  image.onload = () => showImage(image);
  image.onerror = () => {
    setDropFeedback("That image did not open. Try a PNG, JPG or WebP instead.", true);
    setBlooMood("concerned", "I couldn’t open that one. Could you try another image?");
  };
  image.src = source;
}

function handleFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    setDropFeedback("Please choose a PNG, JPG or WebP screenshot.", true);
    setBlooMood("concerned", "That doesn’t look like an image. A PNG, JPG or WebP will work.");
    return;
  }

  setDropFeedback("Opening it here on your device…");
  const reader = new FileReader();
  reader.onload = () => loadImageSource(reader.result);
  reader.onerror = () => {
    setDropFeedback("That file could not be read. Please try another screenshot.", true);
    setBlooMood("concerned", "I couldn’t read that file. Let’s try another one.");
  };
  reader.readAsDataURL(file);
}

function createSample() {
  const sample = document.createElement("canvas");
  sample.width = 1200;
  sample.height = 720;
  const sampleContext = sample.getContext("2d");

  sampleContext.fillStyle = "#f5fbff";
  sampleContext.fillRect(0, 0, sample.width, sample.height);
  sampleContext.fillStyle = "#102f4a";
  sampleContext.fillRect(0, 0, sample.width, 92);
  sampleContext.fillStyle = "#ffffff";
  sampleContext.font = "700 28px Arial";
  sampleContext.fillText("Security incident notes", 52, 58);

  sampleContext.fillStyle = "#d8edfb";
  sampleContext.fillRect(930, 24, 210, 44);
  sampleContext.fillStyle = "#102f4a";
  sampleContext.font = "700 17px Arial";
  sampleContext.fillText("PRIVATE DRAFT", 968, 52);

  sampleContext.fillStyle = "#102f4a";
  sampleContext.font = "700 32px Arial";
  sampleContext.fillText("Potential phishing report", 58, 166);
  sampleContext.fillStyle = "#294b67";
  sampleContext.font = "24px Arial";
  const lines = [
    "Reporter: friend@example.com",
    "Phone: +234 801 234 5678",
    "Source IP: 192.168.10.44",
    "API key: sk-demo-not-a-real-secret-123456789",
    "Finding: The login link uses a lookalike domain.",
    "Next step: reset the password and revoke active sessions.",
  ];
  lines.forEach((line, index) => sampleContext.fillText(line, 58, 240 + index * 64));

  sampleContext.strokeStyle = "#78bee9";
  sampleContext.lineWidth = 3;
  sampleContext.beginPath();
  sampleContext.moveTo(58, 640);
  sampleContext.quadraticCurveTo(340, 655, 590, 638);
  sampleContext.stroke();

  loadImageSource(sample.toDataURL("image/png"));
}

function drawPixelatedBox(box, strength) {
  const width = Math.max(1, box.x1 - box.x0);
  const height = Math.max(1, box.y1 - box.y0);
  const sampleSize = Math.max(2, Math.round(Math.min(width, height) / strength));
  const temporary = document.createElement("canvas");
  temporary.width = sampleSize;
  temporary.height = Math.max(2, Math.round((height / width) * sampleSize));
  const temporaryContext = temporary.getContext("2d");

  temporaryContext.imageSmoothingEnabled = false;
  temporaryContext.drawImage(
    elements.canvas,
    box.x0,
    box.y0,
    width,
    height,
    0,
    0,
    temporary.width,
    temporary.height,
  );
  context.save();
  context.imageSmoothingEnabled = false;
  context.drawImage(
    temporary,
    0,
    0,
    temporary.width,
    temporary.height,
    box.x0,
    box.y0,
    width,
    height,
  );
  context.fillStyle = "rgba(66, 155, 213, 0.12)";
  context.fillRect(box.x0, box.y0, width, height);
  context.restore();
}

function renderCanvas(previewBox = null) {
  if (!originalImage) return;
  context.clearRect(0, 0, elements.canvas.width, elements.canvas.height);
  context.drawImage(originalImage, 0, 0, elements.canvas.width, elements.canvas.height);
  const strength = Number(elements.blurStrength.value);
  redactionBoxes.forEach((box) => drawPixelatedBox(box, strength));

  if (previewBox) {
    context.save();
    context.strokeStyle = "#237eb9";
    context.lineWidth = Math.max(2, elements.canvas.width / 500);
    context.setLineDash([10, 7]);
    context.strokeRect(
      previewBox.x0,
      previewBox.y0,
      previewBox.x1 - previewBox.x0,
      previewBox.y1 - previewBox.y0,
    );
    context.restore();
  }
}

function collectSensitiveBoxes(data, customTerms) {
  const blocks = data.blocks || [];
  const lines = blocks.flatMap((block) =>
    (block.paragraphs || []).flatMap((paragraph) => paragraph.lines || []),
  );
  const words = lines.flatMap((line) => line.words || []);
  const candidates = [...lines, ...words];
  return candidates
    .filter((item) => item.bbox && isSensitiveText(item.text, customTerms))
    .map((item) =>
      clampBox({ ...item.bbox, source: "auto" }, elements.canvas.width, elements.canvas.height),
    );
}

async function scanImage() {
  if (!originalImage || isScanning) return;
  if (!window.Tesseract) {
    setStatus(
      "OCR could not start",
      "Reconnect and refresh so the OCR library can download, or cover areas by hand.",
      "error",
    );
    setBlooMood("concerned", "I can’t reach the OCR tools. You can still cover private spots by hand.");
    elements.downloadButton.disabled = false;
    elements.drawingHint.hidden = false;
    return;
  }

  isScanning = true;
  lastProgress = -1;
  setScanLoading(true);
  setStatus(
    "Reading your screenshot",
    "The first scan can take longer while the OCR model downloads.",
    "scanning",
  );
  setBlooMood("scanning", "I’m reading the text now. Your image is staying right here.");

  try {
    if (!ocrWorker) {
      ocrWorker = await window.Tesseract.createWorker("eng", 1, {
        logger(message) {
          if (message.status !== "recognizing text") return;
          const progress = Math.round((message.progress || 0) * 100);
          if (progress >= lastProgress + 5 || progress === 100) {
            lastProgress = progress;
            setStatus("Reading your screenshot", `${progress}% complete`, "scanning");
            elements.blooNote.textContent = `Still looking… ${progress}% read.`;
          }
        },
      });
    }

    const result = await ocrWorker.recognize(elements.canvas, {}, { blocks: true });
    const customTerms = normalizeTerms(elements.customTerms.value);
    const detected = collectSensitiveBoxes(result.data, customTerms);
    redactionBoxes = mergeBoxes([
      ...redactionBoxes.filter((box) => box.source === "manual"),
      ...detected,
    ]);
    renderCanvas();
    elements.downloadButton.disabled = false;
    elements.drawingHint.hidden = false;

    if (detected.length) {
      const areaLabel = `${detected.length} area${detected.length === 1 ? "" : "s"}`;
      setStatus(
        "Private details covered",
        `${areaLabel} found. Give the image one last look before downloading.`,
        "success",
      );
      setBlooMood("success", `Nice! I covered ${areaLabel}. Please give everything one last look.`);
    } else {
      setStatus(
        "Nothing obvious jumped out",
        "Automatic checks can miss things. Review the image and drag over anything private.",
        "ready",
      );
      setBlooMood("idle", "I didn’t spot an obvious secret. Let’s still give it a careful once-over.");
    }
  } catch (error) {
    console.error(error);
    setStatus(
      "The scan did not finish",
      "Try once more, or drag over private areas yourself—the editor still works.",
      "error",
    );
    setBlooMood("concerned", "That scan stumbled. I’m sorry—manual covering still works.");
    elements.downloadButton.disabled = false;
    elements.drawingHint.hidden = false;
  } finally {
    isScanning = false;
    setScanLoading(false);
    window.requestAnimationFrame(updateBlooAvoidance);
  }
}

function canvasPoint(event) {
  const rect = elements.canvas.getBoundingClientRect();
  const point = event.touches?.[0] || event;
  return {
    x: ((point.clientX - rect.left) / rect.width) * elements.canvas.width,
    y: ((point.clientY - rect.top) / rect.height) * elements.canvas.height,
  };
}

function startDrawing(event) {
  if (!originalImage || isScanning) return;
  dragStart = canvasPoint(event);
  elements.canvas.setPointerCapture?.(event.pointerId);
}

function moveDrawing(event) {
  if (!dragStart) return;
  const point = canvasPoint(event);
  renderCanvas({
    x0: Math.min(dragStart.x, point.x),
    y0: Math.min(dragStart.y, point.y),
    x1: Math.max(dragStart.x, point.x),
    y1: Math.max(dragStart.y, point.y),
  });
}

function finishDrawing(event) {
  if (!dragStart) return;
  const point = canvasPoint(event);
  const box = clampBox(
    {
      x0: Math.min(dragStart.x, point.x),
      y0: Math.min(dragStart.y, point.y),
      x1: Math.max(dragStart.x, point.x),
      y1: Math.max(dragStart.y, point.y),
      source: "manual",
    },
    elements.canvas.width,
    elements.canvas.height,
    0,
  );
  dragStart = null;

  if (box.x1 - box.x0 > 8 && box.y1 - box.y0 > 8) {
    redactionBoxes.push(box);
    elements.downloadButton.disabled = false;
    elements.drawingHint.hidden = false;
    setStatus(
      "That spot is covered",
      "Add another area, run the text check, or download when it looks right.",
      "success",
    );
    setBlooMood("success", "Good catch! That spot is covered now.");
  }
  renderCanvas();
}

function cancelDrawing() {
  dragStart = null;
  renderCanvas();
}

function downloadImage() {
  if (!originalImage) return;
  renderCanvas();
  const link = document.createElement("a");
  link.download = `blur-buddy-safe-${Date.now()}.png`;
  link.href = elements.canvas.toDataURL("image/png");
  link.click();
  setStatus("Safer copy downloaded", "Keep the original private, and share the new copy with care.", "success");
  setBlooMood("success", "Your safer copy is ready. Nice work checking it before sharing!");
}

function resetApp() {
  originalImage = null;
  redactionBoxes = [];
  dragStart = null;
  elements.fileInput.value = "";
  elements.customTerms.value = "";
  elements.blurStrength.value = "16";
  elements.strengthValue.textContent = describeStrength(16);
  elements.editor.hidden = true;
  elements.dropZone.hidden = false;
  elements.workspace.dataset.state = "empty";
  elements.workspaceTitle.textContent = "Bring in a screenshot";
  elements.downloadButton.disabled = true;
  elements.scanButton.disabled = false;
  elements.scanButtonLabel.textContent = "Find & cover private details";
  elements.scanButton.setAttribute("aria-busy", "false");
  elements.drawingHint.hidden = true;
  setDropFeedback();
  setBlooMood("idle", "Fresh desk, fresh start. Drop in a screenshot when you’re ready.");
  setStatus(
    "Ready when you are",
    "Bloo can check the text, then you can cover any extras by hand.",
    "ready",
  );
  window.requestAnimationFrame(updateBlooAvoidance);
}

function updateStrength() {
  elements.strengthValue.textContent = describeStrength(elements.blurStrength.value);
  renderCanvas();
}

function greetBloo() {
  window.clearTimeout(greetingTimer);
  elements.blooDock.classList.remove("is-greeting");
  void elements.blooDock.offsetWidth;
  elements.blooDock.classList.add("is-greeting");
  greetingTimer = window.setTimeout(() => elements.blooDock.classList.remove("is-greeting"), 1100);
}

function rectanglesOverlap(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function updateBlooAvoidance() {
  elements.blooDock.classList.remove("is-avoiding");
  const blooRect = elements.blooButton.getBoundingClientRect();
  const controls = document.querySelectorAll("button:not(#blooButton), input, a");
  const overlapsControl = [...controls].some((control) => {
    if (control.hidden || control.closest("[hidden]")) return false;
    const style = window.getComputedStyle(control);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = control.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight) return false;
    return rectanglesOverlap(blooRect, rect);
  });
  elements.blooDock.classList.toggle("is-avoiding", overlapsControl);
}

elements.dropZone.addEventListener("click", openFilePicker);
elements.fileInput.addEventListener("change", (event) => handleFile(event.target.files[0]));
elements.sampleButton.addEventListener("click", createSample);
elements.scanButton.addEventListener("click", scanImage);
elements.downloadButton.addEventListener("click", downloadImage);
elements.resetButton.addEventListener("click", resetApp);
elements.blurStrength.addEventListener("input", updateStrength);
elements.canvas.addEventListener("pointerdown", startDrawing);
elements.canvas.addEventListener("pointermove", moveDrawing);
elements.canvas.addEventListener("pointerup", finishDrawing);
elements.canvas.addEventListener("pointercancel", cancelDrawing);
elements.blooButton.addEventListener("click", greetBloo);

for (const eventName of ["dragenter", "dragover"]) {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.add("is-dragging");
  });
}

for (const eventName of ["dragleave", "drop"]) {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.remove("is-dragging");
  });
}

elements.dropZone.addEventListener("drop", (event) => handleFile(event.dataTransfer.files[0]));
window.addEventListener("scroll", () => window.requestAnimationFrame(updateBlooAvoidance), { passive: true });
window.addEventListener("resize", () => window.requestAnimationFrame(updateBlooAvoidance));

elements.strengthValue.textContent = describeStrength(elements.blurStrength.value);
window.requestAnimationFrame(updateBlooAvoidance);
