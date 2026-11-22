/**
 * @aureliajs/ssr Unified Document Renderer
 *
 * High-level, zero-boilerplate Convention-over-Configuration (CoC) API for Aurelia 2 SSR.
 * Combines isolated component SSR rendering, state serialization, and complete HTML5 shell assembly
 * into a single unified function call.
 */

import { CustomElement } from 'aurelia';
import { renderAurelia } from './render';
import { createHtmlDocument } from './html';
import { serializeState } from './serialize';
import type {
  AureliaComponent,
  ComponentProps,
  RenderDocumentOptions,
} from './types';

function kebabCase(str: string): string {
  return str
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

/**
 * Infer a standard kebab-case custom element tag name or component identifier.
 */
export function resolveComponentName(component: unknown): string {
  if (typeof component === 'string') return component;
  if (typeof component === 'function') {
    if (CustomElement.isType(component)) {
      return CustomElement.getDefinition(component).name;
    }
    if (component.name) {
      return kebabCase(component.name);
    }
  }
  if (typeof component === 'object' && component !== null) {
    if (component.constructor && CustomElement.isType(component.constructor)) {
      return CustomElement.getDefinition(component.constructor).name;
    }
    if (component.constructor && component.constructor.name && component.constructor.name !== 'Object') {
      return kebabCase(component.constructor.name);
    }
  }
  return 'app-root';
}

/**
 * Render an Aurelia 2 component into a full HTML5 document string with automatic
 * asset, root tag, and state hydration conventions.
 *
 * @example
 * // 1-line zero-configuration SSR document
 * const html = await renderDocument(ProfilePage, {
 *   props: { username: 'sandiko' },
 *   title: 'Profile — Aurelia 2 SSR',
 * });
 */
export async function renderDocument<
  TComponent extends object = object,
  TContext extends Record<string, unknown> = Record<string, unknown>,
>(
  component: AureliaComponent<TComponent>,
  options?: Omit<RenderDocumentOptions<TComponent, TContext>, 'component'>
): Promise<string>;
export async function renderDocument<
  TComponent extends object = object,
  TContext extends Record<string, unknown> = Record<string, unknown>,
>(options: RenderDocumentOptions<TComponent, TContext>): Promise<string>;
export async function renderDocument<
  TComponent extends object = object,
  TContext extends Record<string, unknown> = Record<string, unknown>,
>(
  componentOrOptions: AureliaComponent<TComponent> | RenderDocumentOptions<TComponent, TContext>,
  maybeOptions?: Omit<RenderDocumentOptions<TComponent, TContext>, 'component'>
): Promise<string> {
  const opts: RenderDocumentOptions<TComponent, TContext> =
    typeof componentOrOptions === 'function' || maybeOptions !== undefined
      ? { component: componentOrOptions as AureliaComponent<TComponent>, ...maybeOptions }
      : (componentOrOptions as RenderDocumentOptions<TComponent, TContext>);

  const component = opts.component;
  if (!component) {
    throw new Error('renderDocument: component is required');
  }

  const componentName = opts.componentName ?? resolveComponentName(component);

  const rootTag = opts.rootTag !== undefined
    ? opts.rootTag
    : (componentName.includes('-') ? componentName : 'app-root');

  const cssBundle = opts.cssBundle === false
    ? undefined
    : (opts.cssBundle ?? '/style.css');

  const jsBundle = opts.jsBundle === false
    ? undefined
    : (opts.jsBundle ?? '/client.js');

  const bodyHtml = await renderAurelia<TComponent, TContext>(opts);

  const payload = await serializeState<TContext, ComponentProps<TComponent>>(
    (opts.context ?? {}) as TContext,
    opts.props,
    componentName,
    opts.serialize
  );

  return createHtmlDocument<TContext, ComponentProps<TComponent>>(bodyHtml, payload, {
    ...opts,
    rootTag,
    cssBundle,
    jsBundle,
  });
}
