// js/landmark-state.js
// Mutable landmark facts shared between the Manhattan-only landmark builder (landmarks.js) and the engine-core
// modules (controllers.js, cameras.js). Keeping them here lets the core load without the Manhattan modules: in
// Copenhagen mode landmarks.js is never imported and `bryantParkLawn` simply stays undefined.
export const landmarkState = { bryantParkLawn: undefined };
