import {
  aggregateDetections,
  buildDetections,
  canvasBoxToCss,
  createManualRedaction,
  createTourStops,
  describeStrength,
  formatCategoryCount,
  normalizeTerms,
  pixelSampleDimensions,
} from "./security.js";
import { TourSession, waitForTour } from "./tour.js";

const elements = {
  fileInput: document.querySelector("#fileInput"),
  dropZone: document.querySelector("#dropZone"),
  dropHelp: document.querySelector(".drop-zone-copy span"),
  editor: document.querySelector("#editor"),
  workspace: document.querySelector("#workspace"),
  workspaceTitle: document.querySelector("#workspace-title"),
  canvasShell: document.querySelector(".canvas-shell"),
  comparisonStage: document.querySelector("#comparisonStage"),
  canvas: document.querySelector("#imageCanvas"),
  originalCanvas: document.querySelector("#originalCanvas"),
  comparisonUi: document.querySelector("#comparisonUi"),
  comparisonDivider: document.querySelector("#comparisonDivider"),
  comparisonSlider: document.querySelector("#comparisonSlider"),
  tourBubble: document.querySelector("#tourBubble"),
  sampleButton: document.querySelector("#sampleButton"),
  scanButton: document.querySelector("#scanButton"),
  scanButtonLabel: document.querySelector("#scanButtonLabel"),
  replayButton: document.querySelector("#replayButton"),
  downloadButton: document.querySelector("#downloadButton"),
  finalDownloadButton: document.querySelector("#finalDownloadButton"),
  resetButton: document.querySelector("#resetButton"),
  customTerms: document.querySelector("#customTerms"),
  blurStrength: document.querySelector("#blurStrength"),
  strengthValue: document.querySelector("#strengthValue"),
  statusCard: document.querySelector("#statusCard"),
  statusTitle: document.querySelector("#statusTitle"),
  statusText: document.querySelector("#statusText"),
  drawingHint: document.querySelector("#drawingHint"),
  privacyReceipt: document.querySelector("#privacyReceipt"),
  receiptTotal: document.querySelector("#receiptTotal"),
  receiptList: document.querySelector("#receiptList"),
  safeShareCard: document.querySelector("#safeShareCard"),
  blooDock: document.querySelector("#blooDock"),
  blooButton: document.querySelector("#blooButton"),
  blooNote: document.querySelector("#blooNote"),
};

const context = elements.canvas.getContext("2d", { willReadFrequently: true });
const originalContext = elements.originalCanvas.getContext("2d");
const defaultDropHelp = elements.dropHelp.textContent;
const tourSessions = new TourSession();
const blooHome = elements.blooDock.parentElement;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

let originalImage = null;
let redactionBoxes = [];
let tourDetections = [];
let dragStart = null;
let keyboardRedaction = null;
let isScanning = false;
let isTouring = false;
let tourCompleted = false;
let downloadReady = false;
let ocrWorker = null;
let greetingTimer = null;
let lastProgress = -1;
let currentTourBox = null;

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

function setWorkBusy(busy, phase = "scan") {
  elements.scanButton.disabled = busy;
  elements.replayButton.disabled = busy;
  elements.customTerms.disabled = busy;
  elements.downloadButton.disabled = busy || !downloadReady;
  elements.finalDownloadButton.disabled = busy;
  elements.scanButton.setAttribute("aria-busy", String(busy));
  if (busy) {
    elements.scanButtonLabel.textContent =
      phase === "scan" ? "Reading your screenshot…" : "Bloo is protecting details…";
  } else {
    elements.scanButtonLabel.textContent = tourCompleted
      ? "Scan this screenshot again"
      : "Find & cover private details";
  }
}

function openFilePicker() {
  if (!isScanning && !isTouring) elements.fileInput.click();
}

function fitCanvasToImage(image) {
  const maxDimension = 1800;
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  const canvasWidth = Math.round(width * scale);
  const canvasHeight = Math.round(height * scale);
  elements.canvas.width = canvasWidth;
  elements.canvas.height = canvasHeight;
  elements.originalCanvas.width = canvasWidth;
  elements.originalCanvas.height = canvasHeight;
}

function drawOriginalComparison() {
  if (!originalImage) return;
  originalContext.clearRect(0, 0, elements.originalCanvas.width, elements.originalCanvas.height);
  originalContext.drawImage(
    originalImage,
    0,
    0,
    elements.originalCanvas.width,
    elements.originalCanvas.height,
  );
}

function stopActiveWork({ terminateOcr = false } = {}) {
  tourSessions.cancel();
  isScanning = false;
  isTouring = false;
  currentTourBox = null;
  hidePrivacyBubble();
  restoreBlooDock();

  if (terminateOcr && ocrWorker) {
    const worker = ocrWorker;
    ocrWorker = null;
    Promise.resolve(worker.terminate()).catch(() => {});
  }
}

function showImage(image) {
  stopActiveWork({ terminateOcr: isScanning });
  originalImage = image;
  redactionBoxes = [];
  tourDetections = [];
  tourCompleted = false;
  downloadReady = false;
  keyboardRedaction = null;
  fitCanvasToImage(image);
  drawOriginalComparison();
  elements.dropZone.hidden = true;
  elements.editor.hidden = false;
  elements.workspace.dataset.state = "editing";
  elements.workspaceTitle.textContent = "Make it safe to share";
  elements.replayButton.hidden = true;
  elements.privacyReceipt.hidden = true;
  elements.safeShareCard.hidden = true;
  elements.drawingHint.hidden = true;
  hideComparison();
  setWorkBusy(false);
  setDropFeedback();
  setStatus(
    "Ready when you are",
    "Bloo can check the text, then you can cover any extras by hand.",
    "ready",
  );
  setBlooMood("idle", "Looks good. Start the privacy tour when you want me to check the text.");
  renderCanvas();
  window.requestAnimationFrame(() => {
    syncOverlayGeometry();
    updateBlooAvoidance();
  });
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
  if (!file || !["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    setDropFeedback("Please choose a PNG, JPG or WebP screenshot.", true);
    setBlooMood("concerned", "That doesn’t look like a supported image. A PNG, JPG or WebP will work.");
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
  const sample = pixelSampleDimensions(box, strength);
  const temporary = document.createElement("canvas");
  temporary.width = sample.width;
  temporary.height = sample.height;
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
    context.strokeStyle = "#176fa8";
    context.fillStyle = "rgba(66, 155, 213, 0.12)";
    context.lineWidth = Math.max(2, elements.canvas.width / 500);
    context.setLineDash([10, 7]);
    context.fillRect(
      previewBox.x0,
      previewBox.y0,
      previewBox.x1 - previewBox.x0,
      previewBox.y1 - previewBox.y0,
    );
    context.strokeRect(
      previewBox.x0,
      previewBox.y0,
      previewBox.x1 - previewBox.x0,
      previewBox.y1 - previewBox.y0,
    );
    context.restore();
  }
}

function createOcrSource() {
  const source = document.createElement("canvas");
  source.width = elements.canvas.width;
  source.height = elements.canvas.height;
  source.getContext("2d").drawImage(originalImage, 0, 0, source.width, source.height);
  return source;
}

function motionDuration(standard, reduced = 18) {
  return reducedMotion.matches ? reduced : standard;
}

function hidePrivacyBubble() {
  elements.tourBubble.classList.remove("is-dropping", "is-pixelating", "is-finished");
  elements.tourBubble.removeAttribute("style");
}

function positionBubble(box) {
  if (!box || !originalImage) return;
  const canvasRect = elements.canvas.getBoundingClientRect();
  const stageRect = elements.comparisonStage.getBoundingClientRect();
  const cssBox = canvasBoxToCss(box, canvasRect, elements.canvas.width, elements.canvas.height);
  elements.tourBubble.style.left = `${cssBox.left - stageRect.left}px`;
  elements.tourBubble.style.top = `${cssBox.top - stageRect.top}px`;
  elements.tourBubble.style.width = `${Math.max(14, cssBox.width)}px`;
  elements.tourBubble.style.height = `${Math.max(12, cssBox.height)}px`;
}

function positionBloo(box, immediate = false) {
  if (!box || !originalImage || !elements.blooDock.classList.contains("is-touring")) return;
  const canvasRect = elements.canvas.getBoundingClientRect();
  const shellRect = elements.canvasShell.getBoundingClientRect();
  const cssBox = canvasBoxToCss(box, canvasRect, elements.canvas.width, elements.canvas.height);
  const dockRect = elements.blooDock.getBoundingClientRect();
  const width = dockRect.width || 76;
  const height = dockRect.height || 92;
  const maxLeft = Math.max(0, shellRect.width - width);
  const maxTop = Math.max(0, shellRect.height - height);
  const targetLeft = Math.min(
    maxLeft,
    Math.max(0, cssBox.left - shellRect.left + cssBox.width / 2 - width / 2),
  );
  const targetTop = Math.min(
    maxTop,
    Math.max(0, cssBox.top - shellRect.top - height * 0.62),
  );

  if (immediate) elements.blooDock.style.transition = "none";
  elements.blooDock.style.left = `${targetLeft}px`;
  elements.blooDock.style.top = `${targetTop}px`;
  if (immediate) {
    void elements.blooDock.offsetWidth;
    elements.blooDock.style.removeProperty("transition");
  }
}

function enterTourMode(firstBox) {
  elements.canvasShell.append(elements.blooDock);
  elements.blooDock.classList.remove("is-avoiding");
  elements.blooDock.classList.add("is-touring");
  const shellRect = elements.canvasShell.getBoundingClientRect();
  elements.blooDock.style.left = `${Math.max(0, shellRect.width - 90)}px`;
  elements.blooDock.style.top = `${Math.max(0, shellRect.height - 105)}px`;
  void elements.blooDock.offsetWidth;
  if (firstBox) positionBloo(firstBox);
}

function restoreBlooDock() {
  if (elements.blooDock.parentElement !== blooHome) blooHome.append(elements.blooDock);
  elements.blooDock.classList.remove("is-touring");
  elements.blooDock.style.removeProperty("left");
  elements.blooDock.style.removeProperty("top");
  elements.blooDock.style.removeProperty("transition");
}

function addTourRedaction(box) {
  const exists = redactionBoxes.some(
    (candidate) =>
      candidate.source === "auto" &&
      candidate.x0 === box.x0 &&
      candidate.y0 === box.y0 &&
      candidate.x1 === box.x1 &&
      candidate.y1 === box.y1,
  );
  if (!exists) redactionBoxes.push({ ...box, source: "auto" });
  renderCanvas();
}

async function animatePrivacyBubble(stop, session, applyRedaction) {
  currentTourBox = stop.boundingBox;
  positionBubble(stop.boundingBox);
  positionBloo(stop.boundingBox);
  await waitForTour(motionDuration(660), session.signal);
  if (!session.isCurrent()) return;

  setBlooMood("discovery", "Found one. I’m dropping a privacy bubble right here.");
  elements.tourBubble.classList.add("is-dropping");
  await waitForTour(motionDuration(360), session.signal);
  if (!session.isCurrent()) return;

  elements.tourBubble.classList.add("is-pixelating");
  await waitForTour(motionDuration(230), session.signal);
  if (!session.isCurrent()) return;

  if (applyRedaction) addTourRedaction(stop.boundingBox);
  elements.tourBubble.classList.add("is-finished");
  await waitForTour(motionDuration(190), session.signal);
  hidePrivacyBubble();
}

function renderReceipt() {
  if (!tourCompleted) {
    elements.privacyReceipt.hidden = true;
    return;
  }

  const manualCount = redactionBoxes.filter((box) => box.source === "manual").length;
  const receipt = aggregateDetections(tourDetections, manualCount);
  elements.receiptTotal.textContent = `${receipt.total} private detail${receipt.total === 1 ? "" : "s"} protected`;
  elements.receiptList.replaceChildren();

  for (const [category, count] of Object.entries(receipt.categories)) {
    const item = document.createElement("li");
    item.textContent = formatCategoryCount(category, count);
    elements.receiptList.append(item);
  }
  if (receipt.manualCount) {
    const item = document.createElement("li");
    item.textContent = `${receipt.manualCount} manual area${receipt.manualCount === 1 ? "" : "s"}`;
    elements.receiptList.append(item);
  }

  elements.privacyReceipt.hidden = false;
}

function finishTour(detections, replay = false) {
  currentTourBox = null;
  restoreBlooDock();
  hidePrivacyBubble();
  setBlooMood("success", replay ? "Tour replay complete! Everything stayed protected." : "Privacy tour complete! Give the image one last look.");

  if (!replay) {
    tourDetections = detections;
    const manualBoxes = redactionBoxes.filter((box) => box.source === "manual");
    redactionBoxes = [
      ...manualBoxes,
      ...detections.map((detection) => ({ ...detection.boundingBox, source: "auto" })),
    ];
    tourCompleted = true;
    renderCanvas();
    renderReceipt();
    elements.replayButton.hidden = detections.length === 0;
    elements.safeShareCard.hidden = false;
    showComparison();
  }

  downloadReady = true;
  elements.downloadButton.disabled = isScanning || isTouring;
  elements.drawingHint.hidden = false;
  const count = detections.length;
  setStatus(
    replay ? "Privacy tour replayed" : "Bloo’s privacy tour is complete",
    count
      ? `Bloo protected ${count} detail${count === 1 ? "" : "s"}. Review the image before sharing.`
      : "Nothing obvious was detected. Review the image carefully and cover anything private by hand.",
    "success",
  );
}

async function runPrivacyTour(detections, session, { replay = false } = {}) {
  const stops = createTourStops(detections);
  isTouring = true;
  setWorkBusy(true, "tour");
  updateComparison(0);

  if (!stops.length) {
    await waitForTour(motionDuration(240), session.signal);
    if (session.isCurrent()) finishTour(detections, replay);
    return;
  }

  enterTourMode(stops[0].boundingBox);
  for (const stop of stops) {
    if (!session.isCurrent()) return;
    setBlooMood("scanning", `Heading to detail ${stop.index + 1} of ${stops.length}.`);
    setStatus(
      `Protecting detail ${stop.index + 1} of ${stops.length}`,
      "Bloo is travelling to the detected area and sealing it locally.",
      "scanning",
    );
    await animatePrivacyBubble(stop, session, !replay);
  }

  if (session.isCurrent()) finishTour(detections, replay);
}

async function scanImage() {
  if (!originalImage || isScanning || isTouring) return;
  if (!window.Tesseract) {
    setStatus(
      "OCR could not start",
      "Reconnect and refresh so the OCR library can download, or cover areas by hand.",
      "error",
    );
    setBlooMood("concerned", "I can’t reach the OCR tools. You can still cover private spots by hand.");
    downloadReady = true;
    elements.downloadButton.disabled = false;
    elements.drawingHint.hidden = false;
    return;
  }

  const session = tourSessions.start();
  isScanning = true;
  lastProgress = -1;
  setWorkBusy(true, "scan");
  setStatus(
    "Reading your screenshot",
    "The first scan can take longer while the OCR model downloads.",
    "scanning",
  );
  setBlooMood("scanning", "I’m focused on the text now. Your image is staying right here.");

  try {
    if (!ocrWorker) {
      const worker = await window.Tesseract.createWorker("eng", 1, {
        logger(message) {
          if (!session.isCurrent() || message.status !== "recognizing text") return;
          const progress = Math.round((message.progress || 0) * 100);
          if (progress >= lastProgress + 5 || progress === 100) {
            lastProgress = progress;
            setStatus("Reading your screenshot", `${progress}% complete`, "scanning");
            elements.blooNote.textContent = `Still looking… ${progress}% read.`;
          }
        },
      });
      if (!session.isCurrent()) {
        await worker.terminate();
        return;
      }
      ocrWorker = worker;
    }

    const result = await ocrWorker.recognize(createOcrSource(), {}, { blocks: true });
    if (!session.isCurrent()) return;
    const detections = buildDetections(
      result.data,
      normalizeTerms(elements.customTerms.value),
      elements.canvas.width,
      elements.canvas.height,
    );
    isScanning = false;
    await runPrivacyTour(detections, session);
  } catch (error) {
    if (!session.isCurrent() || error?.name === "AbortError") return;
    setStatus(
      "The scan did not finish",
      "Try once more, or drag over private areas yourself—the editor still works.",
      "error",
    );
    setBlooMood("concerned", "That scan stumbled. I’m sorry—manual covering still works.");
    downloadReady = true;
    elements.downloadButton.disabled = false;
    elements.drawingHint.hidden = false;
  } finally {
    if (session.isCurrent()) {
      tourSessions.complete(session);
      isScanning = false;
      isTouring = false;
      setWorkBusy(false);
      window.requestAnimationFrame(updateBlooAvoidance);
    }
  }
}

async function replayTour() {
  if (!tourCompleted || !tourDetections.length || isScanning || isTouring) return;
  const session = tourSessions.start();
  try {
    await runPrivacyTour(tourDetections, session, { replay: true });
  } catch (error) {
    if (error?.name !== "AbortError" && session.isCurrent()) {
      setStatus("Replay paused", "Your protected image is unchanged and ready to review.", "ready");
      setBlooMood("concerned", "The replay paused, but your protected image is unchanged.");
    }
  } finally {
    if (session.isCurrent()) {
      tourSessions.complete(session);
      isTouring = false;
      setWorkBusy(false);
      window.requestAnimationFrame(updateBlooAvoidance);
    }
  }
}

function canvasPoint(event) {
  const rect = elements.canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * elements.canvas.width,
    y: ((event.clientY - rect.top) / rect.height) * elements.canvas.height,
  };
}

function startDrawing(event) {
  if (!originalImage || isScanning || isTouring || event.button !== 0) return;
  updateComparison(0);
  keyboardRedaction = null;
  dragStart = canvasPoint(event);
  elements.canvas.setPointerCapture?.(event.pointerId);
}

function moveDrawing(event) {
  if (!dragStart) return;
  const point = canvasPoint(event);
  renderCanvas(createManualRedaction(dragStart, point, elements.canvas.width, elements.canvas.height));
}

function commitManualRedaction(box) {
  if (box.x1 - box.x0 <= 8 || box.y1 - box.y0 <= 8) return false;
  redactionBoxes.push(box);
  downloadReady = true;
  elements.downloadButton.disabled = false;
  elements.drawingHint.hidden = false;
  setStatus(
    "One additional area protected",
    "Good catch. Review the image again or download when it looks right.",
    "success",
  );
  setBlooMood("success", "Good catch — one additional area was protected!");
  renderReceipt();
  return true;
}

function finishDrawing(event) {
  if (!dragStart) return;
  const point = canvasPoint(event);
  const box = createManualRedaction(
    dragStart,
    point,
    elements.canvas.width,
    elements.canvas.height,
  );
  dragStart = null;
  commitManualRedaction(box);
  renderCanvas();
}

function cancelDrawing() {
  dragStart = null;
  renderCanvas();
}

function initialKeyboardRedaction() {
  const width = Math.max(40, elements.canvas.width * 0.22);
  const height = Math.max(24, elements.canvas.height * 0.09);
  const centerX = elements.canvas.width / 2;
  const centerY = elements.canvas.height / 2;
  return createManualRedaction(
    { x: centerX - width / 2, y: centerY - height / 2 },
    { x: centerX + width / 2, y: centerY + height / 2 },
    elements.canvas.width,
    elements.canvas.height,
  );
}

function focusKeyboardRedaction() {
  if (!originalImage || isScanning || isTouring) return;
  updateComparison(0);
  keyboardRedaction ||= initialKeyboardRedaction();
  renderCanvas(keyboardRedaction);
}

function moveKeyboardRedaction(event) {
  if (!originalImage || isScanning || isTouring) return;
  keyboardRedaction ||= initialKeyboardRedaction();
  const movement = event.shiftKey ? 24 : 8;
  const resize = event.shiftKey ? 16 : 6;
  let { x0, y0, x1, y1 } = keyboardRedaction;

  if (event.key === "ArrowLeft") [x0, x1] = [x0 - movement, x1 - movement];
  else if (event.key === "ArrowRight") [x0, x1] = [x0 + movement, x1 + movement];
  else if (event.key === "ArrowUp") [y0, y1] = [y0 - movement, y1 - movement];
  else if (event.key === "ArrowDown") [y0, y1] = [y0 + movement, y1 + movement];
  else if (["+", "="].includes(event.key)) [x0, y0, x1, y1] = [x0 - resize, y0 - resize, x1 + resize, y1 + resize];
  else if (["-", "_"].includes(event.key)) [x0, y0, x1, y1] = [x0 + resize, y0 + resize, x1 - resize, y1 - resize];
  else if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    commitManualRedaction({ ...keyboardRedaction, source: "manual" });
    keyboardRedaction = null;
    renderCanvas();
    return;
  } else if (event.key === "Escape") {
    keyboardRedaction = null;
    renderCanvas();
    return;
  } else {
    return;
  }

  event.preventDefault();
  keyboardRedaction = createManualRedaction(
    { x: x0, y: y0 },
    { x: x1, y: y1 },
    elements.canvas.width,
    elements.canvas.height,
  );
  renderCanvas(keyboardRedaction);
}

function blurKeyboardRedaction() {
  keyboardRedaction = null;
  if (!dragStart) renderCanvas();
}

function downloadImage() {
  if (!originalImage) return;
  renderCanvas();
  const link = document.createElement("a");
  link.download = `blur-buddy-protected-${Date.now()}.png`;
  link.href = elements.canvas.toDataURL("image/png");
  link.click();
  setStatus(
    "Protected copy downloaded",
    "Keep the original private, and review the new copy before sharing.",
    "success",
  );
  setBlooMood("success", "Your protected copy is ready. Nice work reviewing it before sharing!");
}

function resetApp() {
  stopActiveWork({ terminateOcr: true });
  originalImage = null;
  redactionBoxes = [];
  tourDetections = [];
  tourCompleted = false;
  downloadReady = false;
  dragStart = null;
  keyboardRedaction = null;
  elements.fileInput.value = "";
  elements.customTerms.value = "";
  elements.blurStrength.value = "16";
  elements.strengthValue.textContent = describeStrength(16);
  elements.editor.hidden = true;
  elements.dropZone.hidden = false;
  elements.workspace.dataset.state = "empty";
  elements.workspaceTitle.textContent = "Bring in a screenshot";
  elements.replayButton.hidden = true;
  elements.privacyReceipt.hidden = true;
  elements.safeShareCard.hidden = true;
  elements.drawingHint.hidden = true;
  context.clearRect(0, 0, elements.canvas.width, elements.canvas.height);
  originalContext.clearRect(0, 0, elements.originalCanvas.width, elements.originalCanvas.height);
  hideComparison();
  setWorkBusy(false);
  setDropFeedback();
  setBlooMood("idle", "Fresh desk, fresh start. Drop in a screenshot when you’re ready.");
  setStatus(
    "Ready when you are",
    "Bloo can check the text, then you can cover any extras by hand.",
    "ready",
  );
  window.requestAnimationFrame(() => {
    updateBlooAvoidance();
    elements.dropZone.focus();
  });
}

function updateStrength() {
  elements.strengthValue.textContent = describeStrength(elements.blurStrength.value);
  renderCanvas();
}

function updateComparison(value = Number(elements.comparisonSlider.value)) {
  const percentage = Math.max(0, Math.min(100, Number(value)));
  elements.comparisonSlider.value = String(percentage);
  const position = `${percentage}%`;
  elements.originalCanvas.style.setProperty("--comparison-position", position);
  elements.comparisonUi.style.setProperty("--comparison-position", position);
  elements.comparisonSlider.setAttribute(
    "aria-valuetext",
    `${Math.round(percentage)}% original, ${Math.round(100 - percentage)}% protected`,
  );
}

function showComparison() {
  elements.originalCanvas.hidden = false;
  elements.comparisonUi.hidden = false;
  updateComparison(50);
  window.requestAnimationFrame(syncOverlayGeometry);
}

function hideComparison() {
  elements.originalCanvas.hidden = true;
  elements.comparisonUi.hidden = true;
  updateComparison(0);
}

function syncOverlayGeometry() {
  if (!originalImage || elements.editor.hidden) return;
  const canvasRect = elements.canvas.getBoundingClientRect();
  const stageRect = elements.comparisonStage.getBoundingClientRect();
  const left = canvasRect.left - stageRect.left;
  const top = canvasRect.top - stageRect.top;
  for (const overlay of [elements.originalCanvas, elements.comparisonUi]) {
    overlay.style.left = `${left}px`;
    overlay.style.top = `${top}px`;
    overlay.style.width = `${canvasRect.width}px`;
    overlay.style.height = `${canvasRect.height}px`;
  }
  if (currentTourBox) {
    positionBubble(currentTourBox);
    positionBloo(currentTourBox, true);
  }
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
  if (elements.blooDock.classList.contains("is-touring")) return;
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
elements.replayButton.addEventListener("click", replayTour);
elements.downloadButton.addEventListener("click", downloadImage);
elements.finalDownloadButton.addEventListener("click", downloadImage);
elements.resetButton.addEventListener("click", resetApp);
elements.blurStrength.addEventListener("input", updateStrength);
elements.comparisonSlider.addEventListener("input", () => updateComparison());
elements.canvas.addEventListener("pointerdown", startDrawing);
elements.canvas.addEventListener("pointermove", moveDrawing);
elements.canvas.addEventListener("pointerup", finishDrawing);
elements.canvas.addEventListener("pointercancel", cancelDrawing);
elements.canvas.addEventListener("focus", focusKeyboardRedaction);
elements.canvas.addEventListener("keydown", moveKeyboardRedaction);
elements.canvas.addEventListener("blur", blurKeyboardRedaction);
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
window.addEventListener(
  "scroll",
  () => {
    window.requestAnimationFrame(() => {
      syncOverlayGeometry();
      updateBlooAvoidance();
    });
  },
  { passive: true },
);
window.addEventListener("resize", () =>
  window.requestAnimationFrame(() => {
    syncOverlayGeometry();
    updateBlooAvoidance();
  }),
);

if ("ResizeObserver" in window) {
  new ResizeObserver(() => window.requestAnimationFrame(syncOverlayGeometry)).observe(elements.canvas);
}

elements.strengthValue.textContent = describeStrength(elements.blurStrength.value);
window.requestAnimationFrame(updateBlooAvoidance);
