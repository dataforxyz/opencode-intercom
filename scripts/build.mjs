import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
};

await Promise.all([
  build({
    ...common,
    entryPoints: ["opencode/plugin.ts"],
    outfile: "dist/plugin.mjs",
    external: ["@opencode-ai/plugin"],
  }),
  build({
    ...common,
    entryPoints: ["broker/broker.ts"],
    outfile: "dist/broker.mjs",
  }),
]);
