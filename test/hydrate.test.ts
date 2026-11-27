import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { JSDOM } from 'jsdom';
import { CustomElement, PLATFORM } from 'aurelia';
import {
  clearHydration,
  createClientHydrator,
  hydrateFromServer,
  isHydrationAvailable,
  peekHydrationPayload,
  resolveRequestContext,
} from '../src/hydrate';
import { DEFAULT_SCRIPT_ID, createHydrationScript } from '../src/html';
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
});
