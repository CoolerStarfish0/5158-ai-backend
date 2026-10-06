import { createWorkProxy } from "../../_lib/work-proxy.js";
const allowedModifiers = ["shift", "control", "alt", "command"];
export default createWorkProxy({
  path: "/api/work/keyboard/key",
  validate: ({ key, modifiers }) => {
    if (typeof key !== "string" || key.length === 0 || key.length > 50) {
      return "key must be a valid string";
    }
    if (modifiers !== undefined && !Array.isArray(modifiers)) {
      return "modifiers must be an array";
    }
    return (modifiers || []).every((modifier) => allowedModifiers.includes(modifier))
      ? null
      : "Invalid modifier";
  }
});