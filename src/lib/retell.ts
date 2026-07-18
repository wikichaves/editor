import type Anthropic from "@anthropic-ai/sdk";
import { TRANSLATION_MODEL, chunkText } from "./translate";
import type { ChapterInput } from "./epub";

/**
 * "Simplificar para chicos" mode: retell a whole book as a small series of
 * bedtime chapters for a 5–7 year old, in Rioplatense Spanish.
 *
 * This is NOT a per-chunk transform (like translate/summarize). To honour a
 * total length and a chapter structure, we first *understand the whole book*
 * (map-reduce summary), then *plan* chapters, then *write* each one. Faithful
 * to the original story, simplified in language, gentle with hard content.
 */

// Read-aloud pace for a bedtime story with a young child (words per minute).
const WORDS_PER_MIN = 120;
// Target ~18 min per chapter (aim under 20), so ~2160 words.
const TARGET_WORDS_PER_CHAPTER = 2160;
const MIN_CHAPTERS = 5;
const MAX_CHAPTERS = 10;

// Bigger chunks than translation: we only need the gist per piece here.
const MAP_CHUNK_CHARS = 6000;
// When the joined summaries exceed this, reduce them another round.
const REDUCE_TARGET_CHARS = 14000;
const REDUCE_BATCH_CHARS = 10000;

const CONCURRENCY = 8;

/** Run `fn` over items with a concurrency cap, preserving input order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

async function complete(
  client: Anthropic,
  system: string,
  user: string,
  maxTokens: number,
): Promise<string> {
  const message = await client.messages.create({
    model: TRANSLATION_MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
  });
  return textOf(message);
}

const MAP_SYSTEM =
  "Sos un asistente que resume libros. Te doy un fragmento de un libro (puede estar en cualquier idioma). Devolvé en español neutro un resumen breve (100-200 palabras) de lo que pasa en el fragmento, conservando los nombres propios, lugares y los hechos y giros importantes en orden. No agregues opiniones ni comentarios: solo el resumen.";

/** Map step: condense each chunk of the source into ordered beats. */
async function summariseChunks(
  client: Anthropic,
  fullText: string,
): Promise<string[]> {
  const chunks = chunkText(fullText, MAP_CHUNK_CHARS);
  return mapLimit(chunks, CONCURRENCY, (chunk) =>
    complete(client, MAP_SYSTEM, chunk, 1024),
  );
}

/** Group consecutive strings into batches under a char budget. */
function batchByChars(items: string[], budget: number): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const it of items) {
    if (size + it.length > budget && current.length) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(it);
    size += it.length + 2;
  }
  if (current.length) batches.push(current);
  return batches;
}

const REDUCE_SYSTEM =
  "Sos un asistente que integra resúmenes parciales de un libro en uno solo, coherente y en orden. Conservá los nombres, lugares y los hechos importantes. Devolvé solo el resumen combinado, sin comentarios.";

const SYNOPSIS_SYSTEM =
  "Sos un asistente que escribe la sinopsis completa de un libro a partir de resúmenes por partes. Escribí en español una sinopsis ordenada y coherente (600-1000 palabras) que cuente el arco completo de la historia de principio a fin: personajes principales, conflicto, hechos clave y desenlace. Solo la sinopsis.";

/** Reduce step: fold chunk summaries into one coherent full-story synopsis. */
async function buildSynopsis(
  client: Anthropic,
  summaries: string[],
): Promise<string> {
  let level = summaries;
  // Fold until the combined summaries are small enough for one synopsis call.
  while (level.join("\n\n").length > REDUCE_TARGET_CHARS && level.length > 1) {
    const batches = batchByChars(level, REDUCE_BATCH_CHARS);
    level = await mapLimit(batches, CONCURRENCY, (batch) =>
      complete(client, REDUCE_SYSTEM, batch.join("\n\n"), 2048),
    );
  }
  return complete(client, SYNOPSIS_SYSTEM, level.join("\n\n"), 4096);
}

interface PlannedChapter {
  titulo: string;
  resumen: string;
}

/** Strip ```json fences and parse a JSON array of chapters, defensively. */
function parsePlan(raw: string): PlannedChapter[] | null {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start === -1 || end === -1) return null;
  try {
    const arr = JSON.parse(s.slice(start, end + 1));
    if (!Array.isArray(arr)) return null;
    const out = arr
      .filter((c) => c && typeof c.titulo === "string" && typeof c.resumen === "string")
      .map((c) => ({ titulo: c.titulo.trim(), resumen: c.resumen.trim() }));
    return out.length ? out : null;
  } catch {
    return null;
  }
}

/** Plan step: decide the chapters (5–10) and what each one covers. */
async function planChapters(
  client: Anthropic,
  synopsis: string,
): Promise<PlannedChapter[]> {
  const system =
    `Sos un editor de cuentos para chicos. A partir de la sinopsis de un libro, dividí la historia en capítulos para leer en voz alta a un nene de 5 a 7 años, uno por noche. ` +
    `Elegí entre ${MIN_CHAPTERS} y ${MAX_CHAPTERS} capítulos según cuánta historia haya: cada capítulo debe dar para unos 15-20 minutos de lectura en voz alta (ni más). Si la historia es simple, tendé a ${MIN_CHAPTERS}. ` +
    `Los capítulos deben cubrir TODA la historia en orden, sin huecos ni repeticiones. ` +
    `Devolvé SOLO un arreglo JSON, sin texto extra, con este formato: ` +
    `[{"titulo":"título corto (máx 6 palabras)","resumen":"qué pasa en este capítulo, en orden"}]`;
  const raw = await complete(client, system, synopsis, 3000);
  const plan = parsePlan(raw);
  if (plan) {
    return plan.slice(0, MAX_CHAPTERS);
  }
  // Fallback: one chapter carrying the whole synopsis (still readable).
  return [{ titulo: "El cuento", resumen: synopsis }];
}

/** Keep chapter titles short so the ePub TOC stays tidy. */
function tidyTitle(raw: string, n: number): string {
  const t = raw.replace(/^cap[íi]tulo\s*\d*\s*[:.\-]?\s*/i, "").trim();
  const short = t.split(/\s+/).slice(0, 8).join(" ");
  return `Capítulo ${n}: ${short || "El cuento"}`;
}

/** Write step: turn one planned chapter into finished bedtime prose. */
async function writeChapter(
  client: Anthropic,
  synopsis: string,
  titles: string[],
  index: number,
  chapter: PlannedChapter,
): Promise<string> {
  const system =
    `Sos un narrador que recuenta libros para chicos de 5 a 7 años, para leerles en voz alta antes de dormir. Escribí en ESPAÑOL RIOPLATENSE (de Argentina): usá "vos" en vez de "tú", el voseo en los verbos (tenés, mirá, vení), y un tono cálido y natural de cuento de noche.\n\n` +
    `Reglas:\n` +
    `- FIEL pero simplificado: respetá la misma historia, los personajes y la trama del libro; no inventes otra historia. Simplificá el lenguaje y acortá.\n` +
    `- Vocabulario rico y un poco desafiante, pero siempre claro y entendible para esa edad. Nada de arcaísmos ni lenguaje anticuado.\n` +
    `- Quitá sexualidad y complejidades innecesarias.\n` +
    `- Con lo difícil (muerte, miedo, violencia, pérdidas) NO lo borres si es importante para la historia: contalo con mucha delicadeza, calidez y esperanza, apropiado para un nene chico.\n` +
    `- Extensión: alrededor de 1900-2400 palabras (unos 18-20 minutos de lectura en voz alta). Priorizá que el cuento fluya natural por sobre el número exacto.\n` +
    `- NO escribas el título ni "Capítulo N": solo el cuerpo del capítulo. Separá los párrafos con una línea en blanco. No uses markdown ni viñetas.`;

  const user =
    `Sinopsis completa del libro (para que mantengas coherencia de nombres y tono):\n${synopsis}\n\n` +
    `La historia está dividida en estos capítulos, en orden:\n${titles
      .map((t, i) => `${i + 1}. ${t}`)
      .join("\n")}\n\n` +
    `Escribí SOLO el capítulo ${index + 1} ("${chapter.titulo}"). Este capítulo cubre exactamente esto (no cuentes lo de los otros capítulos):\n${chapter.resumen}`;

  return complete(client, system, user, 6000);
}

function countWords(s: string): number {
  const m = s.trim().match(/\S+/g);
  return m ? m.length : 0;
}

/**
 * Retell a book as bedtime chapters for a young child (Rioplatense Spanish).
 * Returns the finished chapters ready for the ePub builder.
 */
export async function retellForChild(
  client: Anthropic,
  fullText: string,
): Promise<ChapterInput[]> {
  if (!fullText.trim()) {
    throw new Error("No hay texto para simplificar.");
  }

  const summaries = await summariseChunks(client, fullText);
  const synopsis = await buildSynopsis(client, summaries);
  const plan = await planChapters(client, synopsis);

  const titles = plan.map((c, i) => tidyTitle(c.titulo, i + 1));
  console.log(`retell: ${plan.length} chapters planned`);

  const bodies = await mapLimit(plan, Math.min(CONCURRENCY, plan.length), (c, i) =>
    writeChapter(client, synopsis, titles, i, c),
  );

  const chapters: ChapterInput[] = plan.map((_, i) => ({
    title: titles[i],
    text: bodies[i],
  }));

  const totalWords = bodies.reduce((n, b) => n + countWords(b), 0);
  const perChapter = bodies
    .map((b) => Math.round(countWords(b) / WORDS_PER_MIN))
    .join(", ");
  console.log(
    `retell: ~${Math.round(totalWords / WORDS_PER_MIN)} min total (target ~${Math.round(
      (plan.length * TARGET_WORDS_PER_CHAPTER) / WORDS_PER_MIN,
    )}), per-chapter min: ${perChapter}`,
  );

  return chapters;
}
