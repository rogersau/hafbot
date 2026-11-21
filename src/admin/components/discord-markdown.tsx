import { useMemo, type ReactNode } from "react";
import type { MarkdownFlavor } from "./markdown-editor";

export function DiscordMarkdown({
  source,
  flavor = "full",
}: {
  source: string;
  flavor?: MarkdownFlavor;
}) {
  const blocks = useMemo(() => renderDiscordMarkdown(source, flavor), [source, flavor]);
  return <div className="space-y-2 break-words">{blocks}</div>;
}

interface RenderState {
  key: number;
}

function renderDiscordMarkdown(source: string, flavor: MarkdownFlavor): ReactNode[] {
  const lines = source.split("\n");
  const out: ReactNode[] = [];
  const state: RenderState = { key: 0 };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (flavor === "full" && line.startsWith("```")) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").startsWith("```")) {
        buf.push(lines[i] ?? "");
        i++;
      }
      i++;
      out.push(
        <pre
          key={state.key++}
          className="overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-xs"
        >
          <code>{buf.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    if (flavor === "full" && line.startsWith("### ")) {
      out.push(
        <h4 key={state.key++} className="text-base font-semibold">
          {renderInline(line.slice(4), state, flavor)}
        </h4>,
      );
      i++;
      continue;
    }
    if (flavor === "full" && line.startsWith("## ")) {
      out.push(
        <h3 key={state.key++} className="text-lg font-semibold">
          {renderInline(line.slice(3), state, flavor)}
        </h3>,
      );
      i++;
      continue;
    }
    if (flavor === "full" && line.startsWith("# ")) {
      out.push(
        <h2 key={state.key++} className="text-xl font-semibold">
          {renderInline(line.slice(2), state, flavor)}
        </h2>,
      );
      i++;
      continue;
    }
    if (flavor === "full" && line.startsWith("-# ")) {
      out.push(
        <p key={state.key++} className="text-xs text-muted-foreground">
          {renderInline(line.slice(3), state, flavor)}
        </p>,
      );
      i++;
      continue;
    }

    if (flavor === "full" && line.startsWith("> ")) {
      const buf: string[] = [];
      while (i < lines.length && (lines[i] ?? "").startsWith("> ")) {
        buf.push((lines[i] ?? "").slice(2));
        i++;
      }
      out.push(
        <blockquote
          key={state.key++}
          className="border-l-2 border-border pl-3 text-muted-foreground"
        >
          {buf.map((b, idx) => (
            <p key={idx}>{renderInline(b, state, flavor)}</p>
          ))}
        </blockquote>,
      );
      continue;
    }

    if (flavor === "full" && /^(\d+)\.\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^(\d+)\.\s/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^(\d+)\.\s/, ""));
        i++;
      }
      out.push(
        <ol key={state.key++} className="list-decimal space-y-1 pl-5">
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item, state, flavor)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    if (flavor === "full" && /^[-*]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").slice(2));
        i++;
      }
      out.push(
        <ul key={state.key++} className="list-disc space-y-1 pl-5">
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item, state, flavor)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    if (line.length === 0) {
      i++;
      continue;
    }

    out.push(
      <p key={state.key++} className="whitespace-pre-wrap">
        {renderInline(line, state, flavor)}
      </p>,
    );
    i++;
  }
  return out;
}

interface InlineRule {
  pattern: RegExp;
  render: (match: RegExpExecArray, state: RenderState, flavor: MarkdownFlavor) => ReactNode;
}

const INLINE_RULES: InlineRule[] = [
  {
    pattern: /\*\*\*([^*\n]+)\*\*\*/,
    render: (m, state, flavor) => (
      <strong key={state.key++} className="italic">
        {renderInline(m[1] ?? "", state, flavor)}
      </strong>
    ),
  },
  {
    pattern: /\*\*([^*\n]+)\*\*/,
    render: (m, state, flavor) => (
      <strong key={state.key++}>{renderInline(m[1] ?? "", state, flavor)}</strong>
    ),
  },
  {
    pattern: /__([^_\n]+)__/,
    render: (m, state, flavor) => (
      <span key={state.key++} className="underline">
        {renderInline(m[1] ?? "", state, flavor)}
      </span>
    ),
  },
  {
    pattern: /\*([^*\n]+)\*/,
    render: (m, state, flavor) => (
      <em key={state.key++}>{renderInline(m[1] ?? "", state, flavor)}</em>
    ),
  },
  {
    pattern: /_([^_\n]+)_/,
    render: (m, state, flavor) => (
      <em key={state.key++}>{renderInline(m[1] ?? "", state, flavor)}</em>
    ),
  },
  {
    pattern: /~~([^~\n]+)~~/,
    render: (m, state, flavor) => (
      <span key={state.key++} className="line-through">
        {renderInline(m[1] ?? "", state, flavor)}
      </span>
    ),
  },
  {
    pattern: /\|\|([^|\n]+)\|\|/,
    render: (m, state) => (
      <span
        key={state.key++}
        className="rounded bg-muted px-1 text-muted-foreground hover:bg-muted-foreground/20 hover:text-foreground"
        title="Spoiler"
      >
        {m[1]}
      </span>
    ),
  },
  {
    pattern: /`([^`\n]+)`/,
    render: (m, state) => (
      <code key={state.key++} className="rounded bg-muted/60 px-1 py-0.5 font-mono text-xs">
        {m[1]}
      </code>
    ),
  },
  {
    pattern: /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/,
    render: (m, state, flavor) => (
      <a
        key={state.key++}
        href={m[2]}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sky-400 underline-offset-2 hover:underline"
      >
        {renderInline(m[1] ?? "", state, flavor)}
      </a>
    ),
  },
  {
    pattern: /<#(\d+)>/,
    render: (_m, state) => (
      <span key={state.key++} className="rounded bg-sky-500/15 px-1 text-sky-300">
        #channel
      </span>
    ),
  },
  {
    pattern: /<@!?(\d+)>/,
    render: (_m, state) => (
      <span key={state.key++} className="rounded bg-indigo-500/15 px-1 text-indigo-300">
        @user
      </span>
    ),
  },
  {
    pattern: /<@&(\d+)>/,
    render: (_m, state) => (
      <span key={state.key++} className="rounded bg-fuchsia-500/15 px-1 text-fuchsia-300">
        @role
      </span>
    ),
  },
];

function renderInline(text: string, state: RenderState, flavor: MarkdownFlavor): ReactNode[] {
  const out: ReactNode[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let earliest: { rule: InlineRule; match: RegExpExecArray } | null = null;
    for (const rule of INLINE_RULES) {
      rule.pattern.lastIndex = 0;
      const match = rule.pattern.exec(text.slice(cursor));
      if (!match) continue;
      if (!earliest || match.index < earliest.match.index) {
        earliest = { rule, match };
      }
    }
    if (!earliest) {
      out.push(text.slice(cursor));
      break;
    }
    if (earliest.match.index > 0) {
      out.push(text.slice(cursor, cursor + earliest.match.index));
    }
    out.push(earliest.rule.render(earliest.match, state, flavor));
    cursor += earliest.match.index + earliest.match[0].length;
  }
  return out;
}
