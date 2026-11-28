/**
 * @aureliajs/ssr Deferred Promise Registry
 *
 * Zero-dependency per-document registry connecting `['$p', id]` markers decoded
 * from initial SSR state with late-arriving `<script type="application/json" data-au-deferred="...">` chunks.
 */

type PendingDeferredEntry = {
  status: 'pending';
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

type SettledDeferredEntry =
  | { status: 'fulfilled'; promise: Promise<unknown> }
  | { status: 'rejected'; promise: Promise<unknown> };

type DeferredEntry = PendingDeferredEntry | SettledDeferredEntry;

export interface DeferredRegistry {
  readonly entries: Map<string, DeferredEntry>;
  readonly listeners: Set<() => void>;
}

function createDeferredRegistry(): DeferredRegistry {
  return {
    entries: new Map(),
    listeners: new Set(),
  };
}

const documentRegistries = new WeakMap<object, DeferredRegistry>();
const globalRegistry = createDeferredRegistry();

export function resolveDocument(root?: ParentNode | Document | null): Document | null {
  if (root) {
    if ('nodeType' in root && root.nodeType === 9) {
      return root as Document;
    }
    if ('ownerDocument' in root && root.ownerDocument) {
      return root.ownerDocument;
    }
  }
  return typeof document !== 'undefined' ? document : null;
}

export function getDeferredRegistry(root?: ParentNode | Document | null): DeferredRegistry {
  const doc = resolveDocument(root);
  if (!doc) return globalRegistry;
  let registry = documentRegistries.get(doc);
  if (!registry) {
    registry = createDeferredRegistry();
    documentRegistries.set(doc, registry);
  }
  return registry;
}

export function claimDeferredPromise(
  id: string,
  registry: DeferredRegistry = getDeferredRegistry()
): Promise<unknown> {
  const existing = registry.entries.get(id);
  if (existing) {
    if (existing.status !== 'pending') {
      registry.entries.delete(id);
    }
    return existing.promise;
  }

  let resolve!: (value: unknown) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  registry.entries.set(id, { status: 'pending', promise, resolve, reject });
  return promise;
}

export function settleDeferredPromise(
  id: string,
  fulfilled: boolean,
  outcome: unknown,
  registry: DeferredRegistry = getDeferredRegistry()
): void {
  const existing = registry.entries.get(id);
  if (existing) {
    if (existing.status === 'pending') {
      registry.entries.delete(id);
      if (fulfilled) {
        existing.resolve(outcome);
      } else {
        existing.reject(outcome);
      }
      notifyListeners(registry);
    }
    return;
  }

  if (fulfilled) {
    registry.entries.set(id, {
      status: 'fulfilled',
      promise: Promise.resolve(outcome),
    });
  } else {
    const rejected = Promise.reject(outcome);
    // Guard against unhandled rejection before the hydration payload claims this ID.
    rejected.catch(() => {});
    registry.entries.set(id, {
      status: 'rejected',
      promise: rejected,
    });
  }
}

export function hasPendingDeferred(registry: DeferredRegistry = getDeferredRegistry()): boolean {
  for (const entry of registry.entries.values()) {
    if (entry.status === 'pending') return true;
  }
  return false;
}

export function onDeferredSettled(
  registry: DeferredRegistry,
  listener: () => void
): () => void {
  registry.listeners.add(listener);
  return () => {
    registry.listeners.delete(listener);
  };
}

function notifyListeners(registry: DeferredRegistry): void {
  for (const listener of registry.listeners) {
    listener();
  }
}
