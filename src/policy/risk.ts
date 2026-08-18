import type { Action, Risk } from "../schema/index.js";

const irreversibleControl = /\b(submit|confirm|approve|post|transfer|delete|remove|close|disburse|authorize)\b/i;
const reversibleRecordChange = /\b(save|update|change|edit|create|new|add)\b/i;

export function classifyRisk(action: Action, controlName?: string, isFormSubmit = false): Risk {
  if (isFormSubmit) return "irreversible";

  switch (action.type) {
    case "navigate":
    case "extract":
    case "assert":
    case "wait":
      return "safe";
    case "click":
      if (irreversibleControl.test(controlName ?? "")) return "irreversible";
      return reversibleRecordChange.test(controlName ?? "") ? "sensitive" : "safe";
    case "type":
    case "select":
    case "press":
      return "safe";
  }
}
