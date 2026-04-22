import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';

// HashRouter callback handler: ML OAuth redirects to /perfil?code=... (no hash),
// but HashRouter expects /#/perfil. Detect test user OAuth here and notify
// parent window via multiple channels BEFORE React/HashRouter mount.
(() => {
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get('code');
  const state = urlParams.get('state');

  console.log("🔍 index.tsx OAuth callback check:", {
    hasCode: !!code,
    state,
    hasOpener: !!window.opener,
    search: window.location.search,
    hash: window.location.hash,
    href: window.location.href
  });

  if (code && state === 'test_user') {
    console.log("✅ Test user OAuth detected at root - notifying parent via multiple channels");

    const payload = { type: 'ml_oauth_code', code, state, timestamp: Date.now() };

    // Channel 1: localStorage (most reliable - persists even if popup closes immediately)
    try {
      localStorage.setItem('ml_test_oauth_result', JSON.stringify(payload));
      console.log("💾 Written to localStorage ml_test_oauth_result");
    } catch (e) {
      console.error("❌ localStorage write failed:", e);
    }

    // Channel 2: BroadcastChannel (works without window.opener)
    try {
      const bc = new BroadcastChannel('ml_test_oauth');
      bc.postMessage(payload);
      console.log("📻 BroadcastChannel message sent");
      setTimeout(() => bc.close(), 1000);
    } catch (e) {
      console.error("❌ BroadcastChannel failed:", e);
    }

    // Channel 3: postMessage to opener (traditional)
    if (window.opener) {
      try {
        window.opener.postMessage(payload, window.location.origin);
        console.log("📤 postMessage sent to opener");
      } catch (e) {
        console.error("❌ postMessage failed:", e);
      }
    } else {
      console.warn("⚠️ No window.opener available");
    }

    // Show visual confirmation and auto-close
    document.documentElement.innerHTML = `
      <body style="font-family:system-ui;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;background:#f0fdf4;color:#166534;text-align:center;padding:20px;">
        <div style="font-size:60px;margin-bottom:20px;">✅</div>
        <h1 style="font-size:24px;margin-bottom:10px;">Autorización exitosa</h1>
        <p style="color:#64748b;">Puedes cerrar esta ventana. Volviendo automáticamente...</p>
        <p style="color:#94a3b8;font-size:12px;margin-top:20px;">Code: ${code.substring(0, 20)}...</p>
      </body>
    `;

    setTimeout(() => {
      try { window.close(); } catch {}
    }, 1500);

    // Stop further execution of React app
    throw new Error('OAuth callback handled - stopping React mount');
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
