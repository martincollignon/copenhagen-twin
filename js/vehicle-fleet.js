export const BODY_MIX = Object.freeze({ crossoverEV: 0.40, hatch: 0.30, estate: 0.18, van: 0.08, taxi: 0.04 });
export const PARKED_BODY_MIX = Object.freeze({ crossoverEV: 0.94 * 40 / 88, hatch: 0.94 * 30 / 88, estate: 0.94 * 18 / 88, van: 0.06 });
export const CAR_BODY_TYPES = Object.freeze(['crossoverEV', 'hatch', 'estate', 'van']);
export const CAR_PALETTE = Object.freeze([
  { name: 'grey', weight: 0.26, colors: [0x555a60, 0x777d81, 0x929696] },
  { name: 'white', weight: 0.25, colors: [0xeeefeb] },
  { name: 'black', weight: 0.22, colors: [0x171a1d] },
  { name: 'silver', weight: 0.10, colors: [0xbfc3c6] },
  { name: 'blue', weight: 0.10, colors: [0x22354c, 0x395b77] },
  { name: 'red', weight: 0.04, colors: [0x922e35] },
  { name: 'other', weight: 0.03, colors: [0x3f5148, 0xb2a996, 0x592d37] }
].map((entry) => Object.freeze({ ...entry, colors: Object.freeze(entry.colors) })));

export function fleetRandom(index, salt = 0) {
  let n = Math.imul(index + 1, 0x45d9f3b) ^ Math.imul(salt + 1, 0x27d4eb2d);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

export function sampleBody(value, parked = false) {
  const weights = parked ? PARKED_BODY_MIX : BODY_MIX;
  let end = 0;
  for (const [name, weight] of Object.entries(weights)) {
    end += weight;
    if (value < end) return name;
  }
  return parked ? 'van' : 'taxi';
}

export function samplePaint(value) {
  let start = 0;
  for (const entry of CAR_PALETTE) {
    if (value < start + entry.weight) {
      const variant = Math.min(entry.colors.length - 1, Math.floor(Math.max(0, value - start) / entry.weight * entry.colors.length));
      return entry.colors[variant];
    }
    start += entry.weight;
  }
  return CAR_PALETTE.at(-1).colors.at(-1);
}

export function fleetVehicle(bodyRoll, paintRoll, variantRoll, parked = false) {
  const kind = sampleBody(bodyRoll, parked);
  const taxi = kind === 'taxi';
  const body = taxi ? (variantRoll < 0.5 ? 'estate' : 'crossoverEV') : kind;
  return { body, taxi, paint: body === 'van' ? CAR_PALETTE[1].colors[0] : samplePaint(paintRoll) };
}

export const CAR_PLATE = Object.freeze({ width: 0.52, height: 0.11, textureWidth: 520, rowHeight: 110, variants: 8 });

export function plateRegistration(variant) {
  const letters = 'ABCDEFGHJKLMNPRSTUVXYZ';
  const a = letters[Math.floor(fleetRandom(variant, 11) * letters.length)];
  const b = letters[Math.floor(fleetRandom(variant, 12) * letters.length)];
  const digits = String(10000 + Math.floor(fleetRandom(variant, 13) * 90000));
  return `${a}${b} ${digits.slice(0, 2)} ${digits.slice(2)}`;
}
