'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sunTimes } = require('../src/sun');
const av = require('../src/availability');
const { DEFAULT_SETTINGS } = require('../src/db');

const PHX = [33.4484, -112.074];
const local = (d) => d.toLocaleTimeString('en-US', { timeZone: 'America/Phoenix', hour: 'numeric', minute: '2-digit' });
const rules = (over) => Object.assign({}, DEFAULT_SETTINGS.availability, { minNoticeHours: 0 }, over);

test('sunrise and sunset in Phoenix match published times (within a couple of minutes)', () => {
  const minutes = (d) => { const [h, m] = local(d).split(/[: ]/); return (Number(h) % 12 + (local(d).includes('PM') ? 12 : 0)) * 60 + Number(m); };
  const near = (d, hhmm) => { const [h, m] = hhmm.split(':').map(Number); assert.ok(Math.abs(minutes(d) - (h * 60 + m)) <= 2, `${local(d)} vs ${hhmm}`); };
  const summer = sunTimes('2026-06-21', ...PHX); near(summer.sunrise, '5:19'); near(summer.sunset, '19:42');
  const winter = sunTimes('2026-12-21', ...PHX); near(winter.sunrise, '7:29'); near(winter.sunset, '17:24');
});

test('an evening session ends just after sunset, whatever its length', () => {
  const r = rules();
  for (const minutes of [45, 90]) {
    const t = av.periodTimes('2026-11-14', 'evening', minutes, r, ...PHX);
    const sunset = sunTimes('2026-11-14', ...PHX).sunset;
    const after = (t.end - sunset) / 60000;
    assert.ok(after <= r.eveningTailMinutes && after > r.eveningTailMinutes - 5, `ends ${after} min after sunset`);
    assert.equal((t.end - t.start) / 60000, minutes);
    assert.equal(t.start.getUTCMinutes() % 5, 0, 'starts on a 5-minute mark');
  }
});

test('weekdays, blocked dates, notice and the booking window are respected', () => {
  const now = new Date('2026-11-02T15:00:00Z'); // Monday morning in Phoenix
  const days = av.computeDays({ fromYmd: '2026-11-02', days: 14, minutes: 60, now,
    rules: rules({ morning: [6], evening: [5, 6], blockedDates: ['2026-11-14'], minNoticeHours: 48, maxDaysAhead: 30 }) });
  const open = Object.fromEntries(days.map((d) => [d.date, d.slots.map((s) => s.period)]));
  assert.deepEqual(open['2026-11-02'], []); // Monday: nothing offered
  assert.deepEqual(open['2026-11-06'], ['evening']); // Friday
  assert.deepEqual(open['2026-11-07'], ['morning', 'evening']); // Saturday
  assert.deepEqual(open['2026-11-14'], []); // blocked
  const soon = av.computeDays({ fromYmd: '2026-11-02', days: 2, minutes: 60, now, rules: rules({ evening: [0, 1, 2, 3, 4, 5, 6], minNoticeHours: 48 }) });
  assert.ok(soon.every((d) => !d.slots.length), 'nothing inside the notice period');
  const far = av.computeDays({ fromYmd: '2026-12-20', days: 3, minutes: 60, now, rules: rules({ evening: [0, 1, 2, 3, 4, 5, 6], maxDaysAhead: 30 }) });
  assert.ok(far.every((d) => !d.slots.length), 'nothing past the booking window');
});

test('taken times disappear, and a full week offers nothing', () => {
  const now = new Date('2026-11-01T15:00:00Z');
  const base = { fromYmd: '2026-11-09', days: 7, minutes: 60, now, rules: rules({ morning: [], evening: [0, 1, 2, 3, 4, 5, 6], weeklyCap: 3 }) };
  const taken = av.computeDays(Object.assign({}, base, { taken: new Set(['2026-11-10:evening']) }));
  assert.equal(taken.find((d) => d.date === '2026-11-10').slots.length, 0);
  assert.equal(taken.find((d) => d.date === '2026-11-11').slots.length, 1);
  const full = av.computeDays(Object.assign({}, base, { weekCounts: new Map([['2026-11-09', 3]]) }));
  assert.ok(full.every((d) => !d.slots.length));
});

test('weeks start on Monday', () => {
  assert.equal(av.weekKey('2026-11-15'), '2026-11-09'); // Sunday belongs to the week before
  assert.equal(av.weekKey('2026-11-09'), '2026-11-09');
});
