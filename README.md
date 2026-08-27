# Wiki Editor — PDF · EPUB · AZW3 → ePub

App web que convierte un libro (**PDF**, **EPUB** o **AZW3**) en un **ePub**
listo para leer en un e-reader. Opcionalmente lo **traduce al español**, lo
**resume**, o lo **recuenta como cuento para chicos de 5-7 años**. Puede
enviarte el resultado por email — incluso directo a tu Kindle.

La salida es solo texto: capítulos con índice navegable y una tapa, sin las
imágenes del interior.

## Qué hace

Al subir un archivo, `POST /api/convert` detecta el formato por sus *magic
bytes* (no por la extensión) y extrae el texto:

- **PDF** con [`unpdf`](https://github.com/unjs/unpdf). Si no tiene capa de
  texto (escaneado), cae a **OCR** (ver abajo).
- **EPUB** descomprimiendo el ZIP y leyendo el XHTML en orden del *spine*
  (con [`jszip`](https://stuk.github.io/jszip/)).
- **AZW3/MOBI** con un parser propio *best-effort* (PDB + PalmDOC). DRM y
  compresión HUFF/CDIC se rechazan con un mensaje claro.

Después aplica el modo elegido y arma el ePub en memoria con
[`epub-gen-memory`](https://github.com/cpiber/epub-gen-memory).

### Modos

| Modo | Qué hace |
| --- | --- |
| **Traducir al español** (por defecto) | Traduce EN→ES por bloques de ~3500 caracteres, en paralelo. |
| **Resumir** | Condensa el contenido a ~50%, conservando lo esencial. |
| **Simplificar para chicos (5-7 años)** | Recuenta el libro entero como cuento para leer en voz alta. Reemplaza a los dos anteriores. |

El modo **simplificar** no es un resumen por partes: primero *entiende el libro
completo* (resumen map-reduce → sinopsis), después *planifica* entre 5 y 10
capítulos de ~20 minutos de lectura en voz alta, y recién ahí *escribe* cada
uno. Es fiel a la trama y los personajes, en **español rioplatense**, con
lenguaje simple pero rico; los momentos difíciles se cuentan con delicadeza en
lugar de omitirse. Ver `src/lib/retell.ts`.

### Tapas

Cada libro recibe una tapa, en este orden de preferencia:

1. La tapa original del **EPUB** (vía el OPF: `meta name="cover"`,
   `properties="cover-image"` o un archivo que se llame *cover*).
2. La imagen más prominente de las primeras páginas del **PDF**.
3. Si no hay ninguna: una **tapa tipográfica generada** con el título, en un
   tono derivado del propio título para que dos libros no se vean iguales.

Todas pasan por el mismo filtro: escala de grises, contraste suave para e-ink y
redimensionado a 600×800 (ver `src/lib/cover.ts`).

Todo corre en el runtime **Node.js** (no Edge) y el ePub se genera **en
memoria** — nunca se escribe a disco, así funciona en serverless.

## Stack

- Next.js 15 (App Router) + React 19 + TypeScript
- Tailwind v4 + componentes estilo shadcn/ui
- `openai`, `unpdf`, `jszip`, `pdf-lib`, `sharp`,
  `epub-gen-memory`, `@vercel/blob`, `resend`

## Setup local

```bash
npm install
cp .env.example .env.local   # y completá OPENAI_API_KEY
npm run dev
```

Abrí http://localhost:3000.

### Variables de entorno

| Variable | Requerida | Descripción |
| --- | --- | --- |
| `OPENAI_API_KEY` | sí | API key de OpenAI. https://platform.openai.com/api-keys |
| `BLOB_READ_WRITE_TOKEN` | para archivos >4 MB | Token de Vercel Blob. Se auto-setea al conectar un Blob store. |
| `RESEND_API_KEY` | no | Solo si querés enviar el ePub por email. https://resend.com/ |
| `EMAIL_FROM` | no | Remitente, ej. `Wiki Editor <editor@tudominio.com>`. Sin dominio verificado, Resend solo entrega al dueño de la cuenta. |
| `EMAIL_ARCHIVE` | no | Copia cada ePub generado a esta dirección (tu archivo personal). Los avisos de error también van acá. |
| `NEXT_PUBLIC_SENDER_EMAIL` | no | Dirección que la app muestra en las instrucciones del Kindle como remitente a aprobar. Debería coincidir con `EMAIL_FROM`. |

Sin `OPENAI_API_KEY` la conversión falla (500).

### Prefijar el destinatario

El campo de email se puede precompletar por querystring, y queda recordado en
el navegador para las visitas siguientes:

```
https://tu-app.vercel.app/?email=vos@ejemplo.com
```

## Archivos grandes

Las funciones serverless de Vercel limitan el cuerpo del request a **4.5 MB**.
Por eso:

- **≤ 4 MB** → el navegador hace un POST directo a `/api/convert`.
- **> 4 MB** → el navegador parte el archivo en fragmentos de 4 MB y los manda
  a `/api/chunk`, que los guarda en Vercel Blob (acceso **privado**);
  `/api/convert` los reensambla, procesa y limpia.

El ePub resultante se devuelve en la respuesta (descarga directa) o se manda
como adjunto por email — nunca se publica en una URL pública.

## Entrega por email y Kindle

Si completás el email, la conversión corre en segundo plano (`next/after`) y el
ePub llega como adjunto: no hace falta dejar la página abierta. Útil para
libros largos u OCR.

Para que llegue **directo al Kindle**:

1. Verificá un dominio propio en Resend y seteá `EMAIL_FROM` con una dirección
   de ese dominio (el remitente de prueba `onboarding@resend.dev` solo entrega
   al dueño de la cuenta de Resend).
2. En Amazon → *Manage Your Content and Devices* → *Preferences* → *Personal
   Document Settings*, agregá esa dirección a la **Approved Personal Document
   E-mail List**.
3. Usá tu dirección `@kindle.com` como destinatario. Amazon convierte el EPUB
   al formato Kindle automáticamente.

Conviene además definir `EMAIL_ARCHIVE` con una casilla normal: te queda una
copia de cada libro y, sobre todo, es el único lugar donde vas a ver los avisos
de error — Amazon descarta en silencio todo lo que no sea un documento.

## OCR de PDFs escaneados

Si un PDF no tiene capa de texto, se usa el **soporte nativo de PDF de Claude**:
el archivo se manda al modelo, que lo lee (visión) y devuelve el texto. No hay
rasterización ni dependencias nativas. Los PDFs de más de 12 páginas se parten
en lotes que se procesan en paralelo. Límites: **100 páginas / 30 MB** por
archivo (ver `src/lib/ocr.ts`).

## Deploy en Vercel

1. Importá el repo en Vercel (**Add New… → Project**). Framework: Next.js
   (autodetectado).
2. **Conectá un Blob store**: *Storage → Create → Blob*. Eso agrega
   `BLOB_READ_WRITE_TOKEN` automáticamente.
3. Cargá `OPENAI_API_KEY` (y `RESEND_API_KEY` / `EMAIL_FROM` si vas a usar
   email) en *Settings → Environment Variables*.
4. Deploy.

### Límite de tiempo

`/api/convert` declara `maxDuration = 800` segundos, que requiere **Pro + Fluid
Compute** (en Hobby el máximo es 60). Los libros largos y el OCR lo necesitan.

### Versión

El pie de la app muestra `vX.Y.Z+<sha>` — la versión de `package.json` más el
commit desplegado, para saber qué build estás probando.

## Cambiar el modelo

En `src/lib/translate.ts`, la constante `TRANSLATION_MODEL`. Alternativa más
barata: `claude-haiku-4-5-20251001`.

## Sobre AZW3 (best-effort)

El parser de AZW3/MOBI cubre la mayoría de los archivos (sin comprimir y
PalmDOC), pero **no** soporta DRM ni compresión HUFF/CDIC. Si un AZW3 falla,
convertilo antes a EPUB con [Calibre](https://calibre-ebook.com/).

## Fuera de alcance

Sin auth, sin base de datos, sin extracción de imágenes del interior y sin
reconstrucción de layouts complejos (columnas, tablas, fórmulas).

## Licencia

MIT — ver [LICENSE](LICENSE).
