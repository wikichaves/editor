import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PDF → ePub (Español)",
  description: "Convertí un PDF en inglés a un ePub en español, sin imágenes.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
