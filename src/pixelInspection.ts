import { PNG } from 'pngjs';
import { decode } from 'jpeg-js';
import type { AgentToolResultImageContent } from './pi-compat.ts';

type Point = { x: number; y: number };
type Region = Point & { width: number; height: number };
export interface PixelInspection { samplePixels?: Point[]; magnify?: Region }

/** Read the image returned by the provider, in its original coordinate system. */
export function inspectScreenshot(image: AgentToolResultImageContent, { samplePixels, magnify }: PixelInspection) {
  if (samplePixels !== undefined && (!Array.isArray(samplePixels) || samplePixels.length < 1 || samplePixels.length > 8)) {
    throw new Error('Choose between one and eight screenshot pixels.');
  }
  const bytes = Buffer.from(image.data, 'base64');
  const lossless = image.mimeType === 'image/png';
  if (!lossless && image.mimeType !== 'image/jpeg') throw new Error('Pixel inspection needs a PNG or JPEG screenshot.');
  if (lossless && (bytes.length < 24 || bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > 16_000_000)) {
    throw new Error('Screenshot too large for pixel inspection.');
  }
  const shot = lossless ? PNG.sync.read(bytes) : decode(bytes, { maxResolutionInMP: 16, maxMemoryUsageInMB: 128 });
  function checkPoint(p: Point) {
    if (!p || !Number.isInteger(p.x) || !Number.isInteger(p.y) || p.x < 0 || p.x >= shot.width || p.y < 0 || p.y >= shot.height) {
      throw new Error('Coordinates must be whole pixels within the full screenshot.');
    }
  }
  const notes: string[] = [];
  if (samplePixels) {
    const samples = samplePixels.map(p => {
      checkPoint(p);
      const offset = 4 * (shot.width * p.y + p.x);
      return `(${p.x},${p.y}) RGB(${shot.data.subarray(offset, offset + 3).join(',')})`;
    });
    notes.push(`Colors from the ${lossless ? 'lossless PNG' : 'compressed JPEG (approximate colors)'} screenshot: ${samples.join(' | ')}.`);
  }
  let crop: string | undefined;
  if (magnify !== undefined) {
    checkPoint(magnify);
    const { x, y, width, height } = magnify;
    if (![width,height].every(n => Number.isInteger(n) && n >= 1 && n <= 320) || x + width > shot.width || y + height > shot.height) {
      throw new Error('Choose a region inside the screenshot with each side between 1 and 320 pixels.');
    }
    const detail = new PNG({width: 2 * width, height: 2 * height});
    for (let row = 0; row < detail.height; row++) {
      for (let col = 0; col < detail.width; col++) {
        const from = 4 * ((y + Math.floor(row / 2)) * shot.width + x + Math.floor(col / 2));
        detail.data.set(shot.data.subarray(from, from + 4), 4 * (row * detail.width + col));
      }
    }
    crop = PNG.sync.write(detail).toString('base64');
    notes.push(`The second image is a 2× detail of the full screenshot at (${x},${y}), size ${width} × ${height}. For an action at (u,v) in this detail, use x=${x}+floor(u/2), y=${y}+floor(v/2) on the full screenshot.`);
  }
  return { text: notes.join('\n'), crop };
}
