/* PROTOTYPE — throwaway. Variant A: "Mission Control".
   A true-black telemetry deck. Slim icon rail, chamfered esports module cards,
   mono data accents, one glance = whole guild. */

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
import "./mission-control.css";

export function MissionControl() {
  const [view, setView] = useState<string>("deck");
  const openFeature = FEATURES.find((f) => f.id === view);

  return (
    <div className="mc-root">
      <aside className="mc-rail" aria-label="Feature rail">
        <a className="mc-rail__logo" href="?variant=A" title="HAF Bot — deck">
          <img src="/logo.png" alt="HAF Bot" />
        </a>
        <button
          type="button"
          className={`mc-rail__item ${view === "deck" ? "is-active" : ""}`}
          title="Overview"
          onClick={() => setView("deck")}
        >
          <Icon name="overview" size={18} />
        </button>
        <div className="mc-rail__divider" />
        {FEATURES.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`mc-rail__item ${view === f.id ? "is-active" : ""}`}
            title={`${f.name} — ${STATUS_LABEL[f.status]}`}
            onClick={() => setView(f.id)}
          >
            <Icon name={FEATURE_ICONS[f.id] ?? "settings"} size={18} />
            <span className={`mc-rail__dot mc-rail__dot--${f.status}`} />
          </button>
        ))}
        <div className="mc-rail__spacer" />
        <button type="button" className="mc-rail__item" title="Guild Settings">
          <Icon name="settings" size={18} />
        </button>
      </aside>

      <div className="mc-main">
        <header className="mc-topbar">
          <button type="button" className="mc-guild-switch">
            <span className="mc-guild-switch__sigil">WC</span>
            <span className="mc-guild-switch__name">{GUILD.name}</span>
            <Icon name="chevronDown" size={14} />
          </button>
          <span className="mc-plan">{GUILD.plan}</span>
          <div className="mc-topbar__spacer" />
          <button type="button" className="mc-search">
            <Icon name="search" size={14} />
            <span>Ask HAF or jump to…</span>
            <kbd>⌘K</kbd>
          </button>
          <span className="mc-avatar" title="Signed in as rogers">
            R
          </span>
        </header>

        {view === "deck" || !openFeature ? (
          <Deck onOpen={setView} />
        ) : openFeature.id === "bot-defense" ? (
          <BotDefensePanel onBack={() => setView("deck")} />
        ) : (
          <GenericPanel feature={openFeature} onBack={() => setView("deck")} />
        )}
      </div>
    </div>
  );
}

function Deck({ onOpen }: { onOpen: (id: string) => void }) {
  return (
    <main className="mc-deck">
      <section className="mc-hero">
        <div className="mc-hero__badge">
          <img src="/logo.png" alt="" />
        </div>
        <div className="mc-hero__copy">
          <p className="mc-hero__eyebrow">Guild operations // {GUILD.handle}</p>
          <h1 className="mc-hero__title">
            ALL SYSTEMS <em>HELPFUL.</em>
          </h1>
          <div className="mc-hero__telemetry">
            <span>
              <strong>{GUILD.members.toLocaleString()}</strong> members
            </span>
            <span>
              <strong>142</strong> actions today
            </span>
            <span>
              <strong>{ATTENTION.length}</strong> need you
            </span>
          </div>
        </div>
        <div className="mc-hero__ring" title={`Setup coverage ${GUILD.coverage}%`}>
          <svg viewBox="0 0 120 120">
            <circle className="mc-ring__track" cx="60" cy="60" r="52" />
            <circle
              className="mc-ring__fill"
              cx="60"
              cy="60"
              r="52"
              strokeDasharray={`${(GUILD.coverage / 100) * 326.7} 326.7`}
            />
          </svg>
          <div className="mc-ring__label">
            <strong>{GUILD.coverage}%</strong>
            <span>coverage</span>
          </div>
        </div>
      </section>

      <section className="mc-attention" aria-label="Needs attention">
        {ATTENTION.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`mc-alert mc-alert--${item.severity}`}
            onClick={() => onOpen(item.featureId)}
          >
            <Icon name={item.severity === "setup" ? "bolt" : "alert"} size={15} />
            <span className="mc-alert__title">{item.title}</span>
            <span className="mc-alert__detail">{item.detail}</span>
            <span className="mc-alert__action">
              {item.action} <Icon name="arrowRight" size={13} />
            </span>
          </button>
        ))}
      </section>

      <section className="mc-grid" aria-label="Feature modules">
        {FEATURES.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`mc-module mc-module--${f.status}`}
            onClick={() => onOpen(f.id)}
          >
            <span className="mc-module__head">
              <Icon name={FEATURE_ICONS[f.id] ?? "settings"} size={15} />
              <span className="mc-module__group">{f.group}</span>
              <span className={`mc-led mc-led--${f.status}`} />
            </span>
            <span className="mc-module__metric">{f.metric}</span>
            <span className="mc-module__metric-label">{f.metricLabel}</span>
            <span className="mc-module__name">{f.name}</span>
            <span className="mc-module__spark" aria-hidden="true">
              {f.spark.map((v, i) => (
                <i key={i} style={{ height: `${Math.max(8, v * 10)}%` }} />
              ))}
            </span>
          </button>
        ))}
      </section>

      <section className="mc-activity">
        <h2 className="mc-section-title">Live feed</h2>
        <ul>
          {ACTIVITY.slice(0, 5).map((event, i) => (
            <li key={i}>
              <span className="mc-activity__at">{event.at}</span>
              <span>{event.text}</span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

function BotDefensePanel({ onBack }: { onBack: () => void }) {
  const [honeypotOn, setHoneypotOn] = useState(BOT_DEFENSE.honeypot.enabled);
  const [rateOn, setRateOn] = useState(BOT_DEFENSE.rate.enabled);
  const [channels, setChannels] = useState(BOT_DEFENSE.rate.channels);
  const [window_, setWindow] = useState(BOT_DEFENSE.rate.windowSeconds);
  const [resolved, setResolved] = useState<Record<string, string>>({});

  const openFlags = BOT_DEFENSE.flags.filter((f) => !resolved[f.member]);

  return (
    <main className="mc-panel">
      <button type="button" className="mc-back" onClick={onBack}>
        ← Deck
      </button>
      <header className="mc-panel__header">
        <h1>
          BOT <em>DEFENSE</em>
        </h1>
        <span className={`mc-chip ${openFlags.length ? "mc-chip--hot" : ""}`}>
          {openFlags.length ? `${openFlags.length} flags open` : "Queue clear"}
        </span>
      </header>

      <div className="mc-panel__columns">
        <section className="mc-bank">
          <h2 className="mc-section-title">Detectors</h2>

          <div className="mc-detector">
            <div className="mc-detector__head">
              <h3>Honeypot Detector</h3>
              <Toggle on={honeypotOn} onClick={() => setHoneypotOn(!honeypotOn)} />
            </div>
            <p className="mc-detector__blurb">
              Flags any member who posts in a designated honeypot channel.
            </p>
            <div className="mc-field">
              <span className="mc-field__label">Honeypot channel</span>
              <span className="mc-tag">{BOT_DEFENSE.honeypot.channel}</span>
            </div>
            <div className="mc-field">
              <span className="mc-field__label">On trip</span>
              <span className="mc-field__value">{BOT_DEFENSE.honeypot.response}</span>
            </div>
          </div>

          <div className="mc-detector">
            <div className="mc-detector__head">
              <h3>Rate Detector</h3>
              <Toggle on={rateOn} onClick={() => setRateOn(!rateOn)} />
            </div>
            <p className="mc-detector__blurb">
              Flags members spraying the same message across channels.
            </p>
            <div className="mc-field">
              <span className="mc-field__label">Trip at</span>
              <Stepper value={channels} unit="channels" min={2} max={12} onChange={setChannels} />
            </div>
            <div className="mc-field">
              <span className="mc-field__label">Within</span>
              <Stepper
                value={window_}
                unit="sec"
                min={15}
                max={300}
                step={15}
                onChange={setWindow}
              />
            </div>
            <div className="mc-field">
              <span className="mc-field__label">On trip</span>
              <span className="mc-field__value">{BOT_DEFENSE.rate.response}</span>
            </div>
          </div>

          <div className="mc-detector mc-detector--shared">
            <h3>Shared</h3>
            <div className="mc-field">
              <span className="mc-field__label">Excluded roles</span>
              <span className="mc-field__chips">
                {BOT_DEFENSE.excludedRoles.map((r) => (
                  <span key={r} className="mc-tag">
                    {r}
                  </span>
                ))}
              </span>
            </div>
            <div className="mc-field">
              <span className="mc-field__label">Mod queue</span>
              <span className="mc-tag">{BOT_DEFENSE.modQueue}</span>
            </div>
          </div>
        </section>

        <section className="mc-flags">
          <h2 className="mc-section-title">Flag queue</h2>
          {BOT_DEFENSE.flags.map((flag) => {
            const state = resolved[flag.member];
            return (
              <article key={flag.member} className={`mc-flag ${state ? "is-resolved" : ""}`}>
                <div className="mc-flag__row">
                  <strong>{flag.member}</strong>
                  <span className="mc-flag__age">{flag.age}</span>
                </div>
                <p className="mc-flag__evidence">{flag.evidence}</p>
                <span className="mc-tag">{flag.detector}</span>
                {state ? (
                  <p className="mc-flag__terminal">
                    {state === "confirmed" ? "Confirmed bot — never re-flagged" : "Dismissed"}
                  </p>
                ) : (
                  <div className="mc-flag__actions">
                    <button
                      type="button"
                      className="mc-btn mc-btn--primary"
                      onClick={() => setResolved((s) => ({ ...s, [flag.member]: "confirmed" }))}
                    >
                      Confirm bot
                    </button>
                    <button
                      type="button"
                      className="mc-btn"
                      onClick={() => setResolved((s) => ({ ...s, [flag.member]: "dismissed" }))}
                    >
                      Dismiss
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </section>
      </div>
    </main>
  );
}

function GenericPanel({ feature, onBack }: { feature: Feature; onBack: () => void }) {
  return (
    <main className="mc-panel">
      <button type="button" className="mc-back" onClick={onBack}>
        ← Deck
      </button>
      <header className="mc-panel__header">
        <h1>{feature.name}</h1>
        <span className="mc-chip">{STATUS_LABEL[feature.status]}</span>
      </header>
      <div className="mc-module mc-module--wide">
        <span className="mc-module__metric">{feature.metric}</span>
        <span className="mc-module__metric-label">{feature.metricLabel}</span>
        <p className="mc-panel__summary">{feature.summary}</p>
      </div>
      <p className="mc-panel__note">
        Prototype drill-in — only Bot Defense is fully mocked in this variant.
      </p>
    </main>
  );
}

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={`mc-toggle ${on ? "is-on" : ""}`}
      onClick={onClick}
    >
      <span className="mc-toggle__thumb" />
    </button>
  );
}

function Stepper({
  value,
  unit,
  min,
  max,
  step = 1,
  onChange,
}: {
  value: number;
  unit: string;
  min: number;
  max: number;
  step?: number;
  onChange: (next: number) => void;
}) {
  return (
    <span className="mc-stepper">
      <button
        type="button"
        aria-label="decrease"
        onClick={() => onChange(Math.max(min, value - step))}
      >
        −
      </button>
      <span className="mc-stepper__value">
        {value} <small>{unit}</small>
      </span>
      <button
        type="button"
        aria-label="increase"
        onClick={() => onChange(Math.min(max, value + step))}
      >
        +
      </button>
    </span>
  );
}
