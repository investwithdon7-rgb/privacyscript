/**
 * Face detection for photos (HIPAA identifier 17: full-face photographs).
 *
 * UltraFace RFB-320 (MIT; ONNX Model Zoo export, Apache-2.0): 1.2 MB,
 * shipped with the app in public/models/, so no download from elsewhere and
 * it works offline. Runs on the ONNX runtime the app already loads for name
 * detection; about 20 ms per photo.
 *
 * Small faces in large photos can be missed (the model looks at a 320x240
 * copy), which is why the user is still asked to check the picture.
 */

import type { InferenceSession } from 'onnxruntime-web';
import { asset } from '@/lib/assets';

export interface FaceBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  score: number;
}

const MIN_SCORE = 0.7;
const W = 320;
const H = 240;

let session: Promise<InferenceSession> | null = null;

/** Keep the strongest of overlapping boxes. */
export function nonMaxSuppression(boxes: FaceBox[], iou = 0.3): FaceBox[] {
  const sorted = [...boxes].sort((a, b) => b.score - a.score);
  const kept: FaceBox[] = [];
  const area = (b: FaceBox) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
  for (const b of sorted) {
    const overlaps = kept.some((k) => {
      const w = Math.min(b.x1, k.x1) - Math.max(b.x0, k.x0);
      const h = Math.min(b.y1, k.y1) - Math.max(b.y0, k.y0);
      if (w <= 0 || h <= 0) return false;
      const inter = w * h;
      return inter / (area(b) + area(k) - inter) > iou;
    });
    if (!overlaps) kept.push(b);
  }
  return kept;
}

/** Turn the model's outputs into face boxes in image pixels. */
export function decodeFaces(scores: Float32Array, boxes: Float32Array, width: number, height: number): FaceBox[] {
  const found: FaceBox[] = [];
  for (let i = 0; i < scores.length / 2; i++) {
    const score = scores[i * 2 + 1];
    if (score < MIN_SCORE) continue;
    found.push({
      x0: Math.max(0, boxes[i * 4] * width),
      y0: Math.max(0, boxes[i * 4 + 1] * height),
      x1: Math.min(width, boxes[i * 4 + 2] * width),
      y1: Math.min(height, boxes[i * 4 + 3] * height),
      score,
    });
  }
  return nonMaxSuppression(found);
}

/** Faces in a decoded picture (browser only). */
export async function detectFaces(bitmap: ImageBitmap): Promise<FaceBox[]> {
  const ort = await import('onnxruntime-web');
  ort.env.wasm.wasmPaths = asset('/wasm/');
  session ??= ort.InferenceSession.create(asset('/models/ultraface-rfb-320.onnx'));
  const s = await session;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, W, H);
  const rgba = ctx.getImageData(0, 0, W, H).data;
  const input = new Float32Array(3 * W * H);
  for (let p = 0; p < W * H; p++) {
    for (let c = 0; c < 3; c++) input[c * W * H + p] = (rgba[p * 4 + c] - 127) / 128;
  }
  const out = await s.run({ input: new ort.Tensor('float32', input, [1, 3, H, W]) });
  return decodeFaces(out.scores.data as Float32Array, out.boxes.data as Float32Array, bitmap.width, bitmap.height);
}

/**
 * The picture with each face covered by a black box (a little larger than
 * the face), re-saved in its own format. The re-saved file carries no
 * metadata, and the orientation is already applied to the pixels.
 */
export async function coverFaces(bitmap: ImageBitmap, faces: FaceBox[], mime: string): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  ctx.fillStyle = '#000';
  for (const f of faces) {
    const padX = (f.x1 - f.x0) * 0.15;
    const padY = (f.y1 - f.y0) * 0.15;
    ctx.fillRect(f.x0 - padX, f.y0 - padY, f.x1 - f.x0 + 2 * padX, f.y1 - f.y0 + 2 * padY);
  }
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not save the picture.'))), mime, 0.95)
  );
  return new Uint8Array(await blob.arrayBuffer());
}
