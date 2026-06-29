import sharp from "sharp";
import { getDocumentProxy, extractImages } from "unpdf";

// Target cover size (portrait, e-reader friendly).
const COVER_W = 600;
const COVER_H = 800;
// Only scan the first pages — the cover is almost always near the start.
const MAX_SCAN_PAGES = 6;
// Ignore tiny images (icons, bullets, logos).
const MIN_AREA = 150 * 150;

interface RawImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  channels: 1 | 3 | 4;
}

/**
 * Pick the most prominent image from the first pages of a PDF and turn it into
 * a "Kindle-friendly" cover: grayscale, high contrast, downsized. Returns a
 * JPEG Buffer, or null if no suitable image is found (or processing fails).
 *
 * NOTE: pdf.js detaches the input buffer, so pass a dedicated copy.
 */
async function largestImageOnPage(
  pdf: Awaited<ReturnType<typeof getDocumentProxy>>,
  page: number,
): Promise<RawImage | null> {
  let best: RawImage | null = null;
  let imgs: RawImage[];
  try {
    imgs = (await extractImages(pdf, page)) as unknown as RawImage[];
  } catch {
    return null;
  }
  for (const img of imgs) {
    if (!img?.data || img.width * img.height < MIN_AREA) continue;
    if (!best || img.width * img.height > best.width * best.height) best = img;
  }
  return best;
}

export async function extractPdfCover(pdfData: Uint8Array): Promise<Buffer | null> {
  let best: RawImage | null = null;

  try {
    const pdf = await getDocumentProxy(pdfData);
    // The front cover is almost always page 1 — prefer it. Only fall back to
    // later pages if page 1 has no suitable image.
    best = await largestImageOnPage(pdf, 1);
    if (!best) {
      const pages = Math.min(pdf.numPages, MAX_SCAN_PAGES);
      for (let p = 2; p <= pages; p++) {
        const candidate = await largestImageOnPage(pdf, p);
        if (candidate && (!best || candidate.width * candidate.height > best.width * best.height)) {
          best = candidate;
        }
      }
    }
  } catch {
    return null;
  }

  if (!best) return null;

  try {
    // Composite any transparency on WHITE (not black), grayscale, downsize.
    const base = await sharp(Buffer.from(best.data), {
      raw: { width: best.width, height: best.height, channels: best.channels },
    })
      .flatten({ background: "#ffffff" })
      .grayscale()
      .resize(COVER_W, COVER_H, { fit: "inside" })
      .png() // explicit format so the buffer can be re-read for stats below
      .toBuffer();

    const mean = (await sharp(base).stats()).channels[0]?.mean ?? 128;

    let pipeline = sharp(base).gamma(1.1).linear(1.15, -16); // gentle e-ink contrast
    if (mean > 0 && mean < 90) {
      // Lighten genuinely dark covers toward a mid tone.
      pipeline = pipeline.linear(Math.min(2, 130 / mean), 0);
    }

    return pipeline.jpeg({ quality: 82 }).toBuffer();
  } catch {
    return null;
  }
}
