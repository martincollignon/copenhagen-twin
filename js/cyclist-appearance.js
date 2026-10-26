// Deterministic street-life traits shared by the cyclist renderer and headless acceptance checks.
// Values describe the Copenhagen everyday-bike mix; they do not depend on frame timing or traversal order.

function hashUnit(index, salt) {
  let h = Math.imul((Math.trunc(index) | 0) ^ (salt | 0), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h ^= h >>> 16;
  return (h >>> 0) / 0x1_0000_0000;
}

const HELMET_COLOURS = [0x202226, 0x293541, 0x3b3d3d, 0x394136, 0x6d706d, 0xe1dfd5];
const FRAME_COLOURS = [
  0x16181a, 0x25282b, 0x191b20, 0x25313d, 0x26352c, 0x505e57,
  0x9caeae, 0xb6b3a4, 0xc1bda9, 0xa35d38
];

/** Stable fractional hash in [0, 1). Exported so acceptance tests inspect the same rule as the renderer. */
export { hashUnit as cyclistHash };

/**
 * Appearance for one rider. Cargo types total approximately five percent of the population; the helmet share is forty
 * percent. The salts are independent so helmet use does not correlate with bike type or paint.
 */
export function cyclistAppearance(index) {
  const bikeRoll = hashUnit(index, 0x16a91);
  const helmetRoll = hashUnit(index, 1024);
  const variant = bikeRoll < 0.025 ? 'cargo-longjohn'
    : bikeRoll < 0.05 ? 'cargo-trike'
      : bikeRoll < 0.3 ? 'mens'
        : bikeRoll < 0.5 ? 'city-crate'
          : 'city';
  return {
    variant,
    cargo: variant.startsWith('cargo-'),
    helmet: helmetRoll < 0.4,
    helmetColour: HELMET_COLOURS[Math.floor(hashUnit(index, 0x784b2) * HELMET_COLOURS.length)],
    frameColour: FRAME_COLOURS[Math.floor(hashUnit(index, 0x48c31) * FRAME_COLOURS.length)]
  };
}
