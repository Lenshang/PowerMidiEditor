// Bridge to the JUCE WebBrowserComponent native backend.
// Mirrors the wire protocol of JUCE's @juce-framework/webview interop:
//   - native functions: emit '__juce__invoke' {name, params, resultId},
//     response arrives on '__juce__complete' as {promiseId, result}.
//   - backend events arrive via backend.addEventListener(eventId, cb).
import type { Bridge } from './bridge';
import type { UiEvent } from './protocol';

interface JuceBackend {
  addEventListener(eventId: string, cb: (payload: unknown) => void): unknown;
  removeEventListener(token: unknown): void;
  emitEvent(eventId: string, payload: unknown): void;
}

function getBackend(): JuceBackend {
  return (window as unknown as { __JUCE__: { backend: JuceBackend } }).__JUCE__.backend;
}

export function hasJuceBackend(): boolean {
  return typeof (window as unknown as Record<string, unknown>).__JUCE__ !== 'undefined';
}

export function createJuceBridge(): Bridge {
  const backend = getBackend();

  let nextPromiseId = 0;
  const pending = new Map<number, (result: unknown) => void>();

  backend.addEventListener('__juce__complete', (payload) => {
    const { promiseId, result } = payload as { promiseId: number; result: unknown };
    const entry = pending.get(promiseId);
    if (entry) {
      pending.delete(promiseId);
      entry(result);
    }
  });

  async function invoke<T = unknown>(name: string, payload?: unknown): Promise<T> {
    const resultId = nextPromiseId++;
    const reply = new Promise<unknown>((resolve) => pending.set(resultId, resolve));
    // JUCE routes the call by the `name` field to the registered native
    // function ("invoke") and passes `params` straight through — so the
    // protocol name travels as params[0] and the payload as params[1].
    backend.emitEvent('__juce__invoke', { name: 'invoke', params: [name, payload ?? null], resultId });

    // The plugin is on the same thread; a lost reply would deadlock the UI,
    // so guard with a timeout and surface a clear error instead.
    const result = await Promise.race([
      reply,
      new Promise<never>((_, reject) =>
        setTimeout(() => {
          if (pending.delete(resultId)) reject(new Error(`invoke('${name}') timed out`));
        }, 5000),
      ),
    ]);
    const r = result as { ok?: boolean; data?: unknown; error?: string };
    if (r && r.ok === false) throw new Error(r.error ?? 'invoke failed');
    return r?.data as T;
  }

  return {
    mode: 'juce',
    invoke,
    onEvent(cb: (e: UiEvent) => void) {
      const handler = (payload: unknown) => cb(payload as UiEvent);
      const token = backend.addEventListener('pme', handler);
      return () => backend.removeEventListener(token);
    },
  };
}
