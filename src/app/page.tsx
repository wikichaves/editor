"use client";

import * as React from "react";
import { upload } from "@vercel/blob/client";
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

interface ConvertResult {
  title: string;
  downloadUrl: string;
  emailed: boolean;
  emailError?: string;
}

export default function Home() {
  const [status, setStatus] = React.useState<Status>("idle");
  const [fileName, setFileName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [error, setError] = React.useState("");
  const [progress, setProgress] = React.useState(0);
  const [result, setResult] = React.useState<ConvertResult | null>(null);

  async function handleFile(file: File) {
    setFileName(file.name);
    setError("");
    setResult(null);
    setProgress(0);

    try {
      // 1. Upload straight to Blob (skips the 4.5 MB serverless limit).
      setStatus("uploading");
      const blob = await upload(file.name, file, {
        access: "public",
        handleUploadUrl: "/api/upload",
        contentType: file.type || "application/octet-stream",
        multipart: true, // split into parts + retry — helps on slow connections
        onUploadProgress: (e) => setProgress(Math.round(e.percentage)),
      });

      // 2. Convert (extract → translate → build → store → email).
      setStatus("processing");
      const res = await fetch("/api/convert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          blobUrl: blob.url,
          filename: file.name,
          email: email.trim() || undefined,
        }),
      });

      if (!res.ok) {
        let message = "Algo salió mal al convertir el archivo.";
        try {
          const data = await res.json();
          if (data?.error) message = data.error;
        } catch {
          // keep default
        }
        setError(message);
        setStatus("error");
        return;
      }

      const data: ConvertResult = await res.json();
      setResult(data);
      setStatus("done");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "No se pudo conectar con el servidor.",
      );
      setStatus("error");
    }
  }

  function handleReject(message: string) {
    setFileName("");
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
          <CardTitle>PDF · EPUB · AZW3 → ePub en español</CardTitle>
          <CardDescription>
            Subí un PDF, EPUB o AZW3 en inglés (con texto) y descargá un ePub
            traducido al español. La salida no incluye imágenes.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {status === "idle" && (
            <>
              <label className="block space-y-1.5">
                <span className="text-sm font-medium">
                  Email (opcional) — te mandamos el ePub
                </span>
                <input
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  placeholder="vos@ejemplo.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-lg border border-[var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--primary)]"
                />
              </label>
              <Dropzone onFile={handleFile} onReject={handleReject} />
            </>
          )}

          {busy && (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-[var(--border)] px-6 py-14 text-center">
              <Loader2 className="size-8 animate-spin text-[var(--muted-foreground)]" />
              <div className="w-full space-y-1">
                <p className="text-sm font-medium">
                  {status === "uploading" ? `Subiendo… ${progress}%` : "Procesando…"}
                </p>
                {status === "uploading" && (
                  <div className="mx-auto mt-2 h-2 w-full max-w-xs overflow-hidden rounded-full bg-[var(--muted)]">
                    <div
                      className="h-full rounded-full bg-[var(--primary)] transition-[width] duration-200"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                )}
                <p className="text-xs text-[var(--muted-foreground)]">
                  {status === "uploading"
                    ? "Subiendo el archivo al almacenamiento."
                    : "Extrayendo el texto, traduciendo y armando el ePub. Puede tardar según el tamaño."}
                </p>
                <p className="truncate text-xs text-[var(--muted-foreground)]">
                  {fileName}
                </p>
              </div>
            </div>
          )}

          {status === "done" && result && (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-[var(--border)] px-6 py-12 text-center">
              <CheckCircle2 className="size-8 text-green-600" />
              <div className="space-y-1">
                <p className="text-sm font-medium">¡Listo!</p>
                {result.emailed && (
                  <p className="flex items-center justify-center gap-1.5 text-xs text-[var(--muted-foreground)]">
                    <Mail className="size-3.5" /> Te lo enviamos por email.
                  </p>
                )}
                {!result.emailed && result.emailError && (
                  <p className="text-xs text-amber-600">
                    No se pudo enviar el email ({result.emailError}). Usá la
                    descarga.
                  </p>
                )}
              </div>
              <a href={result.downloadUrl} download>
                <Button size="sm">
                  <FileDown className="size-4" /> Descargar .epub
                </Button>
              </a>
              <Button onClick={reset} variant="outline" size="sm">
                Convertir otro
              </Button>
            </div>
          )}

          {status === "error" && (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-red-300 bg-red-50 px-6 py-14 text-center dark:bg-red-950/30">
              <AlertCircle className="size-8 text-red-600" />
              <div className="space-y-1">
                <p className="text-sm font-medium">No se pudo convertir</p>
                <p className="text-xs text-[var(--muted-foreground)]">{error}</p>
              </div>
              <Button onClick={reset} variant="outline" size="sm">
                Probar de nuevo
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="mt-4 text-center text-xs text-[var(--muted-foreground)]">
        Traducción con Anthropic Claude · Sin OCR · Sin imágenes
      </p>
    </main>
  );
}
