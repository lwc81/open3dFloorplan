import type { BackgroundImage, Point } from '$lib/models/types';

export interface BlueprintCalibrationCandidate {
  points: [Point, Point];
  distanceCm: number | null;
}

export interface BackgroundSnapCandidate {
  point: Point;
  kind: 'corner' | 'endpoint' | 'intersection';
  score: number;
}

type Axis = 'horizontal' | 'vertical';

type OcrBBox = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

type OcrWordLike = {
  text?: string;
  confidence?: number;
  bbox?: OcrBBox;
};

type TesseractResult = {
  data?: {
    text?: string;
    words?: OcrWordLike[];
  };
};

type OcrWorker = {
  setParameters: (params: Record<string, string>) => Promise<unknown>;
  recognize: (image: HTMLCanvasElement, options?: Record<string, unknown>) => Promise<TesseractResult>;
};

type CreateWorker = (
  langs?: string,
  oem?: number,
  options?: { logger?: (message: unknown) => void }
) => Promise<OcrWorker>;

type BinaryImage = {
  width: number;
  height: number;
  data: Uint8Array;
};

type SegmentRun = {
  start: number;
  end: number;
};

type LineCandidate = {
  axis: Axis;
  start: Point;
  end: Point;
  score: number;
};

type MeasurementCandidate = {
  valueCm: number;
  score: number;
};

let workerPromise: Promise<OcrWorker> | null = null;
const binaryImageCache = new Map<string, BinaryImage>();

function getImageDimensions(image: HTMLImageElement) {
  return {
    width: image.naturalWidth || image.width,
    height: image.naturalHeight || image.height,
  };
}

async function getOcrWorker(): Promise<OcrWorker> {
  if (!workerPromise) {
    workerPromise = import('tesseract.js').then(async (module) => {
      const mod = module as unknown as {
        createWorker?: CreateWorker;
        default?: { createWorker?: CreateWorker };
      };
      const createWorker = mod.createWorker ?? mod.default?.createWorker;
      if (!createWorker) {
        throw new Error('tesseract.js createWorker() is not available');
      }
      const worker = await createWorker('eng', 1, { logger: () => undefined });
      await worker.setParameters({
        tessedit_pageseg_mode: '11',
        tessedit_char_whitelist: "0123456789.,mMcCfFtTiInN'\"",
        preserve_interword_spaces: '1',
        user_defined_dpi: '300',
      });
      return worker;
    });
  }
  return workerPromise;
}

function worldToImagePoint(point: Point, backgroundImage: BackgroundImage, image: HTMLImageElement): Point | null {
  const { width, height } = getImageDimensions(image);
  if (!backgroundImage.scale || backgroundImage.scale <= 0 || !width || !height) return null;

  const dx = point.x - backgroundImage.position.x;
  const dy = point.y - backgroundImage.position.y;
  const angle = -backgroundImage.rotation * Math.PI / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const localX = dx * cos - dy * sin;
  const localY = dx * sin + dy * cos;

  return {
    x: localX / backgroundImage.scale + width / 2,
    y: localY / backgroundImage.scale + height / 2,
  };
}

function imageToWorldPoint(point: Point, backgroundImage: BackgroundImage, image: HTMLImageElement): Point | null {
  const { width, height } = getImageDimensions(image);
  if (!backgroundImage.scale || backgroundImage.scale <= 0 || !width || !height) return null;

  const localX = (point.x - width / 2) * backgroundImage.scale;
  const localY = (point.y - height / 2) * backgroundImage.scale;
  const angle = backgroundImage.rotation * Math.PI / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  return {
    x: backgroundImage.position.x + localX * cos - localY * sin,
    y: backgroundImage.position.y + localX * sin + localY * cos,
  };
}

function normalizeMeasurementText(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/o/g, '0')
    .replace(/,/g, '.')
    .replace(/\s+/g, '')
    .replace(/(\d)\.(?=\d{3}(?:\D|$))/g, '$1');
}

function parseMeasurementCandidateCm(raw: string): number | null {
  const normalized = normalizeMeasurementText(raw);
  const match = normalized.match(/(\d+(?:\.\d+)?)(mm|cm|m|ft|in|"|')?$/);
  if (!match) return null;

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;

  switch (match[2]) {
    case 'mm':
      return value / 10;
    case 'cm':
      return value;
    case 'm':
      return value * 100;
    case 'ft':
    case "'":
      return value * 30.48;
    case 'in':
    case '"':
      return value * 2.54;
    default: {
      const digitsOnly = match[1].replace(/\D/g, '');
      if (digitsOnly.length >= 4) return value / 10;
      if (digitsOnly.length === 3 && Number(digitsOnly) >= 500) return value / 10;
      return value;
    }
  }
}

function scoreMeasurementToken(raw: string): number {
  const normalized = normalizeMeasurementText(raw);
  const digitCount = normalized.replace(/\D/g, '').length;
  let score = digitCount * 4;
  if (digitCount >= 4) score += 10;
  if (/(mm|cm|m|ft|in|"|')$/.test(normalized)) score += 12;
  return score;
}

function pickBestWordCandidate(words: OcrWordLike[], targetX: number, targetY: number): MeasurementCandidate | null {
  let best: MeasurementCandidate | null = null;

  for (const word of words) {
    const text = word.text?.trim();
    if (!text) continue;

    const valueCm = parseMeasurementCandidateCm(text);
    if (valueCm === null) continue;

    let score = Number(word.confidence ?? 0) + scoreMeasurementToken(text);
    if (word.bbox) {
      const centerX = (word.bbox.x0 + word.bbox.x1) / 2;
      const centerY = (word.bbox.y0 + word.bbox.y1) / 2;
      score -= Math.hypot(centerX - targetX, centerY - targetY) * 0.08;
    }

    if (!best || score > best.score) {
      best = { valueCm, score };
    }
  }

  return best;
}

function pickTextFallbackCandidate(text: string): MeasurementCandidate | null {
  const matches = text.match(/\d[\d\s.,]*(?:mm|cm|m|ft|in|"|')?/gi) ?? [];
  let best: MeasurementCandidate | null = null;

  for (const match of matches) {
    const valueCm = parseMeasurementCandidateCm(match);
    if (valueCm === null) continue;

    const score = scoreMeasurementToken(match) + normalizeMeasurementText(match).length;
    if (!best || score > best.score) {
      best = { valueCm, score };
    }
  }

  return best;
}

function cloneCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.drawImage(source, 0, 0);
  return canvas;
}

function createProcessedCanvas(source: HTMLCanvasElement, threshold: number | null, invert = false): HTMLCanvasElement {
  const canvas = cloneCanvas(source);
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { data } = imageData;
  for (let i = 0; i < data.length; i += 4) {
    const luminance = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const contrasted = Math.max(0, Math.min(255, (luminance - 128) * 2 + 128));
    let value = threshold === null ? contrasted : (contrasted > threshold ? 255 : 0);
    if (invert) value = 255 - value;
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
    data[i + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

function rotateCanvas90(source: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = source.height;
  canvas.height = source.width;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(source, -source.width / 2, -source.height / 2);
  return canvas;
}

function buildLineCropCanvas(image: HTMLImageElement, start: Point, end: Point): HTMLCanvasElement | null {
  const lineLength = Math.hypot(end.x - start.x, end.y - start.y);
  if (lineLength < 8) return null;

  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const midX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2;
  const alongPadding = Math.max(48, Math.min(180, lineLength * 0.12));
  const perpendicularPadding = Math.max(96, Math.min(220, lineLength * 0.28));
  const upscale = lineLength < 220 ? 4 : lineLength < 600 ? 3 : 2;

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(96, Math.round((lineLength + alongPadding * 2) * upscale));
  canvas.height = Math.max(96, Math.round(perpendicularPadding * 2 * upscale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = false;
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.scale(upscale, upscale);
  ctx.rotate(-angle);
  ctx.drawImage(image, -midX, -midY);
  return canvas;
}

function getBinaryImage(image: HTMLImageElement): BinaryImage {
  const { width, height } = getImageDimensions(image);
  const key = `${image.currentSrc || image.src}|${width}x${height}`;
  const cached = binaryImageCache.get(key);
  if (cached) return cached;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    const empty = { width, height, data: new Uint8Array(width * height) };
    binaryImageCache.set(key, empty);
    return empty;
  }

  ctx.drawImage(image, 0, 0, width, height);
  const imageData = ctx.getImageData(0, 0, width, height);
  const binary = new Uint8Array(width * height);
  for (let i = 0; i < binary.length; i++) {
    const offset = i * 4;
    const luminance = 0.299 * imageData.data[offset] + 0.587 * imageData.data[offset + 1] + 0.114 * imageData.data[offset + 2];
    binary[i] = imageData.data[offset + 3] > 32 && luminance < 216 ? 1 : 0;
  }

  const result = { width, height, data: binary };
  binaryImageCache.set(key, result);
  return result;
}

function directionalSupport(binary: BinaryImage, x: number, y: number, dx: number, dy: number, maxLen = 10): number {
  let support = 0;
  for (let step = 1; step <= maxLen; step++) {
    const px = x + dx * step;
    const py = y + dy * step;
    const dark = dx !== 0
      ? hasDarkOnHorizontal(binary, px, py)
      : hasDarkOnVertical(binary, px, py);
    if (!dark) break;
    support = step;
  }
  return support;
}

function evaluateRawBackgroundSnapCandidate(
  binary: BinaryImage,
  x: number,
  y: number,
  distanceOrigin?: Point
): { imagePoint: Point; kind: BackgroundSnapCandidate['kind']; score: number } | null {
  if (!isDark(binary, x, y)) return null;

  const left = directionalSupport(binary, x, y, -1, 0);
  const right = directionalSupport(binary, x, y, 1, 0);
  const up = directionalSupport(binary, x, y, 0, -1);
  const down = directionalSupport(binary, x, y, 0, 1);

  const horizontalSides = Number(left >= 4) + Number(right >= 4);
  const verticalSides = Number(up >= 4) + Number(down >= 4);
  const totalSides = horizontalSides + verticalSides;
  if (totalSides === 0) return null;

  let kind: BackgroundSnapCandidate['kind'] | null = null;
  if (horizontalSides > 0 && verticalSides > 0) {
    kind = totalSides >= 3 ? 'intersection' : 'corner';
  } else if (totalSides === 1) {
    kind = 'endpoint';
  }
  if (!kind) return null;

  const lineStrength = left + right + up + down;
  const distancePenalty = distanceOrigin ? Math.hypot(distanceOrigin.x - x, distanceOrigin.y - y) * 1.5 : 0;
  const kindBonus = kind === 'intersection' ? 18 : kind === 'corner' ? 12 : 6;
  const score = lineStrength + kindBonus - distancePenalty;
  if (score <= 0) return null;

  return { imagePoint: { x, y }, kind, score };
}

function buildRawBackgroundSnapCandidates(binary: BinaryImage, center: Point, radiusPx: number) {
  const raw: Array<{ imagePoint: Point; kind: BackgroundSnapCandidate['kind']; score: number }> = [];
  const minX = Math.max(0, Math.floor(center.x - radiusPx));
  const maxX = Math.min(binary.width - 1, Math.ceil(center.x + radiusPx));
  const minY = Math.max(0, Math.floor(center.y - radiusPx));
  const maxY = Math.min(binary.height - 1, Math.ceil(center.y + radiusPx));

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const candidate = evaluateRawBackgroundSnapCandidate(binary, x, y, center);
      if (candidate) raw.push(candidate);
    }
  }

  raw.sort((a, b) => b.score - a.score);
  return raw;
}

function clusterBackgroundSnapCandidates(
  raw: Array<{ imagePoint: Point; kind: BackgroundSnapCandidate['kind']; score: number }>,
  backgroundImage: BackgroundImage,
  image: HTMLImageElement,
  limit: number
): BackgroundSnapCandidate[] {
  const clustered: Array<{ imagePoint: Point; kind: BackgroundSnapCandidate['kind']; score: number }> = [];

  for (const candidate of raw) {
    const existing = clustered.find((item) => Math.hypot(item.imagePoint.x - candidate.imagePoint.x, item.imagePoint.y - candidate.imagePoint.y) <= 4);
    if (existing) continue;
    clustered.push(candidate);
    if (clustered.length >= limit) break;
  }

  const result: BackgroundSnapCandidate[] = [];
  for (const candidate of clustered) {
    const worldPoint = imageToWorldPoint(candidate.imagePoint, backgroundImage, image);
    if (!worldPoint) continue;
    result.push({
      point: worldPoint,
      kind: candidate.kind,
      score: candidate.score,
    });
  }
  return result;
}

export function detectBackgroundSnapCandidatesNearPoint({
  image,
  backgroundImage,
  point,
  worldRadius,
  limit = 8,
}: {
  image: HTMLImageElement;
  backgroundImage: BackgroundImage;
  point: Point;
  worldRadius: number;
  limit?: number;
}): BackgroundSnapCandidate[] {
  const imagePoint = worldToImagePoint(point, backgroundImage, image);
  if (!imagePoint) return [];

  const binary = getBinaryImage(image);
  const radiusPx = Math.max(12, Math.min(64, Math.round(worldRadius / Math.max(backgroundImage.scale, 0.001))));
  const raw = buildRawBackgroundSnapCandidates(binary, imagePoint, radiusPx);
  return clusterBackgroundSnapCandidates(raw, backgroundImage, image, limit);
}

export function detectBackgroundSnapCandidatesForImage({
  image,
  backgroundImage,
  limit = 400,
  sampleStep,
}: {
  image: HTMLImageElement;
  backgroundImage: BackgroundImage;
  limit?: number;
  sampleStep?: number;
}): BackgroundSnapCandidate[] {
  const binary = getBinaryImage(image);
  const raw: Array<{ imagePoint: Point; kind: BackgroundSnapCandidate['kind']; score: number }> = [];
  const step = sampleStep ?? Math.max(4, Math.round(Math.max(binary.width, binary.height) / 600));
  const margin = 8;

  for (let y = margin; y < binary.height - margin; y += step) {
    for (let x = margin; x < binary.width - margin; x += step) {
      const candidate = evaluateRawBackgroundSnapCandidate(binary, x, y);
      if (candidate) raw.push(candidate);
    }
  }

  raw.sort((a, b) => b.score - a.score);
  return clusterBackgroundSnapCandidates(raw, backgroundImage, image, limit);
}

function isDark(binary: BinaryImage, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= binary.width || y >= binary.height) return false;
  return binary.data[y * binary.width + x] === 1;
}

function hasDarkOnHorizontal(binary: BinaryImage, x: number, y: number): boolean {
  return isDark(binary, x, y - 1) || isDark(binary, x, y) || isDark(binary, x, y + 1);
}

function hasDarkOnVertical(binary: BinaryImage, x: number, y: number): boolean {
  return isDark(binary, x - 1, y) || isDark(binary, x, y) || isDark(binary, x + 1, y);
}

function scanHorizontalRun(binary: BinaryImage, y: number, preferredX: number, maxGap = 40): SegmentRun | null {
  let runStart = -1;
  let lastDark = -1;
  let gap = 0;
  let best: { run: SegmentRun; score: number } | null = null;

  for (let x = 0; x < binary.width; x++) {
    const dark = hasDarkOnHorizontal(binary, x, y);
    if (dark) {
      if (runStart < 0) runStart = x;
      lastDark = x;
      gap = 0;
      continue;
    }

    if (runStart >= 0 && gap < maxGap) {
      gap += 1;
      continue;
    }

    if (runStart >= 0 && lastDark >= runStart) {
      const length = lastDark - runStart;
      if (length >= 60) {
        const distance = preferredX < runStart ? runStart - preferredX : preferredX > lastDark ? preferredX - lastDark : 0;
        const score = length - distance * 2;
        if (!best || score > best.score) {
          best = { run: { start: runStart, end: lastDark }, score };
        }
      }
    }

    runStart = -1;
    lastDark = -1;
    gap = 0;
  }

  if (runStart >= 0 && lastDark >= runStart) {
    const length = lastDark - runStart;
    if (length >= 60) {
      const distance = preferredX < runStart ? runStart - preferredX : preferredX > lastDark ? preferredX - lastDark : 0;
      const score = length - distance * 2;
      if (!best || score > best.score) {
        best = { run: { start: runStart, end: lastDark }, score };
      }
    }
  }

  return best?.run ?? null;
}

function scanVerticalRun(binary: BinaryImage, x: number, preferredY: number, maxGap = 40): SegmentRun | null {
  let runStart = -1;
  let lastDark = -1;
  let gap = 0;
  let best: { run: SegmentRun; score: number } | null = null;

  for (let y = 0; y < binary.height; y++) {
    const dark = hasDarkOnVertical(binary, x, y);
    if (dark) {
      if (runStart < 0) runStart = y;
      lastDark = y;
      gap = 0;
      continue;
    }

    if (runStart >= 0 && gap < maxGap) {
      gap += 1;
      continue;
    }

    if (runStart >= 0 && lastDark >= runStart) {
      const length = lastDark - runStart;
      if (length >= 60) {
        const distance = preferredY < runStart ? runStart - preferredY : preferredY > lastDark ? preferredY - lastDark : 0;
        const score = length - distance * 2;
        if (!best || score > best.score) {
          best = { run: { start: runStart, end: lastDark }, score };
        }
      }
    }

    runStart = -1;
    lastDark = -1;
    gap = 0;
  }

  if (runStart >= 0 && lastDark >= runStart) {
    const length = lastDark - runStart;
    if (length >= 60) {
      const distance = preferredY < runStart ? runStart - preferredY : preferredY > lastDark ? preferredY - lastDark : 0;
      const score = length - distance * 2;
      if (!best || score > best.score) {
        best = { run: { start: runStart, end: lastDark }, score };
      }
    }
  }

  return best?.run ?? null;
}

function countVerticalSupport(binary: BinaryImage, x: number, y: number, radius = 14): number {
  let count = 0;
  for (let yy = y - radius; yy <= y + radius; yy++) {
    if (hasDarkOnVertical(binary, x, yy)) count += 1;
  }
  return count;
}

function countHorizontalSupport(binary: BinaryImage, x: number, y: number, radius = 14): number {
  let count = 0;
  for (let xx = x - radius; xx <= x + radius; xx++) {
    if (hasDarkOnHorizontal(binary, xx, y)) count += 1;
  }
  return count;
}

function refineHorizontalSegment(binary: BinaryImage, y: number, preferredX: number, run: SegmentRun): SegmentRun {
  let leftMarker: number | null = null;
  let rightMarker: number | null = null;

  for (let x = Math.max(run.start + 3, preferredX - 4); x >= run.start + 3; x--) {
    if (countVerticalSupport(binary, x, y) >= 4) {
      leftMarker = x;
      break;
    }
  }
  for (let x = Math.min(run.end - 3, preferredX + 4); x <= run.end - 3; x++) {
    if (countVerticalSupport(binary, x, y) >= 4) {
      rightMarker = x;
      break;
    }
  }

  if (leftMarker !== null && rightMarker !== null && rightMarker - leftMarker >= 40) {
    return { start: leftMarker, end: rightMarker };
  }
  return run;
}

function refineVerticalSegment(binary: BinaryImage, x: number, preferredY: number, run: SegmentRun): SegmentRun {
  let topMarker: number | null = null;
  let bottomMarker: number | null = null;

  for (let y = Math.max(run.start + 3, preferredY - 4); y >= run.start + 3; y--) {
    if (countHorizontalSupport(binary, x, y) >= 4) {
      topMarker = y;
      break;
    }
  }
  for (let y = Math.min(run.end - 3, preferredY + 4); y <= run.end - 3; y++) {
    if (countHorizontalSupport(binary, x, y) >= 4) {
      bottomMarker = y;
      break;
    }
  }

  if (topMarker !== null && bottomMarker !== null && bottomMarker - topMarker >= 40) {
    return { start: topMarker, end: bottomMarker };
  }
  return run;
}

function detectLineNearPoint(binary: BinaryImage, point: Point): LineCandidate | null {
  const clickX = Math.round(point.x);
  const clickY = Math.round(point.y);
  let best: LineCandidate | null = null;

  for (let y = Math.max(0, clickY - 70); y <= Math.min(binary.height - 1, clickY + 70); y++) {
    const run = scanHorizontalRun(binary, y, clickX);
    if (!run) continue;
    const refined = refineHorizontalSegment(binary, y, clickX, run);
    const length = refined.end - refined.start;
    const distanceToRun = clickX < refined.start ? refined.start - clickX : clickX > refined.end ? clickX - refined.end : 0;
    const score = length - Math.abs(y - clickY) * 14 - distanceToRun * 2;
    if (!best || score > best.score) {
      best = {
        axis: 'horizontal',
        start: { x: refined.start, y },
        end: { x: refined.end, y },
        score,
      };
    }
  }

  for (let x = Math.max(0, clickX - 70); x <= Math.min(binary.width - 1, clickX + 70); x++) {
    const run = scanVerticalRun(binary, x, clickY);
    if (!run) continue;
    const refined = refineVerticalSegment(binary, x, clickY, run);
    const length = refined.end - refined.start;
    const distanceToRun = clickY < refined.start ? refined.start - clickY : clickY > refined.end ? clickY - refined.end : 0;
    const score = length - Math.abs(x - clickX) * 14 - distanceToRun * 2;
    if (!best || score > best.score) {
      best = {
        axis: 'vertical',
        start: { x, y: refined.start },
        end: { x, y: refined.end },
        score,
      };
    }
  }

  return best && best.score >= 40 ? best : null;
}

async function recognizeMeasurementFromLine(image: HTMLImageElement, start: Point, end: Point): Promise<number | null> {
  const crop = buildLineCropCanvas(image, start, end);
  if (!crop) return null;

  const worker = await getOcrWorker();
  const variants = [
    createProcessedCanvas(crop, null),
    createProcessedCanvas(crop, 208),
    rotateCanvas90(createProcessedCanvas(crop, null)),
    rotateCanvas90(createProcessedCanvas(crop, 208)),
  ];

  let best: MeasurementCandidate | null = null;
  for (const variant of variants) {
    const result = await worker.recognize(variant, { rotateAuto: false });
    const targetX = variant.width / 2;
    const targetY = variant.height / 2;
    const candidate = pickBestWordCandidate(result.data?.words ?? [], targetX, targetY)
      ?? pickTextFallbackCandidate(result.data?.text ?? '');
    if (candidate && (!best || candidate.score > best.score)) {
      best = candidate;
    }
  }

  return best?.valueCm ?? null;
}

export async function detectBlueprintDistanceCm({
  image,
  backgroundImage,
  points,
}: {
  image: HTMLImageElement;
  backgroundImage: BackgroundImage;
  points: [Point, Point];
}): Promise<number | null> {
  const start = worldToImagePoint(points[0], backgroundImage, image);
  const end = worldToImagePoint(points[1], backgroundImage, image);
  if (!start || !end) return null;

  return recognizeMeasurementFromLine(image, start, end);
}

export async function detectBlueprintCalibrationFromClick({
  image,
  backgroundImage,
  point,
}: {
  image: HTMLImageElement;
  backgroundImage: BackgroundImage;
  point: Point;
}): Promise<BlueprintCalibrationCandidate | null> {
  const imagePoint = worldToImagePoint(point, backgroundImage, image);
  if (!imagePoint) return null;

  const binary = getBinaryImage(image);
  const line = detectLineNearPoint(binary, imagePoint);
  if (!line) return null;

  const worldStart = imageToWorldPoint(line.start, backgroundImage, image);
  const worldEnd = imageToWorldPoint(line.end, backgroundImage, image);
  if (!worldStart || !worldEnd) return null;

  return {
    points: [worldStart, worldEnd],
    distanceCm: await recognizeMeasurementFromLine(image, line.start, line.end),
  };
}