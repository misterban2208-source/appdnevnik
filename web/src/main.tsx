import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { initTelegram } from './lib/telegram.ts';
import './styles/global.css';

initTelegram();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
