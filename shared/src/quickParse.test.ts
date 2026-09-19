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
