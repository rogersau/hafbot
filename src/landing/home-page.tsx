import { LANDING_FAQ } from "./home-content";
import { LandingDemo } from "./landing-demo";
import type { PublicLandingPrice } from "./landing-prices";

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

        <main>
          <section className="hero landing-shell" aria-labelledby="hero-title">
            <div className="hero-copy">
              <p className="eyebrow">
                <span className="eyebrow-dot" aria-hidden="true"></span>BUILT FOR DISCORD GAMING
                COMMUNITIES
              </p>
              <h1 id="hero-title">Less time running Discord. More time playing.</h1>
              <p className="hero-intro">
                A Discord bot for gaming communities: handle player reports in private tickets, link
                game accounts, organise groups and automate moderation from one web dashboard. Start
                with one useful workflow on the hosted free plan, or self-host with Docker on your
                own infrastructure.
              </p>
              <div className="hero-actions">
                <a className="button button-primary" href="/install">
                  Add HAF Bot to Discord <span aria-hidden="true">↗</span>
                </a>
                <a className="button button-ghost" href="#live-demo">
                  See it in action <span aria-hidden="true">↓</span>
                </a>
                <a className="button button-ghost" href="https://docs.hafbot.xyz/self-hosting">
                  Self-host HAF <span aria-hidden="true">↗</span>
                </a>
              </div>
              <ul className="hero-trust">
                <li>Free forever plan</li>
                <li>No card required</li>
                <li>Guided setup</li>
              </ul>
            </div>

            <div
              className="radar-scope"
              role="img"
              aria-label="Illustration of example HAF Bot activity: member verification, an LFG application, a trade post and moderator review. Not live customer data."
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
                    <b>Member verified</b>
                  </div>
                  <div className="scope-blip blip-lfg">
                    <i aria-hidden="true" />
                    <b>LFG application</b>
                  </div>
                  <div className="scope-blip blip-trade">
                    <i aria-hidden="true" />
                    <b>Trade posted</b>
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

          <LandingDemo />

          <section className="operations-strip" aria-label="What HAF Bot covers">
            <div className="landing-shell">
              <p>One bot. Less admin. More time for your community.</p>
              <div className="capability-marquee" aria-hidden="true">
                <div className="marquee-track">
                  <span>WELCOME</span>
                  <span>VERIFY</span>
                  <span>FIND SQUADS</span>
                  <span>TRADE</span>
                  <span>MODERATE</span>
                  <span>LOG</span>
                  <span>ANNOUNCE</span>
                  <span>SCHEDULE</span>
                </div>
                <div className="marquee-track">
                  <span>WELCOME</span>
                  <span>VERIFY</span>
                  <span>FIND SQUADS</span>
                  <span>TRADE</span>
                  <span>MODERATE</span>
                  <span>LOG</span>
                  <span>ANNOUNCE</span>
                  <span>SCHEDULE</span>
                </div>
              </div>
            </div>
          </section>

          <div className="lower-content">
            <section className="goals landing-shell" aria-labelledby="goals-title">
              <header className="section-heading reveal">
                <div>
                  <p className="eyebrow">START WITH WHAT YOU WANT TO IMPROVE</p>
                  <h2 id="goals-title">What should HAF help your community do?</h2>
                </div>
                <p>
                  Open a goal to see a practical starting point. You can add more features whenever
                  your community needs them.
                </p>
              </header>
              <div className="goal-accordion reveal">
                <details open>
                  <summary>
                    <span className="goal-index" aria-hidden="true">
                      01
                    </span>
                    <span className="goal-title">Protect the community</span>
                  </summary>
                  <div>
                    <p>
                      Limit unwanted reactions, flag suspicious accounts and review off-topic
                      images.
                    </p>
                    <ul>
                      <li>
                        <a href="https://docs.hafbot.xyz/features/reaction-rules">Reaction Rules</a>
                      </li>
                      <li>
                        <a href="https://docs.hafbot.xyz/features/bot-defense">Bot Defense</a>
                      </li>
                      <li>
                        <a href="https://docs.hafbot.xyz/features/image-rules">Image Rules</a>
                      </li>
                    </ul>
                  </div>
                </details>
                <details>
                  <summary>
                    <span className="goal-index" aria-hidden="true">
                      02
                    </span>
                    <span className="goal-title">Run staff operations</span>
                  </summary>
                  <div>
                    <p>Give staff dependable support, evidence, and audit workflows.</p>
                    <ul>
                      <li>
                        <a href="https://docs.hafbot.xyz/features/tickets">Tickets</a>
                      </li>
                      <li>
                        <a href="https://docs.hafbot.xyz/features/evidence-vault">Evidence Vault</a>
                      </li>
                      <li>
                        <a href="https://docs.hafbot.xyz/features/guild-audit-log">
                          Guild Audit Log
                        </a>
                      </li>
                    </ul>
                  </div>
                </details>
                <details>
                  <summary>
                    <span className="goal-index" aria-hidden="true">
                      03
                    </span>
                    <span className="goal-title">Help members participate</span>
                  </summary>
                  <div>
                    <p>
                      Help members find groups, trade, join events, and turn structured Suggestions
                      into transparent community decisions with visible staff outcomes.
                    </p>
                    <ul>
                      <li>
                        <a href="https://docs.hafbot.xyz/features/lfg">Looking for Group</a>
                      </li>
                      <li>
                        <a href="https://docs.hafbot.xyz/features/marketplace">Marketplace</a>
                      </li>
                      <li>
                        <a href="https://docs.hafbot.xyz/features/suggestions">Suggestions</a>
                      </li>
                      <li>
                        <a href="https://docs.hafbot.xyz/features/events">Events</a>
                      </li>
                    </ul>
                  </div>
                </details>
                <details>
                  <summary>
                    <span className="goal-index" aria-hidden="true">
                      04
                    </span>
                    <span className="goal-title">Connect players and systems</span>
                  </summary>
                  <div>
                    <p>Connect player identities, game servers, and trusted external services.</p>
                    <ul>
                      <li>
                        <a href="https://docs.hafbot.xyz/features/player-link">Player Link</a>
                      </li>
                      <li>
                        <a href="https://docs.hafbot.xyz/features/player-count">Player Count</a>
                      </li>
                      <li>
                        <a href="https://docs.hafbot.xyz/features/webhook-proxy">Webhooks</a>
                      </li>
                      <li>
                        <a href="https://docs.hafbot.xyz/features/server-levels">
                          DayZ Server Levels (Beta)
                        </a>
                      </li>
                      <li>
                        <a href="https://docs.hafbot.xyz/guides/wardogs-discord-community">
                          WARDOGS Discord setup and status
                        </a>
                      </li>
                    </ul>
                  </div>
                </details>
                <details>
                  <summary>
                    <span className="goal-index" aria-hidden="true">
                      05
                    </span>
                    <span className="goal-title">Manage access and communications</span>
                  </summary>
                  <div>
                    <p>Automate temporary access and keep important Discord messages current.</p>
                    <ul>
                      <li>
                        <a href="https://docs.hafbot.xyz/features/timed-roles">Timed Roles</a>
                      </li>
                      <li>
                        <a href="https://docs.hafbot.xyz/features/managed-messages">
                          Managed Messages
                        </a>
                      </li>
                      <li>
                        <a href="https://docs.hafbot.xyz/features/member-verification">
                          Member Verification
                        </a>
                      </li>
                    </ul>
                  </div>
                </details>
              </div>
            </section>

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
                    <li>3 managed messages, including drafts · 100 MB storage</li>
                  </ul>
                  <a href="/install">Add to Discord</a>
                </article>
                <article className="recommended">
                  <b className="recommended-label">RECOMMENDED</b>
                  <small>PREMIUM</small>
                  <h3>Level up one community</h3>
                  <div className="stripe-prices">
                    <PlanPrices prices={prices} plan="premium" />
                  </div>
                  <ul>
                    <li>Paid features for 1 assigned Discord server</li>
                    <li>More ticket types, advanced ticket tools and Events</li>
                    <li>No plan quantity limit on player links or managed messages</li>
                    <li>1 GB managed storage · monthly or yearly billing</li>
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
                <h2 id="faq-title">Before you add another bot…</h2>
              </div>
              <div className="reveal">
                {LANDING_FAQ.map(({ question, answer, guide }, index) => (
                  <details key={question} open={index === 0}>
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
              <div className="final-cta-card reveal">
                <div className="final-cta-ping" aria-hidden="true"></div>
                <p className="eyebrow">READY WHEN YOU ARE</p>
                <h2 id="cta-title">Get your evenings back.</h2>
                <p>
                  Add HAF Bot to your Discord and hand over the busywork tonight. Free plan
                  included—upgrade only if you outgrow it.
                </p>
                <div className="hero-actions">
                  <a className="button button-primary" href="/install">
                    Add HAF Bot to Discord <span aria-hidden="true">↗</span>
                  </a>
                  <a className="button button-ghost" href="https://docs.hafbot.xyz">
                    Browse the docs <span aria-hidden="true">↗</span>
                  </a>
                </div>
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
