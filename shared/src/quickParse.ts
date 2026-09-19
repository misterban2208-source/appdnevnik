import type { Priority } from './types.ts';
import { addDays, daysInMonth, toISODate, weekdayOf } from './time.ts';

export interface QuickParseResult {
  title: string;
  date: string | null;
  startMin: number | null;
  endMin: number | null;
  durationMin: number | null;
  categoryName: string | null;
  priority: Priority | null;
  /** Set when the requested duration was cut at midnight. */
  clamped: boolean;
}

const WEEKDAYS_FULL: Record<string, number> = {
  воскресенье: 0, sunday: 0,
  понедельник: 1, monday: 1,
  вторник: 2, tuesday: 2,
  среда: 3, среду: 3, wednesday: 3,
  четверг: 4, thursday: 4,
  пятница: 5, пятницу: 5, friday: 5,
  суббота: 6, субботу: 6, saturday: 6,
};
/** Short forms are only accepted after a preposition or at the very start of the text. */
const WEEKDAYS_SHORT: Record<string, number> = {
  вс: 0, sun: 0, пн: 1, mon: 1, вт: 2, tue: 2, tues: 2, ср: 3, wed: 3, чт: 4, thu: 4, thur: 4, пт: 5, fri: 5, сб: 6, sat: 6,
};

const HOUR_UNITS = '(?:часов|часа|час|ч|hours|hour|hrs|hr|h)';
const MIN_UNITS_LONG = '(?:минут|мин|minutes|mins|min)';
const MIN_UNITS = `(?:${MIN_UNITS_LONG}|м|m)`;
const QUANTITY_UNITS = '(?:минут|мин|min|раз|шт|км|km|м|m|кг|kg|л|l|штук|человек|чел)';
/** Token boundary that tolerates trailing punctuation. */
const END = '(?=[\\s.,;:!?)]|$)';
const PREP = '(?:в|во|at|@|с|from)?';

const RANGE_RE = new RegExp(`(?:^|\\s)(${PREP})\\s*(\\d{1,2})(?:[:.](\\d{2}))?\\s*[-–—]\\s*(\\d{1,2})(?:[:.](\\d{2}))?${END}(?!\\s*${QUANTITY_UNITS}(?:\\s|$))`, 'i');
const TIME_RE = new RegExp(`(?:^|\\s)${PREP}\\s*(\\d{1,2})[:.](\\d{2})(?:\\s*(am|pm))?${END}`, 'i');
const RU_QUAL = '(?:\\s*(?:часов|часа|час|ч))?(?:\\s*(утра|дня|вечера|ночи))?';
const HOUR_ONLY_RE = new RegExp(`(?:^|\\s)(?:в|at)\\s+(\\d{1,2})(?:\\s*(am|pm))?${RU_QUAL}${END}`, 'i');
const AMPM_RE = new RegExp(`(?:^|\\s)${PREP}\\s*(\\d{1,2})\\s*(am|pm)${END}`, 'i');
const DUR_HM_RE = new RegExp(`(?:^|\\s)(\\d+(?:[.,]\\d+)?)\\s*${HOUR_UNITS}(?:\\s*(\\d{1,2})\\s*${MIN_UNITS})?${END}`, 'i');
const DUR_M_LONG_RE = new RegExp(`(?:^|\\s)(\\d{1,3})\\s*${MIN_UNITS_LONG}${END}`, 'i');
const DUR_M_SHORT_RE = new RegExp(`(?:^|\\s)(\\d{1,3})\\s*(?:м|m)${END}`, 'i');
const CAT_RE = /(?:^|\s)#([\p{L}\p{N}_-]+)/u;
const PRIO_RE = /(?:^|\s)(!{1,3})(?=\s|$)/;
const DATE_WORD_RE = /(?:^|\s)(сегодня|завтра|послезавтра|today|tomorrow|tmr)(?=[\s.,;:!?)]|$)/i;
const WEEKDAY_FULL_RE = new RegExp(`(?:^|\\s)(?:в|во|on|next|в\\s+следующ\\w+)?\\s*(${Object.keys(WEEKDAYS_FULL).join('|')})${END}`, 'i');
const WEEKDAY_SHORT_RE = new RegExp(`(?:^\\s*|(?:^|\\s)(?:в|во|on|next)\\s+)(${Object.keys(WEEKDAYS_SHORT).join('|')})(?=[.,;]|\\s|$)`, 'i');
const ISO_DATE_RE = /(?:^|\s)(\d{4})-(\d{2})-(\d{2})(?=[\s.,;:!?)]|$)/;
const DM_DATE_RE = new RegExp(`(?:^|\\s)(\\d{1,2})\\.(\\d{1,2})(?:\\.(\\d{2,4}))?(?=[\\s,;!?)]|$)(?!\\s*${HOUR_UNITS}(?:\\s|$))(?!\\s*${MIN_UNITS}(?:\\s|$))`, 'g');

function cut(src: string, m: RegExpExecArray): string {
  // Also drop punctuation that immediately followed the consumed token.
  const after = src.slice(m.index + m[0].length).replace(/^[.,;:!?)]+/, '');
  return (src.slice(0, m.index) + ' ' + after).replace(/\s+/g, ' ').trim();
}

function to24(h: number, ampm?: string, ruQual?: string): number {
  if (ampm) {
    const a = ampm.toLowerCase();
    if (a === 'pm' && h < 12) return h + 12;
    if (a === 'am' && h === 12) return 0;
    return h;
  }
  if (ruQual) {
    const q = ruQual.toLowerCase();
    if ((q === 'дня' || q === 'вечера') && h < 12) return h + 12;
    if (q === 'ночи' && h === 12) return 0;
    if (q === 'утра' && h === 12) return 0;
  }
  return h;
}

function validDate(y: number, mo: number, d: number): boolean {
  return y >= 2000 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo - 1);
}

function iso(y: number, mo: number, d: number): string {
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Parses free text like "завтра 14:30 звонок Ивану 45м #работа !!".
 * `today` must be the real current date (date words are absolute references).
 */
export function quickParse(input: string, today = toISODate(new Date())): QuickParseResult {
  let s = ' ' + input.trim().replace(/\s+/g, ' ') + ' ';
  const res: QuickParseResult = {
    title: '',
    date: null,
    startMin: null,
    endMin: null,
    durationMin: null,
    categoryName: null,
    priority: null,
    clamped: false,
  };
  const wrap = (x: string) => ' ' + x + ' ';
  let m: RegExpExecArray | null;

  if ((m = CAT_RE.exec(s))) {
    res.categoryName = m[1];
    s = wrap(cut(s, m));
  }
  if ((m = PRIO_RE.exec(s))) {
    res.priority = Math.min(3, m[1].length) as Priority;
    s = wrap(cut(s, m));
  }

  // ---- date ----
  if ((m = ISO_DATE_RE.exec(s))) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (validDate(y, mo, d)) {
      res.date = iso(y, mo, d);
      s = wrap(cut(s, m));
    }
  }
  if (!res.date && (m = DATE_WORD_RE.exec(s))) {
    const w = m[1].toLowerCase();
    res.date = w === 'сегодня' || w === 'today' ? today : w === 'послезавтра' ? addDays(today, 2) : addDays(today, 1);
    s = wrap(cut(s, m));
  }
  if (!res.date) {
    let wd: number | null = null;
    if ((m = WEEKDAY_FULL_RE.exec(s))) wd = WEEKDAYS_FULL[m[1].toLowerCase()];
    else if ((m = WEEKDAY_SHORT_RE.exec(s))) wd = WEEKDAYS_SHORT[m[1].toLowerCase()];
    if (m && wd !== null) {
      const cur = weekdayOf(today);
      let diff = (wd - cur + 7) % 7;
      if (diff === 0) diff = 7;
      res.date = addDays(today, diff);
      s = wrap(cut(s, m));
    }
  }
  if (!res.date) {
    DM_DATE_RE.lastIndex = 0;
    let dm: RegExpExecArray | null;
    while ((dm = DM_DATE_RE.exec(s))) {
      const d = Number(dm[1]);
      const mo = Number(dm[2]);
      const yearRaw = dm[3];
      const hasYear = !!yearRaw;
      // Without a year, "9.30" reads as a time; "12.05" (leading-zero month) or "25.12" reads as a date.
      const looksLikeDate = hasYear || d > 12 || (dm[2].length === 2 && dm[2].startsWith('0'));
      if (!looksLikeDate) continue;
      const y = hasYear ? (yearRaw.length === 2 ? 2000 + Number(yearRaw) : Number(yearRaw)) : Number(today.slice(0, 4));
      if (!validDate(y, mo, d)) continue;
      res.date = iso(y, mo, d);
      s = wrap(cut(s, dm));
      break;
    }
  }

  // ---- time ----
  if ((m = RANGE_RE.exec(s))) {
    const prep = m[1];
    const sh = Number(m[2]);
    const sm = Number(m[3] ?? 0);
    const eh = Number(m[4]);
    const em = Number(m[5] ?? 0);
    // A bare "2-3" is a quantity; treat it as a time range only with minutes, a preposition or plausible hours.
    const plausible = m[3] !== undefined || m[5] !== undefined || !!prep || (sh >= 6 && eh > sh);
    if (plausible && sh < 24 && sm < 60 && eh < 24 && em < 60) {
      res.startMin = sh * 60 + sm;
      res.endMin = eh * 60 + em;
      if (res.endMin <= res.startMin) res.endMin = Math.min(1440, res.startMin + 60);
      res.durationMin = res.endMin - res.startMin;
      s = wrap(cut(s, m));
    }
  }
  if (res.startMin === null && (m = TIME_RE.exec(s))) {
    const h = to24(Number(m[1]), m[3]);
    const mm = Number(m[2]);
    if (h < 24 && mm < 60) {
      res.startMin = h * 60 + mm;
      s = wrap(cut(s, m));
    }
  }
  if (res.startMin === null && (m = AMPM_RE.exec(s))) {
    const h = to24(Number(m[1]), m[2]);
    if (h < 24) {
      res.startMin = h * 60;
      s = wrap(cut(s, m));
    }
  }
  if (res.startMin === null && (m = HOUR_ONLY_RE.exec(s))) {
    const h = to24(Number(m[1]), m[2], m[3]);
    if (h < 24) {
      res.startMin = h * 60;
      s = wrap(cut(s, m));
    }
  }

  // ---- duration ----
  if ((m = DUR_HM_RE.exec(s))) {
    const hours = Number(m[1].replace(',', '.'));
    const mins = Number(m[2] ?? 0);
    const total = Math.round(hours * 60 + mins);
    if (total > 0 && total <= 1440) {
      res.durationMin = total;
      s = wrap(cut(s, m));
    }
  } else if ((m = DUR_M_LONG_RE.exec(s))) {
    res.durationMin = Number(m[1]);
    s = wrap(cut(s, m));
  } else if ((m = DUR_M_SHORT_RE.exec(s)) && Number(m[1]) <= 240) {
    // Bare "м"/"m" above four hours is a distance ("400 м"), not a duration.
    res.durationMin = Number(m[1]);
    s = wrap(cut(s, m));
  }

  if (res.startMin !== null && res.endMin === null && res.durationMin !== null) {
    const wanted = res.startMin + res.durationMin;
    res.endMin = Math.min(1440, wanted);
    if (wanted > 1440) {
      res.clamped = true;
      res.durationMin = res.endMin - res.startMin;
    }
  }

  res.title = s.replace(/\s+/g, ' ').trim();
  return res;
}
