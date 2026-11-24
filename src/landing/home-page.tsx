import { LANDING_FAQ } from "./home-content";
import { LandingDemo } from "./landing-demo";
import type { PublicLandingPrice } from "./landing-prices";
import { FirstWorkflowSelector } from "./first-workflow-selector";
import { MAIN_CONTENT_ID, SkipLink } from "../accessibility/skip-link";

export function LandingHomePage({ prices }: { prices: readonly PublicLandingPrice[] }) {
  return (
    <>
      <div className="signal-field" aria-hidden="true">
        <i />
        <i />
        <i />
        <span />
        <span />
        <span />
      </div>
      <div className="landing-page">
        <SkipLink />
        <header className="site-header">
          <nav className="landing-shell site-nav" aria-label="Main navigation">
            <a className="brand" href="/" aria-label="HAF Bot home">
              <img src="/logo.png" alt="" width={42} height={42} />
              <span>HAF BOT</span>
            </a>
            <a className="login-link" href="#plans">
              Pricing
            </a>
            <a className="login-link" href="https://docs.hafbot.xyz/">
              Docs
            </a>
            <a className="login-link" href="/changelog">
              What's New
            </a>
            <a className="login-link" href="/admin">
              Login
            </a>
            <a className="install-link" href="/install">
              Install <span aria-hidden="true">↗</span>
            </a>
          </nav>
        </header>

        <main id={MAIN_CONTENT_ID} tabIndex={-1}>
          <section className="hero landing-shell" aria-labelledby="hero-title">
            <div className="hero-copy">
              <p className="eyebrow">
                <span className="eyebrow-dot" aria-hidden="true"></span>BUILT FOR DISCORD GAMING
                COMMUNITIES
              </p>
              <h1 id="hero-title">Handle player reports in private.</h1>
              <p className="hero-intro">
                HAF Bot adds private support tickets and a staff dashboard to your gaming Discord.
                Choose one workflow, set it up, and test it as a member.
              </p>
              <div className="hero-actions">
                <a className="button button-primary" href="#first-workflow">
                  Choose your first workflow <span aria-hidden="true">↓</span>
                </a>
              </div>
              <ul className="hero-trust">
                <li>Start free, no card required</li>
              </ul>
            </div>

            <div
              className="radar-scope"
              role="img"
              aria-label="Illustration of example HAF Bot activity: a private ticket, a welcome role, an LFG application and moderator review. Not live customer data."
            >
              <div className="scope-frame">
                <header className="scope-bar">
                  <span className="scope-status">
                    <i aria-hidden="true" />
                    EXAMPLE ACTIVITY
                  </span>
                  <span className="scope-id">HAF COMMUNITY · AU</span>
                </header>
                <div className="scope-display">
                  <span className="scope-bearing bearing-0">000</span>
                  <span className="scope-bearing bearing-90">090</span>
                  <span className="scope-bearing bearing-180">180</span>
                  <span className="scope-bearing bearing-270">270</span>
                  <div className="scope-sweep" aria-hidden="true"></div>
                  <div className="scope-blip blip-verified">
                    <i aria-hidden="true" />
                    <b>Welcome role granted</b>
                  </div>
                  <div className="scope-blip blip-lfg">
                    <i aria-hidden="true" />
                    <b>LFG application</b>
                  </div>
                  <div className="scope-blip blip-trade">
                    <i aria-hidden="true" />
                    <b>Private ticket opened</b>
                  </div>
                  <div className="scope-blip blip-moderation">
                    <i aria-hidden="true" />
                    <b>Mod queue cleared</b>
                  </div>
                  <img className="scope-logo" src="/logo.png" alt="" />
                </div>
                <footer className="scope-bar scope-readouts">
                  <span>ILLUSTRATIVE PREVIEW</span>
                  <span>NOT LIVE DATA</span>
                </footer>
              </div>
            </div>
          </section>

          <FirstWorkflowSelector />
          <LandingDemo />

          <div className="lower-content">
            <section className="pricing landing-shell" id="plans" aria-labelledby="plans-title">
              <header className="section-heading reveal">
                <div>
                  <p className="eyebrow">HOSTED HAF PLANS</p>
                  <h2 id="plans-title">Start free. Upgrade when your community needs more.</h2>
                </div>
                <div className="pricing-summary">
                  <p>
                    These plans cover the hosted HAF service. Stripe handles monthly and yearly
                    payments. Self-hosted mode includes core features with your own external
                    services.
                  </p>
                  <p>
                    Buying a plan does not upgrade every server you manage. After purchase, choose
                    one eligible Discord server in Billing with Premium, or up to three with Premium
                    Plus.
                  </p>
                  <a href="https://docs.hafbot.xyz/plans">Compare every feature and plan limit ↗</a>
                </div>
              </header>
              <div className="plan-grid reveal">
                <article>
                  <small>FREE</small>
                  <h3>Get started</h3>
                  <p className="plan-price">
                    <strong>$0</strong>
                    <span>forever</span>
                  </p>
                  <ul>
                    <li>1 ticket panel and type, with ordinary transcripts</li>
                    <li>Up to 100 player links across supported platforms</li>
                    <li>LFG, Marketplace, Suggestions and Timed Roles</li>
                    <li>3 Managed Messages total across drafts and published messages</li>
                    <li>100 MB managed storage</li>
                  </ul>
                  <a href="/install">Add to Discord</a>
                </article>
                <article className="recommended">
                  <b className="recommended-label">RECOMMENDED</b>
                  <small>PREMIUM</small>
                  <h3>When Free is not enough</h3>
                  <div className="stripe-prices">
                    <PlanPrices prices={prices} plan="premium" />
                  </div>
                  <ul>
                    <li>Separate ticket types for support and reports</li>
                    <li>Scheduled Events, Image Rules or Mention Spam Protection</li>
                    <li>Player Count or Webhooks</li>
                    <li>More than 100 Player Links or more than 3 Managed Messages</li>
                    <li>1 GB managed storage</li>
                  </ul>
                  <a href="/admin/billing?plan=premium&amp;frequency=yearly">Choose Premium</a>
                </article>
                <article>
                  <small>PREMIUM PLUS</small>
                  <h3>Run a bigger network</h3>
                  <div className="stripe-prices">
                    <PlanPrices prices={prices} plan="premium_plus" />
                  </div>
                  <ul>
                    <li>Paid features for up to 3 assigned Discord servers</li>
                    <li>Same per-server features as Premium</li>
                    <li>1 shared white-label bot name and brand</li>
                    <li>1 GB managed storage per assigned server</li>
                  </ul>
                  <a href="/admin/billing?plan=premium_plus&amp;frequency=yearly">
                    Choose Premium Plus
                  </a>
                </article>
              </div>
              <p className="pricing-note">
                {prices.length > 0
                  ? "Standard subscription prices. Prices come straight from Stripe."
                  : "Log in to Billing to see the current paid prices."}
              </p>
              <p className="pricing-note">
                Discord limits, storage allowances and abuse safeguards still apply. Steam and Xbox
                links use platform sign-in; PlayStation IDs are self-reported.
              </p>
            </section>

            <section className="faq landing-shell" id="faq" aria-labelledby="faq-title">
              <div className="reveal">
                <p className="eyebrow">QUICK ANSWERS</p>
                <h2 id="faq-title">Before you install</h2>
              </div>
              <div className="reveal">
                {LANDING_FAQ.map(({ question, answer, guide }) => (
                  <details key={question}>
                    <summary>{question}</summary>
                    <p>
                      {answer}
                      {guide && (
                        <>
                          {" "}
                          <a href={guide.href}>{guide.text}</a>.
                        </>
                      )}
                    </p>
                  </details>
                ))}
              </div>
            </section>
          </div>
        </main>

        <footer className="site-footer">
          <div className="landing-shell">
            <a className="footer-brand" href="/" aria-label="HAF Bot home">
              <img src="/logo.png" alt="" width={30} height={30} />
              <span>HAF BOT</span>
              <small>HELPFUL AS F**K</small>
            </a>
            <nav aria-label="Footer navigation">
              <a href="https://docs.hafbot.xyz/">Docs</a>
              <a href="/changelog">What's New</a>
              <a href="/changelog.xml">Subscribe to updates</a>
              <a href="https://docs.hafbot.xyz/self-hosting">Self-host</a>
              <a href="https://discord.gg/HpRPkdm6dv">Support</a>
              <a href="/terms">Terms</a>
              <a href="/privacy">Privacy</a>
            </nav>
          </div>
        </footer>
      </div>
    </>
  );
}

function PlanPrices({
  prices,
  plan,
}: {
  prices: readonly PublicLandingPrice[];
  plan: PublicLandingPrice["plan"];
}) {
  const planPrices = prices
    .filter((price) => price.plan === plan)
    .sort((left, right) => left.frequency.localeCompare(right.frequency));
  if (planPrices.length === 0) {
    return <p className="price-fallback">View current price in Billing</p>;
  }

  return planPrices.map((price) => (
    <p className="stripe-price" key={price.frequency}>
      <strong>{price.formattedAmount}</strong>
      <span>{`${price.currency.toUpperCase()} / ${price.frequency === "monthly" ? "month" : "year"}`}</span>
    </p>
  ));
}
