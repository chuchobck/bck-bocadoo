import { describe, expect, it } from 'vitest';
import { RequestContextStore } from '../../src/tenancy/request-context';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('RequestContextStore', () => {
  it('fuera de run no hay contexto y set no rompe', () => {
    expect(RequestContextStore.get()).toBeUndefined();
    expect(() => RequestContextStore.set({ tenantId: '1' })).not.toThrow();
  });

  it('requests concurrentes no se cruzan', async () => {
    const seen = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        RequestContextStore.run({ requestId: `r${i}` }, async () => {
          await tick((i * 7) % 11);
          RequestContextStore.set({ tenantId: String(i + 1) });
          await tick((i * 3) % 5);
          return RequestContextStore.get();
        }),
      ),
    );
    seen.forEach((ctx, i) => expect(ctx).toEqual({ requestId: `r${i}`, tenantId: String(i + 1) }));
  });
});
