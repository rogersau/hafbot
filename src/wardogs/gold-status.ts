import { GOLD_DAY_MS, WARDOGS_SERVER_LIST_URL, type WardogsGoldStatus } from "./community-data";

const number = new Intl.NumberFormat("en-US");
const utcDate = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" });
const percent = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 1,
  signDisplay: "exceptZero",
});
const chartLevels = "▁▂▃▄▅▆▇█";

export function formatWardogsGoldStatus({ latest, history }: WardogsGoldStatus): string {
  const previous = history.find((point) => point.ts === latest.ts - GOLD_DAY_MS);
  const lines = [
    "**WARDOGS Gold Exchange**",
    `**${number.format(latest.price)} cash** per gold bar`,
    `Price for ${utcDate.format(latest.ts)} UTC`,
  ];
  if (previous)
    lines.push(`${percent.format((latest.price - previous.price) / previous.price)} vs. yesterday`);
  if (history.length > 1) {
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
    `[Source: WARDOGS Server List](${WARDOGS_SERVER_LIST_URL}/gold-bars) · [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)`,
  );
  return lines.join("\n");
}
