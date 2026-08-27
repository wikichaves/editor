import type OpenAI from "openai";
import { PDFDocument } from "pdf-lib";
import { TRANSLATION_MODEL, type TransformOpts } from "./translate";

// Anthropic's native PDF support handles up to 100 pages / 32 MB per request.
export const OCR_MAX_PAGES = 100;
export const OCR_MAX_BYTES = 30 * 1024 * 1024;

// Split big scanned PDFs into page batches and OCR them in parallel so each
// Claude call stays fast and the whole job fits in the function time limit.
const PAGES_PER_BATCH = 12;
const OCR_CONCURRENCY = 4;

function ocrPromptFor({ translate, summarize }: TransformOpts): string {
  let p =
    "Este PDF está escaneado (sin capa de texto). Transcribí TODO su texto en orden de lectura";
  if (translate) p += ", traducido a un español natural y fluido";
  if (summarize) {
    p += `${translate ? " y" : ","} resumido a aproximadamente la mitad de su longitud (conservando lo esencial, nombres y el hilo de la historia)`;
  }
  p +=
    ". Respetá los saltos de párrafo. Si una página no tiene texto, omitila. No agregues notas, números de página ni comentarios: devolvé ÚNICAMENTE el texto resultante.";
  return p;
}

/** Send one PDF (base64) to Claude and return the extracted text. */
async function ocrOne(
  client: OpenAI,
  base64: string,
  prompt: string,
): Promise<string> {
  const response = await client.responses.create({
    model: TRANSLATION_MODEL,
    max_output_tokens: 16000,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_file",
            filename: "documento.pdf",
            file_data: base64,
          },
          { type: "input_text", text: prompt },
        ],
      },
    ],
  });
  return response.output_text.trim();
}

/** Run `fn` over items with a concurrency cap, preserving order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * OCR a scanned PDF with Claude's native PDF support, optionally translating to
 * Spanish and/or condensing. Large PDFs are split into page batches OCR'd in
 * parallel so the job stays within the function time limit. No rasterization.
 */
export async function ocrPdf(
  client: OpenAI,
  pdf: Uint8Array,
  opts: TransformOpts,
): Promise<string> {
  if (pdf.byteLength > OCR_MAX_BYTES) {
    throw new Error(
      "El PDF escaneado es muy grande para OCR (máx 30 MB). Dividilo y probá por partes.",
    );
  }

  const prompt = ocrPromptFor(opts);

  // Load with pdf-lib (does not detach the input) to count and split pages.
  const src = await PDFDocument.load(pdf);
  const numPages = src.getPageCount();
  if (numPages > OCR_MAX_PAGES) {
    throw new Error(
      `El PDF escaneado tiene ${numPages} páginas; el OCR admite hasta ${OCR_MAX_PAGES}. Dividilo y probá por partes.`,
    );
  }

  let text: string;
  if (numPages <= PAGES_PER_BATCH) {
    console.log(`ocr: single call, ${numPages} pages`);
    text = await ocrOne(client, Buffer.from(pdf).toString("base64"), prompt);
  } else {
    // Build one sub-PDF per page batch.
    const ranges: [number, number][] = [];
    for (let s = 0; s < numPages; s += PAGES_PER_BATCH) {
      ranges.push([s, Math.min(s + PAGES_PER_BATCH, numPages)]);
    }
    console.log(`ocr: ${numPages} pages → ${ranges.length} batches of ${PAGES_PER_BATCH}`);

    const batchesB64: string[] = [];
    for (const [start, end] of ranges) {
      const doc = await PDFDocument.create();
      const pages = await doc.copyPages(
        src,
        Array.from({ length: end - start }, (_, k) => start + k),
      );
      pages.forEach((p) => doc.addPage(p));
      const bytes = await doc.save();
      batchesB64.push(Buffer.from(bytes).toString("base64"));
    }

    const parts = await mapLimit(batchesB64, OCR_CONCURRENCY, (b) =>
      ocrOne(client, b, prompt),
    );
    text = parts.join("\n\n");
  }

  if (!text) {
    throw new Error("No se pudo extraer texto del PDF escaneado (OCR vacío).");
  }
  return text;
}
