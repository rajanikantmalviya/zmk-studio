import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5174, strictPort: true },
  build: {
    outDir: "dist-viewer",
    target: "chrome105",
    rollupOptions: { input: "viewer.html" },
  },
});
