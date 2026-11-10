import { htmlResponse } from "../http/html-response";
import { escapeHtml } from "../routes/commerce-branding";
import type { BanAppealPublicState } from "./types";

export function renderBanAppealPage(input: {
  guildId: string;
  state?: BanAppealPublicState;
  publicBaseUrl: string;
  error?: string;
  status?: number;
  nowMs?: number;
}): Response {
  const state = input.state;
  const title = state?.config.title ?? "Discord ban appeal";
  const callbackUrl = new URL(`/ban-appeals/${input.guildId}`, input.publicBaseUrl).toString();
  const now = input.nowMs ?? Date.now();
  const open = state?.appeal?.status === "pending" || state?.appeal?.status === "unban_pending";
  const outcome = state?.appeal
    ? {
        pending: "Your appeal is awaiting staff review.",
        unban_pending: "Staff are confirming an unban request. You do not need to submit again.",
        unbanned: "Your appeal was approved and the Discord ban was removed.",
        rejected: "Staff rejected this appeal.",
      }[state.appeal.status]
    : "";
  const canSubmit = Boolean(
    state?.signedInName &&
    state.config.enabled &&
    state.currentBan &&
    !open &&
    state.nextSubmissionAtMs <= now,
  );
  const message =
    input.error ??
    (!state?.config.enabled
      ? "Ban appeals are not enabled for this server."
      : !state.signedInName
        ? "Sign in with the Discord account that was banned to submit an appeal."
        : open
          ? outcome
          : !state.currentBan
            ? "Your Discord account is not currently banned from this server."
            : state.nextSubmissionAtMs > now
              ? `You can submit another appeal after ${new Date(state.nextSubmissionAtMs).toISOString().replace("T", " ").replace(".000Z", " UTC")}.`
              : "Your appeal will be visible only to authorised server staff.");
  const nonce = crypto.randomUUID();
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} — HAF Bot</title>
  <style nonce="${nonce}">:root{color-scheme:dark light}*{box-sizing:border-box}body{margin:0;background:light-dark(#f5f7fb,#10131a);color:light-dark(#17202c,#e9edf6);font:16px/1.55 system-ui,sans-serif}main{max-width:680px;margin:0 auto;padding:32px 20px}h1{font-size:1.8rem;line-height:1.2}p{white-space:pre-wrap;overflow-wrap:anywhere}.muted{opacity:.75}.notice{padding:16px;border:1px solid light-dark(#ccd3df,#424c60);border-radius:8px}button,textarea{font:inherit}button{border:0;border-radius:6px;background:light-dark(#243c80,#a8c2ff);color:light-dark(#fff,#10131a);padding:12px 18px;cursor:pointer}button:disabled{opacity:.6;cursor:wait}textarea{display:block;width:100%;margin:8px 0 16px;border:1px solid light-dark(#a9b1c0,#596579);border-radius:6px;padding:12px;background:light-dark(#fff,#1b202b);color:inherit;resize:vertical;min-height:180px}label{font-weight:600}a{color:inherit}details{margin:20px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}footer{margin-top:32px;opacity:.75;font-size:.9rem}:focus-visible{outline:3px solid light-dark(#3158a0,#b8cdff);outline-offset:3px}</style>
  <script src="/assets/ban-appeals.js" defer></script></head><body><main data-ban-appeal-page data-callback-url="${escapeHtml(callbackUrl)}" data-api-path="/api/ban-appeals/${input.guildId}">
  <p class="muted">HAF Bot · Server moderation</p><h1>${escapeHtml(title)}</h1>${state?.config.instructions ? `<p>${escapeHtml(state.config.instructions)}</p>` : ""}
  ${state?.signedInName ? `<p>Signed in as <strong>${escapeHtml(state.signedInName)}</strong>.</p>` : ""}<p class="notice" role="status">${escapeHtml(message)}</p>
  ${!input.error && state?.config.enabled && !state.signedInName ? `<button type="button" data-sign-in>Sign in with Discord</button>` : ""}
  ${state?.appeal && !open ? `<p>${escapeHtml(outcome)}</p>` : ""}
  ${state?.appeal ? `<details><summary>Your latest submitted appeal</summary><pre>${escapeHtml(state.appeal.text)}</pre></details>` : ""}
  ${canSubmit ? `<form data-appeal-form data-request-id="${crypto.randomUUID()}"><label for="appeal-text">Why should staff review your ban?</label><textarea id="appeal-text" name="text" required minlength="20" maxlength="4000" aria-describedby="appeal-help"></textarea><p id="appeal-help" class="muted">20–4000 characters. One appeal can be open at a time.</p><button type="submit">Submit appeal</button></form>` : ""}
  <p data-error role="alert" hidden></p><footer><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="${escapeHtml(callbackUrl)}">Refresh status</a></footer></main></body></html>`;
  return htmlResponse({
    profile: "admin",
    html,
    status: input.status,
    requestUrl: new URL(callbackUrl),
    styleNonce: nonce,
  });
}

export const BAN_APPEAL_CLIENT_SCRIPT = `"use strict";
(()=>{
 const root=document.querySelector('[data-ban-appeal-page]');if(!root)return;
 const error=root.querySelector('[data-error]');
 const fail=(message)=>{error.textContent=message;error.hidden=false;};
 const signIn=root.querySelector('[data-sign-in]');
 if(signIn)signIn.addEventListener('click',async()=>{signIn.disabled=true;try{
   const callback=new URL(root.dataset.callbackUrl);if(callback.origin!==location.origin)throw new Error('Open this page on the official HAF Bot address.');
   const response=await fetch('/api/auth/sign-in/social',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({provider:'discord',callbackURL:callback.toString()})});
   const data=await response.json();if(!response.ok||typeof data.url!=='string')throw new Error('Discord sign-in is temporarily unavailable.');
   const target=new URL(data.url);if(target.protocol!=='https:'||!['discord.com','discordapp.com'].includes(target.hostname))throw new Error('Discord sign-in returned an unexpected address.');
   location.assign(target.toString());
 }catch(cause){fail(cause instanceof Error?cause.message:'Could not sign in with Discord.');signIn.disabled=false;}});
 const form=root.querySelector('[data-appeal-form]');if(form)form.addEventListener('submit',async(event)=>{event.preventDefault();if(!form.reportValidity())return;const button=form.querySelector('button');button.disabled=true;error.hidden=true;try{
   const response=await fetch(root.dataset.apiPath,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({id:form.dataset.requestId,text:form.elements.namedItem('text').value})});
   const data=await response.json();if(!response.ok)throw new Error(typeof data.error==='string'?data.error:'Could not submit the appeal.');location.reload();
 }catch(cause){fail(cause instanceof Error?cause.message:'Could not submit the appeal.');button.disabled=false;}});
})();`;
