import { NextRequest, NextResponse, after } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { put } from "@vercel/blob";
import { detectKind, extractBookText } from "@/lib/extract";
import { translateText, translateTitle } from "@/lib/translate";
import { ocrTranslatePdf } from "@/lib/ocr";
import { buildEpub } from "@/lib/epub";
import { emailEpub, emailFailure } from "@/lib/email";

// Must run on Node.js (Buffer + native-free libs), not Edge.
export const runtime = "nodejs";
// 300s requires Pro/Fluid; OCR of scanned PDFs can take a while.
export const maxDuration = 300;

interface ConvertBody {
  blobUrl?: string;
  filename?: string;
  email?: string;
}

/** Extract/OCR → translate → build the Spanish ePub. Throws user-facing errors. */
async function buildSpanishEpub(
  data: Uint8Array,
  filename: string | undefined,
): Promise<{ title: string; epub: Buffer }> {
  const kind = detectKind(data);
  if (!kind) throw new Error("Formato no reconocido. Subí un PDF, EPUB o AZW3.");

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
  const spanish = needsOcr
    ? await ocrTranslatePdf(client, data)
    : await translateText(client, fullText);

  // Clean the file-name-derived title (strip download-mirror junk) and translate it.
  const rawTitle = (filename || "libro").replace(/\.(pdf|epub|azw3|azw|mobi)$/i, "");
  const cleaned = cleanTitle(rawTitle) || "Libro";
  let title = cleaned;
  try {
    title = await translateTitle(client, cleaned);
  } catch {
    title = cleaned; // keep the cleaned English title if translation fails
  }

  const epub = await buildEpub(title, spanish);
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

  // Accept either a direct multipart upload (small files) or a Blob URL.
  const contentType = req.headers.get("content-type") || "";
  let data: Uint8Array;
  let filename: string | undefined;
  let email: string | undefined;

  if (contentType.includes("application/json")) {
    let body: ConvertBody;
    try {
      body = (await req.json()) as ConvertBody;
    } catch {
      return NextResponse.json({ error: "Petición inválida." }, { status: 400 });
    }
    if (!body.blobUrl) {
      return NextResponse.json(
        { error: "No se recibió el archivo subido." },
        { status: 400 },
      );
    }
    filename = body.filename;
    email = body.email;
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
        const { title, epub } = await buildSpanishEpub(data, filename);
        await emailEpub({ to, title, epub });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "No se pudo convertir el archivo.";
        await emailFailure(to, message).catch(() => {});
      }
    });
    return NextResponse.json({ async: true, email: to });
  }

  // --- Sync path (no email): process now and return a download URL. ---
  let result: { title: string; epub: Buffer };
  try {
    result = await buildSpanishEpub(data, filename);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "No se pudo convertir el archivo.";
    return NextResponse.json({ error: message }, { status: 422 });
  }

  let downloadUrl: string;
  try {
    const blob = await put(`epubs/${result.title}.epub`, result.epub, {
      access: "public",
      contentType: "application/epub+zip",
      addRandomSuffix: true,
    });
    downloadUrl = blob.url;
  } catch {
    return NextResponse.json(
      { error: "No se pudo guardar el ePub resultante." },
      { status: 502 },
    );
  }

  return NextResponse.json({ title: result.title, downloadUrl });
}
