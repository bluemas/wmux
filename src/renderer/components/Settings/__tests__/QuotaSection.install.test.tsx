// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QuotaSection } from '../tabs/TokenUsageTab/QuotaSection';
import type { ProviderQuotaReading, QuotaProviderId } from '../../../../shared/tokenUsage/quotaTypes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function reading(provider: QuotaProviderId, planLabel: string): ProviderQuotaReading {
  return {
    quota: {
      provider, status: 'ok', windows: [], planLabel, creditsLabel: null, capturedAtMs: null,
      fetchedAtMs: Date.now(), contextUsage: null, avgTokensPerMessage: null, message: null,
    },
    deltas: [],
  };
}

describe('QuotaSection agy sensor install', () => {
  let cleanup: () => void = () => undefined;
  afterEach(() => {
    cleanup();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  async function mount(api: Record<string, unknown>, providers: QuotaProviderId[]) {
    (window as unknown as { electronAPI: unknown }).electronAPI = { tokenUsage: api };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(<QuotaSection activeProviders={providers} />); });
    cleanup = () => { act(() => root.unmount()); container.remove(); };
    return container;
  }

  it('shows a failed sensor install on the agy card', async () => {
    const container = await mount({
      readQuota: vi.fn(async () => ({ readings: [] })),
      agySensorStatus: vi.fn(async () => ({ state: 'missing', settingsPath: '', hasData: false, message: null })),
      installAgySensor: vi.fn(async () => { throw new Error('disk full'); }),
    }, ['agy']);
    const install = [...container.querySelectorAll('button')].find((b) => /Install/i.test(b.textContent ?? ''))!;
    await act(async () => { install.click(); });
    expect(container.textContent).toContain('disk full');
  });
});
