import { extractPdfText } from "./pdf";
import { extractEpubText } from "./epub-in";
import { extractMobiText } from "./mobi";

export type BookKind = "pdf" | "epub" | "mobi";

/** Detect the book format from the file's magic bytes (not its name). */
export function detectKind(data: Uint8Array): BookKind | null {
  // PDF: "%PDF"
  if (data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46) {
    return "pdf";
  }
  // ZIP ("PK\x03\x04") — EPUBs are ZIPs. extractEpubText validates further.
  if (data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04) {
    return "epub";
  }
  // MOBI / AZW3: PDB header has "BOOKMOBI" at offset 60.
  const sig = String.fromCharCode(...data.subarray(60, 68));
  if (sig === "BOOKMOBI") return "mobi";
  return null;
}

/** Extract the plain text of a book, dispatching on its detected format. */
export async function extractBookText(data: Uint8Array): Promise<string> {
  const kind = detectKind(data);
  switch (kind) {
    case "pdf":
      return (await extractPdfText(data)).join("\n\n");
    case "epub":
      return extractEpubText(data);
    case "mobi":
      return extractMobiText(data);
    default:
      throw new Error(
        "Formato no reconocido. Subí un PDF, EPUB o AZW3 (con texto, no escaneado).",
      );
  }
}
