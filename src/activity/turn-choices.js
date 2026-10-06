import { t } from "./i18n.js";

// An attack the turn offers, as the button label and the action it sends. Shared by the turn bar and the battlefield menu.
export function attackChoice(attack, target) {
  const offHand = attack.weapon.startsWith("offhand:");
  const nonlethal = attack.weapon.startsWith("nonlethal:");
  const weaponId = attack.weapon.replace(/^(offhand:|nonlethal:)/, "");
  const weapon = offHand ? t("activity.weapon.offhand", { name: attack.weaponName }) : nonlethal ? t("activity.weapon.nonlethal", { name: attack.weaponName }) : attack.weaponName;
  return { label: t("activity.action.attack", { name: target.name, weapon }), action: { kind: "attack", weaponId, targetId: target.id, offHand, nonlethal } };
}
