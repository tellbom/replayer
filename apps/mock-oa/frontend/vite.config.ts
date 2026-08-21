import vue from '@vitejs/plugin-vue';

const cssModuleSalt = Math.random().toString(36).slice(2, 8);

export default {
  plugins: [vue()],
  css: {
    modules: {
      generateScopedName: `[local]_${cssModuleSalt}_[hash:base64:5]`,
    },
  },
  server: {
    port: 15173,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:3000',
      '/legacy': 'http://localhost:3000',
      '/sso': 'http://localhost:3000',
    },
  },
};
