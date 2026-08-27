import epubGen from "epub-gen-memory";
import JSZip from "jszip";

// epub-gen-memory is a CJS module. Depending on the bundler's interop, the
// callable is either the default export itself or nested at `.default`.
const epub: typeof epubGen =
  typeof epubGen === "function"
    ? epubGen
    : (epubGen as unknown as { default: typeof epubGen }).default;

/**
 * epub-gen-memory adds the image and its OPF metadata, but does not create a
 * cover XHTML page or a `guide` reference. Kindle's mail converter commonly
 * ignores an image-only cover, so add both parts of the EPUB convention.
 */
async function addKindleCoverPage(book: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(book);
  const opfFile = zip.file("OEBPS/content.opf");
  if (!opfFile) return book;

  let opf = await opfFile.async("string");
  if (!/id="image_cover"/.test(opf) || /id="cover-page"/.test(opf)) {
    return book;
  }

  zip.file(
    "OEBPS/cover.xhtml",
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Portada</title><style>html,body{margin:0;padding:0;height:100%;}body{display:flex;align-items:center;justify-content:center;}img{max-width:100%;max-height:100vh;object-fit:contain;}</style></head>
<body><img src="cover.jpeg" alt="Portada"/></body>
</html>`,
  );

  opf = opf.replace(
    /<\/manifest>/,
    '        <item id="cover-page" href="cover.xhtml" media-type="application/xhtml+xml" />\n    </manifest>',
  );
  opf = opf.replace(
    /<spine([^>]*)>/,
    '<spine$1>\n        <itemref idref="cover-page" linear="no"/>',
  );
  opf = opf.replace(
    /<guide>([\s\S]*?)<\/guide>/,
    '<guide>\n        <reference type="cover" title="Portada" href="cover.xhtml" />$1</guide>',
  );
  zip.file("OEBPS/content.opf", opf);
  return Buffer.from(
    await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
    }),
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// A line that looks like a chapter heading (kept short to avoid false positives).
const HEADING_RE =
  /^(?:cap[íi]tulo|chapter|parte|secci[óo]n|pr[óo]logo|prologo|ep[íi]logo|epilogo|introducci[óo]n)\b.{0,60}$/i;

/** Turn a block of text into <p> paragraphs, splitting on blank lines. */
function paragraphsToHtml(block: string): string {
  const paras = block
    .split(/\n\n+/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean);
  return paras.map((p) => `<p>${escapeHtml(p)}</p>`).join("\n");
}

interface Chapter {
  title: string;
  body: string;
}

/**
 * Split the translated text into chapters by detecting heading lines. When no
 * headings are found, falls back to a single chapter under the book title.
 * The list of chapter titles becomes the ePub's navigable table of contents.
 */
function splitIntoChapters(bookTitle: string, text: string): Chapter[] {
  const lines = text.split("\n");
  const collected: { title: string; lines: string[] }[] = [];
  let current = { title: bookTitle, lines: [] as string[] };
  let sawHeading = false;

  const flush = () => {
    const hasBody = current.lines.some((l) => l.trim());
    if (hasBody || current.title !== bookTitle) collected.push(current);
  };

  for (const raw of lines) {
    if (HEADING_RE.test(raw.trim())) {
      flush();
      current = { title: raw.trim(), lines: [] };
      sawHeading = true;
    } else {
      current.lines.push(raw);
    }
  }
  flush();

  if (!sawHeading || collected.length === 0) {
    return [{ title: bookTitle, body: paragraphsToHtml(text) }];
  }
  return collected.map((c) => ({
    title: c.title,
    body: paragraphsToHtml(c.lines.join("\n")),
  }));
}

/** Assemble an ePub from ready-made chapter HTML. Shared by both builders. */
async function assemble(
  title: string,
  author: string,
  content: { title: string; content: string }[],
  coverImage?: Buffer,
): Promise<Buffer> {
  const options: Parameters<typeof epub>[0] = { title, author };
  if (coverImage) {
    options.cover = new File([new Uint8Array(coverImage)], "cover.jpg", {
      type: "image/jpeg",
    });
  }
  const book = await epub(options, content);
  return coverImage ? addKindleCoverPage(book) : book;
}

/**
 * Build an ePub in memory from translated Spanish text. Detects chapters for a
 * navigable TOC and, when provided, sets a cover image. Returns a Buffer
 * (never touches disk — key for serverless).
 */
export async function buildEpub(
  title: string,
  spanishText: string,
  coverImage?: Buffer,
): Promise<Buffer> {
  const chapters = splitIntoChapters(title, spanishText);
  const content = chapters.map((c) => ({
    title: c.title,
    content: c.body || "<p></p>",
  }));
  return assemble(title, "Generado automáticamente", content, coverImage);
}

export interface ChapterInput {
  title: string;
  text: string;
}

/**
 * Build an ePub from explicit chapters (title + plain text). Used by the
 * child-retelling mode, where chapter boundaries are known up front and we
 * don't want to rely on heading detection. Each chapter's title becomes a TOC
 * entry.
 */
export async function buildEpubFromChapters(
  title: string,
  chapters: ChapterInput[],
  coverImage?: Buffer,
): Promise<Buffer> {
  const content = chapters.map((c) => ({
    title: c.title,
    content: paragraphsToHtml(c.text) || "<p></p>",
  }));
  return assemble(title, "Adaptado para leer en familia", content, coverImage);
}
