import type { WardogsGoldStatus } from "./community-data";
import { GOLD_DAY_MS } from "./gold-status";

const dateLabel = new Intl.DateTimeFormat("en-GB", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const number = new Intl.NumberFormat("en-US");
const compactNumber = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const fontFamily = "DejaVu Sans";
const gold = "#ffd580";
const headingColor = "#f3eee5";

export async function renderWardogsGoldChart(
  { latest, history }: WardogsGoldStatus,
  signal?: AbortSignal,
): Promise<Blob> {
  const start = history[0]?.ts ?? latest.ts;
  const days = (latest.ts - start) / GOLD_DAY_MS + 1;
  const pointsByDay = new Map(history.map((point) => [point.ts, point.price]));
  pointsByDay.set(latest.ts, latest.price);
  const high = Math.max(...pointsByDay.values());
  const width = 840;
  const inset = 30;
  const chartHeight = 150;
  const slot = (width - inset * 2) / days;
  const barWidth = Math.min(64, slot * 0.58);
  const baseline = 282;

  const rows = Array.from({ length: days }, (_, index) => {
    const ts = start + index * GOLD_DAY_MS;
    const price = pointsByDay.get(ts);
    const current = ts === latest.ts;
    const x = inset + (index + 0.5) * slot;
    const height = price === undefined ? 0 : (price / high) * chartHeight;
    const top = baseline - height;
    const bar =
      price === undefined
        ? ""
        : `<rect x="${x - barWidth / 2}" y="${top}" width="${barWidth}" height="${height}"
            rx="5" fill="${current ? gold : "#9d753e"}"/>`;
    const label =
      price === undefined ? "—" : (price < 10_000_000 ? number : compactNumber).format(price);
    return `
      ${bar}
      <text x="${x}" y="${top - 12}" text-anchor="middle" fill="${current ? gold : "#f3eee5"}"
        font-size="${label.length > 7 ? 18 : 21}" font-weight="bold">${label}</text>
      <text x="${x}" y="319" text-anchor="middle" fill="${current ? gold : "#c7c0b4"}"
        font-size="20">${dateLabel.format(ts)}</text>
    `;
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="350">
    <rect width="${width}" height="350" fill="#1b1917"/>
    <g font-family="${fontFamily}">
      <text x="${inset}" y="49" fill="${headingColor}" font-size="33" font-weight="bold">Recent gold prices</text>
      <text x="${inset}" y="81" fill="#c7c0b4" font-size="21">Cash per gold bar · UTC</text>
      <path d="M30 132H810 M30 182H810 M30 232H810 M30 282H810" stroke="#403a32" fill="none"/>
      ${rows.join("")}
    </g>
  </svg>`;
  const { renderAsync } = await import("@resvg/resvg-js");
  const image = await renderAsync(svg, { font: { defaultFontFamily: fontFamily } }, signal);
  // resvg can succeed with all text missing on hosts without fonts.
  const headingPixels = image.pixels.subarray(0, width * 56 * 4);
  if (!headingPixels.includes(Buffer.from(`${headingColor.slice(1)}ff`, "hex"))) {
    throw new Error("WARDOGS gold chart text did not render");
  }
  return new Blob([new Uint8Array(image.asPng())], { type: "image/png" });
}
