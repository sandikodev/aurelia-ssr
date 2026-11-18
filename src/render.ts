/**
 * @aureliajs/ssr Server Renderer
 *
 * Pure, platform-scoped Server-Side Rendering engine for Aurelia 2.
 * Uses Aurelia 2's native per-container `BrowserPlatform(win)` and real `ISSRContext`
 * from `@aurelia/runtime-html` — zero `globalThis` monkey-patching, zero global mutexes,
 * zero secret instance mutations.
 */

import { JSDOM } from 'jsdom';
import {
  Aurelia,
  CustomElement,
  DI,
  IPlatform,
  ITemplateElementFactory,
  Registration,
  resolve,
  type Constructable,
} from 'aurelia';
import { ISSRContext, StandardConfiguration } from '@aurelia/runtime-html';
import { BrowserPlatform } from '@aurelia/platform-browser';
import type { IRequestContext as IRequestContextData, RenderOptions } from './types.js';
import { IRequestContext, resolveRequestContext } from './tokens.js';
import { escapeAttr } from './html.js';

export { IRequestContext, resolveRequestContext };

/**
 * Request-scoped `ITemplateElementFactory` creating `<template>` nodes directly
 * against the active request's `IPlatform.document`, avoiding cross-document
 * template cache contamination (`AUR0757`) across concurrent SSR requests.
 */
class SsrTemplateElementFactory implements ITemplateElementFactory {
  private readonly platform = resolve(IPlatform);

  public createTemplate(input: string | Node): HTMLTemplateElement {
    if (typeof input === 'string') {
      const template = this.platform.document.createElement('template');
      template.innerHTML = input;
      return template;
    }
    if (input.nodeName !== 'TEMPLATE') {
      const template = this.platform.document.createElement('template');
      template.content.appendChild(input);
      return template;
    }
    return input as HTMLTemplateElement;
  }
}

function resolveClientOnlyTag(component: unknown): string {
  if (typeof component === 'function' && CustomElement.isType(component)) {
    return CustomElement.getDefinition(component).name;
  }
  if (
    typeof component === 'object' &&
    component !== null &&
    component.constructor &&
    CustomElement.isType(component.constructor)
  ) {
    return CustomElement.getDefinition(component.constructor).name;
  }
  const named = component as { name?: string } | null;
  return named?.name || 'client-island';
}

function isClientOnlyComponent(component: unknown): boolean {
  if (!component) return false;
  return Boolean((component as { clientOnly?: boolean }).clientOnly);
}

function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolveResult, rejectResult) => {
    const timer = setTimeout(
      () => rejectResult(new Error(`renderAurelia timeout after ${timeoutMs}ms`)),
      timeoutMs
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolveResult(value);
      },
      (err) => {
        clearTimeout(timer);
        rejectResult(err);
      }
    );
  });
}

/**
 * Render an Aurelia 2 component to an HTML string inside an isolated,
 * request-scoped `BrowserPlatform` and DI container.
 */
export async function renderAurelia<
  TComponent extends object = object,
  TContext extends Record<string, unknown> = Record<string, unknown>,
>(options: RenderOptions<TComponent, TContext>): Promise<string> {
  const {
    component,
    context = {} as TContext,
    props,
    timeout = 5000,
    registrations,
    settle,
    preserveMarkers = true,
    url = 'http://localhost/',
    params = {},
    query = {},
  } = options;

  if (!component) {
    throw new Error('renderAurelia: component is required');
  }

  // Client-only island boundary: emit minimal placeholder without spawning JSDOM
  if (isClientOnlyComponent(component)) {
    const tag = resolveClientOnlyTag(component);
    return `<div class="au-client-island" data-au-client="${escapeAttr(tag)}"></div>`;
  }

  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="ssr-root"></div></body></html>', {
    url,
    contentType: 'text/html',
    pretendToBeVisual: true,
  });

  const win = dom.window as unknown as typeof globalThis;
  const platform = new BrowserPlatform(win);
  const container = DI.createContainer();
  const app = new Aurelia(container);

  const requestContext: IRequestContextData<TContext> = {
    data: context,
    url,
    params,
    query,
    isServer: true,
    isClient: false,
  };

  const renderTask = (async (): Promise<string> => {
    app.register(
      StandardConfiguration,
      Registration.instance(IPlatform, platform),
      Registration.singleton(ITemplateElementFactory, SsrTemplateElementFactory),
      Registration.instance(ISSRContext, { preserveMarkers }),
      Registration.instance(IRequestContext, requestContext)
    );

    if (registrations && registrations.length > 0) {
      app.register(...registrations);
    }

    const rootComponent: object =
      typeof component === 'function'
        ? (app.container.get(component as Constructable<TComponent>) as object)
        : component;

    if (props) {
      Object.assign(rootComponent, props);
    }

    const host = dom.window.document.getElementById('ssr-root');
    if (!host) {
      throw new Error('renderAurelia: host element #ssr-root not found');
    }

    await app.app({ host, component: rootComponent }).start();

    if (settle && settle > 0) {
      await new Promise((done) => setTimeout(done, settle));
    }

    return host.innerHTML;
  })();

  try {
    return await raceWithTimeout(renderTask, timeout);
  } finally {
    try {
      await app.stop();
    } catch {
      // Ignore stop errors if startup failed or timed out
    }
    try {
      app.dispose();
    } catch {
      // Ignore dispose errors
    }
    try {
      dom.window.close();
    } catch {
      // Ignore JSDOM teardown errors
    }
  }
}

/**
 * Standard SSR alias mirroring React/Vue conventions.
 */
export { renderAurelia as renderToString };
