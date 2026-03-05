import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// Perf-lite mode for Firefox (helps heavy blur/glow UIs)
const ua = navigator.userAgent.toLowerCase();
const isFirefox = ua.includes("firefox");
if (isFirefox) {
  document.documentElement.classList.add("perf-lite");
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
