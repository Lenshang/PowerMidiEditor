import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { midiBus, useStore } from './state/store';
import { AppErrorBoundary } from './ui/ErrorBoundary';
import './styles.css';

// test/debug hooks: lets tooling assert view/doc state precisely
(window as unknown as Record<string, unknown>).__PME_STORE__ = useStore;
(window as unknown as Record<string, unknown>).__PME_MIDI_BUS__ = midiBus;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>,
);
