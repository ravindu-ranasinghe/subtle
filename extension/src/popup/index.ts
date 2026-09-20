/**
 * Popup entry. The filename stays .ts because popup.html points at it and
 * that file is frozen; the React tree lives in ./App.tsx.
 */

import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './popup.css';

const host = document.querySelector('#app');
if (host) createRoot(host).render(createElement(App));
console.log('[subtle] popup ok');
