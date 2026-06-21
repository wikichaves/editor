"use client";

import * as React from "react";
import { Loader2, FileDown, CheckCircle2, AlertCircle } from "lucide-react";
import { Dropzone } from "@/components/dropzone";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type Status = "idle" | "processing" | "done" | "error";

export default function Home() {
  const [status, setStatus] = React.useState<Status>("idle");
  const [fileName, setFileName] = React.useState<string>("");
  const [error, setError] = React.useState<string>("");

  async function handleFile(file: File) {
    setFileName(file.name);
    setError("");
    setStatus("processing");

    try {
      const body = new FormData();
      body.append("file", file);

      const res = await fetch("/api/convert", { method: "POST", body });

      if (!res.ok) {
        let message = "Algo salió mal al convertir el PDF.";
        try {
          const data = await res.json();
          if (data?.error) message = data.error;
        } catch {
          // non-JSON error body; keep default message
        }
        setError(message);
        setStatus("error");
        return;
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.name.replace(/\.pdf$/i, "") + ".epub";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      setStatus("done");
    } catch {
      setError("No se pudo conectar con el servidor.");
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
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-4 py-12">
      <Card>
        <CardHeader>
          <CardTitle>PDF → ePub en español</CardTitle>
          <CardDescription>
            Subí un PDF en inglés (con texto) y descargá un ePub traducido al
            español. La salida no incluye imágenes.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {status === "idle" && (
            <Dropzone onFile={handleFile} onReject={handleReject} />
          )}

          {status === "processing" && (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-[var(--border)] px-6 py-14 text-center">
              <Loader2 className="size-8 animate-spin text-[var(--muted-foreground)]" />
              <div className="space-y-1">
                <p className="text-sm font-medium">Procesando…</p>
                <p className="text-xs text-[var(--muted-foreground)]">
                  Extrayendo el texto, traduciendo y armando el ePub. Esto puede
                  tardar según el tamaño del PDF.
                </p>
                <p className="truncate text-xs text-[var(--muted-foreground)]">
                  {fileName}
                </p>
              </div>
            </div>
          )}

          {status === "done" && (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-[var(--border)] px-6 py-14 text-center">
              <CheckCircle2 className="size-8 text-green-600" />
              <div className="space-y-1">
                <p className="text-sm font-medium">¡Listo!</p>
                <p className="text-xs text-[var(--muted-foreground)]">
                  La descarga del .epub debería haber empezado.
                </p>
              </div>
              <Button onClick={reset} variant="outline" size="sm">
                <FileDown className="size-4" /> Convertir otro
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
