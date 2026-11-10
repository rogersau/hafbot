export interface GuildR2ObjectStore {
  upsertObject(input: {
    guildId: string;
    key: string;
    sizeBytes: number;
    createdAtMs: number;
  }): Promise<void>;
  deleteObject(input: { guildId: string; key: string; deletedAtMs?: number }): Promise<void>;
  getGuildUsageBytes(guildId: string): Promise<number>;
}

export interface GuildR2Usage {
  usedBytes: number;
  reservedBytes: number;
  lastReconciledAtMs: number | null;
}

export interface ExpiredGuildR2UploadReservation {
  guildId: string;
  key: string;
  operationKey: string;
}

export type GuildR2ReservationResult =
  | { status: "reserved"; previousCommittedBytes: number }
  | { status: "quota-exceeded"; usage: GuildR2Usage }
  | { status: "conflict" };

export interface GuildR2QuotaStore extends GuildR2ObjectStore {
  reserveObject(input: {
    guildId: string;
    key: string;
    operationKey: string;
    reservedBytes: number;
    limitBytes: number;
    expiresAtMs: number;
    nowMs: number;
  }): Promise<GuildR2ReservationResult>;
  commitObject(input: {
    guildId: string;
    key: string;
    operationKey: string;
    actualBytes: number;
    committedAtMs: number;
  }): Promise<boolean>;
  markUploadStarted(input: {
    guildId: string;
    key: string;
    operationKey: string;
    startedAtMs: number;
  }): Promise<boolean>;
  releaseReservation(input: {
    guildId: string;
    key: string;
    operationKey: string;
  }): Promise<boolean>;
  releaseExpiredReservations(nowMs: number, limit: number): Promise<number>;
  listExpiredUploadReservations(
    nowMs: number,
    limit: number,
  ): Promise<ExpiredGuildR2UploadReservation[]>;
  resolveExpiredUploadReservation(input: {
    guildId: string;
    key: string;
    operationKey: string;
    actualBytes: number | null;
    resolvedAtMs: number;
  }): Promise<boolean>;
  getGuildUsage(guildId: string): Promise<GuildR2Usage>;
}
