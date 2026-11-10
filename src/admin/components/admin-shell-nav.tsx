import {
  useEffect,
  useState,
  type AnchorHTMLAttributes,
  type MouseEventHandler,
  type ReactNode,
  type JSX,
} from "react";
import { useNavigate } from "@tanstack/react-router";

import {
  ADMIN_DASHBOARD_ROUTES,
  getPaidAdminFeature,
  type AdminDashboardPath,
} from "../dashboard-routes";
import { cn } from "../lib/utils";
import {
  buildPlayerLinkPlatformHref,
  buildReactionRulesTabHref,
  buildTicketsTabHref,
  getPlayerLinkPlatformFromSearch,
  getReactionRulesTabFromSearch,
  getTicketsTabFromSearch,
} from "../lib/admin-route-state";
import {
  AtSignIcon,
  BanIcon,
  BadgeDollarSignIcon,
  BotOffIcon,
  CalendarClockIcon,
  ChevronDownIcon,
  CircleIcon,
  CircleUserRoundIcon,
  ClipboardListIcon,
  ImageIcon,
  Link2Icon,
  ListFilterIcon,
  LayoutDashboardIcon,
  LockIcon,
  MessagesSquareIcon,
  RadioIcon,
  SettingsIcon,
  StoreIcon,
  TicketIcon,
  TimerIcon,
  UserLockIcon,
  UsersIcon,
  UsersRoundIcon,
  VaultIcon,
  WebhookIcon,
  WrenchIcon,
} from "./ui/icons";
import type { GuildEntitlementTier } from "../../types";
import { isRecord } from "../../unknown-parse";

const ROUTE_ICONS: Partial<
  Record<AdminDashboardPath, (props: { className?: string }) => JSX.Element>
> = {
  "/admin": (props) => <LayoutDashboardIcon {...props} />,
  "/admin/billing": (props) => <BadgeDollarSignIcon {...props} />,
  "/admin/troubleshooting": (props) => <WrenchIcon {...props} />,
  "/admin/channel-permissions": (props) => <LockIcon {...props} />,
  "/admin/profile": (props) => <CircleUserRoundIcon {...props} />,
  "/admin/blocklist": (props) => <ListFilterIcon {...props} />,
  "/admin/timed-roles": (props) => <TimerIcon {...props} />,
  "/admin/reaction-roles": (props) => <UserLockIcon {...props} />,
  "/admin/tickets": (props) => <TicketIcon {...props} />,
  "/admin/managed-messages": (props) => <MessagesSquareIcon {...props} />,
  "/admin/commerce": (props) => <BadgeDollarSignIcon {...props} />,
  "/admin/marketplace": (props) => <StoreIcon {...props} />,
  "/admin/lfg": (props) => <UsersIcon {...props} />,
  "/admin/clans": (props) => <UsersRoundIcon {...props} />,
  "/admin/suggestions": (props) => <MessagesSquareIcon {...props} />,
  "/admin/events": (props) => <CalendarClockIcon {...props} />,
  "/admin/wardogs": (props) => <RadioIcon {...props} />,
  "/admin/playercount": (props) => <UsersRoundIcon {...props} />,
  "/admin/player-link": (props) => <Link2Icon {...props} />,
  "/admin/evidence-vault": (props) => <VaultIcon {...props} />,
  "/admin/ban-cases": (props) => <BanIcon {...props} />,
  "/admin/audit-log": (props) => <ClipboardListIcon {...props} />,
  "/admin/guild-settings": (props) => <SettingsIcon {...props} />,
  "/admin/webhooks": (props) => <WebhookIcon {...props} />,
  "/admin/image-rules": (props) => <ImageIcon {...props} />,
  "/admin/bot-defense": (props) => <BotOffIcon {...props} />,
  "/admin/mention-protection": (props) => <AtSignIcon {...props} />,
  "/admin/member-verification": (props) => <UserLockIcon {...props} />,
};

const SETTINGS_ROUTES = [
  { path: "/admin/profile", label: "Profile" },
  { path: "/admin/troubleshooting", label: "Troubleshooting" },
] as const;
const REACTION_RULE_TABS = [
  { hash: "blocklist", label: "Blocklist" },
  { hash: "limits", label: "Limits" },
] as const;
const PLAYER_LINK_TABS = [
  { platform: "steam", label: "Steam Link" },
  { platform: "xbox", label: "Xbox Link" },
  { platform: "playstation", label: "PlayStation Link" },
] as const;
const ADMIN_NAV_SECTION_LABELS = [
  "Overview",
  "Moderation",
  "Community Management",
  "Access Control",
  "Integrations",
  "Configuration",
] as const;
type AdminNavSectionLabel = (typeof ADMIN_NAV_SECTION_LABELS)[number];
type AdminNavSectionPreferences = Record<AdminNavSectionLabel, boolean>;

export const ADMIN_NAV_SECTION_STORAGE_KEY = "discord-automation:admin-nav-sections";
const DEFAULT_ADMIN_NAV_SECTION_PREFERENCES: AdminNavSectionPreferences = {
  Overview: true,
  Moderation: false,
  "Community Management": false,
  "Access Control": false,
  Integrations: false,
  Configuration: false,
};
// CUSTOMER_NAV_GROUPS items are either route objects ({ path, label }) rendered
// as flat SidebarRouteLinks, or one of two string sentinels ("Reaction Rules",
// "Player Link") rendered as expandable SidebarGroups with their own sub-links.
// Because the sentinels are handled inline below, they intentionally have no
// { path } entry and never reach SidebarRouteLink.
function dashboardRoute(path: AdminDashboardPath) {
  return ADMIN_DASHBOARD_ROUTES.find((route) => route.path === path)!;
}
const CUSTOMER_NAV_GROUPS = [
  {
    label: "Overview",
    items: [{ path: "/admin", label: "Dashboard" }],
  },
  {
    label: "Moderation",
    items: [
      "Reaction Rules",
      dashboardRoute("/admin/chat-moderation"),
      { path: "/admin/evidence-vault", label: "Evidence Vault" },
      { path: "/admin/ban-cases", label: "Ban Cases" },
      { path: "/admin/image-rules", label: "Image Rules" },
      { path: "/admin/bot-defense", label: "Bot Defense" },
      { path: "/admin/mention-protection", label: "Mention Protection" },
    ],
  },
  {
    label: "Community Management",
    items: [
      { path: "/admin/lfg", label: "LFG" },
      { path: "/admin/clans", label: "Clan Management" },
      { path: "/admin/suggestions", label: "Suggestions" },
      { path: "/admin/events", label: "Events" },
      { path: "/admin/commerce", label: "Commerce" },
      { path: "/admin/marketplace", label: "Marketplace" },
      { path: "/admin/tickets", label: "Tickets" },
      { path: "/admin/managed-messages", label: "Managed Messages" },
      dashboardRoute("/admin/automation"),
      dashboardRoute("/admin/reputation"),
    ],
  },
  {
    label: "Access Control",
    items: [
      { path: "/admin/reaction-roles", label: "Reaction Roles" },
      { path: "/admin/timed-roles", label: "Timed Roles" },
      { path: "/admin/member-verification", label: "Member Verification" },
    ],
  },
  {
    label: "Integrations",
    items: [
      dashboardRoute("/admin/content-feeds"),
      "Player Link",
      { path: "/admin/webhooks", label: "Webhooks" },
      { path: "/admin/playercount", label: "Player Count" },
      { path: "/admin/wardogs", label: "WARDOGS targets" },
    ],
  },
  {
    label: "Configuration",
    items: [
      { path: "/admin/guild-settings", label: "Guild Settings" },
      { path: "/admin/channel-permissions", label: "Channel Permissions" },
      "Configuration History",
      { path: "/admin/audit-log", label: "Guild Audit Log" },
      ...SETTINGS_ROUTES,
    ],
  },
] as const;

export function AdminShellNav({
  currentPath,
  currentSearch,
  selectedGuildId,
  selectedGuildTier,
  playstationLinkEnabled = true,
  collapsed,
  buildNavigationHref,
  onNavigate,
}: {
  currentPath: AdminDashboardPath;
  currentSearch: string;
  selectedGuildId: string;
  selectedGuildTier?: GuildEntitlementTier | null;
  playstationLinkEnabled?: boolean;
  collapsed: boolean;
  buildNavigationHref: (path: AdminDashboardPath) => string;
  onNavigate: () => void;
}) {
  const [reactionRulesExpanded, setReactionRulesExpanded] = useState(false);
  const [playerLinkExpanded, setPlayerLinkExpanded] = useState(false);
  const [sectionPreferences, setSectionPreferences] = useState<AdminNavSectionPreferences>(
    DEFAULT_ADMIN_NAV_SECTION_PREFERENCES,
  );
  // eslint-disable-next-line custom/no-use-effect -- localStorage is only available after hydration.
  useEffect(() => {
    const stored = readAdminNavSectionPreferences();
    if (stored) setSectionPreferences(stored);
  }, []);
  const reactionRulesActive = isRouteActive(currentPath, "/admin/blocklist", selectedGuildId);
  const activeReactionRulesTab = getReactionRulesTabFromSearch(currentSearch);
  const playerLinkActive = isRouteActive(currentPath, "/admin/player-link", selectedGuildId);
  const activePlayerLinkPlatform = getPlayerLinkPlatformFromSearch(currentSearch);
  const ticketsActive = isRouteActive(currentPath, "/admin/tickets", selectedGuildId);
  const configurationHistoryActive =
    ticketsActive && getTicketsTabFromSearch(currentSearch) === "history";
  const playerLinkTabs = playstationLinkEnabled
    ? PLAYER_LINK_TABS
    : PLAYER_LINK_TABS.filter((tab) => tab.platform !== "playstation");
  const reactionRulesOpen = reactionRulesExpanded || reactionRulesActive;
  const playerLinkOpen = playerLinkExpanded || playerLinkActive;
  const activeSection = getActiveNavSection(currentPath, currentSearch, selectedGuildId);

  return (
    <nav
      className="admin-shell-navigation mt-1 flex min-h-0 flex-1 flex-col space-y-4 overflow-y-auto px-3 pb-3"
      aria-label="Admin"
    >
      <>
        {CUSTOMER_NAV_GROUPS.map((group) => {
          const active = activeSection === group.label;
          const open = collapsed || active || sectionPreferences[group.label];
          return (
            <NavSection
              key={group.label}
              label={group.label}
              collapsed={collapsed}
              open={open}
              active={active}
              disclosureDisabled={collapsed || active}
              onToggle={() => {
                const next = {
                  ...sectionPreferences,
                  [group.label]: !sectionPreferences[group.label],
                };
                setSectionPreferences(next);
                writeAdminNavSectionPreferences(next);
              }}
            >
              {open
                ? group.items.map((item) => {
                    if (item === "Configuration History") {
                      return (
                        <SidebarSubLink
                          key={item}
                          href={buildTicketsTabHref(
                            buildNavigationHref("/admin/tickets"),
                            "history",
                          )}
                          active={configurationHistoryActive}
                          label={item}
                          onNavigate={onNavigate}
                          collapsed={collapsed}
                        />
                      );
                    }

                    if (item === "Player Link") {
                      return (
                        <SidebarGroup
                          key={item}
                          label="Player Link"
                          icon={<RadioIcon className="h-4 w-4 shrink-0" />}
                          open={collapsed || playerLinkOpen}
                          active={playerLinkActive}
                          collapsed={collapsed}
                          onToggle={() => setPlayerLinkExpanded((open) => !open)}
                        >
                          {playerLinkTabs.map((tab) => {
                            const active =
                              playerLinkActive && activePlayerLinkPlatform === tab.platform;
                            return (
                              <SidebarSubLink
                                key={tab.platform}
                                href={buildPlayerLinkPlatformHref(
                                  buildNavigationHref("/admin/player-link"),
                                  tab.platform,
                                )}
                                active={active}
                                label={tab.label}
                                onNavigate={onNavigate}
                                collapsed={collapsed}
                              />
                            );
                          })}
                        </SidebarGroup>
                      );
                    }

                    if (item === "Reaction Rules") {
                      return (
                        <SidebarGroup
                          key={item}
                          label="Reaction Rules"
                          icon={<BanIcon className="h-4 w-4 shrink-0" />}
                          open={collapsed || reactionRulesOpen}
                          active={reactionRulesActive}
                          collapsed={collapsed}
                          onToggle={() => setReactionRulesExpanded((open) => !open)}
                        >
                          {REACTION_RULE_TABS.map((tab) => {
                            const active =
                              reactionRulesActive && activeReactionRulesTab === tab.hash;
                            return (
                              <SidebarSubLink
                                key={tab.hash}
                                href={buildReactionRulesTabHref(
                                  buildNavigationHref("/admin/blocklist"),
                                  tab.hash,
                                )}
                                active={active}
                                label={tab.label}
                                onNavigate={onNavigate}
                                collapsed={collapsed}
                              />
                            );
                          })}
                        </SidebarGroup>
                      );
                    }

                    const route = item;
                    return (
                      <SidebarRouteLink
                        key={route.path}
                        route={route}
                        href={buildNavigationHref(route.path)}
                        active={
                          isRouteActive(currentPath, route.path, selectedGuildId) &&
                          !(route.path === "/admin/tickets" && configurationHistoryActive)
                        }
                        locked={isRouteLocked(route.path, selectedGuildTier)}
                        collapsed={collapsed}
                        onNavigate={onNavigate}
                      />
                    );
                  })
                : group.items.map((item) => (
                    <span
                      key={typeof item === "string" ? item : item.path}
                      aria-hidden="true"
                      className="sr-only"
                    >
                      {typeof item === "string" ? item : item.label}
                    </span>
                  ))}
            </NavSection>
          );
        })}
      </>
    </nav>
  );
}

function NavSection({
  label,
  collapsed,
  open,
  active,
  disclosureDisabled,
  children,
  onToggle,
}: {
  label: AdminNavSectionLabel;
  collapsed: boolean;
  open: boolean;
  active: boolean;
  disclosureDisabled: boolean;
  children: ReactNode;
  onToggle: () => void;
}) {
  const contentId = "admin-nav-section-" + slugifyNavSectionLabel(label);
  return (
    <section className="space-y-1" data-nav-section={label}>
      <button
        type="button"
        className={cn(
          "font-display flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          collapsed && "lg:justify-center",
          active && "text-foreground",
        )}
        disabled={disclosureDisabled}
        aria-expanded={open}
        aria-controls={contentId}
        aria-current={active ? "page" : undefined}
        title={collapsed ? label : undefined}
        onClick={onToggle}
      >
        <span className={cn("truncate", collapsed && "lg:hidden")}>{label}</span>
        <ChevronDownIcon
          className={cn("ml-auto h-3.5 w-3.5 transition-transform", open && "rotate-180")}
        />
      </button>
      <div id={contentId}>{children}</div>
    </section>
  );
}

function slugifyNavSectionLabel(label: AdminNavSectionLabel) {
  return label
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replace(/^-|[-]$/g, "");
}

function readAdminNavSectionPreferences(): AdminNavSectionPreferences | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(ADMIN_NAV_SECTION_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    const value = parsed;

    if (Object.keys(value).length !== ADMIN_NAV_SECTION_LABELS.length) return null;
    if (!ADMIN_NAV_SECTION_LABELS.every((label) => typeof value[label] === "boolean")) return null;
    return Object.fromEntries(
      ADMIN_NAV_SECTION_LABELS.map((label) => [label, value[label]]),
    ) as AdminNavSectionPreferences;
  } catch {
    return null;
  }
}

function writeAdminNavSectionPreferences(preferences: AdminNavSectionPreferences) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ADMIN_NAV_SECTION_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // persistence is a nice-to-have
  }
}

function getActiveNavSection(
  currentPath: string,
  currentSearch: string,
  selectedGuildId: string,
): AdminNavSectionLabel | null {
  const ticketsActive = isRouteActive(currentPath, "/admin/tickets", selectedGuildId);
  const configurationHistoryActive =
    ticketsActive && getTicketsTabFromSearch(currentSearch) === "history";
  for (const group of CUSTOMER_NAV_GROUPS) {
    for (const item of group.items) {
      if (item === "Configuration History") {
        if (configurationHistoryActive) return group.label;
      } else if (item === "Reaction Rules") {
        if (isRouteActive(currentPath, "/admin/blocklist", selectedGuildId)) return group.label;
      } else if (item === "Player Link") {
        if (isRouteActive(currentPath, "/admin/player-link", selectedGuildId)) return group.label;
      } else if (
        isRouteActive(currentPath, item.path, selectedGuildId) &&
        !(item.path === "/admin/tickets" && configurationHistoryActive)
      ) {
        return group.label;
      }
    }
  }
  return null;
}

export function getCurrentPageLabel(currentPath: AdminDashboardPath, selectedGuildId: string) {
  const directRoute = ADMIN_DASHBOARD_ROUTES.find((route) => route.path === currentPath);
  if (directRoute) return directRoute.label;

  const normalizedGuildId = selectedGuildId.trim();
  const scopedRoute = ADMIN_DASHBOARD_ROUTES.find((route) => {
    return normalizedGuildId && buildGuildScopedPath(route.path, normalizedGuildId) === currentPath;
  });

  return scopedRoute?.label ?? "Overview";
}

function SidebarRouteLink({
  route,
  href,
  active,
  locked,
  collapsed,
  onNavigate,
}: {
  route: { path: AdminDashboardPath; label: string };
  href: string;
  active: boolean;
  locked: boolean;
  collapsed: boolean;
  onNavigate: () => void;
}) {
  const Icon = ROUTE_ICONS[route.path] ?? CircleIcon;

  return (
    <NavigationLink
      href={href}
      aria-current={active ? "page" : undefined}
      title={collapsed ? route.label : undefined}
      className={cn(
        "font-display group relative flex items-center gap-3 rounded-md text-sm font-semibold transition-colors px-3 py-3 lg:px-2 lg:py-2",
        active
          ? "bg-primary text-primary-foreground shadow-xs"
          : locked
            ? "text-muted-foreground/70 hover:bg-muted hover:text-foreground"
            : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
      onNavigate={onNavigate}
    >
      <Icon
        className={cn(
          "h-5 w-5 shrink-0 transition-colors lg:h-4 lg:w-4",
          active
            ? "text-primary-foreground"
            : locked
              ? "text-muted-foreground/60"
              : "text-muted-foreground group-hover:text-foreground",
        )}
      />
      <SidebarText className={cn("truncate transition-all", collapsed && "lg:hidden")}>
        {route.label}
      </SidebarText>
      {locked && !collapsed ? (
        <span className="ml-auto" aria-label="Premium-only feature" title="Premium-only feature">
          <LockIcon className="h-3.5 w-3.5 text-muted-foreground/60" />
        </span>
      ) : null}
    </NavigationLink>
  );
}

function SidebarGroup({
  label,
  icon,
  open,
  active = false,
  collapsed,
  className,
  children,
  onToggle,
}: {
  label: string;
  icon: ReactNode;
  open: boolean;
  active?: boolean;
  collapsed: boolean;
  className?: string;
  children: ReactNode;
  onToggle: () => void;
}) {
  return (
    <div className={cn("mt-2", className)}>
      <button
        type="button"
        className={cn(
          "font-display flex w-full items-center gap-3 rounded-md px-2 py-2 text-sm font-semibold transition-colors hover:bg-muted hover:text-foreground",
          active ? "text-foreground" : "text-muted-foreground",
        )}
        aria-expanded={open}
        aria-current={active ? "page" : undefined}
        onClick={onToggle}
      >
        {icon}
        <SidebarText className={cn("flex-1 text-left", collapsed && "lg:hidden")}>
          {label}
        </SidebarText>
        <ChevronDownIcon
          className={cn(
            "h-3.5 w-3.5 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open ? <div className="mt-1 space-y-1">{children}</div> : null}
    </div>
  );
}

function SidebarSubLink({
  href,
  active,
  label,
  collapsed = false,
  onNavigate,
}: {
  href: string;
  active: boolean;
  label: string;
  collapsed?: boolean;
  onNavigate: () => void;
}) {
  return (
    <NavigationLink
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "font-display group flex items-center gap-3 rounded-md px-3 py-2 text-sm font-semibold transition-colors",
        active
          ? "bg-primary/10 text-primary"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
      onNavigate={onNavigate}
    >
      <CircleIcon
        className={cn(
          "h-2 w-2 shrink-0 transition-colors",
          active ? "fill-current text-primary" : "text-muted-foreground",
        )}
      />
      <SidebarText className={cn(collapsed && "lg:hidden")}>{label}</SidebarText>
    </NavigationLink>
  );
}

function SidebarText({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("inline-block translate-y-px", className)}>{children}</span>;
}

function NavigationLink({
  href,
  disabled = false,
  children,
  onNavigate,
  onClick,
  ...props
}: {
  href: string;
  disabled?: boolean;
  children: ReactNode;
  onNavigate: () => void;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "children" | "onClick">) {
  const navigate = useNavigate();

  if (disabled) {
    return (
      <a {...props} href="#" onClick={(event) => event.preventDefault()}>
        {children}
      </a>
    );
  }

  return (
    <a
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }

        onNavigate();
        event.preventDefault();
        void navigate({ href });
      }}
      {...props}
    >
      {children}
    </a>
  );
}

function isRouteLocked(path: AdminDashboardPath, selectedGuildTier?: GuildEntitlementTier | null) {
  return getPaidAdminFeature(path) !== null && selectedGuildTier === "free";
}

function isRouteActive(
  currentPath: string,
  routePath: AdminDashboardPath,
  selectedGuildId: string,
) {
  if (routePath === currentPath) return true;
  const normalizedGuildId = selectedGuildId.trim();
  if (!normalizedGuildId) return false;
  return buildGuildScopedPath(routePath, normalizedGuildId) === currentPath;
}

function buildGuildScopedPath(path: string, guildId: string) {
  if (path === "/admin") return `/admin/${encodeURIComponent(guildId)}`;
  if (!path.startsWith("/admin/")) return path;
  if (path === "/admin/billing") {
    return path;
  }

  return `/admin/${encodeURIComponent(guildId)}${path.slice("/admin".length)}`;
}
