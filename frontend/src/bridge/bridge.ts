import type { UiEvent } from './protocol';
import { createJuceBridge, hasJuceBackend } from './juce';
import { createMockBridge } from './mock';

export interface Bridge {
  readonly mode: 'juce' | 'mock';
  /** RPC; resolves with `data` or throws with the error message. */
  invoke<T = unknown>(name: string, payload?: unknown,
      opts?: { timeoutMs?: number }): Promise<T>;
  onEvent(cb: (e: UiEvent) => void): () => void;
}

let instance: Bridge | null = null;

export function getBridge(): Bridge {
  instance ??= hasJuceBackend() ? createJuceBridge() : createMockBridge();
  return instance;
}
