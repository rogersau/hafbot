import { landingCommunity } from "./community";

const goals = [
  {
    title: "Protect the community",
    description:
      "Stop spam, flag sketchy accounts, and keep off-topic images out of your channels.",
    features: [
      ["Reaction Rules", "features/reaction-rules"],
      ["Bot Defense", "features/bot-defense"],
      ["Image Rules", "features/image-rules"],
    ],
  },
  {
    title: "Run staff operations",
    description:
      "Give your mods clean tickets, an evidence vault, and audit logs that actually make sense.",
    features: [
      ["Tickets", "features/tickets"],
      ["Evidence Vault", "features/evidence-vault"],
      ["Guild Audit Log", "features/guild-audit-log"],
    ],
  },
  {
    title: "Help members participate",
    description:
      "Let players squad up, trade, join events, and vote on suggestions. Everyone can see what the mods decide.",
    features: [
      ["Looking for Group", "features/lfg"],
      ["Marketplace", "features/marketplace"],
      ["Events", "features/events"],
      ["Suggestions", "features/suggestions"],
      ["Levels (Beta)", "features/server-levels"],
    ],
  },
  {
    title: "Connect players and systems",
    description:
      "Link player accounts, pull live player counts, fire webhooks, and hook up supported game servers like DayZ.",
    features: [
      ["Player Link (Steam, Xbox & PS)", "features/player-link"],
      ["Live Player Counts", "features/player-count"],
      ["Webhooks", "features/webhook-proxy"],
      ["Game Server Integrations", "#game-server-integrations"],
    ],
  },
  {
    title: "Manage access and communications",
    description:
      "Automate timed roles, member verification, and sticky messages you can edit anytime.",
    features: [
      ["Member Verification", "features/member-verification"],
      ["Timed Roles", "features/timed-roles"],
      ["Managed Messages", "features/managed-messages"],
    ],
  },
] as const;

export function CommunityGoals() {
  return (
    <div className="landing-shell">
      <section className="section-heading consolidation" aria-labelledby="consolidation-title">
        <h2 id="consolidation-title">One bot. Zero bot bloat.</h2>
        <p>
          Ditch the messy stack of separate ticket bots, mod bots, and LFG bots. HAF handles the
          busywork from one dashboard.
        </p>
      </section>
      <section className="goals" aria-labelledby="goals-title">
        <header className="section-heading">
          <h2 id="goals-title">What should HAF help your community do?</h2>
        </header>
        <div className="goal-accordion">
          {goals.map(({ title, description, features }, index) => (
            <details key={title} open={index === 0}>
              <summary>
                <span className="goal-index" aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}
                </span>
                {title}
              </summary>
              <div>
                <p>{description}</p>
                <ul>
                  {features.map(([name, path]) => (
                    <li key={path}>
                      <a href={`https://docs.hafbot.xyz/${path}`}>{name}</a>
                    </li>
                  ))}
                </ul>
              </div>
            </details>
          ))}
        </div>
      </section>
      <aside className="community-proof" aria-label="HAF in the open">
        <p>HAF is open source. See exactly what you’re adding to your server.</p>
        <a href="https://github.com/rogersau/hafbot">MIT-licensed source on GitHub ↗</a>
        {landingCommunity.demoDiscordUrl && (
          <a className="button button-ghost" href={landingCommunity.demoDiscordUrl}>
            Try HAF in our Demo Discord ↗
          </a>
        )}
      </aside>
    </div>
  );
}
