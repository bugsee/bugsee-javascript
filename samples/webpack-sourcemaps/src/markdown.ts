// Thin wrapper over `marked` so the rest of the app doesn't import a third-party lib directly.
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: true });

/** Render markdown source to sanitized-enough HTML for the note preview. */
export function renderMarkdown(source: string): string {
  const html = marked.parse(source, { async: false }) as string;
  return html;
}
