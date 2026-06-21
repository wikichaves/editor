import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { extractPdfText } from "@/lib/pdf";
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

  // Detect a PDF by its magic bytes (%PDF) instead of trusting the file name,
  // so files without a .pdf extension still work as long as they're real PDFs.
  const isPdf =
    data.length > 4 &&
    data[0] === 0x25 && // %
    data[1] === 0x50 && // P
    data[2] === 0x44 && // D
    data[3] === 0x46; // F
  if (!isPdf) {
    return NextResponse.json(
      { error: "El archivo no parece ser un PDF (no tiene la cabecera %PDF)." },
      { status: 400 },
    );
  }

  let pages: string[];
  try {
    pages = await extractPdfText(data);
  } catch {
    return NextResponse.json(
      { error: "No se pudo leer el PDF." },
      { status: 422 },
    );
  }

  const fullText = pages.join("\n\n").trim();
  if (!fullText) {
    return NextResponse.json(
      {
        error:
          "El PDF no tiene capa de texto (¿está escaneado?). Por ahora solo se admiten PDFs con texto.",
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

  const title = file.name.replace(/\.pdf$/i, "");
  const epubBuffer = await buildEpub(title, spanish);

  return new NextResponse(new Uint8Array(epubBuffer), {
    status: 200,
    headers: {
      "Content-Type": "application/epub+zip",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(title)}.epub"`,
    },
  });
}
