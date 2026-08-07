import sharp, { type Sharp } from "sharp";
import JSZip from "jszip";
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
    return await finishCover(
      sharp(Buffer.from(best.data), {
        raw: { width: best.width, height: best.height, channels: best.channels },
      }),
    );
  } catch {
    return null;
  }
}

/**
 * Shared finishing pass: composite transparency on WHITE (not black),
 * grayscale, downsize, and apply gentle e-ink contrast. Dark covers are
 * lightened toward a mid tone so they stay readable on e-paper.
 */
async function finishCover(input: Sharp): Promise<Buffer> {
  const base = await input
    .flatten({ background: "#ffffff" })
    .grayscale()
    .resize(COVER_W, COVER_H, { fit: "inside" })
    .png() // explicit format so the buffer can be re-read for stats below
    .toBuffer();

  const mean = (await sharp(base).stats()).channels[0]?.mean ?? 128;

  let pipeline = sharp(base).gamma(1.1).linear(1.15, -16);
  if (mean > 0 && mean < 90) {
    pipeline = pipeline.linear(Math.min(2, 130 / mean), 0);
  }

  return pipeline.jpeg({ quality: 82 }).toBuffer();
}

/** Image extensions we accept as a cover inside an EPUB. */
const IMAGE_RE = /\.(jpe?g|png|gif|webp)$/i;

/**
 * Pull the cover image out of an EPUB. Tries, in order: the OPF
 * `<meta name="cover">` pointer, an item flagged `properties="cover-image"`,
 * then a filename that looks like a cover. Returns null when there is none.
 */
export async function extractEpubCover(data: Uint8Array): Promise<Buffer | null> {
  try {
    const zip = await JSZip.loadAsync(data);

    const container = await zip.file("META-INF/container.xml")?.async("string");
    const opfPath = container?.match(/full-path="([^"]+)"/i)?.[1];
    if (!opfPath) return null;
    const opf = await zip.file(opfPath)?.async("string");
    if (!opf) return null;

    // manifest: id -> { href, properties }
    const items = new Map<string, { href: string; props: string }>();
    for (const m of opf.matchAll(/<item\b[^>]*>/gi)) {
      const id = m[0].match(/\bid="([^"]+)"/i)?.[1];
      const href = m[0].match(/\bhref="([^"]+)"/i)?.[1];
      if (id && href) {
        items.set(id, {
          href,
          props: m[0].match(/\bproperties="([^"]+)"/i)?.[1] ?? "",
        });
      }
    }

    const candidates: string[] = [];
    const metaCoverId = opf.match(
      /<meta\b[^>]*\bname="cover"[^>]*\bcontent="([^"]+)"/i,
    )?.[1];
    if (metaCoverId && items.has(metaCoverId)) {
      candidates.push(items.get(metaCoverId)!.href);
    }
    for (const { href, props } of items.values()) {
      if (/\bcover-image\b/i.test(props)) candidates.push(href);
    }
    for (const { href } of items.values()) {
      if (/cover/i.test(href) && IMAGE_RE.test(href)) candidates.push(href);
    }

    const baseDir = opfPath.includes("/") ? opfPath.replace(/\/[^/]*$/, "/") : "";
    for (const href of candidates) {
      const clean = decodeURIComponent(href.split("#")[0]);
      if (!IMAGE_RE.test(clean)) continue;
      const file =
        zip.file(joinPath(baseDir, clean)) ?? zip.file(clean) ?? null;
      if (!file) continue;
      const bytes = await file.async("uint8array");
      if (!bytes.length) continue;
      return await finishCover(sharp(Buffer.from(bytes)));
    }
    return null;
  } catch {
    return null;
  }
}

/** Resolve `href` against `base`, collapsing any `../` segments. */
function joinPath(base: string, href: string): string {
  const out: string[] = [];
  for (const seg of (base + href).split("/")) {
    if (seg === "..") out.pop();
    else if (seg !== ".") out.push(seg);
  }
  return out.join("/");
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Greedy word wrap to at most `maxLines` lines of ~`perLine` characters. */
function wrapTitle(title: string, perLine: number, maxLines: number): string[] {
  const words = title.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    const candidate = current ? `${current} ${w}` : w;
    if (candidate.length > perLine && current) {
      lines.push(current);
      current = w;
      if (lines.length === maxLines) break;
    } else {
      current = candidate;
    }
  }
  if (lines.length < maxLines && current) lines.push(current);
  if (!lines.length) return ["Libro"];
  const last = lines.length - 1;
  if (lines.length === maxLines && current && lines[last] !== current) {
    lines[last] = `${lines[last]}…`;
  }
  return lines;
}

/**
 * Last-resort cover: a clean typographic card with the book's title. Every book
 * gets *some* cover so they stay distinguishable in the e-reader library. The
 * tone is derived from the title, so different books don't look identical.
 */
export async function generateTextCover(title: string): Promise<Buffer | null> {
  try {
    const clean = title.trim() || "Libro";
    let hash = 0;
    for (let i = 0; i < clean.length; i++) {
      hash = (hash * 31 + clean.charCodeAt(i)) >>> 0;
    }
    // Mid-to-light grays only: dark plates look muddy on e-ink.
    const shade = 210 - (hash % 60);
    const bg = `rgb(${shade},${shade},${shade})`;

    const lines = wrapTitle(clean, 14, 4);
    // Scale the type down until the longest line fits inside the frame, so long
    // titles never bleed into the border.
    const usableW = COVER_W - 110;
    const longest = Math.max(...lines.map((l) => l.length), 1);
    const AVG_CHAR_EM = 0.5; // rough advance width for a serif face
    const fontSize = Math.round(
      Math.max(30, Math.min(lines.length > 2 ? 56 : 66, usableW / (longest * AVG_CHAR_EM))),
    );
    const lineHeight = fontSize * 1.25;
    const startY = COVER_H / 2 - ((lines.length - 1) * lineHeight) / 2;

    const text = lines
      .map(
        (l, i) =>
          `<text x="${COVER_W / 2}" y="${startY + i * lineHeight}" ` +
          `text-anchor="middle" dominant-baseline="middle" ` +
          `font-family="Georgia, 'Times New Roman', serif" font-size="${fontSize}" ` +
          `fill="#1a1a1a">${escapeXml(l)}</text>`,
      )
      .join("");

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${COVER_W}" height="${COVER_H}">
<rect width="${COVER_W}" height="${COVER_H}" fill="${bg}"/>
<rect x="24" y="24" width="${COVER_W - 48}" height="${COVER_H - 48}" fill="none" stroke="#1a1a1a" stroke-width="3"/>
${text}
</svg>`;

    return await finishCover(sharp(Buffer.from(svg)));
  } catch {
    return null;
  }
}
