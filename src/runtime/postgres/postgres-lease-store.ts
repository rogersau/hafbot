import { randomUUID } from "node:crypto";

import type { PostgresDatabaseCapability } from "./postgres-capability";
import { readPostgresSafeInteger } from "./postgres-values";

export interface PostgresLease {
  name: string;
  ownerId: string;
  leaseToken: string;
  fencingGeneration: number;
  leaseExpiresAt: Date;
}

export interface PostgresLeaseStore {
  acquire(
    name: string,
    ownerId: string,
    leaseMs: number,
    now?: Date,
  ): Promise<PostgresLease | null>;
  renew(lease: PostgresLease, leaseMs: number, now?: Date): Promise<PostgresLease | null>;
  release(lease: PostgresLease): Promise<boolean>;
  read(name: string): Promise<PostgresLease | null>;
}

const MAX_LEASE_MS = 15 * 60_000;

export function createPostgresLeaseStore(
  database: PostgresDatabaseCapability,
  options: { randomId?: () => string } = {},
): PostgresLeaseStore {
  const randomId = options.randomId ?? randomUUID;
  return {
    async acquire(name, ownerId, leaseMs, now = new Date()) {
      assertIdentifier(name, "lease name");
      assertIdentifier(ownerId, "lease owner");
      const leaseToken = randomId();
      const expiresAt = new Date(now.getTime() + readLeaseMs(leaseMs));
      const rows = await database.query<LeaseRow>(
        `INSERT INTO scheduler_leases (
           name, owner_id, lease_token, fencing_generation, lease_expires_at, updated_at
         ) VALUES ($1, $2, $3, 1, $4, $5)
         ON CONFLICT (name) DO UPDATE
           SET owner_id = EXCLUDED.owner_id,
               lease_token = EXCLUDED.lease_token,
               fencing_generation = scheduler_leases.fencing_generation + 1,
               lease_expires_at = EXCLUDED.lease_expires_at,
               updated_at = EXCLUDED.updated_at
         WHERE scheduler_leases.lease_expires_at <= $5
         RETURNING *`,
        [name, ownerId, leaseToken, expiresAt, now],
      );
      return rows[0] ? mapLease(rows[0]) : null;
    },

    async renew(lease, leaseMs, now = new Date()) {
      const expiresAt = new Date(now.getTime() + readLeaseMs(leaseMs));
      const rows = await database.query<LeaseRow>(
        `UPDATE scheduler_leases
            SET lease_expires_at = $1, updated_at = $2
          WHERE name = $3
            AND owner_id = $4
            AND lease_token = $5
            AND fencing_generation = $6
            AND lease_expires_at > $2
          RETURNING *`,
        [expiresAt, now, lease.name, lease.ownerId, lease.leaseToken, lease.fencingGeneration],
      );
      return rows[0] ? mapLease(rows[0]) : null;
    },

    release(lease) {
      return database
        .execute(
          `DELETE FROM scheduler_leases
            WHERE name = $1 AND owner_id = $2 AND lease_token = $3 AND fencing_generation = $4`,
          [lease.name, lease.ownerId, lease.leaseToken, lease.fencingGeneration],
        )
        .then((count) => count === 1);
    },

    async read(name) {
      assertIdentifier(name, "lease name");
      const rows = await database.query<LeaseRow>(
        "SELECT * FROM scheduler_leases WHERE name = $1",
        [name],
      );
      return rows[0] ? mapLease(rows[0]) : null;
    },
  };
}

interface LeaseRow extends Record<string, unknown> {
  name: string;
  owner_id: string;
  lease_token: string;
  fencing_generation: string | number;
  lease_expires_at: Date;
}

function mapLease(row: LeaseRow): PostgresLease {
  return {
    name: row.name,
    ownerId: row.owner_id,
    leaseToken: row.lease_token,
    fencingGeneration: readPostgresSafeInteger(row.fencing_generation, "fencing_generation"),
    leaseExpiresAt: row.lease_expires_at,
  };
}

function readLeaseMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 100 || value > MAX_LEASE_MS) {
    throw new Error(`Lease duration must be between 100 and ${MAX_LEASE_MS} milliseconds.`);
  }
  return value;
}

function assertIdentifier(value: string, name: string): void {
  if (!value || value.length > 255 || hasControlCharacter(value)) {
    throw new Error(`${name} must be a non-empty bounded identifier.`);
  }
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => character.codePointAt(0)! < 32);
}
