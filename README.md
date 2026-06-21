# PDF · EPUB · AZW3 → ePub (Español)

App web personal que convierte un libro **en inglés** (con capa de texto) en un
**ePub en español**, sin imágenes. Acepta **PDF**, **EPUB** y **AZW3** como
entrada — no soporta OCR ni archivos escaneados.

## Cómo funciona

1. Subís un `.pdf`, `.epub` o `.azw3` en el dropzone.
2. El endpoint `POST /api/convert` detecta el formato por sus *magic bytes* (no
   por la extensión) y extrae el texto según corresponda:
   - **PDF** con [`unpdf`](https://github.com/unjs/unpdf).
   - **EPUB** descomprimiendo el ZIP y leyendo el XHTML en orden del *spine*
     (con [`jszip`](https://stuk.github.io/jszip/)).
   - **AZW3/MOBI** con un parser propio *best-effort* (PDB + PalmDOC). DRM y
     compresión HUFF/CDIC se rechazan con un mensaje claro.
3. Trocea el texto en bloques de ~3500 caracteres respetando los saltos de
   párrafo, traduce cada bloque EN→ES con la API de Anthropic
   (`claude-sonnet-4-6`) y arma el ePub en memoria con
   [`epub-gen-memory`](https://github.com/cpiber/epub-gen-memory).
4. El navegador descarga el `.epub` resultante.

Todo corre en el runtime **Node.js** (no Edge) y el ePub se genera **en
memoria** — nunca se escribe a disco, así anda en serverless (Vercel).

## Stack

- Next.js 15 (App Router) + React 19 + TypeScript
- Tailwind v4 + componentes estilo shadcn/ui
- `@anthropic-ai/sdk`, `unpdf`, `jszip`, `epub-gen-memory`

## Setup local

```bash
npm install
cp .env.example .env.local   # y completá ANTHROPIC_API_KEY
npm run dev
```

Abrí http://localhost:3000.

### Variables de entorno

| Variable                | Requerida | Descripción                                                       |
| ----------------------- | --------- | ----------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`     | sí        | API key de Anthropic. https://console.anthropic.com/              |
| `BLOB_READ_WRITE_TOKEN` | sí        | Token de Vercel Blob. Se auto-setea al conectar un Blob store.    |
| `RESEND_API_KEY`        | no        | Solo si querés enviar el ePub por email. https://resend.com/      |
| `EMAIL_FROM`            | no        | Remitente. Sin dominio verificado, Resend solo entrega al dueño de la cuenta. |

Sin `ANTHROPIC_API_KEY` la traducción falla (500). Sin `BLOB_READ_WRITE_TOKEN`
fallan la subida y el guardado del resultado.

### Por qué Vercel Blob

Las funciones serverless de Vercel limitan el cuerpo del request a **4.5 MB**.
Para soportar libros más grandes, el navegador sube el archivo **directo a
Blob** (`/api/upload` emite el token) y `/api/convert` lo procesa desde la URL
del blob. El ePub resultante también se guarda en Blob para tener una URL de
descarga estable (útil en celular, donde la descarga vía JS suele fallar).

## Deploy en Vercel

1. Subí el repo a GitHub (privado).
2. En Vercel: **Add New… → Project → Import** el repo.
3. Framework: Next.js (autodetectado). No hace falta tocar build settings.
4. **Conectá un Blob store:** en **Storage → Create → Blob**, conectalo al
   proyecto. Eso agrega `BLOB_READ_WRITE_TOKEN` automáticamente.
5. **⚠️ Variables de entorno** (**Settings → Environment Variables**, Production):
   - `ANTHROPIC_API_KEY` (obligatoria; sin ella el deploy compila pero falla al convertir).
   - `RESEND_API_KEY` (opcional, para email). Tip: registrate en Resend con la
     casilla a la que querés que lleguen los envíos; así el remitente de prueba
     `onboarding@resend.dev` puede entregarte sin verificar un dominio.
6. Deploy.

### Sobre el límite de tiempo

El handler declara `maxDuration = 60` (segundos), el máximo del plan Hobby.
Si tenés Pro / Fluid Compute, podés subirlo hasta `300` en
`src/app/api/convert/route.ts` para PDFs más largos.

## Cambiar el modelo de traducción

En `src/lib/translate.ts`, la constante `TRANSLATION_MODEL`. Alternativa más
barata: `claude-haiku-4-5-20251001`.

## Sobre AZW3 (best-effort)

El parser de AZW3/MOBI cubre la mayoría de los archivos (sin comprimir y
PalmDOC), pero **no** soporta DRM ni compresión HUFF/CDIC. Si un AZW3 falla,
convertilo antes a EPUB con [Calibre](https://calibre-ebook.com/) y subí ese.

## Fuera de alcance

Sin auth, sin base de datos, sin OCR, sin extracción/embebido de imágenes y sin
reconstrucción de layouts complejos (columnas, tablas, fórmulas).
