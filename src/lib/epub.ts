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

/**
 * Build an ePub in memory from translated Spanish text. No images.
 * Single chapter, paragraphs preserved — prioritizes readability over a
 * fancy TOC. Returns a Buffer (never touches disk — key for serverless).
 */
export async function buildEpub(title: string, spanishText: string): Promise<Buffer> {
  const paragraphs = spanishText
    .split(/\n\n+/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean);

  const html = paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("\n");

  const content = [{ title, content: html || "<p></p>" }];

  const buffer = await epub(
    { title, author: "Traducción automática (EN→ES)" },
    content,
  );

  return buffer;
}
