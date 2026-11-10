import * as appSchema from "./app-schema";
import * as authSchema from "./auth-schema";

export * from "./app-schema";
export * from "./auth-schema";

const appSchemaNames = new Set(Object.keys(appSchema));
const authSchemaNames = new Set(Object.keys(authSchema));
const schemaCollisions = [...appSchemaNames].filter((name) => authSchemaNames.has(name));

if (schemaCollisions.length > 0) {
  throw new Error(`Unified schema export collision: ${schemaCollisions.join(", ")}`);
}

export const unifiedSchema = { ...authSchema, ...appSchema } as const;

export const unifiedSchemaCollisions = schemaCollisions as readonly string[];
