import OpenAI from "openai";
import { detectKind, extractBookText } from "@/lib/extract";
import { transformText, translateTitle } from "@/lib/translate";
import { ocrPdf } from "@/lib/ocr";
import { retellForChild } from "@/lib/retell";
import {
  extractPdfCover,
  extractEpubCover,
  generateTextCover,
} from "@/lib/cover";
import { buildEpub, buildEpubFromChapters, type ChapterInput } from "@/lib/epub";

/** Conversion options. `simplify` (child retelling) overrides the other two. */
export interface JobOpts {
  translate: boolean;
  summarize: boolean;
  simplify: boolean;
}

/** Extract/OCR → (translate/summarize or child-retell) → build the ePub. */
export async function buildEpubJob(
  data: Uint8Array,
  filename: string | undefined,
  opts: JobOpts,
): Promise<{ title: string; epub: Buffer }> {
  const kind = detectKind(data);
  if (!kind) throw new Error("Formato no reconocido. Subí un PDF, EPUB o AZW3.");

  // Keep a copy for cover extraction before pdf.js detaches the buffer.
  const coverSource = kind === "pdf" || kind === "epub" ? data.slice() : null;

  // Extract from a COPY: pdf.js detaches the buffer it reads, and we still need
  // the original bytes if we fall back to OCR.
  const extracted = (await extractBookText(data.slice())).trim();
  const needsOcr = kind === "pdf" && extracted.length < 30; // scanned PDF

  if (!extracted && !needsOcr) {
    throw new Error(
      "El archivo no tiene capa de texto y no se pudo hacer OCR. Solo se admiten archivos con texto (o PDFs escaneados).",
    );
  }

  const client = new OpenAI();
  const t0 = Date.now();
  console.log(
    `job: kind=${kind} needsOcr=${needsOcr} textLen=${extracted.length} translate=${opts.translate} summarize=${opts.summarize} simplify=${opts.simplify}`,
  );

  // The source text. For scanned PDFs we OCR first: a faithful transcription
  // when we're going to retell, otherwise OCR applies translate/summarize.
  let sourceText = extracted;
  if (needsOcr) {
    sourceText = await ocrPdf(
      client,
      data,
      opts.simplify ? { translate: false, summarize: false } : opts,
    );
  }

  // Build either explicit chapters (child retelling) or a flat body of text.
  let chapters: ChapterInput[] | null = null;
  let body = "";
  if (opts.simplify) {
    chapters = await retellForChild(client, sourceText);
  } else if (needsOcr) {
    body = sourceText; // OCR already applied translate/summarize
  } else {
    body = await transformText(client, sourceText, opts);
  }
  const outLen = chapters
    ? chapters.reduce((n, c) => n + c.text.length, 0)
    : body.length;
  console.log(
    `job: transform done in ${Math.round((Date.now() - t0) / 1000)}s, outLen=${outLen}`,
  );

  // Clean the file-name-derived title; translate it when translating/simplifying.
  const rawTitle = (filename || "libro").replace(/\.(pdf|epub|azw3|azw|mobi)$/i, "");
  let title = cleanTitle(rawTitle) || "Libro";
  if (opts.translate || opts.simplify) {
    try {
      title = await translateTitle(client, title);
    } catch {
      // keep the cleaned original title if translation fails
    }
  }

  // Cover: the book's own artwork when we can find it (PDF page image / EPUB
  // cover entry), otherwise a generated title card — every book gets one so
  // they stay distinguishable in the e-reader library.
  let cover: Buffer | undefined;
  if (coverSource) {
    try {
      cover =
        (kind === "epub"
          ? await extractEpubCover(coverSource)
          : await extractPdfCover(coverSource)) ?? undefined;
    } catch {
      cover = undefined;
    }
  }
  if (!cover) {
    cover = (await generateTextCover(title).catch(() => null)) ?? undefined;
  }
  console.log(`job: cover=${cover ? `${cover.length}b` : "none"}`);

  const epub = chapters
    ? await buildEpubFromChapters(title, chapters, cover)
    : await buildEpub(title, body, cover);
  return { title, epub };
}

/** Strip download-site junk (z-library, 1lib, libgen…) and tidy a raw title. */
export function cleanTitle(raw: string): string {
  return raw
    // Parenthesised/bracketed groups that mention a known mirror.
    .replace(
      /[([{][^)\]}]*(?:z-?lib|1lib|library|libgen|anna|archive|pdfdrive|epubs?)[^)\]}]*[)\]}]/gi,
      "",
    )
    // Loose mirror domains/tokens, e.g. "z-library.sk", "1lib.sk".
    .replace(/\b(?:z-?library|z-?lib|1lib|libgen|pdfdrive)(?:\.\w+)?\b/gi, "")
    // Underscores → spaces (common in downloaded filenames).
    .replace(/_+/g, " ")
    // Tidy whitespace and stray edge punctuation.
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,;:.\-–—]+|[\s,;:.\-–—]+$/g, "")
    .trim();
}
