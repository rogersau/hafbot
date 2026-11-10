const CLIPBOARD_UNAVAILABLE_MESSAGE = "Clipboard is unavailable in this environment.";
const CLIPBOARD_WRITE_FAILED_MESSAGE = "Failed to copy to clipboard.";

// Keep clipboard access behind this single seam so callers only report success after the write completes.
export async function copyTextToClipboard(value: string): Promise<void> {
  if (typeof navigator === "undefined" || typeof navigator.clipboard?.writeText !== "function") {
    throw new Error(CLIPBOARD_UNAVAILABLE_MESSAGE);
  }

  try {
    await navigator.clipboard.writeText(value);
  } catch {
    throw new Error(CLIPBOARD_WRITE_FAILED_MESSAGE);
  }
}
