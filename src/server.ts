/**
 * @aureliajs/ssr Server Entrypoint
 */

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
export type {
  AureliaComponent,
  ComponentProps,
  RenderContext,
  HydrationPayload,
  RenderOptions,
  RenderDocumentOptions,
  SSREngine,
  SerializeOptions,
  DocumentShell,
  DocumentOptions,
  DocumentTemplateContext,
  IRequestContext as IRequestContextType,
} from './types';
