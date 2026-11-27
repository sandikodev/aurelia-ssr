import { describe, it, expect } from 'bun:test';
import { serializeState, validatePayload, stringifyPayload } from '../src/serialize';
import { decodeHydrationPayload } from '../src/hydrate';

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
});
