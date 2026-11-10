import { cn } from "../lib/utils";
import { useTabNavigation } from "./ui/tab-navigation";

export interface AdminTabItem<TabId extends string> {
  id: TabId;
  label: string;
  disabled?: boolean;
}

export function AdminTabs<TabId extends string>({
  tabs,
  activeTab,
  ariaLabel,
  className,
  leftContent,
  rightContent,
  onTabChange,
}: {
  tabs: Array<AdminTabItem<TabId>>;
  activeTab: TabId;
  ariaLabel: string;
  className?: string;
  leftContent?: React.ReactNode;
  rightContent?: React.ReactNode;
  onTabChange: (tab: TabId) => void;
}) {
  const navigation = useTabNavigation();
  const tabStop =
    tabs.find((tab) => tab.id === activeTab && !tab.disabled) ?? tabs.find((tab) => !tab.disabled);
  return (
    <div
      {...navigation}
      className={cn(
        "admin-tabs-bar flex flex-wrap items-center justify-between gap-1 border-b border-border",
        className,
      )}
      role="tablist"
      aria-label={ariaLabel}
    >
      <div className="flex flex-wrap items-center gap-1">
        {leftContent ? <div className="flex items-center">{leftContent}</div> : null}
        {tabs.map((tab) => {
          const selected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={selected}
              disabled={tab.disabled}
              tabIndex={tab === tabStop ? 0 : -1}
              className={cn(
                "admin-tabs-trigger relative flex min-w-[6.5rem] items-center justify-center px-4 py-2 text-center text-xs transition-colors disabled:opacity-50",
                selected
                  ? "font-display font-extrabold text-foreground"
                  : "font-display font-semibold text-muted-foreground hover:text-foreground",
              )}
              onClick={() => onTabChange(tab.id)}
            >
              {tab.label}
              {selected ? (
                <span className="absolute inset-x-4 -bottom-px h-0.5 rounded-full bg-accent" />
              ) : null}
            </button>
          );
        })}
      </div>
      {rightContent ? <div className="flex items-center pr-2">{rightContent}</div> : null}
    </div>
  );
}
