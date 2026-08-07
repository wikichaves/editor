"use client";

import * as React from "react";
import { Loader2, FileDown, CheckCircle2, AlertCircle, Mail } from "lucide-react";
import { Dropzone } from "@/components/dropzone";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type Status = "idle" | "uploading" | "processing" | "done" | "error";

/** Above this size a conversion takes long enough that we require an email. */
const SLOW_JOB_BYTES = 1024 * 1024;

interface ConvertResult {
  title?: string;
  downloadUrl?: string;
  async?: boolean;
  email?: string;
}

export default function Home() {
  const [status, setStatus] = React.useState<Status>("idle");
  const [fileName, setFileName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [error, setError] = React.useState("");
  const [errorTitle, setErrorTitle] = React.useState("No se pudo convertir");
  const [progress, setProgress] = React.useState(0);
  const [result, setResult] = React.useState<ConvertResult | null>(null);
  const [translate, setTranslate] = React.useState(true);
  const [summarize, setSummarize] = React.useState(false);
  const [simplify, setSimplify] = React.useState(false);

  // Prefill the recipient from `?email=…` and remember it locally, so you can
  // bookmark the URL once (e.g. …/?email=tu@kindle.com) and it stays filled in
  // on later visits. Nothing personal is baked into the code.
  const REMEMBERED_EMAIL_KEY = "editor:email";
  React.useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("email");
    if (fromUrl) {
      setEmail(fromUrl);
      try {
        localStorage.setItem(REMEMBERED_EMAIL_KEY, fromUrl);
      } catch {
        // private mode / storage disabled — the URL still works
      }
      return;
    }
    try {
      const saved = localStorage.getItem(REMEMBERED_EMAIL_KEY);
      if (saved) setEmail(saved);
    } catch {
      // ignore
    }
  }, []);

  async function handleFile(file: File) {
    const wantsEmail = email.trim().length > 0;
    // Without an email we hold the browser connection open for the whole
    // conversion. That's fine for a quick job, but a big book (or the
    // multi-pass child retelling) takes minutes and just looks hung — so ask
    // for an address and deliver it in the background instead.
    if (!wantsEmail && (simplify || file.size > SLOW_JOB_BYTES)) {
      setFileName("");
      setErrorTitle("Necesitamos tu email");
      setError(
        simplify
          ? "Para simplificar un libro necesitamos tu email: tarda varios minutos y te lo mandamos cuando esté listo."
          : "Este archivo es grande y va a tardar varios minutos. Dejanos tu email y te mandamos el ePub cuando esté listo.",
      );
      setStatus("error");
      return;
    }

    setFileName(file.name);
    setError("");
    setResult(null);
    setProgress(0);

    try {
      // Small files (< 4.5 MB request limit) POST directly. Larger files are
      // sent in chunks straight to the function (/api/chunk) — the only upload
      // channel that proved reliable — then assembled server-side.
      const CHUNK = 4 * 1024 * 1024;
      let res: Response;

      if (file.size <= CHUNK) {
        setStatus("processing");
        const fd = new FormData();
        fd.append("file", file);
        if (wantsEmail) fd.append("email", email.trim());
        fd.append("translate", String(translate));
        fd.append("summarize", String(summarize));
        fd.append("simplify", String(simplify));
        res = await fetch("/api/convert", { method: "POST", body: fd });
      } else {
        setStatus("uploading");
        const uploadId = crypto.randomUUID().replace(/-/g, "");
        const total = Math.ceil(file.size / CHUNK);
        for (let i = 0; i < total; i++) {
          const part = file.slice(i * CHUNK, (i + 1) * CHUNK);
          const r = await fetch(`/api/chunk?id=${uploadId}&i=${i}`, {
            method: "POST",
            body: part,
          });
          if (!r.ok) throw new Error("Falló la subida de un fragmento. Reintentá.");
          setProgress(Math.round(((i + 1) / total) * 100));
        }
        setStatus("processing");
        res = await fetch("/api/convert", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            uploadId,
            filename: file.name,
            email: wantsEmail ? email.trim() : undefined,
            translate,
            summarize,
            simplify,
          }),
        });
      }

      if (!res.ok) {
        let message = "Algo salió mal al convertir el archivo.";
        try {
          const data = await res.json();
          if (data?.error) message = data.error;
        } catch {
          // keep default
        }
        setErrorTitle("No se pudo convertir");
        setError(message);
        setStatus("error");
        return;
      }

      const ct = res.headers.get("content-type") || "";
      if (ct.includes("application/epub+zip")) {
        // Synchronous (no email): the ePub comes back in the response body.
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = file.name.replace(/\.(pdf|epub|azw3|azw|mobi)$/i, "") + ".epub";
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        setResult({ async: false });
      } else {
        const data: ConvertResult = await res.json();
        setResult(data);
      }
      setStatus("done");
    } catch (err) {
      setErrorTitle("No se pudo convertir");
      setError(
        err instanceof Error ? err.message : "No se pudo conectar con el servidor.",
      );
      setStatus("error");
    }
  }

  function handleReject(message: string) {
    setFileName("");
    setErrorTitle("No se pudo convertir");
    setError(message);
    setStatus("error");
  }

  function reset() {
    setStatus("idle");
    setFileName("");
    setError("");
    setProgress(0);
    setResult(null);
  }

  const busy = status === "uploading" || status === "processing";

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-4 py-12">
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">PDF · EPUB · AZW3 → ePub</CardTitle>
          <CardDescription className="text-base">
            Convertí un libro a ePub, traducido al español si querés.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {status === "idle" && (
            <>
              <label className="block space-y-1.5">
                <span className="text-base font-medium">
                  Email {simplify && <span className="font-normal text-[var(--muted-foreground)]">(necesario)</span>}
                </span>
                <span className="block text-sm font-normal text-[var(--muted-foreground)]">
                  Te lo mandamos cuando esté listo. Con una dirección @kindle.com
                  llega directo al Kindle.
                </span>
                <input
                  type="email"
                  inputMode="email"
                  // Keep the browser / password managers from silently filling a
                  // saved address: the recipient should only come from ?email=,
                  // the remembered value, or what you type.
                  autoComplete="off"
                  data-1p-ignore
                  data-lpignore="true"
                  name="recipient"
                  placeholder="vos@ejemplo.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-lg border border-[var(--border)] bg-transparent px-3 py-2.5 text-base outline-none focus:border-[var(--primary)]"
                />
              </label>

              <div
                className={`space-y-2 rounded-lg border border-[var(--border)] px-3 py-3 transition-opacity ${
                  simplify ? "opacity-50" : ""
                }`}
              >
                <label className="flex items-start gap-2.5">
                  <input
                    type="checkbox"
                    checked={translate}
                    disabled={simplify}
                    onChange={(e) => setTranslate(e.target.checked)}
                    className="mt-0.5 size-4"
                  />
                  <span className="space-y-0.5">
                    <span className="block text-base font-medium">
                      Traducir al español
                    </span>
                    <span className="block text-sm text-[var(--muted-foreground)]">
                      Si no, queda en el idioma original.
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-2.5">
                  <input
                    type="checkbox"
                    checked={summarize}
                    disabled={simplify}
                    onChange={(e) => setSummarize(e.target.checked)}
                    className="mt-0.5 size-4"
                  />
                  <span className="space-y-0.5">
                    <span className="block text-base font-medium">Resumir</span>
                    <span className="block text-sm text-[var(--muted-foreground)]">
                      Lo acorta a la mitad.
                    </span>
                  </span>
                </label>
              </div>

              <label className="flex items-start gap-2.5 rounded-lg border border-[var(--primary)]/40 bg-[var(--primary)]/5 px-3 py-3">
                <input
                  type="checkbox"
                  checked={simplify}
                  onChange={(e) => setSimplify(e.target.checked)}
                  className="mt-0.5 size-4"
                />
                <span className="space-y-0.5">
                  <span className="block text-base font-medium">
                    Simplificar para chicos (5-7 años) 🧸
                  </span>
                  <span className="block text-sm text-[var(--muted-foreground)]">
                    Lo recuenta como cuento para leer en voz alta, en capítulos de
                    ~20 min: uno por noche.
                  </span>
                </span>
              </label>

              <Dropzone onFile={handleFile} onReject={handleReject} />
            </>
          )}

          {busy && (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-[var(--border)] px-6 py-14 text-center">
              <Loader2 className="size-8 animate-spin text-[var(--muted-foreground)]" />
              <div className="w-full space-y-1">
                <p className="text-base font-medium">
                  {status === "uploading" && progress < 100
                    ? `Subiendo… ${progress}%`
                    : "Procesando…"}
                </p>
                {status === "uploading" && progress < 100 && (
                  <div className="mx-auto mt-2 h-2 w-full max-w-xs overflow-hidden rounded-full bg-[var(--muted)]">
                    <div
                      className="h-full rounded-full bg-[var(--primary)] transition-[width] duration-200"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                )}
                <p className="text-sm text-[var(--muted-foreground)]">
                  {status === "uploading" && progress < 100
                    ? "Subiendo el archivo."
                    : "Puede tardar unos minutos."}
                </p>
                <p className="truncate text-sm text-[var(--muted-foreground)]">
                  {fileName}
                </p>
              </div>
            </div>
          )}

          {status === "done" && result && (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-[var(--border)] px-6 py-12 text-center">
              <CheckCircle2 className="size-8 text-green-600" />
              {result.async ? (
                <>
                  <div className="space-y-1">
                    <p className="text-base font-medium">¡Recibido!</p>
                    <p className="flex items-center justify-center gap-1.5 text-sm text-[var(--muted-foreground)]">
                      <Mail className="size-4" /> Te llega a {result.email} en unos
                      minutos.
                    </p>
                    <p className="text-sm text-[var(--muted-foreground)]">
                      Ya podés cerrar esta página.
                    </p>
                  </div>
                  <Button onClick={reset} variant="outline" size="sm">
                    Convertir otro
                  </Button>
                </>
              ) : (
                <>
                  <div className="space-y-1">
                    <p className="text-base font-medium">¡Listo!</p>
                    <p className="text-sm text-[var(--muted-foreground)]">
                      La descarga debería empezar sola.
                    </p>
                  </div>
                  {result.downloadUrl && (
                    <a href={result.downloadUrl} download>
                      <Button size="sm">
                        <FileDown className="size-4" /> Descargar .epub
                      </Button>
                    </a>
                  )}
                  <Button onClick={reset} variant="outline" size="sm">
                    Convertir otro
                  </Button>
                </>
              )}
            </div>
          )}

          {status === "error" && (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-red-300 bg-red-50 px-6 py-14 text-center dark:bg-red-950/30">
              <AlertCircle className="size-8 text-red-600" />
              <div className="space-y-1">
                <p className="text-base font-medium">{errorTitle}</p>
                <p className="text-sm text-[var(--muted-foreground)]">{error}</p>
              </div>
              <Button onClick={reset} variant="outline" size="sm">
                Probar de nuevo
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="mt-4 text-center text-sm text-[var(--muted-foreground)]">
        Con Claude · OCR para escaneados · Sin imágenes
      </p>
      <p className="mt-1 text-center text-xs text-[var(--muted-foreground)]/70">
        {process.env.NEXT_PUBLIC_APP_VERSION ?? "v?"}
      </p>
    </main>
  );
}
