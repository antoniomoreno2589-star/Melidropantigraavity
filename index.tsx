import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';

// HashRouter callback handler: ML OAuth redirects to /perfil?code=... (no hash),
// but HashRouter expects /#/perfil. Detect test user OAuth here and postMessage
// to parent window BEFORE React/HashRouter mount.
(() => {
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get('code');
  const state = urlParams.get('state');

  console.log("🔍 index.tsx OAuth callback check:", {
    hasCode: !!code,
    state,
    hasOpener: !!window.opener,
    search: window.location.search,
    hash: window.location.hash
  });

  if (code && state === 'test_user') {
    if (window.opener) {
      console.log("✅ Test user OAuth detected at root - sending postMessage");
      try {
        window.opener.postMessage(
          { type: 'ml_oauth_code', code, state },
          window.location.origin
        );
        console.log("📤 postMessage sent from index.tsx");
        // Close the popup window after sending the message
        setTimeout(() => window.close(), 500);
      } catch (e) {
        console.error("❌ Error sending postMessage from index.tsx:", e);
      }
    } else {
      console.warn("⚠️ No window.opener - this popup wasn't opened via window.open()");
    }
  }
})();

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>
);
