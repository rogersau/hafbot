import type { CustomerSession } from "../auth/customer-session";
import { defineRoute, type Route } from "../admin-route-registry";
import { bodyGuildScopedAccess, guildScopedAccess } from "../admin-route-guards";
import { QuantityLimitError } from "../entitlement-checks";
import type { MessageTemplateService } from "../../services/message-template-service";
import { ManagedMessageError } from "../../services/managed-message-service";
import { adminErrorEnvelopeSchema, messageTemplateContracts } from "../../contracts/admin";

export function createMessageTemplateAdminRoutes(options: {
  service: MessageTemplateService;
  readCustomerAdminSession?: (request: Request) => Promise<CustomerSession | null>;
}): Array<Route<any, any, Response>> {
  return [
    defineRoute({
      ...messageTemplateContracts.list,
      feature: undefined,
      success: messageTemplateContracts.list.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: guildScopedAccess("read"),
      handler: async ({ query }) =>
        Response.json({
          guildId: query.guildId,
          templates: await options.service.list(query.guildId),
        }),
    }),
    defineRoute({
      ...messageTemplateContracts.save,
      feature: undefined,
      success: messageTemplateContracts.save.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body, request }) => {
        try {
          const actorUserId = await readActorUserId(options.readCustomerAdminSession, request);
          const template =
            body.action === "duplicate"
              ? await options.service.duplicate(
                  body.guildId,
                  body.id ?? "",
                  body.internalName,
                  actorUserId,
                )
              : await options.service.save(
                  {
                    guildId: body.guildId,
                    id: body.id,
                    internalName: body.internalName,
                    embeds: body.embeds ?? [],
                    availableForTicketReplies: body.availableForTicketReplies === true,
                  },
                  actorUserId,
                );
          return Response.json({ template });
        } catch (error) {
          if (error instanceof QuantityLimitError || error instanceof ManagedMessageError) {
            return Response.json(
              { error: error.message },
              {
                status: error instanceof ManagedMessageError ? error.status : 400,
              },
            );
          }
          throw error;
        }
      },
    }),
    defineRoute({
      ...messageTemplateContracts.delete,
      feature: undefined,
      success: messageTemplateContracts.delete.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: bodyGuildScopedAccess("write"),
      handler: async ({ body, request }) => {
        const actorUserId = await readActorUserId(options.readCustomerAdminSession, request);
        return Response.json({
          ok: true,
          deleted: await options.service.delete(body.guildId, body.id, actorUserId),
        });
      },
    }),
  ];
}

async function readActorUserId(
  reader: ((request: Request) => Promise<CustomerSession | null>) | undefined,
  request: Request,
): Promise<string> {
  const session = await reader?.(request);
  return session?.user.id ?? "admin-ui";
}
