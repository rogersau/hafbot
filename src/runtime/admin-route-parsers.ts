import type { z } from "zod";
import { readBoundedUtf8Body } from "./bounded-request-body";

export interface ParseErrorIssue {
  path: string;
  message: string;
  code: string;
}

export interface ParseError {
  _tag: "ParseError";
  target: "body" | "query";
  message: string;
  issues: ParseErrorIssue[];
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: ParseError };

function issuesFromZod(error: z.ZodError): ParseErrorIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
    code: issue.code,
  }));
}

export async function parseAdminBody<T>(
  request: Request,
  schema: z.ZodType<T>,
  options?: { maxBytes?: number },
): Promise<ParseResult<T>> {
  let raw: unknown;
  try {
    if (options?.maxBytes !== undefined) {
      const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (mediaType !== "application/json") throw new Error("unsupported_media_type");
      const bounded = await readBoundedUtf8Body(request, {
        maxBytes: options.maxBytes,
        canonicalMediaType: "application/json",
      });
      if (!bounded.ok) throw new Error(bounded.reason);
      raw = JSON.parse(bounded.text);
    } else {
      raw = await request.clone().json();
    }
  } catch {
    const message = "Invalid JSON body.";
    return {
      ok: false,
      error: {
        _tag: "ParseError",
        target: "body",
        message,
        issues: [{ path: "", message, code: "invalid_json" }],
      },
    };
  }
  return parseAdminBodyValue(raw, schema);
}

export function parseAdminBodyValue<T>(raw: unknown, schema: z.ZodType<T>): ParseResult<T> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      error: {
        _tag: "ParseError",
        target: "body",
        message: "Invalid request body",
        issues: issuesFromZod(result.error),
      },
    };
  }
  return { ok: true, value: result.data };
}

export function parseAdminQuery<T>(url: URL, schema: z.ZodType<T>): ParseResult<T> {
  const raw: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [key, value] of url.searchParams.entries()) {
    if (seen.has(key)) {
      return {
        ok: false,
        error: {
          _tag: "ParseError",
          target: "query",
          message: "Invalid request query",
          issues: [
            {
              path: key,
              message: "Query parameter must appear only once.",
              code: "duplicate_query_parameter",
            },
          ],
        },
      };
    }
    seen.add(key);
    raw[key] = value;
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      error: {
        _tag: "ParseError",
        target: "query",
        message: "Invalid request query",
        issues: issuesFromZod(result.error),
      },
    };
  }
  return { ok: true, value: result.data };
}

export function parseErrorResponse(error: ParseError): Response {
  return Response.json({ error: error.message, issues: error.issues }, { status: 400 });
}
