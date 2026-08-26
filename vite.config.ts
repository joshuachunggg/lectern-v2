import { defineConfig } from 'vite';

export default defineConfig({ base: process.env.GITHUB_ACTIONS ? '/lectern-v2/' : '/', server: { allowedHosts: ['ca51-136-60-66-165.ngrok-free.app'] } });
