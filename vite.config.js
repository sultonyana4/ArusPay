import { defineConfig } from 'vite';

const previewHost = process.env.ARUSPAY_PREVIEW_HOST;
const allowedHosts = previewHost ? [previewHost] : [];

export default defineConfig({
  server: {
    allowedHosts,
  },
  preview: {
    allowedHosts,
  },
});
