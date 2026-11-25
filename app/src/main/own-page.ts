// Decides whether a URL is the app's own page, which alone may use the IPC API and be navigated to.
import { pathToFileURL } from "node:url";

/**
 * In development the page is the dev server (match its origin exactly; a prefix match would admit
 * `http://localhost:5173.evil.example`). Built, it's the bundled index.html (match the file, any hash).
 */
export function ownPageCheck(rendererUrl: string | undefined, rendererFile: string): (url: string) => boolean {
  const devOrigin = rendererUrl ? new URL(rendererUrl).origin : undefined;
  const filePath = pathToFileURL(rendererFile).pathname;
  return (url) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (devOrigin) return parsed.origin === devOrigin;
    return parsed.protocol === "file:" && parsed.host === "" && parsed.pathname === filePath;
  };
}
