import { describe, it, expect } from 'bun:test';
import {
  serializeState,
  serializeStateStream,
  validatePayload,
  stringifyPayload,
} from '../src/serialize';
import { decodeHydrationPayload } from '../src/hydrate';
import { decodeRichValue } from '../src/codec';
import { DEFERRED_SCRIPT_ATTR, createDeferredScript } from '../src/html';

describe('serializeState()', () => {
  it('preserves arbitrary application keys without opinionated regex redaction', async () => {
    // Legitimate domain keys that regex-guessing serializers mistakenly delete
    const context = {
      designToken: 'color-brand',
      txHash: '0xabc123',
      salt: '1 tsp',
      tokenCount: 4096,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };

    const payload = await serializeState(context, { items: [1, 2] }, 'metrics-page');

    expect(payload.component).toBe('metrics-page');
    expect(payload.context.designToken).toBe('color-brand');
    expect(payload.context.txHash).toBe('0xabc123');
    expect(payload.context.salt).toBe('1 tsp');
    expect(payload.context.tokenCount).toBe(4096);
    expect(payload.context.createdAt as unknown).toBe('2026-01-01T00:00:00.000Z');
    expect(payload.initialData).toEqual({ items: [1, 2] });
    expect(validatePayload(payload)).toBe(true);
  });

  it('supports standard JSON replacer option for explicit caller-controlled filtering', async () => {
    const context: Record<string, unknown> = { email: 'a@b.com', internalSecret: 'do-not-expose' };

    const payload = await serializeState(context, undefined, 'profile', {
      replacer: (key, value) => (key === 'internalSecret' ? undefined : value),
    });

    expect(payload.context).toEqual({ email: 'a@b.com' });
  });

  it('handles circular references and omits non-serializable functions/symbols', async () => {
    const circular: Record<string, unknown> = {
      name: 'node',
      fn: () => 'ignored',
      sym: Symbol('ignored'),
    };
    circular.self = circular;

    const payload = await serializeState({}, circular, 'tree');
    expect(payload.initialData).toEqual({ name: 'node', self: '[Circular]' });
    expect(validatePayload(payload)).toBe(true);
  });

  it('safely serializes BigInt values without throwing', async () => {
    const payload = await serializeState({ count: 9007199254740993n }, undefined, 'bigint-test');
    expect(payload.context.count as unknown).toBe('9007199254740993');
    expect(validatePayload(payload)).toBe(true);
  });

  it('escapes HTML script-breaking characters in stringifyPayload()', async () => {
    const payload = await serializeState(
      { bio: '</script><script>alert("xss")</script>' },
      undefined,
      'profile'
    );

    const json = stringifyPayload(payload);
    expect(json).not.toContain('</script>');
    expect(json).toContain('\\u003c/script\\u003e');
    expect(JSON.parse(json).context.bio).toBe('</script><script>alert("xss")</script>');
  });

  it('round-trips Date, Map, Set, BigInt, RegExp, URL, special numbers, and circular graphs in richTypes mode', async () => {
    interface RichData {
      when: Date;
      big: bigint;
      pattern: RegExp;
      endpoint: URL;
      tags: Set<string>;
      scores: Map<string, number>;
      specials: [number, number, number, number, undefined];
      sharedA: { label: string };
      sharedB: { label: string };
      self?: RichData;
    }

    const shared = { label: 'singleton-ref' };
    const data: RichData = {
      when: new Date('2026-11-28T00:00:00.000Z'),
      big: 9007199254740999123n,
      pattern: /^au-[a-z]+$/gi,
      endpoint: new URL('https://aurelia.io/docs?v=2'),
      tags: new Set(['ssr', 'islands']),
      scores: new Map([
        ['ttfb', 4],
        ['lcp', 42],
      ]),
      specials: [Number.NaN, Infinity, -Infinity, -0, undefined],
      sharedA: shared,
      sharedB: shared,
    };
    data.self = data;

    const payload = await serializeState(
      { secret: 'drop-me', role: 'admin' },
      data,
      'rich-page',
      {
        richTypes: true,
        replacer: (key, val) => (key === 'secret' ? undefined : val),
      }
    );

    expect(payload.encoding).toBe('rich');
    const wire = stringifyPayload(payload);
    const parsedWire = JSON.parse(wire) as typeof payload;
    const decoded = decodeHydrationPayload<RichData, { secret?: string; role: string }>(parsedWire);

    expect(decoded.context).toEqual({ role: 'admin' });
    const out = decoded.initialData!;
    expect(out.when instanceof Date).toBe(true);
    expect(out.when.toISOString()).toBe('2026-11-28T00:00:00.000Z');
    expect(out.big).toBe(9007199254740999123n);
    expect(out.pattern instanceof RegExp).toBe(true);
    expect(out.pattern.source).toBe('^au-[a-z]+$');
    expect(out.pattern.flags).toBe('gi');
    expect(out.endpoint instanceof URL).toBe(true);
    expect(out.endpoint.href).toBe('https://aurelia.io/docs?v=2');
    expect(out.tags instanceof Set).toBe(true);
    expect(Array.from(out.tags)).toEqual(['ssr', 'islands']);
    expect(out.scores instanceof Map).toBe(true);
    expect(out.scores.get('lcp')).toBe(42);
    expect(Number.isNaN(out.specials[0])).toBe(true);
    expect(out.specials[1]).toBe(Infinity);
    expect(out.specials[2]).toBe(-Infinity);
    expect(Object.is(out.specials[3], -0)).toBe(true);
    expect(out.specials[4]).toBeUndefined();
    expect(out.sharedA).toBe(out.sharedB);
    expect(out.self).toBe(out);
  });

  it('applies the replacer once per string in rich mode and drops unsafe property names', async () => {
    let stringCalls = 0;
    const payload = await serializeState(
      { locale: 'id' },
      {
        profile: { name: 'Ayu', nested: { note: '</script><script>alert(1)</script>' } },
        unsafe: JSON.parse('{"__proto__":{"polluted":true},"safe":"ok"}'),
      },
      'rich-security',
      {
        richTypes: true,
        replacer: (key, val) => {
          if (typeof val === 'string') stringCalls++;
          return val;
        },
      }
    );

    const wire = stringifyPayload(payload);
    expect(stringCalls).toBe(4);
    expect(wire).not.toContain('</script>');
    expect(wire).not.toContain('__proto__');

    const decoded = decodeHydrationPayload(payload);
    const data = decoded.initialData as {
      profile: { nested: { note: string } };
      unsafe: { safe: string };
    };
    expect(decoded.context.locale).toBe('id');
    expect(data.profile.nested.note).toContain('</script>');
    expect(data.unsafe.safe).toBe('ok');
    expect(Object.prototype.hasOwnProperty.call({}, 'polluted')).toBe(false);
  });

  it('still decodes legacy flat payloads without an encoding field', () => {
    const decoded = decodeHydrationPayload({
      component: 'legacy-page',
      context: { theme: 'dark' },
      initialData: { hits: 3 },
      timestamp: Date.now(),
    });
    expect(decoded.context).toEqual({ theme: 'dark' });
    expect(decoded.initialData).toEqual({ hits: 3 });
  });

  it('carries route params through serialization and hydration', async () => {
    const payload = await serializeState({ user: 'ayu' }, { hits: 3 }, 'detail-page', {
      params: { id: '42' },
    });

    expect(payload.params).toEqual({ id: '42' });
    expect(decodeHydrationPayload(payload).params).toEqual({ id: '42' });
  });

  it('sanitizes route params without allowing prototype pollution', async () => {
    const payload = await serializeState({}, undefined, 'param-page', {
      params: JSON.parse('{"__proto__":{"polluted":true},"slug":"safe"}') as Record<string, string>,
    });

    expect(payload.params).toEqual({ slug: 'safe' });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('tolerates corrupt rich tables instead of throwing during hydration', () => {
    const decoded = decodeRichValue<Record<string, unknown>>([
      {
        ok: 1,
        badRef: 99,
        negative: -1,
        big: 2,
        url: 3,
        regex: 4,
        set: 5,
        map: 6,
        list: 7,
      },
      'hello',
      ['$b', 'not-a-bigint'],
      ['$l', 'not a url'],
      ['$r', '[', ''],
      ['$s', [1, 99, -2]],
      ['$m', [[1, 2], [99, 1], ['x', 1]]],
      [1, 99, -1, 2],
    ]);

    expect(decoded.ok).toBe('hello');
    expect(decoded.badRef).toBeUndefined();
    expect(decoded.negative).toBeUndefined();
    expect(decoded.big).toBeUndefined();
    expect(decoded.url).toBeUndefined();
    expect(decoded.regex).toBeUndefined();
    expect(decoded.set).toEqual(new Set(['hello']));
    const map = decoded.map as Map<unknown, unknown>;
    expect(map.size).toBe(1);
    expect(map.has('hello')).toBe(true);
    expect(decoded.list).toEqual(['hello', undefined, undefined, undefined]);

    // A malicious length must not allocate an unbounded array.
    const huge = decodeRichValue<unknown[]>([Array.from({ length: 100_000 }, () => 0)]);
    expect(huge.length).toBe(1);

    // Non-string deferred promise marker ID should safely fall back to undefined.
    const badDeferred = decodeRichValue<{ p: unknown }>([{ p: 1 }, ['$p', 123]]);
    expect(badDeferred.p).toBeUndefined();
  });
});

describe('serializeStateStream() & createDeferredScript()', () => {
  it('encodes unresolved promises immediately without blocking and tracks them in pending', async () => {
    let resolveUser!: (v: { name: string; joinedAt: Date }) => void;
    let resolveSession!: (v: { role: string }) => void;
    const userPromise = new Promise<{ name: string; joinedAt: Date }>((r) => {
      resolveUser = r;
    });
    const sessionPromise = new Promise<{ role: string }>((r) => {
      resolveSession = r;
    });

    const { payload, pending } = serializeStateStream(
      { session: sessionPromise, locale: 'id' },
      { user: userPromise, sharedUser: userPromise, title: 'Instant Shell' },
      'stream-page',
      {
        deferredPrefix: 'chunk-',
        params: { id: '99' },
      }
    );

    // Returned synchronously while promises are still unresolved
    expect(payload.encoding).toBe('rich');
    expect(payload.component).toBe('stream-page');
    expect(payload.params).toEqual({ id: '99' });
    expect(pending.length).toBe(2);
    expect(pending[0]?.id).toBe('chunk-1');
    expect(pending[1]?.id).toBe('chunk-2');

    const wire = stringifyPayload(payload);
    expect(wire).toContain('["$p","chunk-1"]');
    expect(wire).toContain('["$p","chunk-2"]');

    const decoded = decodeHydrationPayload<
      {
        user: Promise<{ name: string; joinedAt: Date }>;
        sharedUser: Promise<{ name: string; joinedAt: Date }>;
        title: string;
      },
      { session: Promise<{ role: string }>; locale: string }
    >(JSON.parse(wire));

    expect(decoded.initialData?.title).toBe('Instant Shell');
    expect(decoded.context.locale).toBe('id');
    expect(decoded.initialData?.user).toBeInstanceOf(Promise);
    expect(decoded.initialData?.user).toBe(decoded.initialData?.sharedUser);
    expect(decoded.context.session).toBeInstanceOf(Promise);

    // Resolve server promises via custom resolvePromise hook in a separate decode check
    resolveSession({ role: 'admin' });
    resolveUser({ name: 'Ayu', joinedAt: new Date('2026-12-01T00:00:00.000Z') });

    const settledMap = new Map<string, unknown>();
    for (const item of pending) {
      settledMap.set(item.id, await item.promise);
    }

    const customDecoded = decodeRichValue<{
      user: Promise<{ name: string; joinedAt: Date }>;
    }>(payload.initialData, {
      resolvePromise: (id) => Promise.resolve(settledMap.get(id)),
    });

    const resolvedUser = await customDecoded.user;
    expect(resolvedUser.name).toBe('Ayu');
    expect(resolvedUser.joinedAt).toBeInstanceOf(Date);
  });

  it('emits XSS-safe inert deferred scripts for fulfilled rich values and rejected errors', () => {
    const okHtml = createDeferredScript('d1"evil', {
      bio: '</script><script>alert("xss")</script>',
      createdAt: new Date('2026-05-01T12:00:00.000Z'),
      tags: new Set(['fast', 'csp']),
    });

    expect(okHtml).toContain(`<script type="application/json" ${DEFERRED_SCRIPT_ATTR}="d1&quot;evil">`);
    expect(okHtml).not.toContain('</script><script>');
    expect(okHtml).toContain('\\u003c/script\\u003e');

    const err = new TypeError('Bad chunk </script>');
    err.stack = 'SECRET_STACK_TRACE_LINE';
    const errHtml = createDeferredScript('d2', undefined, { error: err });

    expect(errHtml).toContain(`<script type="application/json" ${DEFERRED_SCRIPT_ATTR}="d2">`);
    expect(errHtml).toContain('"ok":false');
    expect(errHtml).toContain('"name":"TypeError"');
    expect(errHtml).not.toContain('</script><script>');
    expect(errHtml).not.toContain('SECRET_STACK_TRACE_LINE');
  });
});
