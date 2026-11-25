// Error messages from database drivers can carry a DSN, a user or a password. Everything that is
// logged or stored in etl_db.message goes through here first.
export function sanitizeMessage(msg: string): string {
  return msg
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@")
    .replace(/(password|pwd|secret|token)\s*[=:]\s*\S+/gi, "$1=***")
    .slice(0, 2000);
}

export const errorText = (e: unknown): string => sanitizeMessage(e instanceof Error ? e.message : String(e));
