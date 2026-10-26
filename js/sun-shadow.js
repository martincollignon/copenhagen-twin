import { SunShadowNode } from 'three/addons/lights/SunShadowNode.js';
import { SunLightNode } from 'three/addons/lights/SunLightNode.js';

export class DepthOnlySunShadowNode extends SunShadowNode {
  setupRenderTarget(shadow, builder) {
    const result = super.setupRenderTarget(shadow, builder);
    // Sun cascades sample only the PCF depth texture, so their unused color attachment can be dropped.
    result.shadowMap.textures.length = 0;
    return result;
  }
}

export class DepthOnlySunLightNode extends SunLightNode {
  setupShadowNode() {
    return new DepthOnlySunShadowNode(this.light);
  }
}
