import js from "@eslint/js";
import vue from "eslint-plugin-vue";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default [
  { ignores: ["dist/", "node_modules/"] },
  js.configs.recommended,
  ...vue.configs["flat/recommended"],
  prettier,
  {
    files: ["src/**/*.{js,vue}"],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ["**/*.mjs"],
    // playwright 验证脚本（ui-test/ui-settings-test/scripts/*）同时用 node 与 browser API
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ["**/*.{js,vue}"],
    rules: {
      "vue/multi-word-component-names": "off",
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
];
