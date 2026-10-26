// Pure NOAA-style solar position helpers for Copenhagen's local civil time.
// Azimuth is degrees clockwise from true north; scene vectors use x=east, y=up, z=south.

const COPENHAGEN_TIME_ZONE = 'Europe/Copenhagen';
const DEFAULT_LATITUDE = 55.684;
const DEFAULT_LONGITUDE = 12.564;
const GRID_CONVERGENCE_DEGREES = 2.9;
const DEG = Math.PI / 180;

const copenhagenFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: COPENHAGEN_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
});

function copenhagenParts(timestamp) {
  const parts = Object.fromEntries(copenhagenFormatter.formatToParts(new Date(timestamp))
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, Number(part.value)]));
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second
  };
}

function sameWallTime(a, b) {
  return a.year === b.year && a.month === b.month && a.day === b.day &&
    a.hour === b.hour && a.minute === b.minute && a.second === b.second;
}

function offsetMinutesAt(timestamp) {
  const local = copenhagenParts(timestamp);
  const localAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  return Math.round((localAsUtc - Math.floor(timestamp / 1000) * 1000) / 60000);
}

/**
 * Convert a Copenhagen wall-clock date and time to a UTC Date without using the
 * host machine's time zone. For the autumn repeated hour, use the first (summer)
 * occurrence; for the spring gap, shift forward by the size of the gap.
 */
function copenhagenLocalDateTimeToUtc(dateText, timeText) {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateText));
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(String(timeText));
  if (!dateMatch || !timeMatch) throw new RangeError('Expected Copenhagen date YYYY-MM-DD and time HH:MM');

  const [, yearText, monthText, dayText] = dateMatch;
  const [, hourText, minuteText] = timeMatch;
  const wall = {
    year: Number(yearText),
    month: Number(monthText),
    day: Number(dayText),
    hour: Number(hourText),
    minute: Number(minuteText),
    second: 0
  };
  const wallAsUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const normalized = new Date(wallAsUtc);
  if (normalized.getUTCFullYear() !== wall.year || normalized.getUTCMonth() + 1 !== wall.month ||
      normalized.getUTCDate() !== wall.day || wall.hour > 23 || wall.minute > 59) {
    throw new RangeError('Invalid Copenhagen local date or time');
  }

  // Copenhagen's offset changes only at the DST boundaries. Sampling around
  // the requested wall time finds both offsets even inside a repeated hour.
  const offsets = new Set();
  for (let hours = -48; hours <= 48; hours += 12) {
    offsets.add(offsetMinutesAt(wallAsUtc + hours * 3600000));
  }

  const candidates = [...offsets]
    .map((offset) => wallAsUtc - offset * 60000)
    .filter((timestamp) => sameWallTime(copenhagenParts(timestamp), wall))
    .sort((a, b) => a - b);
  if (candidates.length) return new Date(candidates[0]);

  // A local time in the spring gap maps using the old offset, which lands after
  // the jump (for example, 02:30 becomes 03:30 CEST).
  const beforeTransitionOffset = Math.min(...offsets);
  return new Date(wallAsUtc - beforeTransitionOffset * 60000);
}

function timestampFrom(date) {
  const timestamp = date instanceof Date ? date.getTime() : new Date(date).getTime();
  if (!Number.isFinite(timestamp)) throw new RangeError('Expected a valid date or timestamp');
  return timestamp;
}

/**
 * Return NOAA solar position for a UTC instant. Elevation includes NOAA's
 * atmospheric-refraction correction, so the sun reaches the apparent horizon
 * near the published sunrise and sunset times.
 */
function solarPosition(date, latitude = DEFAULT_LATITUDE, longitude = DEFAULT_LONGITUDE) {
  const timestamp = timestampFrom(date);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    throw new RangeError('Latitude or longitude is outside its valid range');
  }

  const instant = new Date(timestamp);
  const utcMinutes = instant.getUTCHours() * 60 + instant.getUTCMinutes() + instant.getUTCSeconds() / 60;
  const julianDay = timestamp / 86400000 + 2440587.5;
  const julianCentury = (julianDay - 2451545) / 36525;
  const meanLongitude = ((280.46646 + julianCentury * (36000.76983 + julianCentury * 0.0003032)) % 360) * DEG;
  const meanAnomaly = (357.52911 + julianCentury * (35999.05029 - 0.0001537 * julianCentury)) * DEG;
  const eccentricity = 0.016708634 - julianCentury * (0.000042037 + 0.0000001267 * julianCentury);
  const center = Math.sin(meanAnomaly) * (1.914602 - julianCentury * (0.004817 + 0.000014 * julianCentury)) +
    Math.sin(2 * meanAnomaly) * (0.019993 - 0.000101 * julianCentury) +
    Math.sin(3 * meanAnomaly) * 0.000289;
  const trueLongitude = meanLongitude + center * DEG;
  const omega = (125.04 - 1934.136 * julianCentury) * DEG;
  const apparentLongitude = trueLongitude - (0.00569 + 0.00478 * Math.sin(omega)) * DEG;
  const meanObliquity = 23 + (26 + (21.448 - julianCentury * (46.815 + julianCentury * (0.00059 - julianCentury * 0.001813))) / 60) / 60;
  const obliquity = (meanObliquity + 0.00256 * Math.cos(omega)) * DEG;
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(apparentLongitude));
  const y = Math.tan(obliquity / 2) ** 2;
  const equationOfTime = 4 / DEG * (
    y * Math.sin(2 * meanLongitude) - 2 * eccentricity * Math.sin(meanAnomaly) +
    4 * eccentricity * y * Math.sin(meanAnomaly) * Math.cos(2 * meanLongitude) -
    0.5 * y * y * Math.sin(4 * meanLongitude) -
    1.25 * eccentricity * eccentricity * Math.sin(2 * meanAnomaly)
  );

  const trueSolarMinutes = ((utcMinutes + equationOfTime + 4 * longitude) % 1440 + 1440) % 1440;
  const hourAngle = (trueSolarMinutes / 4 - 180) * DEG;
  const latitudeRadians = latitude * DEG;
  const cosZenith = Math.max(-1, Math.min(1,
    Math.sin(latitudeRadians) * Math.sin(declination) +
    Math.cos(latitudeRadians) * Math.cos(declination) * Math.cos(hourAngle)));
  const zenith = Math.acos(cosZenith);
  const geometricElevation = 90 - zenith / DEG;

  const cosAzimuth = Math.max(-1, Math.min(1,
    (Math.sin(latitudeRadians) * Math.cos(zenith) - Math.sin(declination)) /
    Math.max(1e-12, Math.cos(latitudeRadians) * Math.sin(zenith))));
  let azimuth = Math.acos(cosAzimuth) / DEG;
  azimuth = hourAngle > 0 ? 180 + azimuth : 180 - azimuth;
  if (azimuth >= 360) azimuth -= 360;

  let refraction = 0;
  if (geometricElevation > 85) {
    refraction = 0;
  } else if (geometricElevation > 5) {
    const tangent = Math.tan(geometricElevation * DEG);
    refraction = (58.1 / tangent - 0.07 / tangent ** 3 + 0.000086 / tangent ** 5) / 3600;
  } else if (geometricElevation > -0.575) {
    const e = geometricElevation;
    refraction = (1735 + e * (-518.2 + e * (103.4 + e * (-12.79 + e * 0.711)))) / 3600;
  } else {
    refraction = -20.772 / Math.tan(geometricElevation * DEG) / 3600;
  }

  return {
    elevation: geometricElevation + refraction,
    geometricElevation,
    azimuth,
    declination: declination / DEG,
    equationOfTime
  };
}

/** Return a unit vector from the scene origin toward the apparent sun. */
function sunDirection(date, latitude = DEFAULT_LATITUDE, longitude = DEFAULT_LONGITUDE) {
  const { elevation, azimuth } = solarPosition(date, latitude, longitude);
  const elevationRadians = elevation * DEG;
  const gridAzimuthRadians = (azimuth - GRID_CONVERGENCE_DEGREES) * DEG;
  const horizontal = Math.cos(elevationRadians);
  return {
    x: horizontal * Math.sin(gridAzimuthRadians),
    y: Math.sin(elevationRadians),
    z: -horizontal * Math.cos(gridAzimuthRadians)
  };
}

export {
  COPENHAGEN_TIME_ZONE,
  DEFAULT_LATITUDE,
  DEFAULT_LONGITUDE,
  GRID_CONVERGENCE_DEGREES,
  copenhagenLocalDateTimeToUtc,
  solarPosition,
  sunDirection
};
