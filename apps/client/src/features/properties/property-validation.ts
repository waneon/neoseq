import type { ValidationIssue } from "../../entities/properties";
import type { MessageFunction } from "../../i18n";

export function validationMessage(issue: ValidationIssue, message: MessageFunction): string {
  const values = issue.values ?? {};
  switch (issue.code) {
    case "reserved_key":
      return message("validation.reservedKey", { key: values.key });
    case "property_type":
      return message("validation.propertyType", { key: values.key, type: values.type });
    case "property_cardinality":
      return message("validation.propertyCardinality", {
        key: values.key,
        cardinality: values.cardinality,
      });
    case "property_strings":
      return message("validation.propertyStrings", { key: values.key, values: values.values });
    case "default_forbidden":
      return message("validation.defaultForbidden", { key: values.key });
    case "control_character":
      return message("validation.controlCharacter");
    case "date":
      return message("validation.date");
    case "empty_key":
      return message("validation.emptyKey");
    case "empty_page":
      return message("validation.emptyPage");
    case "finite_number":
      return message("validation.finiteNumber");
    case "key_length":
      return message("validation.keyLength");
    case "string_length":
      return message("validation.stringLength");
    case "whitespace_key":
      return message("validation.whitespaceKey");
  }
}
