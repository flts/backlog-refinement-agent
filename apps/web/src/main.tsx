import React from 'react';
import ReactDOM from 'react-dom/client';
import { Root } from './app/Root';
import { applyTheme, getThemePreference } from './app/theme';
import './styles.css';

applyTheme(getThemePreference());

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
