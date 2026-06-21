import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { put } from "@vercel/blob";
import { detectKind, extractBookText } from "@/lib/extract";
import { translateText } from "@/lib/translate";
import { ocrTranslatePdf } from "@/lib/ocr";
import { buildEpub } from "@/lib/epub";
import { emailEpub } from "@/lib/email";

// Must run on Node.js (Buffer + native-free libs), not Edge.
export const runtime = "nodejs";
// 300s requires Pro/Fluid; OCR of scanned PDFs can take a while.
export const maxDuration = 300;

interface ConvertBody {
  blobUrl?: string;
  filename?: string;
  email?: string;
}

export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "Falta ANTHROPIC_API_KEY en el servidor." },
      { status: 500 },
    );
  }

  // Accept either a direct multipart upload (small files, ≤ ~4.5 MB) or a Blob
  // URL (large files that bypassed the serverless request-body limit).
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

  const wantsEmail = !!email?.trim();
  if (wantsEmail && !process.env.RESEND_API_KEY) {
    return NextResponse.json(
      { error: "El envío por email no está configurado (falta RESEND_API_KEY)." },
      { status: 500 },
    );
  }

  const kind = detectKind(data);
  if (!kind) {
    return NextResponse.json(
      { error: "Formato no reconocido. Subí un PDF, EPUB o AZW3." },
      { status: 400 },
    );
  }

  let fullText: string;
  try {
    fullText = (await extractBookText(data)).trim();
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "No se pudo leer el archivo.";
    return NextResponse.json({ error: message }, { status: 422 });
  }

  // A PDF with (almost) no text layer is scanned → fall back to OCR.
  const needsOcr = kind === "pdf" && fullText.length < 30;

  if (!fullText && !needsOcr) {
    return NextResponse.json(
      {
        error:
          "El archivo no tiene capa de texto y no se pudo hacer OCR. Solo se admiten archivos con texto (o PDFs escaneados).",
      },
      { status: 422 },
    );
  }

  const client = new Anthropic();
  let spanish: string;
  if (needsOcr) {
    // Scanned PDF: Claude reads it natively and returns the Spanish text.
    try {
      spanish = await ocrTranslatePdf(client, data);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Falló el OCR del PDF escaneado.";
      return NextResponse.json({ error: message }, { status: 422 });
    }
  } else {
    try {
      spanish = await translateText(client, fullText);
    } catch {
      return NextResponse.json(
        { error: "Falló la traducción. Probá de nuevo en un rato." },
        { status: 502 },
      );
    }
  }

  const title = (filename || "libro").replace(/\.(pdf|epub|azw3|azw|mobi)$/i, "");
  const epubBuffer = await buildEpub(title, spanish);

  // Store the result so it has a real URL (reliable download, also on mobile).
  let downloadUrl: string;
  try {
    const blob = await put(`epubs/${title}.epub`, epubBuffer, {
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

  // Optionally email it as an attachment.
  let emailed = false;
  let emailError: string | undefined;
  if (wantsEmail) {
    try {
      await emailEpub({ to: email!.trim(), title, epub: epubBuffer });
      emailed = true;
    } catch (err) {
      emailError = err instanceof Error ? err.message : "No se pudo enviar el email.";
    }
  }

  return NextResponse.json({ title, downloadUrl, emailed, emailError });
}
