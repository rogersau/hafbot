import changelog from "../../changelog.json";
import { MAIN_CONTENT_ID, SkipLink } from "../accessibility/skip-link";

const CHANGE_GROUPS = [
  ["new", "New"],
  ["improved", "Improved"],
  ["fixed", "Fixed"],
] as const;

const RELEASE_DATE = new Intl.DateTimeFormat("en-AU", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

export function ChangelogPage() {
  return (
    <div className="changelog-page min-h-screen bg-background text-foreground">
      <SkipLink />
      <header className="border-b border-border/60">
        <nav className="mx-auto flex max-w-4xl flex-col gap-4 px-6 py-6 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <a href="/" className="flex w-fit items-center gap-3 text-foreground">
            <img
              className="h-11 w-11 object-contain"
              src="/logo.png"
              alt="HAF Bot logo"
              width={44}
              height={44}
            />
            <span className="font-display text-base font-bold">HAF Bot</span>
          </a>
          <div className="flex flex-wrap items-center gap-5">
            <a href="/">Home</a>
            <a href="https://docs.hafbot.xyz">Docs</a>
            <a href="/admin">Admin</a>
            <a href="/changelog.xml">Subscribe to updates (Atom)</a>
          </div>
        </nav>
      </header>
      <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto max-w-4xl px-6 py-16">
        <p className="font-display text-sm font-bold uppercase text-accent">Product updates</p>
        <h1 className="font-display mt-4 text-5xl font-extrabold leading-none sm:text-6xl">
          What's new in HAF Bot
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-8 text-muted-foreground">
          New features, useful improvements, and important fixes for the communities using HAF Bot.
        </p>
        <p className="mt-6 text-sm text-muted-foreground">
          Entries describe features at their release date. Check{" "}
          <a href="https://docs.hafbot.xyz/plans" className="underline">
            current plans and limits
          </a>{" "}
          before choosing a subscription.
        </p>
        <div className="mt-14 space-y-12">
          {changelog.releases.map((release) => (
            <Release key={release.version} release={release} />
          ))}
        </div>
      </main>
    </div>
  );
}

function Release({ release }: { release: (typeof changelog.releases)[number] }) {
  return (
    <article
      className="rounded-lg border border-border bg-card/70 p-6 sm:p-8"
      id={`release-${encodeURIComponent(release.version)}`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="font-display text-xs font-bold uppercase tracking-wide text-accent">
            Version {release.version}
          </p>
          <h2 className="font-display mt-2 text-2xl font-bold sm:text-3xl">{release.title}</h2>
        </div>
        <time className="shrink-0 text-sm text-muted-foreground" dateTime={release.date}>
          {RELEASE_DATE.format(new Date(`${release.date}T00:00:00Z`))}
        </time>
      </div>
      <p className="mt-5 leading-7 text-muted-foreground">{release.summary}</p>
      <div className="mt-7 space-y-5">
        {CHANGE_GROUPS.map(([type, label]) => {
          const changes = release.changes.filter((change) => change.type === type);
          if (changes.length === 0) return null;
          return (
            <section key={type}>
              <h3 className="font-display text-sm font-bold uppercase text-foreground">{label}</h3>
              <ul className="mt-3 space-y-2 text-sm leading-6 text-muted-foreground">
                {changes.map((change, index) => (
                  <li key={index} className="flex gap-3">
                    <span
                      className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                      aria-hidden="true"
                    />
                    <span>{change.text}</span>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </article>
  );
}
