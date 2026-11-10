import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/oxanium";
import "./styles.css";
import App from "./App";

const root = document.getElementById("admin-root");
if (!root) throw new Error("Missing #admin-root element");

const initialAuthenticated = root.dataset.authenticated === "true";
const initialPath = root.dataset.initialPath ?? "/admin";
const initialSearch = root.dataset.initialSearch ?? "";
const initialUserName = root.dataset.userName ?? "Admin User";
const initialUserEmail = root.dataset.userEmail ?? "";
const initialUserImage = root.dataset.userImage ?? "";
const initialPlayStationLinkEnabled = root.dataset.playstationLinkEnabled !== "false";
const initialWorkerVersion = root.dataset.workerVersion ?? "";

createRoot(root).render(
  <StrictMode>
    <App
      initialAuthenticated={initialAuthenticated}
      initialPath={initialPath}
      initialSearch={initialSearch}
      initialUserName={initialUserName}
      initialUserEmail={initialUserEmail}
      initialUserImage={initialUserImage}
      initialPlayStationLinkEnabled={initialPlayStationLinkEnabled}
      initialWorkerVersion={initialWorkerVersion}
    />
  </StrictMode>,
);
