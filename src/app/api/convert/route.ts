import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { detectKind, extractBookText } from "@/lib/extract";
import { translateText } from "@/lib/translate";
import { buildEpub } from "@/lib/epub";

// Must run on Node.js (we need Buffer + native-free Node libs), not Edge.
export const runtime = "nodejs";
// 60s on Hobby; bump to 300 if you have Fluid Compute / Pro.
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "Falta ANTHROPIC_API_KEY en el servidor." },
      { status: 500 },
    );
  }

  const formData = await req.formData();
  const file = formData.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "No se recibió ningún archivo." },
      { status: 400 },
    );
  }
  const data = new Uint8Array(await file.arrayBuffer());

  // Detect the format by magic bytes instead of trusting the file name.
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
    // Extractors throw user-facing messages (DRM, HUFF/CDIC, invalid EPUB…).
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

  const title = file.name.replace(/\.(pdf|epub|azw3|azw|mobi)$/i, "");
  const epubBuffer = await buildEpub(title, spanish);

  return new NextResponse(new Uint8Array(epubBuffer), {
    status: 200,
    headers: {
      "Content-Type": "application/epub+zip",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(title)}.epub"`,
    },
  });
}
