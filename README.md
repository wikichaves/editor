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

| Variable            | Descripción                                                  |
| ------------------- | ------------------------------------------------------------ |
| `ANTHROPIC_API_KEY` | API key de Anthropic. Conseguila en https://console.anthropic.com/ |

Sin esta variable, la traducción falla en runtime (el endpoint devuelve 500).

## Deploy en Vercel

1. Subí el repo a GitHub (privado).
2. En Vercel: **Add New… → Project → Import** el repo.
3. Framework: Next.js (autodetectado). No hace falta tocar build settings.
4. **⚠️ Importante:** en **Settings → Environment Variables** agregá
   `ANTHROPIC_API_KEY` con tu key, para los entornos Production (y Preview si
   querés). **Si no la seteás, el deploy compila pero falla en runtime** cuando
   intentás convertir un PDF.
5. Deploy.

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
