import type { AppConfigMutation } from "../admin-types";

export interface AppConfigStore {
  upsertAppConfig(body: AppConfigMutation): Promise<void>;
}
