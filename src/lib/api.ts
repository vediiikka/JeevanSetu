import { HttpError } from "@/lib/auth";

export function ok<T>(data: T, status = 200): Response {
  return Response.json(data as object, { status });
}

export function fail(message: string, status = 400, extra?: Record<string, unknown>): Response {
  return Response.json({ error: message, ...extra }, { status });
}

/** Wraps a route handler with consistent error handling. */
export function route<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response>,
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (error) {
      if (error instanceof HttpError) {
        return fail(error.message, error.status);
      }
      console.error("[api] unhandled error", error);
      const message = error instanceof Error ? error.message : "Unexpected server error";
      return fail(message, 500);
    }
  };
}

export async function readJson<T = Record<string, unknown>>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

export function requireString(value: unknown, field: string, max = 500): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(400, `${field} is required`);
  }
  if (value.length > max) throw new HttpError(400, `${field} is too long`);
  return value.trim();
}

export function optionalString(value: unknown, max = 2000): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new HttpError(400, "Expected a string value");
  if (value.length > max) throw new HttpError(400, "Value is too long");
  return value.trim();
}

export function requireNumber(value: unknown, field: string): number {
  const num = typeof value === "string" ? Number(value) : value;
  if (typeof num !== "number" || !Number.isFinite(num)) {
    throw new HttpError(400, `${field} must be a number`);
  }
  return num;
}

export function requireLat(value: unknown, field = "latitude"): number {
  const num = requireNumber(value, field);
  if (num < -90 || num > 90) throw new HttpError(400, `${field} must be between -90 and 90`);
  return num;
}

export function requireLng(value: unknown, field = "longitude"): number {
  const num = requireNumber(value, field);
  if (num < -180 || num > 180) throw new HttpError(400, `${field} must be between -180 and 180`);
  return num;
}

export function requireEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new HttpError(400, `${field} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}
