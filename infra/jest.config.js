module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['@swc/jest']
  },
  setupFilesAfterEnv: ['aws-cdk-lib/testhelpers/jest-autoclean'],
  // Default (5s) is nowhere near enough for rtmp-service-stack.test.ts /
  // ws-sfu-stack.test.ts — their DockerImageAsset construction triggers a
  // *real* `docker build` of the Rust services' multi-stage Dockerfiles
  // (deliberate: it's the only thing that actually proves those Dockerfiles
  // build, see their own test files). Locally this looks instant once
  // Docker's layer cache is warm from other work, but a cold cache (a fresh
  // CI runner, nothing pulled or compiled yet) genuinely takes minutes per
  // image — confirmed directly: an uncached ws-sfu build took ~8 minutes.
  testTimeout: 900_000,
};
