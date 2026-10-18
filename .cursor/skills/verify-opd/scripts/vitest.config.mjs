import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const jose = fileURLToPath(new URL('../../../../worker/node_modules/jose', import.meta.url));

export default {
  root: here,
  resolve: {
    alias: { jose },
  },
  test: {
    environment: 'node',
    include: ['access-gate.test.ts'],
  },
};
