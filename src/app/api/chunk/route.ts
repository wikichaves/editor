import { put } from "@vercel/blob";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Receive one chunk of a large upload (each well under the 4.5 MB request
 * limit) and store it in Blob server-side under uploads/<id>/<index>. The
 * browser only ever talks to this function — no unreliable client→Blob SDK.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const indexRaw = url.searchParams.get("i");
  const index = Number(indexRaw);

  if (!id || !/^[a-zA-Z0-9_-]{8,64}$/.test(id) || !Number.isInteger(index) || index < 0) {
    return NextResponse.json({ error: "Parámetros de fragmento inválidos." }, { status: 400 });
  }

  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.byteLength === 0) {
    return NextResponse.json({ error: "Fragmento vacío." }, { status: 400 });
  }

  try {
    // Zero-padded index so list() returns chunks in order.
    await put(`uploads/${id}/${String(index).padStart(5, "0")}`, buf, {
      access: "public",
      contentType: "application/octet-stream",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  } catch {
    return NextResponse.json(
      { error: "No se pudo guardar el fragmento subido." },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true });
}
