export type AdminFeedbackCategory = "problem" | "suggestion" | "other";
export type AdminFeedbackNotificationState = "pending" | "sent" | "failed";

export interface AdminFeedbackRecord {
  id: string;
  reference: string;
  category: AdminFeedbackCategory;
  summary: string;
  description: string;
  reporterUserId: string;
  guildId: string | null;
  workspaceId: string | null;
  route: string;
  pageLabel: string | null;
  correlationId: string | null;
  errorCode: string | null;
  rayId: string | null;
  workerVersion: string;
  environment: string;
  diagnosticsIncluded: boolean;
  browser: string | null;
  os: string | null;
  notificationState: AdminFeedbackNotificationState;
  notificationErrorCode: string | null;
  createdAtMs: number;
}

export interface AdminFeedbackStore {
  countRecentByReporter(reporterUserId: string, sinceMs: number): Promise<number>;
  readOldestRecentCreatedAtMs(reporterUserId: string, sinceMs: number): Promise<number | null>;
  insert(record: AdminFeedbackRecord): Promise<void>;
  updateNotification(
    id: string,
    state: AdminFeedbackNotificationState,
    errorCode?: string | null,
  ): Promise<void>;
  purgeExpired(beforeMs: number, limit: number): Promise<number>;
}
