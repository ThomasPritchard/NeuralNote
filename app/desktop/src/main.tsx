import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource-variable/source-serif-4/wght.css";
import "./styles.css";
import App from "./App";
import { bootstrapPreferences } from "./preferences/preferences";

async function mount() {
  if (import.meta.env.VITE_NEURALNOTE_NATIVE_E2E === "1") {
    await import("@wdio/tauri-plugin");
    const { installNativeE2eBridge } = await import("./nativeE2eBridge");
    installNativeE2eBridge();
  }
  const initialPreferences = await bootstrapPreferences();
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App initialPreferences={initialPreferences} />
    </React.StrictMode>,
  );
}

void mount();
