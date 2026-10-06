import { t } from "./i18n.js";
import { performAction } from "./actions.js";

// The Companions tab: the creatures your hero brought along between fights, each with the way to send it away.
// A companion is sent away with a second press, and only when no fight is on.
function companionList(game) {
  const list = document.createElement("div");
  list.className = "sheet-features";
  for (const companion of game.companions) {
    const row = document.createElement("div");
    row.className = "workspace-offer-row";
    const detail = [t("activity.companions.from", { spell: companion.spellName }), companion.hp === null ? null : t("activity.companions.hurt", { hp: companion.hp })].filter(Boolean).join(" · ");
    row.append(Object.assign(document.createElement("span"), { textContent: `${companion.name} · ${detail}` }));
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ui-control";
    button.textContent = t("activity.companions.dismiss");
    button.disabled = !game.canDismissCompanion;
    let armed = null;
    button.addEventListener("click", () => {
      if (armed === null) {
        button.textContent = t("activity.companions.dismissSure");
        armed = setTimeout(() => { armed = null; button.textContent = t("activity.companions.dismiss"); }, 4000);
        return;
      }
      clearTimeout(armed);
      armed = null;
      void performAction({ kind: "dismissCompanion", companionId: companion.id });
    });
    row.append(button);
    list.append(row);
  }
  if (!game.canDismissCompanion) list.append(Object.assign(document.createElement("p"), { className: "sheet-note", textContent: t("activity.companions.busy") }));
  return list;
}


// Paints the Companions tab from the snapshot; the panel is made the first time it is needed.
export function renderCompanions(game) {
  let panel = document.querySelector("#hero-panel-companions");
  if (panel === null) {
    panel = document.createElement("section");
    panel.className = "hero-tab-panel";
    panel.id = "hero-panel-companions";
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", "hero-tab-companions");
    panel.hidden = true;
    document.querySelector(".hero-body").append(panel);
  }
  panel.replaceChildren(...(game.companions?.length ? [companionList(game)] : []));
}
