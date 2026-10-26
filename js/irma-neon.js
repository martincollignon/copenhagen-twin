import * as THREE from 'three/webgpu';
import { attribute, uniform, uv, abs, pow, float } from 'three/tsl';
import { irmaNeonArtwork } from './irma-neon-art.js';

// The Irma Block's roof signs. Footprints and roof contact heights come from the same GeoDanmark/LoD2 data as the
// buildings. Setbacks and braces are estimates informed by the 2025-04-27 west/nadir Skråfoto views
// west_2025_84_40_5_0054_00001508_100mm and nadir_2025_84_40_1_0052_00001962_100mm.
// Artwork follows the supplied January 2015 night photograph; these two evidence dates are intentionally distinct.
const SETBACK = 2.0;
const BRACE_DEPTH = 3.0;
const SIDES = 6;
const EGG_PERIOD = 60 / 7;

const accumulator = () => ({ position: [], normal: [], color: [], uv: [], index: [] });
const colorCache = new Map();
function linearColor(hex) {
  if (!colorCache.has(hex)) colorCache.set(hex, new THREE.Color(hex).toArray());
  return colorCache.get(hex);
}

function appendTube(a, points, radius, color) {
  const first = a.position.length / 3;
  const closed = points.length > 2 && points[0].distanceToSquared(points.at(-1)) < 1e-8;
  for (let i = 0; i < points.length; i++) {
    const before = points[i === 0 ? (closed ? points.length - 2 : 0) : i - 1];
    const after = points[i === points.length - 1 ? (closed ? 1 : i) : i + 1];
    const tangent = new THREE.Vector3().subVectors(after, before).normalize();
    const across = new THREE.Vector3().crossVectors(tangent, Math.abs(tangent.z) < .95 ? new THREE.Vector3(0,0,1) : new THREE.Vector3(0,1,0)).normalize();
    const normal = new THREE.Vector3().crossVectors(tangent, across).normalize();
    for (let j = 0; j < SIDES; j++) {
      const angle = j * Math.PI * 2 / SIDES;
      const n = across.clone().multiplyScalar(Math.cos(angle)).addScaledVector(normal, Math.sin(angle));
      a.position.push(points[i].x + n.x * radius, points[i].y + n.y * radius, points[i].z + n.z * radius);
      a.normal.push(n.x,n.y,n.z);
      a.color.push(...color);
      if (i > 0) {
        const b = first + (i - 1) * SIDES + j;
        const c = first + (i - 1) * SIDES + (j + 1) % SIDES;
        a.index.push(b,c,c+SIDES,b,c+SIDES,b+SIDES);
      }
    }
  }
}

// A narrow, soft halo makes thin tubes survive the lower-resolution planar reflection. It uses ordinary colour /
// alpha outputs (no MRT-only material), so the reflection pass renders it along with the actual tube geometry.
function appendHalo(a, points, color) {
  const first = a.position.length / 3;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const prev = points[Math.max(0,i-1)], next = points[Math.min(points.length-1,i+1)];
    const len = Math.hypot(next.x-prev.x,next.y-prev.y) || 1;
    const nx = -(next.y-prev.y) / len, ny = (next.x-prev.x) / len;
    for (const side of [-1,1]) {
      a.position.push(p.x + nx*.21*side,p.y + ny*.21*side,p.z-.012);
      a.normal.push(0,0,1);
      a.color.push(...color);
      a.uv.push(i/(points.length-1),(side+1)/2);
    }
    if (i > 0) {
      const b = first + (i-1)*2;
      a.index.push(b,b+1,b+3,b,b+3,b+2);
    }
  }
}

function geometry(a) {
  const g = new THREE.BufferGeometry();
  for (const name of ['position','normal','color']) g.setAttribute(name, new THREE.Float32BufferAttribute(a[name],3));
  if (a.uv.length) g.setAttribute('uv',new THREE.Float32BufferAttribute(a.uv,2));
  g.setIndex(a.index);
  g.computeBoundingSphere();
  return g;
}

/** Highest measured roof triangle under the support foot; use the existing eave when no LoD2 roof is available. */
function roofHeightAt(record, x, z, fallback) {
  if (!record) return fallback;
  let height = -Infinity;
  for (let i=0;i<record.nT;i++) {
    if (record.kind[i] !== 0) continue;
    const ia=record.idx[i*3]*3, ib=record.idx[i*3+1]*3, ic=record.idx[i*3+2]*3, p=record.pos;
    const ax=p[ia],az=p[ia+2],bx=p[ib],bz=p[ib+2],cx=p[ic],cz=p[ic+2];
    const den=(bz-cz)*(ax-cx)+(cx-bx)*(az-cz);
    if (Math.abs(den)<1e-8) continue;
    const u=((bz-cz)*(x-cx)+(cx-bx)*(z-cz))/den;
    const v=((cz-az)*(x-cx)+(ax-cx)*(z-cz))/den;
    const w=1-u-v;
    if (Math.min(u,v,w)>=-1e-5) height=Math.max(height,u*p[ia+1]+v*p[ib+1]+w*p[ic+1]);
  }
  return Number.isFinite(height) ? height : fallback;
}

export function createIrmaNeon(parent, buildingsById, roofRecords = new Map()) {
  const group = new THREE.Group();
  group.name = 'IrmaLakefrontNeon';
  parent.add(group);
  const power = Array.from({ length: 4 }, () => uniform(0));
  const tubeMaterials = power.map((p) => {
    const m = new THREE.MeshStandardNodeMaterial({ color: 0x606060, vertexColors: true, roughness: .28, metalness: .12 });
    m.name = 'irma-neon-tube';
    m.emissiveNode = attribute('color','vec3').mul(p);
    return m;
  });
  const haloMaterials = power.map((p) => {
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false });
    m.name = 'irma-neon-halo';
    m.colorNode = attribute('color','vec3').mul(2.2);
    m.opacityNode = pow(float(1).sub(abs(uv().y.mul(2).sub(1))),3).mul(p.div(7.5)).mul(.32);
    return m;
  });
  const metal = new THREE.MeshStandardNodeMaterial({ color: 0x41433f, metalness: .65, roughness: .67 });
  const panels = [], lights = [];

  for (const art of irmaNeonArtwork()) {
    const building = buildingsById.get(art.buildingId);
    if (!building?.ring?.length) continue;
    const [[ax,az],[bx,bz]] = art.edge;
    const len = Math.hypot(bx-ax,bz-az), tx=(bx-ax)/len, tz=(bz-az)/len, nx=-tz, nz=tx;
    const x=ax+tx*art.offset-nx*SETBACK, z=az+tz*art.offset-nz*SETBACK;
    const roof = roofRecords.get(art.buildingId);
    const roofAt = (u,depth) => roofHeightAt(roof,x+tx*u+nx*depth,z+tz*u+nz*depth,building.eave);
    const posts = Math.ceil(art.width/4.5);
    let base = building.eave+.4;
    for (let i=0;i<=posts;i++) base=Math.max(base,roofAt(art.width*i/posts,0)+.3);

    const panel = new THREE.Group();
    panel.name = `neon-${art.id}`;
    panel.position.set(x,base,z);
    panel.rotation.y = Math.atan2(-tz,tx);
    panel.userData = { buildingId: art.buildingId, sourceDate: '2015-01-31', placement: 'photo-estimated, LoD2 roof contacts' };
    group.add(panel);

    const frame = accumulator();
    const bar = (a,b,r=.035) => appendTube(frame,[new THREE.Vector3(...a),new THREE.Vector3(...b)],r,[1,1,1]);
    for (const h of [0,art.height*.42,art.height*.78,art.height]) bar([0,h,-.16],[art.width,h,-.16],.027);
    for (let i=0;i<=posts;i++) {
      const u=art.width*i/posts, foot=roofAt(u,-.15)-base, rear=roofAt(u,-BRACE_DEPTH)-base;
      bar([u,foot,-.15],[u,art.height,-.15]);
      bar([u,rear,-BRACE_DEPTH],[u,art.height*.8,-.15],.03);
      bar([u,foot,-.15],[u,rear,-BRACE_DEPTH],.03);
    }
    const scaffold = new THREE.Mesh(geometry(frame),metal);
    scaffold.name = 'neon-roof-scaffold';
    scaffold.receiveShadow = true;
    panel.add(scaffold);

    const tubes=Array.from({length:4},accumulator), halos=Array.from({length:4},accumulator);
    for (const stroke of art.strokes) {
      const points=stroke.points.map(([u,v])=>new THREE.Vector3(u,v,.04));
      const color=linearColor(stroke.color);
      appendTube(tubes[stroke.stage],points,stroke.radius,color);
      appendHalo(halos[stroke.stage],points,color);
    }
    for (let stage=0;stage<4;stage++) {
      if (!tubes[stage].index.length) continue;
      const tube = new THREE.Mesh(geometry(tubes[stage]),tubeMaterials[stage]);
      tube.name = stage ? `neon-egg-${stage}` : 'neon-glass-tubes';
      panel.add(tube);
      const halo = new THREE.Mesh(geometry(halos[stage]),haloMaterials[stage]);
      halo.name = 'neon-tube-halo';
      halo.renderOrder = 2;
      panel.add(halo);
    }

    // Three fixed, short-range sources: a faint roof/cornice tint without district-wide coloured lighting or shadows.
    const light = new THREE.PointLight(art.tint,0,12,2);
    light.position.set(art.width*.5,-.7,SETBACK+.6);
    panel.add(light);
    lights.push(light);
    panels.push({ id: art.id, buildingId: art.buildingId, position: [x,base,z], width: art.width, setback: SETBACK });
  }

  const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  function update(nightFactor = 0) {
    const t = Math.max(0,Math.min(1,(nightFactor-.08)/.42));
    const on = t*t*(3-2*t);
    power[0].value = on*7.5;
    const stage = Math.floor((performance.now()*.001/EGG_PERIOD % 1)*3)+1;
    for (let i=1;i<4;i++) power[i].value = on*7.5*(reducedMotion?.matches || stage===i ? 1 : .035);
    for (const light of lights) light.intensity = on*18;
  }
  return { group, panels, update, stats: { panels: panels.length, sourceDate: '2015-01-31' } };
}
