import type { ReactNode } from "react";
import type {
  AdminGuildDirectoryEntry,
  UserPreferences,
  UserPreferencesPatch,
} from "../../runtime/admin-types";
import type { EntitlementInfo } from "../hooks/use-entitlement";
import type { ApplyUserPreferencesOptions } from "../hooks/use-user-preferences";
import type {
  CommerceTab,
  PlayerLinkPlatform,
  ReactionRulesTab,
  TicketsTab,
} from "../lib/admin-route-state";

export interface AdminPageMetadata {
  title: string;
  description: string;
  icon: ReactNode;
  actions?: ReactNode;
}

export interface AdminRouterContext {
  currentPath: string;
  currentSearch: string;
  selectedWorkspaceId: string;
  selectedGuildId: string;
  pathGuildId: string;
  reactionRulesTab: ReactionRulesTab;
  playerLinkPlatform: PlayerLinkPlatform;
  ticketsTab: TicketsTab;
  commerceTab: CommerceTab;
  defaultRedirectTarget: string | null;
  guildDirectory: AdminGuildDirectoryEntry[] | null;
  guildLookupError: string | null;
  guildResourcesRefreshVersion: number;
  onSelectedGuildChange: (nextGuildId: string) => void;
  refreshGuildDirectory: () => Promise<void>;
  onRefresh: () => Promise<void>;
  playstationLinkEnabled: boolean;
  workerVersion?: string;
  entitlement: EntitlementInfo | null;
  userProfile: {
    name: string;
    email: string;
    image: string;
  };
  userPreferences: UserPreferences;
  applyUserPreferencesPatch: (
    patch: UserPreferencesPatch,
    options?: ApplyUserPreferencesOptions,
  ) => Promise<void>;
  pageMetadata: AdminPageMetadata | null;
  setPageMetadata: (metadata: AdminPageMetadata | null) => void;
  isRoutePending: boolean;
}
