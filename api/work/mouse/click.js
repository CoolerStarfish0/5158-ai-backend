import { createWorkProxy } from "../../_lib/work-proxy.js";
export default createWorkProxy({
  path: "/api/work/mouse/click",
  validate: ({ button }) =>
    button !== undefined && !["left", "right", "middle"].includes(button)
      ? "button must be left, right, or middle"
      : null
});