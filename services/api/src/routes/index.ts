import type { RouteModule } from './ctx.ts';
import { capitalRoutes } from './capital.ts';
import { researchModule } from './research.ts';
// Feature modules append ONE import + ONE array entry here (re-read the file before editing; others edit it too).
export const routeModules: RouteModule[] = [capitalRoutes, researchModule];
