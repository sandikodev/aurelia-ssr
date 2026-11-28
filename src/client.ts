/**
 * @aureliajs/ssr Client Entrypoint (zero server / JSDOM dependencies)
 */

export {
  decodeHydrationPayload,
  hydrateFromServer,
  isHydrationAvailable,
  peekHydrationPayload,
  clearHydration,
  createClientHydrator,
  resolveDeferredScripts,
  observeDeferredHydration,
} from './hydrate';
export { decodeRichValue } from './codec';
export { IRequestContext, resolveRequestContext } from './tokens';
export { DEFAULT_SCRIPT_ID, DEFERRED_SCRIPT_ATTR } from './html';
export type {
  AureliaComponent,
  ComponentProps,
  RenderContext,
  HydrationPayload,
  HydrationResult,
  HydrateFromServerOptions,
  ClientHydratorOptions,
  DecodeRichOptions,
  IRequestContext as IRequestContextType,
} from './types';
