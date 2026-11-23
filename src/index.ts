/**
 * @aureliajs/ssr
 *
 * Standards-compliant, framework-agnostic SSR & Hydration Core Engine for Aurelia 2.
 */

// Server-side API
export { renderAurelia, renderToString, detectDefaultSSREngine } from './render';
export { renderDocument, resolveComponentName } from './document';
export { IRequestContext, resolveRequestContext } from './tokens';
export { serializeState, validatePayload, stringifyPayload } from './serialize';
export {
  DEFAULT_SCRIPT_ID,
  createDocumentShell,
  createHydrationScript,
  createHtmlDocument,
  escapeHtml,
  escapeAttr,
  validateHtmlStructure,
} from './html';

// Client-side API
export {
  hydrateFromServer,
  isHydrationAvailable,
  peekHydrationPayload,
  clearHydration,
  createClientHydrator,
} from './hydrate';

// Pure Generic Types
export type {
  AureliaComponent,
  ComponentProps,
  RenderContext,
  HydrationPayload,
  HydrationResult,
  RenderOptions,
  RenderDocumentOptions,
  SSREngine,
  SerializeOptions,
  DocumentShell,
  DocumentOptions,
  DocumentTemplateContext,
  HydrateFromServerOptions,
  ClientHydratorOptions,
  IRequestContext as IRequestContextType,
} from './types';

export const VERSION = '0.2.0';
