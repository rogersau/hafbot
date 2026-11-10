/* PROTOTYPE — throwaway. Variant C: "Workshop".
   A tabbed admin workspace: wide nav tree opens features as closable tabs,
   IDE-style tab bar on top of the workspace, and a status bar at the bottom. */

import { useState } from "react";
import { ACTIVITY, ATTENTION, BOT_DEFENSE, FEATURES, GUILD, STATUS_LABEL } from "../mock-data";
import { Icon } from "../icons";
import "./workshop.css";

const NAV_GROUPS = ["Moderation", "Community", "Access", "Integrations"] as const;

export function Workshop({ mission = false }: { mission?: boolean }) {
  const [tabs, setTabs] = useState<string[]>(["overview"]);
  const [active, setActive] = useState("overview");

  const openTab = (id: string) => {
    setTabs((current) => (current.includes(id) ? current : [...current, id]));
    setActive(id);
  };

  const closeTab = (id: string) => {
    if (id === "overview") return;
    setTabs((current) => {
      const next = current.filter((t) => t !== id);
      if (active === id) setActive(next[next.length - 1] ?? "overview");
      return next;
    });
  };

  return (
    <div className={`ws-root ${mission ? "ws-root--mission" : ""}`}>
      <aside className="ws-sidebar">
        <div className="ws-brand">
          <img src="/logo.png" alt="HAF Bot" />
          <div>
            <strong>
              HAF <em>{mission ? "OPS DECK" : "WORKSHOP"}</em>
            </strong>
            <span>guild admin</span>
          </div>
        </div>

        <button type="button" className="ws-guildcard">
          <span className="ws-guildcard__sigil">WC</span>
          <span className="ws-guildcard__text">
            <strong>{GUILD.name}</strong>
            <small>
              {GUILD.members.toLocaleString()} members · {GUILD.plan}
            </small>
          </span>
          <Icon name="chevronDown" size={13} />
        </button>

        <nav className="ws-tree" aria-label="Features">
          <button
            type="button"
            className={`ws-tree__item ${active === "overview" ? "is-active" : ""}`}
            onClick={() => openTab("overview")}
          >
            <Icon name="overview" size={15} />
            <span className="ws-tree__label">Overview</span>
          </button>
          {NAV_GROUPS.map((group) => (
            <div key={group} className="ws-tree__group">
              <p className="ws-tree__grouplabel">{group}</p>
              {FEATURES.filter((f) => f.group === group).map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className={`ws-tree__item ${active === f.id ? "is-active" : ""}`}
                  onClick={() => openTab(f.id)}
                >
                  <span className={`ws-dot ws-dot--${f.status}`} />
                  <span className="ws-tree__label">{f.name}</span>
                  {f.status === "attention" && <span className="ws-tree__badge">{f.metric}</span>}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="ws-sidebar__footer">
          <span className="ws-avatar">R</span>
          <div>
            <strong>rogers</strong>
            <span>Guild admin</span>
          </div>
          <Icon name="settings" size={15} />
        </div>
      </aside>

      <div className="ws-stage">
        <div className="ws-tabbar" role="tablist">
          {tabs.map((id) => {
            const feature = FEATURES.find((f) => f.id === id);
            const label = feature?.name ?? "Overview";
            return (
              <div
                key={id}
                role="tab"
                aria-selected={active === id}
                className={`ws-tab ${active === id ? "is-active" : ""}`}
                onClick={() => setActive(id)}
              >
                {feature && <span className={`ws-dot ws-dot--${feature.status}`} />}
                <span>{label}</span>
                {id !== "overview" && (
                  <button
                    type="button"
                    className="ws-tab__close"
                    aria-label={`Close ${label}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(id);
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}
          <div className="ws-tabbar__spacer" />
          <button type="button" className="ws-command">
            <Icon name="search" size={13} /> ⌘K
          </button>
        </div>

        <main className="ws-workspace">
          {active === "overview" ? (
            <OverviewTab mission={mission} onOpen={openTab} />
          ) : (
            <FeatureTab featureId={active} />
          )}
        </main>

        <footer className="ws-statusbar">
          <span className="ws-statusbar__item">
            <span className="ws-statusbar__pulse" /> Gateway connected
          </span>
          <span className="ws-statusbar__item">{GUILD.name}</span>
          <span className="ws-statusbar__item">{GUILD.plan} plan</span>
          <span className="ws-statusbar__spacer" />
          <span className="ws-statusbar__item">
            {GUILD.configuredCount}/{GUILD.totalCount} features configured
          </span>
          <span className="ws-statusbar__item">synced 12s ago</span>
        </footer>
      </div>
    </div>
  );
}

function OverviewTab({ mission, onOpen }: { mission: boolean; onOpen: (id: string) => void }) {
  return (
    <div className="ws-overview">
      <header className="ws-overview__head">
        <h1>
          {mission ? (
            <>
              ALL SYSTEMS, <em>ONE WORKSPACE.</em>
            </>
          ) : (
            <>
              Good evening, <em>rogers.</em>
            </>
          )}
        </h1>
        <p>
          {ATTENTION.length} items need a human · {GUILD.configuredCount} of {GUILD.totalCount}{" "}
          features configured · everything else is humming.
        </p>
      </header>

      <div className="ws-overview__grid">
        <section className="ws-panel ws-panel--queue">
          <h2 className="ws-panel__title">Queue</h2>
          {ATTENTION.map((item) => (
            <button
              key={item.id}
              type="button"
              className="ws-queue__row"
              onClick={() => onOpen(item.featureId)}
            >
              <span className={`ws-queue__sev ws-queue__sev--${item.severity}`} />
              <span className="ws-queue__body">
                <strong>{item.title}</strong>
                <small>
                  {item.feature} — {item.detail}
                </small>
              </span>
              <span className="ws-queue__action">
                {item.action} <Icon name="arrowRight" size={12} />
              </span>
            </button>
          ))}
        </section>

        <div className="ws-overview__right">
          <section className="ws-panel">
            <h2 className="ws-panel__title">Vitals</h2>
            <div className="ws-vitals">
              <div className="ws-vital">
                <strong>{GUILD.members.toLocaleString()}</strong>
                <span>members</span>
              </div>
              <div className="ws-vital">
                <strong>142</strong>
                <span>actions today</span>
              </div>
              <div className="ws-vital">
                <strong>{GUILD.coverage}%</strong>
                <span>coverage</span>
              </div>
            </div>
            <div className="ws-meter">
              <span style={{ width: `${GUILD.coverage}%` }} />
            </div>
            <p className="ws-panel__hint">
              Next best step: set up Mention Protection — the last Moderation feature not running.
            </p>
            <button
              type="button"
              className="ws-btn ws-btn--primary"
              onClick={() => onOpen("mention-protection")}
            >
              Set up Mention Protection
            </button>
          </section>

          <section className="ws-panel">
            <h2 className="ws-panel__title">Recent activity</h2>
            <ul className="ws-activity">
              {ACTIVITY.slice(0, 5).map((event, i) => (
                <li key={i}>
                  <span>{event.at}</span>
                  {event.text}
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}

function FeatureTab({ featureId }: { featureId: string }) {
  const feature = FEATURES.find((f) => f.id === featureId);
  const [enabled, setEnabled] = useState(feature?.status !== "setup");
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    detectors: true,
    flags: true,
    shared: false,
  });
  const [resolved, setResolved] = useState<Record<string, string>>({});

  if (!feature) return null;
  const isBotDefense = feature.id === "bot-defense";
  const toggleSection = (key: string) => setOpenSections((s) => ({ ...s, [key]: !s[key] }));

  return (
    <div className="ws-feature">
      <header className="ws-feature__head">
        <div>
          <p className="ws-feature__crumb">
            {feature.group} / {STATUS_LABEL[feature.status]}
          </p>
          <h1>{feature.name}</h1>
          <p className="ws-feature__summary">{feature.summary}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          className={`ws-toggle ${enabled ? "is-on" : ""}`}
          onClick={() => setEnabled(!enabled)}
        >
          <span />
        </button>
      </header>

      {isBotDefense ? (
        <>
          <Accordion
            title="Detectors"
            meta="2 of 2 on"
            open={!!openSections.detectors}
            onToggle={() => toggleSection("detectors")}
          >
            <div className="ws-row">
              <div>
                <strong>Honeypot Detector</strong>
                <small>
                  Watching {BOT_DEFENSE.honeypot.channel} · {BOT_DEFENSE.honeypot.response}
                </small>
              </div>
              <span className="ws-pill ws-pill--on">on</span>
            </div>
            <div className="ws-row">
              <div>
                <strong>Rate Detector</strong>
                <small>
                  {BOT_DEFENSE.rate.channels}+ channels / {BOT_DEFENSE.rate.windowSeconds}s ·{" "}
                  {BOT_DEFENSE.rate.response}
                </small>
              </div>
              <span className="ws-pill ws-pill--on">on</span>
            </div>
          </Accordion>

          <Accordion
            title="Flag queue"
            meta={`${BOT_DEFENSE.flags.filter((f) => !resolved[f.member]).length} open`}
            open={!!openSections.flags}
            onToggle={() => toggleSection("flags")}
          >
            {BOT_DEFENSE.flags.map((flag) => {
              const state = resolved[flag.member];
              return (
                <div key={flag.member} className={`ws-flag ${state ? "is-resolved" : ""}`}>
                  <div className="ws-flag__main">
                    <strong>{flag.member}</strong>
                    <small>
                      {flag.detector} · {flag.evidence} · {flag.age}
                    </small>
                  </div>
                  {state ? (
                    <span className="ws-pill">{state}</span>
                  ) : (
                    <span className="ws-flag__actions">
                      <button
                        type="button"
                        className="ws-btn ws-btn--primary"
                        onClick={() => setResolved((s) => ({ ...s, [flag.member]: "confirmed" }))}
                      >
                        Confirm bot
                      </button>
                      <button
                        type="button"
                        className="ws-btn"
                        onClick={() => setResolved((s) => ({ ...s, [flag.member]: "dismissed" }))}
                      >
                        Dismiss
                      </button>
                    </span>
                  )}
                </div>
              );
            })}
          </Accordion>

          <Accordion
            title="Shared settings"
            meta={`${BOT_DEFENSE.excludedRoles.length} excluded roles`}
            open={!!openSections.shared}
            onToggle={() => toggleSection("shared")}
          >
            <div className="ws-row">
              <div>
                <strong>Excluded roles</strong>
                <small>Skipped by both detectors</small>
              </div>
              <span className="ws-chips">
                {BOT_DEFENSE.excludedRoles.map((r) => (
                  <span key={r} className="ws-chip">
                    {r}
                  </span>
                ))}
              </span>
            </div>
            <div className="ws-row">
              <div>
                <strong>Mod queue</strong>
                <small>Where flags are posted</small>
              </div>
              <span className="ws-chip">{BOT_DEFENSE.modQueue}</span>
            </div>
          </Accordion>
        </>
      ) : (
        <section className="ws-panel">
          <h2 className="ws-panel__title">Configuration</h2>
          <div className="ws-row">
            <div>
              <strong>{feature.metricLabel}</strong>
              <small>{feature.summary}</small>
            </div>
            <span className="ws-feature__metric">{feature.metric}</span>
          </div>
          <p className="ws-panel__hint">
            Prototype drill-in — only Bot Defense is fully mocked in this variant.
          </p>
        </section>
      )}
    </div>
  );
}

function Accordion({
  title,
  meta,
  open,
  onToggle,
  children,
}: {
  title: string;
  meta: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className={`ws-accordion ${open ? "is-open" : ""}`}>
      <button type="button" className="ws-accordion__head" onClick={onToggle} aria-expanded={open}>
        <span className="ws-accordion__chev">▸</span>
        <strong>{title}</strong>
        <span className="ws-accordion__meta">{meta}</span>
      </button>
      {open && <div className="ws-accordion__body">{children}</div>}
    </section>
  );
}
