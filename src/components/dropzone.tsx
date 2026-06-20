"use client";

import * as React from "react";
import { UploadCloud } from "lucide-react";
import { cn } from "@/lib/utils";

interface DropzoneProps {
  onFile: (file: File) => void;
  disabled?: boolean;
}

export function Dropzone({ onFile, disabled }: DropzoneProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = React.useState(false);

  function pick(file: File | undefined | null) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".pdf")) return;
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
        <p className="text-sm font-medium">
          Arrastrá un PDF acá o hacé clic para elegir
        </p>
        <p className="text-xs text-[var(--muted-foreground)]">
          Solo PDFs con texto (no escaneados). Sin imágenes en la salida.
        </p>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
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
