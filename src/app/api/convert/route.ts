import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { put } from "@vercel/blob";
import { detectKind, extractBookText } from "@/lib/extract";
import { translateText } from "@/lib/translate";
import { buildEpub } from "@/lib/epub";
import { emailEpub } from "@/lib/email";

// Must run on Node.js (Buffer + native-free libs), not Edge.
export const runtime = "nodejs";
// 60s on Hobby; bump to 300 if you have Fluid Compute / Pro for longer books.
export const maxDuration = 60;

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

  let body: ConvertBody;
  try {
    body = (await req.json()) as ConvertBody;
  } catch {
    return NextResponse.json({ error: "Petición inválida." }, { status: 400 });
  }

  const { blobUrl, filename, email } = body;
  if (!blobUrl) {
    return NextResponse.json(
      { error: "No se recibió el archivo subido." },
      { status: 400 },
    );
  }
  const wantsEmail = !!email?.trim();
  if (wantsEmail && !process.env.RESEND_API_KEY) {
    return NextResponse.json(
      { error: "El envío por email no está configurado (falta RESEND_API_KEY)." },
      { status: 500 },
    );
  }

  // Pull the uploaded file back from Blob storage.
  let data: Uint8Array;
  try {
    const res = await fetch(blobUrl);
    if (!res.ok) throw new Error(String(res.status));
    data = new Uint8Array(await res.arrayBuffer());
  } catch {
    return NextResponse.json(
      { error: "No se pudo recuperar el archivo subido." },
      { status: 502 },
    );
  }

  if (!detectKind(data)) {
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

  if (!fullText) {
    return NextResponse.json(
      {
        error:
          "El archivo no tiene capa de texto (¿está escaneado?). Solo se admiten archivos con texto.",
      },
      { status: 422 },
    );
  }

  const client = new Anthropic();
  let spanish: string;
  try {
    spanish = await translateText(client, fullText);
  } catch {
    return NextResponse.json(
      { error: "Falló la traducción. Probá de nuevo en un rato." },
      { status: 502 },
    );
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
