import { clampBox, isSensitiveText, mergeBoxes, normalizeTerms } from "./security.js";

const elements = {
  fileInput: document.querySelector("#fileInput"),
  dropZone: document.querySelector("#dropZone"),
  editor: document.querySelector("#editor"),
  canvas: document.querySelector("#imageCanvas"),
  sampleButton: document.querySelector("#sampleButton"),
  scanButton: document.querySelector("#scanButton"),
  downloadButton: document.querySelector("#downloadButton"),
  resetButton: document.querySelector("#resetButton"),
  customTerms: document.querySelector("#customTerms"),
  blurStrength: document.querySelector("#blurStrength"),
  statusTitle: document.querySelector("#statusTitle"),
  statusText: document.querySelector("#statusText"),
  drawingHint: document.querySelector("#drawingHint"),
};

const context = elements.canvas.getContext("2d", { willReadFrequently: true });
let originalImage = null;
let redactionBoxes = [];
let dragStart = null;
let isScanning = false;
let ocrWorker = null;

function setStatus(title, text) {
  elements.statusTitle.textContent = title;
  elements.statusText.textContent = text;
}

function openFilePicker() {
  elements.fileInput.click();
}

function fitCanvasToImage(image) {
  const maxDimension = 1800;
  const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height));
  elements.canvas.width = Math.round((image.naturalWidth || image.width) * scale);
  elements.canvas.height = Math.round((image.naturalHeight || image.height) * scale);
}

function showImage(image) {
  originalImage = image;
  redactionBoxes = [];
  fitCanvasToImage(image);
  elements.dropZone.hidden = true;
  elements.editor.hidden = false;
  elements.downloadButton.disabled = true;
  elements.drawingHint.hidden = true;
  setStatus("Ready for a privacy check", "We’ll look for sensitive text using Tesseract OCR.");
  renderCanvas();
}

function loadImageSource(source) {
  const image = new Image();
  image.onload = () => showImage(image);
  image.onerror = () => setStatus("That image did not load", "Please try a PNG, JPG or WebP file.");
  image.src = source;
}

function handleFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    setStatus("Please choose an image", "BlurBuddy accepts PNG, JPG and WebP screenshots.");
    return;
  }
  const reader = new FileReader();
  reader.onload = () => loadImageSource(reader.result);
  reader.readAsDataURL(file);
}

function createSample() {
  const sample = document.createElement("canvas");
  sample.width = 1200;
  sample.height = 720;
  const sampleContext = sample.getContext("2d");
  sampleContext.fillStyle = "#f7f3ef";
  sampleContext.fillRect(0, 0, sample.width, sample.height);
  sampleContext.fillStyle = "#6f4ad5";
  sampleContext.fillRect(0, 0, sample.width, 86);
  sampleContext.fillStyle = "white";
  sampleContext.font = "700 28px Arial";
  sampleContext.fillText("Security incident notes", 52, 54);
  sampleContext.fillStyle = "#2f2734";
  sampleContext.font = "700 32px Arial";
  sampleContext.fillText("Potential phishing report", 58, 156);
  sampleContext.font = "24px Arial";
  const lines = [
    "Reporter: friend@example.com",
    "Phone: +234 801 234 5678",
    "Source IP: 192.168.10.44",
    "API key: sk-demo-not-a-real-secret-123456789",
    "Finding: The login link uses a lookalike domain.",
    "Next step: reset the password and revoke active sessions.",
  ];
  lines.forEach((line, index) => sampleContext.fillText(line, 58, 230 + index * 64));
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
  temporaryContext.drawImage(elements.canvas, box.x0, box.y0, width, height, 0, 0, temporary.width, temporary.height);
  context.save();
  context.imageSmoothingEnabled = false;
  context.drawImage(temporary, 0, 0, temporary.width, temporary.height, box.x0, box.y0, width, height);
  context.fillStyle = "rgba(111, 74, 213, 0.08)";
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
    context.strokeStyle = "#ff7e70";
    context.lineWidth = Math.max(2, elements.canvas.width / 500);
    context.setLineDash([10, 7]);
    context.strokeRect(previewBox.x0, previewBox.y0, previewBox.x1 - previewBox.x0, previewBox.y1 - previewBox.y0);
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
    .map((item) => clampBox({ ...item.bbox, source: "auto" }, elements.canvas.width, elements.canvas.height));
}

async function scanImage() {
  if (!originalImage || isScanning) return;
  if (!window.Tesseract) {
    setStatus("OCR could not start", "Refresh the page while online so the open-source OCR library can load.");
    return;
  }

  isScanning = true;
  elements.scanButton.disabled = true;
  elements.scanButton.textContent = "Reading the screenshot…";
  setStatus("Privacy scan in progress", "The first scan may take a little longer while the OCR model loads.");

  try {
    if (!ocrWorker) {
      ocrWorker = await window.Tesseract.createWorker("eng", 1, {
        logger(message) {
          if (message.status === "recognizing text") {
            setStatus("Reading the screenshot", `${Math.round((message.progress || 0) * 100)}% complete`);
          }
        },
      });
    }
    const result = await ocrWorker.recognize(elements.canvas, {}, { blocks: true });
    const customTerms = normalizeTerms(elements.customTerms.value);
    const detected = collectSensitiveBoxes(result.data, customTerms);
    redactionBoxes = mergeBoxes([...redactionBoxes.filter((box) => box.source === "manual"), ...detected]);
    renderCanvas();
    elements.downloadButton.disabled = false;
    elements.drawingHint.hidden = false;

    if (detected.length) {
      setStatus("Sensitive details protected", `${detected.length} area${detected.length === 1 ? "" : "s"} found. Drag over anything else you want hidden.`);
    } else {
      setStatus("No obvious secrets found", "Review the screenshot and drag over anything you still want hidden.");
    }
  } catch (error) {
    console.error(error);
    setStatus("The scan did not finish", "You can still drag over private areas manually, or try the scan again.");
    elements.downloadButton.disabled = false;
    elements.drawingHint.hidden = false;
  } finally {
    isScanning = false;
    elements.scanButton.disabled = false;
    elements.scanButton.innerHTML = '<span aria-hidden="true">✦</span> Scan again';
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
  const box = clampBox({
    x0: Math.min(dragStart.x, point.x),
    y0: Math.min(dragStart.y, point.y),
    x1: Math.max(dragStart.x, point.x),
    y1: Math.max(dragStart.y, point.y),
    source: "manual",
  }, elements.canvas.width, elements.canvas.height, 0);
  dragStart = null;

  if (box.x1 - box.x0 > 8 && box.y1 - box.y0 > 8) {
    redactionBoxes.push(box);
    elements.downloadButton.disabled = false;
    setStatus("Manual blur added", "Review the result, add more areas, or download your safe screenshot.");
  }
  renderCanvas();
}

function downloadImage() {
  renderCanvas();
  const link = document.createElement("a");
  link.download = `blur-buddy-safe-${Date.now()}.png`;
  link.href = elements.canvas.toDataURL("image/png");
  link.click();
}

function resetApp() {
  originalImage = null;
  redactionBoxes = [];
  elements.fileInput.value = "";
  elements.editor.hidden = true;
  elements.dropZone.hidden = false;
  elements.downloadButton.disabled = true;
}

elements.dropZone.addEventListener("click", openFilePicker);
elements.fileInput.addEventListener("change", (event) => handleFile(event.target.files[0]));
elements.sampleButton.addEventListener("click", createSample);
elements.scanButton.addEventListener("click", scanImage);
elements.downloadButton.addEventListener("click", downloadImage);
elements.resetButton.addEventListener("click", resetApp);
elements.blurStrength.addEventListener("input", () => renderCanvas());
elements.canvas.addEventListener("pointerdown", startDrawing);
elements.canvas.addEventListener("pointermove", moveDrawing);
elements.canvas.addEventListener("pointerup", finishDrawing);
elements.canvas.addEventListener("pointercancel", () => { dragStart = null; renderCanvas(); });

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
