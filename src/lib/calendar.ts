// Business-day arithmetic, the same rules the control spreadsheet used (Excel WORKDAY):
// Monday–Friday, minus the company's holidays and bridge days (the Register's "Holidays" tab).
import { addDays, isoWeekday } from "./dates.js";

export class BusinessCalendar {
  private holidays: Set<string>;

  constructor(holidays: Iterable<string> = []) {
    this.holidays = new Set(holidays);
  }

  reset(holidays: Iterable<string>): void {
    this.holidays = new Set(holidays);
  }

  isBusinessDay(day: string): boolean {
    return isoWeekday(day) < 6 && !this.holidays.has(day);
  }

  /**
   * Excel WORKDAY(start, n): moves `n` business days from `start`, not counting `start` itself.
   * n = 0 returns `start` even on a weekend; an empty n counts as 0, as in the spreadsheet.
   */
  workdayAdd(start: string | null, n: number | null): string | null {
    if (start == null) return null;
    let left = Math.abs(n ?? 0);
    if (left > 5000) return null;
    const step = (n ?? 0) < 0 ? -1 : 1;
    let d = start;
    while (left > 0) {
      d = addDays(d, step);
      if (this.isBusinessDay(d)) left--;
    }
    return d;
  }

  /** Business days in the closed interval [from, to]; 0 when to < from. */
  businessDays(from: string | null, to: string | null): number {
    if (!from || !to || to < from) return 0;
    let n = 0;
    for (let d = from; d <= to; d = addDays(d, 1)) if (this.isBusinessDay(d)) n++;
    return n;
  }
}
