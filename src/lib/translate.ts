import type Anthropic from "@anthropic-ai/sdk";

/**
 * Translation model. Swap for the cheaper alternative if cost matters:
 *   "claude-haiku-4-5-20251001"
 */
export const TRANSLATION_MODEL = "claude-sonnet-4-6";

const SYSTEM_PROMPT =
  "You are a professional literary translator. Translate the text from English to Spanish. Preserve paragraph breaks exactly. Do not add notes, explanations, or markdown. Output only the translation.";

/** Target chunk size in characters, splitting on paragraph breaks. */
const MAX_CHUNK_CHARS = 3500;

/**
 * Split text into chunks of roughly MAX_CHUNK_CHARS, respecting paragraph
 * breaks (\n\n). A single paragraph longer than the limit is hard-split.
 */
export function chunkText(text: string, maxChars = MAX_CHUNK_CHARS): string[] {
  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    if (para.length > maxChars) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let i = 0; i < para.length; i += maxChars) {
        chunks.push(para.slice(i, i + maxChars));
      }
      continue;
    }

    const candidate = current ? `${current}\n\n${para}` : para;
    if (candidate.length > maxChars) {
      if (current) chunks.push(current);
      current = para;
    } else {
      current = candidate;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

export interface TransformOpts {
  translate: boolean;
  summarize: boolean;
}

function systemPromptFor({ translate, summarize }: TransformOpts): string {
  if (translate && summarize) {
    return "You are a professional literary translator and editor. Translate the text from English to Spanish AND condense it to roughly half its length, keeping the key content, names, and narrative flow. Preserve paragraph breaks. Do not add notes, explanations, or markdown. Output only the resulting Spanish text.";
  }
  if (translate) return SYSTEM_PROMPT;
  if (summarize) {
    return "You are a skilled editor. Condense the text to roughly half its length, in its ORIGINAL language, keeping the key content, names, and narrative flow. Preserve paragraph breaks. Do not add notes, explanations, or markdown. Output only the condensed text.";
  }
  return "";
}

// How many chunks to send to Claude at once. Parallelism keeps long books
// within the function time limit; balanced against API rate limits.
const CONCURRENCY = 12;

/** Run `fn` over items with a concurrency cap, preserving input order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

/**
 * Transform the text per the chosen options: translate EN→ES and/or condense to
 * ~50%. When neither is selected, the text is returned unchanged (no LLM call).
 * Chunks are processed in parallel (bounded) so long books finish in time.
 */
export async function transformText(
  client: Anthropic,
  fullText: string,
  opts: TransformOpts,
): Promise<string> {
  if (!opts.translate && !opts.summarize) return fullText;

  const system = systemPromptFor(opts);
  const chunks = chunkText(fullText);

  const out = await mapLimit(chunks, CONCURRENCY, async (chunk) => {
    const message = await client.messages.create({
      model: TRANSLATION_MODEL,
      max_tokens: 8192,
      system,
      messages: [{ role: "user", content: chunk }],
    });
    return message.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
  });

  return out.join("\n\n");
}

/**
 * Translate a book title EN→ES. Returns only the translated title. Falls back
 * to the input if the model returns nothing.
 */
export async function translateTitle(
  client: Anthropic,
  title: string,
): Promise<string> {
  if (!title.trim()) return title;

  const message = await client.messages.create({
    model: TRANSLATION_MODEL,
    max_tokens: 200,
    system:
      "Traducí el título de libro del inglés al español. Devolvé SOLO el título traducido, sin comillas, sin explicaciones ni texto extra. Si ya está en español o es un nombre propio, devolvelo tal cual.",
    messages: [{ role: "user", content: title }],
  });

  const out = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  return out || title;
}
