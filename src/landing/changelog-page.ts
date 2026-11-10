import changelog from "../../changelog.json";

const CHANGE_GROUPS = [
  ["new", "New"],
  ["improved", "Improved"],
  ["fixed", "Fixed"],
] as const;

export function renderChangelog(): HTMLElement {
  const page = element("div", "min-h-screen bg-background text-foreground");
  page.append(renderHeader(), renderMain());
  return page;
}

function renderHeader(): HTMLElement {
  const header = element("header", "border-b border-border/60");
  const nav = element(
    "nav",
    "mx-auto flex max-w-4xl flex-col gap-4 px-6 py-6 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between",
  );
  const brand = link("/", "flex w-fit items-center gap-3 text-foreground");
  const logo = element("img", "h-11 w-11 object-contain");
  logo.src = "/logo.png";
  logo.alt = "HAF Bot logo";
  logo.width = 44;
  logo.height = 44;
  brand.append(logo, element("span", "font-display text-base font-bold", "HAF Bot"));

  const links = element("div", "flex flex-wrap items-center gap-5");
  links.append(link("/", undefined, "Home"), link("https://docs.hafbot.xyz", undefined, "Docs"));
  links.append(link("/admin", undefined, "Admin"));
  links.append(link("/changelog.xml", undefined, "Subscribe to updates (Atom)"));
  nav.append(brand, links);
  header.append(nav);
  return header;
}

function renderMain(): HTMLElement {
  const main = element("main", "mx-auto max-w-4xl px-6 py-16");
  main.append(
    element("p", "font-display text-sm font-bold uppercase text-accent", "Product updates"),
    element(
      "h1",
      "font-display mt-4 text-5xl font-extrabold leading-none sm:text-6xl",
      "What's new in HAF Bot",
    ),
    element(
      "p",
      "mt-6 max-w-2xl text-lg leading-8 text-muted-foreground",
      "New features, useful improvements, and important fixes for the communities using HAF Bot.",
    ),
  );

  const historyNote = element("p", "mt-6 text-sm text-muted-foreground");
  historyNote.append(
    "Entries describe features at their release date. Check ",
    link("https://docs.hafbot.xyz/plans", undefined, "current plans and limits"),
    " before choosing a subscription.",
  );
  main.append(historyNote);

  const releases = element("div", "mt-14 space-y-12");
  releases.append(...changelog.releases.map(renderRelease));
  main.append(releases);
  return main;
}

function renderRelease(release: (typeof changelog.releases)[number]): HTMLElement {
  const article = element("article", "rounded-lg border border-border bg-card/70 p-6 sm:p-8");
  article.id = `release-${encodeURIComponent(release.version)}`;
  const heading = element(
    "div",
    "flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between",
  );
  const title = element("div");
  title.append(
    element(
      "p",
      "font-display text-xs font-bold uppercase tracking-wide text-accent",
      `Version ${release.version}`,
    ),
    element("h2", "font-display mt-2 text-2xl font-bold sm:text-3xl", release.title),
  );
  const date = element("time", "shrink-0 text-sm text-muted-foreground", formatDate(release.date));
  date.dateTime = release.date;
  heading.append(title, date);

  const groups = element("div", "mt-7 space-y-5");
  for (const [type, label] of CHANGE_GROUPS) {
    const changes = release.changes.filter((change) => change.type === type);
    if (changes.length === 0) continue;

    const section = element("section");
    section.append(
      element("h3", "font-display text-sm font-bold uppercase text-foreground", label),
    );
    const list = element("ul", "mt-3 space-y-2 text-sm leading-6 text-muted-foreground");
    for (const change of changes) {
      const item = element("li", "flex gap-3");
      const bullet = element("span", "mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-accent");
      bullet.setAttribute("aria-hidden", "true");
      item.append(bullet, element("span", undefined, change.text));
      list.append(item);
    }
    section.append(list);
    groups.append(section);
  }

  article.append(
    heading,
    element("p", "mt-5 leading-7 text-muted-foreground", release.summary),
    groups,
  );
  return article;
}

function formatDate(date: string): string {
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function link(href: string, className?: string, text?: string): HTMLAnchorElement {
  const anchor = element("a", className, text);
  anchor.href = href;
  return anchor;
}
