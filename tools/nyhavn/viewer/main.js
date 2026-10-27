import * as THREE from "./vendor/three.module.js";
import { OrbitControls } from "./vendor/examples/controls/OrbitControls.js";
import { GLTFLoader } from "./vendor/examples/loaders/GLTFLoader.js";

const MODEL_URL = "../model-v2/building.json";
const GLB_URL = "../model-v2/building.glb";
const PHOTO_ROOT = "../sources/skraafoto-native/";
const $ = (id) => document.getElementById(id);

const scenePanel = $("scene-panel");
const photoPanel = $("photo-panel");
const canvas = $("model-canvas");
const photoStage = document.querySelector(".photo-stage");
const sourceImage = $("source-image");
const projectionCanvas = $("projection-canvas");
const projectionContext = projectionCanvas.getContext("2d");
const sceneModeButton = $("scene-mode");
const photoModeButton = $("photo-mode");
const showInferred = $("show-inferred");
const showFacadePhotos = $("show-facade-photos");
const overlayOpacity = $("overlay-opacity");
const edgeOnly = $("edge-only");
const cameraSelect = $("camera-select");
const cameraPreset = $("camera-preset");

let model;
let renderer;
let scene;
let camera;
let controls;
let modelRoot;
let buildingById = new Map();
let cameraRecords = [];
let selectedView;
let resizeObserver;
let currentPreset = "hero-across";
let hoveredObject;

function setMode(mode) {
  const photo = mode === "photo";
  scenePanel.hidden = photo;
  photoPanel.hidden = !photo;
  sceneModeButton.classList.toggle("is-active", !photo);
  photoModeButton.classList.toggle("is-active", photo);
  sceneModeButton.setAttribute("aria-selected", String(!photo));
  photoModeButton.setAttribute("aria-selected", String(photo));
  if (photo) drawPhotoOverlay();
  else requestAnimationFrame(resizeRenderer);
}
sceneModeButton.addEventListener("click", () => setMode("scene"));
photoModeButton.addEventListener("click", () => setMode("photo"));

function initializeRenderer() {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.65));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xd6dde0);
  scene.fog = new THREE.Fog(0xd6dde0, 380, 1800);
  camera = new THREE.PerspectiveCamera(44, 1, 0.05, 2400);
  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.minDistance = 1.5;
  controls.maxDistance = 2200;
  controls.maxPolarAngle = Math.PI * 0.49;
  scene.add(new THREE.HemisphereLight(0xeaf0f2, 0x686258, 1.1));
  const key = new THREE.DirectionalLight(0xfff5e8, 2.15);
  key.position.set(-90, 150, -50);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -180;
  key.shadow.camera.right = 180;
  key.shadow.camera.top = 180;
  key.shadow.camera.bottom = -180;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 520;
  key.shadow.bias = -0.00016;
  key.shadow.normalBias = 0.065;
  scene.add(key);
  scene.add(key.target);
  const fill = new THREE.DirectionalLight(0xdbe7ed, 0.55);
  fill.position.set(90, 75, 120);
  scene.add(fill);
  resizeObserver = new ResizeObserver(resizeRenderer);
  resizeObserver.observe(scenePanel);
  window.addEventListener("resize", resizeRenderer);
  canvas.addEventListener("pointermove", inspectSurface);
  canvas.addEventListener("pointerleave", clearSelection);
  $("reset-camera").addEventListener("click", () => applyPreset(currentPreset));
  showInferred.addEventListener("change", () => {
    $("show-inferred-photo").checked = showInferred.checked;
    applyVisibility();
    drawPhotoOverlay();
  });
  $("show-inferred-photo").addEventListener("change", (event) => {
    showInferred.checked = event.target.checked;
    applyVisibility();
    drawPhotoOverlay();
  });
  showFacadePhotos.addEventListener("change", applyVisibility);
  overlayOpacity.addEventListener("input", drawPhotoOverlay);
  edgeOnly.addEventListener("change", drawPhotoOverlay);
  cameraSelect.addEventListener("change", () => selectPhotoView(cameraSelect.value));
  cameraPreset.addEventListener("change", () => applyPreset(cameraPreset.value));
  animate();
}

function resizeRenderer() {
  if (!renderer || scenePanel.hidden) return;
  const rect = scenePanel.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return;
  renderer.setSize(rect.width, rect.height, false);
  camera.aspect = rect.width / rect.height;
  camera.updateProjectionMatrix();
}
function animate() {
  requestAnimationFrame(animate);
  if (!renderer || scenePanel.hidden) return;
  controls.update();
  renderer.render(scene, camera);
}

function applyPreset(id) {
  const preset = model && model.viewer_presets && model.viewer_presets.items && model.viewer_presets.items[id];
  if (!preset || !camera || !controls) return;
  currentPreset = id;
  if (cameraPreset.value !== id) cameraPreset.value = id;
  camera.fov = Number(preset.fov || 44);
  camera.position.fromArray(preset.position);
  controls.target.fromArray(preset.target);
  camera.near = 0.05;
  camera.far = 2600;
  camera.updateProjectionMatrix();
  controls.update();
  const key = scene.children.find((x) => x.isDirectionalLight && x.castShadow);
  if (key) {
    let vx = camera.position.x - controls.target.x, vz = camera.position.z - controls.target.z;
    const horizontalLength = Math.hypot(vx, vz) || 1;
    vx /= horizontalLength; vz /= horizontalLength;
    const lx = -vz, lz = vx;
    key.position.set(controls.target.x + vx * 70 + lx * 28,
      controls.target.y + 100,
      controls.target.z + vz * 70 + lz * 28);
    key.target.position.copy(controls.target);
    key.target.updateMatrixWorld();
    const cameraDistance = camera.position.distanceTo(controls.target);
    const shadowSpan = cameraDistance < 165 ? 62 : 180;
    key.shadow.camera.left = -shadowSpan;
    key.shadow.camera.right = shadowSpan;
    key.shadow.camera.top = shadowSpan;
    key.shadow.camera.bottom = -shadowSpan;
    key.shadow.normalBias = 0.065;
    key.shadow.camera.updateProjectionMatrix();
  }
}
function populatePresets() {
  const presets = (model.viewer_presets && model.viewer_presets.items) || {};
  for (const [id, preset] of Object.entries(presets)) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = preset.label;
    cameraPreset.append(option);
  }
  const initial = (model.viewer_presets && model.viewer_presets.default) || Object.keys(presets)[0];
  if (initial) applyPreset(initial);
}

function loadModel() {
  const loader = new GLTFLoader();
  loader.load(GLB_URL, (gltf) => {
    modelRoot = gltf.scene;
    modelRoot.traverse((object) => {
      if (!object.isMesh) return;
      const data = object.userData;
      data.conf = data.conf || "inferred";
      data.src = data.src || [];
      data.buildingId = data.building_id || "context";
      data.element = data.element || object.name;
      const photoAppearance = Boolean(data.appearance_only) || String(data.element).includes("Facade photo");
      if (photoAppearance) object.material = asUnlitPhotoMaterial(object.material);
      if (Array.isArray(object.material)) object.material.forEach((material) => { material.side = THREE.DoubleSide; });
      else object.material.side = THREE.DoubleSide;
      const inferredParasol = data.buildingId === "context" && String(data.element).toLowerCase().includes("parasol");
      object.castShadow = !photoAppearance && (data.buildingId !== "context" || inferredParasol);
      object.receiveShadow = !photoAppearance;
      object.frustumCulled = true;
    });
    scene.add(modelRoot);
    applyVisibility();
    populatePresets();
    const metrics = model.metrics || {};
    const detailStatus = metrics.detail_opening_count == null ? "" : ` · ${metrics.detail_feature_count || 0} photo-traced features`;
    $("scene-status").textContent = `${metrics.building_count || model.buildings.length} envelopes · ${metrics.roofer_fit_count || 0} Roofer fits${detailStatus}`;
    $("building-count").textContent = model.buildings.length.toLocaleString();
    $("fit-count").textContent = `${Number(metrics.roofer_fit_count || 0).toLocaleString()} / ${Number(metrics.inferred_fallback_count || 0).toLocaleString()}`;
    $("roof-count").textContent = Number(metrics.roofer_roof_triangle_count || metrics.roof_triangle_count || 0).toLocaleString();
    $("facade-count").textContent = `${Number(metrics.facade_photo_edge_count || metrics.facade_texture_count || 0).toLocaleString()} · ${Number(metrics.facade_detail_front_count || 0).toLocaleString()} · ${Number(metrics.facade_unavailable_count || 0).toLocaleString()}`;
    $("detail-count").textContent = metrics.detail_opening_count == null
      ? "—"
      : [metrics.detail_opening_count, metrics.roof_window_feature_count, metrics.chimney_feature_count, metrics.detail_label_count]
        .map((value) => Number(value || 0).toLocaleString()).join(" · ");
    const area = model.buildings.reduce((sum, building) => {
      const ring = building.footprint_epsg25832 || [];
      let a = 0;
      for (let i = 0; i < ring.length; i += 1) {
        const p = ring[i], q = ring[(i + 1) % ring.length];
        a += p[0] * q[1] - q[0] * p[1];
      }
      const holes = (building.footprint_holes_epsg25832 || []).reduce((h, r) => {
        let v = 0;
        for (let i = 0; i < r.length; i += 1) {
          const p = r[i], q = r[(i + 1) % r.length];
          v += p[0] * q[1] - q[0] * p[1];
        }
        return h + Math.abs(v / 2);
      }, 0);
      return sum + Math.abs(a / 2) - holes;
    }, 0);
    $("area-value").textContent = Math.round(area).toLocaleString() + " m²";
  }, undefined, (error) => {
    $("scene-status").textContent = "Could not load the local v2 GLB";
    $("selection-address").textContent = error.message;
    console.error("Nyhavn v2 GLB load failed", error);
  });
}

function asUnlitPhotoMaterial(material) {
  const convert = (source) => {
    const result = new THREE.MeshBasicMaterial({
      map: source.map || null,
      color: source.color || 0xffffff,
      transparent: source.transparent,
      opacity: source.opacity,
      alphaTest: source.alphaTest,
      depthWrite: source.depthWrite,
      side: THREE.DoubleSide,
      toneMapped: false
    });
    result.name = source.name || "Photo appearance";
    return result;
  };
  return Array.isArray(material) ? material.map(convert) : convert(material);
}

function applyVisibility() {
  if (!modelRoot) return;
  const inferred = showInferred.checked, photos = showFacadePhotos.checked;
  modelRoot.traverse((object) => {
    if (!object.isMesh) return;
    const facade = String(object.userData.element).includes("Facade photo");
    object.visible = (inferred || object.userData.conf !== "inferred") && (photos || !facade);
  });
}

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
function inspectSurface(event) {
  if (!modelRoot) return;
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObject(modelRoot, true).find((item) => item.object.visible);
  if (!hit) return clearSelection();
  hoveredObject = hit.object;
  showSelectedSurface(hit);
}
function showSelectedSurface(hit) {
  const object = hit.object;
  const id = object.userData.buildingId || object.name.split("/")[0];
  const building = buildingById.get(id);
  const label = building && building.frontage_label
    ? building.frontage_label + " · " + building.address
    : (building && building.address) || id;
  const faceIndex = Number.isInteger(hit.faceIndex) ? hit.faceIndex : -1;
  const featureId = faceIndex >= 0 && object.userData.feature_ids ? object.userData.feature_ids[faceIndex] : null;
  const featureSource = faceIndex >= 0 && object.userData.triangle_sources ? object.userData.triangle_sources[faceIndex] : null;
  const featureTraces = faceIndex >= 0 && object.userData.triangle_trace_ids ? object.userData.triangle_trace_ids[faceIndex] : null;
  const element = object.userData.element || object.name.split("/").slice(1).join(" / ");
  $("selection-name").textContent = label;
  $("selection-address").textContent = element + (featureId ? " · " + featureId : "") + (building && building.year ? " · registered " + building.year : "");
  const meta = $("selection-meta");
  meta.replaceChildren();
  addMetadata(meta, "Confidence", object.userData.conf || "inferred");
  if (object.userData.appearance_confidence) addMetadata(meta, "Appearance confidence", object.userData.appearance_confidence);
  if (featureId) addMetadata(meta, "Feature", String(featureId));
  if (Array.isArray(featureTraces) && featureTraces.length) addMetadata(meta, "Trace IDs", featureTraces.join(", "));
  const source = Array.isArray(featureSource) ? featureSource : (object.userData.src || []);
  addMetadata(meta, "Source", source.join(", "));
  if (object.userData.effective_gsd_m_px) addMetadata(meta, "Texture sampling", object.userData.effective_gsd_m_px + " m/px; not accuracy");
  if (object.userData.coverage != null) addMetadata(meta, "Coverage", String(object.userData.coverage));
  if (object.userData.occlusion != null) addMetadata(meta, "Occlusion", String(object.userData.occlusion));
  if (object.userData.confidence_basis) addMetadata(meta, "Basis", object.userData.confidence_basis);
  if (object.userData.reason) addMetadata(meta, "Note", object.userData.reason);
  if (object.userData.material_adjustment) addMetadata(meta, "Appearance note", object.userData.material_adjustment);
  if (building && building.frontage_label) addMetadata(meta, "Register address", building.address);
}
function addMetadata(container, label, value) {
  const dt = document.createElement("dt"), dd = document.createElement("dd");
  dt.textContent = label; dd.textContent = value;
  container.append(dt, dd);
}
function clearSelection() {
  if (!hoveredObject) return;
  hoveredObject = null;
  $("selection-name").textContent = "Nothing selected";
  $("selection-address").textContent = "Move over a roof, facade or context surface to inspect its source.";
  $("selection-meta").replaceChildren();
}

function rotationMatrix(pers) {
  const rad = (deg) => (Number(deg) * Math.PI) / 180;
  const omega = rad(pers["pers:omega"]), phi = rad(pers["pers:phi"]), kappa = rad(pers["pers:kappa"]);
  const co = Math.cos(omega), so = Math.sin(omega), cp = Math.cos(phi), sp = Math.sin(phi), ck = Math.cos(kappa), sk = Math.sin(kappa);
  return [
    [cp * ck, -cp * sk, sp],
    [co * sk + so * sp * ck, co * ck - so * sp * sk, -so * cp],
    [so * sk - co * sp * ck, so * ck + co * sp * sk, co * cp]
  ];
}
function worldToPixel(pers, east, north, height) {
  const io = pers["pers:interior_orientation"], dimensions = io.sensor_array_dimensions.map(Number);
  const width = dimensions[0], imageHeight = dimensions[1], pixel = Number(io.pixel_spacing[0]), focal = Number(io.focal_length);
  const offset = io.principal_point_offset || [0, 0], center = pers["pers:perspective_center"].map(Number);
  const d = [east - center[0], north - center[1], height - center[2]], m = rotationMatrix(pers);
  const depth = m[0][2] * d[0] + m[1][2] * d[1] + m[2][2] * d[2];
  if (depth >= -1e-9) return null;
  const xdot = focal * (m[0][0] * d[0] + m[1][0] * d[1] + m[2][0] * d[2]) / depth;
  const ydot = focal * (m[0][1] * d[0] + m[1][1] * d[1] + m[2][1] * d[2]) / depth;
  const col = -((xdot - Number(offset[0])) - width * pixel / 2) / pixel;
  const rowBottom = -((ydot - Number(offset[1])) - imageHeight * pixel / 2) / pixel;
  return [col, imageHeight - rowBottom];
}
function projectToCrop(record, e, n, h) {
  const p = worldToPixel(record.pers, e, n, h);
  if (!p) return null;
  const c = record.crop, factor = Number(c.overview_factor || 1);
  return [(p[0] - c.x0) / factor, (p[1] - c.y0) / factor];
}

function drawPhotoOverlay() {
  if (!selectedView || !sourceImage.complete || !sourceImage.naturalWidth) return;
  const width = sourceImage.naturalWidth, height = sourceImage.naturalHeight;
  if (projectionCanvas.width !== width || projectionCanvas.height !== height) {
    projectionCanvas.width = width; projectionCanvas.height = height;
    photoStage.style.aspectRatio = width + " / " + height;
  }
  const ctx = projectionContext;
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.globalAlpha = Number(overlayOpacity.value) / 100;
  ctx.lineWidth = Math.max(1.1, width / 1900);
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  for (const building of model.buildings) {
    const edges = building.surface_wire_edges_epsg25832_dvr90 || [];
    if (edges.length) {
      ctx.strokeStyle = building.geometry_status === "inferred_fallback_envelope" ? "rgba(192, 125, 67, .86)" : "rgba(183, 69, 48, .84)";
      ctx.lineWidth = Math.max(1, width / 2200);
      ctx.beginPath();
      for (const edge of edges) {
        const a = projectToCrop(selectedView, edge[0][0], edge[0][1], edge[0][2]);
        const b = projectToCrop(selectedView, edge[1][0], edge[1][1], edge[1][2]);
        if (!a || !b) continue;
        ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
      }
      ctx.stroke();
      if (showInferred.checked) drawDetailAlignmentEdges(ctx, building.detail_wire_edges_epsg25832_dvr90 || [], selectedView, width);
      continue;
    }
    const rings = building.footprint_rings_epsg25832 || [building.footprint_epsg25832];
    const ring = rings[0] || [], ground = building.ground_dvr90, tops = building.eave_boundary_dvr90 || [];
    const bottom = ring.map((p) => projectToCrop(selectedView, p[0], p[1], ground));
    const top = ring.map((p, i) => projectToCrop(selectedView, p[0], p[1], tops[i] || ground + 10));
    if (bottom.some((p) => !p) || top.some((p) => !p)) continue;
    ctx.strokeStyle = "#fff2d9"; ctx.lineWidth = Math.max(1, width / 2400);
    strokeRing(ctx, bottom);
    if (!showInferred.checked) continue;
    ctx.strokeStyle = "#c04c34"; ctx.lineWidth = Math.max(1.2, width / 1700);
    strokeRing(ctx, top);
    for (let i = 0; i < ring.length; i += 1) {
      const j = (i + 1) % ring.length;
      if (!edgeOnly.checked) {
        ctx.fillStyle = "rgba(179, 79, 51, .16)";
        ctx.beginPath(); ctx.moveTo(bottom[i][0], bottom[i][1]);
        for (const p of [bottom[j], top[j], top[i]]) ctx.lineTo(p[0], p[1]);
        ctx.closePath(); ctx.fill();
      }
      ctx.beginPath(); ctx.moveTo(bottom[i][0], bottom[i][1]); ctx.lineTo(top[i][0], top[i][1]); ctx.stroke();
    }
    drawDetailAlignmentEdges(ctx, building.detail_wire_edges_epsg25832_dvr90 || [], selectedView, width);
  }
  ctx.restore();
}
function drawDetailAlignmentEdges(ctx, edges, view, width) {
  if (!edges.length) return;
  ctx.strokeStyle = "rgba(220, 137, 57, .92)";
  ctx.lineWidth = Math.max(1.2, width / 1850);
  ctx.beginPath();
  for (const edge of edges) {
    const a = projectToCrop(view, edge[0][0], edge[0][1], edge[0][2]);
    const b = projectToCrop(view, edge[1][0], edge[1][1], edge[1][2]);
    if (!a || !b) continue;
    ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
  }
  ctx.stroke();
}
function strokeRing(ctx, points) {
  if (points.length < 2) return;
  ctx.beginPath(); ctx.moveTo(points[0][0], points[0][1]);
  for (const p of points.slice(1)) ctx.lineTo(p[0], p[1]);
  ctx.closePath(); ctx.stroke();
}

function populateCameraSelect() {
  cameraRecords = model.cameras || [];
  for (const record of cameraRecords) {
    const option = document.createElement("option");
    const date = record.datetime ? record.datetime.slice(0, 10) : "2025";
    const scale = Number(record.gsd || 0) * Number((record.crop || {}).overview_factor || 1);
    option.value = record.view_id;
    option.textContent = record.direction + " · " + date + " · " + scale.toFixed(2) + " m/px";
    cameraSelect.append(option);
  }
  const selected = cameraRecords.find((r) => r.direction === "south") || cameraRecords[0];
  if (selected) {
    cameraSelect.value = selected.view_id;
    selectPhotoView(selected.view_id);
  } else {
    $("photo-empty").hidden = false;
  }
}
function selectPhotoView(id) {
  selectedView = cameraRecords.find((r) => r.view_id === id);
  if (!selectedView) return;
  sourceImage.alt = selectedView.direction + " calibrated 2025 Skråfoto, captured " + (selectedView.datetime || "date not recorded");
  sourceImage.src = PHOTO_ROOT + selectedView.file;
  sourceImage.onload = () => {
    photoStage.style.aspectRatio = sourceImage.naturalWidth + " / " + sourceImage.naturalHeight;
    projectionCanvas.width = sourceImage.naturalWidth;
    projectionCanvas.height = sourceImage.naturalHeight;
    $("photo-empty").hidden = true;
    drawPhotoOverlay();
  };
  sourceImage.onerror = () => {
    $("photo-empty").hidden = false;
    $("photo-empty").textContent = "Could not load " + selectedView.file;
  };
  const crop = selectedView.crop || {}, gsd = Number(selectedView.gsd || 0) * Number(crop.overview_factor || 1);
  $("photo-label").textContent = selectedView.direction + " view · " + (selectedView.datetime || "2025");
  $("photo-detail").textContent = "Calibrated STAC camera · " + gsd.toFixed(2) + " m per saved pixel · source Roofer edges are red; inferred dormer, chimney and opening edges are amber. Overlay lines show geometry, not image tie points.";
  $("camera-json").textContent = JSON.stringify({
    view_id: selectedView.view_id, item_id: selectedView.item_id, direction: selectedView.direction,
    datetime: selectedView.datetime, native_gsd_m_px: selectedView.gsd, effective_gsd_m_px: gsd,
    image_size: selectedView.image_size, crop: selectedView.crop, pers: selectedView.pers
  }, null, 2);
}

async function start() {
  initializeRenderer();
  try {
    const response = await fetch(MODEL_URL);
    if (!response.ok) throw new Error("v2 building.json returned " + response.status);
    model = await response.json();
    buildingById = new Map(model.buildings.map((b) => [b.id, b]));
    loadModel();
    populateCameraSelect();
  } catch (error) {
    $("scene-status").textContent = "Could not load local v2 model data";
    $("selection-address").textContent = error.message;
    console.error("Nyhavn v2 data load failed", error);
  }
}
start();
