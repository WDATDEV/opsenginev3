import type { RuleCondition } from "@opsengine/db";

export type MatchableLetter = {
  fromEmail: string;
  subject: string;
  body: string;
};

// Words are typed as a comma or line separated list. Empty entries are dropped.
export function words(value: string) {
  return value
    .split(/[,\n]/)
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean);
}

function textOf(letter: MatchableLetter, field: RuleCondition["field"]) {
  if (field === "subject") return letter.subject.toLowerCase();
  if (field === "body") return letter.body.toLowerCase();
  if (field === "sender") return letter.fromEmail.toLowerCase();
  return letter.fromEmail.toLowerCase().split("@")[1] ?? "";
}

export function conditionMatches(letter: MatchableLetter, condition: RuleCondition) {
  const list = words(condition.value);
  // A condition with no words never matches, so an empty box cannot automate every email.
  if (list.length === 0) return false;
  const text = textOf(letter, condition.field);
  switch (condition.op) {
    case "contains_any":
      return list.some((word) => text.includes(word));
    case "contains_all":
      return list.every((word) => text.includes(word));
    case "not_contains":
      return list.every((word) => !text.includes(word));
    case "equals":
      return list.some((word) => text === word);
    case "ends_with":
      return list.some((word) => text.endsWith(word));
    default:
      return false;
  }
}

export function ruleMatches(letter: MatchableLetter, mode: string, conditions: RuleCondition[]) {
  if (conditions.length === 0) return false;
  const results = conditions.map((condition) => conditionMatches(letter, condition));
  return mode === "any" ? results.some(Boolean) : results.every(Boolean);
}
