import { readFileSync } from "node:fs";
import { validateChangelog } from "./changelog-format.mjs";

validateChangelog(JSON.parse(readFileSync(new URL("../changelog.json", import.meta.url), "utf8")));
