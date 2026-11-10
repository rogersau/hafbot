import { useEffect, useMemo, useRef, useState } from "react";

import { MAX_BLOCKLIST_BATCH_EMOJIS, normalizeBlocklistEmoji } from "../../blocklist";
import { EmojiPicker, type EmojiPickerSelection, type GuildEmojiResource } from "./emoji-picker";
import { Button } from "./ui/button";
import { XIcon } from "./ui/icons";

export interface BlocklistEmojiFieldProps {
  currentEmojis: readonly string[];
  emojis: GuildEmojiResource[];
  loading?: boolean;
  submitting?: boolean;
  onSubmit: (emojis: string[]) => Promise<boolean> | boolean;
}

export function BlocklistEmojiField({
  currentEmojis,
  emojis,
  loading = false,
  submitting = false,
  onSubmit,
}: BlocklistEmojiFieldProps) {
  const [draftEmojis, setDraftEmojis] = useState<string[]>([]);
  const currentEmojiSet = useMemo(
    () => new Set(currentEmojis.map((emoji) => normalizeBlocklistEmoji(emoji)).filter(Boolean)),
    [currentEmojis],
  );
  const blockedUnicodeSet = useMemo(() => {
    const values = currentEmojis.flatMap((emoji) => {
      const normalized = normalizeBlocklistEmoji(emoji);
      return normalized && !isCustomEmojiValue(normalized) ? [toUnicodeUnified(normalized)] : [];
    });
    return new Set(values);
  }, [currentEmojis]);
  const fieldRef = useRef<HTMLDivElement>(null);

  // eslint-disable-next-line custom/no-use-effect -- Disables blocked Unicode buttons after the lazy picker mounts.
  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;

    const syncBlockedUnicode = () => {
      for (const button of field.querySelectorAll<HTMLButtonElement>("button[data-unified]")) {
        const isBlocked = blockedUnicodeSet.has(button.dataset.unified ?? "");
        button.disabled = isBlocked;
        button.style.opacity = isBlocked ? "0.5" : "";
        if (isBlocked) {
          button.setAttribute("aria-disabled", "true");
          button.setAttribute("title", "Already blocked");
        } else {
          button.removeAttribute("aria-disabled");
          if (button.title === "Already blocked") button.removeAttribute("title");
        }
      }
    };

    syncBlockedUnicode();
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(syncBlockedUnicode);
    observer.observe(field, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [blockedUnicodeSet]);

  function handleSelect(selection: EmojiPickerSelection) {
    const value = normalizeBlocklistEmoji(selection.value);
    if (!value || currentEmojiSet.has(value)) return;

    setDraftEmojis((previous) => {
      if (previous.includes(value) || previous.length >= MAX_BLOCKLIST_BATCH_EMOJIS) {
        return previous;
      }
      return [...previous, value];
    });
  }

  function removeDraftEmoji(value: string) {
    setDraftEmojis((previous) => previous.filter((emoji) => emoji !== value));
  }

  async function submitDraft() {
    if (submitting || draftEmojis.length === 0) return;
    const succeeded = await onSubmit([...draftEmojis]);
    if (succeeded) setDraftEmojis([]);
  }

  return (
    <div ref={fieldRef} className="space-y-3">
      <EmojiPicker
        emojis={emojis}
        loading={loading}
        multiSelect
        selectedValues={draftEmojis}
        disabledValues={currentEmojis}
        onSelect={handleSelect}
        disabled={submitting}
      />

      {currentEmojis.length > 0 ? (
        <p className="text-xs text-muted-foreground" role="status">
          Already blocked: {currentEmojis.join(", ")}
        </p>
      ) : null}

      {draftEmojis.length > 0 ? (
        <div
          aria-label="Draft Blocklist emoji selection"
          className="space-y-2 rounded-md border border-dashed border-border bg-muted/20 p-3"
        >
          <p className="text-xs font-medium text-foreground">
            Selected to add ({draftEmojis.length})
          </p>
          <div className="flex flex-wrap gap-2">
            {draftEmojis.map((emoji) => (
              <span
                key={emoji}
                className="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-xs"
              >
                <span className="font-mono">{emoji}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 rounded-sm"
                  aria-label={`Remove ${emoji} from selection`}
                  onClick={() => removeDraftEmoji(emoji)}
                  disabled={submitting}
                >
                  <XIcon className="h-3.5 w-3.5" />
                </Button>
              </span>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => void submitDraft()} disabled={submitting}>
              Add {draftEmojis.length} emoji{draftEmojis.length === 1 ? "" : "s"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDraftEmojis([])}
              disabled={submitting}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function isCustomEmojiValue(value: string): boolean {
  return /^[^:>\s]+:\d+$/.test(value);
}

function toUnicodeUnified(value: string): string {
  return Array.from(value)
    .map((character) => character.codePointAt(0)?.toString(16) ?? "")
    .filter(Boolean)
    .join("-");
}
