import { eq } from "@/db";
import { db } from "@/db";
import { users } from "@/db/schema";
import { createSession, verifyPassword } from "@/lib/auth";
import { fail, ok, readJson, requireString, route } from "@/lib/api";
import { normalizeLoginName } from "@/lib/loginName";
import { ensureSeeded } from "@/lib/seed";

export const dynamic = "force-dynamic";

export const POST = route(async (request: Request) => {
  await ensureSeeded();
  const body = await readJson(request);
  // Accept an email, a username ("rakesh.patel") or a display name ("Rakesh Patel").
  const identifier = requireString(body.username ?? body.email, "username", 160);
  const email = normalizeLoginName(identifier);
  const password = requireString(body.password, "password", 200);

  const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
  const user = rows[0];
  if (!user) return fail("Invalid username or password. Use your name as username (e.g. rakesh.patel) or your full email.", 401);
  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) return fail("Invalid username or password.", 401);

  // The token is returned too, so the browser can keep the session even when it drops cookies.
  const token = await createSession(user.id, user.role as "admin" | "driver" | "patient");
  return ok({
    user: { id: user.id, name: user.name, email: user.email, role: user.role, phone: user.phone },
    token,
  });
});
