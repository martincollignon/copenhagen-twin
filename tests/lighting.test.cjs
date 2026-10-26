const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const root = join(__dirname, '..');
const sunSource = readFileSync(join(root, 'js/sun-position.js'), 'utf8');
const lightingSource = readFileSync(join(root, 'js/lighting.js'), 'utf8');

class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.set(x, y, z); }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(vector) { return this.set(vector.x, vector.y, vector.z); }
  normalize() {
    const length = Math.hypot(this.x, this.y, this.z) || 1;
    return this.set(this.x / length, this.y / length, this.z / length);
  }
}

class Color {
  constructor(hex = 0xffffff) { this.setHex(hex); }
  setHex(hex) {
    this.r = ((hex >> 16) & 0xff) / 255;
    this.g = ((hex >> 8) & 0xff) / 255;
    this.b = (hex & 0xff) / 255;
    return this;
  }
  multiplyScalar(scalar) { this.r *= scalar; this.g *= scalar; this.b *= scalar; return this; }
  copy(color) { this.r = color.r; this.g = color.g; this.b = color.b; return this; }
}

function value(initial) { return { value: initial }; }

class NumericNode {
  constructor(value) { this.value = value; }
  sub(other) { return new NumericNode(this.value - numericValue(other)); }
  negate() { return new NumericNode(-this.value); }
  div(other) { return new NumericNode(this.value / numericValue(other)); }
}

function numericValue(value) {
  return value instanceof NumericNode ? value.value : value;
}

function createLighting(search = '') {
  class HemisphereLight {
    constructor(color, groundColor, intensity) {
      this.color = new Color(color);
      this.groundColor = new Color(groundColor);
      this.intensity = intensity;
      this.position = new Vector3();
    }
  }
  const THREE = {
    Vector3,
    Color,
    HemisphereLight,
    MathUtils: { clamp: (number, min, max) => Math.min(max, Math.max(min, number)) },
    FogExp2: class {
      constructor(color, density) { this.color = new Color(color); this.density = density; }
    },
    Scene: class { add() {} }
  };
  class SkyMesh {
    constructor() {
      this.scale = { setScalar() {} };
      this.turbidity = value(0);
      this.rayleigh = value(0);
      this.mieCoefficient = value(0);
      this.mieDirectionalG = value(0);
      this.cloudScale = value(0);
      this.cloudSpeed = value(0);
      this.cloudCoverage = value(0);
      this.cloudDensity = value(0);
      this.cloudElevation = value(0);
      this.sunPosition = value(new Vector3());
      this.showSunDisc = value(1);
      this.material = { colorNode: {}, vertexNode: {} };
    }
  }
  class SunLight {
    constructor(color, intensity) {
      this.color = new Color(color);
      this.intensity = intensity;
      this.position = new Vector3();
      this.shadow = { mapSize: { set() {} }, camera: {}, normalBias: 0 };
    }
    updateMatrixWorld() {}
  }
  const cityUniforms = {
    uSunColor: value(new Color()),
    uSkyTopColor: value(new Color()),
    uSkyHorizonColor: value(new Color()),
    uSkySunDir: value(new Vector3()),
    uInteriorGlow: value(0),
    uRoadWetness: value(0),
    uCanyonBounce: value(0)
  };
  const imports = {
    'three/webgpu': THREE,
    'three/tsl': {
      Fn: () => () => ({}),
      float: (number) => new NumericNode(number),
      vec3: (...components) => components,
      vec4: () => ({}),
      uniform: (initial) => value(initial),
      mix: () => ({}),
      dot: (color, weights) => new NumericNode(
        color.r * weights[0] + color.g * weights[1] + color.b * weights[2]
      ),
      fog: () => ({}),
      pmremTexture: () => ({}),
      positionWorld: {},
      cameraPosition: {},
      length: () => ({}),
      normalize: () => ({}),
      max: (a, b) => new NumericNode(Math.max(numericValue(a), numericValue(b))),
      exp: (node) => new NumericNode(Math.exp(numericValue(node))),
      abs: () => ({}),
      select: () => ({})
    },
    'three/addons/objects/SkyMesh.js': { SkyMesh },
    'three/addons/lights/SunLight.js': { SunLight },
    'three/addons/lights/SunLightNode.js': { SunLightNode: class {} },
    './tsl-materials.js': { cityUniforms }
  };
  const sunPosition = loadModule(sunSource, { filename: 'sun-position.js' });
  imports['./sun-position.js'] = sunPosition;
  const lightingApi = loadModule(lightingSource, {
    imports,
    globals: { window: { location: { search } }, URLSearchParams },
    filename: 'lighting.js'
  });
  const scene = { add() {}, fog: null };
  return { lighting: new lightingApi.LightingSystem(scene), cityUniforms, lightingApi };
}

test('LightingSystem applies the real October preset times and southern sun vectors', () => {
  const { lighting, cityUniforms } = createLighting();
  assert.equal(lighting.activePresetId, 'golden');
  assert.equal(lighting.currentSunDateTime.toISOString(), '2026-10-26T15:10:00.000Z');
  assert.ok(lighting.currentSunPosition.elevation > 0);
  assert.ok(lighting.sunLight.position.z > 0);

  lighting.applyPreset('midday');
  assert.equal(lighting.currentSunDateTime.toISOString(), '2026-10-26T11:00:00.000Z');
  assert.ok(lighting.sunLight.position.z > 0, 'midday sunlight points from the south');

  lighting.applyPreset('twilight');
  assert.equal(lighting.currentSunDateTime.toISOString(), '2026-10-26T16:20:00.000Z');
  assert.ok(lighting.currentSunPosition.elevation < 0);
  assert.equal(lighting.sunLight.intensity, 0);
  assert.deepEqual([cityUniforms.uSunColor.value.r, cityUniforms.uSunColor.value.g, cityUniforms.uSunColor.value.b], [0, 0, 0]);
  assert.deepEqual([
    lighting.sunLight.position.x,
    lighting.sunLight.position.y,
    lighting.sunLight.position.z
  ], [lighting.sky.sunPosition.value.x, lighting.sky.sunPosition.value.y, lighting.sky.sunPosition.value.z]);

  lighting.applyPreset('midnight');
  assert.equal(lighting.currentSunDateTime.toISOString(), '2026-10-26T22:00:00.000Z');
  assert.equal(lighting.sunLight.intensity, 0);
});

test('LightingSystem date and time query overrides use Copenhagen local time', () => {
  const dateOverride = createLighting('?date=2026-06-21');
  assert.equal(dateOverride.lighting.currentSunDateTime.toISOString(), '2026-06-21T14:10:00.000Z');
  dateOverride.lighting.applyPreset('midday');
  assert.equal(dateOverride.lighting.currentSunDateTime.toISOString(), '2026-06-21T10:00:00.000Z');

  const timeOverride = createLighting('?time=13:15');
  assert.equal(timeOverride.lighting.currentSunDateTime.toISOString(), '2026-10-26T12:15:00.000Z');
  assert.equal(timeOverride.lighting.currentSunPosition.elevation > 0, true);
});

test('overcast query applies cloud, sun, hemisphere and wetness settings with wet override support', () => {
  const overcast = createLighting('?sky=overcast');
  assert.equal(overcast.lighting.skyMode, 'overcast');
  assert.equal(overcast.lighting.sky.cloudCoverage.value, 0.78);
  assert.equal(overcast.lighting.sky.cloudDensity.value, 0.6);
  assert.ok(overcast.lighting.sunLight.intensity / 5.8 >= 0.3 && overcast.lighting.sunLight.intensity / 5.8 <= 0.5);
  assert.ok(overcast.lighting.hemiLight.intensity > 1.62);
  assert.equal(overcast.cityUniforms.uRoadWetness.value, 0.35);

  const wetOverride = createLighting('?sky=overcast&wet=0.8&date=2026-06-21&time=12:00');
  assert.equal(wetOverride.cityUniforms.uRoadWetness.value, 0.8);
  assert.equal(wetOverride.lighting.currentSunDateTime.toISOString(), '2026-06-21T10:00:00.000Z');

  const clear = createLighting();
  assert.equal(clear.lighting.skyMode, 'clear');
  assert.equal(clear.lighting.sky.cloudCoverage.value, 0.18);
  assert.equal(clear.cityUniforms.uRoadWetness.value, 0);
});

test('overcast at night preserves the night palette, and time overrides move sun geometry only', () => {
  const overcastNight = createLighting('?sky=overcast');
  overcastNight.lighting.applyPreset('midnight');
  assert.equal(overcastNight.lighting.sunLight.intensity, 0);
  assert.equal(overcastNight.lighting.hemiLight.intensity, 0.72);
  assert.equal(overcastNight.lighting.hemiLight.color.r, new Color(0x263a62).r);

  // The query clock controls sun direction; the selected preset still supplies its fill-light mood.
  const lateSun = createLighting('?time=23:00');
  assert.equal(lateSun.lighting.sunLight.intensity, 0);
  assert.equal(lateSun.lighting.hemiLight.intensity, 1.62);
});

test('clear-midday aerial haze keeps moderate attenuation and caps in-scatter without shifting hue', () => {
  const { lighting, lightingApi } = createLighting();
  lighting.applyPreset('midday');

  assert.equal(lighting.currentFogDensity, 0.00013);
  const oneKilometreVeil = numericValue(
    lightingApi.fogAttenuation(new NumericNode(lighting.currentFogDensity * 1000))
  );
  assert.ok(Math.abs(oneKilometreVeil - 0.1219) < 0.0001, `1 km veil was ${oneKilometreVeil}`);
  assert.equal(lighting.uFogMaxLuminance.value, 0.48);
  assert.equal(lighting.uFogSkyRoughness.value, 0.72);
  assert.equal(lighting.sky.mieCoefficient.value, 0.0035);

  const source = {
    r: 4.0,
    g: 2.5,
    b: 1.25,
    mul(scale) {
      const amount = numericValue(scale);
      return { r: this.r * amount, g: this.g * amount, b: this.b * amount };
    }
  };
  const boundedNode = lightingApi.limitFogRadiance(source, new NumericNode(lighting.uFogMaxLuminance.value));
  const bounded = {
    r: numericValue(boundedNode.r),
    g: numericValue(boundedNode.g),
    b: numericValue(boundedNode.b)
  };
  const luminance = bounded.r * 0.2126 + bounded.g * 0.7152 + bounded.b * 0.0722;
  assert.ok(luminance <= 0.480000001, `fog luminance exceeded limit: ${luminance}`);
  assert.ok(Math.abs(luminance - 0.48) < 1e-10, `expected HDR sample to reach the limit: ${luminance}`);
  assert.ok(Math.abs(bounded.r / source.r - bounded.g / source.g) < 1e-12);
  assert.ok(Math.abs(bounded.g / source.g - bounded.b / source.b) < 1e-12);

  const alreadyPale = { r: 0.3, g: 0.4, b: 0.2, mul(scale) {
    const amount = numericValue(scale);
    return { r: this.r * amount, g: this.g * amount, b: this.b * amount };
  } };
  const paleNode = lightingApi.limitFogRadiance(alreadyPale, new NumericNode(0.48));
  assert.deepEqual({
    r: numericValue(paleNode.r),
    g: numericValue(paleNode.g),
    b: numericValue(paleNode.b)
  }, {
    r: alreadyPale.r,
    g: alreadyPale.g,
    b: alreadyPale.b
  });
});

test('clear-midday haze adjustments leave overcast and other preset fog/sky values intact', () => {
  const overcast = createLighting('?sky=overcast').lighting;
  overcast.applyPreset('midday');
  assert.equal(overcast.currentFogDensity, 0.0004);
  assert.equal(overcast.uFogMaxLuminance.value, 100);
  assert.equal(overcast.uFogSkyRoughness.value, 0.3);
  assert.equal(overcast.sky.mieCoefficient.value, 0.005);
  assert.equal(overcast.sky.cloudCoverage.value, 0.78);

  const clear = createLighting().lighting;
  clear.applyPreset('twilight');
  assert.equal(clear.currentFogDensity, 0.00032);
  assert.equal(clear.uFogMaxLuminance.value, 100);
  assert.equal(clear.uFogSkyRoughness.value, 0.3);
  assert.equal(clear.sky.mieCoefficient.value, 0.01);
  clear.applyPreset('midnight');
  assert.equal(clear.currentFogDensity, 0.00036);
  assert.equal(clear.uFogMaxLuminance.value, 100);
  assert.equal(clear.uFogSkyRoughness.value, 0.3);
  assert.equal(clear.sky.mieCoefficient.value, 0.004);
});
