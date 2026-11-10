import "./styles.css";
import { renderChangelog } from "./changelog-page";

const root = document.getElementById("landing-root");
if (!root) throw new Error("Missing #landing-root element");

root.append(renderChangelog());
