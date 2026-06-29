import { NextRequest, NextResponse, after } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { list, del, get } from "@vercel/blob";
import { detectKind, extractBookText } from "@/lib/extract";
import { transformText, translateTitle, type TransformOpts } from "@/lib/translate";
import { ocrPdf } from "@/lib/ocr";
import { extractPdfCover } from "@/lib/cover";
import { buildEpub } from "@/lib/epub";
import { emailEpub, emailFailure } from "@/lib/email";

// Must run on Node.js (Buffer + native-free libs), not Edge.
export const runtime = "nodejs";
// 300s requires Pro/Fluid; OCR of scanned PDFs can take a while.
export const maxDuration = 300;

interface ConvertBody {
  blobUrl?: string;
  uploadId?: string;
  filename?: string;
  email?: string;
  translate?: boolean;
  summarize?: boolean;
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

/** Extract/OCR → (optionally translate/summarize) → build the ePub. */
async function buildEpubJob(
  data: Uint8Array,
  filename: string | undefined,
  opts: TransformOpts,
): Promise<{ title: string; epub: Buffer }> {
  const kind = detectKind(data);
  if (!kind) throw new Error("Formato no reconocido. Subí un PDF, EPUB o AZW3.");

  // Keep a copy for cover extraction before pdf.js detaches the buffer.
  const coverSource = kind === "pdf" ? data.slice() : null;

  // Extract from a COPY: pdf.js detaches the buffer it reads, and we still need
  // the original bytes if we fall back to OCR.
  const fullText = (await extractBookText(data.slice())).trim();
  const needsOcr = kind === "pdf" && fullText.length < 30; // scanned PDF

  if (!fullText && !needsOcr) {
    throw new Error(
      "El archivo no tiene capa de texto y no se pudo hacer OCR. Solo se admiten archivos con texto (o PDFs escaneados).",
    );
  }

  const client = new Anthropic();
  // Scanned PDFs always need Claude to read them (OCR); text files only call
  // the model when translating and/or summarizing.
  const body = needsOcr
    ? await ocrPdf(client, data, opts)
    : await transformText(client, fullText, opts);

  // Clean the file-name-derived title; translate it only when translating.
  const rawTitle = (filename || "libro").replace(/\.(pdf|epub|azw3|azw|mobi)$/i, "");
  let title = cleanTitle(rawTitle) || "Libro";
  if (opts.translate) {
    try {
      title = await translateTitle(client, title);
    } catch {
      // keep the cleaned original title if translation fails
    }
  }

  // Best-effort cover for PDFs: most prominent image, grayscaled for e-readers.
  let cover: Buffer | undefined;
  if (coverSource) {
    try {
      cover = (await extractPdfCover(coverSource)) ?? undefined;
    } catch {
      cover = undefined;
    }
  }

  const epub = await buildEpub(title, body, cover);
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
  // Defaults: translate on, summarize off.
  let opts: TransformOpts = { translate: true, summarize: false };

  if (contentType.includes("application/json")) {
    let body: ConvertBody;
    try {
      body = (await req.json()) as ConvertBody;
    } catch {
      return NextResponse.json({ error: "Petición inválida." }, { status: 400 });
    }
    filename = body.filename;
    email = body.email;
    opts = { translate: body.translate !== false, summarize: body.summarize === true };

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
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "No se pudo convertir el archivo.";
        await emailFailure(to, message).catch(() => {});
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
