import type { WardogsGoldStatus } from "./community-data";
import { GOLD_DAY_MS } from "./gold-status";

const dateLabel = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const number = new Intl.NumberFormat("en-US");

export async function renderWardogsGoldChart(
  { latest, history }: WardogsGoldStatus,
  signal?: AbortSignal,
): Promise<Blob> {
  const start = history[0]?.ts ?? latest.ts;
  const days = (latest.ts - start) / GOLD_DAY_MS + 1;
  const pointsByDay = new Map(history.map((point) => [point.ts, point.price]));
  pointsByDay.set(latest.ts, latest.price);
  const high = Math.max(...pointsByDay.values());
  const chartWidth = 680;
  const chartHeight = 180;
  const slot = chartWidth / days;
  const barWidth = Math.min(52, slot * 0.65);
  const baseline = 314;

  const rows = Array.from({ length: days }, (_, index) => {
    const ts = start + index * GOLD_DAY_MS;
    const price = pointsByDay.get(ts);
    const x = 40 + (index + 0.5) * slot;
    const height = price === undefined ? 0 : (price / high) * chartHeight;
    const bar =
      price === undefined
        ? ""
        : `<rect x="${x - barWidth / 2}" y="${baseline - height}" width="${barWidth}" height="${height}"
            rx="4" fill="${ts === latest.ts ? "#facc68" : "#b7863b"}"/>`;
    return `
      ${bar}
      <text x="${x}" y="${baseline - height - 10}" text-anchor="middle" fill="#f8fafc" font-size="13">
        ${price === undefined ? "—" : number.format(price)}
      </text>
      <text x="${x}" y="340" text-anchor="middle" fill="#cbd5e1" font-size="15">${dateLabel.format(ts)}</text>
    `;
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="760" height="380" viewBox="0 0 760 380">
    <rect width="760" height="380" fill="#17202d"/>
    <rect x="40" y="36" width="32" height="4" rx="2" fill="#facc68"/>
    <g font-family="DejaVu Sans, sans-serif">
      <text x="40" y="77" fill="#f8fafc" font-size="29" font-weight="bold">WARDOGS Gold Exchange</text>
      <text x="40" y="105" fill="#cbd5e1" font-size="16">Cash per gold bar · UTC</text>
      <path d="M40 134H720 M40 194H720 M40 254H720 M40 314H720" stroke="#465568" fill="none"/>
      ${rows.join("")}
    </g>
  </svg>`;
  const { renderAsync } = await import("@resvg/resvg-js");
  const png = (await renderAsync(svg, null, signal)).asPng();
  return new Blob([new Uint8Array(png)], { type: "image/png" });
}
