/**
 * @aureliajs/ssr Client Hydration
 *
 * Pure HTML5-standard, strictly typed client hydration primitives for Aurelia 2.
 * Reads state from inert `<script type="application/json" id="__AURELIA_SSR_DATA__">`
 * elements — zero `window` global pollution and zero server/JSDOM dependencies.
 */

import { AppTask, Aurelia, CustomElement, IAppRoot, Registration, type Constructable } from 'aurelia';
import type {
  ClientHydratorOptions,
  HydrateFromServerOptions,
  HydrationPayload,
  HydrationResult,
  IRequestContext as IRequestContextData,
} from './types';
import { IRequestContext, resolveRequestContext } from './tokens';
import { DEFAULT_SCRIPT_ID } from './html';
import { decodeRichValue } from './codec';
import {
  getDeferredRegistry,
  hasPendingDeferred,
  onDeferredSettled,
  resolveDocument,
  settleDeferredPromise,
} from './deferred';

export { IRequestContext, resolveRequestContext };
export type { HydrationResult, ClientHydratorOptions, HydrateFromServerOptions };

function findScriptElement(scriptId: string): HTMLScriptElement | null {
  if (typeof document === 'undefined') return null;
  const el = document.getElementById(scriptId);
  if (!el || el.tagName.toUpperCase() !== 'SCRIPT') return null;
  return el as HTMLScriptElement;
}

function validatePayload(payload: unknown): asserts payload is HydrationPayload {
  if (!payload || typeof payload !== 'object') {
    throw new TypeError('Hydration payload must be a JSON object');
  }

  const obj = payload as Record<string, unknown>;

  if (typeof obj.component !== 'string') {
    throw new TypeError('Hydration payload.component must be a string');
  }

  if (!obj.context || typeof obj.context !== 'object') {
    throw new TypeError('Hydration payload.context must be an object');
  }

  if (typeof obj.timestamp !== 'number' || obj.timestamp <= 0) {
    throw new TypeError('Hydration payload.timestamp must be a positive number');
  }

  if (obj.initialData !== undefined && typeof obj.initialData !== 'object') {
    throw new TypeError('Hydration payload.initialData must be an object if provided');
  }
}

/**
 * Check if an HTML5 JSON hydration script element exists without consuming it.
 */
export function isHydrationAvailable(scriptId = DEFAULT_SCRIPT_ID): boolean {
  const el = findScriptElement(scriptId);
  return Boolean(el && el.textContent && el.textContent.trim().length > 0);
}

/**
 * Parse and return the raw hydration payload without removing the `<script>` element.
 */
export function peekHydrationPayload<
  TContext extends Record<string, unknown> = Record<string, unknown>,
  TData = Record<string, unknown>,
>(scriptId = DEFAULT_SCRIPT_ID): HydrationPayload<TContext, TData> | undefined {
  const el = findScriptElement(scriptId);
  if (!el || !el.textContent) return undefined;
  return JSON.parse(el.textContent) as HydrationPayload<TContext, TData>;
}

/**
 * Remove the JSON hydration `<script>` element from the DOM.
 */
export function clearHydration(scriptId = DEFAULT_SCRIPT_ID): void {
  findScriptElement(scriptId)?.remove();
}

export function decodeHydrationPayload<
  TData = Record<string, unknown>,
  TContext extends Record<string, unknown> = Record<string, unknown>,
>(
  payload: HydrationPayload<TContext, TData>,
  options?: { root?: ParentNode | Document | null }
): HydrationResult<TData, TContext> {
  if (payload.encoding === 'rich') {
    const decodeOpts = options?.root ? { root: options.root } : undefined;
    const decodedContext = (decodeRichValue<TContext>(payload.context, decodeOpts) ?? {}) as TContext;
    const decodedData =
      payload.initialData !== undefined
        ? decodeRichValue<TData>(payload.initialData, decodeOpts)
        : undefined;

    return {
      component: payload.component,
      context: decodedContext,
      initialData: decodedData,
      ssrScope: payload.ssrScope,
      timestamp: payload.timestamp,
      params: payload.params,
    };
  }

  return {
    component: payload.component,
    context: payload.context,
    initialData: payload.initialData,
    ssrScope: payload.ssrScope,
    timestamp: payload.timestamp,
    params: payload.params,
  };
}

const DEFERRED_SCRIPT_SELECTOR = 'script[type="application/json"][data-au-deferred]';

function parseDeferredError(parsed: Record<string, unknown>): Error {
  const msg =
    typeof parsed.error === 'string' && parsed.error.length > 0
      ? parsed.error
      : 'Deferred promise rejected';
  const err = new Error(msg);
  if (typeof parsed.name === 'string' && parsed.name.length > 0) {
    err.name = parsed.name;
  }
  return err;
}

/**
 * Scan `root` (defaults to `document`) for inert `<script type="application/json" data-au-deferred="...">`
 * elements, remove them cleanly from the DOM, decode their payloads with `decodeRichValue`,
 * and resolve or reject the matching client `Promise`s.
 */
export function resolveDeferredScripts(root?: ParentNode | Document | null): number {
  const target: ParentNode | null =
    root ?? (typeof document !== 'undefined' ? document : null);
  if (!target || typeof target.querySelectorAll !== 'function') {
    return 0;
  }

  const registry = getDeferredRegistry(target);
  const scripts = target.querySelectorAll(DEFERRED_SCRIPT_SELECTOR);
  let processed = 0;

  for (const script of Array.from(scripts)) {
    const id = script.getAttribute('data-au-deferred');
    const raw = script.textContent;
    script.remove();

    if (!id || !raw) {
      continue;
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        if (obj.ok === false || ('error' in obj && obj.ok !== true)) {
          settleDeferredPromise(id, false, parseDeferredError(obj), registry);
        } else if ('data' in obj) {
          const decoded = decodeRichValue(obj.data, { root: target });
          settleDeferredPromise(id, true, decoded, registry);
        } else {
          settleDeferredPromise(id, true, obj, registry);
        }
      } else if (Array.isArray(parsed)) {
        const decoded = decodeRichValue(parsed, { root: target });
        settleDeferredPromise(id, true, decoded, registry);
      } else {
        settleDeferredPromise(id, true, parsed, registry);
      }
      processed++;
    } catch (err) {
      settleDeferredPromise(id, false, err, registry);
      processed++;
    }
  }

  return processed;
}

function resolveMutationObserverCtor(
  target: ParentNode
): typeof MutationObserver | undefined {
  const doc = resolveDocument(target);
  const win = doc?.defaultView ?? (typeof window !== 'undefined' ? window : undefined);
  if (win && typeof win.MutationObserver === 'function') {
    return win.MutationObserver;
  }
  if (typeof MutationObserver === 'function') {
    return MutationObserver;
  }
  return undefined;
}

/**
 * Observe `root` (defaults to `document`) for streaming `<script type="application/json" data-au-deferred="...">`
 * chunks via `MutationObserver`, immediately scanning any existing deferred scripts too.
 * Returns a cleanup function to disconnect the observer.
 */
export function observeDeferredHydration(
  root?: ParentNode | Document | null
): () => void {
  const target: ParentNode | null =
    root ?? (typeof document !== 'undefined' ? document : null);
  if (!target) {
    return () => {};
  }

  resolveDeferredScripts(target);

  const ObserverCtor = resolveMutationObserverCtor(target);
  if (!ObserverCtor) {
    return () => {};
  }

  const observeNode =
    'nodeType' in target && target.nodeType === 9
      ? ((target as Document).documentElement ?? target)
      : target;

  const observer = new ObserverCtor((mutations) => {
    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) {
        resolveDeferredScripts(target);
        return;
      }
    }
  });

  observer.observe(observeNode, { childList: true, subtree: true });

  return () => {
    observer.disconnect();
  };
}

/**
 * Extract, validate, and consume the server-rendered hydration payload
 * from `<script id="__AURELIA_SSR_DATA__" type="application/json">`.
 */
export function hydrateFromServer<
  TData = Record<string, unknown>,
  TContext extends Record<string, unknown> = Record<string, unknown>,
>(options?: HydrateFromServerOptions): HydrationResult<TData, TContext> | null {
  const scriptId = options?.scriptId ?? DEFAULT_SCRIPT_ID;
  const maxAge = options?.maxAge ?? Infinity;

  const el = findScriptElement(scriptId);
  if (!el || !el.textContent) {
    return null;
  }

  const parsed: unknown = JSON.parse(el.textContent);
  validatePayload(parsed);

  const payload = parsed as HydrationPayload<TContext, TData>;
  const age = Date.now() - payload.timestamp;

  if (Number.isFinite(maxAge) && age > maxAge) {
    console.warn(
      `Hydration payload is stale (age: ${age}ms, max: ${maxAge}ms). Falling back to client state.`
    );
    el.remove();
    return {
      component: payload.component,
      context: {} as TContext,
      initialData: undefined,
      timestamp: payload.timestamp,
      params: {},
      stale: true,
    };
  }

  // Consume once by removing the inert script node from the DOM
  el.remove();

  const result = decodeHydrationPayload<TData, TContext>(payload);
  resolveDeferredScripts();
  return result;
}

function kebabCase(str: string): string {
  return str
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

function indexComponents(
  components: readonly Constructable[] | Readonly<Record<string, Constructable>>
): ReadonlyMap<string, Constructable> {
  const map = new Map<string, Constructable>();

  if (Array.isArray(components)) {
    for (const comp of components) {
      const className = comp.name;
      const defName = CustomElement.isType(comp)
        ? CustomElement.getDefinition(comp).name
        : className;
      if (defName) map.set(defName, comp);
      if (className) {
        map.set(className, comp);
        map.set(kebabCase(className), comp);
      }
    }
    return map;
  }

  for (const [key, comp] of Object.entries(components)) {
    map.set(key, comp);
    if (CustomElement.isType(comp)) {
      map.set(CustomElement.getDefinition(comp).name, comp);
    }
    if (comp.name) {
      map.set(comp.name, comp);
      map.set(kebabCase(comp.name), comp);
    }
  }
  return map;
}

function resolveHostElement(target?: string | HTMLElement): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  if (target && typeof target !== 'string') return target;
  if (typeof target === 'string') {
    return document.querySelector<HTMLElement>(target);
  }
  return (
    document.querySelector<HTMLElement>('app-root') ??
    document.getElementById('ssr-root') ??
    document.body
  );
}

/**
 * Strictly typed client-side hydration bootstrapper for Aurelia 2 SSR.
 *
 * Reads the HTML5 JSON hydration payload, registers `IRequestContext<TContext>`
 * in Aurelia's DI container, resolves the matching Custom Element class, injects
 * `initialData` props, and hydrates (or boots) on the target host element.
 */
export async function createClientHydrator<
  TContext extends Record<string, unknown> = Record<string, unknown>,
  TData = Record<string, unknown>,
>(options: ClientHydratorOptions<TContext, TData>): Promise<object | null> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return null;
  }

  const peekedComponent = peekHydrationPayload(options.scriptId)?.component;
  const hydration = hydrateFromServer<TData, TContext>({
    scriptId: options.scriptId,
    maxAge: options.maxAge,
  });

  const registryScope = getDeferredRegistry(document);
  if (hasPendingDeferred(registryScope)) {
    const stopDeferred = observeDeferredHydration(document);
    const unsubscribe = onDeferredSettled(registryScope, () => {
      if (!hasPendingDeferred(registryScope)) {
        unsubscribe();
        stopDeferred();
      }
    });
  }

  const host = resolveHostElement(options.target);
  if (!host) {
    const error = new Error(
      `[createClientHydrator] Target host element "${typeof options.target === 'string' ? options.target : 'app-root'}" not found.`
    );
    options.onError?.(error);
    return null;
  }

  const registry = indexComponents(options.components);
  const componentName = hydration?.component ?? peekedComponent ?? '';
  const ComponentClass = (componentName ? registry.get(componentName) : undefined) ?? options.fallback;

  if (!ComponentClass) {
    const error = new Error(
      `[createClientHydrator] No component registered for "${componentName}". Available: ${Array.from(registry.keys()).join(', ')}`
    );
    options.onError?.(error);
    return null;
  }

  try {
    const app = new Aurelia();

    const requestContext: IRequestContextData<TContext> = {
      data: (hydration?.context ?? {}) as TContext,
      url: window.location?.href ?? 'http://localhost/',
      params: hydration?.params ?? {},
      query: window.location
        ? Object.fromEntries(new URLSearchParams(window.location.search))
        : {},
      isServer: false,
      isClient: true,
    };

    app.register(Registration.instance(IRequestContext, requestContext));

    if (options.registrations && options.registrations.length > 0) {
      app.register(...options.registrations);
    }

    if (hydration?.initialData && typeof hydration.initialData === 'object') {
      const initialProps = hydration.initialData;
      app.register(
        AppTask.activating(IAppRoot, (root) => {
          Object.assign(root.controller.viewModel as object, initialProps);
        })
      );
    }

    if (hydration?.ssrScope) {
      const root = await app.hydrate({
        host,
        component: ComponentClass,
        ssrScope: hydration.ssrScope,
      });
      const instance = root.controller.viewModel as object;
      options.onHydrated?.(componentName || ComponentClass.name, instance, hydration);
      return instance;
    }

    // Cleanly replace static SSR HTML nodes in the host container to prevent duplicate rendering
    host.replaceChildren();

    await app.app({ host, component: ComponentClass }).start();
    const rootInstance = app.root.controller.viewModel as object;
    options.onHydrated?.(componentName || ComponentClass.name, rootInstance, hydration);
    return rootInstance;
  } catch (err) {
    options.onError?.(err);
    throw err;
  }
}
