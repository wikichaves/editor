/**
 * Convert an HTML/XHTML fragment to readable plain text, preserving paragraph
 * breaks. Good enough for "translate the text" — it is not a full HTML parser.
 */
export function htmlToText(html: string): string {
  return html
    // Drop anything we never want as text.
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    // Block-level closings and line breaks become paragraph/line breaks.
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|blockquote)\s*>/gi, "\n\n")
    // Remove all remaining tags.
    .replace(/<[^>]+>/g, "")
    // Decode the handful of entities that actually matter for reading.
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => safeCodePoint(parseInt(n, 10)))
    // Tidy whitespace.
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function safeCodePoint(n: number): string {
  try {
    return String.fromCodePoint(n);
  } catch {
    return "";
  }
}
