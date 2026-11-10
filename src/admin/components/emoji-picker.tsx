import { createElement, useEffect, useMemo, useState, type ComponentType } from "react";
import { cn } from "../lib/utils";
import {
  loadEmojiPickerImplementation,
  preloadEmojiPickerImplementation,
  resetEmojiPickerImplementation,
} from "./emoji-picker-loader";
import type { EmojiPickerImplementationProps } from "./emoji-picker-implementation";
import { Input } from "./ui/input";
import { ChevronDownIcon, SearchIcon } from "./ui/icons";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

export interface GuildEmojiResource {
  id: string;
  name: string;
  animated: boolean;
  available: boolean;
}

interface EmojiPickerProps {
  emojis: GuildEmojiResource[];
  loading?: boolean;
  selectedValue?: string | null;
  selectedValues?: readonly string[];
  onSelect: (emoji: EmojiPickerSelection) => void;
  disabled?: boolean;
  multiSelect?: boolean;
  disabledValues?: readonly string[];
  /** Restrict the picker to Unicode emoji when custom markup is not valid input. */
  unicodeOnly?: boolean;
}

export interface EmojiPickerSelection {
  type: "unicode" | "custom";
  value: string;
  display: string;
}

export function EmojiPicker({
  emojis,
  loading,
  selectedValue,
  selectedValues = [],
  onSelect,
  disabled,
  multiSelect = false,
  disabledValues = [],
  unicodeOnly = false,
}: EmojiPickerProps) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState("unicode");
  const [filter, setFilter] = useState("");
  const [unicodePicker, setUnicodePicker] =
    useState<ComponentType<EmojiPickerImplementationProps> | null>(null);
  const [unicodePickerError, setUnicodePickerError] = useState(false);

  useEffect(() => {
    if (!open || activeTab !== "unicode" || unicodePicker || unicodePickerError) return;
    let current = true;
    void loadEmojiPickerImplementation().then(
      (component) => current && setUnicodePicker(() => component),
      () => current && setUnicodePickerError(true),
    );
    return () => {
      current = false;
    };
  }, [activeTab, open, unicodePicker, unicodePickerError]);

  const filtered = useMemo(() => {
    const term = filter.trim().toLowerCase();
    const available = emojis.filter((emoji) => emoji.available);
    if (!term) return available;
    return available.filter((emoji) => emoji.name.toLowerCase().includes(term));
  }, [emojis, filter]);

  const selectedCustomEmoji = useMemo(() => {
    if (!selectedValue) return null;
    return (
      emojis.find((emoji) => emoji.available && `:${emoji.name}:${emoji.id}` === selectedValue) ??
      null
    );
  }, [emojis, selectedValue]);

  const disabledValuesSet = new Set(disabledValues.map(normalizePickerEmojiValue));

  function handleUnicodeSelect(emoji: string) {
    onSelect({ type: "unicode", value: emoji, display: emoji });
    if (!multiSelect) setOpen(false);
  }

  function preloadUnicodePicker() {
    void preloadEmojiPickerImplementation().catch(() => undefined);
  }

  function retryUnicodePicker() {
    resetEmojiPickerImplementation();
    setUnicodePickerError(false);
  }

  function handleCustomSelect(emoji: GuildEmojiResource) {
    const value = `:${emoji.name}:${emoji.id}`;
    const display = `${emoji.animated ? "<a" : "<"}:${emoji.name}:${emoji.id}>`;
    onSelect({ type: "custom", value, display });
    if (!multiSelect) setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={(nextOpen) => !disabled && setOpen(nextOpen)}>
      <div data-unified-emoji-picker="true">
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className="h-10 w-full justify-between gap-2 px-3 font-sans font-normal"
            aria-expanded={open}
            disabled={disabled}
            onPointerEnter={preloadUnicodePicker}
            onFocus={preloadUnicodePicker}
            onTouchStart={preloadUnicodePicker}
          >
            <span className="flex min-w-0 items-center gap-2">
              <EmojiPreview
                selectedValue={multiSelect ? null : selectedValue}
                selectedCustomEmoji={selectedCustomEmoji}
              />
              <span
                className={cn(
                  "truncate",
                  !(multiSelect ? selectedValues.length > 0 : Boolean(selectedValue)) &&
                    "text-muted-foreground",
                )}
              >
                {multiSelect
                  ? selectedValues.length > 0
                    ? `${selectedValues.length} selected`
                    : "Choose emojis"
                  : selectedValue
                    ? formatSelectedLabel(selectedValue, selectedCustomEmoji)
                    : "Choose emoji"}
              </span>
            </span>
            <ChevronDownIcon className="h-4 w-4 text-muted-foreground" />
          </Button>
        </PopoverTrigger>

        <PopoverContent className="w-[22rem] p-0" align="start" sideOffset={8}>
          <div className="border-b border-border bg-muted/20 px-3 py-2">
            <p className="text-sm font-semibold text-foreground">
              {multiSelect ? "Choose emojis" : "Choose emoji"}
            </p>
            <p className="text-xs text-muted-foreground">
              {unicodeOnly ? "Choose a Unicode emoji." : "Unicode and server emoji in one picker."}
            </p>
          </div>

          <div className="p-3">
            {unicodeOnly ? (
              <UnicodePickerContent
                unicodePicker={unicodePicker}
                unicodePickerError={unicodePickerError}
                onSelect={handleUnicodeSelect}
                onRetry={retryUnicodePicker}
              />
            ) : (
              <Tabs value={activeTab} onValueChange={setActiveTab}>
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="unicode">Unicode</TabsTrigger>
                  <TabsTrigger value="server">Server</TabsTrigger>
                </TabsList>

                <TabsContent value="unicode" className="mt-3">
                  <UnicodePickerContent
                    unicodePicker={unicodePicker}
                    unicodePickerError={unicodePickerError}
                    onSelect={handleUnicodeSelect}
                    onRetry={retryUnicodePicker}
                  />
                </TabsContent>

                <TabsContent value="server" className="mt-3">
                  <div className="space-y-2">
                    <div className="relative">
                      <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        className="h-8 pl-8 text-xs"
                        placeholder="Search server emojis..."
                        value={filter}
                        onChange={(event) => setFilter(event.target.value)}
                      />
                    </div>
                    <div
                      className={cn(
                        "max-h-[320px] overflow-y-auto rounded-md border border-border bg-background/60 p-2",
                        (loading || filtered.length === 0) &&
                          "flex min-h-[5rem] items-center justify-center",
                      )}
                    >
                      {loading ? (
                        <p className="text-xs text-muted-foreground">Loading server emojis...</p>
                      ) : filtered.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          {emojis.length === 0
                            ? "This server has no custom emojis."
                            : "No emojis match your search."}
                        </p>
                      ) : (
                        <div className="grid grid-cols-[repeat(auto-fill,minmax(2.25rem,1fr))] gap-1">
                          {filtered.map((emoji) => {
                            const value = `:${emoji.name}:${emoji.id}`;
                            const isDisabled = disabledValuesSet.has(
                              normalizePickerEmojiValue(value),
                            );
                            return (
                              <button
                                key={emoji.id}
                                type="button"
                                title={`:${emoji.name}:`}
                                aria-label={emoji.name}
                                disabled={isDisabled}
                                onClick={() => handleCustomSelect(emoji)}
                                className={cn(
                                  "flex h-9 w-9 items-center justify-center rounded-md border border-transparent transition-colors hover:border-border hover:bg-secondary",
                                  isDisabled && "opacity-50",
                                )}
                              >
                                <img
                                  src={getCustomEmojiUrl(emoji)}
                                  alt={emoji.name}
                                  className="h-6 w-6 object-contain"
                                  loading="lazy"
                                />
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                </TabsContent>
              </Tabs>
            )}
          </div>
        </PopoverContent>
      </div>
    </Popover>
  );
}

function UnicodePickerContent({
  unicodePicker,
  unicodePickerError,
  onSelect,
  onRetry,
}: {
  unicodePicker: ComponentType<EmojiPickerImplementationProps> | null;
  unicodePickerError: boolean;
  onSelect: (emoji: string) => void;
  onRetry: () => void;
}) {
  if (unicodePicker) {
    return (
      <div
        data-emoji-picker-unicode="true"
        className="h-[340px] overflow-hidden rounded-md border border-border"
      >
        {createElement(unicodePicker, { onSelect })}
      </div>
    );
  }
  if (unicodePickerError) {
    return (
      <div
        className="flex h-[340px] flex-col items-center justify-center gap-3 rounded-md border border-border px-6 text-center"
        role="alert"
      >
        <p className="text-sm text-muted-foreground">The emoji picker could not load.</p>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  }
  return (
    <div
      className="flex h-[340px] items-center justify-center rounded-md border border-border"
      role="status"
      aria-live="polite"
    >
      <p className="text-sm text-muted-foreground">Loading unicode emojis...</p>
    </div>
  );
}

function EmojiPreview({
  selectedValue,
  selectedCustomEmoji,
}: {
  selectedValue?: string | null;
  selectedCustomEmoji: GuildEmojiResource | null;
}) {
  if (selectedCustomEmoji) {
    return (
      <span className="flex h-6 w-6 items-center justify-center rounded-md border border-border bg-background">
        <img
          src={getCustomEmojiUrl(selectedCustomEmoji)}
          alt=""
          className="h-5 w-5 object-contain"
          loading="lazy"
        />
      </span>
    );
  }

  if (selectedValue) {
    return (
      <span className="flex h-6 w-6 items-center justify-center text-lg leading-none">
        {selectedValue}
      </span>
    );
  }

  return (
    <span className="h-6 w-6 rounded-md border border-dashed border-muted-foreground/40 bg-muted/20" />
  );
}

function formatSelectedLabel(
  selectedValue: string,
  selectedCustomEmoji: GuildEmojiResource | null,
) {
  if (selectedCustomEmoji) return `:${selectedCustomEmoji.name}:`;
  return selectedValue;
}

function getCustomEmojiUrl(emoji: GuildEmojiResource) {
  return `https://cdn.discordapp.com/emojis/${emoji.id}.${emoji.animated ? "gif" : "png"}?size=64&quality=lossless`;
}

function normalizePickerEmojiValue(value: string): string {
  const trimmed = value.trim();
  const customEmoji = /^(?:<a?:|:)([^:>]+):(\d+)>?$/.exec(trimmed);
  return customEmoji ? `${customEmoji[1]}:${customEmoji[2]}` : trimmed;
}
