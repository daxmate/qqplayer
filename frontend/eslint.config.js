import js from "@eslint/js";
import vue from "eslint-plugin-vue";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default [
  { ignores: ["dist/", "node_modules/"] },
  js.configs.recommended,
  // TS 推荐规则只作用于 TS 文件：tseslint 的 flat config 里有一个不带 files 的全局 config，
  // 直接展开会把这 23 条规则泄漏到存量 JS/.vue（如 @typescript-eslint/no-unused-vars 变 error），
  // 这里给无 files 限制的 config 补上 TS 扩展名限定
  ...tseslint.configs.recommended.map((cfg) =>
    // 带 plugins 的 config 是插件注册，必须保持全局；只给无 files 的规则 config 补 TS 限定
    cfg.plugins ? cfg : { ...cfg, files: cfg.files ?? ["**/*.{ts,mts,cts,tsx}"] },
  ),
  {
    // 契约类标记接口（如 `interface ImportBookResult extends BookView {}`）允许空体
    files: ["**/*.{ts,mts,cts,tsx}"],
    rules: {
      "@typescript-eslint/no-empty-object-type": [
        "error",
        { allowInterfaces: "with-single-extends" },
      ],
    },
  },
  ...vue.configs["flat/recommended"],
  prettier,
  {
    files: ["src/**/*.js"],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["**/*.mjs"],
    // playwright 验证脚本（ui-test/ui-settings-test/scripts/*）同时用 node 与 browser API
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ["**/*.vue"],
    languageOptions: {
      globals: { ...globals.browser },
      // 统一用 TS parser：<script lang="ts"> 原生支持，纯 JS script 也是 espree 超集，行为等价
      parserOptions: { parser: tseslint.parser },
    },
    rules: {
      "vue/multi-word-component-names": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
];
