import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { isFirefox } from './utils/browser'

try {
  const html = document.documentElement;
  if (isFirefox()) html.setAttribute("data-browser", "firefox");
  else html.removeAttribute("data-browser");
} catch {}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
