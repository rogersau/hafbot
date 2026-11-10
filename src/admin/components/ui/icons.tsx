import * as React from "react";
import { cn } from "../../lib/utils";

type IconProps = React.SVGProps<SVGSVGElement> & { className?: string };

function makeIcon(path: React.ReactNode, displayName: string) {
  const Component = React.forwardRef<SVGSVGElement, IconProps>(({ className, ...props }, ref) => (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("shrink-0", className)}
      aria-hidden="true"
      {...props}
    >
      {path}
    </svg>
  ));
  Component.displayName = displayName;
  return Component;
}

export const LayoutDashboardIcon = /* @__PURE__ */ makeIcon(
  <>
    <rect x="3" y="3" width="7" height="9" rx="1" />
    <rect x="14" y="3" width="7" height="5" rx="1" />
    <rect x="14" y="12" width="7" height="9" rx="1" />
    <rect x="3" y="16" width="7" height="5" rx="1" />
  </>,
  "LayoutDashboardIcon",
);

export const ActivityIcon = /* @__PURE__ */ makeIcon(
  <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />,
  "ActivityIcon",
);

export const BadgeDollarSignIcon = /* @__PURE__ */ makeIcon(
  <>
    <path d="M12 3 4.5 6v6c0 4.5 3 7.5 7.5 9 4.5-1.5 7.5-4.5 7.5-9V6L12 3Z" />
    <path d="M14 9.5c-.5-.5-1.2-.8-2-.8-1.1 0-2 .6-2 1.5s.9 1.5 2 1.5 2 .6 2 1.5-.9 1.5-2 1.5c-.8 0-1.5-.3-2-.8M12 8v8" />
  </>,
  "BadgeDollarSignIcon",
);

export const BanIcon = /* @__PURE__ */ makeIcon(
  <>
    <circle cx="12" cy="12" r="10" />
    <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
  </>,
  "BanIcon",
);

export const ClockIcon = /* @__PURE__ */ makeIcon(
  <>
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </>,
  "ClockIcon",
);

export const TicketIcon = /* @__PURE__ */ makeIcon(
  <>
    <path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" />
    <path d="M13 5v2" />
    <path d="M13 17v2" />
    <path d="M13 11v2" />
  </>,
  "TicketIcon",
);

export const LogOutIcon = /* @__PURE__ */ makeIcon(
  <>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <polyline points="16 17 21 12 16 7" />
    <line x1="21" y1="12" x2="9" y2="12" />
  </>,
  "LogOutIcon",
);

export const ServerIcon = /* @__PURE__ */ makeIcon(
  <>
    <rect x="2" y="2" width="20" height="8" rx="2" />
    <rect x="2" y="14" width="20" height="8" rx="2" />
    <line x1="6" y1="6" x2="6.01" y2="6" />
    <line x1="6" y1="18" x2="6.01" y2="18" />
  </>,
  "ServerIcon",
);

export const RefreshIcon = /* @__PURE__ */ makeIcon(
  <>
    <polyline points="23 4 23 10 17 10" />
    <polyline points="1 20 1 14 7 14" />
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
  </>,
  "RefreshIcon",
);

export const PlayIcon = /* @__PURE__ */ makeIcon(
  <polygon points="5 3 19 12 5 21 5 3" />,
  "PlayIcon",
);

export const MenuIcon = /* @__PURE__ */ makeIcon(
  <>
    <line x1="3" y1="6" x2="21" y2="6" />
    <line x1="3" y1="12" x2="21" y2="12" />
    <line x1="3" y1="18" x2="21" y2="18" />
  </>,
  "MenuIcon",
);

export const XIcon = /* @__PURE__ */ makeIcon(
  <>
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </>,
  "XIcon",
);

export const PlusIcon = /* @__PURE__ */ makeIcon(
  <>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </>,
  "PlusIcon",
);

export const ChevronDownIcon = /* @__PURE__ */ makeIcon(
  <polyline points="6 9 12 15 18 9" />,
  "ChevronDownIcon",
);

export const ChevronLeftIcon = /* @__PURE__ */ makeIcon(
  <>
    <polyline points="11 17 6 12 11 7" />
    <polyline points="18 17 13 12 18 7" />
  </>,
  "ChevronLeftIcon",
);

export const ChevronRightIcon = /* @__PURE__ */ makeIcon(
  <>
    <polyline points="13 17 18 12 13 7" />
    <polyline points="6 17 11 12 6 7" />
  </>,
  "ChevronRightIcon",
);

export const CheckIcon = /* @__PURE__ */ makeIcon(
  <polyline points="20 6 9 17 4 12" />,
  "CheckIcon",
);

export const CircleIcon = /* @__PURE__ */ makeIcon(<circle cx="12" cy="12" r="6" />, "CircleIcon");

export const SearchIcon = /* @__PURE__ */ makeIcon(
  <>
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </>,
  "SearchIcon",
);

export const AlertTriangleIcon = /* @__PURE__ */ makeIcon(
  <>
    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </>,
  "AlertTriangleIcon",
);

export const AtSignIcon = /* @__PURE__ */ makeIcon(
  <>
    <circle cx="12" cy="12" r="4" />
    <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 8" />
  </>,
  "AtSignIcon",
);

export const CalendarClockIcon = /* @__PURE__ */ makeIcon(
  <>
    <path d="M8 2v4M16 2v4M3 10h18" />
    <rect x="3" y="4" width="18" height="18" rx="2" />
    <circle cx="16" cy="16" r="4" />
    <path d="M16 14v2l1 1" />
  </>,
  "CalendarClockIcon",
);

export const ShieldIcon = /* @__PURE__ */ makeIcon(
  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />,
  "ShieldIcon",
);

export const VaultIcon = /* @__PURE__ */ makeIcon(
  <>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="12" cy="12" r="4" />
    <path d="M12 8v4l2 2" />
    <path d="M7 7h.01M17 7h.01M7 17h.01M17 17h.01" />
  </>,
  "VaultIcon",
);

export const BotOffIcon = /* @__PURE__ */ makeIcon(
  <>
    <path d="M12 8V4H8" />
    <rect x="4" y="8" width="16" height="12" rx="2" />
    <path d="M2 14h2M20 14h2M9 13v2M15 13v2" />
    <path d="m5 5 14 14" />
  </>,
  "BotOffIcon",
);

export const CircleUserRoundIcon = /* @__PURE__ */ makeIcon(
  <>
    <circle cx="12" cy="12" r="10" />
    <circle cx="12" cy="10" r="3" />
    <path d="M6.5 19a6 6 0 0 1 11 0" />
  </>,
  "CircleUserRoundIcon",
);

export const WrenchIcon = /* @__PURE__ */ makeIcon(
  <>
    <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.2 2.2-2.8-2.8 2-2.4Z" />
  </>,
  "WrenchIcon",
);

export const UsersIcon = /* @__PURE__ */ makeIcon(
  <>
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </>,
  "UsersIcon",
);

export const RadioIcon = /* @__PURE__ */ makeIcon(
  <>
    <circle cx="12" cy="12" r="2" />
    <path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14" />
  </>,
  "RadioIcon",
);

export const RadioTowerIcon = /* @__PURE__ */ makeIcon(
  <>
    <path d="M12 10v11" />
    <path d="m8 21 4-11 4 11" />
    <path d="M5 8a10 10 0 0 1 14 0M2 5a14 14 0 0 1 20 0" />
  </>,
  "RadioTowerIcon",
);

export const LockIcon = /* @__PURE__ */ makeIcon(
  <>
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </>,
  "LockIcon",
);

export const BellIcon = /* @__PURE__ */ makeIcon(
  <>
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
  </>,
  "BellIcon",
);

export const UserIcon = /* @__PURE__ */ makeIcon(
  <>
    <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </>,
  "UserIcon",
);

export const ListFilterIcon = /* @__PURE__ */ makeIcon(
  <>
    <path d="M3 6h18M6 12h12M10 18h4" />
  </>,
  "ListFilterIcon",
);

export const TimerIcon = /* @__PURE__ */ makeIcon(
  <>
    <path d="M10 2h4M12 14v-4M12 6a8 8 0 1 0 5.66 2.34" />
    <path d="M17 3v3h3" />
    <path d="m20 3-3 3" />
  </>,
  "TimerIcon",
);

export const UserLockIcon = /* @__PURE__ */ makeIcon(
  <>
    <path d="M15 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <rect x="14" y="16" width="8" height="5" rx="1" />
    <path d="M16 16v-1a2 2 0 0 1 4 0v1" />
  </>,
  "UserLockIcon",
);

export const SettingsIcon = /* @__PURE__ */ makeIcon(
  <>
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </>,
  "SettingsIcon",
);

export const StarIcon = /* @__PURE__ */ makeIcon(
  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />,
  "StarIcon",
);

export const EyeIcon = /* @__PURE__ */ makeIcon(
  <>
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </>,
  "EyeIcon",
);

export const EyeOffIcon = /* @__PURE__ */ makeIcon(
  <>
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
    <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
    <line x1="1" y1="1" x2="23" y2="23" />
  </>,
  "EyeOffIcon",
);

export const ImageIcon = /* @__PURE__ */ makeIcon(
  <>
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <polyline points="21 15 16 10 5 21" />
  </>,
  "ImageIcon",
);

export const InfoIcon = /* @__PURE__ */ makeIcon(
  <>
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="16" x2="12" y2="12" />
    <line x1="12" y1="8" x2="12.01" y2="8" />
  </>,
  "InfoIcon",
);

export const MessagesSquareIcon = /* @__PURE__ */ makeIcon(
  <>
    <path d="M21 11a8 8 0 0 1-8 8H7l-4 3v-7a8 8 0 1 1 18-4Z" />
    <path d="M8 8h8M8 12h5" />
  </>,
  "MessagesSquareIcon",
);

export const StoreIcon = /* @__PURE__ */ makeIcon(
  <>
    <path d="M3 10h18M5 10v10h14V10M4 10l1-6h14l1 6" />
    <path d="M3 10a3 3 0 0 0 5 2 3 3 0 0 0 4 0 3 3 0 0 0 4 0 3 3 0 0 0 5-2M9 20v-5h6v5" />
  </>,
  "StoreIcon",
);

export const UsersRoundIcon = /* @__PURE__ */ makeIcon(
  <>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
  </>,
  "UsersRoundIcon",
);

export const Link2Icon = /* @__PURE__ */ makeIcon(
  <>
    <path d="M9 17H7a5 5 0 0 1 0-10h2M15 7h2a5 5 0 0 1 0 10h-2M8 12h8" />
  </>,
  "Link2Icon",
);

export const ClipboardListIcon = /* @__PURE__ */ makeIcon(
  <>
    <rect x="4" y="4" width="16" height="17" rx="2" />
    <path d="M8 4V2h8v2M8 10h8M8 14h5M8 18h3" />
  </>,
  "ClipboardListIcon",
);

export const WebhookIcon = /* @__PURE__ */ makeIcon(
  <>
    <circle cx="12" cy="5" r="2" />
    <circle cx="5" cy="19" r="2" />
    <circle cx="19" cy="19" r="2" />
    <path d="M12 7v4M10 12 6.5 17M14 12l3.5 5" />
  </>,
  "WebhookIcon",
);
