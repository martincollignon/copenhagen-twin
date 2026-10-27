const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const shadowSource = readFileSync(join(__dirname, '..', 'js/sun-shadow.js'), 'utf8');

function loadSunShadow() {
  const setupCalls = [];
  class UpstreamSunShadowNode {
    constructor(light) { this.light = light; }
    setupRenderTarget(shadow, builder) {
      setupCalls.push({ shadow, builder });
      return builder.result;
    }
  }
  class UpstreamSunLightNode {
    constructor(light) { this.light = light; }
    setupShadowNode() { return new UpstreamSunShadowNode(this.light); }
  }

  const api = loadModule(shadowSource, {
    imports: {
      'three/addons/lights/SunShadowNode.js': { SunShadowNode: UpstreamSunShadowNode },
      'three/addons/lights/SunLightNode.js': { SunLightNode: UpstreamSunLightNode }
    },
    filename: 'sun-shadow.js'
  });

  return { ...api, setupCalls, UpstreamSunShadowNode };
}

test('depth-only sun shadow keeps the upstream target and depth resources while dropping color attachments', () => {
  const { DepthOnlySunShadowNode, setupCalls } = loadSunShadow();
  const shadow = { mapSize: { width: 3072, height: 3072 } };
  const colorAttachment = { format: 'rgba16float' };
  const sampler = { minFilter: 'linear', magFilter: 'linear' };
  const depthTexture = {
    width: 6144,
    height: 3072,
    compareFunction: 'less-equal',
    minFilter: 'linear',
    magFilter: 'linear'
  };
  const shadowMap = {
    width: 6144,
    height: 3072,
    textures: [colorAttachment],
    depthTexture,
    sampler
  };
  const colorTextures = shadowMap.textures;
  const result = { shadowMap, depthTexture };
  const builder = { result };
  const node = new DepthOnlySunShadowNode({ type: 'SunLight' });

  const actual = node.setupRenderTarget(shadow, builder);

  assert.strictEqual(actual, result);
  assert.strictEqual(actual.shadowMap, shadowMap);
  assert.strictEqual(shadowMap.textures, colorTextures);
  assert.deepEqual(shadowMap.textures, []);
  assert.strictEqual(actual.depthTexture, depthTexture);
  assert.strictEqual(shadowMap.depthTexture, depthTexture);
  assert.deepEqual([shadowMap.width, shadowMap.height], [6144, 3072]);
  assert.deepEqual([depthTexture.width, depthTexture.height], [6144, 3072]);
  assert.strictEqual(shadowMap.sampler, sampler);
  assert.equal(setupCalls.length, 1);
  assert.strictEqual(setupCalls[0].shadow, shadow);
  assert.strictEqual(setupCalls[0].builder, builder);
});

test('depth-only sun light creates the depth-only shadow node for its light', () => {
  const { DepthOnlySunLightNode, DepthOnlySunShadowNode, UpstreamSunShadowNode } = loadSunShadow();
  const light = { type: 'SunLight', id: 17 };
  const node = new DepthOnlySunLightNode(light);

  const shadowNode = node.setupShadowNode();

  assert.ok(shadowNode instanceof DepthOnlySunShadowNode);
  assert.ok(shadowNode instanceof UpstreamSunShadowNode);
  assert.strictEqual(shadowNode.light, light);
});
