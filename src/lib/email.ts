import { Resend } from "resend";

const DEFAULT_FROM = "Wiki Editor <onboarding@resend.dev>";

/**
 * Optional archive address. Every generated ePub is copied here, which doubles
 * as a personal library and as confirmation that a book was produced. It also
 * matters for failures: when the recipient is a @kindle.com address, Amazon
 * silently drops anything that isn't a document, so an error notice sent only
 * there would never be seen.
 */
function archiveAddress(to: string): string | null {
  const archive = process.env.EMAIL_ARCHIVE?.trim();
  if (!archive) return null;
  // Don't duplicate when the archive is already the recipient.
  return archive.toLowerCase() === to.trim().toLowerCase() ? null : archive;
}

/**
 * Email the generated ePub as an attachment via Resend.
 *
 * Requires RESEND_API_KEY. The "from" address defaults to Resend's shared
 * onboarding sender, which (without a verified domain) only delivers to the
 * email of the Resend account owner — set EMAIL_FROM to a verified address to
 * send anywhere.
 */
export async function emailEpub(opts: {
  to: string;
  title: string;
  epub: Buffer;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("Falta RESEND_API_KEY en el servidor.");

  const resend = new Resend(apiKey);
  const from = process.env.EMAIL_FROM || DEFAULT_FROM;
  const archive = archiveAddress(opts.to);

  const { error } = await resend.emails.send({
    from,
    to: opts.to,
    ...(archive ? { bcc: archive } : {}),
    subject: `Tu ePub: ${opts.title}`,
    text: `Adjuntamos "${opts.title}.epub".\n\nGenerado automáticamente.`,
    attachments: [
      {
        filename: `${opts.title}.epub`,
        content: opts.epub,
      },
    ],
  });

  if (error) {
    throw new Error(`No se pudo enviar el email: ${error.message}`);
  }
}

/**
 * Notify the user by email that their conversion failed (best-effort).
 * Copied to the archive address so a failure is visible even when the
 * recipient is a Kindle address that discards non-document mail.
 */
export async function emailFailure(to: string, detail: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return;

  const resend = new Resend(apiKey);
  const from = process.env.EMAIL_FROM || DEFAULT_FROM;
  const archive = archiveAddress(to);

  await resend.emails.send({
    from,
    // Send *to* the archive as well (not bcc): this is the copy that actually
    // gets read when the primary recipient is a Kindle address.
    to: archive ? [to, archive] : to,
    subject: "No pudimos convertir tu archivo",
    text: `Hubo un problema al convertir tu archivo:\n\n${detail}\n\nProbá de nuevo o con otro archivo.`,
  });
}
