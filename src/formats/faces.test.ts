import { describe, expect, it } from 'vitest';
import { decodeFaces } from '@/formats/faces';

describe('face boxes', () => {
  it('keeps confident boxes, merges overlaps, scales to the picture', () => {
    // Three candidates: two overlapping on one face, one weak.
    const scores = new Float32Array([0.01, 0.99, 0.05, 0.95, 0.6, 0.4]);
    const boxes = new Float32Array([0.36, 0.12, 0.53, 0.34, 0.35, 0.11, 0.52, 0.33, 0.1, 0.1, 0.2, 0.2]);
    const faces = decodeFaces(scores, boxes, 512, 512);
    expect(faces).toHaveLength(1);
    expect(faces[0].x0).toBeCloseTo(184.3, 0);
    expect(faces[0].y1).toBeCloseTo(174.1, 0);
  });
});
