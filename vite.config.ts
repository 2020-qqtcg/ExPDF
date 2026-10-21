import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import localFontsPlugin from './server/fonts.mjs'
import codexPlugin from './server/codex.mjs'
import codexAgentPlugin from './server/codex-agent.mjs'
export default defineConfig({ plugins: [react(), localFontsPlugin(), codexPlugin({ agent: true }), codexAgentPlugin()], server: { port: 4173, strictPort: true }, assetsInclude: ['**/*.pdf'], build: { chunkSizeWarningLimit: 1600 } })
