import React from 'react';
import ReactDOM from 'react-dom/client';
import { Bootstrap } from './app/Bootstrap';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Bootstrap />
  </React.StrictMode>,
);
