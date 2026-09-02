import type { Config } from "jest";

const config: Config = {
  testEnvironment: "node",
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: { jsx: "react-jsx" } }],
  },
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1",
    "^server-only$": "<rootDir>/__tests__/__mocks__/server-only.ts",
    "\\.css$": "<rootDir>/__tests__/__mocks__/styleMock.ts",
  },
  testMatch: ["**/__tests__/**/*.test.ts"],
};

export default config;
