"use client";

import * as React from "react";
import { UploadCloud } from "lucide-react";
import { cn } from "@/lib/utils";

interface DropzoneProps {
  onFile: (file: File) => void;
  onReject?: (message: string) => void;
  disabled?: boolean;
}

export function Dropzone({ onFile, onReject, disabled }: DropzoneProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = React.useState(false);

  function pick(file: File | undefined | null) {
    if (!file) return;
    // Accept by extension OR MIME type. Many mobile file pickers report an
    // empty type, so when the type is unknown we let the server decide (it
    // checks the file's magic bytes). Only reject when it's clearly wrong.
    const name = file.name.toLowerCase();
    const looksSupported =
      /\.(pdf|epub|azw3|azw|mobi)$/.test(name) ||
      file.type === "application/pdf" ||
      file.type === "application/epub+zip" ||
      file.type === "application/x-mobipocket-ebook" ||
      file.type === "";
    if (!looksSupported) {
      onReject?.(
        `"${file.name}" no es un formato soportado. Subí un PDF, EPUB o AZW3 con texto.`,
      );
      return;
    }
    onFile(file);
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-disabled={disabled}
      onClick={() => !disabled && inputRef.current?.click()}
      onKeyDown={(e) => {
        if (!disabled && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (!disabled) pick(e.dataTransfer.files?.[0]);
      }}
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-14 text-center transition-colors",
        dragging
          ? "border-[var(--primary)] bg-[var(--muted)]"
          : "border-[var(--border)]",
        disabled
          ? "cursor-not-allowed opacity-60"
          : "cursor-pointer hover:bg-[var(--muted)]",
      )}
    >
      <UploadCloud className="size-8 text-[var(--muted-foreground)]" />
      <div className="space-y-1">
        <p className="text-base font-medium">
          Arrastrá el libro acá o hacé clic para elegir
        </p>
        <p className="text-sm text-[var(--muted-foreground)]">
          PDF (incluso escaneado), EPUB o AZW3.
        </p>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.epub,.azw3,.azw,.mobi,application/pdf,application/epub+zip,application/x-mobipocket-ebook"
        className="hidden"
        disabled={disabled}
        onChange={(e) => {
          pick(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
}
