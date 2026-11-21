import { lazy, Suspense, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

export type MarkdownFlavor = "full" | "inline";

const DiscordMarkdown = lazy(async () => ({
  default: (await import("./discord-markdown")).DiscordMarkdown,
}));

interface MarkdownEditorProps {
  id?: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  rows?: number;
  flavor?: MarkdownFlavor;
  multiline?: boolean;
  helpText?: string;
  disabled?: boolean;
  maxLength?: number;
}

interface ToolbarAction {
  id: string;
  label: string;
  shortcut?: string;
  hint: string;
  apply: (selection: SelectionState) => SelectionEdit;
  flavors?: MarkdownFlavor[];
  multilineOnly?: boolean;
}

interface SelectionState {
  value: string;
  start: number;
  end: number;
  selected: string;
}

interface SelectionEdit {
  before: string;
  selected: string;
  after: string;
  cursorOffset?: number;
  selectAfter?: boolean;
}

function wrap(
  prefix: string,
  suffix: string = prefix,
  placeholder: string = "text",
): ToolbarAction["apply"] {
  return ({ selected }) => {
    const inner = selected.length > 0 ? selected : placeholder;
    return { before: prefix, selected: inner, after: suffix, selectAfter: selected.length === 0 };
  };
}

function linePrefix(prefix: string, placeholder = "text"): ToolbarAction["apply"] {
  return ({ selected }) => {
    if (selected.length === 0) {
      return { before: prefix, selected: placeholder, after: "", selectAfter: true };
    }
    const lines = selected.split("\n").map((line) => (line.length > 0 ? `${prefix}${line}` : line));
    return { before: "", selected: lines.join("\n"), after: "" };
  };
}

const ACTIONS: ToolbarAction[] = [
  { id: "bold", label: "B", hint: "Bold", shortcut: "Mod+B", apply: wrap("**", "**", "bold text") },
  {
    id: "italic",
    label: "I",
    hint: "Italic",
    shortcut: "Mod+I",
    apply: wrap("*", "*", "italic text"),
  },
  {
    id: "underline",
    label: "U",
    hint: "Underline",
    shortcut: "Mod+U",
    apply: wrap("__", "__", "underlined text"),
  },
  {
    id: "strike",
    label: "S",
    hint: "Strikethrough",
    apply: wrap("~~", "~~", "struck text"),
  },
  {
    id: "spoiler",
    label: "||",
    hint: "Spoiler",
    apply: wrap("||", "||", "spoiler"),
    flavors: ["full"],
  },
  {
    id: "code",
    label: "</>",
    hint: "Inline code",
    apply: wrap("`", "`", "code"),
  },
  {
    id: "codeblock",
    label: "{ }",
    hint: "Code block",
    multilineOnly: true,
    flavors: ["full"],
    apply: ({ selected }) => {
      const inner = selected.length > 0 ? selected : "code";
      return {
        before: "```\n",
        selected: inner,
        after: "\n```",
        selectAfter: selected.length === 0,
      };
    },
  },
  {
    id: "h1",
    label: "H1",
    hint: "Heading 1",
    multilineOnly: true,
    flavors: ["full"],
    apply: linePrefix("# ", "Heading"),
  },
  {
    id: "h2",
    label: "H2",
    hint: "Heading 2",
    multilineOnly: true,
    flavors: ["full"],
    apply: linePrefix("## ", "Heading"),
  },
  {
    id: "h3",
    label: "H3",
    hint: "Heading 3",
    multilineOnly: true,
    flavors: ["full"],
    apply: linePrefix("### ", "Heading"),
  },
  {
    id: "subtext",
    label: "-#",
    hint: "Subtext",
    multilineOnly: true,
    flavors: ["full"],
    apply: linePrefix("-# ", "subtext"),
  },
  {
    id: "quote",
    label: "❝",
    hint: "Quote block",
    multilineOnly: true,
    flavors: ["full"],
    apply: linePrefix("> ", "quoted text"),
  },
  {
    id: "ul",
    label: "•",
    hint: "Bulleted list",
    multilineOnly: true,
    flavors: ["full"],
    apply: linePrefix("- ", "list item"),
  },
  {
    id: "ol",
    label: "1.",
    hint: "Numbered list",
    multilineOnly: true,
    flavors: ["full"],
    apply: ({ selected }) => {
      if (selected.length === 0) {
        return { before: "1. ", selected: "list item", after: "", selectAfter: true };
      }
      const lines = selected
        .split("\n")
        .map((line, index) => (line.length > 0 ? `${index + 1}. ${line}` : line));
      return { before: "", selected: lines.join("\n"), after: "" };
    },
  },
  {
    id: "link",
    label: "🔗",
    hint: "Link (masked)",
    flavors: ["full"],
    apply: ({ selected }) => {
      const label = selected.length > 0 ? selected : "link text";
      return {
        before: "[",
        selected: label,
        after: "](https://example.com)",
      };
    },
  },
];

const CHARACTER_COUNT_FORMATTER = new Intl.NumberFormat("en-US");

export type MarkdownCharacterCountTone = "normal" | "warning" | "limit";

export function getMarkdownCharacterCountTone(
  valueLength: number,
  maxLength: number,
): MarkdownCharacterCountTone {
  if (valueLength >= maxLength) return "limit";
  if (valueLength >= maxLength * 0.9) return "warning";
  return "normal";
}

export function MarkdownEditor({
  id,
  value,
  onChange,
  placeholder,
  rows = 4,
  flavor = "full",
  multiline = true,
  helpText,
  disabled = false,
  maxLength,
}: MarkdownEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [tab, setTab] = useState<"write" | "preview">("write");

  const visibleActions = useMemo(
    () =>
      ACTIONS.filter((action) => {
        if (action.flavors && !action.flavors.includes(flavor)) return false;
        if (action.multilineOnly && !multiline) return false;
        return true;
      }),
    [flavor, multiline],
  );
  const characterCount =
    maxLength === undefined
      ? null
      : `${CHARACTER_COUNT_FORMATTER.format(value.length)} / ${CHARACTER_COUNT_FORMATTER.format(maxLength)}`;
  const characterCountTone =
    maxLength === undefined ? null : getMarkdownCharacterCountTone(value.length, maxLength);

  function applyAction(action: ToolbarAction) {
    if (disabled) return;
    const target: HTMLTextAreaElement | HTMLInputElement | null = multiline
      ? textareaRef.current
      : inputRef.current;
    if (!target) return;

    const start = target.selectionStart ?? value.length;
    const end = target.selectionEnd ?? value.length;
    const selected = value.slice(start, end);
    const edit = action.apply({ value, start, end, selected });
    const before = value.slice(0, start);
    const after = value.slice(end);
    const next = `${before}${edit.before}${edit.selected}${edit.after}${after}`;
    if (maxLength !== undefined && next.length > maxLength) return;
    onChange(next);

    requestAnimationFrame(() => {
      const selectionStart = before.length + edit.before.length;
      const selectionEnd = selectionStart + edit.selected.length;
      target.focus();
      if (edit.selectAfter) {
        target.setSelectionRange(selectionStart, selectionEnd);
      } else {
        const cursor = selectionStart + edit.selected.length + (edit.cursorOffset ?? 0);
        target.setSelectionRange(cursor, cursor);
      }
    });
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) {
    if (!(event.metaKey || event.ctrlKey)) return;
    const key = event.key.toLowerCase();
    const match = visibleActions.find((action) => {
      if (!action.shortcut) return false;
      const want = action.shortcut.toLowerCase().replace("mod+", "");
      return want === key;
    });
    if (!match) return;
    event.preventDefault();
    applyAction(match);
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 p-1">
        <div className="flex flex-wrap items-center gap-1">
          {visibleActions.map((action) => (
            <button
              key={action.id}
              type="button"
              title={
                action.hint +
                (action.shortcut
                  ? ` (${action.shortcut.replace("Mod", isMac() ? "⌘" : "Ctrl")})`
                  : "")
              }
              aria-label={action.hint}
              onClick={() => applyAction(action)}
              disabled={disabled}
              className="inline-flex h-7 min-w-[1.75rem] items-center justify-center rounded-md border border-transparent px-2 text-xs font-semibold text-muted-foreground transition-colors hover:border-border hover:bg-background hover:text-foreground"
            >
              <span
                className={cn(
                  action.id === "bold" && "font-bold",
                  action.id === "italic" && "italic",
                  action.id === "underline" && "underline",
                  action.id === "strike" && "line-through",
                )}
              >
                {action.label}
              </span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <ToggleButton active={tab === "write"} onClick={() => setTab("write")}>
            Write
          </ToggleButton>
          <ToggleButton active={tab === "preview"} onClick={() => setTab("preview")}>
            Preview
          </ToggleButton>
        </div>
      </div>

      {tab === "write" ? (
        multiline ? (
          <Textarea
            ref={textareaRef}
            id={id}
            className="font-mono leading-relaxed"
            rows={rows}
            maxLength={maxLength}
            value={value}
            disabled={disabled}
            placeholder={placeholder}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={handleKeyDown}
          />
        ) : (
          <Input
            ref={inputRef}
            id={id}
            maxLength={maxLength}
            value={value}
            disabled={disabled}
            placeholder={placeholder}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={handleKeyDown}
          />
        )
      ) : (
        <DiscordPreview value={value} flavor={flavor} multiline={multiline} />
      )}

      {helpText || characterCount ? (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px]">
          {helpText ? <p className="text-muted-foreground">{helpText}</p> : null}
          {characterCount ? (
            <p
              className={cn(
                "ml-auto tabular-nums",
                characterCountTone === "normal" && "text-muted-foreground",
                characterCountTone === "warning" && "text-amber-500",
                characterCountTone === "limit" && "text-destructive",
              )}
              aria-live="polite"
              data-character-count-tone={characterCountTone}
            >
              {characterCount}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ToggleButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={active ? "default" : "ghost"}
      className="h-7 px-2 text-xs"
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function DiscordPreview({
  value,
  flavor,
  multiline,
}: {
  value: string;
  flavor: MarkdownFlavor;
  multiline: boolean;
}) {
  if (!value.trim()) {
    return (
      <div className="rounded-md border border-dashed bg-muted/20 px-3 py-6 text-center text-xs text-muted-foreground">
        Nothing to preview yet.
      </div>
    );
  }

  return (
    <div
      className={cn(
        "rounded-md border bg-background p-3 text-sm leading-relaxed",
        !multiline && "py-2",
      )}
    >
      <Suspense fallback={<p role="status">Loading preview…</p>}>
        <DiscordMarkdown source={value} flavor={flavor} />
      </Suspense>
    </div>
  );
}

function isMac() {
  if (typeof navigator === "undefined") return false;
  return navigator.platform.toLowerCase().includes("mac");
}
