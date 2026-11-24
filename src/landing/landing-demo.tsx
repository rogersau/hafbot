import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

const CHANNELS = [
  { id: "support", label: "support-tickets" },
  { id: "welcome", label: "welcome" },
  { id: "looking-for-group", label: "looking-for-group" },
] as const;

export function LandingDemo() {
  const [activeIndex, setActiveIndex] = useState(0);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const mobileToggle = useRef<HTMLButtonElement>(null);
  const tabList = useRef<HTMLDivElement>(null);
  const messageContent = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (mobileNavOpen) {
      tabList.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
    }
  }, [mobileNavOpen]);

  function closeMobileNav() {
    setMobileNavOpen(false);
    mobileToggle.current?.focus({ preventScroll: true });
  }

  function activate(index: number) {
    setActiveIndex(index);
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
        onClick={() => {
          activate(index);
          if (mobileNavOpen) closeMobileNav();
        }}
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
          <h2 id="demo-title">See what members do in Discord.</h2>
        </div>
        <p>
          Try a private support ticket, a welcome role, or an LFG post. These are mockups, not live
          customer activity. All three examples are included on Free. See the{" "}
          <a href="https://docs.hafbot.xyz/plans">full plan comparison</a> for limits and paid
          options.
        </p>
      </header>

      <div
        className="discord-console reveal"
        data-nosnippet=""
        data-mobile-nav-open={mobileNavOpen ? "" : undefined}
        role="group"
        aria-label="Example Discord gaming community using HAF Bot"
        onKeyDown={(event) => {
          if (mobileNavOpen && event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            closeMobileNav();
          }
        }}
      >
        <div className="server-rail" aria-hidden="true">
          <img src="/logo.png" alt="" />
          <span>HC</span>
          <span>01</span>
          <span>+</span>
        </div>
        <div
          className="channel-rail"
          id="demo-channel-list"
          onBlur={(event) => {
            if (mobileNavOpen && !event.currentTarget.contains(event.relatedTarget)) {
              setMobileNavOpen(false);
            }
          }}
        >
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
            {CHANNELS.map(renderTab)}
          </div>
        </div>

        <button
          className="mobile-channel-backdrop"
          type="button"
          aria-hidden="true"
          onMouseDown={(event) => event.preventDefault()}
          onClick={closeMobileNav}
          tabIndex={-1}
        ></button>

        <div className="message-pane">
          <header>
            <button
              className="mobile-channel-toggle"
              type="button"
              ref={mobileToggle}
              aria-label={mobileNavOpen ? "Close channel list" : "Open channel list"}
              aria-expanded={mobileNavOpen}
              aria-controls="demo-channel-list"
              onClick={() => (mobileNavOpen ? closeMobileNav() : setMobileNavOpen(true))}
            >
              <span className="mobile-channel-icon" aria-hidden="true" />
              <span className="mobile-channel-label" aria-hidden="true">
                Channel list
              </span>
            </button>
            <div>
              <b id="active-channel"># {CHANNELS[activeIndex].label}</b>
              <span>Example channel</span>
            </div>
          </header>
          <div className="message-content" ref={messageContent}>
            <section
              id="panel-support"
              role="tabpanel"
              tabIndex={0}
              aria-labelledby="tab-support"
              data-panel="support"
              hidden={CHANNELS[activeIndex].id !== "support"}
            >
              <div className="panel-intro compact-intro">
                <p className="eyebrow">PRIVATE SUPPORT TICKETS</p>
                <h3>Give reports a private place to go.</h3>
                <p>
                  A player opens a ticket from your support panel. HAF creates a private channel for
                  that player, the configured support role and HAF Bot.
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
                    <time>Today at 7:34 PM</time>
                  </p>
                  <div className="discord-embed">
                    <h4>Player support</h4>
                    <p>Need a hand or want to report something? Open a ticket to talk to staff.</p>
                  </div>
                  <div className="discord-actions">
                    <span className="mock-button">Open ticket</span>
                  </div>
                  <a href="https://docs.hafbot.xyz/features/tickets">Set up Tickets ↗</a>
                </div>
              </article>
            </section>

            <section
              id="panel-welcome"
              role="tabpanel"
              tabIndex={0}
              aria-labelledby="tab-welcome"
              data-panel="welcome"
              hidden={CHANNELS[activeIndex].id !== "welcome"}
            >
              <div className="panel-intro compact-intro">
                <p className="eyebrow">MEMBER VERIFICATION</p>
                <h3>Give new players an easy first step.</h3>
                <p>
                  Welcome members in a DM or shared channel. The free Discord button confirms the
                  account interacted with HAF Bot before granting a role. It does not prove human or
                  game-account identity.
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
                    <h4>Welcome to HAF Community</h4>
                    <p>
                      Read the rules, hit Verify, and jump in. Your welcome role can be restored if
                      you leave and rejoin.
                    </p>
                    <footer>HAF Community • Today at 7:41 PM</footer>
                  </div>
                  <div className="discord-actions">
                    <span className="mock-button success">✓ Verify</span>
                    <span className="mock-button secondary">Rules ↗</span>
                  </div>
                  <a href="https://docs.hafbot.xyz/features/member-verification#verification-methods">
                    Compare Discord button, Turnstile and Steam link required ↗
                  </a>
                </div>
              </article>
            </section>

            <section
              id="panel-looking-for-group"
              role="tabpanel"
              tabIndex={0}
              aria-labelledby="tab-looking-for-group"
              data-panel="looking-for-group"
              hidden={CHANNELS[activeIndex].id !== "looking-for-group"}
            >
              <div className="panel-intro compact-intro">
                <p className="eyebrow">LOOKING FOR GROUP</p>
                <h3>Turn “anyone on?” into a full squad.</h3>
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
                    <h4>Looking For Gamers</h4>
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
                    </div>
                    <footer>Today at 8:03 PM</footer>
                  </div>
                  <div className="discord-actions">
                    <span className="mock-button success">✓ I'm Interested</span>
                  </div>
                  <a href="https://docs.hafbot.xyz/features/lfg">Read about LFG ↗</a>
                </div>
              </article>
            </section>
          </div>
        </div>
      </div>

      <nav className="workflow-guides" aria-labelledby="workflow-guides-title">
        <h3 id="workflow-guides-title">Find another workflow</h3>
        <ul>
          <li>
            <a href="https://docs.hafbot.xyz/features/mention-protection">
              Reduce unwanted mentions
            </a>
          </li>
          <li>
            <a href="https://docs.hafbot.xyz/features/player-link">Connect game accounts</a>
          </li>
          <li>
            <a href="https://docs.hafbot.xyz/features/managed-messages">
              Keep announcements current
            </a>
          </li>
          <li>
            <a href="https://docs.hafbot.xyz/guides/wardogs-discord-community">
              Set up a WARDOGS community
            </a>
          </li>
          <li>
            <a href="https://docs.hafbot.xyz/">Browse all feature guides ↗</a>
          </li>
        </ul>
      </nav>
    </section>
  );
}
