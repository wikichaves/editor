import { extractText, getDocumentProxy } from "unpdf";

/**
 * Extract the plain-text layer of a PDF, page by page.
 * Images are ignored entirely — unpdf only returns text content.
 * Returns one trimmed string per page.
 */
export async function extractPdfText(data: Uint8Array): Promise<string[]> {
  const pdf = await getDocumentProxy(data);
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(text) ? text : [text];
  // Strip null bytes some PDFs emit and trim whitespace per page.
  return pages.map((page) => page.replace(/\x00/g, "").trim());
}
