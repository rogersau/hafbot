import {
  decryptWardogsRconCredential,
  encryptWardogsRconCredential,
  type PlaintextWardogsRconSecret,
  type WebhookCredentialKeyRing,
} from "../security/webhook-credentials";
import {
  DISABLED_NETWORK,
  WARDOGS_POLICY,
  WardogsError,
  WardogsPreDispatchError,
  publicTarget,
  type ApprovedOrigin,
  type NetworkPolicy,
  type ReadOperation,
  type ReadResults,
  type Target,
} from "./model";
import type { WardogsStore } from "./store";
import {
  approvedOrigin,
  readWdrcon,
  requestWdrcon,
  validateSecret,
  type ReadTransport,
  type BanRequest,
} from "./transport";

export interface WardogsOptions {
  store: WardogsStore;
  reservedAccessEnabled?: boolean;
  mutationsEnabled?: boolean;
  commerceGrantsEnabled?: boolean;
  canChangeOrigin?: (guildId: string, targetId: string) => Promise<boolean>;
  keyRing?: () => Promise<WebhookCredentialKeyRing>;
  policy?: NetworkPolicy;
  transport?: ReadTransport;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}
export class WardogsService {
  private readonly now: () => number;
  readonly policy: NetworkPolicy;
  constructor(private readonly options: WardogsOptions) {
    this.now = options.now ?? Date.now;
    this.policy = options.policy ?? DISABLED_NETWORK;
  }
  async list(guildId: string) {
    return (await this.options.store.list(guildId)).map((target) => {
      const dto = publicTarget(target);
      const entry = this.policy.origins.find((entry) => entry.id === target.originRef);
      dto.stale ||=
        !this.policy.enabled ||
        !target.enabled ||
        !entry ||
        target.verifiedOrigin !== approvedOrigin(entry) ||
        !this.policy.approvals.some(
          (approval) =>
            approval.targetId === target.id &&
            approval.generation === target.generation &&
            approval.originRef === target.originRef &&
            approval.origin === approvedOrigin(entry),
        );
      return dto;
    });
  }
  async statusReadiness(guildId: string, targetId: string) {
    const target = await this.options.store.read(guildId, targetId);
    if (!target)
      return { target: null, ready: false, error: "WARDOGS target is unavailable for this Guild." };
    const entry = this.policy.origins.find((entry) => entry.id === target.originRef);
    const approved =
      entry &&
      this.policy.approvals.some(
        (approval) =>
          approval.targetId === target.id &&
          approval.generation === target.generation &&
          approval.originRef === target.originRef &&
          approval.origin === approvedOrigin(entry),
      );
    const ready = Boolean(
      this.policy.enabled &&
      target.enabled &&
      !target.disconnected &&
      target.envelope &&
      this.options.keyRing &&
      approved &&
      !target.authBlocked &&
      target.verifiedGeneration === target.generation &&
      entry &&
      target.verifiedOrigin === approvedOrigin(entry),
    );
    return {
      target: publicTarget(target),
      ready,
      error: ready
        ? undefined
        : "WARDOGS target requires enabled, approved and verified read access for its current configuration.",
    };
  }
  async observationReadiness(guildId: string, targetId: string) {
    const state = await this.statusReadiness(guildId, targetId);
    const entry = this.policy.origins.find((e) => e.id === state.target?.originRef);
    const approval = this.policy.approvals.find(
      (a) =>
        a.targetId === targetId &&
        a.generation === state.target?.generation &&
        a.originRef === state.target?.originRef &&
        entry &&
        a.origin === approvedOrigin(entry),
    );
    return {
      authorized: Boolean(
        this.policy.enabled && state.target?.enabled && !state.target.disconnected && approval,
      ),
      ready: state.ready,
      generation: state.target?.generation ?? 0,
      completeRoster: Boolean(
        approval?.attendanceContract?.completeRoster && approval.attendanceContract.evidence.trim(),
      ),
    };
  }
  setup() {
    return {
      networkEnabled: this.policy.enabled,
      credentialEncryptionAvailable: Boolean(this.options.keyRing),
      origins: this.policy.origins.map(({ id }) => ({ id })),
      maxTargets: WARDOGS_POLICY.maxTargets,
    };
  }
  async create(guildId: string, name: string, originRef: string | null) {
    this.validateConfig(name, originRef);
    const now = this.now();
    const target: Target = {
      id: crypto.randomUUID(),
      guildId,
      name,
      originRef,
      generation: 1,
      enabled: false,
      banCasesEnabled: false,
      disconnected: false,
      credentialId: null,
      envelope: null,
      credentialUpdatedAtMs: null,
      createdAtMs: now,
      updatedAtMs: now,
      diagnostic: null,
      authBlocked: false,
      verifiedOrigin: null,
      verifiedGeneration: null,
      verifiedAtMs: null,
      lastSuccessAtMs: null,
    };
    if (!(await this.options.store.create(target))) throw new WardogsError("disabled");
    return publicTarget(target);
  }
  async change(input: {
    guildId: string;
    targetId: string;
    generation: number;
    name?: string;
    originRef?: string | null;
    enabled?: boolean;
    commerceEnabled?: boolean;
    banCasesEnabled?: boolean;
    secret?: string;
    disconnect?: boolean;
  }) {
    const target = await this.owned(input.guildId, input.targetId, input.generation);
    this.validateConfig(
      input.name ?? target.name,
      input.originRef === undefined ? target.originRef : input.originRef,
    );
    if (
      input.originRef !== undefined &&
      input.originRef !== target.originRef &&
      this.options.canChangeOrigin &&
      !(await this.options.canChangeOrigin(input.guildId, input.targetId))
    )
      throw new WardogsError("disabled");
    if (input.secret !== undefined) {
      validateSecret(input.secret);
      if (!this.options.keyRing) throw new WardogsError("disabled");
      target.credentialId = crypto.randomUUID();
      target.envelope = await encryptWardogsRconCredential({
        plaintext: input.secret as PlaintextWardogsRconSecret,
        credentialId: target.credentialId,
        owner: { kind: "wardogs_rcon", guildId: target.guildId, publicId: target.id },
        keyRing: await this.options.keyRing(),
      });
      target.credentialUpdatedAtMs = this.now();
      target.authBlocked = false;
      target.disconnected = false;
    }
    if (input.name !== undefined) target.name = input.name;
    if (input.originRef !== undefined) target.originRef = input.originRef;
    if (input.enabled !== undefined) target.enabled = input.enabled;
    if (input.commerceEnabled !== undefined) target.commerceEnabled = input.commerceEnabled;
    if (input.banCasesEnabled !== undefined) target.banCasesEnabled = input.banCasesEnabled;
    if (input.disconnect) {
      target.enabled = false;
      target.disconnected = true;
      target.credentialId = null;
      target.envelope = null;
      target.credentialUpdatedAtMs = null;
    }
    target.generation++;
    target.verifiedOrigin = null;
    target.verifiedGeneration = null;
    target.verifiedAtMs = null;
    target.updatedAtMs = this.now();
    if (!(await this.options.store.save(target, input.generation)))
      throw new WardogsError("disabled");
    return publicTarget(target);
  }
  async read<K extends ReadOperation>(
    input: {
      guildId: string;
      targetId: string;
      generation: number;
      operation: K;
    },
    guard?: { beforeSend(dispatchByMs: number): Promise<void>; onSend(startedAtMs: number): void },
  ): Promise<ReadResults[K]> {
    return this.performRead(input, false, guard);
  }
  async readPlayerCountStatus(input: {
    guildId: string;
    targetId: string;
    generation: number;
    serverId: string;
  }): Promise<ReadResults["status"]> {
    await this.owned(input.guildId, input.targetId, input.generation);
    // Player Count tests address saved entries. Keep their minute budget across
    // service instances and target changes, separate from setup and other reads.
    if (
      !(await this.options.store.claim(
        `player-count:${input.guildId}:${input.serverId}`,
        crypto.randomUUID(),
        this.now(),
        0,
        60_000,
      ))
    )
      throw new WardogsError("rate_limited");
    return this.read({ ...input, operation: "status" });
  }
  private async performRead<K extends ReadOperation>(
    input: { guildId: string; targetId: string; generation: number; operation: K },
    reverify: boolean,
    guard?: { beforeSend(dispatchByMs: number): Promise<void>; onSend(startedAtMs: number): void },
  ): Promise<ReadResults[K]> {
    return this.performRequest(
      input,
      reverify,
      async (entry, secret, beforeDispatch, dispatchByMs) => {
        await guard?.beforeSend(dispatchByMs);
        // No await may separate the deadline check, start timestamp and transport.
        beforeDispatch();
        guard?.onSend(this.now());
        return readWdrcon({
          origin: entry,
          secret,
          operation: input.operation,
          transport: this.options.transport,
          now: this.now,
        });
      },
    );
  }
  private async performRequest<T>(
    input: { guildId: string; targetId: string; generation: number },
    reverify: boolean,
    dispatch: (
      entry: ApprovedOrigin,
      secret: string,
      beforeDispatch: () => void,
      dispatchByMs: number,
    ) => Promise<T>,
  ): Promise<T> {
    let target = await this.owned(input.guildId, input.targetId, input.generation);
    if (!this.policy.enabled || !target.enabled || target.disconnected)
      throw new WardogsError("disabled");
    const initialEntry = this.policy.origins.find((entry) => entry.id === target.originRef);
    if (
      !initialEntry ||
      !this.policy.approvals.some(
        (approval) =>
          approval.targetId === target.id &&
          approval.generation === target.generation &&
          approval.originRef === target.originRef &&
          approval.origin === approvedOrigin(initialEntry),
      )
    )
      throw new WardogsError("unapproved_target");
    const entry: ApprovedOrigin = initialEntry;
    const origin = approvedOrigin(entry);
    if (target.authBlocked && !reverify)
      throw new WardogsError(
        target.diagnostic === "forbidden" ? "forbidden" : "authentication_failed",
      );
    if (!target.envelope || !target.credentialId || !this.options.keyRing)
      throw new WardogsError("disabled");
    const token = crypto.randomUUID();
    const targetLock = `target:${target.id}`;
    const claimedAtMs = this.now();
    if (
      !(await this.options.store.claim(
        targetLock,
        token,
        this.now(),
        WARDOGS_POLICY.timeoutMs + 1000,
        0,
      ))
    )
      throw new WardogsError("rate_limited");
    if (
      !(await this.options.store.claim(
        origin,
        token,
        this.now(),
        WARDOGS_POLICY.timeoutMs + 1000,
        60_000 / WARDOGS_POLICY.requestsPerMinute,
      ))
    ) {
      await this.options.store.release(targetLock, token, 0);
      throw new WardogsError("rate_limited");
    }
    let cooldown = 0;
    try {
      // Reload after the durable claim: queued work carries only IDs/generation.
      target = await this.owned(input.guildId, input.targetId, input.generation);
      if (!this.policy.enabled || !target.enabled || target.disconnected)
        throw new WardogsError("disabled");
      const currentEntry = this.policy.origins.find(
        (candidate) => candidate.id === target.originRef,
      );
      const currentOrigin = currentEntry ? approvedOrigin(currentEntry) : null;
      if (
        !currentEntry ||
        currentOrigin !== origin ||
        !this.policy.approvals.some(
          (approval) =>
            approval.targetId === target.id &&
            approval.generation === target.generation &&
            approval.originRef === target.originRef &&
            approval.origin === currentOrigin,
        )
      )
        throw new WardogsError("unapproved_target");
      if (target.authBlocked && !reverify)
        throw new WardogsError(
          target.diagnostic === "forbidden" ? "forbidden" : "authentication_failed",
        );
      if (!target.envelope || !target.credentialId || !this.options.keyRing)
        throw new WardogsError("disabled");
      if (reverify) {
        target.verifiedOrigin = null;
        target.verifiedGeneration = null;
        target.verifiedAtMs = null;
      }
      let secret: string;
      try {
        secret = await decryptWardogsRconCredential({
          envelope: target.envelope,
          credentialId: target.credentialId,
          owner: { kind: "wardogs_rcon", guildId: target.guildId, publicId: target.id },
          keyRing: await this.options.keyRing(),
        });
      } catch {
        throw new WardogsError("disabled");
      }
      await this.owned(input.guildId, input.targetId, input.generation);
      const result = await dispatch(
        entry,
        secret,
        () => {
          if (this.now() - claimedAtMs > 1000) throw new WardogsError("timeout");
        },
        claimedAtMs + 1000,
      );
      await this.owned(input.guildId, input.targetId, input.generation);
      target.lastSuccessAtMs = this.now();
      target.diagnostic = null;
      target.authBlocked = false;
      if (!(await this.options.store.save(target, input.generation)))
        throw new WardogsError("disabled");
      return result;
    } catch (error) {
      const safe = error instanceof WardogsError ? error : new WardogsError("provider_unavailable");
      cooldown = safe.retryAtMs ?? 0;
      target.diagnostic = safe.code;
      if (
        [
          "invalid_response",
          "oversized_response",
          "unsupported_operation",
          "authentication_failed",
          "forbidden",
          "unapproved_target",
        ].includes(safe.code)
      ) {
        target.verifiedOrigin = null;
        target.verifiedGeneration = null;
        target.verifiedAtMs = null;
      }
      if (safe.code === "authentication_failed" || safe.code === "forbidden")
        target.authBlocked = true;
      // A late failure belongs to the queried generation, just like a success.
      // A diagnostic CAS miss cannot erase proof that the mutation was never sent.
      if (
        !(await this.options.store.save(target, input.generation)) &&
        !(safe instanceof WardogsPreDispatchError)
      )
        throw new WardogsError("disabled");
      throw safe;
    } finally {
      try {
        await this.options.store.release(origin, token, cooldown);
      } finally {
        await this.options.store.release(targetLock, token, 0);
      }
    }
  }
  async verify(input: { guildId: string; targetId: string; generation: number; roster: boolean }) {
    const capabilities = await this.performRead({ ...input, operation: "capabilities" }, true);
    if (
      !capabilities.routes.includes("status") ||
      (input.roster && !capabilities.routes.includes("roster"))
    )
      throw new WardogsError("unsupported_operation");
    const wait =
      this.options.wait ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    await wait(60_000 / WARDOGS_POLICY.requestsPerMinute);
    await this.read({ ...input, operation: "status" });
    if (input.roster) {
      await wait(60_000 / WARDOGS_POLICY.requestsPerMinute);
      await this.read({ ...input, operation: "roster" });
    }
    const target = await this.owned(input.guildId, input.targetId, input.generation);
    target.verifiedOrigin = approvedOrigin(
      this.policy.origins.find((entry) => entry.id === target.originRef)!,
    );
    target.verifiedGeneration = target.generation;
    target.verifiedAtMs = this.now();
    if (!(await this.options.store.save(target, input.generation)))
      throw new WardogsError("disabled");
    return publicTarget(target);
  }
  async accessReadiness(guildId: string, targetId: string) {
    const state = await this.statusReadiness(guildId, targetId);
    const target = state.target;
    const entry = this.policy.origins.find((e) => e.id === target?.originRef);
    const approval = this.policy.approvals.find(
      (a) =>
        a.targetId === targetId &&
        a.generation === target?.generation &&
        a.originRef === target?.originRef &&
        entry &&
        a.origin === approvedOrigin(entry),
    );
    const contract = approval?.reservedContract;
    const ready = Boolean(
      state.ready &&
      this.options.reservedAccessEnabled &&
      this.options.mutationsEnabled &&
      target?.commerceEnabled &&
      contract?.completeList &&
      contract.evidence.trim() &&
      contract.physicalTargetId.trim() &&
      contract.capacityMeaning === "saleable-entries" &&
      Number.isSafeInteger(contract.entryCapacity) &&
      contract.entryCapacity > 0 &&
      contract.entryCapacity <= 2000,
    );
    return {
      target,
      ready,
      physicalTarget: contract?.physicalTargetId ?? "",
      origin: approval?.origin ?? "",
      capacity: ready ? contract!.entryCapacity : null,
    };
  }
  async accessRequest(
    input: { guildId: string; targetId: string; generation: number },
    request: import("./transport").AccessRequest,
    beforeSend?: () => Promise<void>,
  ) {
    const check = async () => {
      if (
        request.kind === "reserved-mutation" &&
        request.action === "grant" &&
        !this.options.commerceGrantsEnabled
      )
        throw new WardogsError("disabled");
      const state = await this.accessReadiness(input.guildId, input.targetId);
      if (!state.ready || state.target?.generation !== input.generation)
        throw new WardogsError("disabled");
      return state;
    };
    for (let attempt = 0; ; attempt++) {
      let dispatched = false;
      try {
        await check();
        return await this.performRequest(input, false, async (entry, secret, beforeDispatch) => {
          await check();
          await beforeSend?.();
          const state = await check();
          beforeDispatch();
          // Any failure from requestWdrcon or later bookkeeping remains ambiguous.
          dispatched = true;
          return requestWdrcon({
            origin: entry,
            secret,
            request,
            transport: this.options.transport,
            now: this.now,
            reservedAccessEnabled: this.options.reservedAccessEnabled,
            mutationsEnabled: this.options.mutationsEnabled,
            targetOptIn: state.target?.commerceEnabled,
          });
        });
      } catch (error) {
        if (
          request.kind !== "reserved-mutation" &&
          !dispatched &&
          error instanceof WardogsError &&
          error.code === "rate_limited" &&
          attempt === 0
        ) {
          // Paired checkout snapshots may meet the previous read's durable origin budget.
          // Wait once, then claim that same budget again. Upstream responses and mutations
          // are never replayed here; contention/cooldown after the wait still fails closed.
          const wait =
            this.options.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
          await wait(60_000 / WARDOGS_POLICY.requestsPerMinute);
          continue;
        }
        if (request.kind !== "reserved-mutation" || dispatched) throw error;
        throw new WardogsPreDispatchError(
          error instanceof WardogsError ? error.code : "provider_unavailable",
          error instanceof WardogsError ? error.retryAtMs : null,
        );
      }
    }
  }
  async banReadiness(guildId: string, targetId: string, action: "ban" | "unban") {
    const state = await this.statusReadiness(guildId, targetId);
    const target = state.target;
    const entry = this.policy.origins.find((e) => e.id === target?.originRef);
    const approval = this.policy.approvals.find(
      (a) =>
        a.targetId === targetId &&
        a.generation === target?.generation &&
        a.originRef === target?.originRef &&
        entry &&
        a.origin === approvedOrigin(entry),
    );
    const ready = Boolean(
      state.ready &&
      this.options.mutationsEnabled &&
      target?.banCasesEnabled &&
      approval?.banContract?.completeList &&
      approval.banContract.synchronousMutations === true &&
      approval.banContract.evidence.trim() &&
      approval.banContract.physicalTargetId.trim() &&
      approval.banContract[action],
    );
    return {
      target,
      ready,
      physicalTarget: approval?.banContract?.physicalTargetId ?? "",
      // Keep operator endpoint details out of feature records and moderator DTOs.
      approvalIdentity: Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(
              JSON.stringify({
                origin: approval?.origin,
                verifiedAtMs: target?.verifiedAtMs,
                contract: approval?.banContract,
              }),
            ),
          ),
        ),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join(""),
    };
  }
  async banRequest(
    input: { guildId: string; targetId: string; generation: number; action: "ban" | "unban" },
    request: BanRequest,
    beforeSend?: () => Promise<void>,
    assertCurrent?: () => Promise<void>,
  ) {
    if (request.kind === "mutation" && request.action !== input.action)
      throw new WardogsError("unsupported_operation");
    const check = async () => {
      const state = await this.banReadiness(input.guildId, input.targetId, input.action);
      if (!state.ready || state.target?.generation !== input.generation)
        throw new WardogsError("disabled");
      return state;
    };
    await check();
    return this.performRequest(input, false, async (entry, secret, beforeDispatch) => {
      const state = await check();
      try {
        await beforeSend?.();
        await check();
        await assertCurrent?.();
        beforeDispatch();
      } catch (error) {
        if (request.kind !== "mutation") throw error;
        throw new WardogsPreDispatchError(
          error instanceof WardogsError ? error.code : "provider_unavailable",
          error instanceof WardogsError ? error.retryAtMs : null,
        );
      }
      return requestWdrcon({
        origin: entry,
        secret,
        request,
        transport: this.options.transport,
        now: this.now,
        mutationsEnabled: this.options.mutationsEnabled,
        targetOptIn: state.target?.banCasesEnabled,
      });
    });
  }
  private async owned(guildId: string, targetId: string, generation: number) {
    const target = await this.options.store.read(guildId, targetId);
    if (!target || target.generation !== generation) throw new WardogsError("disabled");
    return target;
  }
  private validateConfig(name: string, originRef: string | null) {
    if (!name.trim() || name.length > 100) throw new WardogsError("invalid_response");
    if (originRef !== null && !this.policy.origins.some((entry) => entry.id === originRef))
      throw new WardogsError("unapproved_target");
  }
}
