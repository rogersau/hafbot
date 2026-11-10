import { z } from "zod";
import { ObservationError } from "../../server-levels/observations/model";
import type { createAttendanceObservationRuntime } from "../attendance-observation-runtime";
import type { CustomerSession } from "../auth/customer-session";
import { defineRoute, type Route } from "../admin-route-registry";
import { bodyGuildScopedAccess, guildScopedAccess } from "../admin-route-guards";
const scope = z.object({ guildId: z.string().min(1), workspaceId: z.string().min(1).optional() });
export function createAttendanceObservationRoutes(options: {
  attendanceObservations?: ReturnType<typeof createAttendanceObservationRuntime>;
  readCustomerAdminSession?: (request: Request) => Promise<CustomerSession | null>;
  authorizeAttendanceObservationAdmin?: (request: Request, guildId: string) => Promise<boolean>;
}): Route<any, any, Response>[] {
  const runtime = options.attendanceObservations;
  if (!runtime) return [];
  async function respond(
    request: Request,
    guildId: string,
    action: (actorId: string) => Promise<unknown>,
  ) {
    try {
      const actorId = (await options.readCustomerAdminSession?.(request))?.user.discordUserId;
      if (!actorId || !(await options.authorizeAttendanceObservationAdmin?.(request, guildId)))
        return Response.json(
          { error: "Current Guild Admin access is required for attendance observations." },
          { status: 403 },
        );
      return Response.json(await action(actorId));
    } catch (error) {
      return Response.json(
        {
          error:
            error instanceof ObservationError
              ? error.message
              : "Observation validation is unavailable. No XP is awarded.",
        },
        { status: 409 },
      );
    }
  }
  return [
    defineRoute({
      method: "GET",
      path: "/admin/api/wardogs/observations/readiness",
      query: scope.extend({ targetId: z.string().uuid() }),
      access: guildScopedAccess("read"),
      handler: ({ request, query }) =>
        respond(request, query.guildId, () =>
          runtime.service.readiness(query.guildId, query.targetId),
        ),
    }),
    defineRoute({
      method: "GET",
      path: "/admin/api/wardogs/observations",
      query: scope,
      access: guildScopedAccess("read"),
      handler: ({ request, query }) =>
        respond(request, query.guildId, async () => ({
          label: "Observation only — no XP",
          runs: (
            await Promise.all(
              (await runtime.store.list(query.guildId)).map(async (r) => ({
                id: r.id,
                targetId: r.targetId,
                generation: r.generation,
                report: await runtime.store.report(r.id),
              })),
            )
          ).filter((run) => run.report !== null),
          retainedReports: await runtime.store.reports(query.guildId),
        })),
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/wardogs/observations/start",
      body: scope
        .extend({
          targetId: z.string().uuid(),
          generation: z.number().int().positive(),
          durationHours: z.number().positive().max(24),
          configuredCapacity: z.number().int().min(1).max(10000).nullable(),
          confirmation: z.literal("OBSERVATION_ONLY_NO_XP"),
          evidence: z.object({
            sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
            serverBuild: z.string().max(100).nullable(),
            hostEvidence: z.enum(["synthetic-fixture", "operator-read-approved"]),
          }),
        })
        .strict(),
      feature: "serverLevels",
      paidOnly: "premium-only-features",
      access: bodyGuildScopedAccess("write"),
      handler: ({ request, body }) =>
        respond(request, body.guildId, async (actorId) => {
          const run = await runtime.service.start({ ...body, actorId });
          return { id: run.id, report: await runtime.store.report(run.id) };
        }),
    }),
    defineRoute({
      method: "POST",
      path: "/admin/api/wardogs/observations/stop",
      body: scope.extend({ id: z.string().uuid() }).strict(),
      access: bodyGuildScopedAccess("write"),
      handler: ({ request, body }) =>
        respond(request, body.guildId, async () => {
          await runtime.service.stop(body.guildId, body.id);
          return { stopped: true };
        }),
    }),
  ];
}
