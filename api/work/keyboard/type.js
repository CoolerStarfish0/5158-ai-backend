import { createWorkProxy } from "../../_lib/work-proxy.js";
export default createWorkProxy({
  path: "/api/work/keyboard/type",
  validate: ({ text }) =>
    typeof text !== "string" || text.length > 5000
      ? "Invalid text. Text must be a string of 5000 characters or fewer."
      : null
});