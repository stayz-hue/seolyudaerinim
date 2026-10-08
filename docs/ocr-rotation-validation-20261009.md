# ID OCR rotation validation — 2026-10-09 KST

## Change

Read all four orientations with sparse-text and block-text segmentation instead of stopping on the first plausible name. Use the Korean tessdata_best model with a separate cache namespace. Preserve the uploaded original for OCR while retaining the existing 1600 px submission copy; OCR canvases are capped at 2400 px on the longest edge. Provide Image-element decoding when createImageBitmap is unavailable or fails. Cancel stale jobs and free workers, bitmap/canvas resources and object URLs. Allow up to 180 seconds for recognition.

Do not guess date digits or the birth century. Handle OCR-collapsed masking marks only when all six date digits and the century digit are read exactly. Reject partial numeric suffixes, impossible dates, conflicting names/dates, and unrelated ancillary fields. An exact name line can corroborate an anchored name only within the same orientation. Suggestions still require user review; matching reads are not an accuracy probability.

## Verification

- 113 automated tests passed, including four-angle traversal, early false candidates, conflicting identity fields, stale uploads, original-vs-submission image separation, resource limits, cancellation and fallback decoding.
- Actual Tesseract.js 6.0.1 engine with WASM core 6.1.2, Korean best model: 2 synthetic ID layouts × 2 quality conditions × 4 rotations = 16 cases. Name, birth date and address were correct in all 16. The four dim license cases were rerun after the collapsed-mask fix; the other 12 already passed.
- Fixtures are explicitly fictional, rendered with Pretendard at 1200×760. The dim variant is resized to 900 px, blurred by 0.5 px, darkened to 65%, and JPEG-compressed at quality 70. They use three- and four-syllable Korean names and a masked fictional number.
- Chromium executed the production module with actual browser WASM workers, native bitmap decoding and Image-element fallback. A 3600 px rotated image was bounded and read correctly after the date extraction fix.
- Browser intake smoke test passed at 320, 390 and 736 px. Submission was intercepted locally; no live customer order was created.

## Limits

This is a small synthetic regression set, not a measured real-world accuracy rate. Real identity-card photos, glare, perspective distortion, worn print, uncommon names, HEIC decoding and physical iPhone/Safari behavior have not been measured here. CDN/model bytes were locally served during browser engine tests, so network download latency was not benchmarked.

Model source: https://tessdata.projectnaptha.com/4.0.0_best/kor.traineddata.gz
Model documentation: https://github.com/tesseract-ocr/tessdata_best
Engine documentation: https://github.com/naptha/tesseract.js/blob/master/docs/api.md
