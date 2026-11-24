import type { WardogsGoldStatus } from "./community-data";

export const WARDOGS_SERVER_LIST_URL = "https://wardogserverlist.com";
export const GOLD_DAY_MS = 24 * 60 * 60 * 1000;

const number = new Intl.NumberFormat("en-US");
const utcDate = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" });
const percent = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 1,
  signDisplay: "exceptZero",
});
const chartLevels = "▁▂▃▄▅▆▇█";

export const DEFAULT_GOLD_VOICE_FORMAT = "Gold: {price}";
export const GOLD_VOICE_FORMAT_LIMIT = 100;
export const GOLD_POST_FORMATS = ["full", "chart", "image", "summary"] as const;
export type GoldPostFormat = (typeof GOLD_POST_FORMATS)[number];

const voicePlaceholder = /\{(price|change|date)\}/g;

export function isGoldVoiceFormat(format: string): boolean {
  const trimmed = format.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= GOLD_VOICE_FORMAT_LIMIT &&
    !/[{}\r\n]/.test(trimmed.replace(voicePlaceholder, ""))
  );
}

function dailyChange({ latest, history }: WardogsGoldStatus): string | undefined {
  const previous = history.find((point) => point.ts === latest.ts - GOLD_DAY_MS);
  return previous && percent.format((latest.price - previous.price) / previous.price);
}

export function formatWardogsGoldChannelName(
  status: WardogsGoldStatus,
  format = DEFAULT_GOLD_VOICE_FORMAT,
): string {
  const values = {
    price: number.format(status.latest.price),
    change: dailyChange(status) ?? "—",
    date: utcDate.format(status.latest.ts),
  };
  const name = format
    .replace(voicePlaceholder, (_, key: keyof typeof values) => values[key])
    .trim();
  if (name.length <= GOLD_VOICE_FORMAT_LIMIT) return name;
  const truncated = name.slice(0, GOLD_VOICE_FORMAT_LIMIT - 1).replace(/[\uD800-\uDBFF]$/, "");
  return `${truncated.trimEnd()}…`;
}

export function formatWardogsGoldStatus(
  status: WardogsGoldStatus,
  format: GoldPostFormat = "full",
): string {
  const { latest, history } = status;
  const change = dailyChange(status);
  const date = `${utcDate.format(latest.ts)} UTC`;
  const lines = [
    format === "image" ? "### WARDOGS Gold Exchange" : "**WARDOGS Gold Exchange**",
    `**${number.format(latest.price)} cash** per gold bar`,
    format === "image"
      ? [date, change && `**${change}** vs. yesterday`].filter(Boolean).join(" · ")
      : `Price for ${date}`,
  ];
  if (change && format !== "image") lines.push(`${change} vs. yesterday`);
  if (format === "chart" && history.length > 1) {
    const high = Math.max(...history.map(({ price }) => price));
    const rows = history.map(({ ts, price }) => {
      const bar = "█".repeat(Math.max(1, Math.round((price / high) * 20)));
      return `${utcDate.format(ts).padStart(11)}  ${number.format(price).padStart(10)}  ${bar}`;
    });
    lines.push("", "**Price history (cash per gold bar, UTC)**", "```", ...rows, "```");
  } else if (format === "full" && history.length > 1) {
    const prices = history.map((point) => point.price);
    const low = Math.min(...prices);
    const spread = Math.max(...prices) - low;
    const trend = prices
      .map((price) => chartLevels[spread ? Math.round(((price - low) / spread) * 7) : 3])
      .join("");
    lines.push(
      "",
      `**Price history (UTC)** \`${trend}\``,
      ...history.map(({ ts, price }) => `${utcDate.format(ts)} · ${number.format(price)}`),
    );
  }
  lines.push(
    "",
    `-# Data: [WARDOGS Server List](<${WARDOGS_SERVER_LIST_URL}/gold-bars>) · [CC BY 4.0](<https://creativecommons.org/licenses/by/4.0/>)`,
  );
  return lines.join("\n");
}

export function describeWardogsGoldChart({ latest, history }: WardogsGoldStatus): string {
  const entries = history.filter(({ ts }) => ts < latest.ts).concat(latest);
  const prices = entries.map(({ ts, price }) => `${utcDate.format(ts)}, ${number.format(price)}`);
  return `Daily cash per gold bar (UTC). ${prices.join(". ")}.`;
}
