// Offline bindings use the pinned SDK's official templates; no deployment or credentials.
import { apiCodegen } from "../node_modules/convex/dist/esm/cli/codegen_templates/api.js";
import { serverCodegen } from "../node_modules/convex/dist/esm/cli/codegen_templates/server.js";
import { header } from "../node_modules/convex/dist/esm/cli/codegen_templates/common.js";
import { format } from "prettier";
import { mkdir, readdir, writeFile, readFile } from "node:fs/promises";
const modules = (await readdir("convex"))
  .sort()
  .filter(
    (f) =>
      f.endsWith(".ts") &&
      ![
        "schema.ts",
        "validators.ts",
        "errorCodes.ts",
        "modelOutputs.ts",
        "auth.config.ts",
      ].includes(f),
  );
const api = apiCodegen(modules);
const server = serverCodegen({ useTypeScript: false, envVars: undefined });
const source = await readFile(
  "node_modules/convex/src/cli/codegen_templates/dataModel.ts",
  "utf8",
);
const template =
  source.split("const dynamicDataModelContent = ")[1].split("\n  `;")[0] +
  "\n  `";
// Evaluate only the pinned SDK template literal, with its header helper.
const dataModel = new Function("header", `return ${template}`)(header);
const outputs = {
  "api.js": api.JS,
  "api.d.ts": api.DTS,
  "server.js": server.JS,
  "server.d.ts": server.DTS,
  "dataModel.d.ts": dataModel,
};
await mkdir("convex/_generated", { recursive: true });
for (const [name, rawContent] of Object.entries(outputs)) {
  const content = await format(rawContent, {
    parser: name.endsWith(".ts") ? "typescript" : "babel",
  });
  const path = `convex/_generated/${name}`;
  if (process.argv.includes("--check")) {
    if ((await readFile(path, "utf8").catch(() => null)) !== content)
      throw Error(`Convex binding drift: ${name}`);
  } else await writeFile(path, content);
}
console.log("Convex offline bindings verified; live deployment UNTESTED");
