import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const baseUrl = process.argv.find((argument) => /^https?:\/\//.test(argument)) || "http://127.0.0.1:4173";
const realOcr = process.argv.includes("--real-ocr");
const captureScreenshots = process.argv.includes("--screenshots");
const candidates = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);
const chromePath = candidates.find(existsSync);

if (!chromePath) {
  console.log("Browser smoke test skipped: Chrome/Chromium was not found.");
  process.exit(0);
}

const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--remote-debugging-pipe",
    "--user-data-dir=/tmp/blurbuddy-browser-smoke",
  ],
  { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] },
);

const commandPipe = chrome.stdio[3];
const responsePipe = chrome.stdio[4];
let nextId = 0;
let buffered = Buffer.alloc(0);
const pending = new Map();
const eventWaiters = [];

responsePipe.on("data", (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  let separator = buffered.indexOf(0);
  while (separator !== -1) {
    const packet = buffered.subarray(0, separator).toString();
    buffered = buffered.subarray(separator + 1);
    if (packet) {
      const message = JSON.parse(packet);
      if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      } else if (message.method) {
        for (const waiter of [...eventWaiters]) {
          if (waiter.method === message.method && (!waiter.sessionId || waiter.sessionId === message.sessionId)) {
            eventWaiters.splice(eventWaiters.indexOf(waiter), 1);
            waiter.resolve(message.params);
          }
        }
      }
    }
    separator = buffered.indexOf(0);
  }
});

function send(method, params = {}, sessionId) {
  const id = ++nextId;
  const message = { id, method, params };
  if (sessionId) message.sessionId = sessionId;
  commandPipe.write(`${JSON.stringify(message)}\0`);
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function waitForEvent(method, sessionId) {
  return new Promise((resolve) => eventWaiters.push({ method, sessionId, resolve }));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function poll(expression, sessionId, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await evaluate(expression, sessionId);
    if (value) return value;
    await delay(60);
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

async function evaluate(expression, sessionId) {
  const result = await send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result.value;
}

async function captureScreenshot(path, sessionId) {
  const { data } = await send(
    "Page.captureScreenshot",
    { format: "png", captureBeyondViewport: true },
    sessionId,
  );
  writeFileSync(path, data, "base64");
}

try {
  await send("Browser.getVersion");
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  await send("Network.enable", {}, sessionId);
  if (!realOcr) {
    await send("Network.setBlockedURLs", { urls: ["*cdn.jsdelivr.net/npm/tesseract.js*"] }, sessionId);
  }
  await send(
    "Emulation.setDeviceMetricsOverride",
    { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );
  await send(
    "Page.addScriptToEvaluateOnNewDocument",
    {
      source: `
        window.__downloads = 0;
        window.__recognizeCalls = 0;
        const originalAnchorClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {
          if (this.download) { window.__downloads += 1; return; }
          return originalAnchorClick.call(this);
        };
        ${realOcr ? "" : `window.Tesseract = {
          createWorker: async (_language, _count, options) => {
            options?.logger?.({ status: "recognizing text", progress: 0.5 });
            return {
              recognize: async () => {
                window.__recognizeCalls += 1;
                await new Promise((resolve) => setTimeout(resolve, 80));
                options?.logger?.({ status: "recognizing text", progress: 1 });
                return { data: { blocks: [{ paragraphs: [{ lines: [
                  { text: "Reporter: friend@example.com", confidence: 96, bbox: { x0: 52, y0: 210, x1: 410, y1: 248 }, words: [] },
                  { text: "Source IP: 192.168.10.44", confidence: 94, bbox: { x0: 52, y0: 338, x1: 390, y1: 376 }, words: [] }
                ] }] }] } };
              },
              terminate: async () => {}
            };
          }
        };`}
      `,
    },
    sessionId,
  );

  const loaded = waitForEvent("Page.loadEventFired", sessionId);
  await send("Page.navigate", { url: baseUrl }, sessionId);
  await loaded;
  await poll("document.readyState === 'complete' && typeof document.querySelector('#sampleButton')?.click === 'function'", sessionId);

  if (realOcr) {
    await send(
      "Emulation.setEmulatedMedia",
      { features: [{ name: "prefers-reduced-motion", value: "reduce" }] },
      sessionId,
    );
    await evaluate("document.querySelector('#sampleButton').click(); true", sessionId);
    await poll("!document.querySelector('#editor').hidden && document.querySelector('#imageCanvas').width === 1200", sessionId);
    assert.equal(await evaluate("typeof window.Tesseract", sessionId), "object");
    await evaluate("document.querySelector('#scanButton').click(); true", sessionId);
    await poll("!document.querySelector('#safeShareCard').hidden", sessionId, 180000);
    const result = await evaluate(
      `(() => ({
        tone: document.querySelector('#statusCard').dataset.tone,
        receipt: document.querySelector('#privacyReceipt').innerText,
        downloadEnabled: !document.querySelector('#downloadButton').disabled
      }))()`,
      sessionId,
    );
    assert.equal(result.tone, "success");
    assert.match(result.receipt, /private details? protected/);
    assert.equal(result.downloadEnabled, true);
    const summary = result.receipt.split("\n").find((line) => line.includes("private detail"));
    console.log(`Real browser-local Tesseract scan passed. ${summary}`);
  } else {
  await evaluate("document.querySelector('#sampleButton').click(); true", sessionId);
  await poll("!document.querySelector('#editor').hidden && document.querySelector('#imageCanvas').width === 1200", sessionId);
  assert.equal(await evaluate("document.querySelector('#imageCanvas').tabIndex", sessionId), 0);
  await evaluate("document.querySelector('#scanButton').click(); document.querySelector('#scanButton').click(); true", sessionId);
  await poll("document.querySelector('#tourBubble').classList.contains('is-dropping')", sessionId, 4000);

  const touring = await evaluate(
    `(() => {
      const bloo = document.querySelector('#blooDock');
      const bubble = document.querySelector('#tourBubble');
      return {
        parent: bloo.parentElement.className,
        blooLeft: parseFloat(bloo.style.left),
        blooTop: parseFloat(bloo.style.top),
        bubbleWidth: parseFloat(bubble.style.width),
        bubbleHeight: parseFloat(bubble.style.height)
      };
    })()`,
    sessionId,
  );
  assert.match(touring.parent, /canvas-shell/);
  assert.ok(Number.isFinite(touring.blooLeft) && Number.isFinite(touring.blooTop));
  assert.ok(touring.bubbleWidth > 0 && touring.bubbleHeight > 0);
  if (captureScreenshots) await captureScreenshot("/tmp/blurbuddy-tour-action.png", sessionId);

  await poll("!document.querySelector('#safeShareCard').hidden", sessionId, 8000);
  const completed = await evaluate(
    `(() => ({
      calls: window.__recognizeCalls,
      receipt: document.querySelector('#privacyReceipt').innerText,
      replayVisible: !document.querySelector('#replayButton').hidden,
      comparisonVisible: !document.querySelector('#comparisonUi').hidden,
      safeText: document.querySelector('#safeShareCard p').textContent.trim(),
      downloadEnabled: !document.querySelector('#downloadButton').disabled,
      blooMood: document.querySelector('#blooDock').dataset.mood
    }))()`,
    sessionId,
  );
  assert.equal(completed.calls, 1);
  assert.match(completed.receipt, /2 private details protected/);
  assert.match(completed.receipt, /1 email/);
  assert.match(completed.receipt, /1 private IP/);
  assert.equal(completed.receipt.includes("friend@example.com"), false);
  assert.equal(completed.receipt.includes("192.168.10.44"), false);
  assert.equal(completed.replayVisible, true);
  assert.equal(completed.comparisonVisible, true);
  assert.equal(
    completed.safeText,
    "Bloo protected the details it recognised. Review the image before sharing.",
  );
  assert.equal(completed.downloadEnabled, true);
  assert.equal(completed.blooMood, "success");
  if (captureScreenshots) await captureScreenshot("/tmp/blurbuddy-tour-desktop.png", sessionId);

  await evaluate("document.querySelector('#comparisonSlider').value = 27; document.querySelector('#comparisonSlider').dispatchEvent(new Event('input', { bubbles: true })); true", sessionId);
  assert.equal(
    await evaluate("document.querySelector('#comparisonUi').style.getPropertyValue('--comparison-position')", sessionId),
    "27%",
  );

  await evaluate(
    `(() => {
      const canvas = document.querySelector('#imageCanvas');
      canvas.setPointerCapture = () => {};
      const rect = canvas.getBoundingClientRect();
      const send = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, {
        bubbles: true, pointerId: 4, button: 0, clientX: rect.left + x, clientY: rect.top + y
      }));
      send('pointerdown', 40, 40);
      send('pointermove', 130, 90);
      send('pointerup', 130, 90);
      return true;
    })()`,
    sessionId,
  );
  const manualReceipt = await evaluate("document.querySelector('#privacyReceipt').innerText", sessionId);
  assert.match(manualReceipt, /3 private details protected/);
  assert.match(manualReceipt, /1 manual area/);
  assert.match(await evaluate("document.querySelector('#blooNote').textContent", sessionId), /one additional area/i);

  await evaluate(
    `(() => {
      const canvas = document.querySelector('#imageCanvas');
      canvas.focus();
      canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()`,
    sessionId,
  );
  const keyboardReceipt = await evaluate("document.querySelector('#privacyReceipt').innerText", sessionId);
  assert.match(keyboardReceipt, /4 private details protected/);
  assert.match(keyboardReceipt, /2 manual areas/);

  await evaluate("document.querySelector('#downloadButton').click(); true", sessionId);
  assert.equal(await evaluate("window.__downloads", sessionId), 1);

  const beforeReplay = await evaluate("document.querySelector('#imageCanvas').toDataURL()", sessionId);
  await evaluate("document.querySelector('#replayButton').click(); true", sessionId);
  assert.equal(await evaluate("document.querySelector('#downloadButton').disabled", sessionId), true);
  await poll("document.querySelector('#statusTitle').textContent === 'Privacy tour replayed'", sessionId, 8000);
  const afterReplay = await evaluate("document.querySelector('#imageCanvas').toDataURL()", sessionId);
  assert.equal(afterReplay, beforeReplay);
  await evaluate("document.querySelector('#replayButton').click(); true", sessionId);
  await delay(420);
  await evaluate("document.querySelector('#resetButton').click(); true", sessionId);
  const resetState = await evaluate(
    `(() => ({
      editorHidden: document.querySelector('#editor').hidden,
      dropVisible: !document.querySelector('#dropZone').hidden,
      bubbleActive: document.querySelector('#tourBubble').className,
      blooParent: document.querySelector('#blooDock').parentElement.tagName,
      busy: document.querySelector('#scanButton').getAttribute('aria-busy')
    }))()`,
    sessionId,
  );
  assert.equal(resetState.editorHidden, true);
  assert.equal(resetState.dropVisible, true);
  assert.equal(resetState.bubbleActive, "privacy-bubble");
  assert.equal(resetState.blooParent, "BODY");
  assert.equal(resetState.busy, "false");
  assert.ok(beforeReplay.startsWith("data:image/png;base64,"));

  await evaluate(
    `window.Tesseract = { createWorker: async () => { throw new Error('expected OCR failure'); } };
     document.querySelector('#sampleButton').click(); true`,
    sessionId,
  );
  await poll("!document.querySelector('#editor').hidden", sessionId);
  await evaluate("document.querySelector('#scanButton').click(); true", sessionId);
  await poll("document.querySelector('#statusCard').dataset.tone === 'error'", sessionId);
  assert.equal(await evaluate("document.querySelector('#blooDock').dataset.mood", sessionId), "concerned");

  await evaluate(
    `document.querySelector('#resetButton').click();
     (async () => {
       const blob = await fetch('/preview.png').then((response) => response.blob());
       const transfer = new DataTransfer();
       transfer.items.add(new File([blob], 'preview.png', { type: 'image/png' }));
       const input = document.querySelector('#fileInput');
       input.files = transfer.files;
       input.dispatchEvent(new Event('change', { bubbles: true }));
     })(); true`,
    sessionId,
  );
  await poll("!document.querySelector('#editor').hidden && document.querySelector('#imageCanvas').width > 0", sessionId);

  await send(
    "Emulation.setDeviceMetricsOverride",
    { width: 390, height: 844, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );
  await delay(200);
  const mobile = await evaluate(
    `(() => ({
      innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      blooWidth: parseFloat(getComputedStyle(document.querySelector('#blooButton')).width),
      canvasWidth: document.querySelector('#imageCanvas').getBoundingClientRect().width,
      shellWidth: document.querySelector('.canvas-shell').getBoundingClientRect().width
    }))()`,
    sessionId,
  );
  assert.ok(mobile.scrollWidth <= mobile.innerWidth + 1);
  assert.ok(mobile.blooWidth <= 54, JSON.stringify(mobile));
  assert.ok(mobile.canvasWidth <= mobile.shellWidth);
  if (captureScreenshots) await captureScreenshot("/tmp/blurbuddy-tour-mobile.png", sessionId);

  await send(
    "Emulation.setEmulatedMedia",
    { features: [{ name: "prefers-reduced-motion", value: "reduce" }] },
    sessionId,
  );
  const reduced = await evaluate(
    `(() => ({
      matches: matchMedia('(prefers-reduced-motion: reduce)').matches,
      duration: getComputedStyle(document.querySelector('#blooButton')).animationDuration
    }))()`,
    sessionId,
  );
  assert.equal(reduced.matches, true);
  assert.ok(parseFloat(reduced.duration) <= 0.001, JSON.stringify(reduced));

  console.log("Browser smoke test passed: sample, tour, replay, reset cancellation, comparison, receipt, pointer/keyboard redaction, download, upload, mobile, reduced motion, and OCR failure.");
  }
} finally {
  chrome.kill("SIGTERM");
}
