module.exports = {
  projects: [
    {
      displayName: 'core',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/src/core/**/*.test.ts', '<rootDir>/test/**/*.test.ts'],
      transform: {
        '\\.ts$': [
          'babel-jest',
          {
            configFile: false,
            babelrc: false,
            presets: [
              ['@babel/preset-env', { targets: { node: 'current' } }],
              '@babel/preset-typescript',
            ],
          },
        ],
      },
    },
    {
      displayName: 'ui',
      preset: 'jest-expo',
      setupFilesAfterEnv: ['<rootDir>/test/support/ui-setup.ts'],
      testMatch: [
        '<rootDir>/src/ui/**/*.test.{ts,tsx}',
        '<rootDir>/src/adapters/**/*.test.{ts,tsx}',
        '<rootDir>/modules/**/*.test.{ts,tsx}',
      ],
    },
  ],
};
