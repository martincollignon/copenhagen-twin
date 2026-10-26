// js/dispose-tree.js
// Releases an Object3D subtree the way the WebGPU renderer needs it. `geometry.dispose()` frees the GPU buffers, but the
// renderer keeps one RenderObject per (mesh, material) in a Set and only lets go of it when the MESH emits 'dispose' (or its
// material does, which a material shared by many tiles never does): without this event every mesh of every tile that was ever
// streamed in stays reachable, JS heap and all.

/**
 * @param {THREE.Object3D} root removed from its parent first
 * @param {{ materials?: boolean }} [opts] dispose the materials too (only for materials the subtree owns)
 */
export function disposeTree(root, { materials = false } = {}) {
  if (!root) return;
  root.parent?.remove(root);
  root.traverse((o) => {
    o.geometry?.dispose?.();
    if (materials && o.material) for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose?.();
    o.dispatchEvent?.({ type: 'dispose' });
  });
}
