// Floating control panel for the browser mock backend (never shown inside
// the plugin, where the host transport is authoritative).
import { useEffect, useState } from 'react';
import { useStore } from '../state/store';

interface MockApi {
  play(): void;
  stop(): void;
  setTempo(bpm: number): void;
  setLoop(on: boolean): void;
  getTransport(): { playing: boolean; tempo: number };
  reset(): void;
}

function mock(): MockApi | null {
  return (window as unknown as Record<string, unknown>).__PME_MOCK__ as MockApi | null;
}

export function DevHUD(): React.ReactElement | null {
  const mode = useStore((s) => s.mode);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(true);

  useEffect(() => {
    if (mode !== 'mock') return;
    const t = setInterval(() => {
      const m = mock();
      if (m) setPlaying(m.getTransport().playing);
    }, 200);
    return () => clearInterval(t);
  }, [mode]);

  if (mode !== 'mock') return null;
  const m = mock();
  if (!m) return null;

  return (
    <div className="devhud">
      <span className="devhud-title">Mock</span>
      <button className="mini-btn primary" onClick={() => (playing ? m.stop() : m.play())}>
        {playing ? '⏸' : '▶'}
      </button>
      <button
        className={`mini-btn ${loop ? 'active' : ''}`}
        onClick={() => { setLoop(!loop); m.setLoop(!loop); }}
      >
        Loop
      </button>
      <button className="mini-btn" onClick={() => m.reset()} title="Reset">Reset</button>
    </div>
  );
}
