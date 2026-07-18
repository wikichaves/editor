import epubGen from "epub-gen-memory";

// epub-gen-memory is a CJS module. Depending on the bundler's interop, the
// callable is either the default export itself or nested at `.default`.
const epub: typeof epubGen =
  typeof epubGen === "function"
    ? epubGen
    : (epubGen as unknown as { default: typeof epubGen }).default;

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
  return epub(options, content);
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
