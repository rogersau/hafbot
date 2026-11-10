import { mkdirSync, writeFileSync } from "node:fs";

const directory = "dist-admin/admin/assets";
mkdirSync(directory, { recursive: true });
writeFileSync(
  `${directory}/theme-bootstrap.js`,
  `(function(){function c(v){var m=/(?:^|; )theme=(dark|light)/.exec(v);return m?m[1]:null}var s=c(document.cookie);var p=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches;var d=s?s:(p?"dark":"light");var r=document.documentElement;r.classList.remove("dark","light");r.classList.add(d);if(!s){var q=location.protocol==="https:"?"; Secure":"";document.cookie="theme="+d+"; Path=/; Max-Age=31536000; SameSite=Lax"+q}})();\n`,
);
