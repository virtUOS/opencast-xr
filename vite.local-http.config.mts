import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Local helper config for Task 10 desktop verification — UNTRACKED, safe to
// delete, never committed (see apps/demo/vite.local-http.config.mts for the
// established pattern this copies).
//
// Plain HTTP on 5192, so the app can be viewed inside Claude's built-in
// browser, which rejects the self-signed certificate the project's real
// vite.config.ts serves (https: true via vite-plugin-mkcert). Port choice:
// the player's real dev port is 5190; 5191 is reserved for the demo's own
// plain-HTTP scratch helper — this uses 5192 to avoid colliding with either.
//
// WebXR needs a secure context, so "Enter VR" is expected to report
// unavailable here (no navigator.xr / insecure context) — that IS what this
// task's XR-status diagnosis line is for.
export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 5192, strictPort: true },
})
