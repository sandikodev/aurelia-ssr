/**
 * @aureliajs/ssr Server Entrypoint
 */

export { renderAurelia, renderToString, detectDefaultSSREngine } from './render';
export { renderDocument, resolveComponentName } from './document';
export { IRequestContext, resolveRequestContext } from './tokens';
export {
  serializeState,
  serializeStateStream,
  validatePayload,
  stringifyPayload,
} from './serialize';
export { encodeRichValue } from './codec';
export {
  DEFAULT_SCRIPT_ID,
  DEFERRED_SCRIPT_ATTR,
  createDocumentShell,
  createHydrationScript,
  createDeferredScript,
  createHtmlDocument,
  escapeHtml,
  escapeAttr,
  validateHtmlStructure,
} from './html';
export type {
  AureliaComponent,
  ComponentProps,
  RenderContext,
  HydrationPayload,
  RenderOptions,
  RenderDocumentOptions,
  SSREngine,
  SerializeOptions,
  SerializeStreamOptions,
  SerializedStateStream,
  DeferredPromiseEntry,
  DeferredScriptOptions,
  EncodeRichOptions,
  DocumentShell,
  DocumentOptions,
  DocumentTemplateContext,
  IRequestContext as IRequestContextType,
} from './types';
