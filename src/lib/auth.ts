import { randomBytes } from "node:crypto";
import { cookies, headers } from "next/headers";
import { and, eq, gt } from "@/db";
import bcrypt from "bcryptjs";
import { db } from "@/db";
import { sessions, users } from "@/db/schema";
import type { Role } from "@/lib/domain";

export const SESSION_COOKIE = "jeevansetu_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;

export type SessionUser = {
  id: number;
  name: string;
  email: string;
  phone: string;
  role: Role;
};

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function createSession(userId: number, role: Role): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({ token, userId, role, expiresAt });
  const headerList = await headers();
  const secure = (headerList.get("x-forwarded-proto") ?? "http").split(",")[0].trim() === "https";
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    // SameSite=None lets the cookie travel when the app is shown inside another site's
    // frame. Browsers only accept it with Secure, so it is used over HTTPS only.
    sameSite: secure ? "none" : "lax",
    secure,
    path: "/",
    expires: expiresAt,
  });
  return token;
}

/**
 * Session tokens presented with this request, in priority order: the
 * `Authorization: Bearer` header first, then the httpOnly cookie. A stale cookie
 * (left over from a previous server run or an expired session) must never hide a
 * valid token sent in the header.
 */
async function sessionTokens(): Promise<string[]> {
  const tokens: string[] = [];
  const authorization = (await headers()).get("authorization") ?? "";
  const bearer = /^Bearer\s+([a-f0-9]{64})$/i.exec(authorization.trim());
  if (bearer) tokens.push(bearer[1].toLowerCase());
  const store = await cookies();
  const cookieToken = store.get(SESSION_COOKIE)?.value;
  if (cookieToken && /^[a-f0-9]{64}$/i.test(cookieToken) && !tokens.includes(cookieToken)) tokens.push(cookieToken);
  return tokens;
}

export async function destroySession(): Promise<void> {
  for (const token of await sessionTokens()) {
    await db.delete(sessions).where(eq(sessions.token, token));
  }
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

export async function getSessionUser(): Promise<SessionUser | null> {
  for (const token of await sessionTokens()) {
    const sessionRows = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.token, token), gt(sessions.expiresAt, new Date())))
      .limit(1);
    const session = sessionRows[0];
    if (!session) continue;
    const userRows = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
    const user = userRows[0];
    if (!user) continue;
    return { id: user.id, name: user.name, email: user.email, phone: user.phone, role: user.role as Role };
  }
  return null;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function requireUser(roles?: Role[]): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new HttpError(401, "Authentication required");
  if (roles && roles.length > 0 && !roles.includes(user.role)) {
    throw new HttpError(403, "You do not have access to this resource");
  }
  return user;
}
