import { app } from "./state.js";
import { requestJson } from "./api.js";
import { classText, t } from "./i18n.js";
import { setMessage } from "./dom.js";

const abilities = ["str", "dex", "con", "int", "wis", "cha"];
const standardScores = [15, 14, 13, 12, 10, 8];
let catalog = null;
let step = 0;

const dialog = () => document.querySelector("#character-builder-dialog");
const field = (id) => dialog().querySelector(`#${id}`);
const label = (id) => id.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join(" ");
const className = (id) => {
  const translated = t(`activity.creator.classOption.${id}`);
  return translated.startsWith("activity.") ? classText(id) : translated;
};
const element = (tag, className, content) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
};
const select = (id, values, textOf) => {
  const node = element("select");
  node.id = id;
  for (const value of values) {
    const option = element("option", "", textOf(value));
    option.value = value;
    node.append(option);
  }
  return node;
};
const labelled = (text, control) => {
  const node = element("label");
  node.append(element("span", "", text), control);
  return node;
};
const button = (text, click, primary = false) => {
  const node = element("button", `live-action-choice${primary ? " primary" : ""}`, text);
  node.type = "button";
  node.addEventListener("click", click);
  return node;
};
const feedback = (message) => { field("builder-feedback").textContent = message; };
const chosen = (name) => [...dialog().querySelectorAll(`input[name="${name}"]:checked`)].map((node) => node.value);
const raceText = (id) => t(`activity.creator.race.${id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())}`).startsWith("activity.") ? label(id) : t(`activity.creator.race.${id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())}`);
const skillText = (id) => {
  const translated = t(`activity.creator.skill.${id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())}`);
  return translated.startsWith("activity.") ? label(id) : translated;
};

export async function loadCharacters() {
  const area = document.querySelector("#lobby-characters");
  if (!area) return;
  const payload = await requestJson("/api/activity/characters");
  catalog = payload.catalog;
  if (!dialog().childElementCount) wireCharacterCreator();
  document.dispatchEvent(new Event("activity-characters-loaded"));
  area.replaceChildren();
  const heading = element("div", "section-heading");
  const title = element("h2", "", t("activity.lobby.savedCharacters"));
  heading.append(title, button(t("activity.lobby.startCreator"), openCharacterCreator, true));
  area.append(heading);
  if (!payload.characters.length) area.append(element("p", "lobby-character-empty", t("activity.creator.emptyLibrary")));
  const list = element("div", "lobby-character-list");
  for (const character of payload.characters) {
    const card = element("article", "lobby-character-card ui-card");
    card.append(element("strong", "", character.name), element("span", "", `${raceText(character.race ?? "human")} · ${className(character.className)}`));
    list.append(card);
  }
  area.append(list);
}

function buildChoices() {
  return {
    name: field("builder-name").value.trim(), race: field("builder-race").value, class: field("builder-class").value,
    appearance: field("builder-appearance").value.trim(), backstory: field("builder-backstory").value.trim(),
    kit: field("builder-kit").value,
    abilities: Object.fromEntries(abilities.map((ability) => [ability, Number(field(`builder-${ability}`).value)])),
    skills: chosen("builder-skill"), expertise: chosen("builder-expertise"),
    ...(field("builder-race").value === "half-elf" ? { raceAbilityChoices: chosen("builder-race-ability"), raceSkillChoices: chosen("builder-race-skill") } : {}),
  };
}

function validate(stage) {
  const build = buildChoices();
  const chosenClass = catalog.classes.find((entry) => entry.id === build.class);
  if (stage >= 0 && !build.name) return t("activity.creator.nameRequired");
  if (stage >= 1) {
    if (new Set(Object.values(build.abilities)).size !== 6 || [...Object.values(build.abilities)].sort((a, b) => b - a).some((score, index) => score !== standardScores[index])) return t("activity.creator.scoreError");
    if (build.skills.length !== chosenClass.skillCount) return t("activity.creator.skillCount", { count: chosenClass.skillCount });
    if (build.expertise.length !== chosenClass.expertiseCount || build.expertise.some((skill) => !build.skills.includes(skill))) return t("activity.creator.expertiseCount", { count: chosenClass.expertiseCount });
    if (build.race === "half-elf" && (build.raceAbilityChoices.length !== 2 || build.raceSkillChoices.length !== 2 || build.raceSkillChoices.some((skill) => build.skills.includes(skill)))) return t("activity.creator.halfElfError");
  }
  return null;
}

function renderClassChoices() {
  if (!catalog) return;
  const chosenClass = catalog.classes.find((entry) => entry.id === field("builder-class").value);
  const scores = field("builder-scores");
  scores.replaceChildren();
  for (const ability of abilities) scores.append(labelled(ability.toUpperCase(), select(`builder-${ability}`, standardScores, String)));
  for (const ability of abilities) field(`builder-${ability}`).value = String(chosenClass.suggestedAbilities[ability]);
  const skills = field("builder-skills");
  skills.replaceChildren(element("h3", "", t("activity.creator.skillCount", { count: chosenClass.skillCount })));
  for (const skill of chosenClass.skillChoices) {
    const input = element("input"); input.type = "checkbox"; input.name = "builder-skill"; input.value = skill;
    skills.append(labelled(skillText(skill), input));
  }
  const expertise = field("builder-expertise");
  expertise.replaceChildren();
  if (chosenClass.expertiseCount) {
    expertise.append(element("h3", "", t("activity.creator.expertiseCount", { count: chosenClass.expertiseCount })));
    for (const skill of chosenClass.skillChoices) {
      const input = element("input"); input.type = "checkbox"; input.name = "builder-expertise"; input.value = skill;
      expertise.append(labelled(skillText(skill), input));
    }
  }
  field("builder-kit").replaceWith(select("builder-kit", chosenClass.kits, (kit) => {
    const translated = t(`campaign.chars.kit.${kit}`);
    return translated.startsWith("campaign.") ? label(kit) : translated;
  }));
  renderRaceChoices();
}

function renderRaceChoices() {
  const area = field("builder-race-choices");
  area.replaceChildren();
  if (field("builder-race").value !== "half-elf") return;
  area.append(element("h3", "", t("activity.creator.halfElfAbilities")));
  for (const ability of abilities.filter((item) => item !== "cha")) {
    const input = element("input"); input.type = "checkbox"; input.name = "builder-race-ability"; input.value = ability;
    area.append(labelled(ability.toUpperCase(), input));
  }
  area.append(element("h3", "", t("activity.creator.halfElfSkills")));
  for (const skill of catalog.skills) {
    const input = element("input"); input.type = "checkbox"; input.name = "builder-race-skill"; input.value = skill;
    area.append(labelled(skillText(skill), input));
  }
}

function showStep(next) {
  if (next > step) {
    const error = validate(step);
    if (error) { feedback(error); return; }
  }
  feedback("");
  step = next;
  for (const [index, panel] of [...dialog().querySelectorAll("[data-builder-panel]")].entries()) panel.hidden = index !== step;
  for (const [index, tab] of [...dialog().querySelectorAll("[data-builder-step]")].entries()) tab.setAttribute("aria-current", String(index === step));
  if (step === 2) {
    const build = buildChoices();
    field("builder-review-name").textContent = build.name;
    field("builder-review-subtitle").textContent = `${raceText(build.race)} ${className(build.class)} · ${t("activity.lobby.levelOne")}`;
    field("builder-review-details").textContent = `${t("activity.creator.skills")}: ${build.skills.map(skillText).join(", ")} · ${t("activity.creator.kit")}: ${t(`campaign.chars.kit.${build.kit}`)}`;
    field("builder-review-stats").replaceChildren(...abilities.map((ability) => element("span", "", `${ability.toUpperCase()} ${build.abilities[ability]}`)));
  }
}

export function openCharacterCreator() {
  if (!catalog) { setMessage(t("activity.creator.unavailable")); return; }
  const form = dialog();
  form.querySelectorAll("input[type=text], textarea").forEach((input) => { input.value = ""; });
  field("builder-race").value = "human";
  field("builder-class").value = "fighter";
  renderClassChoices();
  step = 0;
  showStep(0);
  form.showModal();
}

export function wireCharacterCreator() {
  const form = dialog();
  form.replaceChildren();
  const header = element("header", "builder-header");
  const copy = element("div");
  copy.append(element("h2", "", t("activity.creator.title")), element("p", "", t("activity.creator.description")));
  header.append(copy, button("×", () => form.close()));
  const tabs = element("nav", "builder-steps");
  ["identity", "build", "review"].forEach((name, index) => {
    const tab = button(`${index + 1}  ${t(`activity.creator.${name}`)}`, () => showStep(index));
    tab.dataset.builderStep = name;
    tabs.append(tab);
  });
  const identity = element("section", "builder-panel"); identity.dataset.builderPanel = "identity";
  const name = element("input"); name.id = "builder-name"; name.type = "text"; name.maxLength = 40;
  identity.append(labelled(t("activity.creator.name"), name));
  const identityFields = element("div", "builder-fields");
  identityFields.append(labelled(t("activity.creator.ancestry"), select("builder-race", [], String)), labelled(t("activity.creator.class"), select("builder-class", [], String)));
  identity.append(identityFields);
  const appearance = element("textarea"); appearance.id = "builder-appearance"; appearance.maxLength = 300;
  const backstory = element("textarea"); backstory.id = "builder-backstory"; backstory.maxLength = 300;
  identity.append(labelled(t("activity.creator.appearance"), appearance), labelled(t("activity.creator.backstory"), backstory), button(t("activity.creator.continue"), () => showStep(1), true));
  const build = element("section", "builder-panel"); build.dataset.builderPanel = "build";
  build.append(element("h3", "", t("activity.creator.abilities")), element("p", "", t("activity.creator.scoreHelp")));
  const scores = element("div", "builder-score-grid"); scores.id = "builder-scores"; build.append(scores);
  const skills = element("div", "builder-choice-grid"); skills.id = "builder-skills"; build.append(skills);
  const expertise = element("div", "builder-choice-grid"); expertise.id = "builder-expertise"; build.append(expertise);
  const raceChoices = element("div", "builder-choice-grid"); raceChoices.id = "builder-race-choices"; build.append(raceChoices);
  build.append(labelled(t("activity.creator.kit"), select("builder-kit", [], String)));
  const buildButtons = element("div", "builder-buttons"); buildButtons.append(button(t("activity.creator.back"), () => showStep(0)), button(t("activity.creator.continue"), () => showStep(2), true)); build.append(buildButtons);
  const review = element("section", "builder-panel"); review.dataset.builderPanel = "review";
  const reviewName = element("h3"); reviewName.id = "builder-review-name";
  const subtitle = element("p"); subtitle.id = "builder-review-subtitle";
  const details = element("p"); details.id = "builder-review-details";
  const stats = element("div", "builder-review-stats"); stats.id = "builder-review-stats";
  const reviewButtons = element("div", "builder-buttons");
  const save = button(t("activity.creator.save"), async () => {
    const error = validate(1);
    if (error) { feedback(error); return; }
    save.disabled = true;
    try {
      await requestJson("/api/activity/characters", { method: "POST", body: JSON.stringify(buildChoices()) });
      form.close();
      await loadCharacters();
      setMessage(t("activity.creator.saved"));
    } catch (failure) { feedback(failure instanceof Error ? failure.message : t("activity.connection.requestFailed")); }
    finally { save.disabled = false; }
  }, true);
  reviewButtons.append(button(t("activity.creator.back"), () => showStep(1)), save);
  review.append(reviewName, subtitle, stats, details, reviewButtons);
  const message = element("p", "builder-feedback"); message.id = "builder-feedback"; message.setAttribute("role", "alert");
  form.append(header, tabs, identity, build, review, message);
  form.addEventListener("change", (event) => {
    if (event.target.id === "builder-class") renderClassChoices();
    if (event.target.id === "builder-race") renderRaceChoices();
  });
  // The authenticated lobby load fills these pickers; the dialog is never opened before then.
  const populate = () => {
    if (!catalog) return;
    field("builder-race").replaceWith(select("builder-race", catalog.races, raceText));
    field("builder-class").replaceWith(select("builder-class", catalog.classes.map((entry) => entry.id), className));
  };
  document.addEventListener("activity-characters-loaded", populate);
}
