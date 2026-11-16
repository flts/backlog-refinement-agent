import React from 'react';
import ReactDOM from 'react-dom/client';
import { Bootstrap } from './app/Bootstrap';
import { applyTheme, getThemePreference } from './app/theme';
import './styles.css';

applyTheme(getThemePreference());

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Bootstrap />
  </React.StrictMode>,
);
