import type { MessageTemplate } from "../../types";

export interface MessageTemplateStore {
  listByGuild(guildId: string): Promise<MessageTemplate[]>;
  listTicketReplyTemplates(guildId: string): Promise<MessageTemplate[]>;
  readById(guildId: string, id: string): Promise<MessageTemplate | null>;
  countByGuild(guildId: string): Promise<number>;
  upsert(template: MessageTemplate): Promise<void>;
  delete(guildId: string, id: string): Promise<void>;
}
