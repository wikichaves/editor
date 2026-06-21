import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

// 50 MB cap for uploaded books. Adjust if you need bigger files.
const MAX_BYTES = 50 * 1024 * 1024;

/**
 * Issues short-lived client tokens so the browser can upload the source file
 * straight to Vercel Blob, bypassing the 4.5 MB serverless request-body limit.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json()) as HandleUploadBody;

  try {
    const result = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: [
          "application/pdf",
          "application/epub+zip",
          "application/x-mobipocket-ebook",
          "application/octet-stream", // many e-readers/exports use this
        ],
        maximumSizeInBytes: MAX_BYTES,
        addRandomSuffix: true,
      }),
      // Required by the API but we do the work in /api/convert instead.
      onUploadCompleted: async () => {},
    });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error al subir el archivo.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
