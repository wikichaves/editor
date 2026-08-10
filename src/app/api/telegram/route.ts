import { NextRequest, NextResponse, after } from "next/server";
import { detectKind } from "@/lib/extract";
import { buildEpubJob } from "@/lib/job";
import { emailEpub } from "@/lib/email";

// Same constraints as /api/convert: Node.js runtime, long budget for OCR + LLM.
export const runtime = "nodejs";
export const maxDuration = 800;

/**
 * The Bot API only serves downloads for files up to 20 MB. Bigger books have to
 * go through the web uploader, which chunks them into Blob instead.
 */
const MAX_TELEGRAM_FILE = 20 * 1024 * 1024;

/** Telegram retries any non-2xx, so failures are reported in-chat, not by status. */
const OK = NextResponse.json({ ok: true });

interface TgDocument {
  file_id: string;
  file_name?: string;
  file_size?: number;
}

interface TgUpdate {
  message?: {
    chat: { id: number };
    from?: { id: number };
    text?: string;
    document?: TgDocument;
  };
}

function api(method: string): string {
  return `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`;
}

async function send(chatId: number, text: string): Promise<void> {
  try {
    await fetch(api("sendMessage"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (err) {
    console.error(`telegram: sendMessage failed: ${err}`);
  }
}

/** Resolve a file_id to its bytes via getFile + the file download endpoint. */
async function download(fileId: string): Promise<Uint8Array> {
  const res = await fetch(`${api("getFile")}?file_id=${encodeURIComponent(fileId)}`);
  const body = (await res.json()) as { ok: boolean; result?: { file_path?: string } };
  const path = body.result?.file_path;
  if (!body.ok || !path) throw new Error("Telegram no devolvió el archivo.");

  const file = await fetch(
    `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${path}`,
  );
  if (!file.ok) throw new Error(`descarga falló (${file.status})`);
  return new Uint8Array(await file.arrayBuffer());
}

export async function POST(req: NextRequest) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const kindle = process.env.TELEGRAM_KINDLE_EMAIL?.trim();
  if (!token || !secret || !kindle) {
    console.error("telegram: faltan TELEGRAM_BOT_TOKEN / _WEBHOOK_SECRET / _KINDLE_EMAIL");
    return OK;
  }

  // Anyone can find the bot and guess this path; the shared secret is what
  // proves the request actually came from the webhook we registered.
  if (req.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return new NextResponse("forbidden", { status: 403 });
  }

  let update: TgUpdate;
  try {
    update = (await req.json()) as TgUpdate;
  } catch {
    return OK;
  }

  const msg = update.message;
  if (!msg) return OK;
  const chatId = msg.chat.id;

  // Second gate: even with the secret, only the owner may spend Claude credits.
  const allowed = (process.env.TELEGRAM_ALLOWED_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!msg.from || !allowed.includes(String(msg.from.id))) {
    console.warn(`telegram: rechazado from=${msg.from?.id ?? "?"}`);
    await send(chatId, "Este bot es privado.");
    return OK;
  }

  const doc = msg.document;
  if (!doc) {
    await send(
      chatId,
      msg.text?.startsWith("/start")
        ? "Mandame un libro (PDF, EPUB o AZW3) y te lo simplifico para chicos. Te llega al Kindle cuando esté."
        : "Mandámelo como archivo (PDF, EPUB o AZW3).",
    );
    return OK;
  }

  if ((doc.file_size ?? 0) > MAX_TELEGRAM_FILE) {
    await send(
      chatId,
      "Ese archivo pasa los 20 MB, que es lo máximo que Telegram me deja descargar. Ese tenés que subirlo por la web.",
    );
    return OK;
  }

  await send(chatId, "Recibido. Lo estoy convirtiendo — te aviso cuando salga.");

  // Telegram needs its 200 now; the conversion takes minutes.
  after(async () => {
    const name = doc.file_name;
    try {
      const data = await download(doc.file_id);
      if (!detectKind(data)) {
        await send(chatId, "No reconozco ese formato. Tiene que ser PDF, EPUB o AZW3.");
        return;
      }
      const { title, epub } = await buildEpubJob(data, name, {
        translate: true,
        summarize: false,
        simplify: true,
      });
      await emailEpub({ to: kindle, title, epub });
      console.log(`telegram: sent "${title}" (${epub.length} bytes) to ${kindle}`);
      await send(chatId, `Listo: "${title}" va camino a tu Kindle.`);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "No se pudo convertir el archivo.";
      console.error(`telegram: job failed for ${name ?? "?"}: ${message}`);
      await send(chatId, `No pude convertirlo: ${message}`);
    }
  });

  return OK;
}
