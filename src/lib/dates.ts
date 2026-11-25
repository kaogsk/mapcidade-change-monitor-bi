// Calendar helpers. Days are ISO strings (YYYY-MM-DD) everywhere: SQLite has no DATE type, and
// string comparison on ISO days is the same as date comparison.

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True when `s` is a real calendar day in YYYY-MM-DD form (rejects 2026-02-30). */
export function isIsoDay(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = ISO_DAY.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.getUTCFullYear() === +m[1]! && d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]!;
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Calendar days from `a` to `b` (b − a). */
export function diffDays(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export function isoWeekday(day: string): number {
  const w = new Date(`${day}T00:00:00Z`).getUTCDay();
  return w === 0 ? 7 : w;
}

/** The calendar day of `instant` in time zone `tz`. */
export function dayIn(tz: string, instant: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(instant);
}

/** Offset (ms) of `tz` relative to UTC at `instant` (UTC−3 → −10 800 000). */
export function tzOffsetMs(tz: string, instant: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The UTC instant of wall-clock `hh:mm[:ss]` on `day` in `tz`. */
export function zonedTime(day: string, hhmm: string, tz: string): Date {
  const [h = 0, m = 0, s = 0] = hhmm.split(":").map(Number);
  const guess = Date.parse(`${day}T00:00:00Z`) + ((h * 60 + m) * 60 + s) * 1000;
  let t = guess - tzOffsetMs(tz, new Date(guess));
  // second pass settles the rare case where the offset changes between guess and result (DST)
  t = guess - tzOffsetMs(tz, new Date(t));
  return new Date(t);
}

/** Text → ISO day without throwing: accepts YYYY-MM-DD… and DD/MM/YYYY…; anything else is null. */
export function tryDate(t: unknown): string | null {
  if (typeof t !== "string") return null;
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(t);
  if (iso) return isIsoDay(iso[1]) ? iso[1]! : null;
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(t);
  if (dmy) {
    const s = `${dmy[3]}-${dmy[2]!.padStart(2, "0")}-${dmy[1]!.padStart(2, "0")}`;
    return isIsoDay(s) ? s : null;
  }
  return null;
}
