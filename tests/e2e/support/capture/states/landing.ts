// The landing page's own capture state — one static render, no loading/error/empty variant, since
// nothing on this route fetches data on load.
//
//   npm run capture:screens -- --screen landing --states default

import type { StateRegistry } from "../types";

export const states: StateRegistry = {
  default: { route: "/" },
};
