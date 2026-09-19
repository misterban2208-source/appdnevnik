import type { Priority } from './types.ts';
import { addDays, toISODate, weekdayOf } from './time.ts';

export interface QuickParseResult {
  title: string;
  date: string | null;
  startMin: number | null;
  endMin: number | null;
  durationMin: number | null;
  categoryName: string | null;
  priority: Priority | null;
}

const WEEKDAYS: Record<string, number> = {
  вс: 0, воскресенье: 0, sun: 0, sunday: 0,
  пн: 1, понедельник: 1, mon: 1, monday: 1,
  вт: 2, вторник: 2, tue: 2, tues: 2, tuesday: 2,
  ср: 3, среда: 3, среду: 3, wed: 3, wednesday: 3,
  чт: 4, четверг: 4, thu: 4, thur: 4, thursday: 4,
  пт: 5, пятница: 5, пятницу: 5, fri: 5, friday: 5,
  сб: 6, суббота: 6, субботу: 6, sat: 6, saturday: 6,
};

const HOUR_UNITS = '(?:часов|часа|час|ч|hours|hour|hrs|hr|h)';
const MIN_UNITS = '(?:минут|мин|м|minutes|mins|min|m)';

const RANGE_RE = /(?:^|\s)(\d{1,2})(?:[:.](\d{2}))?\s*[-–—]\s*(\d{1,2})(?:[:.](\d{2}))?(?=\s|$)/;
const TIME_RE = /(?:^|\s)(?:в|at|@)?\s*(\d{1,2})[:.](\d{2})(?:\s*(am|pm))?(?=\s|$)/i;
const HOUR_ONLY_RE = /(?:^|\s)(?:в|at)\s+(\d{1,2})(?:\s*(am|pm))?(?=\s|$)/i;
const AMPM_RE = /(?:^|\s)(\d{1,2})\s*(am|pm)(?=\s|$)/i;
const DUR_HM_RE = new RegExp(`(?:^|\\s)(\\d+(?:[.,]\\d+)?)\\s*${HOUR_UNITS}(?:\\s*(\\d{1,2})\\s*${MIN_UNITS})?(?=\\s|$)`, 'i');
const DUR_M_RE = new RegExp(`(?:^|\\s)(\\d{1,3})\\s*${MIN_UNITS}(?=\\s|$)`, 'i');
const CAT_RE = /(?:^|\s)#([\p{L}\p{N}_-]+)/u;
const PRIO_RE = /(?:^|\s)(!{1,3})(?=\s|$)/;
const DATE_WORD_RE = /(?:^|\s)(сегодня|завтра|послезавтра|today|tomorrow|tmr)(?=\s|$)/i;
const WEEKDAY_RE = new RegExp(`(?:^|\\s)(?:в|во|on)?\\s*(${Object.keys(WEEKDAYS).join('|')})(?=\\s|$)`, 'i');
const ISO_DATE_RE = /(?:^|\s)(\d{4}-\d{2}-\d{2})(?=\s|$)/;
const DM_DATE_RE = /(?:^|\s)(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?(?=\s|$)/;

function cut(src: string, m: RegExpExecArray): string {
  return (src.slice(0, m.index) + ' ' + src.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim();
}

function to24(h: number, ampm?: string): number {
  if (!ampm) return h;
  const a = ampm.toLowerCase();
  if (a === 'pm' && h < 12) return h + 12;
  if (a === 'am' && h === 12) return 0;
  return h;
}

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
  };

  let m: RegExpExecArray | null;

  if ((m = CAT_RE.exec(s))) {
    res.categoryName = m[1];
    s = ' ' + cut(s, m) + ' ';
  }
  if ((m = PRIO_RE.exec(s))) {
    res.priority = Math.min(3, m[1].length) as Priority;
    s = ' ' + cut(s, m) + ' ';
  }
  if ((m = ISO_DATE_RE.exec(s))) {
    res.date = m[1];
    s = ' ' + cut(s, m) + ' ';
  } else if ((m = DATE_WORD_RE.exec(s))) {
    const w = m[1].toLowerCase();
    res.date =
      w === 'сегодня' || w === 'today'
        ? today
        : w === 'послезавтра'
          ? addDays(today, 2)
          : addDays(today, 1);
    s = ' ' + cut(s, m) + ' ';
  } else if ((m = WEEKDAY_RE.exec(s))) {
    const target = WEEKDAYS[m[1].toLowerCase()];
    const cur = weekdayOf(today);
    let diff = (target - cur + 7) % 7;
    if (diff === 0) diff = 7;
    res.date = addDays(today, diff);
    s = ' ' + cut(s, m) + ' ';
  } else if ((m = DM_DATE_RE.exec(s)) && Number(m[1]) <= 31 && Number(m[2]) <= 12 && !RANGE_RE.test(m[0])) {
    // Only treat "12.05" as a date when it cannot be a time (minutes > 59 or explicit year).
    const d = Number(m[1]);
    const mo = Number(m[2]);
    const hasYear = !!m[3];
    const looksLikeTime = d <= 23 && mo <= 59 && !hasYear && m[0].trim().length <= 5 && /\d\.\d{2}$/.test(m[0].trim());
    if (hasYear || !looksLikeTime) {
      const y = hasYear ? (m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : Number(today.slice(0, 4));
      res.date = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      s = ' ' + cut(s, m) + ' ';
    }
  }

  if ((m = RANGE_RE.exec(s))) {
    const sh = Number(m[1]);
    const sm = Number(m[2] ?? 0);
    const eh = Number(m[3]);
    const em = Number(m[4] ?? 0);
    if (sh < 24 && sm < 60 && eh < 24 && em < 60) {
      res.startMin = sh * 60 + sm;
      res.endMin = eh * 60 + em;
      if (res.endMin <= res.startMin) res.endMin = res.startMin + 60;
      res.durationMin = res.endMin - res.startMin;
      s = ' ' + cut(s, m) + ' ';
    }
  }
  if (res.startMin === null && (m = TIME_RE.exec(s))) {
    const h = to24(Number(m[1]), m[3]);
    const mm = Number(m[2]);
    if (h < 24 && mm < 60) {
      res.startMin = h * 60 + mm;
      s = ' ' + cut(s, m) + ' ';
    }
  }
  if (res.startMin === null && (m = AMPM_RE.exec(s))) {
    const h = to24(Number(m[1]), m[2]);
    if (h < 24) {
      res.startMin = h * 60;
      s = ' ' + cut(s, m) + ' ';
    }
  }
  if (res.startMin === null && (m = HOUR_ONLY_RE.exec(s))) {
    const h = to24(Number(m[1]), m[2]);
    if (h < 24) {
      res.startMin = h * 60;
      s = ' ' + cut(s, m) + ' ';
    }
  }

  if ((m = DUR_HM_RE.exec(s))) {
    const hours = Number(m[1].replace(',', '.'));
    const mins = Number(m[2] ?? 0);
    res.durationMin = Math.round(hours * 60 + mins);
    s = ' ' + cut(s, m) + ' ';
  } else if ((m = DUR_M_RE.exec(s))) {
    res.durationMin = Number(m[1]);
    s = ' ' + cut(s, m) + ' ';
  }

  if (res.startMin !== null && res.endMin === null && res.durationMin !== null) {
    res.endMin = Math.min(1440, res.startMin + res.durationMin);
  }

  res.title = s.replace(/\s+/g, ' ').trim();
  return res;
}
