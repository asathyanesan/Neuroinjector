import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Served at https://asathyanesan.github.io/Neuroinjector/assistant/
export default defineConfig({
  plugins: [react()],
  base: '/Neuroinjector/assistant/',
  build: {
    outDir: 'dist',
    assetsDir: 'assets'
  }
})
