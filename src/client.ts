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
} from './hydrate';
export { decodeRichValue } from './codec';
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
