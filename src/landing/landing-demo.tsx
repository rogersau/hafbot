import { useEffect, useRef, useState, type KeyboardEvent } from "react";

const CHANNELS = [
  { id: "announcements", label: "announcements" },
  { id: "community", label: "community-hub" },
  { id: "mod-queue", label: "mod-queue" },
  { id: "audit-log", label: "audit-log" },
  { id: "welcome", label: "welcome" },
  { id: "looking-for-group", label: "looking-for-group" },
  { id: "marketplace", label: "marketplace" },
  { id: "evidence-vault", label: "evidence-vault" },
];

export function LandingDemo() {
  const [activeIndex, setActiveIndex] = useState(1);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const tabList = useRef<HTMLDivElement>(null);
  const messageContent = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!mobileNavOpen) return;
    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setMobileNavOpen(false);
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [mobileNavOpen]);

  function activate(index: number) {
    setActiveIndex(index);
    setMobileNavOpen(false);
    if (messageContent.current) messageContent.current.scrollTop = 0;
  }

  function selectByKeyboard(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number;
    switch (event.key) {
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = CHANNELS.length - 1;
        break;
      case "ArrowDown":
      case "ArrowRight":
        nextIndex = (index + 1) % CHANNELS.length;
        break;
      case "ArrowUp":
      case "ArrowLeft":
        nextIndex = (index - 1 + CHANNELS.length) % CHANNELS.length;
        break;
      default:
        return;
    }

    event.preventDefault();
    activate(nextIndex);
    tabList.current?.querySelector<HTMLButtonElement>(`#tab-${CHANNELS[nextIndex].id}`)?.focus();
  }

  function renderTab(channel: (typeof CHANNELS)[number]) {
    const index = CHANNELS.indexOf(channel);
    const selected = activeIndex === index;
    return (
      <button
        key={channel.id}
        id={`tab-${channel.id}`}
        type="button"
        role="tab"
        aria-selected={selected}
        aria-controls={`panel-${channel.id}`}
        tabIndex={selected ? 0 : -1}
        data-channel={channel.id}
        onClick={() => activate(index)}
        onKeyDown={(event) => selectByKeyboard(event, index)}
      >
        # {channel.label}
      </button>
    );
  }

  return (
    <section className="demo landing-shell" id="live-demo" aria-labelledby="demo-title">
      <header className="section-heading reveal">
        <div>
          <p className="eyebrow">EXAMPLE DISCORD WORKFLOWS</p>
          <h2 id="demo-title">See what your community could use.</h2>
        </div>
        <p>
          Explore illustrative examples of verification, LFG, trades, mod review and logs. These are
          mockups, not live customer activity. Feature availability depends on your plan.
        </p>
      </header>

      <div
        className="discord-console reveal"
        data-nosnippet=""
        data-mobile-nav-open={mobileNavOpen ? "" : undefined}
        aria-label="Example Discord gaming community using HAF Bot"
      >
        <aside className="server-rail" aria-hidden="true">
          <img src="/logo.png" alt="" />
          <span>HC</span>
          <span>01</span>
          <span>+</span>
        </aside>
        <aside className="channel-rail">
          <header>
            <strong>HAF COMMUNITY</strong>
            <span aria-hidden="true">⌄</span>
          </header>
          <p>EXAMPLE CHANNELS</p>
          <div
            className="channel-tabs"
            role="tablist"
            ref={tabList}
            aria-label="Example HAF Bot tools"
            aria-orientation="vertical"
          >
            {CHANNELS.slice(0, 4).map(renderTab)}
            <div className="channel-group-label" role="presentation">
              MORE COMMUNITY TOOLS
            </div>
            {CHANNELS.slice(4).map(renderTab)}
          </div>
        </aside>

        <button
          className="mobile-channel-backdrop"
          type="button"
          aria-label="Close channel list"
          onClick={() => setMobileNavOpen(false)}
          tabIndex={-1}
        ></button>

        <div className="message-pane">
          <header>
            <button
              className="mobile-channel-toggle"
              type="button"
              aria-label={mobileNavOpen ? "Close channel list" : "Open channel list"}
              aria-expanded={mobileNavOpen}
              onClick={() => setMobileNavOpen((open) => !open)}
            >
              <span aria-hidden="true" />
            </button>
            <div>
              <b id="active-channel"># {CHANNELS[activeIndex].label}</b>
              <span>See what HAF Bot can do inside Discord.</span>
            </div>
            <span aria-hidden="true">⌕ &nbsp; ?</span>
          </header>
          <div className="message-content" ref={messageContent}>
            <section
              id="panel-community"
              role="tabpanel"
              aria-labelledby="tab-community"
              data-panel="community"
              hidden={CHANNELS[activeIndex].id !== "community"}
            >
              <div className="bot-heading">
                <span className="bot-avatar">
                  <img src="/logo.png" alt="" />
                </span>
                <div>
                  <p>
                    <b>HAF BOT</b>
                    <em>APP</em>
                    <time>Today at 7:42 PM</time>
                  </p>
                  <h2>Keep your server moving.</h2>
                  <p>
                    Members use HAF in Discord. Staff configure player links, support and community
                    tools in the web dashboard.
                  </p>
                </div>
              </div>
              <div className="activity-label">
                <span>WHAT'S HAPPENING</span>
              </div>
              <article className="discord-event">
                <span className="member-avatar blue">RX</span>
                <div>
                  <p>
                    <b>RexActual</b>
                    <time>Today at 7:46 PM</time>
                  </p>
                  <span>joined the community and finished verification</span>
                  <div className="bot-reply">
                    <b>
                      HAF BOT <em>APP</em>
                    </b>
                    <p>You're verified, RexActual. Welcome in.</p>
                    <span className="mock-button">✓ Verified</span>
                  </div>
                </div>
                <aside>
                  <small>NEW PLAYERS</small>
                  <b>Member Verification</b>
                  <a href="https://docs.hafbot.xyz/features/member-verification">
                    Read about verification ↗
                  </a>
                </aside>
              </article>
              <article className="discord-event">
                <span className="member-avatar purple">MA</span>
                <div>
                  <p>
                    <b>Maple</b>
                    <time>Today at 8:03 PM</time>
                  </p>
                  <span>created an LFG post for tonight’s raid</span>
                  <div className="bot-reply purple-reply">
                    <b>LOOKING FOR GROUP</b>
                    <p>
                      <strong>Nightfall Raid · looking for 3 players</strong>
                      <br />
                      Applications open · Expires in 23h
                    </p>
                    <span className="mock-button">Apply</span>
                  </div>
                </div>
                <aside>
                  <small>COMMUNITY</small>
                  <b>Looking for Group</b>
                  <a href="https://docs.hafbot.xyz/features/lfg">Read about LFG ↗</a>
                </aside>
              </article>
            </section>

            <section
              id="panel-announcements"
              role="tabpanel"
              aria-labelledby="tab-announcements"
              data-panel="announcements"
              hidden={CHANNELS[activeIndex].id !== "announcements"}
            >
              <div className="panel-intro">
                <p className="eyebrow">MANAGED MESSAGE</p>
                <h2>Post it once. Update it anytime.</h2>
                <p>
                  Change announcements from HAF without deleting and reposting them. Everyone sees
                  the latest version in the same message.
                </p>
              </div>
              <article className="feature-message">
                <span className="bot-avatar">
                  <img src="/logo.png" alt="" />
                </span>
                <div>
                  <p>
                    <b>HAF BOT</b>
                    <em>APP</em>
                    <time>Today at 6:30 PM</time>
                  </p>
                  <div className="announcement-card">
                    <small>COMMUNITY BRIEFING</small>
                    <h3>Weekend raid schedule</h3>
                    <p>
                      Squad sign-ups close Friday at 8 PM AEST. Check your platform link before
                      applying.
                    </p>
                    <footer>Updated by Community Staff · no extra ping</footer>
                  </div>
                  <a href="https://docs.hafbot.xyz/features/managed-messages">
                    See how announcements work ↗
                  </a>
                </div>
              </article>
            </section>

            <section
              id="panel-mod-queue"
              role="tabpanel"
              aria-labelledby="tab-mod-queue"
              data-panel="mod-queue"
              hidden={CHANNELS[activeIndex].id !== "mod-queue"}
            >
              <div className="panel-intro">
                <p className="eyebrow">IMAGE RULES MOD QUEUE · PAID PLANS</p>
                <h2>Let the bot flag it. Let your mods decide.</h2>
                <p>
                  In normal mode, uncertain images are removed from the channel and queued for staff
                  review. Start in dry run to test your rules without deleting messages.
                </p>
              </div>
              <article className="feature-message">
                <span className="member-avatar green">HB</span>
                <div>
                  <p>
                    <b>HAF BOT</b>
                    <em>APP</em>
                    <time>Today at 8:17 PM</time>
                  </p>
                  <div className="queue-card">
                    <small>MOD CHECK NEEDED</small>
                    <h3>Image needs a quick look</h3>
                    <p>
                      Original message removed. Review the image and classification. Restore posts a
                      new bot-authored image message, not the original text or authorship.
                    </p>
                    <div>
                      <span className="mock-button">Approve deletion</span>
                      <span className="mock-button secondary">Restore message</span>
                    </div>
                  </div>
                  <a href="https://docs.hafbot.xyz/features/image-rules">
                    Read about Image Rules ↗
                  </a>
                </div>
              </article>
            </section>

            <section
              id="panel-audit-log"
              role="tabpanel"
              aria-labelledby="tab-audit-log"
              data-panel="audit-log"
              hidden={CHANNELS[activeIndex].id !== "audit-log"}
            >
              <div className="panel-intro">
                <p className="eyebrow">GUILD AUDIT LOG</p>
                <h2>Know what changed and who changed it.</h2>
                <p>
                  Important bot and staff actions are posted to a Discord channel, so your team can
                  quickly check what happened.
                </p>
              </div>
              <div className="discord-message-stack">
                <article className="discord-message">
                  <span className="bot-avatar">
                    <img src="/logo.png" alt="" />
                  </span>
                  <div>
                    <p className="discord-message-meta">
                      <b>HAF BOT</b>
                      <em>APP</em>
                      <time>Today at 8:22 PM</time>
                    </p>
                    <div className="discord-embed audit-embed yellow-embed">
                      <h3>Managed Message Updated</h3>
                      <div className="embed-fields single-column">
                        <p>
                          <b>Actor</b>
                          <span>
                            @StaffLead
                            <br />
                            ID: 492801745639201743
                          </span>
                        </p>
                        <p>
                          <b>Internal Name</b>
                          <span>Weekend raid schedule</span>
                        </p>
                        <p>
                          <b>Channel</b>
                          <span>#announcements</span>
                        </p>
                        <p>
                          <b>Message ID</b>
                          <span>1264920315578601512</span>
                        </p>
                      </div>
                      <footer>
                        <span>hafbot.xyz</span>
                        <time>Today at 8:22 PM</time>
                      </footer>
                    </div>
                  </div>
                </article>
                <article className="discord-message">
                  <span className="bot-avatar">
                    <img src="/logo.png" alt="" />
                  </span>
                  <div>
                    <p className="discord-message-meta">
                      <b>HAF BOT</b>
                      <em>APP</em>
                      <time>Today at 8:17 PM</time>
                    </p>
                    <div className="discord-embed audit-embed green-embed">
                      <h3>Image Rules Mod Queue Action</h3>
                      <div className="embed-fields single-column">
                        <p>
                          <b>Author</b>
                          <span>
                            @Maple
                            <br />
                            ID: 318544810279330481
                          </span>
                        </p>
                        <p>
                          <b>Channel</b>
                          <span>#screenshots</span>
                        </p>
                        <p>
                          <b>Message ID</b>
                          <span>1264920315578601597</span>
                        </p>
                      </div>
                      <footer>
                        <span>hafbot.xyz</span>
                        <time>Today at 8:17 PM</time>
                      </footer>
                    </div>
                  </div>
                </article>
                <article className="discord-message">
                  <span className="bot-avatar">
                    <img src="/logo.png" alt="" />
                  </span>
                  <div>
                    <p className="discord-message-meta">
                      <b>HAF BOT</b>
                      <em>APP</em>
                      <time>Today at 7:46 PM</time>
                    </p>
                    <div className="discord-embed audit-embed green-embed">
                      <h3>Member Verified</h3>
                      <div className="embed-fields single-column">
                        <p>
                          <b>User</b>
                          <span>
                            @RexActual
                            <br />
                            ID: 284790135728649013
                          </span>
                        </p>
                        <p>
                          <b>Context</b>
                          <span>
                            <strong>method:</strong> discord-button
                          </span>
                        </p>
                      </div>
                      <footer>
                        <span>hafbot.xyz</span>
                        <time>Today at 7:46 PM</time>
                      </footer>
                    </div>
                  </div>
                </article>
              </div>
              <a className="panel-doc-link" href="https://docs.hafbot.xyz/features/guild-audit-log">
                See how audit logs work ↗
              </a>
            </section>

            <section
              id="panel-welcome"
              role="tabpanel"
              aria-labelledby="tab-welcome"
              data-panel="welcome"
              hidden={CHANNELS[activeIndex].id !== "welcome"}
            >
              <div className="panel-intro compact-intro">
                <p className="eyebrow">MEMBER VERIFICATION</p>
                <h2>Give new players an easy first step.</h2>
                <p>
                  Welcome members in a DM or shared channel. The free Verify button grants your
                  configured role; it is not proof of human or game-account identity.
                </p>
              </div>
              <article className="discord-message">
                <span className="bot-avatar">
                  <img src="/logo.png" alt="" />
                </span>
                <div>
                  <p className="discord-message-meta">
                    <b>HAF BOT</b>
                    <em>APP</em>
                    <time>Today at 7:41 PM</time>
                  </p>
                  <div className="discord-embed welcome-embed">
                    <h3>Welcome to HAF Community</h3>
                    <p>
                      Read the rules, hit Verify, and jump in. Your access will be waiting if you
                      leave and come back later.
                    </p>
                    <footer>HAF Community • Today at 7:41 PM</footer>
                  </div>
                  <div className="discord-actions">
                    <span className="mock-button success">✓ Verify</span>
                    <span className="mock-button secondary">Rules ↗</span>
                  </div>
                  <a href="https://docs.hafbot.xyz/features/member-verification">
                    See how player verification works ↗
                  </a>
                </div>
              </article>
            </section>

            <section
              id="panel-looking-for-group"
              role="tabpanel"
              aria-labelledby="tab-looking-for-group"
              data-panel="looking-for-group"
              hidden={CHANNELS[activeIndex].id !== "looking-for-group"}
            >
              <div className="panel-intro compact-intro">
                <p className="eyebrow">LOOKING FOR GROUP</p>
                <h2>Turn “anyone on?” into a full squad.</h2>
                <p>
                  Players share a server or activity, when they want to play and who they need.
                  Interested members can notify the poster or apply through optional approval.
                </p>
              </div>
              <article className="discord-message">
                <span className="bot-avatar">
                  <img src="/logo.png" alt="" />
                </span>
                <div>
                  <p className="discord-message-meta">
                    <b>HAF BOT</b>
                    <em>APP</em>
                    <time>Today at 8:03 PM</time>
                  </p>
                  <div className="discord-embed lfg-embed">
                    <h3>🎮 Looking For Gamers</h3>
                    <div className="embed-fields single-column">
                      <p>
                        <b>🌲 Server</b>
                        <span>Chernarus • AU Main</span>
                      </p>
                      <p>
                        <b>🕒 When</b>
                        <span>Tonight from 8:30 PM AEST</span>
                      </p>
                      <p>
                        <b>👥 Looking for</b>
                        <span>3 players for a bunker run</span>
                      </p>
                      <p>
                        <b>📝 Info</b>
                        <span>Bring NBC gear. New players welcome.</span>
                      </p>
                      <p>
                        <b>👤 Posted by</b>
                        <span>@Maple</span>
                      </p>
                      <p>
                        <b>⏳ Expires</b>
                        <span>in 23 hours</span>
                      </p>
                      <p>
                        <b>📌 Status</b>
                        <span>Open</span>
                      </p>
                    </div>
                    <footer>Today at 8:03 PM</footer>
                  </div>
                  <div className="discord-actions">
                    <span className="mock-button success">✓ I'm Interested</span>
                    <span className="mock-button secondary">✎ Edit Post</span>
                    <span className="mock-button danger">✕ Close Post</span>
                  </div>
                  <a href="https://docs.hafbot.xyz/features/lfg">Read about LFG ↗</a>
                </div>
              </article>
            </section>

            <section
              id="panel-marketplace"
              role="tabpanel"
              aria-labelledby="tab-marketplace"
              data-panel="marketplace"
              hidden={CHANNELS[activeIndex].id !== "marketplace"}
            >
              <div className="panel-intro compact-intro">
                <p className="eyebrow">MARKETPLACE</p>
                <h2>Make trading easier to follow.</h2>
                <p>
                  Every post shows what's offered, what's wanted, the server, and who posted it. No
                  more offers getting lost in chat.
                </p>
              </div>
              <article className="discord-message">
                <span className="bot-avatar">
                  <img src="/logo.png" alt="" />
                </span>
                <div>
                  <p className="discord-message-meta">
                    <b>HAF BOT</b>
                    <em>APP</em>
                    <time>Today at 8:11 PM</time>
                  </p>
                  <div className="discord-embed marketplace-embed">
                    <h3>💼 Marketplace Listing</h3>
                    <div className="embed-fields">
                      <p>
                        <b>Type</b>
                        <span>Have item to trade</span>
                      </p>
                      <p>
                        <b>Server</b>
                        <span>AU Main</span>
                      </p>
                      <p>
                        <b>Condition</b>
                        <span>Pristine</span>
                      </p>
                      <p>
                        <b>What do you have for trade?</b>
                        <span>NVG headstrap + battery</span>
                      </p>
                      <p>
                        <b>Is there something you are looking for?</b>
                        <span>Plate carrier or 5.56 ammunition</span>
                      </p>
                      <p>
                        <b>Extra info</b>
                        <span>Available after tonight’s restart.</span>
                      </p>
                      <p>
                        <b>Posted by</b>
                        <span>@RexActual</span>
                      </p>
                    </div>
                    <footer>Post ID: market-1842 • Today at 8:11 PM</footer>
                  </div>
                  <div className="discord-actions">
                    <span className="mock-button success">💼 Do Business</span>
                    <span className="mock-button danger">🔒 Close Post</span>
                  </div>
                  <a href="https://docs.hafbot.xyz/features/marketplace">
                    Read about Marketplace ↗
                  </a>
                </div>
              </article>
            </section>

            <section
              id="panel-evidence-vault"
              role="tabpanel"
              aria-labelledby="tab-evidence-vault"
              data-panel="evidence-vault"
              hidden={CHANNELS[activeIndex].id !== "evidence-vault"}
            >
              <div className="panel-intro compact-intro">
                <p className="eyebrow">EVIDENCE VAULT</p>
                <h2>Keep a private staff record of sensitive messages.</h2>
                <p>
                  Staff can hide a message, find it later, and see who posted it, where it came
                  from, and who saved it.
                </p>
              </div>
              <article className="discord-message">
                <span className="bot-avatar">
                  <img src="/logo.png" alt="" />
                </span>
                <div>
                  <p className="discord-message-meta">
                    <b>HAF BOT</b>
                    <em>APP</em>
                    <time>Today at 8:26 PM</time>
                  </p>
                  <div className="discord-embed evidence-embed">
                    <h3>Evidence Vault Search</h3>
                    <p>Records for Discord user 3185…4481. Newest first.</p>
                    <div className="embed-fields single-column">
                      <p>
                        <b>1. ev_01J8YH4K2N</b>
                        <span>
                          Source author: Maple (3185…4481)
                          <br />
                          Source channel: #staff-reports
                          <br />
                          Hider: StaffLead (4928…0174)
                          <br />
                          Hidden: 4 minutes ago
                        </span>
                      </p>
                      <p>
                        <b>2. ev_01J8XF91QS</b>
                        <span>
                          Source author: Maple (3185…4481)
                          <br />
                          Source channel: #trade-disputes
                          <br />
                          Hider: ModAlex (7012…6620)
                          <br />
                          Hidden: 2 days ago
                        </span>
                      </p>
                    </div>
                    <footer>Page 1 of 1 • 2 results</footer>
                  </div>
                  <div className="discord-actions">
                    <span className="mock-button">View record 1</span>
                    <span className="mock-button">View record 2</span>
                  </div>
                  <a href="https://docs.hafbot.xyz/features/evidence-vault">
                    Read about Evidence Vault ↗
                  </a>
                </div>
              </article>
            </section>
          </div>
        </div>
      </div>
    </section>
  );
}
