import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quickParse } from './quickParse.ts';

const TODAY = '2026-09-18'; // Friday

test('time + duration in russian', () => {
  const r = quickParse('14:30 звонок Ивану 45м', TODAY);
  assert.equal(r.title, 'звонок Ивану');
  assert.equal(r.startMin, 14 * 60 + 30);
  assert.equal(r.durationMin, 45);
  assert.equal(r.endMin, 14 * 60 + 30 + 45);
  assert.equal(r.date, null);
});

test('tomorrow with hour only and hours duration', () => {
  const r = quickParse('завтра в 9 спорт 1ч', TODAY);
  assert.equal(r.title, 'спорт');
  assert.equal(r.date, '2026-09-19');
  assert.equal(r.startMin, 9 * 60);
  assert.equal(r.durationMin, 60);
});

test('weekday, range, category and priority', () => {
  const r = quickParse('пн 10:00-11:30 планёрка #работа !!', TODAY);
  assert.equal(r.title, 'планёрка');
  assert.equal(r.date, '2026-09-21');
  assert.equal(r.startMin, 600);
  assert.equal(r.endMin, 690);
  assert.equal(r.categoryName, 'работа');
  assert.equal(r.priority, 2);
});

test('english am/pm', () => {
  const r = quickParse('tomorrow 2pm call with Anna 30m', TODAY);
  assert.equal(r.title, 'call with Anna');
  assert.equal(r.date, '2026-09-19');
  assert.equal(r.startMin, 14 * 60);
  assert.equal(r.durationMin, 30);
});

test('untimed task keeps the title intact', () => {
  const r = quickParse('Купить билеты', TODAY);
  assert.equal(r.title, 'Купить билеты');
  assert.equal(r.startMin, null);
  assert.equal(r.durationMin, null);
});

test('hours with minutes duration', () => {
  const r = quickParse('Чтение 1ч 30м', TODAY);
  assert.equal(r.title, 'Чтение');
  assert.equal(r.durationMin, 90);
});

test('explicit date dd.mm.yyyy', () => {
  const r = quickParse('25.12.2026 Рождество', TODAY);
  assert.equal(r.date, '2026-12-25');
  assert.equal(r.title, 'Рождество');
});

test('english "at 2pm" consumes the preposition', () => {
  const r = quickParse('call at 2pm', TODAY);
  assert.equal(r.title, 'call');
  assert.equal(r.startMin, 14 * 60);
});

test('decimal hours are a duration, not a date', () => {
  const r = quickParse('1.5 h reading', TODAY);
  assert.equal(r.date, null);
  assert.equal(r.durationMin, 90);
  assert.equal(r.title, 'reading');
});

test('invalid calendar dates are ignored', () => {
  const r = quickParse('31.04 отчёт', TODAY);
  assert.equal(r.date, null);
});

test('leading-zero month reads as a date, dotted hour as a time', () => {
  assert.equal(quickParse('12.05 день рождения', TODAY).date, '2026-05-12');
  const t = quickParse('9.30 созвон', TODAY);
  assert.equal(t.date, null);
  assert.equal(t.startMin, 9 * 60 + 30);
});

test('quantity ranges are not time ranges', () => {
  const r = quickParse('сделать 2-3 звонка', TODAY);
  assert.equal(r.startMin, null);
  assert.equal(r.title, 'сделать 2-3 звонка');
  const q = quickParse('перерыв на 10-15 минут', TODAY);
  assert.equal(q.startMin, null);
});

test('trailing punctuation after a time still parses', () => {
  const r = quickParse('созвон в 15:00.', TODAY);
  assert.equal(r.startMin, 15 * 60);
  assert.equal(r.title, 'созвон');
  const c = quickParse('встреча в 14:30, потом обед', TODAY);
  assert.equal(c.startMin, 14 * 60 + 30);
  assert.equal(c.title, 'встреча потом обед');
});

test('short weekday aliases need a preposition', () => {
  assert.equal(quickParse('buy sun cream', TODAY).date, null);
  assert.equal(quickParse('on sat nav update', TODAY).date, '2026-09-19');
  assert.equal(quickParse('пн планёрка', TODAY).date, '2026-09-21');
});

test('russian hour qualifiers', () => {
  const r = quickParse('созвон в 2 часа дня', TODAY);
  assert.equal(r.startMin, 14 * 60);
  assert.equal(r.title, 'созвон');
  const e = quickParse('в 9 вечера созвон', TODAY);
  assert.equal(e.startMin, 21 * 60);
  assert.equal(e.title, 'созвон');
});

test('distances in metres are not durations', () => {
  const r = quickParse('плавание 500 м', TODAY);
  assert.equal(r.durationMin, null);
  assert.equal(r.title, 'плавание 500 м');
});

test('duration past midnight is clamped consistently', () => {
  const r = quickParse('23:30 сон 1ч', TODAY);
  assert.equal(r.endMin, 1440);
  assert.equal(r.durationMin, 30);
  assert.equal(r.clamped, true);
});

test('date after a dotted time is still found', () => {
  const r = quickParse('14.30 12.05.2027 звонок', TODAY);
  assert.equal(r.date, '2027-05-12');
  assert.equal(r.startMin, 14 * 60 + 30);
  assert.equal(r.title, 'звонок');
});
