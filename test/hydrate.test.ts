import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { JSDOM } from 'jsdom';
import { CustomElement, PLATFORM } from 'aurelia';
import {
  clearHydration,
  createClientHydrator,
  hydrateFromServer,
  isHydrationAvailable,
  observeDeferredHydration,
  peekHydrationPayload,
  resolveDeferredScripts,
  resolveRequestContext,
} from '../src/hydrate';
import { DEFAULT_SCRIPT_ID, createDeferredScript, createHydrationScript } from '../src/html';
import { serializeStateStream } from '../src/serialize';
import type { HydrationPayload } from '../src/types';

function createPayload(overrides?: Partial<HydrationPayload>): HydrationPayload {
  return {
    component: 'test-page',
    context: { theme: 'dark' },
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('HTML5 JSON script client hydration', () => {
  let dom: JSDOM;
  const domProps = [
    'window',
    'document',
    'Node',
    'Element',
    'HTMLElement',
    'CustomEvent',
    'Event',
    'HTMLTemplateElement',
    'MutationObserver',
  ] as const;
  const savedGlobals: Record<string, unknown> = {};
  const savedPlatform: Record<string, unknown> = {};

  beforeEach(() => {
    dom = new JSDOM('<!DOCTYPE html><html><body><app-root></app-root></body></html>', {
      url: 'http://localhost/dashboard?tab=overview',
    });
    const p = PLATFORM as unknown as Record<string, unknown>;
    const g = globalThis as Record<string, unknown>;
    const w = dom.window as unknown as Record<string, unknown>;

    for (const prop of domProps) {
      savedGlobals[prop] = g[prop];
      savedPlatform[prop] = p[prop];
      g[prop] = w[prop];
      p[prop] = w[prop];
    }
  });

  afterEach(() => {
    const p = PLATFORM as unknown as Record<string, unknown>;
    const g = globalThis as Record<string, unknown>;

    for (const prop of domProps) {
      if (savedGlobals[prop] !== undefined) {
        g[prop] = savedGlobals[prop];
      } else {
        delete g[prop];
      }
      if (savedPlatform[prop] !== undefined) {
        p[prop] = savedPlatform[prop];
      }
    }
    dom.window.close();
  });

  function mountPayloadScript(payload: HydrationPayload, scriptId = DEFAULT_SCRIPT_ID): void {
    const wrapper = dom.window.document.createElement('div');
    wrapper.innerHTML = createHydrationScript(payload, scriptId);
    dom.window.document.body.appendChild(wrapper.firstElementChild!);
  }

  it('returns null when no JSON hydration script exists in DOM', () => {
    expect(isHydrationAvailable()).toBe(false);
    expect(peekHydrationPayload()).toBeUndefined();
    expect(hydrateFromServer()).toBeNull();
  });

  it('extracts, validates, and removes the JSON script node on hydrateFromServer()', () => {
    const payload = createPayload({
      context: { locale: 'id', tier: 'pro' },
      initialData: { posts: [{ id: 1 }] },
    });
    mountPayloadScript(payload);

    expect(isHydrationAvailable()).toBe(true);
    expect(peekHydrationPayload()).toEqual(payload);

    const result = hydrateFromServer<{ posts: Array<{ id: number }> }, { locale: string; tier: string }>();
    expect(result).not.toBeNull();
    expect(result?.component).toBe('test-page');
    expect(result?.context).toEqual({ locale: 'id', tier: 'pro' });
    expect(result?.initialData).toEqual({ posts: [{ id: 1 }] });

    // Script node consumed and removed cleanly from DOM
    expect(dom.window.document.getElementById(DEFAULT_SCRIPT_ID)).toBeNull();
    expect(isHydrationAvailable()).toBe(false);
  });

  it('keeps component identity but drops data from stale payloads exceeding maxAge', () => {
    mountPayloadScript(
      createPayload({ component: 'cached-landing', timestamp: Date.now() - 60_000 })
    );
    const stale = hydrateFromServer({ maxAge: 30_000 });
    expect(stale?.component).toBe('cached-landing');
    expect(stale?.stale).toBe(true);
    expect(stale?.initialData).toBeUndefined();
    expect(stale?.context).toEqual({});
  });

  it('hydrates CDN-cached / SSG payloads of any age by default and falls back cleanly when explicit maxAge expires', async () => {
    // 1-hour-old CDN cached payload succeeds when no maxAge TTL is forced
    mountPayloadScript(
      createPayload({
        component: 'cached-landing',
        initialData: { hero: 'Cached Hero' },
        timestamp: Date.now() - 3_600_000,
      })
    );
    const cached = hydrateFromServer<{ hero: string }>();
    expect(cached).not.toBeNull();
    expect(cached?.initialData?.hero).toBe('Cached Hero');

    // Even when explicit maxAge expires, createClientHydrator still mounts the peeked component
    const CachedLanding = CustomElement.define(
      { name: 'cached-landing', template: '<p>${hero}</p>' },
      class {
        hero = 'Client Default Hero';
      }
    );

    mountPayloadScript(
      createPayload({
        component: 'cached-landing',
        initialData: { hero: 'Expired Server Hero' },
        timestamp: Date.now() - 120_000,
      })
    );

    await createClientHydrator({
      components: [CachedLanding],
      maxAge: 5_000,
    });

    const host = dom.window.document.querySelector('app-root')!;
    expect(host.innerHTML).toContain('Client Default Hero');
  });

  it('injects rich-encoded initialData before binding() runs via AppTask.activating', async () => {
    const { serializeState } = await import('../src/serialize');
    let observedDateDuringBinding = false;

    const EventWidget = CustomElement.define(
      { name: 'event-widget', template: '<span>${startsAt.toISOString()}</span>' },
      class {
        startsAt: Date = new Date(0);
        binding() {
          observedDateDuringBinding =
            this.startsAt instanceof Date &&
            this.startsAt.toISOString() === '2026-12-01T10:00:00.000Z';
        }
      }
    );

    const payload = await serializeState(
      {},
      { startsAt: new Date('2026-12-01T10:00:00.000Z') },
      'event-widget',
      { richTypes: true }
    );
    mountPayloadScript(payload);

    await createClientHydrator({
      components: [EventWidget],
    });

    expect(observedDateDuringBinding).toBe(true);
    expect(dom.window.document.querySelector('app-root')!.innerHTML).toContain(
      '2026-12-01T10:00:00.000Z'
    );
  });

  it('supports custom scriptId and clearHydration()', () => {
    mountPayloadScript(createPayload(), 'CUSTOM_SSR_DATA');
    expect(isHydrationAvailable('CUSTOM_SSR_DATA')).toBe(true);
    clearHydration('CUSTOM_SSR_DATA');
    expect(isHydrationAvailable('CUSTOM_SSR_DATA')).toBe(false);
  });

  it('hydrates CustomElement with typed DI IRequestContext and initialData', async () => {
    interface AppCtx extends Record<string, unknown> {
      tenant: string;
    }

    const DashboardWidget = CustomElement.define(
      {
        name: 'dashboard-widget',
        template:
          '<div>Tenant: ${req.data.tenant} | Tab: ${req.query.tab} | Title: ${title} | Client: ${req.isClient}</div>',
      },
      class {
        readonly req = resolveRequestContext<AppCtx>();
        title = '';
      }
    );

    mountPayloadScript(
      createPayload({
        component: 'dashboard-widget',
        context: { tenant: 'acme' },
        initialData: { title: 'Live Metrics' },
      })
    );

    let hydratedName = '';
    await createClientHydrator<AppCtx, { title: string }>({
      components: [DashboardWidget],
      onHydrated: (name) => {
        hydratedName = name;
      },
    });

    const host = dom.window.document.querySelector('app-root')!;
    expect(hydratedName).toBe('dashboard-widget');
    expect(host.innerHTML).toContain('Tenant: acme');
    expect(host.innerHTML).toContain('Tab: overview');
    expect(host.innerHTML).toContain('Title: Live Metrics');
    expect(host.innerHTML).toContain('Client: true');
  });

  it('mounts immediately with unresolved Promise and resolves Aurelia ViewModel when deferred script streams in', async () => {
    let settleServerPromise!: (v: { name: string; fetchedAt: Date }) => void;
    const slowServerPromise = new Promise<{ name: string; fetchedAt: Date }>((resolve) => {
      settleServerPromise = resolve;
    });

    const { payload, pending } = serializeStateStream(
      { region: 'ap-southeast-1' },
      { userPromise: slowServerPromise, heading: 'Profile' },
      'streaming-profile'
    );

    const StreamingProfile = CustomElement.define(
      {
        name: 'streaming-profile',
        template: '<section><h1>${heading}</h1><p class="status">${statusText}</p></section>',
      },
      class {
        heading = '';
        userPromise: Promise<{ name: string; fetchedAt: Date }> = Promise.resolve({
          name: '',
          fetchedAt: new Date(0),
        });
        statusText = 'Loading...';

        binding() {
          this.userPromise.then(
            (user) => {
              this.statusText = `${user.name} @ ${user.fetchedAt.toISOString()}`;
            },
            (err: Error) => {
              this.statusText = `Error: ${err.message}`;
            }
          );
        }
      }
    );

    mountPayloadScript(payload);

    // Mounts immediately without blocking on slowServerPromise
    const instance = (await createClientHydrator({
      components: [StreamingProfile],
    })) as { userPromise: Promise<{ name: string; fetchedAt: Date }>; statusText: string };

    const host = dom.window.document.querySelector('app-root')!;
    expect(instance.userPromise).toBeInstanceOf(Promise);
    expect(instance.statusText).toBe('Loading...');
    expect(host.innerHTML).toContain('Profile');
    expect(host.innerHTML).toContain('Loading...');

    // Verify zero inline executable JS scripts exist in the document
    const allScripts = Array.from(dom.window.document.querySelectorAll('script'));
    for (const s of allScripts) {
      expect(s.getAttribute('type')).toBe('application/json');
    }

    // Now the slow server promise resolves and streams its inert deferred chunk
    settleServerPromise({
      name: 'Sandiko',
      fetchedAt: new Date('2026-11-28T08:00:00.000Z'),
    });
    const resolvedVal = await pending[0]!.promise;

    const wrapper = dom.window.document.createElement('div');
    wrapper.innerHTML = createDeferredScript(pending[0]!.id, resolvedVal);
    const deferredEl = wrapper.firstElementChild!;
    expect(deferredEl.getAttribute('type')).toBe('application/json');
    dom.window.document.body.appendChild(deferredEl);

    // Wait for MutationObserver + promise microtasks + Aurelia DOM update
    const resolvedOnClient = await instance.userPromise;
    await new Promise((r) => setTimeout(r, 10));

    expect(resolvedOnClient.name).toBe('Sandiko');
    expect(resolvedOnClient.fetchedAt).toBeInstanceOf(Date);
    expect(dom.window.document.querySelector('script[data-au-deferred]')).toBeNull();
    expect(instance.statusText).toBe('Sandiko @ 2026-11-28T08:00:00.000Z');
    expect(host.innerHTML).toContain('Sandiko @ 2026-11-28T08:00:00.000Z');
  });

  it('rejects client Promise safely when deferred chunk carries an error payload', async () => {
    let rejectServerPromise!: (reason?: unknown) => void;
    const failingServerPromise = new Promise<string>((_, reject) => {
      rejectServerPromise = reject;
    });

    interface StreamCtx extends Record<string, unknown> {
      auditPromise: Promise<string>;
    }

    const { payload, pending } = serializeStateStream<StreamCtx, { dataPromise: Promise<string> }>(
      { auditPromise: failingServerPromise },
      { dataPromise: failingServerPromise },
      'error-widget'
    );

    const ErrorWidget = CustomElement.define(
      { name: 'error-widget', template: '<p class="err">${errorMessage}</p>' },
      class {
        readonly req = resolveRequestContext<StreamCtx>();
        dataPromise: Promise<string> = Promise.resolve('');
        errorMessage = 'pending';

        binding() {
          this.dataPromise.catch((err: Error) => {
            this.errorMessage = `${err.name}: ${err.message}`;
          });
        }
      }
    );

    mountPayloadScript(payload);

    const instance = (await createClientHydrator<StreamCtx, { dataPromise: Promise<string> }>({
      components: [ErrorWidget],
    })) as {
      req: { data: StreamCtx };
      dataPromise: Promise<string>;
      errorMessage: string;
    };

    expect(instance.req.data.auditPromise).toBe(instance.dataPromise);

    rejectServerPromise(new TypeError('Database unavailable </script>'));
    let capturedError: unknown;
    try {
      await pending[0]!.promise;
    } catch (err) {
      capturedError = err;
    }

    const wrapper = dom.window.document.createElement('div');
    wrapper.innerHTML = createDeferredScript(pending[0]!.id, undefined, { error: capturedError });
    dom.window.document.body.appendChild(wrapper.firstElementChild!);

    await expect(instance.dataPromise).rejects.toThrow('Database unavailable </script>');
    await new Promise((r) => setTimeout(r, 10));

    expect(instance.errorMessage).toBe('TypeError: Database unavailable </script>');
    expect(dom.window.document.querySelector('app-root')!.innerHTML).toContain(
      'TypeError: Database unavailable'
    );
    expect(dom.window.document.querySelector('script[data-au-deferred]')).toBeNull();
  });

  it('resolves pre-arrived deferred scripts during hydrateFromServer() and supports manual observeDeferredHydration()', async () => {
    const p1 = Promise.resolve({ count: 42 });
    const { payload, pending } = serializeStateStream({}, { metrics: p1 }, 'metrics-view');

    // Simulate deferred chunk already in DOM before client hydration runs
    const wrapper = dom.window.document.createElement('div');
    wrapper.innerHTML = createDeferredScript(pending[0]!.id, await pending[0]!.promise);
    dom.window.document.body.appendChild(wrapper.firstElementChild!);
    mountPayloadScript(payload);

    const result = hydrateFromServer<{ metrics: Promise<{ count: number }> }>();
    expect(result).not.toBeNull();
    expect(await result!.initialData!.metrics).toEqual({ count: 42 });
    expect(dom.window.document.querySelector('script[data-au-deferred]')).toBeNull();

    // Verify manual resolveDeferredScripts & observeDeferredHydration cleanup
    const p2 = new Promise<string>(() => {});
    const stream2 = serializeStateStream({}, { label: p2 }, 'label-view');
    mountPayloadScript(stream2.payload);

    const stop = observeDeferredHydration(dom.window.document);
    const res2 = hydrateFromServer<{ label: Promise<string> }>();
    const badChunk = dom.window.document.createElement('script');
    badChunk.setAttribute('type', 'application/json');
    badChunk.setAttribute('data-au-deferred', stream2.pending[0]!.id);
    badChunk.textContent = '{invalid-json';
    dom.window.document.body.appendChild(badChunk);

    expect(resolveDeferredScripts(dom.window.document)).toBe(1);
    await expect(res2!.initialData!.label).rejects.toThrow();
    stop();
  });

  it('keeps client entrypoint free of JSDOM or Node server imports', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const clientFiles = ['client.ts', 'hydrate.ts', 'codec.ts', 'deferred.ts', 'tokens.ts'];
    for (const file of clientFiles) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');
      expect(src).not.toMatch(/from\s+['"](?:jsdom|linkedom|node:)/);
    }
  });
});
