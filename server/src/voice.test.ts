import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, pickVoiceTarget, truncateMessage, voiceKeyboard } from './bot.ts';
import { extFor, ID_RE, voiceKey } from './voice.ts';

const TODAY = '2026-09-19';
const MORNING = 9 * 60;
const EVENING = 20 * 60;

test('an unlabelled voice lands in the section matching the time of day', () => {
  assert.deepEqual(pickVoiceTarget(undefined, TODAY, MORNING), { date: TODAY, section: 'morning' });
  assert.deepEqual(pickVoiceTarget(undefined, TODAY, EVENING), { date: TODAY, section: 'evening' });
  // 15:00 is the cut-off.
  assert.equal(pickVoiceTarget(undefined, TODAY, 15 * 60 - 1).section, 'morning');
  assert.equal(pickVoiceTarget(undefined, TODAY, 15 * 60).section, 'evening');
});

test('caption keywords override the time of day, in both languages', () => {
  assert.equal(pickVoiceTarget('вечерние мысли', TODAY, MORNING).section, 'evening');
  assert.equal(pickVoiceTarget('morning thoughts', TODAY, EVENING).section, 'morning');
  assert.equal(pickVoiceTarget('УТРО', TODAY, EVENING).section, 'morning');
});

test('"вчера" moves the note to the previous day and defaults to its evening', () => {
  assert.deepEqual(pickVoiceTarget('вчера', TODAY, MORNING), { date: '2026-09-18', section: 'evening' });
  assert.deepEqual(pickVoiceTarget('yesterday', TODAY, EVENING), { date: '2026-09-18', section: 'evening' });
  // An explicit morning keyword still wins for yesterday.
  assert.deepEqual(pickVoiceTarget('вчера утром', TODAY, EVENING), { date: '2026-09-18', section: 'morning' });
});

test('correction buttons stay inside Telegram callback-data limits and offer the other section', () => {
  const id = '0f3c2a1e-4b5d-4c6e-8f7a-9b8c7d6e5f4a';
  for (const [note, today] of [
    [{ id, section: 'morning', date: TODAY }, TODAY],
    [{ id, section: 'evening', date: '2026-09-18' }, TODAY],
    [{ id, section: 'evening', date: '2026-09-10' }, TODAY],
  ] as const) {
    const rows = voiceKeyboard(note, today, 'ru').inline_keyboard;
    const buttons = rows.flat();
    assert.ok(buttons.length >= 2, 'at least the section switch and delete');
    for (const b of buttons) {
      const data = (b as { callback_data?: string }).callback_data ?? '';
      assert.ok(data.length > 0 && Buffer.byteLength(data, 'utf8') <= 64, `callback_data too long: ${data}`);
    }
    // The button offers the section the note is NOT in.
    const offered = buttons.map((b) => (b as { callback_data?: string }).callback_data ?? '');
    assert.ok(offered.includes(`v:${id}:${note.section === 'morning' ? 'e' : 'm'}`));
    assert.ok(offered.includes(`v:${id}:d`), 'delete is always offered');
  }
});

test('a note far in the past offers no day shift', () => {
  const id = '0f3c2a1e-4b5d-4c6e-8f7a-9b8c7d6e5f4a';
  const data = voiceKeyboard({ id, section: 'morning', date: '2026-09-10' }, TODAY, 'ru')
    .inline_keyboard.flat()
    .map((b) => (b as { callback_data?: string }).callback_data ?? '');
  assert.ok(!data.includes(`v:${id}:y`) && !data.includes(`v:${id}:t`));
});

test('truncation never leaves an HTML tag half open', () => {
  const long = `<b>${'a'.repeat(4100)}</b>`;
  const cut = truncateMessage(long);
  assert.ok(cut.length <= 4010, 'stays under the Telegram limit');
  assert.ok(cut.endsWith('</b>…'), `expected a closed bold tag, got: ${cut.slice(-12)}`);
  // A cut that lands inside "<cod" must drop the fragment rather than emit broken markup.
  const broken = truncateMessage(`${'x'.repeat(3998)}<code>y</code>`);
  assert.ok(!/<[^>]*$/.test(broken.slice(0, -1)), 'no dangling tag start');
  // Short messages are untouched.
  assert.equal(truncateMessage('<b>hi</b>'), '<b>hi</b>');
});

test('escaping protects the markup and caps the length', () => {
  assert.equal(esc('<b>&</b>'), '&lt;b&gt;&amp;&lt;/b&gt;');
  assert.ok(esc('z'.repeat(500)).length < 260);
});

test('file extensions follow the container, with parameters ignored', () => {
  assert.equal(extFor('audio/mp4;codecs=mp4a.40.2'), 'm4a');
  assert.equal(extFor('audio/x-m4a'), 'm4a');
  assert.equal(extFor('audio/webm;codecs=opus'), 'webm');
  assert.equal(extFor('audio/ogg'), 'ogg');
  assert.equal(extFor('audio/mpeg'), 'mp3');
  assert.equal(extFor('application/octet-stream'), 'bin');
});

test('object keys are scoped per user and ids are strictly validated', () => {
  assert.equal(voiceKey(42, 'abc'), 'voice/42/abc');
  assert.ok(ID_RE.test('0f3c2a1e-4b5d-4c6e-8f7a-9b8c7d6e5f4a'));
  // Anything that could escape the key prefix is refused before it reaches R2.
  for (const bad of ['../../etc', 'voice/1/x', '0f3c2a1e4b5d4c6e8f7a9b8c7d6e5f4a', '']) {
    assert.ok(!ID_RE.test(bad), `should reject: ${bad}`);
  }
});
