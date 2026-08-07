import { NextRequest, NextResponse, after } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { list, del, get } from "@vercel/blob";
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
import { emailEpub, emailFailure } from "@/lib/email";

/** Conversion options. `simplify` (child retelling) overrides the other two. */
interface JobOpts {
  translate: boolean;
  summarize: boolean;
  simplify: boolean;
}

// Must run on Node.js (Buffer + native-free libs), not Edge.
export const runtime = "nodejs";
// Long books take many LLM calls; 800s requires Pro + Fluid Compute.
export const maxDuration = 800;

interface ConvertBody {
  blobUrl?: string;
  uploadId?: string;
  filename?: string;
  email?: string;
  translate?: boolean;
  summarize?: boolean;
  simplify?: boolean;
}

/** Fetch all chunks of an upload from Blob and concatenate them in order. */
async function assembleChunks(
  uploadId: string,
): Promise<{ data: Uint8Array; urls: string[] }> {
  const { blobs } = await list({ prefix: `uploads/${uploadId}/` });
  if (!blobs.length) throw new Error("no chunks");
  blobs.sort((a, b) => a.pathname.localeCompare(b.pathname));

  const parts: Uint8Array[] = [];
  for (const b of blobs) {
    // Private store → read content server-side with get(), not a public URL.
    const r = await get(b.pathname, { access: "private" });
    if (!r || r.statusCode !== 200 || !r.stream) throw new Error("chunk read failed");
    parts.push(new Uint8Array(await new Response(r.stream).arrayBuffer()));
  }

  let total = 0;
  for (const p of parts) total += p.length;
  const data = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    data.set(p, off);
    off += p.length;
  }
  return { data, urls: blobs.map((b) => b.url) };
}

/** Extract/OCR → (translate/summarize or child-retell) → build the ePub. */
async function buildEpubJob(
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

  const client = new Anthropic();
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
function cleanTitle(raw: string): string {
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

export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "Falta ANTHROPIC_API_KEY en el servidor." },
      { status: 500 },
    );
  }

  // Accept a chunked upload (large files), a Blob URL, or a direct multipart
  // upload (small files).
  const contentType = req.headers.get("content-type") || "";
  let data: Uint8Array;
  let filename: string | undefined;
  let email: string | undefined;
  let chunkUrls: string[] = [];
  // Defaults: translate on, summarize off, simplify off.
  let opts: JobOpts = { translate: true, summarize: false, simplify: false };

  if (contentType.includes("application/json")) {
    let body: ConvertBody;
    try {
      body = (await req.json()) as ConvertBody;
    } catch {
      return NextResponse.json({ error: "Petición inválida." }, { status: 400 });
    }
    filename = body.filename;
    email = body.email;
    opts = {
      translate: body.translate !== false,
      summarize: body.summarize === true,
      simplify: body.simplify === true,
    };

    if (body.uploadId) {
      try {
        const assembled = await assembleChunks(body.uploadId);
        data = assembled.data;
        chunkUrls = assembled.urls;
      } catch {
        return NextResponse.json(
          { error: "No se pudieron recuperar los fragmentos subidos." },
          { status: 502 },
        );
      }
    } else if (body.blobUrl) {
      try {
        const res = await fetch(body.blobUrl);
        if (!res.ok) throw new Error(String(res.status));
        data = new Uint8Array(await res.arrayBuffer());
      } catch {
        return NextResponse.json(
          { error: "No se pudo recuperar el archivo subido." },
          { status: 502 },
        );
      }
    } else {
      return NextResponse.json(
        { error: "No se recibió el archivo subido." },
        { status: 400 },
      );
    }
  } else {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return NextResponse.json({ error: "Petición inválida." }, { status: 400 });
    }
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "No se recibió ningún archivo." },
        { status: 400 },
      );
    }
    filename = file.name;
    const e = form.get("email");
    email = typeof e === "string" ? e : undefined;
    opts = {
      translate: form.get("translate") !== "false",
      summarize: form.get("summarize") === "true",
      simplify: form.get("simplify") === "true",
    };
    data = new Uint8Array(await file.arrayBuffer());
  }

  const to = email?.trim();

  // Validate the format up front so obvious errors return immediately.
  if (!detectKind(data)) {
    return NextResponse.json(
      { error: "Formato no reconocido. Subí un PDF, EPUB o AZW3." },
      { status: 400 },
    );
  }

  // --- Async path: deliver by email so a flaky connection doesn't need to
  // stay open during a long OCR/translation. Returns immediately. ---
  if (to) {
    if (!process.env.RESEND_API_KEY) {
      return NextResponse.json(
        { error: "El envío por email no está configurado (falta RESEND_API_KEY)." },
        { status: 500 },
      );
    }
    after(async () => {
      try {
        const { title, epub } = await buildEpubJob(data, filename, opts);
        await emailEpub({ to, title, epub });
        console.log(`email: sent "${title}" (${epub.length} bytes) to ${to}`);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "No se pudo convertir el archivo.";
        console.error(`email: job failed for ${to}: ${message}`);
        await emailFailure(to, message)
          .then(() => console.log(`email: failure notice sent to ${to}`))
          .catch((e) =>
            console.error(
              `email: could not send failure notice to ${to}: ${
                e instanceof Error ? e.message : e
              }`,
            ),
          );
      } finally {
        if (chunkUrls.length) await del(chunkUrls).catch(() => {});
      }
    });
    return NextResponse.json({ async: true, email: to });
  }

  // --- Sync path (no email): process now and return a download URL. ---
  let result: { title: string; epub: Buffer };
  try {
    result = await buildEpubJob(data, filename, opts);
  } catch (err) {
    if (chunkUrls.length) await del(chunkUrls).catch(() => {});
    const message =
      err instanceof Error ? err.message : "No se pudo convertir el archivo.";
    return NextResponse.json({ error: message }, { status: 422 });
  }
  if (chunkUrls.length) await del(chunkUrls).catch(() => {});

  // Return the ePub bytes directly so the browser downloads it (no Blob).
  return new NextResponse(new Uint8Array(result.epub), {
    status: 200,
    headers: {
      "Content-Type": "application/epub+zip",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(result.title)}.epub"`,
    },
  });
}
