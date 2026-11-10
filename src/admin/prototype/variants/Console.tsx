/* PROTOTYPE — throwaway. Variant B: "Console".
   A light, dense top-nav admin console: KPI strip, an attention inbox table,
   a feature directory table with in-row controls, and a classic settings-form
   drill-in with a sticky save bar. */

import { useState } from "react";
import {
  ACTIVITY,
  ATTENTION,
  BOT_DEFENSE,
  FEATURES,
  GUILD,
  STATUS_LABEL,
  type Feature,
} from "../mock-data";
import { FEATURE_ICONS, Icon } from "../icons";
import "./console.css";

const NAV_GROUPS = ["Moderation", "Community", "Access", "Integrations"] as const;

export function Console() {
  const [view, setView] = useState<string>("overview");
  const openFeature = FEATURES.find((f) => f.id === view);

  return (
    <div className="co-root">
      <header className="co-brandbar">
        <div className="co-brand">
          <img src="/logo.png" alt="HAF Bot" />
          <span className="co-brand__name">
            HAF <em>Admin Console</em>
          </span>
        </div>
        <button type="button" className="co-guild">
          <span className="co-guild__sigil">WC</span>
          <span>
            <strong>{GUILD.name}</strong>
            <small>
              {GUILD.members.toLocaleString()} members · {GUILD.plan}
            </small>
          </span>
          <Icon name="chevronDown" size={14} />
        </button>
        <div className="co-brandbar__right">
          <button type="button" className="co-search">
            <Icon name="search" size={14} />
            <span>Search settings…</span>
            <kbd>⌘K</kbd>
          </button>
          <span className="co-avatar" title="Signed in as rogers">
            R
          </span>
        </div>
      </header>

      <nav className="co-nav" aria-label="Admin sections">
        <button
          type="button"
          className={`co-nav__item ${view === "overview" ? "is-active" : ""}`}
          onClick={() => setView("overview")}
        >
          Overview
        </button>
        {NAV_GROUPS.map((group) => (
          <div key={group} className="co-nav__group">
            <button
              type="button"
              className={`co-nav__item ${openFeature?.group === group ? "is-active" : ""}`}
            >
              {group} <Icon name="chevronDown" size={12} />
            </button>
            <div className="co-nav__menu" role="menu">
              {FEATURES.filter((f) => f.group === group).map((f) => (
                <button
                  key={f.id}
                  type="button"
                  role="menuitem"
                  className="co-nav__menuitem"
                  onClick={() => setView(f.id)}
                >
                  <span className={`co-dot co-dot--${f.status}`} />
                  {f.name}
                  <span className="co-nav__menustatus">{STATUS_LABEL[f.status]}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
        <div className="co-nav__spacer" />
        <button type="button" className="co-nav__item co-nav__item--muted">
          Guild Settings
        </button>
        <button type="button" className="co-nav__item co-nav__item--muted">
          Billing
        </button>
      </nav>

      {view === "overview" || !openFeature ? (
        <Overview onOpen={setView} />
      ) : (
        <FeaturePage feature={openFeature} onBack={() => setView("overview")} />
      )}
    </div>
  );
}

function Overview({ onOpen }: { onOpen: (id: string) => void }) {
  const kpis = [
    { label: "Members", value: GUILD.members.toLocaleString(), delta: "+38 this week" },
    { label: "Bot actions today", value: "142", delta: "↑ 12% vs avg" },
    { label: "Open bot flags", value: "3", delta: "needs review", hot: true },
    { label: "Open tickets", value: "2", delta: "oldest 6h", hot: true },
    {
      label: "Setup coverage",
      value: `${GUILD.coverage}%`,
      delta: `${GUILD.configuredCount}/${GUILD.totalCount} features`,
    },
  ];

  return (
    <main className="co-main">
      <div className="co-pagehead">
        <div>
          <h1>Overview</h1>
          <p>Guild operations for {GUILD.name} — status first, actions second.</p>
        </div>
        <div className="co-pagehead__actions">
          <button type="button" className="co-btn">
            Refresh
          </button>
          <button type="button" className="co-btn co-btn--primary">
            Run setup
          </button>
        </div>
      </div>

      <section className="co-kpis" aria-label="Key numbers">
        {kpis.map((kpi) => (
          <div key={kpi.label} className={`co-kpi ${kpi.hot ? "co-kpi--hot" : ""}`}>
            <span className="co-kpi__label">{kpi.label}</span>
            <strong className="co-kpi__value">{kpi.value}</strong>
            <span className="co-kpi__delta">{kpi.delta}</span>
          </div>
        ))}
      </section>

      <section className="co-panel">
        <header className="co-panel__head">
          <h2>
            Needs attention <span className="co-count">{ATTENTION.length}</span>
          </h2>
        </header>
        <table className="co-table">
          <thead>
            <tr>
              <th style={{ width: "2rem" }} />
              <th>Item</th>
              <th>Feature</th>
              <th>Detail</th>
              <th style={{ width: "9rem", textAlign: "right" }} />
            </tr>
          </thead>
          <tbody>
            {ATTENTION.map((item) => (
              <tr key={item.id} onClick={() => onOpen(item.featureId)}>
                <td>
                  <span className={`co-sev co-sev--${item.severity}`} />
                </td>
                <td className="co-table__strong">{item.title}</td>
                <td>{item.feature}</td>
                <td className="co-table__muted">{item.detail}</td>
                <td className="co-table__action">
                  <span className="co-btn co-btn--small co-btn--primary">{item.action}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="co-panel">
        <header className="co-panel__head">
          <h2>Feature directory</h2>
          <span className="co-panel__hint">
            {GUILD.configuredCount} of {GUILD.totalCount} configured
          </span>
        </header>
        <table className="co-table co-table--directory">
          <tbody>
            {NAV_GROUPS.map((group) => (
              <GroupRows key={group} group={group} onOpen={onOpen} />
            ))}
          </tbody>
        </table>
      </section>

      <section className="co-panel">
        <header className="co-panel__head">
          <h2>Recent activity</h2>
        </header>
        <ul className="co-activity">
          {ACTIVITY.map((event, i) => (
            <li key={i}>
              <span className="co-activity__at">{event.at}</span>
              {event.text}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

function GroupRows({ group, onOpen }: { group: string; onOpen: (id: string) => void }) {
  const features = FEATURES.filter((f) => f.group === group);
  return (
    <>
      <tr className="co-table__grouprow">
        <td colSpan={6}>{group}</td>
      </tr>
      {features.map((f) => (
        <tr key={f.id} onClick={() => onOpen(f.id)}>
          <td>
            <span className="co-feature">
              <Icon name={FEATURE_ICONS[f.id] ?? "settings"} size={15} />
              {f.name}
            </span>
          </td>
          <td>
            <span className={`co-status co-status--${f.status}`}>
              <span className={`co-dot co-dot--${f.status}`} />
              {STATUS_LABEL[f.status]}
            </span>
          </td>
          <td className="co-table__muted">{f.summary}</td>
          <td className="co-table__mono">
            {f.metric} <small>{f.metricLabel}</small>
          </td>
          <td onClick={(e) => e.stopPropagation()}>
            <MiniToggle on={f.status === "active" || f.status === "attention"} />
          </td>
          <td className="co-table__action">
            <span className="co-configure">Configure →</span>
          </td>
        </tr>
      ))}
    </>
  );
}

function MiniToggle({ on: initial }: { on: boolean }) {
  const [on, setOn] = useState(initial);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={`co-toggle ${on ? "is-on" : ""}`}
      onClick={() => setOn(!on)}
    >
      <span />
    </button>
  );
}

function FeaturePage({ feature, onBack }: { feature: Feature; onBack: () => void }) {
  const [enabled, setEnabled] = useState(feature.status !== "setup");
  const [dirty, setDirty] = useState(0);
  const [honeypotOn, setHoneypotOn] = useState(BOT_DEFENSE.honeypot.enabled);
  const [rateOn, setRateOn] = useState(BOT_DEFENSE.rate.enabled);
  const [resolved, setResolved] = useState<Record<string, string>>({});
  const isBotDefense = feature.id === "bot-defense";
  const openFlags = BOT_DEFENSE.flags.filter((f) => !resolved[f.member]);

  const markDirty = () => setDirty((d) => d + 1);

  return (
    <main className="co-main co-main--form">
      <nav className="co-breadcrumb" aria-label="Breadcrumb">
        <button type="button" onClick={onBack}>
          Console
        </button>
        <span>/</span>
        <span>{feature.group}</span>
        <span>/</span>
        <strong>{feature.name}</strong>
      </nav>

      <div className="co-pagehead">
        <div>
          <h1>{feature.name}</h1>
          <p>{feature.summary}</p>
        </div>
        <label className="co-masterswitch">
          <span>{enabled ? "Enabled" : "Disabled"}</span>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            className={`co-toggle ${enabled ? "is-on" : ""}`}
            onClick={() => {
              setEnabled(!enabled);
              markDirty();
            }}
          >
            <span />
          </button>
        </label>
      </div>

      <div className="co-formgrid">
        <div className="co-formgrid__main">
          {isBotDefense ? (
            <>
              <section className="co-panel">
                <header className="co-panel__head">
                  <h2>Detectors</h2>
                </header>
                <div className="co-fieldrow">
                  <div className="co-fieldrow__text">
                    <strong>Honeypot Detector</strong>
                    <span>Flags members posting in {BOT_DEFENSE.honeypot.channel}.</span>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={honeypotOn}
                    className={`co-toggle ${honeypotOn ? "is-on" : ""}`}
                    onClick={() => {
                      setHoneypotOn(!honeypotOn);
                      markDirty();
                    }}
                  >
                    <span />
                  </button>
                </div>
                <div className="co-fieldrow">
                  <div className="co-fieldrow__text">
                    <strong>Rate Detector</strong>
                    <span>
                      Same message in {BOT_DEFENSE.rate.channels}+ channels within{" "}
                      {BOT_DEFENSE.rate.windowSeconds}s.
                    </span>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={rateOn}
                    className={`co-toggle ${rateOn ? "is-on" : ""}`}
                    onClick={() => {
                      setRateOn(!rateOn);
                      markDirty();
                    }}
                  >
                    <span />
                  </button>
                </div>
                <div className="co-fieldrow co-fieldrow--static">
                  <div className="co-fieldrow__text">
                    <strong>Rate thresholds</strong>
                  </div>
                  <div className="co-fieldrow__controls">
                    <label>
                      Channels{" "}
                      <input
                        type="number"
                        defaultValue={BOT_DEFENSE.rate.channels}
                        onChange={markDirty}
                      />
                    </label>
                    <label>
                      Window (s){" "}
                      <input
                        type="number"
                        defaultValue={BOT_DEFENSE.rate.windowSeconds}
                        onChange={markDirty}
                      />
                    </label>
                  </div>
                </div>
              </section>

              <section className="co-panel">
                <header className="co-panel__head">
                  <h2>
                    Flag queue <span className="co-count">{openFlags.length}</span>
                  </h2>
                </header>
                <table className="co-table">
                  <thead>
                    <tr>
                      <th>Member</th>
                      <th>Detector</th>
                      <th>Evidence</th>
                      <th>Age</th>
                      <th style={{ textAlign: "right" }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {BOT_DEFENSE.flags.map((flag) => {
                      const state = resolved[flag.member];
                      return (
                        <tr key={flag.member} className={state ? "is-resolved" : ""}>
                          <td className="co-table__strong">{flag.member}</td>
                          <td>{flag.detector}</td>
                          <td className="co-table__muted">{flag.evidence}</td>
                          <td className="co-table__mono">{flag.age}</td>
                          <td className="co-table__action">
                            {state ? (
                              <span className="co-status co-status--active">
                                {state === "confirmed" ? "Confirmed" : "Dismissed"}
                              </span>
                            ) : (
                              <span className="co-rowactions">
                                <button
                                  type="button"
                                  className="co-btn co-btn--small co-btn--primary"
                                  onClick={() =>
                                    setResolved((s) => ({ ...s, [flag.member]: "confirmed" }))
                                  }
                                >
                                  Confirm bot
                                </button>
                                <button
                                  type="button"
                                  className="co-btn co-btn--small"
                                  onClick={() =>
                                    setResolved((s) => ({ ...s, [flag.member]: "dismissed" }))
                                  }
                                >
                                  Dismiss
                                </button>
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </section>
            </>
          ) : (
            <section className="co-panel">
              <header className="co-panel__head">
                <h2>Configuration</h2>
              </header>
              <div className="co-fieldrow co-fieldrow--static">
                <div className="co-fieldrow__text">
                  <strong>{feature.metricLabel}</strong>
                  <span>{feature.summary}</span>
                </div>
                <span className="co-table__mono" style={{ fontSize: "1.4rem" }}>
                  {feature.metric}
                </span>
              </div>
              <p className="co-note">
                Prototype drill-in — only Bot Defense is fully mocked in this variant.
              </p>
            </section>
          )}
        </div>

        <aside className="co-formgrid__side">
          <section className="co-panel">
            <header className="co-panel__head">
              <h2>Access</h2>
            </header>
            <div className="co-sidefact">
              <span>Mod queue</span>
              <strong>{BOT_DEFENSE.modQueue}</strong>
            </div>
            <div className="co-sidefact">
              <span>Mod roles</span>
              <strong>{BOT_DEFENSE.modRoles.join(", ")}</strong>
            </div>
            <div className="co-sidefact">
              <span>Excluded roles</span>
              <div className="co-chips">
                {BOT_DEFENSE.excludedRoles.map((r) => (
                  <span key={r} className="co-chip">
                    {r}
                  </span>
                ))}
              </div>
            </div>
          </section>
          <section className="co-panel">
            <header className="co-panel__head">
              <h2>Status</h2>
            </header>
            <div className="co-sidefact">
              <span>State</span>
              <span className={`co-status co-status--${feature.status}`}>
                <span className={`co-dot co-dot--${feature.status}`} />
                {STATUS_LABEL[feature.status]}
              </span>
            </div>
            <div className="co-sidefact">
              <span>Last change</span>
              <strong>2 days ago</strong>
            </div>
          </section>
        </aside>
      </div>

      <div className={`co-savebar ${dirty ? "is-visible" : ""}`} role="status">
        <span>
          <strong>{dirty}</strong> unsaved {dirty === 1 ? "change" : "changes"}
        </span>
        <div>
          <button type="button" className="co-btn" onClick={() => setDirty(0)}>
            Discard
          </button>
          <button type="button" className="co-btn co-btn--primary" onClick={() => setDirty(0)}>
            Save changes
          </button>
        </div>
      </div>
    </main>
  );
}
