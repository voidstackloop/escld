import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import amplifyJson from "./../amplify_outputs.json";
import { Amplify } from 'aws-amplify';
import { reportClientError } from './lib/client-error-reporter'
import { initRum } from './lib/rum'

Amplify.configure(amplifyJson)

// Frontend RUM (Core Web Vitals) — see rum.ts for why this is self-hosted
// rather than a vendor RUM SDK.
initRum()

// This app previously had zero client-side error visibility — not even a
// console.error call anywhere. These are the last line of defense for
// anything a component's own error handling doesn't catch (a render crash
// outside an ErrorBoundary, a stray unhandled promise rejection).
window.addEventListener('error', (event) => {
  reportClientError('Uncaught error', {
    message: event.message,
    source: event.filename,
    line: event.lineno,
    column: event.colno,
  })
})
window.addEventListener('unhandledrejection', (event) => {
  reportClientError('Unhandled promise rejection', { reason: String(event.reason) })
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
