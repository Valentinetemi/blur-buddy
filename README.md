# BlurBuddy

**Share the screenshot. Keep the secrets.**

BlurBuddy is a browser-based screenshot privacy tool. It uses local OCR to find private-looking text, turns those detections into a guided tour with Bloo, and lets the user review, manually cover, compare, and download the protected image. Automatic detection is assistance, not a safety guarantee.

![BlurBuddy's blue screenshot privacy workspace with Bloo in the corner](./preview.png)

## What it does

- Runs Tesseract.js OCR in the browser
- Detects emails, phone numbers, IP addresses, web addresses, credential-like text, and user-entered custom terms
- Moves Bloo to real OCR bounding boxes and turns glossy privacy bubbles into pixelated redactions
- Replays the tour without rerunning OCR or changing the protected image
- Supports pointer and keyboard manual redaction, adjustable pixelation, before/after comparison, reset, and PNG download
- Shows a value-free privacy receipt and cautious review reminder
- Keeps Bloo playable with mouse, touch, and keyboard pet controls
- Supports reduced motion and a compact mobile layout

## Architecture

BlurBuddy is a static browser application. Screenshot processing, OCR results, redaction geometry, and downloads stay in the browser.

| Layer | Files | Responsibility |
| --- | --- | --- |
| Browser image pipeline | `app.js`, `security.js`, `tour.js` | Load the image, run OCR, detect patterns, retain local structured detections, animate the tour, pixelate, compare, reset, and download |
| Verification | `tests/`, `scripts/browser-smoke.mjs` | Unit, animation, interaction, failure, mobile, reduced-motion, and real-OCR checks |

### Local OCR and redaction flow

1. The browser decodes the selected image into a canvas.
2. Tesseract.js reads a fresh in-memory copy of the original image locally.
3. `security.js` converts OCR lines or words into `{ category, boundingBox, confidence, text }` detections. The detected text remains in browser memory only.
4. Bloo visits the actual OCR boxes after independent canvas-to-CSS scaling is calculated from `getBoundingClientRect()`.
5. Each visual privacy bubble becomes a real canvas pixelation. Manual redactions use the same protected-canvas render path.
6. Comparison uses a separate local original canvas. Download serializes only the protected canvas to PNG.
7. Reset cancels the active tour, terminates the OCR worker when necessary, and clears image state.

### Bloo’s Privacy Tour

Bloo enters a focused state while OCR runs, visits detections sequentially, reacts at each discovery, drops the redaction bubble, and celebrates after the tour. Replay reuses only the saved local detection boxes and does not rerun OCR or apply the redactions again. Outside a tour, Bloo returns to the user’s session-positioned pet mode.

The privacy receipt contains counts only and the completion state always reminds the user to review the image before sharing.

## Privacy model

BlurBuddy has no application backend or third-party speech service. Screenshots, canvas pixels, OCR text, detected values, custom terms, and redaction geometry remain in the browser. Tesseract.js and its English recognition data are fetched when needed, but the screenshot itself is processed locally.

Download uses the protected canvas only. Nothing is uploaded or stored by BlurBuddy.

## Local development

```bash
npm start
```

Then open [http://localhost:4173](http://localhost:4173).

Tesseract.js and its English recognition data are fetched on first scan, so that first scan needs an internet connection. The screenshot itself is still processed only in the browser.

## Testing

Run the unit suite plus the production build:

```bash
npm test
npm run build
```

For browser checks, start `npm start` in one terminal and run these in another:

```bash
npm run test:browser
npm run test:ocr
```

`test:browser` uses deterministic OCR and covers pet interaction, real detection coordinates, sequential animation, replay, comparison, receipt, manual pointer and keyboard redaction, reset, download, upload, mobile layout, reduced motion, and OCR failure. `test:ocr` loads Tesseract.js normally and verifies a real browser-local scan of the practice image.

## Project background

Useful security screenshots often contain private details, and careful manual cleanup is easy to forget. Bloo makes the review step visible and approachable without placing an LLM, remote image processor, database, or screenshot-upload service inside the privacy boundary. The open-source OCR choice keeps recognition inspectable and local.

## Safety note

Automatic detection can miss private information. Always review the protected image and add manual redactions before sharing.
