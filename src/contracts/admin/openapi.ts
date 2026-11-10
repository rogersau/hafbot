import { z } from "zod";
import { adminOperationContracts } from "./index";
import { getCustomerAuthCookieSettings } from "../auth-session-cookie";
import { isRecord } from "../../unknown-parse";

type JsonSchema = Record<string, unknown>;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const correlationHeader = {
  description: "Correlation identifier for support and diagnostics",
  required: true,
  schema: { type: "string" },
};

type AnySchema = z.ZodType;
type ZodDefinition = { type: string; [key: string]: unknown };
type ZodCheckDefinition = {
  check?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  value?: number;
  inclusive?: boolean;
  pattern?: RegExp;
};

function definitionOf(schema: AnySchema): ZodDefinition {
  return schema._zod.def as unknown as ZodDefinition;
}

function checkDefinition(check: unknown): ZodCheckDefinition {
  if (!isRecord(check)) return {};
  const value = check as { _zod?: { def?: unknown }; def?: unknown };
  return (value._zod?.def ?? value.def ?? check) as ZodCheckDefinition;
}

function displayType(typeName: string): string {
  return `Zod${typeName.charAt(0).toUpperCase()}${typeName.slice(1)}`;
}

export function projectZodSchema(schema: AnySchema, location = "schema"): JsonSchema {
  const definition = definitionOf(schema);
  const typeName = definition.type;

  if (typeName === "optional" || typeName === "nullable") {
    const innerType = definition.innerType as AnySchema;
    return typeName === "optional"
      ? projectZodSchema(innerType, location)
      : { anyOf: [projectZodSchema(innerType, location), { type: "null" }] };
  }
  if (typeName === "pipe") {
    return projectZodSchema(definition.in as AnySchema, location);
  }
  if (typeName === "default" || typeName === "catch" || typeName === "readonly") {
    return projectZodSchema(definition.innerType as AnySchema, location);
  }
  if (typeName === "string") {
    const result: JsonSchema = { type: "string" };
    for (const rawCheck of (definition.checks as unknown[] | undefined) ?? []) {
      const check = checkDefinition(rawCheck);
      if (check.check === "custom") continue;
      if (check.check === "min_length") result.minLength = check.minimum;
      else if (check.check === "max_length") result.maxLength = check.maximum;
      else if (check.check === "string_format" && check.format === "regex" && check.pattern) {
        result.pattern = check.pattern.source;
      } else {
        throw new Error(
          `Unsupported Zod string check at ${location}: ${String(check.format ?? check.check)}`,
        );
      }
    }
    return result;
  }
  if (typeName === "number") {
    const result: JsonSchema = { type: "number" };
    for (const rawCheck of (definition.checks as unknown[] | undefined) ?? []) {
      const check = checkDefinition(rawCheck);
      if (check.check === "number_format") {
        if (check.format === "safeint" || check.format === "int") result.type = "integer";
      } else if (check.check === "greater_than") {
        result[check.inclusive === false ? "exclusiveMinimum" : "minimum"] = check.value;
      } else if (check.check === "less_than") {
        result[check.inclusive === false ? "exclusiveMaximum" : "maximum"] = check.value;
      } else {
        throw new Error(`Unsupported Zod number check at ${location}: ${String(check.check)}`);
      }
    }
    return result;
  }
  if (typeName === "boolean") return { type: "boolean" };
  if (typeName === "unknown" || typeName === "any") return {};
  if (typeName === "literal") {
    const values = definition.values as unknown[];
    const value = values[0];
    const literalType = value === null ? "null" : typeof value;
    if (!["string", "number", "boolean", "null"].includes(literalType)) {
      throw new Error(`Unsupported Zod literal at ${location}: ${literalType}`);
    }
    return { type: literalType, const: value };
  }
  if (typeName === "enum") {
    return { type: "string", enum: Object.values(definition.entries as Record<string, unknown>) };
  }
  if (typeName === "array") {
    const result: JsonSchema = {
      type: "array",
      items: projectZodSchema(definition.element as AnySchema, `${location}[]`),
    };
    for (const rawCheck of (definition.checks as unknown[] | undefined) ?? []) {
      const check = checkDefinition(rawCheck);
      if (check.check === "min_length") result.minItems = check.minimum;
      else if (check.check === "max_length") result.maxItems = check.maximum;
      else throw new Error(`Unsupported Zod array check at ${location}: ${String(check.check)}`);
    }
    return result;
  }
  if (typeName === "union") {
    return {
      oneOf: (definition.options as AnySchema[]).map((option, index) =>
        projectZodSchema(option, `${location}.oneOf[${index}]`),
      ),
    };
  }
  if (typeName === "object") {
    const shape = definition.shape as Record<string, AnySchema>;
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const key of Object.keys(shape).sort()) {
      const child = shape[key];
      properties[key] = projectZodSchema(child, `${location}.${key}`);
      if (!child.isOptional()) required.push(key);
    }
    const catchall = definition.catchall as AnySchema | undefined;
    const strict = catchall && definitionOf(catchall).type === "never";
    return {
      type: "object",
      properties,
      ...(required.length === 0 ? {} : { required }),
      ...(strict ? { additionalProperties: false } : {}),
    };
  }

  throw new Error(`Unsupported Zod node at ${location}: ${displayType(typeName)}`);
}

function queryParameters(schema: AnySchema, operationId: string): Record<string, unknown>[] {
  if (definitionOf(schema).type !== "object") {
    throw new Error(`Unsupported query schema at ${operationId}.query: expected ZodObject`);
  }
  const shape = definitionOf(schema).shape as Record<string, AnySchema>;
  return Object.keys(shape)
    .sort()
    .map((name) => ({
      name,
      in: "query",
      required: !shape[name].isOptional(),
      schema: projectZodSchema(shape[name], `${operationId}.query.${name}`),
    }));
}

export function createAdminOpenApiDocument(): Record<string, unknown> {
  const sessionCookie = getCustomerAuthCookieSettings("https://hafbot.xyz").sessionToken;
  const paths: Record<string, Record<string, unknown>> = {};
  for (const contract of [...adminOperationContracts].sort(
    (left, right) => left.path.localeCompare(right.path) || left.method.localeCompare(right.method),
  )) {
    const responses: Record<string, unknown> = {
      [contract.success.status]: {
        description: contract.success.description,
        headers: { "X-Correlation-ID": correlationHeader },
        content: {
          "application/json": {
            schema: projectZodSchema(contract.success.schema, `${contract.operationId}.success`),
          },
        },
      },
    };
    for (const error of [...contract.errors].sort((left, right) => left.status - right.status)) {
      responses[error.status] = {
        description: error.description,
        headers: {
          "X-Correlation-ID": correlationHeader,
          ...([429, 503].includes(error.status)
            ? {
                "Retry-After": {
                  description: "Seconds before the request should be retried, when known",
                  schema: { type: "integer", minimum: 0 },
                },
              }
            : {}),
        },
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/AdminErrorEnvelopeV1" } },
        },
        "x-haf-error-codes": [...error.codes].sort(),
      };
    }

    const operation: Record<string, unknown> = {
      operationId: contract.operationId,
      summary: contract.summary,
      ...(contract.description === undefined ? {} : { description: contract.description }),
      tags: [...contract.tags].sort(),
      security: [{ AdminSessionCookie: [] }],
      ...(contract.query === undefined
        ? {}
        : { parameters: queryParameters(contract.query, contract.operationId) }),
      ...(contract.body === undefined
        ? {}
        : {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: projectZodSchema(contract.body, `${contract.operationId}.body`),
                },
              },
            },
          }),
      responses,
      "x-haf-access": contract.access,
      "x-haf-feature": contract.feature ?? null,
      "x-haf-entitlement": contract.entitlement ?? null,
    };
    (paths[contract.path] ??= {})[contract.method.toLowerCase()] = operation;
  }

  return {
    openapi: "3.1.0",
    info: { title: "HAF Admin API", version: "1.0.0" },
    paths,
    components: {
      securitySchemes: {
        AdminSessionCookie: {
          type: "apiKey",
          in: "cookie",
          name: sessionCookie.name,
          description: "Secure, HttpOnly, SameSite=Lax admin session cookie",
          "x-cookie-security": {
            secure: sessionCookie.attributes.secure,
            httpOnly: sessionCookie.attributes.httpOnly,
            sameSite: sessionCookie.attributes.sameSite,
          },
        },
      },
      schemas: {
        AdminErrorEnvelopeV1: projectZodSchema(
          adminOperationContracts[0].errors[0].schema,
          "components.schemas.AdminErrorEnvelopeV1",
        ),
      },
    },
  };
}

export function serializeAdminOpenApiDocument(): string {
  return `${JSON.stringify(sortJson(createAdminOpenApiDocument() as JsonValue), null, 2)}\n`;
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJson);
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}
