import { Resend } from "resend";

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
  const from = process.env.EMAIL_FROM || "Tero ePub <onboarding@resend.dev>";

  const { error } = await resend.emails.send({
    from,
    to: opts.to,
    subject: `Tu ePub en español: ${opts.title}`,
    text: `Adjuntamos "${opts.title}.epub", traducido al español.\n\nGenerado automáticamente (EN→ES).`,
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

/** Notify the user by email that their conversion failed (best-effort). */
export async function emailFailure(to: string, detail: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return;

  const resend = new Resend(apiKey);
  const from = process.env.EMAIL_FROM || "Tero ePub <onboarding@resend.dev>";

  await resend.emails.send({
    from,
    to,
    subject: "No pudimos convertir tu archivo",
    text: `Hubo un problema al convertir tu archivo:\n\n${detail}\n\nProbá de nuevo o con otro archivo.`,
  });
}
