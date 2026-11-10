import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "../lib/utils";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./ui/command";
import { SearchIcon } from "./ui/icons";

export type CommandPaletteGroupKind = "pages" | "resources" | "recent";

export interface CommandPaletteItem {
  /** Stable identifier passed back to `onSelect`. */
  id: string;
  /** Visible label rendered inside the palette. */
  label: string;
  /** Optional group — items without a group go into the ungrouped list. */
  group?: CommandPaletteGroupKind;
  /** Optional extra keywords used for substring matching only. */
  keywords?: string[];
  /** Optional hint shown on the right of the item (e.g. "↵"). */
  hint?: ReactNode;
  /** Disable the item (filtered out from selection but still rendered). */
  disabled?: boolean;
}

interface CommandPaletteGroup {
  kind: CommandPaletteGroupKind;
  label: string;
}

const GROUP_ORDER: CommandPaletteGroup[] = [
  { kind: "pages", label: "Dashboard pages" },
  { kind: "resources", label: "Servers" },
  { kind: "recent", label: "Recent actions" },
];

export interface CommandPaletteProps {
  open: boolean;
  items: CommandPaletteItem[];
  onSelect: (item: CommandPaletteItem) => void;
  onDismiss: () => void;
  placeholder?: string;
  emptyMessage?: string;
}

/**
 * Global search/command palette. Entirely presentational: the caller owns the
 * `open` state, the searchable items, and the `onSelect` callback (typically
 * wiring it through `useNavigate()` from `@tanstack/react-router`).
 */
export function CommandPalette({
  open,
  items,
  onSelect,
  onDismiss,
  placeholder = "Search pages, servers, and recent actions…",
  emptyMessage = "No matches found.",
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  // Reset the query each time the palette opens so the user always starts fresh.
  // eslint-disable-next-line custom/no-use-effect -- Resets palette query state on open.
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  // eslint-disable-next-line custom/no-use-effect -- Contains modal focus and preserves background accessibility and scroll state.
  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const background = Array.from(document.body.children)
      .filter((element) => !element.contains(dialog))
      .map((element) => ({
        element,
        inert: element.getAttribute("inert"),
        ariaHidden: element.getAttribute("aria-hidden"),
      }));
    const previousOverflow = document.body.style.overflow;
    for (const { element } of background) {
      element.setAttribute("inert", "");
      element.setAttribute("aria-hidden", "true");
    }
    document.body.style.overflow = "hidden";

    const focusable = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => {
        const style = window.getComputedStyle(element);
        return (
          element.tabIndex >= 0 &&
          !element.closest('[hidden], [inert], [aria-hidden="true"]') &&
          style.display !== "none" &&
          style.visibility !== "hidden"
        );
      });
    const focusFirst = () => (focusable()[0] ?? dialog).focus();
    const handleFocus = (event: FocusEvent) => {
      if (!dialog.contains(event.target as Node)) focusFirst();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismissRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const elements = focusable();
      const first = elements[0] ?? dialog;
      const last = elements[elements.length - 1] ?? dialog;
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    focusFirst();
    window.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("focusin", handleFocus);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("focusin", handleFocus);
      document.body.style.overflow = previousOverflow;
      for (const { element, inert, ariaHidden } of background) {
        if (inert === null) element.removeAttribute("inert");
        else element.setAttribute("inert", inert);
        if (ariaHidden === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", ariaHidden);
      }
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [open]);

  const grouped = useMemo(() => groupAndFilterItems(items, query), [items, query]);

  if (!open) return null;

  const palette = (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      data-command-palette="true"
      tabIndex={-1}
      className="fixed inset-0 z-[70] flex items-start justify-center p-4 pt-[10vh]"
    >
      <button
        type="button"
        aria-label="Close command palette"
        tabIndex={-1}
        className="admin-command-palette-overlay absolute inset-0 bg-background/80 backdrop-blur-sm"
        onClick={onDismiss}
      />
      <div
        className={cn(
          "admin-command-palette relative z-10 w-full max-w-xl overflow-hidden rounded-[5px] border bg-popover text-popover-foreground shadow-lg",
          "data-[state=open]:animate-in data-[state=closed]:animate-out",
        )}
      >
        <Command shouldFilter={false} loop>
          <CommandInput placeholder={placeholder} value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandEmpty>{emptyMessage}</CommandEmpty>
            {grouped.map(({ group, items: groupItems }) => {
              if (groupItems.length === 0) return null;
              return (
                <CommandGroup key={group?.kind ?? "ungrouped"} heading={group?.label}>
                  {groupItems.map((item) => (
                    <CommandItem
                      key={item.id}
                      value={`${item.label} ${item.id} ${(item.keywords ?? []).join(" ")}`}
                      disabled={item.disabled}
                      onSelect={() => {
                        if (item.disabled) return;
                        onSelect(item);
                      }}
                    >
                      <SearchIcon className="mr-2 h-4 w-4 shrink-0 opacity-50" aria-hidden="true" />
                      <span className="truncate">{item.label}</span>
                      {item.hint ? (
                        <span className="ml-auto pl-2 text-xs text-muted-foreground">
                          {item.hint}
                        </span>
                      ) : null}
                    </CommandItem>
                  ))}
                </CommandGroup>
              );
            })}
          </CommandList>
        </Command>
      </div>
    </div>
  );
  return typeof document === "undefined" ? palette : createPortal(palette, document.body);
}

interface GroupedItems {
  group: CommandPaletteGroup | null;
  items: CommandPaletteItem[];
}

function groupAndFilterItems(items: CommandPaletteItem[], query: string): GroupedItems[] {
  const normalized = query.trim().toLowerCase();
  const matches = normalized
    ? items.filter((item) => {
        if (item.disabled) return false;
        const haystack = [item.label, item.id, ...(item.keywords ?? [])].join(" ").toLowerCase();
        return haystack.includes(normalized);
      })
    : items.filter((item) => !item.disabled);

  const buckets = new Map<CommandPaletteGroupKind | "ungrouped", CommandPaletteItem[]>();
  for (const item of matches) {
    const key = item.group ?? "ungrouped";
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }

  const result: GroupedItems[] = [];
  for (const group of GROUP_ORDER) {
    const bucket = buckets.get(group.kind);
    if (bucket && bucket.length > 0) result.push({ group, items: bucket });
  }
  const ungrouped = buckets.get("ungrouped");
  if (ungrouped && ungrouped.length > 0) {
    result.push({ group: null, items: ungrouped });
  }
  return result;
}

export { useCommandPaletteShortcut } from "../hooks/use-command-palette-shortcut";
