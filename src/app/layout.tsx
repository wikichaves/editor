import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Wiki Editor",
  description: "Simplificá un libro para tu hijo, en español.",
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
