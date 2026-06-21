import JSZip from "jszip";
import { extractEpubText } from "../src/lib/epub-in";
import { extractMobiText } from "../src/lib/mobi";
import { detectKind } from "../src/lib/extract";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("ok:", msg);
}

// ---------- EPUB ----------
async function testEpub() {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip");
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
  );
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0"?><package><manifest>
      <item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
      <item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
     </manifest><spine>
      <itemref idref="c1"/>
      <itemref idref="c2"/>
     </spine></package>`,
  );
  zip.file("OEBPS/ch1.xhtml", `<html><body><h1>Chapter One</h1><p>Hello &amp; welcome.</p></body></html>`);
  zip.file("OEBPS/ch2.xhtml", `<html><body><p>Second chapter here.</p></body></html>`);
  const data = new Uint8Array(await zip.generateAsync({ type: "uint8array" }));

  assert(detectKind(data) === "epub", "detectKind → epub");
  const text = await extractEpubText(data);
  assert(/Chapter One/.test(text), "epub keeps chapter 1 heading");
  assert(/Hello & welcome\./.test(text), "epub decodes &amp; and keeps text");
  // Spine order: ch1 before ch2.
  assert(text.indexOf("Chapter One") < text.indexOf("Second chapter"), "epub respects spine order");
}

// ---------- MOBI / AZW3 ----------
function palmDocCompress(bytes: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (const b of bytes) {
    if (b === 0) out.push(0);
    else if (b >= 0x09 && b <= 0x7f) out.push(b);
    else out.push(0x01, b); // copy-next-1 literal escape
  }
  return Uint8Array.from(out);
}

function buildMobi(html: string, compress: boolean): Uint8Array {
  const enc = new TextEncoder();
  const htmlBytes = enc.encode(html);
  const textRec = compress ? palmDocCompress(htmlBytes) : htmlBytes;

  const rec0 = new Uint8Array(200);
  const dv = new DataView(rec0.buffer);
  dv.setUint16(0, compress ? 2 : 1); // compression
  dv.setUint32(4, htmlBytes.length); // text length (uncompressed)
  dv.setUint16(8, 1); // record count
  dv.setUint16(10, 4096); // record size
  dv.setUint16(12, 0); // encryption
  rec0.set(enc.encode("MOBI"), 16); // magic
  dv.setUint32(20, 0xc0); // mobi header length (<0xE4 → no extra flags)
  dv.setUint32(44, 65001); // text encoding UTF-8

  const numRecords = 2;
  const headerSize = 78 + numRecords * 8;
  const rec0Off = headerSize;
  const rec1Off = rec0Off + rec0.length;
  const total = rec1Off + textRec.length;

  const buf = new Uint8Array(total);
  const bv = new DataView(buf.buffer);
  buf.set(enc.encode("BOOKMOBI"), 60); // type+creator
  bv.setUint16(76, numRecords);
  bv.setUint32(78, rec0Off);
  bv.setUint32(78 + 8, rec1Off);
  buf.set(rec0, rec0Off);
  buf.set(textRec, rec1Off);
  return buf;
}

function testMobi(compress: boolean) {
  const html = `<html><body><p>The Octonauts explore the deep.</p><p>Second line &amp; more.</p></body></html>`;
  const data = buildMobi(html, compress);
  assert(detectKind(data) === "mobi", `detectKind → mobi (compress=${compress})`);
  const text = extractMobiText(data);
  assert(/Octonauts explore the deep/.test(text), `mobi extracts text (compress=${compress})`);
  assert(/Second line & more/.test(text), `mobi decodes entities (compress=${compress})`);
}

(async () => {
  await testEpub();
  testMobi(false);
  testMobi(true);
  console.log("\nALL PASSED");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
