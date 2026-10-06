import { createWorkProxy } from "../../_lib/work-proxy.js";
export default createWorkProxy({
  path: "/api/work/mouse/move",
  validate: ({ x, y }) =>
    typeof x !== "number" || !Number.isFinite(x) ||
    typeof y !== "number" || !Number.isFinite(y)
      ? "Invalid mouse coordinates."
      : null
});