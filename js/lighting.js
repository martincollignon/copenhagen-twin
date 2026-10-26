import * as THREE from 'three/webgpu';
import {
  Fn,
  float,
  vec3,
  vec4,
  uniform,
  mix,
  dot,
  fog,
  pmremTexture,
  positionWorld,
  cameraPosition,
  length,
  normalize,
  max,
  exp,
  abs,
  select
} from 'three/tsl';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { SunLight } from 'three/addons/lights/SunLight.js';
import { SunLightNode } from 'three/addons/lights/SunLightNode.js';
import { cityUniforms } from './tsl-materials.js';
import {
  copenhagenLocalDateTimeToUtc,
  solarPosition,
  sunDirection
} from './sun-position.js';

// js/lighting.js
// Physically-Based Atmospheric Sky (Preetham SkyMesh + Beer-Powder Clouds),
// Live PMREMGenerator IBL Cubemap, Three.js r186 SunLight (2-Cascade CSM),
// and Occlusion-Aware Urban Canyon Global Illumination for Three.js r186 WebGPURenderer

const DEFAULT_SCENE_DATE = '2026-10-26';
const CLEAR_MIDDAY_FOG_MAX_LUMINANCE = 0.48;
const CLEAR_MIDDAY_FOG_SKY_ROUGHNESS = 0.72;
const DEFAULT_FOG_MAX_LUMINANCE = 100.0;
const DEFAULT_FOG_SKY_ROUGHNESS = 0.3;
const FOG_LUMINANCE_WEIGHTS = [0.2126, 0.7152, 0.0722];

function fogAttenuation(opticalDepth) {
  return float(1.0).sub(exp(opticalDepth.negate()));
}

function limitFogRadiance(color, maxLuminance) {
  const weights = vec3(...FOG_LUMINANCE_WEIGHTS);
  const luminance = dot(color, weights);
  return color.mul(maxLuminance.div(max(luminance, maxLuminance)));
}

const TIME_PRESETS = {
  golden: {
    id: 'golden',
    name: 'Golden Hour · 16:10',
    localTime: '16:10',
    sunColor: 0xffca92,
    sunIntensity: 5.8,
    hemiSky: 0xa9c0d7,
    hemiGround: 0xc88a62, // Warm terracotta / limestone upward canyon bounce
    hemiIntensity: 1.62,
    skyTop: 0x91a9c1,
    skyHorizon: 0xe0d7ca,
    fogColor: 0xd5cec3,
    fogDensity: 0.00016,
    interiorGlow: 0.48,
    roadWetness: 0,
    envIntensity: 0.54,
    canyonBounce: 0.52,
    turbidity: 6.5,
    rayleigh: 1.9,
    mieCoefficient: 0.006,
    mieDirectionalG: 0.86,
    cloudCoverage: 0.18,
    cloudDensity: 0.28,
    skyExposure: 0.148,
    nightFactor: 0.0
  },
  midday: {
    id: 'midday',
    name: 'Sunny Midday · 12:00',
    localTime: '12:00',
    sunColor: 0xfff5e8,
    sunIntensity: 6.6,
    hemiSky: 0xb1c9dd,
    hemiGround: 0xb89678, // Warm sunlit masonry & pavement bounce
    hemiIntensity: 1.72,
    skyTop: 0x94b0cc,
    skyHorizon: 0xcbd6df,
    fogColor: 0xcbd4dc,
    fogDensity: 0.00013,
    interiorGlow: 0.24,
    roadWetness: 0,
    envIntensity: 0.58,
    canyonBounce: 0.58,
    turbidity: 5.8,
    rayleigh: 1.8,
    mieCoefficient: 0.005,
    mieDirectionalG: 0.84,
    cloudCoverage: 0.16,
    cloudDensity: 0.26,
    skyExposure: 0.142,
    nightFactor: 0.0
  },
  twilight: {
    id: 'twilight',
    name: 'Blue Hour · 17:20',
    localTime: '17:20',
    sunColor: 0x9bb9ee,
    sunIntensity: 3.1,
    hemiSky: 0x718ab4,
    hemiGround: 0x545a68,
    hemiIntensity: 1.22,
    skyTop: 0x172a48,
    skyHorizon: 0x7187a6,
    fogColor: 0x35465f,
    fogDensity: 0.00032,
    interiorGlow: 1.25,
    roadWetness: 0,
    envIntensity: 0.36,
    canyonBounce: 0.32,
    turbidity: 9.5,
    rayleigh: 3.4,
    mieCoefficient: 0.010,
    mieDirectionalG: 0.90,
    cloudCoverage: 0.20,
    cloudDensity: 0.30,
    skyExposure: 0.115,
    nightFactor: 0.52
  },
  midnight: {
    id: 'midnight',
    name: 'Copenhagen Night · 23:00',
    localTime: '23:00',
    sunColor: 0x8cb0e8,
    sunIntensity: 0,
    hemiSky: 0x263a62,
    hemiGround: 0x382e36,
    hemiIntensity: 0.72,
    skyTop: 0x060c1a,
    skyHorizon: 0x182640,
    fogColor: 0x0c1424,
    fogDensity: 0.00036,
    interiorGlow: 1.55,
    roadWetness: 0,
    envIntensity: 0.30,
    canyonBounce: 0.18,
    turbidity: 4.0,
    rayleigh: 1.5,
    mieCoefficient: 0.004,
    mieDirectionalG: 0.80,
    cloudCoverage: 0.22,
    cloudDensity: 0.25,
    skyExposure: 0.022,
    nightFactor: 0.86
  }
};

function parseLightingQuery(search) {
  const query = new URLSearchParams(search || '');
  let date = null;
  let time = null;
  let wetness = null;

  const requestedDate = query.get('date');
  if (requestedDate) {
    try {
      copenhagenLocalDateTimeToUtc(requestedDate, '12:00');
      date = requestedDate;
    } catch { /* Ignore malformed optional query values. */ }
  }

  const requestedTime = query.get('time');
  if (requestedTime) {
    try {
      copenhagenLocalDateTimeToUtc(DEFAULT_SCENE_DATE, requestedTime);
      time = requestedTime;
    } catch { /* Ignore malformed optional query values. */ }
  }

  const requestedWetness = query.get('wet');
  if (requestedWetness !== null && requestedWetness.trim() !== '') {
    const parsedWetness = Number(requestedWetness);
    if (Number.isFinite(parsedWetness)) wetness = THREE.MathUtils.clamp(parsedWetness, 0, 1);
  }

  return {
    date,
    time,
    skyMode: query.get('sky') === 'overcast' ? 'overcast' : 'clear',
    wetness
  };
}

class LightingSystem {
  constructor(scene, renderer = null) {
    this.scene = scene;
    this.renderer = renderer;
    this.activePresetId = 'golden';
    const search = typeof window === 'undefined' ? '' : window.location.search;
    const overrides = parseLightingQuery(search);
    this.dateOverride = overrides.date;
    this.timeOverride = overrides.time;
    this.skyMode = overrides.skyMode;
    this.wetnessOverride = overrides.wetness;

    // Assign SunLight its node implementation for WebGPURenderer (Light.registerNode since r187; r186 used the library)
    if (SunLight.registerNode) {
      SunLight.registerNode(SunLightNode);
    } else if (renderer && renderer.library) {
      renderer.library.addLight(SunLightNode, SunLight);
    }

    this.scene.fog = new THREE.FogExp2(0xdcc5ae, 0.00024);
    // Leave scene.background = null because SkyMesh renders the 360° sky dome, and setting
    // a THREE.Color on scene.background sets forceClear=true in WebGPURenderer's Background.update,
    // which would otherwise clear Cascade 0 when rendering Cascade 1 in SunShadowNode!
    this.scene.background = null;

    // Physical Preetham SkyMesh + Beer-Powder Clouds (from three/addons/objects/SkyMesh.js). Its unit box must contain
    // the camera wherever it flies over the 1:1 city (it renders at the far plane
    // whatever its size)
    this.sky = new SkyMesh();
    this.sky.scale.setScalar(200000);
    this.sky.turbidity.value = 8.0;
    this.sky.rayleigh.value = 2.8;
    this.sky.mieCoefficient.value = 0.008;
    this.sky.mieDirectionalG.value = 0.88;
    this.sky.cloudScale.value = 0.00018;
    this.sky.cloudSpeed.value = 0.000015;
    this.sky.cloudCoverage.value = 0.36;
    this.sky.cloudDensity.value = 0.38;
    this.sky.cloudElevation.value = 0.52;

    // Calibrate SkyMesh raw radiance (EE=1000 * 0.04) into standard exposure=1.0 HDR range
    this.uSkyExposure = uniform(0.148);
    this.uNightFactor = uniform(0.0);
    this.uNightSkyColor = uniform(new THREE.Color(0x0b1528));
    this.uSkySaturation = uniform(0.72);
    this.uFogMaxLuminance = uniform(DEFAULT_FOG_MAX_LUMINANCE);
    this.uFogSkyRoughness = uniform(DEFAULT_FOG_SKY_ROUGHNESS);
    const rawSkyNode = this.sky.material.colorNode;
    this.sky.material.colorNode = Fn(() => {
      const dayCol = rawSkyNode.rgb.mul(this.uSkyExposure);
      const luminance = dot(dayCol, vec3(0.2126, 0.7152, 0.0722));
      // Mix toward equal-energy grey to pale the physical zenith without changing its luminance.
      const paleDayCol = mix(vec3(luminance), dayCol, this.uSkySaturation);
      const finalSky = mix(paleDayCol, this.uNightSkyColor, this.uNightFactor);
      return vec4(finalSky, float(1.0));
    })();

    // In reversedDepthBuffer mode ([1..0]), camera.far is z = 0.0 (whereas SkyMesh defaults to z = w)
    if (renderer && renderer.reversedDepthBuffer) {
      const rawSkyVertexNode = this.sky.material.vertexNode;
      this.sky.material.vertexNode = Fn(() => {
        const pos = rawSkyVertexNode.toVar();
        pos.z.assign(0.0);
        return pos;
      })();
    }

    this.scene.add(this.sky);

    // Reusable PMREMGenerator & offscreen envScene (mirrors webgpu_generator_city.html)
    this.pmremGenerator = renderer ? new THREE.PMREMGenerator(renderer) : null;
    this.envScene = new THREE.Scene();
    this.envRenderTarget = null;

    // Three.js r186 SunLight with automatic 2-Cascade Shadow Map (SunLightShadow + SunShadowNode)
    // Shines from its position vector toward the origin (no .target needed)
    const initialSun = this.getPresetSun(TIME_PRESETS.golden).direction;
    this.sunLight = new SunLight(0xffca92, 5.8);
    this.sunLight.position.set(initialSun.x, initialSun.y, initialSun.z);
    this.sunLight.castShadow = true;
    // 3072x3072 per cascade = 6144x3072 2-cascade shadow atlas (an 8192x4096 one cost ~20% fps and caused hitches),
    // 2048 where the device allows less. The near cascade spans about 100 m at street level (see update).
    const maxTex = (renderer && renderer.backend && renderer.backend.device && renderer.backend.device.limits.maxTextureDimension2D) || 4096;
    const tile = maxTex >= 6144 ? 3072 : 2048;
    this.sunLight.shadow.mapSize.set(tile, tile);
    this.sunLight.shadow.camera.near = 0.5;
    this.sunLight.shadow.camera.far = 400;
    // Suppress shadow acne along the surface normal in world units
    // so short casters like cars, curbs, tree trunks, and pedestrians keep crisp contact shadows
    this.sunLight.shadow.normalBias = 0.05;
    this.scene.add(this.sunLight);

    // Subtle Hemisphere Sky + Warm Terracotta/Limestone Ground Bounce Fill
    // (Kept intentionally lower than sunLight so urban canyon shadows remain deep and crisp)
    this.hemiLight = new THREE.HemisphereLight(0x9abbe6, 0xc88a62, 1.05);
    this.hemiLight.position.set(0, 300, 0);
    this.scene.add(this.hemiLight);

    this.applyPreset('golden');

    // Sky-matched aerial perspective (replaces the flat FogExp2 colour): distant surfaces fade into a diffuse baked-sky
    // sample just above the horizon through an exponential haze layer, so elevated views stay clearer than the horizon.
    this.uFogDensity = uniform(this.currentFogDensity || TIME_PRESETS.golden.fogDensity);
    this.uFogHeight = uniform(900.0);
    if (this.envRenderTarget) this.scene.fogNode = this.createAerialFogNode();
  }

  getPresetSun(preset) {
    // Date/time query values override solar geometry; the selected preset still owns the lighting mood.
    const date = this.dateOverride || DEFAULT_SCENE_DATE;
    const time = this.timeOverride || preset.localTime;
    const instant = copenhagenLocalDateTimeToUtc(date, time);
    return {
      instant,
      position: solarPosition(instant),
      direction: sunDirection(instant)
    };
  }

  createAerialFogNode() {
    const toFrag = positionWorld.sub(cameraPosition);
    const dist = length(toFrag);
    const dir = toFrag.div(max(dist, 0.001));
    const horizonDir = normalize(vec3(dir.x, max(dir.y, 0.015), dir.z));
    // A rough PMREM sample suppresses the narrow solar lobe before it enters the haze.
    // Clear midday also gets a scene-linear luminance ceiling; uniform scaling preserves sky hue.
    const skyColor = limitFogRadiance(
      pmremTexture(this.envRenderTarget.texture, horizonDir, this.uFogSkyRoughness).rgb,
      this.uFogMaxLuminance
    );
    // Mean haze density exp(-y / H) along the ray between the fragment and the camera
    const H = this.uFogHeight;
    const ya = max(positionWorld.y, 0.0);
    const yb = max(cameraPosition.y, 0.0);
    const dy = yb.sub(ya);
    const ea = exp(ya.div(H).negate());
    const eb = exp(yb.div(H).negate());
    const meanDensity = select(abs(dy).greaterThan(1.0), ea.sub(eb).mul(H).div(dy), ea);
    const tau = this.uFogDensity.mul(dist).mul(meanDensity);
    return fog(skyColor, fogAttenuation(tau));
  }

  bakeEnvironmentMap() {
    if (!this.pmremGenerator) return;
    // Bake physical SkyMesh (without solar disc) into scene.environment for realistic canyon IBL.
    // Reuses a single RenderTarget so texture identity never changes.
    this.sky.showSunDisc.value = 0;
    this.envScene.add(this.sky);
    this.envRenderTarget = this.pmremGenerator.fromScene(this.envScene, 0, 0.1, 100, {
      renderTarget: this.envRenderTarget
    });
    this.scene.environment = this.envRenderTarget.texture;
    this.sky.showSunDisc.value = 1;
    this.scene.add(this.sky);
  }

  applyPreset(presetId, force = false) {
    const p = TIME_PRESETS[presetId] || TIME_PRESETS.golden;
    if (!force && this.activePresetId === p.id && this.envRenderTarget !== null) {
      return;
    }
    this.activePresetId = p.id;

    const sun = this.getPresetSun(p);
    const overcast = this.skyMode === 'overcast';
    const overcastDaylight = overcast && sun.position.elevation > 0;
    const sunVector = new THREE.Vector3(sun.direction.x, sun.direction.y, sun.direction.z);
    const sunFactor = sun.position.elevation > 0 ? (overcast ? 0.4 : 1) : 0;
    const sunIntensity = p.sunIntensity * sunFactor;
    const sunColor = new THREE.Color(p.sunColor).multiplyScalar(sunFactor);
    const hemiSky = overcastDaylight ? 0xc4cdd4 : p.hemiSky;
    const hemiGround = overcastDaylight ? 0x898b88 : p.hemiGround;
    const hemiIntensity = overcastDaylight ? Math.max(1.9, p.hemiIntensity * 1.3) : p.hemiIntensity;
    const skyTop = overcastDaylight ? 0xaab6bf : p.skyTop;
    const skyHorizon = overcastDaylight ? 0xc9ced1 : p.skyHorizon;
    const fogColor = overcastDaylight ? 0xc0c7ca : p.fogColor;
    const fogDensity = overcast ? 0.0004 : p.fogDensity;
    const cloudCoverage = overcast ? 0.78 : p.cloudCoverage;
    const cloudDensity = overcast ? 0.6 : p.cloudDensity;
    const turbidity = overcastDaylight ? Math.max(8, p.turbidity) : p.turbidity;
    const rayleigh = overcastDaylight ? p.rayleigh * 0.75 : p.rayleigh;
    const clearMidday = p.id === 'midday' && !overcast;
    const mieCoefficient = clearMidday ? 0.0035 : p.mieCoefficient;
    const wetness = this.wetnessOverride ?? (overcast ? 0.35 : p.roadWetness);
    this.currentSunPosition = sun.position;
    this.currentSunDateTime = sun.instant;
    this.currentFogDensity = fogDensity;
    this.uFogMaxLuminance.value = clearMidday ? CLEAR_MIDDAY_FOG_MAX_LUMINANCE : DEFAULT_FOG_MAX_LUMINANCE;
    this.uFogSkyRoughness.value = clearMidday ? CLEAR_MIDDAY_FOG_SKY_ROUGHNESS : DEFAULT_FOG_SKY_ROUGHNESS;

    this.sunLight.color.setHex(p.sunColor);
    this.sunLight.intensity = sunIntensity;
    this.sunLight.position.copy(sunVector);
    this.sunLight.updateMatrixWorld();

    this.hemiLight.color.setHex(hemiSky);
    this.hemiLight.groundColor.setHex(hemiGround);
    this.hemiLight.intensity = hemiIntensity;

    this.scene.fog.color.setHex(fogColor);
    this.scene.fog.density = fogDensity;
    if (this.uFogDensity) this.uFogDensity.value = fogDensity;

    // Update physical Preetham SkyMesh uniforms
    this.sky.turbidity.value = turbidity;
    this.sky.rayleigh.value = rayleigh;
    this.sky.mieCoefficient.value = mieCoefficient;
    this.sky.mieDirectionalG.value = p.mieDirectionalG;
    this.sky.cloudCoverage.value = cloudCoverage;
    this.sky.cloudDensity.value = cloudDensity;
    this.sky.sunPosition.value.copy(sunVector);
    this.uSkyExposure.value = p.skyExposure;
    this.uSkySaturation.value = overcastDaylight ? 0.54 : (p.id === 'twilight' ? 0.58 : (p.nightFactor > 0 ? 0.82 : 0.72));
    this.uNightFactor.value = p.nightFactor;

    cityUniforms.uSunColor.value.copy(sunColor);
    cityUniforms.uSkyTopColor.value.setHex(skyTop);
    cityUniforms.uSkyHorizonColor.value.setHex(skyHorizon);
    cityUniforms.uSkySunDir.value.copy(sunVector);
    cityUniforms.uInteriorGlow.value = p.interiorGlow;
    cityUniforms.uRoadWetness.value = wetness;
    if (cityUniforms.uCanyonBounce) {
      cityUniforms.uCanyonBounce.value = p.canyonBounce;
    }

    this.scene.environmentIntensity = p.envIntensity * (overcastDaylight ? 1.12 : 1);
    this.bakeEnvironmentMap();
  }

  setSkyMode(mode) {
    const skyMode = mode === 'overcast' ? 'overcast' : 'clear';
    if (this.skyMode === skyMode) return;
    this.skyMode = skyMode;
    this.applyPreset(this.activePresetId, true);
  }

  update(focusPos) {
    // SunLightShadow fits and texel-snaps its 2 cascades to the view camera frustum.
    // A 400 m floor reaches long late-October shadows while keeping the near cascade close to its former span.
    const altitude = focusPos && Number.isFinite(focusPos.y) ? Math.max(0, focusPos.y) : 0;
    this.sunLight.shadow.camera.far = Math.max(400, Math.min(1200, 360 + altitude * 1.8));
  }
}

export { LightingSystem, fogAttenuation, limitFogRadiance };
