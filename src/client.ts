/**
 * @aureliajs/ssr Client Entrypoint (zero server / JSDOM dependencies)
 */

export {
  hydrateFromServer,
  isHydrationAvailable,
  peekHydrationPayload,
  clearHydration,
  createClientHydrator,
} from './hydrate';
export { IRequestContext, resolveRequestContext } from './tokens';
export { DEFAULT_SCRIPT_ID } from './html';
export type {
  AureliaComponent,
  ComponentProps,
  RenderContext,
  HydrationPayload,
  HydrationResult,
  HydrateFromServerOptions,
  ClientHydratorOptions,
  IRequestContext as IRequestContextType,
} from './types';
