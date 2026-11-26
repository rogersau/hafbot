import { useRef, useState } from "react";
import type { PublicLandingPrice } from "./landing-prices";

type DisplayCurrency = "AUD" | "USD" | "EUR";
type Conversion = { currency: DisplayCurrency; rate: number };

export function LandingPricing({ prices }: { prices: readonly PublicLandingPrice[] }) {
  const [currency, setCurrency] = useState<DisplayCurrency>("AUD");
  const [rates, setRates] = useState<{ USD: number; EUR: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const canConvert = prices.length > 0 && prices.every((price) => price.currency === "aud");
  const loadingRates = useRef(false);

  async function changeCurrency(next: DisplayCurrency) {
    setCurrency(next);
    if (next === "AUD" || rates || loadingRates.current) return;
    loadingRates.current = true;
    setFailed(false);
    try {
      const { getLandingExchangeRates } = await import("./landing-prices");
      const value = await getLandingExchangeRates();
      setRates(value);
      setFailed(!value);
    } catch {
      setFailed(true);
    } finally {
      loadingRates.current = false;
    }
  }
  const conversion =
    currency !== "AUD" && rates && canConvert ? { currency, rate: rates[currency] } : null;
  return (
    <section className="pricing landing-shell" id="plans" aria-labelledby="plans-title">
      <header className="section-heading reveal">
        <div>
          <p className="eyebrow">HOSTED HAF PLANS</p>
          <h2 id="plans-title">Start free. Only pay if your server outgrows it.</h2>
        </div>
        <div className="pricing-summary">
          <p>
            Hosted plans cover our managed bot and dashboard, billed via Stripe. Want to host it
            yourself? Docker self-hosting is MIT-licensed and free.
          </p>
          <p>
            Assign Premium to one Discord server in Billing, or cover up to three with Premium Plus.
          </p>
          <a href="https://docs.hafbot.xyz/plans">See which features each plan includes ↗</a>
        </div>
      </header>
      {canConvert && (
        <div className="price-currency">
          <label>
            Show prices in{" "}
            <select
              value={currency}
              onChange={(event) => void changeCurrency(event.target.value as DisplayCurrency)}
            >
              <option>AUD</option>
              <option>USD</option>
              <option>EUR</option>
            </select>
          </label>
          <span role="status">
            {currency === "AUD"
              ? "Base prices in AUD. Stripe offers local currencies where available."
              : conversion
                ? `Approximate ${currency} prices. Stripe confirms your exchange rate at checkout.`
                : failed
                  ? "Exchange rates are unavailable. Showing AUD prices."
                  : "Loading exchange rates. Showing AUD prices."}
          </span>
        </div>
      )}
      <div className="plan-grid reveal">
        <article>
          <small>FREE</small>
          <h3>Get started</h3>
          <p className="plan-price">
            <strong>$0</strong>
            <span>forever</span>
          </p>
          <ul>
            <li>1 ticket panel &amp; type with standard transcripts</li>
            <li>Up to 100 player links (Steam, Xbox &amp; PlayStation)</li>
            <li>LFG, Marketplace, Suggestions and Timed Roles</li>
            <li>Up to 3 Managed Messages (drafts + live)</li>
            <li>100 MB managed storage</li>
          </ul>
          <a href="/install?continue=discord">Add to Discord</a>
        </article>
        <article className="recommended">
          <b className="recommended-label">RECOMMENDED</b>
          <small>PREMIUM</small>
          <h3>For one growing community</h3>
          <div className="stripe-prices">
            <PlanPrices prices={prices} conversion={conversion} plan="premium" />
          </div>
          <ul>
            <li>Unlimited ticket panels &amp; types, auto-replies and anonymous reports</li>
            <li>Scheduled Events, Image Rules and Mention Spam Protection</li>
            <li>Live player counts and webhooks</li>
            <li>Unlimited player links and managed messages</li>
            <li>1 GB managed storage</li>
          </ul>
          <a href="/admin/billing?plan=premium&amp;frequency=yearly">Choose Premium</a>
        </article>
        <article>
          <small>PREMIUM PLUS</small>
          <h3>Run a bigger network</h3>
          <div className="stripe-prices">
            <PlanPrices prices={prices} conversion={conversion} plan="premium_plus" />
          </div>
          <ul>
            <li>Paid features for up to 3 assigned Discord servers</li>
            <li>Same per-server features as Premium</li>
            <li>1 shared white-label bot name and brand</li>
            <li>1 GB managed storage per assigned server</li>
          </ul>
          <a href="/admin/billing?plan=premium_plus&amp;frequency=yearly">Choose Premium Plus</a>
        </article>
      </div>
      <p className="pricing-note">
        Stripe handles checkout and billing. Steam and Xbox use official sign-in; PlayStation IDs
        are self-reported. Normal Discord API and fair-use limits apply.{" "}
        <a href="/terms">See Terms</a>.
      </p>
      <p className="pricing-note">
        Rather run it on your own server? Self-hosted Docker mode is MIT-licensed and includes all
        core features → <a href="https://docs.hafbot.xyz/self-hosting">Self-hosting guide</a>
      </p>
    </section>
  );
}

function PlanPrices({
  prices,
  plan,
  conversion,
}: {
  prices: readonly PublicLandingPrice[];
  plan: PublicLandingPrice["plan"];
  conversion: Conversion | null;
}) {
  const monthly = prices.find((price) => price.plan === plan && price.frequency === "monthly");
  const yearly = prices.find((price) => price.plan === plan && price.frequency === "yearly");
  if (!monthly && !yearly) return <p className="price-fallback">View current price in Billing</p>;

  const annualAmount = Number(yearly?.decimalAmount);
  const monthlyAmount = Number(monthly?.decimalAmount);
  const savings =
    monthlyAmount > 0 && monthly?.currency === yearly?.currency
      ? Math.round(100 * (1 - annualAmount / (monthlyAmount * 12)))
      : 0;
  function format(amount: number, currency: string) {
    return new Intl.NumberFormat("en-AU", {
      style: "currency",
      currency: conversion?.currency ?? currency,
      currencyDisplay: "narrowSymbol",
    }).format(amount * (conversion?.rate ?? 1));
  }

  return (
    <>
      {[monthly, yearly]
        .filter((price): price is PublicLandingPrice => !!price)
        .map((price) => (
          <p className="stripe-price" key={price.frequency}>
            <strong>
              {conversion
                ? format(Number(price.decimalAmount), price.currency)
                : price.formattedAmount}
            </strong>
            <span>{`${conversion?.currency ?? price.currency.toUpperCase()} / ${price.frequency === "monthly" ? "month" : "year"}`}</span>
          </p>
        ))}
      {yearly && savings > 0 && (
        <p className="annual-savings">
          <b>{`Save ${savings}%`}</b> {format(annualAmount / 12, yearly.currency)}/mo billed yearly
        </p>
      )}
    </>
  );
}
