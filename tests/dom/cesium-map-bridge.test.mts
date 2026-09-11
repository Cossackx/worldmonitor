import { describe, expect, it, vi } from 'vitest';
import { createCesiumMapBridge } from '@/components/CesiumMapBridge';
import type { CesiumMapAdapter } from '@/components/CesiumMapAdapter';

function adapterStub(): CesiumMapAdapter {
  const ready = Promise.resolve();
  return {
    whenReady: vi.fn(() => ready),
    render: vi.fn(),
    resize: vi.fn(),
    getTimeRange: vi.fn(() => '24h'),
  } as unknown as CesiumMapAdapter;
}

describe('CesiumMapBridge', () => {
  it('forwards adapter methods with the adapter as their receiver', () => {
    const adapter = adapterStub();
    const bridge = createCesiumMapBridge(adapter);

    bridge.render();
    bridge.resize();

    expect(adapter.render).toHaveBeenCalledOnce();
    expect(adapter.resize).toHaveBeenCalledOnce();
  });

  it('does not turn arbitrary absent properties into callable functions', () => {
    const bridge = createCesiumMapBridge(adapterStub());

    expect((bridge as unknown as Record<string, unknown>).notAContractMethod).toBeUndefined();
    expect((bridge as unknown as Record<string, unknown>).then).toBeUndefined();
  });

  it('keeps readiness truthful by forwarding the adapter promise', async () => {
    const adapter = adapterStub();
    const ready = adapter.whenReady();
    const bridge = createCesiumMapBridge(adapter);

    expect(bridge.whenReady()).toBe(ready);
    await expect(bridge.whenReady()).resolves.toBeUndefined();
  });

  it('only supplies explicitly declared compatibility methods', () => {
    const bridge = createCesiumMapBridge(adapterStub());

    expect(bridge.getBbox()).toBeNull();
    expect(bridge.setPositiveEvents).toEqual(expect.any(Function));
    expect(() => bridge.setPositiveEvents([])).not.toThrow();
    expect((bridge as unknown as Record<string, unknown>).setImaginaryLayer).toBeUndefined();
  });
});
