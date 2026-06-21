import JSZip from "jszip";
import { htmlToText } from "./html-text";

/**
 * Extract readable text from an EPUB (a ZIP of XHTML files).
 * Reads the OPF to follow the spine order, strips markup, and concatenates.
 * Formatting and images are dropped — we only need the text to translate.
 */
export async function extractEpubText(data: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(data);

  const containerXml = await readZip(zip, "META-INF/container.xml");
  if (!containerXml) throw new Error("EPUB inválido: falta META-INF/container.xml");

  const opfPath = containerXml.match(/full-path="([^"]+)"/i)?.[1];
  if (!opfPath) throw new Error("EPUB inválido: no se encontró el archivo OPF");

  const opf = await readZip(zip, opfPath);
  if (!opf) throw new Error("EPUB inválido: no se pudo leer el OPF");

  // manifest: id -> href
  const manifest = new Map<string, string>();
  for (const m of opf.matchAll(/<item\b[^>]*>/gi)) {
    const id = m[0].match(/\bid="([^"]+)"/i)?.[1];
    const href = m[0].match(/\bhref="([^"]+)"/i)?.[1];
    if (id && href) manifest.set(id, href);
  }

  // spine: ordered list of idrefs
  const spine: string[] = [];
  for (const m of opf.matchAll(/<itemref\b[^>]*>/gi)) {
    const idref = m[0].match(/\bidref="([^"]+)"/i)?.[1];
    if (idref) spine.push(idref);
  }

  const baseDir = opfPath.includes("/") ? opfPath.replace(/\/[^/]*$/, "/") : "";

  // Prefer spine order; fall back to every (x)html item in the manifest.
  const hrefs = spine.length
    ? (spine.map((id) => manifest.get(id)).filter(Boolean) as string[])
    : [...manifest.values()].filter((h) => /\.x?html?$/i.test(h));

  const parts: string[] = [];
  for (const href of hrefs) {
    const cleanHref = decodeURIComponent(href.split("#")[0]);
    const html =
      (await readZip(zip, joinPath(baseDir, cleanHref))) ??
      (await readZip(zip, cleanHref));
    if (!html) continue;
    const text = htmlToText(html);
    if (text) parts.push(text);
  }

  return parts.join("\n\n");
}

async function readZip(zip: JSZip, path: string): Promise<string | null> {
  const file = zip.file(path);
  return file ? file.async("string") : null;
}

/** Resolve `href` against `base`, collapsing any `../` segments. */
function joinPath(base: string, href: string): string {
  const stack = (base + href).split("/");
  const out: string[] = [];
  for (const seg of stack) {
    if (seg === "..") out.pop();
    else if (seg !== ".") out.push(seg);
  }
  return out.join("/");
}
