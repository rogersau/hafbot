import {
  commerceAccentForeground,
  commerceAccentHex,
  defaultCommerceBranding,
  type CommercePublicBranding,
} from "../commerce/branding";
import { htmlResponse } from "../http/html-response";

export interface CommercePageOptions {
  title: string;
  description?: string;
  content: string;
  branding?: CommercePublicBranding;
  status?: number;
  requestUrl?: URL;
}

export function renderCommercePage(options: CommercePageOptions): Response {
  const branding = options.branding ?? defaultCommerceBranding("HAF Bot Commerce");
  const accent = commerceAccentHex(branding.accentColor);
  const foreground = commerceAccentForeground(branding.accentColor);
  const icon = safeDiscordIconUrl(branding.guildIconUrl);
  const description = options.description ?? branding.tagline;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(options.title)} — HAF Bot Commerce</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta property="og:title" content="${escapeHtml(options.title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:type" content="website">
  ${icon ? `<meta property="og:image" content="${escapeHtml(icon)}">` : ""}
  <style>
  :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#10131a;color:#e9edf6;font:16px/1.55 system-ui,sans-serif}
  .commerce-shell{max-width:1040px;margin:0 auto;padding:20px 18px 36px}.commerce-topbar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0;color:#aeb8c9;font-size:.9rem}.commerce-brand{display:flex;align-items:center;gap:9px;color:#f3f6ff;font-weight:700}.commerce-mark{display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:${accent};color:${foreground};font-weight:800}.commerce-hero{position:relative;min-height:188px;overflow:hidden;padding:24px;border:1px solid #303848;border-radius:16px;background:radial-gradient(circle at 20% 22%, ${accent}b3, transparent 42%),linear-gradient(135deg,#15324c,#252b60)}.commerce-hero:after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,transparent 20%,#070a10cc)}.commerce-identity{position:absolute;z-index:1;left:24px;right:24px;bottom:22px;display:flex;align-items:end;gap:15px;color:#fff}.commerce-icon{display:grid;place-items:center;width:72px;height:72px;flex:0 0 auto;border:2px solid #fff;border-radius:20px;background:#1d3f5b;box-shadow:0 8px 24px #0006;font-size:28px}.commerce-icon img{width:100%;height:100%;object-fit:cover;border-radius:18px}.commerce-identity h1{margin:0 0 2px;font-size:1.7rem;line-height:1.15}.commerce-tagline{margin:0;color:#e2efff}.commerce-content{display:grid;gap:18px;margin-top:18px}.commerce-content>*{margin-block:0}.commerce-card{padding:24px;border:1px solid #303848;border-radius:14px;background:#1b202b}.commerce-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(280px,340px);gap:18px}.commerce-grid-wide{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:16px}.commerce-card h1,.commerce-card h2,.commerce-card h3{line-height:1.2}.commerce-card h1{margin:0 0 8px}.commerce-card h2{margin:0 0 10px;font-size:1.35rem}.commerce-card h3{margin:22px 0 9px;font-size:1.05rem}.commerce-eyebrow{margin:0 0 9px;color:#aeb8c9;font-size:.9rem}.commerce-muted,.commerce-description{color:#aeb8c9}.commerce-price{margin:12px 0;font-size:2rem;font-weight:750}.commerce-price span{color:#aeb8c9;font-size:1rem;font-weight:400}.commerce-benefits,.commerce-terms{margin:0;padding-left:20px;color:#d1d9e8}.commerce-benefits li,.commerce-terms li{margin:.5rem 0}.commerce-role{display:inline-flex;align-items:center;gap:7px;padding:6px 10px;border-radius:999px;color:#d8edff;background:#15364c}.commerce-role-dot{width:8px;height:8px;border-radius:50%;background:#61d3ff}.commerce-actions{display:grid;gap:11px;margin-top:20px}.commerce-button,.commerce-button-secondary{display:inline-block;border:0;border-radius:8px;padding:12px 17px;color:${foreground};background:${accent};font:inherit;font-weight:700;text-align:center;text-decoration:none;cursor:pointer}.commerce-button-secondary{background:#353f52;color:#fff}.commerce-button:focus-visible,.commerce-button-secondary:focus-visible{outline:3px solid #c8d1ff;outline-offset:3px}.commerce-notice,.commerce-status{padding:12px 15px;border-radius:8px;background:#252c39;color:#d4deef}.commerce-status{margin-top:20px}.commerce-error{border-left:4px solid #ef6b73}.commerce-locked{opacity:.75}.commerce-fixed{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px}.commerce-fixed-label{padding:3px 8px;border-radius:999px;background:#303848;color:#cbd5e7;font-size:.8rem}.commerce-footer{display:flex;justify-content:space-between;gap:15px;padding:20px 2px 0;color:#8f9bb2;font-size:.85rem}.commerce-footer a{color:#bac6dd}.commerce-form{margin:0}.commerce-fieldset{display:grid;gap:10px;margin:16px 0;padding:14px;border:1px solid #3b4557;border-radius:8px}.commerce-fieldset label{display:flex;gap:8px;align-items:center}.commerce-fieldset input[type=text],.commerce-fieldset input[type=number],.commerce-fieldset input:not([type]){width:100%;padding:9px;border:1px solid #4b5568;border-radius:6px;background:#151923;color:#fff}
  @media(max-width:960px){.commerce-grid{grid-template-columns:1fr}}
  @media(max-width:760px){.commerce-shell{padding:12px 12px 28px}.commerce-hero{min-height:170px}.commerce-identity{left:18px;right:18px;bottom:16px}.commerce-icon{width:62px;height:62px;border-radius:17px}.commerce-icon img{border-radius:15px}.commerce-footer{flex-direction:column}.commerce-topbar{font-size:.82rem}}
  </style></head><body><div class="commerce-shell">
  <header class="commerce-topbar"><div class="commerce-brand"><span class="commerce-mark">H</span><span>HAF Bot</span><span class="commerce-muted">Commerce</span></div><span>Secure seller checkout</span></header>
  <section class="commerce-hero" aria-label="${escapeHtml(branding.guildName)} branding"><div class="commerce-identity"><div class="commerce-icon">${icon ? `<img src="${escapeHtml(icon)}" alt="">` : "❄"}</div><div><h1>${escapeHtml(branding.guildName)}</h1><p class="commerce-tagline">${escapeHtml(branding.tagline || "Support the server and unlock a closer community experience.")}</p></div></div></section>
  <main class="commerce-content">${options.content}</main>
  <footer class="commerce-footer"><span>HAF Bot facilitates payment and Discord entitlement delivery.</span><span>Privacy · Terms · Seller support</span></footer>
  </div></body></html>`;
  return htmlResponse({
    profile: "commerce",
    html,
    status: options.status,
    requestUrl: options.requestUrl,
  });
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeDiscordIconUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "cdn.discordapp.com" ||
      !/^\/icons\/[A-Za-z0-9_-]{2,100}\/[A-Za-z0-9_-]{2,200}\.png$/.test(url.pathname)
    )
      return null;
    return url.toString();
  } catch {
    return null;
  }
}
