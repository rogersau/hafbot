import type { Env } from "./test-env";
import { createSqliteRuntime } from "./sqlite/runtime/sqlite-runtime";
export default {
  async fetch(request: Request, env: Env, context?: ExecutionContext) {
    return createSqliteRuntime(env, context).fetch(request);
  },
};
