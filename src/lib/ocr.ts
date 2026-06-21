import type Anthropic from "@anthropic-ai/sdk";
import { getDocumentProxy } from "unpdf";
import { TRANSLATION_MODEL } from "./translate";

// Anthropic's native PDF support handles up to 100 pages / 32 MB per request.
export const OCR_MAX_PAGES = 100;
export const OCR_MAX_BYTES = 30 * 1024 * 1024;

const OCR_PROMPT =
  "Este PDF está escaneado (sin capa de texto). Transcribí TODO su texto en " +
  "orden de lectura y traducilo a un español natural y fluido. Respetá los " +
  "saltos de párrafo. Si una página no tiene texto, omitila. No agregues notas, " +
  "números de página ni comentarios: devolvé ÚNICAMENTE la traducción al español.";

/**
 * OCR + translate a scanned PDF in one step using Claude's native PDF support.
 * Claude reads the document (including page images), so no rasterization is
 * needed. Returns the Spanish text. Throws a user-facing error if the PDF is
 * too large or has too many pages for a single request.
 */
export async function ocrTranslatePdf(
  client: Anthropic,
  pdf: Uint8Array,
): Promise<string> {
  if (pdf.byteLength > OCR_MAX_BYTES) {
    throw new Error(
      "El PDF escaneado es muy grande para OCR (máx 30 MB). Dividilo y probá por partes.",
    );
  }

  // Encode to base64 BEFORE any pdf.js call: getDocumentProxy detaches the
  // underlying ArrayBuffer, which would corrupt a later read.
  const base64 = Buffer.from(pdf).toString("base64");

  const proxy = await getDocumentProxy(pdf);
  if (proxy.numPages > OCR_MAX_PAGES) {
    throw new Error(
      `El PDF escaneado tiene ${proxy.numPages} páginas; el OCR admite hasta ${OCR_MAX_PAGES}. Dividilo y probá por partes.`,
    );
  }

  const message = await client.messages.create({
    model: TRANSLATION_MODEL,
    max_tokens: 16000,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: base64,
            },
          },
          { type: "text", text: OCR_PROMPT },
        ],
      },
    ],
  });

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  if (!text) {
    throw new Error("No se pudo extraer texto del PDF escaneado (OCR vacío).");
  }
  return text;
}
