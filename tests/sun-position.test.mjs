import assert from 'node:assert/strict';
import test from 'node:test';
import { copenhagenLocalDateTimeToUtc, solarPosition, sunDirection } from '../js/sun-position.js';

function localPosition(date, time) {
  return solarPosition(copenhagenLocalDateTimeToUtc(date, time));
}

test('NOAA solar position matches the Copenhagen autumn and summer references', () => {
  const autumnNoon = localPosition('2026-10-26', '11:53');
  assert.ok(Math.abs(autumnNoon.elevation - 21.8) < 0.3, `elevation was ${autumnNoon.elevation.toFixed(3)}°`);
  assert.ok(Math.abs(autumnNoon.azimuth - 180) < 1, `azimuth was ${autumnNoon.azimuth.toFixed(3)}°`);

  const summerNoon = localPosition('2026-06-21', '13:15');
  assert.ok(Math.abs(summerNoon.elevation - 57.8) < 0.3, `elevation was ${summerNoon.elevation.toFixed(3)}°`);

  const autumnSunset = localPosition('2026-10-26', '16:44');
  assert.ok(autumnSunset.elevation < 0, `sunset elevation was ${autumnSunset.elevation.toFixed(3)}°`);
  assert.ok(autumnSunset.elevation > -1, 'the apparent sun reaches the horizon near the published sunset');
});

test('October daytime presets point into the south half of the scene and blue hour is below the horizon', () => {
  const goldenInstant = copenhagenLocalDateTimeToUtc('2026-10-26', '16:10');
  const middayInstant = copenhagenLocalDateTimeToUtc('2026-10-26', '12:00');
  const golden = sunDirection(goldenInstant);
  const midday = sunDirection(middayInstant);
  const blueHourPosition = localPosition('2026-10-26', '17:20');
  const blueHour = sunDirection(copenhagenLocalDateTimeToUtc('2026-10-26', '17:20'));

  assert.ok(golden.z > 0, 'golden-hour sunlight comes from the south-west');
  assert.ok(midday.z > 0, 'midday sunlight comes from the south');
  const actualGridAzimuth = Math.atan2(midday.x, -midday.z) * 180 / Math.PI;
  const expectedGridAzimuth = solarPosition(middayInstant).azimuth - 2.9;
  assert.ok(Math.abs(actualGridAzimuth - expectedGridAzimuth) < 1e-9, 'the vector uses the 2.9° grid correction');
  assert.ok(blueHourPosition.elevation < 0, 'blue hour has no direct sun');
  assert.ok(blueHour.y < 0, 'the blue-hour sun vector is below the horizon');
  for (const direction of [golden, midday, blueHour]) {
    const length = Math.hypot(direction.x, direction.y, direction.z);
    assert.ok(Math.abs(length - 1) < 1e-12, `direction length was ${length}`);
  }
});

test('Copenhagen local clock conversion follows CET and CEST independent of the host zone', () => {
  assert.equal(copenhagenLocalDateTimeToUtc('2026-01-15', '12:00').toISOString(), '2026-01-15T11:00:00.000Z');
  assert.equal(copenhagenLocalDateTimeToUtc('2026-07-15', '12:00').toISOString(), '2026-07-15T10:00:00.000Z');
});

test('Copenhagen daylight-saving transitions resolve gaps and repeated times consistently', () => {
  // The nonexistent 02:30 spring time moves forward by the one-hour DST gap.
  assert.equal(copenhagenLocalDateTimeToUtc('2026-03-29', '02:30').toISOString(), '2026-03-29T01:30:00.000Z');
  // The repeated 02:30 autumn time selects its first (CEST) occurrence.
  assert.equal(copenhagenLocalDateTimeToUtc('2026-10-25', '02:30').toISOString(), '2026-10-25T00:30:00.000Z');
});

test('Copenhagen local clock parser rejects malformed values', () => {
  assert.throws(() => copenhagenLocalDateTimeToUtc('2026-02-30', '12:00'), RangeError);
  assert.throws(() => copenhagenLocalDateTimeToUtc('2026-10-26', '24:00'), RangeError);
  assert.throws(() => copenhagenLocalDateTimeToUtc('26-10-2026', '12:00'), RangeError);
});
