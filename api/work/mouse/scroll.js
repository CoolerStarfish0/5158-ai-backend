import { createWorkProxy } from "../../_lib/work-proxy.js";
export default createWorkProxy({
  path: "/api/work/mouse/scroll",
  validate: ({ amount }) =>
    typeof amount !== "number" || !Number.isFinite(amount)
      ? "amount must be a valid number"
      : null
});