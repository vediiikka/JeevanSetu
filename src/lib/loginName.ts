/**
 * Login identifiers. Drivers sign in with the name-based username that is shown in
 * the console (for example `rakesh.patel` or `Rakesh Patel`), and the full address
 * (`rakesh.patel@jeevansetu.in`) also works. Pure module: safe for client and server.
 */
export const LOGIN_DOMAIN = "jeevansetu.in";

/** "Rakesh Patel" -> "rakesh.patel" (also used to build driver logins). */
export function slugName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.|\.$/g, "");
}

/** Accepts an email, a username or a display name and returns the account email. */
export function normalizeLoginName(input: string): string {
  const value = input.trim().toLowerCase();
  if (!value) return "";
  if (value.includes("@")) return value;
  const slug = slugName(value);
  return slug ? `${slug}@${LOGIN_DOMAIN}` : value;
}
