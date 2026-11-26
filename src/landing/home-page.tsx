import { CommunityGoals } from "./community-goals";
import { landingCommunity } from "./community";
import { LANDING_FAQ } from "./home-content";
import { LandingDemo } from "./landing-demo";
import { LandingPricing } from "./landing-pricing";
import type { PublicLandingPrice } from "./landing-prices";
import { MAIN_CONTENT_ID, SkipLink } from "../accessibility/skip-link";

export function LandingHomePage({
  prices,
  discordScreenshot,
  dashboardScreenshot,
}: {
  prices: readonly PublicLandingPrice[];
  discordScreenshot?: string;
  dashboardScreenshot?: string;
}) {
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
            <a className="install-link" href="/install?continue=discord">
              Add to Discord <span aria-hidden="true">↗</span>
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
              <h1 id="hero-title">Less time running Discord. More time playing.</h1>
              <p className="hero-intro">
                Tickets, player links, LFG, trading, and mod tools in one bot and one web dashboard.
                Start free on our hosted plan, or self-host with Docker on your own box.
              </p>
              <div className="hero-actions">
                <a className="button button-primary" href="/install?continue=discord">
                  Add to Discord for free <span aria-hidden="true">↗</span>
                </a>
                <a className="button button-ghost" href="#live-demo">
                  See it in action <span aria-hidden="true">↓</span>
                </a>
              </div>
              <ul className="hero-trust">
                <li>Free forever plan</li>
                <li>No card required</li>
                <li>Guided setup</li>
              </ul>
              <p className="hero-self-host">
                Want to run it yourself?{" "}
                <a href="https://docs.hafbot.xyz/self-hosting">Self-host with Docker →</a>
              </p>
            </div>

            <figure className="workspace-preview">
              <div className="workspace-panel">
                <h2>Tickets in Discord</h2>
                {discordScreenshot ? (
                  <img src={discordScreenshot} alt="HAF ticket workflow in Discord" />
                ) : (
                  <p>
                    A player opens a private ticket. Only they and the support team can see it.{" "}
                    <a href="https://docs.hafbot.xyz/features/tickets#member-flow">
                      Follow a ticket →
                    </a>
                  </p>
                )}
              </div>
              <div className="workspace-panel">
                <h2>Tickets in the staff dashboard</h2>
                {dashboardScreenshot && (
                  <a
                    href={dashboardScreenshot}
                    aria-label="View the full Tickets dashboard screenshot"
                  >
                    <img
                      src={dashboardScreenshot}
                      alt="Ticket panel settings in the HAF dashboard"
                      width={1440}
                      height={1050}
                    />
                  </a>
                )}
              </div>
              <figcaption>
                Sample server preview
                {landingCommunity.demoDiscordUrl && (
                  <>
                    {" "}
                    ·{" "}
                    <a href={landingCommunity.demoDiscordUrl}>test it live in our demo Discord →</a>
                  </>
                )}
              </figcaption>
            </figure>
          </section>

          <LandingDemo />

          <div className="lower-content">
            <CommunityGoals />
            <LandingPricing prices={prices} />

            <section className="faq landing-shell" id="faq" aria-labelledby="faq-title">
              <div className="reveal">
                <p className="eyebrow">QUICK ANSWERS</p>
                <h2 id="faq-title">Before you add another bot…</h2>
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
            <section className="final-cta landing-shell" aria-labelledby="cta-title">
              <h2 id="cta-title">Get your evenings back.</h2>
              <p>
                Add HAF Bot to your Discord and hand over the busywork tonight. Start free and
                upgrade only if you outgrow it.
              </p>
              <div className="hero-actions">
                <a className="button button-primary" href="/install?continue=discord">
                  Add to Discord for free ↗
                </a>
                <a className="button button-ghost" href="https://docs.hafbot.xyz/">
                  Browse the docs ↗
                </a>
              </div>
            </section>
          </div>
        </main>

        <footer className="site-footer">
          <div className="landing-shell">
            <a className="footer-brand" href="/" aria-label="HAF Bot home">
              <img src="/logo.png" alt="" width={30} height={30} />
              <span>HAF BOT</span>
              <small>· HELPFUL AS F**K</small>
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
