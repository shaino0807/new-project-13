import { api } from "@appdeploy/client";

declare global {
  interface Window {
    appApi: typeof api;
  }
}

window.appApi = api;
window.dispatchEvent(new Event("app-api-ready"));
