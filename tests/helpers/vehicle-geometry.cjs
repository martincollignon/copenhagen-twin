// Buffer/primitive doubles for the dependency-free Node suite. Loft sections and vehicle builders run unchanged.
class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.set(x, y, z); }
  set(x, y, z) { Object.assign(this, { x, y, z }); return this; }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  subVectors(a, b) { return this.set(a.x - b.x, a.y - b.y, a.z - b.z); }
  divideScalar(s) { this.x /= s; this.y /= s; this.z /= s; return this; }
  normalize() { return this.divideScalar(Math.hypot(this.x, this.y, this.z) || 1); }
  negate() { return this.divideScalar(-1); }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
  crossVectors(a, b) { return this.set(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x); }
}
class Vector2 {
  constructor(x = 0, y = 0) { this.x = x; this.y = y; }
  min(v) { this.x = Math.min(this.x, v.x); this.y = Math.min(this.y, v.y); return this; }
  max(v) { this.x = Math.max(this.x, v.x); this.y = Math.max(this.y, v.y); return this; }
}
class BufferAttribute {
  constructor(array, itemSize) { this.array = new Float32Array(array); this.itemSize = itemSize; this.count = array.length / itemSize; }
  getX(i) { return this.array[i * this.itemSize]; }
  getY(i) { return this.array[i * this.itemSize + 1]; }
  getZ(i) { return this.array[i * this.itemSize + 2]; }
  setX(i, x) { this.array[i * this.itemSize] = x; }
  setZ(i, z) { this.array[i * this.itemSize + 2] = z; }
  setXYZ(i, x, y, z) { this.array.set([x, y, z], i * this.itemSize); }
}
class BufferGeometry {
  constructor() { this.attributes = {}; }
  setAttribute(k, a) { this.attributes[k] = a; return this; }
  getAttribute(k) { return this.attributes[k]; }
  setIndex(a) { this.index = a.array ? a : new BufferAttribute(a, 1); return this; }
  computeVertexNormals() {
    const p = this.attributes.position, n = new Float32Array(p.count * 3);
    for (let i = 0; i < this.index.count; i += 3) {
      const [a, b, c] = this.index.array.slice(i, i + 3);
      const u = new Vector3(p.getX(b) - p.getX(a), p.getY(b) - p.getY(a), p.getZ(b) - p.getZ(a));
      const v = new Vector3(p.getX(c) - p.getX(a), p.getY(c) - p.getY(a), p.getZ(c) - p.getZ(a));
      const normal = new Vector3().crossVectors(u, v).normalize();
      for (const j of [a, b, c]) { n[j * 3] += normal.x; n[j * 3 + 1] += normal.y; n[j * 3 + 2] += normal.z; }
    }
    for (let i = 0; i < n.length; i += 3) {
      const d = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
      n[i] /= d; n[i + 1] /= d; n[i + 2] /= d;
    }
    return this.setAttribute('normal', new BufferAttribute(n, 3));
  }
  transform(fn) {
    const p = this.attributes.position;
    for (let i = 0; i < p.count; i++) p.setXYZ(i, ...fn(p.getX(i), p.getY(i), p.getZ(i)));
    return this;
  }
  translate(x, y, z) { return this.transform((a, b, c) => [a + x, b + y, c + z]); }
  rotateX(t) { return this.transform((x, y, z) => [x, y * Math.cos(t) - z * Math.sin(t), y * Math.sin(t) + z * Math.cos(t)]); }
  rotateY(t) { return this.transform((x, y, z) => [x * Math.cos(t) + z * Math.sin(t), y, -x * Math.sin(t) + z * Math.cos(t)]); }
  rotateZ(t) { return this.transform((x, y, z) => [x * Math.cos(t) - y * Math.sin(t), x * Math.sin(t) + y * Math.cos(t), z]); }
}
class BoxGeometry extends BufferGeometry {
  constructor(w, h, d) {
    super();
    const p = [];
    for (const z of [-d / 2, d / 2]) for (const y of [-h / 2, h / 2]) for (const x of [-w / 2, w / 2]) p.push(x, y, z);
    this.setAttribute('position', new BufferAttribute(p, 3));
    this.setAttribute('uv', new BufferAttribute(new Float32Array(16), 2));
    this.setIndex([0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5]);
    this.computeVertexNormals();
  }
}
class CircleGeometry extends BufferGeometry {
  constructor(r, segments = 16, start = 0, span = Math.PI * 2) {
    super();
    const p = [0, 0, 0], ix = [];
    for (let i = 0; i <= segments; i++) {
      const t = start + span * i / segments;
      p.push(r * Math.cos(t), r * Math.sin(t), 0);
      if (i > 0) ix.push(0, i, i + 1);
    }
    this.setAttribute('position', new BufferAttribute(p, 3)).setIndex(ix);
    this.setAttribute('uv', new BufferAttribute(new Float32Array(p.length / 3 * 2), 2));
    this.computeVertexNormals();
  }
}
class Shape {
  constructor() { this.points = []; }
  moveTo(x, y) { this.points.push([x, y]); }
  lineTo(x, y) { this.points.push([x, y]); }
  quadraticCurveTo(x, y, a, b) { this.points.push([x, y], [a, b]); }
}
class ExtrudeGeometry extends BoxGeometry {
  constructor(shape, options) {
    const xs = shape.points.map((p) => p[0]), ys = shape.points.map((p) => p[1]);
    super(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), options.depth);
    this.translate(0, 0, options.depth / 2);
  }
}
class LatheGeometry extends BoxGeometry {
  constructor(profile) {
    const r = Math.max(...profile.map((p) => p.x));
    const ys = profile.map((p) => p.y);
    super(r * 2, Math.max(...ys) - Math.min(...ys), r * 2);
  }
}
const THREE = { Vector2, Vector3, BufferAttribute, Float32BufferAttribute: BufferAttribute, BufferGeometry, BoxGeometry, CircleGeometry, Shape, ExtrudeGeometry, LatheGeometry,
  ShapeUtils: {
    isClockWise: (p) => p.reduce((s, a, i) => { const b = p[(i + 1) % p.length]; return s + a.x * b.y - b.x * a.y; }, 0) < 0,
    triangulateShape: (p) => Array.from({ length: p.length - 2 }, (_, i) => [0, i + 1, i + 2])
  }
};

function geometryUtils(engine = THREE) {
  return {
    mergeVertices(g) { if (!g.index) g.setIndex(Array.from({ length: g.attributes.position.count }, (_, i) => i)); return g; },
    mergeGeometries(parts) {
      const g = new engine.BufferGeometry(), indices = [];
      let offset = 0;
      for (const p of parts) {
        for (const index of p.index.array) indices.push(index + offset);
        offset += p.attributes.position.count;
      }
      g.setIndex(indices);
      for (const key of Object.keys(parts[0].attributes)) {
        const size = parts[0].attributes[key].itemSize;
        const values = parts.flatMap((p) => Array.from(p.attributes[key].array));
        g.setAttribute(key, new engine.Float32BufferAttribute(values, size));
      }
      return g;
    }
  };
}
module.exports = { THREE, geometryUtils };
