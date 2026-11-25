// Who may sign in. Production authenticated against the company's directory (LDAP bind with the
// network account); here the same `Authenticator` interface is backed by a JSON file of scrypt
// hashes, so the rest of the auth flow (session cookie, access log, editors list) is unchanged.
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

export interface Identity {
  username: string;
  name: string;
}

export interface Authenticator {
  authenticate(username: string, password: string): Promise<Identity | null>;
}

interface DirectoryUser {
  username: string;
  name: string;
  salt: string;
  hash: string;
}

export function hashPassword(password: string, salt = randomBytes(16).toString("hex")): { salt: string; hash: string } {
  return { salt, hash: scryptSync(password, salt, 32).toString("hex") };
}

export function createDirectory(users: DirectoryUser[]): Authenticator {
  const byName = new Map(users.map((u) => [u.username.toLowerCase(), u]));
  // a fixed dummy hash keeps the timing of "unknown user" close to "wrong password"
  const dummy = hashPassword("x", "0".repeat(32));
  return {
    async authenticate(username, password) {
      const u = byName.get(username.trim().toLowerCase());
      const ref = u ?? { ...dummy, username: "", name: "" };
      const got = scryptSync(password, ref.salt, 32);
      const ok = timingSafeEqual(got, Buffer.from(ref.hash, "hex"));
      return u && ok ? { username: u.username.toLowerCase(), name: u.name } : null;
    },
  };
}

/** Fail-closed: no directory file means the server refuses to start (unless auth is disabled). */
export function loadDirectory(path: string): Authenticator {
  if (!existsSync(path)) throw new Error(`auth: directory file not found (${path}). Run "npm run seed" or set AUTH_DISABLED=1 for local use.`);
  const raw = JSON.parse(readFileSync(path, "utf-8")) as { users?: DirectoryUser[] };
  return createDirectory(raw.users ?? []);
}
